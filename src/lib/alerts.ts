import type { TranslationKey } from "./i18n/en"
import { supabase } from "./supabase"

// Real public.notifications rows (branch-scoped by RLS), replacing the
// dbNotifications/alertsData mocks that used to back AlertsPage.tsx and
// App.tsx's NotifDropdown/sidebar badge. product_request_approved/rejected
// and out_of_stock notifications are created server-side (see
// admin_approve_product_request()/admin_reject_product_request()/
// check_out_of_stock_alerts() in the schema); batch_recall and
// stock_adjustment are created by adjust_stock().
//
// titleKey holds a TranslationKey, not display text -- the caller (AlertsPage,
// App.tsx's NotifDropdown) renders it with t(), so the same stored
// notification row displays in whichever language is active rather than
// being frozen in English at write time.

export type AlertSeverity = "critical" | "warning" | "info"

export interface LiveAlert {
  id: string
  sourceType: string
  type: AlertSeverity
  titleKey: TranslationKey
  msg: string
  createdAt: string
  isRead: boolean
}

export const ALERT_SOURCE_TITLE_KEYS: Record<string, TranslationKey> = {
  batch_recall: "alerts.source.batchRecall",
  stock_adjustment: "alerts.source.stockAdjustment",
  product_request_approved: "alerts.source.productRequestApproved",
  product_request_rejected: "alerts.source.productRequestRejected",
  out_of_stock: "alerts.source.outOfStock",
}

const SEVERITY: Record<string, AlertSeverity> = {
  batch_recall: "critical",
  stock_adjustment: "warning",
  product_request_approved: "info",
  product_request_rejected: "warning",
  out_of_stock: "critical",
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
    titleKey: ALERT_SOURCE_TITLE_KEYS[row.source_type] ?? "alerts.source.notification",
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

// Re-fires an unread "out of stock" notification for any product still at
// zero stock once the reminder interval (6h, set server-side in
// check_out_of_stock_alerts()) has elapsed since the last one was read.
// Idempotent and cheap to call often -- see loadLiveAlerts()'s call site in
// App.tsx's existing poll, which is what actually makes this "recurring"
// rather than a one-off check on page load.
export async function checkOutOfStockAlerts(): Promise<void> {
  const { error } = await supabase.rpc("check_out_of_stock_alerts")
  if (error) throw error
}
