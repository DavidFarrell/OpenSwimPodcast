import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { createRequire } from "node:module";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";

const require = createRequire(import.meta.url);
const { createDeviceWatcher } = require("./device.cjs");

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
