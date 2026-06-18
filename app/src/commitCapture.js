// The cardinal-safe commit/capture SEQUENCING, extracted as a pure async seam so the
// guarantee is provable in a unit test instead of a DOM harness. The transfer path -
// setCuts per episode, allSettled, fail-closed check, resolveReview, fail-closed check
// - is EXACTLY today's. Capture is bolted on AFTER a successful resolve, fire-and-
// forget, fully wrapped, so it can NEVER change what setCuts receives, block the
// commit, or fail-close the transfer.
//
// CARDINAL GUARANTEE (the cut-set-unchanged proof). setCuts receives the SAME ranges
// and resolveReview is reached in EVERY capture world: capture succeeds, buildRecords
// throws, capture throws synchronously, capture returns a rejected promise, capture is
// absent. The commit cannot perceive the capture.
//
// All side effects are injected so the core stays pure and testable:
//   items          the episodes to commit, in order.
//   rangesFor      (item) => [[startSec,endSec], ...] - the authoritative cut-set.
//   setCuts        (uuid, ranges, ext) => Promise<{ok}> | {ok} - the commit write.
//   resolveReview  () => Promise<{ok}> - releases the pipeline past the gate.
//   buildRecords   () => records[] - builds the capture batch (may throw / be heavy).
//   capture        (records) => any - the fire-and-forget bridge (may be undefined).
//   onResolved     () => void - called once on the success path (e.g. setReview(null)).
//
// Returns { ok, reason }. ok:true means the transfer was released. ok:false means a
// fail-closed path was hit (reason names which); the caller keeps the gate open. A
// capture failure NEVER flips ok to false.
// Cancel/abandon the gate. Deliberately the COUNTERPART to commitAndCapture: it touches
// NEITHER the commit (setCuts/resolveReview) NOR capture - it just cancels the run and
// goes back. Extracted so "capture never fires on cancel" is a real, asserted contract
// (the cancel path simply has no way to reach capture), not a hope. cancel may be absent
// (no bridge) - then we still go back.
export async function cancelTransfer({ cancel, onBack }) {
  if (typeof cancel === "function") await cancel();
  if (typeof onBack === "function") onBack();
}

export async function commitAndCapture({
  items = [], rangesFor, setCuts, resolveReview, buildRecords, capture, onResolved,
}) {
  // (1) Commit every episode's final cut-set. Identical to today: build the writes,
  //     await all, fail closed if any rejected or replied { ok:false }.
  const sends = items.map((item) =>
    Promise.resolve(setCuts(item.uuid, rangesFor(item), item.ext)));
  const results = await Promise.allSettled(sends);
  const failed = results.some((r) => r.status === "rejected" || (r.value && r.value.ok === false));
  if (failed) return { ok: false, reason: "setCuts" };

  // (2) Release the pipeline. Fail closed on a thrown or { ok:false } resolve.
  const r = await resolveReview();
  if (r && r.ok === false) return { ok: false, reason: "resolve" };

  // (3) Success. Tear the gate down FIRST (the committed state is final), THEN fire
  //     capture fire-and-forget. The WHOLE of build + fire is wrapped: a throw from
  //     buildRecords or capture, or capture being undefined, is swallowed and cannot
  //     change the ok:true outcome.
  if (onResolved) onResolved();
  try {
    if (typeof capture === "function") {
      const records = buildRecords ? buildRecords() : [];
      // Fire-and-forget. The real bridge (preload review.capture) returns a Promise,
      // so swallow a rejection too - an async capture failure must never surface as an
      // unhandled rejection. We never await or inspect the result.
      const out = capture(records);
      if (out && typeof out.then === "function") out.then(() => {}, () => {});
    }
  } catch {
    // best-effort: a synchronous capture failure must never surface or fail-close
  }
  return { ok: true };
}
