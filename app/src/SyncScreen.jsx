import { useEffect, useMemo, useRef, useState } from "react";
import { Btn, CoverArt, Progress } from "./Atoms.jsx";
import { Toolbar } from "./Shell.jsx";
import { fnameFor } from "./TodayScreen.jsx";
import { formatMB } from "./useDevice.js";
import { CutlistReview } from "./CutlistReview.jsx";
import { TranscriptEvidence } from "./TranscriptEvidence.jsx";
import { buildTrimAudioUrls, applyCutEdit } from "./trimAudio.js";

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
    { id: "delete",   label: "Remove old",    detail: "delete superseded files" },
    { id: "convert",  label: "Encode",        detail: encodeDetail },
    { id: "transfer", label: "Transfer",      detail: "copy to OpenSwim Pro" },
    { id: "verify",   label: "Verify",        detail: "checksum + eject-safe" },
  ];
}

function logKey(evt) {
  return evt.uuid ? `${evt.stage}:${evt.uuid}` : `${evt.stage}:${evt.text}`;
}

// The optional analysis stages (only present when Trim / Announce are on). They
// run between Remove-old and Encode. We surface each one the moment its first
// event arrives so the user can see the slow GPU work (transcribe -> detect ->
// speak) happening instead of staring at a frozen "Encode".
const ANALYSIS_STAGE_DEFS = {
  transcribe: { id: "transcribe", label: "Transcribe", detail: "speech to text" },
  trim: { id: "trim", label: "Find cuts", detail: "detect ads + intros" },
  announce: { id: "announce", label: "Write intros", detail: "summarise + speak" },
};
const ANALYSIS_ORDER = ["transcribe", "trim", "announce"];

function insertAnalysisStages(base, stageState) {
  const present = ANALYSIS_ORDER.filter((id) => stageState[id]);
  if (!present.length) return base;
  const extra = present.map((id) => ANALYSIS_STAGE_DEFS[id]);
  const ci = base.findIndex((s) => s.id === "convert");
  if (ci < 0) return [...base, ...extra];
  return [...base.slice(0, ci), ...extra, ...base.slice(ci)];
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
  // The review gate (approve-cuts step). When the backend holds the pipeline on
  // uncertain cuts it emits a `review` event carrying the flagged episodes; we
  // raise an overlay over the running view until the user clicks Continue, then
  // call sync.resolveReview() to release the pipeline. `null` = no gate open.
  const [review, setReview] = useState(null);
  // Decisions/edits the user makes IN the overlay, mirrored locally for an
  // immediate redraw (the per-cut IPC is the persistence layer the backend reads
  // back on resume). Keyed by uuid.
  const [reviewDecisions, setReviewDecisions] = useState({});
  const [reviewEditedCuts, setReviewEditedCuts] = useState({});
  const reviewAudioUrls = useMemo(() => buildTrimAudioUrls(downloadByUuid), [downloadByUuid]);
  // The gate is correct by construction: keep/remove/edit update ONLY local state
  // while the overlay is open (no incremental IPC), then Continue RE-SENDS the
  // authoritative current state to the backend, awaits every write, and only
  // resolves if all landed. This removes any dependence on earlier writes having
  // succeeded - a failed or dropped write can never leave the backend on stale
  // state, because Continue re-establishes it from scratch and fails closed.
  // A synchronous lock (ref, not state) is taken the instant Continue is pressed
  // so no decision/edit can mutate state mid-send; the boolean mirror drives the
  // disabled buttons + error line.
  const reviewLock = useRef(false);
  const [reviewResolving, setReviewResolving] = useState(false);
  const [reviewError, setReviewError] = useState(null);
  const cutKeyOf = (cut) => `${Math.round(Number(cut.startSec) * 1000)}-${Math.round(Number(cut.endSec) * 1000)}`;

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
    if (!devicePath) { setError("no device mounted"); setPhase("error"); return; }

    const off = api.onEvent((evt) => {
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
        setReview({ items: Array.isArray(evt.items) ? evt.items : [] });
      }
      else if (evt.type === "log") setLogByKey((m) => ({ ...m, [logKey(evt)]: evt }));
      else if (evt.type === "transcribe" || evt.type === "trim" || evt.type === "announce") {
        // Per-episode analysis progress: keep the latest event per (type, uuid).
        setSteps((m) => ({ ...m, [`${evt.type}:${evt.uuid}`]: evt }));
      }
      else if (evt.type === "finished") {
        if (evt.ok) setPhase("done");
        else { setError(evt.error?.message || "sync failed"); setPhase("error"); }
      }
    });

    api.start(spec).catch(() => {});
    return () => off && off();
  }, [phase, devicePath]);

  const cancel = async () => {
    const api = window.openswim && window.openswim.sync;
    if (api) await api.cancel();
    onBack();
  };

  // --- Review gate handlers ---
  // Keep/remove choice - LOCAL state only (the authoritative re-send happens at
  // Continue). Default stays KEEP - only an explicit REMOVE ever cuts (cardinal
  // rule). Keyed by the cut's CURRENT key so an edited-then-decided cut records
  // under its edited key; Continue reconciles both keys.
  const reviewDecide = (uuid, cut, decision) => {
    if (reviewLock.current) return; // gate is resolving - state is frozen
    if (!uuid || !cut) return;
    const key = cutKeyOf(cut);
    const value = decision === "remove" ? "remove" : "keep";
    setReviewDecisions((p) => ({ ...p, [uuid]: { ...(p[uuid] || {}), [key]: value } }));
  };
  // Boundary nudge/typed edit - LOCAL state only. Swaps the new boundaries into
  // the displayed cut list (it only changes WHAT a later REMOVE would cut).
  const reviewEdit = (uuid, originalCut, newCut) => {
    if (reviewLock.current) return; // gate is resolving - state is frozen
    if (!uuid || !originalCut || !newCut) return;
    setReviewEditedCuts((p) => {
      const cur = p[uuid] || (review && review.items.find((x) => x.uuid === uuid)?.cuts) || [];
      const next = applyCutEdit(cur, originalCut, newCut);
      if (next === cur) return p;
      return { ...p, [uuid]: next };
    });
  };
  // Release the pipeline. CARDINAL-RULE-SAFE ORDERING:
  // (1) take the synchronous lock so no decision/edit can mutate state mid-send;
  // (2) RE-SEND the authoritative current state to the backend - for every flagged
  //     DETECTED cut, send its current keep/remove (keyed by the detected cut so
  //     the backend's applyDecisions finds it), plus the boundary edit when the
  //     user adjusted it (so a remove applies at the adjusted range). This
  //     overrides any earlier dropped/failed write - the backend store is rebuilt
  //     from what is on screen RIGHT NOW;
  // (3) await every write and verify each LANDED (a rejected promise OR an
  //     { ok:false } reply = FAIL CLOSED: keep the gate open, show an error, do
  //     NOT resolve - never resume on uncertain state);
  // (4) only when all writes landed, resolve - itself fail-closed: if resolve
  //     errors, restore the gate rather than leaving the pipeline released-but-
  //     overlay-gone. The backend then resumes and emits stage:review done.
  const continueReview = async () => {
    if (reviewLock.current) return;
    reviewLock.current = true;
    setReviewResolving(true);
    setReviewError(null);
    // Any abnormal path keeps the gate OPEN with an error - never resume on
    // uncertain state. A missing bridge, a missing required edit, a rejected or
    // { ok:false } write, or a thrown call ALL fail closed here.
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
      if (!trimApi || !trimApi.decide) { failClosed("Decision bridge unavailable - cannot save choices. Try again."); return; }

      const sends = [];
      let editMissing = false;
      for (const item of (review ? review.items : [])) {
        const detected = item.cuts || [];
        const current = reviewEditedCuts[item.uuid] || detected;
        const decs = reviewDecisions[item.uuid] || {};
        detected.forEach((dcut, k) => {
          if (!dcut || !dcut.needsReview) return;
          const ccut = current[k] || dcut;
          const dKey = cutKeyOf(dcut);
          const cKey = cutKeyOf(ccut);
          // Decision may be recorded under the edited key (decided after editing)
          // or the detected key (decided before). Either reads as the intent.
          const value = (decs[cKey] || decs[dKey]) === "remove" ? "remove" : "keep";
          // A REMOVE at an adjusted boundary REQUIRES the edit to land first, else
          // the backend would cut the original (wider) detected range - the exact
          // cardinal-rule violation. Fail closed if the edit bridge is missing.
          if (value === "remove" && cKey !== dKey) {
            if (!trimApi.edit) { editMissing = true; return; }
            sends.push(Promise.resolve(trimApi.edit(item.uuid, dcut, { startSec: ccut.startSec, endSec: ccut.endSec })));
          }
          // Decision keyed by the DETECTED cut (backend looks it up there).
          sends.push(Promise.resolve(trimApi.decide(item.uuid, dcut, value)));
        });
      }
      if (editMissing) { failClosed("Couldn't save an adjusted boundary. Try again."); return; }

      const results = await Promise.allSettled(sends);
      const failed = results.some((r) => r.status === "rejected" || (r.value && r.value.ok === false));
      if (failed) { failClosed("A decision didn't save. Check the choices and press Continue again."); return; }

      const r = await syncApi.resolveReview();
      if (r && r.ok === false) { failClosed("Couldn't resume the transfer. Press Continue again."); return; }

      setReview(null);
      setReviewResolving(false);
      reviewLock.current = false;
    } catch {
      failClosed("Something went wrong saving your choices. Press Continue again.");
    }
  };

  const reviewFlaggedCount = review
    ? review.items.reduce((n, it) =>
        n + ((reviewEditedCuts[it.uuid] || it.cuts || []).filter((c) => c && c.needsReview).length), 0)
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
    return <SuccessScreen queue={queue} totalMB={totalMB} onDone={onDone} videoCount={videoCount} skippedCount={skipped.length} />;
  }

  if (phase === "error") {
    return (
      <div style={{ flex: 1, display: "flex", flexDirection: "column", minHeight: 0 }}>
        <Toolbar
          label="sync failed"
          title="Something went wrong."
          subtitle={error || "unknown error"}
          actions={<>
            <Btn variant="ghost" onClick={onBack}>back to today</Btn>
            <Btn variant="cta" onClick={() => { setError(null); setLogByKey({}); setStageState({}); setSteps({}); setServerPlan([]); setPhase("running"); }}>
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
          title={devicePath ? "Ready when you are." : "No headphones connected."}
          subtitle={devicePath
            ? [
                `${totalMB.toFixed(1)}MB across ${queue.length} file${queue.length !== 1 ? "s" : ""}`,
                removedPreview > 0 ? `~${removedPreview} to remove` : null,
                videoCount > 0 ? `${videoCount} video→audio` : null,
                playbackSpeed !== 1.0 ? `re-encoding at ${playbackSpeed}× speed` : null,
                boost ? "volume boost on" : null,
                skipped.length ? `${skipped.length} skipped (unreachable)` : null,
              ].filter(Boolean).join(" · ")
            : "Plug in your OpenSwim Pro before transferring."}
          actions={<>
            <Btn variant="ghost" onClick={onBack}>back to line-up</Btn>
            <Btn variant="cta" onClick={() => { onArm && onArm(); setPhase("running"); }} disabled={!queue.length || !devicePath}>
              {!devicePath ? "NO HEADPHONES"
                : queue.length ? `SEND · ${queue.length} EP`
                : fullQueue.length ? "WAITING FOR DOWNLOADS"
                : "NOTHING LINED UP"}
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
          <div style={{ padding: "24px 28px", display: "flex", flexDirection: "column",
            alignItems: "flex-start", justifyContent: "center", gap: 16 }}>
            <div className="ct-label">awaiting start</div>
            <div className="ct-subhead" style={{ maxWidth: 440 }}>
              Lock the line-up, remove yesterday's files, transcribe and find cuts, write intros, encode, copy to the headphones, verify.
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
        label={`Transfer · stage ${Math.max(1, currentStageIdx + 1)}/${stages.length} · ${stages[Math.max(0, currentStageIdx)].id}`}
        title="Sending to your headphones."
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
                  {reviewFlaggedCount} cut{reviewFlaggedCount !== 1 ? "s" : ""} across {review.items.length} episode{review.items.length !== 1 ? "s" : ""} need a decision
                </div>
              </div>
              <div style={{ width: 8, height: 8, borderRadius: "50%", background: "var(--ct-amber)" }}></div>
            </div>
            <div className="ct-dialog__body" style={{ overflow: "auto", flex: 1, padding: 0 }}>
              <div className="ct-meta" style={{ color: "var(--fg-muted)", padding: "12px 20px 4px" }}>
                These were left intact because they were ambiguous or over the safe length.
                Confident cuts have already been applied. Anything you don't mark{" "}
                <span style={{ color: "var(--ct-amber)" }}>REMOVE</span> is kept.
              </div>
              {review.items.map((item) => {
                const cuts = reviewEditedCuts[item.uuid] || item.cuts || [];
                return (
                  <div key={item.uuid} style={{ marginTop: 8 }}>
                    <div className="ct-label" style={{ padding: "0 20px" }}>{item.title}</div>
                    <CutlistReview
                      uuid={item.uuid}
                      trimEntry={{ cuts }}
                      decisions={reviewDecisions[item.uuid] || {}}
                      audioUrl={reviewAudioUrls[item.uuid]}
                      onDecide={reviewDecide}
                      onEditCut={reviewEdit} />
                    <TranscriptEvidence uuid={item.uuid} transcript={item.segments} trimEntry={{ cuts }} />
                  </div>
                );
              })}
            </div>
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

      <div style={{ flex: 1, display: "grid", gridTemplateColumns: "300px 1fr",
        minHeight: 0, borderTop: "1px solid var(--rule)" }}>
        <div style={{ borderRight: "1px solid var(--rule)", overflow: "auto", padding: "10px 0" }}>
          {stageProgress.map((st, si) => (
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
          ))}
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

function SuccessScreen({ queue, totalMB, onDone, videoCount, skippedCount = 0 }) {
  const totalMin = queue.reduce((s, x) => s + x.durMin, 0);
  const totalHM = `${Math.floor(totalMin / 60)}h ${Math.floor(totalMin % 60)}m`;
  const skipNote = skippedCount ? ` · ${skippedCount} skipped (unreachable)` : "";
  return (
    <div style={{ flex: 1, display: "flex", flexDirection: "column", minHeight: 0 }} className="ct-slide-in">
      <Toolbar
        label="transfer complete · safe to unplug"
        title="On your headphones."
        subtitle={`${queue.length} episode${queue.length !== 1 ? "s" : ""} renamed, converted, transferred, verified${skipNote}.`}
        actions={<>
          <Btn variant="secondary" onClick={onDone}>Back to queue</Btn>
          <Btn variant="cta" onClick={onDone}>DONE</Btn>
        </>}
      />
      <div style={{ padding: "20px", display: "grid", gap: 16, overflow: "auto" }}>
        <div className="stats">
          <div className="stats__cell">
            <div className="stats__label">Files</div>
            <div className="stats__value">{queue.length}</div>
            <div className="stats__sub">{queue.length} written</div>
          </div>
          <div className="stats__cell">
            <div className="stats__label">Listen time</div>
            <div className="stats__value">{totalHM}</div>
            <div className="stats__sub">≈ 2–3 swims</div>
          </div>
          <div className="stats__cell">
            <div className="stats__label">Transferred</div>
            <div className="stats__value">{totalMB.toFixed(0)}<span style={{ fontSize: 14, color: "var(--fg-muted)", marginLeft: 4 }}>MB</span></div>
            <div className="stats__sub">on device</div>
          </div>
          <div className="stats__cell">
            <div className="stats__label">Converted</div>
            <div className="stats__value">{videoCount}</div>
            <div className="stats__sub">video → audio</div>
          </div>
        </div>

        <div style={{ border: "1px solid var(--rule)", padding: "28px 20px",
          display: "grid", gridTemplateColumns: "1fr 280px", gap: 28, alignItems: "center",
          background: "var(--ct-coffee-deep)" }}>
          <div>
            <div className="ct-label">on device</div>
            <div style={{ display: "grid", gridTemplateColumns: "1fr", gap: 2, marginTop: 10 }}>
              {queue.map((it, i) => {
                const fname = fnameFor(it.show, i + 1, "mp3");
                return (
                  <div key={it.id} style={{ display: "grid", gridTemplateColumns: "24px 1fr auto",
                    gap: 10, padding: "6px 0", alignItems: "center",
                    borderBottom: "1px solid var(--rule)" }}>
                    <CoverArt show={it.show} size={20} />
                    <div style={{ fontFamily: "var(--font-mono)", fontSize: 12, color: "var(--fg)" }}>
                      {fname}
                    </div>
                    <div style={{ fontFamily: "var(--font-mono)", fontSize: 11, color: "var(--fg-muted)" }}>
                      {it.dur}
                    </div>
                  </div>
                );
              })}
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
