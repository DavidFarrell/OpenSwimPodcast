const { ipcMain, app, BrowserWindow } = require("electron");
const path = require("node:path");
const pc = require("./pocketcasts.cjs");
const { DownloadManager } = require("./downloader.cjs");
const { createDeviceWatcher } = require("./device.cjs");
const { runSync, readManifest } = require("./sync.cjs");

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

let syncController = null;

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
      cacheDir,
      signal: syncController.signal,
      onEvent: (e) => { recordTrimEvent(e); broadcast("sync:event", e); },
    });
    broadcast("sync:event", { type: "finished", ok: true });
    return res;
  } catch (e) {
    broadcast("sync:event", { type: "finished", ok: false, error: { message: e.message, code: e.code, name: e.name } });
    throw e;
  } finally {
    syncController = null;
  }
}

function cancelSync() {
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

function registerAll() {
  const handlers = {
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

    "announce:get": (_, uuid) => getAnnounce(uuid),
    "announce:set": (_, { uuid, enabled }) => setAnnounce(uuid, enabled),
    "announce:list": () => listAnnounce(),

    "trim:get": (_, uuid) => getTrim(uuid),
    "trim:set": (_, { uuid, enabled }) => setTrim(uuid, enabled),
    "trim:list": () => listTrim(),
    "trim:status": (_, uuid) => getTrimStatus(uuid),
  };
  for (const [ch, fn] of Object.entries(handlers)) {
    ipcMain.handle(ch, async (ev, arg) => {
      try { return { ok: true, data: await fn(ev, arg) }; }
      catch (e) { return { ok: false, error: serializeError(e) }; }
    });
  }
}

module.exports = {
  registerPocketCasts: registerAll,
  getAnnounce, setAnnounce, listAnnounce, resolveAnnounceQueue,
  getTrim, setTrim, listTrim, resolveTrimQueue, getTrimStatus, recordTrimEvent,
};
