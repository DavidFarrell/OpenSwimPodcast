import { describe, it, expect } from "vitest";
import { paintDecision } from "./dragPaint.js";

describe("paintDecision", () => {
  it("SELECT-paint: toggles a currently-grey line, leaves an already-selected line alone", () => {
    // paint wants selected=true.
    expect(paintDecision(false, true)).toBe(true);  // grey -> needs toggle to become selected
    expect(paintDecision(true, true)).toBe(false);  // already selected -> no toggle
  });

  it("DESELECT-paint: toggles a currently-selected line, leaves an already-grey line alone", () => {
    // paint wants selected=false.
    expect(paintDecision(true, false)).toBe(true);  // selected -> needs toggle to become grey
    expect(paintDecision(false, false)).toBe(false); // already grey -> no toggle
  });
});
