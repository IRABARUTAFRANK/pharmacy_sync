import { getMyBranchDetails } from "./branch"
import { fetchAllRows, supabase } from "./supabase"

// undefined -> caller's own branch only (today's exact original behavior).
// A single uuid -> that one branch (RLS -- see
// 2026-09-16_org_wide_inventory_read_access.sql -- only actually returns
// rows if the caller is that branch's own user OR an active member of its
// organization; an unauthorized id silently comes back empty, never errors,
// same as every other RLS-enforced read in this codebase).
// An array -> exactly those branches combined ("All branches" org view);
// pass every branch id in the org, not [] (an empty .in() matches nothing).
export type InventoryScope = string | string[] | undefined

export interface InventoryRow {
  product_id: string
  branch_id: string
  product_type: "medicine" | "supply" | "other"
  name: string
  generic_name?: string
  tax_rate: string
  variant_id: string
  dosage?: string
  form?: string
  unit?: string
  category: string
  batch_id: string
  batch_number: string
  expiry_date: string
  cost_price: number
  selling_price: number
  quantity_received: number
  received_at: string
  manufacturer_name?: string
  delivery_code?: string
  supplier_name: string
  quantity_available: number
  barcode_status: string
  min_quantity: number
  max_quantity?: number
  stock_status: "ok" | "low" | "zero" | "expiry" | "over"
}

export interface InventoryDataset {
  rows: InventoryRow[]
  barcodes: Array<{ id: string; stock_batch_id: string; code: string; barcode_type: string; child_count: number | null; pieces_per_pack: number | null; code_source: string; quantity_available: number; status: string }>
  supplierUnits: Array<{ name: string; units: number }>
}

const asNumber = (value: string | number | null | undefined) => Number(value ?? 0)

// stock_batches and barcodes grow without bound over the branch's lifetime
// (barcodes especially -- one row per physical pack/box ever received, so a
// single large delivery alone can produce thousands). Both, plus every
// other table here, are paginated via fetchAllRows() rather than a plain
// .select() -- an unbounded select silently truncates once a branch has
// enough history to exceed PostgREST's row cap, with no error to explain
// why stock or barcodes just stopped showing up.
//
// `scope` narrows every branch-scoped table below to exactly the intended
// branch(es) -- see InventoryScope above. This used to rely purely on RLS
// (branch_id = current_branch_id(), nothing else), which was correct back
// when that was the only row RLS could ever return; now that
// 2026-09-16_org_wide_inventory_read_access.sql lets an org member's RLS
// return every branch in their organization, the client has to do this
// narrowing itself, exactly like every branchArg()-based RPC call already
// does via effective_branch_id() server-side. barcodes has no branch_id
// column of its own (only stock_batch_id), so it's narrowed by first
// resolving which batch ids are in scope, not by its own filter.
export async function loadInventoryDataset(scope?: InventoryScope): Promise<InventoryDataset> {
  const branchFilter = (query: any) => Array.isArray(scope) ? query.in("branch_id", scope) : scope ? query.eq("branch_id", scope) : query
  const [branch, batches, variants, products, suppliers, reorderPoints, categories, categorizations, taxRates] = await Promise.all([
    getMyBranchDetails(typeof scope === "string" ? scope : undefined),
    fetchAllRows<any>((from, to) => branchFilter(supabase.from("stock_batches").select("*")).order("received_at", { ascending: false }).order("id").range(from, to)),
    fetchAllRows<any>((from, to) => supabase.from("product_variants").select("*").order("id").range(from, to)),
    fetchAllRows<any>((from, to) => supabase.from("products").select("*").order("id").range(from, to)),
    fetchAllRows<any>((from, to) => branchFilter(supabase.from("suppliers").select("*")).order("id").range(from, to)),
    fetchAllRows<any>((from, to) => branchFilter(supabase.from("reorder_points").select("*")).order("id").range(from, to)),
    fetchAllRows<any>((from, to) => branchFilter(supabase.from("product_categories").select("*")).order("id").range(from, to)),
    fetchAllRows<any>((from, to) => branchFilter(supabase.from("branch_product_categorization").select("*")).order("product_id").range(from, to)),
    fetchAllRows<any>((from, to) => supabase.from("tax_rates").select("*").order("id").range(from, to)),
  ])
  // barcodes has no branch_id of its own, so it's scoped by the batch ids
  // already resolved above rather than by branchFilter -- an empty `batches`
  // (nothing in scope) would otherwise fall through to an unfiltered
  // .select(), unintentionally returning every barcode RLS allows.
  const batchIds = batches.map(b => b.id)
  const barcodes = batchIds.length === 0 ? [] : await fetchAllRows<any>((from, to) =>
    supabase.from("barcodes").select("*").in("stock_batch_id", batchIds).order("code").range(from, to))
  const expiryThresholdDays = branch.expiryAlertThresholdDays
  const defaultReorderMin = branch.defaultReorderMin
  const today = new Date()
  const rows = batches.map(batch => {
    const variant = variants.find(item => item.id === batch.product_variant_id)
    const product = products.find(item => item.id === variant?.product_id)
    const supplier = suppliers.find(item => item.id === batch.supplier_id)
    const reorder = reorderPoints.find(item => item.product_id === product?.id && item.branch_id === batch.branch_id)
    const categoryLink = categorizations.find(item => item.product_id === product?.id && item.branch_id === batch.branch_id)
    const category = categories.find(item => item.id === categoryLink?.category_id)
    const taxRate = taxRates.find(item => item.id === product?.tax_rate_id)
    const batchBarcodes = barcodes.filter(item => item.stock_batch_id === batch.id)
    // Stock is counted from leaf "pack" barcodes only (quantity_available * pieces_per_pack).
    // A "box" row's quantity_available just means "this carton exists" (always 1) and must
    // not be added on top, or every carton inflates the count by one extra unit.
    const quantityAvailable = batchBarcodes
      .filter(item => item.barcode_type === "pack")
      .reduce((total, item) => total + asNumber(item.quantity_available) * asNumber(item.pieces_per_pack), 0)
    const barcodeStatus = batchBarcodes.find(item => item.barcode_type === "box")?.status ?? batchBarcodes[0]?.status ?? "active"
    const daysToExpiry = Math.ceil((new Date(batch.expiry_date).getTime() - today.getTime()) / 86_400_000)
    const minQuantity = reorder ? asNumber(reorder.min_quantity) : defaultReorderMin
    const maxQuantity = reorder?.max_quantity == null ? undefined : asNumber(reorder.max_quantity)
    // Precedence matters: a batch that is both expiring and overstocked is an
    // expiry problem first. "over" only applies when a maximum has actually
    // been set for the product -- an unset maximum means "no ceiling", not 0.
    const stockStatus: InventoryRow["stock_status"] =
      quantityAvailable === 0 || barcodeStatus === "sold_out" ? "zero"
      : daysToExpiry < expiryThresholdDays || barcodeStatus === "expired" ? "expiry"
      : quantityAvailable < minQuantity || barcodeStatus === "recalled" || barcodeStatus === "damaged" ? "low"
      : maxQuantity != null && maxQuantity > 0 && quantityAvailable > maxQuantity ? "over"
      : "ok"
    return { product_id: product?.id ?? "", branch_id: batch.branch_id, product_type: product?.product_type ?? "medicine", name: [product?.name, variant?.dosage].filter(Boolean).join(" ") || "Unnamed product", generic_name: product?.generic_name ?? undefined, tax_rate: taxRate ? (asNumber(taxRate.rate_percentage) === 0 ? "Exempt" : `${taxRate.rate_percentage}%`) : "—", variant_id: variant?.id ?? "", dosage: variant?.dosage ?? undefined, form: variant?.form ?? undefined, unit: variant?.unit ?? undefined, category: category?.name ?? "Uncategorised", batch_id: batch.id, batch_number: batch.batch_number, expiry_date: batch.expiry_date, cost_price: asNumber(batch.cost_price), selling_price: asNumber(batch.selling_price), quantity_received: asNumber(batch.quantity_received), received_at: batch.received_at, manufacturer_name: batch.manufacturer_name ?? undefined, delivery_code: batch.delivery_code ?? undefined, supplier_name: supplier?.supplier_name ?? "—", quantity_available: quantityAvailable, barcode_status: barcodeStatus, min_quantity: minQuantity, max_quantity: maxQuantity, stock_status: stockStatus }
  })
  const supplierUnits = suppliers.map(supplier => ({ name: supplier.supplier_name, units: batches.filter(batch => batch.supplier_id === supplier.id).reduce((total, batch) => total + asNumber(batch.quantity_received), 0) })).filter(item => item.units > 0)
  return { rows, barcodes, supplierUnits }
}

// Stock levels for a product at a branch: min_quantity is the level that
// flags "Low stock" (time to order a delivery), max_quantity the level above
// which it flags "Overstocked". public.reorder_points already has full RLS +
// grants scoped to the signed-in branch (branch_id = current_branch_id()), so
// this writes directly rather than through an RPC. unique(product_id,
// branch_id) is what makes the upsert idempotent -- one row per product per
// branch.
export async function upsertStockLevels(productId: string, branchId: string, minQuantity: number, maxQuantity: number | null): Promise<void> {
  const { error } = await supabase
    .from("reorder_points")
    .upsert({ product_id: productId, branch_id: branchId, min_quantity: minQuantity, max_quantity: maxQuantity }, { onConflict: "product_id,branch_id" })
  if (error) throw error
}
