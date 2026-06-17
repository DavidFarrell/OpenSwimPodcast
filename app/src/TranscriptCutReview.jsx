import {
  sentenceLines, selectableCuts, selectedToRanges,
  panelSummary, selectedCount, heldLines, heldCutCount,
} from "./transcriptToggle.js";
import { previewJoinWindows } from "./cutlistReview.js";

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
//   defaultOpen       start expanded (the SyncScreen gate wants the transcript open
//                     so the user reviews immediately; the Today pre-sync list leaves
//                     it collapsed for a quiet overview).
//
// Renders nothing when there is no usable cut OR no usable transcript - no clutter
// for episodes whose cuts all auto-applied with nothing to read, matching today.
export function TranscriptCutReview({
  uuid, transcript, trimEntry, selected, onToggleSentence, audioUrl, defaultOpen = false,
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
  // jump button and the auto-open, so the user is pulled to the cuts still needing a look.
  const held = heldLines(lines, trimEntry);
  const heldCount = heldCutCount(trimEntry);
  const hasUnreviewedHeld = [...held].some((i) => !sel.has(i));

  // Plain refs (no hooks) so the component is renderable by a direct function call
  // in tests as well as by React. A callback ref captures the shared <audio>; the
  // ▶ handlers close over it. Mirrors CutlistReview's no-hooks audio approach.
  const audioRef = { current: null };
  const pendingJoin = { current: null };
  const bodyRef = { current: null };
  const previewsOn = !!audioUrl;

  // Scroll the first unreviewed held line (held AND not yet selected) into view - so the
  // user can FIND a held cut in a long transcript instead of hunting for it. DOM query
  // on click (no hook needed); a no-op if the body is not mounted or nothing is held.
  const jumpToFlagged = () => {
    const root = bodyRef.current;
    if (!root) return;
    const el = root.querySelector('[data-unreviewed="true"]');
    if (el && typeof el.scrollIntoView === "function") el.scrollIntoView({ block: "center" });
  };

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

  const yellowCount = selectedCount(sel);
  const cutCount = ranges.length;

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
    <details className="transcript-cut-review" data-uuid={uuid || ""} {...((defaultOpen || hasUnreviewedHeld) ? { open: true } : {})}
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

      {hasUnreviewedHeld && (
        <button type="button" className="transcript-cut-review__jump-flagged"
          onClick={jumpToFlagged}
          title="jump to the first spot the detector flagged for your review"
          style={{ fontFamily: "var(--font-mono)", fontSize: 10, letterSpacing: ".5px",
            color: "var(--ct-amber)", background: "transparent", cursor: "pointer",
            border: "1px solid var(--ct-amber)", borderRadius: 2, padding: "2px 8px",
            margin: "0 0 8px" }}>
          ⚑ {heldCount} flagged for review - jump to {heldCount !== 1 ? "first" : "it"}
        </button>
      )}

      {audioUrl && (
        <audio ref={(el) => { audioRef.current = el; }} src={audioUrl} preload="none"
          className="transcript-cut-review__audio" data-testid="transcript-cut-audio" />
      )}

      <div className="transcript-cut-review__body" ref={(el) => { bodyRef.current = el; }}
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
                onClick={() => toggle(line.index)}
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
