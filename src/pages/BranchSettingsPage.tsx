import { useCallback, useEffect, useState } from "react"
import { Btn, Card, CenterAlert, SectionHeader, StatusBadge } from "../components"
import { useTranslation } from "../lib/i18n"
import { branchLogoUrl, getMyBranchDetails, updateBranchDetails, uploadBranchLogo } from "../lib/branch"
import { updatePassword } from "../lib/auth"
import { errorMessage } from "../lib/supabase"
import { StaffRoster } from "./TeamPage"

const inputStyle = { width: "100%", padding: "9px 10px", border: "1px solid var(--border)", borderRadius: 7, fontFamily: "inherit", fontSize: 13, boxSizing: "border-box" as const }
const label = { fontSize: 10, fontWeight: 600, color: "var(--ink-muted)", textTransform: "uppercase" as const, letterSpacing: "0.05em", display: "block", marginBottom: 4 }

function CardHeader({ icon, title, subtitle }: { icon: string; title: string; subtitle?: string }) {
  return (
    <div style={{ display: "flex", alignItems: "flex-start", gap: 10, marginBottom: 14 }}>
      <div style={{ width: 32, height: 32, borderRadius: 8, background: "var(--primary-light)", display: "flex", alignItems: "center", justifyContent: "center", fontSize: 15, flexShrink: 0 }}>{icon}</div>
      <div>
        <h2 style={{ margin: 0, fontSize: 14, fontWeight: 700, color: "var(--ink)" }}>{title}</h2>
        {subtitle && <p style={{ margin: "3px 0 0", color: "var(--ink-muted)", fontSize: 11 }}>{subtitle}</p>}
      </div>
    </div>
  )
}

const STATUS_COLORS: Record<string, { c: string; bg: string }> = {
  active: { c: "#16a34a", bg: "#d1fae5" },
  locked: { c: "#dc2626", bg: "#fef2f2" },
  pending: { c: "#d97706", bg: "#fef3c7" },
  otp_sent: { c: "#d97706", bg: "#fef3c7" },
  denied: { c: "#dc2626", bg: "#fef2f2" },
}

// Reuses the Super Admin Portal's own status labels (admin.status*) rather
// than a second, parallel set of translations for the same five values.
const STATUS_LABEL_KEY: Record<string, "admin.statusPending" | "admin.statusOtpSent" | "admin.statusActive" | "admin.statusLocked" | "admin.statusDenied"> = {
  pending: "admin.statusPending", otp_sent: "admin.statusOtpSent", active: "admin.statusActive", locked: "admin.statusLocked", denied: "admin.statusDenied",
}

// `onLogoSaved` (App.tsx) lets the sidebar's own logo update the moment a
// save here actually persists a new one -- without it, the sidebar would
// only pick up the change on the next sign-in/reload, same staleness the
// receipt doesn't have (it re-fetches the branch row fresh every print).
export default function BranchSettingsPage({ onLogoSaved }: { onLogoSaved?: (url: string | null) => void }) {
  const { t } = useTranslation()
  const [branchName, setBranchName] = useState("")
  const [address, setAddress] = useState("")
  const [phone, setPhone] = useState("")
  const [tin, setTin] = useState("")
  const [logoPath, setLogoPath] = useState<string | null>(null)
  const [logoPreview, setLogoPreview] = useState<string | null>(null)
  const [bankAccountNumber, setBankAccountNumber] = useState("")
  const [bankAccountName, setBankAccountName] = useState("")
  const [momoPayNumber, setMomoPayNumber] = useState("")
  const [reminderHours, setReminderHours] = useState(6)
  const [branchCode, setBranchCode] = useState<string | null>(null)
  const [status, setStatus] = useState("active")
  const [createdAt, setCreatedAt] = useState("")
  const [loading, setLoading] = useState(true)
  const [saving, setSaving] = useState(false)
  const [uploadingLogo, setUploadingLogo] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [successMsg, setSuccessMsg] = useState<string | null>(null)
  // CenterAlert is keyed off this, not successMsg itself: the save/change
  // success text is the same constant string every time, so calling
  // setSuccessMsg(sameString) twice in a row is a no-op to React (identical
  // state, no re-render) -- the toast would only ever appear on the FIRST
  // save, silently stop showing on every one after that. A bump-on-every-
  // success counter guarantees a fresh key regardless of whether the
  // message text repeats.
  const [successSeq, setSuccessSeq] = useState(0)

  const [newPassword, setNewPassword] = useState("")
  const [confirmPassword, setConfirmPassword] = useState("")
  const [changingPassword, setChangingPassword] = useState(false)
  const [passwordError, setPasswordError] = useState<string | null>(null)
  const [passwordSuccess, setPasswordSuccess] = useState<string | null>(null)
  const [passwordSuccessSeq, setPasswordSuccessSeq] = useState(0)

  const refresh = useCallback(async () => {
    setLoading(true)
    setError(null)
    try {
      const details = await getMyBranchDetails()
      setBranchName(details.name)
      setAddress(details.address ?? "")
      setPhone(details.phone ?? "")
      setTin(details.tin ?? "")
      setLogoPath(details.logoPath)
      setBankAccountNumber(details.bankAccountNumber ?? "")
      setBankAccountName(details.bankAccountName ?? "")
      setMomoPayNumber(details.momoPayNumber ?? "")
      setReminderHours(details.outOfStockReminderHours)
      setBranchCode(details.branchCode)
      setStatus(details.status)
      setCreatedAt(details.createdAt)
    } catch (reason) {
      setError(errorMessage(reason, t("branchSettings.loadError")))
    } finally {
      setLoading(false)
    }
  }, [t])

  useEffect(() => { void refresh() }, [refresh])

  async function pickLogo(file: File | null) {
    if (!file) return
    setLogoPreview(URL.createObjectURL(file))
    setUploadingLogo(true)
    setError(null)
    try {
      const path = await uploadBranchLogo(file)
      setLogoPath(path)
    } catch (reason) {
      setError(errorMessage(reason, t("branchSettings.logoUploadError")))
    } finally {
      setUploadingLogo(false)
    }
  }

  async function save() {
    setSaving(true)
    setError(null)
    try {
      await updateBranchDetails(address.trim(), phone.trim(), tin.trim(), logoPath, bankAccountNumber.trim(), bankAccountName.trim(), momoPayNumber.trim(), reminderHours)
      setSuccessMsg(t("branchSettings.saveSuccess"))
      setSuccessSeq(seq => seq + 1)
      onLogoSaved?.(logoPath ? branchLogoUrl(logoPath) : null)
    } catch (reason) {
      setError(errorMessage(reason, t("branchSettings.saveError")))
    } finally {
      setSaving(false)
    }
  }

  async function changePassword() {
    setPasswordError(null)
    if (newPassword.length < 8) { setPasswordError(t("branchSettings.passwordTooShort")); return }
    if (newPassword !== confirmPassword) { setPasswordError(t("branchSettings.passwordMismatch")); return }
    setChangingPassword(true)
    try {
      await updatePassword(newPassword)
      setNewPassword("")
      setConfirmPassword("")
      setPasswordSuccess(t("branchSettings.passwordChangeSuccess"))
      setPasswordSuccessSeq(seq => seq + 1)
    } catch (reason) {
      setPasswordError(errorMessage(reason, t("branchSettings.passwordChangeError")))
    } finally {
      setChangingPassword(false)
    }
  }

  const logoSrc = logoPreview ?? (logoPath ? branchLogoUrl(logoPath) : null)
  const statusColor = STATUS_COLORS[status] ?? STATUS_COLORS.active

  return <div className="animate-fade-in" style={{ display: "flex", flexDirection: "column", gap: 16, maxWidth: 860 }}>
    {error && <div style={{ background: "#fef2f2", color: "#b91c1c", border: "1px solid #fecaca", borderRadius: 10, padding: "12px 14px", fontSize: 12 }}>{error}</div>}
    {successMsg && <CenterAlert key={successSeq} message={successMsg} tone="success" />}
    {passwordSuccess && <CenterAlert key={passwordSuccessSeq} message={passwordSuccess} tone="success" />}

    <SectionHeader title={t("page.branch")} subtitle={t("branchSettings.subtitle")} />

    {loading ? <Card><p style={{ fontSize: 12, color: "var(--ink-muted)" }}>{t("branchSettings.loading")}</p></Card> : (
      <>
        {/* Branch Info + Notification Preferences, side by side */}
        <div style={{ display: "flex", gap: 16, flexWrap: "wrap" }}>
          <Card style={{ flex: "1 1 300px", minWidth: 280 }}>
            <CardHeader icon="🏥" title={t("branchSettings.infoTitle")} />
            <div style={{ display: "flex", flexDirection: "column", gap: 10 }}>
              {branchCode && (
                <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center" }}>
                  <span style={{ fontSize: 12, color: "var(--ink-muted)" }}>{t("branchSettings.branchCodeLabel")}</span>
                  <span style={{ fontSize: 12, fontWeight: 700, fontFamily: "monospace", color: "var(--ink)" }}>{branchCode}</span>
                </div>
              )}
              <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center" }}>
                <span style={{ fontSize: 12, color: "var(--ink-muted)" }}>{t("branchSettings.statusLabel")}</span>
                <StatusBadge label={t(STATUS_LABEL_KEY[status] ?? "admin.statusActive")} color={statusColor.c} bg={statusColor.bg} />
              </div>
              {createdAt && (
                <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center" }}>
                  <span style={{ fontSize: 12, color: "var(--ink-muted)" }}>{t("branchSettings.memberSinceLabel")}</span>
                  <span style={{ fontSize: 12, fontWeight: 600, color: "var(--ink)" }}>{new Date(createdAt).toLocaleDateString()}</span>
                </div>
              )}
            </div>
          </Card>

          <Card style={{ flex: "1 1 300px", minWidth: 280 }}>
            <CardHeader icon="🔔" title={t("branchSettings.notificationsTitle")} subtitle={t("branchSettings.notificationsSubtitle")} />
            <label style={label}>{t("branchSettings.reminderHoursLabel")}</label>
            <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
              <input
                type="number" min={1} max={168} value={reminderHours}
                onChange={e => setReminderHours(Math.max(1, Math.min(168, Number(e.target.value) || 1)))}
                style={{ ...inputStyle, width: 90 }}
              />
              <span style={{ fontSize: 12, color: "var(--ink-muted)" }}>{t("branchSettings.reminderHoursUnit")}</span>
            </div>
            <p style={{ margin: "8px 0 0", fontSize: 10, color: "var(--ink-faint)" }}>{t("branchSettings.reminderHoursHint")}</p>
          </Card>
        </div>

        {/* Pharmacy Profile */}
        <Card>
          <CardHeader icon="🧾" title={t("branchSettings.profileTitle")} subtitle={t("branchSettings.profileSubtitle")} />
          <div style={{ display: "flex", flexDirection: "column", gap: 14 }}>
            <div style={{ display: "flex", gap: 14, alignItems: "center" }}>
              <div style={{ width: 72, height: 72, borderRadius: 10, border: "1px solid var(--border)", background: "var(--bg)", display: "flex", alignItems: "center", justifyContent: "center", overflow: "hidden", flexShrink: 0 }}>
                {logoSrc ? <img src={logoSrc} alt="" style={{ width: "100%", height: "100%", objectFit: "contain" }} /> : <span style={{ fontSize: 10, color: "var(--ink-faint)" }}>{t("branchSettings.noLogo")}</span>}
              </div>
              <div>
                <label style={label}>{t("branchSettings.logoLabel")}</label>
                <input type="file" accept="image/*" onChange={e => void pickLogo(e.target.files?.[0] ?? null)} style={{ fontSize: 12 }} disabled={uploadingLogo} />
                <p style={{ margin: "4px 0 0", fontSize: 10, color: "var(--ink-faint)" }}>{uploadingLogo ? t("branchSettings.logoUploading") : t("branchSettings.logoHint")}</p>
              </div>
            </div>

            <div>
              <label style={label}>{t("branchSettings.nameLabel")}</label>
              <input value={branchName} disabled style={{ ...inputStyle, background: "var(--bg)", color: "var(--ink-muted)" }} />
              <p style={{ margin: "4px 0 0", fontSize: 10, color: "var(--ink-faint)" }}>{t("branchSettings.nameHint")}</p>
            </div>
            <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 12 }}>
              <div>
                <label style={label}>{t("branchSettings.addressLabel")}</label>
                <input value={address} onChange={e => setAddress(e.target.value)} style={inputStyle} />
              </div>
              <div>
                <label style={label}>{t("branchSettings.phoneLabel")}</label>
                <input value={phone} onChange={e => setPhone(e.target.value)} style={inputStyle} />
              </div>
            </div>
            <div>
              <label style={label}>{t("branchSettings.tinLabel")}</label>
              <input value={tin} onChange={e => setTin(e.target.value)} style={inputStyle} />
              <p style={{ margin: "4px 0 0", fontSize: 10, color: "var(--ink-faint)" }}>{t("branchSettings.tinHint")}</p>
            </div>
          </div>
        </Card>

        {/* Payment Details */}
        <Card>
          <CardHeader icon="💳" title={t("branchSettings.paymentTitle")} />
          <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 12 }}>
            <div>
              <label style={label}>{t("branchSettings.bankAccountNumberLabel")}</label>
              <input value={bankAccountNumber} onChange={e => setBankAccountNumber(e.target.value)} style={inputStyle} />
            </div>
            <div>
              <label style={label}>{t("branchSettings.bankAccountNameLabel")}</label>
              <input value={bankAccountName} onChange={e => setBankAccountName(e.target.value)} style={inputStyle} />
            </div>
          </div>
          <div style={{ marginTop: 12 }}>
            <label style={label}>{t("branchSettings.momoPayLabel")}</label>
            <input value={momoPayNumber} onChange={e => setMomoPayNumber(e.target.value)} style={inputStyle} />
          </div>
        </Card>

        <div style={{ display: "flex", justifyContent: "flex-end" }}>
          <Btn variant="primary" onClick={() => void save()}>{saving ? t("branchSettings.saving") : t("branchSettings.save")}</Btn>
        </div>

        {/* Account & Security */}
        <Card>
          <CardHeader icon="🔒" title={t("branchSettings.securityTitle")} subtitle={t("branchSettings.securitySubtitle")} />
          {passwordError && <p style={{ fontSize: 12, color: "#b91c1c", marginBottom: 10 }}>{passwordError}</p>}
          <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 12, maxWidth: 480 }}>
            <div>
              <label style={label}>{t("branchSettings.newPasswordLabel")}</label>
              <input type="password" value={newPassword} onChange={e => setNewPassword(e.target.value)} style={inputStyle} />
            </div>
            <div>
              <label style={label}>{t("branchSettings.confirmPasswordLabel")}</label>
              <input type="password" value={confirmPassword} onChange={e => setConfirmPassword(e.target.value)} style={inputStyle} />
            </div>
          </div>
          <div style={{ display: "flex", justifyContent: "flex-end", marginTop: 12 }}>
            <Btn variant="secondary" onClick={() => void changePassword()}>{changingPassword ? t("branchSettings.changingPassword") : t("branchSettings.changePassword")}</Btn>
          </div>
        </Card>

        {/* Team */}
        <div>
          <h2 style={{ margin: "4px 0 4px", fontSize: 14 }}>{t("branchSettings.staffTitle")}</h2>
          <p style={{ margin: "0 0 10px", color: "var(--ink-muted)", fontSize: 11 }}>{t("branchSettings.staffSubtitle")}</p>
          <StaffRoster showHeader={false} />
        </div>
      </>
    )}
  </div>
}
