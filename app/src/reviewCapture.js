// Review-interaction capture - pure logic (no React, no DOM, no IPC, no fs). Turns
// one episode's gate interaction into a self-describing record: the frozen detector
// proposal, the final committed cut-set, and a per-sentence provenance table joining
// the two. A downstream notebook reads these to learn where the detector over- or
// under-cut versus what the user kept.
//
// CARDINAL RULE. This module cannot change a cut - it only DESCRIBES the committed
// cut-set. `collapsedRanges` is computed by the SAME `selectedToRanges(lines,
// finalSelected)` the gate sends to `trim.setCuts`. The caller MUST build the
// snapshot from the SAME `sentenceLines({segments})` the gate collapses (see
// snapshotInitial); given that, the record can only describe the cut-set committed.
//
// PURITY. Pure and synchronous throughout. captureId, timestamps, appVersion etc. are
// CALLER-SUPPLIED via meta/behavioural, not generated here - that is what makes the
// record unit-testable with fixed inputs.

import {
  preselectFromCuts, heldLines, selectableCuts, lineInCuts, selectedToRanges,
} from "./transcriptToggle.js";

// Bumped when the record SHAPE changes; distinct from SPLITTER_VERSION, which
// attributes a change in how sentences are derived from segments.
export const SCHEMA_VERSION = 1;
export const SPLITTER_VERSION = 1;

// Deep clone via JSON so the snapshot and record own plain, frozen data and cannot be
// mutated through a caller-held reference. Inputs here are small JSON-shaped objects
// (segments, cuts, lines), so JSON round-trip is the simplest correct copy.
function clone(value) {
  return value === undefined ? null : JSON.parse(JSON.stringify(value));
}

function deepFreeze(obj) {
  if (obj && typeof obj === "object" && !Object.isFrozen(obj)) {
    Object.freeze(obj);
    for (const k of Object.keys(obj)) deepFreeze(obj[k]);
  }
  return obj;
}

// FNV-1a 32-bit over a string -> 8-char hex. A LOCAL DEDUPE KEY, not a security hash:
// node:crypto/crypto.subtle are async / awkward in renderer-side ESM under jsdom, so a
// tiny deterministic string hash is the right tool.
function fnv1a(str) {
  let h = 0x811c9dc5;
  for (let i = 0; i < str.length; i++) {
    h ^= str.charCodeAt(i);
    h = (h + ((h << 1) + (h << 4) + (h << 7) + (h << 8) + (h << 24))) >>> 0;
  }
  return (h >>> 0).toString(16).padStart(8, "0");
}

// Canonical JSON: object keys sorted recursively, so two semantically-equal values
// serialize identically regardless of key insertion order (e.g. a reason object
// { kind, score } vs { score, kind }). Without this, the dedupe key could differ for
// equal proposals. Arrays keep order (it is meaningful); primitives pass through.
function canonical(value) {
  if (Array.isArray(value)) return value.map(canonical);
  if (value && typeof value === "object") {
    const out = {};
    for (const k of Object.keys(value).sort()) out[k] = canonical(value[k]);
    return out;
  }
  return value;
}

// Hash an explicitly-ordered array projection. The caller passes the fields in array
// form (order meaningful); canonical() then stabilises any nested object key order.
function hashTuple(parts) {
  return fnv1a(JSON.stringify(canonical(parts)));
}

// Hash the transcript the user reviewed: the emitted per-sentence projection (index,
// times, text, speaker), so any change to a sentence's words, placement, or speaker
// flips the key. Mirrors the `transcript.lines` the record stores.
export function hashTranscript(lines) {
  const rows = Array.isArray(lines)
    ? lines.map((l) => [l.index, l.startSec, l.endSec, l.text, l.speaker ?? null])
    : [];
  return hashTuple(["t", SPLITTER_VERSION, rows]);
}

// Hash the detector proposal: the emitted projection (identity, boundary, label,
// reasons, flag, quotes), so any meaningful change flips the key. Takes the already-
// projected proposal rows the record stores, so the key never disagrees with them.
export function hashProposal(proposal) {
  const rows = Array.isArray(proposal)
    ? proposal.map((c) => [c.cutId, c.startSec, c.endSec, c.label, c.reasons, c.needsReview, c.firstLineQuote, c.lastLineQuote])
    : [];
  return hashTuple(["p", rows]);
}

// The cutIds whose range contains a line's midpoint, in cut order - same midpoint test
// the toggle logic uses (lineInCuts). Only selectable cuts are passed in, so a
// malformed cut never attributes a line.
function sourceCutIdsFor(line, cuts) {
  const out = [];
  for (const c of cuts) {
    if (lineInCuts(line, [c])) out.push(c.cutId ?? null);
  }
  return out;
}

// Project one selectable cut into the stored proposal row shape. clone() deep-copies
// every field, so no caller-owned reference (including nested values inside reasons or
// the quote fields) survives into the snapshot/record - the projected row is fully
// detached and safe to freeze. reasons defaults to [] and missing fields to null.
function projectCut(c) {
  return clone({
    cutId: c.cutId ?? null,
    startSec: c.startSec,
    endSec: c.endSec,
    label: c.label ?? null,
    reasons: Array.isArray(c.reasons) ? c.reasons : [],
    needsReview: c.needsReview === true,
    firstLineQuote: c.firstLineQuote ?? null,
    lastLineQuote: c.lastLineQuote ?? null,
  });
}

// Freeze the initial state the moment the gate opens. preselect (confident-only) and
// held (needsReview) are computed HERE, once, from the SAME filtered cut table, so the
// snapshot is the single source of truth and cannot disagree with the surface. Returns
// frozen, JSON-cloned data: the lines, the projected proposal, and the two index sets
// as sorted arrays. `lines` MUST be the same sentenceLines({segments}) the gate
// collapses at Continue - that is what ties the record to the committed cut-set.
export function snapshotInitial({ lines, cuts }) {
  const ls = clone(Array.isArray(lines) ? lines : []);
  const trimEntry = { cuts: selectableCuts({ cuts: Array.isArray(cuts) ? cuts : [] }) };
  const preselect = preselectFromCuts(ls, trimEntry);
  const held = heldLines(ls, trimEntry);
  return deepFreeze({
    lines: ls,
    cuts: trimEntry.cuts.map(projectCut),
    preselect: [...preselect].sort((a, b) => a - b),
    held: [...held].sort((a, b) => a - b),
  });
}

function initialStateFor(index, preselect, held) {
  if (preselect.has(index)) return "cut_confident"; // confident wins over held
  if (held.has(index)) return "cut_held";
  return "kept";
}

// Per-sentence provenance table: one row per line, joining the frozen initial state to
// the final committed state. finalSelected is the SAME Set the gate collapses, so
// finalState matches exactly what is cut.
function buildTable(snapshot, finalSelected) {
  const preselect = new Set(snapshot.preselect);
  const held = new Set(snapshot.held);
  return snapshot.lines.map((line) => ({
    index: line.index,
    time: line.time,
    text: line.text,
    speaker: line.speaker ?? null,
    initialState: initialStateFor(line.index, preselect, held),
    finalState: finalSelected.has(line.index) ? "cut" : "kept",
    sourceCutIds: sourceCutIdsFor(line, snapshot.cuts),
  }));
}

// The four headline signals, each a sorted list of sentence indices - a notebook wants
// WHICH sentences (to look up text/quotes); a count is a trivial .length. Computed from
// the table, so they cannot drift from it.
function deriveSignals(table) {
  const pick = (pred) => table.filter(pred).map((r) => r.index).sort((a, b) => a - b);
  return {
    addedUnflagged: pick((r) => r.finalState === "cut" && r.initialState === "kept"),
    removedConfident: pick((r) => r.initialState === "cut_confident" && r.finalState === "kept"),
    heldAccepted: pick((r) => r.initialState === "cut_held" && r.finalState === "cut"),
    heldRejected: pick((r) => r.initialState === "cut_held" && r.finalState === "kept"),
  };
}

// Assemble the full record. Everything that describes the cut-set is derived from the
// FROZEN snapshot (lines + projected cuts), never from the live `cuts` argument, so the
// proposal, hashes, table, and collapsedRanges can never describe a different proposal
// than the one snapshotted. `transcript` is stored raw (cloned) so a future splitter
// change is attributable to its input. finalSelected MUST be a Set - the gate always
// has one; a non-Set is a caller bug we surface, not silently treat as "cut nothing".
export function buildReviewRecord({ initialSnapshot, finalSelected, transcript, meta = {}, behavioural = {} }) {
  if (!(finalSelected instanceof Set)) {
    throw new TypeError("buildReviewRecord: finalSelected must be a Set (the same one the gate sends to trim.setCuts)");
  }
  const lines = initialSnapshot.lines;
  const table = buildTable(initialSnapshot, finalSelected);
  const signals = deriveSignals(table);
  const proposal = initialSnapshot.cuts.map(projectCut);

  return {
    schemaVersion: SCHEMA_VERSION,
    splitterVersion: SPLITTER_VERSION,

    captureId: meta.captureId ?? null,
    uuid: meta.uuid ?? null,
    title: meta.title ?? null,
    showId: meta.showId ?? null,
    enclosureUrl: meta.enclosureUrl ?? null,
    appVersion: meta.appVersion ?? null,
    detector: {
      model: meta.model ?? null,
      mode: meta.mode ?? null,
      thresholds: clone(meta.thresholds),
    },
    transcriptHash: hashTranscript(lines),
    detectorProposalHash: hashProposal(proposal),

    transcript: {
      segments: clone((transcript && Array.isArray(transcript.segments)) ? transcript.segments
        : (Array.isArray(transcript) ? transcript : [])),
      lines: lines.map((l) => ({
        index: l.index, startSec: l.startSec, endSec: l.endSec, text: l.text, speaker: l.speaker ?? null, time: l.time,
      })),
    },

    proposal,

    // Final accepted state EXACTLY as committed: the selected indices, and the ranges
    // from the SAME selectedToRanges(lines, finalSelected) the gate sends.
    finalSelected: [...finalSelected].sort((a, b) => a - b),
    collapsedRanges: selectedToRanges(lines, finalSelected),

    table,
    signals,

    behavioural: {
      openedAt: behavioural.openedAt ?? null,
      committedAt: behavioural.committedAt ?? null,
      openDurationMs: behavioural.openDurationMs ?? null,
      edited: behavioural.edited ?? null,
      toggleCount: behavioural.toggleCount ?? null,
    },
  };
}

// Build the array of review records for every OPENED episode, from frozen gate state.
// Pure: every side-effecting value (captureId, committedAt) is injected, so the same
// inputs always produce the same records and the unit tests are deterministic. Only
// uuids in `reviewedUuids` (the ones the user opened) contribute - a never-opened
// episode is absent. `finalSelected` per uuid MUST be the SAME Set the gate sends to
// trim.setCuts (buildReviewRecord throws on a non-Set), so collapsedRanges describes
// exactly the committed cut-set.
//
//   items          the gate's review items ({ uuid, title, segments, ... }).
//   reviewedUuids  Set<uuid> of episodes the user opened (built records only for these).
//   snapshots      uuid -> frozen snapshotInitial({lines,cuts}), taken at first open.
//   finalSelected  uuid -> Set<number> of selected indices (== what the gate committed).
//   openedAt       uuid -> ms timestamp of first open (for openDurationMs).
//   toggleCounts   uuid -> number of toggles (drives edited + toggleCount).
//   committedAt    ms timestamp stamped now (one value for the whole batch).
//   makeCaptureId  () => string, injected (parent passes crypto.randomUUID).
//   metaFor        optional uuid -> extra meta (showId/model/etc.) merged per record.
export function buildCaptureRecords({
  items = [], reviewedUuids, snapshots = {}, finalSelected = {},
  openedAt = {}, toggleCounts = {}, committedAt = null, makeCaptureId, metaFor,
}) {
  const opened = reviewedUuids instanceof Set ? reviewedUuids : new Set(reviewedUuids || []);
  const records = [];
  for (const item of items) {
    const uuid = item && item.uuid;
    if (!uuid || !opened.has(uuid)) continue;
    const snapshot = snapshots[uuid];
    if (!snapshot) continue; // opened but never snapshotted - nothing to describe
    const sel = finalSelected[uuid];
    const openMs = openedAt[uuid] ?? null;
    const toggles = toggleCounts[uuid] ?? 0;
    const extraMeta = (typeof metaFor === "function" ? metaFor(uuid) : null) || {};
    records.push(buildReviewRecord({
      initialSnapshot: snapshot,
      finalSelected: sel,
      transcript: { segments: item.segments || [] },
      meta: {
        captureId: typeof makeCaptureId === "function" ? makeCaptureId() : null,
        uuid,
        title: item.title ?? null,
        ...extraMeta,
      },
      behavioural: {
        openedAt: openMs,
        committedAt,
        openDurationMs: (openMs != null && committedAt != null) ? committedAt - openMs : null,
        edited: toggles > 0,
        toggleCount: toggles,
      },
    }));
  }
  return records;
}
