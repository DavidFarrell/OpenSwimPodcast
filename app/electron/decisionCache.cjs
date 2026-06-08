const fsp = require("node:fs/promises");
const path = require("node:path");
const { fingerprint } = require("./transcribe.cjs");

// Persistent decision cache for reviewed trim cuts (P3c).
//
// When a cut is flagged needs-review and the user makes a keep/remove decision in
// the review surface, that decision is persisted here keyed by the audio
// fingerprint (the same size+mtime scheme transcribe.cjs uses) and a stable cut
// key (startSec-endSec rounded to ms - matching ipc.cjs cutKey() and
// cutlistReview.js cutKey()). The cache is a sidecar JSON next to the audio, just
// like the transcript cache, so re-processing the SAME untouched episode reuses
// the user's reviewed choices and never re-asks.
//
// CARDINAL RULE (trim): zero false positives. The cache only ever applies a
// decision the user explicitly made. A "remove" decision lets a previously-flagged
// cut be auto-applied (the user already said yes); a "keep" decision drops the cut
// entirely so it is not re-flagged. Anything WITHOUT a cached decision keeps its
// original flagging - we never invent a removal. Every read/write degrades safely
// and never throws into the pipeline; a corrupt or unreadable cache is treated as
// empty (cache miss -> flag normally).
//
// ADJUSTED BOUNDARIES (P3b edits): a user may approve a removal only AFTER nudging
// its boundaries in the review surface. In that case the cut the user actually
// approved is the ADJUSTED one, not the detector's original range, so re-applying
// the original boundaries would cut audio the user never approved (a cardinal-rule
// violation). A decision value is therefore one of:
//   - "keep"                                  (drop the cut)
//   - "remove"                                (apply at the detector boundaries)
//   - { action: "remove", startSec, endSec }  (apply at the user-adjusted boundaries)
// The object form is keyed by the ORIGINAL cut key (matching the edit map in
// ipc.cjs) so a re-detected cut still maps to the user's adjusted choice, and
// applyDecisions emits the adjusted boundaries for it. Malformed object decisions
// (missing/inverted/negative boundaries) are UNUSABLE and rejected on both read
// and write: we drop them entirely rather than fall back to a plain "remove". A
// plain "remove" would re-apply the detector's ORIGINAL (wider) range, but the
// user only approved the removal at the narrowed boundaries - falling back would
// trim audio the user explicitly excluded (a cardinal-rule violation). Dropping
// the entry means the cut keeps its original needs-review flag and is re-asked,
// which is the safe degrade.

// Stable key for a single cut. Mirrors ipc.cjs cutKey() and cutlistReview.js
// cutKey() so a decision recorded in any of them round-trips here.
function cutKey(cut) {
  if (!cut) return null;
  const s = Number(cut.startSec);
  const e = Number(cut.endSec);
  if (!Number.isFinite(s) || !Number.isFinite(e)) return null;
  return `${Math.round(s * 1000)}-${Math.round(e * 1000)}`;
}

// Normalise a single decision value to its canonical persisted/applied form, or
// null if it is not a usable decision. Accepts:
//   - "keep"                                  -> "keep"
//   - "remove"                                -> "remove"
//   - { action: "remove", startSec, endSec }  -> { action:"remove", startSec, endSec }
//     ONLY when start/end are finite, non-negative and start < end. A malformed
//     adjusted-remove (missing/inverted/negative boundaries) is UNUSABLE and
//     returns null - it is NOT degraded to a plain "remove". Degrading would apply
//     the detector's original (wider) range, but the user only approved the removal
//     at the narrowed boundaries, so cutting the wider range would trim audio the
//     user explicitly excluded (a cardinal-rule violation). Returning null drops
//     the decision; the cut then keeps its needs-review flag and is re-asked.
function normaliseDecision(v) {
  if (v === "keep" || v === "remove") return v;
  if (v && typeof v === "object" && v.action === "remove") {
    const s = Number(v.startSec);
    const e = Number(v.endSec);
    if (Number.isFinite(s) && Number.isFinite(e) && s >= 0 && s < e) {
      return { action: "remove", startSec: s, endSec: e };
    }
    return null;
  }
  return null;
}

// Sidecar path for the decision cache, alongside the audio and its fingerprint -
// same dot-prefixed, fingerprint-keyed shape as the transcript sidecar so a
// changed (re-downloaded) file naturally misses the old cache.
function decisionSidecarPath(src, fp) {
  const dir = path.dirname(src);
  const base = path.basename(src);
  return path.join(dir, `.${base}.decisions.${fp}.json`);
}

// Read the decision map for an episode. Returns a plain object { cutKey: "keep" |
// "remove" }, or {} on any miss (no file, unreadable, corrupt JSON, wrong shape).
// Never throws.
async function readDecisions({ src, fp } = {}) {
  if (!src) return {};
  let fingerprintValue = fp;
  if (!fingerprintValue) {
    try { fingerprintValue = await fingerprint(src); }
    catch { return {}; }
  }
  const p = decisionSidecarPath(src, fingerprintValue);
  try {
    const raw = await fsp.readFile(p, "utf8");
    const parsed = JSON.parse(raw);
    const map = parsed && typeof parsed === "object" && parsed.decisions
      && typeof parsed.decisions === "object" ? parsed.decisions : null;
    if (!map) return {};
    // Only let through well-formed entries - a corrupt value must not leak into
    // the pipeline as a phantom "remove".
    const out = {};
    for (const [k, v] of Object.entries(map)) {
      if (typeof k !== "string") continue;
      const norm = normaliseDecision(v);
      if (norm != null) out[k] = norm;
    }
    return out;
  } catch {
    return {};
  }
}

// Persist a full decision map for an episode (merging is the caller's job - this
// writes what it is given). Returns true on success, false on any failure. Never
// throws - failing to cache is not fatal, the user can decide again next pass.
async function writeDecisions({ src, fp, decisions } = {}) {
  if (!src || !decisions || typeof decisions !== "object") return false;
  let fingerprintValue = fp;
  if (!fingerprintValue) {
    try { fingerprintValue = await fingerprint(src); }
    catch { return false; }
  }
  // Sanitise before writing so the sidecar can only ever hold valid decisions.
  const clean = {};
  for (const [k, v] of Object.entries(decisions)) {
    if (typeof k !== "string") continue;
    const norm = normaliseDecision(v);
    if (norm != null) clean[k] = norm;
  }
  const p = decisionSidecarPath(src, fingerprintValue);
  const payload = { version: 1, writtenAt: new Date().toISOString(), decisions: clean };
  try {
    await fsp.writeFile(p, JSON.stringify(payload), "utf8");
    return true;
  } catch {
    return false;
  }
}

// Apply a cached decision map to a freshly-detected cut list, returning a new cut
// list. This is the trust-layer reuse step:
//   - A cut with a cached "remove": the user already approved it at the detector
//     boundaries. Clear its needsReview flag so it auto-applies this pass.
//   - A cut with a cached { action:"remove", startSec, endSec }: the user approved
//     it only after ADJUSTING the boundaries. Emit the cut at the user-adjusted
//     boundaries (NOT the detector's original range) and clear needsReview, so the
//     re-applied cut is exactly the one the user approved.
//   - A cut with a cached "keep": the user already declined it. Drop it entirely
//     so it is neither cut nor re-flagged.
//   - A cut with NO cached decision: left exactly as detected (still flagged if it
//     was flagged). We never invent a removal.
// The decision is looked up by the cut's ORIGINAL key, so the adjustment maps back
// to the same detected cut on a later pass. Cuts that were not flagged needs-review
// in the first place are passed through untouched - they auto-apply regardless, and
// the cache only governs the previously-ambiguous ones. Pure; never throws.
function applyDecisions(cuts, decisions) {
  if (!Array.isArray(cuts)) return [];
  const map = decisions && typeof decisions === "object" ? decisions : {};
  const out = [];
  for (const cut of cuts) {
    if (!cut) continue;
    if (!cut.needsReview) { out.push(cut); continue; }
    const key = cutKey(cut);
    const decision = normaliseDecision(key ? map[key] : null);
    if (decision === "remove") {
      out.push({ ...cut, needsReview: false, decided: "remove" });
    } else if (decision && typeof decision === "object" && decision.action === "remove") {
      // User-adjusted remove: apply at the boundaries the user actually approved.
      out.push({
        ...cut,
        startSec: decision.startSec,
        endSec: decision.endSec,
        needsReview: false,
        decided: "remove",
        adjusted: true,
      });
    } else if (decision === "keep") {
      // User declined this cut on a prior pass - drop it, do not re-flag.
      continue;
    } else {
      out.push(cut);
    }
  }
  return out;
}

module.exports = {
  cutKey,
  decisionSidecarPath,
  readDecisions,
  writeDecisions,
  applyDecisions,
};
