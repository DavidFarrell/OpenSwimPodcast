import { hasFlaggedCuts, reviewRows } from "./cutlistReview.js";

// Coarse cut-list review surface (P3a). Shown ONLY for episodes that have at
// least one FLAGGED (needs-review) cut. Each row is a single proposed cut with a
// headline ("Mid-roll 23:10-24:05"), the reason it was flagged, its length, and a
// KEEP / REMOVE pair of controls.
//
// This is intentionally coarse: not a waveform editor, not a transcript editor.
// It is the trust gate - the confident cuts already auto-applied; these are the
// ones the pipeline declined to cut on its own.
//
// CARDINAL RULE: default is KEEP. A cut is removed only when the user explicitly
// chooses REMOVE. onDecide(uuid, cut, "keep" | "remove") records the choice (the
// App wires this to the trim:decide IPC).
export function CutlistReview({ uuid, trimEntry, decisions = {}, onDecide }) {
  const rows = reviewRows(trimEntry, decisions);
  // Render nothing when there is nothing flagged - no clutter for the common
  // case where every cut auto-applied (or there were none).
  if (!hasFlaggedCuts(trimEntry)) return null;

  const decide = (cut, decision) => {
    if (onDecide) onDecide(uuid, cut, decision);
  };

  return (
    <div className="cutlist-review" data-uuid={uuid || ""}
      style={{ borderTop: "1px solid var(--rule)", padding: "8px 20px 12px",
        background: "var(--ct-coffee-deep)" }}>
      <div className="ct-label" style={{ color: "var(--ct-amber)", marginBottom: 6 }}>
        {rows.length} cut{rows.length > 1 ? "s" : ""} need a decision
      </div>
      <div style={{ fontSize: 11, color: "var(--fg-muted)", marginBottom: 8 }}>
        These were left intact because they were ambiguous or over the safe length.
        Choose remove to cut, keep to leave the audio in place.
      </div>
      {rows.map((row) => (
        <div key={row.key} className="cutlist-review__row" data-cut-key={row.key}
          data-decision={row.decision}
          style={{ display: "flex", alignItems: "center", gap: 12, padding: "6px 0",
            borderTop: "1px solid var(--rule)" }}>
          <div style={{ flex: 1, minWidth: 0 }}>
            <div style={{ fontFamily: "var(--font-mono)", fontSize: 12, color: "var(--fg)" }}>
              {row.headline}
              {row.duration && (
                <span style={{ marginLeft: 8, color: "var(--fg-muted)", fontSize: 10 }}>
                  {row.duration}
                </span>
              )}
            </div>
            <div style={{ fontSize: 10, color: "var(--fg-muted)", marginTop: 2 }}>{row.reason}</div>
          </div>
          <div style={{ display: "flex", gap: 2 }}>
            <button className="ct-btn ct-btn--xs cutlist-review__keep"
              onClick={() => decide(row.cut, "keep")}
              aria-pressed={row.decision === "keep"}
              title="leave this audio in place"
              style={{ fontFamily: "var(--font-mono)", fontSize: 10, letterSpacing: ".5px",
                padding: "2px 8px", border: "1px solid var(--rule)", cursor: "pointer",
                background: row.decision === "keep" ? "var(--ct-tea-ghost)" : "transparent",
                color: row.decision === "keep" ? "var(--fg)" : "var(--fg-muted)" }}>
              KEEP
            </button>
            <button className="ct-btn ct-btn--xs cutlist-review__remove"
              onClick={() => decide(row.cut, "remove")}
              aria-pressed={row.decision === "remove"}
              title="cut this block from the episode"
              style={{ fontFamily: "var(--font-mono)", fontSize: 10, letterSpacing: ".5px",
                padding: "2px 8px", border: "1px solid var(--rule)", cursor: "pointer",
                background: row.decision === "remove" ? "var(--ct-amber)" : "transparent",
                color: row.decision === "remove" ? "var(--ct-coffee-deep)" : "var(--fg-muted)" }}>
              REMOVE
            </button>
          </div>
        </div>
      ))}
    </div>
  );
}

export default CutlistReview;
