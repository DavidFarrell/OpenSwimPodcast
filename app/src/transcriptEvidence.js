// Advanced transcript-as-evidence view - pure presentation logic (P3d).
//
// This is the data layer behind TranscriptEvidence.jsx. It is a plain module (no
// React) so the rules are unit-testable without a DOM, mirroring cutlistReview.js.
//
// Purpose: an EVIDENCE-ONLY, read-only view of the transcript segments with the
// detected ad ranges highlighted. It is NOT the primary review surface - the
// keep/remove trust gate lives in CutlistReview. This view exists so a curious
// user can expand it and SEE the transcript lines a cut covers, to sanity-check a
// proposed cut. It makes no decisions and offers no controls; nothing here ever
// changes or applies a cut.

import { formatTime } from "./cutlistReview.js";

// Coerce the in-app transcript ({segments:[{speaker,start,end,text}]} or a bare
// array of segments) into a clean array of {start,end,text}. Mirrors the
// main-process toSegments in detectAds.cjs so the same input shape works here.
// Drops segments without usable text. Returns [] for anything unusable.
export function toSegments(transcript) {
  let raw;
  if (Array.isArray(transcript)) raw = transcript;
  else if (transcript && Array.isArray(transcript.segments)) raw = transcript.segments;
  else return [];
  const out = [];
  for (const s of raw) {
    if (!s) continue;
    const text = typeof s.text === "string" ? s.text.trim() : "";
    if (!text) continue;
    const start = Number(s.start);
    const end = Number(s.end);
    out.push({
      start: Number.isFinite(start) ? start : null,
      end: Number.isFinite(end) ? end : null,
      text,
    });
  }
  return out;
}

// The cuts we draw evidence for. Any cut with a usable [startSec,endSec] range,
// regardless of needsReview - the evidence view shows what WOULD be removed (both
// the auto-applied cuts and the flagged ones) so the transcript context is
// complete. Returns [] for anything unusable.
export function evidenceCuts(trimEntry) {
  if (!trimEntry || !Array.isArray(trimEntry.cuts)) return [];
  return trimEntry.cuts.filter((c) => {
    if (!c) return false;
    const s = Number(c.startSec);
    const e = Number(c.endSec);
    return Number.isFinite(s) && Number.isFinite(e) && e > s;
  });
}

// True when there is something to show: at least one segment AND at least one
// usable cut. The component renders nothing otherwise - an evidence view with no
// cuts (or no transcript) is just clutter.
export function hasEvidence(transcript, trimEntry) {
  return toSegments(transcript).length > 0 && evidenceCuts(trimEntry).length > 0;
}

// Does a segment fall inside any cut range? A segment is "inside a cut" when its
// start time lands within [startSec,endSec). We use start (not full overlap)
// because the detector's ranges are derived from segment start times - this keeps
// the highlight consistent with how the cut was computed. Segments without a
// usable start are never highlighted (we cannot place them).
export function cutForSegment(seg, cuts) {
  if (!seg || seg.start == null) return null;
  for (const c of cuts) {
    const s = Number(c.startSec);
    const e = Number(c.endSec);
    if (seg.start >= s && seg.start < e) return c;
  }
  return null;
}

// Build the view-model rows: one per transcript segment, in order, each marked
// with whether it lands inside a cut and (if so) which cut's label. Pure - the
// component maps straight over this. Read-only: there is deliberately no decision
// or key-for-edit field here.
export function evidenceRows(transcript, trimEntry) {
  const segments = toSegments(transcript);
  const cuts = evidenceCuts(trimEntry);
  return segments.map((seg, i) => {
    const cut = cutForSegment(seg, cuts);
    return {
      index: i,
      time: seg.start != null ? formatTime(seg.start) : "",
      text: seg.text,
      inCut: !!cut,
      cutLabel: cut ? (typeof cut.label === "string" ? cut.label : "ad") : "",
    };
  });
}

// Count of segments that fall inside a cut - shown in the summary line so the
// user knows how much of the transcript the cuts cover before they expand it.
export function highlightedCount(transcript, trimEntry) {
  return evidenceRows(transcript, trimEntry).filter((r) => r.inCut).length;
}
