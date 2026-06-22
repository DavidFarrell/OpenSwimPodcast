// Pure logic for click-and-drag PAINT of the line selection (slice 5). The user
// presses on a line and drags up/down to paint the SAME state onto every line
// dragged over: anchor became amber (selected) -> the drag selects; anchor became
// grey -> the drag deselects. Release ends the gesture.
//
// Only the PURE decision lives here; the DOM gesture (pointer events,
// elementFromPoint, listener attach/detach) is the thin shell in
// TranscriptCutReview.jsx. Keeping the decision pure means the never-twice and
// both-directions correctness is tested without DOM layout (jsdom has none).
//
// CARDINAL RULE: paint only ever flips lines through the SAME onToggleSentence the
// click path uses, so the committed cut is still exactly the amber set at Continue.
// A deselect-paint can only REMOVE lines (safe); a select-paint adds lines the user
// is explicitly painting over (deliberate, same as clicking each one).

// Should we toggle this line to reach the paint target? Toggle only when its current
// state DIFFERS from what the paint wants - a line already in the target state is
// left alone (so painting over already-correct lines is a no-op, never a flip-back).
// The gesture shell (TranscriptCutReview) calls this per line, against the canonical
// selected set overlaid with the indices it has already painted this gesture, and
// dedups by index itself - so each line toggles at most once. This stays a pure,
// single-purpose decision; the visited/fill bookkeeping is the shell's job.
export function paintDecision(isCurrentlySelected, paintWantsSelected) {
  return isCurrentlySelected !== paintWantsSelected;
}
