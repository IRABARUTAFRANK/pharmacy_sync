import { supabase } from "./supabase"
import { supabaseAdmin } from "./supabaseAdmin"
import type { BranchRecord, BranchStatus } from "./store"

interface ApplicationRow {
  id: string
  application_code: string
  pharmacy_name: string
  phone: string
  email: string
  location: string
  status: string
  called_at: string | null
  denied_reason: string | null
  branch_id: string | null
  branch_code: string | null
  activation_code: string | null
  failed_logins?: number | null
  locked_at?: string | null
  submitted_at: string
}

function asRecord(row: ApplicationRow): BranchRecord {
  return {
    id: row.id,
    applicationCode: row.application_code,
    pharmacyName: row.pharmacy_name,
    phone: row.phone,
    email: row.email,
    location: row.location,
    submittedAt: row.submitted_at,
    status: row.status as BranchStatus,
    branchId: row.branch_id ?? undefined,
    branchCode: row.branch_code ?? undefined,
    activationCode: row.activation_code ?? undefined,
    failedLogins: row.failed_logins ?? 0,
    lockedAt: row.locked_at ?? undefined,
    calledAt: row.called_at ?? undefined,
    deniedReason: row.denied_reason ?? undefined,
  }
}

// Stable codes rather than English sentences, for the failures the public
// registration flow can explain to an applicant in their own language.
// pages/BranchPortal.tsx maps these to translation keys; anything else that
// reaches it is a real Postgres/Auth error whose own message is shown as-is.
export const ONBOARDING_SERVICE_ERROR = "ONBOARDING_SERVICE_ERROR"
export const ONBOARDING_RELOAD_FAILED = "ONBOARDING_RELOAD_FAILED"
export const ONBOARDING_NOT_APPROVED = "ONBOARDING_NOT_APPROVED"

function raise(error: { message: string } | null): never {
  throw new Error(error?.message ?? ONBOARDING_SERVICE_ERROR)
}

export async function submitPharmacyRegistration(input: {
  pharmacyName: string
  phone: string
  email: string
  location: string
}): Promise<BranchRecord> {
  const { data, error } = await supabase.rpc("submit_pharmacy_registration", {
    p_pharmacy_name: input.pharmacyName,
    p_phone: input.phone,
    p_email: input.email,
    p_location: input.location,
  })
  if (error) raise(error)
  const created = Array.isArray(data) ? data[0] : data
  const application = await getPharmacyApplication(created.application_id)
  if (!application) raise({ message: ONBOARDING_RELOAD_FAILED })
  return application
}

export async function getPharmacyApplication(applicationId: string): Promise<BranchRecord | null> {
  const { data, error } = await supabase.rpc("get_pharmacy_application", { p_application_id: applicationId })
  if (error) raise(error)
  const row = (Array.isArray(data) ? data[0] : data) as ApplicationRow | undefined
  return row ? asRecord(row) : null
}

// Used by the emailed activation link (.../#branch?email=...), which has to
// resolve an application from any device/browser — sessionStorage only
// remembers the application id on the browser that submitted the form.
export async function getPharmacyApplicationByEmail(email: string): Promise<BranchRecord | null> {
  const { data, error } = await supabase.rpc("get_pharmacy_application_by_email", { p_email: email })
  if (error) raise(error)
  const row = (Array.isArray(data) ? data[0] : data) as ApplicationRow | undefined
  return row ? asRecord(row) : null
}

export async function listPharmacyApplications(): Promise<BranchRecord[]> {
  const { data, error } = await supabaseAdmin.rpc("admin_list_pharmacy_applications")
  if (error) raise(error)
  return ((data ?? []) as ApplicationRow[]).map(asRecord)
}

export async function markPharmacyCalled(applicationId: string): Promise<void> {
  const { error } = await supabaseAdmin.rpc("admin_mark_pharmacy_called", { p_application_id: applicationId })
  if (error) raise(error)
}

export async function denyPharmacyApplication(applicationId: string, reason: string): Promise<void> {
  const { error } = await supabaseAdmin.rpc("admin_deny_pharmacy_application", {
    p_application_id: applicationId,
    p_reason: reason,
  })
  if (error) raise(error)
}

// Sends the activation email (link + 6-digit code) itself, right here, from
// the admin's own already-authenticated browser — the applicant is not
// expected to be online at approval time (they were told to close the tab
// and wait), so nothing on their side can be relied on to trigger the send.
// signInWithOtp only *requests* an OTP for the given address; it never
// touches the admin's own session, which stays signed in throughout.
export async function approvePharmacyApplication(applicationId: string): Promise<void> {
  const { data, error } = await supabaseAdmin.rpc("admin_approve_pharmacy_application", { p_application_id: applicationId })
  if (error) raise(error)
  const approved = Array.isArray(data) ? data[0] : data
  if (approved?.email) await requestPharmacyOtp(approved.email)
}

export async function setBranchLock(branchId: string, locked: boolean): Promise<void> {
  const { error } = await supabaseAdmin.rpc("admin_set_branch_lock", { p_branch_id: branchId, p_locked: locked })
  if (error) raise(error)
}

// Destructive — wipes the branch and everything it owns. The UI requires a
// step-up re-verification (re-enter email, enter a fresh emailed OTP) right
// before calling this; see the AdminPortal.tsx delete-branch modal.
export async function deleteBranch(branchId: string, reason?: string): Promise<void> {
  const { error } = await supabaseAdmin.rpc("admin_delete_branch", { p_branch_id: branchId, p_reason: reason?.trim() || null })
  if (error) raise(error)
}

export interface DeletedBranchRecord {
  id: string
  branchId: string
  pharmacyName: string
  phone: string | null
  email: string | null
  branchCode: string | null
  location: string | null
  reason: string | null
  deletedByEmail: string | null
  deletedAt: string
}

// Archive left behind by admin_delete_branch() -- a log of what was deleted
// and by whom, not a way to recover the branch itself. See the "Deleted
// branches" panel on the branch directory.
export async function listDeletedBranches(): Promise<DeletedBranchRecord[]> {
  const { data, error } = await supabaseAdmin.rpc("admin_list_deleted_branches")
  if (error) raise(error)
  return ((data ?? []) as any[]).map(row => ({
    id: row.id, branchId: row.branch_id, pharmacyName: row.pharmacy_name,
    phone: row.phone, email: row.email, branchCode: row.branch_code, location: row.location,
    reason: row.reason, deletedByEmail: row.deleted_by_email, deletedAt: row.deleted_at,
  }))
}

// The super admin correcting a pharmacy's own details on request. Separate
// from updateBranchDetails() in lib/branch.ts, which is the owner editing
// their OWN branch from their session -- this one names the branch explicitly.
export interface AdminBranchEdit {
  name?: string
  phone?: string
  email?: string
  address?: string
  tin?: string
  website?: string
  licenseNumber?: string
  licenseExpiryDate?: string | null
}

export async function adminUpdateBranchDetails(branchId: string, edit: AdminBranchEdit): Promise<void> {
  const { error } = await supabaseAdmin.rpc("admin_update_branch_details", {
    p_branch_id: branchId,
    p_name: edit.name?.trim() || null,
    p_phone: edit.phone?.trim() || null,
    p_email: edit.email?.trim() || null,
    p_address: edit.address?.trim() || null,
    p_tin: edit.tin?.trim() || null,
    p_website: edit.website?.trim() || null,
    p_license_number: edit.licenseNumber?.trim() || null,
    p_license_expiry_date: edit.licenseExpiryDate || null,
  })
  if (error) raise(error)
}

// Deletes registrations nobody approved within 7 days. Returns how many went,
// so the console can say so rather than have rows vanish between page loads.
export async function expireStaleApplications(): Promise<number> {
  const { data, error } = await supabaseAdmin.rpc("admin_expire_stale_applications")
  if (error) raise(error)
  return Number(data ?? 0)
}

// ── Application ageing ──────────────────────────────────────────────────────
// A pending registration is deleted 7 days after it was submitted. The console
// warns before that happens: "2 days left" from day 5, "1 day left" from day 6.
// Computed here from submitted_at rather than stored, so it can never drift
// from what the server will actually delete.

export const APPLICATION_EXPIRY_DAYS = 7

export function applicationDaysLeft(submittedAt: string): number {
  const elapsedMs = Date.now() - new Date(submittedAt).getTime()
  return APPLICATION_EXPIRY_DAYS - Math.floor(elapsedMs / 86_400_000)
}

export interface PlatformStats { activeBranches: number; trackedSkus: number; cities: number }

// Real counts for the marketing home page's trust-stat strip — see
// public_platform_stats() in the schema. Aggregate numbers only, readable
// before sign-in.
export async function getPlatformStats(): Promise<PlatformStats> {
  const { data, error } = await supabase.rpc("public_platform_stats")
  if (error) raise(error)
  const row = Array.isArray(data) ? data[0] : data
  return {
    activeBranches: row?.active_branches ?? 0,
    trackedSkus: row?.tracked_skus ?? 0,
    cities: row?.cities ?? 0,
  }
}

export async function canRequestPharmacyOtp(email: string): Promise<boolean> {
  const { data, error } = await supabase.rpc("can_request_pharmacy_otp", { p_email: email })
  if (error) raise(error)
  return Boolean(data)
}

export async function requestPharmacyOtp(email: string): Promise<void> {
  const allowed = await canRequestPharmacyOtp(email)
  if (!allowed) throw new Error(ONBOARDING_NOT_APPROVED)
  const { error } = await supabase.auth.signInWithOtp({
    email,
    options: { shouldCreateUser: true },
  })
  if (error) raise(error)
}

export async function verifyPharmacyOtp(email: string, token: string): Promise<BranchRecord> {
  const { error } = await supabase.auth.verifyOtp({ email, token, type: "email" })
  if (error) raise(error)
  const { data, error: activateError } = await supabase.rpc("activate_pharmacy_account")
  if (activateError) raise(activateError)
  const activated = Array.isArray(data) ? data[0] : data
  return {
    id: "",
    pharmacyName: activated.pharmacy_name,
    phone: "",
    email,
    location: "",
    submittedAt: new Date().toISOString(),
    status: "active",
    branchId: activated.branch_id,
    branchCode: activated.branch_code,
    activationCode: activated.activation_code,
    failedLogins: 0,
  }
}

export async function isSuperAdminSession(): Promise<boolean> {
  const { data, error } = await supabaseAdmin.rpc("is_super_admin")
  if (error) return false
  return Boolean(data)
}

export async function requestAdminOtp(email: string): Promise<void> {
  const { error } = await supabaseAdmin.auth.signInWithOtp({
    email,
    options: { shouldCreateUser: false },
  })
  if (error) raise(error)
}

export async function verifyAdminOtp(email: string, token: string): Promise<void> {
  const { error } = await supabaseAdmin.auth.verifyOtp({ email, token, type: "email" })
  if (error) raise(error)
  if (!(await isSuperAdminSession())) {
    await supabaseAdmin.auth.signOut()
    throw new Error("This account is not a super admin. Set app_metadata.role to super_admin in Supabase Auth.")
  }
}

export async function signOutAdmin(): Promise<void> {
  await supabaseAdmin.auth.signOut()
}
