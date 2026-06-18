import { describe, it, expect, beforeEach } from "vitest";
import { createRequire } from "node:module";

// ipc.cjs does `require("electron")` at load. Outside the Electron runtime that
// resolves to the binary path string, so destructuring { ipcMain, app, ... } off
// it yields undefined - harmless as long as we only touch the pure announce
// toggle helpers here, which never reach into the electron API.
const require = createRequire(import.meta.url);
const {
  getAnnounce, setAnnounce, listAnnounce, resolveAnnounceQueue,
  getTrim, setTrim, listTrim, resolveTrimQueue, getTrimStatus, recordTrimEvent,
  setTrimDecision, getTrimDecisions, cutKey, buildHandlers,
  setTrimEdit, getTrimEdits, mergeDecisionsWithEdits,
  setTrimCutSet, getTrimCutSet, sanitizeRanges,
  resolveReview, cancelSync,
} = require("./ipc.cjs");

describe("announce toggle intent (ipc helpers, { ok, data } surface)", () => {
  beforeEach(() => {
    // Clear any state left by a prior test.
    for (const uuid of listAnnounce()) setAnnounce(uuid, false);
  });

  it("defaults to off for an unknown episode", () => {
    expect(getAnnounce("nope")).toBe(false);
  });

  it("set on then read back reflects the toggle and shows up in the list", () => {
    expect(setAnnounce("ep1", true)).toBe(true);
    expect(getAnnounce("ep1")).toBe(true);
    expect(listAnnounce()).toContain("ep1");
  });

  it("set off removes the episode from the enabled set", () => {
    setAnnounce("ep2", true);
    expect(setAnnounce("ep2", false)).toBe(false);
    expect(getAnnounce("ep2")).toBe(false);
    expect(listAnnounce()).not.toContain("ep2");
  });

  it("ignores a missing uuid rather than throwing", () => {
    expect(setAnnounce(undefined, true)).toBe(false);
    expect(getAnnounce(undefined)).toBe(false);
  });
});

describe("startSync announce override (resolveAnnounceQueue)", () => {
  beforeEach(() => {
    for (const uuid of listAnnounce()) setAnnounce(uuid, false);
  });

  it("honours an OFF toggled AFTER a queue was built with announce:true (the off intent wins)", () => {
    // Regression: the queue was assembled with announce:true, then the user
    // flipped Announce OFF before sync started. The old code deleted the map
    // entry on OFF, so `has(uuid)` was false and the stale queued true won -
    // Announce ran anyway. Now an explicit OFF is recorded and must override.
    const queue = [{ uuid: "ep1", announce: true, filename: "01_x.mp3" }];
    setAnnounce("ep1", false);

    const resolved = resolveAnnounceQueue(queue);
    expect(resolved[0].announce).toBe(false);
  });

  it("honours an ON toggled after a queue was built with announce:false", () => {
    const queue = [{ uuid: "ep1", announce: false, filename: "01_x.mp3" }];
    setAnnounce("ep1", true);

    const resolved = resolveAnnounceQueue(queue);
    expect(resolved[0].announce).toBe(true);
  });

  it("falls back to the queued value when no toggle intent was recorded", () => {
    // Fresh uuids never touched by setAnnounce, so resolveAnnounceQueue must
    // pass the queued announce value straight through.
    const queue = [
      { uuid: "fresh-untouched-1", announce: true, filename: "01_x.mp3" },
      { uuid: "fresh-untouched-2", announce: false, filename: "02_y.mp3" },
    ];
    const resolved = resolveAnnounceQueue(queue);
    expect(resolved.map((it) => it.announce)).toEqual([true, false]);
  });
});

describe("trim toggle intent (ipc helpers, { ok, data } surface)", () => {
  beforeEach(() => {
    for (const uuid of listTrim()) setTrim(uuid, false);
  });

  it("defaults to off for an unknown episode", () => {
    expect(getTrim("nope")).toBe(false);
  });

  it("set on then read back reflects the toggle and shows up in the list", () => {
    expect(setTrim("ep1", true)).toBe(true);
    expect(getTrim("ep1")).toBe(true);
    expect(listTrim()).toContain("ep1");
  });

  it("set off removes the episode from the enabled set (explicit OFF stored, not deleted)", () => {
    setTrim("ep2", true);
    expect(setTrim("ep2", false)).toBe(false);
    expect(getTrim("ep2")).toBe(false);
    expect(listTrim()).not.toContain("ep2");
  });

  it("ignores a missing uuid rather than throwing", () => {
    expect(setTrim(undefined, true)).toBe(false);
    expect(getTrim(undefined)).toBe(false);
  });

  it("resolveTrimQueue: an OFF toggled after the queue was built wins over the stale queued true", () => {
    const queue = [{ uuid: "ep1", trim: true, filename: "01_x.mp3" }];
    setTrim("ep1", false);
    const resolved = resolveTrimQueue(queue);
    expect(resolved[0].trim).toBe(false);
  });

  it("resolveTrimQueue: falls back to the queued value when no toggle intent was recorded", () => {
    const queue = [
      { uuid: "trim-fresh-1", trim: true, filename: "01_x.mp3" },
      { uuid: "trim-fresh-2", trim: false, filename: "02_y.mp3" },
    ];
    const resolved = resolveTrimQueue(queue);
    expect(resolved.map((it) => it.trim)).toEqual([true, false]);
  });
});

describe("trim status surface (recordTrimEvent / getTrimStatus)", () => {
  it("defaults to idle with no cuts for an unknown episode", () => {
    expect(getTrimStatus("never-seen")).toEqual({ status: "idle", cuts: [] });
  });

  it("records the status + cut list off the sync:event trim stream", () => {
    const cuts = [{ startSec: 600, endSec: 700, needsReview: false, reasons: [], label: "ad" }];
    recordTrimEvent({ type: "trim", uuid: "epA", state: "analysing" });
    expect(getTrimStatus("epA").status).toBe("analysing");
    recordTrimEvent({ type: "trim", uuid: "epA", state: "ready", cuts });
    expect(getTrimStatus("epA")).toEqual({ status: "ready", cuts });
  });

  it("ignores non-trim events", () => {
    recordTrimEvent({ type: "stage", stage: "convert", state: "done" });
    expect(getTrimStatus("epB")).toEqual({ status: "idle", cuts: [] });
  });
});

describe("trim review decisions (setTrimDecision / getTrimDecisions, P3a)", () => {
  const cut = { startSec: 1390, endSec: 1445, needsReview: true, reasons: ["over-threshold"], label: "ad" };

  it("returns an empty map for an episode with no decisions (default = keep)", () => {
    expect(getTrimDecisions("no-decisions-yet")).toEqual({});
  });

  it("records a remove decision keyed by a stable ms-rounded cut key", () => {
    const key = cutKey(cut);
    expect(setTrimDecision("epD", cut, "remove")).toBe("remove");
    expect(getTrimDecisions("epD")).toEqual({ [key]: "remove" });
  });

  it("a later keep overrides an earlier remove for the same cut", () => {
    const key = cutKey(cut);
    setTrimDecision("epE", cut, "remove");
    setTrimDecision("epE", cut, "keep");
    expect(getTrimDecisions("epE")).toEqual({ [key]: "keep" });
  });

  it("coerces any non-remove decision to keep (CARDINAL: only explicit remove cuts)", () => {
    const key = cutKey(cut);
    expect(setTrimDecision("epF", cut, "garbage")).toBe("keep");
    expect(getTrimDecisions("epF")).toEqual({ [key]: "keep" });
  });

  it("ignores a missing uuid or an unmappable cut without throwing", () => {
    expect(setTrimDecision(undefined, cut, "remove")).toBe(null);
    expect(setTrimDecision("epG", {}, "remove")).toBe(null);
    expect(getTrimDecisions("epG")).toEqual({});
    expect(getTrimDecisions(undefined)).toEqual({});
  });

  it("cutKey matches the renderer cutKey (decisions round-trip across processes)", () => {
    expect(cutKey(cut)).toBe("1390000-1445000");
  });

  it("the trim:decide IPC handler degrades gracefully on a null/missing payload (does not throw)", () => {
    const decide = buildHandlers()["trim:decide"];
    // A null or undefined payload from a malformed IPC call must not throw when
    // the handler destructures { uuid, cut, decision }. It returns null (no
    // decision recorded == keep), honouring the cardinal rule. This would throw
    // a TypeError if the handler destructured the payload directly.
    expect(() => decide(null, null)).not.toThrow();
    expect(decide(null, null)).toBe(null);
    expect(() => decide(null, undefined)).not.toThrow();
    expect(decide(null, undefined)).toBe(null);
    // A well-formed payload still records as before.
    expect(decide(null, { uuid: "epH", cut, decision: "remove" })).toBe("remove");
    expect(getTrimDecisions("epH")).toEqual({ [cutKey(cut)]: "remove" });
  });
});

describe("trim boundary edits (setTrimEdit / getTrimEdits, P3b)", () => {
  const cut = { startSec: 1390, endSec: 1445, needsReview: true, reasons: ["over-threshold"], label: "ad" };

  it("returns an empty map for an episode with no edits", () => {
    expect(getTrimEdits("no-edits-yet")).toEqual({});
  });

  it("records an edit keyed by the ORIGINAL cut key (so it round-trips with decisions)", () => {
    const key = cutKey(cut);
    expect(setTrimEdit("epEdit1", cut, { startSec: 1385, endSec: 1450 })).toEqual({ startSec: 1385, endSec: 1450 });
    expect(getTrimEdits("epEdit1")).toEqual({ [key]: { startSec: 1385, endSec: 1450 } });
  });

  it("a later edit for the same cut overrides the earlier one", () => {
    const key = cutKey(cut);
    setTrimEdit("epEdit2", cut, { startSec: 1380, endSec: 1450 });
    setTrimEdit("epEdit2", cut, { startSec: 1388, endSec: 1444 });
    expect(getTrimEdits("epEdit2")).toEqual({ [key]: { startSec: 1388, endSec: 1444 } });
  });

  // CARDINAL RULE: an edit must never record an inverted / negative range, since
  // that would describe a bad cut. The store rejects it (returns null) and keeps
  // the prior boundaries.
  it("rejects an inverted, equal, negative or non-finite range without recording it", () => {
    expect(setTrimEdit("epEdit3", cut, { startSec: 1445, endSec: 1390 })).toBe(null);
    expect(setTrimEdit("epEdit3", cut, { startSec: 100, endSec: 100 })).toBe(null);
    expect(setTrimEdit("epEdit3", cut, { startSec: -5, endSec: 10 })).toBe(null);
    expect(setTrimEdit("epEdit3", cut, { startSec: NaN, endSec: 10 })).toBe(null);
    expect(getTrimEdits("epEdit3")).toEqual({});
  });

  it("ignores a missing uuid, unmappable original cut, or missing new cut without throwing", () => {
    expect(setTrimEdit(undefined, cut, { startSec: 1, endSec: 2 })).toBe(null);
    expect(setTrimEdit("epEdit4", {}, { startSec: 1, endSec: 2 })).toBe(null);
    expect(setTrimEdit("epEdit4", cut, null)).toBe(null);
    expect(getTrimEdits("epEdit4")).toEqual({});
    expect(getTrimEdits(undefined)).toEqual({});
  });

  it("the trim:edit IPC handler degrades gracefully on a null/missing payload (does not throw)", () => {
    const edit = buildHandlers()["trim:edit"];
    expect(() => edit(null, null)).not.toThrow();
    expect(edit(null, null)).toBe(null);
    expect(() => edit(null, undefined)).not.toThrow();
    expect(edit(null, undefined)).toBe(null);
    expect(edit(null, { uuid: "epEdit5", originalCut: cut, newCut: { startSec: 1385, endSec: 1450 } }))
      .toEqual({ startSec: 1385, endSec: 1450 });
    expect(getTrimEdits("epEdit5")).toEqual({ [cutKey(cut)]: { startSec: 1385, endSec: 1450 } });
  });
});

describe("mergeDecisionsWithEdits (P3c - fold adjusted boundaries into the persisted map)", () => {
  it("turns a removed-AND-edited cut into an adjusted-remove object keyed by the original cut", () => {
    const cut = { startSec: 600, endSec: 700 };
    const key = cutKey(cut);
    setTrimDecision("epMerge1", cut, "remove");
    setTrimEdit("epMerge1", cut, { startSec: 615, endSec: 690 });
    expect(mergeDecisionsWithEdits("epMerge1")).toEqual({
      [key]: { action: "remove", startSec: 615, endSec: 690 },
    });
  });

  it("leaves a plain remove (no edit) as the string 'remove' - detector boundaries", () => {
    const cut = { startSec: 600, endSec: 700 };
    const key = cutKey(cut);
    setTrimDecision("epMerge2", cut, "remove");
    expect(mergeDecisionsWithEdits("epMerge2")).toEqual({ [key]: "remove" });
  });

  it("never attaches boundaries to a KEEP (nothing is cut, so an edit is moot)", () => {
    const cut = { startSec: 600, endSec: 700 };
    const key = cutKey(cut);
    setTrimDecision("epMerge3", cut, "keep");
    setTrimEdit("epMerge3", cut, { startSec: 615, endSec: 690 });
    expect(mergeDecisionsWithEdits("epMerge3")).toEqual({ [key]: "keep" });
  });

  it("an edit alone (no decision) is not promoted to a removal - cardinal rule", () => {
    const cut = { startSec: 600, endSec: 700 };
    setTrimEdit("epMerge4", cut, { startSec: 615, endSec: 690 });
    expect(mergeDecisionsWithEdits("epMerge4")).toEqual({});
  });
});

describe("review gate handshake (resolveReview / cancelSync guards)", () => {
  it("resolveReview is a no-op (false) when nothing is awaiting review", () => {
    expect(resolveReview()).toBe(false);
  });

  it("cancelSync returns false when no sync and no review are in flight", () => {
    // Nothing parked: cancel has nothing to release or abort.
    expect(cancelSync()).toBe(false);
  });
});

describe("explicit cut-set store (setTrimCutSet / getTrimCutSet, transcript-toggle redesign)", () => {
  it("defaults to null (no redesigned decision recorded) for an unknown uuid", () => {
    expect(getTrimCutSet("no-set-yet")).toBe(null);
  });

  it("records and reads back a sanitised, sorted cut-set", () => {
    const stored = setTrimCutSet("epCS1", [[1390, 1445], [600, 660]]);
    expect(stored).toEqual([{ startSec: 600, endSec: 660 }, { startSec: 1390, endSec: 1445 }]);
    expect(getTrimCutSet("epCS1")).toEqual([{ startSec: 600, endSec: 660 }, { startSec: 1390, endSec: 1445 }]);
  });

  it("CARDINAL: drops malformed ranges (inverted / zero / negative / non-finite), never widens", () => {
    const stored = setTrimCutSet("epCS2", [
      [600, 660],     // ok
      [700, 700],     // zero-length - dropped
      [900, 800],     // inverted - dropped
      [-5, 10],       // negative start - dropped
      [Number.NaN, 5],// non-finite - dropped
      { startSec: 1000, endSec: 1030 }, // object form ok
    ]);
    expect(stored).toEqual([{ startSec: 600, endSec: 660 }, { startSec: 1000, endSec: 1030 }]);
  });

  it("an empty selection stores [] (a valid 'cut nothing' state, distinct from no entry)", () => {
    expect(setTrimCutSet("epCS3", [])).toEqual([]);
    expect(getTrimCutSet("epCS3")).toEqual([]); // has an entry -> explicit path, cuts nothing
  });

  it("setTrimCutSet on a falsy uuid is a no-op (null)", () => {
    expect(setTrimCutSet(undefined, [[1, 2]])).toBe(null);
  });

  it("sanitizeRanges accepts both [s,e] tuples and {startSec,endSec} objects", () => {
    expect(sanitizeRanges([[1, 2], { startSec: 3, endSec: 4 }]))
      .toEqual([{ startSec: 1, endSec: 2 }, { startSec: 3, endSec: 4 }]);
    expect(sanitizeRanges("nope")).toEqual([]);
  });

  it("the trim:setCuts IPC handler records the set and degrades on a null payload", () => {
    const setCuts = buildHandlers()["trim:setCuts"];
    expect(() => setCuts({}, null)).not.toThrow();
    setCuts({}, { uuid: "epCS4", ranges: [[600, 660]], ext: "mp3" });
    expect(getTrimCutSet("epCS4")).toEqual([{ startSec: 600, endSec: 660 }]);
  });
});

describe("review:capture IPC handler (slice 3 write edge)", () => {
  it("is wired into the handler map and routes the payload to appendRecords", async () => {
    const handlers = buildHandlers();
    expect(typeof handlers["review:capture"]).toBe("function");
    // A non-array payload is whole-batch rejected by appendRecords (no fs touched), so
    // this asserts the handler genuinely calls appendRecords - a stub returning the
    // queue would not produce this exact result object. It also confirms it returns a
    // Promise that resolves (best-effort) rather than throwing.
    const res = await handlers["review:capture"]({}, { not: "an array" });
    expect(res).toMatchObject({ ok: false, written: 0, error: "not-an-array" });
  });

  it("never throws on a null payload (best-effort)", async () => {
    const handler = buildHandlers()["review:capture"];
    await expect(handler({}, null)).resolves.toMatchObject({ ok: false });
  });
});
