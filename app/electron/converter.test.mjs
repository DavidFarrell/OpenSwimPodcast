import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { createRequire } from "node:module";
import { EventEmitter, PassThrough } from "node:stream";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";

const require = createRequire(import.meta.url);
const { convert, parseDuration, parseTime, normaliseCuts, buildCutFilters, probeDurationSec } = require("./converter.cjs");

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

describe("probeDurationSec()", () => {
  it("parses the duration off ffmpeg stderr (exit code irrelevant)", async () => {
    const { spawn } = fakeSpawn((child) => {
      child.stderr.write("  Duration: 00:33:53.04, start: 0.0, bitrate: 128 kb/s\n");
      // ffmpeg with only -i exits non-zero, but we still parse the duration.
      child.emit("close", 1);
    });
    const sec = await probeDurationSec("/x/out.mp3", { spawn, ffmpegPath: "ffmpeg" });
    expect(sec).toBeCloseTo(33 * 60 + 53.04, 2);
  });

  it("returns null when no ffmpeg path is available (no spawn)", async () => {
    expect(await probeDurationSec("/x/out.mp3", { spawn: () => { throw new Error("nope"); }, ffmpegPath: null })).toBe(null);
  });

  it("returns null when stderr has no Duration line", async () => {
    const { spawn } = fakeSpawn((child) => { child.stderr.write("garbage\n"); child.emit("close", 1); });
    expect(await probeDurationSec("/x/out.mp3", { spawn, ffmpegPath: "ffmpeg" })).toBe(null);
  });

  it("never throws on a spawn error - resolves null", async () => {
    const spawn = () => { const c = makeFakeChild(); setTimeout(() => c.emit("error", new Error("ENOENT")), 0); return c; };
    expect(await probeDurationSec("/x/out.mp3", { spawn, ffmpegPath: "ffmpeg" })).toBe(null);
  });
});

describe("normaliseCuts()", () => {
  it("returns [] for absent/empty/non-array input (cut nothing)", () => {
    expect(normaliseCuts(null)).toEqual([]);
    expect(normaliseCuts(undefined)).toEqual([]);
    expect(normaliseCuts([])).toEqual([]);
    expect(normaliseCuts("nope")).toEqual([]);
  });

  it("drops empty, inverted, non-finite and malformed ranges (degrade safely)", () => {
    expect(normaliseCuts([[5, 5]])).toEqual([]);        // empty
    expect(normaliseCuts([[10, 5]])).toEqual([]);       // inverted
    expect(normaliseCuts([[NaN, 5]])).toEqual([]);      // non-finite
    expect(normaliseCuts([[0, Infinity]])).toEqual([]); // non-finite
    expect(normaliseCuts([[3]])).toEqual([]);           // malformed
    expect(normaliseCuts([["a", "b"]])).toEqual([]);    // non-numeric
  });

  it("drops negative-start ranges entirely (never trims real start-of-episode content)", () => {
    // A negative start is out-of-bounds/malformed. Per the trim cardinal rule
    // (zero false positives) it must be discarded - NOT reshaped to start at 0,
    // which would silently cut the beginning of the episode.
    expect(normaliseCuts([[-3, 10]])).toEqual([]);
    expect(normaliseCuts([[-1, 5], [20, 30]])).toEqual([[20, 30]]); // bad one dropped, good one kept
  });

  it("sorts and merges overlapping / touching ranges", () => {
    expect(normaliseCuts([[30, 40], [10, 20]])).toEqual([[10, 20], [30, 40]]);
    expect(normaliseCuts([[10, 25], [20, 40]])).toEqual([[10, 40]]); // overlap
    expect(normaliseCuts([[10, 20], [20, 30]])).toEqual([[10, 30]]); // touching
  });
});

describe("buildCutFilters()", () => {
  it("returns [] when there are no ranges (zero-regression)", () => {
    expect(buildCutFilters([])).toEqual([]);
    expect(buildCutFilters(null)).toEqual([]);
  });

  it("builds aselect+asetpts dropping a single range", () => {
    expect(buildCutFilters([[10, 20]])).toEqual([
      "aselect='not(between(t,10,20))'",
      "asetpts=N/SR/TB",
    ]);
  });

  it("sums between() terms for multiple ranges", () => {
    expect(buildCutFilters([[10, 20], [30, 40]])).toEqual([
      "aselect='not(between(t,10,20)+between(t,30,40))'",
      "asetpts=N/SR/TB",
    ]);
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
    // Three concat inputs now: chime, speech, episode (the intro is split into
    // its chime and its speech).
    expect(fc).toContain("concat=n=3:v=0:a=1");
    // Resample so the 24kHz intro and 44.1kHz episode reconcile.
    expect(fc).toContain("aresample=44100");
    // Re-encodes to mp3 and maps the concat output.
    expect(args).toEqual(expect.arrayContaining(["-map", "[out]", "-acodec", "libmp3lame", "-f", "mp3"]));
    expect(args.at(-1)).toBe(`${dest}.tmp`);
    expect(fs.existsSync(dest)).toBe(true);
  });

  it("speeds up + boosts the episode AND the intro SPEECH, but leaves the chime untouched", async () => {
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
    const stages = fc.split(";");

    // The intro is split into a chime branch and a speech branch.
    const splitStage = stages.find((s) => s.includes("asplit"));
    expect(splitStage).toBeDefined();
    expect(splitStage.startsWith("[0:a]")).toBe(true);

    // The atempo/boost live on the episode stream ([1:a] -> [ep]).
    const epStage = stages.find((s) => s.endsWith("[ep]"));
    expect(epStage).toBeDefined();
    expect(epStage.startsWith("[1:a]")).toBe(true);
    expect(epStage).toContain("atempo=1.5");
    expect(epStage).toContain("acompressor=");

    // The SPEECH stage trims off the chime (start=0.5) and gets the SAME
    // speed+boost the episode gets, so it matches the episode's pace/loudness.
    const speechStage = stages.find((s) => s.endsWith("[speech]"));
    expect(speechStage).toBeDefined();
    expect(speechStage).toContain("atrim=start=0.5");
    expect(speechStage).toContain("asetpts=N/SR/TB");
    expect(speechStage).toContain("atempo=1.5");
    expect(speechStage).toContain("acompressor=");

    // The CHIME stage keeps only the first 0.5s and is NEVER sped up or boosted -
    // it stays a constant-length, constant-level "Swimcast" marker.
    const chimeStage = stages.find((s) => s.endsWith("[chime]"));
    expect(chimeStage).toBeDefined();
    expect(chimeStage).toContain("atrim=0:0.5");
    expect(chimeStage).not.toContain("atempo");
    expect(chimeStage).not.toContain("acompressor=");

    // Concat order is chime, then speech, then episode.
    const concatStage = stages.find((s) => s.includes("concat="));
    expect(concatStage).toBeDefined();
    expect(concatStage).toContain("concat=n=3:v=0:a=1");
    expect(concatStage.indexOf("[chime]")).toBeLessThan(concatStage.indexOf("[speech]"));
    expect(concatStage.indexOf("[speech]")).toBeLessThan(concatStage.indexOf("[ep]"));
  });

  it("leaves the intro speech UNPROCESSED at speed 1.0 with no boost (matches the unprocessed episode)", async () => {
    const src = path.join(tmp, "ep.mp3");
    const dest = path.join(tmp, "ep-intro-plain.mp3");
    const intro = path.join(tmp, "intro.wav");
    fs.writeFileSync(src, "episode audio");
    fs.writeFileSync(intro, "intro wav");

    const { spawn, calls } = fakeSpawn((child) => {
      child.stderr.write("Duration: 00:00:10.00, start: 0\n");
      fs.writeFileSync(calls[0].args.at(-1), "mp3");
      child.emit("exit", 0);
    });

    await convert({ src, dest, ffmpegPath: "/fake/ffmpeg", spawn, introPath: intro, speed: 1.0, boost: false });
    const fc = calls[0].args[calls[0].args.indexOf("-filter_complex") + 1];
    const stages = fc.split(";");

    // Speech still gets split off and PTS-rebased, but no atempo/boost is added.
    const speechStage = stages.find((s) => s.endsWith("[speech]"));
    expect(speechStage).toBeDefined();
    expect(speechStage).toContain("atrim=start=0.5");
    expect(speechStage).toContain("asetpts=N/SR/TB");
    expect(speechStage).not.toContain("atempo");
    expect(speechStage).not.toContain("acompressor=");
    // Episode is likewise unprocessed (no atempo/boost) - they match.
    const epStage = stages.find((s) => s.endsWith("[ep]"));
    expect(epStage).not.toContain("atempo");
    expect(epStage).not.toContain("acompressor=");
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

  it("prepends the aselect/asetpts cut filters before atempo in the single-input -filter:a chain", async () => {
    const src = path.join(tmp, "ep.mp3");
    const dest = path.join(tmp, "ep-cut.mp3");
    fs.writeFileSync(src, "audio");

    const { spawn, calls } = fakeSpawn((child) => {
      child.stderr.write("Duration: 00:00:30.00, start: 0\n");
      fs.writeFileSync(calls[0].args.at(-1), "mp3");
      child.emit("exit", 0);
    });

    await convert({ src, dest, ffmpegPath: "/fake/ffmpeg", spawn, speed: 1.5, boost: true, cuts: [[10, 20]] });
    const args = calls[0].args;
    expect(args.includes("-filter_complex")).toBe(false);
    const idx = args.indexOf("-filter:a");
    expect(idx).toBeGreaterThan(-1);
    const chain = args[idx + 1];
    // Order: cut drop (aselect/asetpts) -> atempo -> boost. Cuts are on the
    // original timeline so they MUST come before atempo changes the timebase.
    const selPos = chain.indexOf("aselect='not(between(t,10,20))'");
    const ptsPos = chain.indexOf("asetpts=N/SR/TB");
    const atempoPos = chain.indexOf("atempo=1.5");
    const compPos = chain.indexOf("acompressor=");
    expect(selPos).toBe(0);
    expect(ptsPos).toBeGreaterThan(selPos);
    expect(atempoPos).toBeGreaterThan(ptsPos);
    expect(compPos).toBeGreaterThan(atempoPos);
  });

  it("applies cuts to the EPISODE stream (not the intro) in the concat filter graph, before atempo/boost", async () => {
    const src = path.join(tmp, "ep.mp3");
    const dest = path.join(tmp, "ep-intro-cut.mp3");
    const intro = path.join(tmp, "intro.wav");
    fs.writeFileSync(src, "episode audio");
    fs.writeFileSync(intro, "intro wav");

    const { spawn, calls } = fakeSpawn((child) => {
      child.stderr.write("Duration: 00:00:30.00, start: 0\n");
      fs.writeFileSync(calls[0].args.at(-1), "mp3");
      child.emit("exit", 0);
    });

    await convert({ src, dest, ffmpegPath: "/fake/ffmpeg", spawn, introPath: intro, speed: 1.5, boost: true, cuts: [[10, 20], [40, 50]] });
    const args = calls[0].args;
    const fc = args[args.indexOf("-filter_complex") + 1];
    const stages = fc.split(";");

    const epStage = stages.find((s) => s.endsWith("[ep]"));
    expect(epStage).toBeDefined();
    expect(epStage.startsWith("[1:a]")).toBe(true);
    // Both cut ranges, summed, dropped before atempo/boost.
    const selPos = epStage.indexOf("aselect='not(between(t,10,20)+between(t,40,50))'");
    const ptsPos = epStage.indexOf("asetpts=N/SR/TB");
    const atempoPos = epStage.indexOf("atempo=1.5");
    const compPos = epStage.indexOf("acompressor=");
    expect(selPos).toBeGreaterThan(-1);
    expect(ptsPos).toBeGreaterThan(selPos);
    expect(atempoPos).toBeGreaterThan(ptsPos);
    expect(compPos).toBeGreaterThan(atempoPos);

    // Cuts are EPISODE-only: neither the chime nor the speech is ever cut. The
    // speech does carry an asetpts (to rebase after the chime trim) but NEVER an
    // aselect - that is the cut filter and it lives on the episode timeline only.
    const chimeStage = stages.find((s) => s.endsWith("[chime]"));
    expect(chimeStage).toBeDefined();
    expect(chimeStage).not.toContain("aselect");
    const speechStage = stages.find((s) => s.endsWith("[speech]"));
    expect(speechStage).toBeDefined();
    expect(speechStage).not.toContain("aselect");
  });

  it("cutting nothing yields byte-for-byte identical args to no cuts at all (zero-regression)", async () => {
    const src = path.join(tmp, "ep.mp3");
    const intro = path.join(tmp, "intro.wav");
    fs.writeFileSync(src, "audio");
    fs.writeFileSync(intro, "intro");

    async function argsFor(opts) {
      const dest = path.join(tmp, `out-${Math.random().toString(36).slice(2)}.mp3`);
      const { spawn, calls } = fakeSpawn((child) => {
        child.stderr.write("Duration: 00:00:30.00, start: 0\n");
        fs.writeFileSync(calls[0].args.at(-1), "mp3");
        child.emit("exit", 0);
      });
      await convert({ src, dest, ffmpegPath: "/fake/ffmpeg", spawn, ...opts });
      // Drop the trailing tmp path (varies by dest) before comparing.
      return calls[0].args.slice(0, -1);
    }

    // Single-input path: empty/null/invalid-only cuts == no cuts.
    const base = await argsFor({ speed: 1.5, boost: true });
    expect(await argsFor({ speed: 1.5, boost: true, cuts: null })).toEqual(base);
    expect(await argsFor({ speed: 1.5, boost: true, cuts: [] })).toEqual(base);
    expect(await argsFor({ speed: 1.5, boost: true, cuts: [[5, 5], [10, 5]] })).toEqual(base);

    // Concat (intro) path too.
    const baseIntro = await argsFor({ introPath: intro, speed: 1.5, boost: true });
    expect(await argsFor({ introPath: intro, speed: 1.5, boost: true, cuts: [] })).toEqual(baseIntro);
    expect(await argsFor({ introPath: intro, speed: 1.5, boost: true, cuts: [[20, 10]] })).toEqual(baseIntro);
  });

  it("emits byte-identical args on the NO-introPath path (frozen contract, zero-regression)", async () => {
    // The intro-speech change must NOT touch the no-intro code path. This pins
    // the exact arg vector that path produced before the change.
    const src = path.join(tmp, "ep.mp3");
    const dest = path.join(tmp, "ep-nointro.mp3");
    fs.writeFileSync(src, "audio");

    const { spawn, calls } = fakeSpawn((child) => {
      child.stderr.write("Duration: 00:00:30.00, start: 0\n");
      fs.writeFileSync(calls[0].args.at(-1), "mp3");
      child.emit("exit", 0);
    });

    await convert({ src, dest, ffmpegPath: "/fake/ffmpeg", spawn, speed: 1.5, boost: true, cuts: [[10, 20]] });
    expect(calls[0].args).toEqual([
      "-y",
      "-hide_banner",
      "-i", src,
      "-vn",
      "-acodec", "libmp3lame",
      "-b:a", "128k",
      "-f", "mp3",
      "-filter:a", "aselect='not(between(t,10,20))',asetpts=N/SR/TB,atempo=1.5," +
        "acompressor=threshold=-22dB:ratio=3:attack=5:release=80:makeup=4dB," +
        "loudnorm=I=-14:LRA=9:TP=-1.0,volume=6dB,alimiter=limit=0.97:level=disabled",
      "-ac", "1",
      `${dest}.tmp`,
    ]);
    // No filter_complex / split / concat ever leaks into the single-input path.
    expect(calls[0].args).not.toContain("-filter_complex");
  });

  it("can cut at speed 1.0 with no boost (cut-only, no atempo present)", async () => {
    const src = path.join(tmp, "ep.mp3");
    const dest = path.join(tmp, "ep-cutonly.mp3");
    fs.writeFileSync(src, "audio");

    const { spawn, calls } = fakeSpawn((child) => {
      child.stderr.write("Duration: 00:00:30.00, start: 0\n");
      fs.writeFileSync(calls[0].args.at(-1), "mp3");
      child.emit("exit", 0);
    });

    await convert({ src, dest, ffmpegPath: "/fake/ffmpeg", spawn, speed: 1.0, boost: false, cuts: [[10, 20]] });
    const args = calls[0].args;
    const idx = args.indexOf("-filter:a");
    expect(idx).toBeGreaterThan(-1);
    const chain = args[idx + 1];
    expect(chain).toBe("aselect='not(between(t,10,20))',asetpts=N/SR/TB");
    expect(chain).not.toContain("atempo");
    expect(chain).not.toContain("acompressor=");
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
