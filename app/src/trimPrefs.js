// Trim-interstitials UI preferences (P2d).
//
// Mirrors announcePrefs.js exactly. Two pieces of state, both persisted in
// localStorage like the speed/boost/announce toggles in App.jsx:
//   - os_trim     : "1" / "0"  - the universal "Trim interstitials" intent
//   - os_trimOff  : JSON array of episode uuids the user has explicitly
//                   disabled (a per-episode override on top of the global
//                   toggle). We store only the OFF overrides; with the global
//                   toggle ON every other episode is trimmed.
//
// The resolver below is the single source of truth the renderer uses to decide
// whether a given episode should be trimmed. It mirrors the P2c IPC contract:
// an explicit per-episode decision wins, and an OFF must be honoured (never let
// a stale ON win over a chosen OFF).
//
// CARDINAL RULE (trim): zero false positives. The toggle only expresses intent;
// the detector + pipeline still degrade safely (skip the cut, flag needs-review)
// when a boundary is ambiguous. Nothing here forces a cut.

const GLOBAL_KEY = "os_trim";
const OFF_KEY = "os_trimOff";

export function loadTrimGlobal(storage) {
  const s = storage || (typeof localStorage !== "undefined" ? localStorage : null);
  if (!s) return false;
  return s.getItem(GLOBAL_KEY) === "1";
}

export function saveTrimGlobal(value, storage) {
  const s = storage || (typeof localStorage !== "undefined" ? localStorage : null);
  if (!s) return;
  s.setItem(GLOBAL_KEY, value ? "1" : "0");
}

export function loadTrimOff(storage) {
  const s = storage || (typeof localStorage !== "undefined" ? localStorage : null);
  if (!s) return new Set();
  try {
    const arr = JSON.parse(s.getItem(OFF_KEY) || "[]");
    return new Set(Array.isArray(arr) ? arr.filter((x) => typeof x === "string") : []);
  } catch (_) {
    return new Set();
  }
}

export function saveTrimOff(set, storage) {
  const s = storage || (typeof localStorage !== "undefined" ? localStorage : null);
  if (!s) return;
  s.setItem(OFF_KEY, JSON.stringify(Array.from(set || [])));
}

// Effective decision for one episode given the global toggle and the OFF set.
// Global OFF means nothing is trimmed regardless of overrides. Global ON means
// trim unless this uuid is in the explicit OFF set.
export function effectiveTrim(uuid, globalOn, offSet) {
  if (!globalOn) return false;
  if (!uuid) return false;
  return !(offSet && offSet.has(uuid));
}

export { GLOBAL_KEY, OFF_KEY };
