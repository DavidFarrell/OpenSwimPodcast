import { useState } from "react";
import { Btn, CoverArt, DragHandle } from "./Atoms.jsx";
import { Toolbar } from "./Shell.jsx";
import { effectiveAnnounce } from "./announcePrefs.js";
import { effectiveTrim } from "./trimPrefs.js";
import { CutlistReview } from "./CutlistReview.jsx";
import { TranscriptEvidence } from "./TranscriptEvidence.jsx";

import { fnameFor } from "./slugShow.js";
export { fnameFor };

function shortenError(msg) {
  if (!msg) return "error";
  if (/404/.test(msg)) return "404 not found";
  if (/403/.test(msg)) return "403 forbidden";
  if (/5\d\d/.test(msg)) return "server error";
  if (/ENOTFOUND|EAI_AGAIN|getaddrinfo/i.test(msg)) return "dns failed";
  if (/ECONNREFUSED|ECONNRESET/i.test(msg)) return "connection refused";
  if (/timeout/i.test(msg)) return "timeout";
  return msg.length > 28 ? msg.slice(0, 28) + "…" : msg;
}

function DownloadBadge({ state, onRetry }) {
  if (!state) return null;
  const { state: s, bytes = 0, total, error } = state;
  if (s === "ready") {
    return <span style={{ marginLeft: 8, color: "var(--ct-tea)", fontSize: 10 }}>✓ cached</span>;
  }
  if (s === "error") {
    return (
      <span style={{ marginLeft: 8, display: "inline-flex", alignItems: "center", gap: 6 }} title={error || "download failed"}>
        <span style={{ color: "var(--ct-error)", fontSize: 10 }}>✗ {shortenError(error)}</span>
        {onRetry && (
          <button onClick={(e) => { e.stopPropagation(); onRetry(); }}
            style={{
              fontFamily: "var(--font-mono)", fontSize: 9, letterSpacing: ".5px",
              color: "var(--ct-amber)", background: "transparent",
              border: "1px solid var(--rule)", padding: "1px 5px", cursor: "pointer",
            }}>RETRY</button>
        )}
      </span>
    );
  }
  if (s === "cancelled") {
    return <span style={{ marginLeft: 8, color: "var(--fg-muted)", fontSize: 10 }}>cancelled</span>;
  }
  const pct = total ? Math.min(100, Math.round((bytes / total) * 100)) : 0;
  return (
    <span style={{ marginLeft: 8, display: "inline-flex", alignItems: "center", gap: 6 }}>
      <span style={{ width: 40, height: 3, background: "var(--rule)", position: "relative", display: "inline-block" }}>
        <span style={{ position: "absolute", left: 0, top: 0, bottom: 0, width: `${pct}%`, background: "var(--ct-amber)" }} />
      </span>
      <span style={{ color: "var(--ct-amber)", fontSize: 10 }}>{s === "queued" ? "queued" : `${pct}%`}</span>
    </span>
  );
}

const SPEED_OPTIONS = [1.0, 1.25, 1.5, 1.75, 2.0];

function SpeedPicker({ value, onChange }) {
  return (
    <div style={{ display: "inline-flex", alignItems: "center", gap: 6 }}>
      <span className="ct-meta" style={{ color: "var(--fg-muted)", letterSpacing: "1.2px", textTransform: "uppercase" }}>Speed</span>
      <div style={{ display: "flex", border: "1px solid var(--rule)" }}>
        {SPEED_OPTIONS.map((s) => {
          const active = Math.abs(s - value) < 0.001;
          return (
            <button key={s} onClick={() => onChange(s)}
              className="ct-btn ct-btn--xs"
              style={{
                fontFamily: "var(--font-mono)", fontSize: 11, padding: "3px 8px",
                background: active ? "var(--ct-tea-ghost)" : "transparent",
                color: active ? "var(--fg)" : "var(--fg-muted)",
                border: "none",
                borderRight: s === SPEED_OPTIONS.at(-1) ? "none" : "1px solid var(--rule)",
              }}>
              {s}×
            </button>
          );
        })}
      </div>
    </div>
  );
}

function BoostToggle({ value, onChange }) {
  return (
    <div style={{ display: "inline-flex", alignItems: "center", gap: 6 }}>
      <span className="ct-meta" style={{ color: "var(--fg-muted)", letterSpacing: "1.2px", textTransform: "uppercase" }}>Boost</span>
      <button onClick={() => onChange(!value)}
        className="ct-btn ct-btn--xs"
        title="Compress dynamic range and lift overall loudness (~+3 LU). Helps in noisy / underwater listening."
        style={{
          fontFamily: "var(--font-mono)", fontSize: 11, padding: "3px 10px",
          border: "1px solid var(--rule)",
          background: value ? "var(--ct-tea-ghost)" : "transparent",
          color: value ? "var(--fg)" : "var(--fg-muted)",
        }}>
        {value ? "ON" : "OFF"}
      </button>
    </div>
  );
}

function AnnounceToggle({ value, onChange }) {
  return (
    <div style={{ display: "inline-flex", alignItems: "center", gap: 6 }}>
      <span className="ct-meta" style={{ color: "var(--fg-muted)", letterSpacing: "1.2px", textTransform: "uppercase" }}>Announce</span>
      <button onClick={() => onChange(!value)}
        className="ct-btn ct-btn--xs"
        title="Prepend a short spoken intro (show, title, what the episode is about) so you can tell episodes apart underwater. Applies to every episode unless you disable one below."
        style={{
          fontFamily: "var(--font-mono)", fontSize: 11, padding: "3px 10px",
          border: "1px solid var(--rule)",
          background: value ? "var(--ct-tea-ghost)" : "transparent",
          color: value ? "var(--fg)" : "var(--fg-muted)",
        }}>
        {value ? "ON" : "OFF"}
      </button>
    </div>
  );
}

// Compact per-row announce affordance. When the global toggle is off it renders
// nothing (no clutter). When on it shows the passive status (analysing / ready /
// skipped) once the sync stream reports it, plus a single overflow action to
// disable announce for just this episode (or re-enable it). No full toggle set
// per row - just the badge and one action.
function AnnounceBadge({ globalOn, off, status, onToggle }) {
  if (!globalOn) return null;
  let statusEl = null;
  if (off) {
    statusEl = <span style={{ color: "var(--fg-muted)", fontSize: 10 }}>announce off</span>;
  } else if (status === "analysing") {
    statusEl = <span style={{ color: "var(--ct-amber)", fontSize: 10 }}>analysing…</span>;
  } else if (status === "ready") {
    statusEl = <span style={{ color: "var(--ct-tea)", fontSize: 10 }}>✓ intro ready</span>;
  } else if (status === "skipped") {
    statusEl = <span style={{ color: "var(--fg-muted)", fontSize: 10 }} title="intro could not be built - episode sent without it">intro skipped</span>;
  } else {
    statusEl = <span style={{ color: "var(--fg-dim)", fontSize: 10 }}>announce on</span>;
  }
  return (
    <span style={{ display: "inline-flex", alignItems: "center", gap: 6, marginRight: 6 }}>
      {statusEl}
      <button onClick={(e) => { e.stopPropagation(); onToggle(); }}
        className="ct-btn ct-btn--ghost ct-btn--sm"
        title={off ? "enable announce for this episode" : "disable announce for this episode"}
        style={{ fontFamily: "var(--font-mono)", fontSize: 9, letterSpacing: ".5px",
          color: "var(--fg-muted)", border: "1px solid var(--rule)", padding: "1px 5px",
          background: "transparent", cursor: "pointer" }}>
        {off ? "ENABLE" : "DISABLE"}
      </button>
    </span>
  );
}

function TrimToggle({ value, onChange }) {
  return (
    <div style={{ display: "inline-flex", alignItems: "center", gap: 6 }}>
      <span className="ct-meta" style={{ color: "var(--fg-muted)", letterSpacing: "1.2px", textTransform: "uppercase" }}>Trim</span>
      <button onClick={() => onChange(!value)}
        className="ct-btn ct-btn--xs"
        title="Detect and remove intros, outros and ads so you swim straight into the content. Only clean, confident cuts are applied automatically - anything ambiguous is left intact and flagged for review. Applies to every episode unless you disable one below."
        style={{
          fontFamily: "var(--font-mono)", fontSize: 11, padding: "3px 10px",
          border: "1px solid var(--rule)",
          background: value ? "var(--ct-tea-ghost)" : "transparent",
          color: value ? "var(--fg)" : "var(--fg-muted)",
        }}>
        {value ? "ON" : "OFF"}
      </button>
    </div>
  );
}

// Model picker (P4a). A pulldown that selects which local LM Studio model the
// announce summary and the trim detector use. The default (gemma-4-12b-qat) is
// the LOCKED detector model; changing this does NOT change the default or the
// detector method, only which model the calls are routed to. Persisted in
// localStorage by App.jsx. The current value is always shown even when it is not
// one of the listed options (the user may have a custom id stored).
function ModelPicker({ value, onChange, options = [] }) {
  if (!onChange) return null;
  const opts = options.includes(value) || !value ? options : [value, ...options];
  return (
    <div style={{ display: "inline-flex", alignItems: "center", gap: 6 }}>
      <span className="ct-meta" style={{ color: "var(--fg-muted)", letterSpacing: "1.2px", textTransform: "uppercase" }}>Model</span>
      <select
        value={value || ""}
        onChange={(e) => onChange(e.target.value)}
        title="The local LM Studio model used for the announce summary and the ad/intro trim detector. Default is the locked gemma-4-12b-qat. Changing this does not change how the detector works, only which model it calls."
        style={{
          fontFamily: "var(--font-mono)", fontSize: 11, padding: "3px 8px",
          border: "1px solid var(--rule)", background: "transparent",
          color: "var(--fg)",
        }}>
        {opts.map((m) => (
          <option key={m} value={m}>{m}</option>
        ))}
      </select>
    </div>
  );
}

// Compact per-row trim affordance, mirroring AnnounceBadge. When the global
// toggle is off it renders nothing. When on it shows the passive status fed by
// the P2c trim IPC (analysing / ready / needs-review / skipped) plus a single
// overflow action to disable trim for just this episode (or re-enable it).
function TrimBadge({ globalOn, off, status, onToggle }) {
  if (!globalOn) return null;
  let statusEl = null;
  if (off) {
    statusEl = <span style={{ color: "var(--fg-muted)", fontSize: 10 }}>trim off</span>;
  } else if (status === "analysing") {
    statusEl = <span style={{ color: "var(--ct-amber)", fontSize: 10 }}>analysing…</span>;
  } else if (status === "ready") {
    statusEl = <span style={{ color: "var(--ct-tea)", fontSize: 10 }}>✓ trims ready</span>;
  } else if (status === "needs-review") {
    statusEl = <span style={{ color: "var(--ct-amber)", fontSize: 10 }} title="some cuts were ambiguous or over the safe threshold - left intact, awaiting review">needs review</span>;
  } else if (status === "skipped") {
    statusEl = <span style={{ color: "var(--fg-muted)", fontSize: 10 }} title="no confident cuts found - episode sent untrimmed">trim skipped</span>;
  } else {
    statusEl = <span style={{ color: "var(--fg-dim)", fontSize: 10 }}>trim on</span>;
  }
  return (
    <span style={{ display: "inline-flex", alignItems: "center", gap: 6, marginRight: 6 }}>
      {statusEl}
      <button onClick={(e) => { e.stopPropagation(); onToggle(); }}
        className="ct-btn ct-btn--ghost ct-btn--sm"
        title={off ? "enable trim for this episode" : "disable trim for this episode"}
        style={{ fontFamily: "var(--font-mono)", fontSize: 9, letterSpacing: ".5px",
          color: "var(--fg-muted)", border: "1px solid var(--rule)", padding: "1px 5px",
          background: "transparent", cursor: "pointer" }}>
        {off ? "ENABLE" : "DISABLE"}
      </button>
    </span>
  );
}

export function TodayScreen({ items, onDevice, setSelected, order, setOrder,
  goSync, goUpNext, deviceCapacityMB, downloadByUuid = {}, onRetryDownload,
  playbackSpeed = 1.0, setPlaybackSpeed, boost = false, setBoost,
  model, setModel, modelOptions = [],
  announceOn = false, setAnnounceOn, announceOff, setAnnounceEpisode, announceStatus = {},
  trimOn = false, setTrimOn, trimOff, setTrimEpisode, trimStatus = {},
  trimCuts = {}, trimDecisions = {}, onTrimDecide, onTrimEdit, trimAudioUrls = {},
  trimSegments = {},
  devicePath, setShowMountDialog }) {

  const offSet = announceOff || new Set();
  const trimOffSet = trimOff || new Set();

  const queue = order.map((id) => items.find((x) => x.id === id)).filter(Boolean);
  const totalMin = queue.reduce((s, x) => s + x.durMin, 0);
  const totalMB = queue.reduce((s, x) => s + x.sizeMB, 0);
  const totalHM = `${Math.floor(totalMin / 60)}h ${Math.floor(totalMin % 60)}m`;
  const used = onDevice.reduce((s, x) => s + x.sizeMB, 0);
  const free = deviceCapacityMB - used;
  const overCap = totalMB > free;

  const [dragId, setDragId] = useState(null);
  const [dropTarget, setDropTarget] = useState(null);

  const removed = onDevice.filter((d) => !queue.some((q) => d.uuid && q.uuid && q.uuid === d.uuid));

  const remove = (id) => {
    setSelected((s) => s.filter((x) => x !== id));
    setOrder((o) => o.filter((x) => x !== id));
  };

  const handleDragStart = (id) => (e) => {
    setDragId(id);
    e.dataTransfer.effectAllowed = "move";
    try { e.dataTransfer.setData("text/plain", String(id)); } catch (_) {}
  };
  const handleDragOver = (id) => (e) => {
    e.preventDefault();
    if (dragId == null || dragId === id) { setDropTarget(null); return; }
    const rect = e.currentTarget.getBoundingClientRect();
    const pos = (e.clientY - rect.top) < rect.height / 2 ? "above" : "below";
    setDropTarget({ id, pos });
  };
  const handleDrop = (id) => (e) => {
    e.preventDefault();
    if (dragId == null || dragId === id) { setDragId(null); setDropTarget(null); return; }
    setOrder((o) => {
      const from = o.indexOf(dragId);
      let to = o.indexOf(id);
      if (from < 0 || to < 0) return o;
      const n = o.slice();
      const [m] = n.splice(from, 1);
      const rect = e.currentTarget.getBoundingClientRect();
      const pos = (e.clientY - rect.top) < rect.height / 2 ? "above" : "below";
      to = n.indexOf(id);
      n.splice(pos === "below" ? to + 1 : to, 0, m);
      return n;
    });
    setDragId(null); setDropTarget(null);
  };
  const handleDragEnd = () => { setDragId(null); setDropTarget(null); };

  if (!queue.length && !devicePath) {
    return (
      <div style={{ flex: 1, display: "flex", flexDirection: "column", alignItems: "center",
        justifyContent: "center", gap: 16, padding: 40, textAlign: "center" }}>
        <div className="ct-label" style={{ color: "var(--ct-amber)" }}>no headphones connected</div>
        <div className="ct-subhead" style={{ color: "var(--fg-dim)", maxWidth: 360 }}>
          Plug in your OpenSwim Pro to start sending episodes.
        </div>
        <div style={{ marginTop: 8, display: "flex", gap: 8 }}>
          {setShowMountDialog && (
            <Btn variant="secondary" onClick={() => setShowMountDialog(true)}>Pick a volume</Btn>
          )}
          <Btn variant="cta" onClick={goUpNext}>Pick from queue</Btn>
        </div>
      </div>
    );
  }

  if (!queue.length) {
    return (
      <div style={{ flex: 1, display: "flex", flexDirection: "column", alignItems: "center",
        justifyContent: "center", gap: 16 }}>
        <div className="ct-label">nothing lined up</div>
        <div className="ct-subhead" style={{ color: "var(--fg-dim)" }}>Line up some episodes to send to your headphones.</div>
        <div style={{ marginTop: 8 }}><Btn variant="cta" onClick={goUpNext}>Pick from queue</Btn></div>
      </div>
    );
  }

  return (
    <div style={{ flex: 1, display: "flex", flexDirection: "column", minHeight: 0 }}>
      <Toolbar
        label={`Ready · ${queue.length} episodes lined up`}
        title="Ready for your swim."
        subtitle={`${totalHM} · ${totalMB.toFixed(1)}MB · will write ${queue.length} file${queue.length > 1 ? "s" : ""}, remove ${removed.length}${playbackSpeed !== 1.0 ? ` · will re-encode at ${playbackSpeed}× playback speed` : ""}${boost ? " · boost on" : ""}${announceOn ? ` · announce ${queue.filter((q) => effectiveAnnounce(q.uuid, announceOn, offSet)).length}` : ""}${trimOn ? ` · trim ${queue.filter((q) => effectiveTrim(q.uuid, trimOn, trimOffSet)).length}` : ""}`}
        actions={<>
          <Btn variant="secondary" onClick={goUpNext}>+ add more</Btn>
          <Btn variant="cta" onClick={goSync} disabled={overCap}>
            {overCap ? "OVER CAPACITY" : `SEND TO HEADPHONES · ${queue.length} EP`}
          </Btn>
        </>}
      />
      <div style={{ padding: "12px 20px", borderBottom: "1px solid var(--rule)",
        display: "flex", gap: 20, alignItems: "center", flexWrap: "wrap" }}>
        <div className="ct-meta">
          <span style={{ color: overCap ? "var(--ct-error)" : "var(--fg)" }}>{totalMB.toFixed(1)}MB</span>
          <span> / {free.toFixed(0)}MB free · ≈ {Math.round(totalMB / 1.8)}s at 1.8MB/s</span>
        </div>
        <div style={{ flex: 1, minWidth: 120, maxWidth: 240, height: 4,
          background: "var(--rule)", position: "relative", overflow: "hidden" }}>
          <div style={{
            position: "absolute", left: 0, top: 0, bottom: 0,
            width: `${Math.min(100, (totalMB / free) * 100)}%`,
            background: overCap ? "var(--ct-error)" : "var(--ct-amber)",
            transition: "width .28s var(--ease)" }} />
        </div>
        <div style={{ flex: 1 }}></div>
        {setPlaybackSpeed && <SpeedPicker value={playbackSpeed} onChange={setPlaybackSpeed} />}
        {setBoost && <BoostToggle value={boost} onChange={setBoost} />}
        {setAnnounceOn && <AnnounceToggle value={announceOn} onChange={setAnnounceOn} />}
        {setTrimOn && <TrimToggle value={trimOn} onChange={setTrimOn} />}
        {setModel && <ModelPicker value={model} onChange={setModel} options={modelOptions} />}
        <div className="ct-meta" style={{ color: "var(--fg-muted)" }}>drag to reorder · video → MP3</div>
      </div>

      <div style={{ flex: 1, overflow: "auto", minHeight: 0 }}>
        <div style={{ padding: "12px 20px 6px", display: "flex", gap: 20,
          borderBottom: "1px solid var(--rule)" }}>
          <div className="ct-label" style={{ flex: 1 }}>Will write {queue.length} · device renames</div>
        </div>

        {queue.map((it, idx) => {
          const slot = idx + 1;
          const prev = onDevice.find((d) => d.uuid && it.uuid && d.uuid === it.uuid);
          const fname = fnameFor(it.show, slot, "mp3");
          const isRename = prev && prev.fname && prev.fname !== fname;
          const fate = isRename ? "rename" : "new";
          return (
            <div key={it.id}>
            <div className="today-row" data-fate={fate}
              draggable
              data-dragging={dragId === it.id ? "true" : undefined}
              data-drop-above={dropTarget && dropTarget.id === it.id && dropTarget.pos === "above" ? "true" : undefined}
              data-drop-below={dropTarget && dropTarget.id === it.id && dropTarget.pos === "below" ? "true" : undefined}
              onDragStart={handleDragStart(it.id)}
              onDragOver={handleDragOver(it.id)}
              onDrop={handleDrop(it.id)}
              onDragEnd={handleDragEnd}
              style={{ cursor: "grab" }}>
              <div style={{ display: "flex", alignItems: "center", gap: 6, color: "var(--fg-muted)" }} className="today-row__drag">
                <DragHandle />
                <span style={{ fontFamily: "var(--font-mono)", fontSize: 11 }}>{String(slot).padStart(2, "0")}</span>
              </div>
              <CoverArt show={it.show} size={32} />
              <div style={{ minWidth: 0 }}>
                <div className="ct-row__title today-row__title">{it.title}
                  {it.kind === "VIDEO" && (
                    <span style={{ marginLeft: 8, fontFamily: "var(--font-mono)", fontSize: 10,
                      color: "var(--fg-muted)", letterSpacing: ".5px", padding: "1px 4px",
                      border: "1px solid var(--rule)" }}>VIDEO→A</span>
                  )}
                </div>
                <div style={{ display: "flex", alignItems: "center", gap: 10, marginTop: 3 }}>
                  <div className="ct-row__show">{it.show}</div>
                  {isRename && <span className="ct-tag ct-tag--active">RENAME</span>}
                  {!prev && <span className="ct-tag ct-tag--on-device">NEW</span>}
                  <div className="fname">{fname}</div>
                </div>
              </div>
              <div style={{ fontFamily: "var(--font-mono)", fontSize: 11,
                color: "var(--fg-dim)", textAlign: "right" }}>{it.dur}</div>
              <div style={{ fontFamily: "var(--font-mono)", fontSize: 11,
                color: "var(--fg-muted)", textAlign: "right" }}>
                {it.size}
                <DownloadBadge state={downloadByUuid[it.uuid]}
                  onRetry={onRetryDownload ? () => onRetryDownload(it) : null} />
              </div>
              <div style={{ display: "flex", gap: 2, justifyContent: "flex-end", alignItems: "center" }}>
                {setAnnounceEpisode && (
                  <AnnounceBadge globalOn={announceOn}
                    off={it.uuid ? offSet.has(it.uuid) : false}
                    status={it.uuid ? announceStatus[it.uuid] : undefined}
                    onToggle={() => setAnnounceEpisode(it.uuid, offSet.has(it.uuid))} />
                )}
                {setTrimEpisode && (
                  <TrimBadge globalOn={trimOn}
                    off={it.uuid ? trimOffSet.has(it.uuid) : false}
                    status={it.uuid ? trimStatus[it.uuid] : undefined}
                    onToggle={() => setTrimEpisode(it.uuid, trimOffSet.has(it.uuid))} />
                )}
                <button className="ct-btn ct-btn--ghost ct-btn--sm" onClick={() => remove(it.id)}
                  style={{ color: "var(--destructive)" }} title="remove">✕</button>
              </div>
            </div>
            {trimOn && it.uuid && !trimOffSet.has(it.uuid) && (
              <>
                <CutlistReview uuid={it.uuid}
                  trimEntry={{ cuts: trimCuts[it.uuid] || [] }}
                  decisions={trimDecisions[it.uuid] || {}}
                  audioUrl={trimAudioUrls[it.uuid]}
                  onDecide={onTrimDecide}
                  onEditCut={onTrimEdit} />
                <TranscriptEvidence uuid={it.uuid}
                  transcript={trimSegments[it.uuid]}
                  trimEntry={{ cuts: trimCuts[it.uuid] || [] }} />
              </>
            )}
            </div>
          );
        })}

        {removed.length > 0 && (
          <>
            <div style={{ padding: "18px 20px 6px" }}>
              <div className="ct-label" style={{ color: "var(--ct-error)" }}>Will remove {removed.length} · freeing {removed.reduce((s, x) => s + x.sizeMB, 0).toFixed(1)}MB</div>
            </div>
            {removed.map((d) => (
              <div key={d.id} className="today-row" data-fate="remove" style={{ cursor: "default" }}>
                <div style={{ display: "flex", alignItems: "center", gap: 6,
                  color: "var(--ct-error)", fontFamily: "var(--font-mono)", fontSize: 11 }}>✕</div>
                <div style={{ width: 32, height: 32, background: "var(--ct-coffee-deep)",
                  display: "flex", alignItems: "center", justifyContent: "center",
                  fontFamily: "var(--font-mono)", fontSize: 10, color: "var(--fg-muted)" }}>--</div>
                <div style={{ minWidth: 0 }}>
                  <div className="today-row__title" style={{ color: "var(--fg-dim)" }}>{d.title}</div>
                  <div style={{ display: "flex", gap: 10, marginTop: 3 }}>
                    <div className="ct-row__show">{d.show}</div>
                    <div className="fname"><s>{d.fname}</s></div>
                  </div>
                </div>
                <div></div>
                <div style={{ fontFamily: "var(--font-mono)", fontSize: 11,
                  color: "var(--fg-muted)", textAlign: "right" }}>{d.size || (d.sizeMB != null ? `${d.sizeMB.toFixed(1)}M` : "")}</div>
                <div></div>
              </div>
            ))}
          </>
        )}
      </div>
    </div>
  );
}
