import { describe, it, expect } from "vitest";
import {
  snapshotInitial, buildReviewRecord, hashTranscript, hashProposal,
  SCHEMA_VERSION, SPLITTER_VERSION,
} from "./reviewCapture.js";
import { sentenceLines, selectedToRanges } from "./transcriptToggle.js";

// A four-sentence episode: one confident intro cut, one held mid-roll cut, the rest
// content. Lines (by midpoint):
//   line 0  mid 15   -> inside [0,30]    confident intro
//   line 1  mid 630  -> inside [600,700] held ad
//   line 2  mid 680  -> inside [600,700] held ad
//   line 3  mid 740  -> content (no cut)
const transcript = { segments: [
  { start: 0, end: 30, text: "Welcome to the show.", speaker: "S1" },
  { start: 600, end: 660, text: "Sponsored by Acme today.", speaker: "S1" },
  { start: 660, end: 700, text: "Acme makes great widgets.", speaker: "S1" },
  { start: 720, end: 760, text: "Back to the topic.", speaker: "S2" },
] };
const cuts = [
  { cutId: "intro1", startSec: 0, endSec: 30, label: "intro", reasons: ["intro"], needsReview: false,
    firstLineQuote: "Welcome", lastLineQuote: "show" },
  { cutId: "ad1", startSec: 600, endSec: 700, label: "ad", reasons: ["uncertain"], needsReview: true,
    firstLineQuote: "Sponsored", lastLineQuote: "widgets" },
];
const meta = {
  captureId: "cap-123", uuid: "ep-uuid", title: "Ep 1", showId: "show-9",
  enclosureUrl: "https://x/ep1.mp3", appVersion: "1.2.3",
  model: "gemma-4-12b", mode: "balanced", thresholds: { conf: 0.8 },
};
const behavioural = { openedAt: 1000, committedAt: 4000, openDurationMs: 3000, edited: true, toggleCount: 2 };

const lines = sentenceLines(transcript);
const snap = snapshotInitial({ lines, cuts });

describe("snapshotInitial", () => {
  it("computes preselect (confident only) and held (needsReview) internally", () => {
    // Confident intro -> line 0 preselected. Held ad -> lines 1,2 held, NOT preselected.
    expect(snap.preselect).toEqual([0]);
    expect(snap.held).toEqual([1, 2]);
  });

  it("clones the lines and projects the selectable cut table", () => {
    expect(snap.lines).not.toBe(lines); // cloned, not the caller's array
    expect(snap.lines.map((l) => l.index)).toEqual(lines.map((l) => l.index));
    expect(snap.cuts.map((c) => c.cutId)).toEqual(["intro1", "ad1"]);
  });

  it("freezes the snapshot so a held reference cannot mutate provenance", () => {
    expect(Object.isFrozen(snap)).toBe(true);
    expect(Object.isFrozen(snap.lines)).toBe(true);
    expect(Object.isFrozen(snap.lines[0])).toBe(true);
    expect(Object.isFrozen(snap.cuts[0])).toBe(true);
    // Mutating the snapshot throws in strict mode (ESM) / is a no-op; either way the
    // stored value is unchanged.
    expect(() => { snap.lines[0].text = "tampered"; }).toThrow();
    expect(snap.lines[0].text).toBe("Welcome to the show.");
  });

  it("is not affected by mutating the caller's inputs AFTER snapshotting (untrusted, incl. nested reasons)", () => {
    const localLines = sentenceLines(transcript);
    // A cut whose reasons hold an OBJECT - a shallow copy would leave it shared.
    const localCuts = [{ cutId: "c", startSec: 0, endSec: 30, needsReview: false, reasons: [{ kind: "intro", score: 0.9 }] }];
    const s = snapshotInitial({ lines: localLines, cuts: localCuts });
    // Tamper with the caller-owned inputs, including the nested reason object.
    localLines[0].text = "changed";
    localCuts[0].startSec = 999;
    localCuts[0].reasons[0].kind = "tampered";
    expect(s.lines[0].text).toBe("Welcome to the show.");
    expect(s.cuts[0].startSec).toBe(0);
    expect(s.cuts[0].reasons[0].kind).toBe("intro"); // deep-detached, not shared
    // And the snapshot did not freeze the caller's own object.
    expect(Object.isFrozen(localCuts[0].reasons[0])).toBe(false);
  });

  it("CARDINAL: malformed cuts never enter preselect/held/cuts (reuses selectableCuts)", () => {
    // A zero-length, an inverted, a null, plus one good confident + one good held cut.
    const s = snapshotInitial({ lines, cuts: [
      { cutId: "bad-zero", startSec: 5, endSec: 5, needsReview: false },
      { cutId: "bad-inv", startSec: 90, endSec: 60, needsReview: false },
      null,
      { cutId: "good-c", startSec: 0, endSec: 30, needsReview: false },
      { cutId: "good-h", startSec: 600, endSec: 700, needsReview: true },
    ] });
    expect(s.cuts.map((c) => c.cutId)).toEqual(["good-c", "good-h"]);
    expect(s.preselect).toEqual([0]);   // only the good confident cut
    expect(s.held).toEqual([1, 2]);     // only the good held cut
  });
});

describe("provenance classification (kept / cut_confident / cut_held)", () => {
  const rec = buildReviewRecord({ initialSnapshot: snap, finalSelected: new Set([0, 1, 2]), transcript, meta, behavioural });
  const byIndex = Object.fromEntries(rec.table.map((r) => [r.index, r]));

  it("classifies the confident-cut line as cut_confident", () => {
    expect(byIndex[0].initialState).toBe("cut_confident");
  });
  it("classifies held-cut lines as cut_held", () => {
    expect(byIndex[1].initialState).toBe("cut_held");
    expect(byIndex[2].initialState).toBe("cut_held");
  });
  it("classifies a content line as kept", () => {
    expect(byIndex[3].initialState).toBe("kept");
  });
  it("attributes sourceCutIds by midpoint containment", () => {
    expect(byIndex[0].sourceCutIds).toEqual(["intro1"]);
    expect(byIndex[1].sourceCutIds).toEqual(["ad1"]);
    expect(byIndex[3].sourceCutIds).toEqual([]);
  });
  it("carries text/time/speaker into each row", () => {
    expect(byIndex[0].text).toBe("Welcome to the show.");
    expect(byIndex[3].speaker).toBe("S2");
    expect(typeof byIndex[0].time).toBe("string");
  });
});

describe("finalState reflects the committed selection", () => {
  it("marks selected indices cut and the rest kept", () => {
    // User accepted the held ad (1,2), de-selected the confident intro (0).
    const rec = buildReviewRecord({ initialSnapshot: snap, finalSelected: new Set([1, 2]), transcript, meta, behavioural });
    const byIndex = Object.fromEntries(rec.table.map((r) => [r.index, r]));
    expect(byIndex[0].finalState).toBe("kept");
    expect(byIndex[1].finalState).toBe("cut");
    expect(byIndex[2].finalState).toBe("cut");
    expect(byIndex[3].finalState).toBe("kept");
  });
});

describe("derived signals (lists of indices)", () => {
  it("headline: addedUnflagged catches a kept line the user cut", () => {
    // User cut line 3 (content, initial=kept) -> the headline signal.
    const rec = buildReviewRecord({ initialSnapshot: snap, finalSelected: new Set([0, 3]), transcript, meta, behavioural });
    expect(rec.signals.addedUnflagged).toEqual([3]);
  });
  it("removedConfident catches a de-selected confident cut", () => {
    // Drop the confident intro (line 0).
    const rec = buildReviewRecord({ initialSnapshot: snap, finalSelected: new Set([]), transcript, meta, behavioural });
    expect(rec.signals.removedConfident).toEqual([0]);
  });
  it("heldAccepted / heldRejected split on the held lines' final state", () => {
    // Accept held line 1, reject held line 2.
    const rec = buildReviewRecord({ initialSnapshot: snap, finalSelected: new Set([1]), transcript, meta, behavioural });
    expect(rec.signals.heldAccepted).toEqual([1]);
    expect(rec.signals.heldRejected).toEqual([2]);
  });
});

describe("record shape + versioning", () => {
  const rec = buildReviewRecord({ initialSnapshot: snap, finalSelected: new Set([0]), transcript, meta, behavioural });

  it("stamps both schema and splitter versions", () => {
    expect(rec.schemaVersion).toBe(SCHEMA_VERSION);
    expect(rec.splitterVersion).toBe(SPLITTER_VERSION);
  });
  it("lays caller-supplied identity into the shape", () => {
    expect(rec.captureId).toBe("cap-123");
    expect(rec.uuid).toBe("ep-uuid");
    expect(rec.title).toBe("Ep 1");
    expect(rec.showId).toBe("show-9");
    expect(rec.enclosureUrl).toBe("https://x/ep1.mp3");
    expect(rec.appVersion).toBe("1.2.3");
    expect(rec.detector).toEqual({ model: "gemma-4-12b", mode: "balanced", thresholds: { conf: 0.8 } });
  });
  it("carries the raw segments AND the derived lines", () => {
    expect(rec.transcript.segments).toHaveLength(4);
    expect(rec.transcript.lines).toHaveLength(4);
    expect(rec.transcript.lines[0]).toMatchObject({ index: 0, text: "Welcome to the show." });
  });
  it("includes the detector proposal with quotes + reasons", () => {
    expect(rec.proposal).toHaveLength(2);
    expect(rec.proposal[1]).toMatchObject({
      cutId: "ad1", startSec: 600, endSec: 700, label: "ad", needsReview: true,
      firstLineQuote: "Sponsored", lastLineQuote: "widgets",
    });
    expect(rec.proposal[1].reasons).toEqual(["uncertain"]);
  });
  it("records behavioural fields verbatim (never gated)", () => {
    expect(rec.behavioural).toEqual({ openedAt: 1000, committedAt: 4000, openDurationMs: 3000, edited: true, toggleCount: 2 });
  });
  it("nulls absent meta/behavioural rather than throwing", () => {
    const bare = buildReviewRecord({ initialSnapshot: snap, finalSelected: new Set(), transcript });
    expect(bare.captureId).toBeNull();
    expect(bare.behavioural.toggleCount).toBeNull();
    expect(bare.detector).toEqual({ model: null, mode: null, thresholds: null });
  });
});

describe("hash determinism + sensitivity", () => {
  it("hashTranscript is stable across runs for the same lines", () => {
    expect(hashTranscript(lines)).toBe(hashTranscript(sentenceLines(transcript)));
  });
  it("hashTranscript changes when a sentence's text changes", () => {
    const other = sentenceLines({ segments: [{ start: 0, end: 30, text: "Different words here." }] });
    expect(hashTranscript(other)).not.toBe(hashTranscript(lines));
  });
  it("hashTranscript includes every projected line field (field-by-field sensitivity)", () => {
    const row = { index: 0, startSec: 0, endSec: 10, text: "Same words.", speaker: "S1" };
    const base = hashTranscript([row]);
    const tweak = (patch) => hashTranscript([{ ...row, ...patch }]);
    expect(tweak({ index: 1 })).not.toBe(base);
    expect(tweak({ startSec: 1 })).not.toBe(base);
    expect(tweak({ endSec: 11 })).not.toBe(base);
    expect(tweak({ text: "Other words." })).not.toBe(base);
    expect(tweak({ speaker: "S2" })).not.toBe(base);
  });
  it("hashProposal is canonical for nested reason objects (key order does not matter)", () => {
    // Two semantically-equal reason objects with different key insertion order must
    // hash the same, so equal proposals always share a dedupe key.
    const a = [{ cutId: "x", startSec: 0, endSec: 9, label: "ad", reasons: [{ kind: "intro", score: 0.9 }], needsReview: false, firstLineQuote: null, lastLineQuote: null }];
    const b = [{ cutId: "x", startSec: 0, endSec: 9, label: "ad", reasons: [{ score: 0.9, kind: "intro" }], needsReview: false, firstLineQuote: null, lastLineQuote: null }];
    expect(hashProposal(b)).toBe(hashProposal(a));
    // ...but a genuine change to a nested reason value still flips it.
    const c = [{ ...a[0], reasons: [{ kind: "intro", score: 0.1 }] }];
    expect(hashProposal(c)).not.toBe(hashProposal(a));
  });
  it("hashProposal includes every projected field (field-by-field sensitivity)", () => {
    // hashProposal takes PROJECTED proposal rows. Changing any meaningful field must
    // flip the key - so dropping a field from the hash projection would fail a test.
    const row = { cutId: "x", startSec: 600, endSec: 700, label: "ad", reasons: ["a"], needsReview: false, firstLineQuote: "fq", lastLineQuote: "lq" };
    const base = hashProposal([row]);
    const tweak = (patch) => hashProposal([{ ...row, ...patch }]);
    expect(tweak({ cutId: "y" })).not.toBe(base);
    expect(tweak({ startSec: 601 })).not.toBe(base);
    expect(tweak({ endSec: 701 })).not.toBe(base);
    expect(tweak({ label: "intro" })).not.toBe(base);
    expect(tweak({ reasons: ["b"] })).not.toBe(base);
    expect(tweak({ needsReview: true })).not.toBe(base);
    expect(tweak({ firstLineQuote: "other" })).not.toBe(base);
    expect(tweak({ lastLineQuote: "other" })).not.toBe(base);
  });
  it("hashes are 8-char hex strings", () => {
    expect(hashTranscript(lines)).toMatch(/^[0-9a-f]{8}$/);
    expect(hashProposal(cuts)).toMatch(/^[0-9a-f]{8}$/);
  });
  it("the record's stored hashes match hashing its OWN stored projections (cannot disagree)", () => {
    const rec = buildReviewRecord({ initialSnapshot: snap, finalSelected: new Set([0]), transcript, meta, behavioural });
    expect(rec.transcriptHash).toBe(hashTranscript(rec.transcript.lines));
    expect(rec.detectorProposalHash).toBe(hashProposal(rec.proposal));
  });
});

describe("opened-but-unedited episode (a clean positive)", () => {
  it("initial == final: every confident cut committed, nothing added or removed", () => {
    // No held cuts here - both cuts confident, so preselect == the full proposal.
    const confidentCuts = [
      { cutId: "i", startSec: 0, endSec: 30, label: "intro", needsReview: false },
      { cutId: "a", startSec: 600, endSec: 700, label: "ad", needsReview: false },
    ];
    const ls = sentenceLines(transcript);
    const s = snapshotInitial({ lines: ls, cuts: confidentCuts });
    // The gate seeds finalSelected = preselect and the user changes nothing.
    const finalSelected = new Set(s.preselect);
    const rec = buildReviewRecord({ initialSnapshot: s, finalSelected, transcript, meta, behavioural: { ...behavioural, edited: false, toggleCount: 0 } });
    // Every row: initialState cut_confident <-> finalState cut, or kept <-> kept.
    for (const r of rec.table) {
      const wasCut = r.initialState !== "kept";
      expect(r.finalState).toBe(wasCut ? "cut" : "kept");
    }
    // No drift signals at all.
    expect(rec.signals).toEqual({ addedUnflagged: [], removedConfident: [], heldAccepted: [], heldRejected: [] });
  });
});

describe("CARDINAL: collapsedRanges == selectedToRanges(lines, finalSelected)", () => {
  // The key regression. The record can ONLY describe the cut-set that the gate
  // actually commits - the same function, the same finalSelected.
  const cases = [
    new Set([0]),
    new Set([1, 2]),
    new Set([0, 1, 2, 3]),
    new Set([3]),
    new Set(),
    new Set([0, 3]), // non-contiguous
  ];
  for (const finalSelected of cases) {
    it(`matches the gate for selection {${[...finalSelected].join(",")}}`, () => {
      const rec = buildReviewRecord({ initialSnapshot: snap, finalSelected, transcript, meta, behavioural });
      // The EXACT call the gate makes: selectedToRanges(lines, finalSelected).
      expect(rec.collapsedRanges).toEqual(selectedToRanges(lines, finalSelected));
    });
  }

  it("CARDINAL: a non-Set finalSelected throws (a caller bug we surface, never silently 'cut nothing')", () => {
    // The gate always holds a Set. Silently coercing a wrong shape to empty would
    // record a divergent (empty) cut-set; throwing forces the caller to pass the SAME
    // Set it sends to trim.setCuts.
    expect(() => buildReviewRecord({ initialSnapshot: snap, finalSelected: undefined, transcript, meta, behavioural })).toThrow(TypeError);
    expect(() => buildReviewRecord({ initialSnapshot: snap, finalSelected: [0, 1], transcript, meta, behavioural })).toThrow();
  });
});
