import { useState } from "react";
import { Btn } from "./Atoms.jsx";

export function LoginScreen({ onConnect }) {
  const [cookie, setCookie] = useState("");
  const [step, setStep] = useState(0);

  const start = () => {
    setStep(1);
    setTimeout(() => { setStep(2); setTimeout(onConnect, 450); }, 1100);
  };

  return (
    <div style={{ flex: 1, display: "flex", flexDirection: "column", alignItems: "center",
      justifyContent: "center", padding: 40, position: "relative" }}>
      <div style={{ width: 68, height: 68, border: "1px solid var(--rule-strong)",
        display: "flex", alignItems: "center", justifyContent: "center", marginBottom: 28,
        fontFamily: "var(--font-mono)", fontSize: 22, color: "var(--ct-amber)",
        fontWeight: 600, letterSpacing: "1px", position: "relative" }}>
        OS
        <span style={{ position: "absolute", top: 6, right: 6, width: 5, height: 5,
          borderRadius: "50%", background: "var(--ct-amber)",
          boxShadow: "0 0 0 3px rgba(232,180,79,.15)" }}></span>
      </div>
      <div className="ct-hero" style={{ textAlign: "center" }}>Morning swim.</div>
      <div className="ct-hero" style={{ textAlign: "center", opacity: .55, fontWeight: 300 }}>Seven episodes.</div>

      <div style={{ width: 440, marginTop: 38 }}>
        <div className="ct-meta" style={{ color: "var(--fg-muted)", letterSpacing: "1.5px",
          textTransform: "uppercase", marginBottom: 10 }}>Connect Pocket Casts</div>
        <div style={{ display: "flex", flexDirection: "column", gap: 10 }}>
          <input className="ct-input" placeholder="pocketcasts session cookie…" value={cookie}
            onChange={(e) => setCookie(e.target.value)} disabled={step > 0}
            style={{ fontFamily: "var(--font-mono)", fontSize: 12 }} />
          <div style={{ display: "flex", gap: 8, justifyContent: "space-between", alignItems: "center" }}>
            <div className="ct-meta" style={{ color: "var(--fg-muted)" }}>
              stored in keychain · not shown again
            </div>
            <div style={{ display: "flex", gap: 8 }}>
              <Btn variant="ghost" disabled={step > 0}>cancel</Btn>
              <Btn variant="primary" onClick={start} disabled={step > 0}>
                {step === 0 ? "Connect" : step === 1 ? "Connecting…" : "✓ Connected"}
              </Btn>
            </div>
          </div>
        </div>
        {step >= 1 && (
          <div style={{ marginTop: 20, paddingTop: 16, borderTop: "1px solid var(--rule)" }}>
            <div className="ct-log">
              <div className={step >= 1 ? "ct-log__line--done" : "ct-log__line--pending"}>✓ keychain unlocked</div>
              <div className={step >= 1 ? "ct-log__line--done" : "ct-log__line--pending"}>✓ api.pocketcasts.com · 200</div>
              <div className={step >= 2 ? "ct-log__line--done" : "ct-log__line--active"}>
                {step >= 2 ? "✓ 28 episodes · up next fetched" : "▸ fetching up next…"}
              </div>
            </div>
          </div>
        )}
      </div>
    </div>
  );
}
