import { useState, useEffect, useCallback, useRef } from "react";
import {
  Building2, Phone, Mail, MapPin, ArrowRight, CheckCircle2,
  Loader2, ShieldCheck, KeyRound, RefreshCw, AlertCircle, Copy, Check, Lock,
} from "lucide-react";
import {
  getOrganizationApplication,
  getOrganizationApplicationByEmail,
  requestOrganizationRegistrationOtp,
  submitOrganizationRegistration,
  verifyOrganizationRegistrationOtp,
  registerFirstBranch,
  ONBOARDING_SERVICE_ERROR,
  ONBOARDING_RELOAD_FAILED,
  ONBOARDING_NOT_APPROVED,
  type FirstBranchResult,
} from "../lib/onboarding";
import { updatePassword, getCurrentAuthEmail } from "../lib/auth";
import type { OrganizationApplicationRecord } from "../lib/store";
import { AuthShell, authCardHeading, authBody, authInput, authPrimaryButton, PasswordInput } from "./AuthShell";
import pharmacyImg from "../assets/stock2.jpg";
import { useTranslation } from "../lib/i18n";
import type { TranslationKey } from "../lib/i18n/en";

type Step = "form" | "pending" | "otp" | "password" | "branch" | "denied" | "success";

// A plain hash change (window.location.hash = "") would hand control back to
// App's router without a page reload -- but App only checks "is anyone
// signed in?" once, on its very first mount. Someone who just finished
// verifying OTP / setting a password / registering their first branch here
// has a brand-new, real session by this point, but App's own `access` state
// would still be stuck at whatever it resolved to when the page first
// loaded (almost always "nobody's signed in yet", since that's what's true
// before registration). A full navigation forces App to remount and re-run
// that check from scratch, so it actually picks up the session that now
// exists -- landing the person in their dashboard instead of back on the
// public marketing page looking logged out.
function backToHome() {
  window.location.href = "/";
}

// activate_organization_registration() already ran by the time we reach
// "password" — this step only sets a password on the now-live session, so
// it never maps from server status the way the others do; it's entered
// explicitly from the otp step's verify handler. firstBranchId is what
// distinguishes "verified, no branch yet" ("branch") from "fully done"
// ("success") once status is already 'active' — status alone can't express
// that difference (see register_first_branch() in the schema).
function stepForStatus(app: OrganizationApplicationRecord): Step {
  if (app.status === "active") return app.firstBranchId ? "success" : "branch";
  if (app.status === "otp_sent") return "otp";
  if (app.status === "denied") return "denied";
  return "pending";
}

// The onboarding codes this screen can phrase in the applicant's language.
const ONBOARDING_MESSAGE_KEYS: Record<string, TranslationKey> = {
  [ONBOARDING_SERVICE_ERROR]: "register.errorServiceUnavailable",
  [ONBOARDING_RELOAD_FAILED]: "register.errorSavedNotReloaded",
  [ONBOARDING_NOT_APPROVED]: "register.errorNotApproved",
};

const SESSION_KEY = "psync_application_session";
const MIN_PASSWORD_LENGTH = 8;

export default function BranchPortal() {
  const { t, tNode } = useTranslation();

  // A thrown onboarding code becomes translated copy; a real server error
  // keeps its own message (more useful than a generic line); anything else
  // falls back to this call site's own message.
  const explain = useCallback(
    (reason: unknown, fallback: TranslationKey) => {
      const raw = reason instanceof Error ? reason.message : "";
      const key = ONBOARDING_MESSAGE_KEYS[raw];
      if (key) return t(key);
      return raw || t(fallback);
    },
    [t]
  );

  const [step, setStep] = useState<Step>("form");
  const [applicationId, setApplicationId] = useState<string | null>(null);
  const [application, setApplication] = useState<OrganizationApplicationRecord | null>(null);
  const [activated, setActivated] = useState<OrganizationApplicationRecord | null>(null);
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

  // Form state — collects the ORGANIZATION's own fields (legalName/tin) plus
  // contact info the super admin uses to verify (phone/email/location),
  // which doubles as the pre-filled default for the "branch" step below.
  const [form, setForm] = useState({
    legalName: "",
    tin: "",
    phone: "",
    email: "",
    location: "",
  });
  const [formErrors, setFormErrors] = useState<Partial<typeof form>>({});
  const [submitting, setSubmitting] = useState(false);
  const [submitError, setSubmitError] = useState("");

  // "Register your first branch" step state — reached once OTP verification
  // has confirmed the organization but before any branch/login exists yet.
  const [branchForm, setBranchForm] = useState({
    fullName: "",
    pharmacyName: "",
    phone: "",
    email: "",
    location: "",
  });
  const [branchFormErrors, setBranchFormErrors] = useState<Partial<typeof branchForm>>({});
  const [registeringBranch, setRegisteringBranch] = useState(false);
  const [branchSubmitError, setBranchSubmitError] = useState("");
  const [branchResult, setBranchResult] = useState<FirstBranchResult | null>(null);

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

  function applyRecord(record: OrganizationApplicationRecord) {
    setApplication(record);
    if (record.status === "active") setActivated(record);
    setStep(stepForStatus(record));
  }

  // The link emailed once a super admin approves — .../#branch?email=... —
  // has to resolve the application from any device/browser, not just the one
  // that originally submitted the form, so it looks up by email instead of
  // the sessionStorage-remembered application id.
  const resumeFromEmailLink = useCallback(async (email: string) => {
    const record = await getOrganizationApplicationByEmail(email).catch(() => null);
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
      const record = await getOrganizationApplication(id);
      if (!record) return;
      setApplicationId(id);
      applyRecord(record);
    } catch {
      sessionStorage.removeItem(SESSION_KEY);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useEffect(() => {
    (async () => {
      const emailFromLink = new URLSearchParams(window.location.hash.split("?")[1] ?? "").get("email");
      if (emailFromLink) { void resumeFromEmailLink(emailFromLink); return; }
      const savedId = sessionStorage.getItem(SESSION_KEY);
      if (savedId) { void resumeApplication(savedId); return; }
      // Neither the emailed link nor sessionStorage survives closing the tab
      // entirely between setting a password and registering the first
      // branch — but the real Supabase Auth session (created by verifyOtp)
      // does, in localStorage. Fall back to it so that gap doesn't strand
      // someone mid-flow with no way back in except starting over.
      const liveEmail = await getCurrentAuthEmail();
      if (liveEmail) void resumeFromEmailLink(liveEmail);
    })();
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
        const record = await getOrganizationApplication(applicationId);
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
    if (!form.legalName.trim()) errors.legalName = t("register.errorLegalNameRequired");
    if (!form.phone.trim()) errors.phone = t("register.errorPhoneRequired");
    else if (!/^\+?[\d\s\-()]{9,}$/.test(form.phone)) errors.phone = t("register.errorPhoneInvalid");
    if (!form.email.trim()) errors.email = t("register.errorEmailRequired");
    else if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(form.email)) errors.email = t("register.errorEmailInvalid");
    if (!form.location.trim()) errors.location = t("register.errorLocationRequired");
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
      const created = await submitOrganizationRegistration({
        legalName: form.legalName.trim(),
        tin: form.tin.trim() || undefined,
        phone: form.phone.trim(),
        email: form.email.trim(),
        location: form.location.trim(),
      });
      setApplication(created);
      setApplicationId(created.id);
      sessionStorage.setItem(SESSION_KEY, created.id);
      setStep("pending");
    } catch (reason) {
      setSubmitError(explain(reason, "register.errorSubmitFailed"));
    } finally {
      setSubmitting(false);
    }
  }

  async function handleCheckStatus(e: React.FormEvent) {
    e.preventDefault();
    const target = checkEmail.trim().toLowerCase();
    if (!target) { setCheckError(t("register.errorCheckEmailRequired")); return; }
    setCheckBusy(true);
    setCheckError("");
    try {
      const found = await resumeFromEmailLink(target);
      if (!found) setCheckError(t("register.errorNoApplication"));
    } catch (reason) {
      setCheckError(explain(reason, "register.errorCheckFailed"));
    } finally {
      setCheckBusy(false);
    }
  }

  async function handleResend(email: string) {
    setResending(true);
    setResendInfo("");
    try {
      await requestOrganizationRegistrationOtp(email);
      setResendInfo(t("register.otpResent", { email }));
    } catch (reason) {
      setResendInfo(explain(reason, "register.errorResendFailed"));
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
    if (entered.length < 6 || !application) { setOtpError(t("register.errorOtpIncomplete")); return; }
    setOtpError("");
    try {
      const account = await verifyOrganizationRegistrationOtp(application.email, entered);
      setActivated(account);
      setStep("password");
    } catch (reason) {
      setOtpError(explain(reason, "register.errorOtpIncorrect"));
    }
  }

  async function handleSetPassword(e: React.FormEvent) {
    e.preventDefault();
    if (password.length < MIN_PASSWORD_LENGTH) {
      setPasswordError(t("auth.errorPasswordTooShort", { count: MIN_PASSWORD_LENGTH }));
      return;
    }
    if (password !== confirmPassword) {
      setPasswordError(t("auth.errorPasswordMismatch"));
      return;
    }
    setPasswordError("");
    setSettingPassword(true);
    try {
      await updatePassword(password);
      setStep("branch");
    } catch (reason) {
      setPasswordError(explain(reason, "register.errorSetPasswordFailed"));
    } finally {
      setSettingPassword(false);
    }
  }

  // Pre-fill the branch form with the organization's own contact info the
  // moment this step is entered, so the screen can be submitted with no
  // edits at all if the first branch's details match what was already given.
  useEffect(() => {
    if (step !== "branch") return;
    const source = activated ?? application;
    if (!source) return;
    setBranchForm(f => f.pharmacyName ? f : {
      fullName: f.fullName,
      pharmacyName: source.legalName,
      phone: source.phone,
      email: source.email,
      location: source.location,
    });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [step]);

  function validateBranchForm() {
    const errors: Partial<typeof branchForm> = {};
    if (!branchForm.fullName.trim()) errors.fullName = t("register.errorYourNameRequired");
    if (!branchForm.pharmacyName.trim()) errors.pharmacyName = t("register.errorPharmacyNameRequired");
    return errors;
  }

  async function handleRegisterBranch(e: React.FormEvent) {
    e.preventDefault();
    const errors = validateBranchForm();
    setBranchFormErrors(errors);
    if (Object.keys(errors).length > 0) return;

    setRegisteringBranch(true);
    setBranchSubmitError("");
    try {
      const result = await registerFirstBranch({
        fullName: branchForm.fullName.trim(),
        pharmacyName: branchForm.pharmacyName.trim(),
        phone: branchForm.phone.trim(),
        email: branchForm.email.trim(),
        location: branchForm.location.trim(),
      });
      setBranchResult(result);
      setActivated(current => current ? { ...current, firstBranchId: result.branchId } : current);
      setStep("success");
    } catch (reason) {
      setBranchSubmitError(explain(reason, "register.errorRegisterBranchFailed"));
    } finally {
      setRegisteringBranch(false);
    }
  }

  function copyToClipboard(text: string) {
    navigator.clipboard.writeText(text);
    setCopied(text);
    setTimeout(() => setCopied(null), 2000);
  }

  const shownBranch = activated ?? application;
  // The success screen needs the FIRST BRANCH's own name/codes, not the
  // organization's legal name -- branchResult (set the moment
  // handleRegisterBranch succeeds) is authoritative right after
  // registering. Resuming straight into "success" in a later session (the
  // branch was already registered before) has no branchResult, but
  // get_organization_application(_by_email) already joins branch_code/
  // activation_code onto the application row for exactly this case --
  // falling back to the organization's own legal name for display in that
  // one resumed-not-fresh path is an acceptable simplification, since the
  // branch's own name was never fetched by that query.
  const successPharmacyName = branchResult?.pharmacyName ?? shownBranch?.legalName ?? "";
  const successBranchCode = branchResult?.branchCode ?? shownBranch?.branchCode ?? "—";
  const successActivationCode = branchResult?.activationCode ?? shownBranch?.activationCode ?? "—";

  const eyebrow = t("register.eyebrow");
  const tagline = t("register.tagline");

  return (
    <AuthShell image={pharmacyImg} imageAlt={t("register.imageAlt")} eyebrow={eyebrow} tagline={tagline} onBack={backToHome}>

      {/* Progress steps */}
      {step !== "form" && step !== "denied" && (
        <div className="flex items-center gap-0 mb-8">
          {[
            { label: t("register.stepRegister"), done: true },
            { label: t("register.stepVerify"), done: step === "otp" || step === "password" || step === "branch" || step === "success" },
            { label: t("register.stepSetPassword"), done: step === "password" || step === "branch" || step === "success" },
            { label: t("register.stepAddBranch"), done: step === "success" },
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
              {i < 3 && (
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
            <h1 className="text-2xl font-extrabold" style={authCardHeading}>{t("register.formTitle")}</h1>
            <p className="text-sm mt-2" style={authBody}>{t("register.formSubtitle")}</p>
          </div>

          <form onSubmit={handleSubmit} className="px-6 pb-6 space-y-5">
            <Field label={t("register.legalNameLabel")} icon={<Building2 className="w-4 h-4" />} error={formErrors.legalName}>
              <input
                type="text"
                placeholder={t("register.legalNamePlaceholder")}
                value={form.legalName}
                onChange={(e) => setForm((f) => ({ ...f, legalName: e.target.value }))}
                style={{ ...authInput, paddingLeft: 38, borderColor: formErrors.legalName ? "#fca5a5" : "#e2e8f0" }}
              />
            </Field>

            <Field label={t("register.tinLabel")} icon={<Building2 className="w-4 h-4" />}>
              <input
                type="text"
                placeholder={t("register.tinPlaceholder")}
                value={form.tin}
                onChange={(e) => setForm((f) => ({ ...f, tin: e.target.value }))}
                style={{ ...authInput, paddingLeft: 38 }}
              />
            </Field>

            <Field label={t("register.phoneLabel")} icon={<Phone className="w-4 h-4" />} error={formErrors.phone}>
              <input
                type="tel"
                placeholder={t("register.phonePlaceholder")}
                value={form.phone}
                onChange={(e) => setForm((f) => ({ ...f, phone: e.target.value }))}
                style={{ ...authInput, paddingLeft: 38, borderColor: formErrors.phone ? "#fca5a5" : "#e2e8f0" }}
              />
            </Field>

            <Field label={t("register.emailLabel")} icon={<Mail className="w-4 h-4" />} error={formErrors.email}>
              <input
                type="email"
                placeholder={t("auth.emailPlaceholder")}
                value={form.email}
                onChange={(e) => setForm((f) => ({ ...f, email: e.target.value }))}
                style={{ ...authInput, paddingLeft: 38, borderColor: formErrors.email ? "#fca5a5" : "#e2e8f0" }}
              />
            </Field>

            <Field label={t("register.orgLocationLabel")} icon={<MapPin className="w-4 h-4" />} error={formErrors.location}>
              <input
                type="text"
                placeholder={t("register.orgLocationPlaceholder")}
                value={form.location}
                onChange={(e) => setForm((f) => ({ ...f, location: e.target.value }))}
                style={{ ...authInput, paddingLeft: 38, borderColor: formErrors.location ? "#fca5a5" : "#e2e8f0" }}
              />
            </Field>

            <div className="rounded-xl p-3 flex gap-2" style={{ background: "#fffbeb", border: "1px solid #fde68a" }}>
              <AlertCircle className="w-4 h-4 shrink-0 mt-0.5" style={{ color: "#d97706" }} />
              <p className="text-xs" style={{ color: "#b45309", fontFamily: "var(--font-body)" }}>
                {t("register.verifyCallNotice")}
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
              {submitting ? <Loader2 className="w-4 h-4 animate-spin" /> : <>{t("register.submitButton")} <ArrowRight className="w-4 h-4" /></>}
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
              {t("register.checkStatusLink")}
            </button>
          ) : (
            <form onSubmit={handleCheckStatus} className="text-left space-y-3">
              <label className="text-xs font-semibold block" style={{ color: "#374151", fontFamily: "var(--font-body)" }}>
                {t("register.checkStatusLabel")}
              </label>
              <div className="flex gap-2">
                <input
                  type="email" autoFocus
                  value={checkEmail} onChange={(e) => { setCheckEmail(e.target.value); setCheckError(""); }}
                  placeholder={t("auth.emailPlaceholder")} disabled={checkBusy}
                  style={{ ...authInput, flex: 1 }}
                />
                <button type="submit" disabled={checkBusy}
                  className="px-4 rounded-xl text-sm font-semibold shrink-0"
                  style={{ ...authPrimaryButton, width: "auto", opacity: checkBusy ? 0.7 : 1 }}>
                  {checkBusy ? <Loader2 className="w-4 h-4 animate-spin" /> : t("register.checkStatusButton")}
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
            <h2 className="text-xl font-extrabold" style={authCardHeading}>{t("register.pendingTitle")}</h2>
            <p className="text-sm mt-2 leading-relaxed" style={authBody}>
              {tNode("register.pendingBody", {
                pharmacy: <span className="font-semibold" style={{ color: "#1e5fa8" }}>{shownBranch.legalName}</span>,
                phone: <span className="font-semibold" style={{ color: "#0f172a" }}>{shownBranch.phone}</span>,
              })}
            </p>
          </div>

          <div className="rounded-xl p-4 text-left space-y-1" style={{ background: "#f8fafb", border: "1px solid #e2e8f0" }}>
            <p className="text-[10px] uppercase tracking-widest" style={{ color: "#94a3b8", fontFamily: "var(--font-display)" }}>{t("register.applicationIdLabel")}</p>
            <p className="font-mono text-base font-bold" style={{ color: "#1e5fa8" }}>{shownBranch.applicationCode ?? shownBranch.id}</p>
            <p className="text-xs" style={{ color: "#6b7280" }}>{t("register.applicationIdHint")}</p>
          </div>

          <div className="rounded-xl p-4 text-left" style={{ background: "rgba(30,95,168,0.06)", border: "1px solid rgba(30,95,168,0.18)" }}>
            <p className="text-xs font-semibold" style={{ color: "var(--primary)" }}>{t("register.pendingCloseTitle")}</p>
            <p className="text-xs mt-1" style={{ color: "#334155" }}>
              {tNode("register.pendingCloseBody", {
                email: <span className="font-semibold">{shownBranch.email}</span>,
              })}
            </p>
          </div>

          <div className="flex items-center gap-2 justify-center text-sm" style={{ color: "#94a3b8" }}>
            <Loader2 className="w-3.5 h-3.5 animate-spin" />
            <span className="text-xs">{t("register.waitingApproval")}</span>
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
            <h2 className="text-xl font-extrabold" style={authCardHeading}>{t("register.deniedTitle")}</h2>
            <p className="text-sm mt-2 leading-relaxed" style={authBody}>
              {tNode("register.deniedBody", {
                pharmacy: <span className="font-semibold" style={{ color: "#0f172a" }}>{shownBranch.legalName}</span>,
              })}
            </p>
          </div>
          <div className="rounded-xl p-4 text-left" style={{ background: "#fef2f2", border: "1px solid #fecaca" }}>
            <p className="text-xs font-semibold" style={{ color: "#b91c1c" }}>{shownBranch.deniedReason ?? t("register.deniedDefaultReason")}</p>
          </div>
          <p className="text-xs" style={{ color: "#94a3b8" }}>
            {t("register.deniedFooter")}
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
            <h2 className="text-xl font-extrabold" style={authCardHeading}>{t("register.otpTitle")}</h2>
            <p className="text-sm mt-2" style={authBody}>
              {tNode("register.otpBody", {
                email: <span className="font-semibold" style={{ color: "#1e5fa8" }}>{application.email}</span>,
              })}
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
            {t("register.otpVerifyButton")}
          </button>

          <button
            onClick={() => void handleResend(application.email)}
            disabled={resending}
            className="flex items-center justify-center gap-1.5 text-xs mx-auto disabled:opacity-60"
            style={{ color: "#6b7280", fontFamily: "var(--font-body)" }}
          >
            {resending ? <Loader2 className="w-3 h-3 animate-spin" /> : <RefreshCw className="w-3 h-3" />}
            {t("register.otpResendButton")}
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
            <h2 className="text-xl font-extrabold" style={authCardHeading}>{t("register.passwordTitle")}</h2>
            <p className="text-sm mt-2" style={authBody}>
              {t("register.passwordSubtitle")}
            </p>
          </div>

          <form onSubmit={handleSetPassword} className="text-left space-y-4">
            <div>
              <label className="text-xs font-semibold block mb-1.5" style={{ color: "#374151", fontFamily: "var(--font-body)" }}>{t("auth.passwordLabel")}</label>
              <PasswordInput
                autoFocus autoComplete="new-password"
                value={password} onChange={e => { setPassword(e.target.value); setPasswordError(""); }}
                placeholder={t("auth.passwordMinPlaceholder", { count: MIN_PASSWORD_LENGTH })}
                style={authInput}
              />
            </div>
            <div>
              <label className="text-xs font-semibold block mb-1.5" style={{ color: "#374151", fontFamily: "var(--font-body)" }}>{t("register.confirmPasswordLabel")}</label>
              <PasswordInput
                autoComplete="new-password"
                value={confirmPassword} onChange={e => { setConfirmPassword(e.target.value); setPasswordError(""); }}
                placeholder={t("auth.confirmPasswordPlaceholder")}
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
              {settingPassword ? <Loader2 className="w-4 h-4 animate-spin" /> : t("register.passwordSubmitButton")}
            </button>
          </form>
        </div>
      )}

      {/* ── STEP: Register first branch ── */}
      {step === "branch" && (
        <div className="rounded-2xl overflow-hidden" style={{ background: "#fff", border: "1px solid #e8edf4" }}>
          <div className="px-6 py-6">
            <h1 className="text-2xl font-extrabold" style={authCardHeading}>{t("register.branchFormTitle")}</h1>
            <p className="text-sm mt-2" style={authBody}>{t("register.branchFormSubtitle")}</p>
          </div>

          <form onSubmit={handleRegisterBranch} className="px-6 pb-6 space-y-5">
            <Field label={t("register.yourNameLabel")} icon={<Building2 className="w-4 h-4" />} error={branchFormErrors.fullName}>
              <input
                type="text"
                placeholder={t("register.yourNamePlaceholder")}
                value={branchForm.fullName}
                onChange={(e) => setBranchForm((f) => ({ ...f, fullName: e.target.value }))}
                style={{ ...authInput, paddingLeft: 38, borderColor: branchFormErrors.fullName ? "#fca5a5" : "#e2e8f0" }}
              />
            </Field>

            <Field label={t("register.branchNameLabel")} icon={<Building2 className="w-4 h-4" />} error={branchFormErrors.pharmacyName}>
              <input
                type="text"
                placeholder={t("register.pharmacyNamePlaceholder")}
                value={branchForm.pharmacyName}
                onChange={(e) => setBranchForm((f) => ({ ...f, pharmacyName: e.target.value }))}
                style={{ ...authInput, paddingLeft: 38, borderColor: branchFormErrors.pharmacyName ? "#fca5a5" : "#e2e8f0" }}
              />
            </Field>

            <Field label={t("register.phoneLabel")} icon={<Phone className="w-4 h-4" />}>
              <input
                type="tel"
                value={branchForm.phone}
                onChange={(e) => setBranchForm((f) => ({ ...f, phone: e.target.value }))}
                style={{ ...authInput, paddingLeft: 38 }}
              />
            </Field>

            <Field label={t("register.emailLabel")} icon={<Mail className="w-4 h-4" />}>
              <input
                type="email"
                value={branchForm.email}
                onChange={(e) => setBranchForm((f) => ({ ...f, email: e.target.value }))}
                style={{ ...authInput, paddingLeft: 38 }}
              />
            </Field>

            <Field label={t("register.locationLabel")} icon={<MapPin className="w-4 h-4" />}>
              <input
                type="text"
                value={branchForm.location}
                onChange={(e) => setBranchForm((f) => ({ ...f, location: e.target.value }))}
                style={{ ...authInput, paddingLeft: 38 }}
              />
            </Field>

            {branchSubmitError && (
              <div className="rounded-xl p-3 flex gap-2" style={{ background: "#fef2f2", border: "1px solid #fecaca" }}>
                <AlertCircle className="w-4 h-4 shrink-0 mt-0.5" style={{ color: "#dc2626" }} />
                <p className="text-xs" style={{ color: "#b91c1c", fontFamily: "var(--font-body)" }}>{branchSubmitError}</p>
              </div>
            )}

            <button type="submit" disabled={registeringBranch}
              className="flex items-center justify-center gap-2"
              style={{ ...authPrimaryButton, opacity: registeringBranch ? 0.7 : 1 }}>
              {registeringBranch ? <Loader2 className="w-4 h-4 animate-spin" /> : <>{t("register.branchSubmitButton")} <ArrowRight className="w-4 h-4" /></>}
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
            <h2 className="text-xl font-extrabold text-white" style={{ fontFamily: "var(--font-display)" }}>{t("register.successTitle")}</h2>
            <p className="text-sm mt-1" style={{ color: "rgba(255,255,255,0.85)" }}>{successPharmacyName}</p>
          </div>

          <div className="p-6 space-y-4">
            <CodeDisplay
              label={t("register.branchCodeLabel")}
              value={successBranchCode}
              description={t("register.branchCodeHint")}
              copied={copied === successBranchCode}
              onCopy={() => copyToClipboard(successBranchCode)}
            />
            <CodeDisplay
              label={t("register.activationCodeLabel")}
              value={successActivationCode}
              description={t("register.activationCodeHint")}
              copied={copied === successActivationCode}
              onCopy={() => copyToClipboard(successActivationCode)}
            />

            <div className="rounded-xl p-4 space-y-1.5 text-xs" style={{ background: "rgba(30,95,168,0.06)", border: "1px solid rgba(30,95,168,0.2)", color: "#1a4f8f" }}>
              <p className="font-semibold">{t("register.successActiveTitle")}</p>
              <p>• {t("register.successPharmacyLabel")}: <span className="font-medium">{successPharmacyName}</span></p>
              {shownBranch?.location && <p>• {t("register.successLocationLabel")}: <span className="font-medium">{shownBranch.location}</span></p>}
              <p>• {t("register.successEmailLabel")}: <span className="font-medium">{application?.email}</span></p>
            </div>

            <div className="rounded-xl p-4 space-y-1.5 text-xs" style={{ background: "rgba(30,95,168,0.06)", border: "1px solid rgba(30,95,168,0.2)", color: "var(--primary-dark)" }}>
              <p className="font-semibold">{t("register.successNextTitle")}</p>
              <p>{t("register.successNextBody")}</p>
            </div>

            <button type="button" onClick={backToHome}
              className="flex items-center justify-center gap-2"
              style={authPrimaryButton}>
              {t("register.successButton")}
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
