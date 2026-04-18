import { useEffect, useState } from "react";
import { Window, Sidebar } from "./Shell.jsx";
import { LoginScreen } from "./LoginScreen.jsx";
import { UpNextScreen } from "./UpNextScreen.jsx";
import { TodayScreen } from "./TodayScreen.jsx";
import { SyncScreen, MountDialog } from "./SyncScreen.jsx";
import { upNext as mockUpNext, onDevice, deviceCapacityMB } from "./data.js";
import { adaptUpNext, enrichFromPodcastFull } from "./pocketcastsAdapter.js";

const pc = () => (typeof window !== "undefined" && window.openswim && window.openswim.pocketcasts) || null;

export default function App() {
  const [connected, setConnected] = useState(false);
  const [route, setRouteRaw] = useState(() => localStorage.getItem("os_route") || "up-next");
  const [selected, setSelected] = useState([]);
  const [order, setOrder] = useState([]);
  const [syncArmed, setSyncArmed] = useState(false);
  const [mountState, setMountState] = useState("mounted");
  const [showMountDialog, setShowMountDialog] = useState(false);
  const [items, setItems] = useState([]);
  const [feedState, setFeedState] = useState("idle");
  const [feedError, setFeedError] = useState(null);

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
      let enriched = base;
      for (const puuid of missingPodcastUuids.slice(0, 20)) {
        const r = await api.podcastFull(puuid);
        if (cancelled) return;
        if (r.ok && r.data.podcast) {
          enriched = enrichFromPodcastFull(enriched, r.data);
          setItems(enriched);
        }
      }
    })();
    return () => { cancelled = true; };
  }, [connected]);

  useEffect(() => {
    if (connected && items.length && !selected.length) {
      setSelected(items.slice(0, 7).map((x) => x.id));
    }
  }, [connected, items]);

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
            mountState={mountState} setShowMountDialog={setShowMountDialog}
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
                deviceCapacityMB={deviceCapacityMB} />
            )}
            {route === "syncing" && (
              <SyncScreen items={items} order={order} onDevice={onDevice}
                armed={syncArmed} onArm={() => setSyncArmed(true)}
                onDone={() => { setSelected([]); setOrder([]); setSyncArmed(false); setRouteRaw("up-next"); }}
                onBack={() => { setSyncArmed(false); setRouteRaw("today"); }}
                setMountState={setMountState} />
            )}
          </main>
          {showMountDialog && (
            <MountDialog state={mountState} free={deviceCapacityMB - usedMB} used={usedMB}
              onClose={() => setShowMountDialog(false)}
              onForce={() => { setMountState("unmounted"); setShowMountDialog(false); }} />
          )}
        </div>
      </Window>
    </div>
  );
}
