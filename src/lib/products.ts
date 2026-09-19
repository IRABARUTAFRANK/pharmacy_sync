import { supabase } from "./supabase"
import { supabaseAdmin } from "./supabaseAdmin"

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

// Same read, but for the admin console specifically -- see supabaseAdmin.ts's
// own header for why #admin runs on a second, independent client with its
// own auth session. The super admin is never signed in on the REGULAR
// client (only branch users are), so listTaxRates() above -- which reads
// via that regular client -- silently sees an anonymous session there: RLS
// ("tax rates readable" ... to authenticated) then filters every row out
// with no error, leaving the admin console's tax-rate dropdowns permanently
// empty. adminListProducts/adminCreateCategory etc. already avoid this by
// using supabaseAdmin; this is that same fix applied to tax rates.
export async function adminListTaxRates(): Promise<TaxRate[]> {
  const { data, error } = await supabaseAdmin.from("tax_rates").select("id, name, rate_percentage").order("rate_percentage")
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
//
// PostgREST caps a single response at 1000 rows, including a set-returning
// RPC like this one -- with a real price-list import in the catalogue this
// easily passes that, so it's paged via .range() (the function's own ORDER BY
// on p.name, pv.dosage gives a stable order to page against) rather than a
// single unbounded call that would silently drop products past the cutoff.
const ADMIN_LIST_PRODUCTS_PAGE = 1000

export async function adminListProducts(): Promise<AdminProduct[]> {
  const rows: AdminProductRow[] = []
  for (let page = 0; ; page++) {
    const { data, error } = await supabaseAdmin
      .rpc("admin_list_products")
      .range(page * ADMIN_LIST_PRODUCTS_PAGE, page * ADMIN_LIST_PRODUCTS_PAGE + ADMIN_LIST_PRODUCTS_PAGE - 1)
    if (error) raise(error)
    const batch = (data ?? []) as AdminProductRow[]
    rows.push(...batch)
    if (batch.length < ADMIN_LIST_PRODUCTS_PAGE) break
  }
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
  const { data, error } = await supabaseAdmin.rpc("admin_create_product", {
    p_name: input.name,
    p_generic_name: input.genericName ?? null,
    p_product_type: input.productType,
    p_tax_rate_id: input.taxRateId,
    p_variants: input.variants,
  })
  if (error) raise(error)
  return data as string
}

// General catalog import (admin_import_product_catalog, see
// 2026-09-18_admin_product_catalog_import.sql) -- a file that isn't tied to
// any one insurer, for medicines every branch should have regardless of
// insurance coverage. Same idempotent upsert as the insurance price-list
// import (src/lib/sales.ts's adminImportInsurancePriceList), just no
// provider/price involved. Rows come from the same buildImportPreview()
// (src/lib/insuranceImport.ts) called with requirePrice: false.
export interface CatalogImportRow {
  drugCode: string
  productType: "medicine" | "supply"
  productName: string
  genericName: string | null
  dosage: string | null
  form: string
  unit: string
}

export interface CatalogImportResult {
  createdProducts: number
  updatedProducts: number
  createdVariants: number
  reusedVariants: number
}

export async function adminImportProductCatalog(taxRateId: string, rows: CatalogImportRow[]): Promise<CatalogImportResult> {
  const { data, error } = await supabaseAdmin.rpc("admin_import_product_catalog", {
    p_tax_rate_id: taxRateId,
    p_rows: rows.map(r => ({
      drugCode: r.drugCode, productType: r.productType, productName: r.productName, genericName: r.genericName,
      dosage: r.dosage, form: r.form, unit: r.unit,
    })),
  })
  if (error) raise(error)
  const row = (Array.isArray(data) ? data[0] : data) as any
  return {
    createdProducts: Number(row.created_products), updatedProducts: Number(row.updated_products),
    createdVariants: Number(row.created_variants), reusedVariants: Number(row.reused_variants),
  }
}

export async function adminSetProductTax(productId: string, taxRateId: string): Promise<void> {
  const { error } = await supabaseAdmin.rpc("admin_set_product_tax", { p_product_id: productId, p_tax_rate_id: taxRateId })
  if (error) raise(error)
}

export async function adminCreateTaxRate(name: string, ratePercentage: number): Promise<string> {
  const { data, error } = await supabaseAdmin.rpc("admin_create_tax_rate", { p_name: name, p_rate_percentage: ratePercentage })
  if (error) raise(error)
  return data as string
}

// ── Categories ───────────────────────────────────────────────────────────
// Each row here is still one (branch, category name) pair -- product_
// categories itself is unchanged -- but since 2026-09-18_organization_
// shared_categories.sql, creating one for a branch mirrors it to every
// sibling branch in the same organization, so in practice an org's
// branches converge on one shared list rather than staying independently
// private the way this used to work. This is the super admin's oversight
// view across every branch/organization on the platform, plus the ability
// to push a new category out (to one branch, or every branch at once, e.g.
// a new Ministry of Health mandated category).

export interface AdminCategoryRow {
  id: string
  branch_id: string
  branch_name: string
  organization_id: string | null
  organization_name: string | null
  name: string
  description: string | null
}

export async function adminListCategories(): Promise<AdminCategoryRow[]> {
  const { data, error } = await supabaseAdmin.rpc("admin_list_categories")
  if (error) raise(error)
  return (data ?? []) as AdminCategoryRow[]
}

// branchId omitted/null => created for every branch that doesn't already
// have it. Returns how many branches actually got a new row.
export async function adminCreateCategory(name: string, description: string, branchId?: string | null): Promise<number> {
  const { data, error } = await supabaseAdmin.rpc("admin_create_category", {
    p_name: name,
    p_description: description || null,
    p_branch_id: branchId ?? null,
  })
  if (error) raise(error)
  return (data as number) ?? 0
}

// "Push to every branch" (adminCreateCategory with no branchId) only ever
// reaches branches that exist at that exact moment -- a branch onboarded
// afterward never retroactively gets categories that were broadcast before
// it existed. This tops up every branch with every category name that
// exists for at least one branch today, safe to call repeatedly (existing
// rows are never touched). Returns how many new rows were actually added.
export async function adminBackfillCategoriesToAllBranches(): Promise<number> {
  const { data, error } = await supabaseAdmin.rpc("admin_backfill_categories_to_all_branches")
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
  const { data, error } = await supabaseAdmin.rpc("admin_list_product_requests")
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
  const { data, error } = await supabaseAdmin.rpc("admin_approve_product_request", {
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
  const { error } = await supabaseAdmin.rpc("admin_reject_product_request", { p_request_id: requestId, p_reason: reason })
  if (error) raise(error)
}
