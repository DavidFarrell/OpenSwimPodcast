/* global React, ReactDOM, Btn */
const { useState, useEffect } = React;

const TWEAK_DEFAULTS = /*EDITMODE-BEGIN*/{
  "rowFateVariant": "arrow",
  "syncLayoutVariant": "stages"
}/*EDITMODE-END*/;

function Tweaks({ tweaks, setTweaks, onClose }) {
  const set = (k, v) => {
    const n = { ...tweaks, [k]: v };
    setTweaks(n);
    window.parent.postMessage({ type: "__edit_mode_set_keys", edits: { [k]: v } }, "*");
  };
  return (
    <div className="ct-tweaks">
      <div className="ct-tweaks__head">
        <div className="ct-label" style={{ color: "var(--fg)" }}>Tweaks</div>
        <button className="ct-btn ct-btn--ghost ct-btn--sm" onClick={onClose}>✕</button>
      </div>
      <div className="ct-tweaks__body">
        <div className="ct-tweaks__group">
          <div className="ct-label">Today row-fate</div>
          <div className="ct-tweaks__opts">
            {["arrow", "tag", "stripe"].map((v) => (
              <button key={v} className="ct-tweaks__opt"
                data-active={tweaks.rowFateVariant === v}
                onClick={() => set("rowFateVariant", v)}>{v}</button>
            ))}
          </div>
        </div>
        <div className="ct-tweaks__group">
          <div className="ct-label">Sync layout</div>
          <div className="ct-tweaks__opts">
            {["stages", "log-only"].map((v) => (
              <button key={v} className="ct-tweaks__opt"
                data-active={tweaks.syncLayoutVariant === v}
                onClick={() => set("syncLayoutVariant", v)}>{v}</button>
            ))}
          </div>
        </div>
      </div>
    </div>
  );
}

function App() {
  const [connected, setConnected] = useState(() => localStorage.getItem("os_connected") === "1");
  const [route, setRoute] = useState(() => localStorage.getItem("os_route") || "up-next");
  const [selected, setSelected] = useState([]);
  const [order, setOrder] = useState([]);
  const [audioFromVideo, setAudioFromVideo] = useState(true);
  const [mountState, setMountState] = useState("mounted");
  const [showMountDialog, setShowMountDialog] = useState(false);
  const [tweaks, setTweaks] = useState(TWEAK_DEFAULTS);
  const [tweaksOpen, setTweaksOpen] = useState(false);

  const items = window.APP_DATA.upNext;
  const onDevice = window.APP_DATA.onDevice;
  const deviceCapacityMB = window.APP_DATA.deviceCapacityMB;

  useEffect(() => { localStorage.setItem("os_connected", connected ? "1" : "0"); }, [connected]);
  useEffect(() => { localStorage.setItem("os_route", route); }, [route]);

  // Preselect 7 default items first time for quicker demo
  useEffect(() => {
    if (connected && !selected.length) {
      const defaults = [1, 2, 4, 5, 6, 14, 22];
      setSelected(defaults);
    }
  }, [connected]);

  useEffect(() => {
    setOrder((prev) => {
      const keep = prev.filter((id) => selected.includes(id));
      const adds = selected.filter((id) => !keep.includes(id));
      return [...keep, ...adds];
    });
  }, [selected]);

  // Tweaks protocol
  useEffect(() => {
    const h = (e) => {
      if (e.data && e.data.type === "__activate_edit_mode") setTweaksOpen(true);
      if (e.data && e.data.type === "__deactivate_edit_mode") setTweaksOpen(false);
    };
    window.addEventListener("message", h);
    window.parent.postMessage({ type: "__edit_mode_available" }, "*");
    return () => window.removeEventListener("message", h);
  }, []);

  const onDeviceIds = onDevice.map((d) => items.find((x) => x.show === d.show)?.id).filter(Boolean);
  const usedMB = onDevice.reduce((s, x) => s + x.sizeMB, 0);

  if (!connected) {
    return (
      <div style={{ width: "100%", height: "100%", boxSizing: "border-box" }}>
        <Window title="openswim · sign in">
          <LoginScreen onConnect={() => setConnected(true)} />
        </Window>
      </div>
    );
  }

  return (
    <div style={{ width: "100%", height: "100%", boxSizing: "border-box" }}>
      <Window title={`openswim · ${route}`}>
        <div style={{ flex: 1, display: "flex", minHeight: 0, position: "relative" }}>
          <Sidebar route={route} setRoute={setRoute} todayCount={selected.length}
            mountState={mountState} setShowMountDialog={setShowMountDialog} />
          <main style={{ flex: 1, display: "flex", flexDirection: "column",
            minWidth: 0, position: "relative" }}>
            {route === "up-next" && (
              <UpNextScreen items={items} selected={selected} setSelected={setSelected}
                goToday={() => setRoute("today")} onDeviceIds={onDeviceIds} mountState={mountState} />
            )}
            {route === "today" && (
              <TodayScreen items={items} onDevice={onDevice} selected={selected} setSelected={setSelected}
                order={order} setOrder={setOrder}
                goSync={() => setRoute("syncing")}
                audioFromVideo={audioFromVideo} setAudioFromVideo={setAudioFromVideo}
                goUpNext={() => setRoute("up-next")}
                deviceCapacityMB={deviceCapacityMB}
                rowFateVariant={tweaks.rowFateVariant} />
            )}
            {route === "syncing" && (
              <SyncScreen items={items} order={order} onDevice={onDevice}
                audioFromVideo={audioFromVideo}
                onDone={() => { setSelected([]); setOrder([]); setRoute("up-next"); }}
                onBack={() => setRoute("today")}
                syncLayoutVariant={tweaks.syncLayoutVariant}
                setMountState={setMountState} />
            )}
          </main>
          {showMountDialog && (
            <MountDialog state={mountState} free={deviceCapacityMB - usedMB} used={usedMB}
              onClose={() => setShowMountDialog(false)}
              onForce={() => { setMountState("unmounted"); setShowMountDialog(false); }} />
          )}
          {tweaksOpen && <Tweaks tweaks={tweaks} setTweaks={setTweaks} onClose={() => setTweaksOpen(false)} />}
        </div>
      </Window>
    </div>
  );
}

ReactDOM.createRoot(document.getElementById("root")).render(<App />);
