import { supabase } from "./supabase"

// Products and their tax rates are super-admin managed only -- branches can
// no longer create a product inline while receiving stock (see
// src/lib/receiving.ts). A branch that can't find a product files a
// product request instead; the admin turns it into a real product (with a
// tax rate) via adminApproveProductRequest.

function raise(error: { message: string } | null): never {
  throw new Error(error?.message ?? "The product catalogue service could not complete this request.")
}

export interface TaxRate {
  id: string
  name: string
  rate_percentage: number
}

export async function listTaxRates(): Promise<TaxRate[]> {
  const { data, error } = await supabase.from("tax_rates").select("id, name, rate_percentage").order("rate_percentage")
  if (error) raise(error)
  return (data ?? []) as TaxRate[]
}

export interface ProductVariantInput {
  dosage?: string
  form?: string
  unit?: string
}

interface AdminProductRow {
  product_id: string
  product_name: string
  generic_name: string | null
  product_type: string
  tax_rate_id: string
  tax_rate_name: string
  tax_rate_percentage: number
  variant_id: string | null
  dosage: string | null
  form: string | null
  unit: string | null
}

export interface AdminProductVariant {
  id: string
  dosage: string | null
  form: string | null
  unit: string | null
}

export interface AdminProduct {
  id: string
  name: string
  genericName: string | null
  productType: string
  taxRateId: string
  taxRateName: string
  taxRatePercentage: number
  variants: AdminProductVariant[]
}

// Rows come back one-per-variant (a product with no variants -- should not
// happen once admin_create_product enforces at least one -- still surfaces
// with a single null-variant row). Grouped here by product_id for the
// Products & Tax console.
export async function adminListProducts(): Promise<AdminProduct[]> {
  const { data, error } = await supabase.rpc("admin_list_products")
  if (error) raise(error)
  const rows = (data ?? []) as AdminProductRow[]
  const byProduct = new Map<string, AdminProduct>()
  for (const row of rows) {
    let product = byProduct.get(row.product_id)
    if (!product) {
      product = {
        id: row.product_id,
        name: row.product_name,
        genericName: row.generic_name,
        productType: row.product_type,
        taxRateId: row.tax_rate_id,
        taxRateName: row.tax_rate_name,
        taxRatePercentage: Number(row.tax_rate_percentage),
        variants: [],
      }
      byProduct.set(row.product_id, product)
    }
    if (row.variant_id) product.variants.push({ id: row.variant_id, dosage: row.dosage, form: row.form, unit: row.unit })
  }
  return Array.from(byProduct.values())
}

export async function adminCreateProduct(input: {
  name: string
  genericName?: string
  productType: string
  taxRateId: string
  variants: ProductVariantInput[]
}): Promise<string> {
  const { data, error } = await supabase.rpc("admin_create_product", {
    p_name: input.name,
    p_generic_name: input.genericName ?? null,
    p_product_type: input.productType,
    p_tax_rate_id: input.taxRateId,
    p_variants: input.variants,
  })
  if (error) raise(error)
  return data as string
}

export async function adminSetProductTax(productId: string, taxRateId: string): Promise<void> {
  const { error } = await supabase.rpc("admin_set_product_tax", { p_product_id: productId, p_tax_rate_id: taxRateId })
  if (error) raise(error)
}

export async function adminCreateTaxRate(name: string, ratePercentage: number): Promise<string> {
  const { data, error } = await supabase.rpc("admin_create_tax_rate", { p_name: name, p_rate_percentage: ratePercentage })
  if (error) raise(error)
  return data as string
}

// ── Categories ───────────────────────────────────────────────────────────
// Categories are still branch-owned (each branch files its own products
// under its own list, private to that branch) -- these are the super
// admin's oversight view across every branch, plus the ability to push a
// new category out (to one branch, or every branch at once, e.g. a new
// Ministry of Health mandated category).

export interface AdminCategoryRow {
  id: string
  branch_id: string
  branch_name: string
  name: string
  description: string | null
}

export async function adminListCategories(): Promise<AdminCategoryRow[]> {
  const { data, error } = await supabase.rpc("admin_list_categories")
  if (error) raise(error)
  return (data ?? []) as AdminCategoryRow[]
}

// branchId omitted/null => created for every branch that doesn't already
// have it. Returns how many branches actually got a new row.
export async function adminCreateCategory(name: string, description: string, branchId?: string | null): Promise<number> {
  const { data, error } = await supabase.rpc("admin_create_category", {
    p_name: name,
    p_description: description || null,
    p_branch_id: branchId ?? null,
  })
  if (error) raise(error)
  return (data as number) ?? 0
}

// ── Product requests ────────────────────────────────────────────────────
// Deliberately just a message + an optional photo -- the branch describes
// what's missing in their own words rather than filling in a structured
// form; the super admin turns it into a real catalogue entry (with proper
// name/variants/tax) when approving.

export type ProductRequestStatus = "pending" | "approved" | "rejected"

const PRODUCT_REQUEST_IMAGE_BUCKET = "product-requests"

// Uploads to a path namespaced by a fresh random id (not the request id,
// which doesn't exist yet at upload time -- the request is created right
// after, referencing this path). Returns the storage path to pass to
// submitProductRequest, not a URL.
export async function uploadProductRequestImage(file: File): Promise<string> {
  const ext = file.name.includes(".") ? file.name.split(".").pop() : "jpg"
  const path = `${crypto.randomUUID()}.${ext}`
  const { error } = await supabase.storage.from(PRODUCT_REQUEST_IMAGE_BUCKET).upload(path, file)
  if (error) throw new Error(error.message)
  return path
}

export function productRequestImageUrl(path: string): string {
  return supabase.storage.from(PRODUCT_REQUEST_IMAGE_BUCKET).getPublicUrl(path).data.publicUrl
}

export async function submitProductRequest(message: string, imagePath?: string | null): Promise<string> {
  const { data, error } = await supabase.rpc("submit_product_request", {
    p_message: message,
    p_image_path: imagePath ?? null,
  })
  if (error) raise(error)
  return data as string
}

export interface ProductRequestRow {
  id: string
  branch_id: string
  message: string
  image_path: string | null
  status: ProductRequestStatus
  resolved_product_id: string | null
  resolved_variant_id: string | null
  rejection_reason: string | null
  created_at: string
}

// The branch's own requests -- read directly (RLS already scopes this to
// the signed-in branch), used for the StockReceivingPage "your requests" panel.
export async function listMyProductRequests(): Promise<ProductRequestRow[]> {
  const { data, error } = await supabase.from("product_requests").select("*").order("created_at", { ascending: false })
  if (error) raise(error)
  return (data ?? []) as ProductRequestRow[]
}

export interface AdminProductRequestRow extends ProductRequestRow {
  branch_name: string
  requested_by_name: string
}

export async function adminListProductRequests(): Promise<AdminProductRequestRow[]> {
  const { data, error } = await supabase.rpc("admin_list_product_requests")
  if (error) raise(error)
  return (data ?? []) as AdminProductRequestRow[]
}

export async function adminApproveProductRequest(input: {
  requestId: string
  productName: string
  genericName?: string
  productType: string
  taxRateId: string
  variants: ProductVariantInput[]
}): Promise<{ productId: string; variantId: string }> {
  const { data, error } = await supabase.rpc("admin_approve_product_request", {
    p_request_id: input.requestId,
    p_product_name: input.productName,
    p_generic_name: input.genericName ?? null,
    p_product_type: input.productType,
    p_tax_rate_id: input.taxRateId,
    p_variants: input.variants,
  })
  if (error) raise(error)
  const row = Array.isArray(data) ? data[0] : data
  return { productId: row.product_id, variantId: row.variant_id }
}

export async function adminRejectProductRequest(requestId: string, reason: string): Promise<void> {
  const { error } = await supabase.rpc("admin_reject_product_request", { p_request_id: requestId, p_reason: reason })
  if (error) raise(error)
}
