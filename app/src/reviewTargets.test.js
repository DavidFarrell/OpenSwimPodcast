import { describe, it, expect } from "vitest";
import {
  buildReviewTargets, nextCursor, prevCursor, prevDisabled, nextDisabled,
} from "./reviewTargets.js";

// A held cut covers [600,700]; a confident cut covers [60,120]. Lines:
//   0 content (0-30), 1 confident-ad (60-90), 2 confident-ad (90-120),
//   3 content (300-330), 4 held-ad (600-630), 5 held-ad (630-660),
//   6 content (900-930).
// One sentence per segment so a line's index maps cleanly to its cut.
function episode(uuid, cuts) {
  return {
    uuid,
    segments: [
      { start: 0, end: 30, text: "Welcome to the show." },        // 0
      { start: 60, end: 90, text: "Sponsored by Acme." },         // 1
      { start: 90, end: 120, text: "Acme makes widgets." },       // 2
      { start: 300, end: 330, text: "Back to the topic." },       // 3
      { start: 600, end: 630, text: "Brought to you by Beta." },  // 4
      { start: 630, end: 660, text: "Beta is the best." },        // 5
      { start: 900, end: 930, text: "Thanks for listening." },    // 6
    ],
    cuts,
  };
}

const CONFIDENT = { startSec: 60, endSec: 120, needsReview: false, label: "ad" };
const HELD = { startSec: 600, endSec: 660, needsReview: true, label: "ad" };

describe("buildReviewTargets", () => {
  it("one target per held cut - its FIRST held line, not one per held line", () => {
    const targets = buildReviewTargets([episode("e1", [CONFIDENT, HELD])]);
    // HELD spans lines 4 and 5 - a single target at line 4 (the first held line).
    expect(targets).toEqual([{ uuid: "e1", lineIndex: 4 }]);
  });

  it("episodes with no held cuts contribute nothing (confident-only is skipped)", () => {
    const targets = buildReviewTargets([episode("e1", [CONFIDENT])]);
    expect(targets).toEqual([]);
  });

  it("orders held cuts across episodes: modal order, then time within an episode", () => {
    const HELD2 = { startSec: 300, endSec: 330, needsReview: true, label: "ad" }; // line 3
    // e1 has two held cuts (line 3 earlier, line 4 later); e2 has one (line 4).
    const targets = buildReviewTargets([
      episode("e1", [HELD2, HELD]),
      episode("e2", [HELD]),
    ]);
    expect(targets).toEqual([
      { uuid: "e1", lineIndex: 3 }, // e1, earlier in time
      { uuid: "e1", lineIndex: 4 }, // e1, later in time
      { uuid: "e2", lineIndex: 4 }, // e2
    ]);
  });

  it("walks ALL held cuts, including ones the user already opted into (stable cursor)", () => {
    // buildReviewTargets has no notion of selection - it is computed from the
    // detector's cuts alone, so an opted-in held cut still yields its target. This
    // is what keeps the cursor from shrinking as the user toggles.
    const targets = buildReviewTargets([episode("e1", [HELD])]);
    expect(targets).toEqual([{ uuid: "e1", lineIndex: 4 }]);
  });

  it("returns [] for non-array / empty input", () => {
    expect(buildReviewTargets(null)).toEqual([]);
    expect(buildReviewTargets([])).toEqual([]);
    expect(buildReviewTargets([null, { uuid: "" }])).toEqual([]);
  });
});

describe("nextCursor / prevCursor", () => {
  it("advances and steps back by one", () => {
    expect(nextCursor(0, 3)).toBe(1);
    expect(prevCursor(2, 3)).toBe(1);
  });

  it("CLAMPS at both ends - no wrap", () => {
    expect(nextCursor(2, 3)).toBe(2); // already last
    expect(prevCursor(0, 3)).toBe(0); // already first
  });

  it("is safe when n === 0", () => {
    expect(nextCursor(0, 0)).toBe(0);
    expect(prevCursor(0, 0)).toBe(0);
  });

  it("steps from the pre-first sentinel (-1) onto target 0", () => {
    // The first 'next' from the sentinel lands on the first real target.
    expect(nextCursor(-1, 3)).toBe(0);
  });
});

describe("prevDisabled / nextDisabled (sentinel-aware button gating)", () => {
  it("disables prev at the first target and at the pre-first sentinel", () => {
    expect(prevDisabled(0, 3)).toBe(true);   // first target
    expect(prevDisabled(-1, 3)).toBe(true);  // sentinel: nothing before
    expect(prevDisabled(1, 3)).toBe(false);
  });

  it("disables next only at the last target", () => {
    expect(nextDisabled(2, 3)).toBe(true);   // last target
    expect(nextDisabled(1, 3)).toBe(false);
  });

  it("keeps NEXT enabled at the sentinel even with a SINGLE target (so it is reachable)", () => {
    // The exact bug the sentinel fixes: one target, cursor at -1 -> next must work.
    expect(nextDisabled(-1, 1)).toBe(false);
    expect(prevDisabled(-1, 1)).toBe(true);
  });

  it("disables both when there are no targets (n === 0)", () => {
    expect(prevDisabled(-1, 0)).toBe(true);
    expect(nextDisabled(-1, 0)).toBe(true);
  });
});
