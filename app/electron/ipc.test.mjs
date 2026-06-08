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
