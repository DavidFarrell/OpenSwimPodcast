// Announce-episode UI preferences (S6).
//
// Two pieces of state, both persisted in localStorage exactly like the existing
// speed/boost toggles in App.jsx:
//   - os_announce         : "1" / "0"  - the universal "Announce episode" intent
//   - os_announceOff      : JSON array of episode uuids the user has explicitly
//                           disabled (a per-episode override on top of the global
//                           toggle). We store only the OFF overrides; with the
//                           global toggle ON every other episode is announced.
//
// The resolver below is the single source of truth the renderer uses to decide
// whether a given episode should get a spoken intro. It mirrors the S5 IPC
// contract: an explicit per-episode decision wins, and an OFF must be honoured
// (the off-intent fix from S5 - never let a stale ON win over a chosen OFF).

const GLOBAL_KEY = "os_announce";
const OFF_KEY = "os_announceOff";

export function loadAnnounceGlobal(storage) {
  const s = storage || (typeof localStorage !== "undefined" ? localStorage : null);
  if (!s) return false;
  return s.getItem(GLOBAL_KEY) === "1";
}

export function saveAnnounceGlobal(value, storage) {
  const s = storage || (typeof localStorage !== "undefined" ? localStorage : null);
  if (!s) return;
  s.setItem(GLOBAL_KEY, value ? "1" : "0");
}

export function loadAnnounceOff(storage) {
  const s = storage || (typeof localStorage !== "undefined" ? localStorage : null);
  if (!s) return new Set();
  try {
    const arr = JSON.parse(s.getItem(OFF_KEY) || "[]");
    return new Set(Array.isArray(arr) ? arr.filter((x) => typeof x === "string") : []);
  } catch (_) {
    return new Set();
  }
}

export function saveAnnounceOff(set, storage) {
  const s = storage || (typeof localStorage !== "undefined" ? localStorage : null);
  if (!s) return;
  s.setItem(OFF_KEY, JSON.stringify(Array.from(set || [])));
}

// Effective decision for one episode given the global toggle and the OFF set.
// Global OFF means nothing is announced regardless of overrides. Global ON means
// announce unless this uuid is in the explicit OFF set.
export function effectiveAnnounce(uuid, globalOn, offSet) {
  if (!globalOn) return false;
  if (!uuid) return false;
  return !(offSet && offSet.has(uuid));
}

export { GLOBAL_KEY, OFF_KEY };
