import { describe, it, expect } from "vitest";
import {
  splitSentences, toSegments, interpTime, sentenceLines,
  selectableCuts, lineInCuts, preselectFromCuts, toggleSentence,
  selectedToRanges, panelSummary, selectedCount, flaggedLines, heldLines, heldCutCount,
} from "./transcriptToggle.js";

describe("splitSentences", () => {
  it("splits on sentence-ending punctuation, keeping the terminator", () => {
    const out = splitSentences("Hello there. How are you? I am fine!");
    expect(out.map((s) => s.text)).toEqual([
      "Hello there.", "How are you?", "I am fine!",
    ]);
  });

  it("treats a run with no terminal punctuation as a single sentence", () => {
    const out = splitSentences("no punctuation here");
    expect(out).toHaveLength(1);
    expect(out[0].text).toBe("no punctuation here");
    expect(out[0].charStart).toBe(0);
    expect(out[0].charEnd).toBe("no punctuation here".length);
  });

  it("handles a trailing fragment after the last terminator", () => {
    const out = splitSentences("Done. And a tail");
    expect(out.map((s) => s.text)).toEqual(["Done.", "And a tail"]);
  });

  it("keeps a closing quote/bracket with the sentence (mirrors _SENT_END)", () => {
    const out = splitSentences('He said "go now." Then left.');
    expect(out.map((s) => s.text)).toEqual(['He said "go now."', "Then left."]);
  });

  it("returns char offsets that index back into the original text", () => {
    const text = "One. Two.";
    const out = splitSentences(text);
    expect(text.slice(out[0].charStart, out[0].charEnd)).toBe("One.");
    expect(text.slice(out[1].charStart, out[1].charEnd)).toBe("Two.");
  });

  it("returns [] for blank / non-string input", () => {
    expect(splitSentences("")).toEqual([]);
    expect(splitSentences("   ")).toEqual([]);
    expect(splitSentences(null)).toEqual([]);
    expect(splitSentences(42)).toEqual([]);
  });
});

describe("toSegments", () => {
  it("accepts {segments:[...]} and a bare array; drops text-less / start-less", () => {
    const a = toSegments({ segments: [
      { start: 0, end: 5, text: "a" },
      { start: 5, text: "" },         // no text - dropped
      { end: 9, text: "no start" },   // no start - dropped
      { start: 9, end: 12, text: "b", speaker: "S1" },
    ] });
    expect(a.map((s) => s.text.trim())).toEqual(["a", "b"]);
    expect(a[1].speaker).toBe("S1");
    const b = toSegments([{ start: 0, end: 1, text: "x" }]);
    expect(b).toHaveLength(1);
  });

  it("returns [] for unusable input", () => {
    expect(toSegments(null)).toEqual([]);
    expect(toSegments({})).toEqual([]);
    expect(toSegments(123)).toEqual([]);
  });
});

describe("interpTime (proportional char interpolation)", () => {
  const seg = { start: 100, end: 200, text: "0123456789" }; // 10 chars, 100s span

  it("maps char offset proportionally within the segment", () => {
    expect(interpTime(seg, 0)).toBe(100);
    expect(interpTime(seg, 5)).toBe(150); // halfway
    expect(interpTime(seg, 10)).toBe(200);
  });

  it("clamps to [start, end]", () => {
    expect(interpTime(seg, -5)).toBe(100);
    expect(interpTime(seg, 999)).toBe(200);
  });

  it("collapses to start for a zero/negative/absent duration segment", () => {
    expect(interpTime({ start: 50, end: 50, text: "abc" }, 2)).toBe(50);
    expect(interpTime({ start: 50, end: null, text: "abc" }, 2)).toBe(50);
    expect(interpTime({ start: 50, end: 40, text: "abc" }, 2)).toBe(50);
  });
});

describe("sentenceLines", () => {
  it("flattens segments into per-sentence lines with interpolated times", () => {
    // One 20s segment, two equal-length sentences -> ~[0,10] and ~[10,20].
    const lines = sentenceLines({ segments: [
      { start: 0, end: 20, text: "Sentence aa. Sentence bb." },
    ] });
    expect(lines).toHaveLength(2);
    expect(lines[0].index).toBe(0);
    expect(lines[1].index).toBe(1);
    expect(lines[0].startSec).toBeCloseTo(0, 5);
    // "Sentence aa." is 12 chars of a 25-char string -> ~9.6s; both lines forward.
    expect(lines[0].endSec).toBeGreaterThan(lines[0].startSec);
    expect(lines[1].endSec).toBeGreaterThan(lines[1].startSec);
    expect(lines[1].endSec).toBeCloseTo(20, 5);
    // Global index is contiguous and ascending across segments.
    expect(lines.map((l) => l.index)).toEqual([0, 1]);
  });

  it("assigns a contiguous global index across multiple segments", () => {
    const lines = sentenceLines({ segments: [
      { start: 0, end: 10, text: "A. B." },
      { start: 10, end: 20, text: "C. D." },
    ] });
    expect(lines.map((l) => l.index)).toEqual([0, 1, 2, 3]);
    expect(lines.map((l) => l.segIndex)).toEqual([0, 0, 1, 1]);
    expect(lines.map((l) => l.text)).toEqual(["A.", "B.", "C.", "D."]);
  });

  it("always yields a forward (non-inverted) range per line", () => {
    // Degenerate: zero-duration segment. Every sentence collapses but stays forward.
    const lines = sentenceLines({ segments: [
      { start: 5, end: 5, text: "X. Y. Z." },
    ] });
    expect(lines).toHaveLength(3);
    for (const l of lines) expect(l.endSec).toBeGreaterThan(l.startSec);
  });

  it("carries a mm:ss time string from the start", () => {
    const lines = sentenceLines({ segments: [{ start: 630, end: 660, text: "Hi there." }] });
    expect(lines[0].time).toBe("10:30");
  });

  it("CARDINAL: adjacent sentence ranges within a segment are exactly touching (non-overlapping)", () => {
    // Each non-final sentence END snaps to the next sentence START, so a selected
    // sentence's cut can never bleed into an adjacent grey sentence's audio.
    const lines = sentenceLines({ segments: [
      { start: 0, end: 30, text: "First sentence here. Second one now. Third and last." },
    ] });
    expect(lines).toHaveLength(3);
    expect(lines[0].endSec).toBe(lines[1].startSec);
    expect(lines[1].endSec).toBe(lines[2].startSec);
    // No overlap anywhere.
    for (let k = 0; k + 1 < lines.length; k++) {
      expect(lines[k].endSec).toBeLessThanOrEqual(lines[k + 1].startSec);
    }
  });

  it("CARDINAL: no bleed across OVERLAPPING segment boundaries (global clamp)", () => {
    // Diarized segments can overlap: segment B starts (9s) BEFORE segment A ends
    // (10s). Segment A's final sentence would interpolate to ~10s and, without a
    // GLOBAL clamp, a selected A would cut [0,10] - eating 1s of B's (grey) audio.
    // The clamp must hold every line's end <= the next line's start.
    const lines = sentenceLines({ segments: [
      { start: 0, end: 10, text: "Sponsor read all the way." },   // 1 sentence -> ~[0,10]
      { start: 9, end: 20, text: "Back to the real episode now." }, // starts at 9 (overlap)
    ] });
    expect(lines).toHaveLength(2);
    // A's cut must not pass B's start (9), even though A's segment ends at 10.
    expect(lines[0].endSec).toBeLessThanOrEqual(lines[1].startSec);
    expect(lines[0].endSec).toBeLessThanOrEqual(9);
    // Still a forward (usable) range.
    expect(lines[0].endSec).toBeGreaterThan(lines[0].startSec);
  });
});

describe("selectableCuts", () => {
  it("keeps only cuts with a usable forward range", () => {
    const cuts = selectableCuts({ cuts: [
      { startSec: 0, endSec: 30 },
      { startSec: 50, endSec: 50 },   // zero-length - dropped
      { startSec: 90, endSec: 60 },   // inverted - dropped
      null,
      { startSec: 100, endSec: 130 },
    ] });
    expect(cuts).toHaveLength(2);
  });
  it("returns [] for no cuts / bad input", () => {
    expect(selectableCuts(undefined)).toEqual([]);
    expect(selectableCuts({ cuts: "x" })).toEqual([]);
  });
});

describe("preselectFromCuts + lineInCuts", () => {
  const transcript = { segments: [
    { start: 0, end: 30, text: "Welcome to the show." },        // line 0, mid 15
    { start: 600, end: 660, text: "Sponsored by Acme today." },  // line 1, mid 630
    { start: 660, end: 700, text: "Acme makes great widgets." }, // line 2, mid 680
    { start: 720, end: 760, text: "Back to the topic." },        // line 3, mid 740
  ] };

  it("pre-selects exactly the sentences whose midpoint is inside a detector cut", () => {
    const lines = sentenceLines(transcript);
    const sel = preselectFromCuts(lines, { cuts: [{ startSec: 600, endSec: 700, label: "ad" }] });
    // Lines 1 and 2 (the ad) selected; 0 and 3 (content) not.
    expect([...sel].sort((a, b) => a - b)).toEqual([1, 2]);
    expect(lineInCuts(lines[0], [{ startSec: 600, endSec: 700 }])).toBe(false);
    expect(lineInCuts(lines[1], [{ startSec: 600, endSec: 700 }])).toBe(true);
  });

  it("returns an empty set when there are no detector cuts (cardinal default)", () => {
    const lines = sentenceLines(transcript);
    expect(preselectFromCuts(lines, { cuts: [] }).size).toBe(0);
    expect(preselectFromCuts(lines, undefined).size).toBe(0);
  });

  it("CARDINAL: pre-selects CONFIDENT cuts only; a FLAGGED cut starts GREY (matches today's default-keep)", () => {
    const lines = sentenceLines(transcript);
    // Same [600,700] ad range, but FLAGGED needs-review -> NOT pre-selected.
    const flagged = preselectFromCuts(lines, {
      cuts: [{ startSec: 600, endSec: 700, needsReview: true, reasons: ["over-threshold"], label: "ad" }],
    });
    expect(flagged.size).toBe(0);
    // A confident cut at the same range IS pre-selected.
    const confident = preselectFromCuts(lines, {
      cuts: [{ startSec: 600, endSec: 700, needsReview: false, label: "ad" }],
    });
    expect([...confident].sort((a, b) => a - b)).toEqual([1, 2]);
  });

  it("with mixed cuts, pre-selects only the confident one's sentences", () => {
    const lines = sentenceLines(transcript);
    const sel = preselectFromCuts(lines, { cuts: [
      { startSec: 0, endSec: 30, needsReview: false, label: "intro" },     // confident -> line 0
      { startSec: 600, endSec: 700, needsReview: true, label: "ad" },      // flagged -> grey
    ] });
    expect([...sel].sort((a, b) => a - b)).toEqual([0]);
  });
});

describe("flaggedLines + heldCutCount (held cuts stay VISIBLE but opt-in)", () => {
  const transcript = { segments: [
    { start: 0, end: 30, text: "Welcome to the show." },        // line 0, mid 15
    { start: 600, end: 660, text: "Sponsored by Acme today." },  // line 1, mid 630
    { start: 660, end: 700, text: "Acme makes great widgets." }, // line 2, mid 680
    { start: 720, end: 760, text: "Back to the topic." },        // line 3, mid 740
  ] };

  it("flags lines from BOTH confident and held cuts (so a held cut is findable)", () => {
    const lines = sentenceLines(transcript);
    const flagged = flaggedLines(lines, { cuts: [
      { startSec: 0, endSec: 30, needsReview: false, label: "intro" }, // confident -> line 0
      { startSec: 600, endSec: 700, needsReview: true, label: "ad" },  // HELD -> lines 1,2
    ] });
    expect([...flagged].sort((a, b) => a - b)).toEqual([0, 1, 2]);
  });

  it("CARDINAL: a HELD cut is FLAGGED (visible) but NOT pre-selected (opt-in)", () => {
    const lines = sentenceLines(transcript);
    const trimEntry = { cuts: [{ startSec: 600, endSec: 700, needsReview: true, label: "ad" }] };
    // Flagged so the user can SEE + click it...
    expect([...flaggedLines(lines, trimEntry)].sort((a, b) => a - b)).toEqual([1, 2]);
    // ...but NOT auto-selected (it stays grey until the user opts in - cardinal rule).
    expect(preselectFromCuts(lines, trimEntry).size).toBe(0);
  });

  it("returns an empty set when there are no cuts", () => {
    const lines = sentenceLines(transcript);
    expect(flaggedLines(lines, { cuts: [] }).size).toBe(0);
    expect(flaggedLines(lines, undefined).size).toBe(0);
  });

  it("heldCutCount counts only needsReview === true cuts", () => {
    expect(heldCutCount({ cuts: [
      { startSec: 0, endSec: 30, needsReview: false },
      { startSec: 600, endSec: 700, needsReview: true },
      { startSec: 720, endSec: 760, needsReview: true },
    ] })).toBe(2);
    expect(heldCutCount({ cuts: [{ startSec: 0, endSec: 30, needsReview: false }] })).toBe(0);
    expect(heldCutCount(undefined)).toBe(0);
  });
});

describe("heldLines (the precise ⚑ marker set - held cuts ONLY, not confident)", () => {
  const transcript = { segments: [
    { start: 0, end: 30, text: "Welcome to the show." },        // line 0, mid 15
    { start: 600, end: 660, text: "Sponsored by Acme today." },  // line 1, mid 630
    { start: 660, end: 700, text: "Acme makes great widgets." }, // line 2, mid 680
    { start: 720, end: 760, text: "Back to the topic." },        // line 3, mid 740
  ] };

  it("returns ONLY lines inside a held (needsReview) cut - a confident cut gets no ⚑", () => {
    const lines = sentenceLines(transcript);
    const held = heldLines(lines, { cuts: [
      { startSec: 0, endSec: 30, needsReview: false, label: "intro" }, // confident -> NOT held
      { startSec: 600, endSec: 700, needsReview: true, label: "ad" },  // HELD -> lines 1,2
    ] });
    expect([...held].sort((a, b) => a - b)).toEqual([1, 2]);
  });

  it("is a STRICT SUBSET of flaggedLines (held ⊆ flagged); the difference is confident-cut lines", () => {
    const lines = sentenceLines(transcript);
    const trimEntry = { cuts: [
      { startSec: 0, endSec: 30, needsReview: false, label: "intro" }, // confident -> line 0
      { startSec: 600, endSec: 700, needsReview: true, label: "ad" },  // held -> lines 1,2
    ] };
    const flagged = flaggedLines(lines, trimEntry);
    const held = heldLines(lines, trimEntry);
    // held marks 1,2; flagged marks 0,1,2; line 0 (the confident cut) is flagged-not-held.
    expect([...held].sort((a, b) => a - b)).toEqual([1, 2]);
    expect([...flagged].sort((a, b) => a - b)).toEqual([0, 1, 2]);
    expect([...held].every((i) => flagged.has(i))).toBe(true);
    expect(flagged.has(0)).toBe(true);
    expect(held.has(0)).toBe(false);
  });

  it("returns an empty set when there are no held cuts (all confident) or no cuts", () => {
    const lines = sentenceLines(transcript);
    expect(heldLines(lines, { cuts: [{ startSec: 0, endSec: 30, needsReview: false }] }).size).toBe(0);
    expect(heldLines(lines, { cuts: [] }).size).toBe(0);
    expect(heldLines(lines, undefined).size).toBe(0);
  });
});

describe("toggleSentence", () => {
  it("adds an unselected index and removes a selected one, returning a new Set", () => {
    const a = new Set([1, 2]);
    const b = toggleSentence(a, 3);
    expect([...b].sort()).toEqual([1, 2, 3]);
    expect(b).not.toBe(a); // new object
    const c = toggleSentence(b, 2);
    expect([...c].sort()).toEqual([1, 3]);
  });
});

describe("selectedToRanges (the cut-set the user commits)", () => {
  // Six sentences across the timeline, evenly placed.
  const lines = [
    { index: 0, startSec: 0, endSec: 10 },
    { index: 1, startSec: 10, endSec: 20 },
    { index: 2, startSec: 20, endSec: 30 },
    { index: 3, startSec: 30, endSec: 40 },
    { index: 4, startSec: 40, endSec: 50 },
    { index: 5, startSec: 50, endSec: 60 },
  ];

  it("collapses a single contiguous run into one range", () => {
    const r = selectedToRanges(lines, new Set([1, 2, 3]));
    expect(r).toEqual([{ startSec: 10, endSec: 40 }]);
  });

  it("splits non-contiguous selections into separate ranges (grey gap = kept)", () => {
    // 0,1 selected, 2 grey, 4,5 selected -> two ranges; sentence 3 also grey.
    const r = selectedToRanges(lines, new Set([0, 1, 4, 5]));
    expect(r).toEqual([
      { startSec: 0, endSec: 20 },
      { startSec: 40, endSec: 60 },
    ]);
  });

  it("returns one range per isolated selected sentence", () => {
    const r = selectedToRanges(lines, new Set([2]));
    expect(r).toEqual([{ startSec: 20, endSec: 30 }]);
  });

  it("CARDINAL: a selected sentence's cut never bleeds into an adjacent GREY sentence", () => {
    // Same-segment sentences (touching ranges). Select sentence 2 only; its cut must
    // end exactly at sentence 3's start (30), not extend into the grey sentence 3.
    const segLines = sentenceLines({ segments: [
      { start: 0, end: 40, text: "One here. Two here. Three here. Four here." },
    ] });
    // 4 sentences, each ~10s, touching.
    const sel = new Set([segLines[1].index]); // "Two here."
    const r = selectedToRanges(segLines, sel);
    expect(r).toHaveLength(1);
    expect(r[0].startSec).toBe(segLines[1].startSec);
    expect(r[0].endSec).toBe(segLines[1].endSec);
    expect(r[0].endSec).toBe(segLines[2].startSec); // touches sentence 3, not into it
  });

  it("returns [] when nothing is selected (CARDINAL: grey is never cut)", () => {
    expect(selectedToRanges(lines, new Set())).toEqual([]);
    expect(selectedToRanges(lines, undefined)).toEqual([]);
  });

  it("CARDINAL: splits an index-contiguous run across a real TIME gap (kept audio not bridged)", () => {
    // Two selected sentences, consecutive indices, but ~9 minutes apart in time -
    // e.g. a selected intro line and a selected mid-roll line. They must NOT collapse
    // into one giant cut that removes the kept content in between.
    const farLines = [
      { index: 0, startSec: 0, endSec: 20 },     // intro
      { index: 1, startSec: 600, endSec: 660 },  // mid-roll, 580s gap
    ];
    const r = selectedToRanges(farLines, new Set([0, 1]));
    expect(r).toEqual([
      { startSec: 0, endSec: 20 },
      { startSec: 600, endSec: 660 },
    ]);
  });

  it("merges sentences that are truly touching (sub-slack gap) into one cut", () => {
    // <=0.5s gap = char-interp rounding slack between adjacent sentences - one cut.
    const adj = [
      { index: 0, startSec: 600, endSec: 630 },
      { index: 1, startSec: 630.2, endSec: 660 },
    ];
    expect(selectedToRanges(adj, new Set([0, 1]))).toEqual([{ startSec: 600, endSec: 660 }]);
  });

  it("CARDINAL: a 3s UNSELECTED gap between two selected sentences (no grey line) -> TWO ranges, gap intact", () => {
    // The gap (630 -> 633) has NO transcribed sentence between the two selected ones.
    // It could be real content / music / dropped-transcript / missed words, so it must
    // NOT be cut: split into two ranges and leave the 3s gap intact (cut less).
    const gapped = [
      { index: 0, startSec: 600, endSec: 630 },
      { index: 1, startSec: 633, endSec: 660 }, // 3s unselected gap, > 0.5s slack
    ];
    expect(selectedToRanges(gapped, new Set([0, 1]))).toEqual([
      { startSec: 600, endSec: 630 },
      { startSec: 633, endSec: 660 },
    ]);
  });

  it("ignores selected indices that do not exist in the line list", () => {
    const r = selectedToRanges(lines, new Set([99]));
    expect(r).toEqual([]);
  });
});

describe("round-trip: detector cuts -> preselect -> ranges reproduces the cut set", () => {
  // The cardinal-rule contract: with NO user edits, committing the pre-selected
  // set reproduces (approximately) the detector's proposed cut - so default
  // behaviour matches "the detector's cuts get cut".
  const transcript = { segments: [
    { start: 0, end: 20, text: "Intro one. Intro two." },
    { start: 600, end: 660, text: "Ad line one. Ad line two." },
    { start: 700, end: 740, text: "Real content resumes here." },
  ] };
  // Both CONFIDENT here: a confident cut starts pre-selected, so committing with no
  // edits reproduces the detector's cut set (default == today). (A FLAGGED cut starts
  // grey - covered by its own test below.)
  const trimEntry = { cuts: [
    { startSec: 0, endSec: 20, needsReview: false, label: "intro" },
    { startSec: 600, endSec: 660, needsReview: false, label: "ad" },
  ] };

  it("the committed ranges cover the detector cuts and nothing else", () => {
    const lines = sentenceLines(transcript);
    const sel = preselectFromCuts(lines, trimEntry);
    const ranges = selectedToRanges(lines, sel);
    // Two contiguous runs: the intro segment's two sentences, and the ad segment's.
    expect(ranges).toHaveLength(2);
    // Intro run spans ~[0,20].
    expect(ranges[0].startSec).toBeCloseTo(0, 5);
    expect(ranges[0].endSec).toBeCloseTo(20, 5);
    // Ad run spans ~[600,660].
    expect(ranges[1].startSec).toBeCloseTo(600, 5);
    expect(ranges[1].endSec).toBeCloseTo(660, 5);
    // The content sentence (700-740) is NOT in any committed range.
    const contentMid = 720;
    const cut = ranges.some((r) => contentMid >= r.startSec && contentMid <= r.endSec);
    expect(cut).toBe(false);
  });

  it("EXTEND: selecting the content sentence adds it to a cut range", () => {
    const lines = sentenceLines(transcript);
    let sel = preselectFromCuts(lines, trimEntry);
    const contentLine = lines.find((l) => l.text.startsWith("Real content"));
    sel = toggleSentence(sel, contentLine.index);
    const ranges = selectedToRanges(lines, sel);
    const contentMid = 720;
    expect(ranges.some((r) => contentMid >= r.startSec && contentMid <= r.endSec)).toBe(true);
  });

  it("SHRINK: de-selecting an ad sentence narrows/removes its cut", () => {
    const lines = sentenceLines(transcript);
    let sel = preselectFromCuts(lines, trimEntry);
    // Un-select BOTH ad sentences -> the ad cut disappears entirely.
    for (const l of lines.filter((x) => x.text.startsWith("Ad line"))) {
      sel = toggleSentence(sel, l.index);
    }
    const ranges = selectedToRanges(lines, sel);
    const adMid = 630;
    expect(ranges.some((r) => adMid >= r.startSec && adMid <= r.endSec)).toBe(false);
  });
});

describe("panelSummary", () => {
  it("summarises by kind from labels", () => {
    expect(panelSummary({ cuts: [{ startSec: 0, endSec: 9, label: "intro" }] })).toBe("Intro");
    expect(panelSummary({ cuts: [
      { startSec: 0, endSec: 9, label: "intro" },
      { startSec: 100, endSec: 130, label: "ad" },
      { startSec: 200, endSec: 230, label: "ad" },
    ] })).toBe("Intro + 2 mid-rolls");
    expect(panelSummary({ cuts: [
      { startSec: 0, endSec: 9, label: "intro+outro" },
    ] })).toBe("Intro + outro");
  });
  it("falls back to a plain count when labels are unhelpful", () => {
    expect(panelSummary({ cuts: [
      { startSec: 0, endSec: 9, label: "" },
      { startSec: 100, endSec: 130, label: "" },
      { startSec: 200, endSec: 230, label: "" },
    ] })).toBe("3 mid-rolls");
  });
  it("handles the empty case", () => {
    expect(panelSummary({ cuts: [] })).toBe("no cuts");
  });
});

describe("selectedCount", () => {
  it("counts the selected set safely", () => {
    expect(selectedCount(new Set([1, 2, 3]))).toBe(3);
    expect(selectedCount(undefined)).toBe(0);
  });
});
