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

const BOOST_FILTER = "acompressor=threshold=-22dB:ratio=3:attack=5:release=80:makeup=4dB,loudnorm=I=-14:LRA=9:TP=-1.0,volume=6dB,alimiter=limit=0.97:level=disabled";

async function convert({
  src, dest,
  bitrate = "128k", mono = true, speed = 1.0, boost = false,
  introPath = null,
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

  // The speed-up and boost only ever apply to the EPISODE audio. The spoken
  // intro must play at normal speed, so it is never run through these filters.
  const episodeFilters = [];
  if (speed && speed !== 1.0) episodeFilters.push(`atempo=${speed}`);
  if (boost) episodeFilters.push(BOOST_FILTER);

  let args;
  if (introPath) {
    // Front-concat: [intro] then [episode] as a single mp3. The intro WAV is
    // 24kHz mono and the episode is 44.1kHz, so a "-c copy" concat will not
    // work - we use the concat FILTER which re-encodes. The concat filter needs
    // both inputs at the same sample rate and channel layout, so each stream is
    // run through aresample + aformat to a common 44.1kHz target first. The
    // episode stream is additionally filtered (atempo/boost) so it is sped up;
    // the intro stream is NOT sped up so the spoken intro plays at normal speed.
    const channels = mono ? 1 : 2;
    const layout = mono ? "mono" : "stereo";
    const normalise = `aresample=44100,aformat=sample_fmts=s16:channel_layouts=${layout}`;
    const introChain = [normalise];
    const episodeChain = [...episodeFilters, normalise];
    const filterComplex = [
      `[0:a]${introChain.join(",")}[intro]`,
      `[1:a]${episodeChain.join(",")}[ep]`,
      `[intro][ep]concat=n=2:v=0:a=1[out]`,
    ].join(";");

    args = [
      "-y",
      "-hide_banner",
      "-i", introPath,
      "-i", src,
      "-vn",
      "-filter_complex", filterComplex,
      "-map", "[out]",
      "-acodec", "libmp3lame",
      "-b:a", bitrate,
      "-ac", String(channels),
      "-f", "mp3",
      tmp,
    ];
  } else {
    args = [
      "-y",
      "-hide_banner",
      "-i", src,
      "-vn",
      "-acodec", "libmp3lame",
      "-b:a", bitrate,
      "-f", "mp3",
    ];
    if (episodeFilters.length) args.push("-filter:a", episodeFilters.join(","));
    if (mono) args.push("-ac", "1");
    args.push(tmp);
  }

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

module.exports = { convert, parseDuration, parseTime, AbortError, BOOST_FILTER };
