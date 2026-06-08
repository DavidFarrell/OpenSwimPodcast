import { useCallback, useEffect, useRef, useState } from "react";
import { Window, Sidebar } from "./Shell.jsx";
import { LoginScreen } from "./LoginScreen.jsx";
import { UpNextScreen } from "./UpNextScreen.jsx";
import { TodayScreen } from "./TodayScreen.jsx";
import { SyncScreen, MountDialog, VolumePicker } from "./SyncScreen.jsx";
import { upNext as mockUpNext, deviceCapacityMB } from "./data.js";
import { adaptUpNext, enrichFromPodcastFull } from "./pocketcastsAdapter.js";
import { useDownloads } from "./useDownloads.js";
import { useDevice, formatMB } from "./useDevice.js";
import {
  loadAnnounceGlobal, saveAnnounceGlobal,
  loadAnnounceOff, saveAnnounceOff,
  effectiveAnnounce,
} from "./announcePrefs.js";

const pc = () => (typeof window !== "undefined" && window.openswim && window.openswim.pocketcasts) || null;

export default function App() {
  const [connected, setConnected] = useState(false);
  const [route, setRouteRaw] = useState(() => localStorage.getItem("os_route") || "up-next");
  const [playbackSpeed, setPlaybackSpeedRaw] = useState(() => {
    const v = parseFloat(localStorage.getItem("os_playbackSpeed"));
    return Number.isFinite(v) && v > 0 ? v : 1.0;
  });
  const setPlaybackSpeed = (v) => {
    setPlaybackSpeedRaw(v);
    localStorage.setItem("os_playbackSpeed", String(v));
  };
  const [boost, setBoostRaw] = useState(() => localStorage.getItem("os_boost") === "1");
  const setBoost = (v) => {
    setBoostRaw(!!v);
    localStorage.setItem("os_boost", v ? "1" : "0");
  };
  // Announce-episode intent (S6). Universal toggle + per-episode OFF overrides,
  // persisted exactly like speed/boost above. Passive announce status (per uuid)
  // is collected from the S5 sync:event stream.
  const [announceOn, setAnnounceOnRaw] = useState(() => loadAnnounceGlobal());
  const setAnnounceOn = (v) => {
    setAnnounceOnRaw(!!v);
    saveAnnounceGlobal(!!v);
  };
  const [announceOff, setAnnounceOffRaw] = useState(() => loadAnnounceOff());
  const setAnnounceEpisode = (uuid, enabled) => {
    if (!uuid) return;
    setAnnounceOffRaw((prev) => {
      const next = new Set(prev);
      if (enabled) next.delete(uuid); else next.add(uuid);
      saveAnnounceOff(next);
      return next;
    });
  };
  const [announceStatus, setAnnounceStatus] = useState({});
  const [selected, setSelected] = useState([]);
  const [order, setOrder] = useState([]);
  const [syncArmed, setSyncArmed] = useState(false);
  const [syncBusy, setSyncBusy] = useState(false);
  const [showMountDialog, setShowMountDialog] = useState(false);
  const device = useDevice();
  const [items, setItems] = useState([]);
  const [onDevice, setOnDevice] = useState([]);
  const [feedState, setFeedState] = useState("idle");
  const [feedError, setFeedError] = useState(null);
  const { byUuid: downloadByUuid, ensure: ensureDownload, reconcile: reconcileDownloads } = useDownloads();

  useEffect(() => { localStorage.setItem("os_route", route); }, [route]);

  // Push the effective per-episode Announce intent to the S5 IPC for every queued
  // episode. We record an explicit ON or OFF per uuid (never just ON) so the S5
  // off-intent fix can honour a disable - a stale queued ON must not win over a
  // chosen OFF. Runs whenever the toggle, overrides, or queue change.
  useEffect(() => {
    const api = typeof window !== "undefined" && window.openswim && window.openswim.announce;
    if (!api || !api.set) return;
    for (const id of order) {
      const it = items.find((x) => x.id === id);
      if (!it || !it.uuid) continue;
      api.set(it.uuid, effectiveAnnounce(it.uuid, announceOn, announceOff));
    }
  }, [announceOn, announceOff, order, items]);

  // Passive announce status badge feed (S5 emits announce events during sync).
  useEffect(() => {
    const api = typeof window !== "undefined" && window.openswim && window.openswim.sync;
    if (!api || !api.onEvent) return;
    const off = api.onEvent((evt) => {
      if (evt && evt.type === "announce" && evt.uuid) {
        setAnnounceStatus((prev) => ({ ...prev, [evt.uuid]: evt.state }));
      }
    });
    return typeof off === "function" ? off : undefined;
  }, []);

  useEffect(() => {
    const api = pc();
    if (!api) { setConnected(false); return; }
    api.status().then((r) => {
      if (r.ok && r.data.authed) setConnected(true);
    });
  }, []);

  const fetchControllerRef = useRef({ cancelled: false });

  const fetchUpNext = useCallback(async () => {
    const api = pc();
    if (!api) { setItems(mockUpNext); return; }
    fetchControllerRef.current.cancelled = true;
    const ctrl = { cancelled: false };
    fetchControllerRef.current = ctrl;

    setFeedState("loading");
    setFeedError(null);
    const [upRes, podRes, histRes] = await Promise.all([api.upNext(), api.podcastList(), api.history()]);
    if (ctrl.cancelled) return;
    if (!upRes.ok) {
      setFeedError(upRes.error?.message || "failed to load up next");
      setFeedState("error");
      if (upRes.error?.code === "AUTH_EXPIRED") setConnected(false);
      return;
    }
    const episodes = upRes.data.episodes || [];
    const podcasts = podRes.ok ? (podRes.data.podcasts || []) : [];
    const history = histRes.ok ? (histRes.data.episodes || []) : [];
    const base = adaptUpNext({ upNext: episodes, podcasts, history });
    setItems(base);
    setFeedState("ready");

    const missingPodcastUuids = [...new Set(base
      .filter((it) => !it.durMin || !it.sizeMB)
      .map((it) => it.podcastUuid)
      .filter(Boolean))];
    const CONCURRENCY = 6;
    const queueP = [...missingPodcastUuids];
    let working = base;
    const worker = async () => {
      while (queueP.length && !ctrl.cancelled) {
        const puuid = queueP.shift();
        const r = await api.podcastFull(puuid);
        if (ctrl.cancelled) return;
        if (r.ok && r.data.podcast) {
          working = enrichFromPodcastFull(working, r.data);
          setItems(working);
        }
      }
    };
    await Promise.all(Array.from({ length: CONCURRENCY }, worker));
  }, []);

  useEffect(() => {
    if (!connected) { setItems([]); return; }
    fetchUpNext();
    return () => { fetchControllerRef.current.cancelled = true; };
  }, [connected, fetchUpNext]);

  useEffect(() => {
    if (route !== "today") return;
    for (const id of order) {
      const it = items.find((x) => x.id === id);
      if (!it || !it.url || !it.uuid) continue;
      const state = downloadByUuid[it.uuid];
      if (!state || state.state === "error" || state.state === "cancelled") {
        ensureDownload(it.uuid, it.url);
      }
    }
  }, [route, order, items]);

  useEffect(() => {
    if (!items.length || !order.length) return;
    const keepUuids = order
      .map((id) => items.find((x) => x.id === id)?.uuid)
      .filter(Boolean);
    reconcileDownloads(keepUuids);
  }, [order, items]);

  useEffect(() => {
    setOrder((prev) => {
      const keep = prev.filter((id) => selected.includes(id));
      const adds = selected.filter((id) => !keep.includes(id));
      return [...keep, ...adds];
    });
  }, [selected]);

  const setRoute = (r) => {
    if (r !== "syncing") setSyncArmed(false);
    setRouteRaw(r);
  };

  const onDeviceUuids = new Set(onDevice.map((d) => d.uuid).filter(Boolean));
  const onDeviceIds = items.filter((x) => x.uuid && onDeviceUuids.has(x.uuid)).map((x) => x.id);
  const usedMB = onDevice.reduce((s, x) => s + (x.sizeMB || 0), 0);

  const refreshManifest = useCallback(() => {
    const api = typeof window !== "undefined" && window.openswim && window.openswim.device;
    if (!api || !api.readManifest) { setOnDevice([]); return; }
    if (!device.mounted || !device.path) { setOnDevice([]); return; }
    api.readManifest(device.path).then((r) => {
      setOnDevice(r && r.ok && Array.isArray(r.data) ? r.data : []);
    });
  }, [device.mounted, device.path]);

  useEffect(() => { refreshManifest(); }, [refreshManifest]);

  const pillState = !device.available ? "unmounted"
    : !device.mounted ? "unmounted"
    : syncBusy ? "busy"
    : "mounted";
  const pillFree = device.mounted && device.freeMB != null ? formatMB(device.freeMB) : null;
  const pillCapacityMB = device.capacityMB ?? deviceCapacityMB;

  const handleLogout = async () => {
    const api = pc();
    if (api) await api.logout();
    setConnected(false);
    setItems([]);
    setSelected([]);
    setOrder([]);
  };

  if (!connected) {
    return (
      <div style={{ width: "100%", height: "100%", boxSizing: "border-box" }}>
        <Window>
          <div className="os-titlebar" />
          <LoginScreen onConnect={() => setConnected(true)} />
        </Window>
      </div>
    );
  }

  return (
    <div style={{ width: "100%", height: "100%", boxSizing: "border-box" }}>
      <Window>
        <div className="os-titlebar" />
        <div style={{ flex: 1, display: "flex", minHeight: 0, position: "relative" }}>
          <Sidebar route={route} setRoute={setRoute} todayCount={selected.length}
            mountState={pillState} mountFree={pillFree}
            setShowMountDialog={setShowMountDialog}
            onLogout={handleLogout} />
          <main style={{ flex: 1, display: "flex", flexDirection: "column",
            minWidth: 0, position: "relative" }}>
            {feedState === "loading" && !items.length && (
              <div style={{ flex: 1, display: "flex", alignItems: "center", justifyContent: "center",
                color: "var(--fg-muted)", fontFamily: "var(--font-mono)", fontSize: 12 }}>
                loading up next…
              </div>
            )}
            {feedState === "error" && (
              <div style={{ flex: 1, display: "flex", alignItems: "center", justifyContent: "center",
                color: "var(--ct-error)", fontFamily: "var(--font-mono)", fontSize: 12 }}>
                ✗ {feedError}
              </div>
            )}
            {route === "up-next" && feedState !== "error" && items.length > 0 && (
              <UpNextScreen items={items} selected={selected} setSelected={setSelected} order={order}
                goToday={() => setRoute("today")} onDeviceIds={onDeviceIds}
                onRefresh={fetchUpNext} refreshing={feedState === "loading"} />
            )}
            {route === "today" && (
              <TodayScreen items={items} onDevice={onDevice} selected={selected} setSelected={setSelected}
                order={order} setOrder={setOrder}
                goSync={() => { setSyncArmed(true); setRouteRaw("syncing"); }}
                goUpNext={() => setRoute("up-next")}
                deviceCapacityMB={deviceCapacityMB}
                downloadByUuid={downloadByUuid}
                onRetryDownload={(it) => ensureDownload(it.uuid, it.url)}
                playbackSpeed={playbackSpeed}
                setPlaybackSpeed={setPlaybackSpeed}
                boost={boost}
                setBoost={setBoost}
                announceOn={announceOn}
                setAnnounceOn={setAnnounceOn}
                announceOff={announceOff}
                setAnnounceEpisode={setAnnounceEpisode}
                announceStatus={announceStatus}
                devicePath={device.mounted ? device.path : null}
                setShowMountDialog={setShowMountDialog} />
            )}
            {route === "syncing" && (
              <SyncScreen items={items} order={order} onDevice={onDevice}
                armed={syncArmed} onArm={() => setSyncArmed(true)}
                onDone={() => { refreshManifest(); setSelected([]); setOrder([]); setSyncArmed(false); setRouteRaw("up-next"); }}
                onBack={() => { setSyncArmed(false); setRouteRaw("today"); }}
                setMountState={(s) => setSyncBusy(s === "busy")}
                devicePath={device.mounted ? device.path : null}
                downloadByUuid={downloadByUuid}
                playbackSpeed={playbackSpeed}
                boost={boost} />
            )}
          </main>
          {showMountDialog && device.mounted && (
            <MountDialog state={pillState}
              free={device.freeMB != null ? device.freeMB : 0}
              used={device.capacityMB != null && device.freeMB != null ? (device.capacityMB - device.freeMB) : 0}
              path={device.path}
              onClose={() => setShowMountDialog(false)}
              onForce={() => { setSyncBusy(false); setShowMountDialog(false); }} />
          )}
          {showMountDialog && !device.mounted && (
            <VolumePicker onClose={() => setShowMountDialog(false)} onPicked={() => setShowMountDialog(false)} />
          )}
        </div>
      </Window>
    </div>
  );
}
