# Implementation plan - review-screen UX: flagged navigation, drag-paint, degraded-detection warning

**Date:** 2026-06-22
**Surface:** the "Review before sending" gate - `SyncScreen.jsx` (the modal listing one
`TranscriptCutReview` panel per episode that has cuts) and `TranscriptCutReview.jsx` (the
per-episode collapsible transcript where each sentence is a clickable line: amber = will be
cut, grey = kept, ⚑ = the detector flagged it as unsure).
**Status:** CONVERGED with GPT-5 (round 1, all feedback adopted). v2. Three features, FIVE
slices (the controlled-open / review-capture refactor is split out from the cursor logic as
its own slice - that is the risky part, per GPT-5).

---

## 0. Context (current behaviour, verified in code)

- Each episode with cuts renders a `<details>` panel (`TranscriptCutReview`). Panels start
  COLLAPSED; opening one is the deliberate "I reviewed this" signal that freezes the
  review-dataset snapshot (`onOpen(uuid)`).
- Inside a panel, lines map 1:1 to sentences. A line carries `data-index`, `data-selected`,
  `data-held` (⚑ = needs-review), `data-unreviewed` (held AND not yet selected). Clicking a
  line calls `onToggleSentence(uuid, index)` - the component is CONTROLLED; `SyncScreen` owns
  the per-episode `selected` Set and the toggle handler.
- There is one navigation affordance today: a per-panel "⚑ N flagged for review - jump to
  first" button (`jumpToFlagged`) that does a single `scrollIntoView` on the first
  `[data-unreviewed="true"]` line in THAT panel. No next/previous, no cross-episode roll-over.
- The detector (`detectAds.cjs`) calls LM Studio per ~30-min window. `callModel` returns the
  parsed result or `null` on ANY failure (HTTP non-ok, empty/unparseable content, timeout).
  `detectAds` logs "window k/n: model returned nothing" and continues, returning
  `{ ads, stats: { windowsRun, adsReturned, quoteMapFailures } }`. A window that FAILED is
  indistinguishable downstream from a window that genuinely found no ads - so a run degraded
  by token/context limits looks identical to a clean "no ads found". (This is exactly the
  4096-context failure of 2026-06-21: every window returned nothing, the episode showed 0 cuts
  and looked clean.)

## 1. CARDINAL RULE (sacred, untouched)

Zero false-positive cuts. NONE of these features change what gets cut. #1 and #2 only change
HOW the user reaches and toggles lines (the committed cut is still exactly the amber set at
Continue). #3 is purely INFORMATIONAL - it surfaces a warning, never adds, removes, or alters
a cut. Detector locked (`gemma-4-12b-qat`).

## 2. Feature 1 - flagged-only next / previous navigation across episodes

**Goal.** Replace the single "jump to first" with a navigator that steps through the FLAGGED
review items one at a time, in order, rolling from the last item of one episode into the first
item of the next. "Next" and "previous". Flagged-only (the ⚑ held cuts), per David.

**Unit of navigation = a flagged (held) CUT, not a single line.** A held cut is a contiguous
run of held lines; the user reviews the whole run, then jumps to the next run. So a target is
"the first line of each held cut". Ordered by episode order (the modal's existing order), then
by time within an episode.

This feature depends on the controlled-open / idempotent-capture refactor, which is now its
OWN slice (slice 3) done FIRST. Rationale (GPT-5): the cursor math is trivial; the real risk is
changing the review-dataset capture semantics while adding programmatic opening. Isolate that.

**Architecture.** Lift navigation from the per-panel `jumpToFlagged` to `SyncScreen`:
- A pure helper `buildReviewTargets(episodes)` -> ordered array of `{ uuid, lineIndex }`, one
  per held cut, computed from each episode's transcript + trimEntry (reuse `heldLines` /
  `selectableCuts` from `transcriptToggle.js`; a held cut's target = its first held line index).
  Ordered by modal episode order, then time. Walks ALL flagged cuts (not only unreviewed) so
  the cursor stays stable as the user toggles - an auto-shrinking target list makes cursor
  behaviour slippery (GPT-5).
- A cursor (index into that array) in `SyncScreen` state. Pure `nextCursor` / `prevCursor` -
  CLAMP at both ends (no wrap); the buttons DISABLE at the ends so the user knows they have
  reached the last/first item (GPT-5).
- Next/Prev buttons live in the MODAL (near Continue / Cancel), always reachable. Show
  progress, e.g. "Flagged 3 / 12". REMOVE the per-panel "jump to first" button - one navigator,
  no competing affordances (GPT-5).
- To jump to a target, `SyncScreen` calls `ensurePanelOpen(uuid)` (the slice-3 path) to open
  the panel, then a SEPARATE post-commit scroll effect keyed by `{uuid, lineIndex}` scrolls the
  line into view (`data-uuid` + `data-index` query inside a `requestAnimationFrame` / effect so
  the just-opened body is mounted). Scroll is NOT responsible for capture (GPT-5) - opening
  captures, scrolling only scrolls.

**Cut-set safety / dataset.** No cut changes. Navigation opens panels via the same idempotent
path as a user click, so it (correctly, once) marks those episodes reviewed.

**Tests (pure where possible).**
- `buildReviewTargets`: orders held cuts across episodes; one target per held cut (not per
  line); episodes with no held cuts contribute nothing; an already-opted-in held cut still
  appears (we navigate all flagged cuts).
- `nextCursor` / `prevCursor`: advance, clamp at ends, disabled-state flags at first/last.
- Component: a controlled-open panel opens when its uuid is in the open set; scroll effect fires
  for the active target.

## 3. Feature 2 - click-and-drag to paint line selection

**Goal.** Press on a line and drag up/down to paint the SAME state onto every line dragged
over: if the anchor line became amber (selected), the drag selects; if it became grey, the drag
deselects. Release ends the gesture. Today only single-click toggle exists.

**Architecture (inside `TranscriptCutReview`, controlled API unchanged).** All gesture state in
REFS, never React state - React batching may not have committed before the next pointer event,
so state would be stale and miss lines (GPT-5).
- `pointerdown` on a line: toggle it (existing `onToggleSentence`), record in refs:
  `paintWantsSelected` = the line's NEW state (`!wasSelected`), `dragging = true`, and a
  `visited` Set seeded with this line's index.
- During the drag, resolve the line under the pointer via `pointermove` +
  `document.elementFromPoint` (closest `[data-index]`), NOT `pointerenter` alone - the lines
  have nested text/marker/gutter spans, so `pointerenter`/`pointerover` retargeting is
  unreliable (GPT-5). For each resolved line index NOT already in `visited`: add it to
  `visited` (so each line toggles AT MOST ONCE per gesture), then a pure helper
  `paintDecision(isCurrentlySelected, paintWantsSelected) -> shouldToggle` decides whether to
  call `onToggleSentence`. Decide from the canonical parent-owned `selected` set + paint target,
  not from DOM `data-selected` (which can be a render behind).
- `pointerup` AND `pointercancel` (both document-level): clear `dragging`, drop `visited`.
- Suppress native text selection during a drag (`user-select: none` on the body while dragging,
  `preventDefault` on pointerdown) so dragging paints instead of selecting text.

**Cardinal rule.** Painting only ever sets the same `selected` Set the click path sets; the
committed cut is still the amber set at Continue. A drag that deselects can only REMOVE lines
from a cut (safe); a drag that selects adds lines the user is explicitly painting (their
deliberate action, same as clicking each).

**Tests.**
- `paintDecision`: toggles a differing line, leaves a matching line alone (both select and
  deselect directions).
- `visited`-dedup logic (pure): a line resolved twice in one gesture toggles once.
- Component-level: a simulated pointerdown→move→move→up sequence produces the expected toggle
  calls (anchor + each differing, never-twice, none for same-state lines); pointercancel ends
  the gesture.

## 4. Feature 3 - surface "detection may be incomplete" (token / context shortfall)

**Goal.** When the detector could not fully analyse an episode (the model ran out of output
budget or the prompt overflowed context), say so on that episode in the review gate, instead of
letting a degraded run masquerade as a clean "no ads found". Cannot say WHICH ad was missed -
only "don't trust the zero / the cuts here may be incomplete".

**Signal (already present in the model response, currently discarded).** Six reasons, kept
distinct - empty and malformed have different operational causes, so do NOT merge them (GPT-5):
- `truncated` - `finish_reason === "length"` (model hit `max_tokens`, the reasoning-ramble case).
- `context-exceeded` - the prompt overflowed context. Detect from MULTIPLE shapes, not only
  HTTP 400 body text: a non-ok status whose body mentions context, AND any LM-Studio-specific
  context error shape. Do not overfit to one string (GPT-5).
- `http` - any other non-ok response.
- `timeout` - abort / fetch reject (the catch path).
- `empty` - ok response but content blank.
- `parse-error` - ok response, non-blank content that does not parse to the expected schema.

**Architecture (additive, behaviour-neutral for cuts).**
1. `callModel` returns a TYPED outcome instead of bare `null`:
   `{ ok: true, parsed }` or `{ ok: false, reason }`. A pure helper
   `classifyModelOutcome({ res, data, aborted })` maps response -> reason (unit-testable
   without a network). detectAds's existing "parsed or null" branch becomes "outcome.parsed or
   null" - same control flow, plus it now records the reason.
2. `detectAds` aggregates into `stats`: `windowsFailed`, `failureReasons` (per-reason counts),
   and a derived `degraded` boolean (`windowsFailed > 0`). Returned in the existing `stats`
   object - additive.
3. `sync.cjs` carries `stats.degraded` (+ a terse reason summary) into the per-episode trim
   result object (alongside `status`, `cuts`, `segments`), then into the review event / IPC
   payload the renderer already receives.
4. `SyncScreen` -> `TranscriptCutReview` renders a warning row when `degraded`: e.g.
   "⚠ detection may be incomplete - the model couldn't read N of M sections of this episode;
   cuts shown may be missing some ads." A pure `degradeSummary(stats)` builds the text.

   **CRITICAL (GPT-5): a degraded episode with ZERO cuts must still surface.** Today only
   episodes WITH cuts render a panel, so a degraded-to-zero episode (yesterday's exact bug)
   would render NOTHING and the warning would be invisible - silently skipping the very failure
   case this feature exists to catch. So: the review gate must admit an episode that is
   `degraded` even when it has no cuts, rendering at minimum a header + the warning row (no
   transcript body needed - there are no cuts to toggle). Equivalently/additionally, surface a
   gate- or sync-summary-level "N episodes had incomplete detection" line so a degraded-zero
   episode is never silently clean. Wording plain and declarative (no marketing).

**Cardinal rule.** Pure information. No cut added/removed/changed. If the whole feature failed
to compute, cuts are exactly as today.

**Tests.**
- `classifyModelOutcome`: length -> truncated; context-shaped error (more than one shape) ->
  context-exceeded; other non-ok -> http; ok+blank -> empty; ok+unparseable -> parse-error;
  aborted -> timeout; ok+parsed -> ok.
- `detectAds` aggregation: N failed windows -> `windowsFailed:N`, `degraded:true`, reason
  counts; all-ok -> `degraded:false`. The cut output is unchanged vs today for the same inputs
  (a strong "behaviour-neutral" test).
- `degradeSummary`: wording for 1 vs many failed windows; empty when not degraded.
- Gate admission: a degraded ZERO-cut episode is admitted to the review gate / summary (not
  silently dropped); renders the warning even with no cuts.
- Component: renders the warning row iff `degraded`.

## 5. Slices (each its own branch, GPT-5-gated, tests green before commit)

FIVE slices (GPT-5 split the controlled-open / review-capture refactor out from the cursor
logic - that refactor is the risky part; the cursor is trivial). Slice 1 then 2 are a pair:
backend-only degraded state has no user value until surfaced, so 2 follows 1 immediately.

- **Slice 1** - #3 backend signal: `classifyModelOutcome` + `callModel` typed `{ok, reason}`
  outcome + `detectAds` `windowsFailed`/`failureReasons`/`degraded` aggregation. No UI. Cut
  output byte-identical to today (behaviour-neutral test).
- **Slice 2** - #3 propagation + UI: carry `degraded` through `sync.cjs` trim result + review
  payload into `SyncScreen`/`TranscriptCutReview`; render the warning row; `degradeSummary`;
  AND admit degraded zero-cut episodes to the gate/summary (the critical non-silent case).
- **Slice 3** - controlled-open + idempotent review-capture refactor (THE RISKY ONE): convert
  `TranscriptCutReview`'s self-managed `<details open>` to a controlled `open` prop owned by
  `SyncScreen`; route both user-open and (future) programmatic-open through ONE parent
  `ensurePanelOpen(uuid)` that captures the review snapshot ONLY if the uuid is not already in
  `reviewedEpisodes`, then adds it to `openUuids`. Heavy tests on capture idempotence + snapshot
  timing (capture from the parent-owned selected set, before any mutation). NO navigation yet -
  this slice must leave observable behaviour unchanged (panels still open on click, capture
  still fires once).
- **Slice 4** - #1 cross-episode flagged nav: `buildReviewTargets` + `nextCursor`/`prevCursor`;
  modal-level Next/Prev + progress; jump = `ensurePanelOpen` (slice 3) + a separate post-commit
  scroll effect; remove the per-panel "jump to first" button.
- **Slice 5** - #2 drag-paint: `paintDecision` + ref-based gesture + `visited`-dedup +
  `pointermove`/`elementFromPoint` resolution + `pointerup`/`pointercancel` + text-select
  suppression in `TranscriptCutReview`.

## 6. Out of scope (do not build)
- Auto-applying or auto-changing any cut based on the degraded signal (it stays a warning).
- Re-running detection automatically on a degraded episode (could be a later "re-detect this
  episode" button; not now).
- "Skip to next UNREVIEWED" mode for the nav cursor (v1 walks all flagged cuts; this is a later
  refinement).

## 7. Resolved decisions (GPT-5 round 1, all adopted)
1. Nav cursor: CLAMP at the ends, disable buttons at first/last. (Not wrap.)
2. Nav targets: walk ALL flagged cuts (stable cursor under toggles), with a visible progress
   count. Not the auto-shrinking unreviewed-only list.
3. Remove the per-panel "jump to first" button - one modal-level navigator.
4. Drag-paint: include the `pointermove`/`elementFromPoint` resolution NOW (pointerenter-only is
   underbuilt; missed lines on fast drags read as data loss).
5. Detector slice (1) first is correct PROVIDED slice 2 follows immediately - backend-only
   degraded state has no user value until surfaced.
6. Re-slice 4 -> 5: split the controlled-open / idempotent-capture refactor (slice 3, the risky
   part: changing review-capture semantics while adding programmatic open) from the trivial
   cursor logic (slice 4).
7. Feature-3 taxonomy: six distinct reasons (no empty/parse merge); detect context-exceeded from
   multiple shapes, not just HTTP 400 text.
8. Feature 3 must admit degraded ZERO-cut episodes to the gate/summary so the silent-clean
   failure case is never hidden.
