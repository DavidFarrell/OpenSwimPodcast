# Implementation plan - review-interaction dataset

**Date:** 2026-06-18
**Feature:** capture a local training dataset of David's manual ad-cut review edits.
**Status:** plan, pre-build. Converged with GPT-5 before handing to the build boss.

---

## 1. Why

When David reviews the detector's proposed ad-cuts and edits them - especially when he
**adds** a cut the detector missed entirely, or **removes** one the detector was confident
about - those edits are gold for improving the detector. We want to capture them as a local
dataset, but ONLY for episodes he genuinely reviewed.

**The interaction signal = he opened the episode's review panel.** Opening it (even with no
edit) is a deliberate "I looked at this and I'm happy" = a positive label. If he never opens
a panel (sends on trust / "YOLO"), we capture nothing for that episode.

## 2. What we capture, per reviewed episode

One NDJSON record per opened-and-committed episode:

- **Original transcript** - the raw pre-split segments AND the derived sentence lines
  (`index, startSec, endSec, text, speaker, time`), plus the splitter/interpolation schema
  version, so a future change to the sentence splitter is attributable.
- **Detector initial proposal** - each cut as `{ cutId, startSec, endSec, label, reasons,
  needsReview, firstLineQuote, lastLineQuote }`. `cutId` is stable; the quotes are the
  model's verbatim claimed boundaries.
- **Final accepted state** - the final selected sentence set and the collapsed ranges
  EXACTLY as sent to `trim.setCuts`.
- **Per-sentence provenance table** - one row per sentence:
  `{ index, time, text, speaker, initialState, finalState, sourceCutIds }` where
  `initialState ∈ {kept, cut_confident, cut_held}` and `finalState ∈ {kept, cut}`.
- **Derived headline signals** (computed from the table, stored for convenience):
  `addedUnflagged` (final=cut, initial=kept - human found a missed ad),
  `removedConfident` (initial=cut_confident, final=kept - detector false positive),
  `heldAccepted` (initial=cut_held, final=cut), `heldRejected` (initial=cut_held, final=kept).
- **Behavioural fields** (recorded, never gated on): `openedAt`, `committedAt`,
  `openDurationMs`, `edited` (bool), `toggleCount`.
- **Provenance / dedupe / versioning:** `captureId` (uuid), episode `uuid`, `title`, feed/show
  id + enclosure url if available, `transcriptHash`, `detectorProposalHash`, `appVersion`,
  `schemaVersion`, detector `model` / `mode` / sensitivity thresholds.

### Provenance classification (the one subtle rule)

For each sentence index `i`, against the FROZEN initial snapshot:
- `initialState` = `preselect.has(i) ? "cut_confident" : held.has(i) ? "cut_held" : "kept"`
  where `preselect = preselectFromCuts(lines, {cuts})` (confident-only seed) and
  `held = heldLines(lines, {cuts})` (needsReview cuts). If a line is in both, confident wins.
- `finalState` = `finalSelected.has(i) ? "cut" : "kept"`.
- `sourceCutIds` = the `cutId`s whose range contains the line's midpoint.

## 3. Behaviour change - everything starts collapsed

The "Review before sending" gate (`SyncScreen.jsx`) currently auto-opens a panel when it is
the only episode OR when it has held cuts. **Remove both auto-opens.** Every episode panel
starts collapsed; opening one is the clean deliberate signal.

**Acceptance criterion (do not regress the only remaining review cue):** a collapsed panel
with held cuts MUST still show the held-cut count on its `<summary>` AND keep the existing
"⚑ N flagged for review - jump to first" affordance reachable, without the panel auto-opening.
A test asserts the collapsed summary renders the held count. Removing the held cue while
removing the auto-open is a failure.

> Trade-off David has accepted: collapsing held-cut auto-open removes the safety nudge that
> pulled his eye to uncertain cuts. The collapsed summary text is now the only nudge - so it
> must stay.

## 4. Timing (cardinal-safe) - the load-bearing detail

In `continueReview()`:

1. **Build the immutable capture records FIRST**, from the current in-memory UI state
   (`reviewSelected`, the frozen initial snapshots, `review.items`), BEFORE any async side
   effect. (`resolveReview()` can clear/unmount the gate; assembling after it risks losing
   the state.) **This construction is itself wrapped in try/catch:** if record-building throws,
   commit exactly as today and skip capture - a capture-side bug must never block or fail-close
   the transfer.
2. Commit the cuts (`trim.setCuts` per episode) and `resolveReview()` exactly as today -
   unchanged, still fail-closed.
3. **Only after both succeed**, fire-and-forget `review.capture(records)` (best-effort,
   wrapped in try/catch). A capture failure must NEVER fail-close the transfer or surface as
   a transfer error.

Capture happens ONLY on a successful committed Continue. Cancel / abandon / a failed-closed
commit -> capture nothing. Records are built only for episode uuids in the
"opened-this-session" set.

## 5. Slices

Four slices, each its own branch, its own convergence loop, tests green before commit.

### Slice 1 - cut provenance (backend foundation)
`detectAds.cjs`: retain the verbatim boundary quotes on each emitted cut
(`firstLineQuote`/`lastLineQuote`) and add a stable `cutId`. Thread the new fields through
`sync.cjs` so `review.items[].cuts` carry them to the renderer.
- `cutId` derivation: deterministic from the cut's identity - a short hash of
  `startSec|endSec|label`, stable across re-runs of the same proposal, independent of array
  order. **Collision handling (two same-identity cuts in one episode):** append a
  deterministic suffix (e.g. `-2`, `-3`) assigned by a stable order (ascending startSec then
  endSec), NOT array position, so the same proposal always yields the same ids. A test
  exercises the collision path with two cuts sharing `startSec|endSec|label`.
- **Cardinal guard:** boundaries, `needsReview`, and which cuts are emitted are UNCHANGED.
  Only additive fields. A test locks that the existing cut-shape fields are untouched.
- Tests: cuts carry `cutId` + both quotes; `cutId` stable across two runs of the same input;
  collision path yields stable distinct ids; quotes equal the mapped segment text; no change
  to existing detect outputs.

### Slice 2 - capture model (pure logic, renderer-side, no React/DOM)
New `src/reviewCapture.js`. Pure functions:
- `snapshotInitial({ lines, cuts })` -> the frozen initial per-sentence provenance + the cut
  table (with cutId/quotes). It computes `preselect = preselectFromCuts(lines, {cuts})` and
  `held = heldLines(lines, {cuts})` INTERNALLY - it does NOT accept caller-supplied
  `preselect`/`held` (a single source of truth for provenance; no chance the snapshot disagrees
  with what the surface rendered).
- `buildReviewRecord({ initialSnapshot, finalSelected, transcript, cuts, meta, behavioural })`
  -> the full NDJSON record incl. the per-sentence table, derived signals, hashes,
  `schemaVersion`. It also includes `collapsedRanges = selectedToRanges(lines, finalSelected)`
  - the SAME function and the SAME `finalSelected` the gate sends to `trim.setCuts`.
- `hashTranscript(...)`, `hashProposal(...)` - small deterministic hashes (dedupe keys).
- Reuse `sentenceLines`, `preselectFromCuts`, `heldLines`, `selectedToRanges` from
  `transcriptToggle.js`; do NOT reimplement cut logic.
- Tests: provenance classification (kept / cut_confident / cut_held); finalState; the four
  derived signals incl. the headline "added an unflagged line"; record shape + schemaVersion;
  hash determinism; an episode opened-but-unedited yields initial==final (a clean positive).
- **Cardinal-rule regression test (key):** `buildReviewRecord(...).collapsedRanges` deep-equals
  `selectedToRanges(lines, finalSelected)` for the exact `finalSelected` the gate would send -
  i.e. the record can only ever describe the cut-set that is actually committed, never a
  divergent one.

### Slice 3 - persistence (main-process edge)
New `electron/reviewDataset.cjs`: `appendRecords(records)` - validate each record, ensure
`userData/review-dataset/` exists, append as NDJSON to `reviews.jsonl`, best-effort (catch +
return `{ ok:false, error }`, never throw upward). New IPC `review:capture` in `ipc.cjs`,
exposed via `preload.cjs` as `window.openswim.review.capture`. Mirror `decisionCache.cjs`
conventions.
- **Treat the renderer payload as UNTRUSTED, but validate only the TRUST BOUNDARY** - enough
  to avoid unsafe writes and corrupt lines, NOT a re-validation of detector semantics. The
  checks: `schemaVersion` matches the expected version; finite numeric `startSec`/`endSec` on
  cuts and ranges; sentence `index` values non-negative and strictly increasing; **strip
  unknown top-level fields** rather than persist arbitrary keys. Nothing deeper (the validator
  does not try to prove the cuts are "correct").
- **Batch-failure rule (exact, tested):** a payload that is **not an array**, or **exceeds the
  max batch size** (e.g. 64 records), is **rejected whole** (return `{ ok:false }`, write
  nothing). A **single record that fails per-record validation**, or **exceeds the max record
  byte size** (e.g. 4 MB), is **skipped (counted), not thrown** - other valid records in the
  batch still append. Tests assert each of these outcomes precisely.
- **Restrictive local file behaviour:** the path is FIXED at
  `app.getPath("userData")/review-dataset/reviews.jsonl` - never a renderer-supplied path;
  create the dir with owner-only permissions (`0o700`) where the platform supports it; append
  UTF-8, one JSON object per line. On a validation or fs error, **never log transcript text** -
  log counts / error codes only.
- Tests: appends valid records as NDJSON (one JSON object per line); **rejects the whole
  payload** for a non-array or an over-max-batch input (writes nothing); **skips only the bad
  record** for a per-record validation failure or an over-size record (valid records still
  append); strips unknown fields; rejects a wrong `schemaVersion`; rejects non-finite times and
  non-monotonic indexes; creates the dir if missing; an fs error returns `{ ok:false }` rather
  than throwing; no transcript text appears in an error path.

### Slice 4 - wire the gate (integration)
- `TranscriptCutReview.jsx`: add an `onOpen(uuid)` fired from `<details onToggle>` when it
  transitions to open; **remove the `hasUnreviewedHeld` auto-open** (keep the held summary
  cue + the jump button). Optional: `onToggleSentence` already exists for edit-tracking; a
  lightweight `toggleCount`/`edited` can be derived in the parent from existing toggle calls -
  no new per-line counters unless needed.
- `SyncScreen.jsx`: pass `defaultOpen={false}` for ALL gate panels; track a
  `reviewedUuids` set + per-uuid `openedAt` + the frozen initial snapshot (taken at first
  open) + `toggleCount`/`edited` (from `onReviewToggle`); in `continueReview()` build records
  for `reviewedUuids` BEFORE the async commit, then fire-and-forget `review.capture` after
  `resolveReview()` succeeds, wrapped best-effort.
- Tests: collapsed-by-default (no panel auto-opens, incl. single-episode + held-cut cases);
  collapsed summary still shows the held-cut count (the acceptance criterion in section 3);
  records built only for opened episodes (a never-opened episode is absent); records assembled
  before `resolveReview` (ordering); capture fired only after a successful resolve; a thrown
  capture does NOT fail-close the transfer; cancel -> no capture.
- **Cut-set-unchanged proof (key):** `trim.setCuts` receives EXACTLY the same ranges in all
  FOUR of: capture enabled and succeeding, record-building throwing, capture (append) throwing,
  and capture bridge unavailable (`window.openswim.review` absent). The committed cut-set is
  identical regardless of capture.

## 6. Out of scope (do not build)

- No upload / sync / telemetry - local file only.
- No UI to browse/inspect the dataset (it is NDJSON on disk; a notebook reads it later).
- No abandoned-review (opened-then-cancelled) stream - dropped by design.
- No change to the detector, the cut boundaries, or the cardinal-rule commit path.
- No per-line scroll-depth instrumentation unless a slice proves it cheap and warranted.

## 7. Done

All four slices merged to `main`, every slice's tests green, GPT-5 READY-TO-SHIP on each.
The transfer/cut path is provably unchanged (cardinal rule intact). Capture verified to write
a well-formed NDJSON record for an opened+committed episode and nothing for a YOLO'd one.
