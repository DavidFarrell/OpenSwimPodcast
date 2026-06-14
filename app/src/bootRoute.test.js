import { describe, it, expect } from "vitest";
import {
  loadBootRoute, saveRoute,
  ROUTE_KEY, BOOT_ROUTE,
} from "./bootRoute.js";

function fakeStorage(initial = {}) {
  const map = new Map(Object.entries(initial));
  return {
    getItem: (k) => (map.has(k) ? map.get(k) : null),
    setItem: (k, v) => map.set(k, String(v)),
    removeItem: (k) => map.delete(k),
    _map: map,
  };
}

describe("bootRoute - always boots to the queue (Fix 2)", () => {
  it("boots to 'up-next' when nothing is stored", () => {
    expect(loadBootRoute(fakeStorage())).toBe("up-next");
    expect(BOOT_ROUTE).toBe("up-next");
  });

  it("boots to 'up-next' REGARDLESS of a stored os_route (never restores a saved route)", () => {
    // The whole point of the fix: a stored transient route must NOT be the boot
    // landing screen.
    for (const stored of ["syncing", "today", "up-next", "anything"]) {
      const s = fakeStorage({ [ROUTE_KEY]: stored });
      expect(loadBootRoute(s)).toBe("up-next");
    }
  });

  it("boots to 'up-next' even with no storage available", () => {
    expect(loadBootRoute(null)).toBe("up-next");
    expect(loadBootRoute(undefined)).toBe("up-next");
  });

  it("uses the os_route storage key", () => {
    expect(ROUTE_KEY).toBe("os_route");
  });
});

describe("bootRoute - within-session persistence", () => {
  it("saves the current route so the stored value reflects the live route", () => {
    const s = fakeStorage();
    saveRoute("today", s);
    expect(s.getItem(ROUTE_KEY)).toBe("today");
    // ...but a later boot still ignores it.
    expect(loadBootRoute(s)).toBe("up-next");
  });

  it("ignores a blank / non-string route on save", () => {
    const s = fakeStorage();
    saveRoute("", s);
    saveRoute(null, s);
    saveRoute(undefined, s);
    expect(s.getItem(ROUTE_KEY)).toBeNull();
  });

  it("does not throw when storage is missing or throws on save", () => {
    expect(() => saveRoute("today", null)).not.toThrow();
    const bad = { setItem: () => { throw new Error("full"); } };
    expect(() => saveRoute("today", bad)).not.toThrow();
  });
});
