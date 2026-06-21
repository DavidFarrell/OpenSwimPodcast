import { describe, it, expect, vi } from "vitest";
import { initWaiting, reduceWaiting, bannerVisible, WAITING_GRACE_MS } from "./waitingState.js";
import { cancelTransfer } from "./commitCapture.js";

const prepared = (n) =>
  ({ type: "prepared", items: Array.from({ length: n }, (_, i) => ({ uuid: `u${i}`, title: `Ep ${i}` })) });
const stage = (state) => ({ type: "stage", stage: "waiting-for-device", state });

// A controllable clock so reducer timestamps + bannerVisible are deterministic.
function clock(start = 1000) {
  let t = start;
  const now = () => t;
  now.advance = (ms) => { t += ms; };
  return now;
}

// Fold a list of events from a fresh state, the way SyncScreen does per event.
// Optional clock threads a deterministic `now` into the reducer.
function play(events, now) {
  return events.reduce((s, e) => reduceWaiting(s, e, now), initWaiting());
}

describe("waitingState - the parked banner derivation", () => {
  it("starts inactive with no prepared summary", () => {
    const s = initWaiting();
    expect(s.active).toBe(false);
    expect(s.prepared).toBe(null);
  });

  // Behaviour #2 (required, render side): the waiting state turns ON when the
  // waiting-for-device stage goes active.
  it("active goes true on the waiting-for-device active stage", () => {
    const s = play([stage("active")]);
    expect(s.active).toBe(true);
  });

  // Behaviour #2 (required, clear side): it clears on the resolve (done) stage -
  // the device attached and transfer is proceeding, so the banner must drop.
  it("active clears on the done stage (device attached, transfer proceeding)", () => {
    const s = play([stage("active"), stage("done")]);
    expect(s.active).toBe(false);
  });

  // Behaviour #4 (required): cancel from the waiting state - the cancelled stage
  // must clear the banner so the waiting UI never sticks after a cancel.
  it("active clears on the cancelled stage (cancel from waiting)", () => {
    const s = play([stage("active"), stage("cancelled")]);
    expect(s.active).toBe(false);
  });

  it("active clears on the error stage (park errored)", () => {
    const s = play([stage("active"), stage("error")]);
    expect(s.active).toBe(false);
  });

  // The prepared summary shows before the device plan arrives, and survives the
  // wait so the "N episodes prepared" count stays visible.
  it("captures the prepared summary and keeps it across the wait", () => {
    const s = play([prepared(3), stage("active")]);
    expect(s.prepared).toHaveLength(3);
    expect(s.active).toBe(true);
    const after = reduceWaiting(s, stage("done"));
    expect(after.prepared).toHaveLength(3); // summary persists past resolve
    expect(after.active).toBe(false);
  });

  // Device-present-throughout: prepared then an instant active->done. The end state
  // is NOT stuck active - a brief/skipped wait is fine, a stuck banner is not.
  it("device-present instant active->done leaves the banner cleared (no stick)", () => {
    const s = play([prepared(2), stage("active"), stage("done")]);
    expect(s.active).toBe(false);
  });

  it("active stamps `since`; a terminal stage clears it back to null", () => {
    const now = clock();
    const a = reduceWaiting(initWaiting(), stage("active"), now);
    expect(a.since).toBe(1000);
    const d = reduceWaiting(a, stage("done"), now);
    expect(d.since).toBe(null);
  });

  it("a repeated active event does NOT re-stamp `since` (stable edge)", () => {
    const now = clock();
    const a = reduceWaiting(initWaiting(), stage("active"), now);
    now.advance(50);
    const a2 = reduceWaiting(a, stage("active"), now);
    expect(a2.since).toBe(1000); // unchanged - the wait started at 1000
  });

  it("ignores unrelated events and other stages", () => {
    const s = play([
      { type: "stage", stage: "convert", state: "active" },
      { type: "log", text: "hi" },
      prepared(1),
      { type: "plan", plan: [] },
    ]);
    expect(s.active).toBe(false);
    expect(s.prepared).toHaveLength(1);
  });

  it("tolerates malformed events", () => {
    expect(reduceWaiting(undefined, null).active).toBe(false);
    expect(reduceWaiting(undefined, { type: "prepared" }).prepared).toEqual([]);
  });
});

// Behaviour #2 + #3 (the no-flash guarantee). bannerVisible is what the component
// actually renders against. The device-present instant case must NOT show the
// banner; a genuine wait must.
describe("bannerVisible - debounced so the device-present case never flashes", () => {
  it("device-present instant active->done is NEVER visible (no flash)", () => {
    const now = clock();
    const s = play([prepared(1), stage("active"), stage("done")], now);
    // The wait resolved; bannerVisible is false at every point in time.
    expect(bannerVisible(s, 1000)).toBe(false);
    expect(bannerVisible(s, 1000 + WAITING_GRACE_MS + 9999)).toBe(false);
  });

  it("is NOT visible during the grace window even while active", () => {
    const now = clock();
    const s = play([stage("active")], now); // since = 1000
    expect(bannerVisible(s, 1000)).toBe(false);
    expect(bannerVisible(s, 1000 + WAITING_GRACE_MS - 1)).toBe(false);
  });

  it("becomes visible once a genuine wait crosses the grace window", () => {
    const now = clock();
    const s = play([stage("active")], now); // since = 1000
    expect(bannerVisible(s, 1000 + WAITING_GRACE_MS)).toBe(true);
    expect(bannerVisible(s, 1000 + WAITING_GRACE_MS + 5000)).toBe(true);
  });

  // Behaviour #4 (cancel from waiting): a long wait that the user cancels - the
  // banner was visible, then the cancelled stage must drop it immediately and keep
  // it down. Proves the waiting UI cannot stick after a cancel.
  it("a visible wait drops the banner the instant cancel arrives", () => {
    const now = clock();
    let s = play([stage("active")], now); // since = 1000
    now.advance(WAITING_GRACE_MS + 100);
    expect(bannerVisible(s, now())).toBe(true); // genuinely waiting, banner up
    s = reduceWaiting(s, stage("cancelled"), now);
    expect(bannerVisible(s, now())).toBe(false); // cancel cleared it
    now.advance(10000);
    expect(bannerVisible(s, now())).toBe(false); // and it stays down
  });

  it("error also drops a visible banner immediately", () => {
    const now = clock();
    let s = play([stage("active")], now);
    now.advance(WAITING_GRACE_MS + 100);
    expect(bannerVisible(s, now())).toBe(true);
    s = reduceWaiting(s, stage("error"), now);
    expect(bannerVisible(s, now())).toBe(false);
  });

  it("never visible from a fresh / malformed state", () => {
    expect(bannerVisible(initWaiting(), 99999)).toBe(false);
    expect(bannerVisible(undefined, 99999)).toBe(false);
    expect(bannerVisible({ active: true, since: null }, 99999)).toBe(false);
  });
});

// Behaviour #4 (the action side): cancel from the waiting state. The banner is
// non-interactive; its ONLY action is the running-view toolbar Cancel, which - like
// every other cancel in this screen - routes through cancelTransfer. This proves
// that path aborts cleanly from the waiting state: it cancels the run and goes back,
// and (by construction) cannot reach any commit/capture write.
describe("cancel from the waiting state aborts cleanly", () => {
  it("cancels the run then goes back, in that order", async () => {
    const calls = [];
    const cancel = vi.fn(() => { calls.push("cancel"); });
    const onBack = vi.fn(() => { calls.push("back"); });
    await cancelTransfer({ cancel, onBack });
    expect(cancel).toHaveBeenCalledTimes(1);
    expect(onBack).toHaveBeenCalledTimes(1);
    expect(calls).toEqual(["cancel", "back"]); // abort first, then leave
  });

  it("still goes back when no cancel bridge is present (no throw)", async () => {
    const onBack = vi.fn();
    await expect(cancelTransfer({ cancel: undefined, onBack })).resolves.toBeUndefined();
    expect(onBack).toHaveBeenCalledTimes(1);
  });
});
