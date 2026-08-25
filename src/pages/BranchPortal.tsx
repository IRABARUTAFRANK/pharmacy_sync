import { useState, useEffect, useCallback, useRef } from "react";
import {
  Building2, Phone, Mail, MapPin, ArrowRight, CheckCircle2,
  Loader2, ShieldCheck, KeyRound, RefreshCw, AlertCircle, Copy, Check, Lock,
} from "lucide-react";
import {
  getPharmacyApplication,
  getPharmacyApplicationByEmail,
  requestPharmacyOtp,
  submitPharmacyRegistration,
  verifyPharmacyOtp,
} from "../lib/onboarding";
import { updatePassword } from "../lib/auth";
import type { BranchRecord } from "../lib/store";
import { AuthShell, authCardHeading, authBody, authInput, authPrimaryButton } from "./AuthShell";
import pharmacyImg from "../assets/stock2.jpg";

type Step = "form" | "pending" | "otp" | "password" | "denied" | "success";

/** Clears the #branch hash, handing control back to App's router (the PharmSync home/dashboard). */
function backToHome() {
  window.location.hash = "";
}

// activate_pharmacy_account() already ran by the time we reach "password" —
// this step only sets a password on the now-live session, so it never maps
// from server status the way the others do; it's entered explicitly from
// the otp step's verify handler.
function stepForStatus(status: BranchRecord["status"]): Step {
  if (status === "active") return "success";
  if (status === "otp_sent") return "otp";
  if (status === "denied") return "denied";
  return "pending";
}

const SESSION_KEY = "psync_application_session";
const MIN_PASSWORD_LENGTH = 8;

export default function BranchPortal() {
  const [step, setStep] = useState<Step>("form");
  const [applicationId, setApplicationId] = useState<string | null>(null);
  const [application, setApplication] = useState<BranchRecord | null>(null);
  const [activated, setActivated] = useState<BranchRecord | null>(null);
  const [otp, setOtp] = useState(["", "", "", "", "", ""]);
  const [otpError, setOtpError] = useState("");
  const [copied, setCopied] = useState<string | null>(null);
  const [resending, setResending] = useState(false);
  const [resendInfo, setResendInfo] = useState("");

  // Password step state
  const [password, setPassword] = useState("");
  const [confirmPassword, setConfirmPassword] = useState("");
  const [passwordError, setPasswordError] = useState("");
  const [settingPassword, setSettingPassword] = useState(false);

  // Form state
  const [form, setForm] = useState({
    pharmacyName: "",
    phone: "",
    email: "",
    location: "",
  });
  const [formErrors, setFormErrors] = useState<Partial<typeof form>>({});
  const [submitting, setSubmitting] = useState(false);
  const [submitError, setSubmitError] = useState("");

  // "Already applied? Check your status" — for anyone who closed the pending
  // page and lost the emailed link, or whose email never arrived. Same
  // lookup as the emailed link (resumeFromEmailLink below), just triggered
  // by typing the email instead of clicking a link.
  const [checkStatusOpen, setCheckStatusOpen] = useState(false);
  const [checkEmail, setCheckEmail] = useState("");
  const [checkBusy, setCheckBusy] = useState(false);
  const [checkError, setCheckError] = useState("");

  // Mirrors `step` for the polling effect below to read synchronously inside
  // an async callback — a plain closure over `step` would see whatever value
  // was current when the poll *started*, not when its response actually
  // arrives, which is exactly the race that clobbered the password step.
  const stepRef = useRef<Step>(step);
  useEffect(() => { stepRef.current = step; }, [step]);

  function applyRecord(record: BranchRecord) {
    setApplication(record);
    if (record.status === "active") setActivated(record);
    setStep(stepForStatus(record.status));
  }

  // The link emailed once a super admin approves — .../#branch?email=... —
  // has to resolve the application from any device/browser, not just the one
  // that originally submitted the form, so it looks up by email instead of
  // the sessionStorage-remembered application id.
  const resumeFromEmailLink = useCallback(async (email: string) => {
    const record = await getPharmacyApplicationByEmail(email).catch(() => null);
    if (!record) return false;
    setApplicationId(record.id);
    applyRecord(record);
    return true;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Restore an in-flight application after a page refresh (same browser/tab
  // that submitted the form — sessionStorage doesn't survive to another device).
  const resumeApplication = useCallback(async (id: string) => {
    try {
      const record = await getPharmacyApplication(id);
      if (!record) return;
      setApplicationId(id);
      applyRecord(record);
    } catch {
      sessionStorage.removeItem(SESSION_KEY);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useEffect(() => {
    const emailFromLink = new URLSearchParams(window.location.hash.split("?")[1] ?? "").get("email");
    if (emailFromLink) {
      void resumeFromEmailLink(emailFromLink);
      return;
    }
    const savedId = sessionStorage.getItem(SESSION_KEY);
    if (savedId) void resumeApplication(savedId);
  }, [resumeFromEmailLink, resumeApplication]);

  // Poll the application status while waiting for admin approval or OTP
  // verification. The activation email (link + code) is sent by the super
  // admin's own action, not triggered from here — this only reflects status
  // changes (otp_sent, denied, active) once they happen.
  //
  // Guarded against a real race: clicking "Verify" itself flips the server
  // status to 'active' (via activate_pharmacy_account()) and moves the UI
  // straight to the "password" step — but a poll tick already in flight at
  // that moment resolves *after* verify does, sees status='active', and
  // without the stepRef check below would call applyRecord() and stomp the
  // "password" step back to "success" a beat later, before a password was
  // ever set. Checking stepRef.current (not the `step` this closure was
  // created with) right before applying the poll's result closes that
  // window: once verify has moved past "pending"/"otp" locally, a stale
  // poll response is simply dropped instead of overriding it.
  useEffect(() => {
    if (step !== "pending" && step !== "otp") return;
    if (!applicationId) return;
    const interval = setInterval(async () => {
      if (stepRef.current !== "pending" && stepRef.current !== "otp") return;
      try {
        const record = await getPharmacyApplication(applicationId);
        if (record && (stepRef.current === "pending" || stepRef.current === "otp")) applyRecord(record);
      } catch {
        // transient network errors are ignored; the next tick retries
      }
    }, 4000);
    return () => clearInterval(interval);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [step, applicationId]);

  function validate() {
    const errors: Partial<typeof form> = {};
    if (!form.pharmacyName.trim()) errors.pharmacyName = "Pharmacy name is required";
    if (!form.phone.trim()) errors.phone = "Phone number is required";
    else if (!/^\+?[\d\s\-()]{9,}$/.test(form.phone)) errors.phone = "Enter a valid phone number";
    if (!form.email.trim()) errors.email = "Email address is required";
    else if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(form.email)) errors.email = "Enter a valid email";
    if (!form.location.trim()) errors.location = "Location is required";
    return errors;
  }

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    const errors = validate();
    setFormErrors(errors);
    if (Object.keys(errors).length > 0) return;

    setSubmitting(true);
    setSubmitError("");
    try {
      const created = await submitPharmacyRegistration({
        pharmacyName: form.pharmacyName.trim(),
        phone: form.phone.trim(),
        email: form.email.trim(),
        location: form.location.trim(),
      });
      setApplication(created);
      setApplicationId(created.id);
      sessionStorage.setItem(SESSION_KEY, created.id);
      setStep("pending");
    } catch (reason) {
      setSubmitError(reason instanceof Error ? reason.message : "Registration failed. Please try again.");
    } finally {
      setSubmitting(false);
    }
  }

  async function handleCheckStatus(e: React.FormEvent) {
    e.preventDefault();
    const target = checkEmail.trim().toLowerCase();
    if (!target) { setCheckError("Enter the email you registered with."); return; }
    setCheckBusy(true);
    setCheckError("");
    try {
      const found = await resumeFromEmailLink(target);
      if (!found) setCheckError("No application found for that email.");
    } catch (reason) {
      setCheckError(reason instanceof Error ? reason.message : "Could not look that up right now.");
    } finally {
      setCheckBusy(false);
    }
  }

  async function handleResend(email: string) {
    setResending(true);
    setResendInfo("");
    try {
      await requestPharmacyOtp(email);
      setResendInfo(`A new link and 6-digit code were sent to ${email}.`);
    } catch (reason) {
      setResendInfo(reason instanceof Error ? reason.message : "Could not send the code right now.");
    } finally {
      setResending(false);
    }
  }

  function handleOtpChange(index: number, value: string) {
    if (!/^\d?$/.test(value)) return;
    const next = [...otp];
    next[index] = value;
    setOtp(next);
    setOtpError("");
    if (value && index < 5) {
      const nextInput = document.getElementById(`otp-${index + 1}`);
      nextInput?.focus();
    }
  }

  function handleOtpKey(index: number, e: React.KeyboardEvent<HTMLInputElement>) {
    if (e.key === "Backspace" && !otp[index] && index > 0) {
      document.getElementById(`otp-${index - 1}`)?.focus();
    }
  }

  function handleOtpPaste(e: React.ClipboardEvent) {
    const data = e.clipboardData.getData("text").replace(/\D/g, "").slice(0, 6);
    if (data.length === 6) {
      setOtp(data.split(""));
      document.getElementById("otp-5")?.focus();
    }
  }

  async function verifyOtp() {
    const entered = otp.join("");
    if (entered.length < 6 || !application) { setOtpError("Enter the complete 6-digit code"); return; }
    setOtpError("");
    try {
      const account = await verifyPharmacyOtp(application.email, entered);
      setActivated(account);
      setStep("password");
    } catch (reason) {
      setOtpError(reason instanceof Error ? reason.message : "Incorrect code. Check your email and try again.");
    }
  }

  async function handleSetPassword(e: React.FormEvent) {
    e.preventDefault();
    if (password.length < MIN_PASSWORD_LENGTH) {
      setPasswordError(`Password must be at least ${MIN_PASSWORD_LENGTH} characters`);
      return;
    }
    if (password !== confirmPassword) {
      setPasswordError("Passwords do not match");
      return;
    }
    setPasswordError("");
    setSettingPassword(true);
    try {
      await updatePassword(password);
      setStep("success");
    } catch (reason) {
      setPasswordError(reason instanceof Error ? reason.message : "Could not set your password. Please try again.");
    } finally {
      setSettingPassword(false);
    }
  }

  function copyToClipboard(text: string) {
    navigator.clipboard.writeText(text);
    setCopied(text);
    setTimeout(() => setCopied(null), 2000);
  }

  const shownBranch = activated ?? application;

  const eyebrow = "Branch registration";
  const tagline = "Every branch, one live inventory — receive once, sell everywhere, never lose a batch.";

  return (
    <AuthShell image={pharmacyImg} imageAlt="Dense pharmacy medicine shelves with organized stock" eyebrow={eyebrow} tagline={tagline} onBack={backToHome}>

      {/* Progress steps */}
      {step !== "form" && step !== "denied" && (
        <div className="flex items-center gap-0 mb-8">
          {[
            { label: "Register", done: true },
            { label: "Verify", done: step === "otp" || step === "password" || step === "success" },
            { label: "Set password", done: step === "password" || step === "success" },
          ].map((s, i) => (
            <div key={i} className="flex items-center flex-1">
              <div className="flex flex-col items-center">
                <div
                  className="w-7 h-7 rounded-full flex items-center justify-center text-xs font-bold"
                  style={{ background: s.done ? "#1e5fa8" : "#e2e8f0", color: s.done ? "#fff" : "#94a3b8" }}
                >
                  {s.done ? <Check className="w-3.5 h-3.5" /> : i + 1}
                </div>
                <p className="text-[10px] mt-1" style={{ fontFamily: "var(--font-body)", color: "#94a3b8" }}>{s.label}</p>
              </div>
              {i < 2 && (
                <div className="flex-1 h-0.5 mx-1 mb-4" style={{ background: s.done ? "#1e5fa8" : "#e2e8f0" }} />
              )}
            </div>
          ))}
        </div>
      )}

      {/* ── STEP: Form ── */}
      {step === "form" && (
        <div className="rounded-2xl overflow-hidden" style={{ background: "#fff", border: "1px solid #e8edf4" }}>
          <div className="px-6 py-6">
            <h1 className="text-2xl font-extrabold" style={authCardHeading}>Register your pharmacy</h1>
            <p className="text-sm mt-2" style={authBody}>Apply for a PharmSync portal. Our admin team will verify and activate your account.</p>
          </div>

          <form onSubmit={handleSubmit} className="px-6 pb-6 space-y-5">
            <Field label="Pharmacy Name" icon={<Building2 className="w-4 h-4" />} error={formErrors.pharmacyName}>
              <input
                type="text"
                placeholder="e.g. Nairobi Central Pharmacy"
                value={form.pharmacyName}
                onChange={(e) => setForm((f) => ({ ...f, pharmacyName: e.target.value }))}
                style={{ ...authInput, paddingLeft: 38, borderColor: formErrors.pharmacyName ? "#fca5a5" : "#e2e8f0" }}
              />
            </Field>

            <Field label="Phone Number" icon={<Phone className="w-4 h-4" />} error={formErrors.phone}>
              <input
                type="tel"
                placeholder="+254 7XX XXX XXX"
                value={form.phone}
                onChange={(e) => setForm((f) => ({ ...f, phone: e.target.value }))}
                style={{ ...authInput, paddingLeft: 38, borderColor: formErrors.phone ? "#fca5a5" : "#e2e8f0" }}
              />
            </Field>

            <Field label="Email Address" icon={<Mail className="w-4 h-4" />} error={formErrors.email}>
              <input
                type="email"
                placeholder="branch@yourpharmacy.com"
                value={form.email}
                onChange={(e) => setForm((f) => ({ ...f, email: e.target.value }))}
                style={{ ...authInput, paddingLeft: 38, borderColor: formErrors.email ? "#fca5a5" : "#e2e8f0" }}
              />
            </Field>

            <Field label="Branch Location" icon={<MapPin className="w-4 h-4" />} error={formErrors.location}>
              <input
                type="text"
                placeholder="e.g. Nairobi, Tom Mboya St, Ground Floor"
                value={form.location}
                onChange={(e) => setForm((f) => ({ ...f, location: e.target.value }))}
                style={{ ...authInput, paddingLeft: 38, borderColor: formErrors.location ? "#fca5a5" : "#e2e8f0" }}
              />
            </Field>

            <div className="rounded-xl p-3 flex gap-2" style={{ background: "#fffbeb", border: "1px solid #fde68a" }}>
              <AlertCircle className="w-4 h-4 shrink-0 mt-0.5" style={{ color: "#d97706" }} />
              <p className="text-xs" style={{ color: "#b45309", fontFamily: "var(--font-body)" }}>
                Our admin team will call the phone number you provide to verify your identity before approving your registration.
              </p>
            </div>

            {submitError && (
              <div className="rounded-xl p-3 flex gap-2" style={{ background: "#fef2f2", border: "1px solid #fecaca" }}>
                <AlertCircle className="w-4 h-4 shrink-0 mt-0.5" style={{ color: "#dc2626" }} />
                <p className="text-xs" style={{ color: "#b91c1c", fontFamily: "var(--font-body)" }}>{submitError}</p>
              </div>
            )}

            <button type="submit" disabled={submitting}
              className="flex items-center justify-center gap-2"
              style={{ ...authPrimaryButton, opacity: submitting ? 0.7 : 1 }}>
              {submitting ? <Loader2 className="w-4 h-4 animate-spin" /> : <>Submit Application <ArrowRight className="w-4 h-4" /></>}
            </button>
          </form>
        </div>
      )}

      {/* Already applied? — resumes the pending/otp/denied/success step for an
          email without needing the emailed link (e.g. the applicant closed
          the tab, or the email never arrived). */}
      {step === "form" && (
        <div className="rounded-2xl p-5 mt-4 text-center" style={{ background: "#f8fafb", border: "1px solid #e2e8f0" }}>
          {!checkStatusOpen ? (
            <button type="button" onClick={() => setCheckStatusOpen(true)}
              className="text-sm font-semibold" style={{ color: "var(--primary)", background: "none", border: 0, cursor: "pointer", fontFamily: "var(--font-body)" }}>
              Already applied? Check your application status
            </button>
          ) : (
            <form onSubmit={handleCheckStatus} className="text-left space-y-3">
              <label className="text-xs font-semibold block" style={{ color: "#374151", fontFamily: "var(--font-body)" }}>
                Email you registered with
              </label>
              <div className="flex gap-2">
                <input
                  type="email" autoFocus
                  value={checkEmail} onChange={(e) => { setCheckEmail(e.target.value); setCheckError(""); }}
                  placeholder="branch@yourpharmacy.com" disabled={checkBusy}
                  style={{ ...authInput, flex: 1 }}
                />
                <button type="submit" disabled={checkBusy}
                  className="px-4 rounded-xl text-sm font-semibold shrink-0"
                  style={{ ...authPrimaryButton, width: "auto", opacity: checkBusy ? 0.7 : 1 }}>
                  {checkBusy ? <Loader2 className="w-4 h-4 animate-spin" /> : "Check"}
                </button>
              </div>
              {checkError && (
                <p className="text-xs flex items-center gap-1.5" style={{ color: "#dc2626" }}>
                  <AlertCircle className="w-3.5 h-3.5 shrink-0" /> {checkError}
                </p>
              )}
            </form>
          )}
        </div>
      )}

      {/* ── STEP: Pending ── */}
      {step === "pending" && shownBranch && (
        <div className="rounded-2xl p-8 text-center space-y-5" style={{ background: "#fff", border: "1px solid #e8edf4" }}>
          <div className="w-16 h-16 rounded-2xl flex items-center justify-center mx-auto" style={{ background: "rgba(180,83,9,0.1)" }}>
            <Phone className="w-7 h-7" style={{ color: "#b45309" }} />
          </div>
          <div>
            <h2 className="text-xl font-extrabold" style={authCardHeading}>Application under review</h2>
            <p className="text-sm mt-2 leading-relaxed" style={authBody}>
              Your registration for <span className="font-semibold" style={{ color: "#1e5fa8" }}>{shownBranch.pharmacyName}</span> has
              been received. Our admin team will call <span className="font-semibold" style={{ color: "#0f172a" }}>{shownBranch.phone}</span> to
              verify your identity.
            </p>
          </div>

          <div className="rounded-xl p-4 text-left space-y-1" style={{ background: "#f8fafb", border: "1px solid #e2e8f0" }}>
            <p className="text-[10px] uppercase tracking-widest" style={{ color: "#94a3b8", fontFamily: "var(--font-display)" }}>Your Application ID</p>
            <p className="font-mono text-base font-bold" style={{ color: "#1e5fa8" }}>{shownBranch.applicationCode ?? shownBranch.id}</p>
            <p className="text-xs" style={{ color: "#6b7280" }}>Save this ID — you may need it if you contact support.</p>
          </div>

          <div className="rounded-xl p-4 text-left" style={{ background: "rgba(30,95,168,0.06)", border: "1px solid rgba(30,95,168,0.18)" }}>
            <p className="text-xs font-semibold" style={{ color: "var(--primary)" }}>You can close this page now.</p>
            <p className="text-xs mt-1" style={{ color: "#334155" }}>
              Once approved, we'll email <span className="font-semibold">{shownBranch.email}</span> an activation
              link and a 6-digit code. The link takes you straight to the code entry screen — it (and the code)
              expire 3 hours after we send them, so verify soon after you get it.
            </p>
          </div>

          <div className="flex items-center gap-2 justify-center text-sm" style={{ color: "#94a3b8" }}>
            <Loader2 className="w-3.5 h-3.5 animate-spin" />
            <span className="text-xs">Waiting for admin approval…</span>
          </div>
        </div>
      )}

      {/* ── STEP: Denied / expired ── */}
      {step === "denied" && shownBranch && (
        <div className="rounded-2xl p-8 text-center space-y-5" style={{ background: "#fff", border: "1px solid #fecaca" }}>
          <div className="w-16 h-16 rounded-2xl flex items-center justify-center mx-auto" style={{ background: "#fef2f2" }}>
            <AlertCircle className="w-7 h-7" style={{ color: "#dc2626" }} />
          </div>
          <div>
            <h2 className="text-xl font-extrabold" style={authCardHeading}>Application not active</h2>
            <p className="text-sm mt-2 leading-relaxed" style={authBody}>
              Your registration for <span className="font-semibold" style={{ color: "#0f172a" }}>{shownBranch.pharmacyName}</span> could
              not be activated.
            </p>
          </div>
          <div className="rounded-xl p-4 text-left" style={{ background: "#fef2f2", border: "1px solid #fecaca" }}>
            <p className="text-xs font-semibold" style={{ color: "#b91c1c" }}>{shownBranch.deniedReason ?? "This application was denied."}</p>
          </div>
          <p className="text-xs" style={{ color: "#94a3b8" }}>
            If your activation link or code expired before you could use it, contact support or submit a new
            application — a fresh application gets a fresh 3-hour window.
          </p>
        </div>
      )}

      {/* ── STEP: OTP ── */}
      {step === "otp" && application && (
        <div className="rounded-2xl p-8 text-center space-y-6" style={{ background: "#fff", border: "1px solid #e8edf4" }}>
          <div className="w-16 h-16 rounded-2xl flex items-center justify-center mx-auto" style={{ background: "rgba(30,95,168,0.1)" }}>
            <KeyRound className="w-7 h-7" style={{ color: "#1e5fa8" }} />
          </div>
          <div>
            <h2 className="text-xl font-extrabold" style={authCardHeading}>Enter verification code</h2>
            <p className="text-sm mt-2" style={authBody}>
              An activation link and 6-digit code were sent to <span className="font-semibold" style={{ color: "#1e5fa8" }}>{application.email}</span>.
              Enter the code below — it expires 3 hours after it was sent.
            </p>
          </div>

          <div className="flex justify-center gap-2" onPaste={handleOtpPaste}>
            {otp.map((digit, i) => (
              <input
                key={i}
                id={`otp-${i}`}
                type="text"
                inputMode="numeric"
                maxLength={1}
                value={digit}
                onChange={(e) => handleOtpChange(i, e.target.value)}
                onKeyDown={(e) => handleOtpKey(i, e)}
                className="w-11 h-14 text-center text-xl font-bold rounded-xl outline-none transition-colors"
                style={{
                  fontFamily: "var(--font-display)",
                  border: `2px solid ${otpError ? "#fca5a5" : digit ? "#1e5fa8" : "#e2e8f0"}`,
                  background: otpError ? "#fef2f2" : digit ? "rgba(30,95,168,0.06)" : "#f8fafb",
                  color: otpError ? "#dc2626" : "#0f172a",
                }}
              />
            ))}
          </div>

          {otpError && (
            <div className="flex items-center justify-center gap-1.5 text-xs" style={{ color: "#dc2626" }}>
              <AlertCircle className="w-3.5 h-3.5" />
              {otpError}
            </div>
          )}

          <button onClick={verifyOtp} disabled={otp.join("").length < 6}
            className="flex items-center justify-center gap-2"
            style={{ ...authPrimaryButton, opacity: otp.join("").length < 6 ? 0.5 : 1, cursor: otp.join("").length < 6 ? "not-allowed" : "pointer" }}>
            <ShieldCheck className="w-4 h-4" />
            Verify code
          </button>

          <button
            onClick={() => void handleResend(application.email)}
            disabled={resending}
            className="flex items-center justify-center gap-1.5 text-xs mx-auto disabled:opacity-60"
            style={{ color: "#6b7280", fontFamily: "var(--font-body)" }}
          >
            {resending ? <Loader2 className="w-3 h-3 animate-spin" /> : <RefreshCw className="w-3 h-3" />}
            Resend code
          </button>
          {resendInfo && <p className="text-[11px] -mt-3" style={{ color: "#94a3b8" }}>{resendInfo}</p>}
        </div>
      )}

      {/* ── STEP: Set password ── */}
      {step === "password" && (
        <div className="rounded-2xl p-8 text-center space-y-6" style={{ background: "#fff", border: "1px solid #e8edf4" }}>
          <div className="w-16 h-16 rounded-2xl flex items-center justify-center mx-auto" style={{ background: "rgba(30,95,168,0.1)" }}>
            <Lock className="w-7 h-7" style={{ color: "var(--primary)" }} />
          </div>
          <div>
            <h2 className="text-xl font-extrabold" style={authCardHeading}>Set your password</h2>
            <p className="text-sm mt-2" style={authBody}>
              Verified — your account is active. Choose a password now; from here on you'll sign in with your email
              and this password, not another emailed code.
            </p>
          </div>

          <form onSubmit={handleSetPassword} className="text-left space-y-4">
            <div>
              <label className="text-xs font-semibold block mb-1.5" style={{ color: "#374151", fontFamily: "var(--font-body)" }}>Password</label>
              <input
                type="password" autoFocus autoComplete="new-password"
                value={password} onChange={e => { setPassword(e.target.value); setPasswordError(""); }}
                placeholder={`At least ${MIN_PASSWORD_LENGTH} characters`}
                style={authInput}
              />
            </div>
            <div>
              <label className="text-xs font-semibold block mb-1.5" style={{ color: "#374151", fontFamily: "var(--font-body)" }}>Confirm password</label>
              <input
                type="password" autoComplete="new-password"
                value={confirmPassword} onChange={e => { setConfirmPassword(e.target.value); setPasswordError(""); }}
                placeholder="Re-enter your password"
                style={authInput}
              />
            </div>

            {passwordError && (
              <div className="flex items-center gap-1.5 text-xs" style={{ color: "#dc2626" }}>
                <AlertCircle className="w-3.5 h-3.5 shrink-0" />
                {passwordError}
              </div>
            )}

            <button type="submit" disabled={settingPassword}
              className="flex items-center justify-center gap-2"
              style={{ ...authPrimaryButton, opacity: settingPassword ? 0.7 : 1 }}>
              {settingPassword ? <Loader2 className="w-4 h-4 animate-spin" /> : "Set password & continue"}
            </button>
          </form>
        </div>
      )}

      {/* ── STEP: Success ── */}
      {step === "success" && shownBranch && (
        <div className="rounded-2xl overflow-hidden" style={{ background: "#fff", border: "1px solid #e8edf4" }}>
          <div className="p-6 text-center" style={{ background: "linear-gradient(135deg, #1e5fa8, #1a4f8f)" }}>
            <div className="w-14 h-14 rounded-full flex items-center justify-center mx-auto mb-3" style={{ background: "rgba(255,255,255,0.2)" }}>
              <CheckCircle2 className="w-8 h-8 text-white" />
            </div>
            <h2 className="text-xl font-extrabold text-white" style={{ fontFamily: "var(--font-display)" }}>Account activated!</h2>
            <p className="text-sm mt-1" style={{ color: "rgba(255,255,255,0.85)" }}>{shownBranch.pharmacyName}</p>
          </div>

          <div className="p-6 space-y-4">
            <CodeDisplay
              label="Your Branch System Code"
              value={shownBranch.branchCode ?? "—"}
              description="This is your permanent identifier in the PharmSync database. Keep it safe."
              copied={copied === shownBranch.branchCode}
              onCopy={() => copyToClipboard(shownBranch.branchCode ?? "")}
            />
            <CodeDisplay
              label="Activation Code"
              value={shownBranch.activationCode ?? "—"}
              description="Use this code when setting up PharmSync on your devices."
              copied={copied === shownBranch.activationCode}
              onCopy={() => copyToClipboard(shownBranch.activationCode ?? "")}
            />

            <div className="rounded-xl p-4 space-y-1.5 text-xs" style={{ background: "rgba(30,95,168,0.06)", border: "1px solid rgba(30,95,168,0.2)", color: "#1a4f8f" }}>
              <p className="font-semibold">Your account is now active</p>
              <p>• Pharmacy: <span className="font-medium">{shownBranch.pharmacyName}</span></p>
              {shownBranch.location && <p>• Location: <span className="font-medium">{shownBranch.location}</span></p>}
              <p>• Email: <span className="font-medium">{application?.email}</span></p>
            </div>

            <div className="rounded-xl p-4 space-y-1.5 text-xs" style={{ background: "rgba(30,95,168,0.06)", border: "1px solid rgba(30,95,168,0.2)", color: "var(--primary-dark)" }}>
              <p className="font-semibold">Next: open your operations dashboard</p>
              <p>Go to the PharmSync dashboard and sign in with this email and the password you just set.</p>
            </div>

            <button type="button" onClick={backToHome}
              className="flex items-center justify-center gap-2"
              style={authPrimaryButton}>
              Go to sign in
            </button>
          </div>
        </div>
      )}
    </AuthShell>
  );
}

// ── Helpers ───────────────────────────────────────────────────────────────────

function Field({
  label,
  icon,
  error,
  children,
}: {
  label: string;
  icon: React.ReactNode;
  error?: string;
  children: React.ReactNode;
}) {
  return (
    <div>
      <label className="text-xs font-semibold block mb-1.5" style={{ color: "#374151", fontFamily: "var(--font-body)" }}>{label}</label>
      <div className="relative">
        <span className="absolute left-3 top-1/2 -translate-y-1/2" style={{ color: "#9ca3af" }}>{icon}</span>
        {children}
      </div>
      {error && (
        <p className="text-xs mt-1 flex items-center gap-1" style={{ color: "#dc2626" }}>
          <AlertCircle className="w-3 h-3" /> {error}
        </p>
      )}
    </div>
  );
}

function CodeDisplay({
  label,
  value,
  description,
  onCopy,
  copied,
}: {
  label: string;
  value: string;
  description: string;
  onCopy: () => void;
  copied: boolean;
}) {
  return (
    <div className="rounded-xl p-4" style={{ background: "#f8fafb", border: "1px solid #e2e8f0" }}>
      <p className="text-[10px] uppercase tracking-widest mb-1" style={{ color: "#94a3b8", fontFamily: "var(--font-display)" }}>{label}</p>
      <div className="flex items-center justify-between gap-2">
        <p className="font-mono text-xl font-bold" style={{ color: "#1e5fa8" }}>{value}</p>
        <button
          onClick={onCopy}
          className="flex items-center gap-1 text-xs transition-colors"
          style={{ color: "#94a3b8" }}
        >
          {copied ? <Check className="w-3.5 h-3.5" /> : <Copy className="w-3.5 h-3.5" />}
        </button>
      </div>
      <p className="text-[11px] mt-1" style={{ color: "#6b7280" }}>{description}</p>
    </div>
  );
}
