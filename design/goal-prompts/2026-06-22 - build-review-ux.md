Use the careful-build-lifecycle skill, BUILD stage.

Project repo: ~/projects/OpenSwimPodcast (workspace is `app/`)
Overlay: design/_build-overlay.md

THE RUN: Build the review-screen UX feature set, slice by slice, from the converged plan at
`design/2026-06-22 - review-ux-plan.md`. FIVE slices, in order:

  1. #3 detector signal - `detectAds.cjs`: `callModel` returns a TYPED outcome `{ ok, parsed }`
     or `{ ok: false, reason }` via a pure `classifyModelOutcome` helper (reasons: `truncated`,
     `context-exceeded`, `http`, `timeout`, `empty`, `parse-error` - kept distinct; detect
     context-overflow from multiple response shapes, not just HTTP-400 body text). `detectAds`
     aggregates `windowsFailed` / `failureReasons` / a derived `degraded` boolean into the
     existing `stats`. NO UI. Cut output BYTE-IDENTICAL to today (the behaviour-neutral test is
     binding).
  2. #3 propagation + warning UI - carry `degraded` (+ terse reason summary) through `sync.cjs`
     trim result + the review payload into `SyncScreen.jsx` / `TranscriptCutReview.jsx`; render
     a plain "⚠ detection may be incomplete - the model couldn't read N of M sections" row via a
     pure `degradeSummary(stats)`. CRITICAL: a degraded episode with ZERO cuts MUST surface in
     the gate/summary (today only episodes with cuts render a panel - a degraded-to-zero episode
     must not be silently clean; this is the exact failure this feature exists to catch).
  3. Controlled-open + idempotent review-capture refactor (THE RISKY SLICE) - convert
     `TranscriptCutReview`'s self-managed `<details open>` to a controlled `open` prop owned by
     `SyncScreen`. Route user-open AND (future) programmatic-open through ONE parent
     `ensurePanelOpen(uuid)` that captures the review-dataset snapshot ONLY if the uuid is not
     already reviewed, then adds it to the open set. Capture from the parent-owned `selected`
     set, before any mutation; scrolling is NOT this slice. This slice must leave observable
     behaviour UNCHANGED (panels still open on click, capture still fires exactly once). Heavy
     tests on capture idempotence + snapshot timing.
  4. #1 cross-episode flagged navigation - pure `buildReviewTargets(episodes)` (one target per
     FLAGGED/held cut = its first held line index, ordered by modal order then time; walks ALL
     flagged cuts) + pure `nextCursor`/`prevCursor` (CLAMP at ends, buttons disable at
     first/last). Modal-level Next/Prev + "Flagged i / N" progress near Continue/Cancel. Jump =
     `ensurePanelOpen` (slice 3) + a SEPARATE post-commit scroll effect keyed `{uuid, lineIndex}`
     (`data-uuid`+`data-index` query in a `requestAnimationFrame`/effect). REMOVE the per-panel
     "jump to first" button (one navigator).
  5. #2 drag-paint - in `TranscriptCutReview`: `pointerdown` toggles the anchor and records, IN
     REFS (not React state), `paintWantsSelected = !wasSelected`, `dragging`, and a `visited` Set
     seeded with the anchor. During drag resolve the line under the pointer via `pointermove` +
     `document.elementFromPoint` (closest `[data-index]`) - NOT `pointerenter` alone (nested
     spans). For each not-yet-`visited` line, a pure `paintDecision(isSelected, paintWantsSelected)
     -> shouldToggle` (decide from the canonical `selected` set, not DOM) gates the existing
     `onToggleSentence`; each line toggles at most once per gesture. Document-level `pointerup`
     AND `pointercancel` end it. Suppress native text selection during a drag.

The plan's sections 2-4 (per-feature architecture + tests) and section 7 (resolved decisions)
are binding. The CARDINAL RULE is sacred: zero false-positive cuts. Features #1 and #2 only
change HOW the user reaches/toggles lines - the committed cut is still exactly the amber set at
Continue. Feature #3 is purely INFORMATIONAL - it never adds, removes, or alters a cut. Every
slice touching the commit or detector path carries the cut-neutral tests the plan specifies.
Detector is locked (`gemma-4-12b-qat`); do not retune it.

The plan was converged with GPT-5 (round 1, all feedback adopted) on 2026-06-22 before this run
- treat it as settled scope. Build to it; do not re-litigate the design unless a slice surfaces
a genuine conflict (then escalate per the skill).

Completion: all five slices merged to `main`, each slice's tests green, GPT-5 READY TO SHIP on
each slice's diff. Proven: cut output unchanged by slices 1 and 3; a degraded episode (including
a zero-cut one) surfaces its warning; flagged Next/Prev walks every flagged cut across episodes
and clamps at the ends; drag-paint toggles each dragged line exactly once in the painted
direction. Do NOT package/deploy - David packages and deploys to /Applications himself after
review.

Run the skill's convergence loop per slice (fresh Opus builder each, up to 5 rounds, adjudicate
at the cap). Use David's review-choice workflow at each slice end (AskUserQuestion: David reviews
PR / GPT-5 reviews PR / merge now). Escalate to David per the skill's escalation rules rather
than guessing.
