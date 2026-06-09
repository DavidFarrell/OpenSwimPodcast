import { describe, it, expect } from "vitest";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const { repairedPath, knownDirs } = require("./fixEnv.cjs");

describe("fixEnv repairedPath()", () => {
  it("prepends the well-known macOS bin dirs a Finder launch misses", () => {
    const out = repairedPath("/usr/bin:/bin").split(":");
    // The homebrew bin (where uv lives) must be present and ahead of /usr/bin.
    expect(out).toContain("/opt/homebrew/bin");
    expect(out.indexOf("/opt/homebrew/bin")).toBeLessThan(out.indexOf("/usr/bin"));
  });

  it("preserves the existing PATH entries (never drops them)", () => {
    const out = repairedPath("/usr/bin:/bin:/sbin").split(":");
    expect(out).toContain("/usr/bin");
    expect(out).toContain("/bin");
    expect(out).toContain("/sbin");
  });

  it("de-duplicates while preserving first-seen order", () => {
    const out = repairedPath("/opt/homebrew/bin:/usr/bin:/opt/homebrew/bin").split(":");
    const occurrences = out.filter((d) => d === "/opt/homebrew/bin").length;
    expect(occurrences).toBe(1);
  });

  it("handles an empty / missing current PATH without throwing", () => {
    expect(() => repairedPath("")).not.toThrow();
    expect(() => repairedPath(undefined)).not.toThrow();
    const out = repairedPath("");
    expect(out).toContain("/opt/homebrew/bin");
  });

  it("knownDirs() includes the user-local bin under HOME", () => {
    const dirs = knownDirs();
    expect(dirs.some((d) => d.endsWith("/.local/bin"))).toBe(true);
  });
});
