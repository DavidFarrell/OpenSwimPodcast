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
