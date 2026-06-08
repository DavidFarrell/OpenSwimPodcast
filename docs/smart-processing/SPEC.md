# Open Swimcast - Smart Processing Features - Design Spec

Date: 2026-06-08
Status: Design only. No code.
Author: Claude, synthesising David's original design, GPT-5's UX critique, and a local model sweep.

Idea ownership is marked throughout: (David) for David's original design, (GPT-5) for points from the UX critique, (Claude) for this synthesis and analysis of the sweep/TTS results.

---

## 1. Problem statement

Open Swimcast is an Electron app that sideloads Pocket Casts episodes onto Shokz OpenSwim Pro swim headphones. The flow is: pick episodes, stage them (set speed, reorder), Process (an ffmpeg pipeline that converts source to mp3 and speeds it up via the atempo filter), then sync to the device.

The underwater hunting problem (David): in the pool, many podcasts open with a near-identical spoken intro of about two minutes. With several queued episodes, David could not tell which episode was playing from the intro alone. He wasted five to ten minutes per swim skipping forward and re-listening to the same intro to work out which episode he was on. He cannot see a screen or read metadata underwater. The only channel is audio, and the first audio he hears is generic.

Two failure costs differ sharply. Missing a trim (leaving an intro in) costs a few seconds of annoyance. A bad cut that removes real content is unrecoverable in the pool. This asymmetry drives the conservative-by-default stance below (GPT-5).

---

## 2. The two features defined precisely

### Feature A - Trim interstitials
Detect and remove non-content segments: repeated show intros, outros, and advert/sponsor reads. The cut is decided before the ffmpeg atempo speed-up, because converter.cjs applies speed as a filter during encode and an atrim must sit ahead of atempo in the same filter chain (David, confirmed against converter.cjs:60). The detection produces a set of time ranges to drop. The app maps those ranges deterministically to timestamps from the transcript - the LLM never emits timestamps (David, confirmed design fix).

Scope decision (GPT-5, accepted by Claude): the default is conservative. Trim the repeated show intro and an obvious end outro when confidence is high. Do not auto-remove mid-roll adverts unless an explicit aggressive mode is on. If uncertain, leave the audio intact and mark the episode "needs review".

### Feature B - Announce episode (generated intro)
Prepend a short spoken intro so David can identify the episode underwater within a few seconds, then hear what it is about.

DECISION (David, 2026-06-08, after listening to a real TTS sample): the generated LLM summary intro is the chosen fix. David heard the rendered intro and wanted to keep it. This reverses the earlier draft recommendation that demoted it - see section 4.4. The intro is structured to lead with the identification anchor, then the summary:
  "This is [show]. [Episode title]. This episode is about [one or two sentences of summary]."
That gives identification in the first ~2 seconds (solving the pool problem) and the richer summary David liked.

Fallback (Claude): when the LLM or transcript is unavailable, fall back to a metadata-only announcement (show + title from Pocket Casts, no LLM). So David never gets silence, and identity never depends on a working model.

Both features are universal toggles in the staging toolbar, behaving as batch defaults with per-episode override (David's toggle placement, refined by GPT-5's "toggles are intent, not workflow" framing).

---

## 3. User stories

### Feature A - Trim interstitials
- As a swimmer, I want repeated show intros removed so that the first thing I hear is distinctive content, not boilerplate.
- As a swimmer, I want obvious end outros removed so that an episode does not trail off into credits and calls to action.
- As a cautious user, I want the app to leave audio intact when it is unsure, so that it never deletes real content I wanted to hear.
- As a user in a hurry, I want to flip one toggle for the whole batch rather than configure each episode.
- As a user, I want an aggressive mode I can opt into when I want mid-roll adverts gone too, accepting the higher risk.

### Feature B - Announce episode
- As a swimmer, I want each episode to start by telling me which show and episode it is, so I can identify it without surfacing or skipping.
- As a swimmer, I want the announcement short (a few seconds) so it does not become its own boilerplate to skip.
- As a user, I want the announcement to be correct, so I am never told the wrong title.
- As a user, I want to disable announcements globally if I find them annoying, and per-episode when one is wrong.

### Review and edit stories (cross-cutting)
- As a user, I want to keep staging and queue more episodes while detection runs in the background, rather than being trapped in a preprocessing modal (GPT-5).
- As a user, I want a per-episode status badge (analysing, ready, needs review, trim skipped) so I can see at a glance which episodes need my attention (GPT-5).
- As a user, I want to review only the suspicious cases, not every episode (GPT-5).
- As a reviewer, I want to see the proposed cuts as a simple list (for example "Intro 0:00-1:43", "Outro 47:12-end"), with keep, remove, play-before, play-after, and preview-join controls.
- As a reviewer, I want coarse boundary nudges (-5s, +5s) and an editable timestamp field, not a draggable waveform editor.
- As an advanced user, I want the full transcript available as evidence under an Advanced view, but not as the primary review surface.
- As a user, I want decisions cached by episode/audio fingerprint so re-processing the same episode reuses my reviewed choices (GPT-5).
- As a user, I want the pipeline to fall back to the original (or speed-adjusted) episode if transcription, the LLM, or TTS is unavailable, so a tool outage never blocks my swim (GPT-5).

---

## 4. Recommended UX

This section reconciles David's original design with GPT-5's critique. Where they conflict, the recommendation and its owner are stated.

### 4.1 Background detection, not blocking (GPT-5, accepted)
David's original mechanic implied that flipping a toggle could kick off transcription and detection. GPT-5's correction is right: a toggle should set intent, not launch a modal workflow. Switching on Trim or Announce should feel like changing a setting, not entering preprocessing jail.

Recommendation (Claude): detection runs in the background once episodes are in staging (or as the first hidden stage of Process). The toggles mark intent. Rows show passive status. Process remains the main action. If analysis has not finished when Process is pressed, the pipeline opens with a "Preparing trim data" stage and waits for it - the technical constraint is only that analysis finishes before conversion, not before the user can keep staging. If one episode's analysis fails or is low-confidence, skip trimming that episode and continue the batch rather than blocking everything.

### 4.2 Minimum-viable review UI - coarse cut list, not a transcript editor (GPT-5, accepted)
David's injection map allowed for a richer review surface. GPT-5's point stands: a full transcript with draggable cut boundaries turns David into an audio editor, which is the wrong job for this product.

Recommendation (Claude): the primary review UI is a per-episode list of proposed cuts with confidence, each row offering keep / remove / play-before / play-after / preview-join, plus coarse boundary nudges (-5s / +5s) and an editable timestamp field. The full transcript lives under Advanced as evidence only. The app surfaces only suspicious cases for review (cuts over a duration threshold, mid-roll cuts, low-confidence results); everything else stays "ready" and is never opened.

### 4.3 Conservative-by-default trimming (GPT-5, accepted)
Because a bad cut is unrecoverable underwater, the default under-trims. High-confidence repeated intro and high-confidence end outro are removed automatically. Mid-roll adverts are left alone unless aggressive mode is enabled. Uncertainty leaves audio intact and flags "needs review". Originals are never destroyed, so any cut can be regenerated without trim (GPT-5).

### 4.4 The key decision - generated LLM intro (B1) vs metadata announcement (B2)

This was the central open question in the draft. It is now resolved.

DECISION (David): ship the generated summary intro (B1) as the fix, structured to lead with show + title so identification still happens in the first ~2 seconds. The metadata-only announcement (B2) is retained as the automatic fallback when the LLM or transcript is unavailable.

How we got here: the draft recommended B2 as default and B1 as an opt-in enhancement, on GPT-5's argument that the real problem is identification, not summarisation. David then listened to a real rendered intro (the qwen 27B summary in the Ryan voice) and decided he wanted to keep exactly that. The deciding insight (Claude): leading the generated intro with the show name and title captures GPT-5's identification point in full while keeping the richer summary David valued, so the two positions reconcile rather than conflict.

Consequences to honour:
- The summary must be faithful (the sweep shows every passing model produced faithful, natural, sub-cap summaries - section 5), and the app must fail safe to the metadata fallback if the model is down, so a tool outage never blocks a swim.
- Latency: the generated path adds an LLM call plus the TTS roundtrip (about 27s wall-clock including cold model load - section 6). This runs in the background during staging, so it does not block David. Warm steady-state is faster.
- A short chime (~0.5s) plays before the spoken intro so David learns to expect the Swimcast marker and does not mistake it for the episode (chime: yes; publish date: no - David's recommended defaults, 2026-06-08).

### 4.5 Toggles as defaults with per-episode override (David's placement, GPT-5's semantics)
The two toolbar toggles are global batch intent. Per-episode override is needed because failures are per-episode: disable trim here, disable announcement here, review detected cuts, re-run analysis. These live behind a row badge plus an overflow/review action, not as full toggle sets cluttering every row (GPT-5).

### 4.6 Failure handling degrades to the original (GPT-5)
- Bad cut removing real content - worst case. Mitigations: conservative cuts, non-destructive originals, one-click regenerate without trim, low-confidence skip.
- TTS robotic - tolerable if short. Keep announcement under five seconds, allow global disable.
- Transcription wrong - do not depend on transcript for identity; use metadata (this is exactly why B2 is the default).
- LLM unavailable - pipeline still runs; skip trim and summary, sync the original or speed-adjusted episode.

---

## 5. Model recommendation table (grounded in the sweep)

All models were tested against the real 20VC transcript (16 segments). Task A is interstitial detection (classify each segment by index; core requirement is to flag segments 3,4,5,6 as intro/sponsor and keep 8-16 as content). Task B is the summary intro.

Key cross-cutting finding (Claude): forcing a JSON schema via response_format is mandatory. Without it, the reasoning-build models loop or emit empty content. The 12B QAT's earlier reasoning-loop failure was caused by reasoning mode, and json_schema forcing eliminated it entirely (0 reasoning tokens, clean stop).

### Task A - interstitial detection

| Model | Setting | Latency | Accuracy | Verdict |
|---|---|---|---|---|
| gemma-4-31b | json-forced | 25.7s | 9/9 correct, zero false positives | Best accuracy. Slow but perfect. |
| qwen3.6-35b-a3b | no_think + response_format | 5.2s | 8/9, one boundary false positive (seg 8) | Best accuracy-per-second. Output lands in reasoning_content. |
| qwen3.6-27b | no_think + response_format | 24-30s | 8/9, one boundary false positive (seg 8) | Accurate but slow; output in reasoning_content; content field empty. |
| gemma-4-e4b | json-forced | 4.7s | core PASS, no false positives, but drops final segment | Fast; must validate returned count. |
| gemma-4-12b-qat | json-forced | 8.8s | core PASS, no false positives, but returns only 12/16 | json_schema fixed the reasoning loop; under-counts. |
| gpt-oss-20b | reasoning-low/high | 1.9-2.4s | FAIL - truncates to 3/16 then stops; minItems forcing garbles indices past ~12 | Not usable for Task A as-is. |

Models that looped or failed on Task A:
- gpt-oss-20b: failed. Strict schema truncates to 3/16; forcing array length gets labels 1-12 right but the model cannot count indices past ~12 and garbles the tail. Unusable without small-batch chunking.
- The reasoning builds (qwen3.6-35b-a3b, qwen3.6-27b, gemma-4-12b-qat before the fix) put valid JSON in reasoning_content with content empty, which looks like a failure unless the app reads reasoning_content.

### Task B - summary intro (only relevant if B1 enhancement is built)

| Model | Latency | Quality |
|---|---|---|
| gpt-oss-20b | ~4s | Excellent, 37 words, faithful. Caveat: emits en-dashes / non-breaking hyphens that TTS can mispronounce. |
| qwen3.6-35b-a3b | 5.5s | Excellent, 45 words, faithful, clean hyphens. |
| qwen3.6-27b | 32s | Excellent, 44 words, faithful, plain hyphens (this was the intro used in the TTS roundtrip). |
| gemma-4-e4b | 5.2s | Faithful, 47 words. |
| gemma-4-12b-qat | 11.7s | Excellent, 59 words (near cap). |
| gemma-4-31b | 34s | Faithful, 56 words. |

### Recommended defaults for the in-app model picker (Claude)
**SUPERSEDED 2026-06-08 - see decision #3.** The whole of section 5 (this table and the per-podcast figures) reflects the abandoned per-segment-index classification approach. The detector is now LOCKED to gemma-4-12b-qat + the quote-boundary method (decision #3). The text below is retained only as history; do NOT use it to pick the detector.

The single-podcast figures below were superseded by a 5-podcast evaluation of all 8 models (full table in /tmp/openswim-test/eval/cross-podcast-results.md). The cross-podcast result is the one to follow:
- Default model: qwen/qwen3.6-27b. Across 5 diverse feeds: 99.1% accuracy, 0 misses, 1 isolated false positive, reliable on all 5, and 100% / 0-FP on The Rest is Classified. Slower (~83s/podcast) but that is a background step. Read reasoning_content if content is empty.
- Alternative "fast/balanced": qwen3.6-35b-a3b. ~18s, 93.7%, 1 FP, safe (no over-trimming) but under-flags soft host-read intros (76.9% on ric).
- Alternative "fastest safe": qwen3.5-35b-a3b. ~7s, 91.9%, 0 false positives anywhere; lower recall on scripted intros (offmenu 60%).
- Not recommended: gemma-4-31b (the only model that made false positives on ric - it over-trimmed real discussion as intro). Disqualified: both gpt-oss models (truncate the JSON array, count_match false on every podcast).

Single-podcast figures (20VC only, retained for reference - DO NOT use to pick the default):
- qwen3.6-35b-a3b: 8/9 at 5.2s. gemma-4-31b: 9/9 at 25.7s. gemma-4-e4b: 4.7s, drops final segment. gpt-oss-20b: failed (garbled indices).
- Summary task (Task B) was uniformly good across all passing models; gpt-oss-20b emits en-dashes that need stripping before TTS.

Guardrails the app must enforce regardless of model (Claude):
- Always use response_format json_schema.
- Always read reasoning_content as a fallback when content is empty.
- Always validate that the returned segment count equals the input count; if not, skip trimming that episode (fail safe to no-cut).

---

## 6. Local-stack feasibility verdict

Verdict (Claude): feasible, local-only, end to end. Transcription (Parakeet/fast-diarize), LLM (local via LM Studio API on :1234), and TTS (qwen-speak, Ryan voice) all work and meet the need, with the constraints below.

- Transcription: Parakeet produces timestamped, diarized segments. This is the substrate for both deterministic timestamp mapping and segment classification.
- LLM: at least three models clear the bar (qwen3.6-35b-a3b, gemma-4-31b, gemma-4-e4b) once json_schema forcing is applied. See section 5.
- TTS: qwen-speak roundtrip passes. Text in, valid WAV out (PCM s16le, 24000 Hz, mono). About 27s wall-clock for a ~50-word intro including one-time cold model load; steady-state warm is faster. Stitching the intro onto the episode mp3 is standard and cheap, but requires a resample/re-encode (the intro is 24kHz mono PCM, the episode is 44.1kHz mp3) - a bare stream-copy concat will not work; the concat filter with re-encode is the reliable path.

Boundary-precision finding (Claude, important for the cut UI) - REVISED 2026-06-08 after inspecting the real transcript JSON:
The fast-diarize / Parakeet output does NOT currently carry word-level timestamps. Each segment exposes only speaker, start, end. Segments can be long: in the real Rest is Classified transcript the opening Declassified Club promo is a single 28-second segment (3.7s to 31.8s). The diarizer also merges intro+ad and ad+content into single segments. Implications:
- Cuts can only land at segment edges for now. When a whole interstitial is its own segment (the common case for a repeated intro or a monologue ad read), cutting the whole segment is clean.
- The seam problem only bites when ONE segment straddles ad-end and content-start. That is the minority case, and the coarse review UI (-5s / +5s nudge, editable timestamp) handles it by hand.
- Word-level timestamps would let a cut land inside a merged segment at the true content boundary, but they are NOT available out of the box. Obtaining them is a separate piece of work - it needs investigation into whether Parakeet can be configured to emit word timings (the `turns` array in the JSON is also worth checking). This is deferred to a later phase, not a blocker (David, accepted).
- This reinforces the conservative default: when the seam is ambiguous, under-trim and, if past the threshold, mark "needs review".
- A stronger long-term option for the repeated-intro case is audio fingerprinting (section 9, decision 7) - the intro is byte-similar across episodes of the same feed, so it can be matched and trimmed without an LLM and without precise transcript timing.

---

## 7. Technical plan sketch (no code)

Per the injection map.

Pipeline stage order (electron/sync.cjs - new stage after finalise):
1. finalise (existing) - the chosen episode list is fixed.
2. transcribe + identify (new) - for episodes with Trim or Announce on:
   a. Run Parakeet to get timestamped, diarized segments plus word-level timestamps.
   b. For Trim: call the local LLM (LM Studio :1234) with the segment list and a strict json_schema; the model returns segment index + label only. The app maps indices back to timestamps deterministically and derives atrim ranges, applying conservative rules and confidence thresholds.
   c. For Announce: build the announcement string from Pocket Casts metadata (B2 default); if the B1 enhancement is enabled, also call the LLM for a short summary. Then call qwen-speak (Ryan) to render the WAV.
3. delete (existing).
4. convert (existing, converter.cjs) - atrim ranges are inserted into the filter chain before atempo, so cuts are decided on the original timeline before the speed-up. The announcement WAV is resampled and concatenated to the front of the converted mp3.
5. transfer (existing).
6. verify (existing).

Injection points:
- Staging UI: src/TodayScreen.jsx toolbar (the two universal toggles, alongside the existing speed/boost toggles around lines 189-212) and per-episode rows (status badges plus overflow/review action, around lines 222-273).
- Converter: electron/converter.cjs - atrim before atempo in the filter chain; front-concat of the announcement WAV with re-encode.
- IPC: electron/ipc.cjs and preload.cjs - a new namespace under the existing {ok,data} envelope for: kick off analysis, report per-episode status, return proposed cuts, accept review edits, re-run analysis.
- Pipeline: electron/sync.cjs - the new transcribe/identify stage between finalise and delete.

Persistence:
- localStorage for toggle state and per-episode overrides.
- On-device manifest for what was actually applied (so the device state is self-describing).
- Cache sidecars keyed by episode/audio fingerprint for transcripts, cut decisions, reviewed choices, and rendered announcement WAVs, so re-processing reuses prior work and reviewed decisions are never re-asked (GPT-5).

How the app calls local tools as subprocesses (the app is not running inside Claude Code, so these are baked-in calls, not agent actions):
- Parakeet/fast-diarize: spawned as a subprocess from the Electron main process; reads the source audio, writes a timestamped transcript JSON the pipeline consumes.
- LLM: a plain HTTP call to the LM Studio OpenAI-compatible endpoint at http://localhost:1234, with response_format json_schema set, and a code-side fallback that reads reasoning_content when content is empty.
- qwen-speak: spawned as a subprocess; text in, WAV out at a known path the converter then stitches.
- All three must degrade gracefully: if any subprocess/endpoint is unavailable, skip its contribution and continue with the original or speed-adjusted episode (GPT-5).

---

## 8. Phasing - REVISED 2026-06-08 (after the detector lock and the Phase 1 build)

What changed since the original plan:
- (a) Phase 1 is built and smoke-validated on the real stack (branch `smart-processing`, commits 580330c..53db024, 152 tests).
- (b) The trim detector is LOCKED: google/gemma-4-12b-qat, quote-boundary method, 30-min windows / 3-min overlap. It catches deep mid-roll ads at ZERO false positives across RiC / Threedom / TWiT (section 5, REVISED). That demolishes the original plan's central assumption that mid-roll trimming was too risky and had to wait behind an opt-in "aggressive mode". Mid-roll is safe by default now.

So the phases below FOLD the old Phase 2 (intro-only trim) and old Phase 4 (mid-roll / aggressive) into one real trim feature, and demote the genuinely-deferred items to an optional polish phase.

**Phase 1 - Announce intro. DONE.** transcribe -> gemma summary -> "This is {show}. {title}. {summary}" -> chime + qwen-speak (Ryan) -> front-concat with re-encode. Metadata-only fallback. Universal toggle + per-episode disable + status badge. Smoke-validated.

**Phase 2 - Trim interstitials (the real one).** Reuse the Phase 1 transcript. Run the locked gemma quote-boundary detector to find ads ANYWHERE - intro, outro, mid-roll - returning verbatim first/last lines per ad, mapped deterministically to segment indices, turned into atrim ranges applied BEFORE atempo in converter.cjs (composing with the existing introPath concat). Cardinal rule, enforced by tests: ZERO false positives - never trim real content. Conservative safety net: when a boundary is ambiguous (a segment straddles ad-end / content-start), a quote fails to map, or a cut exceeds the needs-review threshold, leave the audio intact and flag "needs review" rather than risk a bad cut. Add positional intro/outro handling to catch the episode edges and sweep the one known detector gap (unframed pre-roll cross-promos). Universal Trim toggle + per-episode override + status badges. This is the meat of Feature A; it absorbs old Phases 2 and 4-aggressive.
  Suggested slices: 2a converter atrim primitive (ranges before atempo); 2b detector module (port /tmp/eval/quote_timewin.py - windowing, quote-boundary prompt, quote->index mapping, conservative range derivation); 2c pipeline wiring + IPC; 2d Trim toggle + badges in TodayScreen.

**Phase 3 - Review and trust layer.** A coarse cut-list UI shown ONLY for flagged (suspicious) cuts: keep / remove / play-before / play-after / preview-join, with -5s/+5s nudges and an editable timestamp field. Full transcript as evidence under an Advanced view, not the primary surface. Decision caching keyed by audio fingerprint so reviewed choices stick and re-processing reuses them. This makes the trim trustworthy for the pool: spot-check the few uncertain cuts before they hit the device.
  Suggested slices: 3a cut-list review component; 3b play-before/after/preview-join + nudge controls; 3c fingerprint-keyed decision cache; 3d Advanced transcript evidence view.

**Phase 4 - Reliability and polish (optional; some items need a design spike, not just coding).**
- Model-picker pulldown (gemma-4-12b-qat default; alternatives selectable). Buildable now.
- Conservative/aggressive sensitivity as a user setting (the detector already does mid-roll safely; this just tunes the needs-review threshold). Buildable now.
- Per-podcast intro fingerprinting - match the byte-identical repeated intro across a feed and trim it with no LLM. Most reliable repeated-intro trimmer; structurally closes the pre-roll gap. Needs a spike.
- Word-level boundary precision - investigate whether Parakeet/fast-diarize can emit word timings so a cut can land inside a straddle segment at the true content boundary. Research item (section 6).
- Cross-promo recall tuning - smaller window or per-window segment cap to catch unframed pre-roll cross-promos, IF they prove annoying in real use.

Bottom line: Phases 1-3 are the complete, usable product (identify + trim + review). Phase 4 is polish, cherry-pick as wanted.

---

## 9. Decisions log (resolved 2026-06-08) and remaining tunables

Decisions made with David on 2026-06-08:

1. Intro approach: RESOLVED - generated summary intro is the fix (Feature B / B1), structured to lead with show + title so identification happens in the first ~2 seconds. Metadata-only announcement is the automatic fallback when the LLM/transcript is unavailable. (Reverses the draft's B2-default recommendation; David decided after hearing a real sample.)
2. Intro format: chime YES (~0.5s before the spoken intro); publish date NO. (David's recommended defaults, accepted.)
3. Detector model and method: LOCKED 2026-06-08 - **google/gemma-4-12b-qat + the quote-boundary method on 30-min time windows / 3-min overlap.** This SUPERSEDES every earlier model decision in this doc (the e4b + tuned-prompt per-segment-index approach, the qwen3.6-27b default, and the section-5 single/cross-podcast tables - all stale, kept only for history).
   How it works: the model does NOT classify every segment and does NOT emit indices or timestamps (both proved hallucination-prone). For each 30-min window it returns, per ad, the VERBATIM first_line and last_line (JSON, strict response_format). The app maps those quotes back to segment indices by normalised substring match (deterministic), derives atrim ranges, and applies conservative rules. The 3-min overlap guarantees any ad up to 3 min is fully visible inside one window. Reference implementation: /tmp/eval/quote_timewin.py (windowing, the VERIFY_INSTRUCTION prompt, the quote->index mapping). Guardrails unchanged: always response_format json_schema; read reasoning_content if content is empty; on a quote-map failure, skip that ad (fail safe to no-cut).
   Eval result (RiC / Threedom / TWiT): ZERO false positives on all three (cardinal rule met), 8 of 9 ad blocks caught including ALL 7 deep mid-rolls, 0 quote-map failures. Sole gap: unframed pre-roll cross-promos (no "brought to you by" framing) - a recall edge within David's slack tolerance, and at the episode top where positional intro handling sweeps it anyway. qwen3.6-35b-a3b REJECTED (recall collapses on dense 30-min windows - whole-episode wipeouts).
4. Conservative trim defaults - REVISED. Mid-roll trimming is now ON by default because the locked detector does it at zero false positives; there is no separate opt-in "aggressive mode" required for safety. "Conservative" now means: zero-false-positive cardinal rule (proven), plus a needs-review flag (decision 6) when a boundary is ambiguous (straddle segment), a quote fails to map, or a cut exceeds the threshold - uncertainty leaves audio intact, never risks a bad cut. Originals are never destroyed. (Optional user-facing sensitivity tuning is Phase 4 polish, not a safety gate.)
5. Word-level timestamps: NOT available from the current transcription, and getting them is deferred. Ship segment-level cuts plus the -5s/+5s nudge now; investigate Parakeet word-timing later. (Accepted - see section 6.)
6. "Needs review" threshold (starting heuristic, tune in use): flag if the proposed cut is longer than ~2.5 minutes, OR it is mid-roll (not adjacent to start or end), OR the segment count failed to validate. Everything else auto-applies. (Proposed; tune from real use.)
7. Per-podcast learning: ON the roadmap (Phase 4). Because the intro is near-identical across episodes of the same feed, audio fingerprinting can match and trim it with near-certainty and no LLM - potentially the most reliable trimmer. (Accepted as a later phase.)
8. Summary model: folded into decision 3 - the single default model serves both tasks. No separate summary-only model.

Remaining tunables (not blockers, settle during build):
- The exact "needs review" duration and confidence numbers (decision 6) once there is real usage.
- Chime sound design.
- Whether per-episode overrides also expose a per-episode model choice or only the global picker.
