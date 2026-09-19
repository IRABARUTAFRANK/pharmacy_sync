import { supabase, branchArg } from "./supabase"

// Wraps the inter-branch stock transfer workflow. Approving a transfer
// completes it outright (see 2026-09-19_transfer_instant_complete_and_
// verify.sql) -- there is no separate dispatch/receive scan step any more,
// only a lightweight post-hoc verify.
//
// Workflow: pending (requested by the SENDING branch, picking specific
// whole stock_batches it already owns) -> received (approving now completes
// the transfer outright in the same action -- every batch's branch_id moves
// immediately, no separate dispatch/receive scan step any more). Rejected/
// cancelled only while still pending -- once approved, the stock has
// already moved, so there is nothing left to call off.
//
// 'approved' and 'in_transit' remain valid values only for historical rows
// from before this changed (2026-09-19_transfer_instant_complete_and_verify.
// sql) -- no transfer is ever created in, or advances through, those states
// any more.
export type StockTransferStatus = "pending" | "approved" | "in_transit" | "received" | "rejected" | "cancelled"

// The receiving branch's own after-the-fact confirmation -- purely a record
// of what physically happened, never a gate on the stock movement itself
// (that already happened the moment the transfer was approved).
export type TransferVerifyStatus = "pending" | "confirmed" | "not_received" | "damaged"

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
  verifyStatus: TransferVerifyStatus
  verifyNotes: string | null
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
    toBranchId: row.to_branch_id, toBranchName: row.to_branch_name, status: row.status as StockTransferStatus,
    batchCount: row.batch_count, requestedByName: row.requested_by_name, notes: row.notes,
    rejectionReason: row.rejection_reason, requestedAt: row.requested_at, receivedAt: row.received_at,
    verifyStatus: row.verify_status as TransferVerifyStatus, verifyNotes: row.verify_notes,
  }
}

// Called by the SENDING branch's own owner/manager -- every batch in
// stockBatchIds must already belong to their own branch, and toBranchId
// must be a different branch in the same organization (the RPC itself
// enforces both).
// fromBranchId lets an org_owner/org_manager request a transfer OUT of a
// branch they're currently viewing rather than their own -- request_stock_
// transfer()'s own p_from_branch_id already supports this (defaults to the
// caller's own branch when omitted), this just exposes it here too.
export async function requestStockTransfer(toBranchId: string, stockBatchIds: string[], notes?: string, fromBranchId?: string): Promise<string> {
  const { data, error } = await supabase.rpc("request_stock_transfer", {
    p_to_branch_id: toBranchId, p_stock_batch_ids: stockBatchIds, p_notes: notes ?? null,
    ...(fromBranchId ? { p_from_branch_id: fromBranchId } : {}),
  })
  if (error) throw error
  return data as string
}

// Either the receiving branch's own owner/manager, or any member of the
// owning organization. Completes the transfer outright -- every batch moves
// to the receiving branch's stock in this same call.
export async function approveStockTransfer(transferId: string): Promise<void> {
  const { error } = await supabase.rpc("approve_stock_transfer", { p_transfer_id: transferId })
  if (error) throw error
}

// The receiving branch or any org member -- only while still pending.
export async function rejectStockTransfer(transferId: string, reason?: string): Promise<void> {
  const { error } = await supabase.rpc("reject_stock_transfer", { p_transfer_id: transferId, p_reason: reason ?? null })
  if (error) throw error
}

// The sending branch only -- only while still pending (nothing left to call
// off once approved, since the stock has already moved).
export async function cancelStockTransfer(transferId: string): Promise<void> {
  const { error } = await supabase.rpc("cancel_stock_transfer", { p_transfer_id: transferId })
  if (error) throw error
}

// The RECEIVING branch only, once a transfer has completed (status
// 'received', verifyStatus still 'pending') -- a lightweight after-the-fact
// confirmation, not a gate: it never undoes the stock movement that already
// happened when the transfer was approved, even on 'not_received' or
// 'damaged'. Those two just flag it for the sending branch/org to follow up
// on outside the system.
export async function verifyStockTransfer(transferId: string, result: TransferVerifyStatus, notes?: string): Promise<void> {
  const { error } = await supabase.rpc("verify_stock_transfer", { p_transfer_id: transferId, p_result: result, p_notes: notes ?? null })
  if (error) throw error
}

// Every transfer where the caller's own branch is sender or receiver.
export async function listBranchStockTransfers(): Promise<StockTransfer[]> {
  const { data, error } = await supabase.rpc("list_branch_stock_transfers")
  if (error) throw error
  return ((data ?? []) as any[]).map(mapTransfer)
}

// Every transfer across the whole organization -- any org member
// (assert_org_member() inside the RPC; not limited to org_owner).
export async function listOrganizationStockTransfers(organizationId: string): Promise<StockTransfer[]> {
  const { data, error } = await supabase.rpc("list_organization_stock_transfers", { p_organization_id: organizationId })
  if (error) throw error
  return ((data ?? []) as any[]).map(mapTransfer)
}

// What's actually inside one transfer -- product, batch number, quantity.
// Not yet used by OrganizationPage.tsx's UI, but already live server-side
// for whenever a "what's in this transfer" detail view is added.
export async function listStockTransferItems(transferId: string): Promise<StockTransferItem[]> {
  const { data, error } = await supabase.rpc("list_stock_transfer_items", { p_transfer_id: transferId })
  if (error) throw error
  return ((data ?? []) as any[]).map(row => ({
    stockBatchId: row.stock_batch_id, productName: row.product_name, batchNumber: row.batch_number,
    quantityAvailable: row.quantity_available,
  }))
}

// Scan-to-add for RequestTransferModal's own batch picker: resolves a
// scanned code straight to which of the caller's OWN branch's stock_batches
// it belongs to, so scanning a pack adds its whole batch to the request the
// same way ticking its checkbox already does -- no separate "transfer
// scanning" RPC needed, this is the exact same read-only lookup_barcode()
// the POS and receiving screens already call (branch-scoped server-side,
// never returns another branch's stock). Real-time status/expiry are
// re-checked here too, same as scanBarcode() in sales.ts, since the batch
// list this modal loaded up front can go stale while the picker is open.
export interface ScannedBranchBatch {
  stockBatchId: string
  productName: string
  dosage: string | null
  batchNumber: string
}

export async function scanBranchBatch(code: string, branchId?: string): Promise<ScannedBranchBatch> {
  const trimmed = code.trim()
  if (!trimmed) throw new Error("Scan or type a barcode.")
  const { data, error } = await supabase.rpc("lookup_barcode", { p_code: trimmed, ...branchArg(branchId) })
  if (error) throw error
  const row = Array.isArray(data) ? data[0] : data
  // lookup_barcode() itself is branch-scoped (WHERE sb.branch_id =
  // current_branch_id()) -- a code that's real but belongs to a different
  // branch/organization comes back empty here exactly the same as one that
  // doesn't exist at all, by design (never confirms or denies another
  // org's barcode exists). The message below has to stay true either way,
  // not claim the code is unknown everywhere -- it just isn't part of THIS
  // branch's own stock, which is the only thing a transfer can ever send.
  if (!row) throw new Error(`"${trimmed}" is not part of your branch's stock.`)
  if (row.status !== "active") throw new Error(`This item is ${row.status} and is not available to send.`)
  if (row.expiry_date && row.expiry_date < new Date().toISOString().slice(0, 10)) {
    throw new Error(`This item expired on ${row.expiry_date} and cannot be sent.`)
  }
  return { stockBatchId: row.stock_batch_id, productName: row.product_name, dosage: row.dosage, batchNumber: row.batch_number }
}

// How many individually-scannable packs/boxes a batch still has active --
// the "does this even need a how-many-packs prompt" check RequestTransferModal
// and RequestStockModal both run right after a scan or pick. A batch of 1
// (no real pack breakdown) always answers 1, so the prompt never bothers
// asking about a medicine that was never sold in packs to begin with.
export async function countActiveBatchUnits(stockBatchId: string): Promise<number> {
  const { data, error } = await supabase.rpc("count_active_batch_units", { p_stock_batch_id: stockBatchId })
  if (error) throw error
  return Number(data ?? 0)
}

// Splits `quantity` of a batch's own active packs off into a brand-new
// batch and hands back ITS id -- or, when quantity covers everything the
// batch already has, hands back the same id unchanged (nothing to split).
// Callers pass whatever id comes back straight into request_stock_transfer/
// request_stock_from_branch exactly as they already do today; a split-off
// batch behaves like any other in every other respect.
export async function splitStockBatch(stockBatchId: string, quantity: number): Promise<string> {
  const { data, error } = await supabase.rpc("split_stock_batch", { p_stock_batch_id: stockBatchId, p_quantity: quantity })
  if (error) throw error
  return data as string
}
