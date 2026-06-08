const fs = require("node:fs");
const fsp = require("node:fs/promises");
const path = require("node:path");
const crypto = require("node:crypto");
const { convert: defaultConvert } = require("./converter.cjs");
const { transcribe: defaultTranscribe } = require("./transcribe.cjs");
const { buildAnnouncementText: defaultBuildAnnouncementText } = require("./announce.cjs");
const { renderIntro: defaultRenderIntro } = require("./tts.cjs");
const { detectAds: defaultDetectAds, toSegments } = require("./detectAds.cjs");

// A detected ad block is treated as a positional intro/outro (and snapped to the
// episode edge) when its first/last segment sits within this many seconds of the
// episode start/end. Snapping the leading block back to 0 also sweeps the
// "unframed" pre-roll cross-promo gap that has no quoted opening line - the bit of
// audio before the first quoted ad segment. Trailing blocks are extended to the
// last segment's end.
const EDGE_SNAP_SEC = 45;

class AbortError extends Error {
  constructor() { super("aborted"); this.name = "AbortError"; }
}

function isOurFilename(name) {
  return /^\d{2}_[a-z]+\.mp3$/.test(name);
}

function computeRemovals({ queue, existingDeviceFiles = [], existingManifest = [] }) {
  const newNames = new Set(queue.map((q) => q.filename));
  const newUuids = new Set(queue.map((q) => q.uuid).filter(Boolean));
  const out = [];
  const seen = new Set();

  for (const m of existingManifest) {
    if (!m || !m.fname) continue;
    if (m.uuid && newUuids.has(m.uuid)) continue;
    const replaced = newNames.has(m.fname);
    out.push({ filename: m.fname, replaced });
    seen.add(m.fname);
  }

  for (const name of existingDeviceFiles) {
    if (!isOurFilename(name)) continue;
    if (newNames.has(name)) continue;
    if (seen.has(name)) continue;
    out.push({ filename: name, replaced: false });
    seen.add(name);
  }
  return out;
}

const MANIFEST_FILE = ".openswim-manifest.json";

async function readManifest(devicePath) {
  if (!devicePath) return [];
  const manifestPath = path.join(devicePath, MANIFEST_FILE);

  let dirNames = [];
  try { dirNames = await fsp.readdir(devicePath); } catch { return []; }
  const dirSet = new Set(dirNames);

  let entries = null;
  try {
    const raw = await fsp.readFile(manifestPath, "utf8");
    const parsed = JSON.parse(raw);
    if (Array.isArray(parsed?.entries)) entries = parsed.entries;
  } catch {}

  if (entries) {
    return entries.filter((e) => e && e.fname && dirSet.has(e.fname));
  }

  const stubs = [];
  for (const name of dirNames) {
    if (!isOurFilename(name)) continue;
    const m = /^(\d{2})_([a-z]+)\.mp3$/.exec(name);
    if (!m) continue;
    let sizeMB;
    try { sizeMB = (await fsp.stat(path.join(devicePath, name))).size / (1024 * 1024); }
    catch {}
    stubs.push({
      uuid: null,
      title: name,
      show: m[2].toUpperCase(),
      fname: name,
      sizeMB: sizeMB != null ? Number(sizeMB.toFixed(1)) : 0,
      slot: parseInt(m[1], 10),
      ext: "mp3",
    });
  }
  stubs.sort((a, b) => a.slot - b.slot);
  return stubs;
}

async function writeManifest(devicePath, queue) {
  if (!devicePath) return;
  const entries = queue.map((it, i) => ({
    uuid: it.uuid,
    title: it.title,
    show: it.show,
    fname: it.filename,
    sizeMB: it.sizeMB,
    durMin: it.durMin,
    ext: it.ext || "mp3",
    slot: it.slot != null ? it.slot : i + 1,
  }));
  const payload = { version: 1, writtenAt: new Date().toISOString(), entries };
  const manifestPath = path.join(devicePath, MANIFEST_FILE);
  await fsp.writeFile(manifestPath, JSON.stringify(payload, null, 2));
}

async function sha256File(p) {
  const hash = crypto.createHash("sha256");
  const stream = fs.createReadStream(p);
  for await (const chunk of stream) hash.update(chunk);
  return hash.digest("hex");
}

async function defaultCopy(src, dest, { onProgress, signal } = {}) {
  const totalBytes = (await fsp.stat(src)).size;
  await fsp.mkdir(path.dirname(dest), { recursive: true });
  await new Promise((resolve, reject) => {
    const read = fs.createReadStream(src);
    const write = fs.createWriteStream(dest);
    let copied = 0;
    let aborted = false;

    const onAbort = () => {
      aborted = true;
      read.destroy();
      write.destroy();
      reject(new AbortError());
    };
    if (signal) {
      if (signal.aborted) return onAbort();
      signal.addEventListener("abort", onAbort, { once: true });
    }

    read.on("data", (chunk) => {
      copied += chunk.length;
      if (onProgress) {
        try { onProgress({ bytes: copied, total: totalBytes }); } catch {}
      }
    });
    read.on("error", (e) => { if (!aborted) reject(e); });
    write.on("error", (e) => { if (!aborted) reject(e); });
    write.on("finish", () => { if (!aborted) resolve(); });
    read.pipe(write);
  });
  return { bytes: totalBytes };
}

// An episode needs the converter (a re-encode) when it is a non-mp3 source, when
// speed/boost is on, or when an intro is being prepended - the front-concat
// resamples and re-encodes, so a plain copy will not do.
function itemNeedsEncode(it, needsEncode) {
  const isVideo = it.ext && it.ext !== "mp3";
  // Trim-on episodes MAY need a re-encode (if auto-applyable cuts come back), so
  // we plan a convert entry for them. The convert loop still degrades to a plain
  // copy when no cuts (and no intro/speed/boost) materialise.
  return isVideo || needsEncode || !!it.announce || !!it.trim;
}

function buildPlan({ queue, existingDeviceFiles = [], existingManifest = [], needsEncode = false }) {
  const plan = [];
  plan.push({ stage: "finalise", kind: "info", text: `order locked · ${queue.length} slots` });

  const removals = computeRemovals({ queue, existingDeviceFiles, existingManifest });
  for (const r of removals) {
    const verb = r.replaced ? "replace" : "rm";
    plan.push({ stage: "delete", kind: "del", text: `${verb} ${r.filename}`, filename: r.filename, replaced: r.replaced });
  }

  for (const it of queue) {
    if (it.announce) {
      plan.push({ stage: "announce", kind: "ann", text: it.title, uuid: it.uuid, slot: it.slot });
    }
  }

  for (const it of queue) {
    if (itemNeedsEncode(it, needsEncode)) {
      plan.push({ stage: "convert", kind: "conv", text: it.title, uuid: it.uuid, slot: it.slot });
    }
  }

  for (const it of queue) {
    plan.push({ stage: "transfer", kind: "xfer", text: it.filename, uuid: it.uuid, slot: it.slot, filename: it.filename });
  }

  plan.push({ stage: "verify", kind: "info", text: `checksum ${queue.length} files` });
  return plan;
}

// Generate the intro WAV for a single episode: transcribe -> announce text ->
// tts. Returns the introPath on success, or null on any failure. Degrades
// safely - the metadata-only announcement text always works even without a
// transcript, and renderIntro falls back to null if TTS/ffmpeg is unavailable.
// Never throws into the pipeline.
//
// Transcription is best-effort, NOT a gate: if the transcriber is unavailable,
// unsupported, or throws, we degrade transcript to null and still build the
// metadata-only announce text ("This is {show}. {title}.") and run TTS. Episode
// identification must never depend on a working transcriber/model.
async function generateIntro({
  it, src, outPath,
  transcribeFn, buildAnnouncementTextFn, renderIntroFn,
  llm, signal,
}) {
  try {
    let transcript = null;
    try {
      transcript = await transcribeFn({ src, signal });
    } catch {
      transcript = null; // no transcript -> metadata-only intro, keep going
    }
    const text = await buildAnnouncementTextFn({
      show: it.show, title: it.title, transcript, llm,
    });
    if (!text || !String(text).trim()) return null;
    const intro = await renderIntroFn({ text, outPath, signal });
    return intro || null;
  } catch {
    return null;
  }
}

// Turn a detected ad range into a proposed cut, applying positional intro/outro
// handling against the full segment list. A detected block whose first segment is
// near the episode start is snapped back to 0 (this also sweeps the unframed
// pre-roll cross-promo gap before the first quoted line); a block whose last
// segment is near the episode end is extended to the very end. Returns a cut
// descriptor { startSec, endSec, needsReview, reasons, label }. Never throws.
function adToCut({ ad, segments }) {
  const reasons = Array.isArray(ad.reasons) ? [...ad.reasons] : [];
  let startSec = ad.startSec;
  let endSec = ad.endSec;
  const labels = [];

  const firstSeg = segments[0];
  const lastSeg = segments[segments.length - 1];
  const episodeStart = firstSeg ? firstSeg.start : 0;
  let episodeEnd = null;
  if (lastSeg) {
    episodeEnd = lastSeg.end != null ? lastSeg.end : lastSeg.start;
  }

  // Leading interstitial: the block opens within EDGE_SNAP_SEC of the episode
  // start. Snap the cut back to the very beginning so the pre-roll gap (anything
  // before the first quoted ad segment) is swept too. This is a high-confidence
  // edge case - the start of an episode is the canonical interstitial slot.
  if (episodeStart != null && Number.isFinite(startSec) && startSec - episodeStart <= EDGE_SNAP_SEC) {
    startSec = episodeStart > 0 ? 0 : episodeStart;
    labels.push("intro");
  }

  // Trailing interstitial: the block closes within EDGE_SNAP_SEC of the episode
  // end. Extend the cut to the last segment's end so a sign-off / outro promo is
  // fully removed.
  if (episodeEnd != null && Number.isFinite(endSec) && episodeEnd - endSec <= EDGE_SNAP_SEC && endSec <= episodeEnd) {
    endSec = episodeEnd;
    labels.push("outro");
  }

  if (labels.length === 0) labels.push("ad");

  return {
    startSec,
    endSec,
    needsReview: !!ad.needsReview,
    reasons,
    label: labels.join("+"),
  };
}

// Run the detector over an episode transcript and turn the result into a cut
// list. Returns { status, cuts } where status is one of:
//   idle | ready | needs-review | skipped
// and cuts is the full proposed list (each { startSec, endSec, needsReview,
// reasons, label }). Only cuts with needsReview === false are auto-applyable; the
// caller passes those into convert and holds the rest for the review layer.
//
// Degrades safely: a missing/failed transcript, an unavailable detector, or any
// thrown error returns { status: "skipped", cuts: [] } so the episode still
// converts uncut. Never throws into the pipeline.
async function generateCuts({
  src, transcribeFn, detectAdsFn, llmFetch, signal,
}) {
  try {
    let transcript = null;
    try {
      transcript = await transcribeFn({ src, signal });
    } catch {
      transcript = null;
    }
    if (!transcript) return { status: "skipped", cuts: [] };

    const segments = toSegments(transcript);
    if (segments.length === 0) return { status: "skipped", cuts: [] };

    let result = null;
    try {
      result = await detectAdsFn({ transcript, fetch: llmFetch, signal });
    } catch {
      result = null;
    }
    if (!result || !Array.isArray(result.ads)) return { status: "skipped", cuts: [] };

    const cuts = result.ads.map((ad) => adToCut({ ad, segments }))
      .filter((c) => Number.isFinite(c.startSec) && Number.isFinite(c.endSec) && c.endSec > c.startSec);

    if (cuts.length === 0) return { status: "ready", cuts: [] };
    const status = cuts.some((c) => c.needsReview) ? "needs-review" : "ready";
    return { status, cuts };
  } catch {
    return { status: "skipped", cuts: [] };
  }
}

async function runSync({
  devicePath, cacheDir, queue,
  speed = 1.0, boost = false,
  convertFn = defaultConvert,
  copyFn = defaultCopy,
  transcribeFn = defaultTranscribe,
  buildAnnouncementTextFn = defaultBuildAnnouncementText,
  renderIntroFn = defaultRenderIntro,
  detectAdsFn = defaultDetectAds,
  llm, llmFetch,
  onEvent,
  signal,
} = {}) {
  if (!devicePath) throw new Error("devicePath is required");
  if (!cacheDir) throw new Error("cacheDir is required");
  if (!Array.isArray(queue)) throw new Error("queue is required");
  const needsEncode = (speed && speed !== 1.0) || !!boost;

  const emit = (e) => { try { onEvent && onEvent(e); } catch {} };
  const throwIfAborted = () => {
    if (signal && signal.aborted) throw new AbortError();
  };

  let existingDeviceFiles = [];
  try { existingDeviceFiles = await fsp.readdir(devicePath); } catch {}
  const existingManifest = await readManifest(devicePath);

  const plan = buildPlan({ queue, existingDeviceFiles, existingManifest, needsEncode });
  emit({ type: "plan", plan });

  // Stage: finalise
  emit({ type: "stage", stage: "finalise", state: "active" });
  emit({ type: "stage", stage: "finalise", state: "done" });

  // Stage: announce
  // For every episode with the Announce toggle on, kick off intro generation in
  // the BACKGROUND so transcription/summarisation/TTS overlap with the delete
  // and copy work happening below. Each episode's intro promise is awaited just
  // before that episode is converted, so the intro is always ready in time for
  // the front-concat. A failed intro degrades to a normal converted episode.
  const announceItems = queue
    .map((it, i) => ({ it, i }))
    .filter(({ it }) => it.announce);
  const introPaths = new Array(queue.length).fill(null);
  const introJobs = new Array(queue.length).fill(null);

  if (announceItems.length) {
    emit({ type: "stage", stage: "announce", state: "active" });
    for (const { it, i } of announceItems) {
      const src = path.join(cacheDir, `${it.uuid}.${it.ext || "mp3"}`);
      const outPath = path.join(cacheDir, `${it.uuid}.intro.wav`);
      emit({ type: "announce", uuid: it.uuid, slot: it.slot, state: "analysing" });
      introJobs[i] = generateIntro({
        it, src, outPath,
        transcribeFn, buildAnnouncementTextFn, renderIntroFn,
        llm, signal,
      }).then((intro) => {
        introPaths[i] = intro;
        emit({
          type: "announce", uuid: it.uuid, slot: it.slot,
          state: intro ? "ready" : "skipped",
        });
        return intro;
      });
    }
  }

  // Stage: trim
  // For every episode with the Trim toggle on, kick off ad detection in the
  // BACKGROUND (alongside announce) so transcription + the LLM windows overlap
  // with the delete/copy work below. Each job's result is awaited just before the
  // episode is converted, so the auto-applyable cut list is ready for the
  // converter's atrim stage. Degrades safely: any failure leaves the episode
  // uncut. We reuse the same transcript path as announce (transcribeFn caches by
  // fingerprint, so a Trim+Announce episode transcribes once).
  const trimItems = queue
    .map((it, i) => ({ it, i }))
    .filter(({ it }) => it.trim);
  // Per-episode resolved trim result: { status, cuts }. Defaults to idle so the
  // convert loop can read trimResults[i] unconditionally.
  const trimResults = new Array(queue.length).fill(null).map(() => ({ status: "idle", cuts: [] }));
  const trimJobs = new Array(queue.length).fill(null);

  if (trimItems.length) {
    emit({ type: "stage", stage: "trim", state: "active" });
    for (const { it, i } of trimItems) {
      const src = path.join(cacheDir, `${it.uuid}.${it.ext || "mp3"}`);
      emit({ type: "trim", uuid: it.uuid, slot: it.slot, state: "analysing" });
      trimJobs[i] = generateCuts({
        src, transcribeFn, detectAdsFn, llmFetch, signal,
      }).then((res) => {
        trimResults[i] = res;
        emit({
          type: "trim", uuid: it.uuid, slot: it.slot,
          state: res.status, cuts: res.cuts,
        });
        return res;
      }).catch(() => {
        // generateCuts already degrades to skipped, but guard so a rejected
        // promise never escapes into Promise.allSettled noise / the pipeline.
        const res = { status: "skipped", cuts: [] };
        trimResults[i] = res;
        emit({ type: "trim", uuid: it.uuid, slot: it.slot, state: "skipped", cuts: [] });
        return res;
      });
    }
  }

  // Stage: delete
  emit({ type: "stage", stage: "delete", state: "active" });
  const removals = computeRemovals({ queue, existingDeviceFiles, existingManifest });
  for (const r of removals) {
    throwIfAborted();
    const verb = r.replaced ? "replace" : "rm";
    emit({ type: "log", stage: "delete", state: "active", text: `${verb} ${r.filename}` });
    if (!r.replaced) {
      try { await fsp.unlink(path.join(devicePath, r.filename)); }
      catch (e) {
        emit({ type: "log", stage: "delete", state: "error", text: `rm ${r.filename}: ${e.message}` });
        throw e;
      }
    }
    emit({ type: "log", stage: "delete", state: "done", text: `${verb} ${r.filename}` });
  }
  emit({ type: "stage", stage: "delete", state: "done" });

  // Let the background intro jobs settle before we convert. They have been
  // running during the delete stage; awaiting here guarantees each introPath is
  // resolved (or null) before its episode is front-concatenated.
  if (announceItems.length) {
    await Promise.allSettled(introJobs.filter(Boolean));
    emit({ type: "stage", stage: "announce", state: "done" });
  }

  // Let the background trim/detect jobs settle before we convert, the same way as
  // the intro jobs - each trimResults[i] is resolved (or degraded to skipped)
  // before its episode is passed to the converter.
  if (trimItems.length) {
    await Promise.allSettled(trimJobs.filter(Boolean));
    emit({ type: "stage", stage: "trim", state: "done" });
  }

  // Stage: convert
  emit({ type: "stage", stage: "convert", state: "active" });
  const sources = new Array(queue.length);
  const speedSuffix = (speed && speed !== 1.0) ? `-speed${String(speed).replace(".", "_")}` : "";
  const boostSuffix = boost ? "-boost" : "";
  for (let i = 0; i < queue.length; i++) {
    throwIfAborted();
    const it = queue[i];
    const downloadedPath = path.join(cacheDir, `${it.uuid}.${it.ext || "mp3"}`);
    const introPath = introPaths[i];
    // Decide encode on the RESOLVED intro, not just the toggle: if Announce was
    // on but the intro was skipped (transcribe/LLM/TTS unavailable) and nothing
    // else forces a re-encode, the episode is a plain mp3 at speed 1.0 and is
    // copied directly - degrading to the normal episode exactly as required.
    const isVideo = it.ext && it.ext !== "mp3";
    // Auto-applyable cuts for this episode: only the cuts that are NOT flagged
    // needs-review. needs-review cuts are deliberately held back from the
    // converter (CARDINAL RULE - never auto-trim an ambiguous / over-threshold
    // boundary); the review layer surfaces them later. The converter takes
    // [startSec,endSec] pairs on the ORIGINAL timeline.
    const autoCuts = (trimResults[i].cuts || [])
      .filter((c) => !c.needsReview)
      .map((c) => [c.startSec, c.endSec]);
    // Whether the episode would still need a re-encode even with the intro AND
    // the cuts dropped (video source, or speed/boost on). Drives the
    // convert-failure fallback below: if false, dropping both means a plain copy.
    const mustEncodeWithoutIntro = isVideo || needsEncode;
    const mustEncode = mustEncodeWithoutIntro || !!introPath || autoCuts.length > 0;
    if (!mustEncode) {
      sources[i] = downloadedPath;
      continue;
    }
    // The intro and the cut set are baked into the variant key so a cached encode
    // is never reused across a different intro/cut combination.
    const introSuffix = introPath ? "-intro" : "";
    const cutSuffix = autoCuts.length
      ? `-trim${crypto.createHash("sha1").update(JSON.stringify(autoCuts)).digest("hex").slice(0, 8)}`
      : "";
    const variantSuffix = `${speedSuffix}${boostSuffix}${introSuffix}${cutSuffix}`;
    const mp3Path = path.join(cacheDir, `${it.uuid}${variantSuffix}.mp3`);
    let cached = false;
    try { cached = (await fsp.stat(mp3Path)).size > 0; } catch {}
    if (cached) {
      sources[i] = mp3Path;
      emit({ type: "log", stage: "convert", state: "done", uuid: it.uuid, text: `${it.title} · cached` });
      continue;
    }
    emit({ type: "log", stage: "convert", state: "active", uuid: it.uuid, text: it.title });
    try {
      await convertFn({
        src: downloadedPath, dest: mp3Path, speed, boost, introPath,
        cuts: autoCuts.length ? autoCuts : null, signal,
        onProgress: ({ seconds, durationSec }) => emit({
          type: "log", stage: "convert", state: "active", uuid: it.uuid, text: it.title,
          bytes: seconds, total: durationSec,
        }),
      });
      sources[i] = mp3Path;
      emit({ type: "log", stage: "convert", state: "done", uuid: it.uuid, text: it.title });
    } catch (e) {
      if (e && e.name === "AbortError") throw e;
      // The intro front-concat and the trim atrim stage are extra steps layered
      // on top of whatever the episode would have needed anyway. If the convert
      // fails while an intro was being prepended OR cuts were being applied, we
      // must never lose the real audio because of those extras. So for ANY
      // episode type we RETRY the normal conversion WITHOUT the introPath AND
      // WITHOUT the cuts. Only if that retry also fails is it a genuine
      // conversion failure that surfaces.
      //
      // - A plain speed-1.0 mp3 has no encode to redo once both are dropped, so
      //   the retry is just a direct copy of the original.
      // - A video / sped / boosted episode is re-encoded plainly so it still
      //   ships as a playable mp3, just without the spoken intro or the trims.
      if (introPath || autoCuts.length > 0) {
        const fallbackSuffix = `${speedSuffix}${boostSuffix}`;
        const fallbackPath = path.join(cacheDir, `${it.uuid}${fallbackSuffix}.mp3`);
        try {
          if (!mustEncodeWithoutIntro) {
            // No re-encode needed once the intro and cuts are dropped - ship the
            // original untouched episode.
            sources[i] = downloadedPath;
          } else {
            let cachedFallback = false;
            try { cachedFallback = (await fsp.stat(fallbackPath)).size > 0; } catch {}
            if (!cachedFallback) {
              await convertFn({
                src: downloadedPath, dest: fallbackPath, speed, boost,
                introPath: null, cuts: null, signal,
                onProgress: ({ seconds, durationSec }) => emit({
                  type: "log", stage: "convert", state: "active", uuid: it.uuid, text: it.title,
                  bytes: seconds, total: durationSec,
                }),
              });
            }
            sources[i] = fallbackPath;
          }
          if (introPath) emit({ type: "announce", uuid: it.uuid, slot: it.slot, state: "skipped" });
          if (autoCuts.length > 0) emit({ type: "trim", uuid: it.uuid, slot: it.slot, state: "skipped", cuts: [] });
          const what = [introPath ? "intro" : null, autoCuts.length ? "trim" : null].filter(Boolean).join("+");
          emit({ type: "log", stage: "convert", state: "done", uuid: it.uuid, text: `${it.title} · ${what} skipped (${e.message})` });
          continue;
        } catch (e2) {
          if (e2 && e2.name === "AbortError") throw e2;
          // The retry without the intro/cuts also failed - this is a real
          // conversion failure, not an intro/trim problem. Surface it.
          emit({ type: "log", stage: "convert", state: "error", uuid: it.uuid, text: `${it.title}: ${e2.message}` });
          throw e2;
        }
      }
      emit({ type: "log", stage: "convert", state: "error", uuid: it.uuid, text: `${it.title}: ${e.message}` });
      throw e;
    }
  }
  emit({ type: "stage", stage: "convert", state: "done" });

  // Stage: transfer
  emit({ type: "stage", stage: "transfer", state: "active" });
  const dests = new Array(queue.length);
  for (let i = 0; i < queue.length; i++) {
    throwIfAborted();
    const it = queue[i];
    const dest = path.join(devicePath, it.filename);
    dests[i] = dest;
    emit({ type: "log", stage: "transfer", state: "active", uuid: it.uuid, text: it.filename });
    try {
      await copyFn(sources[i], dest, {
        signal,
        onProgress: ({ bytes, total }) => emit({
          type: "log", stage: "transfer", state: "active", uuid: it.uuid, text: it.filename,
          bytes, total,
        }),
      });
    } catch (e) {
      try { await fsp.unlink(dest); } catch {}
      emit({ type: "log", stage: "transfer", state: "error", uuid: it.uuid, text: `${it.filename}: ${e.message}` });
      throw e;
    }
    emit({ type: "log", stage: "transfer", state: "done", uuid: it.uuid, text: it.filename });
  }
  emit({ type: "stage", stage: "transfer", state: "done" });

  // Stage: verify
  emit({ type: "stage", stage: "verify", state: "active" });
  for (let i = 0; i < queue.length; i++) {
    throwIfAborted();
    const it = queue[i];
    emit({ type: "log", stage: "verify", state: "active", uuid: it.uuid, text: it.filename });
    const [srcHash, dstHash] = await Promise.all([sha256File(sources[i]), sha256File(dests[i])]);
    if (srcHash !== dstHash) {
      emit({ type: "log", stage: "verify", state: "error", uuid: it.uuid, text: `${it.filename} checksum mismatch` });
      throw new Error(`verify failed: checksum mismatch for ${it.filename}`);
    }
    emit({ type: "log", stage: "verify", state: "done", uuid: it.uuid, text: it.filename });
  }
  emit({ type: "stage", stage: "verify", state: "done" });

  try { await writeManifest(devicePath, queue); }
  catch (e) { emit({ type: "log", stage: "verify", state: "error", text: `manifest: ${e.message}` }); }

  emit({ type: "complete", summary: { count: queue.length } });
  return { ok: true, files: dests };
}

module.exports = { runSync, buildPlan, itemNeedsEncode, generateIntro, generateCuts, adToCut, isOurFilename, sha256File, AbortError, readManifest, writeManifest, MANIFEST_FILE, EDGE_SNAP_SEC };
