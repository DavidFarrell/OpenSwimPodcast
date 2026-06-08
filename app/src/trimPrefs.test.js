import { describe, it, expect } from "vitest";
import {
  loadTrimGlobal, saveTrimGlobal,
  loadTrimOff, saveTrimOff,
  effectiveTrim,
  GLOBAL_KEY, OFF_KEY,
} from "./trimPrefs.js";

function fakeStorage(initial = {}) {
  const map = new Map(Object.entries(initial));
  return {
    getItem: (k) => (map.has(k) ? map.get(k) : null),
    setItem: (k, v) => map.set(k, String(v)),
    removeItem: (k) => map.delete(k),
    _map: map,
  };
}

describe("trimPrefs - global toggle persistence", () => {
  it("round-trips the universal toggle through storage like speed/boost/announce", () => {
    const s = fakeStorage();
    expect(loadTrimGlobal(s)).toBe(false);
    saveTrimGlobal(true, s);
    expect(s.getItem(GLOBAL_KEY)).toBe("1");
    expect(loadTrimGlobal(s)).toBe(true);
    saveTrimGlobal(false, s);
    expect(s.getItem(GLOBAL_KEY)).toBe("0");
    expect(loadTrimGlobal(s)).toBe(false);
  });

  it("uses a distinct storage key from announce so the two toggles never collide", () => {
    expect(GLOBAL_KEY).toBe("os_trim");
    expect(OFF_KEY).toBe("os_trimOff");
  });
});

describe("trimPrefs - per-episode OFF overrides persistence", () => {
  it("round-trips the OFF set as a JSON array", () => {
    const s = fakeStorage();
    expect(loadTrimOff(s).size).toBe(0);
    const set = new Set(["uuid-a", "uuid-b"]);
    saveTrimOff(set, s);
    expect(JSON.parse(s.getItem(OFF_KEY))).toEqual(["uuid-a", "uuid-b"]);
    const back = loadTrimOff(s);
    expect(back.has("uuid-a")).toBe(true);
    expect(back.has("uuid-b")).toBe(true);
    expect(back.has("uuid-c")).toBe(false);
  });

  it("tolerates corrupt storage without throwing", () => {
    const s = fakeStorage({ [OFF_KEY]: "{not json" });
    expect(loadTrimOff(s).size).toBe(0);
  });

  it("drops non-string entries from a tampered array", () => {
    const s = fakeStorage({ [OFF_KEY]: JSON.stringify(["ok", 5, null, { x: 1 }]) });
    const back = loadTrimOff(s);
    expect(Array.from(back)).toEqual(["ok"]);
  });
});

describe("trimPrefs - effectiveTrim resolver", () => {
  const off = new Set(["disabled-uuid"]);

  it("trims an episode when the global toggle is on and no override", () => {
    expect(effectiveTrim("ep1", true, off)).toBe(true);
  });

  it("honours a per-episode OFF override even when global is on (off-intent fix)", () => {
    // Regression / CARDINAL RULE alignment: a per-episode disable MUST win.
    // Old buggy behaviour that let a global ON override the per-episode OFF
    // would return true here and risk cutting an episode the user opted out of.
    expect(effectiveTrim("disabled-uuid", true, off)).toBe(false);
  });

  it("trims nothing when the global toggle is off, overrides notwithstanding", () => {
    expect(effectiveTrim("ep1", false, off)).toBe(false);
    expect(effectiveTrim("disabled-uuid", false, off)).toBe(false);
  });

  it("never trims an episode with no uuid", () => {
    expect(effectiveTrim(undefined, true, off)).toBe(false);
    expect(effectiveTrim("", true, off)).toBe(false);
  });

  it("tolerates a missing off set", () => {
    expect(effectiveTrim("ep1", true, undefined)).toBe(true);
    expect(effectiveTrim("ep1", true, null)).toBe(true);
  });
});
