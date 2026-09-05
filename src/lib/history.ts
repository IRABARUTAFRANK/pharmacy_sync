import { supabase } from "./supabase"

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
  title: string
  description: string
  amount: number | null
  actorName: string | null
  // Real where the category has one (claim status, adjustment type, barcode
  // status, read/unread, ticket status...); null where it wouldn't add real
  // information (every sale row is equally "completed" -- there's no
  // pending/refunded concept in this schema).
  status: string | null
}

function raise(error: { message: string } | null, fallback: string): never {
  throw new Error(error?.message ?? fallback)
}

export async function loadBranchHistory(from?: string, to?: string): Promise<HistoryEvent[]> {
  const { data, error } = await supabase.rpc("list_branch_history", { p_from: from ?? null, p_to: to ?? null })
  if (error) raise(error, "Could not load branch history.")
  return (data ?? []).map((row: any) => ({
    eventAt: row.event_at, category: row.category as HistoryCategory, title: row.title,
    description: row.description, amount: row.amount === null ? null : Number(row.amount), actorName: row.actor_name,
    status: row.status ?? null,
  }))
}
