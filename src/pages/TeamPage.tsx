import { useCallback, useEffect, useMemo, useState } from "react"
import { Btn, Card, CenterAlert, Modal, SectionHeader, StatusBadge } from "../components"
import { fmtRWFExact } from "../data"
import { useTranslation } from "../lib/i18n"
import { useGlobalSearch } from "../lib/search"
import { PasswordInput } from "./AuthShell"
import { createSeller, listBranchStaff, listSellerActivityToday, setSellerActive, type SellerActivityRow, type StaffMember } from "../lib/staff"
import { errorMessage } from "../lib/supabase"

function CreateSellerModal({ onClose, onCreated }: { onClose: () => void; onCreated: () => void }) {
  const { t } = useTranslation()
  const [fullName, setFullName] = useState("")
  const [email, setEmail] = useState("")
  const [password, setPassword] = useState("")
  const [error, setError] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)
  const inputStyle = { width: "100%", padding: "9px 10px", border: "1px solid var(--border)", borderRadius: 7, fontFamily: "inherit", fontSize: 12, boxSizing: "border-box" as const }

  async function submit() {
    if (!fullName.trim()) { setError(t("team.nameRequired")); return }
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email.trim())) { setError(t("team.emailInvalid")); return }
    if (password.length < 6) { setError(t("team.passwordTooShort")); return }
    setBusy(true)
    setError(null)
    try {
      await createSeller(fullName.trim(), email.trim(), password)
      onCreated()
    } catch (reason) {
      // lib/staff.ts's createSeller() already unwraps the function's own
      // {error: "..."} response body for a real HTTP error (validation
      // failure, duplicate email, etc.), so a raw SDK error reaching here
      // means the request never got a response at all -- the exact generic
      // text supabase-js throws when it can't reach the function (404/
      // network), almost always because create-branch-seller hasn't been
      // deployed yet. Matched narrowly so a real error message that merely
      // mentions "edge function" isn't mislabeled once the function is live.
      const raw = errorMessage(reason, t("team.createError"))
      setError(raw.toLowerCase().includes("failed to send a request") ? t("team.functionNotDeployed") : raw)
    } finally {
      setBusy(false)
    }
  }

  return <Modal title={t("team.createTitle")} onClose={onClose} width={440}>
    <div style={{ display: "flex", flexDirection: "column", gap: 12 }}>
      <p style={{ margin: 0, fontSize: 11, color: "var(--ink-muted)" }}>{t("team.createIntro")}</p>
      {error && <p style={{ margin: 0, fontSize: 11, color: "#dc2626" }}>{error}</p>}
      <div>
        <label style={{ fontSize: 10, fontWeight: 600, color: "var(--ink-muted)", textTransform: "uppercase", letterSpacing: "0.05em", display: "block", marginBottom: 4 }}>{t("team.fullNameLabel")}</label>
        <input value={fullName} onChange={e => setFullName(e.target.value)} style={inputStyle} />
      </div>
      <div>
        <label style={{ fontSize: 10, fontWeight: 600, color: "var(--ink-muted)", textTransform: "uppercase", letterSpacing: "0.05em", display: "block", marginBottom: 4 }}>{t("team.emailLabel")}</label>
        <input type="email" value={email} onChange={e => setEmail(e.target.value)} style={inputStyle} />
      </div>
      <div>
        <label style={{ fontSize: 10, fontWeight: 600, color: "var(--ink-muted)", textTransform: "uppercase", letterSpacing: "0.05em", display: "block", marginBottom: 4 }}>{t("team.passwordLabel")}</label>
        <PasswordInput value={password} onChange={e => setPassword(e.target.value)} style={inputStyle} placeholder={t("team.passwordPlaceholder")} />
        <p style={{ margin: "4px 0 0", fontSize: 10, color: "var(--ink-faint)" }}>{t("team.passwordHint")}</p>
      </div>
      <div style={{ display: "flex", justifyContent: "flex-end", gap: 8 }}>
        <Btn variant="ghost" onClick={onClose}>{t("team.cancel")}</Btn>
        <Btn variant="primary" onClick={() => void submit()}>{busy ? t("team.creating") : t("team.createSubmit")}</Btn>
      </div>
    </div>
  </Modal>
}

// Shared between TeamPage (its own nav item, owner + manager) and
// BranchSettingsPage (owner-only, folded in alongside the pharmacy profile
// fields) -- one roster/create-seller implementation, not two.
export function StaffRoster({ showHeader = true }: { showHeader?: boolean }) {
  const { t } = useTranslation()
  const [staff, setStaff] = useState<StaffMember[]>([])
  const [activity, setActivity] = useState<SellerActivityRow[]>([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const [showCreate, setShowCreate] = useState(false)
  const [successMsg, setSuccessMsg] = useState<string | null>(null)

  const refresh = useCallback(async () => {
    setLoading(true)
    setError(null)
    try {
      const [s, a] = await Promise.all([listBranchStaff(), listSellerActivityToday()])
      setStaff(s)
      setActivity(a)
    } catch (reason) {
      setError(errorMessage(reason, t("team.loadError")))
    } finally {
      setLoading(false)
    }
  }, [t])

  useEffect(() => { void refresh() }, [refresh])

  async function toggleActive(member: StaffMember) {
    try {
      await setSellerActive(member.id, !member.isActive)
      void refresh()
    } catch (reason) {
      setError(errorMessage(reason, t("team.toggleError")))
    }
  }

  const activityByUser = new Map(activity.map(row => [row.userId, row]))
  const { term: searchTerm } = useGlobalSearch()
  const visibleStaff = useMemo(() => {
    const needle = searchTerm.trim().toLowerCase()
    return needle ? staff.filter(m => `${m.fullName} ${m.email}`.toLowerCase().includes(needle)) : staff
  }, [staff, searchTerm])

  return <div style={{ display: "flex", flexDirection: "column", gap: 16 }}>
    {error && <div style={{ background: "#fef2f2", color: "#b91c1c", border: "1px solid #fecaca", borderRadius: 10, padding: "12px 14px", fontSize: 12 }}>{error}</div>}
    {successMsg && <CenterAlert key={successMsg} message={successMsg} tone="success" />}

    <Card>
      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "flex-start", marginBottom: 10, gap: 8 }}>
        <div>
          <h2 style={{ margin: 0, fontSize: 14 }}>{t("team.rosterTitle")}</h2>
          {showHeader && <p style={{ margin: "3px 0 0", color: "var(--ink-muted)", fontSize: 11 }}>{t("team.rosterSubtitle")}</p>}
        </div>
        <Btn variant="secondary" small onClick={() => setShowCreate(true)}>{t("team.createAction")}</Btn>
      </div>
      <div style={{ overflowX: "auto" }}>
        <table style={{ width: "100%", borderCollapse: "collapse", fontSize: 12 }}>
          <thead><tr style={{ borderBottom: "1px solid var(--border)" }}>
            {[t("team.colName"), t("team.colEmail"), t("team.colStatus"), t("team.colSalesToday"), t("team.colRevenueToday"), t("team.colPatientsToday"), ""].map(l => <th key={l} style={{ textAlign: "left", padding: "8px 10px", color: "var(--ink-muted)", fontSize: 10 }}>{l}</th>)}
          </tr></thead>
          <tbody>
            {visibleStaff.map(member => {
              const a = activityByUser.get(member.id)
              return <tr key={member.id} style={{ borderBottom: "1px solid var(--bg-alt)" }}>
                <td style={{ padding: "9px 10px", fontWeight: 600 }}>{member.fullName}</td>
                <td style={{ padding: "9px 10px", color: "var(--ink-muted)" }}>{member.email}</td>
                <td style={{ padding: "9px 10px" }}>
                  <StatusBadge label={member.isActive ? t("team.active") : t("team.inactive")} color={member.isActive ? "#16a34a" : "#6b7280"} bg={member.isActive ? "#d1fae5" : "#f3f4f6"} />
                </td>
                <td style={{ padding: "9px 10px" }}>{a?.salesCount ?? 0}</td>
                <td style={{ padding: "9px 10px" }}>{fmtRWFExact(a?.revenueToday ?? 0)}</td>
                <td style={{ padding: "9px 10px" }}>{a?.patientsRegisteredToday ?? 0}</td>
                <td style={{ padding: "9px 10px" }}>
                  <button onClick={() => void toggleActive(member)}
                    style={{ fontSize: 10, fontWeight: 700, color: member.isActive ? "#dc2626" : "#16a34a", background: "none", border: "1px solid var(--border)", borderRadius: 6, padding: "4px 8px", cursor: "pointer", fontFamily: "inherit", whiteSpace: "nowrap" }}>
                    {member.isActive ? t("team.deactivate") : t("team.activate")}
                  </button>
                </td>
              </tr>
            })}
            {!loading && visibleStaff.length === 0 && (
              <tr><td colSpan={7} style={{ padding: 28, textAlign: "center", color: "var(--ink-muted)" }}>
                {staff.length === 0 ? t("team.emptyRoster") : `No staff matching "${searchTerm}".`}
              </td></tr>
            )}
          </tbody>
        </table>
      </div>
    </Card>

    {showCreate && <CreateSellerModal onClose={() => setShowCreate(false)} onCreated={() => { setShowCreate(false); setSuccessMsg(t("team.createSuccess")); void refresh() }} />}
  </div>
}

export default function TeamPage() {
  const { t } = useTranslation()
  return <div className="animate-fade-in" style={{ display: "flex", flexDirection: "column", gap: 16 }}>
    <SectionHeader title={t("page.team")} subtitle={t("team.subtitle")} />
    <StaffRoster />
  </div>
}
