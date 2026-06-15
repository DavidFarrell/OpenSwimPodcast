// Sensitivity preference (P4b).
//
// A single user setting that tunes ONLY the needs-review duration threshold the
// trim detector uses to decide whether a clean, well-mapped cut is auto-applied
// or flagged for review. Persisted in localStorage like the speed/boost/model
// toggles in App.jsx, under one key:
//   - os_sensitivity : "conservative" | "balanced" | "aggressive"
//
// Semantics (the ONLY thing this changes):
//   - conservative -> LOWER threshold -> more cuts cross it -> MORE flagging.
//   - balanced     -> the LOCKED default threshold (5 min). This is the default.
//   - aggressive   -> HIGHER threshold -> fewer cuts cross it -> LESS flagging.
//
// It does NOT change the locked detector method (windowing + quote-boundary
// mapping in detectAds.cjs), and crucially it does NOT and CANNOT weaken the
// cardinal rule. A quote-map failure is still skipped (fail safe to no-cut) and an
// ambiguous boundary is still flagged needs-review regardless of sensitivity -
// those checks are independent of this threshold. Sensitivity only moves the line
// between "auto-apply a clean short cut" and "flag a clean long cut".
//
// The threshold is in SECONDS and is always finite and positive, so an unknown /
// blank stored value degrades to the balanced default rather than disabling the
// threshold.

const KEY = "os_sensitivity";

// The LOCKED default threshold (seconds). Must match detectAds.cjs
// NEEDS_REVIEW_MAX_SEC. "balanced" maps to exactly this. Raised from 150 to 300:
// the review gate now surfaces every cut for approval before any write, so this
// threshold only decides which clean spans START pre-selected, not what gets cut
// blind. 300 sits just above the measured max real-ad length (292s) so genuine
// long host-reads pre-select instead of opening the review with nothing selected.
const DEFAULT_THRESHOLD_SEC = 300; // 5 minutes

// The default sensitivity level.
const DEFAULT_SENSITIVITY = "balanced";

// Level -> needs-review threshold in seconds. Lower = flags more (fewer clean spans
// start pre-selected). The order here is the cardinal invariant of this feature:
// conservative < balanced < aggressive. Raised in step with DEFAULT_THRESHOLD_SEC
// (300) now that the review gate surfaces every cut before any write - these tune
// which clean spans START pre-selected, never what is cut blind.
const SENSITIVITY_THRESHOLDS = {
  conservative: 120, // 2 min - flags more
  balanced: DEFAULT_THRESHOLD_SEC, // 5 min - locked default
  aggressive: 360, // 6 min - flags less
};

// The pulldown options, conservative first so the safest choice reads first.
const SENSITIVITY_OPTIONS = ["conservative", "balanced", "aggressive"];

// Load the chosen sensitivity level. Returns DEFAULT_SENSITIVITY when nothing is
// stored, the stored value is blank / unknown, or storage is unavailable.
function loadSensitivity(storage) {
  const s = storage || (typeof localStorage !== "undefined" ? localStorage : null);
  if (!s) return DEFAULT_SENSITIVITY;
  let v = null;
  try {
    v = s.getItem(KEY);
  } catch (_) {
    return DEFAULT_SENSITIVITY;
  }
  if (typeof v !== "string") return DEFAULT_SENSITIVITY;
  const trimmed = v.trim().toLowerCase();
  return Object.prototype.hasOwnProperty.call(SENSITIVITY_THRESHOLDS, trimmed)
    ? trimmed
    : DEFAULT_SENSITIVITY;
}

// Persist the chosen sensitivity level. An unknown / blank / non-string value
// resets to the default so we never store a value that would disable the
// threshold.
function saveSensitivity(value, storage) {
  const s = storage || (typeof localStorage !== "undefined" ? localStorage : null);
  if (!s) return;
  const candidate = (typeof value === "string") ? value.trim().toLowerCase() : "";
  const v = Object.prototype.hasOwnProperty.call(SENSITIVITY_THRESHOLDS, candidate)
    ? candidate
    : DEFAULT_SENSITIVITY;
  try {
    s.setItem(KEY, v);
  } catch (_) {
    // storage full / unavailable - nothing to do, loadSensitivity will fall back.
  }
}

// Map a sensitivity level to the needs-review threshold in seconds. An unknown /
// blank level maps to the locked default so the threshold is always finite and
// positive - it can never be turned off.
function thresholdSecFor(level) {
  const key = (typeof level === "string") ? level.trim().toLowerCase() : "";
  const sec = SENSITIVITY_THRESHOLDS[key];
  return (Number.isFinite(sec) && sec > 0) ? sec : DEFAULT_THRESHOLD_SEC;
}

// Convenience: load the level from storage and return its threshold in seconds.
function loadThresholdSec(storage) {
  return thresholdSecFor(loadSensitivity(storage));
}

export {
  loadSensitivity,
  saveSensitivity,
  thresholdSecFor,
  loadThresholdSec,
  KEY,
  DEFAULT_SENSITIVITY,
  DEFAULT_THRESHOLD_SEC,
  SENSITIVITY_THRESHOLDS,
  SENSITIVITY_OPTIONS,
};
