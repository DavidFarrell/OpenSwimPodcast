import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { TranscriptCutReview, __gesture as gestureModule } from "./TranscriptCutReview.jsx";
import { sentenceLines, preselectFromCuts } from "./transcriptToggle.js";

// Component-level drag-paint gesture (slice 5). The repo's React tests run under the
// `node` vitest environment (no jsdom layout), so we render via a direct function
// call and drive the real handlers. The gesture uses document-level listeners +
// document.elementFromPoint; we install a minimal fake `document` whose
// elementFromPoint is scripted to return the line we want under the pointer, and a
// tiny listener registry so we can dispatch pointermove / pointerup / pointercancel.

const transcript = {
  segments: [
    { start: 0, end: 30, text: "Welcome to the show." },         // line 0 (content)
    { start: 600, end: 660, text: "This is sponsored by Acme." }, // line 1 (ad)
    { start: 660, end: 700, text: "Acme makes great widgets." },  // line 2 (ad)
    { start: 720, end: 760, text: "Back to the topic." },         // line 3 (content)
  ],
};
const trimEntry = { cuts: [{ startSec: 600, endSec: 700, needsReview: false, label: "ad" }] };
function preselected() { return preselectFromCuts(sentenceLines(transcript), trimEntry); }

function renderTree(el) { return el.type(el.props); }
function walk(node, pred, out = []) {
  if (node == null || typeof node === "boolean") return out;
  if (Array.isArray(node)) { node.forEach((n) => walk(n, pred, out)); return out; }
  if (typeof node === "object" && node.props) {
    if (pred(node)) out.push(node);
    walk(node.props.children, pred, out);
  }
  return out;
}
const lineButtons = (tree) =>
  walk(tree, (n) => n.props && /transcript-cut-review__line(?![-\w])/.test(n.props.className || ""))
    .sort((a, b) => a.props["data-index"] - b.props["data-index"]);

// A minimal fake `document` + `window`: a listener registry + a scriptable
// elementFromPoint that returns a stub element whose `closest('[data-index]')` reports
// the given index. The window mirror carries the blur backstop.
function installFakeDocument() {
  const listeners = {};
  const winListeners = {};
  let nextIndex = null; // what elementFromPoint resolves to on the next move
  const reg = (bag) => ({
    addEventListener: (type, fn) => { (bag[type] = bag[type] || []).push(fn); },
    removeEventListener: (type, fn) => { bag[type] = (bag[type] || []).filter((f) => f !== fn); },
  });
  const fakeDoc = {
    ...reg(listeners),
    elementFromPoint: () => {
      if (nextIndex == null) return null;
      return { closest: (sel) => sel === "[data-index]"
        ? { getAttribute: () => String(nextIndex) } : null };
    },
  };
  const fakeWin = { ...reg(winListeners) };
  return {
    fakeDoc, fakeWin, listeners, winListeners,
    setLineUnderPointer: (idx) => { nextIndex = idx; },
    dispatch: (type, ev = {}) => { (listeners[type] || []).slice().forEach((f) => f(ev)); },
    dispatchWin: (type, ev = {}) => { (winListeners[type] || []).slice().forEach((f) => f(ev)); },
    activeCount: () =>
      ["pointermove", "pointerup", "pointercancel"]
        .reduce((n, t) => n + (listeners[t] ? listeners[t].length : 0), 0)
      + (winListeners.blur ? winListeners.blur.length : 0),
  };
}

let savedDoc, savedWin, env;
beforeEach(() => {
  savedDoc = global.document; savedWin = global.window;
  env = installFakeDocument();
  global.document = env.fakeDoc; global.window = env.fakeWin;
});
afterEach(() => { global.document = savedDoc; global.window = savedWin; });

describe("TranscriptCutReview drag-paint gesture (slice 5)", () => {
  it("pointerdown -> move -> move -> up SELECT-paints the anchor and each differing line once", () => {
    const onToggleSentence = vi.fn();
    const tree = renderTree(
      <TranscriptCutReview uuid="ep-x" transcript={transcript} trimEntry={trimEntry}
        selected={new Set()} onToggleSentence={onToggleSentence} />
    );
    const btns = lineButtons(tree);
    // Press on line 0 (grey) -> anchor becomes selected; paint wants selected=true.
    btns[0].props.onPointerDown({ button: 0, preventDefault: vi.fn() });
    // Drag over line 1 then line 2 (both grey) -> each toggles once.
    env.setLineUnderPointer(1); env.dispatch("pointermove", { clientX: 1, clientY: 1 });
    env.setLineUnderPointer(2); env.dispatch("pointermove", { clientX: 1, clientY: 2 });
    env.dispatch("pointerup");
    expect(onToggleSentence.mock.calls).toEqual([
      ["ep-x", 0], ["ep-x", 1], ["ep-x", 2],
    ]);
  });

  it("never toggles a line twice: the same line resolved on two moves toggles once", () => {
    const onToggleSentence = vi.fn();
    const tree = renderTree(
      <TranscriptCutReview uuid="ep-x" transcript={transcript} trimEntry={trimEntry}
        selected={new Set()} onToggleSentence={onToggleSentence} />
    );
    const btns = lineButtons(tree);
    btns[0].props.onPointerDown({ button: 0, preventDefault: vi.fn() });
    env.setLineUnderPointer(1); env.dispatch("pointermove", { clientX: 1, clientY: 1 });
    env.setLineUnderPointer(1); env.dispatch("pointermove", { clientX: 1, clientY: 1 }); // again
    env.dispatch("pointerup");
    expect(onToggleSentence.mock.calls).toEqual([["ep-x", 0], ["ep-x", 1]]);
  });

  it("DESELECT-paint: dragging from a selected anchor across selected lines removes each, skips grey", () => {
    const onToggleSentence = vi.fn();
    // Lines 1,2 selected (the ad). Press line 1 -> deselects it; paint wants grey.
    const tree = renderTree(
      <TranscriptCutReview uuid="ep-x" transcript={transcript} trimEntry={trimEntry}
        selected={preselected()} onToggleSentence={onToggleSentence} />
    );
    const btns = lineButtons(tree);
    btns[1].props.onPointerDown({ button: 0, preventDefault: vi.fn() });
    env.setLineUnderPointer(2); env.dispatch("pointermove", { clientX: 1, clientY: 1 }); // selected -> remove
    env.setLineUnderPointer(0); env.dispatch("pointermove", { clientX: 1, clientY: 2 }); // grey -> skip
    env.dispatch("pointerup");
    expect(onToggleSentence.mock.calls).toEqual([["ep-x", 1], ["ep-x", 2]]);
  });

  it("a plain click (pointerdown then up, no move) toggles EXACTLY once (no double-toggle)", () => {
    const onToggleSentence = vi.fn();
    const tree = renderTree(
      <TranscriptCutReview uuid="ep-x" transcript={transcript} trimEntry={trimEntry}
        selected={new Set()} onToggleSentence={onToggleSentence} />
    );
    const btns = lineButtons(tree);
    // A real mouse click fires pointerdown, then click with detail >= 1.
    btns[3].props.onPointerDown({ button: 0, preventDefault: vi.fn() });
    env.dispatch("pointerup");
    btns[3].props.onClick({ detail: 1 }); // mouse click - must NOT toggle again
    expect(onToggleSentence.mock.calls).toEqual([["ep-x", 3]]);
  });

  it("keyboard activation (click with detail 0, no pointerdown) toggles once", () => {
    const onToggleSentence = vi.fn();
    const tree = renderTree(
      <TranscriptCutReview uuid="ep-x" transcript={transcript} trimEntry={trimEntry}
        selected={new Set()} onToggleSentence={onToggleSentence} />
    );
    const btns = lineButtons(tree);
    btns[3].props.onClick({ detail: 0 }); // Enter/Space on a focused button
    expect(onToggleSentence.mock.calls).toEqual([["ep-x", 3]]);
  });

  it("pointercancel ends the gesture: a later move paints nothing and no listeners leak", () => {
    const onToggleSentence = vi.fn();
    const tree = renderTree(
      <TranscriptCutReview uuid="ep-x" transcript={transcript} trimEntry={trimEntry}
        selected={new Set()} onToggleSentence={onToggleSentence} />
    );
    const btns = lineButtons(tree);
    btns[0].props.onPointerDown({ button: 0, preventDefault: vi.fn() });
    expect(env.activeCount()).toBeGreaterThan(0); // listeners attached during drag
    env.dispatch("pointercancel");
    expect(env.activeCount()).toBe(0);            // ...and detached on cancel (no leak)
    // A move after cancel resolves to a line but must paint nothing.
    env.setLineUnderPointer(2); env.dispatch("pointermove", { clientX: 1, clientY: 1 });
    expect(onToggleSentence.mock.calls).toEqual([["ep-x", 0]]); // only the anchor
  });

  it("FAST DRAG: a move that skips intermediate lines fills them in (no dropped lines)", () => {
    const onToggleSentence = vi.fn();
    const tree = renderTree(
      <TranscriptCutReview uuid="ep-x" transcript={transcript} trimEntry={trimEntry}
        selected={new Set()} onToggleSentence={onToggleSentence} />
    );
    const btns = lineButtons(tree);
    // Press line 0, then a single FAST move that resolves straight to line 3 (1 and 2
    // skipped by the flick). All of 1,2,3 must still paint.
    btns[0].props.onPointerDown({ button: 0, preventDefault: vi.fn() });
    env.setLineUnderPointer(3); env.dispatch("pointermove", { clientX: 1, clientY: 9 });
    env.dispatch("pointerup");
    expect(onToggleSentence.mock.calls).toEqual([
      ["ep-x", 0], ["ep-x", 1], ["ep-x", 2], ["ep-x", 3],
    ]);
  });

  it("RE-ENTRANT: a second pointerdown before release tears the first gesture down (no leaked listeners)", () => {
    const onToggleSentence = vi.fn();
    const tree = renderTree(
      <TranscriptCutReview uuid="ep-x" transcript={transcript} trimEntry={trimEntry}
        selected={new Set()} onToggleSentence={onToggleSentence} />
    );
    const btns = lineButtons(tree);
    btns[0].props.onPointerDown({ button: 0, preventDefault: vi.fn() });
    expect(env.activeCount()).toBe(4); // one gesture: 3 document + 1 window-blur listener
    btns[1].props.onPointerDown({ button: 0, preventDefault: vi.fn() }); // second press, no release
    // The first gesture was torn down, so exactly one gesture's listeners remain (no leak).
    expect(env.activeCount()).toBe(4);
    env.dispatch("pointerup");
    expect(env.activeCount()).toBe(0);
  });

  it("SCOPE: a move resolving to a line OUTSIDE the gesture's panel paints nothing", () => {
    const onToggleSentence = vi.fn();
    const tree = renderTree(
      <TranscriptCutReview uuid="ep-x" transcript={transcript} trimEntry={trimEntry}
        selected={new Set()} onToggleSentence={onToggleSentence} />
    );
    const btns = lineButtons(tree);
    // Stand in a body element whose contains() rejects everything - simulates the
    // resolved line living in a DIFFERENT panel. (In real rendering the bodyRef
    // callback sets gesture.bodyEl; here we install one on the singleton after down.)
    btns[0].props.onPointerDown({ button: 0, preventDefault: vi.fn() });
    gestureModule.bodyEl = { contains: () => false };
    env.setLineUnderPointer(2); env.dispatch("pointermove", { clientX: 1, clientY: 1 });
    env.dispatch("pointerup");
    // Only the anchor toggled; the out-of-panel line did not.
    expect(onToggleSentence.mock.calls).toEqual([["ep-x", 0]]);
  });

  it("RE-ENTRY: leaving the panel (null resolve) then re-entering does NOT bridge the skipped span", () => {
    const onToggleSentence = vi.fn();
    const tree = renderTree(
      <TranscriptCutReview uuid="ep-x" transcript={transcript} trimEntry={trimEntry}
        selected={new Set()} onToggleSentence={onToggleSentence} />
    );
    const btns = lineButtons(tree);
    btns[0].props.onPointerDown({ button: 0, preventDefault: vi.fn() }); // anchor line 0
    env.setLineUnderPointer(null); env.dispatch("pointermove", { clientX: 1, clientY: 99 }); // left panel
    env.setLineUnderPointer(3); env.dispatch("pointermove", { clientX: 1, clientY: 9 });     // re-enter at 3
    env.dispatch("pointerup");
    // Only the anchor (0) and the re-entry line (3) - NOT 1 and 2, which the pointer
    // never crossed inside the panel.
    expect(onToggleSentence.mock.calls).toEqual([["ep-x", 0], ["ep-x", 3]]);
  });

  it("BUTTONS=0: a move with no button down self-heals a missed pointerup (paints nothing, no leak)", () => {
    const onToggleSentence = vi.fn();
    const tree = renderTree(
      <TranscriptCutReview uuid="ep-x" transcript={transcript} trimEntry={trimEntry}
        selected={new Set()} onToggleSentence={onToggleSentence} />
    );
    const btns = lineButtons(tree);
    btns[0].props.onPointerDown({ button: 0, preventDefault: vi.fn() });
    env.setLineUnderPointer(2);
    env.dispatch("pointermove", { clientX: 1, clientY: 1, buttons: 0 }); // released - tear down
    expect(env.activeCount()).toBe(0);
    // A later move resolves a line but the gesture is gone, so nothing more paints.
    env.dispatch("pointermove", { clientX: 1, clientY: 1 });
    expect(onToggleSentence.mock.calls).toEqual([["ep-x", 0]]);
  });

  it("SECOND POINTER: a move from a different pointerId is ignored", () => {
    const onToggleSentence = vi.fn();
    const tree = renderTree(
      <TranscriptCutReview uuid="ep-x" transcript={transcript} trimEntry={trimEntry}
        selected={new Set()} onToggleSentence={onToggleSentence} />
    );
    const btns = lineButtons(tree);
    btns[0].props.onPointerDown({ button: 0, pointerId: 1, preventDefault: vi.fn() });
    // A second finger (pointerId 2) moves over line 2 - must NOT paint.
    env.setLineUnderPointer(2); env.dispatch("pointermove", { clientX: 1, clientY: 1, pointerId: 2 });
    // The owning pointer (1) moves over line 1 - paints.
    env.setLineUnderPointer(1); env.dispatch("pointermove", { clientX: 1, clientY: 1, pointerId: 1 });
    env.dispatch("pointerup", { pointerId: 1 });
    expect(onToggleSentence.mock.calls).toEqual([["ep-x", 0], ["ep-x", 1]]);
  });

  it("SECOND POINTER's pointerup does NOT end the owner's gesture", () => {
    const onToggleSentence = vi.fn();
    const tree = renderTree(
      <TranscriptCutReview uuid="ep-x" transcript={transcript} trimEntry={trimEntry}
        selected={new Set()} onToggleSentence={onToggleSentence} />
    );
    const btns = lineButtons(tree);
    btns[0].props.onPointerDown({ button: 0, pointerId: 1, preventDefault: vi.fn() });
    env.dispatch("pointerup", { pointerId: 2 }); // a different pointer releasing
    expect(env.activeCount()).toBe(4);            // gesture still live (not torn down)
    // The owner can still paint, then end it.
    env.setLineUnderPointer(1); env.dispatch("pointermove", { clientX: 1, clientY: 1, pointerId: 1 });
    env.dispatch("pointerup", { pointerId: 1 });
    expect(env.activeCount()).toBe(0);
    expect(onToggleSentence.mock.calls).toEqual([["ep-x", 0], ["ep-x", 1]]);
  });

  it("SECOND POINTER's pointerdown mid-drag is ignored (no hijack, no toggle, no teardown)", () => {
    const onToggleSentence = vi.fn();
    const tree = renderTree(
      <TranscriptCutReview uuid="ep-x" transcript={transcript} trimEntry={trimEntry}
        selected={new Set()} onToggleSentence={onToggleSentence} />
    );
    const btns = lineButtons(tree);
    btns[0].props.onPointerDown({ button: 0, pointerId: 1, preventDefault: vi.fn() }); // owner: line 0
    const pd2 = vi.fn();
    btns[3].props.onPointerDown({ button: 0, pointerId: 2, preventDefault: pd2 }); // second finger on line 3
    // The second press was ignored: no preventDefault, no toggle of line 3, gesture intact.
    expect(pd2).not.toHaveBeenCalled();
    expect(env.activeCount()).toBe(4);
    // The OWNER can still finish painting normally.
    env.setLineUnderPointer(1); env.dispatch("pointermove", { clientX: 1, clientY: 1, pointerId: 1 });
    env.dispatch("pointerup", { pointerId: 1 });
    expect(onToggleSentence.mock.calls).toEqual([["ep-x", 0], ["ep-x", 1]]); // never line 3
  });

  it("WINDOW BLUR backstop ends the gesture (release outside the document)", () => {
    const onToggleSentence = vi.fn();
    const tree = renderTree(
      <TranscriptCutReview uuid="ep-x" transcript={transcript} trimEntry={trimEntry}
        selected={new Set()} onToggleSentence={onToggleSentence} />
    );
    const btns = lineButtons(tree);
    btns[0].props.onPointerDown({ button: 0, preventDefault: vi.fn() });
    expect(env.activeCount()).toBe(4);
    env.dispatchWin("blur");        // focus lost (release happened off-window)
    expect(env.activeCount()).toBe(0); // all listeners (document + window) freed
  });

  it("TEXT-SELECT SUPPRESSION: pointerdown preventDefaults, sets user-select none, restores it on end", () => {
    const onToggleSentence = vi.fn();
    const tree = renderTree(
      <TranscriptCutReview uuid="ep-x" transcript={transcript} trimEntry={trimEntry}
        selected={new Set()} onToggleSentence={onToggleSentence} />
    );
    // Drive the body ref with a stub element carrying a prior inline user-select policy
    // (React 18 exposes the ref at element.ref). This proves the suppression + restore.
    const bodyEl = walk(tree, (n) => n.props
      && /transcript-cut-review__body/.test(n.props.className || ""))[0];
    const body = { style: { userSelect: "text" }, contains: () => true };
    bodyEl.ref(body);
    const btns = lineButtons(tree);
    const preventDefault = vi.fn();
    btns[0].props.onPointerDown({ button: 0, preventDefault });
    expect(preventDefault).toHaveBeenCalled();   // native text-selection suppressed
    expect(body.style.userSelect).toBe("none");  // ...for the duration of the drag
    env.dispatch("pointerup");
    expect(body.style.userSelect).toBe("text");  // restored to the PRIOR value, not ""
  });

  it("a non-primary button press is ignored (no gesture, no listeners)", () => {
    const onToggleSentence = vi.fn();
    const tree = renderTree(
      <TranscriptCutReview uuid="ep-x" transcript={transcript} trimEntry={trimEntry}
        selected={new Set()} onToggleSentence={onToggleSentence} />
    );
    const btns = lineButtons(tree);
    btns[0].props.onPointerDown({ button: 2, preventDefault: vi.fn() }); // right-click
    expect(onToggleSentence).not.toHaveBeenCalled();
    expect(env.activeCount()).toBe(0);
  });
});
