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

// Sanitise the caller-supplied cut ranges into a clean, sorted, non-overlapping
// list of [startSec, endSec] pairs on the ORIGINAL (pre-speed) episode timeline.
// Invalid, empty, inverted, negative-start or non-finite ranges are dropped
// (degrade safely - never trim something we cannot reason about). Overlapping /
// touching ranges are merged so the resulting aselect expression has no
// redundant terms.
function normaliseCuts(cuts) {
  if (!Array.isArray(cuts) || cuts.length === 0) return [];
  const clean = [];
  for (const c of cuts) {
    if (!Array.isArray(c) || c.length < 2) continue;
    const start = Number(c[0]);
    const end = Number(c[1]);
    if (!Number.isFinite(start) || !Number.isFinite(end)) continue;
    // A negative start is out-of-bounds/malformed - drop the whole range (cut
    // nothing) rather than reshaping it to start at 0, which would silently
    // trim real beginning-of-episode content. Trim cardinal rule: zero false
    // positives - never trim audio we cannot reason about.
    if (start < 0) continue;
    const lo = start;
    const hi = end;
    if (hi <= lo) continue; // empty or inverted range - skip, cut nothing
    clean.push([lo, hi]);
  }
  if (clean.length === 0) return [];
  clean.sort((a, b) => a[0] - b[0]);
  const merged = [clean[0].slice()];
  for (let i = 1; i < clean.length; i++) {
    const prev = merged[merged.length - 1];
    const cur = clean[i];
    if (cur[0] <= prev[1]) {
      if (cur[1] > prev[1]) prev[1] = cur[1];
    } else {
      merged.push(cur.slice());
    }
  }
  return merged;
}

// Build the ffmpeg aselect+asetpts filter pair that DROPS the given ranges from
// an audio stream and repacks the surviving samples into a gapless timeline.
// Returns [] when there is nothing to cut, so the caller emits exactly the same
// args it does today (zero-regression guarantee). aselect keeps samples whose
// timestamp is NOT inside any cut range; asetpts re-bases the PTS so the gap
// closes. The cut math is on the ORIGINAL timeline, so this MUST run before any
// atempo/boost stage.
function buildCutFilters(ranges) {
  if (!ranges || ranges.length === 0) return [];
  const terms = ranges.map(([a, b]) => `between(t,${a},${b})`).join("+");
  return [`aselect='not(${terms})'`, "asetpts=N/SR/TB"];
}

async function convert({
  src, dest,
  bitrate = "128k", mono = true, speed = 1.0, boost = false,
  introPath = null, cuts = null,
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

  // The cut ranges, speed-up and boost only ever apply to the EPISODE audio.
  // The spoken intro must play at normal speed and uncut, so it is never run
  // through these filters. Cuts are on the ORIGINAL timeline, so the aselect/
  // asetpts drop MUST come first, before atempo changes the time base.
  const cutFilters = buildCutFilters(normaliseCuts(cuts));
  const episodeFilters = [...cutFilters];
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

// Read the duration (seconds) of a media file by asking ffmpeg to open it and
// parsing the "Duration:" line off stderr. ffmpeg with only `-i` exits non-zero
// ("At least one output file must be specified") but still prints the duration,
// so we parse stderr regardless of exit code. Best-effort: resolves null on any
// failure (no ffmpeg, spawn error, unparseable) and NEVER throws. Used to report
// the ACTUAL processed/output duration on the success screen rather than the
// original feed length. Tests inject their own (or use the null default in
// sync.cjs), so this only runs against real files in the packaged app.
function probeDurationSec(file, { spawn = defaultSpawn, ffmpegPath = defaultFfmpegPath } = {}) {
  return new Promise((resolve) => {
    if (!file || !ffmpegPath) return resolve(null);
    let child;
    try { child = spawn(ffmpegPath, ["-hide_banner", "-i", file]); }
    catch { return resolve(null); }
    let stderr = "";
    let settled = false;
    const done = (v) => { if (settled) return; settled = true; resolve(v); };
    if (child.stderr) child.stderr.on("data", (b) => { stderr += String(b); });
    child.on("error", () => done(null));
    child.on("close", () => {
      const d = parseDuration(stderr);
      done(Number.isFinite(d) && d >= 0 ? d : null);
    });
  });
}

module.exports = { convert, parseDuration, parseTime, AbortError, BOOST_FILTER, normaliseCuts, buildCutFilters, probeDurationSec };
