import { supabase, branchArg } from "./supabase"

// One unified, owner-only view across every kind of event this branch has
// ever generated -- see list_branch_history() in the schema for the full
// list of sources it reads (sales, stock adjustments, deliveries, insurance
// claims, patients, product requests, staff accounts, batch recalls) and why
// the owner-only gate lives server-side, not just in the client nav.

export type HistoryCategory =
  | "sale" | "stock_adjustment" | "stock_batch" | "insurance_claim"
  | "patient" | "product_request" | "staff" | "batch_recall"
  | "barcode_created" | "notification" | "support_ticket"

export const HISTORY_CATEGORIES: HistoryCategory[] = [
  "stock_batch", "stock_adjustment", "batch_recall", "sale", "insurance_claim",
  "barcode_created", "notification", "support_ticket", "patient", "product_request", "staff",
]

export interface HistoryEvent {
  eventAt: string
  category: HistoryCategory
  amount: number | null
  actorName: string | null
  // Real where the category has one (claim status, adjustment type, barcode
  // status, read/unread, ticket status...); null where it wouldn't add real
  // information (every sale row is equally "completed" -- there's no
  // pending/refunded concept in this schema).
  status: string | null
  // Raw, per-category facts (product name, receipt number, quantity...) --
  // NOT pre-formatted text. list_branch_history() deliberately stops short
  // of building an English sentence server-side; HistoryPage's eventText()
  // builds the displayed title/description from this in whichever language
  // the viewer has chosen.
  meta: Record<string, any>
}

function raise(error: { message: string } | null, fallback: string): never {
  throw new Error(error?.message ?? fallback)
}

export async function loadBranchHistory(from?: string, to?: string, branchId?: string): Promise<HistoryEvent[]> {
  const { data, error } = await supabase.rpc("list_branch_history", { p_from: from ?? null, p_to: to ?? null, ...branchArg(branchId) })
  if (error) raise(error, "Could not load branch history.")
  return (data ?? []).map((row: any) => ({
    eventAt: row.event_at, category: row.category as HistoryCategory,
    amount: row.amount === null ? null : Number(row.amount), actorName: row.actor_name,
    status: row.status ?? null, meta: row.meta ?? {},
  }))
}
