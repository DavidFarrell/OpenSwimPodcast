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

// Prove a just-attached volume is really OUR device and actually writable before
// slice 4 does any destructive delete/transfer. macOS can report a volume attached
// before it is mounted+writable, so a real temp-file write+delete round-trip is the
// load-bearing readiness proof. Total: returns a typed result, never throws.
// Reasons: "no-path" / "no-marker-configured" / "bad-marker" / "missing-marker" / "unreadable" / "not-writable".
const MAX_ATTEMPTS = 20;
async function validateDevice(devicePath, options) {
  // Normalize rather than destructure-default so a null/garbage options arg cannot
  // throw - the function is total.
  const { markerFile, attempts = 5, delayMs = 250, sleep = defaultSleep } =
    (options && typeof options === "object") ? options : {};

  if (!devicePath) return { ok: false, reason: "no-path" };

  // The marker is the ONLY thing that proves this is our device and not a random
  // writable USB volume, so a missing or non-string markerFile is a hard fail - never
  // skip the check and never let a bad marker config turn into a destructive write.
  if (!markerFile || typeof markerFile !== "string") return { ok: false, reason: "no-marker-configured" };

  // The marker must be a plain filename directly inside devicePath. A value with a
  // separator or "."/".." could prove a marker OUTSIDE the device (or match any dir),
  // which would defeat the device proof and risk a write to the wrong volume.
  if (markerFile !== path.basename(markerFile) || markerFile === "." || markerFile === "..") {
    return { ok: false, reason: "bad-marker" };
  }

  // A missing marker means this is the wrong/no device, not a transient state, so
  // fail fast rather than retry - we must never wait out a destructive write to a
  // random USB volume.
  try {
    await fsp.access(path.join(devicePath, markerFile), fs.constants.R_OK);
  } catch {
    return { ok: false, reason: "missing-marker" };
  }

  // Clamp attempts so a bad caller value cannot retry forever and cannot throw on
  // coercion. Retry only the transient readiness checks: a real volume can need a
  // moment after attach before readdir/write succeed.
  const n = typeof attempts === "number" && Number.isFinite(attempts) ? attempts : 5;
  const tries = Math.min(Math.max(1, Math.floor(n)), MAX_ATTEMPTS);

  let lastReason = "unreadable";
  for (let i = 0; i < tries; i++) {
    const r = await probe(devicePath, markerFile);
    if (r === null) return { ok: true, path: devicePath };
    lastReason = r.reason;
    // A terminal failure must stop the loop: either the device was swapped away (marker
    // gone) or it is not cleanly writable (a temp we could not delete). Retrying would
    // risk passing a wrong device or leaking more temps.
    if (r.terminal) return { ok: false, reason: r.reason };
    // A rejecting injected sleep must not escape as a throw - the function is total.
    if (i < tries - 1) { try { await sleep(delayMs); } catch {} }
  }
  return { ok: false, reason: lastReason };
}

// One full attempt: re-prove the marker (device identity), then prove readiness with
// a readdir + temp write + temp delete round-trip. Returns null when all pass, else
// { reason, terminal }. Re-checking the marker EVERY attempt closes the race where the
// volume is swapped for a different writable dir between retries; if the marker is gone
// the device changed under us, so that is terminal (do not wait out a wrong device).
// A failed readdir or write is retryable (transient mid-attach); a temp we wrote but
// could NOT delete is terminal, since that leaves the device not cleanly writable.
async function probe(devicePath, markerFile) {
  try {
    await fsp.access(path.join(devicePath, markerFile), fs.constants.R_OK);
  } catch {
    return { reason: "missing-marker", terminal: true };
  }
  try {
    await fsp.readdir(devicePath);
  } catch {
    return { reason: "unreadable", terminal: false };
  }
  const tmp = path.join(devicePath, `.openswim-validate-${process.pid}-${Date.now()}-${Math.random().toString(36).slice(2)}`);
  try {
    await fsp.writeFile(tmp, "");
  } catch {
    // writeFile can create/truncate the temp before rejecting, so remove it to avoid a
    // leftover. ENOENT means no temp was created (e.g. a read-only dir) - nothing leaked,
    // so that stays retryable. Any other cleanup failure means a temp leaked and could
    // not be removed, which is terminal - do not retry and risk leaking more.
    try {
      await fsp.unlink(tmp);
    } catch (e) {
      if (e && e.code !== "ENOENT") return { reason: "not-writable", terminal: true };
    }
    return { reason: "not-writable", terminal: false };
  }
  try {
    await fsp.unlink(tmp);
  } catch {
    return { reason: "not-writable", terminal: true };
  }
  return null;
}

function defaultSleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
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

module.exports = { createDeviceWatcher, validateDevice };
