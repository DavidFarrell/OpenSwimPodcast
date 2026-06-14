const { ipcMain, app, BrowserWindow } = require("electron");
const path = require("node:path");
const pc = require("./pocketcasts.cjs");
const { DownloadManager } = require("./downloader.cjs");
const { createDeviceWatcher } = require("./device.cjs");
const { runSync, readManifest } = require("./sync.cjs");
const { probeDurationSec } = require("./converter.cjs");
const { writeDecisions } = require("./decisionCache.cjs");

function serializeError(e) {
  return { message: e.message || String(e), code: e.code, status: e.status };
}

let manager = null;
let watcher = null;

function broadcast(channel, payload) {
  for (const w of BrowserWindow.getAllWindows()) {
    if (!w.isDestroyed()) w.webContents.send(channel, payload);
  }
}

function getWatcher() {
  if (watcher) return watcher;
  watcher = createDeviceWatcher({
    volumesRoot: "/Volumes",
    labelPattern: /^openswim/i,
    markerFile: ".openswim-podcast",
    pollMs: 2000,
    debounceMs: 200,
  });
  watcher.on((state) => broadcast("device:state", state));
  watcher.start();
  return watcher;
}

// Per-episode "Announce" toggle intent, keyed by episode uuid. The renderer
// flips this per row; sync:start reads it to decide which episodes get a spoken
// intro. Kept in-memory here (the queue spec also carries it through to runSync)
// so the renderer has a single source of truth it can read back and toggle.
const announcePrefs = new Map();

function getAnnounce(uuid) {
  return uuid ? !!announcePrefs.get(uuid) : false;
}

function setAnnounce(uuid, enabled) {
  if (!uuid) return false;
  const on = !!enabled;
  // Record the explicit intent - true OR false. We deliberately do NOT delete
  // on OFF: a queue item may have been built with announce:true, and startSync
  // only overrides the queued value when an intent was recorded for the uuid.
  // Deleting would let the stale queued true win, so an OFF flipped after the
  // queue was built would be silently lost. Storing false honours the OFF.
  announcePrefs.set(uuid, on);
  return on;
}

function listAnnounce() {
  // Only the episodes actually set to ON (an explicitly-recorded OFF is in the
  // map but must not appear as enabled).
  return Array.from(announcePrefs.entries()).filter(([, on]) => on).map(([uuid]) => uuid);
}

// Fold the per-episode Announce toggle into each queue item. The item may
// already carry `announce` from the renderer (captured when the queue was
// built); a recorded toggle intent ALWAYS takes precedence - on OR off - so a
// toggle flipped after the queue was built is honoured. The map stores both ON
// and OFF intents explicitly, so `has(uuid)` means "the user decided", and the
// stored value (true or false) wins over the stale queued value either way.
function resolveAnnounceQueue(queue) {
  return (queue || []).map((it) => ({
    ...it,
    announce: it.uuid && announcePrefs.has(it.uuid) ? getAnnounce(it.uuid) : !!it.announce,
  }));
}

// Per-episode "Trim" toggle intent, keyed by episode uuid. Mirrors announcePrefs
// exactly (an explicit OFF is stored, not deleted, so a toggle flipped after the
// queue was built wins over the stale queued value).
const trimPrefs = new Map();

function getTrim(uuid) {
  return uuid ? !!trimPrefs.get(uuid) : false;
}

function setTrim(uuid, enabled) {
  if (!uuid) return false;
  const on = !!enabled;
  trimPrefs.set(uuid, on);
  return on;
}

function listTrim() {
  return Array.from(trimPrefs.entries()).filter(([, on]) => on).map(([uuid]) => uuid);
}

function resolveTrimQueue(queue) {
  return (queue || []).map((it) => ({
    ...it,
    trim: it.uuid && trimPrefs.has(it.uuid) ? getTrim(it.uuid) : !!it.trim,
  }));
}

// Latest trim status + proposed cut list per episode uuid, fed by the sync:event
// stream so the renderer can read it back ({ status, cuts }). status is one of
// idle | analysing | ready | needs-review | skipped.
const trimStatus = new Map();

function getTrimStatus(uuid) {
  if (!uuid) return { status: "idle", cuts: [] };
  return trimStatus.get(uuid) || { status: "idle", cuts: [] };
}

function recordTrimEvent(e) {
  if (!e || e.type !== "trim" || !e.uuid) return;
  trimStatus.set(e.uuid, {
    status: e.state || "idle",
    cuts: Array.isArray(e.cuts) ? e.cuts : (trimStatus.get(e.uuid)?.cuts || []),
  });
}

// Per-episode keep/remove decisions for FLAGGED (needs-review) cuts, recorded by
// the P3a coarse cut-list review surface. Keyed by uuid, then by a stable cut key
// (startSec-endSec rounded to ms) so a decision sticks to a specific proposed
// cut even if the cut list is re-read. The value is "keep" or "remove".
//
// CARDINAL RULE: a flagged cut defaults to KEEP (no decision recorded == keep
// the audio intact). Only an explicit "remove" decision lets the cut be applied.
// Nothing here forces a cut; recording a decision never throws.
const trimDecisions = new Map();

function cutKey(cut) {
  if (!cut) return null;
  const s = Number(cut.startSec);
  const e = Number(cut.endSec);
  if (!Number.isFinite(s) || !Number.isFinite(e)) return null;
  return `${Math.round(s * 1000)}-${Math.round(e * 1000)}`;
}

function setTrimDecision(uuid, cut, decision) {
  if (!uuid) return null;
  const key = cutKey(cut);
  if (!key) return null;
  const value = decision === "remove" ? "remove" : "keep";
  let m = trimDecisions.get(uuid);
  if (!m) { m = new Map(); trimDecisions.set(uuid, m); }
  m.set(key, value);
  return value;
}

function getTrimDecisions(uuid) {
  if (!uuid) return {};
  const m = trimDecisions.get(uuid);
  if (!m) return {};
  return Object.fromEntries(m.entries());
}

// Fold the per-episode edited boundaries (P3b) into the keep/remove decision map so
// the persisted sidecar records the cut the user ACTUALLY approved. A "remove" that
// the user only approved after nudging the boundaries must round-trip as an
// adjusted-remove (object form), otherwise a re-process would auto-apply the
// detector's original range - a cut the user never approved (cardinal-rule
// violation). The edit map is keyed by the SAME original cut key as the decision
// map, so we merge by key:
//   - decision "remove" + an edit for that key -> { action:"remove", startSec, endSec }
//   - decision "remove" with no edit            -> "remove" (detector boundaries)
//   - decision "keep"                           -> "keep" (an edit is irrelevant)
// A "keep" never carries boundaries: nothing is cut, so the adjustment is moot.
function mergeDecisionsWithEdits(uuid) {
  const decisions = getTrimDecisions(uuid);
  const edits = getTrimEdits(uuid);
  const merged = {};
  for (const [key, value] of Object.entries(decisions)) {
    if (value === "remove" && edits[key]
        && Number.isFinite(edits[key].startSec) && Number.isFinite(edits[key].endSec)) {
      merged[key] = { action: "remove", startSec: edits[key].startSec, endSec: edits[key].endSec };
    } else {
      merged[key] = value;
    }
  }
  return merged;
}

// Best-effort persistence (P3c): mirror the in-memory decision map for an episode
// to the fingerprint-keyed sidecar next to its cached audio, so a re-process of
// the same untouched episode reuses these reviewed choices and never re-asks. The
// persisted map carries any user-adjusted boundaries (see mergeDecisionsWithEdits)
// so an adjusted+removed cut re-applies at the adjusted range. This is
// fire-and-forget - a missing/unwritable cache is not fatal (the user can decide
// again next pass), and it never throws into the IPC reply.
function persistTrimDecisions(uuid, ext) {
  if (!uuid) return;
  let cacheDir;
  try { cacheDir = path.join(app.getPath("userData"), "cache", "episodes"); }
  catch { return; }
  const src = path.join(cacheDir, `${uuid}.${ext || "mp3"}`);
  const decisions = mergeDecisionsWithEdits(uuid);
  // Async, best-effort: writeDecisions itself never throws (resolves false on
  // failure). Detach so a slow/failing disk write never blocks the IPC reply.
  Promise.resolve().then(() => writeDecisions({ src, decisions })).catch(() => {});
}

// Edited boundaries for FLAGGED cuts (P3b). Keyed by uuid then the ORIGINAL cut
// key, holding the new { startSec, endSec } the user nudged/typed. The renderer
// already keeps the edited cut in its own state for an immediate redraw; this
// store is the persistence layer so an edit survives a re-render / re-process,
// mirroring trimDecisions above.
//
// CARDINAL RULE: an edit only changes WHAT a later REMOVE would cut; it never
// applies a cut on its own. We reject any edit that is missing, unparseable, or
// would invert the range (start >= end) so a bad boundary can never be recorded.
const trimEdits = new Map();

function setTrimEdit(uuid, originalCut, newCut) {
  if (!uuid) return null;
  const key = cutKey(originalCut);
  if (!key || !newCut) return null;
  const s = Number(newCut.startSec);
  const e = Number(newCut.endSec);
  if (!Number.isFinite(s) || !Number.isFinite(e) || s >= e || s < 0) return null;
  const edited = { startSec: s, endSec: e };
  let m = trimEdits.get(uuid);
  if (!m) { m = new Map(); trimEdits.set(uuid, m); }
  m.set(key, edited);
  return edited;
}

function getTrimEdits(uuid) {
  if (!uuid) return {};
  const m = trimEdits.get(uuid);
  if (!m) return {};
  return Object.fromEntries(m.entries());
}

let syncController = null;

// The in-flight review gate. When runSync hands us flagged cuts, we park a
// resolver here and broadcast the `review` event (runSync already emits it via
// onEvent); the renderer shows its review surface and calls sync:review:resolve
// when the user clicks Continue. We then build the decision map from the SAME
// in-memory stores the per-cut IPC already maintains (mergeDecisionsWithEdits) -
// authoritative and synchronous, so there is no race with the async sidecar
// write - and resolve, releasing the pipeline. `uuids` records which episodes
// are under review so we only read decisions for those.
let pendingReview = null; // { resolve, uuids }

// Resolve the parked review gate with the user's decisions, releasing runSync to
// continue to encode + transfer. No-op (returns false) if nothing is awaiting
// review. Building from mergeDecisionsWithEdits means an undecided flagged cut
// simply has no entry, so it stays held back (cardinal rule).
function resolveReview() {
  if (!pendingReview) return false;
  const { resolve, uuids } = pendingReview;
  pendingReview = null;
  const decisionsByUuid = {};
  for (const uuid of uuids || []) decisionsByUuid[uuid] = mergeDecisionsWithEdits(uuid);
  resolve(decisionsByUuid);
  return true;
}

async function startSync(spec) {
  if (syncController) throw Object.assign(new Error("sync already in progress"), { code: "SYNC_IN_PROGRESS" });
  syncController = new AbortController();
  const cacheDir = path.join(app.getPath("userData"), "cache", "episodes");
  const queue = resolveTrimQueue(resolveAnnounceQueue(spec.queue));
  // Reset trim status for the episodes about to be processed so a prior run's
  // result does not linger in the renderer while this one analyses.
  for (const it of queue) {
    if (it.trim && it.uuid) trimStatus.set(it.uuid, { status: "idle", cuts: [] });
  }
  try {
    const res = await runSync({
      devicePath: spec.devicePath,
      queue,
      speed: spec.speed || 1.0,
      boost: !!spec.boost,
      // User-picked LM Studio model id (P4a) for the announce summary + the trim
      // detector. Falls through to each module's default when absent.
      model: (typeof spec.model === "string" && spec.model.trim()) ? spec.model.trim() : undefined,
      // User-picked sensitivity threshold (P4b), in seconds. Tunes flag-vs-auto-
      // apply only. Falls through to detectAds.cjs's NEEDS_REVIEW_MAX_SEC default
      // when absent / non-positive, so the cardinal rule can never be weakened.
      needsReviewMaxSec: (typeof spec.needsReviewMaxSec === "number" && Number.isFinite(spec.needsReviewMaxSec) && spec.needsReviewMaxSec > 0)
        ? spec.needsReviewMaxSec
        : undefined,
      // Detector: the production default is the GEPA champion ("gepa") - validated
      // head-to-head against the prior "legacy" detector on the golden corpus and
      // proven STRICTLY safer (auto-applied false-positive seconds 11.7s vs legacy
      // 99.2s) with higher ad-recall, because char-interpolation cuts the sold
      // portion of a turn instead of the whole turn and the hard guard holds
      // anything long/ambiguous for review. Passed EXPLICITLY so the shipped path
      // is never env-dependent. Revert to "legacy" here to roll back the detector.
      detectorMode: "gepa",
      cacheDir,
      signal: syncController.signal,
      // The interactive review gate: park a resolver and let the renderer release
      // it via sync:review:resolve. The `review` event itself is broadcast through
      // onEvent below, so the renderer knows to show its review surface.
      awaitReview: (items) => new Promise((resolve) => {
        const uuids = (items || []).map((it) => it && it.uuid).filter(Boolean);
        pendingReview = { resolve, uuids };
      }),
      // Real processed-duration probe for the authoritative success report (the
      // renderer uses the returned `res` as the source of truth, not its live
      // queue - so a download finishing mid-run can never be reported as
      // transferred).
      probeDurationFn: (f) => probeDurationSec(f),
      onEvent: (e) => { recordTrimEvent(e); broadcast("sync:event", e); },
    });
    broadcast("sync:event", { type: "finished", ok: true, result: res });
    return res;
  } catch (e) {
    broadcast("sync:event", { type: "finished", ok: false, error: { message: e.message, code: e.code, name: e.name } });
    throw e;
  } finally {
    syncController = null;
  }
}

function cancelSync() {
  // Release a parked review FIRST (with no decisions) so the awaited promise
  // settles, then abort. runSync's throwIfAborted() right after the gate then
  // raises AbortError and nothing reaches the converter - a cancel mid-review
  // cuts nothing, exactly as expected.
  if (pendingReview) { const { resolve } = pendingReview; pendingReview = null; resolve({}); }
  if (syncController) { syncController.abort(); return true; }
  return false;
}

function getManager() {
  if (manager) return manager;
  const cacheDir = path.join(app.getPath("userData"), "cache", "episodes");
  manager = new DownloadManager({
    cacheDir,
    concurrency: 2,
    onEvent: (evt) => {
      broadcast("downloads:progress", evt);
    },
  });
  return manager;
}

function extFromUrl(url) {
  const m = /\.([a-zA-Z0-9]{2,5})(?:\?|$)/.exec(url || "");
  const raw = (m && m[1]) ? m[1].toLowerCase() : "mp3";
  if (["mp3", "m4a", "ogg", "aac", "wav"].includes(raw)) return raw;
  if (["mp4", "m4v", "mov", "webm"].includes(raw)) return raw;
  return "mp3";
}

function buildHandlers() {
  return {
    "pc:status": () => pc.status(),
    "pc:login": (_, { email, password }) => pc.login(email, password),
    "pc:logout": () => pc.logout(),
    "pc:upNext": () => pc.getUpNext(),
    "pc:podcastList": () => pc.getPodcastList(),
    "pc:history": () => pc.getHistory(),
    "pc:podcastFull": (_, uuid) => pc.getPodcastFull(uuid),

    "downloads:ensure": (_, { uuid, url, ext }) => {
      const mgr = getManager();
      const e = mgr.ensure({ uuid, url, ext: ext || extFromUrl(url) });
      return { uuid: e.uuid, state: e.state, bytes: e.bytes, total: e.total };
    },
    "downloads:cancel": (_, uuid) => getManager().cancel(uuid),
    "downloads:list": () => getManager().list(),
    "downloads:reconcile": (_, uuids) => getManager().reconcile(new Set(uuids || [])),

    "device:current": () => getWatcher().current(),
    "device:listVolumes": () => getWatcher().listVolumes(),
    "device:claim": (_, path) => getWatcher().claim(path),
    "device:eject": (_, path) => getWatcher().eject(path),
    "device:readManifest": (_, devicePath) => readManifest(devicePath),

    "sync:start": (_, spec) => startSync(spec),
    "sync:cancel": () => cancelSync(),
    "sync:review:resolve": () => resolveReview(),

    "announce:get": (_, uuid) => getAnnounce(uuid),
    "announce:set": (_, { uuid, enabled }) => setAnnounce(uuid, enabled),
    "announce:list": () => listAnnounce(),

    "trim:get": (_, uuid) => getTrim(uuid),
    "trim:set": (_, { uuid, enabled }) => setTrim(uuid, enabled),
    "trim:list": () => listTrim(),
    "trim:status": (_, uuid) => getTrimStatus(uuid),
    "trim:decide": (_, payload) => {
      const { uuid, cut, decision, ext } = payload || {};
      const value = setTrimDecision(uuid, cut, decision);
      // Persist the episode's full decision map to its fingerprint sidecar so the
      // choice survives a re-process. Only when the decision was actually recorded.
      if (value != null) persistTrimDecisions(uuid, ext);
      return value;
    },
    "trim:decisions": (_, uuid) => getTrimDecisions(uuid),
    "trim:edit": (_, payload) => {
      const { uuid, originalCut, newCut, ext } = payload || {};
      const edited = setTrimEdit(uuid, originalCut, newCut);
      // If this cut was already decided REMOVE, the persisted sidecar must pick up
      // the new boundaries so a re-process re-applies the cut the user just
      // adjusted (not the stale range). Re-persist on a successful edit when a
      // decision already exists, so edit-after-decide is captured too.
      if (edited != null) {
        const key = cutKey(originalCut);
        const decisions = getTrimDecisions(uuid);
        if (key && decisions[key]) persistTrimDecisions(uuid, ext);
      }
      return edited;
    },
    "trim:edits": (_, uuid) => getTrimEdits(uuid),
  };
}

function registerAll() {
  const handlers = buildHandlers();
  for (const [ch, fn] of Object.entries(handlers)) {
    ipcMain.handle(ch, async (ev, arg) => {
      try { return { ok: true, data: await fn(ev, arg) }; }
      catch (e) { return { ok: false, error: serializeError(e) }; }
    });
  }
}

module.exports = {
  registerPocketCasts: registerAll,
  buildHandlers,
  getAnnounce, setAnnounce, listAnnounce, resolveAnnounceQueue,
  getTrim, setTrim, listTrim, resolveTrimQueue, getTrimStatus, recordTrimEvent,
  setTrimDecision, getTrimDecisions, cutKey,
  setTrimEdit, getTrimEdits, mergeDecisionsWithEdits,
  resolveReview, cancelSync,
};
