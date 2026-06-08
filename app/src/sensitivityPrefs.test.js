import { describe, it, expect } from "vitest";
import {
  loadSensitivity, saveSensitivity, thresholdSecFor, loadThresholdSec,
  KEY, DEFAULT_SENSITIVITY, DEFAULT_THRESHOLD_SEC,
  SENSITIVITY_THRESHOLDS, SENSITIVITY_OPTIONS,
} from "./sensitivityPrefs.js";

function fakeStorage(initial = {}) {
  const map = new Map(Object.entries(initial));
  return {
    getItem: (k) => (map.has(k) ? map.get(k) : null),
    setItem: (k, v) => map.set(k, String(v)),
    removeItem: (k) => map.delete(k),
    _map: map,
  };
}

describe("sensitivityPrefs - default", () => {
  it("defaults to balanced when nothing is stored", () => {
    expect(loadSensitivity(fakeStorage())).toBe("balanced");
    expect(DEFAULT_SENSITIVITY).toBe("balanced");
  });

  it("balanced maps to the LOCKED default threshold", () => {
    expect(DEFAULT_THRESHOLD_SEC).toBe(150);
    expect(thresholdSecFor("balanced")).toBe(150);
    expect(SENSITIVITY_THRESHOLDS.balanced).toBe(DEFAULT_THRESHOLD_SEC);
  });

  it("offers conservative first so the safest choice reads first", () => {
    expect(SENSITIVITY_OPTIONS[0]).toBe("conservative");
    expect(SENSITIVITY_OPTIONS).toEqual(["conservative", "balanced", "aggressive"]);
  });

  it("uses a distinct storage key", () => {
    expect(KEY).toBe("os_sensitivity");
  });
});

describe("sensitivityPrefs - cardinal ordering", () => {
  // The invariant of this whole feature: conservative flags MORE (lower
  // threshold), aggressive flags LESS (higher threshold).
  it("orders thresholds conservative < balanced < aggressive", () => {
    const c = thresholdSecFor("conservative");
    const b = thresholdSecFor("balanced");
    const a = thresholdSecFor("aggressive");
    expect(c).toBeLessThan(b);
    expect(b).toBeLessThan(a);
  });

  it("every threshold is finite and positive (never disables the check)", () => {
    for (const level of SENSITIVITY_OPTIONS) {
      const sec = thresholdSecFor(level);
      expect(Number.isFinite(sec)).toBe(true);
      expect(sec).toBeGreaterThan(0);
    }
  });
});

describe("sensitivityPrefs - persistence", () => {
  it("round-trips a chosen level", () => {
    const s = fakeStorage();
    saveSensitivity("conservative", s);
    expect(s.getItem(KEY)).toBe("conservative");
    expect(loadSensitivity(s)).toBe("conservative");
  });

  it("reads back a pre-existing stored level", () => {
    const s = fakeStorage({ [KEY]: "aggressive" });
    expect(loadSensitivity(s)).toBe("aggressive");
  });

  it("normalises case / whitespace", () => {
    const s = fakeStorage();
    saveSensitivity("  Aggressive  ", s);
    expect(s.getItem(KEY)).toBe("aggressive");
    expect(loadSensitivity(s)).toBe("aggressive");
  });

  it("loadThresholdSec resolves storage to the threshold in seconds", () => {
    expect(loadThresholdSec(fakeStorage({ [KEY]: "conservative" }))).toBe(90);
    expect(loadThresholdSec(fakeStorage({ [KEY]: "aggressive" }))).toBe(240);
    expect(loadThresholdSec(fakeStorage())).toBe(DEFAULT_THRESHOLD_SEC);
  });
});

describe("sensitivityPrefs - safe degradation", () => {
  it("falls back to the default on a blank stored value", () => {
    expect(loadSensitivity(fakeStorage({ [KEY]: "   " }))).toBe(DEFAULT_SENSITIVITY);
  });

  it("falls back to the default on an unknown stored value", () => {
    expect(loadSensitivity(fakeStorage({ [KEY]: "yolo" }))).toBe(DEFAULT_SENSITIVITY);
  });

  it("resets an unknown / blank / non-string save to the default", () => {
    const s = fakeStorage();
    saveSensitivity("nonsense", s);
    expect(s.getItem(KEY)).toBe(DEFAULT_SENSITIVITY);
    saveSensitivity("", s);
    expect(s.getItem(KEY)).toBe(DEFAULT_SENSITIVITY);
    saveSensitivity(null, s);
    expect(s.getItem(KEY)).toBe(DEFAULT_SENSITIVITY);
    saveSensitivity(undefined, s);
    expect(s.getItem(KEY)).toBe(DEFAULT_SENSITIVITY);
  });

  it("thresholdSecFor maps unknown / blank levels to the locked default", () => {
    expect(thresholdSecFor("yolo")).toBe(DEFAULT_THRESHOLD_SEC);
    expect(thresholdSecFor("")).toBe(DEFAULT_THRESHOLD_SEC);
    expect(thresholdSecFor(null)).toBe(DEFAULT_THRESHOLD_SEC);
    expect(thresholdSecFor(undefined)).toBe(DEFAULT_THRESHOLD_SEC);
  });

  it("returns the default when no storage is available", () => {
    expect(loadSensitivity(null)).toBe(DEFAULT_SENSITIVITY);
  });

  it("does not throw when storage is missing on save", () => {
    expect(() => saveSensitivity("conservative", null)).not.toThrow();
  });

  it("tolerates a storage that throws on getItem", () => {
    const s = { getItem: () => { throw new Error("boom"); }, setItem: () => {} };
    expect(loadSensitivity(s)).toBe(DEFAULT_SENSITIVITY);
  });
});
