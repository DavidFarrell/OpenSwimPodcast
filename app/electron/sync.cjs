const fs = require("node:fs");
const fsp = require("node:fs/promises");
const path = require("node:path");
const crypto = require("node:crypto");
const { convert: defaultConvert } = require("./converter.cjs");
const { transcribe: defaultTranscribe } = require("./transcribe.cjs");
const { buildAnnouncementText: defaultBuildAnnouncementText } = require("./announce.cjs");
const { renderIntro: defaultRenderIntro } = require("./tts.cjs");
const { detectAds: defaultDetectAds, toSegments } = require("./detectAds.cjs");
const { readDecisions: defaultReadDecisions, applyDecisions, readCutSet: defaultReadCutSet } = require("./decisionCache.cjs");
const { logEvent } = require("./logger.cjs");

// A detected ad block is treated as a positional intro/outro (and snapped to the
// episode edge) when its first/last segment sits within this many seconds of the
// episode start/end. Snapping the leading block back to 0 also sweeps the
// "unframed" pre-roll cross-promo gap that has no quoted opening line - the bit of
// audio before the first quoted ad segment. Trailing blocks are extended to the
// last segment's end.
const EDGE_SNAP_SEC = 45;

// Post-edge-snap safety net (GPT-5 guard spec, cardinal-critical). The edge-snap
// above can extend a cut all the way to 0 / the episode end; a short detected span
// that snaps to a long edge cut must not pre-select. So AFTER the snap, a cut is
// forced needsReview (left grey, not pre-selected) if the FINAL duration exceeds
// HARD_FINAL_CUT_MAX_SEC, or if the snap GREW the cut by more than
// EDGE_SNAP_GROWTH_MAX_SEC. HARD_FINAL_CUT_MAX_SEC is now a PRE-SELECT sanity ceiling
// (not blind-cut protection): the review gate surfaces every cut for approval before
// any write, so the ceiling just stops a runaway-long final span from pre-selecting.
// Set to 360 to match detectAds.cjs HARD_AUTOCUT_MAX_SEC - safely above the measured
// max real-ad length (292s). The EDGE_SNAP_GROWTH_MAX_SEC guard (15s) is UNCHANGED:
// a short span the snap balloons is still held, because that growth is the boundary
// being fabricated by the snap, not a confidently-mapped long read. This applies
// regardless of detector mode and is INDEPENDENT of sensitivity. A cut already within
// both bounds keeps its original flagging.
const HARD_FINAL_CUT_MAX_SEC = 360;
const EDGE_SNAP_GROWTH_MAX_SEC = 15;

// Bumped whenever the intro CHANGES in a way that the variant cache key would not
// otherwise capture - the intro WORDING (Fix 1: episode/season number + publish
// date now spoken) or how the intro is PROCESSED (the sibling lane now speeds +
// loudness-matches the intro speech to the episode). Folded into the intro part
// of the cache key so every pre-fix intro encode is invalidated and a stale
// "slow/quiet/no-metadata intro" mp3 is never reused. Bump this on any future
// intro pipeline change.
const INTRO_PIPELINE_VERSION = 2;

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
// tts. Returns { introPath, text } - introPath is the rendered WAV on success or
// null on any failure; text is the announcement string that was spoken (or "").
// The text is returned so the convert loop can fold a hash of it into the cache
// variant key, invalidating a stale cached encode when the intro wording changes
// (Fix 1/3). Degrades safely - the metadata-only announcement text always works
// even without a transcript, and renderIntro falls back to null if TTS/ffmpeg is
// unavailable. Never throws into the pipeline.
//
// Transcription is best-effort, NOT a gate: if the transcriber is unavailable,
// unsupported, or throws, we degrade transcript to null and still build the
// metadata-only announce text ("This is {show}. {title}.") and run TTS. Episode
// identification must never depend on a working transcriber/model.
async function generateIntro({
  it, src, outPath,
  transcribeFn, buildAnnouncementTextFn, renderIntroFn,
  llm, signal,
  transcript: providedTranscript, hasTranscript = false,
}) {
  try {
    // The orchestrator transcribes once per episode and passes the result in
    // (hasTranscript=true even when the value is null, so we never re-transcribe).
    // Older callers/tests omit it, so we still transcribe here as a fallback.
    let transcript = providedTranscript || null;
    if (!hasTranscript) {
      try {
        transcript = await transcribeFn({ src, signal });
      } catch (e) {
        transcript = null; // no transcript -> metadata-only intro, keep going
        logEvent("announce", `transcribe failed for "${it.title}": ${e && e.message ? e.message : e}`);
      }
    }
    const text = await buildAnnouncementTextFn({
      show: it.show, title: it.title, transcript, llm,
      // Deterministic metadata (Fix 1): episode/season number + publish date are
      // spoken when the feed has them. These never depend on the transcript/LLM.
      published: it.published, episodeNumber: it.episodeNumber, seasonNumber: it.seasonNumber,
    });
    if (!text || !String(text).trim()) {
      logEvent("announce", `no announcement text for "${it.title}" - intro skipped`);
      return { introPath: null, text: "" };
    }
    let intro = await renderIntroFn({ text, outPath, signal });
    // One retry: TTS (qwen-speak/MLX) can fail transiently under load. Only retry
    // a clean null (not an abort), so the happy path still calls render once.
    if (!intro && !(signal && signal.aborted)) {
      logEvent("announce", `TTS render returned null for "${it.title}" - retrying once`);
      intro = await renderIntroFn({ text, outPath, signal });
    }
    if (!intro) logEvent("announce", `TTS/render failed for "${it.title}" - intro skipped (check qwen-speak / ffmpeg)`);
    return { introPath: intro || null, text };
  } catch (e) {
    logEvent("announce", `intro generation threw for "${it.title}": ${e && e.message ? e.message : e}`);
    return { introPath: null, text: "" };
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

  // The detected span BEFORE any edge-snap, so the post-snap guard can measure how
  // much the snap grew the cut.
  const preSnapStart = startSec;
  const preSnapEnd = endSec;

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

  // Post-edge-snap guard (safety net, all modes). If the snap pushed the FINAL cut
  // over the hard cap, or grew it by more than the allowed amount, hold it for
  // review. We only ADD flagging here - a cut already flagged stays flagged, and a
  // cut within both bounds is left exactly as it came in (legacy auto-applies stay
  // auto-applied). Independent of sensitivity; the caps are absolute.
  let needsReview = !!ad.needsReview;
  const finalDur = (Number.isFinite(startSec) && Number.isFinite(endSec)) ? endSec - startSec : null;
  const preSnapDur = (Number.isFinite(preSnapStart) && Number.isFinite(preSnapEnd))
    ? preSnapEnd - preSnapStart : null;
  const growth = (finalDur != null && preSnapDur != null) ? finalDur - preSnapDur : 0;
  if (finalDur != null && finalDur > HARD_FINAL_CUT_MAX_SEC) {
    needsReview = true;
    if (!reasons.includes("post-snap-hard-cap")) reasons.push("post-snap-hard-cap");
  }
  if (growth > EDGE_SNAP_GROWTH_MAX_SEC) {
    needsReview = true;
    if (!reasons.includes("edge-snap-growth")) reasons.push("edge-snap-growth");
  }

  return {
    startSec,
    endSec,
    needsReview,
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
// Before the cut list is returned, any persisted review decision for THIS episode
// (keyed by audio fingerprint, see decisionCache.cjs) is applied: a cut the user
// previously chose to REMOVE is un-flagged so it auto-applies (never re-asked); a
// cut the user previously chose to KEEP is dropped (never re-flagged). A cut with
// no recorded decision keeps its original flagging. This is what makes a reviewed
// episode stick across re-processing.
//
// Degrades safely: a missing/failed transcript, an unavailable detector, or any
// thrown error returns { status: "skipped", cuts: [] } so the episode still
// converts uncut. A missing/corrupt decision cache is treated as "no decisions"
// (the cut list is flagged exactly as detected). Never throws into the pipeline.
async function generateCuts({
  src, transcribeFn, detectAdsFn, llmFetch, model, needsReviewMaxSec, signal,
  // The detector mode, passed EXPLICITLY into detectAds. Defaults to "legacy" so
  // the shipped pipeline is always the locked detector, NEVER the env-driven
  // fallback (a stray OSW_DETECTOR_MODE must never flip production to gepa). The
  // production caller (ipc.cjs) does not set this, so it stays "legacy"; Phase 2's
  // head-to-head calls with detectorMode:"gepa".
  detectorMode = "legacy",
  readDecisionsFn = defaultReadDecisions,
  readCutSetFn = defaultReadCutSet,
  transcript: providedTranscript, hasTranscript = false,
}) {
  try {
    // The orchestrator transcribes once per episode and passes it in
    // (hasTranscript=true even when null, so we never re-transcribe). Older
    // callers/tests omit it, so we fall back to transcribing here.
    let transcript = providedTranscript || null;
    if (!hasTranscript) {
      try {
        transcript = await transcribeFn({ src, signal });
      } catch (e) {
        transcript = null;
        logEvent("trim", `transcribe failed: ${e && e.message ? e.message : e}`);
      }
    }
    if (!transcript) { logEvent("trim", "no transcript - trim skipped (is fast-diarise/uv on PATH? is LM Studio running?)"); return { status: "skipped", cuts: [] }; }

    const segments = toSegments(transcript);
    if (segments.length === 0) { logEvent("trim", "transcript had no usable segments - trim skipped"); return { status: "skipped", cuts: [] }; }

    let result = null;
    try {
      // model is the user-picked LM Studio model id (P4a). When undefined,
      // detectAds falls back to its own LMSTUDIO_MODEL default, so the locked
      // detector keeps working unchanged.
      // mode is passed EXPLICITLY (default "legacy") so detectAds never falls back
      // to OSW_DETECTOR_MODE on the production path - the shipped pipeline is always
      // the locked detector unless a caller deliberately opts into "gepa".
      const detectArgs = { transcript, fetch: llmFetch, signal, mode: detectorMode };
      if (model) detectArgs.model = model;
      // needsReviewMaxSec is the user-picked sensitivity threshold (P4b). When
      // undefined, detectAds falls back to its own NEEDS_REVIEW_MAX_SEC default,
      // so the locked behaviour is unchanged. It only tunes flag-vs-auto-apply;
      // the quote-map fail-safe and ambiguous-boundary flagging are unaffected.
      if (Number.isFinite(needsReviewMaxSec) && needsReviewMaxSec > 0) {
        detectArgs.needsReviewMaxSec = needsReviewMaxSec;
      }
      result = await detectAdsFn(detectArgs);
    } catch (e) {
      result = null;
      logEvent("trim", `detector failed: ${e && e.message ? e.message : e}`);
    }
    if (!result || !Array.isArray(result.ads)) { logEvent("trim", "detector returned no result - trim skipped (is LM Studio running with the model loaded?)"); return { status: "skipped", cuts: [] }; }

    const detected = result.ads.map((ad) => adToCut({ ad, segments }))
      .filter((c) => Number.isFinite(c.startSec) && Number.isFinite(c.endSec) && c.endSec > c.startSec);

    // PRECEDENCE: a previously-reviewed EXPLICIT cut-set for this exact episode wins
    // over the detector AND the legacy decision map. The transcript-toggle redesign
    // persists the user's final selection as a first-class cut-set (decisionCache
    // readCutSet); when one exists for this audio fingerprint, REPLACE the detector's
    // cuts with exactly those ranges so the reviewed choice sticks across re-process -
    // including an EMPTY set (the user reviewed and chose to cut nothing -> no cuts),
    // a de-selected confident cut, and a user-ADDED range the detector never proposed.
    // readCutSet returns null when NO cut-set was persisted (never reviewed), in which
    // case we fall back to the detector + legacy decision path below. A cut-set is
    // emitted as confident (needsReview:false) so that, when re-surfaced for review
    // (Fix 1), it starts pre-yellow == the user's prior selection.
    let savedCutSet = null;
    try {
      savedCutSet = await readCutSetFn({ src });
    } catch {
      savedCutSet = null;
    }
    let cuts;
    if (Array.isArray(savedCutSet)) {
      cuts = savedCutSet
        .map((r) => ({ startSec: Number(r[0]), endSec: Number(r[1]), needsReview: false, reasons: [], label: "ad", decided: "remove" }))
        .filter((c) => Number.isFinite(c.startSec) && Number.isFinite(c.endSec) && c.endSec > c.startSec);
      logEvent("trim", `reusing reviewed cut-set: ${cuts.length} range(s) replace ${detected.length} detected cut(s)`);
    } else {
      // No reviewed cut-set. Reuse any legacy per-cut decisions for this episode (a
      // cache miss / corrupt cache yields {} so the cut list is flagged as detected).
      let decisions = {};
      try {
        decisions = await readDecisionsFn({ src });
      } catch {
        decisions = {};
      }
      cuts = applyDecisions(detected, decisions);
    }

    if (cuts.length === 0) return { status: "ready", cuts: [], segments: [] };
    const status = cuts.some((c) => c.needsReview) ? "needs-review" : "ready";
    // Carry the normalised segments so the renderer's Advanced transcript-as-
    // evidence view (P3d) can highlight the cut ranges in context. Read-only data.
    return { status, cuts, segments };
  } catch {
    return { status: "skipped", cuts: [] };
  }
}

// Resolve one reviewed episode's FINAL cut list from the gate's decision for it.
// The gate resolves per uuid to ONE OF two shapes:
//
//   (a) LEGACY decision map { cutKey: "keep" | "remove" | {action,startSec,endSec} }
//       - the per-detected-cut keep/remove (+ boundary edit) model. Folded via
//         applyDecisions exactly as before: a "remove" un-flags the detected cut so
//         it auto-applies, "keep" drops it, an undecided flagged cut stays held.
//
//   (b) EXPLICIT cut-set { __cutSet: [[startSec,endSec], ...] } - the transcript-
//       toggle redesign's output. The user reviewed the WHOLE transcript and the
//       returned ranges ARE the authoritative final cut set for the episode: REPLACE
//       the episode's cuts with exactly these ranges as auto-apply (needsReview:false)
//       cuts. Nothing the user did not select is cut; the detector's original flagged
//       cuts are discarded in favour of the user's explicit set. An empty / missing
//       __cutSet means the user selected nothing -> NO cuts (cardinal-rule safe: the
//       episode ships untouched).
//
// CARDINAL RULE: in BOTH shapes, only what the user affirmatively chose is cut. The
// explicit set is fail-closed by construction - a malformed range (non-finite or
// non-forward) is dropped, never widened, so an ambiguous range is never cut.
function resolveEpisodeCuts(detectedCuts, decision) {
  const cuts = Array.isArray(detectedCuts) ? detectedCuts : [];
  if (decision && typeof decision === "object" && Array.isArray(decision.__cutSet)) {
    const out = [];
    for (const r of decision.__cutSet) {
      const s = Array.isArray(r) ? Number(r[0]) : Number(r && r.startSec);
      const e = Array.isArray(r) ? Number(r[1]) : Number(r && r.endSec);
      if (!Number.isFinite(s) || !Number.isFinite(e) || !(e > s) || s < 0) continue;
      out.push({ startSec: s, endSec: e, needsReview: false, reasons: [], label: "ad", decided: "remove" });
    }
    out.sort((a, b) => a.startSec - b.startSec);
    return out;
  }
  // Legacy per-cut decision map.
  return applyDecisions(cuts, decision || {});
}

// The review gate. When an episode has cuts still flagged needs-review after
// detection, the pipeline HOLDS here and hands the flagged items to this
// callback, which resolves to a per-uuid decision ({ uuid: <decision> }) once the
// user has decided. <decision> is EITHER a legacy per-cut map ({ cutKey: "keep" |
// "remove" | {action,startSec,endSec} }) OR an explicit final cut-set
// ({ __cutSet: [[startSec,endSec], ...] } - the transcript-toggle redesign). See
// resolveEpisodeCuts. The default resolves to {} immediately - no decisions, so
// every flagged cut stays held back (never auto-applied; cardinal rule) and the run
// continues exactly as it did before the gate existed. The IPC layer injects the
// real interactive implementation; unit tests inject their own, so this default
// never blocks them.
async function defaultAwaitReview() { return {}; }

async function runSync({
  devicePath, cacheDir, queue,
  speed = 1.0, boost = false,
  convertFn = defaultConvert,
  copyFn = defaultCopy,
  transcribeFn = defaultTranscribe,
  buildAnnouncementTextFn = defaultBuildAnnouncementText,
  renderIntroFn = defaultRenderIntro,
  detectAdsFn = defaultDetectAds,
  readDecisionsFn = defaultReadDecisions,
  readCutSetFn = defaultReadCutSet,
  awaitReview = defaultAwaitReview,
  // Best-effort probe of an output file's real duration (seconds). Defaults to a
  // null no-op so unit tests stay hermetic (no ffmpeg spawn); the IPC layer
  // injects the real ffmpeg-based probe so the success screen can report the
  // ACTUAL processed duration instead of the original feed length.
  probeDurationFn = async () => null,
  llm, llmFetch, model, needsReviewMaxSec,
  // Detector mode for the whole run, threaded into generateCuts -> detectAds.
  // Defaults to "legacy"; the production caller (ipc.cjs) leaves it unset so the
  // shipped pipeline is always the locked detector. Phase 2's head-to-head passes
  // detectorMode:"gepa" here.
  detectorMode = "legacy",
  onEvent,
  signal,
} = {}) {
  if (!devicePath) throw new Error("devicePath is required");
  if (!cacheDir) throw new Error("cacheDir is required");
  if (!Array.isArray(queue)) throw new Error("queue is required");
  const needsEncode = (speed && speed !== 1.0) || !!boost;

  // The trim detector and the announce summary both reach the local LLM through a
  // fetch. The IPC caller does not inject one, so default to the main process's
  // global fetch. WITHOUT this, detectAds saw fetch=undefined and silently
  // returned zero ads (no log), and the announce summary was skipped - the exact
  // "no trim, metadata-only intro" failure. Unit tests inject their own mocks, so
  // this default never touches them.
  if (typeof llmFetch !== "function" && typeof globalThis.fetch === "function") {
    llmFetch = globalThis.fetch.bind(globalThis);
  }
  if ((!llm || typeof llm.fetch !== "function") && typeof llmFetch === "function") {
    llm = { ...(llm || {}), fetch: llmFetch };
  }

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

  const announceItems = queue
    .map((it, i) => ({ it, i }))
    .filter(({ it }) => it.announce);
  const trimItems = queue
    .map((it, i) => ({ it, i }))
    .filter(({ it }) => it.trim);
  // Per-episode resolved outputs the convert loop reads unconditionally.
  const introPaths = new Array(queue.length).fill(null);
  // The spoken announcement text per episode, kept alongside introPaths so the
  // convert loop can hash it into the cache variant key (Fix 1/3): a changed
  // intro wording for the same episode invalidates the cached encode.
  const introTexts = new Array(queue.length).fill("");
  const trimResults = new Array(queue.length).fill(null).map(() => ({ status: "idle", cuts: [] }));

  // NOTE: "Stage: delete" (remove superseded device files) USED to run here, before
  // the analysis + the review gate. That was a data-loss footgun: cancelling at the
  // review gate left the device's old files already deleted with NOTHING written in
  // their place. The delete block has been MOVED to AFTER the gate resolves (into the
  // Transferring phase, just before convert) so a cancel-at-gate leaves the device
  // untouched. See the relocated block below, just before "Stage: convert". What gets
  // deleted is unchanged (same computeRemovals); only WHEN it runs has moved.

  // Stage: analyse (transcribe -> detect cuts -> build intro)
  // SEQUENTIAL, one episode at a time, one GPU-heavy step at a time. Running
  // transcription (Parakeet/MLX), ad-detection (gemma/Metal) and TTS (qwen/MLX)
  // concurrently starved each other: detection silently returned empty and TTS
  // failed under GPU contention, so nothing got trimmed. Doing one thing at a
  // time is slower but reliable, and it makes each step a visible stage.
  // We transcribe ONCE per episode and feed the same transcript to both the
  // detector and the intro builder, so a Trim+Announce episode transcribes once.
  const analyseItems = queue
    .map((it, i) => ({ it, i }))
    .filter(({ it }) => it.announce || it.trim);

  if (analyseItems.length) emit({ type: "stage", stage: "transcribe", state: "active" });
  if (trimItems.length) emit({ type: "stage", stage: "trim", state: "active" });
  if (announceItems.length) emit({ type: "stage", stage: "announce", state: "active" });

  for (const { it, i } of analyseItems) {
    throwIfAborted();
    const src = path.join(cacheDir, `${it.uuid}.${it.ext || "mp3"}`);
    logEvent("analyse", `"${it.title}": trim=${!!it.trim} announce=${!!it.announce} llmFetch=${typeof llmFetch === "function"}`);

    // 1. Transcribe once (shared by detect + intro).
    emit({ type: "transcribe", uuid: it.uuid, slot: it.slot, state: "active" });
    let transcript = null;
    const tT0 = Date.now();
    try {
      transcript = await transcribeFn({ src, signal });
    } catch (e) {
      transcript = null;
      logEvent("transcribe", `failed for "${it.title}": ${e && e.message ? e.message : e}`);
    }
    const segCount = transcript && Array.isArray(transcript.segments) ? transcript.segments.length : 0;
    logEvent("transcribe", `"${it.title}": ok=${!!transcript} segments=${segCount} in ${Date.now() - tT0}ms`);
    emit({ type: "transcribe", uuid: it.uuid, slot: it.slot, state: transcript ? "done" : "skipped" });

    // 2. Detect cuts (trim).
    if (it.trim) {
      emit({ type: "trim", uuid: it.uuid, slot: it.slot, state: "analysing" });
      let res;
      try {
        res = await generateCuts({
          src, transcribeFn, detectAdsFn, readDecisionsFn, readCutSetFn, llmFetch, model, needsReviewMaxSec, detectorMode, signal,
          transcript, hasTranscript: true,
        });
      } catch (e) {
        res = { status: "skipped", cuts: [] };
        logEvent("trim", `generateCuts threw for "${it.title}": ${e && e.message ? e.message : e}`);
      }
      trimResults[i] = res;
      const auto = res.cuts.filter((c) => !c.needsReview).length;
      logEvent("trim", `"${it.title}": status=${res.status} cuts=${res.cuts.length} (auto-apply=${auto})`);
      emit({
        type: "trim", uuid: it.uuid, slot: it.slot,
        state: res.status, cuts: res.cuts,
        segments: Array.isArray(res.segments) ? res.segments : [],
      });
    }

    // 3. Build the spoken intro (announce).
    if (it.announce) {
      const outPath = path.join(cacheDir, `${it.uuid}.intro.wav`);
      emit({ type: "announce", uuid: it.uuid, slot: it.slot, state: "analysing" });
      // Thread the user-picked model id (P4a) into the announce summary; omit it
      // when unset so announce.cjs keeps its own default.
      const introLlm = model ? { ...(llm || {}), model } : llm;
      let intro = null;
      let introText = "";
      try {
        const r = await generateIntro({
          it, src, outPath,
          transcribeFn, buildAnnouncementTextFn, renderIntroFn,
          llm: introLlm, signal,
          transcript, hasTranscript: true,
        });
        intro = r && r.introPath ? r.introPath : null;
        introText = (r && r.text) || "";
      } catch {
        intro = null;
        introText = "";
      }
      introPaths[i] = intro;
      introTexts[i] = introText;
      emit({ type: "announce", uuid: it.uuid, slot: it.slot, state: intro ? "ready" : "skipped" });
    }
  }

  if (analyseItems.length) emit({ type: "stage", stage: "transcribe", state: "done" });
  if (trimItems.length) emit({ type: "stage", stage: "trim", state: "done" });
  if (announceItems.length) emit({ type: "stage", stage: "announce", state: "done" });

  // Stage: review gate.
  // HOLD the pipeline here whenever a trim episode has ANY cut at all - confident OR
  // flagged - and let the user see + approve them in the transcript surface before
  // anything is encoded or written to the device. This is the transcript-toggle
  // redesign's whole point: the user sees and controls everything, so NOTHING auto-
  // applies to the converter without having been surfaced for review first. Confident
  // cuts start pre-selected (yellow) in the surface, so the DEFAULT outcome matches
  // the old behaviour (they get cut unless the user greys them) - but they are no
  // longer cut silently. An episode with NO cuts at all skips this gate entirely.
  // CARDINAL RULE: a surfaced cut that the gate does not resolve is NOT auto-applied
  // (the fold below fails closed on a missing resolution); only what the user's
  // resolution explicitly includes is cut.
  const reviewItems = trimItems
    .map(({ it, i }) => {
      const cuts = (trimResults[i] && trimResults[i].cuts) || [];
      if (!cuts.length) return null; // nothing detected -> nothing to surface
      return {
        i, uuid: it.uuid, slot: it.slot, title: it.title, ext: it.ext || "mp3",
        cuts,
        segments: Array.isArray(trimResults[i].segments) ? trimResults[i].segments : [],
      };
    })
    .filter(Boolean);

  if (reviewItems.length) {
    throwIfAborted();
    const payload = reviewItems.map(({ i, ...rest }) => rest);
    logEvent("review", `holding for review: ${reviewItems.length} episode(s) with cuts to approve`);
    emit({ type: "stage", stage: "review", state: "active" });
    emit({ type: "review", items: payload });
    let decisionsByUuid = {};
    try {
      decisionsByUuid = (await awaitReview(payload)) || {};
    } catch (e) {
      if (e && e.name === "AbortError") throw e;
      // A failed gate must not cut anything the user never approved: treat as no
      // decisions, so flagged cuts stay held back.
      decisionsByUuid = {};
    }
    throwIfAborted();
    // Fold the user's decision into each reviewed episode's cut list. The decision
    // is EITHER a legacy per-cut keep/remove map OR an explicit final cut-set (the
    // transcript-toggle redesign) - resolveEpisodeCuts handles both. A decided
    // "remove" / a selected range becomes an auto-apply cut; "keep" / an un-selected
    // range is dropped; an undecided flagged cut stays flagged and is held back below.
    //
    // FAIL-CLOSED (cardinal rule): an episode was SURFACED for review, so NOTHING of
    // it may auto-apply unless the gate resolved it. If the gate returned NO entry for
    // this episode (a failed/empty gate, or a default no-op gate), treat it as an
    // EMPTY explicit cut-set => cut nothing. Only an episode the gate explicitly
    // resolved (an __cutSet, or a legacy keep/remove map) applies anything. This is
    // what stops a confident cut that was surfaced-but-unresolved from being cut.
    for (const item of reviewItems) {
      const hasEntry = !!(decisionsByUuid && Object.prototype.hasOwnProperty.call(decisionsByUuid, item.uuid));
      const d = hasEntry ? decisionsByUuid[item.uuid] : { __cutSet: [] };
      const updated = resolveEpisodeCuts(trimResults[item.i].cuts, d);
      trimResults[item.i] = { ...trimResults[item.i], cuts: updated };
      const auto = updated.filter((c) => !c.needsReview).length;
      const held = updated.filter((c) => c && c.needsReview).length;
      logEvent("review", `"${item.title}": resolved -> ${auto} to apply, ${held} held`);
      emit({
        type: "trim", uuid: item.uuid, slot: item.slot,
        state: updated.some((c) => c && c.needsReview) ? "needs-review" : "ready",
        cuts: updated, segments: item.segments,
      });
    }
    emit({ type: "stage", stage: "review", state: "done" });
  }

  // Stage: delete (RELOCATED - cardinal-rule-critical).
  // Remove superseded device files. This MUST run AFTER the review gate resolves, not
  // before the analysis as it used to: if it ran first, cancelling at the gate would
  // leave the device's old files already deleted with nothing written in their place
  // (data loss). By deleting here - past the gate, in the Transferring phase, just
  // before convert/transfer - a CANCEL at the gate aborts the run (cancelSync resolves
  // the parked gate then aborts; the throwIfAborted() below raises AbortError) BEFORE
  // a single file is unlinked, so the device is left exactly as it was. What gets
  // deleted is identical to before (same computeRemovals on the same inputs); only the
  // timing moved. The "delete" stage now shows under Transferring. Verify still runs
  // last.
  throwIfAborted();
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
    if (it.trim) {
      const cutSec = autoCuts.reduce((s, [a, b]) => s + Math.max(0, (b || 0) - (a || 0)), 0);
      logEvent("convert", `"${it.title}": applying ${autoCuts.length} cut(s) totalling ${cutSec.toFixed(0)}s; introPath=${!!introPath}`);
    }
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
    // is never reused across a different intro/cut combination. The intro part
    // carries INTRO_PIPELINE_VERSION (invalidates every pre-fix "slow/quiet/no-
    // metadata" encode wholesale) AND a short hash of the actual spoken text (so a
    // future intro-wording change for the SAME episode also invalidates). We hash
    // the TEXT, never the regenerated WAV's mtime - mtime would force a needless
    // re-encode every run.
    const introText = introTexts[i] || "";
    const introHash = introText
      ? crypto.createHash("sha1").update(introText).digest("hex").slice(0, 8)
      : "";
    const introSuffix = introPath ? `-intro${INTRO_PIPELINE_VERSION}${introHash ? `-${introHash}` : ""}` : "";
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

  // Build the AUTHORITATIVE transferred set from the files we actually copied and
  // just checksum-verified on the device - never from the caller's queue, which
  // the success screen must NOT trust (a download finishing mid-run could inflate
  // the live queue and make the UI claim an un-transferred episode is on the
  // device). Per episode: real on-device bytes (stat the dest), real processed
  // duration (probe the output, best-effort), whether it was converted vs copied
  // straight through, and verified=true (we only reach here past verify).
  const transferred = [];
  for (let i = 0; i < queue.length; i++) {
    const it = queue[i];
    const raw = path.join(cacheDir, `${it.uuid}.${it.ext || "mp3"}`);
    let bytes = null;
    try { bytes = (await fsp.stat(dests[i])).size; } catch {}
    let durationSec = null;
    try { durationSec = await probeDurationFn(dests[i]); } catch { durationSec = null; }
    if (!Number.isFinite(durationSec) || durationSec < 0) durationSec = null;
    transferred.push({
      uuid: it.uuid,
      title: it.title,
      show: it.show,
      fname: it.filename,
      slot: it.slot,
      bytes,
      durationSec,
      converted: sources[i] !== raw,
      verified: true,
    });
  }
  const totals = {
    files: transferred.length,
    bytes: transferred.reduce((s, t) => s + (t.bytes || 0), 0),
    listenTimeSec: transferred.reduce((s, t) => s + (t.durationSec || 0), 0),
    // True only when EVERY transferred file's duration is known, so the UI can
    // avoid presenting a partial sum as if it were the complete listen time.
    listenTimeComplete: transferred.length > 0 && transferred.every((t) => t.durationSec != null),
    converted: transferred.filter((t) => t.converted).length,
  };

  emit({ type: "complete", summary: { count: queue.length } });
  return { ok: true, files: dests, transferred, totals };
}

module.exports = { runSync, buildPlan, itemNeedsEncode, generateIntro, generateCuts, adToCut, resolveEpisodeCuts, isOurFilename, sha256File, AbortError, readManifest, writeManifest, MANIFEST_FILE, EDGE_SNAP_SEC, HARD_FINAL_CUT_MAX_SEC, EDGE_SNAP_GROWTH_MAX_SEC, INTRO_PIPELINE_VERSION };
