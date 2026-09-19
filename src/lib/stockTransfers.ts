import { supabase, branchArg } from "./supabase"

// Wraps the inter-branch stock transfer workflow -- fully designed and
// already live in the database (PROPOSAL_multi_branch_organizations.sql's
// request/approve/dispatch/receive/reject/cancel RPCs plus
// 2026-09-09_organization_dashboard.sql's org-wide list/item-detail RPCs),
// but this file itself never existed, leaving OrganizationPage.tsx's whole
// Stock Transfers tab (RequestTransferModal, TransferRow, refreshTransfers)
// wired to nothing. This is the missing piece, not a new design -- every
// function name, param, and return shape below matches the live RPCs
// exactly, and every field matches what OrganizationPage.tsx already reads
// off a StockTransfer.
//
// Workflow: pending (requested by the SENDING branch, picking specific
// whole stock_batches it already owns) -> approved (by the receiving branch
// or any org member) -> in_transit (sending branch confirms physical
// hand-off -- see the sending branch's own POS: any surviving 'active' pack
// under a dispatched batch is not sellable, it flips to 'in_transit') ->
// received (receiving branch confirms arrival; stock_batches.branch_id
// actually moves). Rejected/cancelled only before dispatch -- once stock has
// physically left a building, reversing that is a real logistics problem,
// not a status flip.
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

// One row per physical item a scan-to-confirm screen expects to see --
// a box, or a loose pack not sealed inside one -- for the transfer's own
// batches. `status` selects which phase's manifest: 'active' while the
// sending branch is scanning the outgoing package (dispatch), 'in_transit'
// while the receiving branch is scanning it back in (receive) -- matching
// exactly what dispatch_stock_transfer()/receive_stock_transfer() themselves
// flip, so a scanned item always reflects the transfer's real current state.
export interface StockTransferManifestItem {
  barcodeId: string
  code: string
  barcodeType: "box" | "pack"
  stockBatchId: string
  productName: string
  dosage: string | null
  batchNumber: string
}

function mapTransfer(row: any): StockTransfer {
  return {
    id: row.id, fromBranchId: row.from_branch_id, fromBranchName: row.from_branch_name,
    toBranchId: row.to_branch_id, toBranchName: row.to_branch_name, status: row.status as StockTransferStatus,
    batchCount: row.batch_count, requestedByName: row.requested_by_name, notes: row.notes,
    rejectionReason: row.rejection_reason, requestedAt: row.requested_at, receivedAt: row.received_at,
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
// owning organization.
export async function approveStockTransfer(transferId: string): Promise<void> {
  const { error } = await supabase.rpc("approve_stock_transfer", { p_transfer_id: transferId })
  if (error) throw error
}

// The SENDING branch only -- confirms physical hand-off.
export async function dispatchStockTransfer(transferId: string): Promise<void> {
  const { error } = await supabase.rpc("dispatch_stock_transfer", { p_transfer_id: transferId })
  if (error) throw error
}

// The RECEIVING branch only -- confirms physical arrival; this is what
// actually moves the stock.
export async function receiveStockTransfer(transferId: string): Promise<void> {
  const { error } = await supabase.rpc("receive_stock_transfer", { p_transfer_id: transferId })
  if (error) throw error
}

// The receiving branch or any org member -- only while still pending or
// approved (not once dispatched).
export async function rejectStockTransfer(transferId: string, reason?: string): Promise<void> {
  const { error } = await supabase.rpc("reject_stock_transfer", { p_transfer_id: transferId, p_reason: reason ?? null })
  if (error) throw error
}

// The sending branch only -- only while still pending or approved.
export async function cancelStockTransfer(transferId: string): Promise<void> {
  const { error } = await supabase.rpc("cancel_stock_transfer", { p_transfer_id: transferId })
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

export async function listStockTransferManifest(transferId: string, status: "active" | "in_transit"): Promise<StockTransferManifestItem[]> {
  const { data, error } = await supabase.rpc("list_stock_transfer_manifest", { p_transfer_id: transferId, p_status: status })
  if (error) throw error
  return ((data ?? []) as any[]).map(row => ({
    barcodeId: row.barcode_id, code: row.code, barcodeType: row.barcode_type as "box" | "pack",
    stockBatchId: row.stock_batch_id, productName: row.product_name, dosage: row.dosage, batchNumber: row.batch_number,
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
