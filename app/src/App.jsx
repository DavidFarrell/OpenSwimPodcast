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
import {
  loadTrimGlobal, saveTrimGlobal,
  loadTrimOff, saveTrimOff,
  effectiveTrim,
} from "./trimPrefs.js";
import { buildTrimAudioUrls, applyCutEdit } from "./trimAudio.js";
import { loadModel, saveModel, MODEL_OPTIONS } from "./modelPrefs.js";
import {
  loadSensitivity, saveSensitivity, thresholdSecFor, SENSITIVITY_OPTIONS,
} from "./sensitivityPrefs.js";
import { loadBootRoute, saveRoute } from "./bootRoute.js";

const pc = () => (typeof window !== "undefined" && window.openswim && window.openswim.pocketcasts) || null;

export default function App() {
  const [connected, setConnected] = useState(false);
  // Always boot to the queue (Fix 2). A saved os_route is deliberately NOT
  // restored on boot, so a cold start can never land on the transient
  // "syncing" Transfer screen. Within-session navigation still persists below.
  const [route, setRouteRaw] = useState(() => loadBootRoute());
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
  // Model picker (P4a). The LM Studio model id used by the announce summary and
  // the trim detector, persisted like speed/boost. Defaults to the LOCKED
  // gemma-4-12b-qat. Threaded into the sync spec -> announce.cjs / detectAds.cjs.
  const [model, setModelRaw] = useState(() => loadModel());
  const setModel = (v) => {
    const next = (typeof v === "string" && v.trim()) ? v.trim() : loadModel();
    setModelRaw(next);
    saveModel(next);
  };
  // Sensitivity setting (P4b). Tunes the trim detector's needs-review duration
  // threshold ONLY: conservative flags more, aggressive flags less. It cannot
  // weaken the cardinal rule (quote-map failures are still skipped, ambiguous
  // boundaries still flagged). Persisted like model/speed/boost; threaded into the
  // sync spec -> detectAds.cjs as needsReviewMaxSec (seconds).
  const [sensitivity, setSensitivityRaw] = useState(() => loadSensitivity());
  const setSensitivity = (v) => {
    setSensitivityRaw((prev) => {
      saveSensitivity(v);
      return loadSensitivity();
    });
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
  // Trim-interstitials intent (P2d). Universal toggle + per-episode OFF overrides,
  // persisted exactly like announce above. Passive trim status (per uuid) is
  // collected from the P2c sync:event stream.
  const [trimOn, setTrimOnRaw] = useState(() => loadTrimGlobal());
  const setTrimOn = (v) => {
    setTrimOnRaw(!!v);
    saveTrimGlobal(!!v);
  };
  const [trimOff, setTrimOffRaw] = useState(() => loadTrimOff());
  const setTrimEpisode = (uuid, enabled) => {
    if (!uuid) return;
    setTrimOffRaw((prev) => {
      const next = new Set(prev);
      if (enabled) next.delete(uuid); else next.add(uuid);
      saveTrimOff(next);
      return next;
    });
  };
  const [trimStatus, setTrimStatus] = useState({});
  // Proposed cut lists per uuid (P3a) - the trim sync:event carries the full cut
  // list alongside the state. Kept separate from the string status above so the
  // badge can stay a simple string while the review surface reads the cuts.
  const [trimCuts, setTrimCuts] = useState({});
  // Transcript segments per episode, fed by the same trim event. The Advanced
  // transcript-as-evidence view (P3d) reads these to highlight the detected ad
  // ranges in context. Optional - the view renders nothing without segments.
  const [trimSegments, setTrimSegments] = useState({});
  // Recorded keep/remove decisions for FLAGGED cuts, keyed by uuid then cut key
  // ({ uuid: { "start-end": "keep" | "remove" } }). Default is keep everywhere
  // (cardinal rule); only an explicit remove lets a flagged cut be applied.
  const [trimDecisions, setTrimDecisions] = useState({});
  const onTrimDecide = (uuid, cut, decision) => {
    if (!uuid || !cut) return;
    const key = `${Math.round(Number(cut.startSec) * 1000)}-${Math.round(Number(cut.endSec) * 1000)}`;
    const value = decision === "remove" ? "remove" : "keep";
    setTrimDecisions((prev) => ({ ...prev, [uuid]: { ...(prev[uuid] || {}), [key]: value } }));
    const api = typeof window !== "undefined" && window.openswim && window.openswim.trim;
    if (api && api.decide) api.decide(uuid, cut, value);
  };
  // Boundary edit for a FLAGGED cut (P3b nudge / typed timestamp). The new cut
  // already passed cutlistReview's invert guard, so here we just (1) swap the
  // boundaries in the in-memory cut list for an immediate redraw and (2) persist
  // the edit through IPC so it survives a re-process. CARDINAL RULE: this only
  // changes WHAT a later REMOVE would cut - it never applies a cut.
  const onTrimEdit = (uuid, originalCut, newCut) => {
    if (!uuid || !originalCut || !newCut) return;
    setTrimCuts((prev) => {
      const cur = prev[uuid];
      const next = applyCutEdit(cur, originalCut, newCut);
      if (next === cur) return prev;
      return { ...prev, [uuid]: next };
    });
    const api = typeof window !== "undefined" && window.openswim && window.openswim.trim;
    if (api && api.edit) api.edit(uuid, originalCut, newCut);
  };
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

  // Persist the current route within the session. This is NOT restored on boot
  // (loadBootRoute always returns "up-next"); kept only so the value reflects the
  // live route. Never causes a non-"up-next" boot.
  useEffect(() => { saveRoute(route); }, [route]);

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

  // Push the effective per-episode Trim intent to the P2c IPC for every queued
  // episode. Same off-intent discipline as announce: record an explicit ON or
  // OFF per uuid so a stale queued ON never wins over a chosen OFF (CARDINAL
  // RULE - a per-episode disable must be honoured, never risk a bad cut).
  useEffect(() => {
    const api = typeof window !== "undefined" && window.openswim && window.openswim.trim;
    if (!api || !api.set) return;
    for (const id of order) {
      const it = items.find((x) => x.id === id);
      if (!it || !it.uuid) continue;
      api.set(it.uuid, effectiveTrim(it.uuid, trimOn, trimOff));
    }
  }, [trimOn, trimOff, order, items]);

  // Passive trim status badge feed (P2c emits trim events during sync). States:
  // analysing / ready / needs-review / skipped.
  useEffect(() => {
    const api = typeof window !== "undefined" && window.openswim && window.openswim.sync;
    if (!api || !api.onEvent) return;
    const off = api.onEvent((evt) => {
      if (evt && evt.type === "trim" && evt.uuid) {
        setTrimStatus((prev) => ({ ...prev, [evt.uuid]: evt.state }));
        if (Array.isArray(evt.cuts)) {
          setTrimCuts((prev) => ({ ...prev, [evt.uuid]: evt.cuts }));
        }
        if (Array.isArray(evt.segments)) {
          setTrimSegments((prev) => ({ ...prev, [evt.uuid]: evt.segments }));
        }
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
                model={model}
                setModel={setModel}
                modelOptions={MODEL_OPTIONS}
                sensitivity={sensitivity}
                setSensitivity={setSensitivity}
                sensitivityOptions={SENSITIVITY_OPTIONS}
                announceOn={announceOn}
                setAnnounceOn={setAnnounceOn}
                announceOff={announceOff}
                setAnnounceEpisode={setAnnounceEpisode}
                announceStatus={announceStatus}
                trimOn={trimOn}
                setTrimOn={setTrimOn}
                trimOff={trimOff}
                setTrimEpisode={setTrimEpisode}
                trimStatus={trimStatus}
                trimCuts={trimCuts}
                trimSegments={trimSegments}
                trimDecisions={trimDecisions}
                onTrimDecide={onTrimDecide}
                onTrimEdit={onTrimEdit}
                trimAudioUrls={buildTrimAudioUrls(downloadByUuid)}
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
                boost={boost}
                model={model}
                needsReviewMaxSec={thresholdSecFor(sensitivity)} />
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
