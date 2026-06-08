const fs = require("node:fs");
const fsp = require("node:fs/promises");
const path = require("node:path");
const os = require("node:os");
const { spawn: defaultSpawn } = require("node:child_process");

// fast-diarise lives outside this repo and is driven through `uv run`. We keep
// the command here so the caller does not have to know the layout - tests inject
// their own spawn so the real binary is never touched.
const FAST_DIARIZE_DIR = "/Users/david/git/ai-sandbox/projects/fast_mac_transcribe_diarise_local_models_only";
const FAST_DIARIZE_CMD = "uv";

function buildArgs({ src, outTxt, outJson }) {
  return [
    "run",
    "--directory", FAST_DIARIZE_DIR,
    "diarise-transcribe",
    "--in", src,
    "--out", outTxt,
    "--out-json", outJson,
    "--verbose",
  ];
}

// fast-diarise writes a fingerprint-keyed sidecar next to the audio so a second
// pass over the same episode reuses prior work instead of re-transcribing.
async function fingerprint(src) {
  const st = await fsp.stat(src);
  // size+mtime is enough to spot "same episode, untouched file" and is cheap -
  // no need to hash potentially large audio.
  return `${st.size}-${Math.floor(st.mtimeMs)}`;
}

function sidecarPath(src, fp) {
  const dir = path.dirname(src);
  const base = path.basename(src);
  return path.join(dir, `.${base}.transcript.${fp}.json`);
}

// The CLI emits { turns: [...], segments: [...] }. The turns carry the text we
// care about; the bare segments do not. Normalise both shapes into a single
// segments array of { speaker, start, end, text }.
function normalise(parsed) {
  if (!parsed || typeof parsed !== "object") return null;
  const source = Array.isArray(parsed.turns) && parsed.turns.length
    ? parsed.turns
    : Array.isArray(parsed.segments) ? parsed.segments : null;
  if (!source) return null;

  const segments = source
    .map((s) => ({
      speaker: s.speaker != null ? String(s.speaker) : null,
      start: typeof s.start === "number" ? s.start : null,
      end: typeof s.end === "number" ? s.end : null,
      text: typeof s.text === "string" ? s.text : "",
    }))
    .filter((s) => s.text.length > 0);

  if (!segments.length) return null;
  return { segments };
}

async function readSidecar(p) {
  try {
    const raw = await fsp.readFile(p, "utf8");
    return normalise(JSON.parse(raw));
  } catch {
    return null;
  }
}

// Run fast-diarise over an audio file and return its parsed transcript, or null.
// Degrades safely: a missing binary, a non-zero exit, a timeout, or empty/garbage
// JSON all resolve to null so the caller can fall back to metadata-only. Never
// throws into the pipeline.
async function transcribe({
  src,
  spawn = defaultSpawn,
  timeoutMs = 10 * 60 * 1000,
  signal,
} = {}) {
  if (!src) return null;

  let fp;
  try {
    fp = await fingerprint(src);
  } catch {
    // Audio file is gone or unreadable - nothing to transcribe.
    return null;
  }

  // Cache hit: reuse the fingerprint-keyed sidecar, never spawn.
  const cachePath = sidecarPath(src, fp);
  const cached = await readSidecar(cachePath);
  if (cached) return cached;

  // fast-diarise writes the JSON itself; use a temp file we own, then read it.
  const tmpDir = await fsp.mkdtemp(path.join(os.tmpdir(), "os-transcribe-"));
  const outJson = path.join(tmpDir, "out.json");
  const outTxt = path.join(tmpDir, "out.txt");
  const args = buildArgs({ src, outTxt, outJson });

  const cleanup = () => { fsp.rm(tmpDir, { recursive: true, force: true }).catch(() => {}); };

  const result = await new Promise((resolve) => {
    let child;
    try {
      child = spawn(FAST_DIARIZE_CMD, args);
    } catch {
      // Binary missing / spawn failed.
      return resolve(null);
    }

    let settled = false;
    let timer = null;
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

    timer = setTimeout(() => {
      try { child.kill && child.kill("SIGTERM"); } catch {}
      finish(null);
    }, timeoutMs);

    // Drain stdio so the child never blocks on a full pipe.
    if (child.stdout) child.stdout.on("data", () => {});
    if (child.stderr) child.stderr.on("data", () => {});

    child.on("error", () => finish(null));
    child.on("exit", async (code) => {
      if (code !== 0) return finish(null);
      try {
        const raw = await fsp.readFile(outJson, "utf8");
        const parsed = normalise(JSON.parse(raw));
        finish(parsed);
      } catch {
        // No JSON emitted, or it was unparseable.
        finish(null);
      }
    });
  });

  cleanup();

  // Persist the sidecar so the next pass is a cache hit. Failure to cache is not
  // fatal - we still return what we parsed.
  if (result) {
    try {
      await fsp.writeFile(cachePath, JSON.stringify(result), "utf8");
    } catch {}
  }

  return result;
}

module.exports = { transcribe, fingerprint, sidecarPath, normalise, buildArgs };
