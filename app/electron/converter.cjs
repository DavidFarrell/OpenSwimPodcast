const fs = require("node:fs");
const fsp = require("node:fs/promises");
const path = require("node:path");
const { spawn: defaultSpawn } = require("node:child_process");

let defaultFfmpegPath = null;
try {
  defaultFfmpegPath = require("ffmpeg-static");
  // In a packaged Electron app, asarUnpack puts the binary in app.asar.unpacked/
  // but require() still returns the app.asar path - fix it so spawn() can find it.
  if (defaultFfmpegPath) {
    defaultFfmpegPath = defaultFfmpegPath.replace(/app\.asar([/\\])/, "app.asar.unpacked$1");
  }
} catch {}

function parseDuration(stderr) {
  const m = /Duration:\s*(\d+):(\d+):(\d+(?:\.\d+)?)/.exec(stderr);
  if (!m) return null;
  return Number(m[1]) * 3600 + Number(m[2]) * 60 + Number(m[3]);
}

function parseTime(line) {
  const m = /time=(\d+):(\d+):(\d+(?:\.\d+)?)/.exec(line);
  if (!m) return null;
  return Number(m[1]) * 3600 + Number(m[2]) * 60 + Number(m[3]);
}

function tailLines(s, n) {
  return s.split(/\r?\n/).filter(Boolean).slice(-n).join("\n").trim();
}

class AbortError extends Error {
  constructor() { super("aborted"); this.name = "AbortError"; }
}

async function convert({
  src, dest,
  bitrate = "128k", mono = true, speed = 1.0,
  ffmpegPath = defaultFfmpegPath,
  spawn = defaultSpawn,
  onProgress, signal,
} = {}) {
  if (!src) throw new Error("src is required");
  if (!dest) throw new Error("dest is required");
  if (!ffmpegPath) throw new Error("ffmpeg binary not found (ffmpeg-static missing?)");

  await fsp.mkdir(path.dirname(dest), { recursive: true });

  try {
    const s = await fsp.stat(dest);
    if (s.size > 0) return { bytes: s.size, fromCache: true, durationSec: null };
  } catch {}

  const tmp = `${dest}.tmp`;
  try { await fsp.unlink(tmp); } catch {}

  const args = [
    "-y",
    "-hide_banner",
    "-i", src,
    "-vn",
    "-acodec", "libmp3lame",
    "-b:a", bitrate,
    "-f", "mp3",
  ];
  if (speed && speed !== 1.0) args.push("-filter:a", `atempo=${speed}`);
  if (mono) args.push("-ac", "1");
  args.push(tmp);

  return await new Promise((resolve, reject) => {
    let child;
    try { child = spawn(ffmpegPath, args); }
    catch (e) { return reject(e); }

    let stderrBuf = "";
    let duration = null;
    let aborted = false;
    let settled = false;
    const finish = (fn) => { if (settled) return; settled = true; fn(); };

    const onAbort = () => {
      aborted = true;
      try { child.kill && child.kill("SIGTERM"); } catch {}
    };
    if (signal) {
      if (signal.aborted) onAbort();
      else signal.addEventListener("abort", onAbort, { once: true });
    }

    if (child.stderr) {
      child.stderr.on("data", (buf) => {
        const text = String(buf);
        stderrBuf += text;
        if (duration == null) duration = parseDuration(stderrBuf);
        if (onProgress) {
          const lines = text.split(/[\r\n]+/);
          for (const line of lines) {
            const t = parseTime(line);
            if (t != null) {
              try { onProgress({ seconds: t, durationSec: duration }); } catch {}
            }
          }
        }
      });
    }

    child.on("error", (e) => finish(() => reject(e)));
    child.on("exit", async (code) => {
      if (aborted) return finish(() => {
        fsp.unlink(tmp).catch(() => {});
        reject(new AbortError());
      });
      if (code !== 0) {
        return finish(() => {
          fsp.unlink(tmp).catch(() => {});
          const msg = tailLines(stderrBuf, 5) || `ffmpeg exited with code ${code}`;
          reject(Object.assign(new Error(msg), { stderr: stderrBuf, code }));
        });
      }
      try {
        await fsp.rename(tmp, dest);
        const st = await fsp.stat(dest);
        finish(() => resolve({ bytes: st.size, durationSec: duration, fromCache: false }));
      } catch (e) {
        finish(() => reject(e));
      }
    });
  });
}

module.exports = { convert, parseDuration, parseTime, AbortError };
