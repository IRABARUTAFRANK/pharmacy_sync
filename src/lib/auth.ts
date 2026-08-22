import { supabase } from "./supabase"

export type AppRole = "owner" | "manager" | "pharmacist" | "staff"

export interface BranchDirectoryEntry { id: string; name: string }
export interface BranchAccess {
  userId: string
  branchId: string
  branchName: string
  branchCode?: string
  fullName: string
  role: AppRole
}

export async function listBranchDirectory(): Promise<BranchDirectoryEntry[]> {
  const { data, error } = await supabase.from("branch_directory").select("branch_id, display_name").order("display_name")
  if (error) throw error
  return (data ?? []).map(branch => ({ id: branch.branch_id, name: branch.display_name }))
}

// Returning-branch-user sign-in (email + emailed OTP). The branch itself is
// never picked in the UI: it is derived from the signed-in user's own
// public.users.branch_id row, since a user belongs to exactly one branch.
// shouldCreateUser is false here on purpose — an account must already exist
// (created by activate_pharmacy_account() during the one-time onboarding
// flow in Super Admin Portal); this path never creates a new auth user.
export async function canRequestBranchOtp(email: string): Promise<boolean> {
  const { data, error } = await supabase.rpc("can_request_pharmacy_otp", { p_email: email })
  if (error) throw error
  return Boolean(data)
}

export async function requestBranchOtp(email: string): Promise<void> {
  const allowed = await canRequestBranchOtp(email)
  if (!allowed) throw new Error("No active account was found for this email, or it has been locked. Contact the super admin.")
  const { error } = await supabase.auth.signInWithOtp({ email, options: { shouldCreateUser: false } })
  if (error) throw error
}

export async function verifyBranchOtp(email: string, token: string): Promise<BranchAccess> {
  const { error } = await supabase.auth.verifyOtp({ email, token, type: "email" })
  if (error) throw error
  const access = await restoreBranchAccess()
  if (!access) throw new Error("Signed in, but no branch profile is linked to this account yet.")
  return access
}

export async function signInToBranch(email: string, password: string, selectedBranchId: string): Promise<BranchAccess> {
  const { error: signInError } = await supabase.auth.signInWithPassword({ email, password })
  if (signInError) throw signInError

  const { data: userData, error: userError } = await supabase.auth.getUser()
  if (userError || !userData.user) {
    await supabase.auth.signOut()
    throw userError ?? new Error("Your sign-in session could not be verified.")
  }

  const { data: profile, error: profileError } = await supabase
    .from("users")
    .select("id, branch_id, full_name, role, branches(name, branch_code)")
    .eq("id", userData.user.id)
    .single()

  if (profileError || !profile) {
    await supabase.auth.signOut()
    throw new Error("This account has no active pharmacy profile. Ask an administrator to assign a branch.")
  }
  if (profile.branch_id !== selectedBranchId) {
    await supabase.auth.signOut()
    throw new Error("This account is not assigned to the branch you selected.")
  }

  const branch = Array.isArray(profile.branches) ? profile.branches[0] : profile.branches
  return { userId: profile.id, branchId: profile.branch_id, branchName: branch?.name ?? "Your branch", branchCode: branch?.branch_code ?? undefined, fullName: profile.full_name, role: profile.role as AppRole }
}

export async function restoreBranchAccess(): Promise<BranchAccess | null> {
  const { data: userData, error: userError } = await supabase.auth.getUser()
  if (userError || !userData.user) return null
  const { data: profile, error } = await supabase.from("users").select("id, branch_id, full_name, role, branches(name, branch_code)").eq("id", userData.user.id).single()
  if (error || !profile) return null
  const branch = Array.isArray(profile.branches) ? profile.branches[0] : profile.branches
  return { userId: profile.id, branchId: profile.branch_id, branchName: branch?.name ?? "Your branch", branchCode: branch?.branch_code ?? undefined, fullName: profile.full_name, role: profile.role as AppRole }
}

export async function signOutFromBranch(): Promise<void> {
  const { error } = await supabase.auth.signOut()
  if (error) throw error
}
