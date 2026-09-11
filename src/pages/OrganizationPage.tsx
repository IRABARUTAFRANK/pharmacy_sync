import { useCallback, useEffect, useMemo, useState } from "react"
import {
  AreaChart, Area, BarChart, Bar, XAxis, YAxis, CartesianGrid, Tooltip, Legend, ResponsiveContainer,
} from "recharts"
import { Btn, Card, CenterAlert, ChartTooltip, Modal, SectionHeader, StatusBadge } from "../components"
import { useTranslation } from "../lib/i18n"
import type { TranslationKey } from "../lib/i18n/en"
import { errorMessage } from "../lib/supabase"
import {
  addBranchToOrganization, assignBranchRole, createPharmacyOrganization, inviteOrganizationMember,
  listOrganizationBranches, listOrganizationPeople, listRoleChangeLog, orgBranchSummary, removeOrganizationMember,
  setPersonActive, staffOrganizationBranch, updateOrganizationDetails,
  type BranchRole, type OrgBranchSummary, type OrgRole, type OrganizationBranch, type OrganizationPerson,
  type OrganizationSummary, type RoleChangeLogEntry,
} from "../lib/organization"
import { loadInventoryDataset, type InventoryRow } from "../lib/inventory"
import {
  approveStockTransfer, cancelStockTransfer, dispatchStockTransfer, listBranchStockTransfers,
  listOrganizationStockTransfers, receiveStockTransfer, rejectStockTransfer, requestStockTransfer,
  type StockTransfer, type StockTransferStatus,
} from "../lib/stockTransfers"
import { loadOrgOverview, type OverviewPeriod } from "../lib/overview"
import type { LiveAlert } from "../lib/alerts"
import { PasswordInput } from "./AuthShell"
import OverviewPage from "./OverviewPage"

const inputStyle = { width: "100%", padding: "9px 10px", border: "1px solid var(--border)", borderRadius: 7, fontFamily: "inherit", fontSize: 13, boxSizing: "border-box" as const }
const labelStyle = { fontSize: 10, fontWeight: 600, color: "var(--ink-muted)", textTransform: "uppercase" as const, letterSpacing: "0.05em", display: "block", marginBottom: 4 }

// Matches OverviewPage's own `heroCardStyle` -- the Dashboard tab renders
// <OverviewPage> plus these two extra cards (pending approvals, branch
// leaderboard) on the same screen, so they need the identical rounded,
// border-free, soft-shadow look or the seam between the two components
// would show.
const DASHBOARD_CARD_STYLE = { borderRadius: 20, border: "none", boxShadow: "0 6px 24px rgba(17,24,39,0.07)" } as const

function CardHeader({ icon, title, subtitle }: { icon: string; title: string; subtitle?: string }) {
  return (
    <div style={{ display: "flex", alignItems: "center", gap: 12, marginBottom: 6 }}>
      <div style={{ width: 40, height: 40, borderRadius: 10, background: "var(--primary-light)", display: "flex", alignItems: "center", justifyContent: "center", fontSize: 18, flexShrink: 0 }}>{icon}</div>
      <div>
        <h2 style={{ margin: 0, fontSize: 15, fontWeight: 700, color: "var(--ink)" }}>{title}</h2>
        {subtitle && <p style={{ margin: "2px 0 0", color: "var(--ink-muted)", fontSize: 12 }}>{subtitle}</p>}
      </div>
    </div>
  )
}

const ORG_ROLE_COLORS: Record<OrgRole, { c: string; bg: string }> = {
  org_owner: { c: "#7c3aed", bg: "#ede9fe" },
  org_manager: { c: "#2563eb", bg: "#dbeafe" },
}

function OrgRoleBadge({ role }: { role: OrgRole }) {
  const { t } = useTranslation()
  const colors = ORG_ROLE_COLORS[role]
  return <StatusBadge label={t(role === "org_owner" ? "organization.roleOrgOwner" : "organization.roleOrgManager")} color={colors.c} bg={colors.bg} />
}

const BRANCH_ROLE_COLORS: Record<BranchRole, { c: string; bg: string }> = {
  owner: { c: "#7c3aed", bg: "#ede9fe" },
  manager: { c: "#2563eb", bg: "#dbeafe" },
  seller: { c: "#4b5563", bg: "#f3f4f6" },
}

// The unified Members list mixes org-level people (OrgRole) and branch-level
// staff (BranchRole) in one table -- this picks the right label/color for
// whichever kind a given row is.
function PersonRoleBadge({ scope, role }: { scope: "organization" | "branch"; role: OrgRole | BranchRole }) {
  if (scope === "organization") return <OrgRoleBadge role={role as OrgRole} />
  const colors = BRANCH_ROLE_COLORS[role as BranchRole]
  const labelKey: TranslationKey = role === "owner" ? "organization.roleBranchOwner" : role === "manager" ? "organization.roleBranchManager" : "organization.roleBranchSeller"
  return <StatusBadgeWithT labelKey={labelKey} color={colors.c} bg={colors.bg} />
}

function StatusBadgeWithT({ labelKey, color, bg }: { labelKey: TranslationKey; color: string; bg: string }) {
  const { t } = useTranslation()
  return <StatusBadge label={t(labelKey)} color={color} bg={bg} />
}

const BRANCH_STATUS_COLORS: Record<string, { c: string; bg: string }> = {
  active: { c: "#16a34a", bg: "#d1fae5" },
  locked: { c: "#dc2626", bg: "#fef2f2" },
}

// A stable color per branch (by position in the org's branch list) for the
// leaderboard's color dots and, eventually, any per-branch chart series --
// same small fixed palette idea as OverviewPage's own categorical colors,
// just keyed by branch instead of product category.
const BRANCH_DOT_PALETTE = ["#1e5fa8", "#7c3aed", "#0891b2", "#059669", "#d97706", "#db2777"]
function branchDotColor(index: number): string {
  return BRANCH_DOT_PALETTE[index % BRANCH_DOT_PALETTE.length]
}

const TRANSFER_STATUS_COLORS: Record<StockTransferStatus, { c: string; bg: string }> = {
  pending: { c: "#d97706", bg: "#fef3c7" },
  approved: { c: "#2563eb", bg: "#dbeafe" },
  in_transit: { c: "#7c3aed", bg: "#ede9fe" },
  received: { c: "#16a34a", bg: "#d1fae5" },
  rejected: { c: "#dc2626", bg: "#fef2f2" },
  cancelled: { c: "#6b7280", bg: "#f3f4f6" },
}

function TransferStatusBadge({ status }: { status: StockTransferStatus }) {
  const { t } = useTranslation()
  const colors = TRANSFER_STATUS_COLORS[status]
  return <StatusBadge label={t(`organization.transferStatus_${status}` as TranslationKey)} color={colors.c} bg={colors.bg} />
}

// Dismissed state is per-browser only (localStorage), same reasoning every
// other purely-client-side reminder in this app uses -- it's a nudge, not a
// setting that needs to sync anywhere.
function TwoFactorNudge() {
  const { t } = useTranslation()
  const [dismissed, setDismissed] = useState(() => {
    try { return localStorage.getItem("psync_2fa_nudge_dismissed") === "1" } catch { return false }
  })
  if (dismissed) return null
  return (
    <div style={{ background: "#fffbeb", border: "1px solid #fde68a", borderRadius: 10, padding: "12px 14px", display: "flex", justifyContent: "space-between", alignItems: "center", gap: 12, fontSize: 12, color: "#92400e" }}>
      <span>🔐 {t("organization.twoFactorNudge")}</span>
      <button
        onClick={() => { try { localStorage.setItem("psync_2fa_nudge_dismissed", "1") } catch { /* ignore */ } setDismissed(true) }}
        style={{ background: "none", border: "none", cursor: "pointer", fontSize: 16, color: "#92400e", lineHeight: 1, flexShrink: 0 }}
      >×</button>
    </div>
  )
}

function CreateOrganizationCard({ onCreated }: { onCreated: () => void }) {
  const { t } = useTranslation()
  const [legalName, setLegalName] = useState("")
  const [tin, setTin] = useState("")
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)

  async function submit() {
    if (!legalName.trim()) { setError(t("organization.legalNameRequired")); return }
    setBusy(true)
    setError(null)
    try {
      await createPharmacyOrganization(legalName.trim(), tin.trim() || undefined)
      onCreated()
    } catch (reason) {
      setError(errorMessage(reason, t("organization.createError")))
    } finally {
      setBusy(false)
    }
  }

  return (
    <Card>
      <CardHeader icon="🏢" title={t("organization.createTitle")} subtitle={t("organization.createSubtitle")} />
      {error && <p style={{ fontSize: 12, color: "#b91c1c", margin: "0 0 10px" }}>{error}</p>}
      <div style={{ display: "flex", flexDirection: "column", gap: 12, maxWidth: 420 }}>
        <div>
          <label style={labelStyle}>{t("organization.legalNameLabel")}</label>
          <input value={legalName} onChange={e => setLegalName(e.target.value)} style={inputStyle} />
        </div>
        <div>
          <label style={labelStyle}>{t("organization.tinLabel")}</label>
          <input value={tin} onChange={e => setTin(e.target.value)} style={inputStyle} />
        </div>
        <div>
          <Btn variant="primary" onClick={() => void submit()}>{busy ? t("organization.creating") : t("organization.createSubmit")}</Btn>
        </div>
      </div>
    </Card>
  )
}

function AddBranchModal({ organizationId, onClose, onCreated }: {
  organizationId: string; onClose: () => void; onCreated: (branchId: string, pharmacyName: string) => void
}) {
  const { t } = useTranslation()
  const [name, setName] = useState("")
  const [phone, setPhone] = useState("")
  const [email, setEmail] = useState("")
  const [location, setLocation] = useState("")
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)

  async function submit() {
    if (!name.trim()) { setError(t("organization.branchNameRequired")); return }
    setBusy(true)
    setError(null)
    try {
      const branchId = await addBranchToOrganization(organizationId, name.trim(), phone.trim(), email.trim(), location.trim())
      onCreated(branchId, name.trim())
    } catch (reason) {
      setError(errorMessage(reason, t("organization.addBranchError")))
      setBusy(false)
    }
  }

  return (
    <Modal title={t("organization.addBranchTitle")} onClose={onClose} width={440}>
      <div style={{ display: "flex", flexDirection: "column", gap: 12 }}>
        <p style={{ margin: 0, fontSize: 11, color: "var(--ink-muted)" }}>{t("organization.addBranchIntro")}</p>
        {error && <p style={{ margin: 0, fontSize: 11, color: "#dc2626" }}>{error}</p>}
        <div>
          <label style={labelStyle}>{t("organization.branchNameLabel")}</label>
          <input value={name} onChange={e => setName(e.target.value)} style={inputStyle} />
        </div>
        <div>
          <label style={labelStyle}>{t("organization.branchPhoneLabel")}</label>
          <input value={phone} onChange={e => setPhone(e.target.value)} style={inputStyle} />
        </div>
        <div>
          <label style={labelStyle}>{t("organization.branchEmailLabel")}</label>
          <input type="email" value={email} onChange={e => setEmail(e.target.value)} style={inputStyle} />
        </div>
        <div>
          <label style={labelStyle}>{t("organization.branchLocationLabel")}</label>
          <input value={location} onChange={e => setLocation(e.target.value)} style={inputStyle} />
        </div>
        <div style={{ display: "flex", justifyContent: "flex-end", gap: 8 }}>
          <Btn variant="ghost" onClick={onClose}>{t("organization.cancel")}</Btn>
          <Btn variant="primary" onClick={() => void submit()}>{busy ? t("organization.creating") : t("organization.addBranchSubmit")}</Btn>
        </div>
      </div>
    </Modal>
  )
}

// Shown immediately after AddBranchModal succeeds, or from the Branches tab
// for any existing branch -- staffing isn't limited to brand-new branches
// any more. `alreadyStaffed` hides the "owner" choice (the server would
// reject it anyway -- a branch may only ever have one) and defaults the
// picker straight to "manager".
function StaffBranchModal({ branchId, branchName, alreadyStaffed, onClose, onStaffed }: {
  branchId: string; branchName: string; alreadyStaffed: boolean; onClose: () => void; onStaffed: () => void
}) {
  const { t } = useTranslation()
  const [fullName, setFullName] = useState("")
  const [email, setEmail] = useState("")
  const [password, setPassword] = useState("")
  const [role, setRole] = useState<"owner" | "manager" | "seller">(alreadyStaffed ? "manager" : "owner")
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)

  const roleChoices = (alreadyStaffed ? ["manager", "seller"] : ["owner", "manager", "seller"]) as Array<"owner" | "manager" | "seller">
  const ROLE_LABEL_KEYS: Record<"owner" | "manager" | "seller", TranslationKey> = {
    owner: "organization.roleBranchOwner", manager: "organization.roleBranchManager", seller: "organization.roleBranchSeller",
  }

  async function submit() {
    if (!fullName.trim()) { setError(t("organization.usersNameRequired")); return }
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) { setError(t("organization.usersEmailInvalid")); return }
    if (password.length < 6) { setError(t("organization.usersPasswordTooShort")); return }
    setBusy(true)
    setError(null)
    try {
      await staffOrganizationBranch(branchId, fullName.trim(), email.trim(), password, role)
      onStaffed()
    } catch (reason) {
      setError(errorMessage(reason, t("organization.staffBranchError")))
    } finally {
      setBusy(false)
    }
  }

  return (
    <Modal title={t("organization.staffBranchTitle", { name: branchName })} onClose={onClose} width={440}>
      <div style={{ display: "flex", flexDirection: "column", gap: 12 }}>
        <p style={{ margin: 0, fontSize: 11, color: "var(--ink-muted)" }}>{t("organization.staffBranchIntro")}</p>
        {error && <p style={{ margin: 0, fontSize: 11, color: "#dc2626" }}>{error}</p>}
        <div>
          <label style={labelStyle}>{t("organization.usersFullNameLabel")}</label>
          <input value={fullName} onChange={e => setFullName(e.target.value)} style={inputStyle} />
        </div>
        <div>
          <label style={labelStyle}>{t("organization.usersEmailLabel")}</label>
          <input type="email" value={email} onChange={e => setEmail(e.target.value)} style={inputStyle} />
        </div>
        <div>
          <label style={labelStyle}>{t("organization.usersPasswordLabel")}</label>
          <PasswordInput value={password} onChange={e => setPassword(e.target.value)} style={inputStyle} />
        </div>
        <div>
          <label style={labelStyle}>{t("organization.usersRoleLabel")}</label>
          <div style={{ display: "flex", gap: 8 }}>
            {roleChoices.map(r => (
              <button key={r} type="button" onClick={() => setRole(r)} style={{
                flex: 1, padding: "10px", borderRadius: 8, fontFamily: "inherit", cursor: "pointer",
                border: `1.5px solid ${role === r ? "var(--primary)" : "var(--border)"}`,
                background: role === r ? "var(--primary-light)" : "var(--surface)",
                color: role === r ? "var(--primary)" : "var(--ink-mid)", fontWeight: role === r ? 700 : 500, fontSize: 12,
              }}>{t(ROLE_LABEL_KEYS[r])}</button>
            ))}
          </div>
        </div>
        <div style={{ display: "flex", justifyContent: "flex-end", gap: 8 }}>
          <Btn variant="ghost" onClick={onClose}>{t("organization.skipStaffing")}</Btn>
          <Btn variant="primary" onClick={() => void submit()}>{busy ? t("organization.creating") : t("organization.staffBranchSubmit")}</Btn>
        </div>
      </div>
    </Modal>
  )
}

type AssignableRole = "org_manager" | "manager" | "seller"
const ASSIGNABLE_ROLES: AssignableRole[] = ["org_manager", "manager", "seller"]
const ASSIGNABLE_ROLE_LABEL_KEYS: Record<AssignableRole, TranslationKey> = {
  org_manager: "organization.roleOrgManager", manager: "organization.roleBranchManager", seller: "organization.roleBranchSeller",
}

// One assign flow for all three roles an org_owner (or org_manager, for the
// branch-scoped two) can hand out -- org_owner itself is never a choice here,
// since ownership only ever moves via the separate Transfer Ownership
// action. The org_owner/org_manager sets a real password here, same as the
// older "Staff" button (StaffBranchModal above) already does for
// manager/seller -- the new person signs in immediately with the email and
// password they were given, no separate OTP round trip. If the email
// already belongs to an existing login, there is no password to set (they
// keep the one they have); this falls back to a plain role change via the
// existing OTP-invite RPCs' "granted" branch, which already handles exactly
// that case.
function AssignRoleModal({ organizationId, branches, onClose, onDone }: {
  organizationId: string; branches: OrganizationBranch[]; onClose: () => void
  onDone: (result: "created" | "granted" | "invited") => void
}) {
  const { t } = useTranslation()
  const [email, setEmail] = useState("")
  const [fullName, setFullName] = useState("")
  const [password, setPassword] = useState("")
  const [role, setRole] = useState<AssignableRole>("org_manager")
  const [branchId, setBranchId] = useState(branches[0]?.branchId ?? "")
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)

  async function submit() {
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) { setError(t("organization.usersEmailInvalid")); return }
    if (!fullName.trim()) { setError(t("organization.usersNameRequired")); return }
    if (!branchId) { setError(t("organization.homeBranchRequired")); return }
    if (password.length < 6) { setError(t("organization.usersPasswordTooShort")); return }
    setBusy(true)
    setError(null)
    const trimmedEmail = email.trim()
    const trimmedName = fullName.trim()
    try {
      await staffOrganizationBranch(branchId, trimmedName, trimmedEmail, password, role)
      onDone("created")
    } catch (reason) {
      if (errorMessage(reason, "") === "This email is already in use") {
        // Not a new person -- they already have a login (and a password) of
        // their own. Fall back to a pure role change; no password involved.
        try {
          const result = role === "org_manager"
            ? await inviteOrganizationMember(organizationId, branchId, trimmedEmail, trimmedName)
            : await assignBranchRole(organizationId, branchId, trimmedEmail, trimmedName, role)
          onDone(result)
          return
        } catch (fallbackReason) {
          setError(errorMessage(fallbackReason, t("organization.inviteMemberError")))
          setBusy(false)
          return
        }
      }
      setError(errorMessage(reason, t("organization.inviteMemberError")))
      setBusy(false)
    }
  }

  return (
    <Modal title={t("organization.inviteMemberTitle")} onClose={onClose} width={460}>
      <div style={{ display: "flex", flexDirection: "column", gap: 12 }}>
        <p style={{ margin: 0, fontSize: 11, color: "var(--ink-muted)" }}>{t("organization.inviteMemberIntro")}</p>
        {error && <p style={{ margin: 0, fontSize: 11, color: "#dc2626" }}>{error}</p>}
        <div>
          <label style={labelStyle}>{t("organization.usersFullNameLabel")}</label>
          <input value={fullName} onChange={e => setFullName(e.target.value)} style={inputStyle} />
        </div>
        <div>
          <label style={labelStyle}>{t("organization.usersEmailLabel")}</label>
          <input type="email" value={email} onChange={e => setEmail(e.target.value)} style={inputStyle} />
        </div>
        <div>
          <label style={labelStyle}>{t("organization.usersPasswordLabel")}</label>
          <PasswordInput value={password} onChange={e => setPassword(e.target.value)} style={inputStyle} />
          <p style={{ margin: "4px 0 0", fontSize: 10, color: "var(--ink-faint)" }}>{t("organization.assignPasswordHint")}</p>
        </div>
        <div>
          <label style={labelStyle}>{t("organization.usersRoleLabel")}</label>
          <div style={{ display: "flex", gap: 8 }}>
            {ASSIGNABLE_ROLES.map(r => (
              <button key={r} type="button" onClick={() => setRole(r)} style={{
                flex: 1, padding: "10px", borderRadius: 8, fontFamily: "inherit", cursor: "pointer",
                border: `1.5px solid ${role === r ? "var(--primary)" : "var(--border)"}`,
                background: role === r ? "var(--primary-light)" : "var(--surface)",
                color: role === r ? "var(--primary)" : "var(--ink-mid)", fontWeight: role === r ? 700 : 500, fontSize: 12,
              }}>{t(ASSIGNABLE_ROLE_LABEL_KEYS[r])}</button>
            ))}
          </div>
        </div>
        <div>
          <label style={labelStyle}>{t(role === "org_manager" ? "organization.homeBranchLabel" : "organization.assignBranchLabel")}</label>
          <select value={branchId} onChange={e => setBranchId(e.target.value)} style={inputStyle}>
            {branches.map(b => <option key={b.branchId} value={b.branchId}>{b.name}</option>)}
          </select>
          {role === "org_manager" && <p style={{ margin: "4px 0 0", fontSize: 10, color: "var(--ink-faint)" }}>{t("organization.homeBranchHint")}</p>}
        </div>
        <div style={{ display: "flex", justifyContent: "flex-end", gap: 8 }}>
          <Btn variant="ghost" onClick={onClose}>{t("organization.cancel")}</Btn>
          <Btn variant="primary" onClick={() => void submit()}>{busy ? t("organization.inviting") : t("organization.inviteMemberSubmit")}</Btn>
        </div>
      </div>
    </Modal>
  )
}

function RequestTransferModal({ destinationBranches, onClose, onRequested }: {
  destinationBranches: OrganizationBranch[]; onClose: () => void; onRequested: () => void
}) {
  const { t } = useTranslation()
  const [toBranchId, setToBranchId] = useState(destinationBranches[0]?.branchId ?? "")
  const [notes, setNotes] = useState("")
  const [search, setSearch] = useState("")
  const [selected, setSelected] = useState<Set<string>>(new Set())
  const [rows, setRows] = useState<InventoryRow[]>([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)

  useEffect(() => {
    loadInventoryDataset()
      .then(dataset => setRows(dataset.rows.filter(r => r.quantity_available > 0)))
      .catch(reason => setError(errorMessage(reason, t("organization.transferLoadStockError"))))
      .finally(() => setLoading(false))
  }, [t])

  const filtered = useMemo(() => {
    const needle = search.trim().toLowerCase()
    if (!needle) return rows
    return rows.filter(r => r.name.toLowerCase().includes(needle) || r.batch_number.toLowerCase().includes(needle))
  }, [rows, search])

  function toggle(batchId: string) {
    setSelected(prev => {
      const next = new Set(prev)
      if (next.has(batchId)) next.delete(batchId); else next.add(batchId)
      return next
    })
  }

  async function submit() {
    if (!toBranchId) { setError(t("organization.transferDestinationRequired")); return }
    if (selected.size === 0) { setError(t("organization.transferNoBatchesSelected")); return }
    setBusy(true)
    setError(null)
    try {
      await requestStockTransfer(toBranchId, Array.from(selected), notes.trim() || undefined)
      onRequested()
    } catch (reason) {
      setError(errorMessage(reason, t("organization.transferRequestError")))
      setBusy(false)
    }
  }

  return (
    <Modal title={t("organization.requestTransferTitle")} onClose={onClose} width={560}>
      <div style={{ display: "flex", flexDirection: "column", gap: 12 }}>
        <p style={{ margin: 0, fontSize: 11, color: "var(--ink-muted)" }}>{t("organization.requestTransferIntro")}</p>
        {error && <p style={{ margin: 0, fontSize: 11, color: "#dc2626" }}>{error}</p>}
        <div>
          <label style={labelStyle}>{t("organization.destinationBranchLabel")}</label>
          <select value={toBranchId} onChange={e => setToBranchId(e.target.value)} style={inputStyle}>
            {destinationBranches.map(b => <option key={b.branchId} value={b.branchId}>{b.name}</option>)}
          </select>
        </div>
        <div>
          <label style={labelStyle}>{t("organization.pickBatchesLabel")}</label>
          <input value={search} onChange={e => setSearch(e.target.value)} placeholder={t("organization.pickBatchesSearchPlaceholder")} style={{ ...inputStyle, marginBottom: 8 }} />
          <div style={{ maxHeight: 220, overflowY: "auto", border: "1px solid var(--border)", borderRadius: 7 }}>
            {loading ? <p style={{ padding: 12, fontSize: 12, color: "var(--ink-muted)" }}>{t("organization.loading")}</p> : filtered.length === 0 ? (
              <p style={{ padding: 12, fontSize: 12, color: "var(--ink-muted)" }}>{t("organization.transferNoStock")}</p>
            ) : filtered.map(row => (
              <label key={row.batch_id} style={{ display: "flex", alignItems: "center", gap: 10, padding: "8px 10px", borderBottom: "1px solid var(--bg-alt)", cursor: "pointer", fontSize: 12 }}>
                <input type="checkbox" checked={selected.has(row.batch_id)} onChange={() => toggle(row.batch_id)} />
                <div style={{ flex: 1 }}>
                  <div style={{ fontWeight: 600, color: "var(--ink)" }}>{row.name}</div>
                  <div style={{ color: "var(--ink-muted)", fontSize: 11 }}>{row.batch_number} · {row.quantity_available} {t("organization.transferUnitsAvailable")}</div>
                </div>
              </label>
            ))}
          </div>
        </div>
        <div>
          <label style={labelStyle}>{t("organization.transferNotesLabel")}</label>
          <input value={notes} onChange={e => setNotes(e.target.value)} style={inputStyle} />
        </div>
        <div style={{ display: "flex", justifyContent: "flex-end", gap: 8 }}>
          <Btn variant="ghost" onClick={onClose}>{t("organization.cancel")}</Btn>
          <Btn variant="primary" onClick={() => void submit()}>{busy ? t("organization.creating") : t("organization.requestTransferSubmit")}</Btn>
        </div>
      </div>
    </Modal>
  )
}

function TransferRow({ transfer, currentBranchId, onAction }: {
  transfer: StockTransfer
  currentBranchId: string
  onAction: (action: "approve" | "reject" | "dispatch" | "receive" | "cancel", transfer: StockTransfer) => void
}) {
  const { t } = useTranslation()
  const isSender = transfer.fromBranchId === currentBranchId
  const isReceiver = transfer.toBranchId === currentBranchId
  const actions: Array<{ key: "approve" | "reject" | "dispatch" | "receive" | "cancel"; label: TranslationKey; variant: "primary" | "secondary" | "danger" }> = []
  if (transfer.status === "pending") {
    if (isReceiver) { actions.push({ key: "approve", label: "organization.transferApprove", variant: "primary" }, { key: "reject", label: "organization.transferReject", variant: "danger" }) }
    if (isSender) actions.push({ key: "cancel", label: "organization.transferCancel", variant: "danger" })
  } else if (transfer.status === "approved") {
    if (isSender) actions.push({ key: "dispatch", label: "organization.transferDispatch", variant: "primary" })
    if (isReceiver) actions.push({ key: "reject", label: "organization.transferReject", variant: "danger" })
  } else if (transfer.status === "in_transit" && isReceiver) {
    actions.push({ key: "receive", label: "organization.transferReceive", variant: "primary" })
  }

  return (
    <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", padding: "12px 0", borderBottom: "1px solid var(--bg-alt)", gap: 12, flexWrap: "wrap" }}>
      <div>
        <div style={{ fontWeight: 700, fontSize: 13, color: "var(--ink)" }}>{transfer.fromBranchName} → {transfer.toBranchName}</div>
        <div style={{ fontSize: 12, color: "var(--ink-muted)" }}>
          {t("organization.transferBatchCount", { count: transfer.batchCount })}
          {transfer.requestedByName ? ` · ${transfer.requestedByName}` : ""}
          {transfer.notes ? ` · ${transfer.notes}` : ""}
        </div>
      </div>
      <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
        <TransferStatusBadge status={transfer.status} />
        {actions.map(a => (
          <Btn key={a.key} variant={a.variant} small onClick={() => onAction(a.key, transfer)}>{t(a.label)}</Btn>
        ))}
      </div>
    </div>
  )
}

// Kept in sync with App.tsx's own local ORG_TABS constant, which drives the
// actual tab switcher now (see the `activeTab` prop below).
type OrgTab = "dashboard" | "transfers" | "branches" | "members" | "settings"

export default function OrganizationPage({
  currentUserId, currentBranchId, organization, onOrganizationChanged, onViewBranch, activeTab, period, alerts, onViewAlerts, onGoToTransfers,
}: {
  currentUserId: string
  currentBranchId: string
  organization: OrganizationSummary | null
  onOrganizationChanged: () => void
  // Drills into a branch's own operational dashboard (Overview/Inventory/
  // Sales/etc.) -- this always goes through App's top-level `page` state
  // (see App.tsx), never a nested view inside this component, so the org
  // dashboard cleanly unmounts instead of stacking with the branch one.
  onViewBranch: (branch: { branchId: string; branchName: string; branchCode: string | null }) => void
  // Which of ORG_TABS is showing. Controlled by App.tsx -- while this page
  // is active, App's own sidebar IS the org-tab switcher (Dashboard/Stock
  // Transfers/Branches/Members/Settings), replacing the branch nav rather
  // than sitting alongside a second, nested tab list here. See App.tsx's
  // `orgTab` state for why this isn't owned locally.
  // The three below exist only to hand straight to <OverviewPage> for the
  // "dashboard" tab -- same values App.tsx already threads to the plain
  // sidebar Overview page, so this is the org-wide dashboard sharing the
  // exact same component and data instead of a second, duplicate one.
  period: OverviewPeriod
  alerts: LiveAlert[]
  onViewAlerts: () => void
  // Jumps the dashboard's "Pending Approvals" callout (org_manager only,
  // see the dashboard tab below) straight to the Stock Transfers tab --
  // same App.tsx-owned orgTab switch as clicking the sidebar itself.
  onGoToTransfers: () => void
  activeTab: OrgTab
}) {
  const { t } = useTranslation()
  const [branches, setBranches] = useState<OrganizationBranch[]>([])
  const [branchesLoading, setBranchesLoading] = useState(true)
  const [branchesError, setBranchesError] = useState<string | null>(null)
  const [showAddBranch, setShowAddBranch] = useState(false)
  const [staffingBranch, setStaffingBranch] = useState<{ id: string; name: string; alreadyStaffed: boolean } | null>(null)

  const [members, setMembers] = useState<OrganizationPerson[]>([])
  const [membersLoading, setMembersLoading] = useState(true)
  const [membersError, setMembersError] = useState<string | null>(null)
  const [showInviteMember, setShowInviteMember] = useState(false)

  const [log, setLog] = useState<RoleChangeLogEntry[]>([])
  const [logLoading, setLogLoading] = useState(true)
  const [logError, setLogError] = useState<string | null>(null)

  const [summary, setSummary] = useState<OrgBranchSummary[]>([])
  const [summaryLoading, setSummaryLoading] = useState(true)
  const [summaryError, setSummaryError] = useState<string | null>(null)
  const [leaderboardSortKey, setLeaderboardSortKey] = useState<"todayRevenue" | "monthToDateRevenue" | "alerts">("monthToDateRevenue")
  const [leaderboardSortAsc, setLeaderboardSortAsc] = useState(false)

  // Per-branch daily revenue, merged into one combined series for the
  // multi-branch trend chart below -- org_overview_raw()'s combined-branches
  // call doesn't tag each sale with its branch_id (see that RPC's comment),
  // so this reuses the same per-branch call the "View Branch" drill-in
  // already relies on, once per branch, rather than a new backend endpoint.
  const [branchTrend, setBranchTrend] = useState<Record<string, string | number>[]>([])
  const [branchTrendLoading, setBranchTrendLoading] = useState(true)
  const [branchTrendError, setBranchTrendError] = useState<string | null>(null)
  const [activeTrendBranches, setActiveTrendBranches] = useState<Set<string>>(new Set())

  const [myTransfers, setMyTransfers] = useState<StockTransfer[]>([])
  const [orgTransfers, setOrgTransfers] = useState<StockTransfer[]>([])
  const [transfersLoading, setTransfersLoading] = useState(true)
  const [transfersError, setTransfersError] = useState<string | null>(null)
  const [showRequestTransfer, setShowRequestTransfer] = useState(false)

  const [legalName, setLegalName] = useState("")
  const [tradeName, setTradeName] = useState("")
  const [tin, setTin] = useState("")
  const [savingSettings, setSavingSettings] = useState(false)
  const [settingsError, setSettingsError] = useState<string | null>(null)

  const [successMsg, setSuccessMsg] = useState<string | null>(null)
  const [successSeq, setSuccessSeq] = useState(0)
  function announce(message: string) { setSuccessMsg(message); setSuccessSeq(s => s + 1) }

  const organizationId = organization?.organizationId ?? null
  const isOrgOwner = organization?.myRole === "org_owner"
  const isOrgManagerCaller = organization?.myRole === "org_manager"

  useEffect(() => {
    if (organization) { setLegalName(organization.legalName); setTradeName(organization.tradeName ?? ""); setTin(organization.tin ?? "") }
  }, [organization])

  const refreshBranches = useCallback(async () => {
    if (!organizationId) return
    setBranchesLoading(true)
    setBranchesError(null)
    try {
      setBranches(await listOrganizationBranches(organizationId))
    } catch (reason) {
      setBranchesError(errorMessage(reason, t("organization.branchesLoadError")))
    } finally {
      setBranchesLoading(false)
    }
  }, [organizationId, t])

  const refreshMembers = useCallback(async () => {
    if (!organizationId) return
    setMembersLoading(true)
    setMembersError(null)
    try {
      setMembers(await listOrganizationPeople(organizationId))
    } catch (reason) {
      setMembersError(errorMessage(reason, t("organization.membersLoadError")))
    } finally {
      setMembersLoading(false)
    }
  }, [organizationId, t])

  const refreshLog = useCallback(async () => {
    if (!organizationId) return
    setLogLoading(true)
    setLogError(null)
    try {
      setLog(await listRoleChangeLog(organizationId))
    } catch (reason) {
      setLogError(errorMessage(reason, t("organization.auditLoadError")))
    } finally {
      setLogLoading(false)
    }
  }, [organizationId, t])

  const refreshSummary = useCallback(async () => {
    if (!organizationId) return
    setSummaryLoading(true)
    setSummaryError(null)
    try {
      setSummary(await orgBranchSummary(organizationId))
    } catch (reason) {
      setSummaryError(errorMessage(reason, t("organization.dashboardLoadError")))
    } finally {
      setSummaryLoading(false)
    }
  }, [organizationId, t])

  // One loadOrgOverview() call per branch (each already scoped to a single
  // branch, the exact same call "View Branch" drill-in uses), merged into
  // one combined-by-date series -- see the branchTrend state comment above
  // for why a single combined-branches call can't produce this by itself.
  const refreshBranchTrend = useCallback(async () => {
    if (!organizationId || branches.length === 0) { setBranchTrendLoading(false); return }
    setBranchTrendLoading(true)
    setBranchTrendError(null)
    try {
      const perBranch = await Promise.all(
        branches.map(async b => ({ branch: b, data: await loadOrgOverview(period, organizationId, [b.branchId]) })),
      )
      const byLabel = new Map<string, Record<string, string | number>>()
      for (const { branch, data } of perBranch) {
        for (const point of data.revenueTrend) {
          const row = byLabel.get(point.label) ?? { label: point.label }
          row[branch.branchId] = point.revenue
          byLabel.set(point.label, row)
        }
      }
      setBranchTrend(Array.from(byLabel.values()))
    } catch (reason) {
      setBranchTrendError(errorMessage(reason, t("organization.dashboardLoadError")))
    } finally {
      setBranchTrendLoading(false)
    }
  }, [organizationId, branches, period, t])

  const refreshTransfers = useCallback(async () => {
    if (!organizationId) return
    setTransfersLoading(true)
    setTransfersError(null)
    try {
      const [mine, all] = await Promise.all([listBranchStockTransfers(), listOrganizationStockTransfers(organizationId)])
      setMyTransfers(mine)
      setOrgTransfers(all)
    } catch (reason) {
      setTransfersError(errorMessage(reason, t("organization.transferLoadError")))
    } finally {
      setTransfersLoading(false)
    }
  }, [organizationId, t])

  useEffect(() => { void refreshBranches() }, [refreshBranches])
  useEffect(() => { void refreshMembers() }, [refreshMembers])
  useEffect(() => { void refreshLog() }, [refreshLog])
  useEffect(() => { void refreshSummary() }, [refreshSummary])
  useEffect(() => { void refreshBranchTrend() }, [refreshBranchTrend])
  useEffect(() => { void refreshTransfers() }, [refreshTransfers])

  // Every branch starts visible on the trend chart -- click a chip to hide
  // one, same toggle-to-compare interaction as the org-portal spec's
  // reference design. Re-defaults whenever the branch roster itself changes
  // (a branch added/removed), not on every trend refresh.
  useEffect(() => {
    setActiveTrendBranches(new Set(branches.map(b => b.branchId)))
  }, [branches])

  async function handleRemoveMember(member: OrganizationPerson) {
    if (!organizationId) return
    try {
      await removeOrganizationMember(organizationId, member.userId)
      void refreshMembers()
      void refreshLog()
    } catch (reason) {
      setMembersError(errorMessage(reason, t("organization.removeMemberError")))
    }
  }

  // Offboarding: deactivate immediately blocks sign-in everywhere (branch AND
  // org level); the same button reactivates once toggled off. The RPC itself
  // enforces who may act on whom (deactivating an org_manager is owner-only;
  // an org_owner row can never be targeted) -- errors surface here rather
  // than being pre-computed client-side, keeping this simple.
  async function handleToggleActive(member: OrganizationPerson) {
    if (!organizationId) return
    try {
      await setPersonActive(organizationId, member.userId, !member.isActive)
      void refreshMembers()
    } catch (reason) {
      setMembersError(errorMessage(reason, t("organization.togglePersonActiveError")))
    }
  }

  async function handleTransferAction(action: "approve" | "reject" | "dispatch" | "receive" | "cancel", transfer: StockTransfer) {
    try {
      if (action === "approve") await approveStockTransfer(transfer.id)
      else if (action === "reject") await rejectStockTransfer(transfer.id)
      else if (action === "dispatch") await dispatchStockTransfer(transfer.id)
      else if (action === "receive") await receiveStockTransfer(transfer.id)
      else await cancelStockTransfer(transfer.id)
      void refreshTransfers()
    } catch (reason) {
      setTransfersError(errorMessage(reason, t("organization.transferActionError")))
    }
  }

  async function handleSaveSettings() {
    if (!organizationId) return
    if (!legalName.trim()) { setSettingsError(t("organization.legalNameRequired")); return }
    setSavingSettings(true)
    setSettingsError(null)
    try {
      await updateOrganizationDetails(organizationId, legalName.trim(), tradeName.trim() || undefined, tin.trim() || undefined)
      announce(t("organization.settingsSaved"))
      onOrganizationChanged()
    } catch (reason) {
      setSettingsError(errorMessage(reason, t("organization.settingsSaveError")))
    } finally {
      setSavingSettings(false)
    }
  }

  if (!organization) {
    // Only a branch owner ever reaches this page with no organization yet --
    // App.tsx's nav gating keeps a manager with no org role from landing here.
    return (
      <div className="animate-fade-in" style={{ display: "flex", flexDirection: "column", gap: 16 }}>
        <SectionHeader title={t("page.organization")} subtitle={t("organization.subtitle")} />
        <CreateOrganizationCard onCreated={onOrganizationChanged} />
      </div>
    )
  }

  // Transfer destinations are every OTHER branch in the org -- a transfer
  // always moves stock away from the caller's own branch.
  const destinationBranches = branches.filter(b => b.branchId !== currentBranchId)

  return (
    <div className="animate-fade-in" style={{ display: "flex", flexDirection: "column", gap: 16 }}>
      {successMsg && <CenterAlert key={successSeq} message={successMsg} tone="success" />}
      {/* The Dashboard tab renders the same rich Overview dashboard used by
          the plain sidebar Overview page (org-wide by default, with its own
          toolbar) -- this generic header would just sit above it redundantly,
          so it's skipped only for that one tab. Every other tab keeps it. */}
      {activeTab !== "dashboard" && <SectionHeader title={t("page.organization")} subtitle={t("organization.subtitle")} />}
      {isOrgOwner && <TwoFactorNudge />}

      {/* App.tsx's own sidebar IS the org-tab switcher while this page is
          active (Dashboard/Stock Transfers/Branches/Members/Settings) --
          see `activeTab` prop -- so there's no second, nested tab list here
          any more; this is just the selected tab's content. */}
      <div style={{ display: "flex", flexDirection: "column", gap: 16 }}>
          {activeTab === "dashboard" && (
            <>
              {/* org_manager only: approving transfers is core to that role
                  (the org spec's own wording) but they can't restructure the
                  company, so their dashboard promotes what needs THEIR
                  action above the company-wide leaderboard -- an org_owner's
                  dashboard leads with the leaderboard instead (see below),
                  reading as a company-wide command center rather than a
                  to-do list. This is the visual difference between the two
                  roles' otherwise-identical dashboard tab. */}
              {isOrgManagerCaller && !transfersLoading && orgTransfers.some(tr => tr.status === "pending") && (
                <Card style={DASHBOARD_CARD_STYLE}>
                  <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", gap: 12, flexWrap: "wrap" }}>
                    <div style={{ display: "flex", alignItems: "center", gap: 14 }}>
                      <div style={{ width: 40, height: 40, borderRadius: 10, background: "#fef3c7", display: "flex", alignItems: "center", justifyContent: "center", fontSize: 18, flexShrink: 0 }}>⏳</div>
                      <div>
                        <div style={{ fontWeight: 700, fontSize: 14, color: "var(--ink)" }}>
                          {t("organization.pendingApprovalsCount", { count: orgTransfers.filter(tr => tr.status === "pending").length })}
                        </div>
                        <div style={{ fontSize: 12, color: "var(--ink-muted)" }}>{t("organization.pendingApprovalsSubtitle")}</div>
                      </div>
                    </div>
                    <Btn variant="primary" small onClick={onGoToTransfers}>{t("organization.pendingApprovalsAction")}</Btn>
                  </div>
                </Card>
              )}

              {/* The org-wide dashboard -- same component, same data source
                  as the plain sidebar Overview page, just always given
                  `organization`+`branches` here so it defaults to "All
                  branches" combined with a picker to narrow to one. Visiting
                  one specific branch's full operational suite (not just this
                  dashboard) is the separate "View Branch" action below. */}
              <OverviewPage
                period={period}
                branchName={organization.legalName}
                alerts={alerts}
                onViewAlerts={onViewAlerts}
                organization={organization}
                branches={branches}
              />

              {/* Combined revenue trend across every branch, one line each,
                  toggleable -- the per-org-spec chart OverviewPage's own
                  single aggregate line can't show (see branchTrend state
                  comment above for why this needs its own per-branch calls).
                  Only worth showing once there's more than one branch to
                  actually compare. */}
              {branches.length > 1 && (
                <Card style={DASHBOARD_CARD_STYLE}>
                  <CardHeader icon="📈" title={t("organization.trendChartTitle")} subtitle={t("organization.trendChartSubtitle")} />
                  <div style={{ display: "flex", gap: 8, flexWrap: "wrap", margin: "12px 0" }}>
                    {branches.map((b, i) => {
                      const active = activeTrendBranches.has(b.branchId)
                      return (
                        <button
                          key={b.branchId}
                          onClick={() => setActiveTrendBranches(prev => {
                            const next = new Set(prev)
                            if (next.has(b.branchId)) { if (next.size > 1) next.delete(b.branchId) }
                            else next.add(b.branchId)
                            return next
                          })}
                          style={{
                            display: "flex", alignItems: "center", gap: 6, padding: "5px 10px", borderRadius: 999,
                            border: "1px solid var(--border)", background: active ? "var(--bg)" : "transparent",
                            opacity: active ? 1 : 0.4, cursor: "pointer", fontSize: 12, fontFamily: "inherit", color: "var(--ink)",
                          }}
                        >
                          <span style={{ width: 8, height: 8, borderRadius: "50%", background: branchDotColor(i), flexShrink: 0 }} />
                          {b.name}
                        </button>
                      )
                    })}
                  </div>
                  {branchTrendError && <p style={{ fontSize: 12, color: "#b91c1c" }}>{branchTrendError}</p>}
                  {branchTrendLoading ? <p style={{ fontSize: 12, color: "var(--ink-muted)" }}>{t("organization.loading")}</p> : (
                    <ResponsiveContainer width="100%" height={230}>
                      <AreaChart data={branchTrend} margin={{ top: 4, right: 8, bottom: 0, left: 0 }}>
                        <defs>
                          {branches.map((b, i) => (
                            <linearGradient key={b.branchId} id={`gBranch-${b.branchId}`} x1="0" y1="0" x2="0" y2="1">
                              <stop offset="5%" stopColor={branchDotColor(i)} stopOpacity={0.18} />
                              <stop offset="95%" stopColor={branchDotColor(i)} stopOpacity={0} />
                            </linearGradient>
                          ))}
                        </defs>
                        <CartesianGrid stroke="var(--border)" strokeDasharray="4 4" />
                        <XAxis dataKey="label" tick={{ fontSize: 11, fill: "var(--ink-muted)" }} axisLine={false} tickLine={false} minTickGap={16} />
                        <YAxis tick={{ fontSize: 11, fill: "var(--ink-muted)" }} axisLine={false} tickLine={false} tickFormatter={v => Math.round(Number(v)).toLocaleString()} />
                        <Tooltip content={<ChartTooltip />} />
                        <Legend iconType="circle" iconSize={8} wrapperStyle={{ fontSize: 11, color: "var(--ink-mid)" }} />
                        {branches.map((b, i) => activeTrendBranches.has(b.branchId) && (
                          <Area key={b.branchId} type="monotone" dataKey={b.branchId} name={b.name} stroke={branchDotColor(i)} fill={`url(#gBranch-${b.branchId})`} strokeWidth={2} dot={false} activeDot={{ r: 4 }} />
                        ))}
                      </AreaChart>
                    </ResponsiveContainer>
                  )}
                </Card>
              )}

              {/* Revenue and stock-health bars, one per branch -- the same
                  `summary` rows the leaderboard table below reads, just
                  charted instead of tabulated. */}
              {!summaryLoading && summary.length > 0 && (
                <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 16 }}>
                  <Card style={DASHBOARD_CARD_STYLE}>
                    <CardHeader icon="💰" title={t("organization.revenueByBranchTitle")} subtitle={t("organization.revenueByBranchSubtitle")} />
                    <ResponsiveContainer width="100%" height={200}>
                      <BarChart data={summary} margin={{ top: 8, right: 8, bottom: 0, left: 0 }}>
                        <CartesianGrid stroke="var(--border)" strokeDasharray="4 4" vertical={false} />
                        <XAxis dataKey="branchName" tick={{ fontSize: 11, fill: "var(--ink-muted)" }} axisLine={false} tickLine={false} />
                        <YAxis tick={{ fontSize: 11, fill: "var(--ink-muted)" }} axisLine={false} tickLine={false} tickFormatter={v => Math.round(Number(v)).toLocaleString()} />
                        <Tooltip content={<ChartTooltip />} />
                        <Legend iconType="circle" iconSize={8} wrapperStyle={{ fontSize: 11, color: "var(--ink-mid)" }} />
                        <Bar dataKey="todayRevenue" name={t("organization.dashboardColTodayRevenue")} fill="#4318ff" radius={[4, 4, 0, 0]} barSize={18} />
                        <Bar dataKey="monthToDateRevenue" name={t("organization.dashboardColMtdRevenue")} fill="#a78bfa" radius={[4, 4, 0, 0]} barSize={18} />
                      </BarChart>
                    </ResponsiveContainer>
                  </Card>
                  <Card style={DASHBOARD_CARD_STYLE}>
                    <CardHeader icon="⚠️" title={t("organization.stockHealthByBranchTitle")} subtitle={t("organization.stockHealthByBranchSubtitle")} />
                    <ResponsiveContainer width="100%" height={200}>
                      <BarChart data={summary.map(s => ({ ...s, stockAlerts: s.outOfStockCount + s.lowStockCount }))} margin={{ top: 8, right: 8, bottom: 0, left: 0 }}>
                        <CartesianGrid stroke="var(--border)" strokeDasharray="4 4" vertical={false} />
                        <XAxis dataKey="branchName" tick={{ fontSize: 11, fill: "var(--ink-muted)" }} axisLine={false} tickLine={false} />
                        <YAxis tick={{ fontSize: 11, fill: "var(--ink-muted)" }} axisLine={false} tickLine={false} allowDecimals={false} />
                        <Tooltip content={<ChartTooltip />} />
                        <Legend iconType="circle" iconSize={8} wrapperStyle={{ fontSize: 11, color: "var(--ink-mid)" }} />
                        <Bar dataKey="stockAlerts" name={t("organization.dashboardColStockAlerts")} fill="#f59e0b" radius={[4, 4, 0, 0]} barSize={18} />
                        <Bar dataKey="pendingTransfersIn" name={t("organization.dashboardColPendingIn")} fill="#0891b2" radius={[4, 4, 0, 0]} barSize={18} />
                      </BarChart>
                    </ResponsiveContainer>
                  </Card>
                </div>
              )}

              {/* Branch Performance leaderboard -- click-through comparison
                  across the whole organization, sortable, with a color dot
                  per branch and a derived Healthy/Needs Attention badge
                  (alerts or pending inbound transfers). This is what makes
                  the org-level dashboards visually distinct from a single
                  branch's own Overview, which has no cross-branch table. */}
              <Card style={DASHBOARD_CARD_STYLE}>
                <CardHeader icon="📊" title={t("organization.dashboardBranchesTitle")} subtitle={t("organization.dashboardBranchesSubtitle")} />
                {summaryError && <p style={{ fontSize: 12, color: "#b91c1c", margin: "12px 0" }}>{summaryError}</p>}
                {summaryLoading ? <p style={{ fontSize: 12, color: "var(--ink-muted)", marginTop: 12 }}>{t("organization.loading")}</p> : (
                  <div style={{ overflowX: "auto", marginTop: 12 }}>
                    <table style={{ width: "100%", borderCollapse: "collapse", fontSize: 12 }}>
                      <thead>
                        <tr style={{ textAlign: "left", color: "var(--ink-muted)", borderBottom: "1px solid var(--border)" }}>
                          <th style={{ padding: "8px 10px", fontWeight: 600 }}>{t("organization.dashboardColBranch" as TranslationKey)}</th>
                          {([
                            ["todayRevenue", "dashboardColTodayRevenue"],
                            ["monthToDateRevenue", "dashboardColMtdRevenue"],
                            ["alerts", "dashboardColStockAlerts"],
                          ] as const).map(([key, labelKey]) => (
                            <th
                              key={key}
                              onClick={() => {
                                if (leaderboardSortKey === key) setLeaderboardSortAsc(a => !a)
                                else { setLeaderboardSortKey(key); setLeaderboardSortAsc(false) }
                              }}
                              style={{ padding: "8px 10px", fontWeight: 600, textAlign: "right", cursor: "pointer", userSelect: "none", color: leaderboardSortKey === key ? "var(--primary)" : "var(--ink-muted)" }}
                            >
                              {t(labelKey as TranslationKey)}{leaderboardSortKey === key ? (leaderboardSortAsc ? " ↑" : " ↓") : ""}
                            </th>
                          ))}
                          <th style={{ padding: "8px 10px", fontWeight: 600, textAlign: "right" }}>{t("organization.dashboardColPendingIn" as TranslationKey)}</th>
                          <th style={{ padding: "8px 10px", fontWeight: 600, textAlign: "right" }}>{t("organization.dashboardColStatus" as TranslationKey)}</th>
                        </tr>
                      </thead>
                      <tbody>
                        {[...summary]
                          .sort((a, b) => {
                            const val = (row: OrgBranchSummary) => leaderboardSortKey === "alerts"
                              ? row.outOfStockCount + row.lowStockCount
                              : row[leaderboardSortKey]
                            return leaderboardSortAsc ? val(a) - val(b) : val(b) - val(a)
                          })
                          .map(row => {
                            const branchIndex = branches.findIndex(b => b.branchId === row.branchId)
                            const branch = branches[branchIndex]
                            const alertCount = row.outOfStockCount + row.lowStockCount
                            const needsAttention = alertCount > 0 || row.pendingTransfersIn > 0
                            const attentionColors = needsAttention ? BRANCH_STATUS_COLORS.locked : BRANCH_STATUS_COLORS.active
                            return (
                              <tr
                                key={row.branchId}
                                onClick={() => branch && onViewBranch({ branchId: branch.branchId, branchName: branch.name, branchCode: branch.branchCode })}
                                style={{ borderBottom: "1px solid var(--bg-alt)", cursor: branch ? "pointer" : "default" }}
                              >
                                <td style={{ padding: "8px 10px", fontWeight: 600, color: "var(--ink)" }}>
                                  <span style={{ display: "inline-flex", alignItems: "center", gap: 8 }}>
                                    <span style={{ width: 8, height: 8, borderRadius: "50%", background: branchDotColor(branchIndex < 0 ? 0 : branchIndex), flexShrink: 0 }} />
                                    {row.branchName}
                                  </span>
                                </td>
                                <td style={{ padding: "8px 10px", textAlign: "right", fontFamily: "var(--font-mono)" }}>{row.todayRevenue.toLocaleString()}</td>
                                <td style={{ padding: "8px 10px", textAlign: "right", fontFamily: "var(--font-mono)" }}>{row.monthToDateRevenue.toLocaleString()}</td>
                                <td style={{ padding: "8px 10px", textAlign: "right", fontFamily: "var(--font-mono)", color: alertCount > 0 ? "var(--warning)" : "var(--ink-muted)" }}>{alertCount}</td>
                                <td style={{ padding: "8px 10px", textAlign: "right", fontFamily: "var(--font-mono)" }}>{row.pendingTransfersIn}</td>
                                <td style={{ padding: "8px 10px", textAlign: "right" }}>
                                  <StatusBadge label={t(needsAttention ? "organization.branchStatusAttention" : "organization.branchStatusHealthy")} color={attentionColors.c} bg={attentionColors.bg} />
                                </td>
                              </tr>
                            )
                          })}
                      </tbody>
                    </table>
                    {summary.length === 0 && <p style={{ padding: 28, textAlign: "center", color: "var(--ink-muted)", fontSize: 12 }}>{t("organization.branchesEmpty")}</p>}
                  </div>
                )}
              </Card>
            </>
          )}

          {activeTab === "transfers" && (
            <>
              <Card>
                <div style={{ display: "flex", justifyContent: "space-between", alignItems: "flex-start", marginBottom: 16, gap: 12, flexWrap: "wrap" }}>
                  <CardHeader icon="🔁" title={t("organization.transfersMineTitle")} subtitle={t("organization.transfersSubtitle")} />
                  <Btn variant="primary" small onClick={() => setShowRequestTransfer(true)}>+ {t("organization.requestTransfer")}</Btn>
                </div>
                {transfersError && <p style={{ fontSize: 12, color: "#b91c1c", marginBottom: 12 }}>{transfersError}</p>}
                {transfersLoading ? <p style={{ fontSize: 12, color: "var(--ink-muted)" }}>{t("organization.loading")}</p> : myTransfers.map(tr => (
                  <TransferRow key={tr.id} transfer={tr} currentBranchId={currentBranchId} onAction={handleTransferAction} />
                ))}
                {!transfersLoading && myTransfers.length === 0 && <p style={{ padding: 28, textAlign: "center", color: "var(--ink-muted)", fontSize: 12 }}>{t("organization.transfersEmpty")}</p>}
              </Card>

              <Card>
                <CardHeader icon="🏢" title={t("organization.transfersOrgTitle")} subtitle={t("organization.transfersOrgSubtitle")} />
                {!transfersLoading && orgTransfers.map(tr => (
                  <TransferRow key={tr.id} transfer={tr} currentBranchId={currentBranchId} onAction={handleTransferAction} />
                ))}
                {!transfersLoading && orgTransfers.length === 0 && <p style={{ padding: 28, textAlign: "center", color: "var(--ink-muted)", fontSize: 12 }}>{t("organization.transfersEmpty")}</p>}
              </Card>
            </>
          )}

          {activeTab === "branches" && (
            <div style={{ display: "flex", flexDirection: "column", gap: 16 }}>
              <div style={{ display: "flex", justifyContent: "space-between", alignItems: "flex-start", gap: 12, flexWrap: "wrap" }}>
                <div>
                  <h2 style={{ margin: 0, fontSize: 15, fontWeight: 700, color: "var(--ink)" }}>{t("organization.branchesTitle")}</h2>
                  <p style={{ margin: "2px 0 0", color: "var(--ink-muted)", fontSize: 12 }}>{t("organization.branchesSubtitle", { count: branches.length })}</p>
                </div>
                {isOrgOwner && <Btn variant="primary" small onClick={() => setShowAddBranch(true)}>+ {t("organization.addBranch")}</Btn>}
              </div>
              {branchesError && <p style={{ fontSize: 12, color: "#b91c1c" }}>{branchesError}</p>}
              {branchesLoading ? <p style={{ fontSize: 12, color: "var(--ink-muted)" }}>{t("organization.loading")}</p> : (
                <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(320px, 1fr))", gap: 16 }}>
                  {branches.map((b, i) => {
                    const colors = BRANCH_STATUS_COLORS[b.status] ?? BRANCH_STATUS_COLORS.active
                    const row = summary.find(s => s.branchId === b.branchId)
                    const alertCount = row ? row.outOfStockCount + row.lowStockCount : null
                    const manager = members.find(m => m.scope === "branch" && m.branchId === b.branchId && (m.role === "owner" || m.role === "manager"))
                    return (
                      <Card key={b.branchId}>
                        <div style={{ display: "flex", justifyContent: "space-between", alignItems: "flex-start", gap: 12, marginBottom: 14 }}>
                          <div style={{ display: "flex", alignItems: "center", gap: 8, minWidth: 0 }}>
                            <span style={{ width: 8, height: 8, borderRadius: "50%", background: branchDotColor(i), flexShrink: 0 }} />
                            <div style={{ minWidth: 0 }}>
                              <div style={{ fontWeight: 700, fontSize: 14, color: "var(--ink)", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{b.name}</div>
                              <div style={{ fontSize: 12, color: "var(--ink-muted)" }}>{b.branchCode ?? b.address ?? "—"}</div>
                            </div>
                          </div>
                          <StatusBadge label={b.status} color={colors.c} bg={colors.bg} />
                        </div>

                        <div style={{ display: "grid", gridTemplateColumns: "repeat(3, 1fr)", gap: 8, marginBottom: 14 }}>
                          <div style={{ textAlign: "center", padding: "8px 6px", borderRadius: 8, background: "var(--bg)", border: "1px solid var(--border)" }}>
                            <div style={{ fontFamily: "var(--font-mono)", fontWeight: 700, fontSize: 13, color: "var(--ink)" }}>{row ? row.todayRevenue.toLocaleString() : "—"}</div>
                            <div style={{ fontSize: 10, color: "var(--ink-muted)", marginTop: 2 }}>{t("organization.branchCardToday")}</div>
                          </div>
                          <div style={{ textAlign: "center", padding: "8px 6px", borderRadius: 8, background: "var(--bg)", border: "1px solid var(--border)" }}>
                            <div style={{ fontFamily: "var(--font-mono)", fontWeight: 700, fontSize: 13, color: "var(--ink)" }}>{b.staffCount}</div>
                            <div style={{ fontSize: 10, color: "var(--ink-muted)", marginTop: 2 }}>{t("organization.branchCardStaff")}</div>
                          </div>
                          <div style={{ textAlign: "center", padding: "8px 6px", borderRadius: 8, background: "var(--bg)", border: "1px solid var(--border)" }}>
                            <div style={{ fontFamily: "var(--font-mono)", fontWeight: 700, fontSize: 13, color: alertCount ? "var(--warning)" : "var(--ink)" }}>{alertCount ?? "—"}</div>
                            <div style={{ fontSize: 10, color: "var(--ink-muted)", marginTop: 2 }}>{t("organization.branchCardAlerts")}</div>
                          </div>
                        </div>

                        <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", gap: 8, paddingTop: 12, borderTop: "1px solid var(--bg-alt)" }}>
                          <div style={{ fontSize: 12, color: "var(--ink-muted)", minWidth: 0, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
                            {manager ? manager.fullName : (b.staffCount > 0 ? t("organization.staffCountLabel", { count: b.staffCount }) : t("organization.noStaffYet"))}
                          </div>
                          <div style={{ display: "flex", gap: 8, flexShrink: 0 }}>
                            {(isOrgOwner || isOrgManagerCaller) && <Btn variant="primary" small onClick={() => onViewBranch({ branchId: b.branchId, branchName: b.name, branchCode: b.branchCode })}>{t("organization.viewBranch")}</Btn>}
                            {isOrgOwner && <Btn variant="secondary" small onClick={() => setStaffingBranch({ id: b.branchId, name: b.name, alreadyStaffed: b.staffCount > 0 })}>{t("organization.staffBranch")}</Btn>}
                          </div>
                        </div>
                      </Card>
                    )
                  })}
                </div>
              )}
              {!branchesLoading && branches.length === 0 && (
                <Card><p style={{ padding: 28, textAlign: "center", color: "var(--ink-muted)", fontSize: 12, margin: 0 }}>{t("organization.branchesEmpty")}</p></Card>
              )}
            </div>
          )}

          {activeTab === "members" && (
            <Card>
              <div style={{ display: "flex", justifyContent: "space-between", alignItems: "flex-start", marginBottom: 16, gap: 12, flexWrap: "wrap" }}>
                <CardHeader icon="👥" title={t("organization.membersTitle")} subtitle={t("organization.membersSubtitle", { count: members.length })} />
                {(isOrgOwner || isOrgManagerCaller) && <Btn variant="primary" small onClick={() => setShowInviteMember(true)}>+ {t("organization.inviteMember")}</Btn>}
              </div>
              {membersError && <p style={{ fontSize: 12, color: "#b91c1c", marginBottom: 12 }}>{membersError}</p>}
              {membersLoading ? <p style={{ fontSize: 12, color: "var(--ink-muted)" }}>{t("organization.loading")}</p> : members.map((m, i) => {
                const isSelf = m.userId === currentUserId
                const isTargetOwner = m.scope === "organization" && m.role === "org_owner"
                const isTargetOrgManager = m.scope === "organization" && m.role === "org_manager"
                // Matches org_set_user_active()'s own authorization exactly,
                // so a button never appears somewhere the click would just
                // error: deactivating an org_manager is owner-only;
                // branch_manager/sales_person can be toggled by either
                // org_owner or org_manager; org_owner can never be targeted.
                const canDeactivate = !isSelf && !isTargetOwner && (isOrgOwner || !isTargetOrgManager)
                const canManageOrgLevel = isOrgOwner && m.scope === "organization" && !isSelf && !isTargetOwner
                return (
                  <div key={m.userId} style={{ display: "flex", justifyContent: "space-between", alignItems: "center", padding: "12px 0", borderBottom: i === members.length - 1 ? "none" : "1px solid var(--bg-alt)", gap: 12, flexWrap: "wrap" }}>
                    <div>
                      <div style={{ fontWeight: 700, fontSize: 13, color: "var(--ink)" }}>
                        {m.fullName}{isSelf ? ` (${t("organization.you")})` : ""}
                        {!m.isActive && <span style={{ marginLeft: 8, fontSize: 11, color: "#dc2626", fontWeight: 600 }}>{t("organization.inactiveLabel")}</span>}
                      </div>
                      <div style={{ fontSize: 12, color: "var(--ink-muted)" }}>{m.email}{m.branchName ? ` · ${m.branchName}` : ""}</div>
                    </div>
                    <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
                      <PersonRoleBadge scope={m.scope} role={m.role} />
                      {canDeactivate && (
                        <Btn variant={m.isActive ? "danger" : "secondary"} small onClick={() => void handleToggleActive(m)}>
                          {m.isActive ? t("organization.deactivate") : t("organization.reactivate")}
                        </Btn>
                      )}
                      {canManageOrgLevel && <Btn variant="danger" small onClick={() => void handleRemoveMember(m)}>{t("organization.remove")}</Btn>}
                    </div>
                  </div>
                )
              })}
              {!membersLoading && members.length === 0 && <p style={{ padding: 28, textAlign: "center", color: "var(--ink-muted)", fontSize: 12 }}>{t("organization.membersEmpty")}</p>}
            </Card>
          )}

          {activeTab === "settings" && (
            <>
              <Card>
                <CardHeader icon="🏢" title={organization.legalName} subtitle={organization.tradeName ?? undefined} />
                <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(160px, 1fr))", gap: 16, marginTop: 12 }}>
                  <div>
                    <div style={{ fontSize: 10, color: "var(--ink-muted)", textTransform: "uppercase", letterSpacing: "0.05em" }}>{t("organization.tinLabel")}</div>
                    <div style={{ fontSize: 14, fontWeight: 600, color: "var(--ink)", marginTop: 4 }}>{organization.tin ?? "—"}</div>
                  </div>
                  <div>
                    <div style={{ fontSize: 10, color: "var(--ink-muted)", textTransform: "uppercase", letterSpacing: "0.05em" }}>{t("organization.statusLabel")}</div>
                    <div style={{ marginTop: 4 }}><StatusBadge label={organization.status} color={organization.status === "active" ? "#16a34a" : "#dc2626"} bg={organization.status === "active" ? "#d1fae5" : "#fef2f2"} /></div>
                  </div>
                  <div>
                    <div style={{ fontSize: 10, color: "var(--ink-muted)", textTransform: "uppercase", letterSpacing: "0.05em" }}>{t("organization.branchCountLabel")}</div>
                    <div style={{ fontSize: 14, fontWeight: 600, color: "var(--ink)", marginTop: 4 }}>{organization.branchCount}</div>
                  </div>
                  <div>
                    <div style={{ fontSize: 10, color: "var(--ink-muted)", textTransform: "uppercase", letterSpacing: "0.05em" }}>{t("organization.yourRoleLabel")}</div>
                    <div style={{ marginTop: 4 }}><OrgRoleBadge role={organization.myRole} /></div>
                  </div>
                </div>
              </Card>

              <Card>
                <CardHeader icon="⚙️" title={t("organization.settingsTitle")} subtitle={t("organization.settingsSubtitle")} />
                {settingsError && <p style={{ fontSize: 12, color: "#b91c1c", margin: "12px 0" }}>{settingsError}</p>}
                <div style={{ display: "flex", flexDirection: "column", gap: 12, maxWidth: 420, marginTop: 12 }}>
                  <div>
                    <label style={labelStyle}>{t("organization.legalNameLabel")}</label>
                    <input value={legalName} onChange={e => setLegalName(e.target.value)} disabled={!isOrgOwner} style={inputStyle} />
                  </div>
                  <div>
                    <label style={labelStyle}>{t("organization.tradeNameLabel")}</label>
                    <input value={tradeName} onChange={e => setTradeName(e.target.value)} disabled={!isOrgOwner} style={inputStyle} />
                  </div>
                  <div>
                    <label style={labelStyle}>{t("organization.tinLabel")}</label>
                    <input value={tin} onChange={e => setTin(e.target.value)} disabled={!isOrgOwner} style={inputStyle} />
                  </div>
                  {isOrgOwner && (
                    <div>
                      <Btn variant="primary" onClick={() => void handleSaveSettings()}>{savingSettings ? t("organization.savingSettings") : t("organization.saveSettings")}</Btn>
                    </div>
                  )}
                </div>
              </Card>

              <Card>
                <CardHeader icon="📜" title={t("organization.auditTitle")} subtitle={t("organization.auditSubtitle")} />
                {logError && <p style={{ fontSize: 12, color: "#b91c1c", margin: "12px 0" }}>{logError}</p>}
                {logLoading ? <p style={{ fontSize: 12, color: "var(--ink-muted)" }}>{t("organization.loading")}</p> : (
                  <div style={{ overflowX: "auto" }}>
                    <table style={{ width: "100%", borderCollapse: "collapse", fontSize: 12 }}>
                      <thead>
                        <tr style={{ textAlign: "left", color: "var(--ink-muted)", borderBottom: "1px solid var(--border)" }}>
                          {["auditWhen", "auditActor", "auditTarget", "auditChange", "auditAction"].map(k => (
                            <th key={k} style={{ padding: "8px 10px", fontWeight: 600 }}>{t(`organization.${k}` as TranslationKey)}</th>
                          ))}
                        </tr>
                      </thead>
                      <tbody>
                        {log.map(entry => (
                          <tr key={entry.id} style={{ borderBottom: "1px solid var(--bg-alt)" }}>
                            <td style={{ padding: "8px 10px", color: "var(--ink-muted)", whiteSpace: "nowrap" }}>{new Date(entry.createdAt).toLocaleString()}</td>
                            <td style={{ padding: "8px 10px" }}>{entry.actorEmail ?? "—"}</td>
                            <td style={{ padding: "8px 10px" }}>{entry.targetEmail ?? "—"}</td>
                            <td style={{ padding: "8px 10px" }}>{entry.oldRole ?? "—"} → {entry.newRole ?? "—"}</td>
                            <td style={{ padding: "8px 10px" }}>{entry.action}</td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                    {log.length === 0 && <p style={{ padding: 28, textAlign: "center", color: "var(--ink-muted)", fontSize: 12 }}>{t("organization.auditEmpty")}</p>}
                  </div>
                )}
              </Card>
            </>
          )}
      </div>

      {showAddBranch && (
        <AddBranchModal
          organizationId={organization.organizationId}
          onClose={() => setShowAddBranch(false)}
          onCreated={(branchId, pharmacyName) => {
            setShowAddBranch(false)
            void refreshBranches()
            onOrganizationChanged()
            setStaffingBranch({ id: branchId, name: pharmacyName, alreadyStaffed: false })
          }}
        />
      )}

      {staffingBranch && (
        <StaffBranchModal
          branchId={staffingBranch.id}
          branchName={staffingBranch.name}
          alreadyStaffed={staffingBranch.alreadyStaffed}
          onClose={() => setStaffingBranch(null)}
          onStaffed={() => { setStaffingBranch(null); announce(t("organization.staffBranchSuccess")); void refreshBranches(); void refreshLog() }}
        />
      )}

      {showInviteMember && (
        <AssignRoleModal
          organizationId={organization.organizationId}
          branches={branches}
          onClose={() => setShowInviteMember(false)}
          onDone={result => {
            setShowInviteMember(false)
            announce(
              result === "created" ? t("organization.assignCreated")
                : result === "granted" ? t("organization.inviteGranted")
                : t("organization.inviteSentPending"),
            )
            void refreshMembers()
            void refreshBranches()
            void refreshLog()
          }}
        />
      )}

      {showRequestTransfer && (
        <RequestTransferModal
          destinationBranches={destinationBranches}
          onClose={() => setShowRequestTransfer(false)}
          onRequested={() => { setShowRequestTransfer(false); announce(t("organization.transferRequested")); void refreshTransfers() }}
        />
      )}
    </div>
  )
}
