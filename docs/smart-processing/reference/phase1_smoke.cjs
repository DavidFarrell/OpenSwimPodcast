// End-to-end smoke test of the committed Phase 1 modules with REAL dependencies:
// real gemma-4-12b-qat at :1234, real qwen-speak, real ffmpeg. No mocks.
const path = require("path");
const fs = require("fs");
const { execFileSync } = require("child_process");

const E = "/Users/david/git/ai-sandbox/projects/OpenSwimPodcast/app/electron";
const announce = require(path.join(E, "announce.cjs"));
const tts = require(path.join(E, "tts.cjs"));
const converter = require(path.join(E, "converter.cjs"));
const ffmpeg = require(path.join(E, "..", "node_modules", "ffmpeg-static"));

const OUT = "/tmp/ric/smoke_out";
fs.mkdirSync(OUT, { recursive: true });

const SHOW = "The Rest Is Classified";
// In the real app this title comes from Pocket Casts metadata; using the real ep topic here.
const TITLE = "Could the CIA Break the Transatlantic Alliance?";

function dur(p) {
  try {
    return parseFloat(execFileSync(ffmpeg.replace("ffmpeg", "ffprobe").includes("ffprobe") ? "ffprobe" : "ffprobe",
      ["-v", "error", "-show_entries", "format=duration", "-of", "csv=p=0", p]).toString().trim());
  } catch { return null; }
}

(async () => {
  // 1. transcript: normalise the real diarizer turns into the {segments:[{text}]} shape transcribe.cjs emits
  const raw = JSON.parse(fs.readFileSync("/tmp/ric/transcript.json", "utf8"));
  const src = raw.turns && raw.turns.length ? raw.turns : raw.segments;
  const transcript = {
    segments: src
      .map((s) => ({ speaker: s.speaker, start: s.start, end: s.end, text: typeof s.text === "string" ? s.text : "" }))
      .filter((s) => s.text.length > 0),
  };
  console.log(`[transcript] ${transcript.segments.length} segments with text`);

  // 2. REAL announce -> real gemma summary
  console.log("[announce] calling real gemma-4-12b-qat at :1234 ...");
  const t0 = Date.now();
  const text = await announce.buildAnnouncementText({
    show: SHOW, title: TITLE, transcript, llm: { fetch: globalThis.fetch },
  });
  console.log(`[announce] (${((Date.now() - t0) / 1000).toFixed(1)}s) intro text:\n   "${text}"`);

  // metadata-only comparison (no llm)
  const meta = await announce.buildAnnouncementText({ show: SHOW, title: TITLE });
  console.log(`[announce] metadata-only fallback would be:\n   "${meta}"`);

  // 3. REAL tts -> chime + qwen-speak Ryan
  console.log("[tts] rendering chime + qwen-speak (Ryan) ...");
  const t1 = Date.now();
  const introWav = path.join(OUT, "intro.wav");
  const wav = await tts.renderIntro({ text, outPath: introWav });
  if (!wav) { console.error("[tts] FAILED -> null (would degrade to no intro)"); process.exit(2); }
  console.log(`[tts] (${((Date.now() - t1) / 1000).toFixed(1)}s) intro WAV: ${wav}  dur=${dur(wav)}s`);

  // 4. REAL converter -> final intro'd mp3 at speed 1.5 + boost (the episode sped up, intro normal speed)
  console.log("[convert] front-concat intro + episode @ speed 1.5 boost ...");
  const t2 = Date.now();
  const dest = path.join(OUT, "ric_intro_speed15_boost.mp3");
  try { fs.unlinkSync(dest); } catch {}
  const res = await converter.convert({
    src: "/tmp/ric/episode.mp3", dest, speed: 1.5, boost: true, introPath: wav,
  });
  console.log(`[convert] (${((Date.now() - t2) / 1000).toFixed(1)}s) -> ${dest}  bytes=${res.bytes}  dur=${dur(dest)}s`);

  // 5. control: same episode WITHOUT intro, to compare durations
  const destNoIntro = path.join(OUT, "ric_speed15_boost_nointro.mp3");
  try { fs.unlinkSync(destNoIntro); } catch {}
  await converter.convert({ src: "/tmp/ric/episode.mp3", dest: destNoIntro, speed: 1.5, boost: true });
  console.log(`[control] no-intro version dur=${dur(destNoIntro)}s (final should be ~intro + this)`);

  // 6. preview: first 25s of the final mp3 so David can hear chime + intro + start
  const preview = path.join(OUT, "PREVIEW_first25s.mp3");
  try { fs.unlinkSync(preview); } catch {}
  execFileSync(ffmpeg, ["-y", "-hide_banner", "-loglevel", "error", "-i", dest, "-t", "25", "-c", "copy", preview]);
  console.log(`[preview] first 25s -> ${preview}`);
  console.log("\nDONE.");
})().catch((e) => { console.error("SMOKE FAILED:", e); process.exit(1); });
