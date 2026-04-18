import { describe, it, expect, beforeEach, vi } from "vitest";
import { createRequire } from "node:module";
import zlib from "node:zlib";

const require = createRequire(import.meta.url);
const api = require("./pocketcastsApi.cjs");

function mockFetchOk(body, { gzip = false } = {}) {
  const text = typeof body === "string" ? body : JSON.stringify(body);
  const buf = gzip ? zlib.gzipSync(Buffer.from(text)) : Buffer.from(text);
  return vi.fn(async () => ({
    ok: true,
    status: 200,
    statusText: "OK",
    json: async () => (typeof body === "string" ? JSON.parse(body) : body),
    text: async () => text,
    arrayBuffer: async () => buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength),
  }));
}

function mockFetchErr(status, statusText = "error", body = "") {
  return vi.fn(async () => ({
    ok: false,
    status,
    statusText,
    json: async () => ({}),
    text: async () => body,
    arrayBuffer: async () => new ArrayBuffer(0),
  }));
}

describe("pocketcastsApi.login", () => {
  beforeEach(() => { globalThis.fetch = undefined; });

  it("POSTs email+password and returns the token", async () => {
    globalThis.fetch = mockFetchOk({ token: "jwt-xyz", uuid: "user-1" });
    const token = await api.login("a@b.com", "pw");
    expect(token).toBe("jwt-xyz");
    const [url, opts] = globalThis.fetch.mock.calls[0];
    expect(url).toBe("https://api.pocketcasts.com/user/login");
    expect(opts.method).toBe("POST");
    expect(JSON.parse(opts.body)).toEqual({ email: "a@b.com", password: "pw", scope: "webplayer" });
    expect(opts.headers.Authorization).toBeUndefined();
  });

  it("throws with status when credentials are rejected", async () => {
    globalThis.fetch = mockFetchErr(400, "Bad Request", "bad creds");
    await expect(api.login("a@b.com", "wrong")).rejects.toMatchObject({ status: 400 });
  });

  it("throws if the server returns 200 but no token", async () => {
    globalThis.fetch = mockFetchOk({ message: "weird" });
    await expect(api.login("a", "b")).rejects.toThrow(/no token/);
  });
});

describe("pocketcastsApi.getUpNext", () => {
  beforeEach(() => { globalThis.fetch = undefined; });

  it("sends the bearer token and webplayer model", async () => {
    globalThis.fetch = mockFetchOk({ episodes: [{ uuid: "ep-1" }] });
    const res = await api.getUpNext("jwt-xyz");
    expect(res.episodes).toHaveLength(1);
    const [url, opts] = globalThis.fetch.mock.calls[0];
    expect(url).toBe("https://api.pocketcasts.com/up_next/list");
    expect(opts.headers.Authorization).toBe("Bearer jwt-xyz");
    expect(JSON.parse(opts.body)).toEqual({ version: 2, model: "webplayer" });
  });

  it("surfaces 401 as a status-tagged error (so caller can clear session)", async () => {
    globalThis.fetch = mockFetchErr(401, "Unauthorized", "token expired");
    await expect(api.getUpNext("stale")).rejects.toMatchObject({ status: 401 });
  });
});

describe("pocketcastsApi.getPodcastFull", () => {
  beforeEach(() => { globalThis.fetch = undefined; });

  it("decompresses gzipped JSON from the cache endpoint", async () => {
    globalThis.fetch = mockFetchOk({ podcast: { title: "Ezra Klein", episodes: [] } }, { gzip: true });
    const res = await api.getPodcastFull("puuid-1");
    expect(res.podcast.title).toBe("Ezra Klein");
    const [url] = globalThis.fetch.mock.calls[0];
    expect(url).toBe("https://cache.pocketcasts.com/mobile/podcast/full/puuid-1");
  });

  it("handles non-gzipped JSON too", async () => {
    globalThis.fetch = mockFetchOk({ podcast: { title: "X", episodes: [] } }, { gzip: false });
    const res = await api.getPodcastFull("p");
    expect(res.podcast.title).toBe("X");
  });
});
