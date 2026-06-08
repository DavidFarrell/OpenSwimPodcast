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
});
