/* global React, Btn, Toggle, CoverArt, DragHandle, Toolbar */
const { useState: useS2, useMemo: useM2 } = React;

// Pretty filename from show + slot
function slugShow(show) {
  const toks = show.toLowerCase().split(/[·\s]+/).map((t) => t.replace(/[^a-z]/g, "")).filter(Boolean);
  return (toks[0] || "show").slice(0, 8);
}
function fnameFor(show, slot, ext = "mp3") {
  return `${String(slot).padStart(2, "0")}_${slugShow(show)}.${ext}`;
}

function TodayScreen({ items, onDevice, selected, setSelected, order, setOrder,
  goSync, audioFromVideo, setAudioFromVideo, goUpNext, deviceCapacityMB, rowFateVariant }) {

  const queue = order.map((id) => items.find((x) => x.id === id)).filter(Boolean);
  const totalMin = queue.reduce((s, x) => s + x.durMin, 0);
  const totalMB = queue.reduce((s, x) => s + x.sizeMB, 0);
  const totalHM = `${Math.floor(totalMin / 60)}h ${Math.floor(totalMin % 60)}m`;
  const used = onDevice.reduce((s, x) => s + x.sizeMB, 0);
  const free = deviceCapacityMB - used;
  const overCap = totalMB > free;

  // Fate computation: previous files on device that aren't in the new queue = REMOVED
  // Queue items become either RENAME (renumbered) or NEW
  const newSlots = queue.map((it, i) => ({
    it, slot: i + 1,
    prev: onDevice.find((d) => d.show === it.show),
  }));
  const removed = onDevice.filter((d) => !queue.some((q) => q.show === d.show));

  const move = (id, dir) => {
    setOrder((o) => {
      const i = o.indexOf(id); const j = i + dir;
      if (j < 0 || j >= o.length) return o;
      const n = o.slice(); [n[i], n[j]] = [n[j], n[i]]; return n;
    });
  };
  const remove = (id) => {
    setSelected((s) => s.filter((x) => x !== id));
    setOrder((o) => o.filter((x) => x !== id));
  };

  if (!queue.length) {
    return (
      <div style={{ flex: 1, display: "flex", flexDirection: "column", alignItems: "center",
        justifyContent: "center", gap: 16 }} data-screen-label="03 Today (empty)">
        <div className="ct-label">nothing queued</div>
        <div className="ct-subhead" style={{ color: "var(--fg-dim)" }}>Your headset is empty.</div>
        <div style={{ marginTop: 8 }}><Btn variant="cta" onClick={goUpNext}>Pull from up next</Btn></div>
      </div>
    );
  }

  return (
    <div style={{ flex: 1, display: "flex", flexDirection: "column", minHeight: 0 }}
      data-screen-label="03 Today">
      <Toolbar
        label={`Today · ${queue.length} episodes`}
        title="Ready for your swim."
        subtitle={`${totalHM} · ${totalMB.toFixed(1)}MB · will write ${queue.length} file${queue.length>1?"s":""}, remove ${removed.length}`}
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
          <span> / {(free).toFixed(0)}MB free · ≈ {Math.round(totalMB / 1.8)}s at 1.8MB/s</span>
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
        <Toggle on={audioFromVideo} onChange={setAudioFromVideo} label="Audio-only from video" />
      </div>

      <div style={{ flex: 1, overflow: "auto", minHeight: 0 }}>
        <div style={{ padding: "12px 20px 6px", display: "flex", gap: 20,
          borderBottom: "1px solid var(--rule)" }}>
          <div className="ct-label" style={{ flex: 1 }}>Will write {queue.length} · device renames</div>
        </div>

        {newSlots.map(({ it, slot, prev }, idx) => {
          const fname = fnameFor(it.show, slot, it.kind === "VIDEO" && audioFromVideo ? "mp3" : it.kind === "VIDEO" ? "mp4" : "mp3");
          const isRename = prev && prev.fname && prev.fname !== fname;
          const fate = isRename ? "rename" : "new";
          return (
            <div key={it.id} className="today-row" data-fate={fate}>
              <div style={{ display: "flex", alignItems: "center", gap: 6, color: "var(--fg-muted)" }}>
                <DragHandle />
                <span style={{ fontFamily: "var(--font-mono)", fontSize: 11 }}>{String(slot).padStart(2, "0")}</span>
              </div>
              <CoverArt show={it.show} size={32} />
              <div style={{ minWidth: 0 }}>
                <div className="ct-row__title today-row__title">{it.title}
                  {it.kind === "VIDEO" && (
                    <span style={{ marginLeft: 8, fontFamily: "var(--font-mono)", fontSize: 10,
                      color: "var(--fg-muted)", letterSpacing: ".5px", padding: "1px 4px",
                      border: "1px solid var(--rule)" }}>
                      {audioFromVideo ? "VIDEO→A" : "VIDEO"}
                    </span>
                  )}
                </div>
                <div style={{ display: "flex", alignItems: "center", gap: 10, marginTop: 3 }}>
                  <div className="ct-row__show">{it.show}</div>
                  {rowFateVariant === "arrow" && prev && isRename && (
                    <div className="fname"><s>{prev.fname}</s> <em>→ {fname}</em></div>
                  )}
                  {rowFateVariant === "arrow" && !prev && (
                    <div className="fname"><em>+ {fname}</em></div>
                  )}
                  {rowFateVariant === "tag" && (
                    <>
                      {isRename && <span className="ct-tag ct-tag--active">RENAME</span>}
                      {!prev && <span className="ct-tag ct-tag--on-device">NEW</span>}
                      <div className="fname">{fname}</div>
                    </>
                  )}
                  {rowFateVariant === "stripe" && (
                    <div className="fname">{fname} {prev && isRename && <span style={{ color: "var(--ct-amber)" }}>· was {prev.fname}</span>}</div>
                  )}
                </div>
              </div>
              <div style={{ fontFamily: "var(--font-mono)", fontSize: 11,
                color: "var(--fg-dim)", textAlign: "right" }}>{it.dur}</div>
              <div style={{ fontFamily: "var(--font-mono)", fontSize: 11,
                color: "var(--fg-muted)", textAlign: "right" }}>{it.size}</div>
              <div style={{ display: "flex", gap: 2, justifyContent: "flex-end" }}>
                <button className="ct-btn ct-btn--ghost ct-btn--sm" onClick={() => move(it.id, -1)} title="move up">↑</button>
                <button className="ct-btn ct-btn--ghost ct-btn--sm" onClick={() => move(it.id, 1)} title="move down">↓</button>
                <button className="ct-btn ct-btn--ghost ct-btn--sm" onClick={() => remove(it.id)}
                  style={{ color: "var(--destructive)" }} title="remove">✕</button>
              </div>
              {rowFateVariant === "stripe" && (
                <div style={{ position: "absolute", left: 0, top: 0, bottom: 0, width: 3,
                  background: isRename ? "var(--ct-amber)" : "var(--ct-tea)" }}></div>
              )}
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

Object.assign(window, { TodayScreen, fnameFor, slugShow });
