# Implementation plan - decouple device-free prep from the device-bound transfer

**Date:** 2026-06-21
**Feature:** let the user start a sync with NO swim-headphone device attached - do all device-free
work (download already done; transcribe -> detect -> intro -> review -> convert), then PARK and
auto-finish (delete superseded -> copy -> verify -> manifest) the moment the marked device is
plugged in. Use case: "start it in the shower wearing the headset, plug in afterwards."
**Status:** architecture converged with GPT-5 (READY TO SHIP). This is the slice decomposition.

---

## 1. Architecture (settled - do not re-litigate)

Option A: an in-process "await device" park inside `runSync`, mirroring the existing review-gate
park (`awaitReview` -> `pendingReview` resolver in `ipc.cjs`, released over IPC). Three phases:

- **Phase 1 - prep (device-free):** analyse (transcribe -> detect -> build intro) -> review gate
  (unchanged, fail-closed) -> **convert** (MOVED ahead of the device; writes finished mp3s to
  `cacheDir`, keyed by the variant hash of the REVIEWED cut-set + intro text + speed/boost).
- **Phase 2 - await device park:** new injected `awaitDevice()` gate. Emits `stage: waiting-for-device`;
  resolves with a FRESHLY VALIDATED device handle from the existing watcher (immediately if a marked
  device is already mounted - so device-present-throughout is unchanged; else on the next attach).
  Readiness-probed with retry. Cancellable like the review park. Watcher listener cleaned up on every
  exit path.
- **Phase 3 - transfer (device-bound):** with the validated handle, compute the REAL plan now (fresh
  `readdir` + `readManifest` + `buildPlan`), emit the delete/transfer plan, revalidate the device
  immediately before the destructive `delete`, then delete -> transfer (crash-safe) -> verify ->
  manifest.

In-memory park only (app stays open between prep and plug-in); disk caches make a restart + re-SEND
reuse prior work. Durable prepared-state is an explicit non-goal for v1.

## 2. CARDINAL RULE (sacred, unchanged)

Zero false-positive cuts AND no device data loss. The destructive `delete` runs only AFTER review
resolves AND a validated device is present, immediately before transfer; a cancel before transfer
leaves the device untouched. Detector locked (`gemma-4-12b-qat`). Nothing here changes what gets cut.

## 3. Slices (each its own branch, GPT-5-gated, tests green before commit)

### Slice 1 - reorder `convert` ahead of the device `delete` (isolated refactor, no park yet)
Move the `convert` block to run BEFORE the `delete` block in `runSync`. Device is STILL required at
entry; device-present behaviour is identical EXCEPT the one safer change GPT-5 called out: if convert
throws (after its existing intro/cuts-drop fallback), the device's old files are no longer already
deleted. No new device coupling, no park. This isolates the one reorder that the whole feature rests
on and proves it behaviour-preserving.
- Tests: happy path unchanged (delete still happens, transfer/verify/manifest unchanged); a forced
  convert failure leaves the superseded device files INTACT (was: deleted) - a real regression catcher
  for the safer ordering; the convert-failure degrade still ships untrimmed audio (never unreviewed
  cuts). Existing 669 tests stay green.

### Slice 2 - crash-safe transfer (copy-temp -> verify -> rename; manifest only after all verify)
Harden the transfer/verify/manifest tail so a mid-transfer detach cannot leave fake-complete files.
Each file copies to a UNIQUE temp name on the device, its sha256 is verified, THEN it is renamed to
the final name; the manifest is written ONLY after EVERY final rename has completed. Any unlink/copy/
verify/rename/manifest error = transfer failed (no partial-success manifest). Temp files are
best-effort cleaned up on any failure. A crash AFTER the final renames but BEFORE the manifest write
must recover as "NOT successfully transferred" (the run is incomplete, never reported done) - the
manifest is the completion record, so its absence means not-done. Still device-required; no park.
- Tests: a copy that fails mid-file leaves no final-named file (only a temp, which is cleaned up);
  verify mismatch aborts before rename AND before manifest; manifest absent when ANY file fails;
  unique temp names (no collision across files / re-runs); happy path produces the same final files +
  manifest as today; the no-manifest-after-rename state is treated as incomplete by the success path.

### Slice 3 - `validateDevice` readiness probe (pure-ish helper, not yet wired to a park)
New small helper (in `device.cjs` or a sibling): `validateDevice(path, { markerFile, attempts })` ->
returns a validated handle or a typed "not ready" result. Checks: marker file readable, target dir
writable, `readdir` succeeds, a temp-file write+delete succeeds; retries briefly. Used in slice 4
before transfer and to revalidate before delete. Testable against a tmp dir (writable / read-only /
missing-marker / racing-not-yet-ready-then-ready cases).
- Tests: passes a good marked writable dir; fails a missing-marker dir; fails a read-only dir; the
  retry succeeds when readiness arrives on attempt N; never throws (returns a typed result).

### Slice 4 - the `awaitDevice` park in `runSync` + IPC resolver + single-run/cleanup (CORE)
Insert the park between convert and the device plan/delete. `runSync` stops requiring `devicePath` at
entry - it gets the validated handle from `awaitDevice()`. The IPC layer injects `awaitDevice` that
resolves from the device watcher (immediate if a marked device is mounted, else on the next attach
event), runs `validateDevice` (slice 3), unregisters its listener on resolve/cancel/success/error, and
keeps the existing single-run guard held for the whole parked lifetime (a second SEND is rejected
"sync already in progress"). The real `buildPlan` is deferred to here (computed against the freshly-read
device); revalidate immediately before `delete`. Cancel during the park resolves it then
`throwIfAborted()` fires before any device IO. **Slice 4 OWNS the progress event contract** the UI will
later render: it emits `stage: waiting-for-device` (active while parked, done on resolve) and a
device-free `prepared` summary event before parking. Slice 5 only consumes these - no backend change in
slice 5.
- Tests (inject a fake `awaitDevice` + fake watcher): device-present-at-start resolves instantly =
  same outcome as today (a strong "unchanged when plugged in" test); device-absent parks then proceeds
  on a simulated attach; cancel-while-parked does NO device IO (no readdir/unlink/copy) and leaves the
  device untouched; a second start while parked is rejected; the listener is removed on every exit
  path; `buildPlan` runs only after the device resolves; revalidate-before-delete fails closed if the
  device vanished between attach and delete.

### Slice 5 - UI: SEND without a device, waiting-for-device state, prepared-items, auto-continue
PURE UI - consumes the slice-4 event contract, no backend change. `SyncScreen.jsx`: SEND no longer
disabled by `!devicePath` (still gated by downloads-pending + an empty queue); `spec.devicePath` may be
null. While parked, render a "Prepared - plug in your headphones to transfer" state driven by the
`waiting-for-device` stage event; the backend park resolves itself on attach, so the UI just reflects
stage events. Show the device-free "N episodes prepared" summary (the slice-4 `prepared` event) before
the device plan arrives. Keep the device-present flow visually identical.
- Tests: SEND enabled with no device when the queue is non-empty + downloads terminal; the
  waiting-for-device state renders + clears on the resolve stage event; device-present flow unchanged;
  cancel from the waiting state aborts cleanly.

## 4. Out of scope (do not build)
- Durable cross-restart prepared-state (Option B).
- Auto-applying confident cuts to finish review-free in the shower (David kept review-everything).
- Any change to the detector, the cut boundaries, or the review surface.
- Background/auto-start of prep on download (SEND stays an explicit action).

## 5. Done
All five slices merged to `main`, every slice's tests green, GPT-5 READY TO SHIP per slice. A
device-present-throughout run behaves exactly as today; a device-absent run preps, parks, and finishes
on plug-in; cancel at any pre-transfer point leaves the device untouched; mid-transfer detach cannot
leave fake-complete files.
