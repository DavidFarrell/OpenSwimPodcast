import { describe, it, expect, afterEach } from "vitest";
import { createRequire } from "node:module";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { spawnSync } from "node:child_process";

const require = createRequire(import.meta.url);
const { convert } = require("./converter.cjs");
const ffmpegPath = require("ffmpeg-static");

function mkTmp() { return fs.mkdtempSync(path.join(os.tmpdir(), "os-smoke-")); }
function rmTmp(d) { try { fs.rmSync(d, { recursive: true, force: true }); } catch {} }

describe("converter smoke test (real ffmpeg-static)", () => {
  let tmp;
  afterEach(() => { if (tmp) rmTmp(tmp); tmp = null; });

  it("converts a synthesised 1s video into mp3", async () => {
    tmp = mkTmp();
    const src = path.join(tmp, "src.mp4");
    const dest = path.join(tmp, "out.mp3");

    const r = spawnSync(ffmpegPath, [
      "-y", "-hide_banner",
      "-f", "lavfi", "-i", "sine=frequency=440:duration=1",
      "-f", "lavfi", "-i", "color=c=black:s=64x64:d=1",
      "-shortest", src,
    ]);
    expect(r.status).toBe(0);
    expect(fs.existsSync(src)).toBe(true);

    const progress = [];
    const result = await convert({ src, dest, onProgress: (p) => progress.push(p) });

    expect(fs.existsSync(dest)).toBe(true);
    expect(result.bytes).toBeGreaterThan(0);
    expect(result.fromCache).toBe(false);
    expect(result.durationSec).toBeCloseTo(1.0, 0);
    expect(progress.length).toBeGreaterThan(0);
  }, 30_000);

  it("front-concats a 24kHz mono intro ahead of a 44.1kHz episode and reconciles sample rates", async () => {
    tmp = mkTmp();
    const intro = path.join(tmp, "intro.wav");
    const src = path.join(tmp, "ep.mp3");
    const dest = path.join(tmp, "out.mp3");

    // 0.5s tone intro: 24kHz mono PCM WAV (matches qwen-speak output format).
    const ri = spawnSync(ffmpegPath, [
      "-y", "-hide_banner",
      "-f", "lavfi", "-i", "sine=frequency=880:duration=0.5",
      "-ar", "24000", "-ac", "1", "-c:a", "pcm_s16le", intro,
    ]);
    expect(ri.status).toBe(0);

    // 1s episode tone at 44.1kHz mp3.
    const re = spawnSync(ffmpegPath, [
      "-y", "-hide_banner",
      "-f", "lavfi", "-i", "sine=frequency=440:duration=1",
      "-ar", "44100", "-c:a", "libmp3lame", src,
    ]);
    expect(re.status).toBe(0);

    const result = await convert({ src, dest, introPath: intro, speed: 1.0 });
    expect(fs.existsSync(dest)).toBe(true);
    expect(result.bytes).toBeGreaterThan(0);

    // Probe the output duration: intro (0.5s) + episode (1s) ~= 1.5s.
    const probe = spawnSync(ffmpegPath, ["-hide_banner", "-i", dest], { encoding: "utf8" });
    const m = /Duration:\s*(\d+):(\d+):(\d+(?:\.\d+)?)/.exec(probe.stderr || "");
    expect(m).not.toBeNull();
    const seconds = Number(m[1]) * 3600 + Number(m[2]) * 60 + Number(m[3]);
    expect(seconds).toBeGreaterThan(1.3);
    expect(seconds).toBeLessThan(1.8);
  }, 30_000);
});
