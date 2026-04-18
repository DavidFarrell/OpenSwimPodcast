import { useMemo, useState } from "react";
import { Btn, CoverArt, Kbd } from "./Atoms.jsx";
import { Toolbar } from "./Shell.jsx";

export function UpNextScreen({ items, selected, setSelected, goToday, onDeviceIds, order }) {
  const [q, setQ] = useState("");
  const [filter, setFilter] = useState("all");

  const filtered = useMemo(() => items.filter((it) => {
    if (filter === "audio" && it.kind !== "AUDIO") return false;
    if (filter === "video" && it.kind !== "VIDEO") return false;
    if (!q) return true;
    return (it.title + " " + it.show).toLowerCase().includes(q.toLowerCase());
  }), [items, q, filter]);

  const toggle = (id) => setSelected((s) => s.includes(id) ? s.filter((x) => x !== id) : [...s, id]);

  const selectedItems = selected.map((id) => items.find((x) => x.id === id)).filter(Boolean);
  const knownItems = selectedItems.filter((it) => it.durMin > 0 || it.sizeMB > 0);
  const unknownCount = selectedItems.length - knownItems.length;
  const totalSelMin = knownItems.reduce((s, it) => s + it.durMin, 0);
  const totalSelMB = knownItems.reduce((s, it) => s + it.sizeMB, 0);
  const totalHM = `${Math.floor(totalSelMin / 60)}h ${Math.floor(totalSelMin % 60)}m`;
  const pendingNote = unknownCount ? ` (+${unknownCount} pending)` : "";

  return (
    <div style={{ flex: 1, display: "flex", flexDirection: "column", minHeight: 0 }}>
      <Toolbar
        label={`Up Next · ${items.length} episodes`}
        title={selected.length
          ? `${selected.length} selected · ${totalHM} · ${totalSelMB.toFixed(1)}MB${pendingNote}`
          : "Pick what you want on the headset today."}
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
          const orderPos = order ? order.indexOf(it.id) : -1;
          return (
            <div key={it.id} className="ct-row"
              data-state={isSelected ? "selected" : undefined}
              onClick={() => toggle(it.id)}>
              <div className="ct-row__n">
                {isSelected && orderPos >= 0
                  ? <span className="ct-row__order" style={{ marginLeft: 0 }}>{String(orderPos + 1).padStart(2, "0")}</span>
                  : String(idx + 1).padStart(2, "0")}
              </div>
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
