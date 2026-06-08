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

const LMSTUDIO_URL = "http://localhost:1234/v1/chat/completions";
const LMSTUDIO_MODEL = "google/gemma-4-12b-qat";
const LMSTUDIO_TIMEOUT_MS = 10 * 60 * 1000;

// Windowing constants - identical to the locked reference.
const WIN = 1800.0; // 30-minute window
const STRIDE = 1620.0; // 27-minute step => 3-minute overlap

// Needs-review threshold: a cut longer than this (in seconds) is flagged for
// review instead of auto-applied. Starting heuristic from BUILD_PLAN.md, tunable.
const NEEDS_REVIEW_MAX_SEC = 150; // ~2.5 minutes

// The prompt is identical in spirit to the reference VERIFY_INSTRUCTION. Kept
// verbatim so the detector behaves exactly as the locked evaluation proved.
const VERIFY_INSTRUCTION = `You are given a WINDOW of consecutive podcast transcript segments, each line prefixed with its index. Some windows contain one or more READ ADVERTISEMENTS, sponsor messages, or cross-promos for another show; many do not, and some contain several.

Find EVERY genuine ad / sponsor / promo read in this window. For EACH one, return its boundaries as VERBATIM quotes copied exactly from the segment text:
- first_line = the exact sentence where the hosts pivot from conversation INTO the ad (often "our show today is brought to you by X", or the opening line of the pitch).
- last_line = the exact LAST promotional sentence of that same ad - the URL, the discount code, or the sign-off ("thanks to X for supporting the show"). The ad ENDS there. The instant the hosts resume the actual topic or banter ("we're back", "so anyway", returning to the subject), that is CONTENT and must NOT be included.

RULES:
- Catch ALL of them - a 30-minute window may contain two or three separate ad reads; return one entry per ad.
- A cross-promo for another podcast or show counts as an ad/promo even with no URL or discount code - include it.
- A passing mention of a brand, product, or website during normal conversation is NOT an ad - do not include it.
- Quote EXACTLY from the provided text (so the lines can be found by string match). Copy a full distinctive sentence, not a fragment.
- If there is NO actual ad read in this window, return {"ads":[]}. When in doubt, return [] - never invent an ad in normal conversation.

EXAMPLE window:
40. and honestly that ending wrecked me, best film of the year.
41. Our show today is brought to you by Acme VPN. Going online without protection is like leaving your door unlocked.
42. Acme encrypts everything. Visit Acme.com slash show for three months free.
43. We're back. So anyway, where were we on the Scorsese thing?
CORRECT OUTPUT: {"ads":[{"first_line":"Our show today is brought to you by Acme VPN.","last_line":"Visit Acme.com slash show for three months free."}]}
(Segment 43 is content - the hosts resumed the topic - so it is excluded.)`;

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

// Call the LLM for one window. Returns the parsed object ({ads:[...]}) or null on
// any failure (network, non-ok, unparseable). Degrades safely; never throws.
async function callModel({
  lines, fetch, url, model, timeoutMs, signal,
}) {
  if (typeof fetch !== "function") return null;
  const user = lines.join("\n");

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
    response_format: ADS_SCHEMA,
    messages: [
      { role: "system", content: VERIFY_INSTRUCTION },
      { role: "user", content: user },
    ],
  };

  try {
    const res = await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
      signal: controller ? controller.signal : undefined,
    });
    if (!res || !res.ok) return null;
    const data = await res.json();
    return extractJson(extractContent(data));
  } catch {
    return null;
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

// Detect ads across the whole transcript. Returns:
//   {
//     ads: [{ startIndex, endIndex, startSec, endSec, needsReview, reasons }],
//     stats: { windowsRun, adsReturned, quoteMapFailures },
//   }
// where each ad is a contiguous segment-index range. On any catastrophic failure
// (no transcript, no fetch) it returns an empty ads list - no cuts. Per-window and
// per-ad failures are isolated so one bad window never loses the rest.
async function detectAds({
  transcript,
  fetch,
  url = LMSTUDIO_URL,
  model = LMSTUDIO_MODEL,
  timeoutMs = LMSTUDIO_TIMEOUT_MS,
  // needs-review duration threshold (P4b sensitivity). Only tunes which clean cuts
  // are auto-applied vs flagged; never weakens the cardinal rule or the quote-map
  // fail-safe. Falls back to the locked default inside classifyRange.
  needsReviewMaxSec,
  signal,
} = {}) {
  const empty = { ads: [], stats: { windowsRun: 0, adsReturned: 0, quoteMapFailures: 0 } };

  const segments = toSegments(transcript);
  if (segments.length === 0) return empty;
  if (typeof fetch !== "function") return empty;

  // Precompute normalised segment text, aligned by absolute index.
  const normSegs = segments.map((s) => norm(s.text));

  const windows = buildWindows(segments);

  // Collect ad ranges keyed by "start-end" so the same ad seen in two overlapping
  // windows is not added twice.
  const seen = new Map();
  let windowsRun = 0;
  let adsReturned = 0;
  let quoteMapFailures = 0;

  for (const wsegs of windows) {
    windowsRun += 1;
    // Lines as "<index>. <text>" - the model quotes back the text, not the index,
    // and we map via normSegs, so the absolute index prefix is just for the model
    // to reason over the window order.
    const lines = wsegs.map((i) => `${i}. ${segments[i].text}`);

    let parsed = null;
    try {
      parsed = await callModel({ lines, fetch, url, model, timeoutMs, signal });
    } catch {
      // callModel already swallows its own errors, but guard anyway - one bad
      // window must never abort the rest of the episode.
      parsed = null;
    }
    if (!parsed || !Array.isArray(parsed.ads)) continue;

    for (const ad of parsed.ads) {
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
        // Same range from another window. If either sighting had a clean boundary,
        // keep the clean classification.
        if (endQuoteMapped) seen.get(key).endQuoteMapped = true;
        continue;
      }
      seen.set(key, { startIndex: si, endIndex: ei, endQuoteMapped });
    }
  }

  const ads = [...seen.values()]
    .sort((a, b) => a.startIndex - b.startIndex)
    .map(({ startIndex, endIndex, endQuoteMapped }) => {
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
      };
    });

  return { ads, stats: { windowsRun, adsReturned, quoteMapFailures } };
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
  callModel,
  VERIFY_INSTRUCTION,
  ADS_SCHEMA,
  LMSTUDIO_URL,
  LMSTUDIO_MODEL,
  WIN,
  STRIDE,
  NEEDS_REVIEW_MAX_SEC,
};
