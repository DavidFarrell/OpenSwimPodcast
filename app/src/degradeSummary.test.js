import { describe, it, expect } from "vitest";
import { degradeSummary } from "./degradeSummary.js";

describe("degradeSummary - incomplete-detection warning text", () => {
  it("returns empty string when not degraded", () => {
    expect(degradeSummary({ degraded: false, windowsFailed: 0, windowsRun: 4 })).toBe("");
    expect(degradeSummary(null)).toBe("");
    expect(degradeSummary(undefined)).toBe("");
    expect(degradeSummary({})).toBe("");
  });

  it("names ONE failed section (singular) when a single window failed", () => {
    const text = degradeSummary({ degraded: true, windowsFailed: 1, windowsRun: 6 });
    expect(text).toContain("1 of 6 sections");
    expect(text).toContain("cuts shown may be missing some ads");
    // Plain declarative, no em dash.
    expect(text).not.toContain("—");
  });

  it("names MANY failed sections when several windows failed", () => {
    const text = degradeSummary({ degraded: true, windowsFailed: 3, windowsRun: 5 });
    expect(text).toContain("3 of 5 sections");
  });

  it("uses a singular total ('1 of 1 section') without an erroneous plural", () => {
    const text = degradeSummary({ degraded: true, windowsFailed: 1, windowsRun: 1 });
    expect(text).toContain("1 of 1 section");
    expect(text).not.toContain("1 of 1 sections");
  });

  it("falls back to a generic warning when degraded but no usable counts", () => {
    const text = degradeSummary({ degraded: true, windowsFailed: 0, windowsRun: 0 });
    expect(text).toContain("could not read part of this episode");
    expect(text).toContain("missing some ads");
  });

  it("degrades to 'N sections' when the run total is missing or smaller than failed", () => {
    // windowsRun unknown -> do not fabricate an 'of M'.
    expect(degradeSummary({ degraded: true, windowsFailed: 2 })).toContain("2 sections");
    // A nonsense total (< failed) is dropped rather than printing '2 of 1'.
    expect(degradeSummary({ degraded: true, windowsFailed: 2, windowsRun: 1 })).toContain("2 sections");
    expect(degradeSummary({ degraded: true, windowsFailed: 2, windowsRun: 1 })).not.toContain("2 of 1");
  });
});
