import { supabase } from "./supabase"

export type StockTransferStatus = "pending" | "approved" | "in_transit" | "received" | "rejected" | "cancelled"

export interface StockTransfer {
  id: string
  fromBranchId: string
  fromBranchName: string
  toBranchId: string
  toBranchName: string
  status: StockTransferStatus
  batchCount: number
  requestedByName: string | null
  notes: string | null
  rejectionReason: string | null
  requestedAt: string
  receivedAt: string | null
}

export interface StockTransferItem {
  stockBatchId: string
  productName: string
  batchNumber: string
  quantityAvailable: number
}

function mapTransfer(row: any): StockTransfer {
  return {
    id: row.id, fromBranchId: row.from_branch_id, fromBranchName: row.from_branch_name,
    toBranchId: row.to_branch_id, toBranchName: row.to_branch_name, status: row.status,
    batchCount: row.batch_count, requestedByName: row.requested_by_name, notes: row.notes,
    rejectionReason: row.rejection_reason, requestedAt: row.requested_at, receivedAt: row.received_at,
  }
}

// Transfers where the signed-in user's own branch is sender or receiver --
// the only ones they can act on (approve/dispatch/receive/cancel are all
// scoped server-side to the caller's own branch or org membership).
export async function listBranchStockTransfers(): Promise<StockTransfer[]> {
  const { data, error } = await supabase.rpc("list_branch_stock_transfers")
  if (error) throw error
  return ((data ?? []) as any[]).map(mapTransfer)
}

// Every transfer across the whole organization, read-only -- for an
// org_owner/org_manager overseeing branches they don't personally staff.
export async function listOrganizationStockTransfers(organizationId: string): Promise<StockTransfer[]> {
  const { data, error } = await supabase.rpc("list_organization_stock_transfers", { p_organization_id: organizationId })
  if (error) throw error
  return ((data ?? []) as any[]).map(mapTransfer)
}

export async function listStockTransferItems(transferId: string): Promise<StockTransferItem[]> {
  const { data, error } = await supabase.rpc("list_stock_transfer_items", { p_transfer_id: transferId })
  if (error) throw error
  return ((data ?? []) as any[]).map(row => ({
    stockBatchId: row.stock_batch_id, productName: row.product_name,
    batchNumber: row.batch_number, quantityAvailable: row.quantity_available,
  }))
}

export async function requestStockTransfer(toBranchId: string, stockBatchIds: string[], notes?: string): Promise<string> {
  const { data, error } = await supabase.rpc("request_stock_transfer", {
    p_to_branch_id: toBranchId, p_stock_batch_ids: stockBatchIds, p_notes: notes?.trim() || null,
  })
  if (error) throw error
  return data as string
}

export async function approveStockTransfer(transferId: string): Promise<void> {
  const { error } = await supabase.rpc("approve_stock_transfer", { p_transfer_id: transferId })
  if (error) throw error
}

export async function dispatchStockTransfer(transferId: string): Promise<void> {
  const { error } = await supabase.rpc("dispatch_stock_transfer", { p_transfer_id: transferId })
  if (error) throw error
}

export async function receiveStockTransfer(transferId: string): Promise<void> {
  const { error } = await supabase.rpc("receive_stock_transfer", { p_transfer_id: transferId })
  if (error) throw error
}

export async function rejectStockTransfer(transferId: string, reason?: string): Promise<void> {
  const { error } = await supabase.rpc("reject_stock_transfer", { p_transfer_id: transferId, p_reason: reason?.trim() || null })
  if (error) throw error
}

export async function cancelStockTransfer(transferId: string): Promise<void> {
  const { error } = await supabase.rpc("cancel_stock_transfer", { p_transfer_id: transferId })
  if (error) throw error
}
