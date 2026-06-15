# Mini-redesign - design spec (baked, ready to build)

Status: DESIGN BAKED, BUILD NOT STARTED (David asked to hold the build until the
detector finding below is understood). Council: Claude (orchestrator) + GPT-5
(negotiation) + an Opus sub-agent (read the full source). David made the calls.

Date baked: 2026-06-15.

## Decisions (David)
1. Filter clear: clickable X + Esc-to-clear, kill the fake Cmd-K. (unanimous)
2. Stage model: PHASES WITHIN TRANSFER (not a 4th tab) + the agreed seam fixes.
3. Sensitivity: relabel to "Auto-cut" with values "Only obvious / Suggested / More suggested cuts".
4. (raised after the council) Cancel-transfer should NOT restart from scratch.

---

## Item 1 - Filter clear  (file: app/src/UpNextScreen.jsx)
Today line 136 renders `<Kbd>⌘K</Kbd>` - a decorative hint with NO handler and NO
clear button, so Cmd-K does nothing (and Cmd-K conventionally means "focus
search", not clear - doubly misleading).
Change:
- Add a ref to the search `<input>`.
- When `q` is non-empty, render a clickable X (clear) in place of the Kbd; onClick
  `setQ("")` then refocus the input. When `q` is empty, render nothing.
- Add `onKeyDown`: Escape -> `setQ("")`.
- Do NOT wire a global Cmd-K listener (it needs a document-level effect reaching
  into local `q` state; not worth it). Remove the Cmd-K pretense entirely.
- Clear the TEXT ONLY. Leave the all/audio/video segmented control alone (clearing
  both on one X is surprising - Opus's note).
Test: a small unit test for the clear handler if practical; otherwise manual.
Risk: none (isolated, presentational).

## Item 2 - Stage model: phases within Transfer
Goal: give the "processing is its own stage" legibility WITHOUT splitting the
single `runSync` arc into two IPC sessions (the Opus council member showed that
the full 4-tab split = a backend rewrite + a cardinal-rule hazard: every new
boundary is a new place a confident cut could apply without the review gate having
resolved; the overnight build's fail-closed gate must not be re-opened for a tab
rename). So: ONE pipeline, shown as TWO labelled phases.

Changes (all renderer except the one safe sync.cjs reorder):
- **Rename Ready -> Line-up.** `Shell.jsx:25` label "Ready" -> "Line-up" (meta is
  already "LINE UP"). Update the TodayScreen toolbar label/copy and the SyncScreen
  "back to today" -> "back to line-up" (unify; one already says line-up). Keep the
  internal route id `today` unchanged (no churn).
- **Delete the dead inline review on Line-up.** `TodayScreen.jsx:466-473` renders
  `TranscriptCutReview` off `trimSegments`/`trimCuts`/`trimSelected`, which are
  ONLY populated by the sync `trim` event during a Transfer run - so on the
  Line-up screen it is BLANK (the component returns null when cuts/lines are
  empty). It is not a live duplicate review, it is dead surface. Remove it and
  clean the now-unused props threaded TodayScreen <- App.jsx. KEEP the shared
  `TranscriptCutReview` component (SyncScreen's gate still uses it) and KEEP the
  App.jsx state SyncScreen needs. Verify before deleting.
- **Two visible phases in SyncScreen (Transfer).** Group the stage list + header
  into:
  - PREPARING: Transcribe -> Find cuts -> Write intros -> (review gate).
  - TRANSFERRING: Finalise order -> Remove old -> Encode -> Copy -> Verify.
  The header/toolbar shows which phase is active. This is presentational grouping
  of the existing stage list (`buildStages` + `insertAnalysisStages`), reordered
  so the analysis stages render FIRST (they already run first in execution; the
  display currently inserts them before "convert" which is mid-list).
- **Downloads gate (the backlog item - ~90% already built).** `SyncScreen.jsx:88-90`
  already computes `readyQueue` (downloaded) vs `fullQueue`; the idle button text
  already reads "WAITING FOR DOWNLOADS" when nothing is ready. The missing piece is
  a BLOCK: while any episode is still in-flight (download state queued/downloading,
  i.e. not ready/error/cancelled), DISABLE Send and show an explicit
  "Preparing - waiting for N download(s)" state. Allow Send once every episode is
  terminal (ready OR error/cancelled - never block forever on a failed download).
  Never send an un-downloaded episode (already true). Surface the same waiting
  state on Line-up's Send button.
- **Fix the remove-old footgun (sync.cjs).** Today "Remove old" (delete superseded
  device files) runs BEFORE analysis + BEFORE the review gate (`sync.cjs` ~592-607,
  analysis 609+, gate ~723-731, convert 768+). So cancelling at the gate leaves the
  device's old files already deleted with nothing written. Move the delete to AFTER
  the gate resolves (into the Transferring phase, just before Encode/Copy). This is
  the one backend change in item 2 and it is cardinal-rule-adjacent (data on the
  device). GATE IT WITH GPT-5 before commit. The review gate's fail-closed arc
  (resolveReview / setCuts / the parked resolver) must stay behaviourally
  identical - we are only MOVING the delete step, not touching the gate.

Canonical execution + display order after the change:
`transcribe -> find cuts -> write intros -> [REVIEW GATE] -> finalise -> remove old -> encode -> copy -> verify`
(downloads must all be complete before transcribe starts.)

Files: Shell.jsx, TodayScreen.jsx, SyncScreen.jsx, App.jsx, sync.cjs (+ tests).

## Item 3 - Sensitivity -> "Auto-cut"  (files: sensitivityPrefs.js, TodayScreen.jsx)
Keep the INTERNAL keys + thresholds unchanged (conservative=90s, balanced=150s,
aggressive=240s) so stored prefs + the threshold semantics + all existing tests
keep working. Change DISPLAY only:
- Add a display-label map in sensitivityPrefs.js:
  `conservative -> "only obvious cuts"`, `balanced -> "suggested cuts"`,
  `aggressive -> "more suggested cuts"`. (Semantics check: conservative = lower
  threshold = flags MORE = FEWER confident/pre-selected = "only obvious cuts"
  pre-selected. aggressive = higher threshold = MORE confident/pre-selected =
  "more suggested cuts". Correct.)
- `SensitivityPicker` (TodayScreen.jsx): control label "Sensitivity" -> "Auto-cut";
  render the display label per option; update the tooltip.
- Add a one-line helper under the control: "How much it trims on its own before
  asking. It never auto-cuts anything risky." (the last clause restates the
  cardinal rule).
Risk: low (display-only). NOTE: this naming assumes a HEALTHY auto-apply path -
see the detector finding below, which currently makes "auto-cut" apply nothing.

## Item 4 - Cancel-transfer should not restart  (raised by David 2026-06-15)
Symptom: cancelling at the review gate sends David "back to the very beginning";
re-entering Transfer re-transcribes + re-finds cuts (the slow GPU work, ~3-7 min
per episode). He expected to drop back to a screen where the review/analysis is
preserved.
Cause: analysis output (transcript is cached; detector CUTS are not persisted
unless a review is saved to the cut-set sidecar). On cancel nothing is saved, so
re-entry recomputes the detector (and, if the transcript fp misses, re-transcribes).
Design intent: cancelling Transfer should return to a PREPARED state that reuses
the already-computed analysis (transcript + detected cuts + any review selections
so far), not square one. This dovetails with making "Preparing" a durable step.
SCOPE TENSION (flag to David): this needs the detector's per-episode result to
PERSIST across cancel/re-enter (a bounded backend change - extend the cut-set /
decision sidecar to cache detector output, reuse on re-entry). That is more than
"phases within Transfer" implied. Options: (a) fold it in now, or (b) ship items
1-3 first and do cancel-persistence as a fast-follow.

---

## RELATED BLOCKER - detector flags 100% of cuts as needs-review (auto-apply=0)
Found while investigating David's "This Week in Tech came out as zero cuts".
The app log shows the gepa detector FINDS ads on every episode (3-7 each, 0 hard
quote-map fails) but `auto-apply=0` on ALL of them - every cut is needsReview. The
redesigned review only pre-selects CONFIDENT cuts, so the transcript opens with
NOTHING highlighted and the header says "0 lines selected to cut" - it reads as
"found nothing" when it actually found 7 ads and held them all.
Mechanism (detectAds.cjs `mapGepaSpan`): `needsReview = reasons.length > 0`. The
`fuzzy-map` reason fires whenever a boundary quote is not an EXACT substring of a
SINGLE diarized segment (`mapQuoteToOffset` exact = indexOf within one segment),
and the type policy forces intro/outro/housekeeping to needsReview. Hypothesis:
fuzzy-map (and/or type policy) flags nearly everything because gemma's boundary
quotes rarely sit verbatim inside one segment.
Status: a background agent is getting the empirical per-reason histogram on the
real TWiT transcript (segments are medium-length, median 111 chars, so granularity
is not trivially the cause). Then adjudicate the fix with dspygepa (who designed
the quote-boundary mechanism + champion prompt) because the cardinal rule is at
stake. This must be resolved (fixed or consciously deferred) BEFORE/with the build,
since it changes what the redesigned review shows by default. The item-3 "Auto-cut"
naming also assumes a working auto-apply path.

## Build plan (when David gives the go)
- Branch off main (`feat/stage-model-mini-redesign`); leave main clean.
- Sub-agents do the work; Claude orchestrates. Parallel-safe split:
  - Agent A: item 1 (UpNextScreen only).
  - Agent S: items 2 + 3 (Shell, TodayScreen, SyncScreen, App, sync.cjs,
    sensitivityPrefs) as one coherent change (shared files -> one agent).
  - Item 4 + the detector fix: sequence after the finding is adjudicated.
- GPT-5 gate the cardinal-rule-critical diff: the sync.cjs remove-old reorder + the
  downloads-gate logic + the inline-review deletion. Fix anything flagged.
- `cd app && npx vitest run` green (baseline 538) before commit.
- Report + offer deploy (build to dist, ditto into /Applications) so David can try.
