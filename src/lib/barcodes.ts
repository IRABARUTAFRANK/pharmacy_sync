import { supabase } from "./supabase"

// Read-only barcode history for the Barcode Manager screen. Barcodes are only ever
// created server-side by receive_stock_delivery(); nothing here writes.
//
// Loading follows the same shape as loadInventoryDataset(): a handful of parallel
// selects joined in memory, so the page can filter/search client-side without a
// network round-trip per keystroke.

export type BarcodeStatus = "active" | "sold_out" | "expired" | "recalled" | "damaged"
export type BarcodeType = "box" | "pack"

export const BARCODE_STATUSES: BarcodeStatus[] = ["active", "sold_out", "expired", "recalled", "damaged"]

export interface BarcodeRow {
  id: string
  code: string
  barcode_type: BarcodeType
  parent_barcode_id: string | null
  code_source: string
  child_count: number | null
  pieces_per_pack: number | null
  quantity_available: number
  status: BarcodeStatus
  created_at: string
  stock_batch_id: string
  batch_number: string
  expiry_date: string
  delivery_code: string | null
  manufacturer_name: string | null
  received_at: string
  supplier_name: string
  product_name: string
  generic_name: string | null
  variant_label: string
  selling_price: number
  /** Pieces this scannable unit represents. A box is a container, so it counts 0. */
  pieces: number
  /** Everything a client-side substring search should look at. */
  haystack: string
}

export interface BarcodeGroup {
  key: string
  /** "carton" = a box barcode and the pack barcodes inside it. "loose" = packs with no carton. */
  kind: "carton" | "loose"
  parent: BarcodeRow | null
  children: BarcodeRow[]
  productName: string
  variantLabel: string
  batchNumber: string
  deliveryCode: string | null
  supplierName: string
  expiryDate: string
  receivedAt: string
  pieces: number
  statuses: BarcodeStatus[]
}

export interface BarcodeDataset {
  rows: BarcodeRow[]
  groups: BarcodeGroup[]
  statusCounts: Record<BarcodeStatus, number>
  boxCount: number
  packCount: number
  totalPieces: number
}

const asNumber = (value: string | number | null | undefined) => Number(value ?? 0)

export const emptyBarcodeDataset = (): BarcodeDataset => ({
  rows: [],
  groups: [],
  statusCounts: { active: 0, sold_out: 0, expired: 0, recalled: 0, damaged: 0 },
  boxCount: 0,
  packCount: 0,
  totalPieces: 0,
})

export interface DeliveryBarcodeLabel {
  id: string
  code: string
  barcode_type: BarcodeType
  pieces_per_pack: number | null
  child_count: number | null
  product_name: string
  variant_label: string
  batch_number: string
  expiry_date: string
}

// Focused loader for the "print/download this delivery's barcodes" sheet right
// after receiving stock -- deliberately not loadBarcodeDataset(), which fetches
// every barcode the branch has ever generated and does grouping this view
// doesn't need.
export async function loadDeliveryBarcodes(deliveryId: string): Promise<DeliveryBarcodeLabel[]> {
  const { data: batches, error: batchError } = await supabase
    .from("stock_batches")
    .select("id, batch_number, expiry_date, product_variant_id")
    .eq("delivery_id", deliveryId)
  if (batchError) throw batchError
  const batchIds = (batches ?? []).map(batch => batch.id)
  if (batchIds.length === 0) return []

  const [barcodesResult, variantsResult, productsResult] = await Promise.all([
    supabase.from("barcodes").select("id, code, barcode_type, pieces_per_pack, child_count, stock_batch_id").in("stock_batch_id", batchIds).order("code"),
    supabase.from("product_variants").select("id, product_id, dosage, form, unit"),
    supabase.from("products").select("id, name"),
  ])
  if (barcodesResult.error) throw barcodesResult.error
  if (variantsResult.error) throw variantsResult.error
  if (productsResult.error) throw productsResult.error

  const batchById = new Map((batches ?? []).map(batch => [batch.id, batch]))
  const variantById = new Map((variantsResult.data ?? []).map(variant => [variant.id, variant]))
  const productById = new Map((productsResult.data ?? []).map(product => [product.id, product]))

  return (barcodesResult.data ?? []).map(barcode => {
    const batch = batchById.get(barcode.stock_batch_id)
    const variant = batch ? variantById.get(batch.product_variant_id) : undefined
    const product = variant ? productById.get(variant.product_id) : undefined
    return {
      id: barcode.id,
      code: barcode.code,
      barcode_type: barcode.barcode_type as BarcodeType,
      pieces_per_pack: barcode.pieces_per_pack,
      child_count: barcode.child_count,
      product_name: product?.name ?? "Unknown product",
      variant_label: [variant?.dosage, variant?.form, variant?.unit].filter(Boolean).join(" · "),
      batch_number: batch?.batch_number ?? "—",
      expiry_date: batch?.expiry_date ?? "—",
    }
  })
}

export async function loadBarcodeDataset(): Promise<BarcodeDataset> {
  const results = await Promise.all([
    supabase.from("barcodes").select("*").order("code"),
    supabase.from("stock_batches").select("*"),
    supabase.from("product_variants").select("*"),
    supabase.from("products").select("*"),
    supabase.from("suppliers").select("id, supplier_name"),
  ])
  const failed = results.find(result => result.error)
  if (failed?.error) throw failed.error
  const [barcodes, batches, variants, products, suppliers] = results.map(result => result.data ?? []) as any[][]

  const batchById = new Map(batches.map(batch => [batch.id, batch]))
  const variantById = new Map(variants.map(variant => [variant.id, variant]))
  const productById = new Map(products.map(product => [product.id, product]))
  const supplierById = new Map(suppliers.map(supplier => [supplier.id, supplier]))

  const rows: BarcodeRow[] = barcodes.map(barcode => {
    const batch = batchById.get(barcode.stock_batch_id)
    const variant = batch ? variantById.get(batch.product_variant_id) : undefined
    const product = variant ? productById.get(variant.product_id) : undefined
    const supplier = batch ? supplierById.get(batch.supplier_id) : undefined
    const variantLabel = [variant?.dosage, variant?.form, variant?.unit].filter(Boolean).join(" · ")
    const productName = product?.name ?? "Unknown product"
    const batchNumber = batch?.batch_number ?? "—"
    const deliveryCode = batch?.delivery_code ?? null
    const supplierName = supplier?.supplier_name ?? "—"
    // Only leaf pack barcodes carry pieces; a box row's quantity_available means
    // "this carton exists", so counting it would double-count the packs inside.
    const pieces = barcode.barcode_type === "pack"
      ? asNumber(barcode.quantity_available) * asNumber(barcode.pieces_per_pack)
      : 0
    return {
      id: barcode.id,
      code: barcode.code,
      barcode_type: barcode.barcode_type as BarcodeType,
      parent_barcode_id: barcode.parent_barcode_id ?? null,
      code_source: barcode.code_source,
      child_count: barcode.child_count == null ? null : asNumber(barcode.child_count),
      pieces_per_pack: barcode.pieces_per_pack == null ? null : asNumber(barcode.pieces_per_pack),
      quantity_available: asNumber(barcode.quantity_available),
      status: barcode.status as BarcodeStatus,
      created_at: barcode.created_at,
      stock_batch_id: barcode.stock_batch_id,
      batch_number: batchNumber,
      expiry_date: batch?.expiry_date ?? "—",
      delivery_code: deliveryCode,
      manufacturer_name: batch?.manufacturer_name ?? null,
      received_at: batch?.received_at ?? barcode.created_at,
      supplier_name: supplierName,
      product_name: productName,
      generic_name: product?.generic_name ?? null,
      variant_label: variantLabel,
      selling_price: asNumber(batch?.selling_price),
      pieces,
      haystack: `${barcode.code} ${productName} ${product?.generic_name ?? ""} ${variantLabel} ${batchNumber} ${deliveryCode ?? ""} ${supplierName} ${batch?.manufacturer_name ?? ""}`.toLowerCase(),
    }
  })

  const childrenByParent = new Map<string, BarcodeRow[]>()
  for (const row of rows) {
    if (!row.parent_barcode_id) continue
    const bucket = childrenByParent.get(row.parent_barcode_id)
    if (bucket) bucket.push(row)
    else childrenByParent.set(row.parent_barcode_id, [row])
  }

  const groupOf = (parent: BarcodeRow | null, children: BarcodeRow[], key: string, kind: BarcodeGroup["kind"]): BarcodeGroup => {
    const sample = parent ?? children[0]
    const statuses = Array.from(new Set([...(parent ? [parent.status] : []), ...children.map(child => child.status)]))
    return {
      key,
      kind,
      parent,
      children,
      productName: sample.product_name,
      variantLabel: sample.variant_label,
      batchNumber: sample.batch_number,
      deliveryCode: sample.delivery_code,
      supplierName: sample.supplier_name,
      expiryDate: sample.expiry_date,
      receivedAt: sample.received_at,
      pieces: children.reduce((total, child) => total + child.pieces, 0) + (parent?.pieces ?? 0),
      statuses,
    }
  }

  const groups: BarcodeGroup[] = rows
    .filter(row => row.barcode_type === "box")
    .map(box => groupOf(box, childrenByParent.get(box.id) ?? [], box.id, "carton"))

  // Packs with no parent are a simple product received without cartons. They are
  // grouped under their stock batch so the screen stays readable.
  const looseByBatch = new Map<string, BarcodeRow[]>()
  for (const row of rows) {
    if (row.barcode_type !== "pack" || row.parent_barcode_id) continue
    const bucket = looseByBatch.get(row.stock_batch_id)
    if (bucket) bucket.push(row)
    else looseByBatch.set(row.stock_batch_id, [row])
  }
  for (const [batchId, packs] of looseByBatch) groups.push(groupOf(null, packs, `batch-${batchId}`, "loose"))

  groups.sort((a, b) => (b.receivedAt ?? "").localeCompare(a.receivedAt ?? "") || a.key.localeCompare(b.key))

  const statusCounts = { active: 0, sold_out: 0, expired: 0, recalled: 0, damaged: 0 } as Record<BarcodeStatus, number>
  for (const row of rows) if (row.status in statusCounts) statusCounts[row.status] += 1

  return {
    rows,
    groups,
    statusCounts,
    boxCount: rows.filter(row => row.barcode_type === "box").length,
    packCount: rows.filter(row => row.barcode_type === "pack").length,
    totalPieces: rows.reduce((total, row) => total + row.pieces, 0),
  }
}
