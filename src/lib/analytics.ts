import { supabase } from "./supabase"

// Calls the exact same read-only, branch-scoped SQL functions the AI analyst
// uses as tools (see src/datatabase's "AI ANALYST" section) -- but directly,
// with no LLM in between. Same real numbers (including the real linear-
// regression forecast), same owner/manager gate enforced server-side, zero
// API cost, and it keeps working even if the AI analyst is unavailable.

function raise(error: { message: string } | null, fallback: string): never {
  throw new Error(error?.message ?? fallback)
}

export interface BranchSnapshot {
  branchName: string
  todayRevenue: number
  weekToDateRevenue: number
  monthToDateRevenue: number
  activeProductCount: number
  outOfStockCount: number
  lowStockCount: number
  expiringSoonCount: number
  pendingProductRequests: number
  unreadAlerts: number
}

export async function loadBranchSnapshot(): Promise<BranchSnapshot> {
  const { data, error } = await supabase.rpc("ai_branch_snapshot")
  if (error) raise(error, "Could not load the branch snapshot.")
  const row = Array.isArray(data) ? data[0] : data
  return {
    branchName: row?.branch_name ?? "—", todayRevenue: Number(row?.today_revenue ?? 0),
    weekToDateRevenue: Number(row?.week_to_date_revenue ?? 0), monthToDateRevenue: Number(row?.month_to_date_revenue ?? 0),
    activeProductCount: row?.active_product_count ?? 0, outOfStockCount: row?.out_of_stock_count ?? 0,
    lowStockCount: row?.low_stock_count ?? 0, expiringSoonCount: row?.expiring_soon_count ?? 0,
    pendingProductRequests: row?.pending_product_requests ?? 0, unreadAlerts: row?.unread_alerts ?? 0,
  }
}

export type TrendBucket = "day" | "week" | "month"
export interface SalesTrendPoint {
  periodStart: string
  revenue: number
  tax: number
  insuranceCovered: number
  patientOwed: number
  transactionCount: number
}

export async function loadSalesTrend(from: string, to: string, bucket: TrendBucket = "day"): Promise<SalesTrendPoint[]> {
  const { data, error } = await supabase.rpc("ai_sales_trend", { p_from: from, p_to: to, p_bucket: bucket })
  if (error) raise(error, "Could not load the sales trend.")
  return (data ?? []).map((row: any) => ({
    periodStart: row.period_start, revenue: Number(row.revenue), tax: Number(row.tax),
    insuranceCovered: Number(row.insurance_covered), patientOwed: Number(row.patient_owed), transactionCount: row.transaction_count,
  }))
}

export interface TopProductRow {
  productId: string
  productName: string
  dosage: string | null
  quantitySold: number
  revenue: number
}

export async function loadTopProducts(from: string, to: string, metric: "revenue" | "quantity" = "revenue", direction: "asc" | "desc" = "desc", limit = 10): Promise<TopProductRow[]> {
  const { data, error } = await supabase.rpc("ai_top_products", { p_from: from, p_to: to, p_metric: metric, p_direction: direction, p_limit: limit })
  if (error) raise(error, "Could not load top products.")
  return (data ?? []).map((row: any) => ({
    productId: row.product_id, productName: row.product_name, dosage: row.dosage, quantitySold: Number(row.quantity_sold), revenue: Number(row.revenue),
  }))
}

export interface CategoryBreakdownRow {
  categoryName: string
  revenue: number
  quantitySold: number
}

export async function loadCategoryBreakdown(from: string, to: string): Promise<CategoryBreakdownRow[]> {
  const { data, error } = await supabase.rpc("ai_category_breakdown", { p_from: from, p_to: to })
  if (error) raise(error, "Could not load the category breakdown.")
  return (data ?? []).map((row: any) => ({ categoryName: row.category_name, revenue: Number(row.revenue), quantitySold: Number(row.quantity_sold) }))
}

export type StockFilter = "low" | "out" | "expiring" | "expired" | "all"
export interface StockStatusRow {
  productName: string
  dosage: string | null
  quantityAvailable: number
  minQuantity: number
  expiryDate: string | null
  daysToExpiry: number | null
  status: "out" | "expired" | "expiring" | "low" | "ok"
}

export async function loadStockStatus(filter: StockFilter = "all"): Promise<StockStatusRow[]> {
  const { data, error } = await supabase.rpc("ai_stock_status", { p_filter: filter })
  if (error) raise(error, "Could not load stock status.")
  return (data ?? []).map((row: any) => ({
    productName: row.product_name, dosage: row.dosage, quantityAvailable: row.quantity_available, minQuantity: row.min_quantity,
    expiryDate: row.expiry_date, daysToExpiry: row.days_to_expiry, status: row.status,
  }))
}

export interface SalesForecast {
  scope: string
  daysOfHistory: number
  avgDailyQuantity: number
  trendPerDay: number
  projectedQuantityNextPeriod: number
  projectedRevenueNextPeriod: number
}

export async function loadSalesForecast(opts: { productId?: string | null; categoryId?: string | null; daysHistory?: number; horizonDays?: number }): Promise<SalesForecast> {
  const { data, error } = await supabase.rpc("ai_sales_forecast", {
    p_product_id: opts.productId ?? null, p_category_id: opts.categoryId ?? null,
    p_days_history: opts.daysHistory ?? 90, p_horizon_days: opts.horizonDays ?? 30,
  })
  if (error) raise(error, "Could not compute a forecast.")
  const row = Array.isArray(data) ? data[0] : data
  return {
    scope: row?.scope ?? "—", daysOfHistory: row?.days_of_history ?? 0, avgDailyQuantity: Number(row?.avg_daily_quantity ?? 0),
    trendPerDay: Number(row?.trend_per_day ?? 0), projectedQuantityNextPeriod: Number(row?.projected_quantity_next_period ?? 0),
    projectedRevenueNextPeriod: Number(row?.projected_revenue_next_period ?? 0),
  }
}

export interface InsuranceSummaryRow {
  providerName: string
  claimCount: number
  totalClaimed: number
  paidOut: number
  pending: number
}

export async function loadInsuranceSummary(from: string, to: string): Promise<InsuranceSummaryRow[]> {
  const { data, error } = await supabase.rpc("ai_insurance_summary", { p_from: from, p_to: to })
  if (error) raise(error, "Could not load the insurance summary.")
  return (data ?? []).map((row: any) => ({
    providerName: row.provider_name, claimCount: row.claim_count, totalClaimed: Number(row.total_claimed), paidOut: Number(row.paid_out), pending: Number(row.pending),
  }))
}

export interface SellerPerformanceRow {
  sellerName: string
  sellerRole: string
  transactionCount: number
  revenue: number
}

export async function loadSellerPerformance(from: string, to: string): Promise<SellerPerformanceRow[]> {
  const { data, error } = await supabase.rpc("ai_seller_performance", { p_from: from, p_to: to })
  if (error) raise(error, "Could not load seller performance.")
  return (data ?? []).map((row: any) => ({ sellerName: row.seller_name, sellerRole: row.seller_role, transactionCount: row.transaction_count, revenue: Number(row.revenue) }))
}

export interface PatientSummary {
  totalPatientsServed: number
  newPatients: number
  repeatPatients: number
  topPatientName: string | null
  topPatientSpend: number | null
}

export async function loadPatientSummary(from: string, to: string): Promise<PatientSummary> {
  const { data, error } = await supabase.rpc("ai_patient_summary", { p_from: from, p_to: to })
  if (error) raise(error, "Could not load the patient summary.")
  const row = Array.isArray(data) ? data[0] : data
  return {
    totalPatientsServed: row?.total_patients_served ?? 0, newPatients: row?.new_patients ?? 0, repeatPatients: row?.repeat_patients ?? 0,
    topPatientName: row?.top_patient_name ?? null, topPatientSpend: row?.top_patient_spend != null ? Number(row.top_patient_spend) : null,
  }
}

// ─── Analytics page extras: inventory operations, sales patterns, insurance
// depth, and the small extras (seller productivity, recall log, patient
// retention) -- all additional, read-only reports calling the analytics_*
// SQL functions (see the "ANALYTICS PAGE EXTRAS" section of
// pharmacy_schema_consolidated.sql). Same owner/manager + branch scoping.

export interface StockAdjustmentRow {
  adjustmentType: string
  staffName: string
  quantity: number
  adjustmentCount: number
  estimatedValue: number
}

export async function loadStockAdjustments(from: string, to: string): Promise<StockAdjustmentRow[]> {
  const { data, error } = await supabase.rpc("analytics_stock_adjustments", { p_from: from, p_to: to })
  if (error) raise(error, "Could not load stock adjustments.")
  return (data ?? []).map((row: any) => ({
    adjustmentType: row.adjustment_type, staffName: row.staff_name, quantity: Number(row.quantity),
    adjustmentCount: row.adjustment_count, estimatedValue: Number(row.estimated_value),
  }))
}

export interface DeadStockRow {
  productName: string
  dosage: string | null
  quantityOnHand: number
  stockValue: number
  daysSinceLastSale: number | null
}

export async function loadDeadStock(days = 60, limit = 50): Promise<DeadStockRow[]> {
  const { data, error } = await supabase.rpc("analytics_dead_stock", { p_days: days, p_limit: limit })
  if (error) raise(error, "Could not load dead stock.")
  return (data ?? []).map((row: any) => ({
    productName: row.product_name, dosage: row.dosage, quantityOnHand: row.quantity_on_hand,
    stockValue: Number(row.stock_value), daysSinceLastSale: row.days_since_last_sale,
  }))
}

export interface InventoryTurnoverRow {
  categoryName: string
  cogs: number
  currentInventoryValue: number
  turnoverRatio: number | null
}

export async function loadInventoryTurnover(from: string, to: string): Promise<InventoryTurnoverRow[]> {
  const { data, error } = await supabase.rpc("analytics_inventory_turnover", { p_from: from, p_to: to })
  if (error) raise(error, "Could not load inventory turnover.")
  return (data ?? []).map((row: any) => ({
    categoryName: row.category_name, cogs: Number(row.cogs), currentInventoryValue: Number(row.current_inventory_value),
    turnoverRatio: row.turnover_ratio != null ? Number(row.turnover_ratio) : null,
  }))
}

export interface SupplierPerformanceRow {
  supplierName: string
  deliveryCount: number
  unitsReceived: number
  totalCost: number
  avgUnitCost: number | null
}

export async function loadSupplierPerformance(from: string, to: string): Promise<SupplierPerformanceRow[]> {
  const { data, error } = await supabase.rpc("analytics_supplier_performance", { p_from: from, p_to: to })
  if (error) raise(error, "Could not load supplier performance.")
  return (data ?? []).map((row: any) => ({
    supplierName: row.supplier_name, deliveryCount: row.delivery_count, unitsReceived: Number(row.units_received),
    totalCost: Number(row.total_cost), avgUnitCost: row.avg_unit_cost != null ? Number(row.avg_unit_cost) : null,
  }))
}

export interface SalesHeatmapCell {
  dayOfWeek: number
  hourOfDay: number
  revenue: number
  transactionCount: number
}

export async function loadSalesHeatmap(from: string, to: string): Promise<SalesHeatmapCell[]> {
  const { data, error } = await supabase.rpc("analytics_sales_heatmap", { p_from: from, p_to: to })
  if (error) raise(error, "Could not load the sales heatmap.")
  return (data ?? []).map((row: any) => ({
    dayOfWeek: row.day_of_week, hourOfDay: row.hour_of_day, revenue: Number(row.revenue), transactionCount: row.transaction_count,
  }))
}

export interface BasketSizePoint {
  periodStart: string
  avgItemsPerSale: number
  avgRevenuePerSale: number
  transactionCount: number
}

export async function loadBasketSize(from: string, to: string, bucket: TrendBucket = "day"): Promise<BasketSizePoint[]> {
  const { data, error } = await supabase.rpc("analytics_basket_size", { p_from: from, p_to: to, p_bucket: bucket })
  if (error) raise(error, "Could not load basket size.")
  return (data ?? []).map((row: any) => ({
    periodStart: row.period_start, avgItemsPerSale: Number(row.avg_items_per_sale), avgRevenuePerSale: Number(row.avg_revenue_per_sale),
    transactionCount: row.transaction_count,
  }))
}

export interface DiscountUsageRow {
  discountName: string
  discountType: string
  usageCount: number
  revenueWithDiscount: number
  estimatedDiscountValue: number
}

export async function loadDiscountUsage(from: string, to: string): Promise<DiscountUsageRow[]> {
  const { data, error } = await supabase.rpc("analytics_discount_usage", { p_from: from, p_to: to })
  if (error) raise(error, "Could not load discount usage.")
  return (data ?? []).map((row: any) => ({
    discountName: row.discount_name, discountType: row.discount_type, usageCount: row.usage_count,
    revenueWithDiscount: Number(row.revenue_with_discount), estimatedDiscountValue: Number(row.estimated_discount_value),
  }))
}

export interface ClaimAgingBucket {
  ageBucket: string
  claimCount: number
  totalAmount: number
}

export async function loadInsuranceClaimAging(): Promise<ClaimAgingBucket[]> {
  const { data, error } = await supabase.rpc("analytics_insurance_claim_aging")
  if (error) raise(error, "Could not load claim aging.")
  return (data ?? []).map((row: any) => ({ ageBucket: row.age_bucket, claimCount: row.claim_count, totalAmount: Number(row.total_amount) }))
}

export interface ProviderComparisonRow {
  providerName: string
  claimCount: number
  approvedCount: number
  approvalRate: number | null
  avgClaimAmount: number
  avgCoveragePercentage: number | null
}

export async function loadInsuranceProviderComparison(from: string, to: string): Promise<ProviderComparisonRow[]> {
  const { data, error } = await supabase.rpc("analytics_insurance_provider_comparison", { p_from: from, p_to: to })
  if (error) raise(error, "Could not load provider comparison.")
  return (data ?? []).map((row: any) => ({
    providerName: row.provider_name, claimCount: row.claim_count, approvedCount: row.approved_count,
    approvalRate: row.approval_rate != null ? Number(row.approval_rate) : null,
    avgClaimAmount: Number(row.avg_claim_amount), avgCoveragePercentage: row.avg_coverage_percentage != null ? Number(row.avg_coverage_percentage) : null,
  }))
}

export interface SellerProductivityRow {
  sellerName: string
  sellerRole: string
  transactionCount: number
  revenue: number
  activeHours: number
  revenuePerHour: number | null
  transactionsPerHour: number | null
}

export async function loadSellerProductivity(from: string, to: string): Promise<SellerProductivityRow[]> {
  const { data, error } = await supabase.rpc("analytics_seller_productivity", { p_from: from, p_to: to })
  if (error) raise(error, "Could not load seller productivity.")
  return (data ?? []).map((row: any) => ({
    sellerName: row.seller_name, sellerRole: row.seller_role, transactionCount: row.transaction_count, revenue: Number(row.revenue),
    activeHours: Number(row.active_hours), revenuePerHour: row.revenue_per_hour != null ? Number(row.revenue_per_hour) : null,
    transactionsPerHour: row.transactions_per_hour != null ? Number(row.transactions_per_hour) : null,
  }))
}

export interface RecallLogRow {
  productName: string
  dosage: string | null
  batchNumber: string
  manufacturerName: string | null
  reason: string
  recalledByName: string | null
  recalledAt: string
}

export async function loadRecallLog(limit = 50): Promise<RecallLogRow[]> {
  const { data, error } = await supabase.rpc("analytics_recall_log", { p_limit: limit })
  if (error) raise(error, "Could not load the recall log.")
  return (data ?? []).map((row: any) => ({
    productName: row.product_name, dosage: row.dosage, batchNumber: row.batch_number, manufacturerName: row.manufacturer_name,
    reason: row.reason, recalledByName: row.recalled_by_name, recalledAt: row.recalled_at,
  }))
}

export interface PatientRetentionRow {
  patientName: string
  lastVisit: string
  daysSinceLastVisit: number
  pastVisitCount: number
  lifetimeSpend: number
}

export async function loadPatientRetention(opts: { lookbackDays?: number; inactiveDays?: number; limit?: number } = {}): Promise<PatientRetentionRow[]> {
  const { data, error } = await supabase.rpc("analytics_patient_retention", {
    p_lookback_days: opts.lookbackDays ?? 180, p_inactive_days: opts.inactiveDays ?? 60, p_limit: opts.limit ?? 20,
  })
  if (error) raise(error, "Could not load patient retention.")
  return (data ?? []).map((row: any) => ({
    patientName: row.patient_name, lastVisit: row.last_visit, daysSinceLastVisit: row.days_since_last_visit,
    pastVisitCount: row.past_visit_count, lifetimeSpend: Number(row.lifetime_spend),
  }))
}
