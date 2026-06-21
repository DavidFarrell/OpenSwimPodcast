import { describe, it, expect } from "vitest";
import { sendDisabled, sendLabel } from "./sendGate.js";

// Behaviour #1 (required): SEND is ENABLED with no device when the queue is
// non-empty and downloads are terminal. This is the heart of slice 5 - the old
// gate had a `!devicePath` clause that this proves is gone. The function takes no
// device argument at all, so a regression that re-adds the device gate would have
// to change this signature and break these tests.
describe("sendDisabled - device no longer gates SEND", () => {
  it("ENABLED with no device when queue non-empty and downloads terminal", () => {
    expect(sendDisabled({ downloadsPending: 0, queueLength: 3 })).toBe(false);
  });

  // Behaviour #3 (gate side): device-present flow unchanged. With downloads
  // terminal + a non-empty queue, SEND is enabled - exactly as before, whether or
  // not a device is attached (the function is device-blind, so both cases are this
  // one assertion).
  it("ENABLED with the same inputs whether or not a device is present (device-blind)", () => {
    expect(sendDisabled({ downloadsPending: 0, queueLength: 1 })).toBe(false);
  });

  it("DISABLED while any download is still in flight", () => {
    expect(sendDisabled({ downloadsPending: 2, queueLength: 3 })).toBe(true);
  });

  it("DISABLED when the queue is empty", () => {
    expect(sendDisabled({ downloadsPending: 0, queueLength: 0 })).toBe(true);
  });

  it("DISABLED when both pending downloads and empty queue", () => {
    expect(sendDisabled({ downloadsPending: 1, queueLength: 0 })).toBe(true);
  });

  it("defaults to disabled on empty/absent input (safe default)", () => {
    expect(sendDisabled()).toBe(true);
    expect(sendDisabled({})).toBe(true);
  });
});

describe("sendLabel - plain, device-agnostic copy", () => {
  it("shows the SEND label with the episode count when ready (no device wording)", () => {
    expect(sendLabel({ downloadsPending: 0, queueLength: 4 })).toBe("SEND · 4 EP");
  });

  it("shows the download-wait label while downloads pend", () => {
    expect(sendLabel({ downloadsPending: 1, queueLength: 0 })).toBe("WAITING FOR 1 DOWNLOAD");
    expect(sendLabel({ downloadsPending: 3, queueLength: 0 })).toBe("WAITING FOR 3 DOWNLOADS");
  });

  it("shows nothing-lined-up when the queue is empty and downloads terminal", () => {
    expect(sendLabel({ downloadsPending: 0, queueLength: 0 })).toBe("NOTHING LINED UP");
  });

  it("never emits a NO HEADPHONES label (no device clause)", () => {
    const labels = [
      sendLabel({ downloadsPending: 0, queueLength: 2 }),
      sendLabel({ downloadsPending: 0, queueLength: 0 }),
      sendLabel({ downloadsPending: 1, queueLength: 0 }),
    ];
    for (const l of labels) expect(l).not.toMatch(/headphone/i);
  });
});
