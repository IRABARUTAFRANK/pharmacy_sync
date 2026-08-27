import { useCallback, useEffect, useState } from "react"
import { Btn, Card, CenterAlert, SectionHeader } from "../components"
import { useTranslation } from "../lib/i18n"
import { branchLogoUrl, getMyBranchDetails, updateBranchDetails, uploadBranchLogo } from "../lib/branch"
import { errorMessage } from "../lib/supabase"
import { StaffRoster } from "./TeamPage"

export default function BranchSettingsPage() {
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
  const [loading, setLoading] = useState(true)
  const [saving, setSaving] = useState(false)
  const [uploadingLogo, setUploadingLogo] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [successMsg, setSuccessMsg] = useState<string | null>(null)

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
      await updateBranchDetails(address.trim(), phone.trim(), tin.trim(), logoPath, bankAccountNumber.trim(), bankAccountName.trim(), momoPayNumber.trim())
      setSuccessMsg(t("branchSettings.saveSuccess"))
    } catch (reason) {
      setError(errorMessage(reason, t("branchSettings.saveError")))
    } finally {
      setSaving(false)
    }
  }

  const inputStyle = { width: "100%", padding: "9px 10px", border: "1px solid var(--border)", borderRadius: 7, fontFamily: "inherit", fontSize: 13, boxSizing: "border-box" as const }
  const logoSrc = logoPreview ?? (logoPath ? branchLogoUrl(logoPath) : null)

  return <div className="animate-fade-in" style={{ display: "flex", flexDirection: "column", gap: 16, maxWidth: 720 }}>
    {error && <div style={{ background: "#fef2f2", color: "#b91c1c", border: "1px solid #fecaca", borderRadius: 10, padding: "12px 14px", fontSize: 12 }}>{error}</div>}
    {successMsg && <CenterAlert key={successMsg} message={successMsg} tone="success" />}

    <SectionHeader title={t("page.branch")} subtitle={t("branchSettings.subtitle")} />

    <Card>
      {loading ? <p style={{ fontSize: 12, color: "var(--ink-muted)" }}>{t("branchSettings.loading")}</p> : (
        <div style={{ display: "flex", flexDirection: "column", gap: 14 }}>
          <div>
            <h2 style={{ margin: 0, fontSize: 14 }}>{t("branchSettings.profileTitle")}</h2>
            <p style={{ margin: "3px 0 12px", color: "var(--ink-muted)", fontSize: 11 }}>{t("branchSettings.profileSubtitle")}</p>
          </div>

          <div style={{ display: "flex", gap: 14, alignItems: "center" }}>
            <div style={{ width: 72, height: 72, borderRadius: 10, border: "1px solid var(--border)", background: "var(--bg)", display: "flex", alignItems: "center", justifyContent: "center", overflow: "hidden", flexShrink: 0 }}>
              {logoSrc ? <img src={logoSrc} alt="" style={{ width: "100%", height: "100%", objectFit: "contain" }} /> : <span style={{ fontSize: 10, color: "var(--ink-faint)" }}>{t("branchSettings.noLogo")}</span>}
            </div>
            <div>
              <label style={{ fontSize: 10, fontWeight: 600, color: "var(--ink-muted)", textTransform: "uppercase", letterSpacing: "0.05em", display: "block", marginBottom: 4 }}>{t("branchSettings.logoLabel")}</label>
              <input type="file" accept="image/*" onChange={e => void pickLogo(e.target.files?.[0] ?? null)} style={{ fontSize: 12 }} disabled={uploadingLogo} />
              <p style={{ margin: "4px 0 0", fontSize: 10, color: "var(--ink-faint)" }}>{uploadingLogo ? t("branchSettings.logoUploading") : t("branchSettings.logoHint")}</p>
            </div>
          </div>

          <div>
            <label style={{ fontSize: 10, fontWeight: 600, color: "var(--ink-muted)", textTransform: "uppercase", letterSpacing: "0.05em", display: "block", marginBottom: 4 }}>{t("branchSettings.nameLabel")}</label>
            <input value={branchName} disabled style={{ ...inputStyle, background: "var(--bg)", color: "var(--ink-muted)" }} />
            <p style={{ margin: "4px 0 0", fontSize: 10, color: "var(--ink-faint)" }}>{t("branchSettings.nameHint")}</p>
          </div>
          <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 12 }}>
            <div>
              <label style={{ fontSize: 10, fontWeight: 600, color: "var(--ink-muted)", textTransform: "uppercase", letterSpacing: "0.05em", display: "block", marginBottom: 4 }}>{t("branchSettings.addressLabel")}</label>
              <input value={address} onChange={e => setAddress(e.target.value)} style={inputStyle} />
            </div>
            <div>
              <label style={{ fontSize: 10, fontWeight: 600, color: "var(--ink-muted)", textTransform: "uppercase", letterSpacing: "0.05em", display: "block", marginBottom: 4 }}>{t("branchSettings.phoneLabel")}</label>
              <input value={phone} onChange={e => setPhone(e.target.value)} style={inputStyle} />
            </div>
          </div>
          <div>
            <label style={{ fontSize: 10, fontWeight: 600, color: "var(--ink-muted)", textTransform: "uppercase", letterSpacing: "0.05em", display: "block", marginBottom: 4 }}>{t("branchSettings.tinLabel")}</label>
            <input value={tin} onChange={e => setTin(e.target.value)} style={inputStyle} />
            <p style={{ margin: "4px 0 0", fontSize: 10, color: "var(--ink-faint)" }}>{t("branchSettings.tinHint")}</p>
          </div>

          <div style={{ borderTop: "1px solid var(--bg-alt)", paddingTop: 12 }}>
            <h3 style={{ margin: "0 0 10px", fontSize: 12, fontWeight: 700, color: "var(--ink-muted)", textTransform: "uppercase", letterSpacing: "0.05em" }}>{t("branchSettings.paymentTitle")}</h3>
            <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 12 }}>
              <div>
                <label style={{ fontSize: 10, fontWeight: 600, color: "var(--ink-muted)", textTransform: "uppercase", letterSpacing: "0.05em", display: "block", marginBottom: 4 }}>{t("branchSettings.bankAccountNumberLabel")}</label>
                <input value={bankAccountNumber} onChange={e => setBankAccountNumber(e.target.value)} style={inputStyle} />
              </div>
              <div>
                <label style={{ fontSize: 10, fontWeight: 600, color: "var(--ink-muted)", textTransform: "uppercase", letterSpacing: "0.05em", display: "block", marginBottom: 4 }}>{t("branchSettings.bankAccountNameLabel")}</label>
                <input value={bankAccountName} onChange={e => setBankAccountName(e.target.value)} style={inputStyle} />
              </div>
            </div>
            <div style={{ marginTop: 12 }}>
              <label style={{ fontSize: 10, fontWeight: 600, color: "var(--ink-muted)", textTransform: "uppercase", letterSpacing: "0.05em", display: "block", marginBottom: 4 }}>{t("branchSettings.momoPayLabel")}</label>
              <input value={momoPayNumber} onChange={e => setMomoPayNumber(e.target.value)} style={inputStyle} />
            </div>
          </div>

          <div style={{ display: "flex", justifyContent: "flex-end" }}>
            <Btn variant="primary" onClick={() => void save()}>{saving ? t("branchSettings.saving") : t("branchSettings.save")}</Btn>
          </div>
        </div>
      )}
    </Card>

    <div>
      <h2 style={{ margin: "4px 0 4px", fontSize: 14 }}>{t("branchSettings.staffTitle")}</h2>
      <p style={{ margin: "0 0 10px", color: "var(--ink-muted)", fontSize: 11 }}>{t("branchSettings.staffSubtitle")}</p>
      <StaffRoster showHeader={false} />
    </div>
  </div>
}
