import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { createRequire } from "node:module";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";

const require = createRequire(import.meta.url);
const {
  appendRecords, validateRecord, EXPECTED_SCHEMA_VERSION, MAX_BATCH, MAX_RECORD_BYTES, MAX_TOTAL_BYTES,
} = require("./reviewDataset.cjs");

function mkTmp(label = "os-revds-") { return fs.mkdtempSync(path.join(os.tmpdir(), label)); }
function rmTmp(d) { try { fs.rmSync(d, { recursive: true, force: true }); } catch {} }

const DATASET = path.join("review-dataset", "reviews.jsonl");

// A minimal but SHAPE-FAITHFUL valid record (mirrors src/reviewCapture.js
// buildReviewRecord output). `over` lets a test override / add fields.
function validRecord(over = {}) {
  return {
    schemaVersion: EXPECTED_SCHEMA_VERSION,
    splitterVersion: 1,
    captureId: "cap-1",
    uuid: "ep-1",
    title: "An Episode",
    showId: "show-1",
    enclosureUrl: "https://example.com/ep.mp3",
    appVersion: "1.0.0",
    detector: { model: "m", mode: "gepa", thresholds: null },
    transcriptHash: "aabbccdd",
    detectorProposalHash: "11223344",
    transcript: { segments: [], lines: [{ index: 0, startSec: 0, endSec: 1, text: "hi", speaker: null, time: "0:00" }] },
    proposal: [{ cutId: "c1", startSec: 600, endSec: 700, label: "ad", reasons: [], needsReview: false, firstLineQuote: null, lastLineQuote: null }],
    finalSelected: [3, 4],
    collapsedRanges: [{ startSec: 600, endSec: 660 }],
    table: [
      { index: 0, time: "0:00", text: "hi", speaker: null, initialState: "kept", finalState: "kept", sourceCutIds: [] },
      { index: 1, time: "0:01", text: "there", speaker: null, initialState: "kept", finalState: "kept", sourceCutIds: [] },
    ],
    signals: { addedUnflagged: [], removedConfident: [], heldAccepted: [], heldRejected: [] },
    behavioural: { openedAt: null, committedAt: null, openDurationMs: null, edited: null, toggleCount: null },
    ...over,
  };
}

function readLines(baseDir) {
  const raw = fs.readFileSync(path.join(baseDir, DATASET), "utf8");
  return raw.split("\n").filter((l) => l.length > 0).map((l) => JSON.parse(l));
}

describe("validateRecord (trust boundary)", () => {
  it("accepts a well-formed record and strips unknown top-level keys", () => {
    const rec = validRecord({ evil: "x", __proto__nope: 1, anotherJunk: { big: "blob" } });
    const clean = validateRecord(rec);
    expect(clean).not.toBe(null);
    expect(clean).not.toHaveProperty("evil");
    expect(clean).not.toHaveProperty("anotherJunk");
    // Known keys survive.
    expect(clean.uuid).toBe("ep-1");
    expect(clean.proposal).toHaveLength(1);
  });

  it("rejects a wrong schemaVersion", () => {
    expect(validateRecord(validRecord({ schemaVersion: 999 }))).toBe(null);
    expect(validateRecord(validRecord({ schemaVersion: "1" }))).toBe(null);
  });

  it("rejects non-finite cut times", () => {
    expect(validateRecord(validRecord({ proposal: [{ cutId: "c", startSec: Number.NaN, endSec: 1, reasons: [] }] }))).toBe(null);
    expect(validateRecord(validRecord({ proposal: [{ cutId: "c", startSec: 1, endSec: Infinity, reasons: [] }] }))).toBe(null);
    expect(validateRecord(validRecord({ proposal: [{ cutId: "c", startSec: "0", endSec: 1, reasons: [] }] }))).toBe(null);
  });

  it("rejects non-finite collapsedRanges times", () => {
    expect(validateRecord(validRecord({ collapsedRanges: [{ startSec: 1, endSec: Number.NaN }] }))).toBe(null);
  });

  it("rejects a non-monotonic or negative table index", () => {
    expect(validateRecord(validRecord({ table: [{ index: 0 }, { index: 0 }] }))).toBe(null); // duplicate
    expect(validateRecord(validRecord({ table: [{ index: 2 }, { index: 1 }] }))).toBe(null); // decreasing
    expect(validateRecord(validRecord({ table: [{ index: -1 }] }))).toBe(null);              // negative
    expect(validateRecord(validRecord({ table: [{ index: 1.5 }] }))).toBe(null);             // non-integer
  });

  it("rejects a non-object / array record", () => {
    expect(validateRecord(null)).toBe(null);
    expect(validateRecord([])).toBe(null);
    expect(validateRecord("x")).toBe(null);
  });
});

describe("appendRecords (write edge, best-effort NDJSON)", () => {
  let baseDir;
  beforeEach(() => { baseDir = mkTmp(); });
  afterEach(() => rmTmp(baseDir));

  it("appends valid records as NDJSON (one JSON object per line), creating the dir", async () => {
    const res = await appendRecords([validRecord({ uuid: "a" }), validRecord({ uuid: "b" })], { baseDir });
    expect(res).toMatchObject({ ok: true, written: 2, skipped: 0, total: 2 });
    const lines = readLines(baseDir);
    expect(lines).toHaveLength(2);
    expect(lines.map((l) => l.uuid)).toEqual(["a", "b"]);
  });

  it("creates the review-dataset dir if missing", async () => {
    expect(fs.existsSync(path.join(baseDir, "review-dataset"))).toBe(false);
    await appendRecords([validRecord()], { baseDir });
    expect(fs.existsSync(path.join(baseDir, "review-dataset"))).toBe(true);
  });

  it("appends (not overwrites) across calls", async () => {
    await appendRecords([validRecord({ uuid: "a" })], { baseDir });
    await appendRecords([validRecord({ uuid: "b" })], { baseDir });
    expect(readLines(baseDir).map((l) => l.uuid)).toEqual(["a", "b"]);
  });

  it("strips unknown top-level fields before persisting", async () => {
    await appendRecords([validRecord({ secretBlob: "should-not-persist" })], { baseDir });
    const [line] = readLines(baseDir);
    expect(line).not.toHaveProperty("secretBlob");
    expect(line.uuid).toBe("ep-1");
  });

  it("REJECTS THE WHOLE PAYLOAD for a non-array input (writes nothing)", async () => {
    const res = await appendRecords({ not: "an array" }, { baseDir });
    expect(res.ok).toBe(false);
    expect(res.written).toBe(0);
    expect(fs.existsSync(path.join(baseDir, "review-dataset"))).toBe(false);
  });

  it("REJECTS THE WHOLE PAYLOAD for an over-max-batch input (writes nothing)", async () => {
    const big = Array.from({ length: MAX_BATCH + 1 }, (_, i) => validRecord({ uuid: `e${i}` }));
    const res = await appendRecords(big, { baseDir });
    expect(res.ok).toBe(false);
    expect(res.written).toBe(0);
    expect(res.error).toBe("batch-too-large");
    // Not even the dir is touched - nothing was written.
    expect(fs.existsSync(path.join(baseDir, "review-dataset"))).toBe(false);
  });

  it("accepts a batch at exactly MAX_BATCH", async () => {
    const exact = Array.from({ length: MAX_BATCH }, (_, i) => validRecord({ uuid: `e${i}` }));
    const res = await appendRecords(exact, { baseDir });
    expect(res).toMatchObject({ ok: true, written: MAX_BATCH, skipped: 0 });
  });

  it("SKIPS ONLY THE BAD record on a per-record validation failure - valid records still append", async () => {
    const records = [
      validRecord({ uuid: "good-1" }),
      validRecord({ uuid: "bad", schemaVersion: 999 }), // invalid -> skipped
      validRecord({ uuid: "good-2" }),
    ];
    const res = await appendRecords(records, { baseDir });
    expect(res).toMatchObject({ ok: true, written: 2, skipped: 1, total: 3 });
    expect(readLines(baseDir).map((l) => l.uuid)).toEqual(["good-1", "good-2"]);
  });

  it("SKIPS ONLY an over-size record (over MAX_RECORD_BYTES) - valid records still append", async () => {
    // A title big enough to push the serialized record past the per-record cap.
    const huge = validRecord({ uuid: "huge", title: "x".repeat(MAX_RECORD_BYTES + 1) });
    const res = await appendRecords([validRecord({ uuid: "ok" }), huge], { baseDir });
    expect(res).toMatchObject({ ok: true, written: 1, skipped: 1, total: 2 });
    expect(readLines(baseDir).map((l) => l.uuid)).toEqual(["ok"]);
  });

  it("LOGS an over-size skip with counts + reason only, never transcript text", async () => {
    // OSW_LOG makes logger.cjs write; without it the log call is a no-op.
    const logFile = path.join(baseDir, "diag.log");
    const prev = process.env.OSW_LOG;
    process.env.OSW_LOG = logFile;
    try {
      const secret = "SECRET_TRANSCRIPT_WORDS_XYZZY";
      const huge = validRecord({ uuid: "huge", title: secret + "x".repeat(MAX_RECORD_BYTES + 1) });
      const res = await appendRecords([validRecord({ uuid: "ok" }), huge], { baseDir });
      expect(res).toMatchObject({ ok: true, written: 1, skipped: 1, total: 2 });
      const log = fs.readFileSync(logFile, "utf8");
      // The skip is visible: count + reason code present.
      expect(log).toContain("review-capture-skip");
      expect(log).toContain("skipped=1");
      expect(log).toContain("oversize=1");
      // No transcript/record text leaked into the diagnostics log.
      expect(log).not.toContain(secret);
    } finally {
      if (prev === undefined) delete process.env.OSW_LOG; else process.env.OSW_LOG = prev;
    }
  });

  it("does NOT log when nothing is skipped (no noise on a clean batch)", async () => {
    const logFile = path.join(baseDir, "diag2.log");
    const prev = process.env.OSW_LOG;
    process.env.OSW_LOG = logFile;
    try {
      await appendRecords([validRecord({ uuid: "a" }), validRecord({ uuid: "b" })], { baseDir });
      expect(fs.existsSync(logFile)).toBe(false);
    } finally {
      if (prev === undefined) delete process.env.OSW_LOG; else process.env.OSW_LOG = prev;
    }
  });

  it("SKIPS records that would push the append over MAX_TOTAL_BYTES (running cap)", async () => {
    // Each record is just under half the per-record cap, so two fit but the cumulative
    // total cap stops the batch well before MAX_BATCH * MAX_RECORD_BYTES.
    const each = Math.floor(MAX_RECORD_BYTES / 2);
    const n = Math.ceil(MAX_TOTAL_BYTES / each) + 4;
    const records = Array.from({ length: Math.min(n, MAX_BATCH) }, (_, i) =>
      validRecord({ uuid: `e${i}`, title: "x".repeat(each) }));
    const res = await appendRecords(records, { baseDir });
    expect(res.ok).toBe(true);
    expect(res.skipped).toBeGreaterThan(0);
    // What was written stays within the total cap.
    const bytes = fs.statSync(path.join(baseDir, DATASET)).size;
    expect(bytes).toBeLessThanOrEqual(MAX_TOTAL_BYTES);
  });

  it("creates the dataset dir 0o700 and the file 0o600 (least privilege)", async () => {
    if (process.platform === "win32") return; // POSIX perms only
    await appendRecords([validRecord()], { baseDir });
    const dirMode = fs.statSync(path.join(baseDir, "review-dataset")).mode & 0o777;
    const fileMode = fs.statSync(path.join(baseDir, DATASET)).mode & 0o777;
    expect(dirMode).toBe(0o700);
    expect(fileMode).toBe(0o600);
  });

  it("tightens an EXISTING permissive dir to 0o700 (chmod, not just mkdir-on-create)", async () => {
    if (process.platform === "win32") return;
    const dir = path.join(baseDir, "review-dataset");
    fs.mkdirSync(dir, { mode: 0o755 });
    fs.chmodSync(dir, 0o755); // ensure loose perms despite umask
    await appendRecords([validRecord()], { baseDir });
    expect(fs.statSync(dir).mode & 0o777).toBe(0o700);
  });

  it("tightens an EXISTING permissive FILE to 0o600 (chmod existing, not just on create)", async () => {
    if (process.platform === "win32") return;
    const dir = path.join(baseDir, "review-dataset");
    fs.mkdirSync(dir, { recursive: true });
    const file = path.join(dir, "reviews.jsonl");
    fs.writeFileSync(file, "");
    fs.chmodSync(file, 0o644); // loose perms despite mode-on-create
    await appendRecords([validRecord()], { baseDir });
    expect(fs.statSync(file).mode & 0o777).toBe(0o600);
  });

  it("REJECTS a symlinked dataset dir (fixed-path guarantee under fs tampering)", async () => {
    if (process.platform === "win32") return;
    const outside = path.join(baseDir, "outside");
    fs.mkdirSync(outside);
    fs.symlinkSync(outside, path.join(baseDir, "review-dataset"));
    const res = await appendRecords([validRecord()], { baseDir });
    expect(res.ok).toBe(false);
    expect(res.error).toBe("symlink-rejected");
    // Nothing was written through the symlink.
    expect(fs.existsSync(path.join(outside, "reviews.jsonl"))).toBe(false);
  });

  it("REJECTS a symlinked dataset FILE (no follow)", async () => {
    if (process.platform === "win32") return;
    const dir = path.join(baseDir, "review-dataset");
    fs.mkdirSync(dir, { recursive: true });
    const target = path.join(baseDir, "evil-target.jsonl");
    fs.symlinkSync(target, path.join(dir, "reviews.jsonl"));
    const res = await appendRecords([validRecord()], { baseDir });
    expect(res.ok).toBe(false);
    expect(res.error).toBe("symlink-rejected");
    expect(fs.existsSync(target)).toBe(false);
  });

  it("serializes concurrent appends so no NDJSON line is interleaved/corrupted", async () => {
    // Fire many overlapping appends; every line must still parse and all must land.
    const batches = Array.from({ length: 12 }, (_, i) =>
      appendRecords([validRecord({ uuid: `c${i}` }), validRecord({ uuid: `c${i}-b` })], { baseDir }));
    const results = await Promise.all(batches);
    expect(results.every((r) => r.ok && r.written === 2)).toBe(true);
    const lines = readLines(baseDir); // throws if any line is corrupt JSON
    expect(lines).toHaveLength(24);
  });

  it("returns { ok:false } (never throws) when no userData dir is available", async () => {
    // baseDir null AND no Electron app -> path resolution must not throw upward.
    const res = await appendRecords([validRecord()], { baseDir: null });
    expect(res.ok).toBe(false);
    expect(res.error).toBe("no-user-data-dir");
  });

  it("does not throw on a malformed options argument (null / non-object)", async () => {
    // appendRecords(records, null) must not throw on options destructuring.
    await expect(appendRecords({ not: "array" }, null)).resolves.toMatchObject({ ok: false });
    await expect(appendRecords([validRecord()], null)).resolves.toBeTruthy();
    await expect(appendRecords([validRecord()], 42)).resolves.toBeTruthy();
  });

  it("an all-bad batch is a successful no-op (ok:true, written:0) and touches no file", async () => {
    const res = await appendRecords([validRecord({ schemaVersion: 7 })], { baseDir });
    expect(res).toMatchObject({ ok: true, written: 0, skipped: 1, total: 1 });
    expect(fs.existsSync(path.join(baseDir, "review-dataset"))).toBe(false);
  });

  it("an fs error returns { ok:false } rather than throwing", async () => {
    // Point baseDir at a FILE so mkdir of a child dir fails with ENOTDIR.
    const fileAsBase = path.join(baseDir, "iamafile");
    fs.writeFileSync(fileAsBase, "x");
    const res = await appendRecords([validRecord()], { baseDir: fileAsBase });
    expect(res.ok).toBe(false);
    expect(res.written).toBe(0);
    // Error is an fs code / sentinel, never transcript text.
    expect(typeof res.error).toBe("string");
  });

  it("never leaks transcript text on an fs-error path", async () => {
    const secret = "SUPER_SECRET_TRANSCRIPT_LINE_42";
    const fileAsBase = path.join(baseDir, "iamafile");
    fs.writeFileSync(fileAsBase, "x");
    const rec = validRecord();
    rec.transcript.lines[0].text = secret;
    const res = await appendRecords([rec], { baseDir: fileAsBase });
    expect(res.ok).toBe(false);
    expect(JSON.stringify(res)).not.toContain(secret);
  });

  it("never throws upward - a thoroughly malformed payload still resolves to a result object", async () => {
    await expect(appendRecords(undefined, { baseDir })).resolves.toMatchObject({ ok: false });
    await expect(appendRecords([null, 5, "x"], { baseDir })).resolves.toMatchObject({ ok: true, written: 0, skipped: 3 });
  });
});
