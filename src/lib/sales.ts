import { supabase } from "./supabase"
import { listTaxRates, type TaxRate } from "./products"

function raise(error: { message: string } | null, fallback: string): never {
  throw new Error(error?.message ?? fallback)
}

// ── Insurance providers (read side — used by the Sales POS and the admin console) ─

export interface InsuranceProvider {
  id: string
  name: string
  defaultCoveragePercentage: number
  contactInfo: string | null
}

export async function loadInsuranceProviders(): Promise<InsuranceProvider[]> {
  const { data, error } = await supabase.from("insurance_providers").select("id, name, default_coverage_percentage, contact_info").order("name")
  if (error) raise(error, "Could not load insurance providers.")
  return (data ?? []).map(row => ({
    id: row.id, name: row.name, defaultCoveragePercentage: Number(row.default_coverage_percentage), contactInfo: row.contact_info,
  }))
}

// Per-product exceptions for one provider, keyed by product_id. A product with
// no entry here uses the provider's default_coverage_percentage — see the
// insurance_product_coverage table comment ("a row existing here IS the
// differs-from-default flag").
export async function loadCoverageOverrides(providerId: string): Promise<Map<string, number>> {
  const { data, error } = await supabase.from("insurance_product_coverage").select("product_id, coverage_percentage").eq("insurance_provider_id", providerId)
  if (error) raise(error, "Could not load this provider's coverage overrides.")
  return new Map((data ?? []).map(row => [row.product_id as string, Number(row.coverage_percentage)]))
}

export function effectiveCoveragePercentage(provider: InsuranceProvider, overrides: Map<string, number>, productId: string): number {
  const override = overrides.get(productId)
  return override === undefined ? provider.defaultCoveragePercentage : override
}

// ── Branch-side claims (what each insurer owes this branch) ────────────────
// insurance_claims is one row per sale that used insurance (see complete_sale()).
// RLS already scopes a plain select to the caller's own branch (or super admin),
// via the sales.branch_id join in the "insurance claims branch access" policy —
// no branch_id filter needed here, same pattern as getSaleReceipt()/listSaleHistory().

export type InsuranceClaimStatus = "submitted" | "approved" | "rejected" | "paid"

export interface BranchInsuranceClaim {
  id: string
  providerId: string
  coveragePercentageApplied: number
  claimAmount: number
  status: InsuranceClaimStatus
  submittedAt: string
}

export async function loadBranchInsuranceClaims(): Promise<BranchInsuranceClaim[]> {
  const { data, error } = await supabase
    .from("insurance_claims")
    .select("id, insurance_provider_id, coverage_percentage_applied, claim_amount, status, submitted_at")
    .order("submitted_at", { ascending: false })
  if (error) raise(error, "Could not load insurance claims.")
  return (data ?? []).map(row => ({
    id: row.id, providerId: row.insurance_provider_id, coveragePercentageApplied: Number(row.coverage_percentage_applied),
    claimAmount: Number(row.claim_amount), status: row.status as InsuranceClaimStatus, submittedAt: row.submitted_at,
  }))
}

export interface CoverageOverrideRow {
  productId: string
  productName: string
  coveragePercentage: number
}

// Same data as loadCoverageOverrides, but with the product name joined in —
// for the admin console's override list and the branch-facing read-only
// Insurance page, neither of which wants to show a bare uuid.
export async function loadCoverageOverridesWithNames(providerId: string): Promise<CoverageOverrideRow[]> {
  const { data, error } = await supabase.from("insurance_product_coverage").select("product_id, coverage_percentage, products(name)").eq("insurance_provider_id", providerId).order("product_id")
  if (error) raise(error, "Could not load this provider's coverage overrides.")
  return (data ?? []).map((row: any) => ({
    productId: row.product_id, productName: row.products?.name ?? "Unknown product", coveragePercentage: Number(row.coverage_percentage),
  }))
}

// ── Admin: manage providers and per-product overrides ──────────────────────

export async function adminCreateInsuranceProvider(name: string, defaultCoveragePercentage: number, contactInfo?: string): Promise<string> {
  const { data, error } = await supabase.rpc("admin_create_insurance_provider", {
    p_name: name, p_default_coverage_percentage: defaultCoveragePercentage, p_contact_info: contactInfo || null,
  })
  if (error) raise(error, "Could not create this insurance provider.")
  return data as string
}

export async function adminUpdateInsuranceProvider(providerId: string, name: string, defaultCoveragePercentage: number, contactInfo?: string): Promise<void> {
  const { error } = await supabase.rpc("admin_update_insurance_provider", {
    p_provider_id: providerId, p_name: name, p_default_coverage_percentage: defaultCoveragePercentage, p_contact_info: contactInfo || null,
  })
  if (error) raise(error, "Could not update this insurance provider.")
}

// pass 0 to mark a product as not covered at all — still a real override row,
// not a special case (matches the table's own design).
export async function adminSetInsuranceCoverage(providerId: string, productId: string, coveragePercentage: number): Promise<void> {
  const { error } = await supabase.rpc("admin_set_insurance_coverage", { p_provider_id: providerId, p_product_id: productId, p_coverage_percentage: coveragePercentage })
  if (error) raise(error, "Could not set coverage for this product.")
}

export async function adminClearInsuranceCoverage(providerId: string, productId: string): Promise<void> {
  const { error } = await supabase.rpc("admin_clear_insurance_coverage", { p_provider_id: providerId, p_product_id: productId })
  if (error) raise(error, "Could not clear this product's coverage override.")
}

// ── Sales POS: scan → cart ──────────────────────────────────────────────────

export interface ScannedBarcode {
  barcodeId: string
  code: string
  barcodeType: "box" | "pack"
  status: string
  quantityAvailable: number
  // For a pack: pieces still inside this pack. Null for cartons.
  piecesPerPack: number | null
  // Carton-only: pieces in a full (untouched) child pack. Null for packs.
  childPiecesPerPack: number | null
  // Carton-only: how many child packs are still sellable inside this carton.
  activeChildCount: number | null
  productId: string
  productName: string
  dosage: string | null
  form: string | null
  manufacturerName: string | null
  sellingPrice: number
  taxRateId: string
  taxRatePercentage: number
  batchNumber: string
  expiryDate: string
}

const STATUS_MESSAGE: Record<string, string> = {
  sold_out: "This pack has already been sold.",
  expired: "This pack has expired and cannot be sold.",
  recalled: "This pack has been recalled and cannot be sold.",
  damaged: "This pack is marked damaged and cannot be sold.",
}

// Verifies that a barcode's unique code retrieves the product's full info from
// the database — the same lookup_barcode() RPC the receiving/barcode pages
// use, extended with product_id/tax_rate_id so a sale can price and apply
// insurance without a second round trip. Accepts both packs and cartons; the
// caller (SalesPage) picks the sell mode based on barcode_type.
export async function scanBarcode(code: string, taxRates?: TaxRate[]): Promise<ScannedBarcode> {
  const trimmed = code.trim()
  if (!trimmed) throw new Error("Scan or type a barcode.")
  const [lookup, rates] = await Promise.all([
    supabase.rpc("lookup_barcode", { p_code: trimmed }),
    taxRates ? Promise.resolve(taxRates) : listTaxRates(),
  ])
  if (lookup.error) raise(lookup.error, "Could not look up this barcode.")
  const row = Array.isArray(lookup.data) ? lookup.data[0] : lookup.data
  if (!row) throw new Error(`No product is linked to barcode "${trimmed}".`)
  if (row.barcode_type !== "pack" && row.barcode_type !== "box") {
    throw new Error(`Barcode "${trimmed}" is not sellable.`)
  }
  if (row.status !== "active") throw new Error(STATUS_MESSAGE[row.status as string] ?? `This barcode is ${row.status} and cannot be sold.`)
  if (row.barcode_type === "pack" && (!row.quantity_available || row.quantity_available < 1)) {
    throw new Error("This pack has already been sold.")
  }
  if (row.barcode_type === "box" && (!row.active_child_count || row.active_child_count < 1)) {
    throw new Error("This carton has no packs left to sell.")
  }

  const taxRate = rates.find(r => r.id === row.tax_rate_id)
  return {
    barcodeId: row.barcode_id, code: row.code, barcodeType: row.barcode_type, status: row.status,
    quantityAvailable: row.quantity_available, piecesPerPack: row.pieces_per_pack,
    childPiecesPerPack: row.child_pieces_per_pack ?? null,
    activeChildCount: row.active_child_count ?? null,
    productId: row.product_id, productName: row.product_name, dosage: row.dosage, form: row.form,
    manufacturerName: row.manufacturer_name, sellingPrice: Number(row.selling_price),
    taxRateId: row.tax_rate_id, taxRatePercentage: Number(taxRate?.rate_percentage ?? 0),
    batchNumber: row.batch_number, expiryDate: row.expiry_date,
  }
}

// ── Completing a sale ────────────────────────────────────────────────────────

export interface CompleteSaleResult {
  saleId: string
  receiptNumber: string
  totalAmount: number
  insuranceCoveredTotal: number
  patientOwedTotal: number
}

export type SellMode = "whole" | "packs" | "pieces"

export interface SaleLineInput {
  code: string
  // Interpretation depends on the scanned barcode's type:
  //  * pack   + "whole"   → sell the whole pack (quantity ignored)
  //  * pack   + "pieces"  → sell `quantity` loose pieces from the pack
  //  * carton + "whole"   → sell every remaining child pack (quantity ignored)
  //  * carton + "packs"   → sell `quantity` child packs from the carton
  //  * carton + "pieces"  → open one child pack, sell `quantity` pieces
  sellMode: SellMode
  quantity: number | null
}

// The one and only way a sale is written: complete_sale() re-validates and
// re-locks every barcode server-side (never trust the client's cached scan),
// so this is the sole source of truth for what actually got sold and for how
// much — the cart on screen is only ever a preview of this.
export async function completeSale(lines: SaleLineInput[], insuranceProviderId: string | null, patientId: string | null = null): Promise<CompleteSaleResult> {
  if (lines.length === 0) throw new Error("Scan at least one item before completing the sale.")
  const { data, error } = await supabase.rpc("complete_sale", {
    p_lines: lines.map(line => ({
      code: line.code,
      sell_mode: line.sellMode,
      quantity: line.quantity,
    })),
    p_insurance_provider_id: insuranceProviderId,
    p_patient_id: patientId,
  })
  if (error) raise(error, "Could not complete this sale.")
  const row = Array.isArray(data) ? data[0] : data
  return {
    saleId: row.sale_id, receiptNumber: row.receipt_number, totalAmount: Number(row.total_amount),
    insuranceCoveredTotal: Number(row.insurance_covered_total), patientOwedTotal: Number(row.patient_owed_total),
  }
}

// ── Receipts — printable and stored, reread from the database (not from the
// client's in-memory cart) so a reprint from history is byte-for-byte the
// same record as the one shown right after the sale ─────────────────────────

export interface ReceiptItem {
  code: string
  productName: string
  dosage: string | null
  form: string | null
  quantity: number
  unitPrice: number
  subtotal: number
  taxRatePercentage: number
  taxAmount: number
  insuranceCovered: number
  patientOwed: number
}

export interface ReceiptData {
  saleId: string
  receiptNumber: string
  issuedAt: string
  branchName: string
  branchTin: string | null
  branchAddress: string | null
  branchPhone: string | null
  branchLogoUrl: string | null
  branchBankAccountNumber: string | null
  branchBankAccountName: string | null
  branchMomoPayNumber: string | null
  cashierName: string
  patientName: string | null
  patientGender: string | null
  patientAge: number | null
  patientContact: string | null
  insuranceProviderName: string | null
  items: ReceiptItem[]
  subtotal: number
  taxTotal: number
  insuranceCoveredTotal: number
  patientOwedTotal: number
  grandTotal: number
}

export async function getSaleReceipt(saleId: string): Promise<ReceiptData> {
  const [saleRes, receiptRes, itemsRes, claimRes] = await Promise.all([
    supabase.from("sales").select("id, branch_id, cashier_id, patient_id, total_amount, sold_at").eq("id", saleId).maybeSingle(),
    supabase.from("receipts").select("receipt_number, issued_at").eq("sale_id", saleId).maybeSingle(),
    supabase.from("sale_items").select("barcode_id, tax_rate_id, quantity, unit_price, subtotal, insurance_covered_amount").eq("sale_id", saleId),
    supabase.from("insurance_claims").select("insurance_provider_id").eq("sale_id", saleId).maybeSingle(),
  ])
  if (saleRes.error) raise(saleRes.error, "Could not load this sale.")
  if (receiptRes.error) raise(receiptRes.error, "Could not load this receipt.")
  if (itemsRes.error) raise(itemsRes.error, "Could not load this sale's items.")
  if (!saleRes.data || !receiptRes.data) throw new Error("This sale or its receipt could not be found.")

  const items = itemsRes.data ?? []
  const barcodeIds = items.map(i => i.barcode_id)
  const taxRateIds = Array.from(new Set(items.map(i => i.tax_rate_id)))

  const [branchRes, cashierRes, barcodesRes, taxRatesRes, providerRes, patientRes] = await Promise.all([
    supabase.from("branches").select("name, tin, address, phone, logo_path, bank_account_number, bank_account_name, momo_pay_number").eq("id", saleRes.data.branch_id).maybeSingle(),
    supabase.from("users").select("full_name").eq("id", saleRes.data.cashier_id).maybeSingle(),
    barcodeIds.length ? supabase.from("barcodes").select("id, code, stock_batch_id").in("id", barcodeIds) : Promise.resolve({ data: [], error: null }),
    taxRateIds.length ? supabase.from("tax_rates").select("id, rate_percentage").in("id", taxRateIds) : Promise.resolve({ data: [], error: null }),
    claimRes.data?.insurance_provider_id
      ? supabase.from("insurance_providers").select("name").eq("id", claimRes.data.insurance_provider_id).maybeSingle()
      : Promise.resolve({ data: null, error: null }),
    saleRes.data.patient_id
      ? supabase.from("patients").select("full_name, gender, age, tin_or_phone").eq("id", saleRes.data.patient_id).maybeSingle()
      : Promise.resolve({ data: null, error: null }),
  ])
  if (branchRes.error) raise(branchRes.error, "Could not load the branch for this receipt.")
  if (barcodesRes.error) raise(barcodesRes.error, "Could not load the items sold in this sale.")
  if (taxRatesRes.error) raise(taxRatesRes.error, "Could not load tax rates for this receipt.")

  const stockBatchIds = Array.from(new Set((barcodesRes.data ?? []).map((b: any) => b.stock_batch_id)))
  const batchesRes = stockBatchIds.length
    ? await supabase.from("stock_batches").select("id, product_variant_id").in("id", stockBatchIds)
    : { data: [], error: null }
  if (batchesRes.error) raise(batchesRes.error, "Could not load batch details for this receipt.")

  const variantIds = Array.from(new Set((batchesRes.data ?? []).map((b: any) => b.product_variant_id)))
  const variantsRes = variantIds.length
    ? await supabase.from("product_variants").select("id, product_id, dosage, form").in("id", variantIds)
    : { data: [], error: null }
  if (variantsRes.error) raise(variantsRes.error, "Could not load product details for this receipt.")

  const productIds = Array.from(new Set((variantsRes.data ?? []).map((v: any) => v.product_id)))
  const productsRes = productIds.length
    ? await supabase.from("products").select("id, name").in("id", productIds)
    : { data: [], error: null }
  if (productsRes.error) raise(productsRes.error, "Could not load product names for this receipt.")

  const barcodeById = new Map((barcodesRes.data ?? []).map((b: any) => [b.id, b]))
  const batchById = new Map((batchesRes.data ?? []).map((b: any) => [b.id, b]))
  const variantById = new Map((variantsRes.data ?? []).map((v: any) => [v.id, v]))
  const productById = new Map((productsRes.data ?? []).map((p: any) => [p.id, p]))
  const taxRateById = new Map((taxRatesRes.data ?? []).map((t: any) => [t.id, t]))

  const receiptItems: ReceiptItem[] = items.map(item => {
    const barcode = barcodeById.get(item.barcode_id) as any
    const batch = barcode ? batchById.get(barcode.stock_batch_id) as any : null
    const variant = batch ? variantById.get(batch.product_variant_id) as any : null
    const product = variant ? productById.get(variant.product_id) as any : null
    const taxRate = taxRateById.get(item.tax_rate_id) as any
    const subtotal = Number(item.subtotal)
    const taxAmount = Math.round(subtotal * Number(taxRate?.rate_percentage ?? 0)) / 100
    const insuranceCovered = Number(item.insurance_covered_amount)
    return {
      code: barcode?.code ?? "—", productName: product?.name ?? "Unknown product", dosage: variant?.dosage ?? null, form: variant?.form ?? null,
      quantity: item.quantity, unitPrice: Number(item.unit_price), subtotal, taxRatePercentage: Number(taxRate?.rate_percentage ?? 0),
      taxAmount, insuranceCovered, patientOwed: subtotal + taxAmount - insuranceCovered,
    }
  })

  const subtotal = receiptItems.reduce((sum, i) => sum + i.subtotal, 0)
  const taxTotal = receiptItems.reduce((sum, i) => sum + i.taxAmount, 0)
  const insuranceCoveredTotal = receiptItems.reduce((sum, i) => sum + i.insuranceCovered, 0)

  const patient = patientRes.data as any
  const branchRow = branchRes.data as any
  const logoPath: string | null = branchRow?.logo_path ?? null

  return {
    saleId, receiptNumber: receiptRes.data.receipt_number, issuedAt: receiptRes.data.issued_at,
    branchName: branchRow?.name ?? "—",
    branchTin: branchRow?.tin ?? null, branchAddress: branchRow?.address ?? null, branchPhone: branchRow?.phone ?? null,
    branchLogoUrl: logoPath ? supabase.storage.from("branch-logos").getPublicUrl(logoPath).data.publicUrl : null,
    branchBankAccountNumber: branchRow?.bank_account_number ?? null, branchBankAccountName: branchRow?.bank_account_name ?? null,
    branchMomoPayNumber: branchRow?.momo_pay_number ?? null,
    cashierName: cashierRes.data?.full_name ?? "—",
    patientName: patient?.full_name ?? null, patientGender: patient?.gender ?? null, patientAge: patient?.age ?? null, patientContact: patient?.tin_or_phone ?? null,
    insuranceProviderName: (providerRes.data as any)?.name ?? null,
    items: receiptItems, subtotal, taxTotal, insuranceCoveredTotal,
    patientOwedTotal: subtotal + taxTotal - insuranceCoveredTotal, grandTotal: subtotal + taxTotal,
  }
}

// ── Sale history ─────────────────────────────────────────────────────────────

export interface SaleHistoryRow {
  saleId: string
  receiptNumber: string
  soldAt: string
  totalAmount: number
  cashierName: string
  patientId: string | null
  patientName: string | null
  insuranceProviderName: string | null
  itemCount: number
}

// patientId, when given, narrows to one patient's own visit history -- the
// same query PatientsPage uses to answer "what did they buy last time,"
// reused rather than duplicated.
export async function listSaleHistory(limit = 100, patientId?: string): Promise<SaleHistoryRow[]> {
  let query = supabase.from("sales").select("id, cashier_id, patient_id, total_amount, sold_at").order("sold_at", { ascending: false }).limit(limit)
  if (patientId) query = query.eq("patient_id", patientId)
  const salesRes = await query
  if (salesRes.error) raise(salesRes.error, "Could not load sales history.")
  const sales = salesRes.data ?? []
  if (sales.length === 0) return []

  const saleIds = sales.map(s => s.id)
  const cashierIds = Array.from(new Set(sales.map(s => s.cashier_id)))
  const patientIds = Array.from(new Set(sales.map(s => s.patient_id).filter((id): id is string => !!id)))

  const [receiptsRes, itemsRes, claimsRes, cashiersRes, patientsRes] = await Promise.all([
    supabase.from("receipts").select("sale_id, receipt_number").in("sale_id", saleIds),
    supabase.from("sale_items").select("sale_id").in("sale_id", saleIds),
    supabase.from("insurance_claims").select("sale_id, insurance_provider_id").in("sale_id", saleIds),
    supabase.from("users").select("id, full_name").in("id", cashierIds),
    patientIds.length ? supabase.from("patients").select("id, full_name").in("id", patientIds) : Promise.resolve({ data: [], error: null }),
  ])
  if (receiptsRes.error) raise(receiptsRes.error, "Could not load receipts.")
  if (itemsRes.error) raise(itemsRes.error, "Could not load sale items.")
  if (claimsRes.error) raise(claimsRes.error, "Could not load insurance claims.")
  if (cashiersRes.error) raise(cashiersRes.error, "Could not load cashier names.")
  if (patientsRes.error) raise(patientsRes.error, "Could not load patient names.")

  const providerIds = Array.from(new Set((claimsRes.data ?? []).map(c => c.insurance_provider_id)))
  const providersRes = providerIds.length
    ? await supabase.from("insurance_providers").select("id, name").in("id", providerIds)
    : { data: [], error: null }
  if (providersRes.error) raise(providersRes.error, "Could not load insurance providers.")

  const receiptBySale = new Map((receiptsRes.data ?? []).map(r => [r.sale_id, r.receipt_number]))
  const claimBySale = new Map((claimsRes.data ?? []).map(c => [c.sale_id, c.insurance_provider_id]))
  const providerById = new Map((providersRes.data ?? []).map((p: any) => [p.id, p.name]))
  const cashierById = new Map((cashiersRes.data ?? []).map(u => [u.id, u.full_name]))
  const patientById = new Map((patientsRes.data ?? []).map((p: any) => [p.id, p.full_name]))
  const itemCountBySale = new Map<string, number>()
  for (const item of itemsRes.data ?? []) itemCountBySale.set(item.sale_id, (itemCountBySale.get(item.sale_id) ?? 0) + 1)

  return sales.map(s => ({
    saleId: s.id, receiptNumber: receiptBySale.get(s.id) ?? "—", soldAt: s.sold_at, totalAmount: Number(s.total_amount),
    cashierName: cashierById.get(s.cashier_id) ?? "—",
    patientId: s.patient_id, patientName: s.patient_id ? patientById.get(s.patient_id) ?? null : null,
    insuranceProviderName: (() => { const pid = claimBySale.get(s.id); return pid ? providerById.get(pid) ?? null : null })(),
    itemCount: itemCountBySale.get(s.id) ?? 0,
  }))
}
