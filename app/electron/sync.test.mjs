import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { createRequire } from "node:module";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";

const require = createRequire(import.meta.url);
const { runSync, isOurFilename, sha256File, buildPlan, itemNeedsEncode, readManifest, writeManifest, MANIFEST_FILE, generateCuts, adToCut, EDGE_SNAP_SEC, generateIntro, INTRO_PIPELINE_VERSION } = require("./sync.cjs");

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
    expect(stages).toEqual(["finalise", "delete", "convert", "transfer", "verify"]);
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
    const cut = adToCut({ ad: { startSec: 900, endSec: 1000, needsReview: true, reasons: ["over-threshold"] }, segments });
    expect(cut.needsReview).toBe(true);
    // The detector's reason is preserved; the post-snap guard also fires here (the
    // 100s span > 45s hard cap) and appends its own reason - union, never dropped.
    expect(cut.reasons).toContain("over-threshold");
    expect(cut.reasons).toContain("post-snap-hard-cap");
  });

  // The post-edge-snap hard cap (GPT-5 guard spec) holds ANY final cut > 45s for
  // review, independent of detector mode and sensitivity, even a clean mid-roll the
  // detector did not flag. A short cut that the edge-snap GROWS by > 15s is held too.
  it("holds a clean >45s mid-roll for review via the post-snap hard cap", () => {
    const cut = adToCut({ ad: { startSec: 900, endSec: 1000, needsReview: false, reasons: [] }, segments });
    expect(cut.needsReview).toBe(true);
    expect(cut.reasons).toContain("post-snap-hard-cap");
    // The boundaries themselves are untouched - we only flag, never re-cut here.
    expect(cut.startSec).toBe(900);
    expect(cut.endSec).toBe(1000);
  });

  it("leaves a clean <=45s mid-roll auto-applyable (within both caps -> not newly flagged)", () => {
    const cut = adToCut({ ad: { startSec: 900, endSec: 930, needsReview: false, reasons: [] }, segments });
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

  it("trim-on happy path: applies clean cuts and converts with cuts passed through", async () => {
    fs.writeFileSync(path.join(cacheDir, "a.mp3"), Buffer.from("episode audio"));

    const transcribeFn = vi.fn(async ({ src }) => {
      expect(src).toBe(path.join(cacheDir, "a.mp3"));
      return { segments: [
        { start: 0, end: 10, text: "hello" },
        { start: 600, end: 640, text: "this ad" },
        { start: 700, end: 1300, text: "back to it" },
      ] };
    });
    // A clean 40s mid-roll (within the 45s hard cap, away from edges) auto-applies.
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

    const events = [];
    const res = await runSync({
      devicePath, cacheDir, queue: [trimItem()],
      transcribeFn, detectAdsFn, convertFn,
      onEvent: (e) => events.push(e),
    });

    expect(res.ok).toBe(true);
    expect(detectAdsFn).toHaveBeenCalledOnce();
    expect(convertFn).toHaveBeenCalledOnce();
    expect(fs.readFileSync(path.join(devicePath, "01_hardfork.mp3")).toString()).toBe("trimmed mp3");

    const trimStates = events.filter((e) => e.type === "trim" && e.uuid === "a").map((e) => e.state);
    expect(trimStates).toEqual(["analysing", "ready"]);
    const stagesDone = events.filter((e) => e.type === "stage" && e.state === "done").map((e) => e.stage);
    expect(stagesDone).toContain("trim");
  });

  it("a needs-review cut is HELD BACK from the converter (never auto-applied)", async () => {
    fs.writeFileSync(path.join(cacheDir, "a.mp3"), Buffer.from("episode audio"));

    const transcribeFn = vi.fn(async () => ({ segments: [
      { start: 0, end: 10, text: "x" },
      { start: 600, end: 640, text: "clean ad" },
      { start: 700, end: 1300, text: "y" },
      { start: 1300, end: 1700, text: "long sketchy ad" },
    ] }));
    // One clean cut (40s, within the hard cap), one needs-review cut. Only the clean
    // one may reach convert; the flagged 400s mid-roll is held back.
    const detectAdsFn = vi.fn(async () => ({
      ads: [
        { startSec: 600, endSec: 640, needsReview: false, reasons: [] },
        { startSec: 1300, endSec: 1700, needsReview: true, reasons: ["over-threshold"] },
      ],
      stats: {},
    }));
    const convertFn = vi.fn(async ({ dest, cuts }) => {
      // The needs-review [1300,1700] cut must NOT be present.
      expect(cuts).toEqual([[600, 640]]);
      fs.writeFileSync(dest, Buffer.from("partially trimmed"));
      return { bytes: 17, durationSec: 60, fromCache: false };
    });

    const events = [];
    const res = await runSync({
      devicePath, cacheDir, queue: [trimItem()],
      transcribeFn, detectAdsFn, convertFn,
      onEvent: (e) => events.push(e),
    });

    expect(res.ok).toBe(true);
    expect(convertFn).toHaveBeenCalledOnce();
    // The emitted cut list still carries BOTH cuts (so the review layer can show
    // the held-back one), but only the clean one was auto-applied above.
    const trimReady = events.find((e) => e.type === "trim" && e.state === "needs-review");
    expect(trimReady).toBeTruthy();
    expect(trimReady.cuts).toHaveLength(2);
    expect(trimReady.cuts.filter((c) => c.needsReview)).toHaveLength(1);
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

    const events = [];
    const res = await runSync({
      devicePath, cacheDir,
      queue: [
        trimItem(),
        makeItem({ uuid: "b", show: "RADIOLAB", slot: 2, ext: "mp3", filename: "02_radiolab.mp3" }),
      ],
      transcribeFn, detectAdsFn, convertFn,
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

    const events = [];
    const res = await runSync({
      devicePath, cacheDir, queue: [trimItem()], speed: 1.5,
      transcribeFn, detectAdsFn, convertFn,
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
    // A clean 40s mid-roll (within the 45s post-snap hard cap) auto-applies, so the
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

  it("no gate when every cut is confident: awaitReview is never called", async () => {
    fs.writeFileSync(path.join(cacheDir, "a.mp3"), Buffer.from("episode audio"));
    // A confident mid-roll within the 45s hard cap (and away from edges, so no
    // edge-snap) -> nothing flagged -> the review gate is skipped entirely.
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
      fs.writeFileSync(dest, Buffer.from("auto-trimmed"));
      return { bytes: 12, durationSec: 60, fromCache: false };
    });
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
    expect(convertFn).toHaveBeenCalledOnce();
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
});
