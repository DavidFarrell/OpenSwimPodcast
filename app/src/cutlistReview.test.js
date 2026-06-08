import { describe, it, expect } from "vitest";
import {
  flaggedCuts, hasFlaggedCuts, cutKey, formatTime, kindLabel,
  cutHeadline, reasonText, durationText, decisionFor, reviewRows,
} from "./cutlistReview.js";

const clean = { startSec: 0, endSec: 30, needsReview: false, reasons: [], label: "intro" };
const flaggedMid = { startSec: 1390, endSec: 1445, needsReview: true, reasons: ["over-threshold"], label: "ad" };
const flaggedAmb = { startSec: 600, endSec: 712, needsReview: true, reasons: ["ambiguous-boundary"], label: "ad" };

describe("cutlistReview - flagged-only filtering", () => {
  it("returns ONLY needs-review cuts (clean auto-applied cuts never appear)", () => {
    const entry = { status: "needs-review", cuts: [clean, flaggedMid, flaggedAmb] };
    expect(flaggedCuts(entry)).toEqual([flaggedMid, flaggedAmb]);
  });

  it("hasFlaggedCuts is false when every cut auto-applied (CARDINAL: surface stays hidden)", () => {
    expect(hasFlaggedCuts({ status: "ready", cuts: [clean] })).toBe(false);
    expect(hasFlaggedCuts({ status: "ready", cuts: [] })).toBe(false);
    expect(hasFlaggedCuts(undefined)).toBe(false);
    expect(hasFlaggedCuts({ status: "needs-review", cuts: [flaggedMid] })).toBe(true);
  });
});

describe("cutlistReview - formatting", () => {
  it("formatTime renders mm:ss and h:mm:ss", () => {
    expect(formatTime(1390)).toBe("23:10");
    expect(formatTime(65)).toBe("1:05");
    expect(formatTime(3725)).toBe("1:02:05");
    expect(formatTime(-5)).toBe("0:00");
    expect(formatTime(NaN)).toBe("0:00");
  });

  it("kindLabel maps label to a human kind, mid-episode reads Mid-roll", () => {
    expect(kindLabel({ label: "intro" })).toBe("Intro");
    expect(kindLabel({ label: "outro" })).toBe("Outro");
    expect(kindLabel({ label: "intro+outro" })).toBe("Intro + outro");
    expect(kindLabel({ label: "ad" })).toBe("Mid-roll");
    expect(kindLabel({})).toBe("Mid-roll");
  });

  it("cutHeadline reads e.g. 'Mid-roll 23:10-24:05'", () => {
    expect(cutHeadline(flaggedMid)).toBe("Mid-roll 23:10-24:05");
  });

  it("reasonText turns reason codes into plain language with a safe fallback", () => {
    expect(reasonText(flaggedMid)).toContain("safe auto-cut length");
    expect(reasonText(flaggedAmb)).toContain("could not be pinned down");
    expect(reasonText({ reasons: [] })).toContain("flagged for review");
  });

  it("durationText gives an approximate length", () => {
    expect(durationText(flaggedMid)).toBe("55s");
    expect(durationText(flaggedAmb)).toBe("1m 52s");
    expect(durationText({ startSec: 10, endSec: 70 })).toBe("1m");
    expect(durationText({ startSec: 10, endSec: 5 })).toBe("");
  });
});

describe("cutlistReview - cutKey + decisions", () => {
  it("cutKey is stable and ms-rounded", () => {
    expect(cutKey(flaggedMid)).toBe("1390000-1445000");
    expect(cutKey({ startSec: 1.2345, endSec: 2.6789 })).toBe("1235-2679");
    expect(cutKey({})).toBe(null);
  });

  it("decisionFor defaults to keep (CARDINAL: never remove without an explicit choice)", () => {
    expect(decisionFor(flaggedMid, {})).toBe("keep");
    expect(decisionFor(flaggedMid, undefined)).toBe("keep");
    expect(decisionFor(flaggedMid, { "1390000-1445000": "remove" })).toBe("remove");
    expect(decisionFor(flaggedMid, { "1390000-1445000": "keep" })).toBe("keep");
  });
});

describe("cutlistReview - reviewRows view-model", () => {
  it("builds one row per flagged cut, carrying decision + reason + headline", () => {
    const entry = { status: "needs-review", cuts: [clean, flaggedMid, flaggedAmb] };
    const decisions = { "1390000-1445000": "remove" };
    const rows = reviewRows(entry, decisions);
    expect(rows).toHaveLength(2);
    expect(rows[0].key).toBe("1390000-1445000");
    expect(rows[0].headline).toBe("Mid-roll 23:10-24:05");
    expect(rows[0].decision).toBe("remove");
    expect(rows[1].decision).toBe("keep");
    expect(rows[1].reason).toContain("could not be pinned down");
  });
});
