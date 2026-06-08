import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { createRequire } from "node:module";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";

const require = createRequire(import.meta.url);
const { runSync, isOurFilename, sha256File, buildPlan, itemNeedsEncode, readManifest, writeManifest, MANIFEST_FILE } = require("./sync.cjs");

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
