import { describe, it, expect, vi } from "vitest";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const {
  buildAnnouncementText,
  summariseTranscript,
  extractSummary,
  stripTtsUnfriendly,
  sanitise,
  SUMMARY_SCHEMA,
  LMSTUDIO_URL,
  LMSTUDIO_MODEL,
} = require("./announce.cjs");

const TRANSCRIPT = {
  segments: [
    { speaker: "SPEAKER_00", start: 0, end: 2, text: "Welcome to the show." },
    { speaker: "SPEAKER_01", start: 2, end: 5, text: "Today we talk about sea otters and kelp forests." },
  ],
};

// A fake fetch that returns a chat-completion shaped body. By default it puts the
// answer in message.content; pass { inReasoning: true } to exercise the fallback.
function fakeFetch(summary, { inReasoning = false, ok = true } = {}) {
  const payload = JSON.stringify({ summary });
  const message = inReasoning
    ? { content: "", reasoning_content: payload }
    : { content: payload };
  const fetch = vi.fn(async () => ({
    ok,
    json: async () => ({ choices: [{ message }] }),
  }));
  return fetch;
}

describe("stripTtsUnfriendly()", () => {
  it("strips em dashes, en dashes and non-breaking hyphens", () => {
    const out = stripTtsUnfriendly("alpha—beta–gamma‑delta");
    expect(out).not.toMatch(/[—–‑]/);
    expect(out).toBe("alpha beta gamma delta");
  });

  it("collapses whitespace and trims", () => {
    expect(stripTtsUnfriendly("  a   b  ")).toBe("a b");
  });
});

describe("sanitise()", () => {
  it("trims and collapses but never changes the words", () => {
    expect(sanitise("  The   Daily  ")).toBe("The Daily");
    expect(sanitise(null)).toBe("");
  });
});

describe("extractSummary()", () => {
  it("reads message.content JSON", () => {
    const data = { choices: [{ message: { content: JSON.stringify({ summary: "sea otters" }) } }] };
    expect(extractSummary(data)).toBe("sea otters");
  });

  it("falls back to reasoning_content when content is empty", () => {
    const data = { choices: [{ message: { content: "", reasoning_content: JSON.stringify({ summary: "kelp" }) } }] };
    expect(extractSummary(data)).toBe("kelp");
  });

  it("digs JSON out of prose-wrapped reasoning content", () => {
    const data = { choices: [{ message: { content: "", reasoning_content: 'Let me think... {"summary": "crayfish"} done' } }] };
    expect(extractSummary(data)).toBe("crayfish");
  });

  it("returns empty string when nothing usable is present", () => {
    expect(extractSummary({})).toBe("");
    expect(extractSummary({ choices: [{ message: { content: "" } }] })).toBe("");
  });
});

describe("summariseTranscript()", () => {
  it("posts to LM Studio with the locked model and strict json_schema", async () => {
    const fetch = fakeFetch("a clean summary");
    const out = await summariseTranscript({ show: "The Show", title: "Ep 1", transcript: TRANSCRIPT, fetch });

    expect(out).toBe("a clean summary");
    expect(fetch).toHaveBeenCalledTimes(1);
    const [url, opts] = fetch.mock.calls[0];
    expect(url).toBe(LMSTUDIO_URL);
    expect(opts.method).toBe("POST");
    const body = JSON.parse(opts.body);
    expect(body.model).toBe(LMSTUDIO_MODEL);
    expect(body.temperature).toBe(0);
    expect(body.max_tokens).toBeLessThanOrEqual(256);
    expect(body.response_format).toEqual(SUMMARY_SCHEMA);
    expect(body.response_format.json_schema.strict).toBe(true);
  });

  it("returns '' when there is no transcript (does not call fetch)", async () => {
    const fetch = fakeFetch("unused");
    const out = await summariseTranscript({ show: "S", title: "T", transcript: null, fetch });
    expect(out).toBe("");
    expect(fetch).not.toHaveBeenCalled();
  });

  it("returns '' when fetch rejects", async () => {
    const fetch = vi.fn(async () => { throw new Error("ECONNREFUSED"); });
    const out = await summariseTranscript({ show: "S", title: "T", transcript: TRANSCRIPT, fetch });
    expect(out).toBe("");
  });

  it("returns '' on a non-ok response", async () => {
    const fetch = fakeFetch("nope", { ok: false });
    const out = await summariseTranscript({ show: "S", title: "T", transcript: TRANSCRIPT, fetch });
    expect(out).toBe("");
  });
});

describe("buildAnnouncementText()", () => {
  it("appends a clean summary when the LLM call succeeds", async () => {
    const fetch = fakeFetch("sea otters and kelp forests");
    const out = await buildAnnouncementText({
      show: "Nature Pod",
      title: "Otters",
      transcript: TRANSCRIPT,
      llm: { fetch },
    });
    expect(out).toBe("This is Nature Pod. Otters. This episode is about sea otters and kelp forests.");
  });

  it("returns metadata-only when the LLM call fails", async () => {
    const fetch = vi.fn(async () => { throw new Error("down"); });
    const out = await buildAnnouncementText({
      show: "Nature Pod",
      title: "Otters",
      transcript: TRANSCRIPT,
      llm: { fetch },
    });
    expect(out).toBe("This is Nature Pod. Otters.");
  });

  it("returns metadata-only when the transcript is missing (never calls fetch)", async () => {
    const fetch = fakeFetch("unused");
    const out = await buildAnnouncementText({
      show: "Nature Pod",
      title: "Otters",
      transcript: null,
      llm: { fetch },
    });
    expect(out).toBe("This is Nature Pod. Otters.");
    expect(fetch).not.toHaveBeenCalled();
  });

  it("returns metadata-only when no llm is injected", async () => {
    const out = await buildAnnouncementText({
      show: "Nature Pod",
      title: "Otters",
      transcript: TRANSCRIPT,
    });
    expect(out).toBe("This is Nature Pod. Otters.");
  });

  it("uses the reasoning_content fallback to build the summary", async () => {
    const fetch = fakeFetch("the reasoning answer", { inReasoning: true });
    const out = await buildAnnouncementText({
      show: "Nature Pod",
      title: "Otters",
      transcript: TRANSCRIPT,
      llm: { fetch },
    });
    expect(out).toBe("This is Nature Pod. Otters. This episode is about the reasoning answer.");
  });

  it("strips em/en dashes from the final text (metadata and summary)", async () => {
    const fetch = fakeFetch("otters — and – kelp");
    const out = await buildAnnouncementText({
      show: "Nature — Pod",
      title: "The – Otters",
      transcript: TRANSCRIPT,
      llm: { fetch },
    });
    expect(out).not.toMatch(/[—–‑]/);
    expect(out).toContain("This is Nature Pod.");
    expect(out).toContain("This episode is about otters and kelp.");
  });

  it("never substitutes the wrong title - the title appears verbatim (trimmed)", async () => {
    const out = await buildAnnouncementText({
      show: "  My Show  ",
      title: "  Episode 42: The Big One  ",
    });
    expect(out).toBe("This is My Show. Episode 42: The Big One.");
  });

  it("produces show-only or title-only metadata gracefully", async () => {
    expect(await buildAnnouncementText({ show: "Only Show" })).toBe("This is Only Show.");
    expect(await buildAnnouncementText({ title: "Only Title" })).toBe("Only Title.");
  });

  it("does not double the stop when the title ends in ? or ! (no 'Alliance?.')", async () => {
    const q = await buildAnnouncementText({ show: "The Rest Is Classified", title: "Did the CIA do it?" });
    expect(q).toBe("This is The Rest Is Classified. Did the CIA do it?");
    expect(q).not.toMatch(/\?\./);
    const bang = await buildAnnouncementText({ show: "S", title: "Boom!" });
    expect(bang).toBe("This is S. Boom!");
    expect(bang).not.toMatch(/!\./);
  });

  it("does not stutter when the summary already opens as a full episode clause", async () => {
    // The model sometimes returns a whole sentence beginning "This episode ..."
    // despite being asked for a bare phrase. We must not produce
    // "...is about This episode investigates...".
    const fetch = fakeFetch("This episode investigates an alleged CIA plot");
    const out = await buildAnnouncementText({
      show: "The Rest Is Classified",
      title: "The Plot",
      transcript: TRANSCRIPT,
      llm: { fetch },
    });
    expect(out).toBe("This is The Rest Is Classified. The Plot. This episode investigates an alleged CIA plot.");
    expect(out).not.toMatch(/is about This episode/i);
  });

  it("handles 'In this episode' / 'Today' openers without the lead-in", async () => {
    const f1 = fakeFetch("In this episode the hosts debate kelp policy");
    expect(await buildAnnouncementText({ show: "Nature Pod", title: "Kelp", transcript: TRANSCRIPT, llm: { fetch: f1 } }))
      .toBe("This is Nature Pod. Kelp. In this episode the hosts debate kelp policy.");
    const f2 = fakeFetch("today's deep dive into otters");
    const out2 = await buildAnnouncementText({ show: "Nature Pod", title: "Otters", transcript: TRANSCRIPT, llm: { fetch: f2 } });
    expect(out2).toBe("This is Nature Pod. Otters. Today's deep dive into otters.");
    expect(out2).not.toMatch(/is about today/i);
  });

  it("still uses the 'is about' lead-in for a bare topic phrase", async () => {
    const fetch = fakeFetch("a CIA plot against the 1970 World Cup squad");
    const out = await buildAnnouncementText({
      show: "The Rest Is Classified",
      title: "Goalkeeper Down",
      transcript: TRANSCRIPT,
      llm: { fetch },
    });
    expect(out).toBe("This is The Rest Is Classified. Goalkeeper Down. This episode is about a CIA plot against the 1970 World Cup squad.");
  });
});

describe("buildAnnouncementText() deterministic metadata (episode/season/date)", () => {
  // Fix 1: episode number + publish date spoken from the feed, no LLM involved.

  it("speaks an episode number between the show and the title", async () => {
    const out = await buildAnnouncementText({
      show: "Hard Fork", title: "Otters", episodeNumber: 47,
    });
    expect(out).toBe("This is Hard Fork. Episode 47. Otters.");
  });

  it("speaks a season AND episode number for a seasoned show", async () => {
    const out = await buildAnnouncementText({
      show: "Serial", title: "The Alibi", seasonNumber: 3, episodeNumber: 7,
    });
    expect(out).toBe("This is Serial. Season 3, episode 7. The Alibi.");
    // Never the display form.
    expect(out).not.toMatch(/S0?3E0?7/i);
  });

  it("omits the episode clause entirely when there is no episode number", async () => {
    // A season with no episode number is not enough to identify the episode.
    const noNum = await buildAnnouncementText({ show: "Radiolab", title: "Colors", seasonNumber: 2 });
    expect(noNum).toBe("This is Radiolab. Colors.");
    expect(noNum).not.toMatch(/episode/i);
    expect(noNum).not.toMatch(/season/i);
  });

  it("formats an ISO publish date as 'the Nth of Month YYYY' (UTC), not ISO/numeric", async () => {
    const out = await buildAnnouncementText({
      show: "Hard Fork", title: "Otters", published: "2025-06-10T09:00:00Z",
    });
    expect(out).toBe("This is Hard Fork. Otters. Published on the 10th of June 2025.");
    expect(out).not.toMatch(/2025-06-10/);
    expect(out).not.toMatch(/\d+\/\d+\/\d+/);
  });

  it("uses UTC date components: a midnight-UTC timestamp does not drift to the previous day", async () => {
    // 2025-06-10T00:00:00Z is the 10th in UTC; with local-time components it
    // could render as the 9th in a negative-offset timezone. We assert the 10th.
    const out = await buildAnnouncementText({
      show: "Hard Fork", title: "Otters", published: "2025-06-10T00:00:00Z",
    });
    expect(out).toContain("Published on the 10th of June 2025.");
    expect(out).not.toContain("9th of June");
  });

  it("speaks correct ordinals for tricky days (1st, 2nd, 3rd, 11th, 21st, 23rd)", async () => {
    const cases = [
      ["2025-01-01T00:00:00Z", "the 1st of January 2025"],
      ["2025-02-02T00:00:00Z", "the 2nd of February 2025"],
      ["2025-03-03T00:00:00Z", "the 3rd of March 2025"],
      ["2025-04-11T00:00:00Z", "the 11th of April 2025"],
      ["2025-05-21T00:00:00Z", "the 21st of May 2025"],
      ["2025-07-23T00:00:00Z", "the 23rd of July 2025"],
    ];
    for (const [iso, expected] of cases) {
      // eslint-disable-next-line no-await-in-loop
      const out = await buildAnnouncementText({ show: "S", title: "T", published: iso });
      expect(out).toContain(`Published on ${expected}.`);
    }
  });

  it("omits the date clause when the publish date is missing or unparseable", async () => {
    const missing = await buildAnnouncementText({ show: "S", title: "T" });
    expect(missing).toBe("This is S. T.");
    const bad = await buildAnnouncementText({ show: "S", title: "T", published: "not a date" });
    expect(bad).toBe("This is S. T.");
    expect(bad).not.toMatch(/published/i);
  });

  it("builds the full combined string: show, episode, title, date, summary", async () => {
    const fetch = fakeFetch("sea otters and kelp forests");
    const out = await buildAnnouncementText({
      show: "Hard Fork",
      title: "Otters",
      episodeNumber: 47,
      published: "2025-06-10T09:00:00Z",
      transcript: TRANSCRIPT,
      llm: { fetch },
    });
    expect(out).toBe("This is Hard Fork. Episode 47. Otters. Published on the 10th of June 2025. This episode is about sea otters and kelp forests.");
  });

  it("metadata is deterministic: full episode+date line even with NO transcript/LLM", async () => {
    const out = await buildAnnouncementText({
      show: "Hard Fork",
      title: "Otters",
      seasonNumber: 2,
      episodeNumber: 5,
      published: "2025-06-10T09:00:00Z",
      // no transcript, no llm
    });
    expect(out).toBe("This is Hard Fork. Season 2, episode 5. Otters. Published on the 10th of June 2025.");
  });

  it("keeps the title-punctuation guard with the new clauses (no 'Who Won?.')", async () => {
    const out = await buildAnnouncementText({
      show: "Trivia", title: "Who Won?", episodeNumber: 12, published: "2025-06-10T00:00:00Z",
    });
    expect(out).toBe("This is Trivia. Episode 12. Who Won? Published on the 10th of June 2025.");
    expect(out).not.toMatch(/\?\./);
  });

  it("coerces numeric-string / zero episode+season fields like the feed sends them", async () => {
    // Numeric strings are real numbers; 0 / "" mean 'no number' and are omitted.
    const str = await buildAnnouncementText({ show: "S", title: "T", episodeNumber: "47", seasonNumber: "3" });
    expect(str).toBe("This is S. Season 3, episode 47. T.");
    const zero = await buildAnnouncementText({ show: "S", title: "T", episodeNumber: 0 });
    expect(zero).toBe("This is S. T.");
  });
});
