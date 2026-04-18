import { useState } from "react";
import { Btn, CoverArt, DragHandle } from "./Atoms.jsx";
import { Toolbar } from "./Shell.jsx";

function slugShow(show) {
  const toks = show.toLowerCase().split(/[·\s]+/).map((t) => t.replace(/[^a-z]/g, "")).filter(Boolean);
  return (toks[0] || "show").slice(0, 8);
}

export function fnameFor(show, slot, ext = "mp3") {
  return `${String(slot).padStart(2, "0")}_${slugShow(show)}.${ext}`;
}

function shortenError(msg) {
  if (!msg) return "error";
  if (/404/.test(msg)) return "404 not found";
  if (/403/.test(msg)) return "403 forbidden";
  if (/5\d\d/.test(msg)) return "server error";
  if (/ENOTFOUND|EAI_AGAIN|getaddrinfo/i.test(msg)) return "dns failed";
  if (/ECONNREFUSED|ECONNRESET/i.test(msg)) return "connection refused";
  if (/timeout/i.test(msg)) return "timeout";
  return msg.length > 28 ? msg.slice(0, 28) + "…" : msg;
}

function DownloadBadge({ state, onRetry }) {
  if (!state) return null;
  const { state: s, bytes = 0, total, error } = state;
  if (s === "ready") {
    return <span style={{ marginLeft: 8, color: "var(--ct-tea)", fontSize: 10 }}>✓ cached</span>;
  }
  if (s === "error") {
    return (
      <span style={{ marginLeft: 8, display: "inline-flex", alignItems: "center", gap: 6 }} title={error || "download failed"}>
        <span style={{ color: "var(--ct-error)", fontSize: 10 }}>✗ {shortenError(error)}</span>
        {onRetry && (
          <button onClick={(e) => { e.stopPropagation(); onRetry(); }}
            style={{
              fontFamily: "var(--font-mono)", fontSize: 9, letterSpacing: ".5px",
              color: "var(--ct-amber)", background: "transparent",
              border: "1px solid var(--rule)", padding: "1px 5px", cursor: "pointer",
            }}>RETRY</button>
        )}
      </span>
    );
  }
  if (s === "cancelled") {
    return <span style={{ marginLeft: 8, color: "var(--fg-muted)", fontSize: 10 }}>cancelled</span>;
  }
  const pct = total ? Math.min(100, Math.round((bytes / total) * 100)) : 0;
  return (
    <span style={{ marginLeft: 8, display: "inline-flex", alignItems: "center", gap: 6 }}>
      <span style={{ width: 40, height: 3, background: "var(--rule)", position: "relative", display: "inline-block" }}>
        <span style={{ position: "absolute", left: 0, top: 0, bottom: 0, width: `${pct}%`, background: "var(--ct-amber)" }} />
      </span>
      <span style={{ color: "var(--ct-amber)", fontSize: 10 }}>{s === "queued" ? "queued" : `${pct}%`}</span>
    </span>
  );
}

export function TodayScreen({ items, onDevice, setSelected, order, setOrder,
  goSync, goUpNext, deviceCapacityMB, downloadByUuid = {}, onRetryDownload }) {

  const queue = order.map((id) => items.find((x) => x.id === id)).filter(Boolean);
  const totalMin = queue.reduce((s, x) => s + x.durMin, 0);
  const totalMB = queue.reduce((s, x) => s + x.sizeMB, 0);
  const totalHM = `${Math.floor(totalMin / 60)}h ${Math.floor(totalMin % 60)}m`;
  const used = onDevice.reduce((s, x) => s + x.sizeMB, 0);
  const free = deviceCapacityMB - used;
  const overCap = totalMB > free;

  const [dragId, setDragId] = useState(null);
  const [dropTarget, setDropTarget] = useState(null);

  const removed = onDevice.filter((d) => !queue.some((q) => q.show === d.show));

  const remove = (id) => {
    setSelected((s) => s.filter((x) => x !== id));
    setOrder((o) => o.filter((x) => x !== id));
  };

  const handleDragStart = (id) => (e) => {
    setDragId(id);
    e.dataTransfer.effectAllowed = "move";
    try { e.dataTransfer.setData("text/plain", String(id)); } catch (_) {}
  };
  const handleDragOver = (id) => (e) => {
    e.preventDefault();
    if (dragId == null || dragId === id) { setDropTarget(null); return; }
    const rect = e.currentTarget.getBoundingClientRect();
    const pos = (e.clientY - rect.top) < rect.height / 2 ? "above" : "below";
    setDropTarget({ id, pos });
  };
  const handleDrop = (id) => (e) => {
    e.preventDefault();
    if (dragId == null || dragId === id) { setDragId(null); setDropTarget(null); return; }
    setOrder((o) => {
      const from = o.indexOf(dragId);
      let to = o.indexOf(id);
      if (from < 0 || to < 0) return o;
      const n = o.slice();
      const [m] = n.splice(from, 1);
      const rect = e.currentTarget.getBoundingClientRect();
      const pos = (e.clientY - rect.top) < rect.height / 2 ? "above" : "below";
      to = n.indexOf(id);
      n.splice(pos === "below" ? to + 1 : to, 0, m);
      return n;
    });
    setDragId(null); setDropTarget(null);
  };
  const handleDragEnd = () => { setDragId(null); setDropTarget(null); };

  if (!queue.length) {
    return (
      <div style={{ flex: 1, display: "flex", flexDirection: "column", alignItems: "center",
        justifyContent: "center", gap: 16 }}>
        <div className="ct-label">nothing queued</div>
        <div className="ct-subhead" style={{ color: "var(--fg-dim)" }}>Your headset is empty.</div>
        <div style={{ marginTop: 8 }}><Btn variant="cta" onClick={goUpNext}>Pull from up next</Btn></div>
      </div>
    );
  }

  return (
    <div style={{ flex: 1, display: "flex", flexDirection: "column", minHeight: 0 }}>
      <Toolbar
        label={`Today · ${queue.length} episodes`}
        title="Ready for your swim."
        subtitle={`${totalHM} · ${totalMB.toFixed(1)}MB · will write ${queue.length} file${queue.length > 1 ? "s" : ""}, remove ${removed.length}`}
        actions={<>
          <Btn variant="secondary" onClick={goUpNext}>+ add more</Btn>
          <Btn variant="cta" onClick={goSync} disabled={overCap}>
            {overCap ? "OVER CAPACITY" : `SYNC ${queue.length} EP`}
          </Btn>
        </>}
      />
      <div style={{ padding: "12px 20px", borderBottom: "1px solid var(--rule)",
        display: "flex", gap: 20, alignItems: "center", flexWrap: "wrap" }}>
        <div className="ct-meta">
          <span style={{ color: overCap ? "var(--ct-error)" : "var(--fg)" }}>{totalMB.toFixed(1)}MB</span>
          <span> / {free.toFixed(0)}MB free · ≈ {Math.round(totalMB / 1.8)}s at 1.8MB/s</span>
        </div>
        <div style={{ flex: 1, minWidth: 120, maxWidth: 240, height: 4,
          background: "var(--rule)", position: "relative", overflow: "hidden" }}>
          <div style={{
            position: "absolute", left: 0, top: 0, bottom: 0,
            width: `${Math.min(100, (totalMB / free) * 100)}%`,
            background: overCap ? "var(--ct-error)" : "var(--ct-amber)",
            transition: "width .28s var(--ease)" }} />
        </div>
        <div style={{ flex: 1 }}></div>
        <div className="ct-meta" style={{ color: "var(--fg-muted)" }}>drag to reorder · video converts to MP3</div>
      </div>

      <div style={{ flex: 1, overflow: "auto", minHeight: 0 }}>
        <div style={{ padding: "12px 20px 6px", display: "flex", gap: 20,
          borderBottom: "1px solid var(--rule)" }}>
          <div className="ct-label" style={{ flex: 1 }}>Will write {queue.length} · device renames</div>
        </div>

        {queue.map((it, idx) => {
          const slot = idx + 1;
          const prev = onDevice.find((d) => d.show === it.show);
          const fname = fnameFor(it.show, slot, "mp3");
          const isRename = prev && prev.fname && prev.fname !== fname;
          const fate = isRename ? "rename" : "new";
          return (
            <div key={it.id} className="today-row" data-fate={fate}
              draggable
              data-dragging={dragId === it.id ? "true" : undefined}
              data-drop-above={dropTarget && dropTarget.id === it.id && dropTarget.pos === "above" ? "true" : undefined}
              data-drop-below={dropTarget && dropTarget.id === it.id && dropTarget.pos === "below" ? "true" : undefined}
              onDragStart={handleDragStart(it.id)}
              onDragOver={handleDragOver(it.id)}
              onDrop={handleDrop(it.id)}
              onDragEnd={handleDragEnd}
              style={{ cursor: "grab" }}>
              <div style={{ display: "flex", alignItems: "center", gap: 6, color: "var(--fg-muted)" }} className="today-row__drag">
                <DragHandle />
                <span style={{ fontFamily: "var(--font-mono)", fontSize: 11 }}>{String(slot).padStart(2, "0")}</span>
              </div>
              <CoverArt show={it.show} size={32} />
              <div style={{ minWidth: 0 }}>
                <div className="ct-row__title today-row__title">{it.title}
                  {it.kind === "VIDEO" && (
                    <span style={{ marginLeft: 8, fontFamily: "var(--font-mono)", fontSize: 10,
                      color: "var(--fg-muted)", letterSpacing: ".5px", padding: "1px 4px",
                      border: "1px solid var(--rule)" }}>VIDEO→A</span>
                  )}
                </div>
                <div style={{ display: "flex", alignItems: "center", gap: 10, marginTop: 3 }}>
                  <div className="ct-row__show">{it.show}</div>
                  {isRename && <span className="ct-tag ct-tag--active">RENAME</span>}
                  {!prev && <span className="ct-tag ct-tag--on-device">NEW</span>}
                  <div className="fname">{fname}</div>
                </div>
              </div>
              <div style={{ fontFamily: "var(--font-mono)", fontSize: 11,
                color: "var(--fg-dim)", textAlign: "right" }}>{it.dur}</div>
              <div style={{ fontFamily: "var(--font-mono)", fontSize: 11,
                color: "var(--fg-muted)", textAlign: "right" }}>
                {it.size}
                <DownloadBadge state={downloadByUuid[it.uuid]}
                  onRetry={onRetryDownload ? () => onRetryDownload(it) : null} />
              </div>
              <div style={{ display: "flex", gap: 2, justifyContent: "flex-end" }}>
                <button className="ct-btn ct-btn--ghost ct-btn--sm" onClick={() => remove(it.id)}
                  style={{ color: "var(--destructive)" }} title="remove">✕</button>
              </div>
            </div>
          );
        })}

        {removed.length > 0 && (
          <>
            <div style={{ padding: "18px 20px 6px" }}>
              <div className="ct-label" style={{ color: "var(--ct-error)" }}>Will remove {removed.length} · freeing {removed.reduce((s, x) => s + x.sizeMB, 0).toFixed(1)}MB</div>
            </div>
            {removed.map((d) => (
              <div key={d.id} className="today-row" data-fate="remove" style={{ cursor: "default" }}>
                <div style={{ display: "flex", alignItems: "center", gap: 6,
                  color: "var(--ct-error)", fontFamily: "var(--font-mono)", fontSize: 11 }}>✕</div>
                <div style={{ width: 32, height: 32, background: "var(--ct-coffee-deep)",
                  display: "flex", alignItems: "center", justifyContent: "center",
                  fontFamily: "var(--font-mono)", fontSize: 10, color: "var(--fg-muted)" }}>--</div>
                <div style={{ minWidth: 0 }}>
                  <div className="today-row__title" style={{ color: "var(--fg-dim)" }}>{d.title}</div>
                  <div style={{ display: "flex", gap: 10, marginTop: 3 }}>
                    <div className="ct-row__show">{d.show}</div>
                    <div className="fname"><s>{d.fname}</s></div>
                  </div>
                </div>
                <div></div>
                <div style={{ fontFamily: "var(--font-mono)", fontSize: 11,
                  color: "var(--fg-muted)", textAlign: "right" }}>{d.size}</div>
                <div></div>
              </div>
            ))}
          </>
        )}
      </div>
    </div>
  );
}
