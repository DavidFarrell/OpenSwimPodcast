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
