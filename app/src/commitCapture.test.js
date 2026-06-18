import { describe, it, expect, vi } from "vitest";
import { commitAndCapture, cancelTransfer } from "./commitCapture.js";

// Two episodes with deterministic ranges, so a test can assert the EXACT [[s,e],...]
// each one's setCuts received and prove capture never perturbs them.
const items = [
  { uuid: "a", ext: "mp3" },
  { uuid: "b", ext: "mp4" },
];
const RANGES = {
  a: [[10, 20], [40, 55]],
  b: [[0, 5]],
};
const rangesFor = (item) => RANGES[item.uuid];

// A recording setCuts that captures exactly what it was handed, in order, and replies ok.
function recordingSetCuts() {
  const calls = [];
  const fn = vi.fn((uuid, ranges, ext) => { calls.push({ uuid, ranges, ext }); return { ok: true }; });
  return { fn, calls };
}
const okResolve = () => ({ ok: true });

// The committed cut-set, as a stable comparable, independent of capture outcome.
function committedSetOf(calls) {
  return calls.map((c) => ({ uuid: c.uuid, ranges: c.ranges, ext: c.ext }));
}
const EXPECTED_COMMIT = [
  { uuid: "a", ranges: RANGES.a, ext: "mp3" },
  { uuid: "b", ranges: RANGES.b, ext: "mp4" },
];

describe("commitAndCapture - the today-sequence is preserved", () => {
  it("commits every episode then resolves, returning ok", async () => {
    const setCuts = recordingSetCuts();
    const resolveReview = vi.fn(okResolve);
    const onResolved = vi.fn();
    const r = await commitAndCapture({
      items, rangesFor, setCuts: setCuts.fn, resolveReview, onResolved,
      buildRecords: () => [], capture: vi.fn(),
    });
    expect(r.ok).toBe(true);
    expect(committedSetOf(setCuts.calls)).toEqual(EXPECTED_COMMIT);
    expect(resolveReview).toHaveBeenCalledTimes(1);
    expect(onResolved).toHaveBeenCalledTimes(1);
  });

  it("FAIL-CLOSED: a rejected setCuts stops before resolve, no capture", async () => {
    const setCuts = vi.fn((uuid) => uuid === "b" ? Promise.reject(new Error("io")) : { ok: true });
    const resolveReview = vi.fn(okResolve);
    const capture = vi.fn();
    const r = await commitAndCapture({
      items, rangesFor, setCuts, resolveReview, capture,
      buildRecords: () => [{ x: 1 }], onResolved: vi.fn(),
    });
    expect(r).toEqual({ ok: false, reason: "setCuts" });
    expect(resolveReview).not.toHaveBeenCalled();
    expect(capture).not.toHaveBeenCalled();
  });

  it("FAIL-CLOSED: an { ok:false } setCuts reply stops before resolve, no capture", async () => {
    const setCuts = vi.fn((uuid) => uuid === "b" ? { ok: false } : { ok: true });
    const resolveReview = vi.fn(okResolve);
    const capture = vi.fn();
    const r = await commitAndCapture({
      items, rangesFor, setCuts, resolveReview, capture, buildRecords: () => [], onResolved: vi.fn(),
    });
    expect(r).toEqual({ ok: false, reason: "setCuts" });
    expect(resolveReview).not.toHaveBeenCalled();
    expect(capture).not.toHaveBeenCalled();
  });

  it("FAIL-CLOSED: an { ok:false } resolve does not capture and reports reason 'resolve'", async () => {
    const setCuts = recordingSetCuts();
    const resolveReview = vi.fn(() => ({ ok: false }));
    const capture = vi.fn();
    const r = await commitAndCapture({
      items, rangesFor, setCuts: setCuts.fn, resolveReview, capture,
      buildRecords: () => [{ x: 1 }], onResolved: vi.fn(),
    });
    expect(r).toEqual({ ok: false, reason: "resolve" });
    expect(committedSetOf(setCuts.calls)).toEqual(EXPECTED_COMMIT); // still committed today's set
    expect(capture).not.toHaveBeenCalled();
  });
});

describe("commitAndCapture - capture fires ONLY after a successful resolve", () => {
  it("capture is called AFTER resolveReview, with the built records", async () => {
    const order = [];
    const setCuts = vi.fn(() => { order.push("setCuts"); return { ok: true }; });
    const resolveReview = vi.fn(() => { order.push("resolve"); return { ok: true }; });
    const records = [{ uuid: "a" }];
    const capture = vi.fn(() => order.push("capture"));
    await commitAndCapture({
      items, rangesFor, setCuts, resolveReview, capture,
      buildRecords: () => records, onResolved: () => order.push("onResolved"),
    });
    // resolve precedes capture; onResolved (gate teardown) precedes capture too.
    expect(order.indexOf("resolve")).toBeLessThan(order.indexOf("capture"));
    expect(order.indexOf("onResolved")).toBeLessThan(order.indexOf("capture"));
    expect(capture).toHaveBeenCalledWith(records);
  });
});

// THE CUT-SET-UNCHANGED PROOF. setCuts must receive EXACTLY the same ranges and
// resolveReview must be reached in EVERY capture world (success, build-throws, capture
// throws sync, capture rejects async, capture absent). If capture could perturb the
// committed ranges or block the transfer, one of these assertions fails.
describe("commitAndCapture - cut-set-unchanged proof across all capture worlds (cardinal)", () => {
  const worlds = {
    "capture enabled and succeeding": {
      capture: vi.fn(), buildRecords: () => [{ ok: true }],
    },
    "record-building throwing": {
      capture: vi.fn(), buildRecords: () => { throw new Error("build blew up"); },
    },
    "capture (append) throwing synchronously": {
      capture: () => { throw new Error("append blew up"); }, buildRecords: () => [{ ok: true }],
    },
    "capture returning a REJECTED promise (the live IPC bridge failure mode)": {
      capture: () => Promise.reject(new Error("ipc rejected")), buildRecords: () => [{ ok: true }],
    },
    "capture callback present but bridge absent (returns undefined - SyncScreen's lazy shape)": {
      capture: () => undefined, buildRecords: () => [{ ok: true }],
    },
    "capture bridge unavailable (no callback at all)": {
      capture: undefined, buildRecords: () => [{ ok: true }],
    },
  };

  for (const [name, world] of Object.entries(worlds)) {
    it(`commits the SAME ranges + reaches resolve when capture is: ${name}`, async () => {
      const setCuts = recordingSetCuts();
      const resolveReview = vi.fn(okResolve);
      const r = await commitAndCapture({
        items, rangesFor, setCuts: setCuts.fn, resolveReview,
        capture: world.capture, buildRecords: world.buildRecords, onResolved: vi.fn(),
      });
      // The transfer succeeded - capture never fail-closes it...
      expect(r.ok).toBe(true);
      // ...resolveReview was reached exactly once...
      expect(resolveReview).toHaveBeenCalledTimes(1);
      // ...and the committed cut-set is byte-for-byte identical in every world.
      expect(committedSetOf(setCuts.calls)).toEqual(EXPECTED_COMMIT);
    });
  }
});

describe("commitAndCapture - a rejected capture promise is swallowed (no unhandled rejection)", () => {
  it("the rejected capture promise produces no unhandled rejection", async () => {
    const rejections = [];
    const onRej = (e) => rejections.push(e);
    process.on("unhandledRejection", onRej);
    const setCuts = recordingSetCuts();
    const r = await commitAndCapture({
      items, rangesFor, setCuts: setCuts.fn, resolveReview: vi.fn(okResolve),
      capture: () => Promise.reject(new Error("ipc rejected")),
      buildRecords: () => [{ ok: true }], onResolved: vi.fn(),
    });
    // Give the microtask queue + a macrotask a tick to surface any unhandled rejection.
    await new Promise((res) => setTimeout(res, 0));
    process.off("unhandledRejection", onRej);
    expect(r.ok).toBe(true);
    expect(rejections).toHaveLength(0);
  });
});

describe("cancelTransfer - cancel/abandon NEVER touches commit or capture", () => {
  // The real "capture never fires on cancel" assertion. SyncScreen.cancel routes through
  // cancelTransfer, which has no access to setCuts/resolveReview/capture - so a regression
  // that wired cancel into the commit path would fail here.
  it("calls cancel() then onBack(), and nothing else", async () => {
    const order = [];
    const cancel = vi.fn(() => { order.push("cancel"); });
    const onBack = vi.fn(() => { order.push("onBack"); });
    await cancelTransfer({ cancel, onBack });
    expect(cancel).toHaveBeenCalledTimes(1);
    expect(onBack).toHaveBeenCalledTimes(1);
    expect(order).toEqual(["cancel", "onBack"]); // cancel awaited before going back
  });

  it("still goes back when the cancel bridge is absent", async () => {
    const onBack = vi.fn();
    await expect(cancelTransfer({ cancel: undefined, onBack })).resolves.toBeUndefined();
    expect(onBack).toHaveBeenCalledTimes(1);
  });
});

describe("commitAndCapture - zero items (empty gate) commits nothing but still resolves", () => {
  // Not a cancel test (cancel never calls this seam - see SyncScreen.cancel, which calls
  // api.cancel()+onBack() and never commitAndCapture). This pins the empty-gate edge:
  // nothing to commit, the pipeline still releases, capture sees an empty batch.
  it("commits nothing, resolves, capture sees an empty batch only after resolve", async () => {
    const setCuts = vi.fn();
    const resolveReview = vi.fn(okResolve);
    const capture = vi.fn();
    const r = await commitAndCapture({
      items: [], rangesFor, setCuts, resolveReview, capture,
      buildRecords: () => [], onResolved: vi.fn(),
    });
    expect(r.ok).toBe(true);
    expect(setCuts).not.toHaveBeenCalled();
    expect(capture).toHaveBeenCalledWith([]);
  });
});
