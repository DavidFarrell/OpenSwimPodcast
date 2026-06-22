// Cross-episode flagged-cut navigation - pure logic. No React, no DOM, so the
// ordering and the cursor maths are unit-testable on their own.
//
// THE MODEL. The review gate lists one panel per episode (in the modal's order).
// Within an episode the detector may have HELD some cuts for review (needsReview ===
// true). The navigator steps through those held cuts one at a time - the unit of
// navigation is a held CUT, not a single line. A target is the FIRST held line of each
// held cut, ordered by episode (modal order) then by time within the episode.
//
// CARDINAL RULE: nothing here touches what gets cut. A target is just a place to scroll
// to; opening a panel to reach it routes through the same idempotent open path a user
// click uses (SyncScreen.ensurePanelOpen), so navigation never adds, removes, or alters
// a cut. We WALK ALL held cuts, including ones the user has already opted into, so the
// cursor is a stable index that does not shrink as the user toggles (decision 2).

import { sentenceLines, selectableCuts, heldLines } from "./transcriptToggle.js";

// Build the ordered list of navigation targets across every episode.
//   episodes - the review items, in modal order: [{ uuid, segments, cuts }].
// Returns an ordered array of { uuid, lineIndex }, ONE per held cut. For each episode
// (in order) and each held cut (needsReview === true) in time order, the target is that
// cut's FIRST held line index. An episode with no held cuts contributes nothing.
//
// A held cut's lines are found by reusing heldLines (the set of line indices whose
// midpoint lands inside ANY held cut). To split that set back into per-cut targets we
// walk each held cut's [startSec,endSec] and take the smallest held-line index whose
// midpoint falls inside THAT cut - the first held line of that cut. Cuts are sorted by
// startSec so targets within an episode are in time order. Pure; never throws.
export function buildReviewTargets(episodes) {
  const targets = [];
  if (!Array.isArray(episodes)) return targets;
  for (const ep of episodes) {
    if (!ep || !ep.uuid) continue;
    const lines = sentenceLines({ segments: ep.segments || [] });
    if (!lines.length) continue;
    // The line indices the detector held for review in this episode.
    const held = heldLines(lines, { cuts: ep.cuts || [] });
    if (held.size === 0) continue;
    // The held cuts themselves, in time order, so each contributes one target and the
    // targets come out time-ordered within the episode.
    const heldCuts = selectableCuts({ cuts: ep.cuts || [] })
      .filter((c) => c && c.needsReview === true)
      .sort((a, b) => Number(a.startSec) - Number(b.startSec));
    for (const cut of heldCuts) {
      const s = Number(cut.startSec);
      const e = Number(cut.endSec);
      // First held line whose midpoint falls inside THIS cut. lines are in transcript
      // (time) order, so the first match is the cut's first held line.
      const first = lines.find((line) => {
        if (!held.has(line.index)) return false;
        const mid = (line.startSec + line.endSec) / 2;
        return mid >= s && mid <= e;
      });
      if (first) targets.push({ uuid: ep.uuid, lineIndex: first.index });
    }
  }
  return targets;
}

// Clamp a cursor into [0, n-1]. A cursor over an empty target list (n === 0) clamps to
// 0 (the callers also guard on n === 0 so nothing is navigated). Pure.
function clampCursor(cursor, n) {
  if (n <= 0) return 0;
  if (cursor < 0) return 0;
  if (cursor > n - 1) return n - 1;
  return cursor;
}

// Next cursor: advance by one, CLAMPED at the last target (no wrap, decision 1).
export function nextCursor(cursor, n) {
  return clampCursor(cursor + 1, n);
}

// Previous cursor: step back by one, CLAMPED at the first target (no wrap, decision 1).
export function prevCursor(cursor, n) {
  return clampCursor(cursor - 1, n);
}

// Button-disable predicates, SENTINEL-aware (the cursor may be the pre-first -1, where
// no target is current yet). "Prev" is dead when there is nothing before the cursor -
// cursor <= 0 covers both the first target and the -1 sentinel. "Next" is dead only at
// the last real target (cursor >= n-1); at the sentinel with >= 1 target it stays LIVE
// so the first step is reachable. n === 0 disables both (the navigator is hidden anyway).
// Kept pure + separate from nextCursor/prevCursor so the end-of-list disabling is unit-
// tested, not buried inline in the JSX. clampCursor stays in use via next/prevCursor.
export function prevDisabled(cursor, n) {
  if (n <= 0) return true;
  return cursor <= 0;
}
export function nextDisabled(cursor, n) {
  if (n <= 0) return true;
  return cursor >= n - 1;
}
