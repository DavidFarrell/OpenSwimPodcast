const fs = require("node:fs");
const fsp = require("node:fs/promises");
const path = require("node:path");
const { execFile } = require("node:child_process");

function defaultExec(cmd, args) {
  return new Promise((resolve, reject) => {
    execFile(cmd, args, (err, stdout, stderr) => {
      if (err) {
        err.stdout = stdout;
        err.stderr = stderr;
        return reject(err);
      }
      resolve({ stdout, stderr });
    });
  });
}

function createDeviceWatcher({
  volumesRoot,
  labelPattern = /^openswim/i,
  markerFile = null,
  pollMs = 2000,
  debounceMs = 150,
  statfs = fsp.statfs,
  exec = defaultExec,
} = {}) {
  if (!volumesRoot) throw new Error("volumesRoot is required");

  let listeners = [];
  let state = { mounted: false };
  let fsWatcher = null;
  let pollTimer = null;
  let debounceTimer = null;
  let started = false;
  let scanning = false;

  function on(cb) { listeners.push(cb); return () => { listeners = listeners.filter((x) => x !== cb); }; }
  function current() { return state; }
  function emit(next) {
    const changed = next.mounted !== state.mounted
      || next.path !== state.path
      || next.capacityMB !== state.capacityMB
      || next.freeMB !== state.freeMB;
    state = next;
    if (!changed && listeners.length && !state._initial) return;
    for (const cb of listeners) { try { cb(state); } catch {} }
  }

  async function isOurDevice(dir) {
    const label = path.basename(dir);
    if (labelPattern.test(label)) return { label };
    if (markerFile) {
      try {
        await fsp.access(path.join(dir, markerFile));
        return { label };
      } catch {}
    }
    return null;
  }

  async function scan() {
    if (scanning) return;
    scanning = true;
    try {
      let entries = [];
      try { entries = await fsp.readdir(volumesRoot, { withFileTypes: true }); }
      catch { entries = []; }

      for (const e of entries) {
        if (!e.isDirectory()) continue;
        const full = path.join(volumesRoot, e.name);
        const hit = await isOurDevice(full);
        if (hit) {
          let capacityMB, freeMB;
          try {
            const s = await statfs(full);
            const bsize = Number(s.bsize || 0);
            capacityMB = Math.round(Number(s.blocks) * bsize / (1024 * 1024));
            freeMB = Math.round(Number(s.bfree) * bsize / (1024 * 1024));
          } catch {}
          return emit({ mounted: true, path: full, label: hit.label, capacityMB, freeMB });
        }
      }
      emit({ mounted: false });
    } finally {
      scanning = false;
    }
  }

  function scheduleScan() {
    if (debounceTimer) clearTimeout(debounceTimer);
    debounceTimer = setTimeout(() => { debounceTimer = null; scan(); }, debounceMs);
  }

  function start() {
    if (started) return;
    started = true;
    try { fs.mkdirSync(volumesRoot, { recursive: true }); } catch {}
    try {
      fsWatcher = fs.watch(volumesRoot, { persistent: false }, () => scheduleScan());
      fsWatcher.on("error", () => {});
    } catch {}
    pollTimer = setInterval(() => scan(), pollMs);
    if (pollTimer.unref) pollTimer.unref();
    emit({ mounted: false, _initial: true });
    scheduleScan();
  }

  function stop() {
    if (!started) return;
    started = false;
    if (fsWatcher) { try { fsWatcher.close(); } catch {} fsWatcher = null; }
    if (pollTimer) { clearInterval(pollTimer); pollTimer = null; }
    if (debounceTimer) { clearTimeout(debounceTimer); debounceTimer = null; }
  }

  async function listVolumes() {
    let entries = [];
    try { entries = await fsp.readdir(volumesRoot, { withFileTypes: true }); }
    catch { return []; }
    const out = [];
    for (const e of entries) {
      if (!e.isDirectory()) continue;
      const full = path.join(volumesRoot, e.name);
      const hit = await isOurDevice(full);
      let capacityMB, freeMB;
      try {
        const s = await statfs(full);
        const bsize = Number(s.bsize || 0);
        capacityMB = Math.round(Number(s.blocks) * bsize / (1024 * 1024));
        freeMB = Math.round(Number(s.bfree) * bsize / (1024 * 1024));
      } catch {}
      out.push({ path: full, label: e.name, matches: !!hit, capacityMB, freeMB });
    }
    return out;
  }

  async function claim(targetPath) {
    if (!markerFile) throw new Error("marker file is not configured; cannot claim");
    await fsp.writeFile(path.join(targetPath, markerFile), "");
    scheduleScan();
    return true;
  }

  async function eject(targetPath) {
    try {
      await exec("diskutil", ["eject", targetPath]);
    } catch (e) {
      const detail = (e.stderr || e.message || "").trim();
      const err = new Error(detail || "eject failed");
      err.cause = e;
      throw err;
    }
    scheduleScan();
    return true;
  }

  return { start, stop, current, on, scan, listVolumes, claim, eject };
}

module.exports = { createDeviceWatcher };
