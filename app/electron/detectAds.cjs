// Detect read advertisements / sponsor messages / cross-promos inside an episode
// transcript so the converter can trim them out before sideloading.
//
// This is a faithful JS port of the LOCKED reference detector
// `docs/smart-processing/reference/quote_timewin.py`. The method is:
//   - slide a 30-minute window with 3-minute overlap (WIN=1800s, STRIDE=1620s)
//     over the transcript segments by their start time;
//   - for each window ask the local LLM (gemma-4-12b-qat in LM Studio) for EVERY
//     ad it sees, returned as VERBATIM first_line / last_line quotes under a
//     strict json_schema {ads:[{first_line,last_line}]}. The model NEVER emits
//     indices or timestamps;
//   - map each quote to a segment index by normalised substring match (lowercase,
//     collapse whitespace, strip punctuation), exactly as the reference does;
//   - on a quote-map failure, SKIP that ad (fail safe to no-cut).
//
// On top of the reference (which only collects predicted indices) this module
// returns, per ad, the segment-index range [startIndex, endIndex] AND whether the
// range is auto-applyable or needs-review. The CARDINAL RULE is zero false
// positives: a quote that fails to map is skipped, and any range that is too long
// or whose boundary is ambiguous is flagged needs-review rather than cut blindly.
//
// The LLM is reached through an INJECTED fetch so unit tests never touch the real
// LM Studio endpoint. Any tool outage, parse failure or unexpected shape degrades
// to an empty result (no cuts) - this never throws into the pipeline.

const crypto = require("node:crypto");
const { logEvent } = require("./logger.cjs");

const LMSTUDIO_URL = "http://localhost:1234/v1/chat/completions";
const LMSTUDIO_MODEL = "google/gemma-4-12b-qat";
const LMSTUDIO_TIMEOUT_MS = 10 * 60 * 1000;

// Windowing constants - identical to the locked reference.
const WIN = 1800.0; // 30-minute window
const STRIDE = 1620.0; // 27-minute step => 3-minute overlap

// Needs-review threshold: a clean, well-mapped cut longer than this (in seconds)
// is left grey (not pre-selected) instead of pre-selected yellow. The review gate
// now surfaces EVERY cut for approval before any write, so this is no longer a
// blind-cut guard - it only decides which clean spans START pre-selected. Raised
// from 150 to 300 because measured real host-read ad blocks run 119-292s and were
// all being left grey at 150, so the review opened with nothing pre-selected.
// Tunable via the sensitivity slider.
const NEEDS_REVIEW_MAX_SEC = 300; // 5 minutes

// The prompt is identical in spirit to the reference VERIFY_INSTRUCTION. Kept
// verbatim so the detector behaves exactly as the locked evaluation proved.
// v_inject: teaches the model that INJECTED third-party spots (pre/mid/post-roll
// commercials with no "brought to you by" framing, often a different speaker) are
// ads, not content. This fixes the documented gap where dynamically-inserted
// pre-roll ads (e.g. Bloomberg, EE on "The Rest Is Classified") were read as a
// cold open. Tuned + measured on real RiC episodes: catches the injected pre-roll
// with ZERO false positives and holds the content boundary at the episode start
// (does not bleed into an archival clip / the host welcome). See
// docs/smart-processing/PROMPT_EXPERIMENT.md.
const VERIFY_INSTRUCTION = `You are given a WINDOW of consecutive podcast transcript segments, each line prefixed with its index. Some windows contain one or more ADVERTISEMENTS; many do not, and some contain several. Your job is to find every advertisement and quote its exact boundaries.

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
1. SPEAKER_01: For exclusive interviews and ad-free listening, join the club at exampleshow.com.
2. SPEAKER_04: Some follow the noise. Acme follows the money. Behind every headline is a bottom line. Subscribe now at Acme.com.
3. SPEAKER_05: The internet is shaping our kids. We have to be louder. Search Brand Yes Kids.
4. SPEAKER_03: From the archive: the President is dead. This is where our story begins.
5. SPEAKER_01: Welcome to the show. Today we are looking at a dark story.
CORRECT OUTPUT: {"ads":[{"first_line":"For exclusive interviews and ad-free listening, join the club at exampleshow.com.","last_line":"For exclusive interviews and ad-free listening, join the club at exampleshow.com."},{"first_line":"Some follow the noise. Acme follows the money. Behind every headline is a bottom line. Subscribe now at Acme.com.","last_line":"Some follow the noise. Acme follows the money. Behind every headline is a bottom line. Subscribe now at Acme.com."},{"first_line":"The internet is shaping our kids. We have to be louder. Search Brand Yes Kids.","last_line":"The internet is shaping our kids. We have to be louder. Search Brand Yes Kids."}]}
(Segment 4 is an archival clip = real content; segment 5 is the host welcoming listeners = real content. Both excluded.)`;

// Strict json_schema forcing {ads:[{first_line,last_line}]} - identical to the
// reference SCHEMA so the model can only answer in the shape we map from.
const ADS_SCHEMA = {
  type: "json_schema",
  json_schema: {
    name: "ads",
    strict: true,
    schema: {
      type: "object",
      additionalProperties: false,
      required: ["ads"],
      properties: {
        ads: {
          type: "array",
          items: {
            type: "object",
            additionalProperties: false,
            required: ["first_line", "last_line"],
            properties: {
              first_line: { type: "string" },
              last_line: { type: "string" },
            },
          },
        },
      },
    },
  },
};

// --- GEPA "gepa" mode (selectable, NON-default) ---------------------------------
//
// A second, opt-in detector mode that adopts the GEPA champion first-pass
// (seed_checklist_v1). It is OFF by default: detectAds({mode:"legacy"}) (the
// default) keeps the VERIFY_INSTRUCTION + ADS_SCHEMA + whole-segment behaviour
// above byte-for-byte. gepa mode swaps three things - the system prompt, the
// response schema, and the window line format - and maps each returned quote to a
// TIME by CHAR-INTERPOLATION within its coarse diarized segment (recovers ~81% of
// full sentence re-segmentation's precision with NO word-timings). A hard 45s cap
// and several guards route the residual risk (one ad filling most of a long turn,
// a fuzzy/non-unique map) to needsReview. See docs/smart-processing/
// DESIGN_GEPA_ADOPTION.md + OVERNIGHT_BUILD_PLAN.md (the P0 ablation verdict).

// The detector mode. "legacy" is the locked, deployed default; "gepa" is the
// opt-in GEPA champion path. process.env.OSW_DETECTOR_MODE overrides only when the
// caller leaves mode unset (used by the eval harness); an unknown value falls back
// to "legacy" so the shipped behaviour can never be changed by a stray env value.
const DEFAULT_MODE = "legacy";
function resolveMode(mode) {
  const m = (typeof mode === "string" && mode.trim())
    ? mode.trim().toLowerCase()
    : (typeof process !== "undefined" && process.env && process.env.OSW_DETECTOR_MODE
      ? String(process.env.OSW_DETECTOR_MODE).trim().toLowerCase()
      : "");
  return m === "gepa" ? "gepa" : DEFAULT_MODE;
}

// HARD pre-select sanity ceiling (seconds). A mapped span (and, in sync.cjs, the
// post-edge-snap final cut) longer than this is ALWAYS left grey (needs-review),
// never pre-selected. This is now a SANITY CEILING, not blind-cut protection: the
// review gate surfaces every cut for approval before any write, so the ceiling just
// stops an absurdly long span (a runaway mis-map) from pre-selecting. Set to 360 -
// safely above the measured max real-ad length (292s) so genuine long host-reads
// pre-select, while anything beyond ~6 minutes is held for a closer look. It is
// INDEPENDENT of the caller's needsReviewMaxSec / sensitivity: sensitivity may only
// make flagging MORE aggressive (a lower threshold), it can NEVER raise this ceiling.
const HARD_AUTOCUT_MAX_SEC = 360;

// When start_quote and end_quote map to the SAME segment and that segment is at
// least this long, a mapped span covering most of it (>= LONG_TURN_COVER_FRAC) is
// the "one ad fills a whole ~60s turn" danger case - flagged needs-review.
const LONG_TURN_MIN_SEC = 45;
const LONG_TURN_COVER_FRAC = 0.7;

// The GEPA champion FIRST-PASS prompt, ported VERBATIM from
// GEPA_podcast_ad_identifier/prompts/seed_checklist_v1.txt (@45caa6a). Used as the
// gepa-mode system prompt. Richer FAFF taxonomy (ad/intro/outro/housekeeping), a
// checklist, and an explicit "when unsure KEEP" - the cardinal rule, in the model's
// own instructions. Kept exactly so gepa mode behaves as the GEPA eval proved.
const GEPA_INSTRUCTION = `Find FAFF in this podcast transcript window. Faff = anything a listener who only wants the episode's actual content would skip. Lines look like "#idx [mm:ss] SPEAKER: text".

TYPES
- ad: sells or promotes any third-party product, service, brand, charity campaign, or other show. Host-read or pre-recorded. subtype: pre-roll | mid-roll | post-roll.
- intro: pure show packaging with zero episode information. Rare.
- outro: credits, thanks-for-listening, see-you-next-week, final next-episode tease.
- housekeeping: the show promoting ITSELF (patreon, merch, live tour, own network).

CHECKLIST - a stretch is an AD if ANY of:
[ ] "brought to you by / sponsored by / support comes from" framing
[ ] different voice reading polished marketing copy
[ ] slogan, discount code, or URL call-to-action
[ ] casual chat that pivots into selling a named product
[ ] promo for a different podcast
CHECKLIST - a stretch is NOT faff if ANY of:
[ ] it names this episode's topics or guests (billboard = content)
[ ] it is a joke or recurring gag that throws to the break (the gag is content; only the actual advert after it is faff)
[ ] it is a passing brand mention inside normal conversation
[ ] it is shorter than ~5 seconds
[ ] you are not sure (when unsure: KEEP. Cutting real content is the worst failure.)

OUTPUT - for each faff stretch:
- start_quote: the exact first sentence, copied verbatim from the window.
- end_quote: the exact last sentence (URL / code / slogan / sign-off), copied verbatim.
- Boundaries at clean sentence edges; the moment hosts resume the topic it is content.
- Back-to-back ads for different brands = separate entries.

Return strict JSON only: {"spans":[{"type":...,"subtype":...,"start_quote":...,"end_quote":...}]}
subtype only for ads, else null. No faff -> {"spans":[]}.
`;

// Strict json_schema forcing {spans:[{type,subtype,start_quote,end_quote}]} -
// mirrors GEPA detector.py SPANS_SCHEMA so the gepa-mode model can only answer in
// the shape the char-interp mapper reads. type is enum-constrained; subtype is a
// nullable string (only meaningful for ads).
const SPANS_SCHEMA = {
  type: "json_schema",
  json_schema: {
    name: "faff_spans",
    strict: true,
    schema: {
      type: "object",
      additionalProperties: false,
      required: ["spans"],
      properties: {
        spans: {
          type: "array",
          items: {
            type: "object",
            additionalProperties: false,
            required: ["type", "subtype", "start_quote", "end_quote"],
            properties: {
              type: { type: "string", enum: ["ad", "intro", "outro", "housekeeping"] },
              subtype: { type: ["string", "null"] },
              start_quote: { type: "string" },
              end_quote: { type: "string" },
            },
          },
        },
      },
    },
  },
};

const GEPA_VALID_TYPES = new Set(["ad", "intro", "outro", "housekeeping"]);

// Render one window line in the GEPA format: "#<idx> [mm:ss] <speaker>: <text>".
// mm:ss is derived from segment.start (floored to whole seconds, divmod 60, as
// GEPA's dataset._render does); speaker falls back to "SPEAKER" when absent.
function gepaLine(idx, seg) {
  const start = seg && Number.isFinite(seg.start) ? seg.start : 0;
  const total = Math.max(0, Math.floor(start));
  const mm = Math.floor(total / 60);
  const ss = total % 60;
  const pad = (n) => String(n).padStart(2, "0");
  const speaker = seg && typeof seg.speaker === "string" && seg.speaker.trim()
    ? seg.speaker
    : "SPEAKER";
  const text = seg && typeof seg.text === "string" ? seg.text : "";
  return `#${idx} [${pad(mm)}:${pad(ss)}] ${speaker}: ${text}`;
}

// Normalise a quote / segment text for substring matching. Lowercase, drop a
// leading "SPEAKER_xx: " prefix, strip everything that is not a letter/digit/
// space, then collapse whitespace. Mirrors the reference norm().
function norm(s) {
  if (s == null) return "";
  let out = String(s).toLowerCase();
  out = out.replace(/^speaker_\d+:\s*/, "");
  out = out.replace(/[^a-z0-9 ]/g, " ");
  out = out.replace(/\s+/g, " ").trim();
  return out;
}

// Pull the chat-completion content out of an LM Studio response. Reasoning builds
// leave message.content empty and put the answer in message.reasoning_content, so
// fall back to that (same guardrail as announce.cjs and the reference).
function extractContent(data) {
  const message = data && data.choices && data.choices[0] && data.choices[0].message;
  if (!message) return "";
  const content = message.content && String(message.content).trim();
  if (content) return content;
  const reasoning = message.reasoning_content && String(message.reasoning_content).trim();
  return reasoning || "";
}

// Parse the model output into an object. Tries a straight JSON.parse first, then
// falls back to the outermost { ... } slice (reasoning builds sometimes wrap the
// JSON in prose). Returns null when nothing parses. Mirrors reference extract_json.
function extractJson(content) {
  const trimmed = String(content || "").trim();
  if (!trimmed) return null;
  try {
    return JSON.parse(trimmed);
  } catch {}
  const s = trimmed.indexOf("{");
  const e = trimmed.lastIndexOf("}");
  if (s >= 0 && e > s) {
    try {
      return JSON.parse(trimmed.slice(s, e + 1));
    } catch {
      return null;
    }
  }
  return null;
}

// Find the segment index whose normalised text contains the normalised quote.
// Three passes, widening from exact containment to a shared 10-word then 6-word
// prefix - identical strategy to the reference find_seg(). normSegs is an array
// aligned to idxList (the segment indices in this window); normSegs[idx] is the
// normalised text for that absolute index. Returns null when nothing matches
// (caller treats that as a quote-map failure and skips the ad - fail safe).
function findSeg(quote, normSegs, idxList) {
  const nq = norm(quote);
  if (!nq) return null;
  // 1. exact containment
  for (const idx of idxList) {
    if (normSegs[idx] && normSegs[idx].includes(nq)) return idx;
  }
  const words = nq.split(" ").filter(Boolean);
  // 2. shared first ~10 words
  if (words.length >= 3) {
    const prefix = words.slice(0, 10).join(" ");
    if (prefix) {
      for (const idx of idxList) {
        if (normSegs[idx] && normSegs[idx].includes(prefix)) return idx;
      }
    }
  }
  // 3. fallback: segment containing the first 6 words
  if (words.length >= 4) {
    const prefix = words.slice(0, 6).join(" ");
    for (const idx of idxList) {
      if (normSegs[idx] && normSegs[idx].includes(prefix)) return idx;
    }
  }
  return null;
}

// Coerce the in-app transcript ({segments:[{speaker,start,end,text}]} or a bare
// array of segments) into a clean array of {start,end,text} we can window. Drops
// segments without usable text. Returns [] for anything unusable.
function toSegments(transcript) {
  let raw = null;
  if (Array.isArray(transcript)) raw = transcript;
  else if (transcript && Array.isArray(transcript.segments)) raw = transcript.segments;
  if (!raw) return [];
  return raw
    .map((s) => ({
      start: s && typeof s.start === "number" && Number.isFinite(s.start) ? s.start : null,
      end: s && typeof s.end === "number" && Number.isFinite(s.end) ? s.end : null,
      text: s && typeof s.text === "string" ? s.text : "",
      // Carried through for the gepa-mode line format ("#idx [mm:ss] speaker:");
      // legacy mode never reads it, so this is additive and behaviour-neutral.
      speaker: s && typeof s.speaker === "string" ? s.speaker : null,
    }))
    .filter((s) => s.text.trim().length > 0 && s.start != null);
}

// Build the time windows: every segment whose start is in [k*STRIDE, k*STRIDE+WIN)
// for k = 0,1,2,... up to the segment with the latest start. Each window is an
// array of segment indices (into the segments array). Mirrors the reference loop
// (including the "run one window past last_start" termination). Empty windows are
// dropped so we never call the model with nothing.
function buildWindows(segments) {
  const n = segments.length;
  if (n === 0) return [];
  let lastStart = 0;
  for (let i = 0; i < n; i++) {
    if (segments[i].start > lastStart) lastStart = segments[i].start;
  }
  const windows = [];
  let k = 0;
  while (true) {
    const lo = k * STRIDE;
    const hi = lo + WIN;
    const wsegs = [];
    for (let i = 0; i < n; i++) {
      if (segments[i].start >= lo && segments[i].start < hi) wsegs.push(i);
    }
    if (wsegs.length) windows.push(wsegs);
    if (lo > lastStart) break;
    k += 1;
  }
  return windows;
}

// Does this non-ok response body look like the prompt overflowed the model's
// context? Matched conservatively so an unrelated error that merely mentions a
// request "context" and a stray "maximum"/"exceeded" elsewhere does not
// false-positive. Filler between the two words may not cross a clause boundary
// (comma / semicolon / newline), which is what separates "context length exceeded"
// (real) from "request context; maximum retries exceeded" (not). bodyText is the raw
// error body (may be "").
//
// "context" paired with a SIZE word names the limit itself ("context length /
// window / size"). "overflow" / "exceed*" / "too long" are overflow VERBS that count
// next to "context" on either side. Bare "maximum" alone is too generic to qualify.
const CLAUSE = "[^,;\\n]*?"; // same-clause filler only
const CONTEXT_OVERFLOW_RE = new RegExp(
  `context${CLAUSE}\\b(?:length|window|size|overflow|exceed(?:s|ed|ing)?|too long)\\b`
  + `|\\b(?:overflow|exceed(?:s|ed|ing)?|too long)\\b${CLAUSE}context`,
);
function looksLikeContextOverflow(bodyText) {
  const t = String(bodyText || "").toLowerCase();
  if (CONTEXT_OVERFLOW_RE.test(t)) return true;
  // Structured: an error code/type explicitly naming a context-length overflow.
  if (/"(?:code|type)"\s*:\s*"[^"]*context[_ ]?length[^"]*"/i.test(t)) return true;
  return false;
}

// Classify an already-resolved model response into a typed outcome. PURE - no
// network. Returns { ok: true, parsed } or { ok: false, reason } with one of six
// distinct reasons. The reason exists so a degraded run can name its cause; the cut
// path only ever cares about ok vs not-ok.
//   timeout          - the request was aborted (caller sets aborted).
//   context-exceeded - non-ok whose body looks like a context overflow.
//   http             - any other non-ok (or missing) response.
//   truncated        - ok but the model hit max_tokens (finish_reason "length").
//   empty            - ok but the content was blank.
//   parse-error      - ok with non-blank content that did not parse.
// When the content DID parse but the model still hit max_tokens, the outcome is
// { ok: true, parsed, truncated: true } - the ads are usable, but the window was cut
// short so the run is flagged degraded (the failure-path truncated above is the
// parse-failed variant; this is the parse-succeeded variant).
function classifyModelOutcome({ res, data, aborted, bodyText }) {
  if (aborted) return { ok: false, reason: "timeout" };
  if (!res || !res.ok) {
    if (looksLikeContextOverflow(bodyText)) return { ok: false, reason: "context-exceeded" };
    return { ok: false, reason: "http" };
  }

  const content = extractContent(data);
  const parsed = extractJson(content);
  if (parsed != null) {
    // A "length" finish_reason means the model hit max_tokens. Even when the JSON
    // still happened to parse, the window was cut short, so its detection may be
    // incomplete. We KEEP the ads it did find (they were genuinely detected) but
    // also flag the run truncated so the "detection may be incomplete" warning
    // surfaces - otherwise an incomplete window masquerades as fully clean.
    if (finishReason(data) === "length") return { ok: true, parsed, truncated: true };
    return { ok: true, parsed };
  }

  // A "length" finish_reason means the JSON was cut off mid-stream, whether the
  // content came back blank or as a half-written fragment - that is truncation, not
  // a blank or malformed answer.
  if (finishReason(data) === "length") return { ok: false, reason: "truncated" };
  if (!content) return { ok: false, reason: "empty" };
  return { ok: false, reason: "parse-error" };
}

function finishReason(data) {
  const choice = data && data.choices && data.choices[0];
  return choice && typeof choice.finish_reason === "string" ? choice.finish_reason : "";
}

// True when an error (or the controller state) is an abort, not a transport failure.
// A timed-out / externally-cancelled request must classify as timeout; a DNS or
// connection-refused reject must not.
function isAbortError(err, controller) {
  if (controller && controller.signal && controller.signal.aborted) return true;
  return !!err && (err.name === "AbortError" || err.code === "ABORT_ERR");
}

// Cap on how much of a non-ok error body we read for context-overflow classification.
// The body is untrusted and only used for a substring/regex match, so a short prefix
// is enough and bounds memory.
const ERROR_BODY_MAX_CHARS = 4096;

// Read at most `cap` bytes of a (non-ok, untrusted) response body for classification,
// cancelling the stream once the cap is reached so a huge or slow error body cannot
// stall the window or balloon memory. Streams when res.body exposes a reader; falls
// back to res.text() (truncated) when it does not (e.g. test mocks). Returns "" on any
// read failure - the caller treats a missing body as a plain http failure. A read
// rejection is RE-THROWN so the caller can tell an abort (timeout) from a benign read
// error.
async function readCappedBody(res, cap) {
  const reader = res && res.body && typeof res.body.getReader === "function"
    ? res.body.getReader()
    : null;
  if (!reader) {
    if (res && typeof res.text === "function") {
      return String(await res.text()).slice(0, cap);
    }
    return "";
  }
  const decoder = new TextDecoder();
  let out = "";
  try {
    while (out.length < cap) {
      const { done, value } = await reader.read();
      if (done) break;
      // Slice each decoded chunk to the remaining budget before appending, so a
      // single oversized chunk cannot buffer more than the cap.
      const chunk = decoder.decode(value, { stream: true });
      out += chunk.slice(0, cap - out.length);
    }
  } finally {
    try { await reader.cancel(); } catch {}
  }
  return out;
}

// Call the LLM for one window. Returns a TYPED outcome: { ok: true, parsed } (legacy
// {ads:[...]} or gepa {spans:[...]}) or { ok: false, reason }. Degrades safely; never
// throws. The system prompt and response schema are chosen by `mode` (legacy default
// keeps VERIFY_INSTRUCTION + ADS_SCHEMA exactly).
async function callModel({
  lines, fetch, url, model, timeoutMs, signal, mode,
}) {
  if (typeof fetch !== "function") return { ok: false, reason: "http" };
  const user = lines.join("\n");
  const resolved = resolveMode(mode);
  const system = resolved === "gepa" ? GEPA_INSTRUCTION : VERIFY_INSTRUCTION;
  const schema = resolved === "gepa" ? SPANS_SCHEMA : ADS_SCHEMA;

  const controller = typeof AbortController === "function" ? new AbortController() : null;
  let timer = null;
  if (controller) {
    timer = setTimeout(() => { try { controller.abort(); } catch {} }, timeoutMs);
    if (signal) {
      if (signal.aborted) { try { controller.abort(); } catch {} }
      else signal.addEventListener("abort", () => { try { controller.abort(); } catch {} }, { once: true });
    }
  }

  const body = {
    model,
    temperature: 0,
    max_tokens: 4000,
    response_format: schema,
    messages: [
      { role: "system", content: system },
      { role: "user", content: user },
    ],
  };

  // The transport call. A reject here is either an abort (timeout) or a transport
  // failure (DNS, connection refused) - never a parse problem, so it is classified
  // separately from the body read below.
  let res;
  try {
    res = await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
      signal: controller ? controller.signal : undefined,
    });
  } catch (err) {
    if (timer) clearTimeout(timer);
    return { ok: false, reason: isAbortError(err, controller) ? "timeout" : "http" };
  }

  try {
    if (!res || !res.ok) {
      // Read a capped prefix of the (untrusted) error body so a context overflow can
      // be told apart from a plain http failure. A read aborted by our own timeout or
      // an external cancel still means timeout; any other read failure just leaves
      // bodyText "" and classifies as http.
      let bodyText = "";
      try {
        bodyText = await readCappedBody(res, ERROR_BODY_MAX_CHARS);
      } catch (err) {
        if (isAbortError(err, controller)) return { ok: false, reason: "timeout" };
      }
      return classifyModelOutcome({ res, data: null, aborted: false, bodyText });
    }
    // A throw from res.json() is a malformed body on an ok response - parse-error,
    // not a timeout.
    const data = await res.json();
    return classifyModelOutcome({ res, data, aborted: false, bodyText: "" });
  } catch (err) {
    if (isAbortError(err, controller)) return { ok: false, reason: "timeout" };
    return { ok: false, reason: "parse-error" };
  } finally {
    if (timer) clearTimeout(timer);
  }
}

// Decide whether a derived range can be auto-applied or must be flagged for
// review. CARDINAL RULE: when in doubt, do not cut - flag needs-review. A range is
// needs-review when:
//   - the last_line quote did not map (boundary ambiguous - we fell back to the
//     start segment), OR
//   - the cut is longer than the needs-review threshold.
// Everything else (a clean whole-segment span within threshold) auto-applies.
//
// needsReviewMaxSec is the duration threshold (P4b sensitivity setting). It only
// tunes the over-threshold check - a lower value flags more cuts (conservative),
// a higher value flags fewer (aggressive). It NEVER affects the ambiguous-boundary
// rule, and the quote-map-failure skip lives in detectAds() above this, so neither
// the zero-false-positive cardinal rule nor the quote-map fail-safe can be weakened
// by it. A missing / non-finite / non-positive value falls back to the locked
// default so the threshold can never be disabled.
function classifyRange({ startIndex, endIndex, segments, endQuoteMapped, needsReviewMaxSec }) {
  const maxSec = Number.isFinite(needsReviewMaxSec) && needsReviewMaxSec > 0
    ? needsReviewMaxSec
    : NEEDS_REVIEW_MAX_SEC;
  const reasons = [];
  if (!endQuoteMapped) reasons.push("ambiguous-boundary");

  const startSeg = segments[startIndex];
  const endSeg = segments[endIndex];
  // Duration from the start of the first ad segment to the end of the last. Prefer
  // the segment end time; fall back to the next segment's start, then to the last
  // segment's own start (a zero-length tail) so we never crash on missing times.
  let endSec = endSeg.end;
  if (endSec == null) {
    endSec = endIndex + 1 < segments.length ? segments[endIndex + 1].start : endSeg.start;
  }
  const durationSec = endSec - startSeg.start;
  if (Number.isFinite(durationSec) && durationSec > maxSec) {
    reasons.push("over-threshold");
  }

  return { needsReview: reasons.length > 0, reasons };
}

// --- gepa-mode quote -> time mapping (char interpolation) ------------------------
//
// Map a single normalised quote to a segment index AND an exact char offset within
// that segment's NORMALISED text, so a start offset and an end offset are computed
// in the SAME normalised space the match used and stay consistent. We do this by
// finding norm(quote) with indexOf inside the one segment normSegs[si] - that is
// byte-for-byte the string findSeg searched, so the offset is exact.
//
// Returns { si, charOff, exact } or null:
//   - si       absolute segment index the quote maps to (via findSeg, so the same
//              widening passes - exact containment, then 10- then 6-word prefix);
//   - charOff  the char offset of the (normalised) quote inside normSegs[si];
//   - exact    true iff norm(quote) is an exact substring of normSegs[si] (so the
//              offset is trustworthy). false when findSeg matched via a prefix /
//              fuzzy fallback - the caller treats that as a GUARD case (needsReview)
//              and uses the segment boundary, never a fabricated interpolation.
// `nonUnique` (out) is set true when norm(quote) appears in MORE THAN ONE window
// segment (an ambiguous map the guard must flag).
function mapQuoteToOffset(quote, normSegs, idxList, out) {
  const si = findSeg(quote, normSegs, idxList);
  if (si == null) return null;
  const nq = norm(quote);
  const segText = normSegs[si] || "";
  const charOff = segText.indexOf(nq);
  // Non-unique check: the same normalised quote contained by 2+ window segments.
  if (out && nq) {
    let hits = 0;
    for (const idx of idxList) {
      if (normSegs[idx] && normSegs[idx].includes(nq)) hits += 1;
      if (hits > 1) break;
    }
    if (hits > 1) out.nonUnique = true;
  }
  // charOff < 0 means findSeg matched on a prefix/fuzzy pass, not exact containment:
  // we cannot trust an interpolated offset. Map to the segment, flag it inexact, and
  // anchor the offset at the segment start (the caller will clamp + flag review).
  return { si, charOff: charOff >= 0 ? charOff : 0, exact: charOff >= 0 };
}

// Interpolate a time within segment si from a char offset into its normalised text.
// startSec = seg.start + (charOff / max(1, len(norm(seg.text)))) * (seg.end -
// seg.start), clamped to [seg.start, seg.end]. The char offset must come from the
// same normalised space as the match (see mapQuoteToOffset) so start and end stay
// consistent. A segment with no/zero duration collapses to seg.start.
function interpTime(seg, charOff, normLen) {
  const start = seg.start;
  let end = seg.end;
  if (end == null || !Number.isFinite(end)) end = start;
  if (!(end > start)) return start;
  const denom = Math.max(1, normLen);
  const frac = Math.min(1, Math.max(0, charOff / denom));
  const t = start + frac * (end - start);
  return Math.min(end, Math.max(start, t));
}

// Resolve one gepa-mode span ({type,subtype,start_quote,end_quote}) to a cut over
// the absolute segment list. Returns null to SKIP (quote-map fail on the opening
// line - fail safe to no-cut, exactly like legacy), or a cut descriptor
//   { startIndex, endIndex, startSec, endSec, needsReview, reasons, type, subtype }.
// The HARD GUARD (GPT-5 spec) flags needsReview - never auto-applies - when ANY of:
//   - the mapped span duration > HARD_AUTOCUT_MAX_SEC (independent of sensitivity);
//   - the quote map was fuzzy/prefix/non-exact OR matched more than one segment;
//   - start and end map to the SAME long (>= LONG_TURN_MIN_SEC) segment and the
//     span covers most (>= LONG_TURN_COVER_FRAC) of it;
//   - end <= start after interpolation (fall back to the whole [si.start, sj.end]
//     span AND flag).
// TYPE POLICY: type "ad" is auto-cut-eligible (still subject to the guard +
// classifyRange); intro/outro/housekeeping are forced needsReview (held) because
// sync.cjs edge-snaps near-edge blocks to 0/end regardless of type. The full guard
// is the UNION with classifyRange's own needs-review logic.
function mapGepaSpan({
  span, segments, normSegs, idxList, needsReviewMaxSec,
}) {
  const rawType = span && span.type != null ? String(span.type).trim().toLowerCase() : "";
  const type = GEPA_VALID_TYPES.has(rawType) ? rawType : "ad";
  const subtype = span && span.subtype != null ? span.subtype : null;
  const startQuote = span && span.start_quote != null ? span.start_quote : "";
  const endQuote = span && span.end_quote != null ? span.end_quote : "";

  const flags = {};
  const startMap = mapQuoteToOffset(startQuote, normSegs, idxList, flags);
  if (!startMap) return null; // opening line maps nowhere - SKIP (never cut)

  const reasons = [];
  let inexact = !startMap.exact;

  // End quote. If it maps nowhere we fall back to the start segment (single-segment
  // span) and flag the boundary ambiguous, mirroring the legacy ei = si fallback.
  let endMap = mapQuoteToOffset(endQuote, normSegs, idxList, flags);
  let endQuoteMapped = true;
  if (!endMap || endMap.si < startMap.si) {
    endQuoteMapped = false;
    endMap = { si: startMap.si, charOff: (normSegs[startMap.si] || "").length, exact: false };
  }
  if (!endMap.exact) inexact = true;

  const si = startMap.si;
  const sj = endMap.si;
  const startSeg = segments[si];
  const endSeg = segments[sj];
  const startNormLen = (normSegs[si] || "").length;
  const endNormLen = (normSegs[sj] || "").length;

  // Char-interpolated boundaries. The end offset is the END of the matched end_quote
  // (offset + its normalised length) so the cut closes after the quoted sentence.
  let startSec = interpTime(startSeg, startMap.charOff, startNormLen);
  const endCharOffEnd = endMap.charOff + norm(endQuote).length;
  let endSec = interpTime(endSeg, endCharOffEnd, endNormLen);

  // If interpolation produced a non-positive span, fall back to the whole-segment
  // span [si.start, sj.end] and flag - we never emit an inverted/zero cut.
  if (!(endSec > startSec)) {
    startSec = startSeg.start;
    endSec = endSeg.end != null && Number.isFinite(endSeg.end) ? endSeg.end : endSeg.start;
    reasons.push("interp-degenerate");
  }

  // Guard branches (union with classifyRange below).
  const durationSec = endSec - startSec;
  if (Number.isFinite(durationSec) && durationSec > HARD_AUTOCUT_MAX_SEC) {
    reasons.push("hard-cap");
  }
  if (inexact) reasons.push("fuzzy-map");
  if (flags.nonUnique) reasons.push("non-unique-quote");
  // One ad filling most of a single long turn.
  if (si === sj) {
    const segEnd = endSeg.end != null && Number.isFinite(endSeg.end) ? endSeg.end : endSeg.start;
    const segDur = segEnd - startSeg.start;
    if (Number.isFinite(segDur) && segDur >= LONG_TURN_MIN_SEC
        && Number.isFinite(durationSec) && durationSec >= LONG_TURN_COVER_FRAC * segDur) {
      reasons.push("long-turn-most");
    }
  }
  // intro/outro/housekeeping are never auto-cut (edge-snap magnification).
  if (type !== "ad") reasons.push(`type-${type}`);

  // Compose with the existing classifyRange needs-review logic - take the UNION.
  const cls = classifyRange({
    startIndex: si, endIndex: sj, segments, endQuoteMapped, needsReviewMaxSec,
  });
  for (const r of cls.reasons) if (!reasons.includes(r)) reasons.push(r);

  return {
    startIndex: si,
    endIndex: sj,
    startSec,
    endSec,
    needsReview: reasons.length > 0,
    reasons,
    type,
    subtype,
    // VERBATIM boundary claims (the model's start_quote/end_quote), carried as the
    // same provenance fields legacy emits. Additive only.
    firstLineQuote: startQuote,
    lastLineQuote: endQuote,
  };
}

// Derive a stable cut id from the cut's identity: a short hash of
// `startSec|endSec|label`. Deterministic and order-independent, so the same
// proposal always yields the same id across re-runs. Seconds are rounded to the
// millisecond before hashing so floating-point noise from char-interpolation does
// not change the id. This is the BASE id; collisions (two cuts sharing identity in
// one episode) are suffixed by the caller (see assignCutIds in sync.cjs).
function cutId(startSec, endSec, label) {
  const s = Number.isFinite(startSec) ? Math.round(startSec * 1000) : "x";
  const e = Number.isFinite(endSec) ? Math.round(endSec * 1000) : "x";
  const l = typeof label === "string" ? label : "";
  return crypto.createHash("sha1").update(`${s}|${e}|${l}`).digest("hex").slice(0, 8);
}

// Detect ads across the whole transcript. Returns:
//   {
//     ads: [{ startIndex, endIndex, startSec, endSec, needsReview, reasons }],
//     stats: {
//       windowsRun, adsReturned, quoteMapFailures,
//       windowsFailed, failureReasons, degraded,
//     },
//   }
// `windowsFailed` / `failureReasons` / `degraded` are informational only - a failed
// window is skipped exactly as before, so the cut set is unchanged. Each ad is a
// contiguous segment-index range. On any catastrophic failure (no transcript, no
// fetch) it returns an empty ads list - no cuts. Per-window and per-ad failures are
// isolated so one bad window never loses the rest.
async function detectAds({
  transcript,
  // Default to the process global fetch. Previously this was undefined when the
  // caller forgot to inject it, which made detectAds silently return zero ads.
  fetch = (typeof globalThis !== "undefined" && typeof globalThis.fetch === "function")
    ? globalThis.fetch.bind(globalThis)
    : undefined,
  url = LMSTUDIO_URL,
  model = LMSTUDIO_MODEL,
  timeoutMs = LMSTUDIO_TIMEOUT_MS,
  // needs-review duration threshold (P4b sensitivity). Only tunes which clean cuts
  // are auto-applied vs flagged; never weakens the cardinal rule or the quote-map
  // fail-safe. Falls back to the locked default inside classifyRange.
  needsReviewMaxSec,
  // Detector mode: "legacy" (DEFAULT - the locked VERIFY_INSTRUCTION + ADS_SCHEMA +
  // whole-segment mapping, unchanged) or "gepa" (the GEPA champion first-pass +
  // char-interpolation mapping + hard guard). Unset -> OSW_DETECTOR_MODE env ->
  // "legacy". sync.cjs never passes this, so the deployed pipeline stays legacy.
  mode,
  signal,
} = {}) {
  const detectorMode = resolveMode(mode);
  const empty = {
    ads: [],
    stats: {
      windowsRun: 0, adsReturned: 0, quoteMapFailures: 0,
      windowsFailed: 0, windowsTruncated: 0, failureReasons: {}, degraded: false,
    },
  };

  const segments = toSegments(transcript);
  if (segments.length === 0) {
    logEvent("detect", "no usable segments in transcript - 0 cuts (was this transcript empty?)");
    return empty;
  }
  if (typeof fetch !== "function") {
    logEvent("detect", "no fetch available - 0 cuts (LLM unreachable / fetch not injected)");
    return empty;
  }

  // Precompute normalised segment text, aligned by absolute index.
  const normSegs = segments.map((s) => norm(s.text));

  const windows = buildWindows(segments);

  // Collect ad ranges keyed by "start-end" so the same ad seen in two overlapping
  // windows is not added twice.
  const seen = new Map();
  let windowsRun = 0;
  let adsReturned = 0;
  let quoteMapFailures = 0;
  let windowsFailed = 0;
  let windowsTruncated = 0;
  const failureReasons = {};
  const noteReason = (reason) => {
    failureReasons[reason] = (failureReasons[reason] || 0) + 1;
  };
  // Record a SKIPPED window (one that produced no usable ads), once, by reason.
  // Additive bookkeeping - the control flow below still just skips the window, so
  // the cut set is unchanged.
  const noteFailure = (reason) => {
    windowsFailed += 1;
    noteReason(reason);
  };
  // Record a window that DID produce usable ads but whose response was truncated
  // (max_tokens). Its ads are still applied below; this only marks the run degraded
  // so the "detection may be incomplete" warning surfaces. Counted separately from
  // windowsFailed, which keeps its meaning "windows skipped with no usable ads".
  const noteTruncatedButUsed = () => {
    windowsTruncated += 1;
    noteReason("truncated");
  };

  for (const wsegs of windows) {
    windowsRun += 1;
    // Window line format depends on the mode. legacy: "<index>. <text>" (the model
    // quotes back the text, not the index). gepa: "#<idx> [mm:ss] <speaker>: <text>"
    // (the GEPA format the seed_checklist prompt expects). In both, the quote is
    // mapped via normSegs so the prefix is only for the model to reason over order.
    const lines = detectorMode === "gepa"
      ? wsegs.map((i) => gepaLine(i, segments[i]))
      : wsegs.map((i) => `${i}. ${segments[i].text}`);

    let outcome;
    try {
      outcome = await callModel({ lines, fetch, url, model, timeoutMs, signal, mode: detectorMode });
    } catch {
      // callModel is contracted never to throw; this guard only catches an
      // implementation bug, so it is bucketed as http (not as model pressure) and
      // the window is skipped - one bad window must never abort the episode.
      outcome = { ok: false, reason: "http" };
    }
    if (!outcome || !outcome.ok) {
      // A failed window is skipped exactly as before; we now also record WHY so a
      // degraded run is not invisible (the silent "looks like no ads" path).
      const reason = outcome && outcome.reason ? outcome.reason : "http";
      noteFailure(reason);
      logEvent("detect", `window ${windowsRun}/${windows.length}: model returned nothing (${reason})`);
      continue;
    }
    const parsed = outcome.parsed;
    const list = detectorMode === "gepa"
      ? (parsed && Array.isArray(parsed.spans) ? parsed.spans : null)
      : (parsed && Array.isArray(parsed.ads) ? parsed.ads : null);
    if (!list) {
      // Parsed JSON missing the expected ads/spans array. The strict json_schema
      // makes this rare, but it is not a runtime guarantee, so count the wrong-shape
      // window as a parse-error and skip it.
      noteFailure("parse-error");
      logEvent("detect", `window ${windowsRun}/${windows.length}: parsed but no ${detectorMode === "gepa" ? "spans" : "ads"} array (parse-error)`);
      continue;
    }

    if (outcome.truncated) {
      // The list parsed and its ads ARE used below, but the model hit max_tokens, so
      // the reply may have been cut before listing every ad. Flag the run degraded
      // without dropping any ad. Recorded only here, AFTER the wrong-shape skip, so a
      // truncated-but-unusable window stays a parse-error failure, not a used window.
      noteTruncatedButUsed();
      logEvent("detect", `window ${windowsRun}/${windows.length}: used ads but response was truncated (detection may be incomplete)`);
    }

    if (detectorMode === "gepa") {
      for (const span of list) {
        adsReturned += 1;
        const cut = mapGepaSpan({ span, segments, normSegs, idxList: wsegs, needsReviewMaxSec });
        if (cut == null) {
          // Quote-map failure on the OPENING line - cannot place the span. SKIP it
          // entirely (fail safe to no-cut), exactly like legacy.
          quoteMapFailures += 1;
          continue;
        }
        const key = `${cut.startIndex}-${cut.endIndex}`;
        const prev = seen.get(key);
        if (!prev) {
          seen.set(key, cut);
        } else {
          // De-dupe across overlapping windows. The merged cut is SAFE: needsReview
          // if EITHER sighting was (OR the flags), and the UNION of both sightings'
          // reasons. A second, unflagged sighting must NEVER clear a flag the first
          // set (cardinal rule), and vice-versa. We keep prev's geometry (same key
          // == same index range, so startSec/endSec already agree) and only widen
          // its review status.
          const mergedReasons = [...prev.reasons];
          for (const r of cut.reasons) if (!mergedReasons.includes(r)) mergedReasons.push(r);
          prev.needsReview = prev.needsReview || cut.needsReview;
          prev.reasons = mergedReasons;
        }
      }
      continue;
    }

    for (const ad of list) {
      adsReturned += 1;
      const fl = ad && ad.first_line != null ? ad.first_line : "";
      const ll = ad && ad.last_line != null ? ad.last_line : "";

      const si = findSeg(fl, normSegs, wsegs);
      if (si == null) {
        // Quote-map failure on the OPENING line - we cannot place the ad. Skip it
        // entirely (fail safe to no-cut). Never trim audio we cannot reason about.
        quoteMapFailures += 1;
        continue;
      }
      let endQuoteMapped = true;
      let ei = findSeg(ll, normSegs, wsegs);
      if (ei == null) {
        // The closing line did not map. Do not drop the ad - fall back to a single
        // segment span (the reference does ei = si) but mark the boundary ambiguous
        // so the range is flagged needs-review rather than auto-cut.
        endQuoteMapped = false;
        ei = si;
      }
      if (ei < si) ei = si;

      const key = `${si}-${ei}`;
      if (seen.has(key)) {
        // Same range from another window. If THIS sighting is the one with a clean
        // boundary (endQuoteMapped) and the kept one was not, upgrade the kept entry
        // AND adopt this sighting's quotes - so the clean classification is paired
        // with the quotes that actually produced it, not an earlier unmatched pair.
        // Otherwise keep the first sighting's values (deterministic - windows iterate
        // in order).
        const prev = seen.get(key);
        if (endQuoteMapped && !prev.endQuoteMapped) {
          prev.endQuoteMapped = true;
          prev.firstLineQuote = fl;
          prev.lastLineQuote = ll;
        }
        continue;
      }
      // firstLineQuote/lastLineQuote are the model's VERBATIM boundary claims (fl/ll
      // before any normalisation) - provenance for the renderer. Additive only; the
      // index range, endQuoteMapped and downstream classification are unchanged.
      seen.set(key, { startIndex: si, endIndex: ei, endQuoteMapped, firstLineQuote: fl, lastLineQuote: ll });
    }
  }

  // gepa mode: each `seen` entry is already a complete cut (mapped + guarded during
  // mapGepaSpan). Just sort. legacy mode: classify each collected range here, as
  // before (this path is byte-for-byte unchanged).
  const ads = detectorMode === "gepa"
    ? [...seen.values()].sort((a, b) => a.startIndex - b.startIndex)
    : [...seen.values()]
      .sort((a, b) => a.startIndex - b.startIndex)
      .map(({ startIndex, endIndex, endQuoteMapped, firstLineQuote, lastLineQuote }) => {
        const { needsReview, reasons } = classifyRange({
          startIndex, endIndex, segments, endQuoteMapped, needsReviewMaxSec,
        });
        const startSeg = segments[startIndex];
        const endSeg = segments[endIndex];
        let endSec = endSeg.end;
        if (endSec == null) {
          endSec = endIndex + 1 < segments.length ? segments[endIndex + 1].start : endSeg.start;
        }
        return {
          startIndex,
          endIndex,
          startSec: startSeg.start,
          endSec,
          needsReview,
          reasons,
          firstLineQuote,
          lastLineQuote,
        };
      });

  logEvent("detect", `done [${detectorMode}]: ${windowsRun}/${windows.length} windows, ${windowsFailed} failed, ${windowsTruncated} truncated-but-used, ${adsReturned} raw ads, ${quoteMapFailures} quote-map fails -> ${ads.length} final cut(s)`);
  return {
    ads,
    stats: {
      windowsRun,
      adsReturned,
      quoteMapFailures,
      windowsFailed,
      windowsTruncated,
      failureReasons,
      // A truncated-but-used window produced ads but hit max_tokens, so its reply may
      // have been cut before every ad was listed. That degrades the run just like a
      // fully failed window.
      degraded: windowsFailed > 0 || windowsTruncated > 0,
    },
  };
}

module.exports = {
  detectAds,
  norm,
  extractContent,
  extractJson,
  findSeg,
  toSegments,
  buildWindows,
  classifyRange,
  cutId,
  callModel,
  classifyModelOutcome,
  readCappedBody,
  // gepa mode (selectable; legacy stays the default)
  resolveMode,
  gepaLine,
  mapQuoteToOffset,
  interpTime,
  mapGepaSpan,
  GEPA_INSTRUCTION,
  SPANS_SCHEMA,
  HARD_AUTOCUT_MAX_SEC,
  LONG_TURN_MIN_SEC,
  LONG_TURN_COVER_FRAC,
  VERIFY_INSTRUCTION,
  ADS_SCHEMA,
  LMSTUDIO_URL,
  LMSTUDIO_MODEL,
  WIN,
  STRIDE,
  NEEDS_REVIEW_MAX_SEC,
};
