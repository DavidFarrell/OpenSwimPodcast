Use the careful-build-lifecycle skill, BUILD stage.

Project repo: ~/projects/OpenSwimPodcast (workspace is `app/`)
Overlay: design/_build-overlay.md

THE RUN: Build the review-interaction dataset feature, slice by slice, from the development
plan at `design/2026-06-18 - review-dataset-implementation-plan.md`. Four slices, in order:

  1. Cut provenance - `detectAds.cjs` retains the model's verbatim boundary quotes + a stable
     `cutId` on each cut; threaded through `sync.cjs`. Additive only - cut boundaries /
     `needsReview` / which cuts are emitted are UNCHANGED.
  2. Capture model - new pure `src/reviewCapture.js` (`snapshotInitial`, `buildReviewRecord`,
     hashes), reusing `transcriptToggle.js` logic. Includes the cardinal-rule regression test
     (`collapsedRanges === selectedToRanges(lines, finalSelected)`).
  3. Persistence - new `electron/reviewDataset.cjs` (untrusted-input validator, fixed userData
     path, NDJSON append, best-effort) + `review:capture` IPC + preload exposure.
  4. Wire the gate - `SyncScreen.jsx` + `TranscriptCutReview.jsx`: collapse all panels by
     default (remove the single-episode AND held-cut auto-opens; keep the held-count summary
     cue + jump button), track opened episodes + frozen initial snapshot + behavioural fields,
     build records BEFORE the async commit (wrapped), fire-and-forget capture AFTER
     `resolveReview()` succeeds.

The plan's sections 4 (timing) and 5 (per-slice tests) are binding. The CARDINAL RULE is
sacred: this feature must be provably incapable of changing the committed cut-set or
blocking/breaking the transfer - every slice that touches the commit path carries the
cut-set-unchanged tests the plan specifies. Detector is locked (`gemma-4-12b-qat`); do not
retune it.

The plan was converged with GPT-5 to READY TO SHIP on 2026-06-18 before this run - treat it as
settled scope. Build to it; do not re-litigate the design unless a slice surfaces a genuine
conflict (then escalate per the skill).

Completion: all four slices merged to `main`, each slice's tests green, GPT-5 READY TO SHIP on
each slice's diff. Capture verified to write a well-formed NDJSON record for an
opened-and-committed episode and nothing for a never-opened (YOLO'd) one. The transfer/cut path
proven unchanged.

Run the skill's convergence loop per slice (fresh Opus builder each, up to 5 rounds, adjudicate
at the cap). Use David's review-choice workflow at each slice end (AskUserQuestion: David
reviews PR / GPT-5 reviews PR / merge now). Escalate to David per the skill's escalation rules
rather than guessing.
