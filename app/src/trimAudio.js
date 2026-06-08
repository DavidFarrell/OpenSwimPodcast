// P3b wiring helpers (pure) - turn the download manager's per-uuid entries into
// the audio URLs the CutlistReview previews play, and apply an in-place boundary
// edit to a uuid's proposed cut list. Kept as a plain module (no React, no DOM)
// so the App's trim-preview/edit wiring is unit-testable.
//
// CARDINAL RULE: editing only changes WHAT a later REMOVE would cut. applyCutEdit
// never adds, drops or reorders cuts - it swaps a single cut's boundaries for the
// already-validated new boundaries (the invert guard lives in cutlistReview.js /
// the IPC layer). It returns the SAME array reference when nothing matched so the
// caller can skip a needless state update.

import { cutKey } from "./cutlistReview.js";

// Build a file:// URL for a downloaded episode so the renderer's <audio> element
// can play it. Only "ready" downloads with a real local path get a URL; anything
// still downloading / errored / pathless returns null so previews stay disabled
// (CARDINAL RULE for previews: never point the player at a partial file).
export function fileUrlForDownload(entry) {
  if (!entry || entry.state !== "ready") return null;
  const p = entry.path;
  if (typeof p !== "string" || p === "") return null;
  if (/^[a-z]+:\/\//i.test(p)) return p; // already a URL
  // Encode each path segment but keep the separators, so spaces / unicode in the
  // cache path survive. Leading slash is preserved as file:///abs/path.
  const encoded = p.split("/").map((seg) => encodeURIComponent(seg)).join("/");
  return `file://${encoded}`;
}

// Map { uuid: downloadEntry } -> { uuid: audioUrl } for every ready download.
// Episodes without a playable file are simply omitted (CutlistReview treats a
// missing url as "previews disabled").
export function buildTrimAudioUrls(downloadByUuid) {
  const out = {};
  if (!downloadByUuid) return out;
  for (const [uuid, entry] of Object.entries(downloadByUuid)) {
    const url = fileUrlForDownload(entry);
    if (url) out[uuid] = url;
  }
  return out;
}

// Replace the cut matching originalCut (by stable cutKey) with newCut's
// boundaries, preserving every other field (label, reasons, needsReview). Returns
// the same array if the list is empty or no cut matched, so the caller can avoid
// a no-op state update.
export function applyCutEdit(cuts, originalCut, newCut) {
  if (!Array.isArray(cuts) || !cuts.length || !originalCut || !newCut) return cuts;
  const target = cutKey(originalCut);
  if (!target) return cuts;
  let matched = false;
  const next = cuts.map((c) => {
    if (!matched && cutKey(c) === target) {
      matched = true;
      return { ...c, startSec: newCut.startSec, endSec: newCut.endSec };
    }
    return c;
  });
  return matched ? next : cuts;
}
