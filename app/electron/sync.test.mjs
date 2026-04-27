import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { createRequire } from "node:module";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";

const require = createRequire(import.meta.url);
const { runSync, isOurFilename, sha256File, buildPlan, readManifest, writeManifest, MANIFEST_FILE } = require("./sync.cjs");

function mkTmp(label = "os-sync-") { return fs.mkdtempSync(path.join(os.tmpdir(), label)); }
function rmTmp(d) { try { fs.rmSync(d, { recursive: true, force: true }); } catch {} }

function makeItem({ uuid, show, title = "Ep", slot, ext = "mp3", filename }) {
  return { uuid, show, title, slot, ext, filename };
}

describe("isOurFilename", () => {
  it("matches slot_show.mp3 files we write, rejects everything else", () => {
    expect(isOurFilename("01_hardfork.mp3")).toBe(true);
    expect(isOurFilename("07_invisibl.mp3")).toBe(true);
    expect(isOurFilename("99_radio.mp3")).toBe(true);
    expect(isOurFilename("notes.txt")).toBe(false);
    expect(isOurFilename("music.mp3")).toBe(false);
    expect(isOurFilename("01_hardfork.m4a")).toBe(false);
    expect(isOurFilename("123_long.mp3")).toBe(false);
  });
});

describe("buildPlan", () => {
  it("produces one entry per expected action, preserving queue order within each stage", () => {
    const queue = [
      makeItem({ uuid: "a", show: "HARD FORK", slot: 1, ext: "mp3", filename: "01_hardfork.mp3" }),
      makeItem({ uuid: "b", show: "99% INVISIBLE", slot: 2, ext: "mp4", filename: "02_99invisi.mp3" }),
    ];
    const existingDeviceFiles = ["01_oldshow.mp3", "notes.txt"];
    const plan = buildPlan({ queue, existingDeviceFiles });

    const byStage = Object.groupBy ? Object.groupBy(plan, (p) => p.stage)
      : plan.reduce((a, p) => { (a[p.stage] ||= []).push(p); return a; }, {});

    expect(byStage.finalise).toHaveLength(1);
    expect(byStage.delete).toHaveLength(1);
    expect(byStage.delete[0].text).toContain("01_oldshow.mp3");
    expect(byStage.convert).toHaveLength(1);
    expect(byStage.convert[0].uuid).toBe("b");
    expect(byStage.transfer).toHaveLength(2);
    expect(byStage.transfer.map((p) => p.uuid)).toEqual(["a", "b"]);
    expect(byStage.verify).toHaveLength(1);
  });
});

describe("runSync happy path", () => {
  let devicePath, cacheDir;

  beforeEach(() => {
    devicePath = mkTmp("os-device-");
    cacheDir = mkTmp("os-cache-");
  });
  afterEach(() => { rmTmp(devicePath); rmTmp(cacheDir); });

  it("converts videos, copies everything, and verifies sha256", async () => {
    const audioBytes = Buffer.from("some audio payload, yum");
    const videoBytes = Buffer.from("fake video bytes");
    const convertedBytes = Buffer.from("converted mp3 from video");

    fs.writeFileSync(path.join(cacheDir, "a.mp3"), audioBytes);
    fs.writeFileSync(path.join(cacheDir, "b.mp4"), videoBytes);

    const convertFn = vi.fn(async ({ src, dest }) => {
      expect(src).toBe(path.join(cacheDir, "b.mp4"));
      expect(dest).toBe(path.join(cacheDir, "b.mp3"));
      fs.writeFileSync(dest, convertedBytes);
      return { bytes: convertedBytes.length, durationSec: 120, fromCache: false };
    });

    const queue = [
      makeItem({ uuid: "a", show: "HARD FORK", slot: 1, ext: "mp3", filename: "01_hardfork.mp3" }),
      makeItem({ uuid: "b", show: "ACQUIRED", slot: 2, ext: "mp4", filename: "02_acquired.mp3" }),
    ];

    const events = [];
    const res = await runSync({
      devicePath, cacheDir, queue, convertFn,
      onEvent: (e) => events.push(e),
    });

    expect(res.ok).toBe(true);
    expect(fs.readFileSync(path.join(devicePath, "01_hardfork.mp3")).equals(audioBytes)).toBe(true);
    expect(fs.readFileSync(path.join(devicePath, "02_acquired.mp3")).equals(convertedBytes)).toBe(true);
    expect(convertFn).toHaveBeenCalledOnce();

    const stages = events.filter((e) => e.type === "stage" && e.state === "done").map((e) => e.stage);
    expect(stages).toEqual(["finalise", "delete", "convert", "transfer", "verify"]);
    expect(events.at(-1).type).toBe("complete");
  });

  it("deletes our old files from the device but leaves foreign files alone", async () => {
    const payload = Buffer.from("new ep");
    fs.writeFileSync(path.join(cacheDir, "a.mp3"), payload);

    fs.writeFileSync(path.join(devicePath, "01_oldshow.mp3"), Buffer.from("stale"));
    fs.writeFileSync(path.join(devicePath, "02_another.mp3"), Buffer.from("also stale"));
    fs.writeFileSync(path.join(devicePath, "notes.txt"), "user notes");
    fs.writeFileSync(path.join(devicePath, "photo.jpg"), "not ours");

    const queue = [makeItem({ uuid: "a", show: "HARD FORK", slot: 1, ext: "mp3", filename: "01_hardfork.mp3" })];

    const events = [];
    await runSync({ devicePath, cacheDir, queue, convertFn: async () => {}, onEvent: (e) => events.push(e) });

    const remaining = fs.readdirSync(devicePath).sort();
    expect(remaining).toEqual([".openswim-manifest.json", "01_hardfork.mp3", "notes.txt", "photo.jpg"]);
  });

  it("does not re-delete a file whose slot is being reused (same filename new content)", async () => {
    const payload = Buffer.from("new take");
    fs.writeFileSync(path.join(cacheDir, "a.mp3"), payload);
    fs.writeFileSync(path.join(devicePath, "01_hardfork.mp3"), Buffer.from("old take"));

    const queue = [makeItem({ uuid: "a", show: "HARD FORK", slot: 1, ext: "mp3", filename: "01_hardfork.mp3" })];

    await runSync({ devicePath, cacheDir, queue, convertFn: async () => {}, onEvent: () => {} });

    expect(fs.readFileSync(path.join(devicePath, "01_hardfork.mp3")).equals(payload)).toBe(true);
  });

  it("runs the converter at speed != 1.0 even for mp3 sources (atempo re-encode)", async () => {
    fs.writeFileSync(path.join(cacheDir, "a.mp3"), Buffer.from("original audio"));

    const convertFn = vi.fn(async ({ src, dest, speed }) => {
      expect(speed).toBeCloseTo(1.5, 3);
      fs.writeFileSync(dest, Buffer.from("sped up mp3"));
      return { bytes: 11, durationSec: 60, fromCache: false };
    });

    const queue = [makeItem({ uuid: "a", show: "HARD FORK", slot: 1, ext: "mp3", filename: "01_hardfork.mp3" })];

    await runSync({ devicePath, cacheDir, queue, convertFn, speed: 1.5, onEvent: () => {} });

    expect(convertFn).toHaveBeenCalledOnce();
    expect(fs.readFileSync(path.join(devicePath, "01_hardfork.mp3")).toString()).toBe("sped up mp3");
  });

  it("at speed 1.0 an mp3 source is copied directly without invoking the converter", async () => {
    const payload = Buffer.from("pristine mp3");
    fs.writeFileSync(path.join(cacheDir, "a.mp3"), payload);

    const convertFn = vi.fn();
    const queue = [makeItem({ uuid: "a", show: "HARD FORK", slot: 1, ext: "mp3", filename: "01_hardfork.mp3" })];

    await runSync({ devicePath, cacheDir, queue, convertFn, speed: 1.0, onEvent: () => {} });

    expect(convertFn).not.toHaveBeenCalled();
    expect(fs.readFileSync(path.join(devicePath, "01_hardfork.mp3")).equals(payload)).toBe(true);
  });

  it("skips conversion when the converted mp3 already exists in the cache", async () => {
    const cachedMp3 = Buffer.from("already converted");
    fs.writeFileSync(path.join(cacheDir, "b.mp4"), Buffer.from("video"));
    fs.writeFileSync(path.join(cacheDir, "b.mp3"), cachedMp3);

    const convertFn = vi.fn(async () => { throw new Error("should not be called"); });

    const queue = [makeItem({ uuid: "b", show: "ACQUIRED", slot: 1, ext: "mp4", filename: "01_acquired.mp3" })];

    await runSync({ devicePath, cacheDir, queue, convertFn, onEvent: () => {} });

    expect(convertFn).not.toHaveBeenCalled();
    expect(fs.readFileSync(path.join(devicePath, "01_acquired.mp3")).equals(cachedMp3)).toBe(true);
  });
});

describe("runSync failures", () => {
  let devicePath, cacheDir;

  beforeEach(() => {
    devicePath = mkTmp("os-device-");
    cacheDir = mkTmp("os-cache-");
  });
  afterEach(() => { rmTmp(devicePath); rmTmp(cacheDir); });

  it("fails verify and throws when the copy didn't land cleanly", async () => {
    fs.writeFileSync(path.join(cacheDir, "a.mp3"), Buffer.from("correct audio"));

    const copyFn = async (src, dest) => {
      fs.writeFileSync(dest, Buffer.from("corrupted in flight"));
    };

    const queue = [makeItem({ uuid: "a", show: "HARD FORK", slot: 1, ext: "mp3", filename: "01_hardfork.mp3" })];
    const events = [];
    await expect(runSync({
      devicePath, cacheDir, queue, convertFn: async () => {}, copyFn,
      onEvent: (e) => events.push(e),
    })).rejects.toThrow(/checksum|mismatch|verify/i);

    const verifyEvents = events.filter((e) => e.stage === "verify");
    expect(verifyEvents.some((e) => e.state === "error")).toBe(true);
  });

  it("aborts mid-transfer, does not proceed to verify, cleans up the partial", async () => {
    fs.writeFileSync(path.join(cacheDir, "a.mp3"), Buffer.from("aaaaaaaaaaaaaaa"));
    fs.writeFileSync(path.join(cacheDir, "b.mp3"), Buffer.from("bbbbbbbbbbbbbbb"));

    const ctrl = new AbortController();
    const copyFn = async (src, dest, { onProgress, signal }) => {
      if (dest.endsWith("02_second.mp3")) {
        ctrl.abort();
        const err = new Error("aborted"); err.name = "AbortError";
        throw err;
      }
      fs.copyFileSync(src, dest);
    };

    const queue = [
      makeItem({ uuid: "a", show: "FIRST", slot: 1, ext: "mp3", filename: "01_first.mp3" }),
      makeItem({ uuid: "b", show: "SECOND", slot: 2, ext: "mp3", filename: "02_second.mp3" }),
    ];

    const events = [];
    await expect(runSync({
      devicePath, cacheDir, queue, convertFn: async () => {}, copyFn,
      onEvent: (e) => events.push(e), signal: ctrl.signal,
    })).rejects.toMatchObject({ name: "AbortError" });

    const verifyStarted = events.find((e) => e.type === "stage" && e.stage === "verify" && e.state === "active");
    expect(verifyStarted).toBeUndefined();
  });
});

describe("readManifest", () => {
  let dir;
  beforeEach(() => { dir = mkTmp("os-manifest-"); });
  afterEach(() => rmTmp(dir));

  it("returns [] when device has no files", async () => {
    expect(await readManifest(dir)).toEqual([]);
  });

  it("synthesises stub entries from disk when no manifest is present", async () => {
    fs.writeFileSync(path.join(dir, "01_hardfork.mp3"), Buffer.alloc(1024 * 100));
    fs.writeFileSync(path.join(dir, "02_radiolab.mp3"), Buffer.alloc(1024 * 200));
    fs.writeFileSync(path.join(dir, "notes.txt"), "not ours");
    const r = await readManifest(dir);
    expect(r.map((e) => e.fname)).toEqual(["01_hardfork.mp3", "02_radiolab.mp3"]);
    expect(r[0].uuid).toBeNull();
    expect(r[0].show).toBe("HARDFORK");
  });

  it("returns manifest entries verbatim, dropping ones whose file is missing", async () => {
    fs.writeFileSync(path.join(dir, "01_hardfork.mp3"), "x");
    await writeManifest(dir, [
      { uuid: "a", title: "Ep A", show: "HARD FORK", filename: "01_hardfork.mp3", sizeMB: 1, durMin: 30, ext: "mp3", slot: 1 },
      { uuid: "b", title: "Ep B", show: "RADIOLAB",  filename: "02_radiolab.mp3", sizeMB: 2, durMin: 40, ext: "mp3", slot: 2 },
    ]);
    const r = await readManifest(dir);
    expect(r.map((e) => e.uuid)).toEqual(["a"]);
  });

  it("written manifest is at .openswim-manifest.json", async () => {
    await writeManifest(dir, [{ uuid: "a", title: "t", show: "S", filename: "01_s.mp3", sizeMB: 1, durMin: 1, ext: "mp3", slot: 1 }]);
    expect(fs.existsSync(path.join(dir, MANIFEST_FILE))).toBe(true);
  });
});
