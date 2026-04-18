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
});
