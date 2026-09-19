import { FunctionsHttpError } from "@supabase/supabase-js"
import { supabase } from "./supabase"

export type OrgRole = "org_owner" | "org_manager"

export interface OrganizationSummary {
  organizationId: string
  legalName: string
  tradeName: string | null
  tin: string | null
  status: string
  myRole: OrgRole
  branchCount: number
  // Once an org_owner has delegated to an org_manager, App.tsx hides that
  // owner's own branch-level Overview nav item (they still have the
  // identical view at Organization > Dashboard) -- see computeVisibleNav.
  hasOrgManager: boolean
}

export interface OrganizationBranch {
  branchId: string
  name: string
  address: string | null
  phone: string | null
  branchCode: string | null
  status: string
  staffCount: number
  createdAt: string
  latitude: number | null
  longitude: number | null
}

export interface OrgBranchSummary {
  branchId: string
  branchName: string
  todayRevenue: number
  monthToDateRevenue: number
  outOfStockCount: number
  lowStockCount: number
  pendingTransfersIn: number
}

export type BranchRole = "owner" | "manager" | "seller"

// Every person tied to the organization, org-level and branch-level
// together -- one unified list the org_owner/org_manager manages from,
// instead of two separate ones. `role` is `OrgRole` when `scope ===
// "organization"`, `BranchRole` when `scope === "branch"`.
export interface OrganizationPerson {
  userId: string
  fullName: string
  // null when the caller isn't entitled to see this person's email -- an
  // org_manager viewing the org_owner's row, specifically (role hierarchy:
  // a role sees every role below it, never the one above -- see
  // list_organization_people() in 2026-09-14_role_hierarchy_visibility.sql).
  email: string | null
  scope: "organization" | "branch"
  role: OrgRole | BranchRole
  branchId: string | null
  branchName: string | null
  isActive: boolean
  isRemoved: boolean
}

export interface RoleChangeLogEntry {
  id: string
  scope: "organization" | "branch"
  organizationId: string | null
  branchId: string | null
  actorUserId: string | null
  actorEmail: string | null
  targetUserId: string
  targetEmail: string | null
  oldRole: string | null
  newRole: string | null
  action: "grant" | "revoke" | "role_change" | "ownership_transfer"
  reason: string | null
  createdAt: string
}

function mapRoleChangeLog(row: any): RoleChangeLogEntry {
  return {
    id: row.id, scope: row.scope, organizationId: row.organization_id, branchId: row.branch_id,
    actorUserId: row.actor_user_id, actorEmail: row.actor_email, targetUserId: row.target_user_id,
    targetEmail: row.target_email, oldRole: row.old_role, newRole: row.new_role,
    action: row.action, reason: row.reason, createdAt: row.created_at,
  }
}

// null on a signed-in user who holds no organization role at all -- the
// caller uses this to decide whether the Organization nav item should show.
export async function getMyOrganization(): Promise<OrganizationSummary | null> {
  const { data, error } = await supabase.rpc("get_my_organization")
  if (error) throw error
  const row = Array.isArray(data) ? data[0] : data
  if (!row) return null
  return {
    organizationId: row.organization_id, legalName: row.legal_name, tradeName: row.trade_name,
    tin: row.tin, status: row.status, myRole: row.my_role as OrgRole, branchCount: row.branch_count,
    hasOrgManager: Boolean(row.has_org_manager),
  }
}

// null unless the caller's own branch belongs to an organization -- true
// even for a plain branch owner/manager who holds no org_owner/org_manager
// role themselves. Distinct from getMyOrganization(): that one is null for
// such a person (they have no organization_members row), which used to mean
// they had no way to reach the Organization tab at all -- including to
// respond to a stock request addressed to their own branch. The caller uses
// this as a fallback organization id for exactly that: branch-to-branch
// stock requests, which only need "my branch is in an org", not an org role.
export async function getMyBranchOrganizationId(): Promise<string | null> {
  const { data, error } = await supabase.rpc("my_branch_organization_id")
  if (error) throw error
  return (data as string | null) ?? null
}

export async function createPharmacyOrganization(legalName: string, tin?: string): Promise<string> {
  const { data, error } = await supabase.rpc("create_pharmacy_organization", {
    p_legal_name: legalName, p_tin: tin?.trim() || null,
  })
  if (error) throw error
  return data as string
}

export async function listOrganizationBranches(organizationId: string): Promise<OrganizationBranch[]> {
  const { data, error } = await supabase.rpc("list_organization_branches", { p_organization_id: organizationId })
  if (error) throw error
  return ((data ?? []) as any[]).map(row => ({
    branchId: row.branch_id, name: row.name, address: row.address, phone: row.phone,
    branchCode: row.branch_code, status: row.status, staffCount: row.staff_count, createdAt: row.created_at,
    latitude: row.latitude ?? null, longitude: row.longitude ?? null,
  }))
}

export async function updateOrganizationDetails(
  organizationId: string, legalName: string, tradeName?: string, tin?: string
): Promise<void> {
  const { error } = await supabase.rpc("update_organization_details", {
    p_organization_id: organizationId, p_legal_name: legalName,
    p_trade_name: tradeName?.trim() || null, p_tin: tin?.trim() || null,
  })
  if (error) throw error
}

// Per-branch revenue/stock snapshot for the Dashboard tab -- today/MTD
// revenue, out-of-stock/low-stock counts, and pending incoming transfers,
// one row per branch in the organization.
export async function orgBranchSummary(organizationId: string): Promise<OrgBranchSummary[]> {
  const { data, error } = await supabase.rpc("org_branch_summary", { p_organization_id: organizationId })
  if (error) throw error
  return ((data ?? []) as any[]).map(row => ({
    branchId: row.branch_id, branchName: row.branch_name,
    todayRevenue: Number(row.today_revenue), monthToDateRevenue: Number(row.month_to_date_revenue),
    outOfStockCount: row.out_of_stock_count, lowStockCount: row.low_stock_count,
    pendingTransfersIn: row.pending_transfers_in,
  }))
}

export async function addBranchToOrganization(
  organizationId: string, pharmacyName: string, phone: string, email: string, location: string
): Promise<string> {
  const { data, error } = await supabase.rpc("add_branch_to_organization", {
    p_organization_id: organizationId, p_pharmacy_name: pharmacyName,
    p_phone: phone, p_email: email, p_location: location,
  })
  if (error) throw error
  return data as string
}

export async function listOrganizationPeople(organizationId: string): Promise<OrganizationPerson[]> {
  const { data, error } = await supabase.rpc("list_organization_people", { p_organization_id: organizationId })
  if (error) throw error
  return ((data ?? []) as any[]).map(row => ({
    userId: row.user_id, fullName: row.full_name, email: row.email,
    scope: row.scope, role: row.role, branchId: row.branch_id, branchName: row.branch_name,
    isActive: row.is_active, isRemoved: row.is_removed,
  }))
}

// Grants org_manager -- the only role this ever assigns now (ownership only
// ever moves via transferOrganizationOwnership). 'granted' -- the email
// already had a login somewhere (e.g. an existing branch_manager being
// promoted -- their branch role/branch_id is left exactly as-is; they just
// stop showing up in that branch's own staff roster, see
// list_branch_staff()); org access applies immediately. 'invited' -- a
// brand-new person with no existing login at all; nothing is granted until
// they complete the emailed OTP flow (requestOrganizationInviteOtp below).
// No branch to pick here either way -- org_manager was never tied to one
// (the RPC auto-picks its own required technical placeholder for a
// brand-new invite).
export async function inviteOrganizationMember(
  organizationId: string, email: string, fullName: string
): Promise<"granted" | "invited"> {
  const { data, error } = await supabase.rpc("invite_organization_member", {
    p_organization_id: organizationId,
    p_user_email: email, p_full_name: fullName, p_role: "org_manager",
  })
  if (error) throw error
  return data as "granted" | "invited"
}

// The branch_manager/sales_person half of "assign a role" -- same
// granted/invited shape as inviteOrganizationMember, going through the same
// OTP-invite path rather than an immediate password (see staffOrganizationBranch
// below for the separate, still-password-based "add a brand-new branch and
// staff it right now" convenience flow, which this does not replace).
export async function assignBranchRole(
  organizationId: string, branchId: string, email: string, fullName: string, role: "manager" | "seller"
): Promise<"granted" | "invited"> {
  const { data, error } = await supabase.rpc("org_assign_branch_role", {
    p_organization_id: organizationId, p_branch_id: branchId,
    p_user_email: email, p_full_name: fullName, p_role: role,
  })
  if (error) throw error
  return data as "granted" | "invited"
}

// Moves someone between org-level and branch-level roles in one call --
// promote a branch manager up to org_manager, or move the current
// org_manager back down to branch manager/salesperson. Demoting drops
// their organization_members row entirely and sets their branch role
// instead; their branch_id is untouched, so they land back at the branch
// they were already anchored to and reappear in its roster (list_branch_staff()
// excludes org_manager holders, so removing that grant is what makes them
// visible there again). Owner-only, and it refuses to touch the org_owner
// (ownership moves through transferOrganizationOwnership instead).
export type OrgAssignableRole = "org_manager" | "manager" | "seller"

export async function changeOrganizationMemberRole(
  organizationId: string, userId: string, newRole: OrgAssignableRole
): Promise<void> {
  const { error } = await supabase.rpc("org_change_member_role", {
    p_organization_id: organizationId, p_user_id: userId, p_new_role: newRole,
  })
  if (error) throw error
}

export async function removeOrganizationMember(organizationId: string, userId: string): Promise<void> {
  const { error } = await supabase.rpc("remove_organization_member", { p_organization_id: organizationId, p_user_id: userId })
  if (error) throw error
}

// Offboarding: deactivating immediately blocks sign-in everywhere (branch
// AND org level); reactivating restores it. Works on any org-level member
// or branch-level staff in this organization -- the RPC itself enforces who
// may act on whom (deactivating an org_manager is owner-only; org_owner can
// never be targeted here at all).
export async function setPersonActive(organizationId: string, userId: string, isActive: boolean): Promise<void> {
  const { error } = await supabase.rpc("org_set_user_active", {
    p_organization_id: organizationId, p_target_user_id: userId, p_is_active: isActive,
  })
  if (error) throw error
}

export async function listRoleChangeLog(organizationId: string): Promise<RoleChangeLogEntry[]> {
  const { data, error } = await supabase.rpc("list_role_change_log", { p_organization_id: organizationId, p_branch_id: null })
  if (error) throw error
  return ((data ?? []) as any[]).map(mapRoleChangeLog)
}

// ── Organization invite OTP flow (brand-new person, no existing login) ─────
// Same shape as lib/onboarding.ts's pharmacy-OTP pair: request checks
// eligibility then asks Supabase Auth to email a real OTP; verify hands the
// code to Supabase Auth, then calls the idempotent activate RPC.

export async function canRequestOrganizationInviteOtp(email: string): Promise<boolean> {
  const { data, error } = await supabase.rpc("can_request_organization_invite_otp", { p_email: email })
  if (error) throw error
  return Boolean(data)
}

export async function requestOrganizationInviteOtp(email: string): Promise<void> {
  const allowed = await canRequestOrganizationInviteOtp(email)
  if (!allowed) throw new Error("No pending organization invite was found for this email, or it has expired.")
  const { error } = await supabase.auth.signInWithOtp({ email, options: { shouldCreateUser: true } })
  if (error) throw error
}

export interface AcceptedOrganizationInvite { organizationId: string; branchId: string; role: string }

export async function verifyOrganizationInviteOtp(email: string, token: string): Promise<AcceptedOrganizationInvite> {
  const { error } = await supabase.auth.verifyOtp({ email, token, type: "email" })
  if (error) throw error
  const { data, error: activateError } = await supabase.rpc("activate_organization_invite")
  if (activateError) throw activateError
  const row = Array.isArray(data) ? data[0] : data
  return { organizationId: row.organization_id, branchId: row.branch_id, role: row.role }
}

// Staffs a branch anywhere in the organization -- immediate, password-based,
// via the extended create-branch-seller Edge Function (the same one every
// other staff login in this app goes through). Works on a brand-new,
// unstaffed branch (role 'owner' or 'manager') or an already-staffed one
// (role 'manager'/'seller' only -- the Edge Function rejects a second
// 'owner', since a branch may only ever have one). 'org_manager' is the
// fourth, org-level case: an org-wide grant, not a branch role -- it is
// never actually tied to any branch operationally (org_owner-only,
// one-per-organization), so branchId is null here; the Edge Function picks
// a technical placeholder branch on its own (required by a NOT NULL schema
// column, never surfaced anywhere as "their branch" -- see its own header
// comment and list_branch_staff's org_manager exclusion).
export async function staffOrganizationBranch(
  branchId: string | null, fullName: string, email: string, password: string, role: "owner" | "manager" | "seller" | "org_manager"
): Promise<string> {
  const { data, error } = await supabase.functions.invoke("create-branch-seller", {
    body: { fullName, email, password, role, branchId },
  })
  if (error) {
    if (error instanceof FunctionsHttpError) {
      const body = await error.context.json().catch(() => null)
      throw new Error(body?.error ?? error.message)
    }
    throw error
  }
  if (data?.error) throw new Error(data.error)
  return data.userId as string
}

export interface BranchDistanceMeasurement {
  id: string
  branchAId: string
  branchAName: string
  branchBId: string
  branchBName: string
  distanceKm: number
  measuredByName: string | null
  createdAt: string
}

// Persists a distance the org_owner/org_manager measured on the Branches
// map's click-to-measure tool -- otherwise it vanished the moment they
// navigated away or measured a different pair.
export async function saveBranchDistanceMeasurement(
  organizationId: string, branchAId: string, branchBId: string, distanceKm: number,
): Promise<void> {
  const { error } = await supabase.rpc("save_branch_distance_measurement", {
    p_organization_id: organizationId, p_branch_a_id: branchAId, p_branch_b_id: branchBId, p_distance_km: distanceKm,
  })
  if (error) throw error
}

export async function listBranchDistanceMeasurements(organizationId: string): Promise<BranchDistanceMeasurement[]> {
  const { data, error } = await supabase.rpc("list_branch_distance_measurements", { p_organization_id: organizationId })
  if (error) throw error
  return ((data ?? []) as any[]).map(row => ({
    id: row.id, branchAId: row.branch_a_id, branchAName: row.branch_a_name,
    branchBId: row.branch_b_id, branchBName: row.branch_b_name,
    distanceKm: row.distance_km, measuredByName: row.measured_by_name ?? null, createdAt: row.created_at,
  }))
}

export async function deleteBranchDistanceMeasurement(id: string): Promise<void> {
  const { error } = await supabase.rpc("delete_branch_distance_measurement", { p_id: id })
  if (error) throw error
}
