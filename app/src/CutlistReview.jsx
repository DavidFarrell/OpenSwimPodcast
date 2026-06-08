import {
  hasFlaggedCuts, reviewRows, timestampValue, parseTimestamp,
  setBoundary, nudgeBoundary, playBeforeWindow, playAfterWindow,
  previewJoinWindows, NUDGE_STEP_SEC,
} from "./cutlistReview.js";

// Coarse cut-list review surface (P3a + P3b). Shown ONLY for episodes that have
// at least one FLAGGED (needs-review) cut. Each row is a single proposed cut with
// a headline ("Mid-roll 23:10-24:05"), the reason it was flagged, its length, and:
//   - KEEP / REMOVE controls (P3a) - the trust gate decision.
//   - play-before / play-after / preview-join audio previews (P3b).
//   - -5s / +5s coarse nudges on each boundary and editable start/end
//     timestamps (P3b) - adjust the cut's boundaries before it is applied.
//
// This is intentionally coarse: not a waveform editor, not a transcript editor.
// The confident cuts already auto-applied; these are the ones the pipeline
// declined to cut on its own.
//
// CARDINAL RULE: default is KEEP, and editing a boundary never produces an
// invalid (start >= end) range - the math in cutlistReview.js no-ops such edits.
// A cut is removed only when the user explicitly chooses REMOVE.
//   onDecide(uuid, cut, "keep" | "remove") records the keep/remove choice.
//   onEditCut(uuid, originalCut, newCut) records a boundary edit (nudge or typed
//     timestamp). The App persists the edited boundaries; if no handler is wired
//     the controls are simply inert (audio preview still works).
//   audioUrl is the converted-or-original episode file the <audio> element plays
//     for the previews; previews are disabled when it is absent.
export function CutlistReview({
  uuid, trimEntry, decisions = {}, onDecide, onEditCut, audioUrl,
}) {
  const rows = reviewRows(trimEntry, decisions);
  // Plain refs (no hooks) so the component is renderable by a direct function
  // call in tests as well as by React. A callback ref captures the <audio>
  // element; the onClick handlers close over these.
  const audioRef = { current: null };
  // For preview-join we play the "before" window, then on its end seek to the
  // "after" window. This holds the pending second window so the ticker knows to
  // jump rather than stop.
  const pendingJoin = { current: null };

  // Render nothing when there is nothing flagged - no clutter for the common
  // case where every cut auto-applied (or there were none).
  if (!hasFlaggedCuts(trimEntry)) return null;

  const decide = (cut, decision) => {
    if (onDecide) onDecide(uuid, cut, decision);
  };

  const editCut = (cut, newCut) => {
    // setBoundary / nudgeBoundary return the SAME object when an edit is a no-op
    // (would invert the range or was unparseable). Skip the callback in that case
    // so we never record a non-change.
    if (newCut && newCut !== cut && onEditCut) onEditCut(uuid, cut, newCut);
  };

  // Play a single [from,to] window on the shared <audio> element. Stops any
  // pending preview-join first. Safe no-op when there is no audio element/url.
  const playWindow = (win) => {
    pendingJoin.current = null;
    const el = audioRef.current;
    if (!el || !win) return;
    el.pause();
    el.currentTime = win.from;
    const stopAt = () => {
      if (el.currentTime >= win.to) { el.pause(); el.removeEventListener("timeupdate", stopAt); }
    };
    el.addEventListener("timeupdate", stopAt);
    const p = el.play();
    if (p && typeof p.catch === "function") p.catch(() => {});
  };

  // Play the join preview: the "before" window, then seek to "after".
  const playJoin = (cut) => {
    const win = previewJoinWindows(cut);
    const el = audioRef.current;
    if (!el || !win) return;
    pendingJoin.current = win.after;
    el.pause();
    el.currentTime = win.before.from;
    const onTick = () => {
      if (pendingJoin.current === win.after && el.currentTime >= win.before.to) {
        // Hop the gap to the "after" side, then play it out and stop.
        el.currentTime = win.after.from;
        el.removeEventListener("timeupdate", onTick);
        const stopAfter = () => {
          if (el.currentTime >= win.after.to) { el.pause(); el.removeEventListener("timeupdate", stopAfter); pendingJoin.current = null; }
        };
        el.addEventListener("timeupdate", stopAfter);
      }
    };
    el.addEventListener("timeupdate", onTick);
    const p = el.play();
    if (p && typeof p.catch === "function") p.catch(() => {});
  };

  const previewsOn = !!audioUrl;
  const previewBtnStyle = (enabled) => ({
    fontFamily: "var(--font-mono)", fontSize: 10, letterSpacing: ".5px",
    padding: "2px 6px", border: "1px solid var(--rule)",
    cursor: enabled ? "pointer" : "not-allowed", background: "transparent",
    color: enabled ? "var(--fg-muted)" : "var(--fg-dim)", opacity: enabled ? 1 : 0.5,
  });
  const nudgeBtnStyle = {
    fontFamily: "var(--font-mono)", fontSize: 10, padding: "1px 4px",
    border: "1px solid var(--rule)", cursor: "pointer", background: "transparent",
    color: "var(--fg-muted)",
  };
  const tsInputStyle = {
    fontFamily: "var(--font-mono)", fontSize: 11, width: 64, textAlign: "center",
    border: "1px solid var(--rule)", background: "var(--ct-coffee-deep)",
    color: "var(--fg)", padding: "1px 2px",
  };

  return (
    <div className="cutlist-review" data-uuid={uuid || ""}
      style={{ borderTop: "1px solid var(--rule)", padding: "8px 20px 12px",
        background: "var(--ct-coffee-deep)" }}>
      <div className="ct-label" style={{ color: "var(--ct-amber)", marginBottom: 6 }}>
        {rows.length} cut{rows.length > 1 ? "s" : ""} need a decision
      </div>
      <div style={{ fontSize: 11, color: "var(--fg-muted)", marginBottom: 8 }}>
        These were left intact because they were ambiguous or over the safe length.
        Preview the join, nudge the boundaries if needed, then choose remove to cut
        or keep to leave the audio in place.
      </div>
      {audioUrl && (
        <audio ref={(el) => { audioRef.current = el; }} src={audioUrl} preload="none"
          className="cutlist-review__audio" data-testid="cutlist-audio" />
      )}
      {rows.map((row) => (
        <div key={row.key} className="cutlist-review__row" data-cut-key={row.key}
          data-decision={row.decision}
          style={{ display: "flex", flexDirection: "column", gap: 6, padding: "8px 0",
            borderTop: "1px solid var(--rule)" }}>
          <div style={{ display: "flex", alignItems: "center", gap: 12 }}>
            <div style={{ flex: 1, minWidth: 0 }}>
              <div style={{ fontFamily: "var(--font-mono)", fontSize: 12, color: "var(--fg)" }}>
                {row.headline}
                {row.duration && (
                  <span style={{ marginLeft: 8, color: "var(--fg-muted)", fontSize: 10 }}>
                    {row.duration}
                  </span>
                )}
              </div>
              <div style={{ fontSize: 10, color: "var(--fg-muted)", marginTop: 2 }}>{row.reason}</div>
            </div>
            <div style={{ display: "flex", gap: 2 }}>
              <button className="ct-btn ct-btn--xs cutlist-review__keep"
                onClick={() => decide(row.cut, "keep")}
                aria-pressed={row.decision === "keep"}
                title="leave this audio in place"
                style={{ fontFamily: "var(--font-mono)", fontSize: 10, letterSpacing: ".5px",
                  padding: "2px 8px", border: "1px solid var(--rule)", cursor: "pointer",
                  background: row.decision === "keep" ? "var(--ct-tea-ghost)" : "transparent",
                  color: row.decision === "keep" ? "var(--fg)" : "var(--fg-muted)" }}>
                KEEP
              </button>
              <button className="ct-btn ct-btn--xs cutlist-review__remove"
                onClick={() => decide(row.cut, "remove")}
                aria-pressed={row.decision === "remove"}
                title="cut this block from the episode"
                style={{ fontFamily: "var(--font-mono)", fontSize: 10, letterSpacing: ".5px",
                  padding: "2px 8px", border: "1px solid var(--rule)", cursor: "pointer",
                  background: row.decision === "remove" ? "var(--ct-amber)" : "transparent",
                  color: row.decision === "remove" ? "var(--ct-coffee-deep)" : "var(--fg-muted)" }}>
                REMOVE
              </button>
            </div>
          </div>

          {/* P3b: preview + boundary-edit controls */}
          <div style={{ display: "flex", alignItems: "center", gap: 10, flexWrap: "wrap" }}>
            <div style={{ display: "flex", gap: 2 }}>
              <button className="cutlist-review__play-before" disabled={!previewsOn}
                onClick={() => playWindow(playBeforeWindow(row.cut))}
                title="play a few seconds before the cut"
                style={previewBtnStyle(previewsOn)}>▶ BEFORE</button>
              <button className="cutlist-review__play-after" disabled={!previewsOn}
                onClick={() => playWindow(playAfterWindow(row.cut))}
                title="play a few seconds after the cut"
                style={previewBtnStyle(previewsOn)}>▶ AFTER</button>
              <button className="cutlist-review__preview-join" disabled={!previewsOn}
                onClick={() => playJoin(row.cut)}
                title="play across the proposed join (before then after)"
                style={previewBtnStyle(previewsOn)}>▶ JOIN</button>
            </div>

            <div style={{ display: "flex", alignItems: "center", gap: 4 }}>
              <span style={{ fontSize: 10, color: "var(--fg-dim)" }}>start</span>
              <button className="cutlist-review__start-minus"
                onClick={() => editCut(row.cut, nudgeBoundary(row.cut, "start", -NUDGE_STEP_SEC))}
                title={`move start ${NUDGE_STEP_SEC}s earlier`} style={nudgeBtnStyle}>-{NUDGE_STEP_SEC}s</button>
              <input className="cutlist-review__start-input" type="text"
                defaultValue={timestampValue(row.cut.startSec)}
                key={`s-${row.key}`}
                onBlur={(e) => {
                  const sec = parseTimestamp(e.target.value);
                  if (sec == null) { e.target.value = timestampValue(row.cut.startSec); return; }
                  const next = setBoundary(row.cut, "start", sec);
                  if (next === row.cut) e.target.value = timestampValue(row.cut.startSec);
                  else editCut(row.cut, next);
                }}
                onKeyDown={(e) => { if (e.key === "Enter") e.target.blur(); }}
                title="edit the cut start (mm:ss)" style={tsInputStyle} />
              <button className="cutlist-review__start-plus"
                onClick={() => editCut(row.cut, nudgeBoundary(row.cut, "start", NUDGE_STEP_SEC))}
                title={`move start ${NUDGE_STEP_SEC}s later`} style={nudgeBtnStyle}>+{NUDGE_STEP_SEC}s</button>
            </div>

            <div style={{ display: "flex", alignItems: "center", gap: 4 }}>
              <span style={{ fontSize: 10, color: "var(--fg-dim)" }}>end</span>
              <button className="cutlist-review__end-minus"
                onClick={() => editCut(row.cut, nudgeBoundary(row.cut, "end", -NUDGE_STEP_SEC))}
                title={`move end ${NUDGE_STEP_SEC}s earlier`} style={nudgeBtnStyle}>-{NUDGE_STEP_SEC}s</button>
              <input className="cutlist-review__end-input" type="text"
                defaultValue={timestampValue(row.cut.endSec)}
                key={`e-${row.key}`}
                onBlur={(e) => {
                  const sec = parseTimestamp(e.target.value);
                  if (sec == null) { e.target.value = timestampValue(row.cut.endSec); return; }
                  const next = setBoundary(row.cut, "end", sec);
                  if (next === row.cut) e.target.value = timestampValue(row.cut.endSec);
                  else editCut(row.cut, next);
                }}
                onKeyDown={(e) => { if (e.key === "Enter") e.target.blur(); }}
                title="edit the cut end (mm:ss)" style={tsInputStyle} />
              <button className="cutlist-review__end-plus"
                onClick={() => editCut(row.cut, nudgeBoundary(row.cut, "end", NUDGE_STEP_SEC))}
                title={`move end ${NUDGE_STEP_SEC}s later`} style={nudgeBtnStyle}>+{NUDGE_STEP_SEC}s</button>
            </div>
          </div>
        </div>
      ))}
    </div>
  );
}

export default CutlistReview;
