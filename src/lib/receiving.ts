import { supabase, branchArg } from "./supabase"

// Reference/lookup data for the receiving wizard. Everything here is loaded once
// when the page mounts and filtered client-side: branch catalogues are small and
// re-querying per keystroke would be wasteful.

export type ProductType = "medicine" | "supply" | "other"

export interface ReceivingProduct {
  id: string
  name: string
  generic_name: string | null
  product_type: ProductType
  tax_rate_name: string
  tax_rate_percentage: number
}

export interface ReceivingVariant {
  id: string
  product_id: string
  dosage: string | null
  form: string | null
  unit: string | null
}

export interface ReceivingCategory {
  id: string
  name: string
}

export interface ReceivingSupplier {
  id: string
  supplier_name: string
}

export interface ReceivingReference {
  products: ReceivingProduct[]
  variants: ReceivingVariant[]
  categories: ReceivingCategory[]
  suppliers: ReceivingSupplier[]
}

// branchId is the org_owner/org_manager "viewing another branch" case (see
// StockReceivingPage's own header note) -- products/variants/tax rates are
// global and unaffected either way, but plain RLS on product_categories/
// suppliers only ever resolves to the CALLER's own branch, no matter which
// branch is actually being viewed. list_branch_categories/list_branch_
// suppliers are the same SECURITY DEFINER pattern used everywhere else in
// this app for that (effective_branch_id(p_branch_id), which itself
// enforces org membership) -- a raw table select has no way to honor an
// explicit "act as this branch" override, only RLS's own fixed notion of
// "your branch".
export async function loadReceivingReference(branchId?: string): Promise<ReceivingReference> {
  const results = await Promise.all([
    supabase.from("products").select("id, name, generic_name, product_type, tax_rate_id").order("name"),
    supabase.from("product_variants").select("id, product_id, dosage, form, unit"),
    supabase.rpc("list_branch_categories", branchArg(branchId)),
    supabase.rpc("list_branch_suppliers", branchArg(branchId)),
    supabase.from("tax_rates").select("id, name, rate_percentage"),
  ])
  const failed = results.find(result => result.error)
  if (failed?.error) throw failed.error
  const [products, variants, categories, suppliers, taxRates] = results.map(result => result.data ?? []) as any[][]
  const taxById = new Map(taxRates.map(row => [row.id, row]))
  return {
    products: products.map(row => {
      const tax = taxById.get(row.tax_rate_id)
      return {
        id: row.id, name: row.name, generic_name: row.generic_name ?? null, product_type: (row.product_type ?? "medicine") as ProductType,
        tax_rate_name: tax?.name ?? "—", tax_rate_percentage: Number(tax?.rate_percentage ?? 0),
      }
    }),
    variants: variants.map(row => ({ id: row.id, product_id: row.product_id, dosage: row.dosage ?? null, form: row.form ?? null, unit: row.unit ?? null })),
    categories: categories.map(row => ({ id: row.id, name: row.name })),
    suppliers: suppliers.map(row => ({ id: row.id, supplier_name: row.supplier_name })),
  }
}

// Get-or-create: if the product already has any variant this just returns
// the first one untouched. Only a product that genuinely has zero variants
// (e.g. a legacy catalogue entry, or one whose only variant was removed)
// gets a single blank one created here -- see ensure_default_product_
// variant() in 2026-09-17_ensure_default_product_variant.sql for why this
// is safe to call more than once for the same product (it never creates a
// second one), unlike the old inline "type a product name, get a product +
// variant created for you" flow this Receiving page used to have, which
// created duplicates and was removed for that reason.
export async function ensureDefaultProductVariant(productId: string): Promise<string> {
  const { data, error } = await supabase.rpc("ensure_default_product_variant", { p_product_id: productId })
  if (error) throw error
  return data as string
}

export interface ProductDefaults {
  categoryName: string | null
  manufacturer: string | null
  costPrice: number | null
  sellingPrice: number | null
  packaging: "simple" | "cartons"
  cartons: number | null
  packsPerCarton: number | null
  piecesPerPack: number | null
}

const emptyDefaults: ProductDefaults = {
  categoryName: null, manufacturer: null, costPrice: null, sellingPrice: null,
  packaging: "simple", cartons: null, packsPerCarton: null, piecesPerPack: null,
}

// Convenience prefill for a known product the branch has received before —
// never for supplier: a product isn't tied to one supplier, so that field is
// deliberately left alone here. Category comes from branch_product_categorization
// (the one locked category for this product at this branch, if it has been
// filed already); everything else comes from the most recent stock_batches row
// for this product (narrowed to variantId when one is already chosen, otherwise
// any variant of the product) and the barcode shape that batch generated.
export async function loadProductDefaults(productId: string, variantId: string): Promise<ProductDefaults> {
  const result = { ...emptyDefaults }

  const categorization = await supabase.from("branch_product_categorization").select("category_id").eq("product_id", productId).maybeSingle()
  if (categorization.error) throw categorization.error
  if (categorization.data?.category_id) {
    const category = await supabase.from("product_categories").select("name").eq("id", categorization.data.category_id).maybeSingle()
    if (category.error) throw category.error
    result.categoryName = category.data?.name ?? null
  }

  let variantIds = variantId ? [variantId] : []
  if (variantIds.length === 0) {
    const variants = await supabase.from("product_variants").select("id").eq("product_id", productId)
    if (variants.error) throw variants.error
    variantIds = (variants.data ?? []).map(row => row.id)
  }
  if (variantIds.length === 0) return result

  const batch = await supabase
    .from("stock_batches")
    .select("id, manufacturer_name, cost_price, selling_price")
    .in("product_variant_id", variantIds)
    .order("received_at", { ascending: false })
    .limit(1)
    .maybeSingle()
  if (batch.error) throw batch.error
  if (!batch.data) return result

  result.manufacturer = batch.data.manufacturer_name
  result.costPrice = batch.data.cost_price == null ? null : Number(batch.data.cost_price)
  result.sellingPrice = batch.data.selling_price == null ? null : Number(batch.data.selling_price)

  const barcodes = await supabase.from("barcodes").select("barcode_type, pieces_per_pack, child_count").eq("stock_batch_id", batch.data.id)
  if (barcodes.error) throw barcodes.error
  const boxes = (barcodes.data ?? []).filter(row => row.barcode_type === "box")
  const packs = (barcodes.data ?? []).filter(row => row.barcode_type === "pack")

  result.packaging = boxes.length > 0 ? "cartons" : "simple"
  result.cartons = boxes.length > 0 ? boxes.length : null
  result.packsPerCarton = boxes[0]?.child_count ?? null
  result.piecesPerPack = packs[0]?.pieces_per_pack ?? null
  return result
}

// One entry of the RPC's p_lines array. Field names mirror the jsonb keys that
// receive_stock_delivery() reads — do not rename them.
//
// product_variant_id is now required: the RPC no longer accepts a bare
// product_name to create a product/variant on the fly (see
// src/lib/products.ts's submitProductRequest for the "product not in the
// catalogue yet" path). quantity_received is deliberately absent: the RPC
// derives it from the packaging numbers, so sending it from the client would
// duplicate a derived fact.
export interface DeliveryLine {
  product_variant_id: string
  category_name?: string
  manufacturer_name?: string
  batch_number: string
  expiry_date: string
  cost_price: number
  selling_price: number
  cartons?: number
  packs_per_carton?: number
  packs?: number
  pieces_per_pack: number
}

export interface DeliveryReceipt {
  delivery_id: string
  delivery_code: string
}

// The server owns the delivery code: it is read back from the RPC result and
// never invented on the client.
export async function receiveStockDelivery(
  supplierName: string,
  notes: string,
  lines: DeliveryLine[],
  branchId?: string,
): Promise<DeliveryReceipt> {
  const payload = lines.map(line =>
    Object.fromEntries(Object.entries(line).filter(([, value]) => value !== undefined && value !== "" && value !== null))
  )
  const { data, error } = await supabase.rpc("receive_stock_delivery", {
    p_supplier_name: supplierName,
    p_notes: notes,
    p_lines: payload,
    ...branchArg(branchId),
  })
  if (error) throw error
  const receipt = (Array.isArray(data) ? data[0] : data) as DeliveryReceipt | undefined
  if (!receipt?.delivery_code) throw new Error("The delivery was saved but no delivery code came back from the server.")
  return { delivery_id: receipt.delivery_id, delivery_code: receipt.delivery_code }
}
