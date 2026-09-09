import { useCallback, useEffect, useMemo, useState } from "react"
import { Btn, Card, CenterAlert, Modal, SectionHeader, StatusBadge } from "../components"
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
import { PasswordInput } from "./AuthShell"

const inputStyle = { width: "100%", padding: "9px 10px", border: "1px solid var(--border)", borderRadius: 7, fontFamily: "inherit", fontSize: 13, boxSizing: "border-box" as const }
const labelStyle = { fontSize: 10, fontWeight: 600, color: "var(--ink-muted)", textTransform: "uppercase" as const, letterSpacing: "0.05em", display: "block", marginBottom: 4 }

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

type OrgTab = "dashboard" | "transfers" | "branches" | "members" | "settings"

const ORG_TABS: { id: OrgTab; icon: string; labelKey: TranslationKey }[] = [
  { id: "dashboard", icon: "📊", labelKey: "organization.tabDashboard" },
  { id: "transfers", icon: "🔁", labelKey: "organization.tabTransfers" },
  { id: "branches", icon: "🏬", labelKey: "organization.tabBranches" },
  { id: "members", icon: "👥", labelKey: "organization.tabMembers" },
  { id: "settings", icon: "⚙️", labelKey: "organization.tabSettings" },
]

export default function OrganizationPage({ currentUserId, currentBranchId, organization, onOrganizationChanged }: {
  currentUserId: string
  currentBranchId: string
  organization: OrganizationSummary | null
  onOrganizationChanged: () => void
}) {
  const { t } = useTranslation()
  const [activeTab, setActiveTab] = useState<OrgTab>("dashboard")

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
  useEffect(() => { void refreshTransfers() }, [refreshTransfers])

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
      <SectionHeader title={t("page.organization")} subtitle={t("organization.subtitle")} />
      {isOrgOwner && <TwoFactorNudge />}

      <div style={{ display: "flex", gap: 20, alignItems: "flex-start", flexWrap: "wrap" }}>
        <div style={{ width: 200, flexShrink: 0, display: "flex", flexDirection: "column", gap: 4 }}>
          {ORG_TABS.map(tab => (
            <button
              key={tab.id}
              onClick={() => setActiveTab(tab.id)}
              style={{
                display: "flex", alignItems: "center", gap: 10, padding: "10px 12px", borderRadius: 10, cursor: "pointer", fontFamily: "inherit",
                border: `1.5px solid ${activeTab === tab.id ? "var(--primary)" : "transparent"}`,
                background: activeTab === tab.id ? "var(--primary-light)" : "transparent",
                color: activeTab === tab.id ? "var(--primary)" : "var(--ink-mid)",
                fontWeight: activeTab === tab.id ? 700 : 500, fontSize: 13, textAlign: "left",
              }}
            >
              <span>{tab.icon}</span>{t(tab.labelKey)}
            </button>
          ))}
        </div>

        <div style={{ flex: "1 1 480px", minWidth: 320, display: "flex", flexDirection: "column", gap: 16 }}>
          {activeTab === "dashboard" && (
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
                <CardHeader icon="📊" title={t("organization.dashboardBranchesTitle")} subtitle={t("organization.dashboardBranchesSubtitle")} />
                {summaryError && <p style={{ fontSize: 12, color: "#b91c1c", margin: "12px 0" }}>{summaryError}</p>}
                {summaryLoading ? <p style={{ fontSize: 12, color: "var(--ink-muted)", marginTop: 12 }}>{t("organization.loading")}</p> : (
                  <div style={{ overflowX: "auto", marginTop: 12 }}>
                    <table style={{ width: "100%", borderCollapse: "collapse", fontSize: 12 }}>
                      <thead>
                        <tr style={{ textAlign: "left", color: "var(--ink-muted)", borderBottom: "1px solid var(--border)" }}>
                          {["dashboardColBranch", "dashboardColTodayRevenue", "dashboardColMtdRevenue", "dashboardColOutOfStock", "dashboardColLowStock", "dashboardColPendingIn"].map(k => (
                            <th key={k} style={{ padding: "8px 10px", fontWeight: 600 }}>{t(`organization.${k}` as TranslationKey)}</th>
                          ))}
                        </tr>
                      </thead>
                      <tbody>
                        {summary.map(row => (
                          <tr key={row.branchId} style={{ borderBottom: "1px solid var(--bg-alt)" }}>
                            <td style={{ padding: "8px 10px", fontWeight: 600, color: "var(--ink)" }}>{row.branchName}</td>
                            <td style={{ padding: "8px 10px" }}>{row.todayRevenue.toLocaleString()}</td>
                            <td style={{ padding: "8px 10px" }}>{row.monthToDateRevenue.toLocaleString()}</td>
                            <td style={{ padding: "8px 10px" }}>{row.outOfStockCount}</td>
                            <td style={{ padding: "8px 10px" }}>{row.lowStockCount}</td>
                            <td style={{ padding: "8px 10px" }}>{row.pendingTransfersIn}</td>
                          </tr>
                        ))}
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
            <Card>
              <div style={{ display: "flex", justifyContent: "space-between", alignItems: "flex-start", marginBottom: 16, gap: 12, flexWrap: "wrap" }}>
                <CardHeader icon="🏬" title={t("organization.branchesTitle")} subtitle={t("organization.branchesSubtitle", { count: branches.length })} />
                {isOrgOwner && <Btn variant="primary" small onClick={() => setShowAddBranch(true)}>+ {t("organization.addBranch")}</Btn>}
              </div>
              {branchesError && <p style={{ fontSize: 12, color: "#b91c1c", marginBottom: 12 }}>{branchesError}</p>}
              {branchesLoading ? <p style={{ fontSize: 12, color: "var(--ink-muted)" }}>{t("organization.loading")}</p> : branches.map((b, i) => {
                const colors = BRANCH_STATUS_COLORS[b.status] ?? BRANCH_STATUS_COLORS.active
                return (
                  <div key={b.branchId} style={{ display: "flex", justifyContent: "space-between", alignItems: "center", padding: "12px 0", borderBottom: i === branches.length - 1 ? "none" : "1px solid var(--bg-alt)", gap: 12, flexWrap: "wrap" }}>
                    <div>
                      <div style={{ fontWeight: 700, fontSize: 13, color: "var(--ink)" }}>{b.name}</div>
                      <div style={{ fontSize: 12, color: "var(--ink-muted)" }}>
                        {b.branchCode ?? b.address ?? "—"}
                        {" · "}
                        {b.staffCount > 0 ? t("organization.staffCountLabel", { count: b.staffCount }) : t("organization.noStaffYet")}
                      </div>
                    </div>
                    <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
                      <StatusBadge label={b.status} color={colors.c} bg={colors.bg} />
                      {isOrgOwner && <Btn variant="secondary" small onClick={() => setStaffingBranch({ id: b.branchId, name: b.name, alreadyStaffed: b.staffCount > 0 })}>{t("organization.staffBranch")}</Btn>}
                    </div>
                  </div>
                )
              })}
              {!branchesLoading && branches.length === 0 && <p style={{ padding: 28, textAlign: "center", color: "var(--ink-muted)", fontSize: 12 }}>{t("organization.branchesEmpty")}</p>}
            </Card>
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
                <CardHeader icon="🏢" title={t("organization.settingsTitle")} subtitle={t("organization.settingsSubtitle")} />
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
