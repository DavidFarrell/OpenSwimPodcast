import { useEffect, useState } from "react";
import { Window, Sidebar } from "./Shell.jsx";
import { LoginScreen } from "./LoginScreen.jsx";
import { UpNextScreen } from "./UpNextScreen.jsx";
import { TodayScreen } from "./TodayScreen.jsx";
import { SyncScreen, MountDialog } from "./SyncScreen.jsx";
import { upNext, onDevice, deviceCapacityMB } from "./data.js";

export default function App() {
  const [connected, setConnected] = useState(() => localStorage.getItem("os_connected") === "1");
  const [route, setRouteRaw] = useState(() => localStorage.getItem("os_route") || "up-next");
  const [selected, setSelected] = useState([]);
  const [order, setOrder] = useState([]);
  const [syncArmed, setSyncArmed] = useState(false);
  const [mountState, setMountState] = useState("mounted");
  const [showMountDialog, setShowMountDialog] = useState(false);

  const items = upNext;

  useEffect(() => { localStorage.setItem("os_connected", connected ? "1" : "0"); }, [connected]);
  useEffect(() => { localStorage.setItem("os_route", route); }, [route]);

  useEffect(() => {
    if (connected && !selected.length) {
      setSelected([1, 2, 4, 5, 6, 14, 22]);
    }
  }, [connected]);

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
            mountState={mountState} setShowMountDialog={setShowMountDialog} />
          <main style={{ flex: 1, display: "flex", flexDirection: "column",
            minWidth: 0, position: "relative" }}>
            {route === "up-next" && (
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
