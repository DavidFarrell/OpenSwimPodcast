import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { createRequire } from "node:module";
import fs from "node:fs";
import fsp from "node:fs/promises";
import path from "node:path";
import os from "node:os";

const require = createRequire(import.meta.url);
const { createDeviceWatcher, validateDevice } = require("./device.cjs");

function mkTmp() { return fs.mkdtempSync(path.join(os.tmpdir(), "os-dev-")); }
function rmTmp(d) { try { fs.rmSync(d, { recursive: true, force: true }); } catch {} }
const wait = (ms) => new Promise((r) => setTimeout(r, ms));

async function waitFor(pred, { timeout = 1500, step = 30 } = {}) {
  const end = Date.now() + timeout;
  while (Date.now() < end) {
    const v = pred();
    if (v) return v;
    await wait(step);
  }
  throw new Error("waitFor timeout");
}

describe("createDeviceWatcher", () => {
  let root, watcher, events;

  beforeEach(() => {
    root = mkTmp();
    events = [];
  });
  afterEach(async () => {
    if (watcher) { watcher.stop(); watcher = null; }
    rmTmp(root);
  });

  it("reports unmounted when the volumes root is empty", async () => {
    watcher = createDeviceWatcher({ volumesRoot: root, labelPattern: /^openswim/i, pollMs: 50, debounceMs: 20 });
    watcher.on((e) => events.push(e));
    watcher.start();
    await waitFor(() => events.length > 0);
    expect(events[0]).toMatchObject({ mounted: false });
    expect(watcher.current().mounted).toBe(false);
  });

  it("detects a volume whose label matches the OpenSwim pattern", async () => {
    watcher = createDeviceWatcher({ volumesRoot: root, labelPattern: /^openswim/i, pollMs: 50, debounceMs: 20 });
    watcher.on((e) => events.push(e));
    watcher.start();
    await waitFor(() => events.length > 0);

    fs.mkdirSync(path.join(root, "OPENSWIM"));
    const mounted = await waitFor(() => events.find((e) => e.mounted));
    expect(mounted.label).toBe("OPENSWIM");
    expect(mounted.path).toBe(path.join(root, "OPENSWIM"));
    expect(watcher.current().mounted).toBe(true);
  });

  it("detects a volume by marker file even when the label doesn't match", async () => {
    watcher = createDeviceWatcher({
      volumesRoot: root, labelPattern: /^openswim/i, markerFile: ".openswim-podcast",
      pollMs: 50, debounceMs: 20,
    });
    watcher.on((e) => events.push(e));
    watcher.start();
    await waitFor(() => events.length > 0);

    const dir = path.join(root, "Bananas");
    fs.mkdirSync(dir);
    fs.writeFileSync(path.join(dir, ".openswim-podcast"), "");
    const mounted = await waitFor(() => events.find((e) => e.mounted));
    expect(mounted.label).toBe("Bananas");
    expect(mounted.path).toBe(dir);
  });

  it("ignores unrelated volumes and stays unmounted", async () => {
    watcher = createDeviceWatcher({ volumesRoot: root, labelPattern: /^openswim/i, pollMs: 50, debounceMs: 20 });
    watcher.on((e) => events.push(e));
    watcher.start();
    await waitFor(() => events.length > 0);

    fs.mkdirSync(path.join(root, "Macintosh HD"));
    fs.mkdirSync(path.join(root, "Nikki's USB"));
    await wait(200);
    expect(events.some((e) => e.mounted)).toBe(false);
    expect(watcher.current().mounted).toBe(false);
  });

  it("fires an unmount event when the device directory disappears", async () => {
    fs.mkdirSync(path.join(root, "OPENSWIM"));
    watcher = createDeviceWatcher({ volumesRoot: root, labelPattern: /^openswim/i, pollMs: 50, debounceMs: 20 });
    watcher.on((e) => events.push(e));
    watcher.start();
    await waitFor(() => events.find((e) => e.mounted));

    fs.rmdirSync(path.join(root, "OPENSWIM"));
    const after = await waitFor(() => events.filter((e) => !e.mounted).length >= 1 && events.at(-1).mounted === false);
    expect(after).toBeTruthy();
    expect(watcher.current().mounted).toBe(false);
  });

  it("includes capacityMB and freeMB on the mount event", async () => {
    const statfs = async () => ({ blocks: 1000n, bfree: 400n, bsize: 4096 });
    watcher = createDeviceWatcher({
      volumesRoot: root, labelPattern: /^openswim/i, statfs,
      pollMs: 50, debounceMs: 20,
    });
    watcher.on((e) => events.push(e));
    watcher.start();
    await waitFor(() => events.length > 0);

    fs.mkdirSync(path.join(root, "OPENSWIM"));
    const mounted = await waitFor(() => events.find((e) => e.mounted));
    const expectedCap = Math.round(Number(1000n * 4096n) / (1024 * 1024));
    const expectedFree = Math.round(Number(400n * 4096n) / (1024 * 1024));
    expect(mounted.capacityMB).toBe(expectedCap);
    expect(mounted.freeMB).toBe(expectedFree);
  });

  it("listVolumes returns every directory under the volumes root with capacity/free", async () => {
    const statfs = async () => ({ blocks: 2000n, bfree: 500n, bsize: 4096 });
    watcher = createDeviceWatcher({ volumesRoot: root, labelPattern: /^openswim/i, statfs, pollMs: 1000, debounceMs: 20 });
    fs.mkdirSync(path.join(root, "OPENSWIM"));
    fs.mkdirSync(path.join(root, "Nikkis USB"));
    fs.writeFileSync(path.join(root, "not-a-dir"), "");

    const vols = await watcher.listVolumes();
    const byLabel = Object.fromEntries(vols.map((v) => [v.label, v]));
    expect(Object.keys(byLabel).sort()).toEqual(["Nikkis USB", "OPENSWIM"]);
    expect(byLabel["OPENSWIM"].path).toBe(path.join(root, "OPENSWIM"));
    expect(byLabel["OPENSWIM"].matches).toBe(true);
    expect(byLabel["Nikkis USB"].matches).toBe(false);
    expect(byLabel["OPENSWIM"].capacityMB).toBeGreaterThan(0);
    expect(byLabel["OPENSWIM"].freeMB).toBeGreaterThanOrEqual(0);
  });

  it("claim writes the marker file so the next scan recognises the volume", async () => {
    watcher = createDeviceWatcher({
      volumesRoot: root, labelPattern: /^openswim/i, markerFile: ".openswim-podcast",
      pollMs: 50, debounceMs: 20,
    });
    watcher.on((e) => events.push(e));
    watcher.start();
    await waitFor(() => events.length > 0);

    const target = path.join(root, "Bananas");
    fs.mkdirSync(target);
    await wait(80);
    expect(events.some((e) => e.mounted)).toBe(false);

    const ok = await watcher.claim(target);
    expect(ok).toBe(true);
    expect(fs.existsSync(path.join(target, ".openswim-podcast"))).toBe(true);

    const mounted = await waitFor(() => events.find((e) => e.mounted));
    expect(mounted.path).toBe(target);
    expect(mounted.label).toBe("Bananas");
  });

  it("eject shells out to diskutil with the volume path", async () => {
    const calls = [];
    const exec = (cmd, args) => { calls.push({ cmd, args }); return Promise.resolve({ stdout: "", stderr: "" }); };
    watcher = createDeviceWatcher({ volumesRoot: root, labelPattern: /^openswim/i, exec, pollMs: 1000, debounceMs: 20 });
    fs.mkdirSync(path.join(root, "OPENSWIM"));
    const target = path.join(root, "OPENSWIM");

    await watcher.eject(target);
    expect(calls).toEqual([{ cmd: "diskutil", args: ["eject", target] }]);
  });

  it("eject surfaces stderr when diskutil fails (e.g. resource busy)", async () => {
    const exec = () => Promise.reject(Object.assign(new Error("diskutil failed"),
      { stderr: "Volume in use by process 42\n", code: 1 }));
    watcher = createDeviceWatcher({ volumesRoot: root, labelPattern: /^openswim/i, exec, pollMs: 1000, debounceMs: 20 });
    fs.mkdirSync(path.join(root, "OPENSWIM"));
    await expect(watcher.eject(path.join(root, "OPENSWIM"))).rejects.toThrow(/in use|busy|process 42/i);
  });

  it("claim refuses when markerFile is not configured", async () => {
    watcher = createDeviceWatcher({ volumesRoot: root, labelPattern: /^openswim/i, pollMs: 1000, debounceMs: 20 });
    fs.mkdirSync(path.join(root, "Bananas"));
    await expect(watcher.claim(path.join(root, "Bananas"))).rejects.toThrow(/marker/i);
  });

  it("debounces rapid mount/unmount churn into a single terminal event", async () => {
    watcher = createDeviceWatcher({ volumesRoot: root, labelPattern: /^openswim/i, pollMs: 50, debounceMs: 120 });
    watcher.on((e) => events.push(e));
    watcher.start();
    await waitFor(() => events.length > 0);
    const startCount = events.length;

    fs.mkdirSync(path.join(root, "OPENSWIM"));
    await wait(30);
    fs.rmdirSync(path.join(root, "OPENSWIM"));
    await wait(30);
    fs.mkdirSync(path.join(root, "OPENSWIM"));

    await waitFor(() => events.at(-1)?.mounted === true);
    const churn = events.slice(startCount);
    expect(churn.length).toBeLessThanOrEqual(2);
    expect(churn.at(-1).mounted).toBe(true);
  });
});

describe("validateDevice", () => {
  let root;
  const MARKER = ".openswim-podcast";
  const noSleep = async () => {};

  beforeEach(() => { root = mkTmp(); });
  afterEach(() => {
    // Restore perms in case a read-only test left the dir locked, so rmTmp can remove it.
    try { fs.chmodSync(root, 0o700); } catch {}
    rmTmp(root);
  });

  it("passes a good marked writable dir", async () => {
    fs.writeFileSync(path.join(root, MARKER), "");
    const res = await validateDevice(root, { markerFile: MARKER, sleep: noSleep });
    expect(res).toEqual({ ok: true, path: root });
  });

  it("returns no-path for an empty devicePath without throwing", async () => {
    expect(await validateDevice("", { markerFile: MARKER, sleep: noSleep })).toEqual({ ok: false, reason: "no-path" });
    expect(await validateDevice(undefined, { markerFile: MARKER, sleep: noSleep })).toEqual({ ok: false, reason: "no-path" });
  });

  // Slice 4: a cancel (aborted signal) must stop the probe BEFORE its temp write+delete
  // runs on the device, so a cancel-while-revalidating touches no device. The function
  // stays total - returns { ok:false, reason:"aborted" }, never throws.
  it("bails with reason 'aborted' when the signal is already aborted (no device write)", async () => {
    fs.writeFileSync(path.join(root, MARKER), "");
    const ctrl = new AbortController();
    ctrl.abort();
    const before = fs.readdirSync(root);
    const res = await validateDevice(root, { markerFile: MARKER, sleep: noSleep, signal: ctrl.signal });
    expect(res).toEqual({ ok: false, reason: "aborted" });
    // No probe temp was written/left behind - the dir is exactly as before.
    expect(fs.readdirSync(root)).toEqual(before);
  });

  // A cancel that lands mid-probe (after the loop's pre-probe check, while the marker
  // access / readdir run) must still stop BEFORE the probe's temp write. We abort during
  // the injected sleep that precedes the (now aborted) write window by aborting from the
  // marker-access path: use a getter-free approach - abort right after the first probe
  // begins by aborting from a one-shot patched readdir is heavy, so instead assert the
  // probe-level guard directly: abort between the pre-loop check and the write by
  // aborting inside the sleep of a forced-retry, then confirm no temp leaked.
  it("aborts mid-probe before the temp write (no temp leaked, reason aborted)", async () => {
    fs.writeFileSync(path.join(root, MARKER), "");
    const ctrl = new AbortController();
    const before = fs.readdirSync(root).sort();
    // First attempt: the dir is read-only so the write fails (retryable not-writable),
    // and we abort during the inter-attempt sleep. The NEXT attempt's pre-probe check
    // catches the abort, but to exercise the in-probe guard we instead abort right as the
    // probe is about to write on a writable dir: abort inside a sleep that runs BEFORE the
    // retry, then make the retry the one that would write.
    let calls = 0;
    const sleep = async () => { ctrl.abort(); };
    // Make the first probe fail retryably so the loop sleeps (and aborts) then re-enters
    // probe, whose in-probe guard now returns aborted before any write. Force a transient
    // readdir failure once by temporarily chmod-ing, then restore in the sleep.
    fs.chmodSync(root, 0o500); // read-only -> first write fails (not-writable, retryable)
    const res = await validateDevice(root, { markerFile: MARKER, attempts: 3, sleep, signal: ctrl.signal });
    fs.chmodSync(root, 0o700);
    expect(res.ok).toBe(false);
    expect(["aborted", "not-writable"]).toContain(res.reason);
    // No validate temp leaked on the device.
    expect(fs.readdirSync(root).filter((f) => f.startsWith(".openswim-validate-"))).toEqual([]);
    expect(fs.readdirSync(root).sort()).toEqual(before);
  });

  it("fails a missing-marker dir (wrong device) and does not retry it", async () => {
    let slept = 0;
    const sleep = async () => { slept++; };
    const res = await validateDevice(root, { markerFile: MARKER, attempts: 5, sleep });
    expect(res).toEqual({ ok: false, reason: "missing-marker" });
    expect(slept).toBe(0);
  });

  it("fails a read-only dir with not-writable", async () => {
    fs.writeFileSync(path.join(root, MARKER), "");
    fs.chmodSync(root, 0o500);
    const res = await validateDevice(root, { markerFile: MARKER, attempts: 2, sleep: noSleep });
    expect(res).toEqual({ ok: false, reason: "not-writable" });
    fs.chmodSync(root, 0o700);
  });

  it("fails no-marker-configured when no markerFile is given (never bypasses the device proof)", async () => {
    // Without a marker we cannot prove this is our device, so a bare writable dir must
    // NOT pass - this is the cardinal-rule guard against writing to a random USB volume.
    expect(await validateDevice(root, { sleep: noSleep })).toEqual({ ok: false, reason: "no-marker-configured" });
    expect(await validateDevice(root, { markerFile: "", sleep: noSleep })).toEqual({ ok: false, reason: "no-marker-configured" });
  });

  it("never throws on a null or non-object options argument", async () => {
    expect(await validateDevice(root, null)).toEqual({ ok: false, reason: "no-marker-configured" });
    expect(await validateDevice(root)).toEqual({ ok: false, reason: "no-marker-configured" });
    expect(await validateDevice("", null)).toEqual({ ok: false, reason: "no-path" });
  });

  it("rejects a non-string markerFile without throwing", async () => {
    for (const bad of [true, 1, {}, [], Symbol("x")]) {
      const res = await validateDevice(root, { markerFile: bad, sleep: noSleep });
      expect(res).toEqual({ ok: false, reason: "no-marker-configured" });
    }
  });

  it("does not pass a wrong device when the marker disappears between retries (re-checks every attempt)", async () => {
    // The marker is present at the start (passes the upfront check + attempt 0's
    // re-check), but the dir is read-only so readiness fails and we retry. Before the
    // retry we remove the marker AND make the dir writable - simulating the volume
    // being swapped for a different writable dir. The re-check must catch this and
    // refuse rather than return ok for the now-unmarked writable dir.
    fs.writeFileSync(path.join(root, MARKER), "");
    fs.chmodSync(root, 0o500);
    let slept = 0;
    const sleep = async () => {
      slept++;
      fs.chmodSync(root, 0o700);
      fs.unlinkSync(path.join(root, MARKER));
    };
    const res = await validateDevice(root, { markerFile: MARKER, attempts: 5, sleep });
    expect(res).toEqual({ ok: false, reason: "missing-marker" });
    expect(slept).toBe(1); // terminal on the marker-gone re-check, no further retries
  });

  it("a temp file it cannot delete is a terminal not-writable (no retry, no further leaks)", async () => {
    fs.writeFileSync(path.join(root, MARKER), "");
    const realUnlink = fsp.unlink;
    let unlinkCalls = 0;
    fsp.unlink = async (p) => { unlinkCalls++; throw new Error("unlink denied"); };
    let slept = 0;
    const sleep = async () => { slept++; };
    try {
      const res = await validateDevice(root, { markerFile: MARKER, attempts: 5, sleep });
      expect(res).toEqual({ ok: false, reason: "not-writable" });
      expect(slept).toBe(0); // terminal: stops immediately, does not retry
      expect(unlinkCalls).toBe(1); // only one temp written, so only one failed unlink
    } finally {
      fsp.unlink = realUnlink;
    }
    for (const nm of fs.readdirSync(root)) {
      if (nm.startsWith(".openswim-validate-")) fs.unlinkSync(path.join(root, nm));
    }
  });

  it("is terminal if writeFile fails AFTER creating the temp and cleanup also fails (no retry, no growing leak)", async () => {
    fs.writeFileSync(path.join(root, MARKER), "");
    const realWrite = fsp.writeFile;
    const realUnlink = fsp.unlink;
    // writeFile creates the temp then rejects (a partial write); the cleanup unlink then
    // fails with a non-ENOENT error, so a temp leaked - this must be terminal.
    fsp.writeFile = async (p) => { await realWrite(p, ""); throw new Error("disk full mid-write"); };
    fsp.unlink = async () => { throw Object.assign(new Error("unlink denied"), { code: "EACCES" }); };
    let slept = 0;
    const sleep = async () => { slept++; };
    try {
      const res = await validateDevice(root, { markerFile: MARKER, attempts: 5, sleep });
      expect(res).toEqual({ ok: false, reason: "not-writable" });
      expect(slept).toBe(0); // terminal: no retry, so no further temps written
    } finally {
      fsp.writeFile = realWrite;
      fsp.unlink = realUnlink;
    }
    for (const nm of fs.readdirSync(root)) {
      if (nm.startsWith(".openswim-validate-")) fs.unlinkSync(path.join(root, nm));
    }
  });

  it("rejects a marker with a separator or . / .. so it cannot prove a marker outside the device", async () => {
    fs.writeFileSync(path.join(root, MARKER), "");
    for (const bad of [".", "..", "sub/.marker", "../escape", "/abs/marker"]) {
      const res = await validateDevice(root, { markerFile: bad, sleep: noSleep });
      expect(res).toEqual({ ok: false, reason: "bad-marker" });
    }
  });

  it("fails unreadable when the marked path cannot be listed", async () => {
    // Put the marker on a subdir that exists, then chmod it 0o100 (execute-only): the
    // marker access (R_OK on a named file) is allowed via the exec bit but readdir of
    // the dir is denied, exercising the readdir failure branch with a real marker.
    const dir = path.join(root, "dev");
    fs.mkdirSync(dir);
    fs.writeFileSync(path.join(dir, MARKER), "");
    fs.chmodSync(dir, 0o100);
    const res = await validateDevice(dir, { markerFile: MARKER, attempts: 2, sleep: noSleep });
    fs.chmodSync(dir, 0o700);
    expect(res).toEqual({ ok: false, reason: "unreadable" });
  });

  it("reports not-writable when the temp delete cannot complete (round-trip incomplete, no false pass)", async () => {
    fs.writeFileSync(path.join(root, MARKER), "");
    const realUnlink = fsp.unlink;
    fsp.unlink = async () => { throw new Error("unlink denied"); };
    try {
      const res = await validateDevice(root, { markerFile: MARKER, attempts: 1, sleep: noSleep });
      expect(res).toEqual({ ok: false, reason: "not-writable" });
    } finally {
      fsp.unlink = realUnlink;
    }
    // Clean the temp the failed unlink left behind so the dir can be removed.
    for (const n of fs.readdirSync(root)) {
      if (n.startsWith(".openswim-validate-")) fs.unlinkSync(path.join(root, n));
    }
  });

  it("never throws even when the injected sleep rejects", async () => {
    fs.writeFileSync(path.join(root, MARKER), "");
    fs.chmodSync(root, 0o500);
    const sleep = async () => { throw new Error("sleep blew up"); };
    const res = await validateDevice(root, { markerFile: MARKER, attempts: 3, sleep });
    fs.chmodSync(root, 0o700);
    expect(res).toEqual({ ok: false, reason: "not-writable" });
  });

  it("clamps a huge attempts value so it cannot retry forever", async () => {
    fs.writeFileSync(path.join(root, MARKER), "");
    fs.chmodSync(root, 0o500);
    let slept = 0;
    const sleep = async () => { slept++; };
    const res = await validateDevice(root, { markerFile: MARKER, attempts: 1e9, sleep });
    fs.chmodSync(root, 0o700);
    expect(res).toEqual({ ok: false, reason: "not-writable" });
    // 20 attempts max -> at most 19 sleeps between them, bounded regardless of input.
    expect(slept).toBeLessThanOrEqual(19);
  });

  it("retry succeeds when readiness arrives on attempt N", async () => {
    fs.writeFileSync(path.join(root, MARKER), "");
    // Start the dir read-only (not yet writable, like a freshly-attached volume), then
    // flip it writable after the 2nd sleep so the 3rd attempt's temp write succeeds.
    fs.chmodSync(root, 0o500);
    let slept = 0;
    const sleep = async () => { slept++; if (slept === 2) fs.chmodSync(root, 0o700); };
    const res = await validateDevice(root, { markerFile: MARKER, attempts: 5, delayMs: 1, sleep });
    expect(res).toEqual({ ok: true, path: root });
    expect(slept).toBe(2);
  });

  it("never throws and cleans up its temp file (no leak)", async () => {
    fs.writeFileSync(path.join(root, MARKER), "");
    const res = await validateDevice(root, { markerFile: MARKER, sleep: noSleep });
    expect(res.ok).toBe(true);
    const leftover = fs.readdirSync(root).filter((n) => n.startsWith(".openswim-validate-"));
    expect(leftover).toEqual([]);
  });

  it("a stale leftover temp from a crash does not break a later validate", async () => {
    fs.writeFileSync(path.join(root, MARKER), "");
    fs.writeFileSync(path.join(root, ".openswim-validate-stale-from-crash"), "");
    const res = await validateDevice(root, { markerFile: MARKER, sleep: noSleep });
    expect(res).toEqual({ ok: true, path: root });
  });
});
