import { supabase } from "./supabase"

export interface InventoryRow {
  product_id: string
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
  stock_status: "ok" | "low" | "zero" | "expiry"
}

export interface InventoryDataset {
  rows: InventoryRow[]
  barcodes: Array<{ id: string; stock_batch_id: string; code: string; barcode_type: string; child_count: number | null; pieces_per_pack: number | null; code_source: string; quantity_available: number; status: string }>
  supplierUnits: Array<{ name: string; units: number }>
}

const asNumber = (value: string | number | null | undefined) => Number(value ?? 0)

export async function loadInventoryDataset(): Promise<InventoryDataset> {
  const results = await Promise.all([
    supabase.from("stock_batches").select("*").order("received_at", { ascending: false }),
    supabase.from("product_variants").select("*"), supabase.from("products").select("*"),
    supabase.from("barcodes").select("*"), supabase.from("suppliers").select("*"),
    supabase.from("reorder_points").select("*"), supabase.from("product_categories").select("*"),
    supabase.from("branch_product_categorization").select("*"), supabase.from("tax_rates").select("*"),
  ])
  const failed = results.find(result => result.error)
  if (failed?.error) throw failed.error
  const [batches, variants, products, barcodes, suppliers, reorderPoints, categories, categorizations, taxRates] = results.map(result => result.data ?? []) as any[][]
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
    const minQuantity = asNumber(reorder?.min_quantity)
    const stockStatus: InventoryRow["stock_status"] = quantityAvailable === 0 || barcodeStatus === "sold_out" ? "zero" : daysToExpiry < 60 || barcodeStatus === "expired" ? "expiry" : quantityAvailable < minQuantity || barcodeStatus === "recalled" || barcodeStatus === "damaged" ? "low" : "ok"
    return { product_id: product?.id ?? "", product_type: product?.product_type ?? "medicine", name: [product?.name, variant?.dosage].filter(Boolean).join(" ") || "Unnamed product", generic_name: product?.generic_name ?? undefined, tax_rate: taxRate ? (asNumber(taxRate.rate_percentage) === 0 ? "Exempt" : `${taxRate.rate_percentage}%`) : "—", variant_id: variant?.id ?? "", dosage: variant?.dosage ?? undefined, form: variant?.form ?? undefined, unit: variant?.unit ?? undefined, category: category?.name ?? "Uncategorised", batch_id: batch.id, batch_number: batch.batch_number, expiry_date: batch.expiry_date, cost_price: asNumber(batch.cost_price), selling_price: asNumber(batch.selling_price), quantity_received: asNumber(batch.quantity_received), received_at: batch.received_at, manufacturer_name: batch.manufacturer_name ?? undefined, delivery_code: batch.delivery_code ?? undefined, supplier_name: supplier?.supplier_name ?? "—", quantity_available: quantityAvailable, barcode_status: barcodeStatus, min_quantity: minQuantity, max_quantity: reorder?.max_quantity == null ? undefined : asNumber(reorder.max_quantity), stock_status: stockStatus }
  })
  const supplierUnits = suppliers.map(supplier => ({ name: supplier.supplier_name.split(" ")[0], units: batches.filter(batch => batch.supplier_id === supplier.id).reduce((total, batch) => total + asNumber(batch.quantity_received), 0) })).filter(item => item.units > 0)
  return { rows, barcodes, supplierUnits }
}
