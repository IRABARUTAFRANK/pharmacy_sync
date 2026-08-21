import { useState, useEffect, useCallback, useRef } from "react";
import {
  Building2, Phone, Mail, MapPin, ArrowRight, CheckCircle2,
  Loader2, ShieldCheck, KeyRound, RefreshCw, AlertCircle, Copy, Check,
} from "lucide-react";
import {
  getPharmacyApplication,
  requestPharmacyOtp,
  submitPharmacyRegistration,
  verifyPharmacyOtp,
} from "../lib/onboarding";
import type { BranchRecord } from "../lib/store";

type Step = "form" | "pending" | "otp" | "success";

const SESSION_KEY = "psync_application_session";

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
  const otpSentRef = useRef(false);

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

  // Restore an in-flight application after a page refresh
  const resumeApplication = useCallback(async (id: string) => {
    try {
      const record = await getPharmacyApplication(id);
      if (!record) return;
      setApplication(record);
      setApplicationId(id);
      if (record.status === "active") { setActivated(record); setStep("success"); }
      else if (record.status === "otp_sent") {
        setStep("otp");
        if (!otpSentRef.current) {
          otpSentRef.current = true;
          void handleResend(record.email, true);
        }
      }
      else if (record.status === "denied") setStep("pending");
      else setStep("pending");
    } catch {
      sessionStorage.removeItem(SESSION_KEY);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useEffect(() => {
    const savedId = sessionStorage.getItem(SESSION_KEY);
    if (savedId) void resumeApplication(savedId);
  }, [resumeApplication]);

  // Poll the application status while waiting for the admin / OTP email
  useEffect(() => {
    if (step !== "pending" && step !== "otp") return;
    if (!applicationId) return;
    const interval = setInterval(async () => {
      try {
        const record = await getPharmacyApplication(applicationId);
        if (!record) return;
        setApplication(record);
        if (record.status === "otp_sent" && step === "pending") {
          setStep("otp");
          if (!otpSentRef.current) {
            otpSentRef.current = true;
            void handleResend(record.email, true);
          }
        }
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

  async function handleResend(email: string, silent = false) {
    setResending(true);
    if (!silent) setResendInfo("");
    try {
      await requestPharmacyOtp(email);
      if (!silent) setResendInfo(`A new 6-digit code was sent to ${email}.`);
    } catch (reason) {
      if (!silent) setResendInfo(reason instanceof Error ? reason.message : "Could not send the code right now.");
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
      setStep("success");
    } catch (reason) {
      setOtpError(reason instanceof Error ? reason.message : "Incorrect code. Check your email and try again.");
    }
  }

  function copyToClipboard(text: string) {
    navigator.clipboard.writeText(text);
    setCopied(text);
    setTimeout(() => setCopied(null), 2000);
  }

  const shownBranch = activated ?? application;

  // ── Render ─────────────────────────────────────────────────────────────────

  return (
    <div className="min-h-screen bg-gradient-to-br from-green-50 via-white to-emerald-50 flex flex-col">
      {/* Header */}
      <header className="bg-white border-b border-green-100 px-6 py-4">
        <div className="max-w-4xl mx-auto flex items-center justify-between">
          <div className="flex items-center gap-3">
            <div className="w-9 h-9 bg-green-600 rounded-lg flex items-center justify-center">
              <ShieldCheck className="w-5 h-5 text-white" />
            </div>
            <div>
              <p className="font-semibold text-green-900 text-sm leading-tight">PharmacySync</p>
              <p className="text-[10px] text-green-600 font-mono uppercase tracking-widest">Branch Registration</p>
            </div>
          </div>
          <span className="text-xs text-slate-400 hidden sm:block">Secure · Verified · Trusted</span>
        </div>
      </header>

      <div className="flex-1 flex items-start justify-center px-4 py-10">
        <div className="w-full max-w-lg">

          {/* Progress steps */}
          {step !== "form" && (
            <div className="flex items-center gap-0 mb-8">
              {[
                { label: "Register", done: true },
                { label: "Verification", done: step === "otp" || step === "success" },
                { label: "Active", done: step === "success" },
              ].map((s, i) => (
                <div key={i} className="flex items-center flex-1">
                  <div className="flex flex-col items-center">
                    <div
                      className={`w-7 h-7 rounded-full flex items-center justify-center text-xs font-bold ${
                        s.done ? "bg-green-600 text-white" : "bg-green-100 text-green-400"
                      }`}
                    >
                      {s.done ? <Check className="w-3.5 h-3.5" /> : i + 1}
                    </div>
                    <p className="text-[10px] mt-1 font-mono text-slate-500">{s.label}</p>
                  </div>
                  {i < 2 && (
                    <div className={`flex-1 h-0.5 mx-1 mb-4 ${s.done ? "bg-green-400" : "bg-green-100"}`} />
                  )}
                </div>
              ))}
            </div>
          )}

          {/* ── STEP: Form ── */}
          {step === "form" && (
            <div className="bg-white rounded-2xl shadow-sm border border-green-100 overflow-hidden">
              <div className="bg-gradient-to-r from-green-600 to-emerald-500 px-6 py-6 text-white">
                <h1 className="text-xl font-bold">Register Your Branch</h1>
                <p className="text-green-100 text-sm mt-1">
                  Apply for a PharmacySync portal. Our admin team will verify and activate your account.
                </p>
              </div>

              <form onSubmit={handleSubmit} className="p-6 space-y-5">
                <Field
                  label="Pharmacy Name"
                  icon={<Building2 className="w-4 h-4" />}
                  error={formErrors.pharmacyName}
                >
                  <input
                    type="text"
                    placeholder="e.g. Nairobi Central Pharmacy"
                    value={form.pharmacyName}
                    onChange={(e) => setForm((f) => ({ ...f, pharmacyName: e.target.value }))}
                    className={inputCls(!!formErrors.pharmacyName)}
                  />
                </Field>

                <Field
                  label="Phone Number"
                  icon={<Phone className="w-4 h-4" />}
                  error={formErrors.phone}
                >
                  <input
                    type="tel"
                    placeholder="+254 7XX XXX XXX"
                    value={form.phone}
                    onChange={(e) => setForm((f) => ({ ...f, phone: e.target.value }))}
                    className={inputCls(!!formErrors.phone)}
                  />
                </Field>

                <Field
                  label="Email Address"
                  icon={<Mail className="w-4 h-4" />}
                  error={formErrors.email}
                >
                  <input
                    type="email"
                    placeholder="branch@yourpharmacy.com"
                    value={form.email}
                    onChange={(e) => setForm((f) => ({ ...f, email: e.target.value }))}
                    className={inputCls(!!formErrors.email)}
                  />
                </Field>

                <Field
                  label="Branch Location"
                  icon={<MapPin className="w-4 h-4" />}
                  error={formErrors.location}
                >
                  <input
                    type="text"
                    placeholder="e.g. Nairobi, Tom Mboya St, Ground Floor"
                    value={form.location}
                    onChange={(e) => setForm((f) => ({ ...f, location: e.target.value }))}
                    className={inputCls(!!formErrors.location)}
                  />
                </Field>

                <div className="bg-amber-50 border border-amber-200 rounded-lg p-3 flex gap-2">
                  <AlertCircle className="w-4 h-4 text-amber-500 shrink-0 mt-0.5" />
                  <p className="text-xs text-amber-700">
                    Our admin team will call the phone number you provide to verify your identity before approving your registration.
                  </p>
                </div>

                {submitError && (
                  <div className="bg-red-50 border border-red-200 rounded-lg p-3 flex gap-2">
                    <AlertCircle className="w-4 h-4 text-red-500 shrink-0 mt-0.5" />
                    <p className="text-xs text-red-700">{submitError}</p>
                  </div>
                )}

                <button
                  type="submit"
                  disabled={submitting}
                  className="w-full flex items-center justify-center gap-2 bg-green-600 hover:bg-green-700 text-white font-semibold py-3 rounded-xl transition-colors disabled:opacity-60"
                >
                  {submitting ? (
                    <Loader2 className="w-4 h-4 animate-spin" />
                  ) : (
                    <>Submit Application <ArrowRight className="w-4 h-4" /></>
                  )}
                </button>
              </form>
            </div>
          )}

          {/* ── STEP: Pending ── */}
          {step === "pending" && shownBranch && (
            <div className="bg-white rounded-2xl shadow-sm border border-green-100 p-8 text-center space-y-5">
              <div className="w-16 h-16 bg-amber-50 border-2 border-amber-200 rounded-full flex items-center justify-center mx-auto">
                <Phone className="w-7 h-7 text-amber-500" />
              </div>
              <div>
                <h2 className="text-xl font-bold text-slate-800">Application Under Review</h2>
                <p className="text-slate-500 text-sm mt-2 leading-relaxed">
                  Your registration for{" "}
                  <span className="font-semibold text-green-700">{shownBranch.pharmacyName}</span>{" "}
                  has been received. Our admin team will call{" "}
                  <span className="font-semibold text-slate-700">{shownBranch.phone}</span>{" "}
                  to verify your identity.
                </p>
              </div>

              <div className="bg-slate-50 border border-slate-200 rounded-xl p-4 text-left space-y-2">
                <p className="text-[10px] font-mono uppercase tracking-widest text-slate-400">Your Application ID</p>
                <p className="font-mono text-base font-bold text-green-700">{shownBranch.applicationCode ?? shownBranch.id}</p>
                <p className="text-xs text-slate-500">Save this ID — you may need it if you contact support.</p>
              </div>

              {shownBranch.status === "denied" && (
                <div className="bg-red-50 border border-red-200 rounded-xl p-4 text-left">
                  <p className="text-xs font-semibold text-red-700">Your application was not approved.</p>
                  {shownBranch.deniedReason && (
                    <p className="text-xs text-red-600 mt-1">Reason: {shownBranch.deniedReason}</p>
                  )}
                </div>
              )}

              <div className="flex items-center gap-2 justify-center text-sm text-slate-400">
                <Loader2 className="w-3.5 h-3.5 animate-spin" />
                <span className="text-xs">Waiting for admin approval…</span>
              </div>

              <div className="space-y-1 text-xs text-slate-400">
                <p>What happens next:</p>
                <p>1. Admin calls your number to verify</p>
                <p>2. A 6-digit code is sent to <span className="text-slate-600">{shownBranch.email}</span></p>
                <p>3. You enter the code here to activate your account</p>
              </div>
            </div>
          )}

          {/* ── STEP: OTP ── */}
          {step === "otp" && application && (
            <div className="bg-white rounded-2xl shadow-sm border border-green-100 p-8 text-center space-y-6">
              <div className="w-16 h-16 bg-green-50 border-2 border-green-200 rounded-full flex items-center justify-center mx-auto">
                <KeyRound className="w-7 h-7 text-green-600" />
              </div>
              <div>
                <h2 className="text-xl font-bold text-slate-800">Enter Verification Code</h2>
                <p className="text-slate-500 text-sm mt-2">
                  A 6-digit code was sent to{" "}
                  <span className="font-semibold text-green-700">{application.email}</span>
                </p>
              </div>

              <div
                className="flex justify-center gap-2"
                onPaste={handleOtpPaste}
              >
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
                    className={`w-11 h-14 text-center text-xl font-bold rounded-xl border-2 transition-colors font-mono ${
                      otpError
                        ? "border-red-300 bg-red-50 text-red-700"
                        : digit
                        ? "border-green-400 bg-green-50 text-green-800"
                        : "border-slate-200 bg-slate-50 text-slate-800 focus:border-green-400 focus:bg-green-50"
                    }`}
                  />
                ))}
              </div>

              {otpError && (
                <div className="flex items-center justify-center gap-1.5 text-red-500 text-xs">
                  <AlertCircle className="w-3.5 h-3.5" />
                  {otpError}
                </div>
              )}

              <button
                onClick={verifyOtp}
                disabled={otp.join("").length < 6}
                className="w-full flex items-center justify-center gap-2 bg-green-600 hover:bg-green-700 text-white font-semibold py-3 rounded-xl transition-colors disabled:opacity-50"
              >
                <ShieldCheck className="w-4 h-4" />
                Verify & Activate Account
              </button>

              <button
                onClick={() => void handleResend(application.email)}
                disabled={resending}
                className="flex items-center justify-center gap-1.5 text-xs text-slate-400 hover:text-green-600 transition-colors mx-auto disabled:opacity-60"
              >
                {resending ? <Loader2 className="w-3 h-3 animate-spin" /> : <RefreshCw className="w-3 h-3" />}
                Resend code
              </button>
              {resendInfo && <p className="text-[11px] text-slate-400 -mt-3">{resendInfo}</p>}
            </div>
          )}

          {/* ── STEP: Success ── */}
          {step === "success" && shownBranch && (
            <div className="bg-white rounded-2xl shadow-sm border border-green-100 overflow-hidden">
              <div className="bg-gradient-to-r from-green-600 to-emerald-500 p-6 text-white text-center">
                <div className="w-14 h-14 bg-white/20 rounded-full flex items-center justify-center mx-auto mb-3">
                  <CheckCircle2 className="w-8 h-8 text-white" />
                </div>
                <h2 className="text-xl font-bold">Account Activated!</h2>
                <p className="text-green-100 text-sm mt-1">{shownBranch.pharmacyName}</p>
              </div>

              <div className="p-6 space-y-4">
                <CodeDisplay
                  label="Your Branch System Code"
                  value={shownBranch.branchCode ?? "—"}
                  description="This is your permanent identifier in the PharmacySync database. Keep it safe."
                  copied={copied === shownBranch.branchCode}
                  onCopy={() => copyToClipboard(shownBranch.branchCode ?? "")}
                />
                <CodeDisplay
                  label="Activation Code"
                  value={shownBranch.activationCode ?? "—"}
                  description="Use this code when setting up PharmacySync on your devices."
                  copied={copied === shownBranch.activationCode}
                  onCopy={() => copyToClipboard(shownBranch.activationCode ?? "")}
                />

                <div className="bg-green-50 border border-green-200 rounded-xl p-4 space-y-1.5 text-xs text-green-800">
                  <p className="font-semibold">Your account is now active</p>
                  <p>• Pharmacy: <span className="font-medium">{shownBranch.pharmacyName}</span></p>
                  {shownBranch.location && <p>• Location: <span className="font-medium">{shownBranch.location}</span></p>}
                  <p>• Email: <span className="font-medium">{application?.email}</span></p>
                </div>

                <div className="bg-emerald-50 border border-emerald-200 rounded-xl p-4 space-y-1.5 text-xs text-emerald-800">
                  <p className="font-semibold">Next: open your operations dashboard</p>
                  <p>Go to the PharmSync dashboard app and sign in with this email — a fresh 6-digit code will be sent to you each time you sign in.</p>
                </div>
              </div>
            </div>
          )}
        </div>
      </div>
    </div>
  );
}

// ── Helpers ───────────────────────────────────────────────────────────────────

function inputCls(hasError: boolean) {
  return `w-full pl-10 pr-4 py-2.5 rounded-lg border text-sm transition-colors ${
    hasError
      ? "border-red-300 bg-red-50 focus:border-red-400"
      : "border-slate-200 bg-slate-50 focus:border-green-400 focus:bg-white"
  }`;
}

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
      <label className="text-xs font-semibold text-slate-600 block mb-1.5">{label}</label>
      <div className="relative">
        <span className="absolute left-3 top-1/2 -translate-y-1/2 text-slate-400">{icon}</span>
        {children}
      </div>
      {error && (
        <p className="text-xs text-red-500 mt-1 flex items-center gap-1">
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
    <div className="bg-slate-50 border border-slate-200 rounded-xl p-4">
      <p className="text-[10px] font-mono uppercase tracking-widest text-slate-400 mb-1">{label}</p>
      <div className="flex items-center justify-between gap-2">
        <p className="font-mono text-xl font-bold text-green-700">{value}</p>
        <button
          onClick={onCopy}
          className="flex items-center gap-1 text-xs text-slate-400 hover:text-green-600 transition-colors"
        >
          {copied ? <Check className="w-3.5 h-3.5" /> : <Copy className="w-3.5 h-3.5" />}
        </button>
      </div>
      <p className="text-[11px] text-slate-500 mt-1">{description}</p>
    </div>
  );
}
