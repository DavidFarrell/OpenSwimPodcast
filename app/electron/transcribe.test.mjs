import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { createRequire } from "node:module";
import { EventEmitter, PassThrough } from "node:stream";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";

const require = createRequire(import.meta.url);
const { transcribe, normalise, sidecarPath, buildArgs } = require("./transcribe.cjs");

function mkTmp() { return fs.mkdtempSync(path.join(os.tmpdir(), "os-trans-")); }
function rmTmp(d) { try { fs.rmSync(d, { recursive: true, force: true }); } catch {} }

function makeFakeChild() {
  const child = new EventEmitter();
  child.stdout = new PassThrough();
  child.stderr = new PassThrough();
  child.kill = vi.fn();
  return child;
}

// program(child, { cmd, args }) runs on the next tick - mirrors converter.test.
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

const SAMPLE_JSON = JSON.stringify({
  turns: [
    { speaker: "SPEAKER_00", start: 0.0, end: 2.5, text: "Welcome to the show.", words: [] },
    { speaker: "SPEAKER_01", start: 2.5, end: 5.0, text: "Today we talk about otters.", words: [] },
  ],
  segments: [
    { speaker: "SPEAKER_00", start: 0.0, end: 2.5 },
    { speaker: "SPEAKER_01", start: 2.5, end: 5.0 },
  ],
});

describe("normalise()", () => {
  it("maps turns into segments carrying speaker/start/end/text", () => {
    const out = normalise(JSON.parse(SAMPLE_JSON));
    expect(out.segments).toHaveLength(2);
    expect(out.segments[0]).toEqual({ speaker: "SPEAKER_00", start: 0.0, end: 2.5, text: "Welcome to the show." });
    expect(out.segments[1].text).toBe("Today we talk about otters.");
  });

  it("returns null for empty or textless input", () => {
    expect(normalise(null)).toBe(null);
    expect(normalise({})).toBe(null);
    expect(normalise({ turns: [] })).toBe(null);
    expect(normalise({ segments: [{ speaker: "A", start: 0, end: 1 }] })).toBe(null);
  });
});

describe("transcribe()", () => {
  let tmp;
  beforeEach(() => { tmp = mkTmp(); });
  afterEach(() => rmTmp(tmp));

  it("spawns fast-diarize and returns the parsed transcript on success", async () => {
    const src = path.join(tmp, "episode.mp3");
    fs.writeFileSync(src, "pretend audio bytes");

    const { spawn, calls } = fakeSpawn((child, { args }) => {
      // The CLI writes the JSON to the path it was handed via --out-json.
      const outJson = args[args.indexOf("--out-json") + 1];
      fs.writeFileSync(outJson, SAMPLE_JSON);
      child.emit("exit", 0);
    });

    const result = await transcribe({ src, spawn });

    expect(calls).toHaveLength(1);
    expect(calls[0].cmd).toBe("uv");
    expect(calls[0].args).toEqual(expect.arrayContaining(["diarise-transcribe", "--in", src, "--out-json"]));
    expect(result).not.toBe(null);
    expect(result.segments).toHaveLength(2);
    expect(result.segments[0].speaker).toBe("SPEAKER_00");
    expect(result.segments[1].text).toBe("Today we talk about otters.");
  });

  it("reuses the fingerprint sidecar on a second call (does not spawn twice)", async () => {
    const src = path.join(tmp, "episode.mp3");
    fs.writeFileSync(src, "pretend audio bytes");

    const { spawn, calls } = fakeSpawn((child, { args }) => {
      const outJson = args[args.indexOf("--out-json") + 1];
      fs.writeFileSync(outJson, SAMPLE_JSON);
      child.emit("exit", 0);
    });

    const first = await transcribe({ src, spawn });
    expect(calls).toHaveLength(1);
    expect(first.segments).toHaveLength(2);

    // Sidecar should now exist on disk.
    const fp = `${fs.statSync(src).size}-${Math.floor(fs.statSync(src).mtimeMs)}`;
    expect(fs.existsSync(sidecarPath(src, fp))).toBe(true);

    const second = await transcribe({ src, spawn });
    // Still only one spawn - the second call was a cache hit.
    expect(calls).toHaveLength(1);
    expect(second.segments).toHaveLength(2);
    expect(second.segments[0].text).toBe("Welcome to the show.");
  });

  it("returns null when the subprocess exits non-zero", async () => {
    const src = path.join(tmp, "episode.mp3");
    fs.writeFileSync(src, "audio");

    const { spawn, calls } = fakeSpawn((child) => {
      child.stderr.write("model load failed\n");
      child.emit("exit", 1);
    });

    const result = await transcribe({ src, spawn });
    expect(calls).toHaveLength(1);
    expect(result).toBe(null);
  });

  it("returns null when the subprocess is missing (spawn throws)", async () => {
    const src = path.join(tmp, "episode.mp3");
    fs.writeFileSync(src, "audio");

    const spawn = () => { throw new Error("ENOENT: uv not found"); };
    const result = await transcribe({ src, spawn });
    expect(result).toBe(null);
  });

  it("returns null when the subprocess emits no JSON", async () => {
    const src = path.join(tmp, "episode.mp3");
    fs.writeFileSync(src, "audio");

    const { spawn } = fakeSpawn((child) => {
      // exit 0 but never writes the --out-json file.
      child.emit("exit", 0);
    });

    const result = await transcribe({ src, spawn });
    expect(result).toBe(null);
  });

  it("returns null when the subprocess emits unparseable JSON", async () => {
    const src = path.join(tmp, "episode.mp3");
    fs.writeFileSync(src, "audio");

    const { spawn } = fakeSpawn((child, { args }) => {
      const outJson = args[args.indexOf("--out-json") + 1];
      fs.writeFileSync(outJson, "this is not json {{{");
      child.emit("exit", 0);
    });

    const result = await transcribe({ src, spawn });
    expect(result).toBe(null);
  });

  it("returns null (and kills the child) when the run times out", async () => {
    const src = path.join(tmp, "episode.mp3");
    fs.writeFileSync(src, "audio");

    const killed = [];
    const { spawn, calls } = fakeSpawn((child) => {
      child.kill = (sig) => { killed.push(sig); };
      // never emits exit - let the timeout fire.
    });

    const result = await transcribe({ src, spawn, timeoutMs: 20 });
    expect(result).toBe(null);
    expect(killed.length).toBeGreaterThan(0);
  });

  it("returns null when the audio file does not exist", async () => {
    const result = await transcribe({ src: path.join(tmp, "nope.mp3"), spawn: () => { throw new Error("should not spawn"); } });
    expect(result).toBe(null);
  });

  it("builds the documented uv run diarise-transcribe arg vector", () => {
    const args = buildArgs({ src: "/a/in.mp3", outTxt: "/a/out.txt", outJson: "/a/out.json" });
    expect(args[0]).toBe("run");
    expect(args).toEqual(expect.arrayContaining(["--directory", "diarise-transcribe", "--in", "/a/in.mp3", "--out", "/a/out.txt", "--out-json", "/a/out.json", "--verbose"]));
  });
});
