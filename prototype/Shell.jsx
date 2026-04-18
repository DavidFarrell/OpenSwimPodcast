/* global React, CoverArt, MountPill */

function Window({ title, children, badge }) {
  return (
    <div className="ct-window" style={{ width: "100%", height: "100%" }}>
      <div className="ct-window__chrome">
        <div className="ct-window__dots">
          <div className="ct-window__dot ct-window__dot--r"></div>
          <div className="ct-window__dot ct-window__dot--y"></div>
          <div className="ct-window__dot ct-window__dot--g"></div>
        </div>
        <div className="ct-window__title">{title}</div>
        <div style={{ width: 54 }}>{badge}</div>
      </div>
      <div className="ct-window__body">{children}</div>
    </div>
  );
}

function Wordmark() {
  return (
    <div style={{ display: "flex", alignItems: "baseline", fontFamily: "var(--font-sans)",
      fontWeight: 600, fontSize: 15, letterSpacing: "-0.3px", color: "var(--fg)", lineHeight: 1 }}>
      <span>OpenSwim</span>
      <span style={{ color: "var(--ct-amber)", margin: "0 4px", fontSize: 12 }}>·</span>
      <span style={{ color: "var(--fg-dim)", fontWeight: 400 }}>Podcast</span>
    </div>
  );
}

function Sidebar({ route, setRoute, todayCount, mountState, setShowMountDialog }) {
  const items = [
    { id: "up-next", label: "Up Next", meta: "POCKET CASTS" },
    { id: "today", label: "Today", meta: todayCount ? `${todayCount} QUEUED` : "QUEUE" },
    { id: "syncing", label: "Sync", meta: "DEVICE" },
  ];
  return (
    <aside style={{ width: 196, borderRight: "1px solid var(--rule)", padding: "18px 0 0",
      flexShrink: 0, position: "relative", display: "flex", flexDirection: "column" }}>
      <div style={{ padding: "0 18px 16px", borderBottom: "1px solid var(--rule)" }}>
        <Wordmark />
        <div style={{ marginTop: 6, fontFamily: "var(--font-mono)", fontSize: 10,
          color: "var(--fg-muted)", letterSpacing: "1.5px" }}>v1.2.0 · WORKBENCH</div>
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
        <MountPill state={mountState} onClick={() => setShowMountDialog && setShowMountDialog(true)} />
      </div>
    </aside>
  );
}

function Toolbar({ label, title, actions, subtitle }) {
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

Object.assign(window, { Window, Wordmark, Sidebar, Toolbar });
