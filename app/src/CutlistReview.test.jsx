import { describe, it, expect, vi } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import { CutlistReview } from "./CutlistReview.jsx";

const clean = { startSec: 0, endSec: 30, needsReview: false, reasons: [], label: "intro" };
const flaggedMid = { startSec: 1390, endSec: 1445, needsReview: true, reasons: ["over-threshold"], label: "ad" };
const flaggedAmb = { startSec: 600, endSec: 712, needsReview: true, reasons: ["ambiguous-boundary"], label: "ad" };

// Walk a React element tree collecting every node that matches a predicate. Used
// to reach the keep/remove buttons and fire their onClick without a DOM, so the
// decision-recording path is exercised for real.
function walk(node, pred, out = []) {
  if (node == null || typeof node === "boolean") return out;
  if (Array.isArray(node)) { node.forEach((n) => walk(n, pred, out)); return out; }
  if (typeof node === "object" && node.props) {
    if (pred(node)) out.push(node);
    walk(node.props.children, pred, out);
  }
  return out;
}

// Render a component element to its element tree (call the function component so
// we can inspect the returned tree, since there is no test renderer dep).
function renderTree(el) {
  if (typeof el.type === "function") return el.type(el.props);
  return el;
}

describe("CutlistReview - flagged-only render", () => {
  it("renders NOTHING when there are no flagged cuts (clean cuts auto-applied)", () => {
    const html = renderToStaticMarkup(
      <CutlistReview uuid="e1" trimEntry={{ status: "ready", cuts: [clean] }} />
    );
    expect(html).toBe("");
  });

  it("renders nothing for an episode with no cuts at all", () => {
    expect(renderToStaticMarkup(<CutlistReview uuid="e1" trimEntry={{ cuts: [] }} />)).toBe("");
    expect(renderToStaticMarkup(<CutlistReview uuid="e1" trimEntry={undefined} />)).toBe("");
  });

  it("renders a row per flagged cut with headline, reason and keep/remove controls", () => {
    const html = renderToStaticMarkup(
      <CutlistReview uuid="e1"
        trimEntry={{ status: "needs-review", cuts: [clean, flaggedMid, flaggedAmb] }} />
    );
    // The clean cut is NOT shown; both flagged cuts are.
    expect(html).toContain("Mid-roll 23:10-24:05");
    expect(html).toContain("Mid-roll 10:00-11:52");
    expect(html).toContain("safe auto-cut length");
    expect(html).toContain("KEEP");
    expect(html).toContain("REMOVE");
    expect(html).toContain("2 cuts need a decision");
    // Default decision is keep (cardinal rule) - the keep button is pressed.
    expect(html).toContain('data-decision="keep"');
  });

  it("reflects a recorded remove decision in the rendered state", () => {
    const html = renderToStaticMarkup(
      <CutlistReview uuid="e1"
        trimEntry={{ status: "needs-review", cuts: [flaggedMid] }}
        decisions={{ "1390000-1445000": "remove" }} />
    );
    expect(html).toContain('data-decision="remove"');
  });
});

describe("CutlistReview - decision recording", () => {
  function buttonsFor(decisions = {}) {
    const onDecide = vi.fn();
    const tree = renderTree(
      <CutlistReview uuid="ep-x"
        trimEntry={{ status: "needs-review", cuts: [flaggedMid] }}
        decisions={decisions} onDecide={onDecide} />
    );
    const keep = walk(tree, (n) => n.props && n.props.className && /cutlist-review__keep/.test(n.props.className))[0];
    const remove = walk(tree, (n) => n.props && n.props.className && /cutlist-review__remove/.test(n.props.className))[0];
    return { onDecide, keep, remove };
  }

  it("REMOVE records a remove decision for the cut", () => {
    const { onDecide, remove } = buttonsFor();
    remove.props.onClick();
    expect(onDecide).toHaveBeenCalledTimes(1);
    expect(onDecide).toHaveBeenCalledWith("ep-x", flaggedMid, "remove");
  });

  it("KEEP records a keep decision for the cut", () => {
    const { onDecide, keep } = buttonsFor();
    keep.props.onClick();
    expect(onDecide).toHaveBeenCalledWith("ep-x", flaggedMid, "keep");
  });

  it("does not throw when no onDecide handler is wired", () => {
    const tree = renderTree(
      <CutlistReview uuid="ep-x" trimEntry={{ status: "needs-review", cuts: [flaggedMid] }} />
    );
    const remove = walk(tree, (n) => n.props && n.props.className && /cutlist-review__remove/.test(n.props.className))[0];
    expect(() => remove.props.onClick()).not.toThrow();
  });
});

describe("CutlistReview - P3b boundary edit controls", () => {
  function findByClass(tree, re) {
    return walk(tree, (n) => n.props && n.props.className && re.test(n.props.className))[0];
  }
  function setup(decisions = {}) {
    const onEditCut = vi.fn();
    const tree = renderTree(
      <CutlistReview uuid="ep-x"
        trimEntry={{ status: "needs-review", cuts: [flaggedMid] }}
        decisions={decisions} onEditCut={onEditCut} />
    );
    return { onEditCut, tree };
  }

  it("-5s on start records an edited cut with start moved 5s earlier", () => {
    const { onEditCut, tree } = setup();
    findByClass(tree, /cutlist-review__start-minus/).props.onClick();
    expect(onEditCut).toHaveBeenCalledTimes(1);
    const [uuid, orig, next] = onEditCut.mock.calls[0];
    expect(uuid).toBe("ep-x");
    expect(orig).toBe(flaggedMid);
    expect(next.startSec).toBe(1385); // 1390 - 5
    expect(next.endSec).toBe(1445);
  });

  it("+5s on end records an edited cut with end moved 5s later", () => {
    const { onEditCut, tree } = setup();
    findByClass(tree, /cutlist-review__end-plus/).props.onClick();
    expect(onEditCut.mock.calls[0][2].endSec).toBe(1450); // 1445 + 5
  });

  it("typing a new start timestamp records the edited boundary", () => {
    const { onEditCut, tree } = setup();
    const input = findByClass(tree, /cutlist-review__start-input/);
    input.props.onBlur({ target: { value: "23:00" } }); // 1380s
    expect(onEditCut).toHaveBeenCalledTimes(1);
    expect(onEditCut.mock.calls[0][2].startSec).toBe(1380);
  });

  it("CARDINAL: an inverting typed start is rejected (no edit recorded, field reset)", () => {
    const { onEditCut, tree } = setup();
    const input = findByClass(tree, /cutlist-review__start-input/);
    const target = { value: "30:00" }; // 1800s, past end 1445 - inverts
    input.props.onBlur({ target });
    expect(onEditCut).not.toHaveBeenCalled();
    expect(target.value).toBe("23:10"); // reset to the cut's real start (1390s)
  });

  it("an unparseable typed value is rejected and the field reset", () => {
    const { onEditCut, tree } = setup();
    const input = findByClass(tree, /cutlist-review__end-input/);
    const target = { value: "not-a-time" };
    input.props.onBlur({ target });
    expect(onEditCut).not.toHaveBeenCalled();
    expect(target.value).toBe("24:05"); // endSec 1445 -> 24:05
  });

  it("does not throw when no onEditCut handler is wired", () => {
    const tree = renderTree(
      <CutlistReview uuid="ep-x" trimEntry={{ status: "needs-review", cuts: [flaggedMid] }} />
    );
    const minus = findByClass(tree, /cutlist-review__start-minus/);
    expect(() => minus.props.onClick()).not.toThrow();
  });
});

describe("CutlistReview - P3b audio previews", () => {
  function findByClass(tree, re) {
    return walk(tree, (n) => n.props && n.props.className && re.test(n.props.className))[0];
  }

  it("renders an <audio> element only when an audioUrl is supplied", () => {
    const withUrl = renderToStaticMarkup(
      <CutlistReview uuid="e1"
        trimEntry={{ status: "needs-review", cuts: [flaggedMid] }}
        audioUrl="file:///tmp/ep.mp3" />
    );
    expect(withUrl).toContain("<audio");
    expect(withUrl).toContain("cutlist-review__preview-join");
    const noUrl = renderToStaticMarkup(
      <CutlistReview uuid="e1" trimEntry={{ status: "needs-review", cuts: [flaggedMid] }} />
    );
    expect(noUrl).not.toContain("<audio");
  });

  it("preview buttons are disabled without an audioUrl", () => {
    const tree = renderTree(
      <CutlistReview uuid="e1" trimEntry={{ status: "needs-review", cuts: [flaggedMid] }} />
    );
    expect(findByClass(tree, /cutlist-review__play-before/).props.disabled).toBe(true);
    expect(findByClass(tree, /cutlist-review__preview-join/).props.disabled).toBe(true);
  });

  it("preview button clicks are a safe no-op when there is no audio element", () => {
    const tree = renderTree(
      <CutlistReview uuid="e1"
        trimEntry={{ status: "needs-review", cuts: [flaggedMid] }}
        audioUrl="file:///tmp/ep.mp3" />
    );
    // The callback ref does not fire in a direct function-call render, so
    // audioRef.current stays null - the handlers must not throw.
    expect(() => findByClass(tree, /cutlist-review__play-before/).props.onClick()).not.toThrow();
    expect(() => findByClass(tree, /cutlist-review__play-after/).props.onClick()).not.toThrow();
    expect(() => findByClass(tree, /cutlist-review__preview-join/).props.onClick()).not.toThrow();
  });
});
