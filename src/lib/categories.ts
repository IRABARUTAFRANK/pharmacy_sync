import { supabase } from "./supabase"

export interface BranchCategory {
  id: string
  name: string
  description: string | null
  productCount: number
  code: string
}

export async function listBranchCategories(): Promise<BranchCategory[]> {
  const { data, error } = await supabase.rpc("list_branch_categories")
  if (error) throw error
  return ((data ?? []) as any[]).map(row => ({
    id: row.id, name: row.name, description: row.description, productCount: Number(row.product_count), code: row.code,
  }))
}

export async function createBranchCategory(name: string, description: string): Promise<string> {
  const { data, error } = await supabase.rpc("create_branch_category", { p_name: name, p_description: description || null })
  if (error) throw error
  return data as string
}

export async function updateBranchCategory(categoryId: string, name: string, description: string): Promise<void> {
  const { error } = await supabase.rpc("update_branch_category", {
    p_category_id: categoryId, p_name: name, p_description: description || null,
  })
  if (error) throw error
}
