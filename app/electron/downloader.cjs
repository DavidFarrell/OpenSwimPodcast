const fs = require("node:fs");
const fsp = require("node:fs/promises");
const path = require("node:path");

class AbortError extends Error {
  constructor() { super("aborted"); this.name = "AbortError"; }
}

async function head(url, signal) {
  const res = await fetch(url, { method: "HEAD", signal });
  if (!res.ok) {
    const e = new Error(`HEAD ${res.status} ${res.statusText}`);
    e.status = res.status;
    throw e;
  }
  const len = res.headers.get("content-length");
  return {
    size: len ? Number(len) : null,
    acceptsRanges: (res.headers.get("accept-ranges") || "").toLowerCase() === "bytes",
  };
}

async function statSize(p) {
  try { return (await fsp.stat(p)).size; } catch { return -1; }
}

async function download({ url, dest, onProgress, signal }) {
  await fsp.mkdir(path.dirname(dest), { recursive: true });
  const part = `${dest}.part`;

  const meta = await head(url, signal);

  const destSize = await statSize(dest);
  if (meta.size != null && destSize === meta.size) {
    return { bytes: destSize, fromCache: true, resumed: false };
  }

  const partSize = await statSize(part);
  const canResume = partSize > 0 && meta.size != null && partSize < meta.size && meta.acceptsRanges;
  const resumed = canResume;

  const headers = {};
  if (canResume) headers["Range"] = `bytes=${partSize}-`;

  const res = await fetch(url, { headers, signal });
  if (!res.ok) {
    const e = new Error(`GET ${res.status} ${res.statusText}`);
    e.status = res.status;
    throw e;
  }

  const startBytes = canResume ? partSize : 0;
  const flags = canResume ? "a" : "w";
  const out = fs.createWriteStream(part, { flags });

  let written = startBytes;

  try {
    await new Promise((resolve, reject) => {
      const reader = res.body.getReader();
      let cancelled = false;

      const onAbort = () => {
        cancelled = true;
        reader.cancel().catch(() => {});
        out.destroy();
        reject(new AbortError());
      };
      if (signal) {
        if (signal.aborted) return onAbort();
        signal.addEventListener("abort", onAbort, { once: true });
      }

      out.on("error", (err) => { if (!cancelled) reject(err); });

      (async () => {
        try {
          while (true) {
            const { value, done } = await reader.read();
            if (cancelled) return;
            if (done) break;
            written += value.length;
            if (onProgress) { try { onProgress({ bytes: written, total: meta.size }); } catch {} }
            if (!out.write(Buffer.from(value))) {
              await new Promise((r) => out.once("drain", r));
            }
          }
          out.end(() => resolve());
        } catch (e) {
          if (cancelled) return;
          out.destroy();
          reject(e);
        }
      })();
    });
  } catch (e) {
    if (signal && signal.aborted) throw new AbortError();
    if (e && (e.name === "AbortError" || e.code === "ABORT_ERR" || e.code === 20)) throw new AbortError();
    throw e;
  }

  await fsp.rename(part, dest);
  return { bytes: written, fromCache: false, resumed };
}

class DownloadManager {
  constructor({ cacheDir, concurrency = 2, onEvent } = {}) {
    this.cacheDir = cacheDir;
    this.concurrency = concurrency;
    this.onEvent = onEvent || (() => {});
    this.entries = new Map();
    this.queue = [];
    this.active = 0;
  }

  pathFor(uuid, ext) {
    return path.join(this.cacheDir, `${uuid}.${ext}`);
  }

  list() {
    return [...this.entries.values()].map((e) => ({
      uuid: e.uuid, state: e.state, bytes: e.bytes, total: e.total, error: e.error,
    }));
  }

  ensure({ uuid, url, ext }) {
    const existing = this.entries.get(uuid);
    if (existing && (existing.state === "downloading" || existing.state === "queued" || existing.state === "ready")) {
      return existing;
    }
    const dest = this.pathFor(uuid, ext || "mp3");
    const entry = {
      uuid, url, dest, state: "queued",
      bytes: 0, total: null, error: null,
      controller: new AbortController(),
    };
    this.entries.set(uuid, entry);
    this.emit(entry);
    this.queue.push(entry);
    this.pump();
    return entry;
  }

  cancel(uuid) {
    const e = this.entries.get(uuid);
    if (!e) return false;
    if (e.state === "queued" || e.state === "downloading") {
      e.controller.abort();
      e.state = "cancelled";
      this.emit(e);
    }
    return true;
  }

  emit(e) {
    this.onEvent({ uuid: e.uuid, state: e.state, bytes: e.bytes, total: e.total, error: e.error });
  }

  async pump() {
    while (this.active < this.concurrency && this.queue.length) {
      const e = this.queue.shift();
      if (e.state !== "queued") continue;
      this.active++;
      this.run(e).finally(() => { this.active--; this.pump(); });
    }
  }

  async run(e) {
    e.state = "downloading";
    this.emit(e);
    try {
      const r = await download({
        url: e.url,
        dest: e.dest,
        signal: e.controller.signal,
        onProgress: ({ bytes, total }) => { e.bytes = bytes; e.total = total; this.emit(e); },
      });
      e.bytes = r.bytes;
      e.total = r.bytes;
      e.state = "ready";
      this.emit(e);
    } catch (err) {
      if (err && err.name === "AbortError") {
        e.state = "cancelled";
      } else {
        e.state = "error";
        e.error = err.message || String(err);
      }
      this.emit(e);
    }
  }
}

module.exports = { download, DownloadManager, AbortError };
