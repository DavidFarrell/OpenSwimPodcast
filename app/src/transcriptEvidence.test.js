import { describe, it, expect } from "vitest";
import {
  toSegments, evidenceCuts, hasEvidence, cutForSegment,
  evidenceRows, highlightedCount,
} from "./transcriptEvidence.js";

const transcript = {
  segments: [
    { speaker: "A", start: 0, end: 30, text: "Welcome to the show." },
    { speaker: "A", start: 600, end: 640, text: "This episode is sponsored by Acme." },
    { speaker: "A", start: 640, end: 700, text: "Acme makes the best widgets." },
    { speaker: "A", start: 720, end: 760, text: "Back to the conversation." },
    { speaker: "B", start: 1390, end: 1420, text: "And another word from our sponsor." },
  ],
};

const trimEntry = {
  cuts: [
    { startSec: 600, endSec: 720, needsReview: false, label: "ad" },
    { startSec: 1390, endSec: 1445, needsReview: true, label: "ad" },
  ],
};

describe("transcriptEvidence - toSegments", () => {
  it("normalises a {segments} transcript and drops empty/whitespace text", () => {
    const out = toSegments({ segments: [
      { start: 1, end: 2, text: "  hi  " },
      { start: 3, end: 4, text: "" },
      { start: 5, end: 6, text: "   " },
      null,
      { start: 7, end: 8, text: "there" },
    ] });
    expect(out).toEqual([
      { start: 1, end: 2, text: "hi" },
      { start: 7, end: 8, text: "there" },
    ]);
  });

  it("accepts a bare array and returns [] for unusable input", () => {
    expect(toSegments([{ start: 0, end: 1, text: "x" }]).length).toBe(1);
    expect(toSegments(null)).toEqual([]);
    expect(toSegments({})).toEqual([]);
    expect(toSegments("nope")).toEqual([]);
  });
});

describe("transcriptEvidence - evidenceCuts", () => {
  it("keeps any cut with a usable range regardless of needsReview", () => {
    expect(evidenceCuts(trimEntry).length).toBe(2);
  });

  it("drops invalid / inverted / non-finite ranges", () => {
    const out = evidenceCuts({ cuts: [
      { startSec: 10, endSec: 5 },
      { startSec: 10, endSec: 10 },
      { startSec: "x", endSec: 20 },
      null,
      { startSec: 1, endSec: 2 },
    ] });
    expect(out).toEqual([{ startSec: 1, endSec: 2 }]);
  });
});

describe("transcriptEvidence - cutForSegment", () => {
  const cuts = evidenceCuts(trimEntry);

  it("matches a segment whose start lands inside a cut [start,end)", () => {
    expect(cutForSegment({ start: 600 }, cuts)).toBe(cuts[0]);
    expect(cutForSegment({ start: 700 }, cuts)).toBe(cuts[0]);
  });

  it("excludes the exclusive end and content outside any cut", () => {
    expect(cutForSegment({ start: 720 }, cuts)).toBe(null); // end is exclusive
    expect(cutForSegment({ start: 0 }, cuts)).toBe(null);
    expect(cutForSegment({ start: null }, cuts)).toBe(null);
  });
});

describe("transcriptEvidence - rows + counts", () => {
  it("marks exactly the in-cut segments and reports the count", () => {
    const rows = evidenceRows(transcript, trimEntry);
    expect(rows.map((r) => r.inCut)).toEqual([false, true, true, false, true]);
    expect(rows[1].cutLabel).toBe("ad");
    expect(rows[1].time).toBe("10:00"); // 600s
    expect(highlightedCount(transcript, trimEntry)).toBe(3);
  });

  it("hasEvidence requires both transcript and a usable cut", () => {
    expect(hasEvidence(transcript, trimEntry)).toBe(true);
    expect(hasEvidence(transcript, { cuts: [] })).toBe(false);
    expect(hasEvidence({ segments: [] }, trimEntry)).toBe(false);
    expect(hasEvidence(null, trimEntry)).toBe(false);
  });
});
