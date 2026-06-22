// Controlled-open + idempotent-capture decisions for the review gate, pulled out of
// SyncScreen as pure functions so the two things that matter - capture fires EXACTLY
// once per episode, and the open-set follows the user's toggle - are unit-testable
// without React or a DOM.
//
// CARDINAL RULE: nothing here touches what gets cut. Capture is best-effort metadata
// for the review dataset; the open-set drives only whether a <details> renders open.

// Does opening `uuid` need a first-open capture? True only the first time - once the
// uuid is in `reviewed`, re-opening (after a close) must NOT re-capture. This is the
// single source of the once-per-episode guarantee.
export function shouldCaptureOnOpen(reviewed, uuid) {
  if (!uuid) return false;
  const set = reviewed instanceof Set ? reviewed : new Set(reviewed || []);
  return !set.has(uuid);
}

// The next open-set after a toggle. A controlled <details> reports its DESIRED state
// (e.g. the user clicked to open or to close) and the parent's set must follow it, or
// the DOM and the React `open` prop desync. Open adds, close removes. Returns a NEW
// Set (never mutates the input) so React state updates are clean. A no-op toggle (open
// an already-open, close an already-closed) returns an equal new Set - harmless.
export function nextOpenSet(current, uuid, isOpen) {
  const next = new Set(current instanceof Set ? current : []);
  if (!uuid) return next;
  if (isOpen) next.add(uuid);
  else next.delete(uuid);
  return next;
}
