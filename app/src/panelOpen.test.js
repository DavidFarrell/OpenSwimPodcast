import { describe, it, expect } from "vitest";
import { shouldCaptureOnOpen, nextOpenSet } from "./panelOpen.js";
import { snapshotInitial } from "./reviewCapture.js";
import { sentenceLines } from "./transcriptToggle.js";

describe("shouldCaptureOnOpen - the once-per-episode guard", () => {
  it("is true the FIRST time a uuid is opened", () => {
    expect(shouldCaptureOnOpen(new Set(), "ep-a")).toBe(true);
  });
  it("is false once the uuid is already reviewed (a re-open after a close)", () => {
    expect(shouldCaptureOnOpen(new Set(["ep-a"]), "ep-a")).toBe(false);
  });
  it("is false for a missing uuid (no capture for nothing)", () => {
    expect(shouldCaptureOnOpen(new Set(), "")).toBe(false);
    expect(shouldCaptureOnOpen(new Set(), undefined)).toBe(false);
  });
  it("accepts an array-like reviewed set without throwing", () => {
    expect(shouldCaptureOnOpen(["ep-a"], "ep-a")).toBe(false);
    expect(shouldCaptureOnOpen(["ep-a"], "ep-b")).toBe(true);
  });
});

describe("nextOpenSet - open-set follows the toggle, never mutates the input", () => {
  it("open adds the uuid", () => {
    expect([...nextOpenSet(new Set(), "ep-a", true)]).toEqual(["ep-a"]);
  });
  it("close removes the uuid", () => {
    expect([...nextOpenSet(new Set(["ep-a", "ep-b"]), "ep-a", false)]).toEqual(["ep-b"]);
  });
  it("returns a NEW Set (the previous state is untouched)", () => {
    const cur = new Set(["ep-a"]);
    const next = nextOpenSet(cur, "ep-b", true);
    expect(next).not.toBe(cur);
    expect([...cur]).toEqual(["ep-a"]); // input unchanged
    expect([...next].sort()).toEqual(["ep-a", "ep-b"]);
  });
  it("a no-op toggle (re-open an open one) is harmless and idempotent", () => {
    expect([...nextOpenSet(new Set(["ep-a"]), "ep-a", true)]).toEqual(["ep-a"]);
  });
  it("a missing uuid is ignored", () => {
    expect([...nextOpenSet(new Set(["ep-a"]), "", true)]).toEqual(["ep-a"]);
  });
});

// A FAITHFUL simulation of SyncScreen's ensurePanelOpen / onPanelToggle, built from the
// SAME pure pieces the component wires (shouldCaptureOnOpen + snapshotInitial +
// nextOpenSet). Proving the semantics here means proving them for the component - the
// only thing the React layer adds is setState plumbing the helpers already model. This
// is where the slice's two load-bearing guarantees live: capture fires EXACTLY ONCE
// per episode, and the snapshot is frozen at FIRST open before any selection mutation.
function makeGate(items) {
  // The capture-tracking state, exactly as SyncScreen holds it (refs there, plain here).
  const reviewed = new Set();
  const snapshots = {};
  const openedAt = {};
  let captureCalls = 0; // how many times the snapshot path actually ran
  let openUuids = new Set();
  let clock = 1000;

  const ensurePanelOpen = (uuid) => {
    if (!uuid) return;
    if (shouldCaptureOnOpen(reviewed, uuid)) {
      reviewed.add(uuid);
      openedAt[uuid] = clock++;
      captureCalls++;
      const item = items.find((it) => it.uuid === uuid);
      if (item) {
        const lines = sentenceLines({ segments: item.segments || [] });
        snapshots[uuid] = snapshotInitial({ lines, cuts: item.cuts || [] });
      }
    }
    openUuids = nextOpenSet(openUuids, uuid, true);
  };
  const onPanelToggle = (uuid, isOpen) => {
    if (isOpen) ensurePanelOpen(uuid);
    else openUuids = nextOpenSet(openUuids, uuid, false);
  };

  return {
    onPanelToggle,
    state: () => ({ reviewed, snapshots, openedAt, captureCalls, openUuids }),
  };
}

const segments = [
  { start: 0, end: 30, text: "Welcome to the show.", speaker: "S1" },
  { start: 600, end: 660, text: "Sponsored by Acme.", speaker: "S1" },
  { start: 660, end: 700, text: "Acme makes widgets.", speaker: "S1" },
  { start: 720, end: 760, text: "Back to it.", speaker: "S2" },
];
const cuts = [{ cutId: "ad1", startSec: 600, endSec: 700, needsReview: false, label: "ad" }];
const items = [{ uuid: "ep-a", title: "Ep A", segments, cuts }];

describe("capture idempotence across open -> close -> open", () => {
  it("first open captures once, marks reviewed, and opens the panel", () => {
    const gate = makeGate(items);
    gate.onPanelToggle("ep-a", true);
    const s = gate.state();
    expect(s.captureCalls).toBe(1);
    expect(s.reviewed.has("ep-a")).toBe(true);
    expect(s.snapshots["ep-a"]).toBeTruthy();
    expect([...s.openUuids]).toEqual(["ep-a"]);
  });

  it("a CLOSE removes the uuid from the open-set but does NOT un-review or re-capture", () => {
    const gate = makeGate(items);
    gate.onPanelToggle("ep-a", true);
    gate.onPanelToggle("ep-a", false);
    const s = gate.state();
    expect(s.captureCalls).toBe(1);          // still one
    expect(s.reviewed.has("ep-a")).toBe(true); // still reviewed
    expect([...s.openUuids]).toEqual([]);      // but closed
  });

  it("re-opening after a close does NOT re-capture (EXACTLY ONE capture across the sequence)", () => {
    const gate = makeGate(items);
    gate.onPanelToggle("ep-a", true);  // open  -> capture
    gate.onPanelToggle("ep-a", false); // close
    gate.onPanelToggle("ep-a", true);  // open again -> NO capture
    const s = gate.state();
    expect(s.captureCalls).toBe(1);
    expect([...s.openUuids]).toEqual(["ep-a"]);
  });
});

describe("snapshot timing - frozen at FIRST open, before any selection mutation", () => {
  it("the snapshot reflects the detector proposal at first open", () => {
    const gate = makeGate(items);
    gate.onPanelToggle("ep-a", true);
    const snap = gate.state().snapshots["ep-a"];
    // The confident ad cut (lines 1,2) is preselected; lines 0,3 are content.
    expect(snap.preselect).toEqual([1, 2]);
    expect(snap.held).toEqual([]);
  });

  it("a later open (re-entry) reuses the first snapshot - a mutated proposal cannot overwrite it", () => {
    // Mutating the source item AFTER the first open must not change the frozen snapshot
    // (snapshotInitial deep-clones), and a re-open never re-snapshots anyway.
    const localItems = [{ uuid: "ep-a", title: "Ep A", segments: segments.map((s) => ({ ...s })), cuts: [{ ...cuts[0] }] }];
    const gate = makeGate(localItems);
    gate.onPanelToggle("ep-a", true);
    const first = gate.state().snapshots["ep-a"];
    // Tamper with the live item, then close + re-open.
    localItems[0].cuts[0].startSec = 0;
    localItems[0].cuts[0].endSec = 30;
    gate.onPanelToggle("ep-a", false);
    gate.onPanelToggle("ep-a", true);
    const after = gate.state().snapshots["ep-a"];
    expect(after).toBe(first);            // same frozen object, never rebuilt
    expect(after.preselect).toEqual([1, 2]); // still the original proposal
  });
});

describe("multi-episode - each episode captures once, independently", () => {
  const two = [
    { uuid: "ep-a", segments, cuts },
    { uuid: "ep-b", segments, cuts },
  ];
  it("opening two different panels captures each once; the open-set holds both", () => {
    const gate = makeGate(two);
    gate.onPanelToggle("ep-a", true);
    gate.onPanelToggle("ep-b", true);
    const s = gate.state();
    expect(s.captureCalls).toBe(2);
    expect([...s.openUuids].sort()).toEqual(["ep-a", "ep-b"]);
    expect(s.reviewed.has("ep-a")).toBe(true);
    expect(s.reviewed.has("ep-b")).toBe(true);
  });
});
