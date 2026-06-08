import { describe, it, expect, vi } from "vitest";
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
    expect(NEEDS_REVIEW_MAX_SEC).toBe(150);
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
      { start: 4, end: 200, text: "b" }, // 200s span
    ];
    const dflt = classifyRange({ startIndex: 0, endIndex: 1, segments: longSegs, endQuoteMapped: true });
    expect(dflt.needsReview).toBe(true); // 200s > 150s default -> flagged

    const aggressive = classifyRange({
      startIndex: 0, endIndex: 1, segments: longSegs, endQuoteMapped: true, needsReviewMaxSec: 240,
    });
    expect(aggressive.needsReview).toBe(false); // 200s < 240s -> auto-apply
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
        { speaker: "S", start: 5, end: 200, text: "Visit Acme dot com slash show for three months free." },
        { speaker: "S", start: 200, end: 400, text: "We're back, so anyway where were we." },
      ],
    };
    const dflt = await detectAds({ transcript: longAd, fetch: fetchReturning(adQuotes) });
    expect(dflt.ads[0].needsReview).toBe(true); // 200s > 150s default

    const aggressive = await detectAds({
      transcript: longAd, fetch: fetchReturning(adQuotes), needsReviewMaxSec: 240,
    });
    expect(aggressive.ads[0].needsReview).toBe(false); // 200s < 240s
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

  it("returns no cuts when no fetch is injected", async () => {
    const { ads } = await detectAds({ transcript: AD_TRANSCRIPT });
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
