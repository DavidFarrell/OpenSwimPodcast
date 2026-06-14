# Design - adopting the GEPA ad-detector work into Open Swimcast (2026-06-14)

Goal: fold the GEPA project's Round-5 detector work into Open Swimcast's `detectAds.cjs`.
Authorized by David (careful build + GPT-5 gates). GEPA repo: `~/git/ai-sandbox/projects/GEPA_podcast_ad_identifier` @ `45caa6a`. This doc is the design + the GPT-5 sense-check verdict; the BUILD is intentionally NOT started yet (see Status).

## What GEPA offers
- `prompts/seed_checklist_v1.txt` - champion FIRST-PASS prompt (same gemma-4-12b-qat quote-boundary method as ours, richer FAFF taxonomy ad/intro/outro/housekeeping, checklist, explicit "when unsure KEEP"). Schema `{spans:[{type,subtype,start_quote,end_quote}]}`.
- Recovery pass (`src/anchors.py` + `src/recover.py` + `prompts/recover_micro_v2.txt`): conservative regex scan for ad-terminal signals -> cluster -> per-cluster micro-window -> one model call back-expands the proven promo to its disguised start -> union onto first pass. ADDITIVE, decoupled.

## KEY FINDING (GPT-5) - this is NOT a prompt swap
True parity with the GEPA champion needs **sentence-level segmentation**. GEPA re-splits word-timed turns into sentences (`transcript.py` `_SENT_END`), so a quote maps to a tight sentence span. Open Swimcast's `transcribe.cjs::normalise` DROPS the word-timings array and feeds the model coarse diarized turns/segments, where one segment can mix ad + content. Swapping only the prompt therefore does NOT adopt the champion - the substrate differs. Word timings ARE available upstream from fast-diarize (noted in `PHASE4_SPIKES.md`); `normalise` just discards them.

## Cardinal-rule risk in OUR pipeline
A mapped-but-WRONG span shorter than the needs-review threshold AUTO-applies: `detectAds.cjs` only flags needs-review on ambiguous-boundary / over-threshold (`classifyRange`), and the quote-map-fail SKIP only protects UNmappable quotes. A confidently-wrong-but-mappable short span passes straight to the converter (`sync.cjs` convert loop). So changing the classifier (the prompt) can introduce confident wrong auto-cuts - it must be proven against the current prompt before going default. Also `sync.cjs` edge-snaps near-edge blocks to 0/end REGARDLESS of model type, which magnifies any intro/outro taxonomy mistake.

## Eval (gemma-4-12b-qat, GEPA harness, its 9 golden shows, weighted; FP_sec = predicted secs outside golden +/-7.5s)
| show | champ fp_sec | champ ad-recall | +recovery fp_sec | +recovery recall | recovery note |
|---|---|---|---|---|---|
| threedom | 5.2 | 0.78 | 5.2 | 0.86 | WIN, 0 added FP (handoff's "5s threedom FP" was actually FIRST-PASS, not recovery) |
| dtns | 0.0 | 0.91 | 52.5 | 0.92 | +52.5s FP - youtube.com/PCMag + /CNET channel cross-promos (unlabeled) |
| btb | 34.5 | 1.00 | 34.5 | 1.00 | (first-pass boundary slop) |
| news_agents_usa | 0.0 | 0.74 | 0.0 | 0.96 | recovery win, 0 FP |
| lennys | 16.8 | 1.00 | 16.8 | 1.00 | (first-pass slop) |
| trip_leading | 12.9 | 0.91 | 12.9 | 0.91 | |
| trip_us | 19.5 | 1.00 | 21.7 | 1.00 | +9.7s - outro sign-off recovered as cross-promo |
| ppf | 0.0 | 1.00 | 0.0 | 1.00 | |
| thursdai (no ads) | 0.0 | - | 0.0 | - | |
| TOTAL | 88.9 | micro 0.84 | 143.6 | micro 0.92 | recovery = +54.7s FP for +8.4pts recall, ~all FP on dtns |
Nothing is literally zero-FP; champion's 88.9s is almost all boundary-slop on real ads/outros + unlabeled host self-promo, NOT cut episode content.

## Phased plan (GPT-5-endorsed sequence)
- **Phase 1 (engineering, cardinal-safe, autonomous):** port the `{spans}` schema/parser + `seed_checklist_v1` behind a SELECTABLE detector mode - the DEPLOYED DEFAULT stays `VERIFY_INSTRUCTION`, nothing in the shipped app changes. Port/emulate GEPA sentence rendering + mapping using the word timings (un-drop them in `transcribe.cjs`, opt-in per mode). Keep our quote->index mapping, needs-review, quote-map-fail skip.
- **Phase 2 (needs David):** head-to-head `VERIFY_INSTRUCTION` vs `seed_checklist_v1` on the GEPA corpus THROUGH final cut semantics (post-`sync.cjs` edge-snap). Split metrics: `auto_applied_fp_sec` / `needs_review_fp_sec` / raw. DAVID adjudicates every NEW auto-applied FP + time delta (real-content cut = stop-ship; boundary slop = acceptable/track; unlabeled faff = golden/policy; policy-grey outro/housekeeping = review-only). Only then make seed the default.
- **Phase 3 (later, guarded):** recovery. dspygepa's hard/soft split (GPT-5-endorsed): HARD terminals (promo code / discount / sponsor framing / terms / giveaway + NAMED brand, topic-link rejected) -> auto-eligible; SOFT terminals (bare URL / channel link / podcast cross-promo) -> require corroboration (overlap a first-pass hit) or review-only. Recovered EXPANSIONS of an existing cut -> needsReview. Ship shadow/review-only first. (This kills the dtns +52.5s while keeping the threedom / news_agents / Specsavers wins.)
- **Type policy (GPT-5):** keep type/subtype metadata; `ad` auto-cut-eligible; `intro`/`outro`/`housekeeping` review-only (except pure-generic-short intro / clear edge credits), because of the edge-snap magnification.

## Status (2026-06-14, ~21:00)
Understand + eval + design + GPT-5 sense-check DONE. Build NOT started - this is the careful-build design gate, and (a) the scope grew beyond the handoff (sentence re-seg, not a prompt swap) so David's steer on scope is wanted, and (b) Phase 2's make-default decision needs David's FP adjudication. Recommendation: do Phase 1 (safe scaffolding, default unchanged) next, then checkpoint with David for the head-to-head + adjudication. LM Studio is up with gemma-4-12b-qat; the golden corpus + harness are local for re-validation.
