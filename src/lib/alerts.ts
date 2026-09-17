import type { TranslationKey } from "./i18n/en"
import { fetchAllRows, supabase } from "./supabase"

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
  low_stock: "alerts.source.lowStock",
  license_expiring: "alerts.source.licenseExpiring",
  forecast_completed: "alerts.source.forecastCompleted",
  restock_recommendation: "alerts.source.restockRecommendation",
  reorder_point_missing: "alerts.source.reorderPointMissing",
  branch_location_missing: "alerts.source.branchLocationMissing",
  expiring_soon: "alerts.source.expiringSoon",
}

const SEVERITY: Record<string, AlertSeverity> = {
  batch_recall: "critical",
  stock_adjustment: "warning",
  product_request_approved: "info",
  product_request_rejected: "warning",
  out_of_stock: "critical",
  low_stock: "warning",
  license_expiring: "critical",
  forecast_completed: "info",
  restock_recommendation: "warning",
  reorder_point_missing: "info",
  branch_location_missing: "warning",
  expiring_soon: "warning",
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

// Paginated -- notifications accumulate for as long as the branch operates
// (out-of-stock reminders, restock recommendations, stock adjustments,
// ...), so an unbounded select eventually hits PostgREST's row cap and
// silently drops the oldest ones instead of erroring.
export async function loadLiveAlerts(): Promise<LiveAlert[]> {
  const data = await fetchAllRows<NotificationRow>((from, to) =>
    supabase.from("notifications").select("*").order("created_at", { ascending: false }).order("id").range(from, to),
  )
  return (data ?? []).map(row => ({
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
// zero stock once the reminder interval has elapsed since the last one was
// read -- the interval itself is per-branch now (branches.out_of_stock_
// reminder_hours, editable from Branch Settings), not a fixed constant.
// Idempotent and cheap to call often -- see loadLiveAlerts()'s call site in
// App.tsx's existing poll, which is what actually makes this "recurring"
// rather than a one-off check on page load.
export async function checkOutOfStockAlerts(): Promise<void> {
  const { error } = await supabase.rpc("check_out_of_stock_alerts")
  if (error) throw error
}

// Same recurring shape as checkOutOfStockAlerts() above, but for "still has
// stock, just below its reorder point" -- a heads-up before a product runs
// out completely, not just after. Reuses the same out_of_stock_reminder_hours
// setting for how often it re-fires.
export async function checkLowStockAlerts(): Promise<void> {
  const { error } = await supabase.rpc("check_low_stock_alerts")
  if (error) throw error
}

// One-shot, not recurring: writes off (and notifies about, under the
// existing 'stock_adjustment' source type) any barcode still marked
// 'active' whose batch has passed its expiry_date. Once written off its
// status becomes 'expired', so it can never match this check again -- unlike
// out-of-stock, there's nothing to keep reminding about once the batch is
// actually gone. Also called from App.tsx's existing poll.
export async function checkExpiredStock(): Promise<void> {
  const { error } = await supabase.rpc("check_expired_stock")
  if (error) throw error
}

// One-shot per batch, same shape as checkExpiredStock() above -- but fires
// BEFORE expiry, once a batch first falls within Branch Settings'
// expiry_alert_threshold_days window (Inventory tab), so there is actually a
// heads-up to act on it before checkExpiredStock() has to write it off.
export async function checkExpiringSoonStock(): Promise<void> {
  const { error } = await supabase.rpc("check_expiring_soon_stock")
  if (error) throw error
}

// Re-fires (at most once a day, same idempotent shape as the two checks
// above) once the branch's license_expiry_date -- set on Branch Settings'
// Legal & Licensing card -- comes within 90 days, and keeps firing (with an
// increasingly urgent message) if it's ignored past the date itself. A no-op
// if no expiry date has been set.
export async function checkLicenseExpiry(): Promise<void> {
  const { error } = await supabase.rpc("check_license_expiry")
  if (error) throw error
}

// Once a saved forecast's (see saveSalesForecastSnapshot() in lib/analytics.ts)
// entire predicted horizon has actually elapsed, this surfaces a
// notification comparing what it predicted against what really sold --
// same idempotent one-shot-per-snapshot shape as the checks above (guarded
// by sales_forecast_snapshots.notified_at instead of a read/cooldown check).
export async function checkForecastAccuracyNotifications(): Promise<void> {
  const { error } = await supabase.rpc("check_forecast_accuracy_notifications")
  if (error) throw error
}

// Any product with stock at this branch but no reorder_points row gets a
// one-time nudge, re-fired at most once a week once read -- much less
// urgent than out-of-stock, so a long cooldown instead of a short one.
export async function checkMissingReorderPoints(): Promise<void> {
  const { error } = await supabase.rpc("check_missing_reorder_points")
  if (error) throw error
}

// Best-sellers about to run out at their current sales pace (see
// ai_restock_recommendations() in lib/analytics.ts for the read-only,
// parameterized version this recurring check is based on). Previously
// existed server-side but was never callable end-to-end -- see
// 2026-09-14_reorder_notifications_org_visibility.sql for the constraint fix
// that let its insert actually succeed for the first time.
export async function checkRestockRecommendations(): Promise<void> {
  const { error } = await supabase.rpc("check_restock_recommendations")
  if (error) throw error
}

// Nudges the branch owner/manager to set the branch's location (Branch
// Settings -> Profile -> Location) once the branch is active and it's still
// unset -- see check_missing_branch_location() in
// 2026-09-15_branch_geolocation.sql. Re-fires at most weekly while ignored,
// same cooldown shape as checkMissingReorderPoints() above. The point of
// the location isn't the map itself -- it's letting a stock transfer
// request sort candidate branches by distance instead of an unsorted list.
export async function checkMissingBranchLocation(): Promise<void> {
  const { error } = await supabase.rpc("check_missing_branch_location")
  if (error) throw error
}
