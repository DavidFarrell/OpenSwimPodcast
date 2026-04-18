/* global React, Btn, Kbd, Tag, Toggle, Progress, CoverArt, DragHandle, Toolbar */
const { useState: useS1, useMemo: useM1 } = React;

function LoginScreen({ onConnect }) {
  const [cookie, setCookie] = useS1("");
  const [step, setStep] = useS1(0); // 0 = input, 1 = connecting, 2 = done
  const start = () => {
    setStep(1);
    setTimeout(() => { setStep(2); setTimeout(onConnect, 450); }, 1100);
  };
  return (
    <div style={{ flex: 1, display: "flex", flexDirection: "column", alignItems: "center",
      justifyContent: "center", padding: 40, position: "relative" }}>
      <div style={{ width: 68, height: 68, border: "1px solid var(--rule-strong)",
        display: "flex", alignItems: "center", justifyContent: "center", marginBottom: 28,
        fontFamily: "var(--font-mono)", fontSize: 22, color: "var(--ct-amber)",
        fontWeight: 600, letterSpacing: "1px", position: "relative" }}>
        OS
        <span style={{ position: "absolute", top: 6, right: 6, width: 5, height: 5,
          borderRadius: "50%", background: "var(--ct-amber)",
          boxShadow: "0 0 0 3px rgba(232,180,79,.15)" }}></span>
      </div>
      <div className="ct-hero" style={{ textAlign: "center" }}>Morning swim.</div>
      <div className="ct-hero" style={{ textAlign: "center", opacity: .55, fontWeight: 300 }}>Seven episodes.</div>

      <div style={{ width: 440, marginTop: 38 }}>
        <div className="ct-meta" style={{ color: "var(--fg-muted)", letterSpacing: "1.5px",
          textTransform: "uppercase", marginBottom: 10 }}>Connect Pocket Casts</div>
        <div style={{ display: "flex", flexDirection: "column", gap: 10 }}>
          <input className="ct-input" placeholder="pocketcasts session cookie…" value={cookie}
            onChange={(e) => setCookie(e.target.value)} disabled={step > 0}
            style={{ fontFamily: "var(--font-mono)", fontSize: 12 }} />
          <div style={{ display: "flex", gap: 8, justifyContent: "space-between", alignItems: "center" }}>
            <div className="ct-meta" style={{ color: "var(--fg-muted)" }}>
              stored in keychain · not shown again
            </div>
            <div style={{ display: "flex", gap: 8 }}>
              <Btn variant="ghost" disabled={step > 0}>cancel</Btn>
              <Btn variant="primary" onClick={start} disabled={step > 0}>
                {step === 0 ? "Connect" : step === 1 ? "Connecting…" : "✓ Connected"}
              </Btn>
            </div>
          </div>
        </div>
        {step >= 1 && (
          <div style={{ marginTop: 20, paddingTop: 16, borderTop: "1px solid var(--rule)" }}>
            <div className="ct-log">
              <div className={step >= 1 ? "ct-log__line--done" : "ct-log__line--pending"}>✓ keychain unlocked</div>
              <div className={step >= 1 ? "ct-log__line--done" : "ct-log__line--pending"}>✓ api.pocketcasts.com · 200</div>
              <div className={step >= 2 ? "ct-log__line--done" : "ct-log__line--active"}>
                {step >= 2 ? "✓ 28 episodes · up next fetched" : "▸ fetching up next…"}
              </div>
            </div>
          </div>
        )}
      </div>
    </div>
  );
}

function UpNextScreen({ items, selected, setSelected, goToday, onDeviceIds, mountState }) {
  const [q, setQ] = useS1("");
  const [filter, setFilter] = useS1("all");
  const filtered = useM1(() => items.filter((it) => {
    if (filter === "audio" && it.kind !== "AUDIO") return false;
    if (filter === "video" && it.kind !== "VIDEO") return false;
    if (!q) return true;
    return (it.title + " " + it.show).toLowerCase().includes(q.toLowerCase());
  }), [items, q, filter]);

  const toggle = (id) => setSelected((s) => s.includes(id) ? s.filter((x) => x !== id) : [...s, id]);
  const totalSelMin = selected.reduce((s, id) => {
    const it = items.find((x) => x.id === id); return s + (it ? it.durMin : 0);
  }, 0);
  const totalSelMB = selected.reduce((s, id) => {
    const it = items.find((x) => x.id === id); return s + (it ? it.sizeMB : 0);
  }, 0);
  const totalHM = `${Math.floor(totalSelMin / 60)}h ${Math.floor(totalSelMin % 60)}m`;

  return (
    <div style={{ flex: 1, display: "flex", flexDirection: "column", minHeight: 0 }}
      data-screen-label="02 Up Next">
      <Toolbar
        label={`Up Next · ${items.length} episodes`}
        title={selected.length ? `${selected.length} selected · ${totalHM} · ${totalSelMB.toFixed(1)}MB` : "Pick what you want on the headset today."}
        actions={<>
          <Btn variant="secondary" onClick={() => setSelected([])} disabled={!selected.length}>Clear</Btn>
          <Btn variant="primary" onClick={goToday} disabled={!selected.length}>
            Review today →
          </Btn>
        </>}
      />
      <div style={{ display: "flex", gap: 12, padding: "10px 20px",
        borderBottom: "1px solid var(--rule)", alignItems: "center" }}>
        <div className="ct-input-group" style={{ flex: 1, maxWidth: 360 }}>
          <svg width="12" height="12" viewBox="0 0 16 16" fill="none" stroke="currentColor"
            strokeWidth="1.4" style={{ color: "var(--fg-muted)" }}>
            <circle cx="7" cy="7" r="4.5"/><path d="M 10.5 10.5 L 14 14"/>
          </svg>
          <input placeholder="search up next" value={q} onChange={(e) => setQ(e.target.value)} />
          <Kbd>⌘K</Kbd>
        </div>
        <div style={{ display: "flex", gap: 4 }}>
          {["all", "audio", "video"].map((f) => (
            <button key={f} onClick={() => setFilter(f)} className="ct-btn ct-btn--xs"
              style={{
                background: filter === f ? "var(--ct-tea-ghost)" : "transparent",
                color: filter === f ? "var(--fg)" : "var(--fg-muted)",
                border: filter === f ? "1px solid var(--rule-strong)" : "1px solid var(--rule)",
              }}>{f}</button>
          ))}
        </div>
        <div style={{ flex: 1 }}></div>
        <div className="ct-meta">{filtered.length} shown</div>
      </div>
      <div style={{ flex: 1, overflow: "auto", minHeight: 0 }}>
        {filtered.map((it, idx) => {
          const isSelected = selected.includes(it.id);
          const onDevice = onDeviceIds && onDeviceIds.includes(it.id);
          return (
            <div key={it.id} className="ct-row"
              data-state={isSelected ? "selected" : undefined}
              onClick={() => toggle(it.id)}>
              <div className="ct-row__n">{String(idx + 1).padStart(2, "0")}</div>
              <CoverArt show={it.show} size={28} />
              <div className="ct-row__main">
                <div className="ct-row__title">
                  {it.title}
                  {it.kind === "VIDEO" && (
                    <span style={{ marginLeft: 8, fontFamily: "var(--font-mono)", fontSize: 10,
                      color: "var(--fg-muted)", letterSpacing: ".5px", padding: "1px 4px",
                      border: "1px solid var(--rule)" }}>VIDEO</span>
                  )}
                  {onDevice && (
                    <span style={{ marginLeft: 8, fontFamily: "var(--font-mono)", fontSize: 10,
                      color: "var(--fg-dim)", letterSpacing: ".5px" }}>· on device</span>
                  )}
                </div>
                <div className="ct-row__show">{it.show}</div>
              </div>
              <div className="ct-row__dur">{it.dur}</div>
              <div className="ct-row__size">{it.size}</div>
              <div className="ct-row__dot"></div>
            </div>
          );
        })}
      </div>
    </div>
  );
}

Object.assign(window, { LoginScreen, UpNextScreen });
