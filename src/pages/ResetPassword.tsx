import { useState } from "react";
import { Lock, AlertCircle, Loader2, CheckCircle2, RefreshCw } from "lucide-react";
import { updatePassword } from "../lib/auth";
import { AuthShell, authCardHeading, authBody, authInput, authPrimaryButton, PasswordInput } from "./AuthShell";
import loginImg from "../assets/products.jpg";
import { useTranslation } from "../lib/i18n";

const MIN_PASSWORD_LENGTH = 8;

// Parses Supabase's own error params from a failed auth-link redirect, e.g.
// #error=access_denied&error_code=otp_expired&error_description=Email+link+is+invalid+or+has+expired
// A used or expired reset link redirects exactly like this — same shape as
// the success case, just with error params instead of a session — and
// without this check it was falling through to a bare "set password" form
// that would fail the moment it tried to call updatePassword() with no
// session behind it. App.tsx's hash router already sends any #error=... hash
// here (alongside the type=recovery success case), so this only has to read it.
function linkError(): string | null {
  const params = new URLSearchParams(window.location.hash.replace(/^#/, ""));
  const description = params.get("error_description");
  if (!description) return null;
  return description.replace(/\+/g, " ");
}

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
  const { t } = useTranslation();
  const [password, setPassword] = useState("");
  const [confirmPassword, setConfirmPassword] = useState("");
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const [done, setDone] = useState(false);
  const [expiredMessage] = useState(linkError);

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    if (password.length < MIN_PASSWORD_LENGTH) { setError(t("auth.errorPasswordTooShort", { count: MIN_PASSWORD_LENGTH })); return; }
    if (password !== confirmPassword) { setError(t("auth.errorPasswordMismatch")); return; }
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
      setError(reason instanceof Error ? reason.message : t("resetPassword.errorSetFailed"));
    } finally {
      setBusy(false);
    }
  }

  return (
    <AuthShell
      image={loginImg}
      imageAlt={t("auth.loginImageAlt")}
      eyebrow={expiredMessage ? t("resetPassword.eyebrowExpired") : t("auth.eyebrowReset")}
      tagline={expiredMessage ? t("resetPassword.taglineExpired") : t("resetPassword.tagline")}
      onBack={() => { window.location.hash = ""; }}
    >
      <div className="rounded-2xl p-8" style={{ background: "#fff", border: "1px solid #e8edf4" }}>
        {expiredMessage ? (
          <div className="text-center py-4">
            <div className="w-14 h-14 rounded-full flex items-center justify-center mx-auto mb-4" style={{ background: "#fef2f2" }}>
              <AlertCircle className="w-7 h-7" style={{ color: "#dc2626" }} />
            </div>
            <h1 className="text-xl font-extrabold" style={authCardHeading}>{t("resetPassword.expiredTitle")}</h1>
            <p className="text-sm mt-2" style={authBody}>{expiredMessage}.</p>
            <p className="text-sm mt-1" style={authBody}>{t("resetPassword.expiredBody")}</p>
            <button type="button" onClick={() => { window.location.hash = ""; }}
              className="flex items-center justify-center gap-2 mx-auto mt-6" style={{ ...authPrimaryButton, width: "auto", padding: "12px 24px" }}>
              <RefreshCw className="w-4 h-4" /> {t("auth.backToSignIn")}
            </button>
          </div>
        ) : done ? (
          <div className="text-center py-4">
            <div className="w-14 h-14 rounded-full flex items-center justify-center mx-auto mb-4" style={{ background: "rgba(30,95,168,0.1)" }}>
              <CheckCircle2 className="w-7 h-7" style={{ color: "#1e5fa8" }} />
            </div>
            <h1 className="text-xl font-extrabold" style={authCardHeading}>{t("resetPassword.doneTitle")}</h1>
            <p className="text-sm mt-2" style={authBody}>{t("resetPassword.doneBody")}</p>
          </div>
        ) : (
          <>
            <div className="w-14 h-14 rounded-2xl flex items-center justify-center mb-6" style={{ background: "rgba(30,95,168,0.1)" }}>
              <Lock className="w-6 h-6" style={{ color: "var(--primary)" }} />
            </div>
            <h1 className="text-2xl font-extrabold" style={authCardHeading}>{t("resetPassword.title")}</h1>
            <p className="text-sm mt-2 mb-7" style={authBody}>{t("resetPassword.subtitle")}</p>

            <form onSubmit={submit} className="space-y-4">
              <div>
                <label className="text-xs font-semibold block mb-1.5" style={{ color: "#374151", fontFamily: "var(--font-body)" }}>{t("resetPassword.newPasswordLabel")}</label>
                <PasswordInput
                  autoFocus autoComplete="new-password"
                  value={password} onChange={e => { setPassword(e.target.value); setError(""); }}
                  placeholder={t("auth.passwordMinPlaceholder", { count: MIN_PASSWORD_LENGTH })}
                  style={authInput}
                />
              </div>
              <div>
                <label className="text-xs font-semibold block mb-1.5" style={{ color: "#374151", fontFamily: "var(--font-body)" }}>{t("resetPassword.confirmPasswordLabel")}</label>
                <PasswordInput
                  autoComplete="new-password"
                  value={confirmPassword} onChange={e => { setConfirmPassword(e.target.value); setError(""); }}
                  placeholder={t("auth.confirmPasswordPlaceholder")}
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
                {busy ? <Loader2 className="w-4 h-4 animate-spin" /> : t("resetPassword.submitButton")}
              </button>
            </form>
          </>
        )}
      </div>
    </AuthShell>
  );
}
