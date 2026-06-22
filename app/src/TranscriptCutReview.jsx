import {
  sentenceLines, selectableCuts, selectedToRanges,
  panelSummary, selectedCount, heldLines, heldCutCount,
} from "./transcriptToggle.js";
import { previewJoinWindows } from "./cutlistReview.js";
import { degradeSummary } from "./degradeSummary.js";
import { paintDecision } from "./dragPaint.js";

// Drag-paint gesture state (slice 5). MODULE-level, not a per-render object, for two
// reasons: (a) only ONE pointer drag can be active across the whole document at a
// time, so a singleton is the honest model; (b) the component uses no hooks, so a
// per-render `{current}` object would be re-created on every re-render and lose the
// in-flight gesture exactly when a paint toggles `selected` and re-renders the panel.
// All gesture state lives here (a module ref) and never in React state - React
// batching may not have committed before the next pointer event, which would make a
// state read stale and miss lines. `painted` records indices toggled THIS gesture so
// a line resolved twice toggles once and the decision stays correct against the
// canonical parent set. `cleanup` detaches the document listeners + restores
// user-select; it is the single teardown for pointerup AND pointercancel.
// Exported as `__gesture` so the gesture tests can white-box the singleton (assert the
// active-panel scope and the re-entrant teardown without a real DOM). Not part of the
// component's public API - the leading underscore marks it internal.
export const __gesture = {
  dragging: false, uuid: null, pointerId: null, bodyEl: null, paintWantsSelected: false,
  visited: null, painted: null, lastIndex: null, cleanup: null,
};
const gesture = __gesture;

// Unified per-episode transcript-toggle review surface (redesign of CutlistReview +
// TranscriptEvidence). ONE collapsible panel per episode that has cuts. The header
// summarises what the detector found ("Intro + 2 mid-rolls"); clicking it expands
// the FULL, scrollable transcript split into SENTENCES. Sentences the detector
// flagged start highlighted YELLOW (in the cut); everything else GREY (kept).
// CLICKING a sentence toggles it in/out of the cut at sentence granularity - so the
// user can EXTEND a cut (select lines the detector missed) or SHRINK it (de-select a
// wrongly-grabbed line) anywhere in the transcript, by READING and CLICKING.
//
// At "Continue", the YELLOW sentences become the final cut set = the maximal
// CONTIGUOUS runs of selected sentences (see transcriptToggle.selectedToRanges).
// Grey is kept. Nothing not-yellow is cut.
//
// CONTROLLED component: the parent owns the `selected` Set (so the Continue commit
// can read the authoritative final selection) and the per-sentence toggle handler.
// The parent seeds `selected` from transcriptToggle.preselectFromCuts so the
// detector's cuts start yellow - default behaviour matches today (the detector's
// cuts get cut unless the user greys them).
//
// CARDINAL RULE: a sentence is cut ONLY when it is yellow (selected) at Continue.
// The toggle never cuts anything itself; it just changes the selection the commit
// reads. The audio preview is SECONDARY (David prefers to read) - a small ▶ per
// selected run and per line, never the primary interaction.
//
//   uuid              episode id (forwarded to onToggleSentence).
//   transcript        the in-app transcript ({segments:[...]} or a bare array).
//   trimEntry         { cuts: [...] } - the detector's proposed cut list (the same
//                     shape CutlistReview received). Drives the header summary and
//                     the initial yellow set (via the parent's preselect).
//   selected          Set of selected sentence indices (the yellow set). Controlled.
//   onToggleSentence  (uuid, index) => void - toggle one sentence in/out.
//   audioUrl          the converted-or-original episode file the <audio> previews
//                     play; previews are disabled (and the ▶ buttons inert) without it.
//   open              CONTROLLED open state, owned by SyncScreen (openUuids.has(uuid)).
//                     The <details open> attribute reflects this prop; the component
//                     does NOT self-manage open. Every open is a deliberate user (or,
//                     in slice 4, programmatic) action routed through the parent; the
//                     held-count summary cue is the collapsed nudge, not an auto-open.
//   onOpenChange      (uuid, isOpen) => void - fired on the native <details> toggle,
//                     reporting the DESIRED open/close so the parent's open-set follows
//                     the user. The parent captures the snapshot on the FIRST open and
//                     drops the uuid on close (no re-capture, no un-review).
//   degrade           { degraded, windowsFailed, windowsRun } - the incomplete-detection
//                     signal. When degraded, a warning row is rendered telling the user
//                     the cuts shown may be missing some ads. PURELY INFORMATIONAL: it
//                     never changes the selection or what gets cut.
//
// Renders nothing when there is no usable cut OR no usable transcript - no clutter
// for episodes whose cuts all auto-applied with nothing to read, matching today. (A
// DEGRADED episode with zero cuts is surfaced by the parent gate, not here - this
// panel still needs a cut + a transcript body to be worth opening.)
export function TranscriptCutReview({
  uuid, transcript, trimEntry, selected, onToggleSentence, audioUrl, open = false, onOpenChange, degrade,
}) {
  const cuts = selectableCuts(trimEntry);
  const lines = sentenceLines(transcript);
  if (cuts.length === 0 || lines.length === 0) return null;

  const sel = selected instanceof Set ? selected : new Set();

  // The lines belonging to a HELD (needs-review) cut - the detector found them but was
  // NOT sure, so they start GREY (kept) and carry a ⚑ review marker in the gutter so a
  // held cut is findable instead of invisible among the kept lines (the "1 mid-roll
  // found but 0 lines selected, nothing highlighted" case). The ⚑ is an ANNOTATION
  // AXIS, orthogonal to the binary cut/keep the text colour shows: a held line keeps
  // its ⚑ whether or not the user opts it into the yellow set, and a confident cut
  // never gets a ⚑. Marking never selects - the cardinal rule (cut only the yellow set
  // at Continue) is unchanged. "Unreviewed" = held AND not yet selected: those drive the
  // jump button. The panel no longer auto-opens on held cuts; the held-count cue on the
  // <summary> (shown while collapsed) is now the only nudge, with the jump button
  // reachable once the user opens the panel.
  const held = heldLines(lines, trimEntry);
  const heldCount = heldCutCount(trimEntry);

  // Plain refs (no hooks) so the component is renderable by a direct function call
  // in tests as well as by React. A callback ref captures the shared <audio>; the
  // ▶ handlers close over it. Mirrors CutlistReview's no-hooks audio approach.
  const audioRef = { current: null };
  const pendingJoin = { current: null };
  const previewsOn = !!audioUrl;

  // Navigation to a held cut now lives in ONE modal-level navigator in SyncScreen
  // (slice 4), not per panel - so the per-panel "jump to first" button is gone. The
  // ⚑ gutter markers and the collapsed-summary "N flagged for review" cue remain as
  // the nudge that a cut is held here.

  // The first sentence index of each contiguous selected run, so we can show a
  // single ▶ at the head of a run (preview the join across that run) rather than one
  // ▶ per line. A line is a "run head" when it is selected and the previous line is
  // not selected (or it is the first line).
  const runHeads = new Set();
  let prevSel = false;
  for (const line of lines) {
    const isSel = sel.has(line.index);
    if (isSel && !prevSel) runHeads.add(line.index);
    prevSel = isSel;
  }

  // Build the { startSec, endSec } cut ranges from the current selection so a run's
  // ▶ can preview the join for the WHOLE run it belongs to (find the range whose
  // start matches a run head). Pure, cheap, recomputed per render.
  const ranges = selectedToRanges(lines, sel);
  const rangeForHead = (line) => {
    const mid = (line.startSec + line.endSec) / 2;
    return ranges.find((r) => mid >= r.startSec && mid <= r.endSec) || { startSec: line.startSec, endSec: line.endSec };
  };

  // Play a single [from,to] window on the shared <audio>. Stops any pending join
  // first. Safe no-op without an audio element/url. (Copied shape from CutlistReview.)
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

  // Play the join preview for a cut range: a few seconds before its start, then hop
  // to a few seconds after its end (how it sounds once the range is removed).
  const playJoin = (range) => {
    const win = previewJoinWindows({ startSec: range.startSec, endSec: range.endSec });
    const el = audioRef.current;
    if (!el || !win) return;
    pendingJoin.current = win.after;
    el.pause();
    el.currentTime = win.before.from;
    const onTick = () => {
      if (pendingJoin.current === win.after && el.currentTime >= win.before.to) {
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

  const toggle = (index) => { if (onToggleSentence) onToggleSentence(uuid, index); };

  // Ref to the scrollable transcript body so a drag can suppress native text
  // selection on it (user-select: none) - without that, dragging highlights text
  // instead of painting. Restored when the gesture ends. Plain object ref, no hook.
  const bodyRef = { current: null };

  // Is a given line index selected RIGHT NOW for the purposes of the gesture? Reads
  // the canonical parent set first, then overlays the indices already painted THIS
  // gesture (the parent re-render may not have landed before the next pointermove, so
  // `sel` can lag). This keeps paintDecision correct on a fast drag.
  const gestureIsSelected = (index) => {
    if (gesture.painted && gesture.painted.has(index)) return gesture.paintWantsSelected;
    return sel.has(index);
  };

  // Resolve the line index under a pointer event via elementFromPoint + closest
  // [data-index] - NOT pointerenter/pointerover, whose retargeting is unreliable
  // across the nested gutter/time/text spans. SCOPED to the panel that started the
  // gesture: the resolved line must live inside this gesture's own transcript body,
  // so dragging out of this panel (over another episode's lines, or the modal chrome)
  // resolves to null and paints nothing - a drag can only ever touch the lines of the
  // panel it began in. Returns a number or null.
  const lineIndexAtPoint = (clientX, clientY) => {
    if (typeof document === "undefined" || !document.elementFromPoint) return null;
    const el = document.elementFromPoint(clientX, clientY);
    const line = el && el.closest && el.closest("[data-index]");
    if (!line) return null;
    const scope = gesture.bodyEl;
    if (scope && scope.contains && !scope.contains(line)) return null;
    const raw = line.getAttribute("data-index");
    const idx = Number(raw);
    return Number.isInteger(idx) ? idx : null;
  };

  // Toggle one line into the paint target, once. Pure decision via paintDecision; the
  // gesture's `visited`/`painted` bookkeeping makes each line toggle at most once and
  // keeps the decision correct against the canonical set even as the parent re-renders.
  const paintOne = (index) => {
    if (gesture.visited.has(index)) return;
    gesture.visited.add(index);
    if (paintDecision(gestureIsSelected(index), gesture.paintWantsSelected)) {
      gesture.painted.add(index);
      toggle(index);
    }
  };

  // Paint the line under the pointer. Because lines render top-to-bottom in index
  // order, a FAST move that skips intermediate lines is filled in: paint every index
  // between the last-resolved line and the new one (inclusive), so a quick flick from
  // line 0 to line 3 still paints 1 and 2 instead of dropping them (which would read
  // as data loss). `visited` keeps each filled line a single toggle.
  const paintAt = (clientX, clientY) => {
    if (!gesture.dragging) return;
    const index = lineIndexAtPoint(clientX, clientY);
    if (index == null) {
      // Pointer left this panel's lines. Drop the fill anchor so a later re-entry does
      // NOT bridge the gap and toggle lines the pointer skipped OUTSIDE the panel.
      gesture.lastIndex = null;
      return;
    }
    const last = gesture.lastIndex;
    if (last != null && last !== index) {
      const step = index > last ? 1 : -1;
      for (let i = last + step; i !== index; i += step) paintOne(i);
    }
    paintOne(index);
    gesture.lastIndex = index;
  };

  const onLinePointerDown = (e, index, wasSelected) => {
    // Only paint on a primary-button press. preventDefault so the drag paints instead
    // of starting a native text selection.
    if (e.button != null && e.button !== 0) return;

    const pointerId = e.pointerId;
    // A drag owned by a DIFFERENT live pointer is in progress (a second finger / pen
    // pressing mid-drag). Ignore the new press entirely: do not preventDefault, do not
    // toggle, do not hijack the gesture. Only the owning pointer drives or ends a drag.
    if (gesture.dragging && gesture.pointerId != null && pointerId != null
      && gesture.pointerId !== pointerId) return;

    if (e.preventDefault) e.preventDefault();

    // Defensive: if a previous gesture is STILL live for THIS pointer (a missed pointerup
    // / a stale gesture), tear it down FIRST so its document listeners are removed and we
    // never run two gestures - that would leak listeners and let a stale closure paint.
    if (gesture.cleanup) gesture.cleanup();

    // The pointerdown TOGGLES the anchor (same as a click) and seeds the gesture: the
    // paint target is the anchor's NEW state, and the anchor counts as visited+painted
    // so a release-in-place toggles it exactly once.
    const wantsSelected = !wasSelected;
    toggle(index);

    const body = bodyRef.current;
    // The pointer that owns this gesture - moves/ends from a SECOND pointer (a second
    // finger / a pen) are ignored, so only the painting pointer drives or ends the paint.
    gesture.dragging = true;
    gesture.uuid = uuid;
    gesture.pointerId = pointerId;
    gesture.bodyEl = body;            // scope: paint only lines inside this panel's body
    gesture.paintWantsSelected = wantsSelected;
    gesture.visited = new Set([index]);
    gesture.painted = new Set([index]);
    gesture.lastIndex = index;        // anchor is the start point for fast-drag fill

    // Save any prior inline user-select so we restore it (not blank it) on cleanup, then
    // suppress text selection on the body for the duration of the drag.
    const priorUserSelect = body ? body.style.userSelect : "";
    if (body) body.style.userSelect = "none";

    // A pointer event belongs to THIS gesture only if it carries no pointerId (mouse in
    // some engines / our tests) or matches the pointer that started the drag. A second
    // finger / pen must not drive or end the active paint.
    const isOwner = (ev) => pointerId == null || ev.pointerId == null || ev.pointerId === pointerId;
    const onMove = (ev) => {
      if (!isOwner(ev)) return;
      // Self-heal a MISSED pointerup (e.g. release outside the window): if no button is
      // down on this move, the drag is over - tear down instead of painting a phantom.
      if (ev.buttons === 0) { if (gesture.cleanup) gesture.cleanup(); return; }
      paintAt(ev.clientX, ev.clientY);
    };
    // pointerup/pointercancel end the gesture only for the OWNING pointer; a second
    // pointer's release must not tear down the active drag.
    const onEnd = (ev) => { if (isOwner(ev || {})) { if (gesture.cleanup) gesture.cleanup(); } };
    // window blur always ends the gesture (no pointer to own) - the release-off-window backstop.
    const onBlur = () => { if (gesture.cleanup) gesture.cleanup(); };
    gesture.cleanup = () => {
      if (typeof document !== "undefined") {
        document.removeEventListener("pointermove", onMove);
        document.removeEventListener("pointerup", onEnd);
        document.removeEventListener("pointercancel", onEnd);
      }
      // A release outside the document never fires document pointerup; window blur is the
      // backstop that ends the gesture and frees the listeners + restores user-select.
      if (typeof window !== "undefined") window.removeEventListener("blur", onBlur);
      if (body) body.style.userSelect = priorUserSelect;
      gesture.dragging = false;
      gesture.uuid = null;
      gesture.pointerId = null;
      gesture.bodyEl = null;
      gesture.visited = null;
      gesture.painted = null;
      gesture.lastIndex = null;
      gesture.cleanup = null;
    };
    if (typeof document !== "undefined") {
      document.addEventListener("pointermove", onMove);
      document.addEventListener("pointerup", onEnd);
      document.addEventListener("pointercancel", onEnd);
    }
    if (typeof window !== "undefined") window.addEventListener("blur", onBlur);
  };

  // A line's click handler. The toggle is driven by the POINTER path (onLinePointerDown)
  // so a mouse press-and-release toggles exactly once. But pointerdown does NOT fire on
  // keyboard activation (Enter/Space on a focused button), which still emits a click with
  // detail === 0. So onClick toggles ONLY for keyboard activation (detail 0); mouse
  // clicks (detail >= 1) are already handled by the pointer path and must NOT toggle
  // again here, or a simple click would double-toggle.
  const onLineClick = (e, index) => {
    if (e && e.detail === 0) toggle(index);
  };

  const yellowCount = selectedCount(sel);
  const cutCount = ranges.length;

  // Incomplete-detection warning. Empty string when not degraded, so the row is only
  // rendered when there is something to warn about. Informational only.
  const degradeText = degradeSummary(degrade);

  // Per-sentence row styling. The cut decision is BINARY and encoded by TEXT COLOUR
  // ALONE: bright amber (+ medium weight) = in the cut, dim grey = kept. No background
  // wash, no left rule - the whole row is a button so reading + clicking is one gesture,
  // and clicking flips the colour. The medium-weight on a cut line is a quiet
  // non-colour reinforcement (legibility / colour-vision), NOT a second axis. The ⚑
  // review marker lives in a separate gutter (see gutterStyle) so "flagged" reads as an
  // orthogonal annotation, never a third colour-state.
  const rowStyle = (isSel) => ({
    display: "flex", gap: 8, alignItems: "baseline", width: "100%",
    padding: "3px 6px", textAlign: "left", cursor: "pointer",
    background: "transparent",
    color: isSel ? "var(--ct-amber)" : "var(--fg-muted)",
    fontFamily: "inherit", fontSize: "inherit", borderRadius: 2, border: "none",
  });
  // Fixed-width left gutter for the ⚑ held-cut marker. Always present (blank when the
  // line is not held) so flags align vertically and the text never shifts. Its colour
  // is a NEUTRAL off-white (--fg-dim), deliberately distinct from the cut-amber and a
  // touch brighter than the grey body text, so the ⚑ reads as metadata on its own axis.
  const gutterStyle = {
    flex: "0 0 auto", width: 12, textAlign: "center", fontSize: 10,
    color: "var(--fg-dim)", userSelect: "none",
  };
  const timeStyle = {
    fontFamily: "var(--font-mono)", fontSize: 10, color: "var(--fg-dim)",
    flex: "0 0 auto", width: 48, textAlign: "right",
  };
  const previewBtnStyle = (enabled) => ({
    fontFamily: "var(--font-mono)", fontSize: 10, padding: "0 4px",
    border: "1px solid var(--rule)", marginLeft: 6,
    cursor: enabled ? "pointer" : "not-allowed", background: "transparent",
    color: enabled ? "var(--fg-muted)" : "var(--fg-dim)", opacity: enabled ? 1 : 0.5,
    flex: "0 0 auto",
  });

  return (
    <details className="transcript-cut-review" data-uuid={uuid || ""} open={!!open}
      // CONTROLLED <details>. The `open` attribute reflects the parent-owned prop, but a
      // native <details> still toggles itself on a summary click BEFORE React re-renders.
      // So on every toggle we read e.target.open (the DOM's just-set desired state) and
      // report it up via onOpenChange; the parent updates its open-set and the `open`
      // prop follows on the next render. That round-trip is what keeps the DOM and React
      // in sync - without it, a fixed `open` prop would fight the user's native toggle.
      // onToggle fires on BOTH open and close, so onOpenChange carries the direction and
      // the parent decides (capture on first open; just drop the uuid on close).
      onToggle={(e) => { if (onOpenChange) onOpenChange(uuid, !!(e.target && e.target.open)); }}
      style={{ borderTop: "1px solid var(--rule)", padding: "6px 20px 10px",
        background: "var(--ct-coffee-deep)" }}>
      <summary className="transcript-cut-review__summary"
        style={{ cursor: "pointer", fontFamily: "var(--font-mono)", fontSize: 11,
          letterSpacing: ".5px", color: "var(--ct-amber)", userSelect: "none" }}>
        {panelSummary(trimEntry)}
        <span style={{ marginLeft: 8, color: "var(--fg-muted)", fontSize: 10, letterSpacing: 0 }}>
          {cutCount} cut{cutCount !== 1 ? "s" : ""} · {yellowCount} line{yellowCount !== 1 ? "s" : ""} selected
          {heldCount > 0 && (
            <span style={{ color: "var(--ct-amber)" }}> · {heldCount} flagged for review</span>
          )}
        </span>
      </summary>

      <div className="transcript-cut-review__hint"
        style={{ fontSize: 10, color: "var(--fg-dim)", margin: "6px 0 8px" }}>
        Amber lines will be cut; grey lines are kept. Click any line to flip it. ⚑ marks
        spots the detector wasn't sure about - take a look, then click to cut if you
        agree. Use the ▶ to hear how a cut joins.
      </div>

      {degradeText && (
        <div className="transcript-cut-review__degraded"
          style={{ fontFamily: "var(--font-mono)", fontSize: 10, letterSpacing: ".5px",
            color: "var(--ct-amber)", border: "1px solid var(--ct-amber)", borderRadius: 2,
            padding: "4px 8px", margin: "0 0 8px" }}>
          ⚠ {degradeText}
        </div>
      )}

      {audioUrl && (
        <audio ref={(el) => { audioRef.current = el; }} src={audioUrl} preload="none"
          className="transcript-cut-review__audio" data-testid="transcript-cut-audio" />
      )}

      <div className="transcript-cut-review__body"
        ref={(el) => { bodyRef.current = el; }}
        style={{ maxHeight: 320, overflowY: "auto", display: "flex", flexDirection: "column", gap: 1 }}>
        {lines.map((line) => {
          const isSel = sel.has(line.index);
          const isHeld = held.has(line.index);          // detector was unsure here (⚑)
          const isUnreviewed = isHeld && !isSel;          // held + not yet opted in
          const isHead = runHeads.has(line.index);
          const lineTitle = isSel ? "click to keep this line (remove from the cut)"
            : isHeld ? "the detector flagged this as a possible cut but was not sure - click to cut it"
            : "click to cut this line";
          return (
            <div key={line.index} className="transcript-cut-review__line-wrap"
              style={{ display: "flex", alignItems: "baseline" }}>
              <button type="button"
                className={`transcript-cut-review__line${isSel ? " is-selected" : ""}${isHeld ? " is-held" : ""}`}
                data-index={line.index} data-selected={isSel ? "true" : "false"}
                data-held={isHeld ? "true" : undefined}
                data-unreviewed={isUnreviewed ? "true" : undefined}
                aria-pressed={isSel}
                // The ⚑ glyph is decorative (aria-hidden); expose the held/flagged status
                // on the button's accessible NAME so keyboard / screen-reader users don't
                // lose it. aria-pressed already conveys cut-vs-keep ("pressed" = in cut).
                aria-label={`${line.time}${isHeld ? ", flagged for review" : ""}: ${line.text}`}
                onPointerDown={(e) => onLinePointerDown(e, line.index, isSel)}
                onClick={(e) => onLineClick(e, line.index)}
                title={lineTitle}
                style={rowStyle(isSel)}>
                <span style={gutterStyle} aria-hidden="true">{isHeld ? "⚑" : ""}</span>
                <span style={timeStyle}>{line.time}</span>
                <span style={{ flex: 1, minWidth: 0, fontSize: 12, lineHeight: 1.4,
                  fontWeight: isSel ? "var(--fw-medium)" : "var(--fw-regular)" }}>{line.text}</span>
              </button>
              {isHead && (
                <button type="button" className="transcript-cut-review__play-join"
                  disabled={!previewsOn}
                  onClick={() => playJoin(rangeForHead(line))}
                  title="play across the proposed join for this cut"
                  style={previewBtnStyle(previewsOn)}>▶</button>
              )}
            </div>
          );
        })}
      </div>
    </details>
  );
}

export default TranscriptCutReview;
