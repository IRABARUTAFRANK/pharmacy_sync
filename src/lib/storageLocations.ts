import { supabase } from "./supabase"

// Optional, per-branch, manager-defined physical locations ("Cabinet A",
// "Fridge 2") a product can be tagged with -- see
// 2026-09-17_storage_locations.sql for the full design rationale. Every
// function here operates on the CALLER's own current branch (current_
// branch_id() server-side) -- there is no cross-branch "view as" variant,
// matching product_categories, its closest sibling in this schema.

export interface StorageLocation {
  id: string
  name: string
  productCount: number
}

export async function listStorageLocations(): Promise<StorageLocation[]> {
  const { data, error } = await supabase.rpc("list_storage_locations")
  if (error) throw error
  return ((data ?? []) as any[]).map(row => ({ id: row.id, name: row.name, productCount: row.product_count ?? 0 }))
}

export async function createStorageLocation(name: string): Promise<string> {
  const { data, error } = await supabase.rpc("create_storage_location", { p_name: name })
  if (error) throw error
  return data as string
}

export async function renameStorageLocation(id: string, name: string): Promise<void> {
  const { error } = await supabase.rpc("rename_storage_location", { p_id: id, p_name: name })
  if (error) throw error
}

export async function deleteStorageLocation(id: string): Promise<void> {
  const { error } = await supabase.rpc("delete_storage_location", { p_id: id })
  if (error) throw error
}

// p_storage_location_id null unassigns the product entirely.
export async function setProductStorageLocation(productId: string, storageLocationId: string | null): Promise<void> {
  const { error } = await supabase.rpc("set_product_storage_location", { p_product_id: productId, p_storage_location_id: storageLocationId })
  if (error) throw error
}

export interface LocationPickerProduct {
  productId: string
  productName: string
  genericName: string | null
  storageLocationId: string | null
  storageLocationName: string | null
}

// Every product ever stocked at this branch, with its current location (if
// any) -- backs the "assign a product to this location" search box.
export async function listBranchProductsForLocationPicker(): Promise<LocationPickerProduct[]> {
  const { data, error } = await supabase.rpc("list_branch_products_for_location_picker")
  if (error) throw error
  return ((data ?? []) as any[]).map(row => ({
    productId: row.product_id, productName: row.product_name, genericName: row.generic_name ?? null,
    storageLocationId: row.storage_location_id ?? null, storageLocationName: row.storage_location_name ?? null,
  }))
}
