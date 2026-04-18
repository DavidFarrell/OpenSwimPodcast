import { describe, it, expect } from "vitest";
import { adaptUpNext, enrichFromPodcastFull } from "./pocketcastsAdapter.js";

const upNextSample = {
  episodes: [
    {
      uuid: "ep-1", title: "The fight over intelligence",
      podcast: "p-hardfork",
      url: "https://cdn.example.com/hardfork/ep1.mp3",
      published: "2026-04-17T09:00:00Z",
    },
    {
      uuid: "ep-video-1", title: "AI agents, copyright panic",
      podcast: "p-hardfork",
      url: "https://cdn.example.com/hardfork/ep2.mp4",
      published: "2026-04-16T09:00:00Z",
    },
    {
      uuid: "ep-no-title", title: "Mystery ep",
      podcast: "p-unknown",
      url: "https://cdn.example.com/mystery.mp3",
      published: "2026-04-15T09:00:00Z",
    },
  ],
};

const podcasts = [
  { uuid: "p-hardfork", title: "Hard Fork" },
];

const history = [
  {
    uuid: "ep-1", duration: 4324, size: "43200000", fileType: "audio/mpeg",
    podcastTitle: "Hard Fork", podcastUuid: "p-hardfork",
  },
];

describe("adaptUpNext", () => {
  it("maps Pocket Casts episodes to the app shape in order", () => {
    const items = adaptUpNext({ upNext: upNextSample.episodes, podcasts, history });
    expect(items).toHaveLength(3);
    expect(items[0].id).toBe(1);
    expect(items[1].id).toBe(2);
    expect(items[0].uuid).toBe("ep-1");
    expect(items[0].title).toBe("The fight over intelligence");
  });

  it("joins podcast titles from podcast/list (uppercased)", () => {
    const items = adaptUpNext({ upNext: upNextSample.episodes, podcasts, history });
    expect(items[0].show).toBe("HARD FORK");
    expect(items[1].show).toBe("HARD FORK");
  });

  it("falls back to 'PODCAST' when podcast title is not known", () => {
    const items = adaptUpNext({ upNext: upNextSample.episodes, podcasts, history });
    expect(items[2].show).toBe("PODCAST");
  });

  it("uses history for duration and size when available", () => {
    const items = adaptUpNext({ upNext: upNextSample.episodes, podcasts, history });
    expect(items[0].dur).toBe("1:12:04");
    expect(items[0].durMin).toBe(72);
    expect(items[0].size).toBe("41M");
    expect(items[0].sizeMB).toBeCloseTo(43200000 / (1024 * 1024), 1);
  });

  it("renders em-dash placeholders when duration/size are unknown", () => {
    const items = adaptUpNext({ upNext: upNextSample.episodes, podcasts, history });
    expect(items[1].dur).toBe("—");
    expect(items[1].size).toBe("—");
    expect(items[1].durMin).toBe(0);
    expect(items[1].sizeMB).toBe(0);
  });

  it("detects VIDEO kind from the url extension when history has no fileType", () => {
    const items = adaptUpNext({ upNext: upNextSample.episodes, podcasts, history });
    expect(items[0].kind).toBe("AUDIO");
    expect(items[1].kind).toBe("VIDEO");
  });
});

describe("enrichFromPodcastFull", () => {
  it("fills in duration/size/kind from the cache podcast/full response", () => {
    const base = adaptUpNext({ upNext: upNextSample.episodes, podcasts: [], history: [] });
    const full = {
      podcast: {
        title: "Hard Fork",
        episodes: [
          { uuid: "ep-1", duration: 3600, file_size: 12345678, file_type: "audio/mpeg" },
          { uuid: "ep-video-1", duration: 7200, file_size: 98765432, file_type: "video/mp4" },
        ],
      },
    };
    const enriched = enrichFromPodcastFull(base, full);
    expect(enriched[0].dur).toBe("1:00:00");
    expect(enriched[0].size).toBe("12M");
    expect(enriched[0].show).toBe("HARD FORK");
    expect(enriched[1].kind).toBe("VIDEO");
    expect(enriched[1].durMin).toBe(120);
  });

  it("leaves items untouched when the podcast full response has no matching uuid", () => {
    const base = adaptUpNext({ upNext: upNextSample.episodes, podcasts, history });
    const full = { podcast: { title: "Different", episodes: [{ uuid: "other", duration: 100, file_size: 100, file_type: "audio/mpeg" }] } };
    const enriched = enrichFromPodcastFull(base, full);
    expect(enriched[0]).toEqual(base[0]);
  });
});
