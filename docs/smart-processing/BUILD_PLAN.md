# Open Swimcast Smart Processing - Autonomous Build Plan

This file is the SELF-CONTAINED source of truth for an unattended build. It does not
depend on any chat context. Full design rationale is in `SPEC.md`; the locked detector
reference implementation is `reference/quote_timewin.py`.

## What we are building

Two features for the Open Swimcast Electron app (sideloads Pocket Casts episodes onto
Shokz OpenSwim swim headphones):
- **Announce intro** (Phase 1, DONE) - prepend a short spoken intro so the swimmer can
  identify the queued episode underwater.
- **Trim interstitials** (Phase 2+) - remove intros / outros / ads anywhere in the episode.

## Repo facts

- Repo: `/Users/david/git/ai-sandbox/projects/OpenSwimPodcast`, app under `app/`.
- Branch: `smart-processing`. Never switch branch, never push, never merge.
- Tests: `cd app && npx vitest run`. Phase 1 baseline = 152 tests passing, build (`npm run build`) compiles.
- Electron backend: `app/electron/*.cjs`. React frontend: `app/src/*.jsx`.

## Phase 1 (DONE) - modules already committed (580330c..53db024)

- `app/electron/converter.cjs` - `convert({src,dest,speed,boost,introPath,...})`. The
  `introPath` WAV is front-concatenated at NORMAL speed; the episode is sped up by atempo.
  Re-encodes (no stream copy). **Phase 2 adds atrim ranges to this same filter chain,
  BEFORE atempo, composing with introPath.**
- `app/electron/transcribe.cjs` - spawns fast-diarize, normalises `{turns}` into
  `{segments:[{speaker,start,end,text}]}`, caches by fingerprint, returns null on failure.
  **Phase 2 reuses this transcript.**
- `app/electron/announce.cjs`, `tts.cjs` - intro text + chime/qwen-speak. Not needed for trim.
- `app/electron/sync.cjs`, `ipc.cjs`, `preload.cjs` - pipeline + IPC. Announce stage runs
  between finalise and convert. **Phase 2 adds a trim/detect step alongside it.**
- `app/src/TodayScreen.jsx`, `announcePrefs.js` - the Announce toggle/badges. **Phase 2
  adds a Trim toggle the same way.**

## LOCKED detector (Phase 2 core) - do NOT re-evaluate models

- Model: `google/gemma-4-12b-qat` via LM Studio at `http://localhost:1234/v1/chat/completions`.
- Method: **quote-boundary on 30-min time windows / 3-min overlap** (WIN=1800s, STRIDE=1620s).
  The model returns, per ad, the VERBATIM `first_line` and `last_line` (strict json_schema
  `{ads:[{first_line,last_line}]}`). The app maps those quotes to segment indices by
  normalised substring match (lowercase, collapse whitespace, strip punctuation), derives
  atrim ranges, applies conservative rules. The model NEVER emits indices or timestamps.
- Reference impl with the exact prompt, windowing and quote->index mapping:
  `reference/quote_timewin.py`. Port it faithfully into a JS module
  (`app/electron/detectAds.cjs`) using an injected fetch (same DI pattern as announce.cjs).
- Proven result: ZERO false positives on RiC / Threedom / TWiT; 8/9 ad blocks caught incl.
  all 7 deep mid-rolls; 0 quote-map failures. Guardrails: always response_format json_schema;
  read `reasoning_content` if `content` empty; on a quote-map failure SKIP that ad (fail safe
  to no-cut). CARDINAL RULE, enforced by tests: zero false positives - never trim real content.

## Build conventions (every slice)

1. **Dependency injection**: any module that spawns a subprocess or makes an HTTP call must
   inject `spawn`/`fetch` (see converter.cjs / announce.cjs) so unit tests never touch the
   real local stack. Unit tests with mocks ARE the gate; real smoke tests are best-effort.
2. **Graceful degradation**: a tool outage, a quote-map failure, or an ambiguous boundary must
   skip the trim for that episode (or flag needs-review) and continue - never throw into the
   pipeline, never abort the batch, never risk a bad cut.
3. **Style**: no em/en dashes; use " - ". Match surrounding code.
4. **Tests**: add tests; `npx vitest run` must be fully green (existing + new) before commit.
   Add regression tests that would fail on the bug being prevented.
5. **GPT-5 review gate** (David does NOT review): for each slice, after implementing and
   staging (`git add -A`), get GPT-5's verdict via
   `/Users/david/.claude/skills/ask-gpt5/ask-gpt5.sh -p <reqfile> -e high -o <outfile>`.
   Commit ONLY on `VERDICT: APPROVE` AND green tests. On REQUEST_CHANGES, revise (up to 2
   rounds) then re-review. If still blocked, STOP the chain (do not stack on a broken base).
6. **Commit per slice** on the branch; do NOT push or merge. Trailer:
   `Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>`.

## Phase 2 - Trim interstitials (slices)

- **2a converter atrim primitive**: extend `converter.cjs` to accept `cuts` (array of
  [startSec,endSec] on the ORIGINAL timeline) and remove them BEFORE atempo, composing with
  the existing introPath concat. Unit + real-ffmpeg smoke (generate a tone, cut a slice,
  assert duration). Cardinal: cutting nothing must equal the current output exactly.
- **2b detectAds.cjs**: port `reference/quote_timewin.py` (windowing, quote-boundary prompt,
  quote->index mapping, conservative range derivation incl. needs-review flagging). Injected
  fetch. Unit tests with mocked windows incl. quote-map-failure -> skip, and a ZERO-FP
  assertion on a content-only window.
- **2c pipeline wiring**: in `sync.cjs`, for Trim-on episodes, reuse the transcript, run
  detectAds, derive cuts, pass to convert. Positional intro/outro handling to catch episode
  edges (sweeps the unframed pre-roll cross-promo gap). IPC for per-episode trim status +
  the cut list. Degrade safely.
- **2d UI**: a universal "Trim" toggle + per-episode override + status badge in TodayScreen,
  mirroring the Announce toggle/announcePrefs pattern. localStorage persistence.

## Phase 3 - Review and trust layer (slices)

- **3a** coarse cut-list review component (per episode): keep / remove, shown ONLY for flagged
  cuts (over the needs-review threshold, mid-ambiguous, or quote-map-failed).
- **3b** play-before / play-after / preview-join controls + -5s/+5s nudges + editable timestamp.
- **3c** decision cache keyed by audio fingerprint so reviewed choices stick across re-process.
- **3d** Advanced transcript-as-evidence view (not the primary surface).

## Phase 4 - Polish (optional; build the buildable, flag the spikes)

- Model-picker pulldown (gemma-4-12b-qat default). BUILDABLE.
- Conservative/aggressive sensitivity setting (tunes needs-review threshold only). BUILDABLE.
- Per-podcast intro fingerprinting (no-LLM repeated-intro trim). SPIKE - attempt a design note,
  do not force an implementation if uncertain.
- Word-level boundary precision (Parakeet word timings). RESEARCH - investigate + write findings,
  defer implementation.

## Needs-review threshold (starting heuristic, tunable)

Flag (do not auto-apply) a cut if: it is longer than ~2.5 min, OR a boundary is ambiguous
(one segment straddles ad-end/content-start), OR a quote failed to map. Everything else with a
clean whole-segment boundary auto-applies. Originals are never destroyed.

## Local stack (runtime; for smoke tests only - the gate is mocked unit tests)

- LM Studio: ensure gemma-4-12b-qat loaded: `~/.cache/lm-studio/bin/lms load google/gemma-4-12b-qat -c 32768 --gpu max -y`.
- fast-diarize: `uv run --directory /Users/david/git/ai-sandbox/projects/fast_mac_transcribe_diarise_local_models_only diarise-transcribe --in <audio> --out <txt> --out-json <json> --verbose`.
- Real test fixtures: `/tmp/ric/episode.mp3` + `/tmp/ric/transcript.json` (RiC); ground truth `/tmp/eval/full_gt/*.json`.
