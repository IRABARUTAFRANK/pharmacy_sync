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

// Returning-branch-user sign-in is email + password, not a per-login emailed
// OTP: OTP only happens once, during the one-time account-activation flow in
// pages/BranchPortal.tsx (see setBranchPassword() in lib/onboarding.ts, which
// sets the password at the end of that flow while the OTP-verified session
// is still live). The branch itself is never picked in the UI here either:
// it is derived from the signed-in user's own public.users.branch_id row,
// since a user belongs to exactly one branch.
export async function signInToBranch(email: string, password: string): Promise<BranchAccess> {
  const { error: signInError } = await supabase.auth.signInWithPassword({ email, password })
  if (signInError) throw signInError

  const access = await restoreBranchAccess()
  if (!access) {
    await supabase.auth.signOut()
    throw new Error("This account has no active pharmacy profile. Ask an administrator to assign a branch.")
  }
  return access
}

export async function sendBranchPasswordReset(email: string, redirectTo: string): Promise<void> {
  const { error } = await supabase.auth.resetPasswordForEmail(email, { redirectTo })
  if (error) throw error
}

// Shared by BranchPortal.tsx (setting a password for the first time, right
// after OTP activation) and LoginView's "forgot password" completion step
// (after the reset-email link lands back with a recovery session). Either
// way, it just sets a password on whatever session is currently live.
export async function updatePassword(password: string): Promise<void> {
  const { error } = await supabase.auth.updateUser({ password })
  if (error) throw error
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
