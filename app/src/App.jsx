import { useEffect, useState } from "react";
import { Window, Sidebar } from "./Shell.jsx";
import { LoginScreen } from "./LoginScreen.jsx";
import { UpNextScreen } from "./UpNextScreen.jsx";
import { TodayScreen } from "./TodayScreen.jsx";
import { SyncScreen, MountDialog, VolumePicker } from "./SyncScreen.jsx";
import { upNext as mockUpNext, onDevice, deviceCapacityMB } from "./data.js";
import { adaptUpNext, enrichFromPodcastFull } from "./pocketcastsAdapter.js";
import { useDownloads } from "./useDownloads.js";
import { useDevice, formatMB } from "./useDevice.js";

const pc = () => (typeof window !== "undefined" && window.openswim && window.openswim.pocketcasts) || null;

export default function App() {
  const [connected, setConnected] = useState(false);
  const [route, setRouteRaw] = useState(() => localStorage.getItem("os_route") || "up-next");
  const [selected, setSelected] = useState([]);
  const [order, setOrder] = useState([]);
  const [syncArmed, setSyncArmed] = useState(false);
  const [syncBusy, setSyncBusy] = useState(false);
  const [showMountDialog, setShowMountDialog] = useState(false);
  const device = useDevice();
  const [items, setItems] = useState([]);
  const [feedState, setFeedState] = useState("idle");
  const [feedError, setFeedError] = useState(null);
  const { byUuid: downloadByUuid, ensure: ensureDownload, reconcile: reconcileDownloads } = useDownloads();

  useEffect(() => { localStorage.setItem("os_route", route); }, [route]);

  useEffect(() => {
    const api = pc();
    if (!api) { setConnected(false); return; }
    api.status().then((r) => {
      if (r.ok && r.data.authed) setConnected(true);
    });
  }, []);

  useEffect(() => {
    if (!connected) { setItems([]); return; }
    const api = pc();
    if (!api) { setItems(mockUpNext); return; }

    let cancelled = false;
    (async () => {
      setFeedState("loading");
      setFeedError(null);
      const [upRes, podRes, histRes] = await Promise.all([api.upNext(), api.podcastList(), api.history()]);
      if (cancelled) return;
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
        while (queueP.length && !cancelled) {
          const puuid = queueP.shift();
          const r = await api.podcastFull(puuid);
          if (cancelled) return;
          if (r.ok && r.data.podcast) {
            working = enrichFromPodcastFull(working, r.data);
            setItems(working);
          }
        }
      };
      await Promise.all(Array.from({ length: CONCURRENCY }, worker));
    })();
    return () => { cancelled = true; };
  }, [connected]);

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

  const onDeviceIds = onDevice.map((d) => items.find((x) => x.show === d.show)?.id).filter(Boolean);
  const usedMB = onDevice.reduce((s, x) => s + x.sizeMB, 0);

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
                goToday={() => setRoute("today")} onDeviceIds={onDeviceIds} />
            )}
            {route === "today" && (
              <TodayScreen items={items} onDevice={onDevice} selected={selected} setSelected={setSelected}
                order={order} setOrder={setOrder}
                goSync={() => { setSyncArmed(true); setRouteRaw("syncing"); }}
                goUpNext={() => setRoute("up-next")}
                deviceCapacityMB={deviceCapacityMB}
                downloadByUuid={downloadByUuid}
                onRetryDownload={(it) => ensureDownload(it.uuid, it.url)} />
            )}
            {route === "syncing" && (
              <SyncScreen items={items} order={order} onDevice={onDevice}
                armed={syncArmed} onArm={() => setSyncArmed(true)}
                onDone={() => { setSelected([]); setOrder([]); setSyncArmed(false); setRouteRaw("up-next"); }}
                onBack={() => { setSyncArmed(false); setRouteRaw("today"); }}
                setMountState={(s) => setSyncBusy(s === "busy")}
                devicePath={device.mounted ? device.path : null}
                downloadByUuid={downloadByUuid} />
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
