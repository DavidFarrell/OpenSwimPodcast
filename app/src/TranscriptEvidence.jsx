import { evidenceRows, highlightedCount, hasEvidence } from "./transcriptEvidence.js";

// Advanced transcript-as-evidence view (P3d). COLLAPSED BY DEFAULT and READ-ONLY.
//
// This is NOT the primary review surface - the keep/remove trust gate is
// CutlistReview. This is a secondary, evidence-only panel a curious user can
// expand to see the transcript segments with the detected ad ranges highlighted,
// to sanity-check what a cut covers. It offers no controls and makes no decisions:
// it never changes, applies, or removes a cut. Use a native <details> so it is
// collapsed until the user opens it and needs no state/hooks.
//
//   transcript - the in-app transcript ({segments:[...]} or a bare segment array).
//   trimEntry  - { cuts: [...] }, the proposed cut list (same shape CutlistReview
//                receives). Both auto-applied and flagged cuts are highlighted so
//                the transcript context is complete.
//
// Renders nothing when there is no transcript or no usable cut - no clutter.
export function TranscriptEvidence({ uuid, transcript, trimEntry }) {
  if (!hasEvidence(transcript, trimEntry)) return null;

  const rows = evidenceRows(transcript, trimEntry);
  const highlighted = highlightedCount(transcript, trimEntry);

  const timeStyle = {
    fontFamily: "var(--font-mono)", fontSize: 10, color: "var(--fg-dim)",
    flex: "0 0 auto", width: 52, textAlign: "right",
  };
  const textStyleBase = { fontSize: 11, lineHeight: 1.4, flex: 1, minWidth: 0 };

  return (
    <details className="transcript-evidence" data-uuid={uuid || ""}
      style={{ borderTop: "1px solid var(--rule)", padding: "6px 20px 10px",
        background: "var(--ct-coffee-deep)" }}>
      <summary className="transcript-evidence__summary"
        style={{ cursor: "pointer", fontFamily: "var(--font-mono)", fontSize: 10,
          letterSpacing: ".5px", color: "var(--fg-muted)", userSelect: "none" }}>
        ADVANCED · transcript evidence
        <span style={{ marginLeft: 8, color: "var(--fg-dim)" }}>
          {highlighted} of {rows.length} segments inside a cut
        </span>
      </summary>
      <div className="transcript-evidence__hint"
        style={{ fontSize: 10, color: "var(--fg-dim)", margin: "6px 0 8px" }}>
        Read-only. The highlighted lines are inside a detected ad range. This is
        evidence only - use the controls above to keep or remove a cut.
      </div>
      <div className="transcript-evidence__body"
        style={{ maxHeight: 260, overflowY: "auto" }}>
        {rows.map((row) => (
          <div key={row.index} className="transcript-evidence__seg"
            data-in-cut={row.inCut ? "true" : "false"}
            style={{ display: "flex", gap: 8, padding: "2px 0",
              alignItems: "baseline" }}>
            <span style={timeStyle}>{row.time}</span>
            <span style={{ ...textStyleBase,
              color: row.inCut ? "var(--ct-amber)" : "var(--fg-muted)" }}>
              {row.inCut && (
                <span className="transcript-evidence__tag"
                  style={{ fontFamily: "var(--font-mono)", fontSize: 9,
                    letterSpacing: ".5px", color: "var(--ct-coffee-deep)",
                    background: "var(--ct-amber)", padding: "0 4px", marginRight: 6 }}>
                  {row.cutLabel.toUpperCase()}
                </span>
              )}
              {row.text}
            </span>
          </div>
        ))}
      </div>
    </details>
  );
}

export default TranscriptEvidence;
