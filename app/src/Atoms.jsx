export function Btn({ variant = "primary", size, children, ...rest }) {
  const cls = ["ct-btn", `ct-btn--${variant}`, size && `ct-btn--${size}`].filter(Boolean).join(" ");
  return <button className={cls} {...rest}>{children}</button>;
}

export function Kbd({ children }) {
  return <span className="ct-kbd">{children}</span>;
}

export function Tag({ variant, children }) {
  const cls = ["ct-tag", variant && `ct-tag--${variant}`].filter(Boolean).join(" ");
  return <span className={cls}>{children}</span>;
}

export function Toggle({ on, onChange, label, dim }) {
  return (
    <div className="ct-toggle" role="switch" aria-checked={on} tabIndex={0}
      onClick={() => onChange(!on)}
      onKeyDown={(e) => (e.key === " " || e.key === "Enter") && onChange(!on)}>
      <div className="ct-toggle__track"><div className="ct-toggle__thumb"></div></div>
      <span style={{ color: dim ? "var(--fg-dim)" : "var(--fg)", fontSize: 13 }}>{label}</span>
    </div>
  );
}

export function Progress({ value }) {
  return <div className="ct-progress"><div className="ct-progress__fill" style={{ width: `${value}%` }}></div></div>;
}

const COVER_COLORS = ["#E8B44F", "#DDF4C9", "#C96F4A", "#5D3F39", "#4E342E", "#DDF4C9", "#E8B44F", "#C96F4A"];

function hashStr(s) {
  let h = 0;
  for (let i = 0; i < s.length; i++) h = (h * 31 + s.charCodeAt(i)) | 0;
  return Math.abs(h);
}

export function CoverArt({ show, size = 28 }) {
  const h = hashStr(show || "x");
  const pattern = h % 6;
  const bg = COVER_COLORS[h % COVER_COLORS.length];
  const fg = COVER_COLORS[(h + 3) % COVER_COLORS.length];
  const letters = (show || "??").replace(/[^A-Za-z]/g, "").slice(0, 2).toUpperCase() || "··";
  const bgImage =
    pattern === 0 ? `repeating-linear-gradient(45deg, ${bg} 0 3px, ${fg} 3px 4px)` :
    pattern === 1 ? `repeating-linear-gradient(0deg, ${bg} 0 4px, ${fg} 4px 5px)` :
    pattern === 2 ? `radial-gradient(circle at 30% 30%, ${fg} 0 30%, ${bg} 32%)` :
    pattern === 3 ? `linear-gradient(135deg, ${bg} 50%, ${fg} 50%)` :
    pattern === 4 ? `linear-gradient(${bg}, ${bg})` :
                    `repeating-linear-gradient(90deg, ${bg} 0 6px, ${fg} 6px 7px)`;
  const showLetters = size >= 28 && pattern !== 2 && pattern !== 3;
  return (
    <div style={{ width: size, height: size, position: "relative", flexShrink: 0, overflow: "hidden" }}>
      <div style={{ position: "absolute", inset: 0, backgroundImage: bgImage }} />
      {showLetters && (
        <div className="cover-art" style={{ position: "absolute", inset: 0,
          color: bg === "#DDF4C9" || bg === "#E8B44F" ? "var(--ct-coffee-ink)" : "var(--ct-tea)",
          fontSize: Math.max(8, size * 0.32) }}>{letters}</div>
      )}
    </div>
  );
}

export function MountPill({ state = "mounted", label, free, onClick }) {
  const labels = {
    mounted: ["OpenSwim Pro", free ? `${free} free` : "connected"],
    busy: ["OpenSwim Pro", "transferring…"],
    unmounted: ["No headphones", "plug in to transfer"],
    warning: ["OpenSwim Pro", label || "low space"],
  };
  const [main, sub] = labels[state] || labels.mounted;
  return (
    <div className="ct-mount" data-state={state} onClick={onClick} role="button" tabIndex={0}>
      <div className="ct-mount__dot"></div>
      <div>
        <div style={{ color: state === "unmounted" ? "var(--fg-muted)" : state === "warning" ? "var(--ct-error)" : "var(--fg)" }}>{main}</div>
        <div style={{ color: "var(--fg-muted)", marginTop: 2, letterSpacing: ".8px", textTransform: "none" }}>{sub}</div>
      </div>
    </div>
  );
}

export function DragHandle() {
  return (
    <svg width="12" height="14" viewBox="0 0 12 14" fill="currentColor" style={{ opacity: .45, cursor: "grab" }}>
      <circle cx="3.5" cy="3" r=".9"/><circle cx="3.5" cy="7" r=".9"/><circle cx="3.5" cy="11" r=".9"/>
      <circle cx="8.5" cy="3" r=".9"/><circle cx="8.5" cy="7" r=".9"/><circle cx="8.5" cy="11" r=".9"/>
    </svg>
  );
}
