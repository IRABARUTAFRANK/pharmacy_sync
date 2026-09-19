import { branchArg, supabase } from "./supabase"

// The pull side of stock movement, complementing lib/stockTransfers.ts's
// sender-initiated push flow -- a real branch-to-branch negotiation, not an
// org_manager picking a source:
//
//   1. requestStockFromBranch() -- the requesting branch picks ONE specific
//      branch to ask. The organization is told (FYI only) that this
//      happened.
//   2. respondToStockOffer() -- that branch's own owner/manager accepts
//      (choosing which of their own batches to send) or denies (with a
//      required reason). Accepting sends the stock immediately -- there is
//      no separate organization approval step any more (see
//      2026-09-19_transfer_instant_complete_and_verify.sql): it creates and
//      completes the underlying transfer in the same action.
//   3. If denied, retryStockNeed() lets the requester pick a DIFFERENT
//      branch and try again -- only one outstanding ask at a time.
//
// 'org_review'/'fulfilling' remain valid StockNeedStatus values only for
// historical rows from before this changed -- a need now goes straight from
// 'open' to 'fulfilled' the moment an offer is accepted.
export type StockNeedStatus = "open" | "org_review" | "fulfilling" | "fulfilled"
export type StockOfferStatus = "pending" | "accepted" | "denied"

export interface StockNeed {
  id: string
  requestingBranchId: string
  requestingBranchName: string
  productVariantId: string
  productName: string
  dosage: string | null
  requestedQuantity: number
  status: StockNeedStatus
  notes: string | null
  transferId: string | null
  // The linked StockTransfer's own status -- set the moment an offer is
  // accepted, since that now creates AND completes the transfer in the same
  // action (see respondToStockOffer's own comment). Practically always
  // "received" by the time the client sees it.
  transferStatus: string | null
  // The most recent ask -- tells the UI which of the two "waiting on
  // someone" states this is in: latestOfferStatus "pending" (waiting on
  // latestOfferBranchName to answer) or "denied" (needs a retry with a
  // different branch, see latestOfferDenialReason). "accepted" means it's
  // already fulfilled -- see status/transferStatus instead.
  latestOfferId: string | null
  latestOfferBranchId: string | null
  latestOfferBranchName: string | null
  latestOfferStatus: StockOfferStatus | null
  latestOfferDenialReason: string | null
  requestedByName: string | null
  createdAt: string
}

export interface StockNeedOffer {
  id: string
  targetBranchId: string
  targetBranchName: string
  status: StockOfferStatus
  denialReason: string | null
  respondedByName: string | null
  respondedAt: string | null
  createdAt: string
}

export interface IncomingStockOffer {
  id: string
  needId: string
  requestingBranchId: string
  requestingBranchName: string
  productVariantId: string
  productName: string
  dosage: string | null
  requestedQuantity: number
  notes: string | null
  createdAt: string
}

export interface StockNeedBatch {
  stockBatchId: string
  batchNumber: string
  expiryDate: string
  quantityAvailable: number
}

function mapNeed(row: any): StockNeed {
  return {
    id: row.id, requestingBranchId: row.requesting_branch_id, requestingBranchName: row.requesting_branch_name,
    productVariantId: row.product_variant_id, productName: row.product_name, dosage: row.dosage,
    requestedQuantity: row.requested_quantity, status: row.status as StockNeedStatus, notes: row.notes,
    transferId: row.transfer_id, transferStatus: row.transfer_status,
    latestOfferId: row.latest_offer_id, latestOfferBranchId: row.latest_offer_branch_id,
    latestOfferBranchName: row.latest_offer_branch_name, latestOfferStatus: row.latest_offer_status,
    latestOfferDenialReason: row.latest_offer_denial_reason,
    requestedByName: row.requested_by_name, createdAt: row.created_at,
  }
}

// Any branch owner/manager, for their own branch (or one an org_owner/
// org_manager is viewing, via branchId). targetBranchId must be a different
// branch in the same organization.
export async function requestStockFromBranch(
  targetBranchId: string, productVariantId: string, requestedQuantity: number, notes?: string, branchId?: string,
): Promise<string> {
  const { data, error } = await supabase.rpc("request_stock_from_branch", {
    p_target_branch_id: targetBranchId, p_product_variant_id: productVariantId,
    p_requested_quantity: requestedQuantity, p_notes: notes?.trim() || null, ...branchArg(branchId),
  })
  if (error) throw error
  return data as string
}

// The asked branch's own owner/manager only -- deliberately not
// branchId-aware, unlike most actions here: whether a branch can spare
// stock is a fact only that branch's own operator knows, not something an
// org_owner/org_manager can answer on their behalf.
export async function respondToStockOffer(offerId: string, accept: boolean, reason?: string, batchIds?: string[]): Promise<void> {
  const { error } = await supabase.rpc("respond_to_stock_offer", {
    p_offer_id: offerId, p_accept: accept, p_reason: reason?.trim() || null, p_batch_ids: batchIds ?? null,
  })
  if (error) throw error
}

// The original requesting branch, after a denial, picks a different branch.
export async function retryStockNeed(needId: string, targetBranchId: string): Promise<string> {
  const { data, error } = await supabase.rpc("retry_stock_need", { p_need_id: needId, p_target_branch_id: targetBranchId })
  if (error) throw error
  return data as string
}

// Omit organizationId for "my own branch's requests" (any owner/manager);
// pass it for the org-wide view (org_owner/org_manager only).
export async function listStockNeeds(organizationId?: string, status?: StockNeedStatus): Promise<StockNeed[]> {
  const { data, error } = await supabase.rpc("list_stock_needs", {
    p_organization_id: organizationId ?? null, p_status: status ?? null,
  })
  if (error) throw error
  return ((data ?? []) as any[]).map(mapNeed)
}

// The full negotiation trail for one request -- every branch asked, in
// order, and why each "no" happened.
export async function listStockNeedOffers(needId: string): Promise<StockNeedOffer[]> {
  const { data, error } = await supabase.rpc("list_stock_need_offers", { p_need_id: needId })
  if (error) throw error
  return ((data ?? []) as any[]).map(row => ({
    id: row.id, targetBranchId: row.target_branch_id, targetBranchName: row.target_branch_name,
    status: row.status as StockOfferStatus, denialReason: row.denial_reason,
    respondedByName: row.responded_by_name, respondedAt: row.responded_at, createdAt: row.created_at,
  }))
}

// Pending offers addressed to my branch (or one an org_owner/org_manager is
// viewing, via branchId) -- the "someone is asking you for stock" inbox.
export async function listIncomingStockOffers(branchId?: string): Promise<IncomingStockOffer[]> {
  const { data, error } = await supabase.rpc("list_incoming_stock_offers", { ...branchArg(branchId) })
  if (error) throw error
  return ((data ?? []) as any[]).map(row => ({
    id: row.id, needId: row.need_id, requestingBranchId: row.requesting_branch_id, requestingBranchName: row.requesting_branch_name,
    productVariantId: row.product_variant_id, productName: row.product_name, dosage: row.dosage,
    requestedQuantity: row.requested_quantity, notes: row.notes, createdAt: row.created_at,
  }))
}

// The specific batches at one branch for one variant, FEFO order -- what an
// accepting branch picks from when responding "yes".
export async function listBranchBatchesForVariant(branchId: string, productVariantId: string): Promise<StockNeedBatch[]> {
  const { data, error } = await supabase.rpc("list_branch_batches_for_variant", {
    p_branch_id: branchId, p_product_variant_id: productVariantId,
  })
  if (error) throw error
  return ((data ?? []) as any[]).map(row => ({
    stockBatchId: row.stock_batch_id, batchNumber: row.batch_number, expiryDate: row.expiry_date,
    quantityAvailable: Number(row.quantity_available),
  }))
}
