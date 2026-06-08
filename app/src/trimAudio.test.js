import { describe, it, expect } from "vitest";
import { fileUrlForDownload, buildTrimAudioUrls, applyCutEdit } from "./trimAudio.js";
import { cutKey } from "./cutlistReview.js";

describe("fileUrlForDownload", () => {
  it("builds a file:// URL for a ready download with a path", () => {
    expect(fileUrlForDownload({ state: "ready", path: "/tmp/cache/ep.mp3" }))
      .toBe("file:///tmp/cache/ep.mp3");
  });

  it("encodes spaces and unicode in the path but keeps separators", () => {
    expect(fileUrlForDownload({ state: "ready", path: "/a b/ép.mp3" }))
      .toBe("file:///a%20b/%C3%A9p.mp3");
  });

  it("passes an already-URL path through unchanged", () => {
    expect(fileUrlForDownload({ state: "ready", path: "file:///x/y.mp3" }))
      .toBe("file:///x/y.mp3");
  });

  // CARDINAL RULE for previews: never point the player at a partial / missing
  // file. Anything not fully downloaded yields null so previews stay disabled.
  it("returns null for a download that is not ready", () => {
    expect(fileUrlForDownload({ state: "downloading", path: "/tmp/ep.mp3" })).toBe(null);
    expect(fileUrlForDownload({ state: "error", path: "/tmp/ep.mp3" })).toBe(null);
    expect(fileUrlForDownload({ state: "queued", path: "/tmp/ep.mp3" })).toBe(null);
  });

  it("returns null when there is no usable path", () => {
    expect(fileUrlForDownload({ state: "ready", path: null })).toBe(null);
    expect(fileUrlForDownload({ state: "ready", path: "" })).toBe(null);
    expect(fileUrlForDownload({ state: "ready" })).toBe(null);
    expect(fileUrlForDownload(null)).toBe(null);
  });
});

describe("buildTrimAudioUrls", () => {
  it("maps only ready downloads to urls, omitting the rest", () => {
    const urls = buildTrimAudioUrls({
      a: { state: "ready", path: "/c/a.mp3" },
      b: { state: "downloading", path: "/c/b.mp3" },
      c: { state: "ready", path: null },
    });
    expect(urls).toEqual({ a: "file:///c/a.mp3" });
  });

  it("returns an empty object for empty / missing input", () => {
    expect(buildTrimAudioUrls({})).toEqual({});
    expect(buildTrimAudioUrls(null)).toEqual({});
    expect(buildTrimAudioUrls(undefined)).toEqual({});
  });
});

describe("applyCutEdit", () => {
  const cuts = [
    { startSec: 10, endSec: 20, label: "ad", reasons: ["over-threshold"], needsReview: true },
    { startSec: 100, endSec: 130, label: "ad", reasons: ["ambiguous-boundary"], needsReview: true },
  ];

  it("swaps only the matching cut's boundaries, preserving other fields", () => {
    const original = cuts[1];
    const next = applyCutEdit(cuts, original, { startSec: 95, endSec: 132 });
    expect(next).not.toBe(cuts);
    expect(next[0]).toBe(cuts[0]); // untouched cut kept by reference value
    expect(next[1]).toEqual({
      startSec: 95, endSec: 132, label: "ad",
      reasons: ["ambiguous-boundary"], needsReview: true,
    });
  });

  it("matches by stable cutKey, not object identity (edit survives a re-fetch)", () => {
    // A fresh object with the same boundaries as cuts[0] must still match.
    const sameBoundaries = { startSec: 10, endSec: 20 };
    expect(cutKey(sameBoundaries)).toBe(cutKey(cuts[0]));
    const next = applyCutEdit(cuts, sameBoundaries, { startSec: 12, endSec: 18 });
    expect(next[0].startSec).toBe(12);
    expect(next[0].endSec).toBe(18);
  });

  // Regression: a no-op must return the SAME array so App skips the state update.
  it("returns the same array when nothing matches or input is unusable", () => {
    expect(applyCutEdit(cuts, { startSec: 999, endSec: 1000 }, { startSec: 1, endSec: 2 })).toBe(cuts);
    expect(applyCutEdit([], cuts[0], { startSec: 1, endSec: 2 })).toEqual([]);
    expect(applyCutEdit(null, cuts[0], { startSec: 1, endSec: 2 })).toBe(null);
    expect(applyCutEdit(cuts, null, { startSec: 1, endSec: 2 })).toBe(cuts);
    expect(applyCutEdit(cuts, cuts[0], null)).toBe(cuts);
  });

  it("edits only the first matching cut when keys collide", () => {
    const dup = [
      { startSec: 10, endSec: 20, label: "a" },
      { startSec: 10, endSec: 20, label: "b" },
    ];
    const next = applyCutEdit(dup, { startSec: 10, endSec: 20 }, { startSec: 11, endSec: 21 });
    expect(next[0].startSec).toBe(11);
    expect(next[1].startSec).toBe(10); // second left intact
  });
});
