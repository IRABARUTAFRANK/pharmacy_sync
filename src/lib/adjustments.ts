import { supabase } from "./supabase"

export type StockAdjustmentType = "damage" | "loss" | "correction" | "return" | "expired_writeoff" | "recalled"

export interface StockAdjustmentRecord {
  id: string
  adjustmentType: StockAdjustmentType
  quantity: number
  reason: string
  adjustedAt: string
  productName: string
  dosage?: string
  batchNumber: string
  performedByName?: string
}

// adjust_stock() is the only place a stock_adjustments row is ever written --
// see the schema comment above it. p_delta is signed pieces: negative removes
// stock (damage/loss/return/expired_writeoff/recalled, or a negative
// correction), positive only ever happens for a 'correction' that found more
// stock than recorded.
export async function adjustStock(stockBatchId: string, adjustmentType: StockAdjustmentType, delta: number, reason: string): Promise<string> {
  const { data, error } = await supabase.rpc("adjust_stock", {
    p_stock_batch_id: stockBatchId,
    p_adjustment_type: adjustmentType,
    p_delta: delta,
    p_reason: reason,
  })
  if (error) throw error
  return data as string
}

export async function listStockAdjustments(): Promise<StockAdjustmentRecord[]> {
  const { data, error } = await supabase.rpc("list_stock_adjustments")
  if (error) throw error
  return ((data ?? []) as any[]).map(row => ({
    id: row.id,
    adjustmentType: row.adjustment_type,
    quantity: Number(row.quantity),
    reason: row.reason ?? "",
    adjustedAt: row.adjusted_at,
    productName: row.product_name,
    dosage: row.dosage ?? undefined,
    batchNumber: row.batch_number,
    performedByName: row.performed_by_name ?? undefined,
  }))
}
