import { describe, it, expect, vi, afterEach } from "vitest";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const {
  detectAds,
  norm,
  extractContent,
  extractJson,
  findSeg,
  toSegments,
  buildWindows,
  classifyRange,
  cutId,
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
} = require("./detectAds.cjs");

// A fake fetch that returns a chat-completion shaped body carrying {ads:[...]}.
// By default the JSON is in message.content; pass { inReasoning: true } to put it
// in message.reasoning_content instead (the reasoning-build fallback path).
function fetchReturning(ads, { inReasoning = false, ok = true } = {}) {
  const payload = JSON.stringify({ ads });
  const message = inReasoning
    ? { content: "", reasoning_content: payload }
    : { content: payload };
  return vi.fn(async () => ({ ok, json: async () => ({ choices: [{ message }] }) }));
}

// A clean ad inside otherwise normal conversation. Short segment gaps so the whole
// thing sits in one window.
const AD_TRANSCRIPT = {
  segments: [
    { speaker: "SPEAKER_00", start: 0, end: 4, text: "And honestly that ending wrecked me, best film of the year." },
    { speaker: "SPEAKER_00", start: 4, end: 9, text: "Our show today is brought to you by Acme VPN." },
    { speaker: "SPEAKER_00", start: 9, end: 14, text: "Acme encrypts everything. Visit Acme dot com slash show for three months free." },
    { speaker: "SPEAKER_01", start: 14, end: 18, text: "We're back. So anyway, where were we on the Scorsese thing?" },
  ],
};

describe("norm()", () => {
  it("lowercases, strips speaker prefix and punctuation, collapses whitespace", () => {
    expect(norm("SPEAKER_03:  Hello,   World!! ")).toBe("hello world");
  });
  it("returns '' for nullish", () => {
    expect(norm(null)).toBe("");
  });
});

describe("extractContent()", () => {
  it("reads message.content", () => {
    expect(extractContent({ choices: [{ message: { content: "hi" } }] })).toBe("hi");
  });
  it("falls back to reasoning_content when content is empty", () => {
    expect(extractContent({ choices: [{ message: { content: "", reasoning_content: "deep" } }] })).toBe("deep");
  });
  it("returns '' when nothing usable", () => {
    expect(extractContent({})).toBe("");
  });
});

describe("extractJson()", () => {
  it("parses clean JSON", () => {
    expect(extractJson('{"ads":[]}')).toEqual({ ads: [] });
  });
  it("digs JSON out of prose wrapping", () => {
    expect(extractJson('thinking... {"ads":[{"first_line":"a","last_line":"b"}]} done'))
      .toEqual({ ads: [{ first_line: "a", last_line: "b" }] });
  });
  it("returns null for garbage", () => {
    expect(extractJson("no json here")).toBeNull();
    expect(extractJson("")).toBeNull();
  });
});

describe("findSeg()", () => {
  const segs = [
    null,
    norm("Our show today is brought to you by Acme VPN."),
    norm("Visit Acme dot com slash show for three months free."),
  ];
  it("maps an exact quote to its segment index", () => {
    expect(findSeg("Our show today is brought to you by Acme VPN.", segs, [1, 2])).toBe(1);
  });
  it("returns null when the quote matches no segment", () => {
    expect(findSeg("This sentence never appears anywhere", segs, [1, 2])).toBeNull();
  });
  it("matches on a shared multi-word prefix when not an exact substring", () => {
    expect(findSeg("Visit Acme dot com slash show for a totally different deal", segs, [1, 2])).toBe(2);
  });
});

describe("buildWindows()", () => {
  it("uses WIN=1800 / STRIDE=1620 (30-min window, 3-min overlap)", () => {
    expect(WIN).toBe(1800.0);
    expect(STRIDE).toBe(1620.0);
  });
  it("puts a short episode in a single window", () => {
    const segs = toSegments(AD_TRANSCRIPT);
    const wins = buildWindows(segs);
    expect(wins.length).toBe(1);
    expect(wins[0]).toEqual([0, 1, 2, 3]);
  });
  it("splits a long episode and overlaps the 3-min seam", () => {
    // Segments at 0, 1610, 1700, 3300s. With STRIDE=1620 the second window starts
    // at 1620s, so the 1610s segment is only in window 0 and the 1700s segment is
    // in both windows (it sits in the 3-min overlap region 1620..1800).
    const segments = [
      { start: 0, end: 5, text: "alpha one" },
      { start: 1610, end: 1615, text: "beta two" },
      { start: 1700, end: 1705, text: "gamma three" },
      { start: 3300, end: 3305, text: "delta four" },
    ];
    const wins = buildWindows(segments);
    expect(wins.length).toBeGreaterThanOrEqual(2);
    expect(wins[0]).toContain(0);
    expect(wins[0]).toContain(1);
    expect(wins[0]).toContain(2);
    // 1700s segment overlaps into the second window too.
    expect(wins[1]).toContain(2);
    expect(wins[1]).not.toContain(1);
  });
});

describe("classifyRange()", () => {
  const segments = [
    { start: 0, end: 4, text: "a" },
    { start: 4, end: 30, text: "b" },
    { start: 30, end: 400, text: "c" },
  ];
  it("auto-applies a clean short whole-segment range", () => {
    const r = classifyRange({ startIndex: 0, endIndex: 1, segments, endQuoteMapped: true });
    expect(r.needsReview).toBe(false);
    expect(r.reasons).toEqual([]);
  });
  it("flags needs-review when the end boundary did not map", () => {
    const r = classifyRange({ startIndex: 0, endIndex: 1, segments, endQuoteMapped: false });
    expect(r.needsReview).toBe(true);
    expect(r.reasons).toContain("ambiguous-boundary");
  });
  it("flags needs-review when the cut exceeds the threshold", () => {
    const r = classifyRange({ startIndex: 0, endIndex: 2, segments, endQuoteMapped: true });
    expect(r.needsReview).toBe(true);
    expect(r.reasons).toContain("over-threshold");
    expect(NEEDS_REVIEW_MAX_SEC).toBe(300);
  });
});

// P4b - sensitivity setting. needsReviewMaxSec only tunes the over-threshold
// check; it can never weaken the cardinal rule (ambiguous boundary always flagged)
// nor the quote-map fail-safe (that lives in detectAds(), tested separately below).
describe("classifyRange() - P4b sensitivity threshold tuning", () => {
  // A clean, well-mapped cut spanning 0 -> 120s (2 minutes). At the locked default
  // (150s) it auto-applies; a conservative (lower) threshold flags it; an
  // aggressive (higher) threshold still auto-applies it.
  const segments = [
    { start: 0, end: 4, text: "a" },
    { start: 4, end: 120, text: "b" },
    { start: 120, end: 400, text: "c" },
  ];

  it("conservative (lower threshold) flags a borderline clean cut that the default auto-applies", () => {
    const dflt = classifyRange({ startIndex: 0, endIndex: 1, segments, endQuoteMapped: true });
    expect(dflt.needsReview).toBe(false); // 120s < 150s default -> auto-apply

    const conservative = classifyRange({
      startIndex: 0, endIndex: 1, segments, endQuoteMapped: true, needsReviewMaxSec: 90,
    });
    expect(conservative.needsReview).toBe(true); // 120s > 90s -> flagged
    expect(conservative.reasons).toContain("over-threshold");
  });

  it("aggressive (higher threshold) keeps auto-applying a cut the default would flag", () => {
    const longSegs = [
      { start: 0, end: 4, text: "a" },
      { start: 4, end: 330, text: "b" }, // 330s span
    ];
    const dflt = classifyRange({ startIndex: 0, endIndex: 1, segments: longSegs, endQuoteMapped: true });
    expect(dflt.needsReview).toBe(true); // 330s > 300s default -> flagged

    const aggressive = classifyRange({
      startIndex: 0, endIndex: 1, segments: longSegs, endQuoteMapped: true, needsReviewMaxSec: 360,
    });
    expect(aggressive.needsReview).toBe(false); // 330s < 360s -> auto-apply
  });

  it("an invalid / non-positive threshold falls back to the locked default", () => {
    for (const bad of [undefined, null, 0, -10, NaN, Infinity, "150"]) {
      const r = classifyRange({
        startIndex: 0, endIndex: 1, segments, endQuoteMapped: true, needsReviewMaxSec: bad,
      });
      // 120s < 150s default -> auto-apply, proving fallback to default not "off".
      expect(r.needsReview).toBe(false);
    }
    // And the default still flags an over-150s cut even with a bad threshold.
    const over = classifyRange({
      startIndex: 0, endIndex: 2, segments, endQuoteMapped: true, needsReviewMaxSec: 0,
    });
    expect(over.needsReview).toBe(true);
    expect(over.reasons).toContain("over-threshold");
  });

  it("CARDINAL: aggressive NEVER overrides an ambiguous boundary", () => {
    // Even with a huge aggressive threshold, an unmapped end boundary is flagged.
    const r = classifyRange({
      startIndex: 0, endIndex: 1, segments, endQuoteMapped: false, needsReviewMaxSec: 100000,
    });
    expect(r.needsReview).toBe(true);
    expect(r.reasons).toContain("ambiguous-boundary");
  });
});

describe("detectAds() - P4b sensitivity threading and fail-safes", () => {
  // A transcript with an ad that spans 0 -> 120s (2 minutes), clean boundaries.
  const borderlineAd = {
    segments: [
      { speaker: "S", start: 0, end: 5, text: "Our show today is brought to you by Acme VPN." },
      { speaker: "S", start: 5, end: 120, text: "Visit Acme dot com slash show for three months free." },
      { speaker: "S", start: 120, end: 300, text: "We're back, so anyway where were we." },
    ],
  };
  const adQuotes = [{
    first_line: "Our show today is brought to you by Acme VPN.",
    last_line: "Visit Acme dot com slash show for three months free.",
  }];

  it("conservative threshold flags a clean cut that the default auto-applies", async () => {
    const dflt = await detectAds({ transcript: borderlineAd, fetch: fetchReturning(adQuotes) });
    expect(dflt.ads).toHaveLength(1);
    expect(dflt.ads[0].needsReview).toBe(false);

    const conservative = await detectAds({
      transcript: borderlineAd, fetch: fetchReturning(adQuotes), needsReviewMaxSec: 90,
    });
    expect(conservative.ads).toHaveLength(1);
    expect(conservative.ads[0].needsReview).toBe(true);
    expect(conservative.ads[0].reasons).toContain("over-threshold");
  });

  it("aggressive threshold auto-applies a cut the default would flag", async () => {
    const longAd = {
      segments: [
        { speaker: "S", start: 0, end: 5, text: "Our show today is brought to you by Acme VPN." },
        { speaker: "S", start: 5, end: 330, text: "Visit Acme dot com slash show for three months free." },
        { speaker: "S", start: 330, end: 500, text: "We're back, so anyway where were we." },
      ],
    };
    const dflt = await detectAds({ transcript: longAd, fetch: fetchReturning(adQuotes) });
    expect(dflt.ads[0].needsReview).toBe(true); // 330s > 300s default

    const aggressive = await detectAds({
      transcript: longAd, fetch: fetchReturning(adQuotes), needsReviewMaxSec: 360,
    });
    expect(aggressive.ads[0].needsReview).toBe(false); // 330s < 360s
  });

  it("CARDINAL: aggressive NEVER auto-applies a quote-map-failed ad - it is skipped entirely", async () => {
    // The first_line quote does not appear in any segment -> the ad cannot be
    // placed -> it must be SKIPPED (no cut), at ANY sensitivity.
    const unmappable = [{
      first_line: "This sentence appears nowhere in the transcript at all.",
      last_line: "Neither does this one, friend.",
    }];
    const aggressive = await detectAds({
      transcript: borderlineAd, fetch: fetchReturning(unmappable), needsReviewMaxSec: 100000,
    });
    expect(aggressive.ads).toHaveLength(0); // skipped - never auto-applied
    expect(aggressive.stats.quoteMapFailures).toBe(1);
  });

  it("CARDINAL: aggressive NEVER auto-applies an ambiguous-boundary cut", async () => {
    // first_line maps, last_line does NOT -> endQuoteMapped false -> flagged
    // ambiguous, never cut, even with a huge aggressive threshold.
    const ambiguous = [{
      first_line: "Our show today is brought to you by Acme VPN.",
      last_line: "A closing line that is nowhere in the transcript.",
    }];
    const aggressive = await detectAds({
      transcript: borderlineAd, fetch: fetchReturning(ambiguous), needsReviewMaxSec: 100000,
    });
    expect(aggressive.ads).toHaveLength(1);
    expect(aggressive.ads[0].needsReview).toBe(true);
    expect(aggressive.ads[0].reasons).toContain("ambiguous-boundary");
  });
});

describe("detectAds()", () => {
  it("posts the locked model, prompt and strict json_schema", async () => {
    const fetch = fetchReturning([]);
    await detectAds({ transcript: AD_TRANSCRIPT, fetch });
    expect(fetch).toHaveBeenCalledTimes(1);
    const [url, opts] = fetch.mock.calls[0];
    expect(url).toBe(LMSTUDIO_URL);
    expect(opts.method).toBe("POST");
    const body = JSON.parse(opts.body);
    expect(body.model).toBe(LMSTUDIO_MODEL);
    expect(body.temperature).toBe(0);
    expect(body.response_format).toEqual(ADS_SCHEMA);
    expect(body.response_format.json_schema.strict).toBe(true);
    expect(body.messages[0].role).toBe("system");
    expect(body.messages[0].content).toBe(VERIFY_INSTRUCTION);
  });

  it("maps a clean ad to the right segment-index range", async () => {
    const fetch = fetchReturning([
      {
        first_line: "Our show today is brought to you by Acme VPN.",
        last_line: "Visit Acme dot com slash show for three months free.",
      },
    ]);
    const { ads, stats } = await detectAds({ transcript: AD_TRANSCRIPT, fetch });
    expect(ads.length).toBe(1);
    expect(ads[0].startIndex).toBe(1);
    expect(ads[0].endIndex).toBe(2);
    expect(ads[0].startSec).toBe(4);
    expect(ads[0].endSec).toBe(14);
    // Clean, short, whole-segment boundary -> auto-applyable.
    expect(ads[0].needsReview).toBe(false);
    expect(stats.adsReturned).toBe(1);
    expect(stats.quoteMapFailures).toBe(0);
  });

  it("ZERO false positives: a content-only window yields no ads", async () => {
    const fetch = fetchReturning([]);
    const { ads, stats } = await detectAds({ transcript: AD_TRANSCRIPT, fetch });
    expect(ads).toEqual([]);
    expect(stats.adsReturned).toBe(0);
    expect(stats.quoteMapFailures).toBe(0);
  });

  it("skips (does not crash on) an ad whose first_line maps to no segment", async () => {
    const fetch = fetchReturning([
      { first_line: "This opening line does not exist anywhere", last_line: "nor does this one" },
    ]);
    const { ads, stats } = await detectAds({ transcript: AD_TRANSCRIPT, fetch });
    expect(ads).toEqual([]); // skipped - fail safe to no-cut
    expect(stats.adsReturned).toBe(1);
    expect(stats.quoteMapFailures).toBe(1);
  });

  it("flags needs-review (does not drop) when only the last_line fails to map", async () => {
    const fetch = fetchReturning([
      {
        first_line: "Our show today is brought to you by Acme VPN.",
        last_line: "A closing line the model invented that is not in the text",
      },
    ]);
    const { ads } = await detectAds({ transcript: AD_TRANSCRIPT, fetch });
    expect(ads.length).toBe(1);
    expect(ads[0].startIndex).toBe(1);
    expect(ads[0].endIndex).toBe(1); // fell back to a single-segment span
    expect(ads[0].needsReview).toBe(true);
    expect(ads[0].reasons).toContain("ambiguous-boundary");
  });

  it("uses the reasoning_content fallback path", async () => {
    const fetch = fetchReturning(
      [
        {
          first_line: "Our show today is brought to you by Acme VPN.",
          last_line: "Visit Acme dot com slash show for three months free.",
        },
      ],
      { inReasoning: true }
    );
    const { ads } = await detectAds({ transcript: AD_TRANSCRIPT, fetch });
    expect(ads.length).toBe(1);
    expect(ads[0].startIndex).toBe(1);
    expect(ads[0].endIndex).toBe(2);
  });

  it("degrades to no cuts when the LLM call fails", async () => {
    const fetch = vi.fn(async () => { throw new Error("ECONNREFUSED"); });
    const { ads, stats } = await detectAds({ transcript: AD_TRANSCRIPT, fetch });
    expect(ads).toEqual([]);
    expect(stats.windowsRun).toBe(1);
  });

  it("degrades to no cuts on a non-ok response", async () => {
    const fetch = fetchReturning([], { ok: false });
    const { ads } = await detectAds({ transcript: AD_TRANSCRIPT, fetch });
    expect(ads).toEqual([]);
  });

  it("degrades to no cuts on unparseable model output", async () => {
    const fetch = vi.fn(async () => ({ ok: true, json: async () => ({ choices: [{ message: { content: "not json" } }] }) }));
    const { ads } = await detectAds({ transcript: AD_TRANSCRIPT, fetch });
    expect(ads).toEqual([]);
  });

  it("returns no cuts and never calls fetch when there is no transcript", async () => {
    const fetch = fetchReturning([]);
    const { ads } = await detectAds({ transcript: null, fetch });
    expect(ads).toEqual([]);
    expect(fetch).not.toHaveBeenCalled();
  });

  it("returns no cuts when fetch is explicitly unavailable (guard still holds)", async () => {
    // detectAds defaults fetch to globalThis.fetch, so omitting it would try the
    // real LLM. Passing fetch:null exercises the no-fetch guard - it must fail
    // safe to zero cuts rather than throw.
    const { ads } = await detectAds({ transcript: AD_TRANSCRIPT, fetch: null });
    expect(ads).toEqual([]);
  });

  it("does not double-count the same ad seen in two overlapping windows", async () => {
    // Two windows both containing the ad segments. The ad maps to the same index
    // range from each window; the result must list it once.
    const segments = [
      { start: 0, end: 5, text: "intro chatter one" },
      { start: 1650, end: 1655, text: "Our show today is brought to you by Acme VPN." },
      { start: 1660, end: 1665, text: "Visit Acme dot com slash show for three months free." },
      { start: 1670, end: 1675, text: "We're back to the topic now." },
    ];
    // Segments at 1650/1660/1670 sit in both window 0 (0..1800) and window 1
    // (1620..3420), so the ad appears in two windows.
    const wins = buildWindows(segments);
    expect(wins.length).toBeGreaterThanOrEqual(2);
    const fetch = fetchReturning([
      {
        first_line: "Our show today is brought to you by Acme VPN.",
        last_line: "Visit Acme dot com slash show for three months free.",
      },
    ]);
    const { ads } = await detectAds({ transcript: { segments }, fetch });
    expect(ads.length).toBe(1);
    expect(ads[0].startIndex).toBe(1);
    expect(ads[0].endIndex).toBe(2);
  });

  it("isolates a bad window - other windows still produce ads", async () => {
    // Window 0 returns garbage (unparseable); window 1 returns a clean ad. The
    // clean ad must survive.
    const segments = [
      { start: 0, end: 5, text: "early chatter that is not an ad" },
      { start: 2000, end: 2005, text: "Our show today is brought to you by Acme VPN." },
      { start: 2010, end: 2015, text: "Visit Acme dot com slash show for three months free." },
    ];
    let call = 0;
    const fetch = vi.fn(async () => {
      call += 1;
      if (call === 1) {
        return { ok: true, json: async () => ({ choices: [{ message: { content: "garbage" } }] }) };
      }
      return {
        ok: true,
        json: async () => ({
          choices: [{
            message: {
              content: JSON.stringify({
                ads: [{
                  first_line: "Our show today is brought to you by Acme VPN.",
                  last_line: "Visit Acme dot com slash show for three months free.",
                }],
              }),
            },
          }],
        }),
      };
    });
    const { ads } = await detectAds({ transcript: { segments }, fetch });
    expect(fetch.mock.calls.length).toBeGreaterThanOrEqual(2);
    expect(ads.length).toBe(1);
    expect(ads[0].startIndex).toBe(1);
    expect(ads[0].endIndex).toBe(2);
  });
});

// =====================================================================================
// GEPA "gepa" mode (selectable; legacy is the default). The deployed pipeline keeps
// calling detectAds with the default (legacy), so these tests opt in via mode:"gepa"
// or OSW_DETECTOR_MODE. The legacy suite above pins zero regression.
// =====================================================================================

// A fake fetch returning a chat-completion body carrying {spans:[...]} (the gepa
// shape). Mirrors fetchReturning but for the SPANS schema.
function fetchSpans(spans, { inReasoning = false, ok = true } = {}) {
  const payload = JSON.stringify({ spans });
  const message = inReasoning
    ? { content: "", reasoning_content: payload }
    : { content: payload };
  return vi.fn(async () => ({ ok, json: async () => ({ choices: [{ message }] }) }));
}

describe("resolveMode()", () => {
  const saved = process.env.OSW_DETECTOR_MODE;
  afterEach(() => {
    if (saved === undefined) delete process.env.OSW_DETECTOR_MODE;
    else process.env.OSW_DETECTOR_MODE = saved;
  });
  it("defaults to legacy when unset and no env", () => {
    delete process.env.OSW_DETECTOR_MODE;
    expect(resolveMode(undefined)).toBe("legacy");
    expect(resolveMode("")).toBe("legacy");
  });
  it("honours an explicit mode option (case/space-insensitive)", () => {
    expect(resolveMode("gepa")).toBe("gepa");
    expect(resolveMode("  GEPA ")).toBe("gepa");
    expect(resolveMode("legacy")).toBe("legacy");
  });
  it("falls back to OSW_DETECTOR_MODE only when the option is unset", () => {
    process.env.OSW_DETECTOR_MODE = "gepa";
    expect(resolveMode(undefined)).toBe("gepa");
    // An explicit option always wins over the env.
    expect(resolveMode("legacy")).toBe("legacy");
  });
  it("an unknown value (option or env) falls back to legacy - never silently changes the shipped default", () => {
    expect(resolveMode("banana")).toBe("legacy");
    process.env.OSW_DETECTOR_MODE = "banana";
    expect(resolveMode(undefined)).toBe("legacy");
  });
});

describe("gepaLine()", () => {
  it("renders '#idx [mm:ss] speaker: text' from start + speaker", () => {
    expect(gepaLine(3, { start: 75, end: 80, speaker: "SPEAKER_02", text: "buy now" }))
      .toBe("#3 [01:15] SPEAKER_02: buy now");
  });
  it("falls back to SPEAKER when the speaker is missing", () => {
    expect(gepaLine(0, { start: 0, end: 2, text: "hello" }))
      .toBe("#0 [00:00] SPEAKER: hello");
  });
});

describe("interpTime()", () => {
  it("interpolates a time from a char offset within the segment", () => {
    // offset 50 of 100 chars over a 0..100s segment -> 50s.
    expect(interpTime({ start: 0, end: 100 }, 50, 100)).toBe(50);
  });
  it("clamps to the segment bounds and never divides by zero", () => {
    expect(interpTime({ start: 10, end: 20 }, 9999, 5)).toBe(20); // clamp high
    expect(interpTime({ start: 10, end: 20 }, -5, 5)).toBe(10); // clamp low
    // len 0 -> denom max(1,0)=1 -> frac = 3/1 = 3, clamped to 1 -> end of segment.
    expect(interpTime({ start: 10, end: 20 }, 3, 0)).toBe(20);
    expect(interpTime({ start: 5, end: 5 }, 3, 4)).toBe(5); // zero-duration segment
  });
});

describe("mapQuoteToOffset()", () => {
  const segText = "Our show today is brought to you by Acme VPN.";
  const normSegs = [null, norm(segText), norm("Visit acme dot com for a deal.")];
  it("maps an exact quote and reports its char offset + exact=true", () => {
    const out = {};
    const m = mapQuoteToOffset("brought to you by Acme VPN.", normSegs, [1, 2], out);
    expect(m.si).toBe(1);
    expect(m.charOff).toBe(norm(segText).indexOf(norm("brought to you by Acme VPN.")));
    expect(m.exact).toBe(true);
    expect(out.nonUnique).toBeUndefined();
  });
  it("flags exact=false (offset anchored at 0) when only a prefix/fuzzy pass matched", () => {
    // Shares the first words but is not an exact substring -> findSeg prefix pass.
    const m = mapQuoteToOffset("Our show today is brought to you by a totally different sponsor", normSegs, [1, 2], {});
    expect(m.si).toBe(1);
    expect(m.exact).toBe(false);
    expect(m.charOff).toBe(0);
  });
  it("returns null when the quote maps to no segment", () => {
    expect(mapQuoteToOffset("nowhere at all in here", normSegs, [1, 2], {})).toBeNull();
  });
  it("sets nonUnique when the same quote is contained by >1 window segment", () => {
    const segs = [norm("subscribe now at example dot com"), norm("subscribe now at example dot com")];
    const out = {};
    mapQuoteToOffset("subscribe now at example dot com", segs, [0, 1], out);
    expect(out.nonUnique).toBe(true);
  });
});

describe("mapGepaSpan() - char interpolation + guards + type policy", () => {
  // A clean two-segment ad. Segment 1 holds the opening pitch, segment 2 the close.
  const segments = [
    { speaker: "S", start: 0, end: 4, text: "And that ending wrecked me." },
    { speaker: "S", start: 100, end: 110, text: "Our show today is brought to you by Acme VPN." },
    { speaker: "S", start: 110, end: 118, text: "Visit acme dot com slash show for three months free." },
    { speaker: "S", start: 200, end: 210, text: "So anyway, where were we." },
  ];
  const normSegs = segments.map((s) => norm(s.text));
  const idxList = [0, 1, 2, 3];

  it("interpolates start within the start segment and end within the end segment", () => {
    const cut = mapGepaSpan({
      span: {
        type: "ad", subtype: "mid-roll",
        start_quote: "brought to you by Acme VPN.",
        end_quote: "Visit acme dot com slash show for three months free.",
      },
      segments, normSegs, idxList,
    });
    // start_quote sits at char 18 of seg1 (norm len 44) over 100..110 -> ~104.09s.
    expect(cut.startIndex).toBe(1);
    expect(cut.endIndex).toBe(2);
    expect(cut.startSec).toBeCloseTo(100 + (18 / 44) * 10, 4);
    // end_quote is the whole of seg2, so its end offset == norm length -> seg2.end.
    expect(cut.endSec).toBeCloseTo(118, 4);
    expect(cut.type).toBe("ad");
    expect(cut.subtype).toBe("mid-roll");
    expect(cut.needsReview).toBe(false); // clean, <45s, exact, unique, ad
    expect(cut.reasons).toEqual([]);
  });

  it("Slice 1: carries the gepa span's verbatim start/end quotes as firstLineQuote/lastLineQuote", () => {
    // gepa mode must populate the SAME provenance fields as legacy, sourced from the
    // span's start_quote/end_quote. Deleting that threading must fail here.
    const cut = mapGepaSpan({
      span: {
        type: "ad", subtype: "mid-roll",
        start_quote: "Our show today is brought to you by Acme VPN.",
        end_quote: "Visit acme dot com slash show for three months free.",
      },
      segments, normSegs, idxList,
    });
    expect(cut.firstLineQuote).toBe("Our show today is brought to you by Acme VPN.");
    expect(cut.lastLineQuote).toBe("Visit acme dot com slash show for three months free.");
  });

  it("SKIPS (returns null) when the opening quote maps to no segment - fail safe, never cut", () => {
    const cut = mapGepaSpan({
      span: { type: "ad", subtype: null, start_quote: "this is nowhere in the window", end_quote: "nor this" },
      segments, normSegs, idxList,
    });
    expect(cut).toBeNull();
  });

  it("flags needs-review (ambiguous boundary) when only the end quote fails to map", () => {
    const cut = mapGepaSpan({
      span: {
        type: "ad", subtype: null,
        start_quote: "Our show today is brought to you by Acme VPN.",
        end_quote: "a closing line that appears nowhere",
      },
      segments, normSegs, idxList,
    });
    expect(cut.startIndex).toBe(1);
    expect(cut.endIndex).toBe(1); // fell back to the start segment
    expect(cut.needsReview).toBe(true);
    expect(cut.reasons).toContain("ambiguous-boundary");
  });

  it("GUARD: a fuzzy/prefix (non-exact) start map -> needs-review (fuzzy-map)", () => {
    const cut = mapGepaSpan({
      span: {
        type: "ad", subtype: null,
        // Shares the opening words of seg1 but is not an exact substring.
        start_quote: "Our show today is brought to you by a different brand entirely here",
        end_quote: "Visit acme dot com slash show for three months free.",
      },
      segments, normSegs, idxList,
    });
    expect(cut.needsReview).toBe(true);
    expect(cut.reasons).toContain("fuzzy-map");
  });

  it("GUARD: a non-unique quote (matched in >1 segment) -> needs-review (non-unique-quote)", () => {
    const segs = [
      { speaker: "S", start: 0, end: 5, text: "Subscribe now at example dot com." },
      { speaker: "S", start: 5, end: 10, text: "Subscribe now at example dot com." },
    ];
    const ns = segs.map((s) => norm(s.text));
    const cut = mapGepaSpan({
      span: {
        type: "ad", subtype: null,
        start_quote: "Subscribe now at example dot com.",
        end_quote: "Subscribe now at example dot com.",
      },
      segments: segs, normSegs: ns, idxList: [0, 1],
    });
    expect(cut.needsReview).toBe(true);
    expect(cut.reasons).toContain("non-unique-quote");
  });

  it("GUARD: span duration over the 360s HARD cap -> needs-review (hard-cap)", () => {
    // A single 400s segment; the quoted span runs most of it -> > 360s.
    const segs = [
      { speaker: "S", start: 0, end: 400, text: "Our sponsor today is Acme and here is a very long read about everything Acme does and a code." },
    ];
    const ns = segs.map((s) => norm(s.text));
    const cut = mapGepaSpan({
      span: {
        type: "ad", subtype: null,
        start_quote: "Our sponsor today is Acme",
        end_quote: "and a code",
      },
      segments: segs, normSegs: ns, idxList: [0],
    });
    expect(cut.endSec - cut.startSec).toBeGreaterThan(HARD_AUTOCUT_MAX_SEC);
    expect(cut.needsReview).toBe(true);
    expect(cut.reasons).toContain("hard-cap");
  });

  it("GUARD: start+end in the SAME long (>=45s) turn covering most of it -> needs-review (long-turn-most)", () => {
    const segs = [
      { speaker: "S", start: 0, end: 60, text: "Acme sponsor read start blah blah blah lots of filler words here in one long diarized turn end code." },
    ];
    const ns = segs.map((s) => norm(s.text));
    const cut = mapGepaSpan({
      span: {
        type: "ad", subtype: null,
        start_quote: "Acme sponsor read start",
        end_quote: "end code",
      },
      segments: segs, normSegs: ns, idxList: [0],
    });
    expect(cut.startIndex).toBe(0);
    expect(cut.endIndex).toBe(0);
    expect(cut.needsReview).toBe(true);
    expect(cut.reasons).toContain("long-turn-most");
  });

  it("GUARD: degenerate interpolation (end<=start) falls back to whole span AND flags", () => {
    // Force end offset < start offset within the same segment by quoting a LATER
    // phrase as start and an EARLIER phrase as end.
    const segs = [
      { speaker: "S", start: 0, end: 10, text: "alpha beta gamma delta epsilon." },
    ];
    const ns = segs.map((s) => norm(s.text));
    const cut = mapGepaSpan({
      span: { type: "ad", subtype: null, start_quote: "epsilon", end_quote: "alpha" },
      segments: segs, normSegs: ns, idxList: [0],
    });
    expect(cut.needsReview).toBe(true);
    expect(cut.reasons).toContain("interp-degenerate");
    // The fallback is the whole-segment span.
    expect(cut.startSec).toBe(0);
    expect(cut.endSec).toBe(10);
  });

  it("TYPE POLICY: intro/outro/housekeeping are forced needs-review even when short + clean", () => {
    for (const type of ["intro", "outro", "housekeeping"]) {
      const cut = mapGepaSpan({
        span: {
          type, subtype: null,
          start_quote: "Our show today is brought to you by Acme VPN.",
          end_quote: "Our show today is brought to you by Acme VPN.",
        },
        segments, normSegs, idxList,
      });
      expect(cut.type).toBe(type);
      expect(cut.needsReview).toBe(true);
      expect(cut.reasons).toContain(`type-${type}`);
    }
  });

  it("TYPE POLICY: type 'ad' stays auto-cut-eligible (carries type/subtype, not flagged by type)", () => {
    const cut = mapGepaSpan({
      span: {
        type: "ad", subtype: "pre-roll",
        start_quote: "Our show today is brought to you by Acme VPN.",
        end_quote: "Visit acme dot com slash show for three months free.",
      },
      segments, normSegs, idxList,
    });
    expect(cut.type).toBe("ad");
    expect(cut.subtype).toBe("pre-roll");
    expect(cut.needsReview).toBe(false);
    expect(cut.reasons.some((r) => r.startsWith("type-"))).toBe(false);
  });

  it("GUARD: sensitivity can never RAISE the 360s hard cap", () => {
    const segs = [
      { speaker: "S", start: 0, end: 400, text: "Our sponsor today is Acme and here is a very long read about everything Acme does and a code." },
    ];
    const ns = segs.map((s) => norm(s.text));
    // A hugely permissive needsReviewMaxSec must NOT let a >360s span auto-apply.
    const cut = mapGepaSpan({
      span: { type: "ad", subtype: null, start_quote: "Our sponsor today is Acme", end_quote: "and a code" },
      segments: segs, normSegs: ns, idxList: [0], needsReviewMaxSec: 100000,
    });
    expect(cut.needsReview).toBe(true);
    expect(cut.reasons).toContain("hard-cap");
  });
});

describe("detectAds() gepa mode - end to end", () => {
  const saved = process.env.OSW_DETECTOR_MODE;
  afterEach(() => {
    if (saved === undefined) delete process.env.OSW_DETECTOR_MODE;
    else process.env.OSW_DETECTOR_MODE = saved;
  });

  const GEPA_AD = {
    segments: [
      { speaker: "SPEAKER_00", start: 0, end: 4, text: "And honestly that ending wrecked me." },
      { speaker: "SPEAKER_00", start: 100, end: 110, text: "Our show today is brought to you by Acme VPN." },
      { speaker: "SPEAKER_00", start: 110, end: 118, text: "Visit acme dot com slash show for three months free." },
      { speaker: "SPEAKER_01", start: 200, end: 205, text: "So anyway, where were we." },
    ],
  };
  const cleanSpan = [{
    type: "ad", subtype: "mid-roll",
    start_quote: "Our show today is brought to you by Acme VPN.",
    end_quote: "Visit acme dot com slash show for three months free.",
  }];

  it("posts the GEPA prompt + SPANS schema + '#idx [mm:ss] speaker:' lines when mode='gepa'", async () => {
    const fetch = fetchSpans([]);
    await detectAds({ transcript: GEPA_AD, fetch, mode: "gepa" });
    const [, opts] = fetch.mock.calls[0];
    const body = JSON.parse(opts.body);
    expect(body.messages[0].content).toBe(GEPA_INSTRUCTION);
    expect(body.response_format).toEqual(SPANS_SCHEMA);
    expect(body.response_format.json_schema.strict).toBe(true);
    // GEPA line format, not the legacy "<idx>. <text>".
    expect(body.messages[1].content).toContain("#1 [01:40] SPEAKER_00: Our show today is brought to you by Acme VPN.");
  });

  it("maps a clean ad by char interpolation and auto-applies it", async () => {
    const { ads, stats } = await detectAds({ transcript: GEPA_AD, fetch: fetchSpans(cleanSpan), mode: "gepa" });
    expect(ads).toHaveLength(1);
    expect(ads[0].startIndex).toBe(1);
    expect(ads[0].endIndex).toBe(2);
    // start_quote is the WHOLE of seg1 (charOff 0) -> seg1.start exactly.
    expect(ads[0].startSec).toBeCloseTo(100, 3);
    // end_quote is the WHOLE of seg2 (end offset == norm length) -> seg2.end exactly.
    expect(ads[0].endSec).toBeCloseTo(118, 3);
    expect(ads[0].needsReview).toBe(false);
    expect(ads[0].type).toBe("ad");
    expect(stats.adsReturned).toBe(1);
    expect(stats.quoteMapFailures).toBe(0);
  });

  it("honours OSW_DETECTOR_MODE=gepa when mode is unset", async () => {
    process.env.OSW_DETECTOR_MODE = "gepa";
    const fetch = fetchSpans([]);
    await detectAds({ transcript: GEPA_AD, fetch });
    const body = JSON.parse(fetch.mock.calls[0][1].body);
    expect(body.messages[0].content).toBe(GEPA_INSTRUCTION);
    expect(body.response_format).toEqual(SPANS_SCHEMA);
  });

  it("CARDINAL: skips an ad whose opening quote maps to no segment (quote-map fail)", async () => {
    const span = [{ type: "ad", subtype: null, start_quote: "nowhere in this episode at all", end_quote: "nor here" }];
    const { ads, stats } = await detectAds({ transcript: GEPA_AD, fetch: fetchSpans(span), mode: "gepa" });
    expect(ads).toEqual([]);
    expect(stats.quoteMapFailures).toBe(1);
  });

  it("uses the reasoning_content fallback in gepa mode too", async () => {
    const { ads } = await detectAds({ transcript: GEPA_AD, fetch: fetchSpans(cleanSpan, { inReasoning: true }), mode: "gepa" });
    expect(ads).toHaveLength(1);
    expect(ads[0].startIndex).toBe(1);
  });

  it("forces intro/outro/housekeeping spans to needs-review end to end", async () => {
    const span = [{
      type: "housekeeping", subtype: null,
      start_quote: "Our show today is brought to you by Acme VPN.",
      end_quote: "Our show today is brought to you by Acme VPN.",
    }];
    const { ads } = await detectAds({ transcript: GEPA_AD, fetch: fetchSpans(span), mode: "gepa" });
    expect(ads).toHaveLength(1);
    expect(ads[0].needsReview).toBe(true);
    expect(ads[0].reasons).toContain("type-housekeeping");
  });

  it("de-dupes the same span across overlapping windows, keeping the safer flagging", async () => {
    // Place the ad deep enough to fall in two overlapping windows.
    const segments = [
      { speaker: "S", start: 0, end: 5, text: "early chatter" },
      { speaker: "S", start: 1650, end: 1660, text: "Our show today is brought to you by Acme VPN." },
      { speaker: "S", start: 1660, end: 1668, text: "Visit acme dot com slash show for three months free." },
      { speaker: "S", start: 1700, end: 1705, text: "back to the topic" },
    ];
    const wins = buildWindows(toSegments({ segments }));
    expect(wins.length).toBeGreaterThanOrEqual(2);
    const { ads } = await detectAds({ transcript: { segments }, fetch: fetchSpans(cleanSpan), mode: "gepa" });
    expect(ads).toHaveLength(1);
    expect(ads[0].startIndex).toBe(1);
    expect(ads[0].endIndex).toBe(2);
  });

  it("degrades to no cuts when the gepa model output is unparseable", async () => {
    const fetch = vi.fn(async () => ({ ok: true, json: async () => ({ choices: [{ message: { content: "not json" } }] }) }));
    const { ads } = await detectAds({ transcript: GEPA_AD, fetch, mode: "gepa" });
    expect(ads).toEqual([]);
  });

  it("CARDINAL: a flagged sighting in one window is NEVER cleared by an unflagged sighting of the same span in another", async () => {
    // The same index range appears in two overlapping windows. Window 0 sees it as a
    // clean `ad` (would auto-apply); window 1 sees the SAME span as `housekeeping`
    // (always needsReview by type policy). The merged cut MUST stay needsReview - a
    // second unflagged sighting can never un-hold a held span (and vice-versa).
    const segments = [
      { speaker: "S", start: 0, end: 5, text: "early chatter" },
      { speaker: "S", start: 1650, end: 1660, text: "Our show today is brought to you by Acme VPN." },
      { speaker: "S", start: 1660, end: 1668, text: "Visit acme dot com slash show for three months free." },
      { speaker: "S", start: 1700, end: 1705, text: "back to the topic" },
    ];
    const wins = buildWindows(toSegments({ segments }));
    expect(wins.length).toBeGreaterThanOrEqual(2);
    const cleanAd = {
      type: "ad", subtype: "mid-roll",
      start_quote: "Our show today is brought to you by Acme VPN.",
      end_quote: "Visit acme dot com slash show for three months free.",
    };
    const flaggedSameSpan = { ...cleanAd, type: "housekeeping", subtype: null };
    // Window 0 -> clean ad; window 1 -> same geometry, flagged housekeeping.
    let call = 0;
    const fetch = vi.fn(async () => {
      call += 1;
      const spans = call === 1 ? [cleanAd] : [flaggedSameSpan];
      return { ok: true, json: async () => ({ choices: [{ message: { content: JSON.stringify({ spans }) } }] }) };
    });
    const { ads } = await detectAds({ transcript: { segments }, fetch, mode: "gepa" });
    expect(fetch.mock.calls.length).toBeGreaterThanOrEqual(2);
    expect(ads).toHaveLength(1);
    expect(ads[0].startIndex).toBe(1);
    expect(ads[0].endIndex).toBe(2);
    // The flag set by the housekeeping sighting survives the clean-ad sighting.
    expect(ads[0].needsReview).toBe(true);
    expect(ads[0].reasons).toContain("type-housekeeping");
  });

  it("the merge order does not matter: flagged-first then clean stays flagged too", async () => {
    // Same as above but the FLAGGED sighting arrives FIRST and the clean one second,
    // proving the OR is symmetric (a later clean sighting cannot clear an early flag).
    const segments = [
      { speaker: "S", start: 0, end: 5, text: "early chatter" },
      { speaker: "S", start: 1650, end: 1660, text: "Our show today is brought to you by Acme VPN." },
      { speaker: "S", start: 1660, end: 1668, text: "Visit acme dot com slash show for three months free." },
      { speaker: "S", start: 1700, end: 1705, text: "back to the topic" },
    ];
    const cleanAd = {
      type: "ad", subtype: "mid-roll",
      start_quote: "Our show today is brought to you by Acme VPN.",
      end_quote: "Visit acme dot com slash show for three months free.",
    };
    const flaggedSameSpan = { ...cleanAd, type: "outro", subtype: null };
    let call = 0;
    const fetch = vi.fn(async () => {
      call += 1;
      const spans = call === 1 ? [flaggedSameSpan] : [cleanAd];
      return { ok: true, json: async () => ({ choices: [{ message: { content: JSON.stringify({ spans }) } }] }) };
    });
    const { ads } = await detectAds({ transcript: { segments }, fetch, mode: "gepa" });
    expect(ads).toHaveLength(1);
    expect(ads[0].needsReview).toBe(true);
    expect(ads[0].reasons).toContain("type-outro");
  });
});

describe("ZERO REGRESSION: legacy mode is byte-for-byte unchanged by the gepa work", () => {
  const LEGACY_AD = {
    segments: [
      { speaker: "SPEAKER_00", start: 0, end: 4, text: "And honestly that ending wrecked me, best film of the year." },
      { speaker: "SPEAKER_00", start: 4, end: 9, text: "Our show today is brought to you by Acme VPN." },
      { speaker: "SPEAKER_00", start: 9, end: 14, text: "Acme encrypts everything. Visit Acme dot com slash show for three months free." },
      { speaker: "SPEAKER_01", start: 14, end: 18, text: "We're back. So anyway, where were we on the Scorsese thing?" },
    ],
  };
  const legacyQuotes = [{
    first_line: "Our show today is brought to you by Acme VPN.",
    last_line: "Visit Acme dot com slash show for three months free.",
  }];

  it("the DEFAULT (no mode, no env) posts VERIFY_INSTRUCTION + ADS_SCHEMA + '<idx>. <text>' lines", async () => {
    const saved = process.env.OSW_DETECTOR_MODE;
    delete process.env.OSW_DETECTOR_MODE;
    try {
      const fetch = fetchReturning([]);
      await detectAds({ transcript: LEGACY_AD, fetch });
      const body = JSON.parse(fetch.mock.calls[0][1].body);
      expect(body.messages[0].content).toBe(VERIFY_INSTRUCTION);
      expect(body.response_format).toEqual(ADS_SCHEMA);
      // Legacy line format, not the gepa "#idx [mm:ss]" one.
      expect(body.messages[1].content).toContain("1. Our show today is brought to you by Acme VPN.");
      expect(body.messages[1].content).not.toContain("#1 [");
    } finally {
      if (saved === undefined) delete process.env.OSW_DETECTOR_MODE;
      else process.env.OSW_DETECTOR_MODE = saved;
    }
  });

  it("the DEFAULT maps a clean ad to whole-segment indices + start/end and auto-applies (unchanged shape)", async () => {
    const { ads, stats } = await detectAds({ transcript: LEGACY_AD, fetch: fetchReturning(legacyQuotes) });
    expect(ads).toHaveLength(1);
    expect(ads[0]).toEqual({
      startIndex: 1,
      endIndex: 2,
      startSec: 4, // whole-segment start (NOT char-interpolated)
      endSec: 14, // whole-segment end
      needsReview: false,
      reasons: [],
      // Slice 1 cut-provenance: the model's VERBATIM boundary quotes, additive only.
      // The cut-shape fields above (indices, start/end, needsReview, reasons) are
      // untouched.
      firstLineQuote: "Our show today is brought to you by Acme VPN.",
      lastLineQuote: "Visit Acme dot com slash show for three months free.",
    });
    // Legacy ad objects carry NO type/subtype keys (that is a gepa-only addition).
    expect("type" in ads[0]).toBe(false);
    expect("subtype" in ads[0]).toBe(false);
    expect(stats.adsReturned).toBe(1);
    expect(stats.quoteMapFailures).toBe(0);
  });

  it("explicit mode:'legacy' behaves identically to the default", async () => {
    const a = await detectAds({ transcript: LEGACY_AD, fetch: fetchReturning(legacyQuotes) });
    const b = await detectAds({ transcript: LEGACY_AD, fetch: fetchReturning(legacyQuotes), mode: "legacy" });
    expect(b.ads).toEqual(a.ads);
  });
});

describe("cutId() - stable provenance hash", () => {
  it("is deterministic for the same identity", () => {
    expect(cutId(600, 700, "ad")).toBe(cutId(600, 700, "ad"));
  });

  it("differs when any of startSec, endSec or label differ", () => {
    const base = cutId(600, 700, "ad");
    expect(cutId(601, 700, "ad")).not.toBe(base);
    expect(cutId(600, 701, "ad")).not.toBe(base);
    expect(cutId(600, 700, "intro")).not.toBe(base);
  });

  it("is a short 8-char hex digest", () => {
    expect(cutId(600, 700, "ad")).toMatch(/^[0-9a-f]{8}$/);
  });

  it("is immune to sub-millisecond float noise (rounds to the ms)", () => {
    // Char-interpolation produces non-round seconds; identical-to-the-ms values
    // must hash the same so the id is stable across re-runs.
    expect(cutId(600.00004, 700, "ad")).toBe(cutId(600, 700, "ad"));
  });
});

describe("Slice 1 cut-provenance - quotes on emitted cuts", () => {
  it("legacy: each cut carries the model's verbatim first/last line quotes", async () => {
    const { ads } = await detectAds({
      transcript: AD_TRANSCRIPT,
      fetch: fetchReturning([{
        first_line: "Our show today is brought to you by Acme VPN.",
        last_line: "Visit Acme dot com slash show for three months free.",
      }]),
    });
    expect(ads).toHaveLength(1);
    expect(ads[0].firstLineQuote).toBe("Our show today is brought to you by Acme VPN.");
    expect(ads[0].lastLineQuote).toBe("Visit Acme dot com slash show for three months free.");
  });

  it("CARDINAL: adding quotes does not change boundaries, needsReview, or which cuts are emitted", async () => {
    // Same input as the "maps a clean ad" test above - the cut-shape fields must be
    // byte-for-byte what they were before provenance was added. Delete the quote
    // threading and these assertions still pass; delete the boundary logic and they
    // fail - so this locks the additive guarantee, not the framework.
    const { ads, stats } = await detectAds({
      transcript: AD_TRANSCRIPT,
      fetch: fetchReturning([{
        first_line: "Our show today is brought to you by Acme VPN.",
        last_line: "Visit Acme dot com slash show for three months free.",
      }]),
    });
    expect(ads).toHaveLength(1);
    expect(ads[0].startIndex).toBe(1);
    expect(ads[0].endIndex).toBe(2);
    expect(ads[0].startSec).toBe(4);
    expect(ads[0].endSec).toBe(14);
    expect(ads[0].needsReview).toBe(false);
    expect(ads[0].reasons).toEqual([]);
    expect(stats.adsReturned).toBe(1);
    expect(stats.quoteMapFailures).toBe(0);
  });

  it("CROSS-WINDOW: when a later window maps the boundary clean, the emitted quotes follow the clean sighting", async () => {
    // An ad whose segments sit in the [1620,1800) overlap, so it is quoted in BOTH
    // window 0 ([0,1800)) and window 1 ([1620,3420)). Window 0 returns a last_line that
    // does NOT map (endQuoteMapped=false, ambiguous); window 1 returns the SAME first_line
    // with a last_line that DOES map (clean). The merged cut must end up clean AND carry
    // window 1's quotes - not window 0's stale unmatched pair.
    // A SINGLE-segment ad in the [1620,1800) overlap, so both windows produce the
    // SAME si-ei key (0-0) and the de-dupe/upgrade path is exercised. Window 0 fails
    // the last_line (falls back to ei=si, ambiguous); window 1 maps the last_line
    // INTO the same segment (clean). Both keep ei=0, so the kept entry is upgraded.
    const transcript = {
      segments: [
        { speaker: "S", start: 1700, end: 1705, text: "Our sponsor today is Acme VPN, the fast one. Visit Acme dot com slash deal for a discount." },
        { speaker: "S", start: 1705, end: 1710, text: "Anyway, back to the show and the topic at hand now." },
      ],
    };
    // Window 0 and window 1 return DIFFERENT first_line AND last_line quotes that BOTH
    // map to segment 0 (so the same si-ei key 0-0). Window 0's last_line maps nowhere
    // (ambiguous); window 1's maps clean. The clean sighting must win BOTH quote fields,
    // so different quotes prove firstLineQuote is also adopted (not just lastLineQuote).
    let call = 0;
    const fetch = vi.fn(async () => {
      call += 1;
      const ad = call === 1
        ? { first_line: "Our sponsor today is Acme VPN", last_line: "A closing line that maps nowhere at all." }
        : { first_line: "Our sponsor today is Acme VPN, the fast one.", last_line: "Visit Acme dot com slash deal for a discount." };
      return { ok: true, json: async () => ({ choices: [{ message: { content: JSON.stringify({ ads: [ad] }) } }] }) };
    });
    const { ads } = await detectAds({ transcript, fetch });
    expect(fetch).toHaveBeenCalledTimes(2); // two windows ran
    expect(ads).toHaveLength(1);
    // The clean (window-2) sighting won: boundary not ambiguous, and BOTH emitted quote
    // fields are window 2's (the stale window-1 first_line "...Acme VPN" was replaced by
    // window 2's "...the fast one.").
    expect(ads[0].reasons).not.toContain("ambiguous-boundary");
    expect(ads[0].firstLineQuote).toBe("Our sponsor today is Acme VPN, the fast one.");
    expect(ads[0].lastLineQuote).toBe("Visit Acme dot com slash deal for a discount.");
  });
});
