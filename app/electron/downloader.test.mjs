import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { createRequire } from "node:module";
import http from "node:http";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";

const require = createRequire(import.meta.url);
const { download } = require("./downloader.cjs");

function makeServer(handler) {
  return new Promise((resolve) => {
    const srv = http.createServer(handler);
    srv.listen(0, "127.0.0.1", () => {
      const { port } = srv.address();
      resolve({ srv, url: `http://127.0.0.1:${port}` });
    });
  });
}

function closeServer(srv) {
  return new Promise((r) => srv.close(() => r()));
}

function mkTmp() {
  return fs.mkdtempSync(path.join(os.tmpdir(), "os-dl-"));
}

function rmTmp(dir) {
  try { fs.rmSync(dir, { recursive: true, force: true }); } catch {}
}

function serveBytes(res, buf, { status = 200, extraHeaders = {} } = {}) {
  res.writeHead(status, { "Content-Type": "audio/mpeg", "Content-Length": buf.length, "Accept-Ranges": "bytes", ...extraHeaders });
  res.end(buf);
}

describe("download()", () => {
  let server, baseUrl, tmp;

  beforeEach(() => { tmp = mkTmp(); });
  afterEach(async () => { if (server) await closeServer(server); rmTmp(tmp); });

  it("writes a fresh file and reports monotonic progress", async () => {
    const payload = Buffer.alloc(1024 * 32, 0xab);
    ({ srv: server, url: baseUrl } = await makeServer((req, res) => serveBytes(res, payload)));
    const dest = path.join(tmp, "ep-1.mp3");

    const progress = [];
    const result = await download({
      url: `${baseUrl}/ep-1.mp3`,
      dest,
      onProgress: (p) => progress.push(p.bytes),
    });

    expect(result.bytes).toBe(payload.length);
    expect(result.fromCache).toBe(false);
    expect(fs.readFileSync(dest).equals(payload)).toBe(true);
    expect(progress.length).toBeGreaterThan(0);
    for (let i = 1; i < progress.length; i++) expect(progress[i]).toBeGreaterThanOrEqual(progress[i - 1]);
    expect(progress[progress.length - 1]).toBe(payload.length);
  });

  it("is a no-op when the destination already exists at the right size", async () => {
    const payload = Buffer.alloc(2048, 0xcd);
    let hits = 0;
    ({ srv: server, url: baseUrl } = await makeServer((req, res) => {
      hits++;
      if (req.method === "HEAD") {
        res.writeHead(200, { "Content-Length": payload.length, "Accept-Ranges": "bytes" });
        return res.end();
      }
      serveBytes(res, payload);
    }));
    const dest = path.join(tmp, "ep-2.mp3");
    fs.writeFileSync(dest, payload);

    const result = await download({ url: `${baseUrl}/ep-2.mp3`, dest });
    expect(result.fromCache).toBe(true);
    expect(result.bytes).toBe(payload.length);
    expect(hits).toBe(1);
  });

  it("resumes from a .part file using Range", async () => {
    const payload = Buffer.alloc(1024 * 16, 0);
    for (let i = 0; i < payload.length; i++) payload[i] = i % 256;

    const rangeRequests = [];
    ({ srv: server, url: baseUrl } = await makeServer((req, res) => {
      if (req.method === "HEAD") {
        res.writeHead(200, { "Content-Length": payload.length, "Accept-Ranges": "bytes" });
        return res.end();
      }
      const range = req.headers["range"];
      if (range) {
        rangeRequests.push(range);
        const m = /bytes=(\d+)-/.exec(range);
        const start = Number(m[1]);
        const slice = payload.slice(start);
        res.writeHead(206, {
          "Content-Type": "audio/mpeg",
          "Content-Length": slice.length,
          "Content-Range": `bytes ${start}-${payload.length - 1}/${payload.length}`,
          "Accept-Ranges": "bytes",
        });
        return res.end(slice);
      }
      serveBytes(res, payload);
    }));

    const dest = path.join(tmp, "ep-3.mp3");
    const part = `${dest}.part`;
    const partial = payload.slice(0, 4096);
    fs.writeFileSync(part, partial);

    const result = await download({ url: `${baseUrl}/ep-3.mp3`, dest });

    expect(rangeRequests).toEqual(["bytes=4096-"]);
    expect(result.bytes).toBe(payload.length);
    expect(result.resumed).toBe(true);
    expect(fs.readFileSync(dest).equals(payload)).toBe(true);
    expect(fs.existsSync(part)).toBe(false);
  });

  it("tags 404 errors with the status code", async () => {
    ({ srv: server, url: baseUrl } = await makeServer((req, res) => {
      res.writeHead(404); res.end("nope");
    }));
    const dest = path.join(tmp, "missing.mp3");
    await expect(download({ url: `${baseUrl}/missing.mp3`, dest })).rejects.toMatchObject({ status: 404 });
    expect(fs.existsSync(dest)).toBe(false);
  });

  it("aborts mid-stream and preserves the .part file so the next call can resume", async () => {
    const payload = Buffer.alloc(1024 * 64, 0x5a);
    ({ srv: server, url: baseUrl } = await makeServer((req, res) => {
      if (req.method === "HEAD") {
        res.writeHead(200, { "Content-Length": payload.length, "Accept-Ranges": "bytes" });
        return res.end();
      }
      res.writeHead(200, { "Content-Type": "audio/mpeg", "Content-Length": payload.length, "Accept-Ranges": "bytes" });
      res.write(payload.slice(0, 2048));
      setTimeout(() => {
        res.write(payload.slice(2048, 4096));
      }, 500);
    }));

    const dest = path.join(tmp, "ep-abort.mp3");
    const ctrl = new AbortController();
    const p = download({ url: `${baseUrl}/ep-abort.mp3`, dest, signal: ctrl.signal });
    setTimeout(() => ctrl.abort(), 50);
    await expect(p).rejects.toMatchObject({ name: "AbortError" });
    expect(fs.existsSync(dest)).toBe(false);
    expect(fs.existsSync(`${dest}.part`)).toBe(true);
    expect(fs.statSync(`${dest}.part`).size).toBeGreaterThan(0);
  });
});
