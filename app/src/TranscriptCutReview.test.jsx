import { describe, it, expect, vi } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import { TranscriptCutReview } from "./TranscriptCutReview.jsx";
import { sentenceLines, preselectFromCuts } from "./transcriptToggle.js";

const transcript = {
  segments: [
    { start: 0, end: 30, text: "Welcome to the show." },         // line 0 (content)
    { start: 600, end: 660, text: "This is sponsored by Acme." }, // line 1 (ad)
    { start: 660, end: 700, text: "Acme makes great widgets." },  // line 2 (ad)
    { start: 720, end: 760, text: "Back to the topic." },         // line 3 (content)
  ],
};
// A CONFIDENT detected mid-roll - so it starts pre-selected (yellow). (Flagged cuts
// start grey; preselectFromCuts' flag handling is covered in transcriptToggle.test.js.)
const trimEntry = { cuts: [{ startSec: 600, endSec: 700, needsReview: false, label: "ad" }] };

// Mirror the parent's pre-selection so the rendered yellow set matches production.
function preselected() {
  return preselectFromCuts(sentenceLines(transcript), trimEntry);
}

// Walk a React element tree collecting nodes matching a predicate (no DOM needed),
// so we can fire a line's onClick and assert the toggle path - same pattern as
// CutlistReview.test.jsx.
function walk(node, pred, out = []) {
  if (node == null || typeof node === "boolean") return out;
  if (Array.isArray(node)) { node.forEach((n) => walk(n, pred, out)); return out; }
  if (typeof node === "object" && node.props) {
    if (pred(node)) out.push(node);
    walk(node.props.children, pred, out);
  }
  return out;
}
function renderTree(el) {
  return typeof el.type === "function" ? el.type(el.props) : el;
}
const byClass = (tree, re) => walk(tree, (n) => n.props && n.props.className && re.test(n.props.className));

describe("TranscriptCutReview - render gate", () => {
  it("renders NOTHING when there are no cuts (nothing to review)", () => {
    expect(renderToStaticMarkup(
      <TranscriptCutReview uuid="e1" transcript={transcript} trimEntry={{ cuts: [] }} selected={new Set()} />
    )).toBe("");
  });

  it("renders NOTHING when there is no transcript", () => {
    expect(renderToStaticMarkup(
      <TranscriptCutReview uuid="e1" transcript={{ segments: [] }} trimEntry={trimEntry} selected={new Set()} />
    )).toBe("");
    expect(renderToStaticMarkup(
      <TranscriptCutReview uuid="e1" transcript={undefined} trimEntry={trimEntry} selected={new Set()} />
    )).toBe("");
  });
});

describe("TranscriptCutReview - one collapsible panel per episode", () => {
  it("is a collapsed <details> by default with a kind summary", () => {
    const html = renderToStaticMarkup(
      <TranscriptCutReview uuid="e1" transcript={transcript} trimEntry={trimEntry} selected={preselected()} />
    );
    expect(html).toContain("<details");
    expect(html).not.toContain("open"); // collapsed unless defaultOpen
    expect(html).toContain("transcript-cut-review__summary");
    // Two ad sentences in one detected mid-roll -> "1 mid-roll" and a 1-cut count.
    expect(html).toContain("1 mid-roll");
    expect(html).toContain("1 cut");
  });

  it("opens when defaultOpen is set (the prop still works; the gate now passes false)", () => {
    const html = renderToStaticMarkup(
      <TranscriptCutReview uuid="e1" transcript={transcript} trimEntry={trimEntry}
        selected={preselected()} defaultOpen />
    );
    expect(html).toContain("open");
  });

  it("renders one clickable line per sentence, the whole transcript, in order", () => {
    const html = renderToStaticMarkup(
      <TranscriptCutReview uuid="e1" transcript={transcript} trimEntry={trimEntry} selected={preselected()} />
    );
    expect(html).toContain("Welcome to the show.");
    expect(html).toContain("This is sponsored by Acme.");
    expect(html).toContain("Acme makes great widgets.");
    expect(html).toContain("Back to the topic.");
    // Each sentence is a <button> (read + click in one gesture): 4 line buttons.
    expect((html.match(/class="transcript-cut-review__line(?:"| )/g) || []).length).toBe(4);
  });
});

describe("TranscriptCutReview - yellow (in-cut) vs grey (kept) marking", () => {
  it("marks the detector-flagged sentences selected and the rest not", () => {
    const html = renderToStaticMarkup(
      <TranscriptCutReview uuid="e1" transcript={transcript} trimEntry={trimEntry} selected={preselected()} />
    );
    // Two ad lines selected (yellow), two content lines not (grey).
    expect((html.match(/data-selected="true"/g) || []).length).toBe(2);
    expect((html.match(/data-selected="false"/g) || []).length).toBe(2);
  });

  it("reflects an externally-changed selection (controlled component)", () => {
    // Empty selection -> every line grey (the cardinal default for a de-selected ep).
    const html = renderToStaticMarkup(
      <TranscriptCutReview uuid="e1" transcript={transcript} trimEntry={trimEntry} selected={new Set()} />
    );
    expect((html.match(/data-selected="true"/g) || []).length).toBe(0);
    expect((html.match(/data-selected="false"/g) || []).length).toBe(4);
    // Header shows 0 cuts / 0 lines selected.
    expect(html).toContain("0 cuts · 0 lines selected");
  });
});

describe("TranscriptCutReview - binary colour + ⚑ as a SEPARATE annotation axis", () => {
  // A HELD (needsReview) mid-roll: lines 1,2 are flagged-but-not-pre-selected.
  const heldTranscript = {
    segments: [
      { start: 0, end: 30, text: "Welcome to the show." },         // line 0 (content)
      { start: 600, end: 660, text: "This might be sponsored." },   // line 1 (held ad)
      { start: 660, end: 700, text: "Acme makes great widgets." },  // line 2 (held ad)
      { start: 720, end: 760, text: "Back to the topic." },         // line 3 (content)
    ],
  };
  const heldEntry = { cuts: [{ startSec: 600, endSec: 700, needsReview: true, label: "ad" }] };

  it("the cut decision is text-colour only - NO wash background, NO dashed left rule", () => {
    const html = renderToStaticMarkup(
      <TranscriptCutReview uuid="e1" transcript={transcript} trimEntry={trimEntry} selected={preselected()} />
    );
    // The amber WASH (--ct-amber-dim) and the dashed flag-as-state rule are both gone.
    expect(html).not.toContain("amber-dim");
    expect(html).not.toContain("dashed");
    // A cut (selected) line carries the bright amber text...
    expect(html).toContain("var(--ct-amber)");
    // ...and a kept line the muted grey - both present (binary).
    expect(html).toContain("var(--fg-muted)");
  });

  it("a held cut starts GREY (not pre-selected) but carries a ⚑ so it is discoverable", () => {
    const html = renderToStaticMarkup(
      <TranscriptCutReview uuid="e1" transcript={heldTranscript} trimEntry={heldEntry}
        selected={new Set()} />
    );
    // Cardinal rule: nothing auto-selected for a held-only episode.
    expect((html.match(/data-selected="true"/g) || []).length).toBe(0);
    // The two held lines are MARKED (data-held) and flagged as unreviewed...
    expect((html.match(/data-held="true"/g) || []).length).toBe(2);
    expect((html.match(/data-unreviewed="true"/g) || []).length).toBe(2);
    // ...and the ⚑ glyph is rendered (twice, one per held line).
    expect((html.match(/⚑/g) || []).length).toBeGreaterThanOrEqual(2);
    // The jump-to button is present with the held count (reachable once opened).
    expect(html).toContain("flagged for review");
  });

  it("ACCEPTANCE: a held panel stays COLLAPSED by default but STILL shows the held count on its summary", () => {
    // Slice 4 removed the held auto-open. The held-count cue on the <summary> is now the
    // ONLY nudge, so it MUST survive while collapsed - deleting it (or re-adding the
    // auto-open) is a regression this test catches.
    const html = renderToStaticMarkup(
      <TranscriptCutReview uuid="e1" transcript={heldTranscript} trimEntry={heldEntry}
        selected={new Set()} />
    );
    // No auto-open: a held-only panel with defaultOpen unset renders no open attribute.
    expect(html).not.toContain("open");
    // ...but the collapsed summary still carries the held-count cue.
    expect(html).toContain("1 flagged for review");
  });

  it("the ⚑ is INDEPENDENT of selection: opting a held line in keeps its ⚑ but clears 'unreviewed'", () => {
    // Select line 1 (opt it into the cut). It stays held (⚑) but is no longer unreviewed.
    const html = renderToStaticMarkup(
      <TranscriptCutReview uuid="e1" transcript={heldTranscript} trimEntry={heldEntry}
        selected={new Set([1])} />
    );
    expect((html.match(/data-held="true"/g) || []).length).toBe(2);      // both still held
    expect((html.match(/data-unreviewed="true"/g) || []).length).toBe(1); // only line 2 left
    expect((html.match(/data-selected="true"/g) || []).length).toBe(1);   // line 1 now cut
  });

  it("exposes the held/flagged status on the button's accessible name (⚑ is aria-hidden)", () => {
    const html = renderToStaticMarkup(
      <TranscriptCutReview uuid="e1" transcript={heldTranscript} trimEntry={heldEntry}
        selected={new Set()} />
    );
    // The decorative glyph is hidden from AT...
    expect(html).toContain('aria-hidden="true"');
    // ...so a held line carries "flagged for review" in its aria-label instead.
    expect(html).toContain("flagged for review: This might be sponsored.");
    // A non-held (kept content) line's label has no "flagged for review".
    expect(html).toContain('aria-label="0:00: Welcome to the show."');
  });

  it("a CONFIDENT cut never gets a ⚑ (the marker means 'unsure', not 'will cut')", () => {
    // trimEntry is a confident mid-roll: its lines are selected (amber) but NOT held.
    const html = renderToStaticMarkup(
      <TranscriptCutReview uuid="e1" transcript={transcript} trimEntry={trimEntry} selected={preselected()} />
    );
    // No line carries the held marker (the ⚑ in the hint copy is static, not a line).
    expect(html).not.toContain('data-held="true"');
    expect(html).not.toContain('data-unreviewed="true"');
  });
});

describe("TranscriptCutReview - sentence toggle wiring (the editing gesture)", () => {
  function setup(selected) {
    const onToggleSentence = vi.fn();
    const tree = renderTree(
      <TranscriptCutReview uuid="ep-x" transcript={transcript} trimEntry={trimEntry}
        selected={selected} onToggleSentence={onToggleSentence} />
    );
    return { onToggleSentence, tree };
  }

  it("clicking a GREY line toggles it (EXTEND - add a line the detector missed)", () => {
    const { onToggleSentence, tree } = setup(preselected());
    // Line 3 ("Back to the topic.") is grey; click it.
    const lineBtns = byClass(tree, /transcript-cut-review__line(?![-\w])/);
    const grey = lineBtns.find((n) => n.props["data-index"] === 3);
    grey.props.onClick();
    expect(onToggleSentence).toHaveBeenCalledWith("ep-x", 3);
  });

  it("clicking a YELLOW line toggles it (SHRINK - keep a wrongly-grabbed line)", () => {
    const { onToggleSentence, tree } = setup(preselected());
    const lineBtns = byClass(tree, /transcript-cut-review__line(?![-\w])/);
    const yellow = lineBtns.find((n) => n.props["data-index"] === 1);
    yellow.props.onClick();
    expect(onToggleSentence).toHaveBeenCalledWith("ep-x", 1);
  });

  it("does not throw when no onToggleSentence handler is wired", () => {
    const tree = renderTree(
      <TranscriptCutReview uuid="ep-x" transcript={transcript} trimEntry={trimEntry} selected={preselected()} />
    );
    const line = byClass(tree, /transcript-cut-review__line(?![-\w])/)[0];
    expect(() => line.props.onClick()).not.toThrow();
  });
});

describe("TranscriptCutReview - onOpen fires on user open, not on close", () => {
  function detailsNode(selected = preselected()) {
    const onOpen = vi.fn();
    const tree = renderTree(
      <TranscriptCutReview uuid="ep-o" transcript={transcript} trimEntry={trimEntry}
        selected={selected} onOpen={onOpen} defaultOpen={false} />
    );
    // The <details> is the root element of the rendered tree.
    return { onOpen, details: tree };
  }

  it("fires onOpen(uuid) when the panel transitions to OPEN", () => {
    const { onOpen, details } = detailsNode();
    details.props.onToggle({ target: { open: true } });
    expect(onOpen).toHaveBeenCalledWith("ep-o");
  });

  it("does NOT fire onOpen when the panel transitions to CLOSED", () => {
    const { onOpen, details } = detailsNode();
    details.props.onToggle({ target: { open: false } });
    expect(onOpen).not.toHaveBeenCalled();
  });

  it("does not throw when no onOpen handler is wired", () => {
    const tree = renderTree(
      <TranscriptCutReview uuid="ep-o" transcript={transcript} trimEntry={trimEntry}
        selected={preselected()} defaultOpen={false} />
    );
    expect(() => tree.props.onToggle({ target: { open: true } })).not.toThrow();
  });

  it("defaultOpen={false} yields no open attribute even with held cuts (no auto-open)", () => {
    const heldEntry = { cuts: [{ startSec: 600, endSec: 700, needsReview: true, label: "ad" }] };
    const html = renderToStaticMarkup(
      <TranscriptCutReview uuid="e1" transcript={transcript} trimEntry={heldEntry}
        selected={new Set()} defaultOpen={false} />
    );
    expect(html).not.toContain("open");
  });
});

describe("TranscriptCutReview - audio preview is SECONDARY", () => {
  it("renders an <audio> + a ▶ run-head button only when an audioUrl is supplied", () => {
    const withUrl = renderToStaticMarkup(
      <TranscriptCutReview uuid="e1" transcript={transcript} trimEntry={trimEntry}
        selected={preselected()} audioUrl="file:///tmp/ep.mp3" />
    );
    expect(withUrl).toContain("<audio");
    expect(withUrl).toContain("transcript-cut-review__play-join");
    const noUrl = renderToStaticMarkup(
      <TranscriptCutReview uuid="e1" transcript={transcript} trimEntry={trimEntry} selected={preselected()} />
    );
    expect(noUrl).not.toContain("<audio");
  });

  it("the ▶ is disabled without an audioUrl and its click is a safe no-op", () => {
    const tree = renderTree(
      <TranscriptCutReview uuid="e1" transcript={transcript} trimEntry={trimEntry} selected={preselected()} />
    );
    const play = byClass(tree, /transcript-cut-review__play-join/)[0];
    expect(play.props.disabled).toBe(true);
    expect(() => play.props.onClick()).not.toThrow();
  });

  it("shows exactly one ▶ per contiguous selected run (not one per line)", () => {
    // One detected mid-roll = one contiguous run = one ▶.
    const html = renderToStaticMarkup(
      <TranscriptCutReview uuid="e1" transcript={transcript} trimEntry={trimEntry}
        selected={preselected()} audioUrl="file:///tmp/ep.mp3" />
    );
    expect((html.match(/transcript-cut-review__play-join/g) || []).length).toBe(1);
  });
});
