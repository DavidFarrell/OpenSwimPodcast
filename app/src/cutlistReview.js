// Coarse cut-list review - pure presentation + decision logic (P3a).
//
// This is the data layer behind the CutlistReview.jsx surface. It is deliberately
// a plain module (no React) so the rules are unit-testable without a DOM. The
// surface itself is NOT a waveform editor and NOT a transcript editor - it is a
// short list of FLAGGED cuts (the ones the detector + pipeline declined to apply
// automatically) with a keep / remove control each.
//
// CARDINAL RULE (trim): zero false positives. A flagged cut defaults to KEEP -
// nothing is cut unless the user explicitly chooses "remove". This module only
// surfaces the proposal and the user's decision; it never forces a cut.

// A flagged cut is one the pipeline flagged needs-review (over the safe length
// threshold, ambiguous boundary, or quote-map failure). Clean cuts auto-apply and
// must NOT appear here. We only show the flagged ones - the whole point of this
// surface is that the confident cuts are already handled silently.
export function flaggedCuts(trimEntry) {
  if (!trimEntry || !Array.isArray(trimEntry.cuts)) return [];
  return trimEntry.cuts.filter((c) => c && c.needsReview === true);
}

// True when an episode has at least one flagged cut to review. The component
// renders nothing when this is false - no clutter for episodes whose cuts all
// auto-applied (or that have no cuts at all).
export function hasFlaggedCuts(trimEntry) {
  return flaggedCuts(trimEntry).length > 0;
}

// Stable key for a single cut, matching the main-process cutKey() in ipc.cjs so a
// recorded decision round-trips. startSec/endSec rounded to whole ms.
export function cutKey(cut) {
  if (!cut) return null;
  const s = Number(cut.startSec);
  const e = Number(cut.endSec);
  if (!Number.isFinite(s) || !Number.isFinite(e)) return null;
  return `${Math.round(s * 1000)}-${Math.round(e * 1000)}`;
}

// mm:ss (or h:mm:ss past an hour) from a seconds value. Used for the time range
// shown on each row, e.g. "23:10".
export function formatTime(sec) {
  const n = Number(sec);
  if (!Number.isFinite(n) || n < 0) return "0:00";
  const total = Math.round(n);
  const h = Math.floor(total / 3600);
  const m = Math.floor((total % 3600) / 60);
  const s = total % 60;
  const ss = String(s).padStart(2, "0");
  if (h > 0) return `${h}:${String(m).padStart(2, "0")}:${ss}`;
  return `${m}:${ss}`;
}

// Human kind label from a cut's `label` (intro / outro / ad / intro+outro etc.).
// Mid-episode ads read as "Mid-roll"; edge cuts keep their intro/outro wording.
export function kindLabel(cut) {
  const raw = cut && typeof cut.label === "string" ? cut.label : "";
  if (raw.includes("intro") && raw.includes("outro")) return "Intro + outro";
  if (raw.includes("intro")) return "Intro";
  if (raw.includes("outro")) return "Outro";
  return "Mid-roll";
}

// One-line headline for a row, e.g. "Mid-roll 23:10-24:05".
export function cutHeadline(cut) {
  if (!cut) return "";
  return `${kindLabel(cut)} ${formatTime(cut.startSec)}-${formatTime(cut.endSec)}`;
}

// Plain-language reason a cut was flagged, from the detector's reason codes. Falls
// back to a generic line so the user always sees why a cut needs a decision.
const REASON_TEXT = {
  "over-threshold": "longer than the safe auto-cut length",
  "ambiguous-boundary": "the end of this block could not be pinned down exactly",
  "mid-roll-ambiguous": "a mid-episode block that may overlap real content",
};

export function reasonText(cut) {
  const reasons = cut && Array.isArray(cut.reasons) ? cut.reasons : [];
  const mapped = reasons.map((r) => REASON_TEXT[r]).filter(Boolean);
  if (mapped.length) return mapped.join("; ");
  return "flagged for review - left intact until you decide";
}

// Approximate length of a cut, e.g. "55s" or "2m 30s". For the confidence/reason
// column so the user can gauge how much would be removed.
export function durationText(cut) {
  const s = Number(cut && cut.startSec);
  const e = Number(cut && cut.endSec);
  if (!Number.isFinite(s) || !Number.isFinite(e) || e <= s) return "";
  const secs = Math.round(e - s);
  if (secs < 60) return `${secs}s`;
  const m = Math.floor(secs / 60);
  const r = secs % 60;
  return r ? `${m}m ${r}s` : `${m}m`;
}

// Effective decision for a cut given the recorded decisions map ({ cutKey: "keep"
// | "remove" }). Default is "keep" - the cardinal rule: never remove flagged
// audio without an explicit choice.
export function decisionFor(cut, decisions) {
  const key = cutKey(cut);
  if (!key || !decisions) return "keep";
  return decisions[key] === "remove" ? "remove" : "keep";
}

// ---------------------------------------------------------------------------
// P3b - boundary editing + audio-preview math
//
// These are the pure helpers behind the review-row controls: coarse -5s/+5s
// nudges, an editable timestamp field, and the play-before / play-after /
// preview-join preview windows. They never apply a cut - they only compute the
// proposed new boundaries (which still default to KEEP) and the time windows the
// renderer's <audio> element should play. Boundaries are on the ORIGINAL
// (pre-speed) episode timeline, same as converter.cjs expects.
//
// CARDINAL RULE still holds: editing a boundary changes WHAT a cut would remove
// if the user later chooses REMOVE; it never removes anything on its own, and we
// never let an edit produce an invalid (start >= end) range.

// Default seconds of audio to play around a boundary for the preview controls.
export const PREVIEW_PAD_SEC = 4;
// The coarse nudge step shown on the -5s / +5s buttons.
export const NUDGE_STEP_SEC = 5;

// Clamp a seconds value to a finite, non-negative number (rounded to ms so the
// cutKey round-trips cleanly). Returns null for unusable input.
function cleanSec(sec) {
  const n = Number(sec);
  if (!Number.isFinite(n)) return null;
  return Math.max(0, Math.round(n * 1000) / 1000);
}

// Parse a user-typed timestamp into seconds. Accepts "mm:ss", "h:mm:ss" and a
// bare seconds number (with optional fraction). Returns null when it cannot be
// parsed so the caller can reject the edit and leave the boundary untouched.
export function parseTimestamp(str) {
  if (typeof str === "number") return cleanSec(str);
  if (typeof str !== "string") return null;
  const t = str.trim();
  if (t === "") return null;
  if (/^\d+(\.\d+)?$/.test(t)) return cleanSec(Number(t));
  const parts = t.split(":");
  if (parts.length < 2 || parts.length > 3) return null;
  for (const p of parts) {
    if (!/^\d+(\.\d+)?$/.test(p)) return null;
  }
  const nums = parts.map(Number);
  let secs;
  if (nums.length === 2) secs = nums[0] * 60 + nums[1];
  else secs = nums[0] * 3600 + nums[1] * 60 + nums[2];
  // Reject malformed mm:ss like "1:75" - minutes/seconds fields must be < 60.
  if (nums[nums.length - 1] >= 60) return null;
  if (nums.length === 3 && nums[1] >= 60) return null;
  return cleanSec(secs);
}

// mm:ss / h:mm:ss for an editable field's value - same precision the user types.
// Differs from formatTime only in that it never coerces a bad value to 0:00; it
// returns "" so an empty/invalid field stays empty rather than snapping to zero.
export function timestampValue(sec) {
  const n = cleanSec(sec);
  if (n == null) return "";
  return formatTime(n);
}

// Set one boundary ("start" | "end") of a cut to an absolute seconds value,
// returning a NEW cut object. The move is rejected (original returned unchanged)
// if it would invert the range - start must stay strictly below end. This is the
// guard that keeps an editable timestamp from ever producing a zero/negative
// length cut.
export function setBoundary(cut, which, sec) {
  if (!cut) return cut;
  const v = cleanSec(sec);
  if (v == null) return cut;
  const s = cleanSec(cut.startSec);
  const e = cleanSec(cut.endSec);
  if (which === "start") {
    if (e == null || v >= e) return cut;
    return { ...cut, startSec: v };
  }
  if (which === "end") {
    if (s == null || v <= s) return cut;
    return { ...cut, endSec: v };
  }
  return cut;
}

// Nudge one boundary by deltaSec (negative = earlier, positive = later),
// returning a NEW cut. Reuses setBoundary so the same invert guard applies: a
// nudge that would cross the other boundary is a no-op (returns the cut
// unchanged) rather than producing an invalid range.
export function nudgeBoundary(cut, which, deltaSec) {
  if (!cut) return cut;
  const base = which === "start" ? cleanSec(cut.startSec) : cleanSec(cut.endSec);
  if (base == null) return cut;
  const d = Number(deltaSec);
  if (!Number.isFinite(d)) return cut;
  return setBoundary(cut, which, base + d);
}

// The audio window to play for "play before" - PREVIEW_PAD_SEC of audio leading
// up to the cut start (so the user hears what comes right before the block).
// Returns { from, to } in seconds, clamped to >= 0. Returns null if unusable.
export function playBeforeWindow(cut, padSec = PREVIEW_PAD_SEC) {
  const s = cleanSec(cut && cut.startSec);
  if (s == null) return null;
  const pad = Math.max(0, Number(padSec) || 0);
  return { from: Math.max(0, s - pad), to: s };
}

// The audio window for "play after" - PREVIEW_PAD_SEC of audio starting at the
// cut end (so the user hears what resumes once the block is gone).
export function playAfterWindow(cut, padSec = PREVIEW_PAD_SEC) {
  const e = cleanSec(cut && cut.endSec);
  if (e == null) return null;
  const pad = Math.max(0, Number(padSec) || 0);
  return { from: e, to: e + pad };
}

// The two windows for "preview join" - a few seconds before the cut start
// followed by a few seconds after the cut end, i.e. how the audio would sound
// once the block between them is removed and the two sides are joined. The
// renderer plays `before` then seeks to `after`. Returns null if unusable.
export function previewJoinWindows(cut, padSec = PREVIEW_PAD_SEC) {
  const before = playBeforeWindow(cut, padSec);
  const after = playAfterWindow(cut, padSec);
  if (!before || !after) return null;
  return { before, after };
}

// Build the view-model rows for the surface: one per flagged cut, each carrying
// its key, headline, reason, duration and current decision. Pure - the component
// maps straight over this.
export function reviewRows(trimEntry, decisions) {
  return flaggedCuts(trimEntry).map((cut) => ({
    key: cutKey(cut),
    cut,
    headline: cutHeadline(cut),
    reason: reasonText(cut),
    duration: durationText(cut),
    decision: decisionFor(cut, decisions),
  }));
}
