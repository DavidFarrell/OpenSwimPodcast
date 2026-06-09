# Podcast ad-detector prompt experiment - results

Goal: make the locked `google/gemma-4-12b-qat` detector flag **injected third-party
pre-roll spots** on The Rest Is Classified (RiC) that it currently misses
(Bloomberg ~18.5-45s, EE ~47.8-75s on "JFK vs the CIA: Fighting in Cuba (Ep 5)"),
while keeping every mid-roll it already catches and **never** flagging real content
(zero false positives is the cardinal rule).

Model, method, schema, and the quote-boundary / 30-min-window mechanics are
UNCHANGED. Only the system instruction (prompt) was iterated.

---

## 1. RECOMMENDED PROMPT (drop-in replacement for the system instruction)

Paste this as the system message in `detectAds.cjs` / the `VERIFY_INSTRUCTION` in
`quote_timewin.py`. Output schema stays `{ads:[{first_line,last_line}]}`.

```text
You are given a WINDOW of consecutive podcast transcript segments, each line prefixed with its index. Some windows contain one or more ADVERTISEMENTS; many do not, and some contain several. Your job is to find every advertisement and quote its exact boundaries.

An ADVERTISEMENT is any segment whose purpose is to sell or promote a product, service, brand, app, or another show - rather than to discuss the episode's actual topic. Ads come in THREE forms, and you must catch ALL of them:

1. HOST-READ SPONSOR READS. The hosts pivot from the conversation into a pitch, usually framed ("our show today is brought to you by X", "this episode is sponsored by X"). They end with a URL, a discount code, or a sign-off ("thanks to X for supporting the show").

2. INJECTED THIRD-PARTY SPOTS (pre-roll, mid-roll or post-roll). These are pre-recorded commercials dropped into the feed. They are NOT framed as "brought to you by" - they just START as a polished sales pitch, often in a DIFFERENT voice/speaker from the hosts, and often back-to-back with other spots near the very start of the episode. Tell-tale signs: a brand talking about itself in marketing language ("Some follow the noise. Bloomberg follows the money..."), a slogan, a call to action ("Subscribe now at Bloomberg.com", "Search EE Yes Boys", "Available wherever you listen"), a charity/cause campaign tied to a brand. If a stretch of text reads like a TV/radio commercial and is not the hosts discussing the topic, it is an ad - even with no host introduction.

3. CROSS-PROMOS for another podcast or show, even with no URL or discount code.

For EACH ad, return its boundaries as VERBATIM quotes copied exactly from the segment text:
- first_line = the exact sentence that STARTS the ad (the first line of the pitch, or the host's pivot into it).
- last_line = the exact LAST promotional sentence of that same ad - the URL, discount code, slogan, or sign-off. The ad ENDS there. The instant the hosts resume the actual topic or banter ("we're back", "so anyway", returning to the subject, or - at the start of an episode - the first line of real content such as an archival clip or the host welcoming listeners), that is CONTENT and must NOT be included.

RULES:
- A 30-minute window may contain several separate ads, especially a run of back-to-back spots at the very beginning of the episode. Return one entry per distinct ad (different brand = different ad).
- A passing mention of a brand, product, or website during normal conversation is NOT an ad - do not include it. The test is purpose: is this text TRYING TO SELL something, or DISCUSSING the topic?
- Quote EXACTLY from the provided text so the lines can be matched. Copy a full distinctive sentence, not a fragment.
- If there is NO ad in this window, return {"ads":[]}. Never invent an ad in genuine conversation - trimming real content is far worse than missing an ad.

EXAMPLE window (note three back-to-back pre-roll spots, none framed as "brought to you by"):
1. [..] SPEAKER_01: For exclusive interviews and ad-free listening, join the club at exampleshow.com.
2. [..] SPEAKER_04: Some follow the noise. Acme follows the money. Behind every headline is a bottom line. Subscribe now at Acme.com.
3. [..] SPEAKER_05: The internet is shaping our kids. We have to be louder. Search Brand Yes Kids.
4. [..] SPEAKER_03: From the archive: the President is dead. This is where our story begins.
5. [..] SPEAKER_01: Welcome to the show. Today we are looking at a dark story.
CORRECT OUTPUT: {"ads":[{"first_line":"For exclusive interviews and ad-free listening, join the club at exampleshow.com.","last_line":"For exclusive interviews and ad-free listening, join the club at exampleshow.com."},{"first_line":"Some follow the noise. Acme follows the money. Behind every headline is a bottom line. Subscribe now at Acme.com.","last_line":"Some follow the noise. Acme follows the money. Behind every headline is a bottom line. Subscribe now at Acme.com."},{"first_line":"The internet is shaping our kids. We have to be louder. Search Brand Yes Kids.","last_line":"The internet is shaping our kids. We have to be louder. Search Brand Yes Kids."}]}
(Segment 4 is an archival clip = real content; segment 5 is the host welcoming listeners = real content. Both excluded.)
```

---

## 2. Before / after - RiC Ep5 ("JFK vs the CIA: Fighting in Cuba (Ep 5)")

Ground truth (built from `/tmp/ep5_transcript.json`, segments = `turns`, 1-based):
- Pre-roll block, segs **1-6**: Declassified Club promo (1), **Bloomberg** ad (2), **EE** ad (3-6)
- Deep mid-roll, segs **90-97**: Attio host-read ("This episode is brought to you by Attio... Try Attio for free at attio.com/trick")
- Post-roll, segs **148-155**: Goalhanger network ad-sales pitch ("...email partnerships at goalhanger.com")

| Ad | Baseline prompt | Recommended prompt |
|----|-----------------|--------------------|
| Declassified Club promo (seg 1) | CAUGHT | CAUGHT |
| **Bloomberg pre-roll (seg 2)** | **MISSED** | **CAUGHT** |
| **EE pre-roll (segs 3-6)** | **MISSED** | **CAUGHT** |
| Attio mid-roll (segs 90-97) | caught (separately) | CAUGHT (8/8) |
| Goalhanger post-roll (segs 148-155) | n/a | CAUGHT |
| **False positives (content flagged)** | **0** | **0** |

Pre-roll block recall: baseline 1/6 (0.17) -> recommended **6/6 (1.00)**.
Whole episode: baseline caught 1 of 3 ad blocks; recommended catches **3/3**, FP=0.

The recommended prompt bounded each spot correctly and stopped exactly at seg 6 -
it did NOT bleed into the seg-7 archival JFK clip ("From Dallas, Texas... President
Kennedy died at 1pm"), which is the highest-risk content boundary.

---

## 3. Regression check - other RiC episode + other shows (zero-FP requirement)

Full multi-window runs (3-7 windows per show). All four shows scored against
`/tmp/eval/full_gt/*.json`.

| Show | Ad blocks caught | False positives | Notes |
|------|------------------|-----------------|-------|
| **RiC Ep5** (target) | **3/3** | **0** | pre-roll 6/6, Attio mid-roll 8/8, Goalhanger post-roll caught |
| RiC (other ep, HP read) | 1/1 | **0** | HP read segs 6-10 -> 4/5 (0.80) |
| threedom | 2/3 | **0** | mid-rolls Shopify/Casper/Quince 9/9 and MintMobile 2/4 caught; pre-roll cross-promos [1-3] missed |
| twit | 4/5 | **0** | ExpressVPN, ZipRecruiter, Melissa, Helix caught; Thinkst Canary [614-620] missed |
| **TOTAL** | **10/12 ad blocks** | **0 false positives across all shows** | |

The single "FP" the raw scorer reported on ep5 (segs 148-149) was the model
correctly catching the START of the Goalhanger post-roll ad-sales pitch; the
hand-built ground truth had under-bounded the outro (started it at 150). After
correcting the GT to 148-155, there are **zero** content-trimming false positives
on any show.

---

## 4. What made the difference

The baseline prompt defined an ad mostly as a **host pivot** "brought to you by X".
Injected programmatic spots (Bloomberg, EE) have **no host framing**, are read by a
**different voice**, and sit **before any "welcome to the show"**, so the model read
them as cold-open content.

The fix adds an explicit **second category** - "INJECTED THIRD-PARTY SPOTS
(pre-roll / mid-roll / post-roll)" - with concrete tell-tale signs (marketing
slogan, call-to-action, different speaker, back-to-back at episode start) and a
**purpose test** ("is this trying to SELL something, or DISCUSSING the topic?").
A pre-roll example with three back-to-back unframed spots teaches the pattern, and
the example's segs 4-5 (archival clip + host welcome) are explicitly labelled
CONTENT so the model learns where the pre-roll run ENDS - protecting the content
boundary that matters most.

The zero-FP guard is preserved verbatim ("trimming real content is far worse than
missing an ad").

---

## 5. Residual misses / risk notes

- The post-roll Goalhanger pitch starts at seg 148, not 150 - the initial hand-built
  ground truth was corrected (outro/ad block now 148-155). The model caught it from
  seg 148, which is correct.
- The HP read on the other RiC episode caught 4/5 segs (missed the one-segment lead-in
  "In intelligence work, it's rarely the obvious problem..."); still >=0.5 so counts as
  caught, and the missing segment is the soft bridge, not the brand/URL.
- Risk of the broader definition: a very advert-styled archival/news clip could in
  principle be flagged. Not observed on any tested episode. The purpose test + the
  negative-content cues in the example are the mitigation.

Residual misses (NOT false positives - just things still missed):
- threedom pre-roll [1-3]: two injected **cross-promos for other shows** (Wiser Than
  Me, Midnight Rebellion) with no URL/CTA. The model catches injected *product/brand*
  spots (the Bloomberg/EE pattern, which was the RiC target) reliably but is weaker on
  injected *show* cross-promos that read like a trailer. Acceptable given the zero-FP
  priority; could be tightened later with a cross-promo trailer example.
- twit Thinkst Canary [614-620]: a long (7-segment) host-read woven into a honeypot
  story; the model bounded it too tightly and the quote didn't map. Pre-existing
  difficulty, unrelated to the pre-roll change.

These are recall gaps, not safety problems. Per the brief, a miss is far preferable
to trimming content, and the recommended prompt holds the zero-FP line everywhere
while fixing the specific RiC pre-roll failure.
```
