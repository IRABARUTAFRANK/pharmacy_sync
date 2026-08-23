import { useState } from "react";
import { Lock, AlertCircle, Loader2, CheckCircle2 } from "lucide-react";
import { updatePassword } from "../lib/auth";
import { AuthShell, authCardHeading, authBody, authInput, authPrimaryButton } from "./AuthShell";
import loginImg from "../assets/products.jpg";

const MIN_PASSWORD_LENGTH = 8;

// Reached via the link in a "forgot password" email (see LoginView's
// requestBranchPasswordReset -> lib/auth.ts sendBranchPasswordReset). That
// link redirects back here with Supabase's own recovery tokens appended to
// the URL hash (…#access_token=…&type=recovery&…) — the supabase-js client
// (created once in lib/supabase.ts, imported before anything renders)
// detects that itself and establishes a real session from it, independently
// of this component's lifecycle. App.tsx's hash router just looks for
// "type=recovery" in the hash to know to render this page instead of the
// normal home/login flow; this form only has to assume that session already
// exists and call updatePassword() on it.
export default function ResetPassword() {
  const [password, setPassword] = useState("");
  const [confirmPassword, setConfirmPassword] = useState("");
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const [done, setDone] = useState(false);

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    if (password.length < MIN_PASSWORD_LENGTH) { setError(`Password must be at least ${MIN_PASSWORD_LENGTH} characters`); return; }
    if (password !== confirmPassword) { setError("Passwords do not match"); return; }
    setError("");
    setBusy(true);
    try {
      await updatePassword(password);
      setDone(true);
      // Clearing the hash hands control back to App.tsx's normal flow, which
      // restores the (now-active) session and takes them straight into
      // their dashboard — no separate "log in again" step needed.
      setTimeout(() => { window.location.hash = ""; }, 1400);
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : "Could not set your password. Request a new reset link and try again.");
    } finally {
      setBusy(false);
    }
  }

  return (
    <AuthShell
      image={loginImg}
      imageAlt="Pharmacist using a digital stock management system with full pharmacy shelves visible"
      eyebrow="Reset password"
      tagline="Choose a new password to get back into your branch dashboard."
      onBack={() => { window.location.hash = ""; }}
    >
      <div className="rounded-2xl p-8" style={{ background: "#fff", border: "1px solid #e8edf4" }}>
        {done ? (
          <div className="text-center py-4">
            <div className="w-14 h-14 rounded-full flex items-center justify-center mx-auto mb-4" style={{ background: "rgba(13,148,136,0.1)" }}>
              <CheckCircle2 className="w-7 h-7" style={{ color: "#0d9488" }} />
            </div>
            <h1 className="text-xl font-extrabold" style={authCardHeading}>Password updated</h1>
            <p className="text-sm mt-2" style={authBody}>Taking you to your dashboard…</p>
          </div>
        ) : (
          <>
            <div className="w-14 h-14 rounded-2xl flex items-center justify-center mb-6" style={{ background: "rgba(30,95,168,0.1)" }}>
              <Lock className="w-6 h-6" style={{ color: "#1e5fa8" }} />
            </div>
            <h1 className="text-2xl font-extrabold" style={authCardHeading}>Set a new password</h1>
            <p className="text-sm mt-2 mb-7" style={authBody}>This resets the password for the account this link was emailed to.</p>

            <form onSubmit={submit} className="space-y-4">
              <div>
                <label className="text-xs font-semibold block mb-1.5" style={{ color: "#374151", fontFamily: "var(--font-body)" }}>New password</label>
                <input
                  type="password" autoFocus autoComplete="new-password"
                  value={password} onChange={e => { setPassword(e.target.value); setError(""); }}
                  placeholder={`At least ${MIN_PASSWORD_LENGTH} characters`}
                  style={authInput}
                />
              </div>
              <div>
                <label className="text-xs font-semibold block mb-1.5" style={{ color: "#374151", fontFamily: "var(--font-body)" }}>Confirm new password</label>
                <input
                  type="password" autoComplete="new-password"
                  value={confirmPassword} onChange={e => { setConfirmPassword(e.target.value); setError(""); }}
                  placeholder="Re-enter your password"
                  style={authInput}
                />
              </div>

              {error && (
                <div className="rounded-xl p-3 flex gap-2" style={{ background: "#fef2f2", border: "1px solid #fecaca" }}>
                  <AlertCircle className="w-4 h-4 shrink-0 mt-0.5" style={{ color: "#dc2626" }} />
                  <p className="text-xs" style={{ color: "#b91c1c", fontFamily: "var(--font-body)" }}>{error}</p>
                </div>
              )}

              <button type="submit" disabled={busy} className="flex items-center justify-center gap-2" style={{ ...authPrimaryButton, opacity: busy ? 0.7 : 1 }}>
                {busy ? <Loader2 className="w-4 h-4 animate-spin" /> : "Set new password"}
              </button>
            </form>
          </>
        )}
      </div>
    </AuthShell>
  );
}
