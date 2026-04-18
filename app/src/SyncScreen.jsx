import { useEffect, useMemo, useState } from "react";
import { Btn, CoverArt, Progress } from "./Atoms.jsx";
import { Toolbar } from "./Shell.jsx";
import { fnameFor } from "./TodayScreen.jsx";
import { formatMB } from "./useDevice.js";

const STAGES = [
  { id: "finalise", label: "Finalise order", detail: "locking slot numbers" },
  { id: "delete",   label: "Remove old",    detail: "delete superseded files" },
  { id: "convert",  label: "Convert video", detail: "extract audio @ 128kbps" },
  { id: "transfer", label: "Transfer",      detail: "copy to OpenSwim Pro" },
  { id: "verify",   label: "Verify",        detail: "checksum + eject-safe" },
];

export function SyncScreen({ items, order, onDevice, onDone, onBack, armed, onArm, setMountState }) {
  const queue = order.map((id) => items.find((x) => x.id === id)).filter(Boolean);
  const removedFiles = onDevice.filter((d) => !queue.some((q) => q.show === d.show));
  const videoCount = queue.filter((x) => x.kind === "VIDEO").length;
  const totalMB = queue.reduce((s, x) => s + x.sizeMB, 0);

  const plan = useMemo(() => {
    const out = [];
    out.push({ stage: "finalise", kind: "info", txt: `order locked · ${queue.length} slots` });
    removedFiles.forEach((d) => out.push({ stage: "delete", kind: "del", txt: `rm ${d.fname}`, size: d.size }));
    queue.forEach((it, i) => {
      if (it.kind === "VIDEO") {
        out.push({ stage: "convert", kind: "conv", txt: `${it.show.toLowerCase().split(" ")[0]} · extract audio`, size: it.size, it, slot: i + 1 });
      }
    });
    queue.forEach((it, i) => {
      const fname = fnameFor(it.show, i + 1, "mp3");
      out.push({ stage: "transfer", kind: "xfer", txt: fname, size: it.size, it, slot: i + 1 });
    });
    out.push({ stage: "verify", kind: "info", txt: `checksum ${queue.length} files · eject-safe` });
    return out;
  }, [queue, removedFiles]);

  const [idx, setIdx] = useState(0);
  const [sub, setSub] = useState(0);
  const [phase, setPhase] = useState(armed ? "running" : "idle");

  useEffect(() => {
    if (phase === "idle") { setMountState && setMountState("mounted"); return; }
    setMountState && setMountState("busy");
    return () => setMountState && setMountState("mounted");
  }, [phase, setMountState]);

  useEffect(() => {
    if (phase !== "running") return;
    const tick = setInterval(() => {
      setSub((s) => {
        const step = plan[idx] && plan[idx].kind === "xfer" ? 0.18 : 0.45;
        const n = s + step;
        if (n >= 1) {
          setIdx((i) => {
            if (i + 1 >= plan.length) { setPhase("done"); return i; }
            return i + 1;
          });
          return 0;
        }
        return n;
      });
    }, 200);
    return () => clearInterval(tick);
  }, [phase, idx, plan]);

  const stageIdxMap = Object.fromEntries(STAGES.map((s, i) => [s.id, i]));
  const currentStage = plan[idx] ? plan[idx].stage : "verify";
  const currentStageIdx = stageIdxMap[currentStage] ?? 0;

  const stageProgress = STAGES.map((st, si) => {
    const stageItems = plan.map((p, i) => ({ ...p, i })).filter((p) => p.stage === st.id);
    const done = stageItems.filter((p) => p.i < idx).length;
    const active = stageItems.some((p) => p.i === idx);
    const pct = stageItems.length ? (done + (active ? sub : 0)) / stageItems.length : (si < currentStageIdx || phase === "done" ? 1 : 0);
    return {
      ...st,
      items: stageItems,
      pct,
      state: phase === "done" ? "done" : (si < currentStageIdx ? "done" : si === currentStageIdx ? "active" : "pending"),
      done,
      total: stageItems.length,
    };
  });

  const overall = (idx + sub) / Math.max(plan.length, 1);
  const doneMB = plan.slice(0, idx).filter((p) => p.kind === "xfer").reduce((s, p) => s + (p.size ? parseFloat(p.size) : 0), 0);

  if (phase === "done") {
    return <SuccessScreen queue={queue} totalMB={totalMB} onDone={onDone} videoCount={videoCount} removed={removedFiles} />;
  }

  if (phase === "idle") {
    return (
      <div style={{ flex: 1, display: "flex", flexDirection: "column", minHeight: 0 }}>
        <Toolbar
          label={`Sync · ${queue.length} queued · ready`}
          title="Ready when you are."
          subtitle={`${totalMB.toFixed(1)}MB across ${queue.length} file${queue.length !== 1 ? "s" : ""} · ${removedFiles.length} will be removed · ${videoCount} video→audio`}
          actions={<>
            <Btn variant="ghost" onClick={onBack}>back to today</Btn>
            <Btn variant="cta" onClick={() => { onArm && onArm(); setPhase("running"); }} disabled={!queue.length}>
              {queue.length ? `START SYNC · ${queue.length} EP` : "NOTHING QUEUED"}
            </Btn>
          </>}
        />
        <div style={{ flex: 1, display: "grid", gridTemplateColumns: "300px 1fr", minHeight: 0 }}>
          <div style={{ borderRight: "1px solid var(--rule)", padding: "10px 0" }}>
            {STAGES.map((st, si) => {
              const stageItems = plan.filter((p) => p.stage === st.id);
              return (
                <div key={st.id} className="stage" data-state="pending">
                  <div className="stage__bullet">{si + 1}</div>
                  <div style={{ minWidth: 0 }}>
                    <div className="stage__label">{st.label}</div>
                    <div className="stage__label stage__detail" style={{ marginTop: 3 }}>
                      {stageItems.length ? `${stageItems.length} pending` : "—"}
                    </div>
                  </div>
                  <div className="stage__right"></div>
                </div>
              );
            })}
          </div>
          <div style={{ padding: "24px 28px", display: "flex", flexDirection: "column",
            alignItems: "flex-start", justifyContent: "center", gap: 16 }}>
            <div className="ct-label">awaiting start</div>
            <div className="ct-subhead" style={{ maxWidth: 440 }}>
              Five stages. Finalise the queue, delete yesterday's files, convert video audio, transfer, verify.
            </div>
            <div className="ct-meta" style={{ color: "var(--fg-dim)", maxWidth: 440, lineHeight: 1.8 }}>
              Nothing is written to OpenSwim Pro until you press <span style={{ color: "var(--ct-amber)", fontWeight: 600 }}>START SYNC</span>.
              Estimated {Math.round(totalMB / 1.8)}s at 1.8MB/s.
            </div>
          </div>
        </div>
      </div>
    );
  }

  return (
    <div style={{ flex: 1, display: "flex", flexDirection: "column", minHeight: 0 }}>
      <Toolbar
        label={`Sync · stage ${currentStageIdx + 1}/5 · ${STAGES[currentStageIdx].id}`}
        title="Sending to OpenSwim Pro."
        subtitle={`${doneMB.toFixed(1)}MB / ${totalMB.toFixed(1)}MB · ${(overall * 100).toFixed(0)}% · 1.8MB/s`}
        actions={<Btn variant="ghost" onClick={onBack}>cancel</Btn>}
      />
      <div style={{ padding: "0 20px" }}>
        <Progress value={overall * 100} />
      </div>

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
                  {st.state === "done" ? `done · ${st.total}` :
                   st.state === "active" ? `${st.detail} · ${st.done}/${st.total}` :
                   st.total ? `${st.total} pending` : "skipped"}
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
            {plan.map((p, i) => {
              const cls = i < idx ? "ct-log__line--done"
                : i === idx ? "ct-log__line--active"
                : "ct-log__line--pending";
              const prefix = i < idx ? "✓" : i === idx ? "▸" : "·";
              const right = p.kind === "xfer" && i === idx
                ? `${(parseFloat(p.size) * sub).toFixed(1)}M / ${p.size}`
                : i < idx ? (p.size || "") : (p.size || "");
              return (
                <div key={i} className={cls} style={{ display: "grid",
                  gridTemplateColumns: "18px 1fr auto", gap: 10 }}>
                  <span>{prefix}</span>
                  <span style={{ whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis" }}>
                    {p.txt}
                    {p.kind === "del" && <span style={{ color: "var(--ct-error)", marginLeft: 6 }}>removed</span>}
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

function SuccessScreen({ queue, totalMB, onDone, videoCount, removed }) {
  const totalMin = queue.reduce((s, x) => s + x.durMin, 0);
  const totalHM = `${Math.floor(totalMin / 60)}h ${Math.floor(totalMin % 60)}m`;
  return (
    <div style={{ flex: 1, display: "flex", flexDirection: "column", minHeight: 0 }} className="ct-slide-in">
      <Toolbar
        label="sync complete · safe to unplug"
        title="On your headset."
        subtitle={`${queue.length} episode${queue.length !== 1 ? "s" : ""} renamed, converted, transferred, verified.`}
        actions={<>
          <Btn variant="secondary" onClick={onDone}>Back to Up Next</Btn>
          <Btn variant="cta" onClick={onDone}>EJECT</Btn>
        </>}
      />
      <div style={{ padding: "20px", display: "grid", gap: 16, overflow: "auto" }}>
        <div className="stats">
          <div className="stats__cell">
            <div className="stats__label">Files</div>
            <div className="stats__value">{queue.length}</div>
            <div className="stats__sub">{removed.length} removed · {queue.length} written</div>
          </div>
          <div className="stats__cell">
            <div className="stats__label">Listen time</div>
            <div className="stats__value">{totalHM}</div>
            <div className="stats__sub">≈ 2–3 swims</div>
          </div>
          <div className="stats__cell">
            <div className="stats__label">Transferred</div>
            <div className="stats__value">{totalMB.toFixed(0)}<span style={{ fontSize: 14, color: "var(--fg-muted)", marginLeft: 4 }}>MB</span></div>
            <div className="stats__sub">at 1.8MB/s</div>
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
            <div className="ct-subhead" style={{ marginTop: 4 }}>Eject device</div>
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
            {state === "busy" ? "⚠ writing files — force eject will corrupt the last transfer." : "safe to eject · no pending writes."}
          </div>
          {error && (
            <div className="ct-meta" style={{ color: "var(--ct-error)", marginTop: 10, whiteSpace: "pre-wrap" }}>
              ✗ {error}
            </div>
          )}
        </div>
        <div className="ct-dialog__actions">
          <Btn variant="ghost" onClick={onClose} disabled={ejecting}>cancel</Btn>
          {state === "busy" && <Btn variant="destructive" onClick={onForce} disabled={ejecting}>Force eject</Btn>}
          <Btn variant="primary" onClick={doEject} disabled={state === "busy" || ejecting}>
            {ejecting ? "Ejecting…" : "Eject"}
          </Btn>
        </div>
      </div>
    </div>
  );
}
