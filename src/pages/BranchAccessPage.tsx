import { useState } from "react"
import { Mail, Lock, AlertCircle, Loader2, CheckCircle2 } from "lucide-react"
import { signInToBranch, sendBranchPasswordReset, type BranchAccess } from "../lib/auth"
import { errorMessage as errorText } from "../lib/supabase"
import { AuthShell, authCardHeading, authBody, authInput, authPrimaryButton, PasswordInput } from "./AuthShell"
import MarketingHome from "./MarketingHome"
import loginImg from "../assets/products.jpg"

// Pharmacy registration is an in-app view (see App.tsx's hash router) rather
// than a separately deployed app, so this is a plain same-page hash link —
// no reload, and the browser back button returns here. The super-admin
// console (#admin) is intentionally not linked from anywhere in this file —
// see the note on BranchAccessPage below.
const REGISTER_URL = "#branch"

const EMAIL_PATTERN = /^[^\s@]+@[^\s@]+\.[^\s@]+$/

// ─── Login view ───────────────────────────────────────────────────────────────
// Email + password, not an emailed OTP: the OTP round trip only ever happens
// once, during account activation (see BranchPortal.tsx), which is also
// where the password gets set. Returning sign-ins use that password.

function LoginView({ onAccess, onHome }: { onAccess: (access: BranchAccess) => void; onHome: () => void }) {
  const [mode, setMode] = useState<"login" | "forgot" | "forgot-sent">("login")
  const [email, setEmail] = useState("")
  const [password, setPassword] = useState("")
  const [error, setError] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)

  async function submit(event: React.FormEvent) {
    event.preventDefault()
    const target = email.trim().toLowerCase()
    if (!EMAIL_PATTERN.test(target)) { setError("Enter the email address your branch was activated with."); return }
    if (!password) { setError("Enter your password."); return }

    setBusy(true)
    setError(null)
    try {
      const access = await signInToBranch(target, password)
      onAccess(access)
    } catch (reason) {
      setError(errorText(reason, "That email and password combination was not accepted."))
    } finally {
      setBusy(false)
    }
  }

  async function submitForgot(event: React.FormEvent) {
    event.preventDefault()
    const target = email.trim().toLowerCase()
    if (!EMAIL_PATTERN.test(target)) { setError("Enter the email address your branch was activated with."); return }

    setBusy(true)
    setError(null)
    try {
      // Supabase appends its own recovery tokens to this URL's hash
      // (#access_token=…&type=recovery&…) — App.tsx's hash router looks for
      // "type=recovery" there and routes to ResetPassword.tsx.
      const redirectTo = `${window.location.origin}${window.location.pathname}`
      await sendBranchPasswordReset(target, redirectTo)
      setMode("forgot-sent")
    } catch (reason) {
      setError(errorText(reason, "Could not send a reset link right now. Please try again."))
    } finally {
      setBusy(false)
    }
  }

  const eyebrow = mode === "login" ? "Branch sign-in" : "Reset password"
  const tagline = mode === "login"
    ? "Sign in to your branch dashboard — live stock, barcodes and sales in one place."
    : "We'll email you a link to choose a new password."

  return (
    <AuthShell
      image={loginImg}
      imageAlt="Pharmacist using a digital stock management system with full pharmacy shelves visible"
      eyebrow={eyebrow}
      tagline={tagline}
      onBack={onHome}
    >
      <div className="rounded-2xl p-8" style={{ background: "#fff", border: "1px solid #e8edf4" }}>
        {mode === "login" && (
          <>
            <div className="w-14 h-14 rounded-2xl flex items-center justify-center mb-6" style={{ background: "rgba(30,95,168,0.1)" }}>
              <Lock className="w-6 h-6" style={{ color: "#1e5fa8" }} />
            </div>
            <h1 className="text-2xl font-extrabold" style={authCardHeading}>Branch sign-in</h1>
            <p className="text-sm mt-2 mb-7" style={authBody}>
              Sign in with the email and password you set when your branch was activated.
            </p>

            <form onSubmit={submit} noValidate className="space-y-4">
              <div>
                <label htmlFor="branch-email" className="text-xs font-semibold block mb-1.5" style={{ color: "#374151", fontFamily: "var(--font-body)" }}>
                  Email address
                </label>
                <div className="relative">
                  <Mail className="w-4 h-4 absolute left-3.5 top-1/2 -translate-y-1/2" style={{ color: "#9ca3af" }} />
                  <input
                    id="branch-email" type="email" autoComplete="email" autoFocus
                    value={email} onChange={e => { setEmail(e.target.value); setError(null) }}
                    placeholder="branch@yourpharmacy.com" disabled={busy}
                    style={{ ...authInput, paddingLeft: 38, borderColor: error ? "#fca5a5" : "#e2e8f0" }}
                  />
                </div>
              </div>

              <div>
                <div className="flex items-center justify-between mb-1.5">
                  <label htmlFor="branch-password" className="text-xs font-semibold" style={{ color: "#374151", fontFamily: "var(--font-body)" }}>
                    Password
                  </label>
                  <button type="button" onClick={() => { setMode("forgot"); setError(null) }}
                    className="text-xs font-semibold" style={{ color: "var(--primary)", background: "none", border: 0, cursor: "pointer", fontFamily: "var(--font-body)" }}>
                    Forgot password?
                  </button>
                </div>
                <PasswordInput
                  id="branch-password" autoComplete="current-password"
                  value={password} onChange={e => { setPassword(e.target.value); setError(null) }}
                  placeholder="••••••••" disabled={busy}
                  leftIcon={<Lock className="w-4 h-4 absolute left-3.5 top-1/2 -translate-y-1/2" style={{ color: "#9ca3af" }} />}
                  style={{ ...authInput, paddingLeft: 38, borderColor: error ? "#fca5a5" : "#e2e8f0" }}
                />
              </div>

              {error && (
                <div className="rounded-xl p-3 flex gap-2" style={{ background: "#fef2f2", border: "1px solid #fecaca" }}>
                  <AlertCircle className="w-4 h-4 shrink-0 mt-0.5" style={{ color: "#dc2626" }} />
                  <p className="text-xs" style={{ color: "#b91c1c", fontFamily: "var(--font-body)" }}>{error}</p>
                </div>
              )}

              <button type="submit" disabled={busy}
                className="flex items-center justify-center gap-2"
                style={{ ...authPrimaryButton, opacity: busy ? 0.7 : 1 }}>
                {busy ? <><Loader2 className="w-4 h-4 animate-spin" /> Signing in…</> : "Sign in"}
              </button>
            </form>

            <p className="text-sm mt-6 text-center" style={authBody}>
              No account yet?{" "}
              <a href={REGISTER_URL} style={{ color: "#1e5fa8", fontWeight: 700, textDecoration: "none" }}>
                Register your pharmacy ↗
              </a>
            </p>
          </>
        )}

        {mode === "forgot" && (
          <>
            <div className="w-14 h-14 rounded-2xl flex items-center justify-center mb-6" style={{ background: "rgba(30,95,168,0.1)" }}>
              <Mail className="w-6 h-6" style={{ color: "var(--primary)" }} />
            </div>
            <h1 className="text-2xl font-extrabold" style={authCardHeading}>Reset your password</h1>
            <p className="text-sm mt-2 mb-7" style={authBody}>
              Enter your branch email and we'll send you a link to choose a new password.
            </p>

            <form onSubmit={submitForgot} noValidate className="space-y-4">
              <div>
                <label htmlFor="forgot-email" className="text-xs font-semibold block mb-1.5" style={{ color: "#374151", fontFamily: "var(--font-body)" }}>
                  Email address
                </label>
                <div className="relative">
                  <Mail className="w-4 h-4 absolute left-3.5 top-1/2 -translate-y-1/2" style={{ color: "#9ca3af" }} />
                  <input
                    id="forgot-email" type="email" autoComplete="email" autoFocus
                    value={email} onChange={e => { setEmail(e.target.value); setError(null) }}
                    placeholder="branch@yourpharmacy.com" disabled={busy}
                    style={{ ...authInput, paddingLeft: 38, borderColor: error ? "#fca5a5" : "#e2e8f0" }}
                  />
                </div>
              </div>

              {error && (
                <div className="rounded-xl p-3 flex gap-2" style={{ background: "#fef2f2", border: "1px solid #fecaca" }}>
                  <AlertCircle className="w-4 h-4 shrink-0 mt-0.5" style={{ color: "#dc2626" }} />
                  <p className="text-xs" style={{ color: "#b91c1c", fontFamily: "var(--font-body)" }}>{error}</p>
                </div>
              )}

              <button type="submit" disabled={busy}
                className="flex items-center justify-center gap-2"
                style={{ ...authPrimaryButton, opacity: busy ? 0.7 : 1 }}>
                {busy ? <><Loader2 className="w-4 h-4 animate-spin" /> Sending…</> : "Send reset link"}
              </button>
              <button type="button" onClick={() => { setMode("login"); setError(null) }}
                className="w-full text-sm font-semibold text-center" style={{ color: "#6b7280", background: "none", border: 0, cursor: "pointer", fontFamily: "var(--font-body)" }}>
                ← Back to sign in
              </button>
            </form>
          </>
        )}

        {mode === "forgot-sent" && (
          <div className="text-center py-2">
            <div className="w-14 h-14 rounded-full flex items-center justify-center mx-auto mb-4" style={{ background: "rgba(30,95,168,0.1)" }}>
              <CheckCircle2 className="w-7 h-7" style={{ color: "#1e5fa8" }} />
            </div>
            <h1 className="text-xl font-extrabold" style={authCardHeading}>Check your email</h1>
            <p className="text-sm mt-2" style={authBody}>
              If <span className="font-semibold" style={{ color: "#0f172a" }}>{email.trim().toLowerCase()}</span> is an
              activated branch account, a reset link is on its way.
            </p>
            <button type="button" onClick={() => { setMode("login"); setError(null) }}
              className="text-sm font-semibold mt-6" style={{ color: "var(--primary)", background: "none", border: 0, cursor: "pointer", fontFamily: "var(--font-body)" }}>
              ← Back to sign in
            </button>
          </div>
        )}
      </div>
    </AuthShell>
  )
}

// ─── Entry point ──────────────────────────────────────────────────────────────
// The super-admin console (#admin) is deliberately not linked anywhere on
// this page or in MarketingHome — the real access control is server-side
// (is_super_admin() on every admin RPC/RLS policy, checked from the signed
// JWT), so a visible link adds no security either way. Not advertising it
// just keeps it off casual visitors' radar; a super admin reaches it by
// going straight to /#admin, given to them out of band.

export default function BranchAccessPage({ onAccess }: { onAccess: (access: BranchAccess) => void }) {
  const [view, setView] = useState<"home" | "login">("home")

  return view === "home"
    ? <MarketingHome onLogin={() => setView("login")} />
    : <LoginView onAccess={onAccess} onHome={() => setView("home")} />
}
