import { supabase } from "./supabase"

export type AppRole = "owner" | "manager" | "pharmacist" | "staff"

export interface BranchDirectoryEntry { id: string; name: string }
export interface BranchAccess {
  userId: string
  branchId: string
  branchName: string
  fullName: string
  role: AppRole
}

export function createBranchPreviewAccess(branch: BranchDirectoryEntry): BranchAccess {
  return {
    userId: `preview-${branch.id}`,
    branchId: branch.id,
    branchName: branch.name,
    fullName: "Branch workspace",
    role: "manager",
  }
}

export async function listBranchDirectory(): Promise<BranchDirectoryEntry[]> {
  const { data, error } = await supabase.from("branch_directory").select("branch_id, display_name").order("display_name")
  if (error) throw error
  return (data ?? []).map(branch => ({ id: branch.branch_id, name: branch.display_name }))
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
    .select("id, branch_id, full_name, role, branches(name)")
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
  return { userId: profile.id, branchId: profile.branch_id, branchName: branch?.name ?? "Your branch", fullName: profile.full_name, role: profile.role as AppRole }
}

export async function restoreBranchAccess(): Promise<BranchAccess | null> {
  const { data: userData, error: userError } = await supabase.auth.getUser()
  if (userError || !userData.user) return null
  const { data: profile, error } = await supabase.from("users").select("id, branch_id, full_name, role, branches(name)").eq("id", userData.user.id).single()
  if (error || !profile) return null
  const branch = Array.isArray(profile.branches) ? profile.branches[0] : profile.branches
  return { userId: profile.id, branchId: profile.branch_id, branchName: branch?.name ?? "Your branch", fullName: profile.full_name, role: profile.role as AppRole }
}

export async function signOutFromBranch(): Promise<void> {
  const { error } = await supabase.auth.signOut()
  if (error) throw error
}
