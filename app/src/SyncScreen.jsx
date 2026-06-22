import { useEffect, useMemo, useRef, useState } from "react";
import { Btn, CoverArt, Progress } from "./Atoms.jsx";
import { Toolbar } from "./Shell.jsx";
import { fnameFor } from "./TodayScreen.jsx";
import { formatMB } from "./useDevice.js";
import { TranscriptCutReview } from "./TranscriptCutReview.jsx";
import { buildTrimAudioUrls } from "./trimAudio.js";
import { sentenceLines, preselectFromCuts, toggleSentence, selectedToRanges, selectedCount, selectableCuts } from "./transcriptToggle.js";
import { degradeSummary } from "./degradeSummary.js";
import { snapshotInitial, buildCaptureRecords } from "./reviewCapture.js";
import { shouldCaptureOnOpen, nextOpenSet } from "./panelOpen.js";
import { buildReviewTargets, nextCursor, prevCursor, prevDisabled, nextDisabled } from "./reviewTargets.js";
import { commitAndCapture, cancelTransfer } from "./commitCapture.js";
import { sendDisabled, sendLabel } from "./sendGate.js";
import { initWaiting, reduceWaiting, bannerVisible } from "./waitingState.js";

// Two visible phases (presentational only - one runSync arc, not two IPC sessions).
// PREPARING covers the analysis + the review gate; TRANSFERRING covers the device
// IO. Every stage id is mapped to one of these so the stage list can render under a
// phase header. The execution order is
//   finalise -> transcribe -> find cuts -> write intros -> [review gate]
//     -> encode -> remove old -> copy -> verify
// Encode runs BEFORE remove-old so a convert failure cannot leave the device wiped
// with nothing written. The DISPLAY groups the analysis stages first (Preparing) and
// the device IO after (Transferring), and lists them in that execution order;
// "Finalise order" is shown under Transferring for legibility even though it executes
// first (it is a no-op label step, not device IO).
const PHASE_PREPARING = "preparing";
const PHASE_TRANSFERRING = "transferring";
const PHASE_OF = {
  transcribe: PHASE_PREPARING,
  trim: PHASE_PREPARING,
  announce: PHASE_PREPARING,
  review: PHASE_PREPARING,
  finalise: PHASE_TRANSFERRING,
  delete: PHASE_TRANSFERRING,
  convert: PHASE_TRANSFERRING,
  transfer: PHASE_TRANSFERRING,
  verify: PHASE_TRANSFERRING,
};
const PHASE_LABEL = { [PHASE_PREPARING]: "Preparing", [PHASE_TRANSFERRING]: "Transferring" };
const PHASE_ORDER = [PHASE_PREPARING, PHASE_TRANSFERRING];

function buildStages({ hasVideo, playbackSpeed, boost }) {
  const reEncode = playbackSpeed !== 1.0 || boost;
  let encodeDetail;
  if (hasVideo && reEncode) {
    const tags = [];
    if (playbackSpeed !== 1.0) tags.push(`${playbackSpeed}×`);
    if (boost) tags.push("boost");
    encodeDetail = `extract audio + ${tags.join(" + ")}`;
  } else if (hasVideo) {
    encodeDetail = "extract audio @ 128kbps";
  } else if (reEncode) {
    const tags = [];
    if (playbackSpeed !== 1.0) tags.push(`${playbackSpeed}×`);
    if (boost) tags.push("boost");
    encodeDetail = `apply ${tags.join(" + ")}`;
  } else {
    encodeDetail = "no encoding needed";
  }
  return [
    { id: "finalise", label: "Finalise order", detail: "locking slot numbers" },
    { id: "convert",  label: "Encode",        detail: encodeDetail },
    { id: "delete",   label: "Remove old",    detail: "delete superseded files" },
    { id: "transfer", label: "Transfer",      detail: "copy to OpenSwim Pro" },
    { id: "verify",   label: "Verify",        detail: "checksum + eject-safe" },
  ];
}

function logKey(evt) {
  return evt.uuid ? `${evt.stage}:${evt.uuid}` : `${evt.stage}:${evt.text}`;
}

// The optional analysis stages (only present when Trim / Announce are on), plus the
// review gate. These are the PREPARING phase. We surface each one the moment its
// first event arrives so the user can see the slow GPU work (transcribe -> detect ->
// speak -> review) happening. They are displayed FIRST (before the Transferring
// stages) to match the execution order: analysis + gate all complete before any
// device IO (encode/copy/verify, and - after the remove-old reorder - the delete).
const ANALYSIS_STAGE_DEFS = {
  transcribe: { id: "transcribe", label: "Transcribe", detail: "speech to text" },
  trim: { id: "trim", label: "Find cuts", detail: "detect ads + intros" },
  announce: { id: "announce", label: "Write intros", detail: "summarise + speak" },
  review: { id: "review", label: "Review cuts", detail: "approve before sending" },
};
// Order within the Preparing phase. review sits last - it is the gate at the end of
// Preparing, just before the Transferring stages begin.
const ANALYSIS_ORDER = ["transcribe", "trim", "announce", "review"];

// PREPEND the present Preparing stages (analysis + gate) before the base Transferring
// stages, so the displayed list reads Preparing-then-Transferring. A stage is
// "present" once any event has set its state (active/done). Returns the base list
// unchanged when no Preparing stage has started (plain transfer, no trim/announce).
function insertAnalysisStages(base, stageState) {
  const present = ANALYSIS_ORDER.filter((id) => stageState[id]);
  if (!present.length) return base;
  const extra = present.map((id) => ANALYSIS_STAGE_DEFS[id]);
  return [...extra, ...base];
}

// Turn the accumulated per-episode analysis events into human log lines.
function analysisLine(evt, title) {
  const t = title || "episode";
  if (evt.type === "transcribe") {
    if (evt.state === "active") return { state: "active", text: `Transcribing ${t}…` };
    if (evt.state === "skipped") return { state: "error", text: `Transcribe failed: ${t}` };
    return { state: "done", text: `Transcribed ${t}` };
  }
  if (evt.type === "trim") {
    if (evt.state === "analysing") return { state: "active", text: `Looking for cuts in ${t}…` };
    if (evt.state === "skipped" || evt.state === "idle") return { state: "done", text: `${t}: no cuts found` };
    const cuts = Array.isArray(evt.cuts) ? evt.cuts : [];
    const review = cuts.filter((c) => c && c.needsReview).length;
    const auto = cuts.length - review;
    const parts = [`${auto} cut${auto !== 1 ? "s" : ""}`];
    if (review) parts.push(`${review} need${review !== 1 ? "" : "s"} review`);
    return { state: "done", text: `${t}: ${parts.join(" · ")}` };
  }
  if (evt.type === "announce") {
    if (evt.state === "analysing") return { state: "active", text: `Writing intro for ${t}…` };
    if (evt.state === "skipped") return { state: "error", text: `Intro skipped: ${t}` };
    return { state: "done", text: `Intro ready: ${t}` };
  }
  return null;
}

export function SyncScreen({ items, order, onDevice, onDone, onBack, armed, onArm, setMountState, devicePath, downloadByUuid = {}, playbackSpeed = 1.0, boost = false, model, needsReviewMaxSec }) {
  const fullQueue = order.map((id) => items.find((x) => x.id === id)).filter(Boolean);
  const readyQueue = fullQueue.filter((it) => downloadByUuid[it.uuid]?.state === "ready");
  const skipped = fullQueue.filter((it) => !readyQueue.includes(it));
  // DOWNLOADS GATE. An episode is "in-flight" while its download is queued or still
  // downloading - i.e. NOT in a terminal state (ready / error / cancelled). A missing
  // state counts as in-flight too (App ensures the download, so "no state yet" means
  // it is about to start). We must never SEND while anything is still downloading
  // (sending the half-written file, or starting before its bytes land); but we must
  // also never block FOREVER on a failed download - error/cancelled are terminal, so
  // once every episode is terminal Send is allowed (the failed ones just get skipped
  // by readyQueue). downloadsPending drives the explicit "Preparing - waiting for N
  // download(s)" block on both this screen and Line-up's Send button.
  const DOWNLOAD_TERMINAL = new Set(["ready", "error", "cancelled"]);
  const inFlightDownloads = fullQueue.filter(
    (it) => !DOWNLOAD_TERMINAL.has(downloadByUuid[it.uuid]?.state)
  );
  const downloadsPending = inFlightDownloads.length;
  const videoCount = readyQueue.filter((x) => x.kind === "VIDEO").length;
  const totalMB = readyQueue.reduce((s, x) => s + x.sizeMB, 0);
  const queue = readyQueue;
  const STAGES = useMemo(() => buildStages({
    hasVideo: videoCount > 0, playbackSpeed, boost,
  }), [videoCount, playbackSpeed, boost]);

  const spec = useMemo(() => ({
    devicePath,
    speed: playbackSpeed,
    boost,
    // Chosen LM Studio model id (P4a) for the announce summary + trim detector.
    // Omitted when unset so the backend falls through to its locked default.
    ...(model ? { model } : {}),
    // Chosen sensitivity threshold (P4b), in seconds. Tunes flag-vs-auto-apply
    // only. Omitted when unset / non-positive so the backend falls through to the
    // locked NEEDS_REVIEW_MAX_SEC default; the cardinal rule is never weakened.
    ...((Number.isFinite(needsReviewMaxSec) && needsReviewMaxSec > 0) ? { needsReviewMaxSec } : {}),
    queue: readyQueue.map((it, i) => ({
      uuid: it.uuid,
      url: it.url,
      show: it.show,
      title: it.title,
      // Deterministic intro metadata (Fix 1) - threaded to announce.cjs via the
      // IPC layer (which spreads ...it) and sync.cjs generateIntro. published is
      // an ISO string; episode/season number are number|null (numbered shows
      // only). Spoken only when present; the intro never depends on these.
      published: it.published,
      episodeNumber: it.episodeNumber,
      seasonNumber: it.seasonNumber,
      slot: i + 1,
      filename: fnameFor(it.show, i + 1, "mp3"),
      ext: it.kind === "VIDEO" ? "mp4" : "mp3",
      sizeMB: it.sizeMB,
      durMin: it.durMin,
    })),
  }), [readyQueue, devicePath, playbackSpeed, boost, model, needsReviewMaxSec]);

  const [phase, setPhase] = useState(armed ? "running" : "idle");
  const [serverPlan, setServerPlan] = useState([]);
  const [stageState, setStageState] = useState({});
  const [logByKey, setLogByKey] = useState({});
  const [steps, setSteps] = useState({});
  const [error, setError] = useState(null);
  // The authoritative result of THIS run ({ transferred, totals, ... }) from the
  // awaited api.start(). SuccessScreen renders this - the files actually copied
  // and verified - NOT the live readyQueue, which can drift if a download
  // finishes mid-run.
  const [result, setResult] = useState(null);
  // The review gate (approve-cuts step). When the backend holds the pipeline on
  // uncertain cuts it emits a `review` event carrying the flagged episodes; we
  // raise an overlay over the running view until the user clicks Continue, then
  // call sync.resolveReview() to release the pipeline. `null` = no gate open.
  const [review, setReview] = useState(null);
  // DEVICE-DECOUPLE (slice 5). The parked "waiting for the headphones" state +
  // the device-free prepared summary, both derived from the slice-4 event contract
  // by the reduceWaiting pure reducer. Like the review gate this is a transient
  // BANNER over the running view, NOT a stage row - so the device-present case
  // (instant active->done park) never adds a flashing row to the progress tree.
  // `.active` is true only while parked; any terminal stage clears it.
  const [waiting, setWaiting] = useState(initWaiting);
  // A render nudge: bannerVisible debounces the parked banner against the grace
  // window, so when the wait goes active we schedule ONE re-render just past the
  // window to flip the banner on (if the wait is still active by then). The
  // device-present instant case resolves before this fires, so the banner is never
  // shown - no flash. `waitTick` exists only to force that single re-render.
  const [waitTick, setWaitTick] = useState(0);
  useEffect(() => {
    if (!waiting.active || waiting.since == null) return;
    const t = setTimeout(() => setWaitTick((n) => n + 1), 420);
    return () => clearTimeout(t);
  }, [waiting.active, waiting.since]);
  // Read against the current clock; waitTick is the re-render trigger (referenced so
  // the dependency is explicit and not dead).
  void waitTick;
  const showWaitingBanner = bannerVisible(waiting);
  // TRANSCRIPT-TOGGLE REDESIGN. The SELECTED (yellow) sentence indices per reviewed
  // episode, keyed by uuid -> Set<number>. The user reviews the whole transcript and
  // toggles sentences in/out; this is the authoritative review state. Seeded from
  // each review item's cuts (preselectFromCuts) when the `review` event arrives, so
  // the detector's cuts start yellow (default == today). Updated ONLY locally while
  // the overlay is open; Continue commits it via trim.setCuts and fails closed.
  const [reviewSelected, setReviewSelected] = useState({});
  // CONTROLLED-OPEN (slice 3). Which episode panels are open, owned here so a panel's
  // <details open> is the parent's decision, not the DOM's. A Set<uuid> in STATE (it
  // drives the open prop, so it must re-render), distinct from the capture-tracking refs
  // below which are pure observation. ensurePanelOpen is the ONE path that opens a panel
  // (user click now, programmatic nav in slice 4); it captures on first open then adds
  // the uuid. A user close just drops the uuid - it never re-captures or un-reviews.
  const [openUuids, setOpenUuids] = useState(new Set());
  // FLAGGED NAVIGATION (slice 4). A single cursor (index into reviewTargets) for the
  // one modal-level Next/Prev navigator that steps through every held cut across all
  // episodes, in modal-then-time order. A stable index over a fixed target list (it
  // walks ALL held cuts, not only unreviewed, so it never shrinks as the user toggles).
  // Navigation only changes HOW the user reaches a line - it adds/removes/changes no
  // cut (the jump routes through the same idempotent ensurePanelOpen a user click uses).
  // Starts at the PRE-FIRST sentinel -1: no target is "current" until the user steps,
  // so the FIRST "next flagged" lands on target 0 (otherwise a single target would be
  // unreachable - both ends disabled - and a multi-target list would skip target 1).
  const PRE_FIRST = -1;
  const [reviewCursor, setReviewCursor] = useState(PRE_FIRST);
  const reviewAudioUrls = useMemo(() => buildTrimAudioUrls(downloadByUuid), [downloadByUuid]);
  // The gate is correct by construction: toggles update ONLY local state while the
  // overlay is open (no incremental IPC), then Continue RE-SENDS the authoritative
  // final cut-set (the contiguous selected runs) to the backend, awaits every write,
  // and only resolves if all landed. A failed/dropped write can never leave the
  // backend on stale state - Continue re-establishes the whole set from scratch and
  // fails closed. A synchronous lock (ref, not state) is taken the instant Continue
  // is pressed so no toggle can mutate state mid-send; the boolean mirror drives the
  // disabled buttons + error line.
  const reviewLock = useRef(false);
  const [reviewResolving, setReviewResolving] = useState(false);
  const [reviewError, setReviewError] = useState(null);

  // REVIEW-CAPTURE TRACKING (slice 4). Plain refs, NOT state: this is observational
  // metadata for the best-effort dataset write, never anything the cut-set or the
  // render depends on, so it must not trigger re-renders or interact with the commit.
  //   reviewedUuids   episodes the user OPENED (records are built only for these).
  //   reviewSnapshots uuid -> frozen snapshotInitial taken at FIRST open (the proposal
  //                   + lines the user saw); captures intent before any toggle.
  //   reviewOpenedAt  uuid -> ms of first open (for openDurationMs).
  //   reviewToggles   uuid -> toggle count (drives edited + toggleCount).
  // ALL are reset when a new `review` event arrives so a prior gate never leaks in.
  const reviewedUuids = useRef(new Set());
  const reviewSnapshots = useRef({});
  const reviewOpenedAt = useRef({});
  const reviewToggles = useRef({});

  // Base stages + any analysis stages that have started. Title lookup for log lines.
  const stages = useMemo(() => insertAnalysisStages(STAGES, stageState), [STAGES, stageState]);
  const titleByUuid = useMemo(() => {
    const m = {};
    for (const it of fullQueue) if (it.uuid) m[it.uuid] = it.title;
    return m;
  }, [fullQueue]);

  useEffect(() => {
    if (phase === "running") setMountState && setMountState("busy");
    if (phase === "done" || phase === "error" || phase === "idle") setMountState && setMountState("mounted");
  }, [phase, setMountState]);

  useEffect(() => {
    if (phase !== "running") return;
    const api = window.openswim && window.openswim.sync;
    if (!api) { setError("sync bridge unavailable"); setPhase("error"); return; }
    // No device gate here any more. The backend preps device-free then PARKS until
    // the headphones are plugged in (slice 4); a null devicePath at start is fine -
    // the park gets its device from the watcher, not from spec.devicePath.

    const off = api.onEvent((evt) => {
      // Fold every event into the parked/prepared banner state (no-op for events it
      // does not recognise). Drives the device-free "N prepared" summary + the
      // waiting-for-device banner; clears the banner on any terminal stage.
      setWaiting((w) => reduceWaiting(w, evt));
      if (evt.type === "plan") setServerPlan(evt.plan);
      else if (evt.type === "stage") {
        setStageState((m) => ({ ...m, [evt.stage]: evt.state }));
        // The pipeline resumes past the gate by emitting stage:review done -
        // tear the overlay down so the progress view shows the finish.
        if (evt.stage === "review" && evt.state === "done") setReview(null);
      }
      else if (evt.type === "review") {
        reviewLock.current = false;
        setReviewResolving(false);
        setReviewError(null);
        // New gate session - clear all capture tracking so a prior gate's opens,
        // snapshots, or toggle counts can never leak into this one's records.
        reviewedUuids.current = new Set();
        reviewSnapshots.current = {};
        reviewOpenedAt.current = {};
        reviewToggles.current = {};
        // New gate - every panel starts collapsed (observable behaviour unchanged).
        setOpenUuids(new Set());
        // New gate - reset the flagged-nav cursor to the pre-first sentinel.
        setReviewCursor(PRE_FIRST);
        const items = Array.isArray(evt.items) ? evt.items : [];
        setReview({ items });
        // Seed each episode's selected (yellow) set from its detector cuts, so the
        // transcript opens with the detector's cuts already selected (default ==
        // today: the detector's cuts get cut unless the user greys them).
        const seed = {};
        for (const item of items) {
          const lines = sentenceLines({ segments: item.segments || [] });
          seed[item.uuid] = preselectFromCuts(lines, { cuts: item.cuts || [] });
        }
        setReviewSelected(seed);
      }
      else if (evt.type === "log") setLogByKey((m) => ({ ...m, [logKey(evt)]: evt }));
      else if (evt.type === "transcribe" || evt.type === "trim" || evt.type === "announce") {
        // Per-episode analysis progress: keep the latest event per (type, uuid).
        setSteps((m) => ({ ...m, [`${evt.type}:${evt.uuid}`]: evt }));
      }
      // NOTE: the `finished` event is intentionally NOT used to transition phase
      // or build the success screen. We drive both from the awaited api.start()
      // result below, which is inherently correlated to THIS run - a stale event
      // from an earlier/other run can never flip this screen to done.
    });

    // The awaited result IS the authoritative outcome of THIS run: { ok, files,
    // transferred, totals }. SuccessScreen renders `transferred` (what was really
    // copied + verified), never the live queue.
    api.start(spec).then((r) => {
      if (r && r.ok) { setResult(r.data || null); setPhase("done"); }
      else { setError((r && r.error && r.error.message) || "sync failed"); setPhase("error"); }
    }).catch((e) => { setError((e && e.message) || "sync failed"); setPhase("error"); });
    return () => off && off();
    // Keyed on `phase` ONLY. The run must start exactly once when phase -> running.
    // Before the device-decouple this also depended on devicePath, which was safe
    // because a run could not start without a device. Now a run can start with a
    // null device and the headphones get plugged in mid-run; re-firing on a
    // devicePath change would call api.start() a SECOND time (a double-start). The
    // backend park takes the device from the watcher, not spec.devicePath, so the
    // effect deliberately does not react to devicePath.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [phase]);

  // Cancel/abandon. Routes through cancelTransfer (the commit/capture counterpart) so
  // the "capture never fires on cancel" guarantee is structural: this path cannot reach
  // setCuts, resolveReview, or review.capture.
  const cancel = () => cancelTransfer({
    cancel: () => { const api = window.openswim && window.openswim.sync; return api && api.cancel(); },
    onBack,
  });

  // --- Review gate handlers (transcript-toggle) ---
  // Toggle one sentence in/out of an episode's selected (yellow) set - LOCAL state
  // only (the authoritative commit happens at Continue). CARDINAL RULE: a sentence
  // is cut only when selected at Continue; toggling cuts nothing itself.
  const onReviewToggle = (uuid, index) => {
    if (reviewLock.current) return; // gate is resolving - state is frozen
    if (!uuid || !Number.isFinite(index)) return;
    // A toggle implies the panel is open; count it for the capture's edited signal.
    // Pure observation - never affects the selection or the commit.
    reviewToggles.current[uuid] = (reviewToggles.current[uuid] || 0) + 1;
    setReviewSelected((p) => ({ ...p, [uuid]: toggleSentence(p[uuid] || new Set(), index) }));
  };
  // Open a panel. THE single open path - user click now, programmatic nav in slice 4.
  // On the FIRST open of an episode it records it REVIEWED and freezes the initial
  // snapshot (the proposal + lines as the detector posed them) from the SAME
  // sentenceLines the gate collapses at Continue, BEFORE any toggle can mutate the
  // selection. shouldCaptureOnOpen is the once-per-episode guard: a re-open after a
  // close never re-captures. The snapshot is wrapped so a snapshot error can never
  // break the gate; capture for that episode is simply dropped. Best-effort and
  // side-effect-free with respect to the cut-set. THEN the uuid joins openUuids so the
  // panel renders open.
  const ensurePanelOpen = (uuid) => {
    if (!uuid) return;
    if (shouldCaptureOnOpen(reviewedUuids.current, uuid)) {
      reviewedUuids.current.add(uuid);
      reviewOpenedAt.current[uuid] = Date.now();
      try {
        const item = (review ? review.items : []).find((it) => it.uuid === uuid);
        if (item) {
          const lines = sentenceLines({ segments: item.segments || [] });
          reviewSnapshots.current[uuid] = snapshotInitial({ lines, cuts: item.cuts || [] });
        }
      } catch {
        // snapshot failed - leave it absent so buildCaptureRecords skips this episode
      }
    }
    setOpenUuids((cur) => nextOpenSet(cur, uuid, true));
  };
  // The panel reported a native <details> toggle. Open routes through ensurePanelOpen
  // (capture-then-open); close just drops the uuid from the open-set so the controlled
  // `open` prop follows the DOM. A close NEVER re-captures or un-reviews - the snapshot
  // and reviewed mark, once taken at first open, persist for the whole gate.
  const onPanelToggle = (uuid, isOpen) => {
    if (isOpen) ensurePanelOpen(uuid);
    else setOpenUuids((cur) => nextOpenSet(cur, uuid, false));
  };

  // FLAGGED-NAV targets: one { uuid, lineIndex } per held cut, in modal-then-time
  // order. Pure (buildReviewTargets), recomputed only when the gate's items change -
  // NOT on toggles, so the target list and the cursor stay stable while the user edits.
  const reviewTargets = useMemo(
    () => buildReviewTargets(review ? review.items : []),
    [review],
  );
  // The active target the scroll effect tracks. NULL at the pre-first sentinel (or any
  // out-of-range cursor) so nothing is scrolled to / treated as current until the user
  // takes the first step. reviewTargets[-1] is undefined -> null, which is exactly right.
  const activeTarget = reviewTargets[reviewCursor] || null;

  // Jump to a target: OPEN its panel via the slice-3 ensurePanelOpen (the SAME
  // idempotent capture-then-open path a user click uses - so a jump correctly, once,
  // marks the episode reviewed and never alters a cut), then move the cursor. The
  // scroll itself is a SEPARATE post-commit effect keyed on the active target (below):
  // ensurePanelOpen owns capture, the effect owns scrolling, never the reverse.
  const jumpToTarget = (cursor) => {
    const target = reviewTargets[cursor];
    if (!target) return;
    ensurePanelOpen(target.uuid);
    setReviewCursor(cursor);
  };
  // Button enablement, from the RAW cursor (which may be the -1 sentinel) via the pure
  // sentinel-aware predicates. nextCursor/prevCursor still clamp the landing index.
  const navPrevDisabled = prevDisabled(reviewCursor, reviewTargets.length);
  const navNextDisabled = nextDisabled(reviewCursor, reviewTargets.length);
  // The 1-based position shown in the progress label - 0 while at the pre-first
  // sentinel (nothing selected yet), else cursor+1.
  const navPosition = reviewCursor < 0 ? 0 : reviewCursor + 1;

  // Post-commit scroll: after the active target's panel body has mounted, scroll its
  // line into view. Keyed on the active {uuid, lineIndex} so it re-runs on every nav
  // step (and after the panel opens). requestAnimationFrame defers to the next frame so
  // the just-opened <details> body is in the DOM. Guarded - a missing element is a
  // no-op (the panel may not render, or rAF may be absent in a test env). Scroll-only:
  // it reads no selection and writes no cut.
  useEffect(() => {
    if (!review || !activeTarget) return;
    const raf = typeof requestAnimationFrame === "function"
      ? requestAnimationFrame : (cb) => setTimeout(cb, 0);
    const cancel = typeof cancelAnimationFrame === "function"
      ? cancelAnimationFrame : clearTimeout;
    const id = raf(() => {
      const el = document.querySelector(
        `[data-uuid="${activeTarget.uuid}"] [data-index="${activeTarget.lineIndex}"]`,
      );
      if (el && typeof el.scrollIntoView === "function") el.scrollIntoView({ block: "center" });
    });
    return () => cancel(id);
  }, [review, activeTarget && activeTarget.uuid, activeTarget && activeTarget.lineIndex]);
  // Per-episode final cut ranges = the contiguous selected sentence runs. Computed
  // from the live selection + the episode's sentence lines. This is exactly what
  // gets cut at Continue.
  const reviewRangesFor = (item) => {
    const lines = sentenceLines({ segments: item.segments || [] });
    return selectedToRanges(lines, reviewSelected[item.uuid] || new Set());
  };
  // Release the pipeline. CARDINAL-RULE-SAFE ORDERING:
  // (1) take the synchronous lock so no toggle can mutate state mid-send;
  // (2) RE-SEND the authoritative final cut-set per episode (the contiguous selected
  //     runs -> [startSec,endSec] ranges) via trim.setCuts. This OVERRIDES any earlier
  //     state - the backend's cut-set is rebuilt from what is selected RIGHT NOW. An
  //     episode with nothing selected sends [] (cut nothing - cardinal-rule safe);
  // (3) await every write and verify each LANDED (a rejected promise OR an
  //     { ok:false } reply = FAIL CLOSED: keep the gate open, show an error, do NOT
  //     resolve - never resume on uncertain state);
  // (4) only when all writes landed, resolve - itself fail-closed: if resolve errors,
  //     restore the gate rather than leave the pipeline released-but-overlay-gone.
  //     The backend then cuts EXACTLY the sent ranges and emits stage:review done.
  const continueReview = async () => {
    if (reviewLock.current) return;
    reviewLock.current = true;
    setReviewResolving(true);
    setReviewError(null);
    // Any abnormal path keeps the gate OPEN with an error - never resume on uncertain
    // state. A missing bridge, a rejected or { ok:false } write, or a thrown call ALL
    // fail closed here.
    const failClosed = (msg) => {
      reviewLock.current = false;
      setReviewResolving(false);
      setReviewError(msg);
    };

    try {
      const trimApi = window.openswim && window.openswim.trim;
      const syncApi = window.openswim && window.openswim.sync;
      // The bridges that actually commit + release MUST be present.
      if (!syncApi || !syncApi.resolveReview) { failClosed("Sync bridge unavailable - cannot resume. Try again."); return; }
      if (!trimApi || !trimApi.setCuts) { failClosed("Decision bridge unavailable - cannot save choices. Try again."); return; }

      const items = review ? review.items : [];

      // GATHER capture inputs BEFORE any await. resolveReview can unmount/clear the
      // gate, so the inputs must be frozen here or they can be lost. This is purely
      // observational - if it throws, captureInputs stays null and the commit proceeds
      // EXACTLY as today (no capture). It can never perturb what setCuts receives.
      let captureInputs = null;
      try {
        const finalSelected = {};
        for (const item of items) finalSelected[item.uuid] = new Set(reviewSelected[item.uuid] || new Set());
        captureInputs = {
          items,
          reviewedUuids: new Set(reviewedUuids.current),
          snapshots: { ...reviewSnapshots.current },
          finalSelected,
          openedAt: { ...reviewOpenedAt.current },
          toggleCounts: { ...reviewToggles.current },
        };
      } catch {
        captureInputs = null;
      }

      // Commit + capture via the cardinal-safe seam. setCuts gets EXACTLY today's
      // ranges; capture fires fire-and-forget ONLY after a successful resolve, fully
      // wrapped. A capture throw / absent bridge cannot change the committed cut-set or
      // fail-close the transfer (proven in commitCapture.test.js). The capture bridge is
      // resolved LAZILY inside the callback, so window.openswim.review is not even touched
      // until after a successful setCuts + resolveReview - a side-effecting getter cannot
      // run pre-commit. The callback is invoked inside commitAndCapture's wrapped try.
      const result = await commitAndCapture({
        items,
        rangesFor: (item) => reviewRangesFor(item).map((r) => [r.startSec, r.endSec]),
        setCuts: (uuid, ranges, ext) => trimApi.setCuts(uuid, ranges, ext),
        resolveReview: () => syncApi.resolveReview(),
        capture: (records) => {
          const reviewApi = window.openswim && window.openswim.review;
          if (reviewApi && typeof reviewApi.capture === "function") return reviewApi.capture(records);
        },
        buildRecords: captureInputs
          ? () => buildCaptureRecords({ ...captureInputs, committedAt: Date.now(), makeCaptureId: () => crypto.randomUUID() })
          : () => [],
        onResolved: () => {
          setReview(null);
          setReviewResolving(false);
          reviewLock.current = false;
        },
      });

      if (!result.ok) {
        const msg = result.reason === "setCuts"
          ? "A choice didn't save. Check the lines and press Continue again."
          : "Couldn't resume the transfer. Press Continue again.";
        failClosed(msg);
      }
    } catch {
      failClosed("Something went wrong saving your choices. Press Continue again.");
    }
  };

  // Total selected (yellow) lines across all reviewed episodes - shown in the gate
  // header so the user sees how much is queued to cut before they commit.
  const reviewSelectedLines = review
    ? review.items.reduce((n, it) => n + selectedCount(reviewSelected[it.uuid]), 0)
    : 0;

  // Total cuts the DETECTOR found across all reviewed episodes. Surfaced alongside
  // the selected-line count so "0 selected" never reads as "found nothing" - the
  // detector may have found several cuts that are all grey (held) pending a click.
  const reviewCutsFound = review
    ? review.items.reduce((n, it) => n + ((it.cuts && it.cuts.length) || 0), 0)
    : 0;

  // Episodes whose detection was incomplete (degraded). Counted gate-wide so a
  // degraded episode - especially one with ZERO cuts that would otherwise look clean -
  // is never silently skipped: the gate header carries an "N had incomplete detection"
  // line. Informational only; this never changes a cut.
  const reviewDegradedCount = review
    ? review.items.filter((it) => it.degrade && it.degrade.degraded).length
    : 0;

  const stageCounts = stages.map((st) => ({
    ...st,
    count: serverPlan.filter((p) => p.stage === st.id).length,
  }));

  // Announce is now narrated as an analysis stage (per-episode lines below), not a
  // plan line item - it never emits a "done" log, so leaving it in planWithLog
  // would stall the progress bar. Drop it here.
  const planWithLog = serverPlan
    .filter((p) => p.stage !== "announce")
    .map((p) => ({ ...p, log: logByKey[logKey(p)] }));
  const doneCount = planWithLog.filter((p) => p.log?.state === "done").length;
  const overall = planWithLog.length ? doneCount / planWithLog.length : 0;

  const currentStage = (() => {
    for (const st of stages) {
      if (stageState[st.id] === "active") return st.id;
    }
    return stages.find((st) => stageState[st.id] !== "done")?.id || "verify";
  })();
  const currentStageIdx = stages.findIndex((s) => s.id === currentStage);
  // Which of the two phases is live, from the current stage. Drives the header label
  // ("Preparing" while transcribing/finding cuts/at the gate; "Transferring" once the
  // device IO begins). The review gate is the last Preparing step.
  const currentPhase = PHASE_OF[currentStage] || PHASE_TRANSFERRING;

  // Per-episode analysis lines for the right-hand log, ordered by slot then step.
  const analysisLines = ANALYSIS_ORDER.flatMap((type) =>
    Object.values(steps)
      .filter((e) => e.type === type)
      .sort((a, b) => (a.slot || 0) - (b.slot || 0))
      .map((e) => ({ key: `${type}:${e.uuid}`, ...analysisLine(e, titleByUuid[e.uuid]) }))
      .filter((l) => l && l.text)
  );

  const stageProgress = stages.map((st) => {
    const stageItems = planWithLog.filter((p) => p.stage === st.id);
    const done = stageItems.filter((p) => p.log?.state === "done").length;
    const active = stageItems.some((p) => p.log?.state === "active");
    const pct = stageItems.length ? (done + (active ? 0.3 : 0)) / stageItems.length
      : (stageState[st.id] === "done" ? 1 : 0);
    return {
      ...st, items: stageItems, pct,
      state: stageState[st.id] || "pending",
      done, total: stageItems.length,
    };
  });

  if (phase === "done") {
    const transferred = (result && Array.isArray(result.transferred)) ? result.transferred : [];
    // Episodes that are ready NOW but were NOT in this run's transferred set -
    // e.g. a download that finished mid-sync. We must not imply they were sent;
    // surface them honestly so the user can run the transfer again.
    const sentUuids = new Set(transferred.map((t) => t.uuid));
    const pending = readyQueue.filter((it) => it.uuid && !sentUuids.has(it.uuid));
    return <SuccessScreen result={result} transferred={transferred} pending={pending}
      onDone={onDone} skippedCount={skipped.length} />;
  }

  if (phase === "error") {
    return (
      <div style={{ flex: 1, display: "flex", flexDirection: "column", minHeight: 0 }}>
        <Toolbar
          label="sync failed"
          title="Something went wrong."
          subtitle={error || "unknown error"}
          actions={<>
            <Btn variant="ghost" onClick={onBack}>back to line-up</Btn>
            <Btn variant="cta" onClick={() => { setError(null); setLogByKey({}); setStageState({}); setSteps({}); setServerPlan([]); setWaiting(initWaiting()); setPhase("running"); }}>
              RETRY
            </Btn>
          </>}
        />
        <div style={{ padding: 24, color: "var(--ct-error)", fontFamily: "var(--font-mono)", fontSize: 12, whiteSpace: "pre-wrap" }}>
          ✗ {error}
        </div>
      </div>
    );
  }

  if (phase === "idle") {
    const removedPreview = onDevice.filter((d) => !queue.some((q) => (d.uuid && q.uuid === d.uuid) || q.show === d.show)).length;
    return (
      <div style={{ flex: 1, display: "flex", flexDirection: "column", minHeight: 0 }}>
        <Toolbar
          label={`Transfer · ${queue.length} ready${skipped.length ? ` · ${skipped.length} skipped` : ""}`}
          title={downloadsPending ? "Preparing…" : "Ready when you are."}
          subtitle={downloadsPending
            ? `Preparing - waiting for ${downloadsPending} download${downloadsPending !== 1 ? "s" : ""} to finish before sending.`
            : [
                `${totalMB.toFixed(1)}MB across ${queue.length} file${queue.length !== 1 ? "s" : ""}`,
                removedPreview > 0 ? `~${removedPreview} to remove` : null,
                videoCount > 0 ? `${videoCount} video→audio` : null,
                playbackSpeed !== 1.0 ? `re-encoding at ${playbackSpeed}× speed` : null,
                boost ? "volume boost on" : null,
                skipped.length ? `${skipped.length} skipped (unreachable)` : null,
                // No device gate any more: prep runs now, transfer happens on
                // plug-in. Say so plainly when no headphones are connected yet.
                !devicePath ? "no headphones yet - we'll transfer when you plug in" : null,
              ].filter(Boolean).join(" · ")}
          actions={<>
            <Btn variant="ghost" onClick={onBack}>back to line-up</Btn>
            <Btn variant="cta" onClick={() => { onArm && onArm(); setPhase("running"); }}
              disabled={sendDisabled({ downloadsPending, queueLength: queue.length })}>
              {sendLabel({ downloadsPending, queueLength: queue.length })}
            </Btn>
          </>}
        />
        <div style={{ flex: 1, display: "grid", gridTemplateColumns: "300px 1fr", minHeight: 0 }}>
          <div style={{ borderRight: "1px solid var(--rule)", padding: "10px 0" }}>
            {STAGES.map((st, si) => (
              <div key={st.id} className="stage" data-state="pending">
                <div className="stage__bullet">{si + 1}</div>
                <div style={{ minWidth: 0 }}>
                  <div className="stage__label">{st.label}</div>
                  <div className="stage__label stage__detail" style={{ marginTop: 3 }}>{st.detail}</div>
                </div>
                <div className="stage__right"></div>
              </div>
            ))}
          </div>
          <div style={{ padding: "16px 28px", display: "flex", flexDirection: "column",
            alignItems: "flex-start", justifyContent: "flex-start", gap: 16 }}>
            <div className="ct-label">awaiting start</div>
            <div className="ct-subhead" style={{ maxWidth: 440 }}>
              Two phases. First we prepare - transcribe, find cuts, write intros, then
              you review every cut. Then we transfer - remove yesterday's files, encode,
              copy to the headphones, verify. Nothing on the device is touched until you
              approve the cuts.
            </div>
            <div className="ct-meta" style={{ color: "var(--fg-dim)", maxWidth: 440, lineHeight: 1.8 }}>
              Nothing is written to your headphones until you press{" "}
              <span style={{ color: "var(--ct-amber)", fontWeight: 600 }}>SEND</span>.
            </div>
          </div>
        </div>
      </div>
    );
  }

  return (
    <div style={{ flex: 1, display: "flex", flexDirection: "column", minHeight: 0 }}>
      <Toolbar
        label={`${(PHASE_LABEL[currentPhase] || "Transferring").toUpperCase()} · stage ${Math.max(1, currentStageIdx + 1)}/${stages.length} · ${stages[Math.max(0, currentStageIdx)].id}`}
        title={currentPhase === PHASE_PREPARING ? "Preparing your episodes." : "Sending to your headphones."}
        subtitle={`${doneCount}/${planWithLog.length} · ${(overall * 100).toFixed(0)}%`}
        actions={<Btn variant="ghost" onClick={cancel}>cancel</Btn>}
      />
      <div style={{ padding: "0 20px" }}>
        <Progress value={overall * 100} />
      </div>

      {review && (
        <div className="ct-overlay">
          <div className="ct-dialog" onClick={(e) => e.stopPropagation()}
            style={{ minWidth: 640, maxWidth: 780, maxHeight: "86vh", display: "flex", flexDirection: "column" }}>
            <div className="ct-dialog__head">
              <div>
                <div className="ct-label" style={{ color: "var(--ct-amber)" }}>Review before sending</div>
                <div className="ct-subhead" style={{ marginTop: 4 }}>
                  {reviewCutsFound} cut{reviewCutsFound !== 1 ? "s" : ""} found · {reviewSelectedLines} line{reviewSelectedLines !== 1 ? "s" : ""} selected to cut across {review.items.length} episode{review.items.length !== 1 ? "s" : ""}
                </div>
                {reviewDegradedCount > 0 && (
                  <div className="ct-meta" style={{ marginTop: 4, color: "var(--ct-amber)" }}>
                    ⚠ {reviewDegradedCount} episode{reviewDegradedCount !== 1 ? "s" : ""} had incomplete detection - some ads may have been missed.
                  </div>
                )}
              </div>
              <div style={{ width: 8, height: 8, borderRadius: "50%", background: "var(--ct-amber)" }}></div>
            </div>
            <div className="ct-dialog__body" style={{ overflow: "auto", flex: 1, padding: 0 }}>
              <div className="ct-meta" style={{ color: "var(--fg-muted)", padding: "12px 20px 4px" }}>
                Open an episode and read its transcript.{" "}
                <span style={{ color: "var(--ct-amber)" }}>Yellow</span> lines will be cut;
                grey lines are kept. Click any line to add or remove it from the cut.
              </div>
              {review.items.map((item) => {
                // Whether the per-episode panel will render at all: it needs a usable
                // cut AND a usable transcript (TranscriptCutReview's own null-gate). A
                // DEGRADED episode with zero cuts renders no panel, so we surface its
                // warning here instead - otherwise that (silent "looks clean") case
                // would show nothing, which is the whole point of this feature.
                const panelRenders =
                  selectableCuts({ cuts: item.cuts || [] }).length > 0
                  && sentenceLines({ segments: item.segments || [] }).length > 0;
                const fallbackDegradeText = (!panelRenders && item.degrade)
                  ? degradeSummary(item.degrade) : "";
                return (
                  <div key={item.uuid} style={{ marginTop: 8 }}>
                    <div className="ct-label" style={{ padding: "0 20px" }}>{item.title}</div>
                    {fallbackDegradeText && (
                      <div style={{ fontFamily: "var(--font-mono)", fontSize: 10, letterSpacing: ".5px",
                        color: "var(--ct-amber)", border: "1px solid var(--ct-amber)", borderRadius: 2,
                        padding: "4px 8px", margin: "6px 20px 0" }}>
                        ⚠ {fallbackDegradeText}
                      </div>
                    )}
                    <TranscriptCutReview
                      uuid={item.uuid}
                      transcript={item.segments}
                      trimEntry={{ cuts: item.cuts || [] }}
                      selected={reviewSelected[item.uuid]}
                      onToggleSentence={onReviewToggle}
                      audioUrl={reviewAudioUrls[item.uuid]}
                      open={openUuids.has(item.uuid)}
                      onOpenChange={onPanelToggle}
                      degrade={item.degrade} />
                  </div>
                );
              })}
            </div>
            {reviewTargets.length > 0 && (
              // FLAGGED NAVIGATOR (slice 4). One modal-level Prev/Next that steps
              // through every held cut across all episodes. Always reachable (it sits
              // above the actions row). Buttons DISABLE at the ends (clamp, no wrap);
              // the progress label shows where the cursor is. A jump opens the target's
              // panel and scrolls to its line - it never changes a cut.
              <div className="ct-review-nav" style={{ display: "flex", alignItems: "center",
                gap: 10, padding: "8px 20px", borderTop: "1px solid var(--rule)" }}>
                <span className="ct-meta" style={{ color: "var(--ct-amber)" }}>
                  ⚑ Flagged {navPosition} / {reviewTargets.length}
                </span>
                <div style={{ flex: 1 }} />
                <Btn variant="ghost"
                  onClick={() => jumpToTarget(prevCursor(reviewCursor, reviewTargets.length))}
                  disabled={reviewResolving || navPrevDisabled}>
                  ‹ prev flagged
                </Btn>
                <Btn variant="ghost"
                  onClick={() => jumpToTarget(nextCursor(reviewCursor, reviewTargets.length))}
                  disabled={reviewResolving || navNextDisabled}>
                  next flagged ›
                </Btn>
              </div>
            )}
            {reviewError && (
              <div className="ct-meta" style={{ color: "var(--ct-error)", padding: "0 20px 8px" }}>
                ✗ {reviewError}
              </div>
            )}
            <div className="ct-dialog__actions">
              <Btn variant="ghost" onClick={cancel} disabled={reviewResolving}>cancel transfer</Btn>
              <Btn variant="cta" onClick={continueReview} disabled={reviewResolving}>
                {reviewResolving ? "SAVING…" : "CONTINUE · FINISH TRANSFER"}
              </Btn>
            </div>
          </div>
        </div>
      )}

      {showWaitingBanner && (
        // PARKED, waiting for the headphones. A non-interactive banner (the only
        // action is cancel, already in the toolbar) over the running view. It clears
        // the moment the waiting-for-device stage goes done/cancelled/error, so the
        // device-present instant case never flashes a stuck banner. The prepared
        // summary (if it arrived) gives the honest "N episodes prepared" count.
        <div style={{ margin: "12px 20px 0", padding: "12px 16px",
          border: "1px solid var(--ct-amber)", background: "var(--ct-amber-ghost, rgba(230,170,80,0.12))",
          display: "flex", alignItems: "center", gap: 12 }}>
          <div style={{ width: 8, height: 8, borderRadius: "50%", background: "var(--ct-amber)", flexShrink: 0 }}>
            <span style={{ display: "block", width: "100%", height: "100%" }} />
          </div>
          <div style={{ minWidth: 0 }}>
            <div className="ct-label" style={{ color: "var(--ct-amber)" }}>
              Prepared - plug in your headphones to transfer
            </div>
            <div className="ct-meta" style={{ color: "var(--fg-dim)", marginTop: 3 }}>
              {waiting.prepared && waiting.prepared.length
                ? `${waiting.prepared.length} episode${waiting.prepared.length !== 1 ? "s" : ""} prepared and ready. Plug in your OpenSwim Pro and the transfer finishes on its own.`
                : "Plug in your OpenSwim Pro and the transfer finishes on its own."}
            </div>
          </div>
        </div>
      )}

      <div style={{ flex: 1, display: "grid", gridTemplateColumns: "300px 1fr",
        minHeight: 0, borderTop: "1px solid var(--rule)" }}>
        <div style={{ borderRight: "1px solid var(--rule)", overflow: "auto", padding: "10px 0" }}>
          {PHASE_ORDER.map((ph) => {
            // The stages that belong to this phase, in their display order. A phase
            // with no stages yet (e.g. Preparing on a plain transfer with no
            // trim/announce) renders nothing - no empty header.
            const phaseStages = stageProgress.filter((st) => PHASE_OF[st.id] === ph);
            if (!phaseStages.length) return null;
            const isActivePhase = currentPhase === ph;
            const allDone = phaseStages.every((st) => st.state === "done");
            return (
              <div key={ph} className="stage-phase" data-phase={ph} data-active={isActivePhase ? "true" : undefined}>
                <div className="stage-phase__head" style={{ display: "flex", alignItems: "center", gap: 8,
                  padding: "4px 18px 6px", fontFamily: "var(--font-mono)", fontSize: 10, letterSpacing: "1.5px",
                  textTransform: "uppercase",
                  color: isActivePhase ? "var(--ct-amber)" : allDone ? "var(--ct-tea)" : "var(--fg-muted)" }}>
                  <span>{PHASE_LABEL[ph]}</span>
                  {isActivePhase && <span style={{ fontSize: 9 }}>● active</span>}
                  {!isActivePhase && allDone && <span style={{ fontSize: 9 }}>✓ done</span>}
                </div>
                {phaseStages.map((st) => {
                  // Bullet number is the stage's position in the FULL list so the
                  // numbering stays stable across the two phase groups.
                  const si = stages.findIndex((s) => s.id === st.id);
                  return (
                    <div key={st.id} className="stage" data-state={st.state}>
                      <div className="stage__bullet">
                        {st.state === "done" ? "✓" : st.state === "active" ? "▸" : si + 1}
                      </div>
                      <div style={{ minWidth: 0 }}>
                        <div className="stage__label">{st.label}</div>
                        <div className="stage__label stage__detail" style={{ marginTop: 3 }}>
                          {st.state === "done" ? "done" : st.detail}
                        </div>
                      </div>
                      <div className="stage__right">
                        {st.state !== "pending" && (
                          <div style={{ width: 40, height: 2, background: "var(--rule)", position: "relative" }}>
                            <div style={{ position: "absolute", inset: 0, width: `${st.pct * 100}%`,
                              background: st.state === "done" ? "var(--ct-tea)" : "var(--ct-amber)" }} />
                          </div>
                        )}
                      </div>
                    </div>
                  );
                })}
              </div>
            );
          })}
        </div>

        <div style={{ padding: "16px 20px", overflow: "auto", background: "var(--ct-coffee-deep)" }}>
          <div className="ct-log">
            {planWithLog.length === 0 && analysisLines.length === 0 && (
              <div className="ct-log__line--active">▸ preparing sync…</div>
            )}
            {analysisLines.map((l) => {
              const cls = l.state === "done" ? "ct-log__line--done"
                : l.state === "active" ? "ct-log__line--active"
                : l.state === "error" ? "ct-log__line--pending"
                : "ct-log__line--pending";
              const prefix = l.state === "done" ? "✓" : l.state === "active" ? "▸" : l.state === "error" ? "✗" : "·";
              return (
                <div key={l.key} className={cls} style={{ display: "grid",
                  gridTemplateColumns: "18px 1fr auto", gap: 10,
                  color: l.state === "error" ? "var(--ct-error)" : undefined }}>
                  <span>{prefix}</span>
                  <span style={{ whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis" }}>{l.text}</span>
                  <span></span>
                </div>
              );
            })}
            {planWithLog.map((p, i) => {
              const state = p.log?.state || "pending";
              const cls = state === "done" ? "ct-log__line--done"
                : state === "active" ? "ct-log__line--active"
                : state === "error" ? "ct-log__line--pending"
                : "ct-log__line--pending";
              const prefix = state === "done" ? "✓" : state === "active" ? "▸" : state === "error" ? "✗" : "·";
              let right = "";
              if (p.log && p.log.total && p.log.bytes != null) {
                if (p.stage === "convert") right = `${p.log.bytes.toFixed(1)}s / ${p.log.total.toFixed(1)}s`;
                else if (p.stage === "transfer") right = `${formatMB(p.log.bytes / (1024 * 1024))} / ${formatMB(p.log.total / (1024 * 1024))}`;
              }
              return (
                <div key={i} className={cls} style={{ display: "grid",
                  gridTemplateColumns: "18px 1fr auto", gap: 10,
                  color: state === "error" ? "var(--ct-error)" : undefined }}>
                  <span>{prefix}</span>
                  <span style={{ whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis" }}>
                    {p.log?.text || p.text}
                  </span>
                  <span style={{ color: "var(--fg-muted)" }}>{right}</span>
                </div>
              );
            })}
            <div style={{ marginTop: 10, color: "var(--fg-muted)" }}>
              <span className="ct-cursor">▍</span>
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}

// Format a seconds value as "Xh Ym" / "Ym" / "Ms", or null -> "—".
function hmFromSec(sec) {
  if (!Number.isFinite(sec) || sec <= 0) return "—";
  const total = Math.round(sec);
  const h = Math.floor(total / 3600);
  const m = Math.floor((total % 3600) / 60);
  if (h > 0) return `${h}h ${m}m`;
  if (m > 0) return `${m}m`;
  return `${total}s`;
}
// h:mm:ss / mm:ss for a single episode duration, or "—" when unknown.
function clockFromSec(sec) {
  if (!Number.isFinite(sec) || sec < 0) return "—";
  const total = Math.round(sec);
  const h = Math.floor(total / 3600);
  const m = Math.floor((total % 3600) / 60);
  const s = total % 60;
  const ss = String(s).padStart(2, "0");
  if (h > 0) return `${h}:${String(m).padStart(2, "0")}:${ss}`;
  return `${m}:${ss}`;
}

// Renders ONLY what was actually copied and verified this run (the authoritative
// `transferred` set + `totals` from runSync), never the live queue. `pending` is
// any episode that is ready now but was NOT in this run (e.g. a download that
// finished mid-sync) - surfaced honestly so the user can run the transfer again.
function SuccessScreen({ result, transferred = [], pending = [], onDone, skippedCount = 0 }) {
  const totals = (result && result.totals) || {
    files: transferred.length,
    bytes: transferred.reduce((s, t) => s + (t.bytes || 0), 0),
    listenTimeSec: transferred.reduce((s, t) => s + (t.durationSec || 0), 0),
    listenTimeComplete: transferred.length > 0 && transferred.every((t) => t.durationSec != null),
    converted: transferred.filter((t) => t.converted).length,
  };
  const files = totals.files != null ? totals.files : transferred.length;
  // Don't present a partial duration sum as the full listen time. When some
  // durations are unknown, mark it approximate ("~") rather than imply exactness.
  const listenComplete = totals.listenTimeComplete !== false;
  const listenLabel = totals.listenTimeSec > 0
    ? (listenComplete ? hmFromSec(totals.listenTimeSec) : `~${hmFromSec(totals.listenTimeSec)}`)
    : "—";
  const notes = [];
  if (pending.length) notes.push(`${pending.length} ready but not sent`);
  if (skippedCount) notes.push(`${skippedCount} skipped (unreachable)`);
  const noteStr = notes.length ? ` · ${notes.join(" · ")}` : "";
  return (
    <div style={{ flex: 1, display: "flex", flexDirection: "column", minHeight: 0 }} className="ct-slide-in">
      <Toolbar
        label="transfer complete · safe to unplug"
        title="On your headphones."
        subtitle={`${files} episode${files !== 1 ? "s" : ""} transferred and verified${noteStr}.`}
        actions={<>
          <Btn variant="secondary" onClick={onDone}>Back to queue</Btn>
          <Btn variant="cta" onClick={onDone}>DONE</Btn>
        </>}
      />
      <div style={{ padding: "20px", display: "grid", gap: 16, overflow: "auto" }}>
        {pending.length > 0 && (
          <div style={{ border: "1px solid var(--ct-amber)", padding: "10px 14px",
            background: "var(--ct-amber-ghost, rgba(230,170,80,0.12))", color: "var(--ct-amber)",
            fontFamily: "var(--font-mono)", fontSize: 12 }}>
            ⚠ {pending.length} episode{pending.length !== 1 ? "s" : ""} finished downloading after this transfer started and {pending.length !== 1 ? "were" : "was"} not copied:
            {" "}{pending.map((p) => p.title).join(", ")}. Run the transfer again to send {pending.length !== 1 ? "them" : "it"}.
          </div>
        )}
        <div className="stats">
          <div className="stats__cell">
            <div className="stats__label">Files</div>
            <div className="stats__value">{files}</div>
            <div className="stats__sub">verified on device</div>
          </div>
          <div className="stats__cell">
            <div className="stats__label">Listen time</div>
            <div className="stats__value">{listenLabel}</div>
            <div className="stats__sub">{listenComplete ? "after trim + speed" : "partial (some unknown)"}</div>
          </div>
          <div className="stats__cell">
            <div className="stats__label">Transferred</div>
            <div className="stats__value">{formatMB((totals.bytes || 0) / (1024 * 1024))}</div>
            <div className="stats__sub">actual bytes</div>
          </div>
          <div className="stats__cell">
            <div className="stats__label">Converted</div>
            <div className="stats__value">{totals.converted || 0}</div>
            <div className="stats__sub">re-encoded</div>
          </div>
        </div>

        <div style={{ border: "1px solid var(--rule)", padding: "28px 20px",
          display: "grid", gridTemplateColumns: "1fr 280px", gap: 28, alignItems: "center",
          background: "var(--ct-coffee-deep)" }}>
          <div>
            <div className="ct-label">on device</div>
            <div style={{ display: "grid", gridTemplateColumns: "1fr", gap: 2, marginTop: 10 }}>
              {transferred.length === 0 && (
                <div className="ct-meta" style={{ color: "var(--fg-muted)", padding: "6px 0" }}>
                  Nothing was transferred this run.
                </div>
              )}
              {transferred.map((t) => (
                <div key={t.uuid || t.fname} style={{ display: "grid", gridTemplateColumns: "24px 1fr auto",
                  gap: 10, padding: "6px 0", alignItems: "center",
                  borderBottom: "1px solid var(--rule)" }}>
                  <CoverArt show={t.show} size={20} />
                  <div style={{ fontFamily: "var(--font-mono)", fontSize: 12, color: "var(--fg)" }}>
                    {t.fname}
                  </div>
                  <div style={{ fontFamily: "var(--font-mono)", fontSize: 11, color: "var(--fg-muted)" }}>
                    {clockFromSec(t.durationSec)}
                  </div>
                </div>
              ))}
            </div>
          </div>
          <div style={{ display: "flex", alignItems: "center", justifyContent: "center" }}>
            <svg width="240" height="140" viewBox="0 0 240 140">
              <g fill="none" stroke="var(--ct-tea)" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                <path d="M 30 70 Q 120 10 210 70" />
                <path d="M 30 70 Q 26 90 40 100 L 60 100 Q 72 100 72 88 L 72 74" />
                <path d="M 210 70 Q 214 90 200 100 L 180 100 Q 168 100 168 88 L 168 74" />
              </g>
              <g fill="rgba(221,244,201,0.22)">
                <rect x="44" y="80" width="16" height="12" />
                <rect x="180" y="80" width="16" height="12" />
              </g>
              <circle cx="120" cy="42" r="3" fill="var(--ct-amber)">
                <animate attributeName="opacity" values="1;.4;1" dur="2s" repeatCount="indefinite" />
              </circle>
              <text x="120" y="120" textAnchor="middle" fill="var(--fg-dim)"
                fontFamily="var(--font-mono)" fontSize="10" letterSpacing="1.5">OPENSWIM PRO</text>
            </svg>
          </div>
        </div>
      </div>
    </div>
  );
}

export function VolumePicker({ onClose, onPicked }) {
  const [vols, setVols] = useState(null);
  const [error, setError] = useState(null);
  const [claiming, setClaiming] = useState(null);

  const refresh = async () => {
    const api = window.openswim && window.openswim.device;
    if (!api) { setError("device bridge unavailable"); return; }
    const r = await api.listVolumes();
    if (r.ok) setVols(r.data); else setError(r.error?.message || "failed to list volumes");
  };

  useEffect(() => { refresh(); }, []);

  const pick = async (v) => {
    setClaiming(v.path);
    const api = window.openswim.device;
    const r = await api.claim(v.path);
    setClaiming(null);
    if (r.ok) { onPicked && onPicked(v); onClose && onClose(); }
    else setError(r.error?.message || "couldn't claim volume");
  };

  return (
    <div className="ct-overlay" onClick={onClose}>
      <div className="ct-dialog" onClick={(e) => e.stopPropagation()} style={{ minWidth: 460 }}>
        <div className="ct-dialog__head">
          <div>
            <div className="ct-label">Pick your OpenSwim</div>
            <div className="ct-subhead" style={{ marginTop: 4 }}>Which volume is it?</div>
          </div>
          <div onClick={refresh} style={{ cursor: "pointer", fontFamily: "var(--font-mono)", fontSize: 10,
            color: "var(--fg-muted)", letterSpacing: "1.2px" }}>REFRESH</div>
        </div>
        <div className="ct-dialog__body">
          {error && <div className="ct-meta" style={{ color: "var(--ct-error)", marginBottom: 8 }}>✗ {error}</div>}
          {vols === null && <div className="ct-meta" style={{ color: "var(--fg-muted)" }}>scanning /Volumes…</div>}
          {vols && vols.length === 0 && (
            <div className="ct-meta" style={{ color: "var(--fg-muted)" }}>
              no volumes found. plug in the OpenSwim and hit REFRESH.
            </div>
          )}
          {vols && vols.length > 0 && (
            <div style={{ display: "flex", flexDirection: "column", gap: 2 }}>
              {vols.map((v) => (
                <div key={v.path}
                  onClick={() => pick(v)}
                  style={{
                    display: "grid", gridTemplateColumns: "1fr auto auto",
                    alignItems: "center", gap: 14, padding: "10px 12px",
                    cursor: claiming ? "wait" : "pointer",
                    border: "1px solid var(--rule)",
                    background: v.matches ? "var(--ct-tea-ghost)" : "transparent",
                    opacity: claiming && claiming !== v.path ? 0.4 : 1,
                  }}>
                  <div style={{ minWidth: 0 }}>
                    <div style={{ color: "var(--fg)", fontSize: 13 }}>
                      {v.label}
                      {v.matches && <span style={{ marginLeft: 8, color: "var(--ct-tea)", fontSize: 10 }}>· detected</span>}
                    </div>
                    <div className="ct-meta" style={{ color: "var(--fg-muted)", marginTop: 2 }}>{v.path}</div>
                  </div>
                  <div className="ct-meta" style={{ color: "var(--fg-dim)", fontFamily: "var(--font-mono)" }}>
                    {v.capacityMB != null ? formatMB(v.capacityMB) : "—"}
                  </div>
                  <div className="ct-meta" style={{ color: "var(--fg-muted)", fontFamily: "var(--font-mono)" }}>
                    {v.freeMB != null ? `${formatMB(v.freeMB)} free` : ""}
                  </div>
                </div>
              ))}
            </div>
          )}
          <div className="ct-meta" style={{ color: "var(--fg-muted)", marginTop: 14 }}>
            Picking a volume writes <code>.openswim-podcast</code> to its root so we recognise it next time.
          </div>
        </div>
        <div className="ct-dialog__actions">
          <Btn variant="ghost" onClick={onClose}>cancel</Btn>
        </div>
      </div>
    </div>
  );
}

export function MountDialog({ state, free, used, path, onClose, onForce }) {
  const pathLabel = path || (state === "unmounted" ? "(not mounted)" : "/Volumes/OPENSWIM");
  const [ejecting, setEjecting] = useState(false);
  const [error, setError] = useState(null);

  const doEject = async () => {
    setError(null);
    const api = window.openswim && window.openswim.device;
    if (!api) { setError("device bridge unavailable"); return; }
    if (!path) { setError("no device path"); return; }
    setEjecting(true);
    const r = await api.eject(path);
    setEjecting(false);
    if (r.ok) onClose && onClose();
    else setError(r.error?.message || "eject failed");
  };

  return (
    <div className="ct-overlay" onClick={onClose}>
      <div className="ct-dialog" onClick={(e) => e.stopPropagation()}>
        <div className="ct-dialog__head">
          <div>
            <div className="ct-label">OpenSwim Pro · {pathLabel}</div>
            <div className="ct-subhead" style={{ marginTop: 4 }}>Safely unplug</div>
          </div>
          <div style={{ width: 8, height: 8, borderRadius: "50%",
            background: state === "busy" ? "var(--ct-amber)" : "var(--ct-tea)" }}></div>
        </div>
        <div className="ct-dialog__body">
          <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 14, marginBottom: 14 }}>
            <div>
              <div className="ct-label">Used</div>
              <div className="ct-title" style={{ marginTop: 4, color: "var(--fg)" }}>{used.toFixed(0)}MB</div>
            </div>
            <div>
              <div className="ct-label">Free</div>
              <div className="ct-title" style={{ marginTop: 4, color: "var(--fg)" }}>{free.toFixed(0)}MB</div>
            </div>
          </div>
          <div className="ct-meta" style={{ color: state === "busy" ? "var(--ct-amber)" : "var(--fg-dim)" }}>
            {state === "busy" ? "⚠ writing files — force unplug will corrupt the last transfer." : "safe to unplug · no pending writes."}
          </div>
          {error && (
            <div className="ct-meta" style={{ color: "var(--ct-error)", marginTop: 10, whiteSpace: "pre-wrap" }}>
              ✗ {error}
            </div>
          )}
        </div>
        <div className="ct-dialog__actions">
          <Btn variant="ghost" onClick={onClose} disabled={ejecting}>cancel</Btn>
          {state === "busy" && <Btn variant="destructive" onClick={onForce} disabled={ejecting}>Force unplug</Btn>}
          <Btn variant="primary" onClick={doEject} disabled={state === "busy" || ejecting}>
            {ejecting ? "Unplugging…" : "Unplug safely"}
          </Btn>
        </div>
      </div>
    </div>
  );
}
