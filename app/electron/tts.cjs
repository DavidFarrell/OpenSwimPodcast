// Render the spoken intro to a final WAV: a short chime followed by the speech.
//
// David learns the chime as the Swimcast marker - it always precedes the spoken
// intro so he knows an episode is starting. The chime is synthesised on the fly
// by ffmpeg (a short sine "bell") so no binary asset has to be bundled.
//
// The speech itself comes from qwen-speak (voice Ryan). qwen-speak has no
// --output flag: it writes a WAV under its own audio_output/ dir and prints
// "Audio saved to: <path>" on stdout, which we parse to find the file. The CLI
// needs a `cd` + venv activation, so it is run through a shell. Both the TTS
// command and ffmpeg are spawned through an injected spawn so unit tests never
// touch the real binaries.
//
// Everything degrades safely: any failure (spawn throws, non-zero exit, missing
// output, ffmpeg error) resolves to null so the caller ships no intro rather
// than blocking the sync. This module never throws into the pipeline.

const fs = require("node:fs");
const fsp = require("node:fs/promises");
const path = require("node:path");
const os = require("node:os");
const { spawn: defaultSpawn } = require("node:child_process");
const { logEvent } = require("./logger.cjs");

let defaultFfmpegPath = null;
try {
  defaultFfmpegPath = require("ffmpeg-static");
  // In a packaged Electron app, asarUnpack puts the binary in app.asar.unpacked/
  // but require() still returns the app.asar path - fix it so spawn() can find it.
  if (defaultFfmpegPath) {
    defaultFfmpegPath = defaultFfmpegPath.replace(/app\.asar([/\\])/, "app.asar.unpacked$1");
  }
} catch {}

// qwen-speak lives outside this repo. We keep the layout here so the caller does
// not have to know it; tests inject their own spawn so this path is never run.
const QWENTTS_DIR = "/Users/david/git/ai-sandbox/projects/qwentts";
const TTS_VOICE = "Ryan";
const CHIME_SECONDS = 0.5;

// qwen-speak runs from its own venv. We spawn the venv's python directly (NOT via
// `bash -lc "cd .. && source activate && python .."`). The shell recipe was
// fragile in a packaged GUI app - a login shell re-sourcing profiles, quoting, or
// a restricted spawn could fail instantly. Spawning the absolute venv python with
// an explicit env (VIRTUAL_ENV + venv bin on PATH) is the documented, robust way
// to run a venv tool without activation.
const VENV_DIR = path.join(QWENTTS_DIR, ".venv");
const VENV_PYTHON = path.join(VENV_DIR, "bin", "python");
const SPEAK_SCRIPT = "tts_engine_v2.py";

// Argv for the qwen-speak invocation (text passed as a normal argv item - no
// shell, so no quoting needed).
function buildSpeakArgs(text, voice = TTS_VOICE) {
  return [SPEAK_SCRIPT, "speak", String(text), "--voice", String(voice)];
}

// The environment for the venv python: activation-equivalent.
function buildSpeakEnv() {
  return {
    ...process.env,
    VIRTUAL_ENV: VENV_DIR,
    PATH: `${path.join(VENV_DIR, "bin")}:${process.env.PATH || ""}`,
    PYTHONUNBUFFERED: "1",
    PYTHONIOENCODING: "utf-8",
  };
}

// qwen-speak prints "Audio saved to: <path>" once it has written the WAV. Pull
// the path back out of stdout. Returns null if the line is not present.
function parseSpeechPath(stdout) {
  if (!stdout) return null;
  const m = /Audio saved to:\s*(.+?)\s*$/m.exec(String(stdout));
  return m ? m[1].trim() : null;
}

// ffmpeg arg vector that synthesises the chime and front-concats it onto the
// speech in a single pass. The ONLY real input is the spoken WAV, passed as
// `-i speechPath`, so it is input 0 and reachable as [0:a]. The chime is NOT an
// input file - it is generated inside filter_complex by the sine source, so it
// needs no input slot. The chime is faded out so it does not click, then both
// streams are resampled to a common 24kHz mono format (the speech is already
// 24kHz mono) and concatenated - chime FIRST, speech SECOND.
function buildAssembleArgs({ speechPath, outPath, chimeSeconds = CHIME_SECONDS }) {
  const normalise = "aresample=24000,aformat=sample_fmts=s16:channel_layouts=mono";
  // 880Hz bell, held for chimeSeconds, faded out over its tail so it rings down.
  const chimeSrc = `sine=frequency=880:duration=${chimeSeconds}`;
  const chimeChain = `${chimeSrc},afade=t=out:st=${chimeSeconds * 0.4}:d=${chimeSeconds * 0.6},${normalise}`;
  const filterComplex = [
    `${chimeChain}[chime]`,
    `[0:a]${normalise}[speech]`,
    `[chime][speech]concat=n=2:v=0:a=1[out]`,
  ].join(";");

  return [
    "-y",
    "-hide_banner",
    "-i", speechPath,
    "-filter_complex", filterComplex,
    "-map", "[out]",
    "-acodec", "pcm_s16le",
    "-ar", "24000",
    "-ac", "1",
    outPath,
  ];
}

// Spawn a child and resolve { code, stdout } once it exits, or null on any
// failure (spawn throws, error event, timeout). Never rejects.
function runChild(spawn, cmd, args, { timeoutMs, signal, cwd, env } = {}) {
  return new Promise((resolve) => {
    let child;
    try {
      const opts = {};
      if (cwd) opts.cwd = cwd;
      if (env) opts.env = env;
      child = spawn(cmd, args, opts);
    } catch (e) {
      // Synchronous spawn failure (e.g. command not found). Surface the reason
      // instead of an opaque null so the caller can log it.
      return resolve({ code: null, stdout: "", stderr: "", failed: `spawn-threw: ${e && e.message ? e.message : e}` });
    }

    let settled = false;
    let timer = null;
    let stdout = "";
    let stderr = "";

    const finish = (value) => {
      if (settled) return;
      settled = true;
      if (timer) clearTimeout(timer);
      if (signal) signal.removeEventListener("abort", onAbort);
      resolve(value);
    };

    const onAbort = () => {
      try { child.kill && child.kill("SIGTERM"); } catch {}
      finish({ code: null, stdout, stderr, failed: "aborted" });
    };

    if (signal) {
      if (signal.aborted) onAbort();
      else signal.addEventListener("abort", onAbort, { once: true });
    }

    if (timeoutMs) {
      timer = setTimeout(() => {
        try { child.kill && child.kill("SIGTERM"); } catch {}
        finish({ code: null, stdout, stderr, failed: `timeout-${timeoutMs}ms` });
      }, timeoutMs);
    }

    if (child.stdout) child.stdout.on("data", (buf) => { stdout += String(buf); });
    // Keep the tail of stderr so a real failure (missing venv, model load error)
    // is diagnosable instead of vanishing.
    if (child.stderr) child.stderr.on("data", (buf) => { stderr = (stderr + String(buf)).slice(-1500); });

    child.on("error", (e) => finish({ code: null, stdout, stderr, failed: `error-event: ${e && e.message ? e.message : e}` }));
    child.on("exit", (code) => finish({ code, stdout, stderr }));
  });
}

// Short tail of a string for log lines.
function tail(s, n = 300) {
  const t = String(s || "").trim().replace(/\s+/g, " ");
  return t.length > n ? "…" + t.slice(-n) : t;
}

// Render `text` to a chime+speech WAV at `outPath`. Returns outPath on success,
// or null on any failure (caller falls back to no intro). Never throws.
async function renderIntro({
  text,
  outPath,
  voice = TTS_VOICE,
  ffmpegPath = defaultFfmpegPath,
  spawn = defaultSpawn,
  shell = "/bin/bash",
  ttsTimeoutMs = 5 * 60 * 1000,
  ffmpegTimeoutMs = 60 * 1000,
  signal,
} = {}) {
  if (!text || !String(text).trim()) { logEvent("tts", "renderIntro: empty text"); return null; }
  if (!outPath) { logEvent("tts", "renderIntro: no outPath"); return null; }
  if (!ffmpegPath) { logEvent("tts", "renderIntro: ffmpegPath unresolved (ffmpeg-static missing?)"); return null; }

  try {
    await fsp.mkdir(path.dirname(outPath), { recursive: true });
  } catch (e) {
    logEvent("tts", `renderIntro: mkdir failed: ${e && e.message ? e.message : e}`);
    return null;
  }

  // 1. Synthesise the speech with qwen-speak by running the venv python directly
  //    (no shell). Parse the WAV path back out of its stdout.
  const speakArgs = buildSpeakArgs(text, voice);
  const t0 = Date.now();
  // Preflight (real runs only - tests inject their own spawn): if the venv python
  // is missing, say so explicitly (a common packaging / relocated-venv failure)
  // rather than an opaque spawn error.
  if (spawn === defaultSpawn) {
    try { await fsp.access(VENV_PYTHON, fs.constants.X_OK); }
    catch { logEvent("tts", `venv python not executable/missing: ${VENV_PYTHON}`); return null; }
  }
  const ttsResult = await runChild(spawn, VENV_PYTHON, speakArgs, {
    timeoutMs: ttsTimeoutMs, signal, cwd: QWENTTS_DIR, env: buildSpeakEnv(),
  });
  const ttsMs = Date.now() - t0;
  if (!ttsResult || ttsResult.code !== 0) {
    logEvent("tts", `qwen-speak failed in ${ttsMs}ms: ${ttsResult ? (ttsResult.failed || `exit ${ttsResult.code}`) : "no result"} | stderr: ${tail(ttsResult && ttsResult.stderr)} | python: ${VENV_PYTHON} cwd: ${QWENTTS_DIR}`);
    return null;
  }

  const speechPath = parseSpeechPath(ttsResult.stdout);
  if (!speechPath) {
    logEvent("tts", `qwen-speak ok (${ttsMs}ms) but could not parse 'Audio saved to:' path | stdout tail: ${tail(ttsResult.stdout)}`);
    return null;
  }

  // Verify qwen-speak actually produced the file it printed before handing the
  // path to ffmpeg. A stale or bogus printed path (no file on disk) is a failure
  // case in its own right - degrade to null now rather than letting ffmpeg choke
  // on a missing input.
  try {
    await fsp.access(speechPath, fs.constants.F_OK);
  } catch {
    logEvent("tts", `parsed speech path does not exist on disk: ${speechPath}`);
    return null;
  }

  // 2. Front-concat the chime onto the speech with ffmpeg.
  const args = buildAssembleArgs({ speechPath, outPath });
  const ffResult = await runChild(spawn, ffmpegPath, args, { timeoutMs: ffmpegTimeoutMs, signal });
  if (!ffResult || ffResult.code !== 0) {
    logEvent("tts", `ffmpeg chime-assembly failed: ${ffResult ? (ffResult.failed || `exit ${ffResult.code}`) : "no result"} | stderr: ${tail(ffResult && ffResult.stderr)} | ffmpeg: ${ffmpegPath}`);
    return null;
  }

  // 3. Confirm the file is actually there and non-empty before claiming success.
  try {
    const st = await fsp.stat(outPath);
    if (!st.size) { logEvent("tts", "assembled intro file is empty"); return null; }
  } catch {
    logEvent("tts", "assembled intro file missing after ffmpeg");
    return null;
  }

  logEvent("tts", `intro built ok in ${Date.now() - t0}ms -> ${outPath}`);
  return outPath;
}

module.exports = {
  renderIntro,
  buildSpeakArgs,
  buildSpeakEnv,
  buildAssembleArgs,
  parseSpeechPath,
  TTS_VOICE,
  QWENTTS_DIR,
  VENV_PYTHON,
  CHIME_SECONDS,
};
