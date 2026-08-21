import { supabase } from "./supabase"
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

function raise(error: { message: string } | null): never {
  throw new Error(error?.message ?? "The pharmacy registration service could not complete this request.")
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
  if (!application) raise({ message: "Registration was saved but could not be reloaded." })
  return application
}

export async function getPharmacyApplication(applicationId: string): Promise<BranchRecord | null> {
  const { data, error } = await supabase.rpc("get_pharmacy_application", { p_application_id: applicationId })
  if (error) raise(error)
  const row = (Array.isArray(data) ? data[0] : data) as ApplicationRow | undefined
  return row ? asRecord(row) : null
}

export async function listPharmacyApplications(): Promise<BranchRecord[]> {
  const { data, error } = await supabase.rpc("admin_list_pharmacy_applications")
  if (error) raise(error)
  return ((data ?? []) as ApplicationRow[]).map(asRecord)
}

export async function markPharmacyCalled(applicationId: string): Promise<void> {
  const { error } = await supabase.rpc("admin_mark_pharmacy_called", { p_application_id: applicationId })
  if (error) raise(error)
}

export async function denyPharmacyApplication(applicationId: string, reason: string): Promise<void> {
  const { error } = await supabase.rpc("admin_deny_pharmacy_application", {
    p_application_id: applicationId,
    p_reason: reason,
  })
  if (error) raise(error)
}

export async function approvePharmacyApplication(applicationId: string): Promise<void> {
  const { error } = await supabase.rpc("admin_approve_pharmacy_application", { p_application_id: applicationId })
  if (error) raise(error)
}

export async function setBranchLock(branchId: string, locked: boolean): Promise<void> {
  const { error } = await supabase.rpc("admin_set_branch_lock", { p_branch_id: branchId, p_locked: locked })
  if (error) raise(error)
}

export async function canRequestPharmacyOtp(email: string): Promise<boolean> {
  const { data, error } = await supabase.rpc("can_request_pharmacy_otp", { p_email: email })
  if (error) raise(error)
  return Boolean(data)
}

export async function requestPharmacyOtp(email: string): Promise<void> {
  const allowed = await canRequestPharmacyOtp(email)
  if (!allowed) throw new Error("This pharmacy is not approved yet, or the account is locked.")
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
  const { data, error } = await supabase.rpc("is_super_admin")
  if (error) return false
  return Boolean(data)
}

export async function requestAdminOtp(email: string): Promise<void> {
  const { error } = await supabase.auth.signInWithOtp({
    email,
    options: { shouldCreateUser: false },
  })
  if (error) raise(error)
}

export async function verifyAdminOtp(email: string, token: string): Promise<void> {
  const { error } = await supabase.auth.verifyOtp({ email, token, type: "email" })
  if (error) raise(error)
  if (!(await isSuperAdminSession())) {
    await supabase.auth.signOut()
    throw new Error("This account is not a super admin. Set app_metadata.role to super_admin in Supabase Auth.")
  }
}

export async function signOutAdmin(): Promise<void> {
  await supabase.auth.signOut()
}
