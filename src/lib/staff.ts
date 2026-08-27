import { FunctionsHttpError } from "@supabase/supabase-js"
import { supabase } from "./supabase"

export interface StaffMember {
  id: string
  fullName: string
  email: string
  isActive: boolean
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
// Edge Function instead of an RPC.
export async function createSeller(fullName: string, email: string, password: string): Promise<string> {
  const { data, error } = await supabase.functions.invoke("create-branch-seller", {
    body: { fullName, email, password },
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

// Plain select, not an RPC -- already covered by the existing "users read own
// branch" RLS policy (branch_id = current_branch_id() or is_super_admin()).
export async function listBranchStaff(): Promise<StaffMember[]> {
  const { data, error } = await supabase
    .from("users")
    .select("id, full_name, email, is_active, created_at")
    .eq("role", "seller")
    .order("full_name")
  if (error) throw error
  return (data ?? []).map(row => ({
    id: row.id, fullName: row.full_name, email: row.email, isActive: row.is_active, createdAt: row.created_at,
  }))
}

export async function setSellerActive(userId: string, isActive: boolean): Promise<void> {
  const { error } = await supabase.rpc("admin_set_seller_active", { p_user_id: userId, p_is_active: isActive })
  if (error) throw error
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
