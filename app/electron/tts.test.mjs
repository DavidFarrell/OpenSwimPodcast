import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { createRequire } from "node:module";
import { EventEmitter, PassThrough } from "node:stream";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";

const require = createRequire(import.meta.url);
const {
  renderIntro,
  buildSpeakArgs,
  buildSpeakEnv,
  buildAssembleArgs,
  parseSpeechPath,
  TTS_VOICE,
} = require("./tts.cjs");

function mkTmp() { return fs.mkdtempSync(path.join(os.tmpdir(), "os-tts-")); }
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

describe("buildSpeakArgs()", () => {
  it("invokes the qwen-speak script with speak + voice Ryan, text as a plain argv item", () => {
    const args = buildSpeakArgs("This is the show.");
    expect(args).toEqual(["tts_engine_v2.py", "speak", "This is the show.", "--voice", "Ryan"]);
    expect(TTS_VOICE).toBe("Ryan");
  });

  it("passes text with quotes/metacharacters verbatim (no shell, no escaping needed)", () => {
    const args = buildSpeakArgs("David's \"weird\" $episode & co");
    expect(args[2]).toBe("David's \"weird\" $episode & co");
  });
});

describe("buildSpeakEnv()", () => {
  it("activates the venv via VIRTUAL_ENV + venv bin on PATH", () => {
    const env = buildSpeakEnv();
    expect(env.VIRTUAL_ENV).toContain("/qwentts/.venv");
    expect(env.PATH.startsWith(env.VIRTUAL_ENV + "/bin:")).toBe(true);
    expect(env.PYTHONUNBUFFERED).toBe("1");
  });
});

describe("parseSpeechPath()", () => {
  it("pulls the WAV path out of qwen-speak stdout", () => {
    const out = "Loading model...\nGenerating speech with voice: Ryan\nAudio saved to: /tmp/qwentts/audio_output/tts_Ryan.wav\n";
    expect(parseSpeechPath(out)).toBe("/tmp/qwentts/audio_output/tts_Ryan.wav");
  });

  it("returns null when the marker line is absent", () => {
    expect(parseSpeechPath("nothing useful here")).toBe(null);
    expect(parseSpeechPath("")).toBe(null);
    expect(parseSpeechPath(null)).toBe(null);
  });
});

describe("buildAssembleArgs()", () => {
  it("puts the synthesised chime BEFORE the speech in the concat", () => {
    const args = buildAssembleArgs({ speechPath: "/tmp/speech.wav", outPath: "/tmp/out.wav" });
    const fcIdx = args.indexOf("-filter_complex");
    expect(fcIdx).toBeGreaterThan(-1);
    const filter = args[fcIdx + 1];

    // The chime is generated (a sine source) and labelled [chime]; the speech is
    // input 0 labelled [speech]. The concat must list chime first, speech second.
    expect(filter).toContain("sine=frequency=880");
    expect(filter).toContain("[chime]");
    expect(filter).toContain("[0:a]");
    expect(filter).toContain("[speech]");
    expect(filter).toContain("[chime][speech]concat=n=2:v=0:a=1[out]");
    // Chime label must appear before the speech label inside the concat node.
    const concat = /\[(\w+)\]\[(\w+)\]concat/.exec(filter);
    expect(concat[1]).toBe("chime");
    expect(concat[2]).toBe("speech");
  });

  it("pins the input contract: speech is the ONLY -i input ([0:a]); chime is a generated filter source", () => {
    const args = buildAssembleArgs({ speechPath: "/tmp/speech.wav", outPath: "/tmp/out.wav" });

    // There is exactly one input file, and it is the speech WAV - so the speech
    // is input 0 and is the stream consumed as [0:a]. The chime has no input slot.
    expect(args.filter((a) => a === "-i")).toHaveLength(1);
    const iIdx = args.indexOf("-i");
    expect(args[iIdx + 1]).toBe("/tmp/speech.wav");

    const filter = args[args.indexOf("-filter_complex") + 1];
    // [0:a] is wired to the speech label, NOT the chime - this is the bit the old
    // comment got backwards (it claimed input 0 was the chime).
    expect(filter).toContain("[0:a]aresample");
    expect(filter).toMatch(/\[0:a\][^;]*\[speech\]/);
    // The chime is NOT sourced from any input index - it comes from sine=.
    expect(filter).toMatch(/sine=frequency=880[^;]*\[chime\]/);
    expect(filter).not.toContain("[1:a]");
    // And the assembled order is unambiguously chime then speech.
    expect(filter.indexOf("[chime][speech]concat")).toBeGreaterThan(-1);
  });

  it("outputs 24kHz mono PCM (matches the qwen-speak format) to outPath", () => {
    const args = buildAssembleArgs({ speechPath: "/tmp/speech.wav", outPath: "/tmp/out.wav" });
    expect(args).toEqual(expect.arrayContaining(["-i", "/tmp/speech.wav", "-acodec", "pcm_s16le", "-ar", "24000", "-ac", "1"]));
    expect(args.at(-1)).toBe("/tmp/out.wav");
  });
});

describe("renderIntro()", () => {
  let tmp;
  beforeEach(() => { tmp = mkTmp(); });
  afterEach(() => rmTmp(tmp));

  it("spawns qwen-speak then ffmpeg and returns the final WAV path on success", async () => {
    const outPath = path.join(tmp, "intro.wav");
    const speechPath = path.join(tmp, "tts_Ryan.wav");

    const { spawn, calls } = fakeSpawn((child, { cmd, args }) => {
      if (cmd === "/fake/ffmpeg") {
        // ffmpeg writes the assembled chime+speech WAV at the last arg.
        fs.writeFileSync(args.at(-1), "chime+speech bytes");
        child.emit("exit", 0);
      } else {
        // qwen-speak: emit the generated speech WAV and announce its path.
        fs.writeFileSync(speechPath, "speech bytes");
        child.stdout.write(`Audio saved to: ${speechPath}\n`);
        child.emit("exit", 0);
      }
    });

    const result = await renderIntro({ text: "This is the show. Episode one.", outPath, ffmpegPath: "/fake/ffmpeg", spawn });

    expect(result).toBe(outPath);
    expect(calls).toHaveLength(2);

    // First spawn invokes the venv python directly (no shell) with the speak args.
    const ttsCall = calls[0];
    expect(ttsCall.cmd).toContain("/.venv/bin/python");
    expect(ttsCall.args).toEqual(["tts_engine_v2.py", "speak", "This is the show. Episode one.", "--voice", "Ryan"]);

    // Second spawn is ffmpeg, with the chime preceding the speech in the concat.
    const ffCall = calls[1];
    expect(ffCall.cmd).toBe("/fake/ffmpeg");
    const filter = ffCall.args[ffCall.args.indexOf("-filter_complex") + 1];
    expect(filter).toContain("[chime][speech]concat=n=2:v=0:a=1[out]");
    expect(ffCall.args).toEqual(expect.arrayContaining(["-i", speechPath]));
    expect(fs.existsSync(outPath)).toBe(true);
  });

  it("returns null (and does not run ffmpeg) when qwen-speak exits non-zero", async () => {
    const outPath = path.join(tmp, "intro.wav");
    const { spawn, calls } = fakeSpawn((child) => {
      child.stderr.write("CUDA error\n");
      child.emit("exit", 1);
    });

    const result = await renderIntro({ text: "hi", outPath, ffmpegPath: "/fake/ffmpeg", spawn });
    expect(result).toBe(null);
    expect(calls).toHaveLength(1); // never reached ffmpeg
  });

  it("returns null when qwen-speak prints no 'Audio saved to' line", async () => {
    const outPath = path.join(tmp, "intro.wav");
    const { spawn, calls } = fakeSpawn((child) => {
      child.stdout.write("done but no path here\n");
      child.emit("exit", 0);
    });

    const result = await renderIntro({ text: "hi", outPath, ffmpegPath: "/fake/ffmpeg", spawn });
    expect(result).toBe(null);
    expect(calls).toHaveLength(1);
  });

  it("returns null (and does not run ffmpeg) when the printed speech file does not exist", async () => {
    const outPath = path.join(tmp, "intro.wav");
    // qwen-speak exits 0 and prints a path, but never actually writes the file -
    // a stale/bogus path. This must degrade to null before ffmpeg is invoked.
    const bogusPath = path.join(tmp, "does_not_exist.wav");
    const { spawn, calls } = fakeSpawn((child) => {
      child.stdout.write(`Audio saved to: ${bogusPath}\n`);
      child.emit("exit", 0);
    });

    const result = await renderIntro({ text: "hi", outPath, ffmpegPath: "/fake/ffmpeg", spawn });
    expect(result).toBe(null);
    expect(calls).toHaveLength(1); // never reached ffmpeg - no input file
    expect(fs.existsSync(bogusPath)).toBe(false);
  });

  it("returns null when the subprocess is missing (spawn throws)", async () => {
    const outPath = path.join(tmp, "intro.wav");
    const spawn = () => { throw new Error("ENOENT: bash not found"); };
    const result = await renderIntro({ text: "hi", outPath, ffmpegPath: "/fake/ffmpeg", spawn });
    expect(result).toBe(null);
  });

  it("returns null when ffmpeg fails to assemble the WAV", async () => {
    const outPath = path.join(tmp, "intro.wav");
    const speechPath = path.join(tmp, "tts_Ryan.wav");
    const { spawn, calls } = fakeSpawn((child, { cmd }) => {
      if (cmd === "/fake/ffmpeg") {
        child.stderr.write("Invalid argument\n");
        child.emit("exit", 1);
      } else {
        fs.writeFileSync(speechPath, "speech bytes");
        child.stdout.write(`Audio saved to: ${speechPath}\n`);
        child.emit("exit", 0);
      }
    });

    const result = await renderIntro({ text: "hi", outPath, ffmpegPath: "/fake/ffmpeg", spawn });
    expect(result).toBe(null);
    expect(calls).toHaveLength(2); // ran ffmpeg, but it failed
  });

  it("returns null when ffmpeg exits 0 but writes no output file", async () => {
    const outPath = path.join(tmp, "intro.wav");
    const speechPath = path.join(tmp, "tts_Ryan.wav");
    const { spawn } = fakeSpawn((child, { cmd }) => {
      if (cmd === "/fake/ffmpeg") {
        // exit 0 but never writes outPath.
        child.emit("exit", 0);
      } else {
        fs.writeFileSync(speechPath, "speech bytes");
        child.stdout.write(`Audio saved to: ${speechPath}\n`);
        child.emit("exit", 0);
      }
    });

    const result = await renderIntro({ text: "hi", outPath, ffmpegPath: "/fake/ffmpeg", spawn });
    expect(result).toBe(null);
  });

  it("returns null for empty text or a missing outPath without spawning", async () => {
    const spawn = () => { throw new Error("should not spawn"); };
    expect(await renderIntro({ text: "", outPath: path.join(tmp, "x.wav"), ffmpegPath: "/fake/ffmpeg", spawn })).toBe(null);
    expect(await renderIntro({ text: "  ", outPath: path.join(tmp, "x.wav"), ffmpegPath: "/fake/ffmpeg", spawn })).toBe(null);
    expect(await renderIntro({ text: "hi", outPath: null, ffmpegPath: "/fake/ffmpeg", spawn })).toBe(null);
  });

  it("returns null when no ffmpeg binary is available", async () => {
    const outPath = path.join(tmp, "intro.wav");
    const spawn = () => { throw new Error("should not spawn"); };
    const result = await renderIntro({ text: "hi", outPath, ffmpegPath: null, spawn });
    expect(result).toBe(null);
  });

  it("returns null (and kills the child) when the TTS run times out", async () => {
    const outPath = path.join(tmp, "intro.wav");
    const killed = [];
    const { spawn } = fakeSpawn((child) => {
      child.kill = (sig) => { killed.push(sig); };
      // never emits exit - let the timeout fire.
    });

    const result = await renderIntro({ text: "hi", outPath, ffmpegPath: "/fake/ffmpeg", spawn, ttsTimeoutMs: 20 });
    expect(result).toBe(null);
    expect(killed.length).toBeGreaterThan(0);
  });
});
