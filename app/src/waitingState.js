// The "waiting for the headphones" parked state, derived from the slice-4 event
// contract as a pure reducer so it is unit-testable without a DOM. Mirrors the
// review gate: a transient BANNER raised over the running view, NOT a permanent
// stage row - so the device-present case (where the park resolves instantly) never
// adds a flashing row to the progress tree.
//
// THE SLICE-4 EVENTS WE CONSUME (no backend change here):
//   { type: "prepared", items: [...] }
//       emitted once after convert, before parking - the episodes prepped + ready.
//   { type: "stage", stage: "waiting-for-device", state: "active" }   parked
//   { type: "stage", stage: "waiting-for-device", state: "done" }     attached, going
//   { type: "stage", stage: "waiting-for-device", state: "cancelled" } cancelled while parked
//   { type: "stage", stage: "waiting-for-device", state: "error" }    park errored
//
// STATE SHAPE: { active: boolean, since: number | null, prepared: items[] | null }.
//   active   true ONLY while the waiting-for-device stage is "active". ANY terminal
//            state (done / cancelled / error) clears it - the banner must never stick.
//   since    ms (Date.now) the wait BECAME active, or null when not active. Used by
//            bannerVisible to suppress the banner on the device-present instant case:
//            if the wait resolves before the grace window elapses, the banner never
//            shows, so a plugged-in user sees no flash. Re-stamped on each fresh
//            active edge; cleared on any terminal state.
//   prepared the device-free "N episodes prepared" summary, shown the moment the
//            `prepared` event lands (before the device plan arrives) and kept once
//            set so the count stays visible through the wait.

const WAITING_STAGE = "waiting-for-device";

// Default grace window. Below this the wait is treated as "effectively instant"
// (the device-present park resolving immediately) and the banner is suppressed, so
// the plugged-in flow is visually identical. Above it the user is genuinely waiting
// and the banner is shown.
const WAITING_GRACE_MS = 400;

function initWaiting() {
  return { active: false, since: null, prepared: null };
}

// Fold one event into the waiting state. Unknown events pass through unchanged, so
// this can be called for every event without a type guard at the call site. `now`
// is injectable for tests; defaults to Date.now.
function reduceWaiting(state, evt, now = Date.now) {
  const prev = state || initWaiting();
  if (!evt || typeof evt !== "object") return prev;

  if (evt.type === "prepared") {
    const items = Array.isArray(evt.items) ? evt.items : [];
    return { ...prev, prepared: items };
  }

  if (evt.type === "stage" && evt.stage === WAITING_STAGE) {
    // active = parked + waiting. Every other state (done/cancelled/error) is
    // terminal for the wait and must clear the banner so it never sticks. The
    // prepared summary is left intact across the transition. Stamp `since` on a
    // fresh active edge so bannerVisible can debounce the instant case.
    if (evt.state === "active") {
      const since = prev.active ? prev.since : now();
      return { ...prev, active: true, since };
    }
    return { ...prev, active: false, since: null };
  }

  return prev;
}

// Whether the parked banner should be VISIBLE right now. True only when the wait is
// active AND it has been active for at least graceMs - so the device-present case
// (where active resolves to done almost instantly, well within graceMs) never paints
// the banner, keeping the plugged-in flow visually identical. A genuine wait crosses
// graceMs and shows. Pure: the component recomputes this against a ticking clock.
function bannerVisible(state, now = Date.now(), graceMs = WAITING_GRACE_MS) {
  if (!state || !state.active || state.since == null) return false;
  return now - state.since >= graceMs;
}

export { initWaiting, reduceWaiting, bannerVisible, WAITING_STAGE, WAITING_GRACE_MS };
