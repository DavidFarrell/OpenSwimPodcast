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

// Build the shell command that runs qwen-speak. The CLI requires a cd into the
// project, a venv activation, then `python tts_engine_v2.py speak "<text>"
// --voice Ryan`. The text is single-quoted (with any embedded single quotes
// escaped) so it survives the shell as one argument.
function shellQuote(s) {
  return `'${String(s).replace(/'/g, `'\\''`)}'`;
}

function buildSpeakCommand(text, voice = TTS_VOICE) {
  return [
    `cd ${shellQuote(QWENTTS_DIR)}`,
    "source .venv/bin/activate",
    `python tts_engine_v2.py speak ${shellQuote(text)} --voice ${shellQuote(voice)}`,
  ].join(" && ");
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
function runChild(spawn, cmd, args, { timeoutMs, signal } = {}) {
  return new Promise((resolve) => {
    let child;
    try {
      child = spawn(cmd, args);
    } catch {
      return resolve(null);
    }

    let settled = false;
    let timer = null;
    let stdout = "";

    const finish = (value) => {
      if (settled) return;
      settled = true;
      if (timer) clearTimeout(timer);
      if (signal) signal.removeEventListener("abort", onAbort);
      resolve(value);
    };

    const onAbort = () => {
      try { child.kill && child.kill("SIGTERM"); } catch {}
      finish(null);
    };

    if (signal) {
      if (signal.aborted) onAbort();
      else signal.addEventListener("abort", onAbort, { once: true });
    }

    if (timeoutMs) {
      timer = setTimeout(() => {
        try { child.kill && child.kill("SIGTERM"); } catch {}
        finish(null);
      }, timeoutMs);
    }

    if (child.stdout) child.stdout.on("data", (buf) => { stdout += String(buf); });
    // Drain stderr so a full pipe never blocks the child.
    if (child.stderr) child.stderr.on("data", () => {});

    child.on("error", () => finish(null));
    child.on("exit", (code) => finish({ code, stdout }));
  });
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
  if (!text || !String(text).trim()) return null;
  if (!outPath) return null;
  if (!ffmpegPath) return null;

  try {
    await fsp.mkdir(path.dirname(outPath), { recursive: true });
  } catch {
    return null;
  }

  // 1. Synthesise the speech with qwen-speak (run through a shell because the CLI
  //    needs cd + venv activation). Parse the WAV path back out of its stdout.
  const speakCmd = buildSpeakCommand(text, voice);
  const ttsResult = await runChild(spawn, shell, ["-lc", speakCmd], { timeoutMs: ttsTimeoutMs, signal });
  if (!ttsResult || ttsResult.code !== 0) return null;

  const speechPath = parseSpeechPath(ttsResult.stdout);
  if (!speechPath) return null;

  // Verify qwen-speak actually produced the file it printed before handing the
  // path to ffmpeg. A stale or bogus printed path (no file on disk) is a failure
  // case in its own right - degrade to null now rather than letting ffmpeg choke
  // on a missing input.
  try {
    await fsp.access(speechPath, fs.constants.F_OK);
  } catch {
    return null;
  }

  // 2. Front-concat the chime onto the speech with ffmpeg.
  const args = buildAssembleArgs({ speechPath, outPath });
  const ffResult = await runChild(spawn, ffmpegPath, args, { timeoutMs: ffmpegTimeoutMs, signal });
  if (!ffResult || ffResult.code !== 0) return null;

  // 3. Confirm the file is actually there and non-empty before claiming success.
  try {
    const st = await fsp.stat(outPath);
    if (!st.size) return null;
  } catch {
    return null;
  }

  return outPath;
}

module.exports = {
  renderIntro,
  buildSpeakCommand,
  buildAssembleArgs,
  parseSpeechPath,
  shellQuote,
  TTS_VOICE,
  QWENTTS_DIR,
  CHIME_SECONDS,
};
