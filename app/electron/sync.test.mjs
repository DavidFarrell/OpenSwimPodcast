import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { createRequire } from "node:module";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";

const require = createRequire(import.meta.url);
const { runSync, isOurFilename, sha256File, buildPlan, itemNeedsEncode, readManifest, writeManifest, MANIFEST_FILE, generateCuts, adToCut, assignCutIds, resolveEpisodeCuts, degradeFromStats, EDGE_SNAP_SEC, generateIntro, INTRO_PIPELINE_VERSION } = require("./sync.cjs");
const { cutId } = require("./detectAds.cjs");

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

  it("emits a convert entry for every queue item when needsEncode is true (e.g. boost or speed change)", () => {
    const queue = [
      makeItem({ uuid: "a", show: "HARD FORK", slot: 1, ext: "mp3", filename: "01_hardfork.mp3" }),
      makeItem({ uuid: "b", show: "RADIOLAB",  slot: 2, ext: "mp3", filename: "02_radiolab.mp3" }),
    ];
    const plan = buildPlan({ queue, needsEncode: true });
    const convertItems = plan.filter((p) => p.stage === "convert");
    expect(convertItems).toHaveLength(2);
    expect(convertItems.map((p) => p.uuid)).toEqual(["a", "b"]);
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
    // Convert now runs BEFORE delete (slice 1): the old device files survive a convert
    // failure, so the safer order is convert -> delete -> transfer -> verify. Slice 4
    // inserts the device park (waiting-for-device) between convert and delete; with a
    // device-present default-resolved park it resolves instantly, so the ONLY change to
    // this list is the new stage in that position - the device-touching order is intact.
    expect(stages).toEqual(["finalise", "convert", "waiting-for-device", "delete", "transfer", "verify"]);
    expect(events.at(-1).type).toBe("complete");
  });

  // The success screen MUST render this authoritative set (files actually copied
  // and verified), never the caller's live queue - else a download finishing
  // mid-run could make the UI claim an un-transferred episode is on the device.
  it("returns an authoritative transferred set built from the verified device files", async () => {
    const audioBytes = Buffer.from("plain mp3 copied straight through");
    const convertedBytes = Buffer.from("re-encoded video to mp3 here");
    fs.writeFileSync(path.join(cacheDir, "a.mp3"), audioBytes);
    fs.writeFileSync(path.join(cacheDir, "b.mp4"), Buffer.from("video"));
    const convertFn = vi.fn(async ({ dest }) => { fs.writeFileSync(dest, convertedBytes); return { bytes: convertedBytes.length, durationSec: 120, fromCache: false }; });
    // Inject a deterministic probe so the test is hermetic (default returns null).
    const probeDurationFn = vi.fn(async (file) => (file.endsWith("01_hardfork.mp3") ? 1800 : 1200));

    const queue = [
      makeItem({ uuid: "a", show: "HARD FORK", title: "Plain Ep", slot: 1, ext: "mp3", filename: "01_hardfork.mp3" }),
      makeItem({ uuid: "b", show: "ACQUIRED", title: "Video Ep", slot: 2, ext: "mp4", filename: "02_acquired.mp3" }),
    ];
    const res = await runSync({ devicePath, cacheDir, queue, convertFn, probeDurationFn, onEvent: () => {} });

    expect(res.ok).toBe(true);
    expect(res.transferred).toHaveLength(2);
    const a = res.transferred.find((t) => t.uuid === "a");
    const b = res.transferred.find((t) => t.uuid === "b");
    // Real on-device bytes (stat of the dest), not queue metadata.
    expect(a.bytes).toBe(audioBytes.length);
    expect(b.bytes).toBe(convertedBytes.length);
    // Real processed duration from the probe.
    expect(a.durationSec).toBe(1800);
    expect(b.durationSec).toBe(1200);
    // converted=false for the straight copy, true for the re-encoded video.
    expect(a.converted).toBe(false);
    expect(b.converted).toBe(true);
    expect(a.verified).toBe(true);
    expect(a.fname).toBe("01_hardfork.mp3");
    expect(a.title).toBe("Plain Ep");
    // Totals are summed from the real per-file values.
    expect(res.totals).toEqual({
      files: 2,
      bytes: audioBytes.length + convertedBytes.length,
      listenTimeSec: 3000,
      listenTimeComplete: true,
      converted: 1,
    });
  });

  it("a null/failing duration probe degrades to null duration, never throws", async () => {
    fs.writeFileSync(path.join(cacheDir, "a.mp3"), Buffer.from("audio"));
    const probeDurationFn = vi.fn(async () => { throw new Error("ffmpeg missing"); });
    const res = await runSync({
      devicePath, cacheDir,
      queue: [makeItem({ uuid: "a", show: "HARD FORK", slot: 1, ext: "mp3", filename: "01_hardfork.mp3" })],
      convertFn: async () => {}, probeDurationFn, onEvent: () => {},
    });
    expect(res.ok).toBe(true);
    expect(res.transferred[0].durationSec).toBe(null);
    expect(res.totals.listenTimeSec).toBe(0);
    // A run with any unknown duration must not claim a complete listen time.
    expect(res.totals.listenTimeComplete).toBe(false);
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

  it("fails verify and throws when the copy didn't land cleanly, leaving NO final file", async () => {
    fs.writeFileSync(path.join(cacheDir, "a.mp3"), Buffer.from("correct audio"));

    // copyFn writes corrupt bytes to the temp it is handed. The sha256 of the temp
    // will not match the source, so verify-before-rename aborts and the rename never
    // happens - no final-named file is created.
    const copyFn = async (src, dest) => {
      fs.writeFileSync(dest, Buffer.from("corrupted in flight"));
    };

    const queue = [makeItem({ uuid: "a", show: "HARD FORK", slot: 1, ext: "mp3", filename: "01_hardfork.mp3" })];
    const events = [];
    await expect(runSync({
      devicePath, cacheDir, queue, convertFn: async () => {}, copyFn,
      onEvent: (e) => events.push(e),
    })).rejects.toThrow(/checksum|mismatch|verify/i);

    // A mismatch surfaces an error event (now in the transfer stage, before rename).
    expect(events.some((e) => e.state === "error" && /mismatch/i.test(e.text || ""))).toBe(true);
    // CARDINAL: no final-named file, no manifest, and no leftover temp.
    const remaining = fs.readdirSync(devicePath);
    expect(remaining).not.toContain("01_hardfork.mp3");
    expect(remaining).not.toContain(MANIFEST_FILE);
    expect(remaining.filter((f) => f.includes(".part-"))).toEqual([]);
  });

  it("aborts mid-transfer, does not proceed to verify, leaves no final file and cleans up the temp", async () => {
    fs.writeFileSync(path.join(cacheDir, "a.mp3"), Buffer.from("aaaaaaaaaaaaaaa"));
    fs.writeFileSync(path.join(cacheDir, "b.mp3"), Buffer.from("bbbbbbbbbbbbbbb"));

    const ctrl = new AbortController();
    // The transfer loop now copies to a UNIQUE temp (".<final>.part-<runId>-<i>"), so
    // we key the abort off the SECOND file's temp, not its final name.
    const copyFn = async (src, dest, { onProgress, signal }) => {
      if (dest.includes(".02_second.mp3.part-")) {
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
    // No final-named partial for the aborted file, and the temp this run created is
    // best-effort cleaned up. (The first file did land - it was verified + renamed
    // before the second's abort - which is fine; the run still fails with no manifest.)
    const remaining = fs.readdirSync(devicePath);
    expect(remaining).not.toContain("02_second.mp3");
    expect(remaining.filter((f) => f.includes(".part-"))).toEqual([]);
    expect(remaining).not.toContain(MANIFEST_FILE);
  });
});

// --- Slice 2: crash-safe transfer (copy-temp -> verify -> rename; manifest last) ---
describe("runSync crash-safe transfer tail", () => {
  let devicePath, cacheDir;
  beforeEach(() => { devicePath = mkTmp("os-device-"); cacheDir = mkTmp("os-cache-"); });
  afterEach(() => { rmTmp(devicePath); rmTmp(cacheDir); });

  // THE slice-2 regression catcher. A copy that fails mid-file (writes a partial to
  // the temp it is handed, then throws) must leave NO final-named file - only the
  // temp, which is then cleaned up. If the crash-safety is removed (copy direct to
  // the final name), a partial final file would survive and this test fails.
  it("a copy that fails mid-file leaves NO final-named file; the temp is cleaned up", async () => {
    fs.writeFileSync(path.join(cacheDir, "a.mp3"), Buffer.from("the real, complete episode audio"));
    const copyFn = async (src, dest) => {
      // Write a partial to the temp, then crash - exactly a mid-transfer detach.
      fs.writeFileSync(dest, Buffer.from("the real, comp"));
      throw new Error("device yanked mid-copy");
    };
    const queue = [makeItem({ uuid: "a", show: "HARD FORK", slot: 1, ext: "mp3", filename: "01_hardfork.mp3" })];
    await expect(runSync({
      devicePath, cacheDir, queue, convertFn: async () => {}, copyFn, onEvent: () => {},
    })).rejects.toThrow(/yanked/);

    const remaining = fs.readdirSync(devicePath);
    // No final-named file (a partial final would mean a false-complete-looking file).
    expect(remaining).not.toContain("01_hardfork.mp3");
    // The temp this run created is best-effort cleaned up.
    expect(remaining.filter((f) => f.includes(".part-"))).toEqual([]);
    // And no manifest: the run is never reported complete.
    expect(remaining).not.toContain(MANIFEST_FILE);
  });

  // A verify mismatch must abort BEFORE the rename AND before the manifest.
  it("a verify mismatch aborts before rename and before manifest, leaving no final + no manifest", async () => {
    fs.writeFileSync(path.join(cacheDir, "a.mp3"), Buffer.from("correct payload"));
    fs.writeFileSync(path.join(cacheDir, "b.mp3"), Buffer.from("also correct"));
    const copyFn = async (src, dest) => {
      // Corrupt only the second file's temp so verify-before-rename catches it.
      if (dest.includes(".02_radiolab.mp3.part-")) fs.writeFileSync(dest, Buffer.from("WRONG"));
      else fs.copyFileSync(src, dest);
    };
    const queue = [
      makeItem({ uuid: "a", show: "HARD FORK", slot: 1, ext: "mp3", filename: "01_hardfork.mp3" }),
      makeItem({ uuid: "b", show: "RADIOLAB", slot: 2, ext: "mp3", filename: "02_radiolab.mp3" }),
    ];
    await expect(runSync({
      devicePath, cacheDir, queue, convertFn: async () => {}, copyFn, onEvent: () => {},
    })).rejects.toThrow(/checksum|mismatch|verify/i);

    const remaining = fs.readdirSync(devicePath);
    // The mismatched file never got a final name, and the manifest was never written
    // (ANY file failing means the whole transfer failed).
    expect(remaining).not.toContain("02_radiolab.mp3");
    expect(remaining).not.toContain(MANIFEST_FILE);
    expect(remaining.filter((f) => f.includes(".part-"))).toEqual([]);
  });

  // Manifest is absent whenever ANY file fails.
  it("the manifest is absent when any file fails", async () => {
    fs.writeFileSync(path.join(cacheDir, "a.mp3"), Buffer.from("good"));
    fs.writeFileSync(path.join(cacheDir, "b.mp3"), Buffer.from("good too"));
    const copyFn = async (src, dest) => {
      if (dest.includes(".02_radiolab.mp3.part-")) throw new Error("second file copy failed");
      fs.copyFileSync(src, dest);
    };
    const queue = [
      makeItem({ uuid: "a", show: "HARD FORK", slot: 1, ext: "mp3", filename: "01_hardfork.mp3" }),
      makeItem({ uuid: "b", show: "RADIOLAB", slot: 2, ext: "mp3", filename: "02_radiolab.mp3" }),
    ];
    await expect(runSync({
      devicePath, cacheDir, queue, convertFn: async () => {}, copyFn, onEvent: () => {},
    })).rejects.toThrow(/second file copy failed/);
    expect(fs.existsSync(path.join(devicePath, MANIFEST_FILE))).toBe(false);
  });

  // Unique temp names: no collision across files within a run, and a prior run's
  // leftover temp is never reused (a new runId is minted each run).
  it("uses unique temp names per file and per run (no collision, no blind reuse)", async () => {
    fs.writeFileSync(path.join(cacheDir, "a.mp3"), Buffer.from("aaa"));
    fs.writeFileSync(path.join(cacheDir, "b.mp3"), Buffer.from("bbb"));
    // A stale leftover temp from a hypothetical prior run sitting on the device.
    const staleTemp = path.join(devicePath, ".01_hardfork.mp3.part-stale-run-0");
    fs.writeFileSync(staleTemp, Buffer.from("garbage from a dead run"));

    const seenTemps = [];
    const copyFn = async (src, dest) => {
      seenTemps.push(path.basename(dest));
      // The temp we copy to must NEVER be the stale leftover (no blind reuse).
      expect(dest).not.toBe(staleTemp);
      fs.copyFileSync(src, dest);
    };
    const queue = [
      makeItem({ uuid: "a", show: "HARD FORK", slot: 1, ext: "mp3", filename: "01_hardfork.mp3" }),
      makeItem({ uuid: "b", show: "RADIOLAB", slot: 2, ext: "mp3", filename: "02_radiolab.mp3" }),
    ];
    const res = await runSync({
      devicePath, cacheDir, queue, convertFn: async () => {}, copyFn, onEvent: () => {},
    });
    expect(res.ok).toBe(true);
    // The two files used distinct temp names within the run.
    expect(new Set(seenTemps).size).toBe(2);
    // Both finals landed; the run's own temps are gone (renamed away).
    expect(fs.existsSync(path.join(devicePath, "01_hardfork.mp3"))).toBe(true);
    expect(fs.existsSync(path.join(devicePath, "02_radiolab.mp3"))).toBe(true);
  });

  // A manifest write failure must NOT be swallowed into an ok:true / complete result.
  // The renames all landed (final files exist) but the completion record could not be
  // written, so the run must FAIL rather than report a completed transfer. The
  // no-manifest-after-rename state recovers as not-done. We fail ONLY the manifest's
  // own temp->final rename (spied), so the episode renames before it still land.
  it("a manifest write failure fails the run (no false-complete after the renames)", async () => {
    fs.writeFileSync(path.join(cacheDir, "a.mp3"), Buffer.from("episode bytes"));
    const fsp = require("node:fs/promises");
    const realRename = fsp.rename.bind(fsp);
    const spy = vi.spyOn(fsp, "rename").mockImplementation(async (from, to) => {
      if (String(to).endsWith(MANIFEST_FILE)) throw new Error("manifest rename blew up");
      return realRename(from, to);
    });
    try {
      const queue = [makeItem({ uuid: "a", show: "HARD FORK", slot: 1, ext: "mp3", filename: "01_hardfork.mp3" })];
      const events = [];
      await expect(runSync({
        devicePath, cacheDir, queue, convertFn: async () => {}, copyFn: async (s, d) => fs.copyFileSync(s, d),
        onEvent: (e) => events.push(e),
      })).rejects.toThrow(/manifest/i);

      // The episode's final file DID land (its rename ran before the manifest), but the
      // run did NOT report completion - no complete event, no manifest on the device.
      expect(fs.existsSync(path.join(devicePath, "01_hardfork.mp3"))).toBe(true);
      expect(fs.existsSync(path.join(devicePath, MANIFEST_FILE))).toBe(false);
      expect(events.some((e) => e.type === "complete")).toBe(false);
    } finally {
      spy.mockRestore();
    }
  });

  // A prior run's manifest must be invalidated BEFORE the destructive delete/transfer,
  // so that if THIS run crashes mid-transfer the device carries no manifest claiming
  // success for a state that has since changed. We simulate the crash by failing the
  // copy after an existing manifest is present, and assert the old manifest is gone.
  it("removes the prior manifest before transfer, so a mid-transfer crash leaves none", async () => {
    fs.writeFileSync(path.join(cacheDir, "a.mp3"), Buffer.from("new content"));
    // A stale manifest from a previous run, plus the file it described.
    fs.writeFileSync(path.join(devicePath, "09_oldshow.mp3"), Buffer.from("old"));
    await writeManifest(devicePath, [
      { uuid: "old", title: "Old", show: "OLD SHOW", filename: "09_oldshow.mp3", sizeMB: 1, durMin: 5, ext: "mp3", slot: 9 },
    ]);
    expect(fs.existsSync(path.join(devicePath, MANIFEST_FILE))).toBe(true);

    const copyFn = async () => { throw new Error("yanked before any file landed"); };
    const queue = [makeItem({ uuid: "a", show: "HARD FORK", slot: 1, ext: "mp3", filename: "01_hardfork.mp3" })];
    await expect(runSync({
      devicePath, cacheDir, queue, convertFn: async () => {}, copyFn, onEvent: () => {},
    })).rejects.toThrow(/yanked/);

    // The stale manifest was removed before the transfer crashed: the device now reads
    // as not-done (no manifest), never as the prior run's still-present success record.
    expect(fs.existsSync(path.join(devicePath, MANIFEST_FILE))).toBe(false);
  });

  // The manifest write is atomic: it lands via a temp+rename, so it never leaves a
  // half-written manifest, and once written no manifest temp survives.
  it("writes the manifest atomically (no manifest temp left behind on success)", async () => {
    fs.writeFileSync(path.join(cacheDir, "a.mp3"), Buffer.from("audio"));
    const queue = [makeItem({ uuid: "a", show: "HARD FORK", slot: 1, ext: "mp3", filename: "01_hardfork.mp3" })];
    const res = await runSync({ devicePath, cacheDir, queue, convertFn: async () => {}, onEvent: () => {} });
    expect(res.ok).toBe(true);
    expect(fs.existsSync(path.join(devicePath, MANIFEST_FILE))).toBe(true);
    // No manifest .part temp survives the atomic write.
    expect(fs.readdirSync(devicePath).filter((f) => f.startsWith(MANIFEST_FILE) && f !== MANIFEST_FILE)).toEqual([]);
  });

  // A cancel that arrives during the manifest write (after the file renames) must not
  // publish the completion record: the run fails as AbortError and no manifest lands.
  it("a cancel during the manifest write does not publish a manifest (no false-complete)", async () => {
    fs.writeFileSync(path.join(cacheDir, "a.mp3"), Buffer.from("episode bytes"));
    const ctrl = new AbortController();
    const fsp = require("node:fs/promises");
    const realWriteFile = fsp.writeFile.bind(fsp);
    // Trip the cancel exactly when the manifest temp is being written - i.e. after the
    // episode rename, before the manifest's atomic rename.
    const spy = vi.spyOn(fsp, "writeFile").mockImplementation(async (p, data, opts) => {
      if (String(p).includes(MANIFEST_FILE)) ctrl.abort();
      return realWriteFile(p, data, opts);
    });
    try {
      const queue = [makeItem({ uuid: "a", show: "HARD FORK", slot: 1, ext: "mp3", filename: "01_hardfork.mp3" })];
      const events = [];
      await expect(runSync({
        devicePath, cacheDir, queue, convertFn: async () => {},
        copyFn: async (s, d) => fs.copyFileSync(s, d), signal: ctrl.signal,
        onEvent: (e) => events.push(e),
      })).rejects.toMatchObject({ name: "AbortError" });
      // The episode file landed, but no manifest was published and no complete fired.
      expect(fs.existsSync(path.join(devicePath, "01_hardfork.mp3"))).toBe(true);
      expect(fs.existsSync(path.join(devicePath, MANIFEST_FILE))).toBe(false);
      // No manifest temp left behind either.
      expect(fs.readdirSync(devicePath).filter((f) => f.startsWith(MANIFEST_FILE) && f !== MANIFEST_FILE)).toEqual([]);
      expect(events.some((e) => e.type === "complete")).toBe(false);
    } finally {
      spy.mockRestore();
    }
  });

  // A legitimately empty source must pass verify (the bytes are sha256-verified before
  // the rename, so presence - not nonzero size - is the right post-rename check).
  it("a zero-byte source still completes (verify is presence, not a size gate)", async () => {
    fs.writeFileSync(path.join(cacheDir, "a.mp3"), Buffer.alloc(0));
    const queue = [makeItem({ uuid: "a", show: "HARD FORK", slot: 1, ext: "mp3", filename: "01_hardfork.mp3" })];
    const res = await runSync({ devicePath, cacheDir, queue, convertFn: async () => {}, onEvent: () => {} });
    expect(res.ok).toBe(true);
    expect(fs.existsSync(path.join(devicePath, "01_hardfork.mp3"))).toBe(true);
    expect(fs.statSync(path.join(devicePath, "01_hardfork.mp3")).size).toBe(0);
    expect(fs.existsSync(path.join(devicePath, MANIFEST_FILE))).toBe(true);
  });

  // Happy path: the crash-safe tail produces the SAME final files + manifest as before
  // (temp-then-rename is invisible once it lands).
  it("happy path produces the same final files and manifest as a direct copy would", async () => {
    const aBytes = Buffer.from("hard fork episode");
    const bBytes = Buffer.from("radiolab episode");
    fs.writeFileSync(path.join(cacheDir, "a.mp3"), aBytes);
    fs.writeFileSync(path.join(cacheDir, "b.mp3"), bBytes);
    const queue = [
      makeItem({ uuid: "a", show: "HARD FORK", title: "HF", slot: 1, ext: "mp3", filename: "01_hardfork.mp3" }),
      makeItem({ uuid: "b", show: "RADIOLAB", title: "RL", slot: 2, ext: "mp3", filename: "02_radiolab.mp3" }),
    ];
    const events = [];
    const res = await runSync({
      devicePath, cacheDir, queue, convertFn: async () => {}, onEvent: (e) => events.push(e),
    });
    expect(res.ok).toBe(true);
    // Final files are byte-identical to the sources, no temps left behind.
    expect(fs.readFileSync(path.join(devicePath, "01_hardfork.mp3")).equals(aBytes)).toBe(true);
    expect(fs.readFileSync(path.join(devicePath, "02_radiolab.mp3")).equals(bBytes)).toBe(true);
    expect(fs.readdirSync(devicePath).filter((f) => f.includes(".part-"))).toEqual([]);
    // Manifest is present and lists both finals.
    const manifest = await readManifest(devicePath);
    expect(manifest.map((e) => e.fname).sort()).toEqual(["01_hardfork.mp3", "02_radiolab.mp3"]);
    expect(events.at(-1).type).toBe("complete");
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

describe("itemNeedsEncode", () => {
  it("forces an encode for an mp3 episode at speed 1.0 once Announce is on (intro needs re-encode)", () => {
    const plain = { ext: "mp3", announce: false };
    const intro = { ext: "mp3", announce: true };
    expect(itemNeedsEncode(plain, false)).toBe(false);
    expect(itemNeedsEncode(intro, false)).toBe(true);
  });
});

describe("buildPlan with announce", () => {
  it("adds an announce entry and a convert entry for each announced episode", () => {
    const queue = [
      makeItem({ uuid: "a", show: "HARD FORK", slot: 1, ext: "mp3", filename: "01_hardfork.mp3" }),
      { ...makeItem({ uuid: "b", show: "RADIOLAB", slot: 2, ext: "mp3", filename: "02_radiolab.mp3" }), announce: true },
    ];
    const plan = buildPlan({ queue });
    const announce = plan.filter((p) => p.stage === "announce");
    const convert = plan.filter((p) => p.stage === "convert");
    expect(announce.map((p) => p.uuid)).toEqual(["b"]);
    // "a" is a plain mp3 at speed 1.0 - no encode; only "b" needs the converter.
    expect(convert.map((p) => p.uuid)).toEqual(["b"]);
  });
});

describe("runSync announce stage", () => {
  let devicePath, cacheDir;

  beforeEach(() => {
    devicePath = mkTmp("os-device-");
    cacheDir = mkTmp("os-cache-");
  });
  afterEach(() => { rmTmp(devicePath); rmTmp(cacheDir); });

  function announceItem(over = {}) {
    return { ...makeItem({ uuid: "a", show: "HARD FORK", slot: 1, ext: "mp3", filename: "01_hardfork.mp3" }), announce: true, ...over };
  }

  // Fix 1: the deterministic intro metadata (published + episode/season number)
  // captured in the queue item must reach buildAnnouncementText through runSync.
  it("threads published + episodeNumber + seasonNumber into buildAnnouncementText", async () => {
    fs.writeFileSync(path.join(cacheDir, "a.mp3"), Buffer.from("episode audio"));

    const transcribeFn = vi.fn(async () => ({ segments: [{ text: "hello world" }] }));
    const buildAnnouncementTextFn = vi.fn(async ({ show, title, published, episodeNumber, seasonNumber }) => {
      expect(show).toBe("HARD FORK");
      expect(title).toBe("Otters");
      expect(published).toBe("2025-06-10T09:00:00Z");
      expect(episodeNumber).toBe(47);
      expect(seasonNumber).toBe(3);
      return "This is HARD FORK. Season 3, episode 47. Otters. Published on the 10th of June 2025.";
    });
    const renderIntroFn = vi.fn(async ({ outPath }) => { fs.writeFileSync(outPath, Buffer.from("intro wav")); return outPath; });
    const convertFn = vi.fn(async ({ dest }) => { fs.writeFileSync(dest, Buffer.from("converted with intro")); return { bytes: 20, durationSec: 60, fromCache: false }; });

    const res = await runSync({
      devicePath, cacheDir,
      queue: [announceItem({ title: "Otters", published: "2025-06-10T09:00:00Z", episodeNumber: 47, seasonNumber: 3 })],
      transcribeFn, buildAnnouncementTextFn, renderIntroFn, convertFn,
      onEvent: () => {},
    });

    expect(res.ok).toBe(true);
    expect(buildAnnouncementTextFn).toHaveBeenCalledOnce();
  });

  // generateIntro returns { introPath, text } so the convert loop can key the
  // cache on the spoken wording (Fix 1/3). Also threads the metadata through.
  it("generateIntro returns the spoken text alongside the introPath and passes metadata through", async () => {
    fs.writeFileSync(path.join(cacheDir, "a.mp3"), Buffer.from("episode audio"));
    const it = announceItem({ title: "Otters", published: "2025-06-10T09:00:00Z", episodeNumber: 47 });
    const buildAnnouncementTextFn = vi.fn(async ({ published, episodeNumber }) => {
      expect(published).toBe("2025-06-10T09:00:00Z");
      expect(episodeNumber).toBe(47);
      return "This is HARD FORK. Episode 47. Otters.";
    });
    const renderIntroFn = vi.fn(async ({ outPath }) => { fs.writeFileSync(outPath, Buffer.from("wav")); return outPath; });
    const out = await generateIntro({
      it, src: path.join(cacheDir, "a.mp3"), outPath: path.join(cacheDir, "a.intro.wav"),
      transcribeFn: vi.fn(async () => ({ segments: [{ text: "hi" }] })),
      buildAnnouncementTextFn, renderIntroFn,
      transcript: { segments: [{ text: "hi" }] }, hasTranscript: true,
    });
    expect(out.introPath).toBe(path.join(cacheDir, "a.intro.wav"));
    expect(out.text).toBe("This is HARD FORK. Episode 47. Otters.");
  });

  // Fix 3 (cache invalidation): a PRE-FIX cached intro encode keyed "-intro"
  // (boolean suffix, old slow/quiet/no-metadata pipeline) must NOT be reused. The
  // new key carries INTRO_PIPELINE_VERSION + a text hash, so the converter runs
  // and writes a fresh encode rather than shipping the stale cached mp3.
  it("does NOT reuse a pre-fix '-intro' cached mp3 (intro pipeline version bumped)", async () => {
    fs.writeFileSync(path.join(cacheDir, "a.mp3"), Buffer.from("episode audio"));
    // The stale pre-fix cache file at the OLD key (uuid + "-intro.mp3").
    const stalePath = path.join(cacheDir, "a-intro.mp3");
    fs.writeFileSync(stalePath, Buffer.from("OLD slow quiet no-metadata intro mix"));

    const transcribeFn = vi.fn(async () => ({ segments: [{ text: "hi" }] }));
    const buildAnnouncementTextFn = vi.fn(async () => "This is HARD FORK. Episode 47. Otters. Published on the 10th of June 2025.");
    const renderIntroFn = vi.fn(async ({ outPath }) => { fs.writeFileSync(outPath, Buffer.from("fresh intro wav")); return outPath; });
    const freshBytes = Buffer.from("FRESH fast loud metadata intro mix");
    const convertFn = vi.fn(async ({ dest }) => { fs.writeFileSync(dest, freshBytes); return { bytes: freshBytes.length, durationSec: 60, fromCache: false }; });

    const res = await runSync({
      devicePath, cacheDir,
      queue: [announceItem({ title: "Otters", published: "2025-06-10T09:00:00Z", episodeNumber: 47 })],
      transcribeFn, buildAnnouncementTextFn, renderIntroFn, convertFn,
      onEvent: () => {},
    });

    expect(res.ok).toBe(true);
    // The converter ran (the stale cache was NOT reused) and a fresh encode shipped.
    expect(convertFn).toHaveBeenCalledOnce();
    expect(fs.readFileSync(path.join(devicePath, "01_hardfork.mp3")).equals(freshBytes)).toBe(true);
    // The new variant cache file is the versioned+hashed key, NOT the old "-intro".
    const written = fs.readdirSync(cacheDir).filter((f) => f.startsWith("a-intro") && f.endsWith(".mp3"));
    expect(written).toContain(`a-intro${INTRO_PIPELINE_VERSION}-${require("node:crypto").createHash("sha1").update("This is HARD FORK. Episode 47. Otters. Published on the 10th of June 2025.").digest("hex").slice(0, 8)}.mp3`);
    // The stale file is still on disk (we never reuse it, but we also don't delete it).
    expect(fs.existsSync(stalePath)).toBe(true);
  });

  // The text hash means a CHANGED intro wording for the SAME episode invalidates:
  // two different announcement texts map to two different cache files.
  it("a different intro wording for the same episode keys a different cache file", async () => {
    fs.writeFileSync(path.join(cacheDir, "a.mp3"), Buffer.from("episode audio"));
    const renderIntroFn = vi.fn(async ({ outPath }) => { fs.writeFileSync(outPath, Buffer.from("wav")); return outPath; });
    const convertFn = vi.fn(async ({ dest }) => { fs.writeFileSync(dest, Buffer.from("out")); return { bytes: 3, durationSec: 60, fromCache: false }; });
    const run = (text) => runSync({
      devicePath, cacheDir, queue: [announceItem()],
      transcribeFn: vi.fn(async () => ({ segments: [{ text: "hi" }] })),
      buildAnnouncementTextFn: vi.fn(async () => text),
      renderIntroFn, convertFn, onEvent: () => {},
    });

    await run("This is HARD FORK. Episode 1. Ep.");
    await run("This is HARD FORK. Episode 2. Ep.");
    const variants = fs.readdirSync(cacheDir).filter((f) => f.startsWith("a-intro") && f.endsWith(".mp3"));
    // Two distinct wordings -> two distinct hashed cache files.
    expect(new Set(variants).size).toBe(2);
  });

  it("announce-on happy path: builds an intro and converts with introPath", async () => {
    fs.writeFileSync(path.join(cacheDir, "a.mp3"), Buffer.from("episode audio"));

    const transcribeFn = vi.fn(async ({ src }) => {
      expect(src).toBe(path.join(cacheDir, "a.mp3"));
      return { segments: [{ text: "hello world" }] };
    });
    const buildAnnouncementTextFn = vi.fn(async ({ show, title, transcript }) => {
      expect(show).toBe("HARD FORK");
      expect(transcript).toBeTruthy();
      return "This is HARD FORK. Ep. This episode is about hello world.";
    });
    const renderIntroFn = vi.fn(async ({ text, outPath }) => {
      expect(text).toContain("This is HARD FORK");
      fs.writeFileSync(outPath, Buffer.from("intro wav"));
      return outPath;
    });
    const convertFn = vi.fn(async ({ src, dest, introPath }) => {
      expect(src).toBe(path.join(cacheDir, "a.mp3"));
      expect(introPath).toBe(path.join(cacheDir, "a.intro.wav"));
      fs.writeFileSync(dest, Buffer.from("converted with intro"));
      return { bytes: 20, durationSec: 60, fromCache: false };
    });

    const events = [];
    const res = await runSync({
      devicePath, cacheDir, queue: [announceItem()],
      transcribeFn, buildAnnouncementTextFn, renderIntroFn, convertFn,
      onEvent: (e) => events.push(e),
    });

    expect(res.ok).toBe(true);
    expect(transcribeFn).toHaveBeenCalledOnce();
    expect(renderIntroFn).toHaveBeenCalledOnce();
    expect(convertFn).toHaveBeenCalledOnce();
    expect(fs.readFileSync(path.join(devicePath, "01_hardfork.mp3")).toString()).toBe("converted with intro");

    const ann = events.filter((e) => e.type === "announce" && e.uuid === "a").map((e) => e.state);
    expect(ann).toEqual(["analysing", "ready"]);
    const stagesDone = events.filter((e) => e.type === "stage" && e.state === "done").map((e) => e.stage);
    expect(stagesDone).toContain("announce");
  });

  it("trim+announce on one episode: transcribes ONCE and runs steps sequentially (transcribe -> detect -> intro)", async () => {
    fs.writeFileSync(path.join(cacheDir, "a.mp3"), Buffer.from("episode audio"));

    const order = [];
    const transcribeFn = vi.fn(async () => { order.push("transcribe"); return { segments: [{ start: 0, end: 5, text: "an ad here" }, { start: 5, end: 600, text: "real content" }] }; });
    const detectAdsFn = vi.fn(async ({ transcript }) => {
      order.push("detect");
      expect(transcript).toBeTruthy(); // detector got the shared transcript
      return { ads: [], stats: {} };
    });
    const buildAnnouncementTextFn = vi.fn(async ({ transcript }) => {
      order.push("intro-text");
      expect(transcript).toBeTruthy(); // intro builder got the SAME transcript
      return "This is HARD FORK. Ep.";
    });
    const renderIntroFn = vi.fn(async ({ outPath }) => { order.push("tts"); fs.writeFileSync(outPath, Buffer.from("wav")); return outPath; });
    const convertFn = vi.fn(async ({ dest }) => { fs.writeFileSync(dest, Buffer.from("out")); return { bytes: 3, durationSec: 60, fromCache: false }; });

    const events = [];
    const res = await runSync({
      devicePath, cacheDir, queue: [announceItem({ trim: true })],
      transcribeFn, detectAdsFn, buildAnnouncementTextFn, renderIntroFn, convertFn,
      onEvent: (e) => events.push(e),
    });

    expect(res.ok).toBe(true);
    // The whole point of the fix: ONE transcription shared by both steps.
    expect(transcribeFn).toHaveBeenCalledOnce();
    // Sequential, not overlapped: transcribe finished before detect, detect before intro.
    expect(order).toEqual(["transcribe", "detect", "intro-text", "tts"]);
    // A visible transcribe stage was emitted for the episode.
    const tr = events.filter((e) => e.type === "transcribe" && e.uuid === "a").map((e) => e.state);
    expect(tr).toEqual(["active", "done"]);
  });

  it("a failing TTS skips the intro and degrades to the normal episode (plain mp3 copied, no introPath)", async () => {
    const payload = Buffer.from("episode audio");
    fs.writeFileSync(path.join(cacheDir, "a.mp3"), payload);

    const transcribeFn = vi.fn(async () => ({ segments: [{ text: "hi" }] }));
    const buildAnnouncementTextFn = vi.fn(async () => "This is HARD FORK. Ep.");
    // TTS unavailable - renderIntro degrades to null.
    const renderIntroFn = vi.fn(async () => null);
    // No intro and a plain mp3 at speed 1.0 means no re-encode: the converter is
    // never invoked and the original episode is copied straight through.
    const convertFn = vi.fn();

    const events = [];
    const res = await runSync({
      devicePath, cacheDir, queue: [announceItem()],
      transcribeFn, buildAnnouncementTextFn, renderIntroFn, convertFn,
      onEvent: (e) => events.push(e),
    });

    expect(res.ok).toBe(true);
    expect(convertFn).not.toHaveBeenCalled();
    expect(fs.readFileSync(path.join(devicePath, "01_hardfork.mp3")).equals(payload)).toBe(true);
    const ann = events.filter((e) => e.type === "announce" && e.uuid === "a").map((e) => e.state);
    expect(ann).toEqual(["analysing", "skipped"]);
  });

  it("a throwing transcribe degrades to a metadata-only intro - the episode still gets an intro, not a skip", async () => {
    fs.writeFileSync(path.join(cacheDir, "a.mp3"), Buffer.from("episode audio"));

    // Transcriber unavailable / unsupported / crashing must NOT abort the intro:
    // the announce-text builder still produces "This is {show}. {title}." from
    // metadata alone and we proceed to TTS.
    const transcribeFn = vi.fn(async () => { throw new Error("fast-diarize crashed"); });
    const buildAnnouncementTextFn = vi.fn(async ({ show, title, transcript }) => {
      expect(transcript).toBeNull();
      return `This is ${show}. ${title}.`;
    });
    const renderIntroFn = vi.fn(async ({ text, outPath }) => {
      expect(text).toBe("This is HARD FORK. Ep.");
      fs.writeFileSync(outPath, Buffer.from("metadata-only intro wav"));
      return outPath;
    });
    const convertFn = vi.fn(async ({ introPath, dest }) => {
      expect(introPath).toBe(path.join(cacheDir, "a.intro.wav"));
      fs.writeFileSync(dest, Buffer.from("converted with metadata intro"));
      return { bytes: 30, durationSec: 60, fromCache: false };
    });

    const events = [];
    const res = await runSync({
      devicePath, cacheDir, queue: [announceItem()],
      transcribeFn, buildAnnouncementTextFn, renderIntroFn, convertFn,
      onEvent: (e) => events.push(e),
    });

    expect(res.ok).toBe(true);
    expect(transcribeFn).toHaveBeenCalledOnce();
    expect(buildAnnouncementTextFn).toHaveBeenCalledOnce();
    expect(renderIntroFn).toHaveBeenCalledOnce();
    expect(convertFn).toHaveBeenCalledOnce();
    expect(fs.readFileSync(path.join(devicePath, "01_hardfork.mp3")).toString()).toBe("converted with metadata intro");
    const ann = events.filter((e) => e.type === "announce" && e.uuid === "a").map((e) => e.state);
    expect(ann).toEqual(["analysing", "ready"]);
  });

  it("a failing TTS still re-encodes a video episode (degrades the intro only, not the conversion)", async () => {
    fs.writeFileSync(path.join(cacheDir, "a.mp4"), Buffer.from("video bytes"));

    const transcribeFn = vi.fn(async () => ({ segments: [{ text: "hi" }] }));
    const buildAnnouncementTextFn = vi.fn(async () => "This is HARD FORK. Ep.");
    const renderIntroFn = vi.fn(async () => null);
    const convertFn = vi.fn(async ({ dest, introPath }) => {
      expect(introPath).toBeNull();
      fs.writeFileSync(dest, Buffer.from("converted video no intro"));
      return { bytes: 24, durationSec: 60, fromCache: false };
    });

    const res = await runSync({
      devicePath, cacheDir,
      queue: [announceItem({ ext: "mp4" })],
      transcribeFn, buildAnnouncementTextFn, renderIntroFn, convertFn,
      onEvent: () => {},
    });

    expect(res.ok).toBe(true);
    expect(convertFn).toHaveBeenCalledOnce();
    expect(fs.readFileSync(path.join(devicePath, "01_hardfork.mp3")).toString()).toBe("converted video no intro");
  });

  it("an intro is produced but the front-concat convert fails: original episode still ships, batch continues", async () => {
    // The intro WAV renders fine, but the front-concat re-encode (ffmpeg) blows
    // up. Because the episode is a plain speed-1.0 mp3, the only reason it was
    // being re-encoded at all was the intro - so on convert failure we degrade
    // to shipping the original un-introd episode. No real audio may be lost and
    // the ffmpeg outage must not throw into the pipeline.
    const epPayload = Buffer.from("real episode audio that must survive");
    fs.writeFileSync(path.join(cacheDir, "a.mp3"), epPayload);
    // A second plain episode after it to prove the batch continues.
    const bPayload = Buffer.from("second episode audio");
    fs.writeFileSync(path.join(cacheDir, "b.mp3"), bPayload);

    const transcribeFn = vi.fn(async () => ({ segments: [{ text: "hi" }] }));
    const buildAnnouncementTextFn = vi.fn(async () => "This is HARD FORK. Ep.");
    const renderIntroFn = vi.fn(async ({ outPath }) => {
      fs.writeFileSync(outPath, Buffer.from("intro wav"));
      return outPath;
    });
    const convertFn = vi.fn(async ({ introPath }) => {
      expect(introPath).toBe(path.join(cacheDir, "a.intro.wav"));
      throw new Error("front-concat ffmpeg crashed");
    });

    const events = [];
    const res = await runSync({
      devicePath, cacheDir,
      queue: [
        announceItem(),
        makeItem({ uuid: "b", show: "RADIOLAB", slot: 2, ext: "mp3", filename: "02_radiolab.mp3" }),
      ],
      transcribeFn, buildAnnouncementTextFn, renderIntroFn, convertFn,
      onEvent: (e) => events.push(e),
    });

    expect(res.ok).toBe(true);
    expect(convertFn).toHaveBeenCalledOnce();
    // The original (un-introd) audio is what reaches the device, not the intro mix.
    expect(fs.readFileSync(path.join(devicePath, "01_hardfork.mp3")).equals(epPayload)).toBe(true);
    // The rest of the batch still ships.
    expect(fs.readFileSync(path.join(devicePath, "02_radiolab.mp3")).equals(bPayload)).toBe(true);
    // The episode is reported as skipped once the intro mix failed.
    const ann = events.filter((e) => e.type === "announce" && e.uuid === "a").map((e) => e.state);
    expect(ann).toEqual(["analysing", "ready", "skipped"]);
    // No convert error event escaped - the failure was degraded, not propagated.
    expect(events.some((e) => e.stage === "convert" && e.state === "error")).toBe(false);
  });

  it("intro'd VIDEO episode whose front-concat fails retries WITHOUT introPath and the batch continues", async () => {
    // Regression for the over-narrow degrade path: previously a convert failure
    // for a video (needs-encode) intro'd episode rethrew and aborted the whole
    // batch. Required behaviour: retry the normal conversion without the intro;
    // that retry succeeds, the episode ships intro-less, and the batch carries on.
    fs.writeFileSync(path.join(cacheDir, "a.mp4"), Buffer.from("video bytes"));
    const bPayload = Buffer.from("second episode audio");
    fs.writeFileSync(path.join(cacheDir, "b.mp3"), bPayload);

    const transcribeFn = vi.fn(async () => ({ segments: [{ text: "hi" }] }));
    const buildAnnouncementTextFn = vi.fn(async () => "This is HARD FORK. Ep.");
    const renderIntroFn = vi.fn(async ({ outPath }) => {
      fs.writeFileSync(outPath, Buffer.from("intro wav"));
      return outPath;
    });
    const convertFn = vi.fn(async ({ introPath, dest }) => {
      if (introPath) throw new Error("front-concat ffmpeg crashed");
      // Retry without the intro re-encodes the video to a playable mp3.
      fs.writeFileSync(dest, Buffer.from("video converted no intro"));
      return { bytes: 24, durationSec: 60, fromCache: false };
    });

    const events = [];
    const res = await runSync({
      devicePath, cacheDir,
      queue: [
        announceItem({ ext: "mp4" }),
        makeItem({ uuid: "b", show: "RADIOLAB", slot: 2, ext: "mp3", filename: "02_radiolab.mp3" }),
      ],
      transcribeFn, buildAnnouncementTextFn, renderIntroFn, convertFn,
      onEvent: (e) => events.push(e),
    });

    expect(res.ok).toBe(true);
    // Two convert calls: the intro attempt (threw) and the intro-less retry.
    expect(convertFn).toHaveBeenCalledTimes(2);
    expect(fs.readFileSync(path.join(devicePath, "01_hardfork.mp3")).toString()).toBe("video converted no intro");
    expect(fs.readFileSync(path.join(devicePath, "02_radiolab.mp3")).equals(bPayload)).toBe(true);
    const ann = events.filter((e) => e.type === "announce" && e.uuid === "a").map((e) => e.state);
    expect(ann).toEqual(["analysing", "ready", "skipped"]);
    expect(events.some((e) => e.stage === "convert" && e.state === "error")).toBe(false);
  });

  it("intro'd SPEED/BOOST episode whose front-concat fails retries WITHOUT introPath and ships sped audio", async () => {
    // Same degrade requirement for a needs-encode mp3 (speed/boost on): the
    // first convert (with intro) fails, the retry without intro succeeds and the
    // sped/boosted episode still ships - intro dropped, audio preserved.
    fs.writeFileSync(path.join(cacheDir, "a.mp3"), Buffer.from("episode audio"));

    const transcribeFn = vi.fn(async () => ({ segments: [{ text: "hi" }] }));
    const buildAnnouncementTextFn = vi.fn(async () => "This is HARD FORK. Ep.");
    const renderIntroFn = vi.fn(async ({ outPath }) => {
      fs.writeFileSync(outPath, Buffer.from("intro wav"));
      return outPath;
    });
    const convertFn = vi.fn(async ({ introPath, dest, speed, boost }) => {
      if (introPath) throw new Error("front-concat ffmpeg crashed");
      expect(speed).toBeCloseTo(1.5, 3);
      expect(boost).toBe(true);
      fs.writeFileSync(dest, Buffer.from("sped boosted no intro"));
      return { bytes: 20, durationSec: 60, fromCache: false };
    });

    const events = [];
    const res = await runSync({
      devicePath, cacheDir,
      queue: [announceItem()],
      speed: 1.5, boost: true,
      transcribeFn, buildAnnouncementTextFn, renderIntroFn, convertFn,
      onEvent: (e) => events.push(e),
    });

    expect(res.ok).toBe(true);
    expect(convertFn).toHaveBeenCalledTimes(2);
    expect(fs.readFileSync(path.join(devicePath, "01_hardfork.mp3")).toString()).toBe("sped boosted no intro");
    const ann = events.filter((e) => e.type === "announce" && e.uuid === "a").map((e) => e.state);
    expect(ann).toEqual(["analysing", "ready", "skipped"]);
    expect(events.some((e) => e.stage === "convert" && e.state === "error")).toBe(false);
  });

  it("a GENUINE conversion failure (intro-less retry also fails) still surfaces as a failure", async () => {
    // Degradation must not swallow real failures: when the retry without the
    // intro ALSO throws, the batch fails - that is a true conversion error, not
    // an intro problem.
    fs.writeFileSync(path.join(cacheDir, "a.mp4"), Buffer.from("video bytes"));

    const transcribeFn = vi.fn(async () => ({ segments: [{ text: "hi" }] }));
    const buildAnnouncementTextFn = vi.fn(async () => "This is HARD FORK. Ep.");
    const renderIntroFn = vi.fn(async ({ outPath }) => {
      fs.writeFileSync(outPath, Buffer.from("intro wav"));
      return outPath;
    });
    const convertFn = vi.fn(async ({ introPath }) => {
      if (introPath) throw new Error("front-concat ffmpeg crashed");
      throw new Error("codec missing - genuine failure");
    });

    const events = [];
    await expect(runSync({
      devicePath, cacheDir,
      queue: [announceItem({ ext: "mp4" })],
      transcribeFn, buildAnnouncementTextFn, renderIntroFn, convertFn,
      onEvent: (e) => events.push(e),
    })).rejects.toThrow(/genuine failure/i);

    expect(convertFn).toHaveBeenCalledTimes(2);
    expect(events.some((e) => e.stage === "convert" && e.state === "error")).toBe(true);
  });

  it("announce-off path is unchanged: no announce events, no intro deps invoked, plain copy", async () => {
    const payload = Buffer.from("pristine mp3");
    fs.writeFileSync(path.join(cacheDir, "a.mp3"), payload);

    const transcribeFn = vi.fn();
    const renderIntroFn = vi.fn();
    const convertFn = vi.fn();

    const events = [];
    await runSync({
      devicePath, cacheDir,
      queue: [makeItem({ uuid: "a", show: "HARD FORK", slot: 1, ext: "mp3", filename: "01_hardfork.mp3" })],
      transcribeFn, renderIntroFn, convertFn, speed: 1.0,
      onEvent: (e) => events.push(e),
    });

    expect(transcribeFn).not.toHaveBeenCalled();
    expect(renderIntroFn).not.toHaveBeenCalled();
    expect(convertFn).not.toHaveBeenCalled();
    expect(events.some((e) => e.type === "announce")).toBe(false);
    expect(events.some((e) => e.type === "stage" && e.stage === "announce")).toBe(false);
    expect(fs.readFileSync(path.join(devicePath, "01_hardfork.mp3")).equals(payload)).toBe(true);
  });
});

describe("adToCut positional intro/outro handling", () => {
  // A realistic ~30-min episode: a leading interstitial, a deep mid-roll, then a
  // trailing sign-off. The blocks are far enough apart that EDGE_SNAP_SEC only
  // catches the genuine edge cases.
  const segments = [
    { start: 5, end: 30, text: "leading" },   // near the start
    { start: 900, end: 1000, text: "midroll" }, // deep in the middle
    { start: 1780, end: 1800, text: "signoff" }, // near the end
  ];
  // Episode spans 5..1800.

  it("snaps a leading ad block back to 0 (sweeps the pre-roll gap) and labels it intro", () => {
    // Detector placed the ad starting at 5s (the first segment) - the edge snap
    // pulls the cut back to 0 so the unframed pre-roll is swept too.
    const cut = adToCut({ ad: { startSec: 5, endSec: 30, needsReview: false, reasons: [] }, segments });
    expect(cut.startSec).toBe(0);
    expect(cut.endSec).toBe(30);
    expect(cut.label).toContain("intro");
  });

  it("extends a trailing ad block to the episode end and labels it outro", () => {
    const cut = adToCut({ ad: { startSec: 1780, endSec: 1795, needsReview: false, reasons: [] }, segments });
    expect(cut.startSec).toBe(1780);
    expect(cut.endSec).toBe(1800);
    expect(cut.label).toContain("outro");
  });

  it("leaves a deep mid-roll ad untouched and labels it ad", () => {
    const cut = adToCut({ ad: { startSec: 900, endSec: 1000, needsReview: false, reasons: [] }, segments });
    expect(cut.startSec).toBe(900);
    expect(cut.endSec).toBe(1000);
    expect(cut.label).toBe("ad");
  });

  it("preserves the needsReview flag from the detector", () => {
    const cut = adToCut({ ad: { startSec: 900, endSec: 1300, needsReview: true, reasons: ["over-threshold"] }, segments });
    expect(cut.needsReview).toBe(true);
    // The detector's reason is preserved; the post-snap guard also fires here (the
    // 400s span > 360s hard cap) and appends its own reason - union, never dropped.
    expect(cut.reasons).toContain("over-threshold");
    expect(cut.reasons).toContain("post-snap-hard-cap");
  });

  // The post-edge-snap hard cap (GPT-5 guard spec) holds ANY final cut > 360s for
  // review, independent of detector mode and sensitivity, even a clean mid-roll the
  // detector did not flag. A short cut that the edge-snap GROWS by > 15s is held too.
  it("holds a clean >360s mid-roll for review via the post-snap hard cap", () => {
    const cut = adToCut({ ad: { startSec: 900, endSec: 1300, needsReview: false, reasons: [] }, segments });
    expect(cut.needsReview).toBe(true);
    expect(cut.reasons).toContain("post-snap-hard-cap");
    // The boundaries themselves are untouched - we only flag, never re-cut here.
    expect(cut.startSec).toBe(900);
    expect(cut.endSec).toBe(1300);
  });

  it("leaves a clean <=360s mid-roll auto-applyable (within both caps -> not newly flagged)", () => {
    const cut = adToCut({ ad: { startSec: 900, endSec: 1000, needsReview: false, reasons: [] }, segments });
    expect(cut.needsReview).toBe(false);
    expect(cut.reasons).toEqual([]);
    expect(cut.label).toBe("ad");
  });

  it("holds a short cut that the edge-snap grows by > 15s (snap-growth guard)", () => {
    // A 5s block ending 40s before the episode end (1800), but within EDGE_SNAP_SEC
    // (45s) of it: the trailing edge-snap extends it to 1800, growing it from 5s to
    // 40s (35s growth, > 15s) -> held for review.
    const cut = adToCut({ ad: { startSec: 1760, endSec: 1765, needsReview: false, reasons: [] }, segments });
    expect(cut.endSec).toBe(1800); // snapped to the episode end
    expect(cut.needsReview).toBe(true);
    expect(cut.reasons).toContain("edge-snap-growth");
  });
});

describe("adToCut cut-provenance passthrough (Slice 1)", () => {
  const segments = [
    { start: 5, end: 30, text: "leading" },
    { start: 900, end: 1000, text: "midroll" },
    { start: 1780, end: 1800, text: "signoff" },
  ];

  it("passes the detector's verbatim quotes straight through (additive)", () => {
    const cut = adToCut({
      ad: {
        startSec: 900, endSec: 1000, needsReview: false, reasons: [],
        firstLineQuote: "Brought to you by Acme.", lastLineQuote: "Visit acme dot com.",
      },
      segments,
    });
    expect(cut.firstLineQuote).toBe("Brought to you by Acme.");
    expect(cut.lastLineQuote).toBe("Visit acme dot com.");
    // The cut-shape fields are unchanged - quotes are additive only.
    expect(cut.startSec).toBe(900);
    expect(cut.endSec).toBe(1000);
    expect(cut.label).toBe("ad");
    expect(cut.needsReview).toBe(false);
  });

  it("leaves quotes undefined when the ad carried none (e.g. a reused cut-set range)", () => {
    const cut = adToCut({ ad: { startSec: 900, endSec: 1000, needsReview: false, reasons: [] }, segments });
    expect(cut.firstLineQuote).toBeUndefined();
    expect(cut.lastLineQuote).toBeUndefined();
  });
});

describe("assignCutIds (Slice 1) - stable, order-independent cut ids", () => {
  it("stamps every cut with a stable 8-char base id derived from start/end/label", () => {
    const cuts = [
      { startSec: 0, endSec: 30, label: "intro" },
      { startSec: 900, endSec: 1000, label: "ad" },
    ];
    const out = assignCutIds(cuts);
    expect(out).toHaveLength(2);
    for (const c of out) expect(c.cutId).toMatch(/^[0-9a-f]{8}$/);
    // Distinct identities -> distinct ids.
    expect(out[0].cutId).not.toBe(out[1].cutId);
  });

  it("does not mutate the input cuts (returns new objects)", () => {
    const cuts = [{ startSec: 0, endSec: 30, label: "intro" }];
    const out = assignCutIds(cuts);
    expect("cutId" in cuts[0]).toBe(false);
    expect(out[0]).not.toBe(cuts[0]);
  });

  it("is stable across re-runs AND independent of array order", () => {
    const a = [
      { startSec: 0, endSec: 30, label: "intro" },
      { startSec: 900, endSec: 1000, label: "ad" },
      { startSec: 1780, endSec: 1800, label: "outro" },
    ];
    // The same proposal in a SHUFFLED array order.
    const b = [a[2], a[0], a[1]];
    const ra = assignCutIds(a);
    const rb = assignCutIds(b);
    // Build identity -> id maps; the id for a given identity must match regardless
    // of the array order it was presented in.
    const idFor = (out) => Object.fromEntries(out.map((c) => [`${c.startSec}-${c.endSec}-${c.label}`, c.cutId]));
    expect(idFor(rb)).toEqual(idFor(ra));
  });

  it("collision path: identical-duplicate cuts get unique, suffixed ids (never collide)", () => {
    // Two genuinely identical cuts (same identity AND same provenance) in one episode.
    // They are indistinguishable, so WHICH one gets the bare id is immaterial - the
    // guarantee here is only that they do NOT collide to the same id. (Order-
    // independence of the id->cut MAPPING, where the cuts differ, is proven in the
    // next test; it cannot be proven with indistinguishable duplicates.)
    const out = assignCutIds([
      { startSec: 100, endSec: 200, label: "ad" },
      { startSec: 100, endSec: 200, label: "ad" },
      { startSec: 50, endSec: 80, label: "ad" }, // earlier start, distinct identity
    ]);
    const ids = out.map((c) => c.cutId);
    expect(new Set(ids).size).toBe(3); // all unique - no collision
    // The two duplicates: one bare base, one "-2" suffix.
    const base = ids[0].replace(/-\d+$/, "");
    expect(ids[0]).toBe(base);
    expect(ids[1]).toBe(`${base}-2`);
  });

  it("collision with DIFFERENT provenance: the id->cut mapping survives array reversal", () => {
    // Two cuts sharing start|end|label but with DIFFERENT provenance (quotes). The
    // bare id vs the -2 suffix must follow the cut's CONTENT, not its array position:
    // reversing the input must NOT swap which logical cut owns the bare id.
    const a = [
      { startSec: 100, endSec: 200, label: "ad", firstLineQuote: "Alpha opener.", lastLineQuote: "Alpha closer.", reasons: [], needsReview: false },
      { startSec: 100, endSec: 200, label: "ad", firstLineQuote: "Bravo opener.", lastLineQuote: "Bravo closer.", reasons: [], needsReview: false },
    ];
    const idByQuote = (out) => Object.fromEntries(out.map((c) => [c.firstLineQuote, c.cutId]));
    const forward = idByQuote(assignCutIds(a));
    const reversed = idByQuote(assignCutIds([a[1], a[0]]));
    // Same logical cut (keyed by its quote) gets the SAME id in both orders.
    expect(reversed).toEqual(forward);
    // And the two are genuinely distinguished (one bare, one suffixed).
    expect(new Set(Object.values(forward)).size).toBe(2);
  });
});

describe("generateCuts", () => {
  it("returns ready with cuts when the detector finds clean ads", async () => {
    // A clean mid-roll within the 45s hard cap (and far from the episode edges, so
    // no edge-snap) auto-applies -> status ready.
    const transcribeFn = vi.fn(async () => ({ segments: [
      { start: 0, end: 10, text: "intro" },
      { start: 600, end: 630, text: "ad" },
      { start: 700, end: 1300, text: "content" },
    ] }));
    const detectAdsFn = vi.fn(async ({ transcript }) => {
      expect(transcript).toBeTruthy();
      return { ads: [{ startIndex: 1, endIndex: 1, startSec: 600, endSec: 630, needsReview: false, reasons: [] }], stats: {} };
    });
    const out = await generateCuts({ src: "/x.mp3", transcribeFn, detectAdsFn });
    expect(out.status).toBe("ready");
    expect(out.cuts).toHaveLength(1);
    expect(out.cuts[0].startSec).toBe(600);
  });

  it("Slice 1: threads cutId + the detector's verbatim quotes onto the final cuts", async () => {
    const transcribeFn = vi.fn(async () => ({ segments: [
      { start: 0, end: 10, text: "intro" },
      { start: 600, end: 630, text: "ad" },
      { start: 700, end: 1300, text: "content" },
    ] }));
    const detectAdsFn = vi.fn(async () => ({
      ads: [{
        startIndex: 1, endIndex: 1, startSec: 600, endSec: 630, needsReview: false, reasons: [],
        firstLineQuote: "Brought to you by Acme.", lastLineQuote: "Visit acme dot com.",
      }],
      stats: {},
    }));
    const out = await generateCuts({ src: "/x.mp3", transcribeFn, detectAdsFn });
    expect(out.cuts).toHaveLength(1);
    expect(out.cuts[0].cutId).toMatch(/^[0-9a-f]{8}$/);
    expect(out.cuts[0].firstLineQuote).toBe("Brought to you by Acme.");
    expect(out.cuts[0].lastLineQuote).toBe("Visit acme dot com.");
    // Cardinal-additive: the boundaries and flag are exactly what the detector
    // proposed (this mid-roll is far from the edges, so no edge-snap).
    expect(out.cuts[0].startSec).toBe(600);
    expect(out.cuts[0].endSec).toBe(630);
    expect(out.cuts[0].needsReview).toBe(false);
  });

  it("returns needs-review status when any cut is flagged", async () => {
    const transcribeFn = vi.fn(async () => ({ segments: [{ start: 600, end: 700, text: "ad" }, { start: 700, end: 1300, text: "x" }] }));
    const detectAdsFn = vi.fn(async () => ({ ads: [{ startSec: 600, endSec: 700, needsReview: true, reasons: ["ambiguous-boundary"] }], stats: {} }));
    const out = await generateCuts({ src: "/x.mp3", transcribeFn, detectAdsFn });
    expect(out.status).toBe("needs-review");
    expect(out.cuts[0].needsReview).toBe(true);
  });

  it("degrades to skipped when transcribe throws", async () => {
    const transcribeFn = vi.fn(async () => { throw new Error("diarize crashed"); });
    const detectAdsFn = vi.fn();
    const out = await generateCuts({ src: "/x.mp3", transcribeFn, detectAdsFn });
    expect(out.status).toBe("skipped");
    expect(out.cuts).toEqual([]);
    expect(detectAdsFn).not.toHaveBeenCalled();
  });

  it("degrades to skipped when the detector throws", async () => {
    const transcribeFn = vi.fn(async () => ({ segments: [{ start: 0, end: 10, text: "hi" }] }));
    const detectAdsFn = vi.fn(async () => { throw new Error("LM Studio down"); });
    const out = await generateCuts({ src: "/x.mp3", transcribeFn, detectAdsFn });
    expect(out.status).toBe("skipped");
    expect(out.cuts).toEqual([]);
  });

  // P4a model-picker threading: the user-picked model id must reach the detector.
  it("threads the picked model id into the detector", async () => {
    const transcribeFn = vi.fn(async () => ({ segments: [{ start: 0, end: 10, text: "hi" }] }));
    const detectAdsFn = vi.fn(async ({ model }) => {
      expect(model).toBe("qwen/qwen3-14b");
      return { ads: [], stats: {} };
    });
    await generateCuts({ src: "/x.mp3", transcribeFn, detectAdsFn, model: "qwen/qwen3-14b" });
    expect(detectAdsFn).toHaveBeenCalledOnce();
  });

  // When no model is picked we must NOT pass an explicit model - the detector
  // falls back to its own LOCKED LMSTUDIO_MODEL default unchanged.
  it("does not pass a model when none is picked (detector keeps its locked default)", async () => {
    const transcribeFn = vi.fn(async () => ({ segments: [{ start: 0, end: 10, text: "hi" }] }));
    const detectAdsFn = vi.fn(async (args) => {
      expect("model" in args).toBe(false);
      return { ads: [], stats: {} };
    });
    await generateCuts({ src: "/x.mp3", transcribeFn, detectAdsFn });
    expect(detectAdsFn).toHaveBeenCalledOnce();
  });

  // Detector mode threading: the shipped pipeline must ALWAYS pass an explicit
  // mode, so a stray OSW_DETECTOR_MODE env can never flip production to gepa.
  it("calls the detector with an explicit mode 'legacy' by default", async () => {
    const transcribeFn = vi.fn(async () => ({ segments: [{ start: 0, end: 10, text: "hi" }] }));
    const detectAdsFn = vi.fn(async ({ mode }) => {
      expect(mode).toBe("legacy");
      return { ads: [], stats: {} };
    });
    await generateCuts({ src: "/x.mp3", transcribeFn, detectAdsFn });
    expect(detectAdsFn).toHaveBeenCalledOnce();
  });

  it("threads an explicit detectorMode:'gepa' through to the detector (Phase 2 head-to-head)", async () => {
    const transcribeFn = vi.fn(async () => ({ segments: [{ start: 0, end: 10, text: "hi" }] }));
    const detectAdsFn = vi.fn(async ({ mode }) => {
      expect(mode).toBe("gepa");
      return { ads: [], stats: {} };
    });
    await generateCuts({ src: "/x.mp3", transcribeFn, detectAdsFn, detectorMode: "gepa" });
    expect(detectAdsFn).toHaveBeenCalledOnce();
  });

  // P4b sensitivity threading: the user-picked threshold must reach the detector.
  it("threads the sensitivity threshold into the detector", async () => {
    const transcribeFn = vi.fn(async () => ({ segments: [{ start: 0, end: 10, text: "hi" }] }));
    const detectAdsFn = vi.fn(async ({ needsReviewMaxSec }) => {
      expect(needsReviewMaxSec).toBe(90);
      return { ads: [], stats: {} };
    });
    await generateCuts({ src: "/x.mp3", transcribeFn, detectAdsFn, needsReviewMaxSec: 90 });
    expect(detectAdsFn).toHaveBeenCalledOnce();
  });

  // No sensitivity picked -> do NOT pass an explicit threshold so the detector
  // falls back to its own LOCKED NEEDS_REVIEW_MAX_SEC default.
  it("does not pass a threshold when none is picked (detector keeps its locked default)", async () => {
    const transcribeFn = vi.fn(async () => ({ segments: [{ start: 0, end: 10, text: "hi" }] }));
    const detectAdsFn = vi.fn(async (args) => {
      expect("needsReviewMaxSec" in args).toBe(false);
      return { ads: [], stats: {} };
    });
    await generateCuts({ src: "/x.mp3", transcribeFn, detectAdsFn });
    expect(detectAdsFn).toHaveBeenCalledOnce();
  });

  // A non-positive / non-finite threshold must NOT be forwarded - it would be
  // meaningless and the detector default must take over instead.
  it("ignores a non-positive / non-finite threshold (falls back to detector default)", async () => {
    const transcribeFn = vi.fn(async () => ({ segments: [{ start: 0, end: 10, text: "hi" }] }));
    for (const bad of [0, -5, NaN, Infinity]) {
      const detectAdsFn = vi.fn(async (args) => {
        expect("needsReviewMaxSec" in args).toBe(false);
        return { ads: [], stats: {} };
      });
      // eslint-disable-next-line no-await-in-loop
      await generateCuts({ src: "/x.mp3", transcribeFn, detectAdsFn, needsReviewMaxSec: bad });
      expect(detectAdsFn).toHaveBeenCalledOnce();
    }
  });
});

describe("degradeFromStats (Slice 2) - distil the detector's failure bookkeeping", () => {
  it("clean run -> not degraded, zero counts", () => {
    expect(degradeFromStats({ windowsRun: 4, windowsFailed: 0, degraded: false }))
      .toEqual({ degraded: false, windowsFailed: 0, windowsRun: 4 });
  });

  it("a failed window -> degraded with the counts carried", () => {
    expect(degradeFromStats({ windowsRun: 6, windowsFailed: 2, degraded: true }))
      .toEqual({ degraded: true, windowsFailed: 2, windowsRun: 6 });
  });

  it("treats a positive failure count as degraded even if the flag is missing", () => {
    // Defence in depth: the warning must never be dropped because a derived flag was absent.
    expect(degradeFromStats({ windowsRun: 3, windowsFailed: 1 }).degraded).toBe(true);
  });

  it("a missing / garbage stats object -> not degraded, zero counts", () => {
    expect(degradeFromStats(undefined)).toEqual({ degraded: false, windowsFailed: 0, windowsRun: 0 });
    expect(degradeFromStats(null)).toEqual({ degraded: false, windowsFailed: 0, windowsRun: 0 });
    expect(degradeFromStats({})).toEqual({ degraded: false, windowsFailed: 0, windowsRun: 0 });
    expect(degradeFromStats({ windowsFailed: -1, windowsRun: "x" }))
      .toEqual({ degraded: false, windowsFailed: 0, windowsRun: 0 });
  });
});

describe("generateCuts degraded propagation (Slice 2)", () => {
  it("carries the detector's degraded signal onto the result (cuts present)", async () => {
    const transcribeFn = vi.fn(async () => ({ segments: [
      { start: 0, end: 10, text: "intro" },
      { start: 600, end: 630, text: "ad" },
      { start: 700, end: 1300, text: "content" },
    ] }));
    const detectAdsFn = vi.fn(async () => ({
      ads: [{ startIndex: 1, endIndex: 1, startSec: 600, endSec: 630, needsReview: false, reasons: [] }],
      stats: { windowsRun: 5, windowsFailed: 2, failureReasons: { timeout: 2 }, degraded: true },
    }));
    const out = await generateCuts({ src: "/x.mp3", transcribeFn, detectAdsFn });
    expect(out.degrade).toEqual({ degraded: true, windowsFailed: 2, windowsRun: 5 });
    // Cardinal-additive: the cut is exactly what the detector proposed; degrade is metadata.
    expect(out.cuts).toHaveLength(1);
    expect(out.cuts[0].startSec).toBe(600);
  });

  it("a degraded ZERO-cut run still carries the degrade signal (the silent-clean case)", async () => {
    // Every window failed -> no ads -> would look clean. The degrade signal is what
    // lets the gate surface it instead of silently skipping.
    const transcribeFn = vi.fn(async () => ({ segments: [{ start: 0, end: 10, text: "hi" }] }));
    const detectAdsFn = vi.fn(async () => ({
      ads: [],
      stats: { windowsRun: 3, windowsFailed: 3, failureReasons: { "context-exceeded": 3 }, degraded: true },
    }));
    const out = await generateCuts({ src: "/x.mp3", transcribeFn, detectAdsFn });
    expect(out.status).toBe("ready");
    expect(out.cuts).toEqual([]);
    expect(out.degrade).toEqual({ degraded: true, windowsFailed: 3, windowsRun: 3 });
  });

  it("a clean run carries a not-degraded signal", async () => {
    const transcribeFn = vi.fn(async () => ({ segments: [{ start: 0, end: 10, text: "hi" }] }));
    const detectAdsFn = vi.fn(async () => ({ ads: [], stats: { windowsRun: 2, windowsFailed: 0, degraded: false } }));
    const out = await generateCuts({ src: "/x.mp3", transcribeFn, detectAdsFn });
    expect(out.degrade.degraded).toBe(false);
  });
});

describe("generateCuts decision-cache reuse (P3c)", () => {
  // A flagged mid-roll the detector keeps surfacing. Without a cached decision it
  // should always come back needs-review.
  // A genuine mid-roll: content surrounds the ad on both sides AND the episode
  // edges are far away, so adToCut leaves the [600,700] boundaries unchanged and
  // the cut key is the predictable "600000-700000".
  function flaggedSetup() {
    const transcribeFn = vi.fn(async () => ({ segments: [
      { start: 0, end: 590, text: "opening content" },
      { start: 600, end: 700, text: "ad" },
      { start: 700, end: 3000, text: "more content" },
    ] }));
    const detectAdsFn = vi.fn(async () => ({
      ads: [{ startSec: 600, endSec: 700, needsReview: true, reasons: ["over-threshold"] }],
      stats: {},
    }));
    return { transcribeFn, detectAdsFn };
  }

  it("cache miss flags normally (no recorded decision -> needs-review)", async () => {
    const { transcribeFn, detectAdsFn } = flaggedSetup();
    const readDecisionsFn = vi.fn(async () => ({})); // empty cache
    const out = await generateCuts({ src: "/x.mp3", transcribeFn, detectAdsFn, readDecisionsFn });
    expect(out.status).toBe("needs-review");
    expect(out.cuts).toHaveLength(1);
    expect(out.cuts[0].needsReview).toBe(true);
  });

  it("a cached REMOVE decision is reused: the cut auto-applies and is NOT re-flagged", async () => {
    const { transcribeFn, detectAdsFn } = flaggedSetup();
    const readDecisionsFn = vi.fn(async () => ({ "600000-700000": "remove" }));
    const out = await generateCuts({ src: "/x.mp3", transcribeFn, detectAdsFn, readDecisionsFn });
    expect(readDecisionsFn).toHaveBeenCalledWith({ src: "/x.mp3" });
    expect(out.status).toBe("ready"); // no longer needs review
    expect(out.cuts).toHaveLength(1);
    expect(out.cuts[0].needsReview).toBe(false);
  });

  it("a cached KEEP decision is reused: the cut is dropped, never re-flagged", async () => {
    const { transcribeFn, detectAdsFn } = flaggedSetup();
    const readDecisionsFn = vi.fn(async () => ({ "600000-700000": "keep" }));
    const out = await generateCuts({ src: "/x.mp3", transcribeFn, detectAdsFn, readDecisionsFn });
    expect(out.status).toBe("ready");
    expect(out.cuts).toEqual([]);
  });

  it("tolerates a corrupt/throwing decision cache: flags normally, never throws", async () => {
    const { transcribeFn, detectAdsFn } = flaggedSetup();
    const readDecisionsFn = vi.fn(async () => { throw new Error("corrupt sidecar"); });
    const out = await generateCuts({ src: "/x.mp3", transcribeFn, detectAdsFn, readDecisionsFn });
    expect(out.status).toBe("needs-review");
    expect(out.cuts[0].needsReview).toBe(true);
  });

  it("uses the real decisionCache default when no readDecisionsFn injected (cache miss path)", async () => {
    const { transcribeFn, detectAdsFn } = flaggedSetup();
    // No sidecar on disk for /does/not/exist.mp3 -> real readDecisions returns {}.
    const out = await generateCuts({ src: "/does/not/exist.mp3", transcribeFn, detectAdsFn });
    expect(out.status).toBe("needs-review");
  });

  it("a cached ADJUSTED remove re-applies at the user-adjusted boundaries, not the detector's", async () => {
    // The user approved this removal only after nudging it from 600-700 to 615-690.
    // On re-process the detector still proposes 600-700; the cut that auto-applies
    // (and ultimately reaches the converter) must be the adjusted 615-690 range, so
    // we never trim the audio the user explicitly excluded (cardinal rule).
    const { transcribeFn, detectAdsFn } = flaggedSetup();
    const readDecisionsFn = vi.fn(async () => ({
      "600000-700000": { action: "remove", startSec: 615, endSec: 690 },
    }));
    const out = await generateCuts({ src: "/x.mp3", transcribeFn, detectAdsFn, readDecisionsFn });
    expect(out.status).toBe("ready");
    expect(out.cuts).toHaveLength(1);
    expect(out.cuts[0].needsReview).toBe(false);
    expect(out.cuts[0].startSec).toBe(615);
    expect(out.cuts[0].endSec).toBe(690);
  });

  it("a MALFORMED cached adjusted-remove leaves the cut flagged (never auto-applied at the detector's wider range) - cardinal rule", async () => {
    // The cache holds a corrupt adjusted-remove (inverted boundaries). The user
    // only approved a removal at the narrowed range; we must NOT fall back to the
    // detector's original 600-700 and auto-cut it. The unusable decision is ignored,
    // so the cut keeps needs-review and is re-asked rather than trimming excluded audio.
    const { transcribeFn, detectAdsFn } = flaggedSetup();
    const readDecisionsFn = vi.fn(async () => ({
      "600000-700000": { action: "remove", startSec: 690, endSec: 615 },
    }));
    const out = await generateCuts({ src: "/x.mp3", transcribeFn, detectAdsFn, readDecisionsFn });
    expect(out.status).toBe("needs-review");
    expect(out.cuts).toHaveLength(1);
    expect(out.cuts[0].needsReview).toBe(true);
    expect(out.cuts[0].startSec).toBe(600);
    expect(out.cuts[0].endSec).toBe(700);
  });
});

describe("generateCuts explicit cut-set reuse (Fix 3 - reviewed selection sticks across re-process)", () => {
  function setup() {
    const transcribeFn = vi.fn(async () => ({ segments: [
      { start: 0, end: 590, text: "opening content" },
      { start: 600, end: 700, text: "ad" },
      { start: 700, end: 3000, text: "more content" },
    ] }));
    // Detector proposes a flagged mid-roll; the saved cut-set should OVERRIDE it.
    const detectAdsFn = vi.fn(async () => ({
      ads: [{ startSec: 600, endSec: 700, needsReview: true, reasons: ["over-threshold"] }],
      stats: {},
    }));
    return { transcribeFn, detectAdsFn };
  }

  it("a saved cut-set REPLACES the detector's cuts with exactly those ranges (auto-apply)", async () => {
    const { transcribeFn, detectAdsFn } = setup();
    // The user reviewed and chose [615,690] (narrower than the detected [600,700]).
    const readCutSetFn = vi.fn(async () => [[615, 690]]);
    const out = await generateCuts({ src: "/x.mp3", transcribeFn, detectAdsFn, readCutSetFn });
    expect(readCutSetFn).toHaveBeenCalledWith({ src: "/x.mp3" });
    expect(out.status).toBe("ready");
    expect(out.cuts).toHaveLength(1);
    expect(out.cuts[0].startSec).toBe(615);
    expect(out.cuts[0].endSec).toBe(690);
    expect(out.cuts[0].needsReview).toBe(false);
  });

  it("CARDINAL: an EMPTY saved cut-set means cut NOTHING (the user de-selected everything)", async () => {
    const { transcribeFn, detectAdsFn } = setup();
    const readCutSetFn = vi.fn(async () => []); // reviewed: cut nothing
    const out = await generateCuts({ src: "/x.mp3", transcribeFn, detectAdsFn, readCutSetFn });
    expect(out.status).toBe("ready");
    expect(out.cuts).toEqual([]);
  });

  it("replays a user-ADDED range the detector never proposed", async () => {
    const { transcribeFn, detectAdsFn } = setup();
    // A range unrelated to the detected [600,700] - the user added it in the transcript.
    const readCutSetFn = vi.fn(async () => [[10, 55]]);
    const out = await generateCuts({ src: "/x.mp3", transcribeFn, detectAdsFn, readCutSetFn });
    expect(out.cuts).toHaveLength(1);
    expect(out.cuts[0].startSec).toBe(10);
    expect(out.cuts[0].endSec).toBe(55);
  });

  it("the cut-set takes PRECEDENCE over a legacy decision map", async () => {
    const { transcribeFn, detectAdsFn } = setup();
    const readCutSetFn = vi.fn(async () => [[615, 690]]);
    const readDecisionsFn = vi.fn(async () => ({ "600000-700000": "remove" })); // legacy says full range
    const out = await generateCuts({ src: "/x.mp3", transcribeFn, detectAdsFn, readCutSetFn, readDecisionsFn });
    // Cut-set wins: the narrowed range, not the detector's full 600-700. A stable
    // cutId is the ONLY new field (Slice 1, additive). Lock the old shape EXACTLY by
    // stripping just cutId and asserting the rest is byte-for-byte the pre-slice shape
    // - so an unrelated extra/mutated field cannot slip through the additive guarantee.
    expect(out.cuts).toHaveLength(1);
    expect(out.cuts[0].cutId).toMatch(/^[0-9a-f]{8}$/);
    const { cutId: _id, ...rest } = out.cuts[0];
    expect(rest).toEqual({ startSec: 615, endSec: 690, needsReview: false, reasons: [], label: "ad", decided: "remove" });
    // The legacy decision path is not even consulted when a cut-set exists.
    expect(readDecisionsFn).not.toHaveBeenCalled();
  });

  it("no saved cut-set (readCutSet null) falls back to the detector + legacy decision path", async () => {
    const { transcribeFn, detectAdsFn } = setup();
    const readCutSetFn = vi.fn(async () => null); // never reviewed
    const readDecisionsFn = vi.fn(async () => ({})); // empty legacy cache
    const out = await generateCuts({ src: "/x.mp3", transcribeFn, detectAdsFn, readCutSetFn, readDecisionsFn });
    // Falls back -> the detector's flagged cut surfaces as before.
    expect(out.status).toBe("needs-review");
    expect(out.cuts).toHaveLength(1);
    expect(out.cuts[0].needsReview).toBe(true);
    expect(readDecisionsFn).toHaveBeenCalled();
  });

  it("tolerates a throwing readCutSet: falls back to the legacy path, never throws", async () => {
    const { transcribeFn, detectAdsFn } = setup();
    const readCutSetFn = vi.fn(async () => { throw new Error("corrupt cutset sidecar"); });
    const readDecisionsFn = vi.fn(async () => ({}));
    const out = await generateCuts({ src: "/x.mp3", transcribeFn, detectAdsFn, readCutSetFn, readDecisionsFn });
    expect(out.status).toBe("needs-review");
    expect(out.cuts[0].needsReview).toBe(true);
  });
});

describe("runSync trim stage", () => {
  let devicePath, cacheDir;

  beforeEach(() => {
    devicePath = mkTmp("os-device-");
    cacheDir = mkTmp("os-cache-");
  });
  afterEach(() => { rmTmp(devicePath); rmTmp(cacheDir); });

  function trimItem(over = {}) {
    return { ...makeItem({ uuid: "a", show: "HARD FORK", slot: 1, ext: "mp3", filename: "01_hardfork.mp3" }), trim: true, ...over };
  }

  it("trim-on happy path: a confident cut is SURFACED for review and applied once approved", async () => {
    fs.writeFileSync(path.join(cacheDir, "a.mp3"), Buffer.from("episode audio"));

    const transcribeFn = vi.fn(async ({ src }) => {
      expect(src).toBe(path.join(cacheDir, "a.mp3"));
      return { segments: [
        { start: 0, end: 10, text: "hello" },
        { start: 600, end: 640, text: "this ad" },
        { start: 700, end: 1300, text: "back to it" },
      ] };
    });
    // A clean 40s mid-roll. Under the redesign it is SURFACED (confident cuts start
    // pre-yellow) and the user keeps it - resolved as the explicit cut-set [600,640].
    const detectAdsFn = vi.fn(async () => ({
      ads: [{ startIndex: 1, endIndex: 1, startSec: 600, endSec: 640, needsReview: false, reasons: [] }],
      stats: {},
    }));
    const convertFn = vi.fn(async ({ src, dest, cuts }) => {
      expect(src).toBe(path.join(cacheDir, "a.mp3"));
      expect(cuts).toEqual([[600, 640]]);
      fs.writeFileSync(dest, Buffer.from("trimmed mp3"));
      return { bytes: 11, durationSec: 60, fromCache: false };
    });
    // The gate now fires for ANY episode with cuts (confident OR flagged). The user
    // keeps the pre-yellow confident cut -> explicit cut-set.
    let gateSawItems = null;
    const awaitReview = vi.fn(async (items) => { gateSawItems = items; return { a: { __cutSet: [[600, 640]] } }; });

    const events = [];
    const res = await runSync({
      devicePath, cacheDir, queue: [trimItem()],
      transcribeFn, detectAdsFn, convertFn, awaitReview,
      onEvent: (e) => events.push(e),
    });

    expect(res.ok).toBe(true);
    expect(detectAdsFn).toHaveBeenCalledOnce();
    // The confident episode was surfaced for review (the redesign's whole point).
    expect(awaitReview).toHaveBeenCalledOnce();
    expect(gateSawItems[0].uuid).toBe("a");
    expect(convertFn).toHaveBeenCalledOnce();
    expect(fs.readFileSync(path.join(devicePath, "01_hardfork.mp3")).toString()).toBe("trimmed mp3");

    const trimStates = events.filter((e) => e.type === "trim" && e.uuid === "a").map((e) => e.state);
    // analyse-stage ready, then the gate re-emits ready after resolving the cut-set.
    expect(trimStates).toEqual(["analysing", "ready", "ready"]);
    const stagesDone = events.filter((e) => e.type === "stage" && e.state === "done").map((e) => e.stage);
    expect(stagesDone).toContain("trim");
    expect(stagesDone).toContain("review");
  });

  it("a needs-review cut starts GREY and is NOT cut unless the user selects it", async () => {
    fs.writeFileSync(path.join(cacheDir, "a.mp3"), Buffer.from("episode audio"));

    const transcribeFn = vi.fn(async () => ({ segments: [
      { start: 0, end: 10, text: "x" },
      { start: 600, end: 640, text: "clean ad" },
      { start: 700, end: 1300, text: "y" },
      { start: 1300, end: 1700, text: "long sketchy ad" },
    ] }));
    // One clean cut (confident -> pre-yellow), one needs-review cut (flagged ->
    // starts GREY). The user keeps the confident one and leaves the flagged one
    // grey, so the explicit cut-set is just the clean cut.
    const detectAdsFn = vi.fn(async () => ({
      ads: [
        { startSec: 600, endSec: 640, needsReview: false, reasons: [] },
        { startSec: 1300, endSec: 1700, needsReview: true, reasons: ["over-threshold"] },
      ],
      stats: {},
    }));
    const convertFn = vi.fn(async ({ dest, cuts }) => {
      // The flagged [1300,1700] cut must NOT be present - only the kept confident one.
      expect(cuts).toEqual([[600, 640]]);
      fs.writeFileSync(dest, Buffer.from("partially trimmed"));
      return { bytes: 17, durationSec: 60, fromCache: false };
    });
    // The gate surfaces both; the resolution keeps only the confident cut.
    const awaitReview = vi.fn(async () => ({ a: { __cutSet: [[600, 640]] } }));

    const events = [];
    const res = await runSync({
      devicePath, cacheDir, queue: [trimItem()],
      transcribeFn, detectAdsFn, convertFn, awaitReview,
      onEvent: (e) => events.push(e),
    });

    expect(res.ok).toBe(true);
    expect(convertFn).toHaveBeenCalledOnce();
    // The episode was surfaced with BOTH cuts (so the review layer shows the flagged
    // one as a grey, opt-in line); the analyse-stage emit carries both.
    const analyseEmit = events.find((e) => e.type === "trim" && e.state === "needs-review");
    expect(analyseEmit).toBeTruthy();
    expect(analyseEmit.cuts).toHaveLength(2);
    expect(analyseEmit.cuts.filter((c) => c.needsReview)).toHaveLength(1);
  });

  it("a detector failure skips the trim but still converts the episode uncut", async () => {
    const payload = Buffer.from("episode audio that must survive");
    fs.writeFileSync(path.join(cacheDir, "a.mp3"), payload);

    const transcribeFn = vi.fn(async () => ({ segments: [{ start: 0, end: 10, text: "hi" }] }));
    const detectAdsFn = vi.fn(async () => { throw new Error("LM Studio unreachable"); });
    // No cuts survive => plain speed-1.0 mp3 => copied straight, converter unused.
    const convertFn = vi.fn();

    const events = [];
    const res = await runSync({
      devicePath, cacheDir, queue: [trimItem()],
      transcribeFn, detectAdsFn, convertFn,
      onEvent: (e) => events.push(e),
    });

    expect(res.ok).toBe(true);
    expect(convertFn).not.toHaveBeenCalled();
    expect(fs.readFileSync(path.join(devicePath, "01_hardfork.mp3")).equals(payload)).toBe(true);
    const trimStates = events.filter((e) => e.type === "trim" && e.uuid === "a").map((e) => e.state);
    expect(trimStates).toEqual(["analysing", "skipped"]);
  });

  it("a transcribe failure skips the trim but still converts the episode uncut", async () => {
    const payload = Buffer.from("episode audio");
    fs.writeFileSync(path.join(cacheDir, "a.mp3"), payload);

    const transcribeFn = vi.fn(async () => { throw new Error("diarize crashed"); });
    const detectAdsFn = vi.fn();
    const convertFn = vi.fn();

    const res = await runSync({
      devicePath, cacheDir, queue: [trimItem()],
      transcribeFn, detectAdsFn, convertFn,
      onEvent: () => {},
    });

    expect(res.ok).toBe(true);
    expect(detectAdsFn).not.toHaveBeenCalled();
    expect(convertFn).not.toHaveBeenCalled();
    expect(fs.readFileSync(path.join(devicePath, "01_hardfork.mp3")).equals(payload)).toBe(true);
  });

  it("the trim convert (atrim) failing degrades to shipping the episode uncut, batch continues", async () => {
    const payload = Buffer.from("real audio must survive a trim failure");
    fs.writeFileSync(path.join(cacheDir, "a.mp3"), payload);
    const bPayload = Buffer.from("second episode");
    fs.writeFileSync(path.join(cacheDir, "b.mp3"), bPayload);

    const transcribeFn = vi.fn(async () => ({ segments: [
      { start: 0, end: 10, text: "x" },
      { start: 600, end: 640, text: "ad" },
      { start: 700, end: 1300, text: "y" },
    ] }));
    // A clean 40s mid-roll (within the hard cap) auto-applies.
    const detectAdsFn = vi.fn(async () => ({
      ads: [{ startSec: 600, endSec: 640, needsReview: false, reasons: [] }],
      stats: {},
    }));
    // First call (with cuts) throws; retry without cuts is a plain speed-1.0 mp3
    // so it never re-enters convertFn (direct copy of the original).
    const convertFn = vi.fn(async ({ cuts }) => {
      if (cuts && cuts.length) throw new Error("atrim ffmpeg crashed");
      throw new Error("should not retry-encode a plain mp3");
    });
    // The confident cut is surfaced and kept by the user -> reaches convert (and hits
    // the atrim-failure degrade path). Episode "b" has no trim, so it is not surfaced.
    const awaitReview = vi.fn(async () => ({ a: { __cutSet: [[600, 640]] } }));

    const events = [];
    const res = await runSync({
      devicePath, cacheDir,
      queue: [
        trimItem(),
        makeItem({ uuid: "b", show: "RADIOLAB", slot: 2, ext: "mp3", filename: "02_radiolab.mp3" }),
      ],
      transcribeFn, detectAdsFn, convertFn, awaitReview,
      onEvent: (e) => events.push(e),
    });

    expect(res.ok).toBe(true);
    expect(convertFn).toHaveBeenCalledOnce();
    // Original untrimmed audio reaches the device.
    expect(fs.readFileSync(path.join(devicePath, "01_hardfork.mp3")).equals(payload)).toBe(true);
    expect(fs.readFileSync(path.join(devicePath, "02_radiolab.mp3")).equals(bPayload)).toBe(true);
    expect(events.some((e) => e.stage === "convert" && e.state === "error")).toBe(false);
    // A trim-skipped event was emitted on the degrade.
    const trimStates = events.filter((e) => e.type === "trim" && e.uuid === "a").map((e) => e.state);
    expect(trimStates).toContain("skipped");
  });

  it("trim-off path is unchanged: no trim events, detector never invoked, plain copy", async () => {
    const payload = Buffer.from("pristine mp3");
    fs.writeFileSync(path.join(cacheDir, "a.mp3"), payload);

    const transcribeFn = vi.fn();
    const detectAdsFn = vi.fn();
    const convertFn = vi.fn();

    const events = [];
    await runSync({
      devicePath, cacheDir,
      queue: [makeItem({ uuid: "a", show: "HARD FORK", slot: 1, ext: "mp3", filename: "01_hardfork.mp3" })],
      transcribeFn, detectAdsFn, convertFn, speed: 1.0,
      onEvent: (e) => events.push(e),
    });

    expect(transcribeFn).not.toHaveBeenCalled();
    expect(detectAdsFn).not.toHaveBeenCalled();
    expect(convertFn).not.toHaveBeenCalled();
    expect(events.some((e) => e.type === "trim")).toBe(false);
    expect(events.some((e) => e.type === "stage" && e.stage === "trim")).toBe(false);
    expect(fs.readFileSync(path.join(devicePath, "01_hardfork.mp3")).equals(payload)).toBe(true);
  });

  it("trim + speed: a clean cut ships, and a converter (atrim) failure still ships sped audio without trims", async () => {
    fs.writeFileSync(path.join(cacheDir, "a.mp3"), Buffer.from("episode audio"));

    const transcribeFn = vi.fn(async () => ({ segments: [
      { start: 0, end: 10, text: "x" },
      { start: 600, end: 640, text: "ad" },
      { start: 700, end: 1300, text: "y" },
    ] }));
    // A clean 40s mid-roll (within the hard cap) auto-applies.
    const detectAdsFn = vi.fn(async () => ({
      ads: [{ startSec: 600, endSec: 640, needsReview: false, reasons: [] }],
      stats: {},
    }));
    const convertFn = vi.fn(async ({ cuts, dest, speed }) => {
      if (cuts && cuts.length) throw new Error("atrim+atempo crashed");
      // Retry without cuts re-encodes (speed on) so the episode still ships.
      expect(speed).toBeCloseTo(1.5, 3);
      fs.writeFileSync(dest, Buffer.from("sped no trim"));
      return { bytes: 12, durationSec: 60, fromCache: false };
    });
    // The confident cut is surfaced and kept -> reaches convert with cuts.
    const awaitReview = vi.fn(async () => ({ a: { __cutSet: [[600, 640]] } }));

    const events = [];
    const res = await runSync({
      devicePath, cacheDir, queue: [trimItem()], speed: 1.5,
      transcribeFn, detectAdsFn, convertFn, awaitReview,
      onEvent: (e) => events.push(e),
    });

    expect(res.ok).toBe(true);
    expect(convertFn).toHaveBeenCalledTimes(2);
    expect(fs.readFileSync(path.join(devicePath, "01_hardfork.mp3")).toString()).toBe("sped no trim");
    expect(events.some((e) => e.stage === "convert" && e.state === "error")).toBe(false);
  });

  // P4a model-picker threading end-to-end through runSync: the picked model id
  // reaches BOTH the trim detector and the announce summary, without changing
  // the locked detector method.
  it("threads runSync({ model }) into both the detector and the announce summary", async () => {
    fs.writeFileSync(path.join(cacheDir, "a.mp3"), Buffer.from("episode audio"));

    const transcribeFn = vi.fn(async () => ({ segments: [
      { start: 0, end: 10, text: "hello" },
      { start: 600, end: 640, text: "this ad" },
      { start: 700, end: 1300, text: "back to it" },
    ] }));
    // A clean 40s mid-roll (within the 360s post-snap hard cap) auto-applies, so the
    // converter still receives a cut and the model-threading assertion holds.
    const detectAdsFn = vi.fn(async ({ model }) => {
      expect(model).toBe("qwen/qwen3-14b");
      return { ads: [{ startSec: 600, endSec: 640, needsReview: false, reasons: [] }], stats: {} };
    });
    const buildAnnouncementTextFn = vi.fn(async ({ llm }) => {
      expect(llm).toBeTruthy();
      expect(llm.model).toBe("qwen/qwen3-14b");
      return "This is HARD FORK. Ep.";
    });
    const renderIntroFn = vi.fn(async ({ outPath }) => {
      fs.writeFileSync(outPath, Buffer.from("intro wav"));
      return outPath;
    });
    const convertFn = vi.fn(async ({ dest, cuts }) => {
      expect(cuts).toEqual([[600, 640]]);
      fs.writeFileSync(dest, Buffer.from("trimmed mp3"));
      return { bytes: 11, durationSec: 60, fromCache: false };
    });

    const res = await runSync({
      devicePath, cacheDir,
      queue: [trimItem({ announce: true })],
      model: "qwen/qwen3-14b",
      llm: { fetch: () => {} },
      transcribeFn, detectAdsFn, buildAnnouncementTextFn, renderIntroFn, convertFn,
      onEvent: () => {},
    });

    expect(res.ok).toBe(true);
    expect(detectAdsFn).toHaveBeenCalledOnce();
    expect(buildAnnouncementTextFn).toHaveBeenCalledOnce();
  });

  // No model picked: the detector receives no explicit model (locked default
  // stays in force) and the announce llm is left untouched.
  it("leaves the locked default in force when no model is picked", async () => {
    fs.writeFileSync(path.join(cacheDir, "a.mp3"), Buffer.from("episode audio"));

    const transcribeFn = vi.fn(async () => ({ segments: [
      { start: 0, end: 10, text: "hello" },
      { start: 600, end: 700, text: "this ad" },
      { start: 700, end: 1300, text: "back to it" },
    ] }));
    const detectAdsFn = vi.fn(async (args) => {
      expect("model" in args).toBe(false);
      return { ads: [], stats: {} };
    });
    const convertFn = vi.fn(async ({ dest }) => {
      fs.writeFileSync(dest, Buffer.from("uncut"));
      return { bytes: 5, durationSec: 60, fromCache: false };
    });

    const res = await runSync({
      devicePath, cacheDir, queue: [trimItem()],
      transcribeFn, detectAdsFn, convertFn,
      onEvent: () => {},
    });

    expect(res.ok).toBe(true);
    expect(detectAdsFn).toHaveBeenCalledOnce();
  });

  // The shipped pipeline path (runSync, no detectorMode set - as ipc.cjs calls it)
  // must hand the detector an explicit mode 'legacy', so a stray OSW_DETECTOR_MODE
  // env can never flip production to gepa.
  it("runSync calls the detector with mode 'legacy' by default (env can't flip production)", async () => {
    fs.writeFileSync(path.join(cacheDir, "a.mp3"), Buffer.from("episode audio"));
    const transcribeFn = vi.fn(async () => ({ segments: [{ start: 0, end: 10, text: "hi" }] }));
    const detectAdsFn = vi.fn(async ({ mode }) => {
      expect(mode).toBe("legacy");
      return { ads: [], stats: {} };
    });
    const convertFn = vi.fn(async ({ dest }) => { fs.writeFileSync(dest, Buffer.from("uncut")); return { bytes: 5, durationSec: 60, fromCache: false }; });
    const res = await runSync({
      devicePath, cacheDir, queue: [trimItem()],
      transcribeFn, detectAdsFn, convertFn, onEvent: () => {},
    });
    expect(res.ok).toBe(true);
    expect(detectAdsFn).toHaveBeenCalledOnce();
  });

  // --- Review gate (approve-cuts step) ---

  // A mid-roll flagged cut (away from the episode edges so adToCut does not snap
  // it to intro/outro), at a stable [200,380] range -> decision key "200000-380000".
  function flaggedTranscribe() {
    return vi.fn(async () => ({ segments: [
      { start: 0, end: 50, text: "open" },
      { start: 200, end: 380, text: "long sketchy mid-roll" },
      { start: 380, end: 1200, text: "rest of the show" },
    ] }));
  }
  function flaggedDetect() {
    return vi.fn(async () => ({
      ads: [{ startSec: 200, endSec: 380, needsReview: true, reasons: ["over-threshold"] }],
      stats: {},
    }));
  }

  it("holds the pipeline on a flagged cut: emits a review event and awaits the gate", async () => {
    fs.writeFileSync(path.join(cacheDir, "a.mp3"), Buffer.from("episode audio"));
    const convertFn = vi.fn(async ({ dest }) => { fs.writeFileSync(dest, Buffer.from("x")); return { bytes: 1, durationSec: 60, fromCache: false }; });

    let gateSawItems = null;
    const awaitReview = vi.fn(async (items) => { gateSawItems = items; return {}; });

    const events = [];
    await runSync({
      devicePath, cacheDir, queue: [trimItem()],
      transcribeFn: flaggedTranscribe(), detectAdsFn: flaggedDetect(), convertFn,
      awaitReview, onEvent: (e) => events.push(e),
    });

    // The gate ran, and was handed the flagged episode + its cut.
    expect(awaitReview).toHaveBeenCalledOnce();
    expect(gateSawItems).toHaveLength(1);
    expect(gateSawItems[0].uuid).toBe("a");
    expect(gateSawItems[0].cuts.some((c) => c.needsReview)).toBe(true);
    // A review event reached the renderer, bracketed by stage:review active/done.
    const review = events.find((e) => e.type === "review");
    expect(review).toBeTruthy();
    expect(review.items[0].cuts).toHaveLength(1);
    const reviewStages = events.filter((e) => e.type === "stage" && e.stage === "review").map((e) => e.state);
    expect(reviewStages).toEqual(["active", "done"]);
  });

  it("an approved (remove) decision from the gate un-flags the cut and it is applied", async () => {
    fs.writeFileSync(path.join(cacheDir, "a.mp3"), Buffer.from("episode audio"));
    const convertFn = vi.fn(async ({ dest, cuts }) => {
      // The user approved the [200,380] cut at the gate, so it must reach convert.
      expect(cuts).toEqual([[200, 380]]);
      fs.writeFileSync(dest, Buffer.from("trimmed"));
      return { bytes: 7, durationSec: 60, fromCache: false };
    });
    // Approve the flagged cut by its decision key.
    const awaitReview = vi.fn(async () => ({ a: { "200000-380000": "remove" } }));

    const res = await runSync({
      devicePath, cacheDir, queue: [trimItem()],
      transcribeFn: flaggedTranscribe(), detectAdsFn: flaggedDetect(), convertFn,
      awaitReview, onEvent: () => {},
    });

    expect(res.ok).toBe(true);
    expect(convertFn).toHaveBeenCalledOnce();
    expect(fs.readFileSync(path.join(devicePath, "01_hardfork.mp3")).toString()).toBe("trimmed");
  });

  it("an undecided flagged cut stays held back (cardinal rule): nothing is cut", async () => {
    const payload = Buffer.from("episode audio that must survive untouched");
    fs.writeFileSync(path.join(cacheDir, "a.mp3"), payload);
    // No decisions returned -> the flagged cut is held back -> plain mp3 copied,
    // converter never invoked.
    const convertFn = vi.fn();
    const awaitReview = vi.fn(async () => ({}));

    const res = await runSync({
      devicePath, cacheDir, queue: [trimItem()],
      transcribeFn: flaggedTranscribe(), detectAdsFn: flaggedDetect(), convertFn,
      awaitReview, onEvent: () => {},
    });

    expect(res.ok).toBe(true);
    expect(convertFn).not.toHaveBeenCalled();
    expect(fs.readFileSync(path.join(devicePath, "01_hardfork.mp3")).equals(payload)).toBe(true);
  });

  // --- Degraded-detection gate admission (Slice 2, plan decision 8) ---

  // A transcript with NO ads, but detection DEGRADED: every window failed, so it found
  // zero cuts and would look clean. The gate must still surface it with the warning.
  function degradedZeroTranscribe() {
    return vi.fn(async () => ({ segments: [
      { start: 0, end: 50, text: "the whole episode" },
      { start: 50, end: 1200, text: "rest of the show" },
    ] }));
  }
  function degradedZeroDetect() {
    return vi.fn(async () => ({
      ads: [],
      stats: { windowsRun: 4, windowsFailed: 4, failureReasons: { "context-exceeded": 4 }, degraded: true },
    }));
  }

  it("admits a DEGRADED zero-cut episode to the gate (not silently clean)", async () => {
    fs.writeFileSync(path.join(cacheDir, "a.mp3"), Buffer.from("episode audio"));
    const convertFn = vi.fn(async ({ dest }) => { fs.writeFileSync(dest, Buffer.from("x")); return { bytes: 1, durationSec: 60, fromCache: false }; });

    let gateSawItems = null;
    const awaitReview = vi.fn(async (items) => { gateSawItems = items; return {}; });

    const events = [];
    await runSync({
      devicePath, cacheDir, queue: [trimItem()],
      transcribeFn: degradedZeroTranscribe(), detectAdsFn: degradedZeroDetect(), convertFn,
      awaitReview, onEvent: (e) => events.push(e),
    });

    // The gate ran and was handed the degraded episode EVEN THOUGH it has zero cuts.
    expect(awaitReview).toHaveBeenCalledOnce();
    expect(gateSawItems).toHaveLength(1);
    expect(gateSawItems[0].uuid).toBe("a");
    expect(gateSawItems[0].cuts).toEqual([]);
    expect(gateSawItems[0].degrade).toEqual({ degraded: true, windowsFailed: 4, windowsRun: 4 });
    // The review event reached the renderer carrying the degrade signal.
    const review = events.find((e) => e.type === "review");
    expect(review).toBeTruthy();
    expect(review.items[0].degrade.degraded).toBe(true);
  });

  it("CARDINAL: a degraded zero-cut episode commits NO cut (audio survives untouched)", async () => {
    const payload = Buffer.from("episode audio that must survive untouched");
    fs.writeFileSync(path.join(cacheDir, "a.mp3"), payload);
    // A degraded episode with zero cuts is purely informational - the gate surfaces a
    // warning but there is nothing to cut. The convert loop must NOT trim, and the
    // original audio must reach the device byte-identical.
    const convertFn = vi.fn();
    const awaitReview = vi.fn(async () => ({}));

    const res = await runSync({
      devicePath, cacheDir, queue: [trimItem()],
      transcribeFn: degradedZeroTranscribe(), detectAdsFn: degradedZeroDetect(), convertFn,
      awaitReview, onEvent: () => {},
    });

    expect(res.ok).toBe(true);
    // No cuts -> no re-encode -> plain copy; the converter is never invoked.
    expect(convertFn).not.toHaveBeenCalled();
    expect(fs.readFileSync(path.join(devicePath, "01_hardfork.mp3")).equals(payload)).toBe(true);
  });

  it("a CLEAN zero-cut episode is still NOT surfaced (no warning, no panel)", async () => {
    // Regression guard: only DEGRADED zero-cut episodes are admitted. A clean
    // no-ads-found episode must keep skipping the gate entirely (no spurious gate).
    fs.writeFileSync(path.join(cacheDir, "a.mp3"), Buffer.from("clean audio"));
    const cleanTranscribe = vi.fn(async () => ({ segments: [{ start: 0, end: 50, text: "all content" }] }));
    const cleanDetect = vi.fn(async () => ({ ads: [], stats: { windowsRun: 2, windowsFailed: 0, degraded: false } }));
    const awaitReview = vi.fn(async () => ({}));

    const events = [];
    await runSync({
      devicePath, cacheDir, queue: [trimItem()],
      transcribeFn: cleanTranscribe, detectAdsFn: cleanDetect,
      convertFn: vi.fn(), awaitReview, onEvent: (e) => events.push(e),
    });

    // No review gate fired - a clean zero-cut episode has nothing to surface.
    expect(awaitReview).not.toHaveBeenCalled();
    expect(events.find((e) => e.type === "review")).toBeFalsy();
  });

  it("a 'keep' decision drops the cut: nothing is cut even though it was reviewed", async () => {
    const payload = Buffer.from("keep me whole");
    fs.writeFileSync(path.join(cacheDir, "a.mp3"), payload);
    const convertFn = vi.fn();
    const awaitReview = vi.fn(async () => ({ a: { "200000-380000": "keep" } }));

    const res = await runSync({
      devicePath, cacheDir, queue: [trimItem()],
      transcribeFn: flaggedTranscribe(), detectAdsFn: flaggedDetect(), convertFn,
      awaitReview, onEvent: () => {},
    });

    expect(res.ok).toBe(true);
    expect(convertFn).not.toHaveBeenCalled();
    expect(fs.readFileSync(path.join(devicePath, "01_hardfork.mp3")).equals(payload)).toBe(true);
  });

  it("CARDINAL (Fix 1): a confident-only episode is STILL surfaced for review (no silent auto-cut)", async () => {
    fs.writeFileSync(path.join(cacheDir, "a.mp3"), Buffer.from("episode audio"));
    // A confident mid-roll within the 360s hard cap (away from edges). Under the
    // redesign this is NOT cut silently - it is surfaced for review (pre-yellow), and
    // only applied once the user's resolution includes it.
    const transcribeFn = vi.fn(async () => ({ segments: [
      { start: 0, end: 50, text: "open" },
      { start: 200, end: 240, text: "clean mid-roll" },
      { start: 380, end: 1200, text: "rest of the show" },
    ] }));
    const detectAdsFn = vi.fn(async () => ({
      ads: [{ startSec: 200, endSec: 240, needsReview: false, reasons: [] }],
      stats: {},
    }));
    const convertFn = vi.fn(async ({ dest, cuts }) => {
      expect(cuts).toEqual([[200, 240]]);
      fs.writeFileSync(dest, Buffer.from("approved-trim"));
      return { bytes: 12, durationSec: 60, fromCache: false };
    });
    // The gate fires; the user keeps the pre-yellow confident cut.
    const awaitReview = vi.fn(async () => ({ a: { __cutSet: [[200, 240]] } }));

    const events = [];
    const res = await runSync({
      devicePath, cacheDir, queue: [trimItem()],
      transcribeFn, detectAdsFn, convertFn, awaitReview,
      onEvent: (e) => events.push(e),
    });

    expect(res.ok).toBe(true);
    expect(awaitReview).toHaveBeenCalledOnce();
    expect(events.some((e) => e.type === "review")).toBe(true);
    expect(convertFn).toHaveBeenCalledOnce();
  });

  it("CARDINAL (Fix 1): a surfaced confident cut the gate does NOT resolve is NOT cut (fail closed)", async () => {
    const payload = Buffer.from("confident-but-unresolved must survive");
    fs.writeFileSync(path.join(cacheDir, "a.mp3"), payload);
    const transcribeFn = vi.fn(async () => ({ segments: [
      { start: 0, end: 50, text: "open" },
      { start: 200, end: 240, text: "clean mid-roll" },
      { start: 380, end: 1200, text: "rest of the show" },
    ] }));
    const detectAdsFn = vi.fn(async () => ({
      ads: [{ startSec: 200, endSec: 240, needsReview: false, reasons: [] }],
      stats: {},
    }));
    const convertFn = vi.fn();
    // The gate returns NO entry for "a" (a failed/empty gate). The fold fails closed:
    // a surfaced episode with no resolution cuts NOTHING - the confident cut is held.
    const awaitReview = vi.fn(async () => ({}));

    const res = await runSync({
      devicePath, cacheDir, queue: [trimItem()],
      transcribeFn, detectAdsFn, convertFn, awaitReview,
      onEvent: () => {},
    });

    expect(res.ok).toBe(true);
    expect(awaitReview).toHaveBeenCalledOnce();
    expect(convertFn).not.toHaveBeenCalled(); // nothing cut -> plain mp3 copied
    expect(fs.readFileSync(path.join(devicePath, "01_hardfork.mp3")).equals(payload)).toBe(true);
  });

  it("no gate when the episode has NO cuts at all: awaitReview is never called", async () => {
    const payload = Buffer.from("clean episode, nothing detected");
    fs.writeFileSync(path.join(cacheDir, "a.mp3"), payload);
    const transcribeFn = vi.fn(async () => ({ segments: [
      { start: 0, end: 50, text: "open" },
      { start: 200, end: 1200, text: "all content, no ads" },
    ] }));
    const detectAdsFn = vi.fn(async () => ({ ads: [], stats: {} }));
    const convertFn = vi.fn();
    const awaitReview = vi.fn(async () => ({}));

    const events = [];
    const res = await runSync({
      devicePath, cacheDir, queue: [trimItem()],
      transcribeFn, detectAdsFn, convertFn, awaitReview,
      onEvent: (e) => events.push(e),
    });

    expect(res.ok).toBe(true);
    expect(awaitReview).not.toHaveBeenCalled();
    expect(events.some((e) => e.type === "review")).toBe(false);
    expect(convertFn).not.toHaveBeenCalled(); // no cuts -> plain copy
    expect(fs.readFileSync(path.join(devicePath, "01_hardfork.mp3")).equals(payload)).toBe(true);
  });

  it("a cancel during review aborts before convert (cut nothing) via an aborting gate", async () => {
    const payload = Buffer.from("must not be cut on cancel");
    fs.writeFileSync(path.join(cacheDir, "a.mp3"), payload);
    const convertFn = vi.fn();
    const ac = new AbortController();
    // Model the IPC cancel path: the gate resolves with no decisions AND the run
    // is aborted, so the throwIfAborted right after the gate raises.
    const awaitReview = vi.fn(async () => { ac.abort(); return {}; });

    await expect(runSync({
      devicePath, cacheDir, queue: [trimItem()],
      transcribeFn: flaggedTranscribe(), detectAdsFn: flaggedDetect(), convertFn,
      awaitReview, signal: ac.signal, onEvent: () => {},
    })).rejects.toThrow();

    expect(convertFn).not.toHaveBeenCalled();
  });

  // CARDINAL (remove-old relocation): the delete step was MOVED to AFTER the review
  // gate. A cancel at the gate must therefore leave the device's superseded old files
  // INTACT - under the old ordering they were already deleted before the gate, which
  // was the data-loss footgun this reorder fixes.
  it("a cancel at the review gate leaves the device's old files UNTOUCHED (delete runs after the gate)", async () => {
    fs.writeFileSync(path.join(cacheDir, "a.mp3"), Buffer.from("new episode audio"));
    // An old superseded file on the device that the run WOULD delete (different show,
    // so computeRemovals marks it for removal, not replacement).
    const oldFile = path.join(devicePath, "07_oldshow.mp3");
    fs.writeFileSync(oldFile, Buffer.from("yesterday's episode - must survive a cancel"));

    const convertFn = vi.fn();
    const ac = new AbortController();
    // The IPC cancel path: gate resolves with no decisions AND the run aborts.
    const awaitReview = vi.fn(async () => { ac.abort(); return {}; });

    const events = [];
    await expect(runSync({
      devicePath, cacheDir, queue: [trimItem()],
      transcribeFn: flaggedTranscribe(), detectAdsFn: flaggedDetect(), convertFn,
      awaitReview, signal: ac.signal, onEvent: (e) => events.push(e),
    })).rejects.toThrow();

    // The old file is still there - nothing was deleted, because the abort raised
    // before the (now post-gate) delete block ran.
    expect(fs.existsSync(oldFile)).toBe(true);
    expect(fs.readFileSync(oldFile).toString()).toBe("yesterday's episode - must survive a cancel");
    // The delete stage never even started (it is past the gate).
    expect(events.some((e) => e.type === "stage" && e.stage === "delete")).toBe(false);
    expect(convertFn).not.toHaveBeenCalled();
  });

  // The delete runs AFTER the review gate resolves AND after convert (Transferring
  // phase): on an approved run the stage:done ORDER is finalise -> ... -> review ->
  // convert -> delete -> transfer -> verify, never delete-before-review and (slice 1)
  // never delete-before-convert.
  it("on an approved run, delete runs AFTER review AND after convert", async () => {
    fs.writeFileSync(path.join(cacheDir, "a.mp3"), Buffer.from("episode audio"));
    // A superseded device file so a delete stage actually fires.
    fs.writeFileSync(path.join(devicePath, "07_oldshow.mp3"), Buffer.from("stale"));
    const convertFn = vi.fn(async ({ dest }) => { fs.writeFileSync(dest, Buffer.from("trimmed")); return { bytes: 7, durationSec: 60, fromCache: false }; });
    const awaitReview = vi.fn(async () => ({ a: { __cutSet: [[200, 380]] } }));

    const events = [];
    const res = await runSync({
      devicePath, cacheDir, queue: [trimItem()],
      transcribeFn: flaggedTranscribe(), detectAdsFn: flaggedDetect(), convertFn,
      awaitReview, onEvent: (e) => events.push(e),
    });

    expect(res.ok).toBe(true);
    const doneOrder = events.filter((e) => e.type === "stage" && e.state === "done").map((e) => e.stage);
    // review precedes convert, convert precedes delete (the slice-1 ordering invariant).
    expect(doneOrder.indexOf("review")).toBeLessThan(doneOrder.indexOf("convert"));
    expect(doneOrder.indexOf("convert")).toBeLessThan(doneOrder.indexOf("delete"));
    // Slice 4: the device park (waiting-for-device) sits between convert and delete. The
    // device-present default park resolves instantly, so the order is otherwise unchanged.
    expect(doneOrder).toEqual(["finalise", "transcribe", "trim", "review", "convert", "waiting-for-device", "delete", "transfer", "verify"]);
  });

  // --- Slice 1: convert-before-delete (no-device-data-loss on convert failure) ---

  // THE slice-1 regression catcher. Convert runs before delete, so a HARD convert
  // failure (one with no intro/cuts fallback to fall back to) throws with the device's
  // OLD superseded files STILL ON THE DEVICE - nothing was unlinked. If the reorder is
  // reverted (delete-before-convert), delete runs first and this old file is gone by
  // the time convert throws: the device is left wiped with nothing written. This test
  // MUST fail if convert is moved back before delete.
  it("a HARD convert failure leaves the superseded device files INTACT (convert runs before delete)", async () => {
    // A video episode forces a re-encode with no intro/cuts, so there is NO degrade
    // fallback - the convert failure propagates and runSync rejects.
    fs.writeFileSync(path.join(cacheDir, "a.mp4"), Buffer.from("video bytes"));
    // An old superseded file (different show => computeRemovals marks it for removal,
    // not replacement) that a delete-first ordering would already have unlinked.
    const oldFile = path.join(devicePath, "07_oldshow.mp3");
    fs.writeFileSync(oldFile, Buffer.from("yesterday's episode - must survive a convert failure"));

    const convertFn = vi.fn(async () => { throw new Error("ffmpeg blew up"); });

    const events = [];
    await expect(runSync({
      devicePath, cacheDir,
      queue: [makeItem({ uuid: "a", show: "HARD FORK", slot: 1, ext: "mp4", filename: "01_hardfork.mp3" })],
      convertFn, onEvent: (e) => events.push(e),
    })).rejects.toThrow("ffmpeg blew up");

    // The old file survives: convert threw BEFORE the delete block ran.
    expect(fs.existsSync(oldFile)).toBe(true);
    expect(fs.readFileSync(oldFile).toString()).toBe("yesterday's episode - must survive a convert failure");
    // The delete stage never even started (it is past a successful convert).
    expect(events.some((e) => e.type === "stage" && e.stage === "delete")).toBe(false);
    // Convert reached its error state, proving the failure happened in convert.
    expect(events.some((e) => e.stage === "convert" && e.state === "error")).toBe(true);
  });

  // The convert-failure DEGRADE path (intro/cuts dropped, original audio still shipped)
  // is unchanged by the reorder: it still ships untrimmed audio, never unreviewed cuts,
  // AND the superseded old file is correctly removed once convert succeeds via fallback.
  it("convert-failure degrade still ships untrimmed audio and then removes the old file", async () => {
    const epPayload = Buffer.from("real episode audio that must survive");
    fs.writeFileSync(path.join(cacheDir, "a.mp3"), epPayload);
    const oldFile = path.join(devicePath, "07_oldshow.mp3");
    fs.writeFileSync(oldFile, Buffer.from("stale"));

    // A confident cut is surfaced and approved, so convert is asked to trim - but the
    // trim convert throws. Because the episode is a plain speed-1.0 mp3, dropping the
    // cuts means the ORIGINAL untrimmed audio ships (never the unreviewed cut).
    const convertFn = vi.fn(async ({ cuts }) => {
      if (cuts && cuts.length) throw new Error("atrim ffmpeg crashed");
      throw new Error("unexpected re-encode of a plain mp3");
    });
    const awaitReview = vi.fn(async () => ({ a: { __cutSet: [[600, 640]] } }));

    const events = [];
    const res = await runSync({
      devicePath, cacheDir, queue: [trimItem()],
      transcribeFn: flaggedTranscribe(), detectAdsFn: flaggedDetect(), convertFn,
      awaitReview, onEvent: (e) => events.push(e),
    });

    expect(res.ok).toBe(true);
    // The ORIGINAL untrimmed audio reached the device (degrade ships audio, not cuts).
    expect(fs.readFileSync(path.join(devicePath, "01_hardfork.mp3")).equals(epPayload)).toBe(true);
    // No convert error escaped - the failure degraded, not propagated.
    expect(events.some((e) => e.stage === "convert" && e.state === "error")).toBe(false);
    // Convert succeeded via degrade, so delete ran: the old superseded file is gone.
    expect(fs.existsSync(oldFile)).toBe(false);
  });

  // A cancel that fires REENTRANTLY from the delete-stage "active" emit (an onEvent
  // callback that aborts) must still leave the device untouched: the guard sits
  // immediately before each unlink, not only at the loop top. Without that guard the
  // old file would be unlinked despite the abort.
  it("a reentrant cancel from the delete 'active' emit leaves the old file INTACT", async () => {
    fs.writeFileSync(path.join(cacheDir, "a.mp3"), Buffer.from("new episode audio"));
    const oldFile = path.join(devicePath, "07_oldshow.mp3");
    fs.writeFileSync(oldFile, Buffer.from("must survive a reentrant cancel"));

    // Plain mp3, no trim/announce: convert is a no-op copy, so the run reaches delete.
    const convertFn = vi.fn();
    const ac = new AbortController();
    // Abort the moment the delete stage announces itself, BEFORE any unlink.
    const onEvent = (e) => {
      if (e.type === "log" && e.stage === "delete" && e.state === "active") ac.abort();
    };

    await expect(runSync({
      devicePath, cacheDir,
      queue: [makeItem({ uuid: "a", show: "HARD FORK", slot: 1, ext: "mp3", filename: "01_hardfork.mp3" })],
      convertFn, signal: ac.signal, onEvent,
    })).rejects.toThrow();

    // The unlink never happened - the per-iteration guard caught the reentrant abort.
    expect(fs.existsSync(oldFile)).toBe(true);
    expect(fs.readFileSync(oldFile).toString()).toBe("must survive a reentrant cancel");
  });

  // --- Transcript-toggle redesign: the gate may resolve to an EXPLICIT cut-set ---

  it("an explicit __cutSet from the gate REPLACES the cuts and applies exactly those ranges", async () => {
    fs.writeFileSync(path.join(cacheDir, "a.mp3"), Buffer.from("episode audio"));
    const convertFn = vi.fn(async ({ dest, cuts }) => {
      // The user reviewed the transcript and selected [210,300] (a SHRUNK / shifted
      // range, NOT the detector's original [200,380]). Exactly that must be cut.
      expect(cuts).toEqual([[210, 300]]);
      fs.writeFileSync(dest, Buffer.from("toggled"));
      return { bytes: 7, durationSec: 60, fromCache: false };
    });
    const awaitReview = vi.fn(async () => ({ a: { __cutSet: [[210, 300]] } }));

    const res = await runSync({
      devicePath, cacheDir, queue: [trimItem()],
      transcribeFn: flaggedTranscribe(), detectAdsFn: flaggedDetect(), convertFn,
      awaitReview, onEvent: () => {},
    });

    expect(res.ok).toBe(true);
    expect(convertFn).toHaveBeenCalledOnce();
    expect(fs.readFileSync(path.join(devicePath, "01_hardfork.mp3")).toString()).toBe("toggled");
  });

  it("CARDINAL: an EMPTY __cutSet cuts nothing (user de-selected everything)", async () => {
    const payload = Buffer.from("nothing selected, ship whole");
    fs.writeFileSync(path.join(cacheDir, "a.mp3"), payload);
    const convertFn = vi.fn();
    const awaitReview = vi.fn(async () => ({ a: { __cutSet: [] } }));

    const res = await runSync({
      devicePath, cacheDir, queue: [trimItem()],
      transcribeFn: flaggedTranscribe(), detectAdsFn: flaggedDetect(), convertFn,
      awaitReview, onEvent: () => {},
    });

    expect(res.ok).toBe(true);
    expect(convertFn).not.toHaveBeenCalled();
    expect(fs.readFileSync(path.join(devicePath, "01_hardfork.mp3")).equals(payload)).toBe(true);
  });

  it("an explicit __cutSet can EXTEND beyond the detected cut (a range the detector never proposed)", async () => {
    fs.writeFileSync(path.join(cacheDir, "a.mp3"), Buffer.from("episode audio"));
    const convertFn = vi.fn(async ({ dest, cuts }) => {
      // The user added the open sketch [0,50] AND kept the mid-roll [200,380].
      expect(cuts).toEqual([[0, 50], [200, 380]]);
      fs.writeFileSync(dest, Buffer.from("extended"));
      return { bytes: 8, durationSec: 60, fromCache: false };
    });
    const awaitReview = vi.fn(async () => ({ a: { __cutSet: [[0, 50], [200, 380]] } }));

    const res = await runSync({
      devicePath, cacheDir, queue: [trimItem()],
      transcribeFn: flaggedTranscribe(), detectAdsFn: flaggedDetect(), convertFn,
      awaitReview, onEvent: () => {},
    });

    expect(res.ok).toBe(true);
    expect(convertFn).toHaveBeenCalledOnce();
  });
});

describe("resolveEpisodeCuts (legacy map OR explicit cut-set)", () => {
  const flaggedMid = { startSec: 200, endSec: 380, needsReview: true, reasons: ["over-threshold"], label: "ad" };

  it("legacy 'remove' map un-flags the detected cut (auto-applies)", () => {
    const out = resolveEpisodeCuts([flaggedMid], { "200000-380000": "remove" });
    expect(out).toHaveLength(1);
    expect(out[0].needsReview).toBe(false);
  });

  it("legacy 'keep' map drops the cut", () => {
    expect(resolveEpisodeCuts([flaggedMid], { "200000-380000": "keep" })).toEqual([]);
  });

  it("an empty legacy map holds the flagged cut (stays needsReview)", () => {
    const out = resolveEpisodeCuts([flaggedMid], {});
    expect(out[0].needsReview).toBe(true);
  });

  it("an explicit __cutSet REPLACES the cuts with auto-apply ranges", () => {
    const out = resolveEpisodeCuts([flaggedMid], { __cutSet: [[210, 300], [600, 660]] });
    // Each cut carries a stable cutId (Slice 1, additive); strip it and assert the
    // rest of the shape is the exact pre-slice cut-set shape.
    expect(out.map(({ cutId, ...rest }) => rest)).toEqual([
      { startSec: 210, endSec: 300, needsReview: false, reasons: [], label: "ad", decided: "remove" },
      { startSec: 600, endSec: 660, needsReview: false, reasons: [], label: "ad", decided: "remove" },
    ]);
    for (const c of out) expect(c.cutId).toMatch(/^[0-9a-f]{8}$/);
  });

  it("CARDINAL: an explicit __cutSet drops malformed ranges, never widens", () => {
    const out = resolveEpisodeCuts([flaggedMid], { __cutSet: [[300, 210], [400, 400], [500, 560]] });
    expect(out.map(({ cutId, ...rest }) => rest)).toEqual([
      { startSec: 500, endSec: 560, needsReview: false, reasons: [], label: "ad", decided: "remove" },
    ]);
  });

  it("an empty explicit __cutSet yields no cuts (cut nothing)", () => {
    expect(resolveEpisodeCuts([flaggedMid], { __cutSet: [] })).toEqual([]);
  });

  it("Slice 1: a __cutSet cut's cutId is derived from its FINAL (user) boundaries", () => {
    // The id on a cut-set range must match cutId() of THAT range's final start/end/
    // label - not the detector's discarded boundaries. This is what makes the id a
    // faithful handle on the cut the renderer actually shows.
    const out = resolveEpisodeCuts([flaggedMid], { __cutSet: [[210, 300]] });
    expect(out[0].cutId).toBe(cutId(210, 300, "ad"));
    // And it is NOT the id of the detector's original 200-380 range.
    expect(out[0].cutId).not.toBe(cutId(200, 380, "ad"));
  });

  it("Slice 1: an adjusted-remove decision re-derives the cutId at the adjusted boundaries", () => {
    // A legacy adjusted-remove mutates the cut's startSec/endSec; the cutId must be
    // re-stamped to the ADJUSTED boundaries. Seed a STALE pre-adjust id on the input so
    // this proves the OVERWRITE (the Round-3 failure mode: applyDecisions keeps the old
    // id via spread while mutating the boundaries), not merely filling a missing id.
    const stale = { ...flaggedMid, cutId: cutId(200, 380, "ad") };
    const out = resolveEpisodeCuts([stale], {
      "200000-380000": { action: "remove", startSec: 215, endSec: 360 },
    });
    expect(out).toHaveLength(1);
    expect(out[0].startSec).toBe(215);
    expect(out[0].endSec).toBe(360);
    expect(out[0].cutId).toBe(cutId(215, 360, "ad"));
    expect(out[0].cutId).not.toBe(cutId(200, 380, "ad")); // the stale id was overwritten
  });
});

// --- Slice 4: the await-device park (device-decouple CORE) ---
// runSync now PARKS between convert and delete until a validated device is present.
// These tests inject a fake awaitDevice (the park) + a fake validateDeviceFn so they
// are hermetic and assert the cardinal invariants directly.
describe("runSync await-device park (slice 4)", () => {
  let devicePath, cacheDir;
  beforeEach(() => { devicePath = mkTmp("os-device-"); cacheDir = mkTmp("os-cache-"); });
  afterEach(() => { rmTmp(devicePath); rmTmp(cacheDir); });

  function plainItem() {
    return makeItem({ uuid: "a", show: "HARD FORK", slot: 1, ext: "mp3", filename: "01_hardfork.mp3" });
  }

  // DEVICE-PRESENT-UNCHANGED: the default park resolves instantly with the entry
  // devicePath (no watcher, no validate). With it injected as an immediate resolve the
  // run must produce the EXACT same on-device outcome as a pre-slice-4 run.
  it("device present at start (instant resolve) = same outcome as today", async () => {
    const payload = Buffer.from("episode audio that lands on the device");
    fs.writeFileSync(path.join(cacheDir, "a.mp3"), payload);

    const events = [];
    const awaitDevice = vi.fn(async () => ({ ok: true, path: devicePath }));
    const res = await runSync({
      devicePath, cacheDir, queue: [plainItem()],
      convertFn: async () => {}, awaitDevice,
      onEvent: (e) => events.push(e),
    });

    expect(res.ok).toBe(true);
    expect(awaitDevice).toHaveBeenCalledOnce();
    // File transferred + verified + manifest written, byte-identical to a plain copy.
    expect(fs.readFileSync(path.join(devicePath, "01_hardfork.mp3")).equals(payload)).toBe(true);
    expect(fs.existsSync(path.join(devicePath, MANIFEST_FILE))).toBe(true);
    expect(res.transferred).toHaveLength(1);
    expect(res.transferred[0].fname).toBe("01_hardfork.mp3");
    // The park's waiting-for-device stage fired and resolved; the plan came AFTER it.
    const stagesDone = events.filter((e) => e.type === "stage" && e.state === "done").map((e) => e.stage);
    expect(stagesDone).toEqual(["finalise", "convert", "waiting-for-device", "delete", "transfer", "verify"]);
    const planIdx = events.findIndex((e) => e.type === "plan");
    const waitDoneIdx = events.findIndex((e) => e.type === "stage" && e.stage === "waiting-for-device" && e.state === "done");
    expect(planIdx).toBeGreaterThan(waitDoneIdx);
  });

  // A device-free `prepared` summary + waiting-for-device active emit BEFORE the park
  // blocks, so the UI (slice 5) can render the parked state.
  it("emits a device-free prepared summary and waiting-for-device:active before parking", async () => {
    fs.writeFileSync(path.join(cacheDir, "a.mp3"), Buffer.from("audio"));
    const events = [];
    // The park resolves only once we let it; capture the events emitted up to that point.
    let release;
    const gate = new Promise((r) => { release = r; });
    const awaitDevice = vi.fn(async () => { await gate; return { ok: true, path: devicePath }; });

    const run = runSync({
      devicePath, cacheDir, queue: [plainItem()],
      convertFn: async () => {}, awaitDevice,
      onEvent: (e) => events.push(e),
    });
    // Let the microtasks up to the park settle.
    await Promise.resolve(); await Promise.resolve();
    const prepared = events.find((e) => e.type === "prepared");
    expect(prepared).toBeTruthy();
    expect(prepared.items).toEqual([{ uuid: "a", title: "Ep", show: "HARD FORK", slot: 1, filename: "01_hardfork.mp3" }]);
    expect(events.some((e) => e.type === "stage" && e.stage === "waiting-for-device" && e.state === "active")).toBe(true);
    // No device IO yet: no plan, no delete stage.
    expect(events.some((e) => e.type === "plan")).toBe(false);
    expect(events.some((e) => e.type === "stage" && e.stage === "delete")).toBe(false);
    release();
    await run;
  });

  // DEVICE-ABSENT-THEN-ATTACH: the park resolves LATER (simulated attach) and the run
  // then proceeds to a full successful transfer against the resolved path.
  it("device absent then attach: parks, then proceeds on a simulated attach", async () => {
    const payload = Buffer.from("waited for the headphones");
    fs.writeFileSync(path.join(cacheDir, "a.mp3"), payload);

    // The device only becomes usable when the fake park resolves (deferred).
    let attach;
    const attached = new Promise((r) => { attach = r; });
    const awaitDevice = vi.fn(async () => { await attached; return { ok: true, path: devicePath }; });

    const events = [];
    const run = runSync({
      devicePath, cacheDir, queue: [plainItem()],
      convertFn: async () => {}, awaitDevice,
      onEvent: (e) => events.push(e),
    });
    await Promise.resolve(); await Promise.resolve();
    // Still parked: nothing written.
    expect(fs.existsSync(path.join(devicePath, "01_hardfork.mp3"))).toBe(false);
    // Simulate the attach.
    attach();
    const res = await run;
    expect(res.ok).toBe(true);
    expect(fs.readFileSync(path.join(devicePath, "01_hardfork.mp3")).equals(payload)).toBe(true);
  });

  // CANCEL-WHILE-PARKED-NO-IO: a cancel during the park does NO device IO (no readdir
  // of the device for the plan, no unlink, no copy) and leaves the device untouched.
  // This fails if throwIfAborted() is not placed immediately after the park resolves.
  it("cancel while parked does NO device IO and leaves the device untouched", async () => {
    fs.writeFileSync(path.join(cacheDir, "a.mp3"), Buffer.from("audio"));
    // Pre-existing device contents that must be untouched by a cancelled run.
    const oldFile = path.join(devicePath, "07_oldshow.mp3");
    fs.writeFileSync(oldFile, Buffer.from("must survive a cancel-while-parked"));

    const ctrl = new AbortController();
    // The park: settle (as cancelSync would, not-ok) AFTER the abort fires, mirroring the
    // IPC cancel order (resolve the parked promise, then abort).
    const awaitDevice = vi.fn(async () => {
      ctrl.abort();
      return { ok: false, reason: "cancelled" };
    });
    const copyFn = vi.fn();
    const validateDeviceFn = vi.fn(async (p) => ({ ok: true, path: p }));

    await expect(runSync({
      devicePath, cacheDir, queue: [plainItem()],
      convertFn: async () => {}, copyFn, awaitDevice, validateDeviceFn,
      signal: ctrl.signal, onEvent: () => {},
    })).rejects.toMatchObject({ name: "AbortError" });

    // No device IO at all past the park: revalidate was never called, no copy, the old
    // file is intact, no new file, no manifest.
    expect(validateDeviceFn).not.toHaveBeenCalled();
    expect(copyFn).not.toHaveBeenCalled();
    expect(fs.readFileSync(oldFile).toString()).toBe("must survive a cancel-while-parked");
    const remaining = fs.readdirSync(devicePath);
    expect(remaining).toEqual(["07_oldshow.mp3"]);
    expect(remaining).not.toContain(MANIFEST_FILE);
  });

  // The waiting-for-device stage must be CLOSED on a cancel (not left active in the
  // event stream): a terminal `cancelled` state fires, and `done` never does.
  it("a cancel-while-parked closes the waiting-for-device stage (cancelled, not done)", async () => {
    fs.writeFileSync(path.join(cacheDir, "a.mp3"), Buffer.from("audio"));
    const ctrl = new AbortController();
    const awaitDevice = vi.fn(async () => { ctrl.abort(); return { ok: false, reason: "cancelled" }; });
    const events = [];
    await expect(runSync({
      devicePath, cacheDir, queue: [plainItem()],
      convertFn: async () => {}, awaitDevice, signal: ctrl.signal,
      onEvent: (e) => events.push(e),
    })).rejects.toMatchObject({ name: "AbortError" });
    const waitStates = events.filter((e) => e.type === "stage" && e.stage === "waiting-for-device").map((e) => e.state);
    expect(waitStates).toContain("active");
    expect(waitStates).toContain("cancelled");
    expect(waitStates).not.toContain("done");
  });

  // The plan (and the device read it is built from) runs ONLY after the park resolves,
  // against the freshly-resolved path - never a stale entry path.
  it("buildPlan / plan event runs only AFTER the device resolves, against the resolved path", async () => {
    fs.writeFileSync(path.join(cacheDir, "a.mp3"), Buffer.from("audio"));
    // The park resolves to a DIFFERENT directory than the entry devicePath; the plan +
    // the transfer must use the RESOLVED dir.
    const resolvedDir = mkTmp("os-resolved-");
    try {
      fs.writeFileSync(path.join(resolvedDir, "07_oldshow.mp3"), Buffer.from("stale on the real device"));
      const events = [];
      const awaitDevice = vi.fn(async () => ({ ok: true, path: resolvedDir }));
      const res = await runSync({
        devicePath, cacheDir, queue: [plainItem()],
        convertFn: async () => {}, awaitDevice,
        onEvent: (e) => events.push(e),
      });
      expect(res.ok).toBe(true);
      // The plan's delete entry reflects the RESOLVED dir's contents (07_oldshow.mp3),
      // proving the device was read fresh at attach time, not the empty entry dir.
      const planEvent = events.find((e) => e.type === "plan");
      expect(planEvent.plan.some((p) => p.stage === "delete" && /07_oldshow\.mp3/.test(p.text))).toBe(true);
      // The file landed on the RESOLVED dir, and the entry dir was never written to.
      expect(fs.existsSync(path.join(resolvedDir, "01_hardfork.mp3"))).toBe(true);
      expect(fs.existsSync(path.join(devicePath, "01_hardfork.mp3"))).toBe(false);
    } finally { rmTmp(resolvedDir); }
  });

  // REVALIDATE-FAILS-CLOSED: if the device vanishes/goes not-ready between the park
  // resolving and the delete, the revalidate fails closed and NOTHING is unlinked. This
  // fails if the revalidate-before-delete guard is removed.
  it("revalidate fails closed: a device that goes not-ready after attach is NOT written/deleted", async () => {
    fs.writeFileSync(path.join(cacheDir, "a.mp3"), Buffer.from("audio"));
    const oldFile = path.join(devicePath, "07_oldshow.mp3");
    fs.writeFileSync(oldFile, Buffer.from("must survive a failed revalidate"));

    const awaitDevice = vi.fn(async () => ({ ok: true, path: devicePath }));
    // The device was valid at attach but is not-ready now (e.g. swapped/yanked).
    const validateDeviceFn = vi.fn(async () => ({ ok: false, reason: "missing-marker" }));
    const copyFn = vi.fn();

    await expect(runSync({
      devicePath, cacheDir, queue: [plainItem()],
      convertFn: async () => {}, copyFn, awaitDevice, validateDeviceFn,
      onEvent: () => {},
    })).rejects.toThrow(/revalidate failed/i);

    // Nothing unlinked, nothing copied, no manifest - the device is untouched.
    expect(copyFn).not.toHaveBeenCalled();
    expect(fs.readFileSync(oldFile).toString()).toBe("must survive a failed revalidate");
    expect(fs.existsSync(path.join(devicePath, MANIFEST_FILE))).toBe(false);
  });

  // A not-available park resolution (no device, no real park) fails the run closed
  // rather than hanging or writing.
  it("a not-available device resolution fails the run closed", async () => {
    fs.writeFileSync(path.join(cacheDir, "a.mp3"), Buffer.from("audio"));
    const awaitDevice = vi.fn(async () => ({ ok: false, reason: "no-device" }));
    await expect(runSync({
      devicePath, cacheDir, queue: [plainItem()],
      convertFn: async () => {}, awaitDevice, onEvent: () => {},
    })).rejects.toThrow(/device not available/i);
    expect(fs.existsSync(path.join(devicePath, "01_hardfork.mp3"))).toBe(false);
  });

  // With NO devicePath and NO injected park, runSync fails closed (does not hang) - the
  // default awaitDevice resolves not-ok.
  it("with no devicePath and no injected park, the run fails closed (does not hang)", async () => {
    fs.writeFileSync(path.join(cacheDir, "a.mp3"), Buffer.from("audio"));
    await expect(runSync({
      cacheDir, queue: [plainItem()],
      convertFn: async () => {}, onEvent: () => {},
    })).rejects.toThrow(/device not available|no-device/i);
  });
});
