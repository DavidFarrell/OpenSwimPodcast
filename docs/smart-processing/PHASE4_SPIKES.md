# Phase 4 Spikes - Design Notes (no forced implementation)

Status: design / research only. No app code changed in this slice.
Date: 2026-06-08.

Phase 4 of BUILD_PLAN.md lists two items that are NOT "just code": per-podcast
intro fingerprinting (a spike) and word-level boundary precision (a research item).
This note investigates both, sketches a data flow, says where each would hook into
the existing modules, and reports findings - it does not force an implementation.

The cardinal rule still governs anything that ships from here: ZERO false positives.
A spike that cannot guarantee it never trims real content does not graduate to a build.

Relevant existing modules:
- `app/electron/transcribe.cjs` - spawns fast-diarize, normalises to
  `{segments:[{speaker,start,end,text}]}`, caches a fingerprint-keyed sidecar.
- `app/electron/detectAds.cjs` - LLM quote-boundary detector, returns ad ranges
  with a `needsReview` flag.
- `app/electron/converter.cjs` - applies `cuts` (`[startSec,endSec]` on the
  ORIGINAL timeline) via `atrim`/`asetpts` BEFORE `atempo`.
- `app/electron/sync.cjs` - pipeline: transcribe -> detectAds -> derive cuts -> convert.
- `app/electron/decisionCache.cjs` - per-fingerprint reviewed-decision cache.

---

## Spike 1 - Per-podcast intro fingerprinting (no-LLM repeated-intro trim)

### Goal
A given feed (e.g. The Rest is Classified) opens nearly every episode with the
same recorded intro - the same music sting and the same scripted lines, often
byte-similar audio. If we can recognise "this is the intro I have seen on this
feed before" we can trim it with no LLM call, no transcript-quote mapping, and
near-certainty. This also structurally closes the one known detector gap (the
unframed pre-roll cross-promo with no "brought to you by" framing).

### Two ways to fingerprint - recommend transcript-prefix first, audio second

**Option A - transcript-prefix similarity (recommended first cut).**
We already have the transcript for every Trim-on / Announce-on episode (it is the
substrate for detectAds and the announce summary, and it is cached). The repeated
intro shows up as a near-identical leading run of words across episodes of the
same feed. So:
- normalise the first ~60s of words (lowercase, collapse whitespace, strip
  punctuation - the SAME normaliser detectAds already uses for quote mapping);
- store that normalised prefix as the feed's "intro signature" keyed by feed/show;
- on the next episode of that feed, compare its leading prefix to the stored
  signature with a token-level similarity (e.g. longest common prefix ratio, or
  Jaccard over the first N shingles). If similarity is over a HIGH threshold,
  the matched span is the intro and its end maps to a word/segment boundary we
  already have a timestamp for.

Why first: zero new dependencies, reuses the normaliser and the transcript we
already cache, and the output (a timestamp range) is exactly what converter.cjs
already consumes. It degrades to "no match -> no cut" trivially.

Why it is not perfect: dynamic ad insertion and small scripted variations ("on
today's episode...") mean the prefix is similar, not identical. That is fine - we
gate on a high similarity threshold and, on a partial match, we do NOT cut; we
fall back to the LLM detector or leave it for review. Under-trim, never over-trim.

**Option B - audio fingerprint (chromaprint / acoustic hashing).**
The stronger long-term matcher (SPEC.md section 6 / decision 7): the intro audio
is byte-similar across episodes, so an acoustic fingerprint (chromaprint via
`fpcalc`, or a simple chroma/MFCC hash) of the first ~2 min matches the feed's
stored intro fingerprint directly, independent of transcription quality. This
survives transcript errors and catches a purely musical sting that has no words.

Cost: a new native/optional dependency (chromaprint's `fpcalc`, or a DIY chroma
hash over ffmpeg-decoded PCM) and a fingerprint-alignment step to find WHERE the
stored intro sits in the new episode (sliding correlation), which is more code
than Option A. Recommend it as a second iteration once Option A proves the UX.

### Data flow (Option A, the recommended spike)

```
sync.cjs (Trim-on episode)
  -> transcribe.cjs            (already runs; returns cached {segments})
  -> introFingerprint.cjs      (NEW, no subprocess, no HTTP - pure function)
       inputs:  segments (or words), feedKey, stored feed-intro signature
       reads/writes: feed-intro signature store (sidecar, keyed by feed/show)
       output:  { matched: bool, endSec, confidence } or { matched:false }
  -> if matched with HIGH confidence:
         emit a cut [0, endSec] flagged needsReview=false (a clean intro cut)
       else:
         no fingerprint cut; LLM detector (detectAds.cjs) runs as today
  -> merge fingerprint cut + detectAds cuts -> converter.cjs (atrim before atempo)
```

Where it hooks in:
- New module `app/electron/introFingerprint.cjs` - a PURE function (no spawn, no
  fetch), so it needs no dependency injection and is trivially unit-testable. It
  takes the already-fetched transcript plus a small persisted per-feed signature
  store and returns a candidate `[0, endSec]` cut or nothing.
- `sync.cjs` calls it alongside `detectAds`, BEFORE deriving the final cut list,
  and merges/dedupes its result with the LLM cuts (the intro range will usually
  subsume or sit before the first LLM ad).
- Signature store: a sidecar similar to the transcript sidecar, keyed by a stable
  feed identifier (Pocket Casts podcast uuid / feed url), holding the normalised
  intro prefix and the timestamp span it covered. First episode of a feed seeds
  the signature (no cut, just learn); subsequent episodes match against it. This
  is the "per-podcast learning" of decision 7.
- Converter and the review layer need NO change: a fingerprint cut is just another
  `[startSec,endSec]` with a `needsReview` flag, indistinguishable downstream.

### Cardinal-rule guardrails for this spike
- Only auto-apply on a HIGH similarity threshold (tune from real feeds). A partial
  match is NOT a cut; defer to the LLM detector or to review.
- The cut end MUST land on an existing word/segment boundary timestamp - never an
  interpolated guess.
- A cut longer than the needs-review threshold (~2.5 min) is flagged, not applied,
  exactly like LLM cuts.
- First-ever episode of a feed only LEARNS the signature; it does not trim from a
  signature it just created (no self-confirmation).
- Anything ambiguous degrades to "no fingerprint cut" and the pipeline continues.

### Recommendation
Buildable as a contained, low-risk slice using Option A (transcript-prefix), pure
function, no new dependency, reusing the existing normaliser and cache patterns.
Option B (chromaprint audio fingerprint) is the stronger matcher but adds a native
dependency and alignment code - defer to a follow-up once Option A is proven in use.
Neither is forced here.

---

## Spike 2 - Word-level boundary precision (Parakeet word timings)

### The question (from SPEC.md section 6 and decision 5)
SPEC.md states that fast-diarize / Parakeet output "does NOT currently carry
word-level timestamps" and that obtaining them "is a separate piece of work" and
"deferred". The whole conservative-seam argument (cut only at segment edges; a
segment straddling ad-end / content-start is the hard case handled by hand with
-5s/+5s nudges) rests on that premise.

### Finding: word-level timestamps are ALREADY present. The SPEC claim is stale.

Investigated the fast_mac_transcribe project directly:
`/Users/david/git/ai-sandbox/projects/fast_mac_transcribe_diarise_local_models_only`

- `src/diarise_transcribe/asr.py` - Parakeet (parakeet-mlx, `parakeet-tdt-0.6b-v3`)
  emits per-token timestamps; the code merges BPE subword tokens into whole `Word`
  objects each with `{text, start, end}`. Word timings are a first-class output,
  not something that needs enabling. The module docstring is literally "Provides
  word-level timestamps for alignment with diarisation."
- `src/diarise_transcribe/merge.py` - `format_json_output()` writes, for EVERY
  turn, a `words` array of `{text, start, end, speaker}`. So `--out-json` already
  contains word-level timings. There is nothing to turn on at the CLI.

Confirmed against the REAL fixture `/tmp/ric/transcript.json` with the small
investigation script `inspect-transcript.cjs` committed alongside this note:

```
turns:              142
turns with words:   142 / 142      <- every turn carries words
total words:        7708
longest turn (s):   60.0
turns over 20s:     44             <- straddle-candidate segments are common
sample word shape:  {"text":"For","start":3.52,"end":3.84,"speaker":"SPEAKER_03"}
word-level timings present: YES
```

So the data is in the JSON today. What is actually missing is CONSUMPTION:
`app/electron/transcribe.cjs::normalise()` deliberately reduces each turn to
`{speaker,start,end,text}` and DROPS the `words` array. The app threw the word
timings away at the normalisation boundary; the transcriber never lacked them.

(Note: 142 turns at a 60.0s ceiling is the diarizer's `max_turn_duration=60`
default force-splitting long turns, not natural boundaries. 44 turns over 20s
means a straddle segment - one turn holding ad-end and content-start - is common,
not the minority case SPEC.md assumed. That makes word timings MORE valuable, not
less: they are what lets a cut land at the true content boundary inside a turn.)

### What it would take to use them (scoped, not built here)

Small and self-contained, because the upstream work is already done:

1. `transcribe.cjs::normalise()` - carry the `words` array through instead of
   dropping it: add `words: Array.isArray(s.words) ? s.words.map(...) : []` to the
   per-segment shape. Keep it optional/back-compatible so existing callers and the
   cached sidecars without words still work (treat missing words as empty).
   - Cache note: the fingerprint-keyed sidecars already on disk were written
     WITHOUT words. Either bump the sidecar schema/version so a words-aware read
     re-derives, or simply tolerate empty words on old sidecars (re-transcribe is
     a cache miss away). No destructive migration needed.
2. detectAds quote->boundary mapping - today a mapped quote yields a SEGMENT index
   whose start/end becomes the cut edge. With words available, after matching the
   `first_line`/`last_line` quote to a segment, refine the cut edge to the matched
   words' `start`/`end` WITHIN that segment. This sharpens a straddle cut to the
   real ad boundary instead of the whole-segment edge.
3. Guardrail (cardinal rule): word-level refinement may only ever make a cut
   SMALLER or move its edge INTO the ad - it must never extend a cut past the
   mapped quote into content. If word matching inside the segment is ambiguous,
   fall back to the segment edge (current behaviour) and, if still over threshold,
   flag needs-review. Word precision is an optimisation on top of the proven
   segment-level method, never a replacement that could over-trim.
4. The -5s/+5s nudge review control (Phase 3b) stays as the manual fallback for
   the residual ambiguous seams; word precision just reduces how often it is needed.

### Recommendation
Re-categorise from "research, blocked on getting word timings" to "buildable, the
timings are already in the JSON". It is a genuine but small slice: thread `words`
through `normalise()` (back-compatible), then refine detectAds cut edges within a
straddle segment under a strict never-extend-into-content guardrail, with the
segment edge as the safe fallback. Not forced in this slice, but no longer blocked
on an upstream capability that turns out to already exist.

Action item regardless of build: correct SPEC.md section 6 / decision 5, which
currently assert word timings are unavailable. They are available; the gap is that
`transcribe.cjs::normalise()` drops them.

---

## Summary

- Intro fingerprinting: buildable as a low-risk, no-dependency slice via
  transcript-prefix matching (Option A), pure function in a new
  `introFingerprint.cjs` called from `sync.cjs`, learning a per-feed signature
  sidecar; chromaprint audio fingerprinting (Option B) is the stronger but
  heavier follow-up. Cardinal rule held by a high match threshold,
  boundary-on-existing-timestamp, learn-before-trim, and degrade-to-no-cut.
- Word-level precision: NOT blocked. Parakeet/fast-diarize already emit word
  timestamps and `--out-json` already contains them (verified on the real RiC
  fixture). The app discards them in `transcribe.cjs::normalise()`. Using them is
  a small, back-compatible thread-through plus a never-extend-into-content
  refinement in detectAds. SPEC.md section 6 should be corrected.
- Neither is implemented in this slice by design; both now have a concrete,
  cardinal-rule-safe path and a clear hook-in point if and when David wants them.
