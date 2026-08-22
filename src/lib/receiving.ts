import { supabase } from "./supabase"

// Reference/lookup data for the receiving wizard. Everything here is loaded once
// when the page mounts and filtered client-side: branch catalogues are small and
// re-querying per keystroke would be wasteful.

export type ProductType = "medicine" | "supply" | "other"

export interface ReceivingProduct {
  id: string
  name: string
  generic_name: string | null
  product_type: ProductType
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

export async function loadReceivingReference(): Promise<ReceivingReference> {
  const results = await Promise.all([
    supabase.from("products").select("id, name, generic_name, product_type").order("name"),
    supabase.from("product_variants").select("id, product_id, dosage, form, unit"),
    // product_categories is branch-owned and RLS already restricts it to this branch.
    supabase.from("product_categories").select("*").order("name"),
    // RLS returns the global (branch_id null) rows plus this branch's own rows.
    supabase.from("suppliers").select("id, supplier_name").order("supplier_name"),
  ])
  const failed = results.find(result => result.error)
  if (failed?.error) throw failed.error
  const [products, variants, categories, suppliers] = results.map(result => result.data ?? []) as any[][]
  return {
    products: products.map(row => ({ id: row.id, name: row.name, generic_name: row.generic_name ?? null, product_type: (row.product_type ?? "medicine") as ProductType })),
    variants: variants.map(row => ({ id: row.id, product_id: row.product_id, dosage: row.dosage ?? null, form: row.form ?? null, unit: row.unit ?? null })),
    categories: categories.map(row => ({ id: row.id, name: row.name })),
    suppliers: suppliers.map(row => ({ id: row.id, supplier_name: row.supplier_name })),
  }
}

// One entry of the RPC's p_lines array. Field names mirror the jsonb keys that
// receive_stock_delivery() reads — do not rename them.
//
// A line is EITHER an existing product_variant_id OR a new product_name (plus the
// optional descriptors the RPC uses to create/reuse the variant), never both.
// quantity_received is deliberately absent: the RPC derives it from the packaging
// numbers, so sending it from the client would duplicate a derived fact.
export interface DeliveryLine {
  product_variant_id?: string
  product_name?: string
  product_type?: ProductType
  generic_name?: string
  dosage?: string
  form?: string
  unit?: string
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
): Promise<DeliveryReceipt> {
  const payload = lines.map(line =>
    Object.fromEntries(Object.entries(line).filter(([, value]) => value !== undefined && value !== "" && value !== null))
  )
  const { data, error } = await supabase.rpc("receive_stock_delivery", {
    p_supplier_name: supplierName,
    p_notes: notes,
    p_lines: payload,
  })
  if (error) throw error
  const receipt = (Array.isArray(data) ? data[0] : data) as DeliveryReceipt | undefined
  if (!receipt?.delivery_code) throw new Error("The delivery was saved but no delivery code came back from the server.")
  return { delivery_id: receipt.delivery_id, delivery_code: receipt.delivery_code }
}
