import { MountPill } from "./Atoms.jsx";

export function Window({ children }) {
  return (
    <div className="ct-window" style={{ width: "100%", height: "100%" }}>
      <div className="ct-window__body">{children}</div>
    </div>
  );
}

function Wordmark() {
  return (
    <div style={{ display: "flex", alignItems: "baseline", fontFamily: "var(--font-sans)",
      fontWeight: 600, fontSize: 15, letterSpacing: "-0.3px", color: "var(--fg)", lineHeight: 1 }}>
      <span>Open</span>
      <span style={{ color: "var(--ct-amber)", margin: "0 4px", fontSize: 12 }}>·</span>
      <span style={{ color: "var(--fg-dim)", fontWeight: 400 }}>Swimcast</span>
    </div>
  );
}

export function Sidebar({ route, setRoute, todayCount, mountState, mountFree, setShowMountDialog, onLogout }) {
  const items = [
    { id: "up-next", label: "Queue", meta: "POCKET CASTS" },
    { id: "today", label: "Ready", meta: todayCount ? `${todayCount} LINED UP` : "LINE UP" },
    { id: "syncing", label: "Transfer", meta: "TO HEADPHONES" },
  ];
  return (
    <aside style={{ width: 196, borderRight: "1px solid var(--rule)", padding: "18px 0 0",
      flexShrink: 0, position: "relative", display: "flex", flexDirection: "column" }}>
      <div style={{ padding: "0 18px 16px", borderBottom: "1px solid var(--rule)" }}>
        <Wordmark />
        <div style={{ marginTop: 6, fontFamily: "var(--font-mono)", fontSize: 10,
          color: "var(--fg-muted)", letterSpacing: "1.5px" }}>v0.1.0</div>
      </div>
      <nav style={{ paddingTop: 10, flex: 1 }}>
        {items.map((it) => {
          const active = route === it.id;
          return (
            <div key={it.id} onClick={() => setRoute(it.id)}
              style={{
                padding: "11px 18px", cursor: "pointer",
                background: active ? "var(--ct-tea-ghost)" : "transparent",
                borderLeft: active ? "2px solid var(--ct-tea)" : "2px solid transparent",
                paddingLeft: active ? 16 : 18,
                transition: "background .1s var(--ease)",
              }}>
              <div style={{ fontSize: 15, fontWeight: 500,
                color: active ? "var(--fg)" : "var(--fg-dim)" }}>{it.label}</div>
              <div style={{ fontFamily: "var(--font-mono)", fontSize: 10,
                color: "var(--fg-muted)", letterSpacing: "1.2px", marginTop: 3 }}>{it.meta}</div>
            </div>
          );
        })}
      </nav>
      <div style={{ padding: "14px 14px 16px", borderTop: "1px solid var(--rule)" }}>
        <MountPill state={mountState} free={mountFree} onClick={() => setShowMountDialog && setShowMountDialog(true)} />
        {onLogout && (
          <div onClick={onLogout} style={{ marginTop: 10, cursor: "pointer",
            fontFamily: "var(--font-mono)", fontSize: 10, color: "var(--fg-muted)",
            letterSpacing: "1.2px", textAlign: "center" }}>
            SIGN OUT
          </div>
        )}
      </div>
    </aside>
  );
}

export function Toolbar({ label, title, actions, subtitle }) {
  return (
    <div className="ct-toolbar">
      <div style={{ minWidth: 0 }}>
        <div className="ct-label">{label}</div>
        <div className="ct-subhead" style={{ marginTop: 4, color: "var(--fg)" }}>{title}</div>
        {subtitle && <div className="ct-meta" style={{ marginTop: 6 }}>{subtitle}</div>}
      </div>
      <div className="ct-toolbar__actions">{actions}</div>
    </div>
  );
}
