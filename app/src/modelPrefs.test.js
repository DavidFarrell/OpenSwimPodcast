import { describe, it, expect } from "vitest";
import {
  loadModel, saveModel,
  KEY, DEFAULT_MODEL, MODEL_OPTIONS,
} from "./modelPrefs.js";

function fakeStorage(initial = {}) {
  const map = new Map(Object.entries(initial));
  return {
    getItem: (k) => (map.has(k) ? map.get(k) : null),
    setItem: (k, v) => map.set(k, String(v)),
    removeItem: (k) => map.delete(k),
    _map: map,
  };
}

describe("modelPrefs - default", () => {
  it("defaults to the LOCKED gemma-4-12b-qat model when nothing is stored", () => {
    const s = fakeStorage();
    expect(loadModel(s)).toBe("google/gemma-4-12b-qat");
    expect(DEFAULT_MODEL).toBe("google/gemma-4-12b-qat");
  });

  it("offers the default as the first pulldown option", () => {
    expect(MODEL_OPTIONS[0]).toBe(DEFAULT_MODEL);
  });

  it("uses a distinct storage key so it never collides with other prefs", () => {
    expect(KEY).toBe("os_model");
  });
});

describe("modelPrefs - persistence", () => {
  it("round-trips a chosen model id through storage", () => {
    const s = fakeStorage();
    saveModel("qwen/qwen3-14b", s);
    expect(s.getItem(KEY)).toBe("qwen/qwen3-14b");
    expect(loadModel(s)).toBe("qwen/qwen3-14b");
  });

  it("reads back a pre-existing stored model id", () => {
    const s = fakeStorage({ [KEY]: "google/gemma-2-27b-it" });
    expect(loadModel(s)).toBe("google/gemma-2-27b-it");
  });

  it("trims whitespace around a stored / saved id", () => {
    const s = fakeStorage();
    saveModel("  qwen/qwen3-14b  ", s);
    expect(s.getItem(KEY)).toBe("qwen/qwen3-14b");
    expect(loadModel(s)).toBe("qwen/qwen3-14b");
  });
});

describe("modelPrefs - safe degradation", () => {
  it("falls back to the default when the stored value is blank", () => {
    const s = fakeStorage({ [KEY]: "   " });
    expect(loadModel(s)).toBe(DEFAULT_MODEL);
  });

  it("resets a blank / non-string save to the default, never an empty id", () => {
    const s = fakeStorage();
    saveModel("", s);
    expect(s.getItem(KEY)).toBe(DEFAULT_MODEL);
    saveModel(null, s);
    expect(s.getItem(KEY)).toBe(DEFAULT_MODEL);
    saveModel(undefined, s);
    expect(s.getItem(KEY)).toBe(DEFAULT_MODEL);
  });

  it("returns the default when no storage is available", () => {
    expect(loadModel(null)).toBe(DEFAULT_MODEL);
  });

  it("does not throw when storage is missing on save", () => {
    expect(() => saveModel("qwen/qwen3-14b", null)).not.toThrow();
  });

  it("tolerates a storage that throws on getItem", () => {
    const s = { getItem: () => { throw new Error("boom"); }, setItem: () => {} };
    expect(loadModel(s)).toBe(DEFAULT_MODEL);
  });
});
