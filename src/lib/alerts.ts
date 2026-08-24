import { supabase } from "./supabase"

// Real public.notifications rows (branch-scoped by RLS), replacing the
// dbNotifications/alertsData mocks that used to back AlertsPage.tsx and
// App.tsx's NotifDropdown/sidebar badge. Nothing in this codebase currently
// creates a batch_recall/stock_adjustment notification (no UI flow writes
// those tables yet), so those source types will legitimately show as empty
// until that exists -- this is real data, not padded to look busier than it
// is. product_request_approved/rejected notifications ARE created, by
// admin_approve_product_request()/admin_reject_product_request() in the
// schema.

export type AlertSeverity = "critical" | "warning" | "info"

export interface LiveAlert {
  id: string
  sourceType: string
  type: AlertSeverity
  title: string
  msg: string
  createdAt: string
  isRead: boolean
}

const TITLES: Record<string, string> = {
  batch_recall: "Batch Recall",
  stock_adjustment: "Stock Adjustment",
  product_request_approved: "Product Request Approved",
  product_request_rejected: "Product Request Declined",
}

const SEVERITY: Record<string, AlertSeverity> = {
  batch_recall: "critical",
  stock_adjustment: "warning",
  product_request_approved: "info",
  product_request_rejected: "warning",
}

interface NotificationRow {
  id: string
  branch_id: string
  source_type: string
  source_id: string
  message: string
  is_read: boolean
  created_at: string
}

export async function loadLiveAlerts(): Promise<LiveAlert[]> {
  const { data, error } = await supabase.from("notifications").select("*").order("created_at", { ascending: false })
  if (error) throw error
  return ((data ?? []) as NotificationRow[]).map(row => ({
    id: row.id,
    sourceType: row.source_type,
    type: SEVERITY[row.source_type] ?? "info",
    title: TITLES[row.source_type] ?? "Notification",
    msg: row.message,
    createdAt: row.created_at,
    isRead: row.is_read,
  }))
}

export async function markAlertRead(id: string): Promise<void> {
  const { error } = await supabase.from("notifications").update({ is_read: true }).eq("id", id)
  if (error) throw error
}

export async function markAllAlertsRead(ids: string[]): Promise<void> {
  if (ids.length === 0) return
  const { error } = await supabase.from("notifications").update({ is_read: true }).in("id", ids)
  if (error) throw error
}
