import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { createRequire } from "node:module";
import { EventEmitter, PassThrough } from "node:stream";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";

const require = createRequire(import.meta.url);
const { convert, parseDuration, parseTime } = require("./converter.cjs");

function mkTmp() { return fs.mkdtempSync(path.join(os.tmpdir(), "os-conv-")); }
function rmTmp(d) { try { fs.rmSync(d, { recursive: true, force: true }); } catch {} }

function makeFakeChild() {
  const child = new EventEmitter();
  child.stdout = new PassThrough();
  child.stderr = new PassThrough();
  child.kill = vi.fn();
  return child;
}

function fakeSpawn(program) {
  const calls = [];
  const spawn = (cmd, args) => {
    const child = makeFakeChild();
    calls.push({ cmd, args, child });
    setTimeout(() => program(child, { cmd, args }), 0);
    return child;
  };
  return { spawn, calls };
}

describe("converter parsers", () => {
  it("parseDuration pulls HH:MM:SS.xx out of ffmpeg stderr", () => {
    const stderr = "Input #0, mov,mp4,m4a,3gp\n  Duration: 01:23:45.67, start: 0.000000";
    expect(parseDuration(stderr)).toBeCloseTo(3600 + 23 * 60 + 45.67, 2);
  });

  it("parseTime extracts time= from a stderr progress line", () => {
    expect(parseTime("size=100kB time=00:02:30.50 bitrate=128 speed=2x")).toBeCloseTo(150.5, 2);
    expect(parseTime("no time in here")).toBe(null);
  });
});

describe("convert()", () => {
  let tmp;
  beforeEach(() => { tmp = mkTmp(); });
  afterEach(() => rmTmp(tmp));

  it("spawns ffmpeg with the expected audio-extraction args and atomically renames on success", async () => {
    const src = path.join(tmp, "ep.mp4");
    const dest = path.join(tmp, "ep.mp3");
    fs.writeFileSync(src, "pretend this is a video");

    const { spawn, calls } = fakeSpawn((child) => {
      child.stderr.write("Input #0\n  Duration: 00:00:10.00, start: 0\n");
      const outPath = calls[0].args.at(-1);
      fs.writeFileSync(outPath, "pretend mp3 bytes");
      child.emit("exit", 0);
    });

    const result = await convert({ src, dest, ffmpegPath: "/fake/ffmpeg", spawn });

    expect(calls).toHaveLength(1);
    expect(calls[0].cmd).toBe("/fake/ffmpeg");
    const args = calls[0].args;
    expect(args).toEqual(expect.arrayContaining(["-i", src, "-vn", "-acodec", "libmp3lame", "-b:a", "128k", "-f", "mp3", "-ac", "1"]));
    expect(args.at(-1)).toBe(`${dest}.tmp`);
    expect(fs.existsSync(dest)).toBe(true);
    expect(fs.existsSync(`${dest}.tmp`)).toBe(false);
    expect(result.fromCache).toBe(false);
    expect(result.durationSec).toBeCloseTo(10.0, 2);
    expect(result.bytes).toBe(fs.statSync(dest).size);
  });

  it("passes -filter:a atempo=X when speed is set and != 1.0", async () => {
    const src = path.join(tmp, "ep.mp4");
    const dest = path.join(tmp, "ep.mp3");
    fs.writeFileSync(src, "video");

    const { spawn, calls } = fakeSpawn((child) => {
      child.stderr.write("Duration: 00:00:10.00, start: 0\n");
      fs.writeFileSync(calls[0].args.at(-1), "mp3");
      child.emit("exit", 0);
    });
    await convert({ src, dest, ffmpegPath: "/fake/ffmpeg", spawn, speed: 1.5 });
    const args = calls[0].args;
    const idx = args.indexOf("-filter:a");
    expect(idx).toBeGreaterThan(-1);
    expect(args[idx + 1]).toBe("atempo=1.5");
  });

  it("omits the atempo filter entirely at speed 1.0", async () => {
    const src = path.join(tmp, "ep.mp4");
    const dest = path.join(tmp, "ep.mp3");
    fs.writeFileSync(src, "video");

    const { spawn, calls } = fakeSpawn((child) => {
      child.stderr.write("Duration: 00:00:10.00, start: 0\n");
      fs.writeFileSync(calls[0].args.at(-1), "mp3");
      child.emit("exit", 0);
    });
    await convert({ src, dest, ffmpegPath: "/fake/ffmpeg", spawn, speed: 1.0 });
    expect(calls[0].args.includes("-filter:a")).toBe(false);
  });

  it("appends the boost filter chain when boost is true", async () => {
    const src = path.join(tmp, "ep.mp3");
    const dest = path.join(tmp, "ep-boost.mp3");
    fs.writeFileSync(src, "audio");

    const { spawn, calls } = fakeSpawn((child) => {
      child.stderr.write("Duration: 00:00:10.00, start: 0\n");
      fs.writeFileSync(calls[0].args.at(-1), "mp3");
      child.emit("exit", 0);
    });
    await convert({ src, dest, ffmpegPath: "/fake/ffmpeg", spawn, speed: 1.0, boost: true });
    const args = calls[0].args;
    const idx = args.indexOf("-filter:a");
    expect(idx).toBeGreaterThan(-1);
    expect(args[idx + 1]).toMatch(/^acompressor=.*loudnorm=.*volume=6dB.*alimiter=/);
    expect(args[idx + 1]).not.toContain("atempo=");
  });

  it("chains atempo before the boost filter when both are set", async () => {
    const src = path.join(tmp, "ep.mp3");
    const dest = path.join(tmp, "ep-both.mp3");
    fs.writeFileSync(src, "audio");

    const { spawn, calls } = fakeSpawn((child) => {
      child.stderr.write("Duration: 00:00:10.00, start: 0\n");
      fs.writeFileSync(calls[0].args.at(-1), "mp3");
      child.emit("exit", 0);
    });
    await convert({ src, dest, ffmpegPath: "/fake/ffmpeg", spawn, speed: 1.5, boost: true });
    const args = calls[0].args;
    const idx = args.indexOf("-filter:a");
    expect(idx).toBeGreaterThan(-1);
    const chain = args[idx + 1];
    const atempoPos = chain.indexOf("atempo=1.5");
    const compPos = chain.indexOf("acompressor=");
    expect(atempoPos).toBeGreaterThan(-1);
    expect(compPos).toBeGreaterThan(atempoPos);
  });

  it("front-concats the intro using filter_complex with re-encode (no -c copy) when introPath is set", async () => {
    const src = path.join(tmp, "ep.mp3");
    const dest = path.join(tmp, "ep-intro.mp3");
    const intro = path.join(tmp, "intro.wav");
    fs.writeFileSync(src, "episode audio");
    fs.writeFileSync(intro, "intro wav");

    const { spawn, calls } = fakeSpawn((child) => {
      child.stderr.write("Duration: 00:00:10.00, start: 0\n");
      fs.writeFileSync(calls[0].args.at(-1), "mp3");
      child.emit("exit", 0);
    });

    await convert({ src, dest, ffmpegPath: "/fake/ffmpeg", spawn, introPath: intro, speed: 1.0 });
    const args = calls[0].args;

    // Two inputs: intro first, episode second.
    const inputs = args.reduce((acc, a, i) => (a === "-i" ? [...acc, args[i + 1]] : acc), []);
    expect(inputs).toEqual([intro, src]);

    // Uses the concat filter, never a stream copy.
    expect(args.includes("-filter_complex")).toBe(true);
    expect(args.includes("-c")).toBe(false);
    expect(args.includes("copy")).toBe(false);
    const fc = args[args.indexOf("-filter_complex") + 1];
    expect(fc).toContain("concat=n=2:v=0:a=1");
    // Resample so the 24kHz intro and 44.1kHz episode reconcile.
    expect(fc).toContain("aresample=44100");
    // Re-encodes to mp3 and maps the concat output.
    expect(args).toEqual(expect.arrayContaining(["-map", "[out]", "-acodec", "libmp3lame", "-f", "mp3"]));
    expect(args.at(-1)).toBe(`${dest}.tmp`);
    expect(fs.existsSync(dest)).toBe(true);
  });

  it("speeds up the episode but NOT the intro in the concat filter graph", async () => {
    const src = path.join(tmp, "ep.mp3");
    const dest = path.join(tmp, "ep-intro-fast.mp3");
    const intro = path.join(tmp, "intro.wav");
    fs.writeFileSync(src, "episode audio");
    fs.writeFileSync(intro, "intro wav");

    const { spawn, calls } = fakeSpawn((child) => {
      child.stderr.write("Duration: 00:00:10.00, start: 0\n");
      fs.writeFileSync(calls[0].args.at(-1), "mp3");
      child.emit("exit", 0);
    });

    await convert({ src, dest, ffmpegPath: "/fake/ffmpeg", spawn, introPath: intro, speed: 1.5, boost: true });
    const args = calls[0].args;
    const fc = args[args.indexOf("-filter_complex") + 1];

    // The atempo/boost live on the episode stream ([1:a] -> [ep]).
    const epStage = fc.split(";").find((s) => s.endsWith("[ep]"));
    expect(epStage).toBeDefined();
    expect(epStage.startsWith("[1:a]")).toBe(true);
    expect(epStage).toContain("atempo=1.5");
    expect(epStage).toContain("acompressor=");

    // The intro stream ([0:a] -> [intro]) is resampled only, never sped up or boosted.
    const introStage = fc.split(";").find((s) => s.endsWith("[intro]"));
    expect(introStage).toBeDefined();
    expect(introStage.startsWith("[0:a]")).toBe(true);
    expect(introStage).not.toContain("atempo");
    expect(introStage).not.toContain("acompressor=");
  });

  it("builds the plain single-input pipeline (no filter_complex) when introPath is not set", async () => {
    const src = path.join(tmp, "ep.mp4");
    const dest = path.join(tmp, "ep.mp3");
    fs.writeFileSync(src, "video");

    const { spawn, calls } = fakeSpawn((child) => {
      child.stderr.write("Duration: 00:00:10.00, start: 0\n");
      fs.writeFileSync(calls[0].args.at(-1), "mp3");
      child.emit("exit", 0);
    });

    await convert({ src, dest, ffmpegPath: "/fake/ffmpeg", spawn, speed: 1.5 });
    const args = calls[0].args;
    expect(args.includes("-filter_complex")).toBe(false);
    const inputs = args.reduce((acc, a, i) => (a === "-i" ? [...acc, args[i + 1]] : acc), []);
    expect(inputs).toEqual([src]);
    // Existing -filter:a path still used for the single-input case.
    const idx = args.indexOf("-filter:a");
    expect(idx).toBeGreaterThan(-1);
    expect(args[idx + 1]).toBe("atempo=1.5");
  });

  it("reports monotonic progress from stderr time= lines", async () => {
    const src = path.join(tmp, "ep.mp4");
    const dest = path.join(tmp, "ep.mp3");
    fs.writeFileSync(src, "x");

    const progress = [];
    const { spawn, calls } = fakeSpawn((child) => {
      child.stderr.write("Duration: 00:00:10.00, start: 0\n");
      child.stderr.write("frame=1 time=00:00:02.00 bitrate=128\r");
      child.stderr.write("frame=2 time=00:00:06.50 bitrate=128\r");
      child.stderr.write("frame=3 time=00:00:10.00 bitrate=128\r");
      fs.writeFileSync(calls[0].args.at(-1), "mp3");
      child.emit("exit", 0);
    });

    await convert({
      src, dest, ffmpegPath: "/fake/ffmpeg", spawn,
      onProgress: (p) => progress.push(p),
    });

    expect(progress.length).toBeGreaterThanOrEqual(3);
    for (let i = 1; i < progress.length; i++) {
      expect(progress[i].seconds).toBeGreaterThanOrEqual(progress[i - 1].seconds);
    }
    expect(progress.at(-1).seconds).toBeCloseTo(10.0, 2);
    expect(progress.at(-1).durationSec).toBeCloseTo(10.0, 2);
  });

  it("returns fromCache:true when dest already exists and is non-empty (never spawns ffmpeg)", async () => {
    const src = path.join(tmp, "ep.mp4");
    const dest = path.join(tmp, "ep.mp3");
    fs.writeFileSync(src, "x");
    fs.writeFileSync(dest, "already-converted-mp3");

    const { spawn, calls } = fakeSpawn(() => {});
    const result = await convert({ src, dest, ffmpegPath: "/fake/ffmpeg", spawn });
    expect(calls).toHaveLength(0);
    expect(result.fromCache).toBe(true);
    expect(result.bytes).toBe(fs.statSync(dest).size);
  });

  it("rejects with the tail of stderr when ffmpeg exits non-zero", async () => {
    const src = path.join(tmp, "ep.mp4");
    const dest = path.join(tmp, "ep.mp3");
    fs.writeFileSync(src, "x");

    const { spawn } = fakeSpawn((child) => {
      child.stderr.write("Invalid data found when processing input\n");
      child.emit("exit", 1);
    });

    await expect(convert({ src, dest, ffmpegPath: "/fake/ffmpeg", spawn }))
      .rejects.toMatchObject({ message: expect.stringMatching(/invalid data/i), code: 1 });
    expect(fs.existsSync(dest)).toBe(false);
  });

  it("kills the child and rejects with AbortError when the signal fires", async () => {
    const src = path.join(tmp, "ep.mp4");
    const dest = path.join(tmp, "ep.mp3");
    fs.writeFileSync(src, "x");

    const killed = [];
    const { spawn, calls } = fakeSpawn((child) => {
      child.kill = (sig) => { killed.push(sig); child.emit("exit", null); };
    });

    const ctrl = new AbortController();
    const p = convert({ src, dest, ffmpegPath: "/fake/ffmpeg", spawn, signal: ctrl.signal });
    setTimeout(() => ctrl.abort(), 10);
    await expect(p).rejects.toMatchObject({ name: "AbortError" });
    expect(killed.length).toBeGreaterThan(0);
    expect(fs.existsSync(dest)).toBe(false);
  });
});
