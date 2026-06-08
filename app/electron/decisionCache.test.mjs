import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { createRequire } from "node:module";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";

const require = createRequire(import.meta.url);
const {
  cutKey, decisionSidecarPath, readDecisions, writeDecisions, applyDecisions,
} = require("./decisionCache.cjs");
const { fingerprint } = require("./transcribe.cjs");

function mkTmp(label = "os-dec-") { return fs.mkdtempSync(path.join(os.tmpdir(), label)); }
function rmTmp(d) { try { fs.rmSync(d, { recursive: true, force: true }); } catch {} }

describe("cutKey", () => {
  it("matches the ipc.cjs / cutlistReview.js key shape (ms-rounded start-end)", () => {
    expect(cutKey({ startSec: 600, endSec: 700 })).toBe("600000-700000");
    expect(cutKey({ startSec: 12.3456, endSec: 13.0 })).toBe("12346-13000");
  });
  it("returns null for unusable cuts", () => {
    expect(cutKey(null)).toBe(null);
    expect(cutKey({ startSec: "x", endSec: 1 })).toBe(null);
  });
});

describe("read/writeDecisions round-trip (fingerprint-keyed sidecar)", () => {
  let dir, src;
  beforeEach(() => {
    dir = mkTmp();
    src = path.join(dir, "ep.mp3");
    fs.writeFileSync(src, Buffer.from("episode audio bytes"));
  });
  afterEach(() => rmTmp(dir));

  it("persists a decision map and reads it back keyed by audio fingerprint", async () => {
    const decisions = { "600000-700000": "remove", "900000-1000000": "keep" };
    expect(await writeDecisions({ src, decisions })).toBe(true);

    const fp = await fingerprint(src);
    const sidecar = decisionSidecarPath(src, fp);
    expect(fs.existsSync(sidecar)).toBe(true);

    const read = await readDecisions({ src });
    expect(read).toEqual(decisions);
  });

  it("returns {} on a cache miss (no sidecar yet)", async () => {
    expect(await readDecisions({ src })).toEqual({});
  });

  it("misses when the audio file changes (fingerprint moves)", async () => {
    await writeDecisions({ src, decisions: { "600000-700000": "remove" } });
    expect(await readDecisions({ src })).toEqual({ "600000-700000": "remove" });

    // Re-download / re-encode: different size + mtime -> new fingerprint -> miss.
    fs.writeFileSync(src, Buffer.from("a totally different, longer episode payload"));
    expect(await readDecisions({ src })).toEqual({});
  });

  it("tolerates a corrupt cache file (returns {}, never throws)", async () => {
    const fp = await fingerprint(src);
    fs.writeFileSync(decisionSidecarPath(src, fp), "{ this is not json ");
    expect(await readDecisions({ src })).toEqual({});
  });

  it("drops malformed entries on read so a bad value never becomes a phantom remove", async () => {
    const fp = await fingerprint(src);
    const payload = { version: 1, decisions: { "1-2": "remove", "3-4": "garbage", "5-6": "keep" } };
    fs.writeFileSync(decisionSidecarPath(src, fp), JSON.stringify(payload));
    expect(await readDecisions({ src })).toEqual({ "1-2": "remove", "5-6": "keep" });
  });

  it("sanitises on write - only keep/remove values are persisted", async () => {
    await writeDecisions({ src, decisions: { "1-2": "remove", "3-4": "nope", "5-6": "keep" } });
    expect(await readDecisions({ src })).toEqual({ "1-2": "remove", "5-6": "keep" });
  });

  it("write degrades to false for a missing src instead of throwing", async () => {
    expect(await writeDecisions({ src: "/no/such/file.mp3", decisions: { "1-2": "keep" } })).toBe(false);
  });

  it("read degrades to {} for a missing src instead of throwing", async () => {
    expect(await readDecisions({ src: "/no/such/file.mp3" })).toEqual({});
  });
});

describe("applyDecisions (trust-layer reuse)", () => {
  it("un-flags a cut the user previously chose to REMOVE so it auto-applies", () => {
    const cuts = [{ startSec: 600, endSec: 700, needsReview: true, reasons: ["over-threshold"] }];
    const out = applyDecisions(cuts, { "600000-700000": "remove" });
    expect(out).toHaveLength(1);
    expect(out[0].needsReview).toBe(false);
    expect(out[0].decided).toBe("remove");
  });

  it("drops a cut the user previously chose to KEEP so it is never re-flagged", () => {
    const cuts = [{ startSec: 600, endSec: 700, needsReview: true, reasons: ["over-threshold"] }];
    const out = applyDecisions(cuts, { "600000-700000": "keep" });
    expect(out).toEqual([]);
  });

  it("leaves a flagged cut with NO recorded decision exactly as detected", () => {
    const cuts = [{ startSec: 600, endSec: 700, needsReview: true, reasons: ["over-threshold"] }];
    const out = applyDecisions(cuts, {});
    expect(out).toEqual(cuts);
  });

  it("passes through non-flagged (auto-applyable) cuts untouched", () => {
    const cuts = [{ startSec: 5, endSec: 30, needsReview: false, reasons: [] }];
    const out = applyDecisions(cuts, { "5000-30000": "keep" });
    // A clean auto-cut is governed by the detector, not the review cache.
    expect(out).toEqual(cuts);
  });

  it("never invents a removal - missing decisions map is treated as empty", () => {
    const cuts = [{ startSec: 600, endSec: 700, needsReview: true, reasons: [] }];
    expect(applyDecisions(cuts, null)).toEqual(cuts);
    expect(applyDecisions(cuts, undefined)).toEqual(cuts);
  });

  it("re-applies an ADJUSTED remove at the user-adjusted boundaries, NOT the detector's", () => {
    // The cut was DETECTED at 600-700 but the user approved a removal only after
    // nudging the boundaries to 615-690. The decision is keyed by the ORIGINAL cut
    // key; the applied cut must carry the adjusted range so we never trim the audio
    // (600-615, 690-700) the user explicitly excluded.
    const cuts = [{ startSec: 600, endSec: 700, needsReview: true, reasons: ["over-threshold"] }];
    const out = applyDecisions(cuts, {
      "600000-700000": { action: "remove", startSec: 615, endSec: 690 },
    });
    expect(out).toHaveLength(1);
    expect(out[0].needsReview).toBe(false);
    expect(out[0].decided).toBe("remove");
    expect(out[0].startSec).toBe(615);
    expect(out[0].endSec).toBe(690);
    expect(out[0].adjusted).toBe(true);
  });

  it("drops a malformed adjusted-remove (does NOT fall back to the detector's wider range) - cardinal rule", () => {
    const cuts = [{ startSec: 600, endSec: 700, needsReview: true, reasons: ["over-threshold"] }];
    // Inverted boundaries (start >= end) make this adjusted-remove unusable. The
    // user approved the removal only at the NARROWED range, so we must NOT degrade
    // to a plain "remove" - that would re-apply the detector's wider 600-700 and
    // trim audio the user excluded. The unusable decision is dropped: the cut keeps
    // its needs-review flag and is re-asked, never auto-applied at the wide range.
    const out = applyDecisions(cuts, {
      "600000-700000": { action: "remove", startSec: 690, endSec: 615 },
    });
    expect(out).toHaveLength(1);
    expect(out[0].needsReview).toBe(true);
    expect(out[0].decided).toBeUndefined();
    expect(out[0].startSec).toBe(600);
    expect(out[0].endSec).toBe(700);
  });
});

describe("adjusted-remove sidecar round-trip", () => {
  let dir, src;
  beforeEach(() => {
    dir = mkTmp();
    src = path.join(dir, "ep.mp3");
    fs.writeFileSync(src, Buffer.from("episode audio bytes"));
  });
  afterEach(() => rmTmp(dir));

  it("persists and reads back an adjusted-remove object, then re-applies at the adjusted range", async () => {
    const decisions = {
      "600000-700000": { action: "remove", startSec: 615, endSec: 690 },
      "900000-1000000": "keep",
    };
    expect(await writeDecisions({ src, decisions })).toBe(true);
    const read = await readDecisions({ src });
    expect(read).toEqual(decisions);

    // The detector re-proposes the ORIGINAL 600-700 block on re-process; the cached
    // adjusted-remove must drive the applied cut to 615-690.
    const cuts = [{ startSec: 600, endSec: 700, needsReview: true, reasons: ["over-threshold"] }];
    const applied = applyDecisions(cuts, read);
    expect(applied).toHaveLength(1);
    expect(applied[0].startSec).toBe(615);
    expect(applied[0].endSec).toBe(690);
    expect(applied[0].needsReview).toBe(false);
  });

  it("drops a malformed adjusted-remove on write (never persisted as a plain remove) - cardinal rule", async () => {
    // A malformed adjusted-remove is unusable. It must NOT be persisted as a plain
    // "remove", which would re-apply the detector's wider range on the next pass and
    // trim audio the user excluded. Dropping it means the cut is re-asked next time.
    await writeDecisions({ src, decisions: {
      "1-2": { action: "remove", startSec: 5, endSec: 3 },   // inverted -> dropped
      "3-4": { action: "remove", startSec: -1, endSec: 10 }, // negative -> dropped
      "5-6": "remove",                                       // a real plain remove survives
    } });
    expect(await readDecisions({ src })).toEqual({ "5-6": "remove" });
  });
});
