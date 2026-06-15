// Per-episode transcript-toggle review - pure logic (redesign of the coarse
// keep/remove cut-list review). No React, no DOM, so the rules are unit-testable.
//
// THE MODEL. Instead of a separate keep/remove row per detected cut, the user
// reviews ONE per-episode transcript: every coarse diarized segment is split into
// SENTENCES, each sentence is one clickable line with its own [startSec,endSec],
// the detector's flagged ranges start SELECTED (yellow), and the user toggles
// sentences in or out. At "Continue" the SELECTED sentences become the final cut
// set, expressed as the maximal CONTIGUOUS runs of selected sentences -> a list of
// [startSec,endSec] ranges. Grey (unselected) is kept; nothing not-selected is cut.
//
// CARDINAL RULE (trim): zero false positives. A sentence is cut ONLY when it is in
// the selected set at Continue. The default selected set is exactly the detector's
// flagged ranges (so default behaviour matches today: the detector's cuts get cut
// unless the user de-selects them); the user can shrink (un-select) or extend
// (select more) at sentence granularity. The selected->ranges collapse never emits
// an inverted or zero-length range, and a sentence with no usable time is never
// selectable, so it can never enter a cut.
//
// SENTENCE TIMES BY CHAR-INTERPOLATION. fast-diarise gives us coarse turns
// {speaker,start,end,text} with NO per-word timings. We recover per-sentence times
// the same way detectAds.cjs maps a quote to a time: proportionally by character
// offset WITHIN the segment -
//   sentence_start = seg.start + (charOffset / len(seg.text)) * (seg.end - seg.start)
// clamped to [seg.start, seg.end]. This mirrors detectAds.cjs interpTime() (which
// interpolates in NORMALISED char space); here we interpolate in the RAW text the
// user reads, so the timestamp shown next to a sentence lines up with that exact
// sentence. The boundaries are on the ORIGINAL (pre-speed) timeline, the same one
// converter.cjs / the cut ranges expect.

import { formatTime } from "./cutlistReview.js";

// Sentence-ending punctuation, mirroring the GEPA repo's transcript.py _SENT_END
// (`[.!?]+["')\]]?$` per word). We apply it over the whole segment text: a split
// point is a run of .!? optionally followed by a closing quote/bracket, then
// whitespace (or end of string). Keeping the terminator WITH the sentence so the
// text the user reads is unchanged and char offsets stay exact against seg.text.
const _SENT_SPLIT = /([.!?]+["')\]]?)(\s+|$)/g;

// Split a segment's raw text into sentences. Returns an array of
// { text, charStart, charEnd } where charStart/charEnd are offsets into the
// ORIGINAL text (charEnd exclusive), so a later interpolation uses the same string.
// Whitespace between sentences is attached to neither (it advances the cursor but
// is not part of any sentence's text). A blank / whitespace-only text yields [].
// Text with no sentence terminator is one sentence spanning the whole string.
export function splitSentences(text) {
  if (typeof text !== "string") return [];
  const out = [];
  let cursor = 0;
  let m;
  _SENT_SPLIT.lastIndex = 0;
  while ((m = _SENT_SPLIT.exec(text)) !== null) {
    // End of the sentence text = end of the terminator group (m.index + group1 len).
    const termEnd = m.index + m[1].length;
    const raw = text.slice(cursor, termEnd);
    const trimmed = raw.trim();
    if (trimmed) {
      // charStart = where the trimmed sentence actually begins (skip leading ws
      // the previous separator did not consume); charEnd = termEnd.
      const lead = raw.length - raw.trimStart().length;
      out.push({ text: trimmed, charStart: cursor + lead, charEnd: termEnd });
    }
    cursor = termEnd + m[2].length; // advance past the trailing whitespace
  }
  // Trailing remainder with no terminal punctuation = a final sentence.
  if (cursor < text.length) {
    const raw = text.slice(cursor);
    const trimmed = raw.trim();
    if (trimmed) {
      const lead = raw.length - raw.trimStart().length;
      out.push({ text: trimmed, charStart: cursor + lead, charEnd: cursor + raw.trimEnd().length });
    }
  }
  return out;
}

// Coerce the in-app transcript ({segments:[{speaker,start,end,text}]} or a bare
// array of segments) into a clean array of {start,end,text,speaker}. Mirrors
// transcriptEvidence.js toSegments + detectAds.cjs toSegments. Drops segments
// without usable text OR without a usable start time (we cannot place a sentence
// from a segment we cannot place). Returns [] for anything unusable.
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
    if (!Number.isFinite(start)) continue;
    const end = Number(s.end);
    out.push({
      start,
      end: Number.isFinite(end) ? end : null,
      text: s.text, // keep RAW (untrimmed) so char offsets from splitSentences align
      speaker: typeof s.speaker === "string" ? s.speaker : null,
    });
  }
  return out;
}

// Interpolate a time within a segment from a char offset into its RAW text.
// t = seg.start + (charOffset / max(1, len(seg.text))) * (seg.end - seg.start),
// clamped to [seg.start, seg.end]. A segment with no/zero/negative duration
// collapses to seg.start (every sentence in it shares the turn start - safe, the
// range collapse still works). Mirrors detectAds.cjs interpTime.
export function interpTime(seg, charOffset) {
  const start = seg.start;
  let end = seg.end;
  if (end == null || !Number.isFinite(end) || !(end > start)) return start;
  const len = Math.max(1, seg.text ? seg.text.length : 1);
  const frac = Math.min(1, Math.max(0, charOffset / len));
  const t = start + frac * (end - start);
  return Math.min(end, Math.max(start, t));
}

// Build the per-episode sentence lines: split every segment into sentences and give
// each its own char-interpolated [startSec,endSec]. Returns an array (in transcript
// order) of:
//   { index, segIndex, startSec, endSec, text, speaker, time }
// index    - global sentence index (the stable id the toggle set keys on)
// segIndex - which segment it came from (for debugging / grouping)
// startSec - interpolated start (charStart -> time)
// endSec   - interpolated end   (charEnd   -> time), forced strictly > startSec by
//            falling back to the segment end (or a tiny epsilon) so a line always
//            has a usable, non-inverted range to contribute to a cut.
// A segment that is a single sentence interpolates to ~[seg.start, seg.end].
// Pure; never throws.
export function sentenceLines(transcript) {
  const segs = toSegments(transcript);
  const lines = [];
  let idx = 0;
  for (let si = 0; si < segs.length; si++) {
    const seg = segs[si];
    const sentences = splitSentences(seg.text);
    // A segment whose text has no splittable content still yields one sentence via
    // splitSentences (the trailing-remainder branch); guard anyway.
    if (sentences.length === 0) continue;
    const segEnd = (seg.end != null && Number.isFinite(seg.end) && seg.end > seg.start)
      ? seg.end : null;
    // Interpolate each sentence's START from its charStart up front, so a sentence's
    // END can SNAP to the next sentence's start. Snapping makes adjacent sentence
    // ranges exactly touching (non-overlapping): the inter-sentence whitespace slice
    // belongs to the EARLIER sentence, so if it is SELECTED and the next is GREY, the
    // cut ends precisely where the grey sentence's audio begins - a selected
    // sentence's cut can never bleed into an adjacent grey sentence's audio.
    const starts = sentences.map((s) => interpTime(seg, s.charStart));
    for (let k = 0; k < sentences.length; k++) {
      const s = sentences[k];
      const startSec = starts[k];
      // END = the next sentence's start (snap to adjacency) for a non-final sentence;
      // the final sentence in the segment ends at its charEnd-interpolated time, the
      // segment end, or a 1ms epsilon - whichever first gives a forward range.
      let endSec;
      if (k + 1 < sentences.length) {
        endSec = starts[k + 1];
      } else {
        endSec = interpTime(seg, s.charEnd);
      }
      // Guarantee a usable forward range. If interpolation/snapping degenerated (no/
      // zero segment duration, a 1-char sentence, or a coincident next start), fall
      // back to the segment end then a 1ms epsilon. Keeps the range non-inverted so
      // the cut-collapse never drops or inverts it.
      if (!(endSec > startSec)) endSec = segEnd != null && segEnd > startSec ? segEnd : startSec + 0.001;
      lines.push({
        index: idx,
        segIndex: si,
        startSec,
        endSec,
        text: s.text,
        speaker: seg.speaker,
        time: formatTime(startSec),
      });
      idx += 1;
    }
  }
  // GLOBAL non-overlap clamp across ALL adjacent lines, including SEGMENT
  // boundaries. The within-segment snap above only makes sentences in the SAME
  // segment exactly touch. Diarized SEGMENTS can overlap or be non-abutting (the
  // next segment can start before this one ends), so a segment's final sentence
  // could otherwise extend past the next (possibly GREY) line's start and bleed a
  // selected cut into kept audio. Clamp every line's endSec to <= the next line's
  // startSec. max(startSec, ...) keeps the range non-inverted under heavy overlap
  // (it degenerates to a zero-length line, which the cut-collapse / converter then
  // drops - i.e. it contributes no cut, which is the cardinal-safe outcome).
  for (let i = 0; i < lines.length - 1; i++) {
    const nextStart = lines[i + 1].startSec;
    // Only clamp when the next line genuinely starts LATER than this line: then the
    // clamped end stays a forward range AND no real audio can bleed across the
    // boundary into the next (possibly GREY) line. When the next line starts at or
    // before this line's start (a degenerate same-start / zero-duration segment),
    // there is no real audio gap to protect, so leave this line's (tiny) range
    // intact rather than collapse it to zero-length.
    if (lines[i].endSec > nextStart && nextStart > lines[i].startSec) {
      lines[i].endSec = nextStart;
    }
  }
  return lines;
}

// The detector cuts we pre-select from. Any cut with a usable [startSec,endSec]
// range (both auto-applied AND flagged - the user now sees and controls
// everything, so the pre-selected yellow set is the detector's FULL proposed cut
// set, matching today's default that confident cuts get cut). Returns [] for
// anything unusable. Mirrors transcriptEvidence.js evidenceCuts.
export function selectableCuts(trimEntry) {
  if (!trimEntry || !Array.isArray(trimEntry.cuts)) return [];
  return trimEntry.cuts.filter((c) => {
    if (!c) return false;
    const s = Number(c.startSec);
    const e = Number(c.endSec);
    return Number.isFinite(s) && Number.isFinite(e) && e > s;
  });
}

// Does a sentence line fall inside any cut range? A line is "inside a cut" when its
// MIDPOINT lands within [startSec, endSec]. We use the midpoint (not the start, and
// not full containment) so a sentence that the char-interpolation places mostly
// inside the detected range is selected even if its exact interpolated start/end
// spill a hair past the boundary - the detector boundary is itself approximate, so
// midpoint is the most faithful "is this sentence part of the ad" test.
export function lineInCuts(line, cuts) {
  if (!line) return false;
  const mid = (line.startSec + line.endSec) / 2;
  for (const c of cuts) {
    const s = Number(c.startSec);
    const e = Number(c.endSec);
    if (mid >= s && mid <= e) return true;
  }
  return false;
}

// Compute the INITIAL selected set (the yellow sentences) from the detector's
// proposed cuts. Returns a Set of sentence indices.
//
// CARDINAL RULE - which cuts start yellow: ONLY the detector's CONFIDENT cuts
// (needsReview !== true) are pre-selected. This makes the default outcome match
// today exactly - confident cuts get cut unless the user greys them, while a FLAGGED
// (ambiguous / over-threshold / unmappable) cut starts GREY (kept by default) and is
// cut only if the user affirmatively selects it. Pre-selecting a flagged cut would
// auto-cut an ambiguous boundary by default, weakening the zero-false-positive rule.
// The flagged cut's sentences are still SHOWN (surfaced) so the user can opt in.
export function preselectFromCuts(lines, trimEntry) {
  const cuts = selectableCuts(trimEntry).filter((c) => c && c.needsReview !== true);
  const sel = new Set();
  if (!Array.isArray(lines) || cuts.length === 0) return sel;
  for (const line of lines) {
    if (lineInCuts(line, cuts)) sel.add(line.index);
  }
  return sel;
}

// The lines the detector proposed cutting - CONFIDENT *and* HELD (needsReview) - as a
// Set of sentence indices. Distinct from preselectFromCuts, which seeds only the
// CONFIDENT cuts as yellow: a HELD cut's lines are "flagged but not selected", so the
// review can MARK them (visible, opt-in) instead of leaving them indistinguishable
// from plain kept content. Without this, a detector cut that was held for review
// (e.g. an uncertain boundary) is invisible in a long transcript - the user is told
// "1 mid-roll found" but cannot see WHERE to review. With it, the held cut's lines are
// marked so the user can find and click them. The CARDINAL RULE is untouched: marking
// a line does NOT select it; it is cut only if the user clicks it into the yellow set.
export function flaggedLines(lines, trimEntry) {
  const cuts = selectableCuts(trimEntry); // ALL cuts, including needsReview ones
  const out = new Set();
  if (!Array.isArray(lines) || cuts.length === 0) return out;
  for (const line of lines) {
    if (lineInCuts(line, cuts)) out.add(line.index);
  }
  return out;
}

// Count of detector cuts that are HELD (needsReview === true) - surfaced for the user
// but NOT pre-selected. Drives the "N flagged for review" hint so the user knows to
// look even when nothing is pre-selected yellow. Pure.
export function heldCutCount(trimEntry) {
  return selectableCuts(trimEntry).filter((c) => c && c.needsReview === true).length;
}

// Toggle one sentence (by index) in or out of a selected Set, returning a NEW Set
// (immutability, so React state updates cleanly). Pure.
export function toggleSentence(selected, index) {
  const next = new Set(selected);
  if (next.has(index)) next.delete(index); else next.add(index);
  return next;
}

// Maximum gap (seconds) the collapse will bridge between two consecutive SELECTED
// sentences before treating them as SEPARATE cuts. This is deliberately TINY - just
// enough to merge sentences whose char-interpolated boundaries are truly touching
// (sub-second rounding slack). It is NOT a tolerance for skipping content: any larger
// gap between two selected sentences is unselected time (real content / music /
// dropped-transcript / words the diariser missed) and MUST split the run, leaving
// that gap INTACT. Cutting unselected time would be a cardinal-rule violation - far
// better to leave a little ad in than to cut a possibly-content gap. (A grey sentence
// between two selected ones already splits the run; this guards the case where the
// gap has NO transcribed sentence at all.)
export const MAX_BRIDGE_GAP_SEC = 0.5;

// Collapse the selected sentences into the FINAL cut ranges: the maximal CONTIGUOUS
// runs of selected sentences, each -> { startSec, endSec }. A run is contiguous when
// the sentences are consecutive in transcript order AND truly touching in TIME (the
// next selected sentence starts within MAX_BRIDGE_GAP_SEC of the current run's end). A
// run BREAKS at (a) any GREY (unselected) sentence, or (b) a time gap larger than the
// tiny bridge slack between two selected sentences - that gap is unselected audio
// (kept) even when both sides are selected. Each run's range = [first selected
// sentence start, last selected sentence end]. An inverted/zero run (guarded;
// sentenceLines guarantees forward lines) is dropped. Returns [] when nothing is
// selected. This is exactly what gets cut at Continue.
//
// CARDINAL RULE: ONLY selected sentences' own time contributes, and a cut range never
// spans unselected audio. A grey sentence OR an untranscribed time gap between two
// yellow stretches splits them into separate cuts, leaving the gap intact. Nothing
// outside the yellow set is ever inside a returned range.
export function selectedToRanges(lines, selected, maxGapSec = MAX_BRIDGE_GAP_SEC) {
  if (!Array.isArray(lines) || !lines.length || !selected || selected.size === 0) return [];
  const gap = Number.isFinite(maxGapSec) && maxGapSec >= 0 ? maxGapSec : MAX_BRIDGE_GAP_SEC;
  const ranges = [];
  let run = null; // { startSec, endSec }
  const flush = () => { if (run && run.endSec > run.startSec) ranges.push(run); run = null; };
  for (const line of lines) {
    if (!selected.has(line.index)) { flush(); continue; }
    if (!run) {
      run = { startSec: line.startSec, endSec: line.endSec };
    } else if (line.startSec - run.endSec > gap) {
      // Selected, but a real kept-audio gap sits before it - close the prior run and
      // start a new one rather than bridge across the gap.
      flush();
      run = { startSec: line.startSec, endSec: line.endSec };
    } else {
      // Genuinely adjacent - extend the open run (endSec is monotonic in time order).
      run.endSec = Math.max(run.endSec, line.endSec);
    }
  }
  flush();
  return ranges;
}

// One-line panel-header summary of what the detector found, e.g. "Intro + 2
// mid-rolls", "3 cuts", "Intro + outro". Pure; reads cut labels (intro / outro /
// ad / intro+outro) the same way cutlistReview.js kindLabel does. Counts the cuts
// by kind and renders a short human phrase. Falls back to "N cut(s)".
export function panelSummary(trimEntry) {
  const cuts = selectableCuts(trimEntry);
  const n = cuts.length;
  if (n === 0) return "no cuts";
  let intro = 0, outro = 0, mid = 0;
  for (const c of cuts) {
    const raw = typeof c.label === "string" ? c.label : "";
    const hasIntro = raw.includes("intro");
    const hasOutro = raw.includes("outro");
    if (hasIntro) intro += 1;
    if (hasOutro) outro += 1;
    if (!hasIntro && !hasOutro) mid += 1;
  }
  const parts = [];
  if (intro) parts.push(intro === 1 ? "Intro" : `${intro} intros`);
  if (mid) parts.push(mid === 1 ? "1 mid-roll" : `${mid} mid-rolls`);
  if (outro) parts.push(outro === 1 ? "outro" : `${outro} outros`);
  // If labels gave us nothing distinguishable, fall back to a plain count.
  if (parts.length === 0) return `${n} cut${n !== 1 ? "s" : ""}`;
  return parts.join(" + ");
}

// Count of sentences currently selected (yellow) - shown in the panel header so the
// user sees how many lines would be cut before they expand it.
export function selectedCount(selected) {
  return selected && typeof selected.size === "number" ? selected.size : 0;
}
