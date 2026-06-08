import { describe, it, expect } from "vitest";
import {
  loadAnnounceGlobal, saveAnnounceGlobal,
  loadAnnounceOff, saveAnnounceOff,
  effectiveAnnounce,
  GLOBAL_KEY, OFF_KEY,
} from "./announcePrefs.js";

function fakeStorage(initial = {}) {
  const map = new Map(Object.entries(initial));
  return {
    getItem: (k) => (map.has(k) ? map.get(k) : null),
    setItem: (k, v) => map.set(k, String(v)),
    removeItem: (k) => map.delete(k),
    _map: map,
  };
}

describe("announcePrefs - global toggle persistence", () => {
  it("round-trips the universal toggle through storage like speed/boost", () => {
    const s = fakeStorage();
    expect(loadAnnounceGlobal(s)).toBe(false);
    saveAnnounceGlobal(true, s);
    expect(s.getItem(GLOBAL_KEY)).toBe("1");
    expect(loadAnnounceGlobal(s)).toBe(true);
    saveAnnounceGlobal(false, s);
    expect(s.getItem(GLOBAL_KEY)).toBe("0");
    expect(loadAnnounceGlobal(s)).toBe(false);
  });
});

describe("announcePrefs - per-episode OFF overrides persistence", () => {
  it("round-trips the OFF set as a JSON array", () => {
    const s = fakeStorage();
    expect(loadAnnounceOff(s).size).toBe(0);
    const set = new Set(["uuid-a", "uuid-b"]);
    saveAnnounceOff(set, s);
    expect(JSON.parse(s.getItem(OFF_KEY))).toEqual(["uuid-a", "uuid-b"]);
    const back = loadAnnounceOff(s);
    expect(back.has("uuid-a")).toBe(true);
    expect(back.has("uuid-b")).toBe(true);
    expect(back.has("uuid-c")).toBe(false);
  });

  it("tolerates corrupt storage without throwing", () => {
    const s = fakeStorage({ [OFF_KEY]: "{not json" });
    expect(loadAnnounceOff(s).size).toBe(0);
  });
});

describe("announcePrefs - effectiveAnnounce resolver", () => {
  const off = new Set(["disabled-uuid"]);

  it("announces an episode when the global toggle is on and no override", () => {
    expect(effectiveAnnounce("ep1", true, off)).toBe(true);
  });

  it("honours a per-episode OFF override even when global is on (S5 off-intent fix)", () => {
    // Regression: a per-episode disable MUST win. Old buggy behaviour that let a
    // global ON override the per-episode OFF would return true here.
    expect(effectiveAnnounce("disabled-uuid", true, off)).toBe(false);
  });

  it("announces nothing when the global toggle is off, overrides notwithstanding", () => {
    expect(effectiveAnnounce("ep1", false, off)).toBe(false);
    expect(effectiveAnnounce("disabled-uuid", false, off)).toBe(false);
  });

  it("never announces an episode with no uuid", () => {
    expect(effectiveAnnounce(undefined, true, off)).toBe(false);
    expect(effectiveAnnounce("", true, off)).toBe(false);
  });
});
