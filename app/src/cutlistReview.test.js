import { describe, it, expect } from "vitest";
import {
  flaggedCuts, hasFlaggedCuts, cutKey, formatTime, kindLabel,
  cutHeadline, reasonText, durationText, decisionFor, reviewRows,
  parseTimestamp, timestampValue, setBoundary, nudgeBoundary,
  playBeforeWindow, playAfterWindow, previewJoinWindows,
  PREVIEW_PAD_SEC, NUDGE_STEP_SEC,
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

describe("cutlistReview - parseTimestamp (editable field)", () => {
  it("parses mm:ss and h:mm:ss into seconds", () => {
    expect(parseTimestamp("23:10")).toBe(1390);
    expect(parseTimestamp("1:05")).toBe(65);
    expect(parseTimestamp("1:02:05")).toBe(3725);
    expect(parseTimestamp("0:00")).toBe(0);
  });

  it("parses a bare seconds value (with optional fraction)", () => {
    expect(parseTimestamp("90")).toBe(90);
    expect(parseTimestamp("90.5")).toBe(90.5);
    expect(parseTimestamp(125)).toBe(125);
  });

  it("rejects malformed input so the boundary is left untouched", () => {
    expect(parseTimestamp("")).toBe(null);
    expect(parseTimestamp("abc")).toBe(null);
    expect(parseTimestamp("1:75")).toBe(null);   // seconds field >= 60
    expect(parseTimestamp("1:75:00")).toBe(null); // minutes field >= 60
    expect(parseTimestamp("1:2:3:4")).toBe(null);
    expect(parseTimestamp(":30")).toBe(null);
    expect(parseTimestamp(null)).toBe(null);
    expect(parseTimestamp(undefined)).toBe(null);
  });

  it("timestampValue round-trips through formatTime, blank for bad input", () => {
    expect(timestampValue(1390)).toBe("23:10");
    expect(timestampValue(3725)).toBe("1:02:05");
    expect(timestampValue(NaN)).toBe("");
    expect(timestampValue(undefined)).toBe("");
  });
});

describe("cutlistReview - setBoundary (editable timestamp)", () => {
  const cut = { startSec: 600, endSec: 712, needsReview: true, label: "ad" };

  it("sets start, returning a new object and never mutating the original", () => {
    const next = setBoundary(cut, "start", 590);
    expect(next.startSec).toBe(590);
    expect(next.endSec).toBe(712);
    expect(next).not.toBe(cut);
    expect(cut.startSec).toBe(600); // unchanged
  });

  it("sets end", () => {
    expect(setBoundary(cut, "end", 720).endSec).toBe(720);
  });

  it("CARDINAL: rejects an edit that would invert the range (start >= end)", () => {
    expect(setBoundary(cut, "start", 712)).toBe(cut); // start == end
    expect(setBoundary(cut, "start", 800)).toBe(cut); // start > end
    expect(setBoundary(cut, "end", 600)).toBe(cut);   // end == start
    expect(setBoundary(cut, "end", 500)).toBe(cut);   // end < start
  });

  it("rejects unparseable / non-finite values and unknown sides", () => {
    expect(setBoundary(cut, "start", NaN)).toBe(cut);
    expect(setBoundary(cut, "middle", 605)).toBe(cut);
    expect(setBoundary(null, "start", 10)).toBe(null);
  });

  it("clamps a negative start to 0", () => {
    expect(setBoundary(cut, "start", -10).startSec).toBe(0);
  });
});

describe("cutlistReview - nudgeBoundary (-5s / +5s)", () => {
  const cut = { startSec: 600, endSec: 712, needsReview: true, label: "ad" };

  it("nudges start earlier and later by the step", () => {
    expect(nudgeBoundary(cut, "start", -NUDGE_STEP_SEC).startSec).toBe(595);
    expect(nudgeBoundary(cut, "start", NUDGE_STEP_SEC).startSec).toBe(605);
  });

  it("nudges end earlier and later by the step", () => {
    expect(nudgeBoundary(cut, "end", -NUDGE_STEP_SEC).endSec).toBe(707);
    expect(nudgeBoundary(cut, "end", NUDGE_STEP_SEC).endSec).toBe(717);
  });

  it("CARDINAL: a nudge that would cross the other boundary is a no-op", () => {
    const tight = { startSec: 100, endSec: 103 };
    // +5s on start would push it past end (108 > 103) - rejected, cut unchanged.
    expect(nudgeBoundary(tight, "start", NUDGE_STEP_SEC)).toBe(tight);
    // -5s on end would push it below start (98 < 100) - rejected.
    expect(nudgeBoundary(tight, "end", -NUDGE_STEP_SEC)).toBe(tight);
  });

  it("clamps a start nudged below zero to 0", () => {
    expect(nudgeBoundary({ startSec: 2, endSec: 50 }, "start", -NUDGE_STEP_SEC).startSec).toBe(0);
  });

  it("rejects a non-finite delta", () => {
    expect(nudgeBoundary(cut, "start", NaN)).toBe(cut);
  });
});

describe("cutlistReview - preview windows", () => {
  const cut = { startSec: 600, endSec: 712 };

  it("playBeforeWindow is PREVIEW_PAD_SEC ending at the cut start", () => {
    expect(playBeforeWindow(cut)).toEqual({ from: 600 - PREVIEW_PAD_SEC, to: 600 });
  });

  it("playAfterWindow is PREVIEW_PAD_SEC starting at the cut end", () => {
    expect(playAfterWindow(cut)).toEqual({ from: 712, to: 712 + PREVIEW_PAD_SEC });
  });

  it("preview-before clamps to 0 near the start of the episode", () => {
    expect(playBeforeWindow({ startSec: 2, endSec: 50 })).toEqual({ from: 0, to: 2 });
  });

  it("previewJoinWindows pairs the before and after windows for the join", () => {
    expect(previewJoinWindows(cut)).toEqual({
      before: { from: 596, to: 600 },
      after: { from: 712, to: 716 },
    });
  });

  it("honours a custom pad", () => {
    expect(playBeforeWindow(cut, 10)).toEqual({ from: 590, to: 600 });
    expect(playAfterWindow(cut, 10)).toEqual({ from: 712, to: 722 });
  });

  it("returns null for unusable cuts", () => {
    expect(playBeforeWindow({})).toBe(null);
    expect(playAfterWindow({})).toBe(null);
    expect(previewJoinWindows({ startSec: 5 })).toBe(null);
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
