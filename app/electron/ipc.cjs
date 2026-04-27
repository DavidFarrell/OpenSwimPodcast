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

let syncController = null;

async function startSync(spec) {
  if (syncController) throw Object.assign(new Error("sync already in progress"), { code: "SYNC_IN_PROGRESS" });
  syncController = new AbortController();
  const cacheDir = path.join(app.getPath("userData"), "cache", "episodes");
  try {
    const res = await runSync({
      devicePath: spec.devicePath,
      queue: spec.queue,
      speed: spec.speed || 1.0,
      boost: !!spec.boost,
      cacheDir,
      signal: syncController.signal,
      onEvent: (e) => broadcast("sync:event", e),
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
  };
  for (const [ch, fn] of Object.entries(handlers)) {
    ipcMain.handle(ch, async (ev, arg) => {
      try { return { ok: true, data: await fn(ev, arg) }; }
      catch (e) { return { ok: false, error: serializeError(e) }; }
    });
  }
}

module.exports = { registerPocketCasts: registerAll };
