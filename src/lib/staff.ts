import { FunctionsHttpError } from "@supabase/supabase-js"
import { supabase, branchArg } from "./supabase"

export type StaffRole = "manager" | "seller"
export type BranchUserRole = "owner" | StaffRole

export interface StaffMember {
  id: string
  fullName: string
  // null when the caller isn't entitled to see this person's email -- a
  // branch manager viewing the branch owner's row, specifically (role
  // hierarchy: a role sees who's below it, never the credentials of who's
  // above -- see list_branch_staff() in
  // 2026-09-15_branch_staff_email_hierarchy.sql).
  email: string | null
  role: BranchUserRole
  isActive: boolean
  isRemoved: boolean
  createdAt: string
}

export interface SellerActivityRow {
  userId: string
  fullName: string
  salesCount: number
  revenueToday: number
  patientsRegisteredToday: number
}

// The only account-creation path that needs a real, manager-chosen password
// for someone else's login -- everything else in this app is passwordless
// OTP activation. Only the service-role Admin API (server-side) can set a
// password on another user's behalf, so this calls the create-branch-seller
// Edge Function instead of an RPC. Creating a manager login is owner-only,
// enforced server-side by the function itself. `branchId` lets an
// org_owner/org_manager staff a branch they're viewing rather than their own
// -- omitted (undefined), the Edge Function defaults to the caller's own
// branch, unchanged from before.
export async function inviteStaff(fullName: string, email: string, password: string, role: StaffRole, branchId?: string): Promise<string> {
  const { data, error } = await supabase.functions.invoke("create-branch-seller", {
    body: { fullName, email, password, role, branchId },
  })
  if (error) {
    // A FunctionsHttpError means the function DID run and responded -- e.g. a
    // validation failure or "email already in use" -- so its real message is
    // in the response body, not the SDK's generic "non-2xx status" wrapper.
    // Only a true network/fetch failure (function unreachable, not deployed)
    // should fall through to that generic message.
    if (error instanceof FunctionsHttpError) {
      const body = await error.context.json().catch(() => null)
      throw new Error(body?.error ?? error.message)
    }
    throw error
  }
  if (data?.error) throw new Error(data.error)
  return data.userId as string
}

// Was a plain select relying on the "users read own branch" RLS policy, which
// has no org-member clause -- that only ever covered your OWN branch, never
// one an org_owner/org_manager is viewing. Now a real RPC, same
// effective_branch_id() pattern as every other view-as-branch read. Every
// role in the branch, not just sellers, so the Users & Roles roster can show
// the full team including itself.
export async function listBranchStaff(branchId?: string): Promise<StaffMember[]> {
  const { data, error } = await supabase.rpc("list_branch_staff", { ...branchArg(branchId) })
  if (error) throw error
  return ((data ?? []) as any[]).map(row => ({
    id: row.id, fullName: row.full_name, email: row.email, role: row.role as BranchUserRole,
    isActive: row.is_active, isRemoved: row.is_removed, createdAt: row.created_at,
  }))
}

export async function setStaffActive(userId: string, isActive: boolean, branchId?: string): Promise<void> {
  const { error } = await supabase.rpc("admin_set_seller_active", { p_user_id: userId, p_is_active: isActive, ...branchArg(branchId) })
  if (error) throw error
}

export async function updateStaffRole(userId: string, role: StaffRole, branchId?: string): Promise<void> {
  const { error } = await supabase.rpc("admin_update_staff_role", { p_user_id: userId, p_role: role, ...branchArg(branchId) })
  if (error) throw error
}

// Sets a new password for someone else's login -- the only thing possible
// once "see their credentials" runs into Supabase Auth never storing a real,
// reversible password anywhere. Authorization (who may reset whose password)
// is entirely server-side, in assert_can_reset_staff_password() -- this just
// calls the one Edge Function that can reach the service-role Admin API.
// Works for both a branch-scoped target (BranchSettingsPage's Users & Roles)
// and an org-level org_manager target (OrganizationPage's Members tab) --
// the target's own id is enough for the server to resolve which case applies.
export async function resetStaffPassword(userId: string, newPassword: string): Promise<void> {
  const { data, error } = await supabase.functions.invoke("reset-staff-password", { body: { userId, newPassword } })
  if (error) {
    if (error instanceof FunctionsHttpError) {
      const body = await error.context.json().catch(() => null)
      throw new Error(body?.error ?? error.message)
    }
    throw error
  }
  if (data?.error) throw new Error(data.error)
}

// Same idea as resetStaffPassword, extended to also change the login EMAIL
// -- one Edge Function, one button, either field optional but at least one
// required (enforced server-side in update-staff-credentials). Also keeps
// public.users.email in sync so list_branch_staff()/list_organization_
// people() immediately show the new address.
export async function updateStaffCredentials(userId: string, newEmail?: string, newPassword?: string): Promise<void> {
  const { data, error } = await supabase.functions.invoke("update-staff-credentials", { body: { userId, newEmail, newPassword } })
  if (error) {
    if (error instanceof FunctionsHttpError) {
      const body = await error.context.json().catch(() => null)
      throw new Error(body?.error ?? error.message)
    }
    throw error
  }
  if (data?.error) throw new Error(data.error)
}

// Permanently revokes login (Supabase Auth ban, no expiry in practice) --
// distinct from setStaffActive(false), which is a reversible deactivation.
// No row is ever deleted, so every past sale/receipt/stock entry this person
// touched stays intact. Authorization and the is_removed flag both come
// from mark_staff_removed() (2026-09-18_staff_removal_and_credentials.sql);
// this just also has the Edge Function apply the actual Auth-level ban.
export async function removeStaffAccount(userId: string): Promise<void> {
  const { data, error } = await supabase.functions.invoke("remove-staff-account", { body: { userId } })
  if (error) {
    if (error instanceof FunctionsHttpError) {
      const body = await error.context.json().catch(() => null)
      throw new Error(body?.error ?? error.message)
    }
    throw error
  }
  if (data?.error) throw new Error(data.error)
}

export async function listSellerActivityToday(): Promise<SellerActivityRow[]> {
  const { data, error } = await supabase.rpc("list_seller_activity_today")
  if (error) throw error
  return ((data ?? []) as any[]).map(row => ({
    userId: row.user_id,
    fullName: row.full_name,
    salesCount: Number(row.sales_count),
    revenueToday: Number(row.revenue_today),
    patientsRegisteredToday: Number(row.patients_registered_today),
  }))
}
