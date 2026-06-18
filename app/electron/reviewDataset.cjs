const fsp = require("node:fs/promises");
const path = require("node:path");
const { logEvent } = require("./logger.cjs");

// Review-dataset persistence (slice 3) - the main-process WRITE EDGE for the
// renderer-side review-capture model (src/reviewCapture.js). The renderer sends one
// record per gate interaction over the `review:capture` IPC; this module validates the
// UNTRUSTED payload at the trust boundary and appends the survivors as NDJSON to a
// single local dataset file under userData.
//
// CARDINAL RULE (trim): this module NEVER touches the cut/commit path - it only appends
// a learning dataset. So it is BEST-EFFORT: every public path catches and returns a
// result object and NEVER throws upward, so a capture failure can never surface as a
// transfer error or block a sync. Conventions mirror decisionCache.cjs.
//
// TRUST BOUNDARY, not re-validation. We validate only enough to avoid an unsafe write
// or a corrupt NDJSON line: schemaVersion must match; cut/range times must be finite;
// table indexes must be non-negative and strictly increasing; unknown TOP-LEVEL keys
// are STRIPPED. We do NOT deeply re-validate nested fields (the renderer already built
// the record) - bulk inside an allowed container is bounded by the per-record byte cap,
// not by deep inspection.

// MUST track src/reviewCapture.js's SCHEMA_VERSION. That module is ESM and this is CJS,
// so we hold the expected value here rather than import across the boundary.
const EXPECTED_SCHEMA_VERSION = 1;

// Whole-batch cap: one capture call carries one episode's record(s). A larger payload
// is malformed/hostile and rejected whole.
const MAX_BATCH = 64;

// Per-record cap. A long ad-heavy episode's record stores the transcript text roughly
// three times (raw transcript.segments, derived transcript.lines, the per-sentence
// table), and those long episodes are exactly the records the dataset exists to capture,
// so 4 MB leaves real headroom while still bounding a single hostile record. An
// over-size record is SKIPPED (counted + logged), not thrown.
const MAX_RECORD_BYTES = 4 * 1024 * 1024;

// Total cap across one append, a sane backstop so a full batch cannot buffer an
// unbounded amount before the single write. 32 MB is generous headroom for a full batch
// of long records. Records that would push the running total over this are SKIPPED
// (counted + logged), not thrown.
const MAX_TOTAL_BYTES = 32 * 1024 * 1024;

// Known top-level keys of a review record (src/reviewCapture.js buildReviewRecord).
// Anything outside this set is stripped, so a hostile renderer cannot persist arbitrary
// top-level fields (e.g. "__proto__").
const KNOWN_KEYS = [
  "schemaVersion", "splitterVersion", "captureId", "uuid", "title", "showId",
  "enclosureUrl", "appVersion", "detector", "transcriptHash", "detectorProposalHash",
  "transcript", "proposal", "finalSelected", "collapsedRanges", "table", "signals",
  "behavioural",
];

const DATASET_DIR = "review-dataset";
const DATASET_FILE = "reviews.jsonl";

// Lazily resolve the Electron userData dir. Wrapped in try so this module loads under
// Vitest with no Electron runtime (tests inject `baseDir` instead). Null when absent.
function defaultBaseDir() {
  try {
    return require("electron").app.getPath("userData");
  } catch {
    return null;
  }
}

function isFiniteNumber(v) {
  return typeof v === "number" && Number.isFinite(v);
}

// Validate one record at the trust boundary. Returns the STRIPPED record (known top-
// level keys only) on pass, or null on fail. Shallow by design: it prevents an
// unsafe/corrupt write, it does not re-prove the cuts.
function validateRecord(record) {
  if (!record || typeof record !== "object" || Array.isArray(record)) return null;
  if (record.schemaVersion !== EXPECTED_SCHEMA_VERSION) return null;

  if (record.proposal != null) {
    if (!Array.isArray(record.proposal)) return null;
    for (const cut of record.proposal) {
      if (!cut || typeof cut !== "object") return null;
      if (!isFiniteNumber(cut.startSec) || !isFiniteNumber(cut.endSec)) return null;
    }
  }

  if (record.collapsedRanges != null) {
    if (!Array.isArray(record.collapsedRanges)) return null;
    for (const r of record.collapsedRanges) {
      if (!r || typeof r !== "object") return null;
      if (!isFiniteNumber(r.startSec) || !isFiniteNumber(r.endSec)) return null;
    }
  }

  // Table indexes must be non-negative integers, strictly increasing - a notebook joins
  // on index, so a duplicate/out-of-order index is corrupt data.
  if (record.table != null) {
    if (!Array.isArray(record.table)) return null;
    let prev = -1;
    for (const row of record.table) {
      if (!row || typeof row !== "object") return null;
      const idx = row.index;
      if (!Number.isInteger(idx) || idx < 0 || idx <= prev) return null;
      prev = idx;
    }
  }

  const clean = {};
  for (const key of KNOWN_KEYS) {
    if (Object.prototype.hasOwnProperty.call(record, key)) clean[key] = record[key];
  }
  return clean;
}

// Serialize a validated record to one NDJSON line, enforcing the per-record byte cap.
// Returns the line (with trailing newline) or null if it is too large or unstringifiable
// (e.g. a circular ref a hostile payload slipped in).
function serializeRecord(clean) {
  let line;
  try {
    line = JSON.stringify(clean);
  } catch {
    return null;
  }
  if (typeof line !== "string") return null;
  if (Buffer.byteLength(line, "utf8") > MAX_RECORD_BYTES) return null;
  return line + "\n";
}

// Reject a path that exists as a SYMLINK, so a pre-placed symlink under userData cannot
// redirect our chmod/append outside the fixed dataset path (fixed-path guarantee under
// local filesystem tampering). lstat does not follow the link. A non-existent path is
// fine (ENOENT -> not a symlink); any other lstat error is treated as unsafe.
async function isSymlink(p) {
  try {
    return (await fsp.lstat(p)).isSymbolicLink();
  } catch (e) {
    if (e && e.code === "ENOENT") return false;
    return true;
  }
}

// Serialize appends so two overlapping IPC captures cannot interleave their NDJSON
// lines in the dataset file. A single chained promise is enough here - captures are
// infrequent and the work is small - and it keeps every line intact.
let writeChain = Promise.resolve();

// Do the filesystem write for one already-validated, already-serialized batch. Returns
// a result object; the caller wraps it. Never throws (errors are caught).
async function writeLines(lines, root, skipped, total) {
  try {
    const dir = path.join(root, DATASET_DIR);
    const file = path.join(dir, DATASET_FILE);
    // Refuse to follow a symlinked dir or file - a fixed-path write must stay inside
    // userData/review-dataset.
    if (await isSymlink(dir) || await isSymlink(file)) {
      return { ok: false, written: 0, skipped, total, error: "symlink-rejected" };
    }
    // Owner-only dir and file (least privilege - the dataset holds transcript text).
    // mkdir/appendFile modes only apply on CREATE, so chmod both in case they
    // pre-existed with looser perms. The chmods are best-effort - a platform that
    // rejects POSIX perms (e.g. Windows) must not fail the write.
    await fsp.mkdir(dir, { recursive: true, mode: 0o700 });
    try { await fsp.chmod(dir, 0o700); } catch {}
    await fsp.appendFile(file, lines.join(""), { encoding: "utf8", mode: 0o600 });
    try { await fsp.chmod(file, 0o600); } catch {}
    return { ok: true, written: lines.length, skipped, total };
  } catch (e) {
    return { ok: false, written: 0, skipped, total, error: e && e.code ? e.code : "fs-error" };
  }
}

// Append review records as NDJSON. Best-effort: returns a result object, never throws.
//
//   appendRecords(records, options = {}) -> Promise<{ ok, written, skipped, total, error? }>
//
// options.baseDir defaults to the Electron userData dir. It is a MAIN-PROCESS-ONLY test
// seam; the IPC handler calls appendRecords(records) with no options, so the renderer
// can never supply a path and the fixed-path guarantee holds. `options` is read
// defensively (a malformed value yields no baseDir) so a bad call can never throw.
//
// Batch rule: a non-array, or a batch over MAX_BATCH, is rejected WHOLE (writes
// nothing). A single record that fails validation, exceeds MAX_RECORD_BYTES, or would
// push the append over MAX_TOTAL_BYTES is SKIPPED (counted). On error we report counts /
// error codes only, never transcript text.
async function appendRecords(records, options) {
  const baseDir = options && typeof options === "object" ? options.baseDir : undefined;
  if (!Array.isArray(records)) {
    return { ok: false, written: 0, skipped: 0, total: 0, error: "not-an-array" };
  }
  if (records.length > MAX_BATCH) {
    return { ok: false, written: 0, skipped: 0, total: records.length, error: "batch-too-large" };
  }

  const total = records.length;
  const lines = [];
  // Skip counts BY REASON so a skip is visible, not silent. We log only these counts
  // and reason codes - never any record/transcript text.
  let invalid = 0;   // failed trust-boundary validation
  let oversize = 0;  // valid but over MAX_RECORD_BYTES (or unstringifiable)
  let overTotal = 0; // would push the append over MAX_TOTAL_BYTES
  let runningBytes = 0;
  for (const record of records) {
    const clean = validateRecord(record);
    if (!clean) { invalid += 1; continue; }
    const line = serializeRecord(clean);
    if (!line) { oversize += 1; continue; }
    const bytes = Buffer.byteLength(line, "utf8");
    if (runningBytes + bytes > MAX_TOTAL_BYTES) { overTotal += 1; continue; }
    runningBytes += bytes;
    lines.push(line);
  }
  const skipped = invalid + oversize + overTotal;
  if (skipped > 0) {
    logEvent("review-capture-skip", `skipped=${skipped} invalid=${invalid} oversize=${oversize} overTotal=${overTotal} total=${total}`);
  }

  // Nothing survived - a successful no-op. Touch no dir/file for an all-bad batch.
  if (lines.length === 0) {
    return { ok: true, written: 0, skipped, total };
  }

  const root = baseDir != null ? baseDir : defaultBaseDir();
  if (root == null) return { ok: false, written: 0, skipped, total, error: "no-user-data-dir" };

  // Chain behind any in-flight write so concurrent captures cannot interleave lines.
  // A failed write must not poison the chain, so the link always resolves.
  const result = writeChain.then(() => writeLines(lines, root, skipped, total));
  writeChain = result.then(() => {}, () => {});
  return result;
}

module.exports = {
  appendRecords,
  validateRecord,
  EXPECTED_SCHEMA_VERSION,
  MAX_BATCH,
  MAX_RECORD_BYTES,
  MAX_TOTAL_BYTES,
};
