import { describe, it, expect, afterEach } from "vitest";
import { createRequire } from "node:module";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const require = createRequire(import.meta.url);
const { logEvent } = require("./logger.cjs");

const tmp = path.join(os.tmpdir(), `osw-logtest-${process.pid}.log`);

afterEach(() => {
  try { fs.unlinkSync(tmp); } catch {}
  delete process.env.OSW_LOG;
});

describe("logger.logEvent()", () => {
  it("is a no-op when OSW_LOG is unset (never touches disk)", () => {
    delete process.env.OSW_LOG;
    expect(() => logEvent("trim", "should not be written")).not.toThrow();
    expect(fs.existsSync(tmp)).toBe(false);
  });

  it("appends a timestamped, tagged line when OSW_LOG is set", () => {
    process.env.OSW_LOG = tmp;
    logEvent("trim", "no transcript");
    logEvent("announce", "TTS failed");
    const body = fs.readFileSync(tmp, "utf8");
    expect(body).toMatch(/\[trim\] no transcript/);
    expect(body).toMatch(/\[announce\] TTS failed/);
    // two lines
    expect(body.trim().split("\n").length).toBe(2);
  });

  it("never throws on an unwritable path", () => {
    process.env.OSW_LOG = "/this/does/not/exist/openswim.log";
    expect(() => logEvent("startup", "x")).not.toThrow();
  });
});
