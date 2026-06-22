// The warning text for an episode whose ad-detection was incomplete. The detector
// runs one model call per ~30-min window; when a window FAILS (token/context
// shortfall, timeout, an unparseable reply) it is skipped, so a run can look like a
// clean "no ads found" when it actually could not read part of the episode. Slice 1
// surfaces this in detectAds's stats (windowsFailed / windowsRun / degraded); this
// module turns those counts into one plain sentence for the review gate.
//
// PURELY INFORMATIONAL. This never adds, removes, or alters a cut - it only builds a
// string. degrade is a small {degraded, windowsFailed, windowsRun} shape carried from
// detectAds through sync.cjs into the review payload (see degradeFromStats).
//
// Returns "" when the episode is not degraded, so a caller can `if (text)` to decide
// whether to render the warning at all.

// Coerce a count to a non-negative integer; anything unusable becomes 0 so the
// wording never prints NaN / undefined.
function count(n) {
  return Number.isFinite(n) && n > 0 ? Math.floor(n) : 0;
}

export function degradeSummary(degrade) {
  if (!degrade || !degrade.degraded) return "";
  const failed = count(degrade.windowsFailed);
  if (failed === 0) {
    // degraded true with no usable count - still warn, just without the N/M figures.
    return "detection may be incomplete - the model could not read part of this episode; cuts shown may be missing some ads.";
  }
  const total = count(degrade.windowsRun);
  // "N of M sections" when the total is known and sensible; otherwise just "N section(s)".
  const where = total >= failed
    ? `${failed} of ${total} section${total !== 1 ? "s" : ""}`
    : `${failed} section${failed !== 1 ? "s" : ""}`;
  return `detection may be incomplete - the model could not read ${where} of this episode; cuts shown may be missing some ads.`;
}

export default degradeSummary;
