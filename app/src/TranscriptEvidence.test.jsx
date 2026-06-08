import { describe, it, expect } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import { TranscriptEvidence } from "./TranscriptEvidence.jsx";

const transcript = {
  segments: [
    { start: 0, end: 30, text: "Welcome to the show." },
    { start: 600, end: 640, text: "This episode is sponsored by Acme." },
    { start: 640, end: 700, text: "Acme makes the best widgets." },
    { start: 720, end: 760, text: "Back to the conversation." },
  ],
};

const trimEntry = {
  cuts: [{ startSec: 600, endSec: 720, needsReview: false, label: "ad" }],
};

describe("TranscriptEvidence - render", () => {
  it("renders NOTHING when there is no usable cut", () => {
    expect(renderToStaticMarkup(
      <TranscriptEvidence uuid="e1" transcript={transcript} trimEntry={{ cuts: [] }} />
    )).toBe("");
  });

  it("renders NOTHING when there is no transcript", () => {
    expect(renderToStaticMarkup(
      <TranscriptEvidence uuid="e1" transcript={{ segments: [] }} trimEntry={trimEntry} />
    )).toBe("");
    expect(renderToStaticMarkup(
      <TranscriptEvidence uuid="e1" transcript={undefined} trimEntry={trimEntry} />
    )).toBe("");
  });

  it("is collapsed by default (a <details> with no open attribute)", () => {
    const html = renderToStaticMarkup(
      <TranscriptEvidence uuid="e1" transcript={transcript} trimEntry={trimEntry} />
    );
    expect(html).toContain("<details");
    expect(html).not.toContain("open"); // collapsed - no `open` attribute
    expect(html).toContain("transcript-evidence__summary");
    expect(html).toContain("ADVANCED");
  });

  it("renders one segment per transcript line, marking in-cut lines", () => {
    const html = renderToStaticMarkup(
      <TranscriptEvidence uuid="e1" transcript={transcript} trimEntry={trimEntry} />
    );
    // All four lines present.
    expect(html).toContain("Welcome to the show.");
    expect(html).toContain("This episode is sponsored by Acme.");
    expect(html).toContain("Back to the conversation.");
    // The two ad lines are flagged in-cut, the surrounding content is not.
    const inCutTrue = (html.match(/data-in-cut="true"/g) || []).length;
    const inCutFalse = (html.match(/data-in-cut="false"/g) || []).length;
    expect(inCutTrue).toBe(2);
    expect(inCutFalse).toBe(2);
    // Summary reports the highlighted count.
    expect(html).toContain("2 of 4 segments inside a cut");
  });

  it("is read-only - exposes no buttons or inputs", () => {
    const html = renderToStaticMarkup(
      <TranscriptEvidence uuid="e1" transcript={transcript} trimEntry={trimEntry} />
    );
    expect(html).not.toContain("<button");
    expect(html).not.toContain("<input");
  });

  it("highlights flagged (needs-review) cuts too, not just auto-applied ones", () => {
    const html = renderToStaticMarkup(
      <TranscriptEvidence uuid="e1" transcript={transcript}
        trimEntry={{ cuts: [{ startSec: 600, endSec: 720, needsReview: true, label: "ad" }] }} />
    );
    expect((html.match(/data-in-cut="true"/g) || []).length).toBe(2);
  });
});
