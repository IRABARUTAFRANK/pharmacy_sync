import { Fragment, useEffect, useMemo, useState } from "react"
import { Area, Bar, BarChart, CartesianGrid, Cell, ComposedChart, Legend, Line, Pie, PieChart, ResponsiveContainer, Tooltip, XAxis, YAxis } from "recharts"
import { Btn, Card, CenterAlert, ChartTooltip, ExportModal, Modal, SectionHeader, StatusBadge, Table } from "../components"
import { fmtRWFExact } from "../data"
import type { ReportSection } from "../lib/export"
import { useTranslation } from "../lib/i18n"
import type { TranslationKey } from "../lib/i18n/en"
import { resolveRange, toDateInputValue, type OverviewPeriod } from "../lib/overview"
import { listBranchPatients } from "../lib/patients"
import { loadReceivingReference, type ReceivingCategory, type ReceivingProduct } from "../lib/receiving"
import { loadBranchInsuranceClaims, loadInsuranceProviders, type InsuranceProvider } from "../lib/sales"
import { useSessionDraft } from "../lib/sessionDraft"
import {
  loadBasketSize, loadBranchSnapshot, loadCategoryBreakdown, loadDeadStock, loadDiscountUsage, loadInsuranceClaimAging,
  loadInsuranceProviderComparison, loadInsuranceSummary, loadInventoryTurnover, loadPatientRetention, loadPatientSummary,
  loadRecallLog, loadSalesForecast, loadSalesForecastAccuracy, loadSalesForecastSeries, loadSalesHeatmap, loadSalesTrend, loadSellerPerformance, loadSellerProductivity,
  loadStockAdjustments, loadStockStatus, loadSupplierPerformance, loadTopProducts, saveSalesForecastSnapshot,
  type BasketSizePoint, type BranchSnapshot, type CategoryBreakdownRow, type ClaimAgingBucket, type DeadStockRow,
  type DiscountUsageRow, type InsuranceSummaryRow, type InventoryTurnoverRow, type PatientRetentionRow, type PatientSummary,
  type ProviderComparisonRow, type RecallLogRow, type SalesForecast, type SalesForecastAccuracyPoint, type SalesForecastPoint, type SalesHeatmapCell, type SalesTrendPoint,
  type SellerPerformanceRow, type SellerProductivityRow, type StockAdjustmentRow, type StockFilter, type StockStatusRow,
  type SupplierPerformanceRow, type TopProductRow, type TrendBucket,
} from "../lib/analytics"

// Same validated categorical palette as InsurancePage.tsx's donut chart --
// see that file's comment for the ΔE/contrast numbers this order clears.
const CATEGORICAL_COLORS = ["#2a78d6", "#eb6834", "#1baf7a", "#eda100", "#e87ba4", "#4a3aa7", "#e34948", "#008300"]

// ─── Customizable Reports ───────────────────────────────────────────────────
// Each card fetches fresh data for whatever period the viewer picks in
// PeriodPickerModal below -- a real report scoped to Today/This Week/Last
// Month/a custom range, not a repackaging of whatever the page's own charts
// currently happen to show. Two categories a reference design showed were
// deliberately left out rather than faked:
//   Profit & Loss   -- this schema has no expense/COGS-at-the-business-level
//                      table, so there's no honest way to produce a real P&L.
//   RRA Compliance  -- the RRA VSDC tax-invoice integration isn't built yet
//                      (see the Overview page's "RRA / VSDC -- Not configured"
//                      tile); a "ready for RRA submission" report would be a
//                      claim this branch can't back up.
// Seller Productivity and the Batch Recall Log take their place, and Sales
// Forecast / Category & Discounts / Supplier Performance round out the set --
// all real, already-built analytics_*/ai_* functions this page's own charts
// call, just not previously offered as a downloadable report.
interface ReportDef {
  id: string
  icon: string
  titleKey: TranslationKey
  descKey: TranslationKey
  tagKey: TranslationKey
  color: string
}

const REPORT_DEFS: ReportDef[] = [
  { id: "sales", icon: "📊", titleKey: "analyticsPage.reportSalesTitle", descKey: "analyticsPage.reportSalesDesc", tagKey: "analyticsPage.reportTagSales", color: "#2a78d6" },
  { id: "inventory", icon: "📦", titleKey: "analyticsPage.reportInventoryTitle", descKey: "analyticsPage.reportInventoryDesc", tagKey: "analyticsPage.reportTagInventory", color: "#16a34a" },
  { id: "insurance", icon: "🏥", titleKey: "analyticsPage.reportInsuranceTitle", descKey: "analyticsPage.reportInsuranceDesc", tagKey: "analyticsPage.reportTagInsurance", color: "#7c3aed" },
  { id: "patients", icon: "🧑", titleKey: "analyticsPage.reportPatientsTitle", descKey: "analyticsPage.reportPatientsDesc", tagKey: "analyticsPage.reportTagPatients", color: "#e87ba4" },
  { id: "productivity", icon: "⏱️", titleKey: "analyticsPage.reportProductivityTitle", descKey: "analyticsPage.reportProductivityDesc", tagKey: "analyticsPage.reportTagStaff", color: "#0d9488" },
  { id: "recalls", icon: "🚨", titleKey: "analyticsPage.reportRecallsTitle", descKey: "analyticsPage.reportRecallsDesc", tagKey: "analyticsPage.reportTagCompliance", color: "#dc2626" },
  { id: "forecast", icon: "🔮", titleKey: "analyticsPage.reportForecastTitle", descKey: "analyticsPage.reportForecastDesc", tagKey: "analyticsPage.reportTagForecast", color: "#f59e0b" },
  { id: "category", icon: "🏷️", titleKey: "analyticsPage.reportCategoryTitle", descKey: "analyticsPage.reportCategoryDesc", tagKey: "analyticsPage.reportTagCategory", color: "#0ea5e9" },
  { id: "supplier", icon: "🚚", titleKey: "analyticsPage.reportSupplierTitle", descKey: "analyticsPage.reportSupplierDesc", tagKey: "analyticsPage.reportTagSupplier", color: "#eb6834" },
]

function isoDate(d: Date): string {
  return d.toISOString().slice(0, 10)
}
function daysAgo(n: number): string {
  const d = new Date()
  d.setDate(d.getDate() - n)
  return isoDate(d)
}

// ─── Report period picker ───────────────────────────────────────────────────
// One shared "which period?" step in front of every report card -- Today,
// this/last week, this/last month, trailing 7/30/90 days, or a custom range --
// resolved to real from/to dates the same lib/analytics.ts functions the rest
// of this page already calls take as plain arguments.
type PeriodPresetId = "today" | "yesterday" | "thisWeek" | "lastWeek" | "thisMonth" | "lastMonth" | "last7" | "last30" | "last90" | "custom"

const PERIOD_PRESETS: { id: PeriodPresetId; labelKey: TranslationKey }[] = [
  { id: "today", labelKey: "analyticsPage.periodToday" },
  { id: "yesterday", labelKey: "analyticsPage.periodYesterday" },
  { id: "thisWeek", labelKey: "analyticsPage.periodThisWeek" },
  { id: "lastWeek", labelKey: "analyticsPage.periodLastWeek" },
  { id: "thisMonth", labelKey: "analyticsPage.periodThisMonth" },
  { id: "lastMonth", labelKey: "analyticsPage.periodLastMonth" },
  { id: "last7", labelKey: "analyticsPage.periodLast7" },
  { id: "last30", labelKey: "analyticsPage.periodLast30" },
  { id: "last90", labelKey: "analyticsPage.periodLast90" },
  { id: "custom", labelKey: "analyticsPage.periodCustom" },
]

interface ResolvedPeriod {
  from: string
  to: string
  label: string
}

function startOfWeek(d: Date): Date {
  const day = new Date(d)
  day.setHours(0, 0, 0, 0)
  const diff = (day.getDay() + 6) % 7 // Monday-first
  return new Date(day.getTime() - diff * 86_400_000)
}

function resolvePeriodPreset(id: PeriodPresetId, label: string, customFrom: string, customTo: string): ResolvedPeriod {
  const now = new Date()
  switch (id) {
    case "today":
      return { from: isoDate(now), to: isoDate(now), label }
    case "yesterday": {
      const y = new Date(now); y.setDate(y.getDate() - 1)
      return { from: isoDate(y), to: isoDate(y), label }
    }
    case "thisWeek":
      return { from: isoDate(startOfWeek(now)), to: isoDate(now), label }
    case "lastWeek": {
      const start = startOfWeek(now)
      const prevStart = new Date(start.getTime() - 7 * 86_400_000)
      const prevEnd = new Date(start.getTime() - 1 * 86_400_000)
      return { from: isoDate(prevStart), to: isoDate(prevEnd), label }
    }
    case "thisMonth":
      return { from: isoDate(new Date(now.getFullYear(), now.getMonth(), 1)), to: isoDate(now), label }
    case "lastMonth": {
      const start = new Date(now.getFullYear(), now.getMonth() - 1, 1)
      const end = new Date(now.getFullYear(), now.getMonth(), 0)
      return { from: isoDate(start), to: isoDate(end), label }
    }
    case "last7":
      return { from: daysAgo(7), to: isoDate(now), label }
    case "last30":
      return { from: daysAgo(30), to: isoDate(now), label }
    case "last90":
      return { from: daysAgo(90), to: isoDate(now), label }
    case "custom":
      return { from: customFrom, to: customTo, label: `${customFrom} → ${customTo}` }
  }
}

function PeriodPickerModal({ def, onClose, onConfirm }: { def: ReportDef; onClose: () => void; onConfirm: (period: ResolvedPeriod) => void }) {
  const { t } = useTranslation()
  const [presetId, setPresetId] = useState<PeriodPresetId>("last30")
  const [customFrom, setCustomFrom] = useState(daysAgo(30))
  const [customTo, setCustomTo] = useState(isoDate(new Date()))

  return (
    <Modal title={t("analyticsPage.periodPickerTitle", { report: t(def.titleKey) })} onClose={onClose} width={440}>
      <div style={{ display: "flex", flexDirection: "column", gap: 14 }}>
        <div style={{ fontSize: 12, color: "var(--ink-muted)" }}>{t("analyticsPage.periodPickerSubtitle")}</div>
        <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 8 }}>
          {PERIOD_PRESETS.map(p => (
            <button
              key={p.id}
              onClick={() => setPresetId(p.id)}
              style={{
                padding: "9px 12px", borderRadius: 8, fontSize: 12, fontWeight: 600, cursor: "pointer", fontFamily: "inherit",
                border: `1.5px solid ${presetId === p.id ? "var(--primary)" : "var(--border)"}`,
                background: presetId === p.id ? "var(--primary-light)" : "var(--surface)",
                color: presetId === p.id ? "var(--primary)" : "var(--ink-mid)",
              }}
            >
              {t(p.labelKey)}
            </button>
          ))}
        </div>
        {presetId === "custom" && (
          <div style={{ display: "flex", gap: 10 }}>
            <div>
              <label style={FIELD_LABEL_STYLE}>{t("analyticsPage.dateFromLabel")}</label>
              <input type="date" value={customFrom} onChange={e => setCustomFrom(e.target.value)} style={DATE_INPUT_STYLE} />
            </div>
            <div>
              <label style={FIELD_LABEL_STYLE}>{t("analyticsPage.dateToLabel")}</label>
              <input type="date" value={customTo} onChange={e => setCustomTo(e.target.value)} style={DATE_INPUT_STYLE} />
            </div>
          </div>
        )}
        <div style={{ display: "flex", gap: 8, justifyContent: "flex-end" }}>
          <Btn variant="secondary" onClick={onClose}>{t("analyticsPage.periodCancel")}</Btn>
          <Btn variant="primary" onClick={() => onConfirm(resolvePeriodPreset(presetId, t(PERIOD_PRESETS.find(p => p.id === presetId)!.labelKey), customFrom, customTo))}>
            {t("analyticsPage.periodContinue")}
          </Btn>
        </div>
      </div>
    </Modal>
  )
}

// Shown only for the Insurance report, right after the period is picked --
// each insurer needs its own claim document, so this asks which one (or "all
// providers" to keep today's combined summary+aging behavior unchanged).
// See generateReport()'s "insurance" branch for what each choice produces.
function InsuranceProviderPickerModal({ providers, onClose, onConfirm }: {
  providers: InsuranceProvider[]
  onClose: () => void
  onConfirm: (providerId: string | null, providerName: string | null) => void
}) {
  const { t } = useTranslation()
  const [providerId, setProviderId] = useState("")

  return (
    <Modal title={t("analyticsPage.insuranceProviderPickerTitle")} onClose={onClose} width={420}>
      <div style={{ display: "flex", flexDirection: "column", gap: 14 }}>
        <div style={{ fontSize: 12, color: "var(--ink-muted)" }}>{t("analyticsPage.insuranceProviderPickerSubtitle")}</div>
        <select value={providerId} onChange={e => setProviderId(e.target.value)} style={SELECT_STYLE}>
          <option value="">{t("analyticsPage.insuranceProviderAllOption")}</option>
          {providers.map(p => <option key={p.id} value={p.id}>{p.name}</option>)}
        </select>
        <div style={{ display: "flex", gap: 8, justifyContent: "flex-end" }}>
          <Btn variant="secondary" onClick={onClose}>{t("analyticsPage.periodCancel")}</Btn>
          <Btn variant="primary" onClick={() => onConfirm(providerId || null, providers.find(p => p.id === providerId)?.name ?? null)}>
            {t("analyticsPage.periodContinue")}
          </Btn>
        </div>
      </div>
    </Modal>
  )
}

function StatTile({ label, value, accent }: { label: string; value: string; accent?: string }) {
  return (
    <div style={{ flex: "1 1 150px", minWidth: 140, background: "var(--surface)", border: "1px solid var(--border)", borderRadius: 12, padding: "14px 16px" }}>
      <div style={{ fontSize: 19, fontWeight: 700, color: accent ?? "var(--ink)", letterSpacing: "-0.01em" }}>{value}</div>
      <div style={{ fontSize: 11, color: "var(--ink-muted)", marginTop: 2 }}>{label}</div>
    </div>
  )
}

const DATE_INPUT_STYLE = { padding: "7px 10px", border: "1px solid var(--border)", borderRadius: 8, fontFamily: "inherit", fontSize: 12 }
const SELECT_STYLE = { padding: "7px 10px", border: "1px solid var(--border)", borderRadius: 8, fontFamily: "inherit", fontSize: 12, background: "var(--surface)" }
const FIELD_LABEL_STYLE = { display: "block", fontSize: 10, fontWeight: 600, color: "var(--ink-muted)", textTransform: "uppercase" as const, letterSpacing: "0.05em", marginBottom: 4 }
const EMPTY_STATE_STYLE = { padding: 20, textAlign: "center" as const, color: "var(--ink-muted)", fontSize: 12 }

// ai_sales_forecast_series() auto-picks day/week/month bucketing server-side
// from the requested span rather than returning which one it chose -- this
// infers it from the actual gap between the first two points so the x-axis
// label style matches what was returned, without adding a second RPC field.
function inferForecastGranularity(periods: string[]): "day" | "week" | "month" {
  if (periods.length < 2) return "month"
  const gapDays = (new Date(periods[1]).getTime() - new Date(periods[0]).getTime()) / 86400000
  if (gapDays <= 2) return "day"
  if (gapDays <= 10) return "week"
  return "month"
}

function formatForecastPeriodLabel(iso: string, granularity: "day" | "week" | "month", lang: string): string {
  const d = new Date(iso)
  return granularity === "month"
    ? d.toLocaleDateString(lang, { month: "short", year: "2-digit" })
    : d.toLocaleDateString(lang, { month: "short", day: "numeric" })
}

// Everything on this page calls the same read-only, branch-scoped SQL
// functions the AI analyst uses as tools -- directly, no LLM involved. Real
// numbers (the forecast is real linear regression, computed in Postgres),
// zero API cost, and it works even when the AI analyst doesn't.
export default function AnalyticsPage({ period, branchId }: { period?: OverviewPeriod; branchId?: string }) {
  const { t, lang } = useTranslation()
  const [error, setError] = useState("")

  const STOCK_STATUS_STYLE: Record<StockStatusRow["status"], { color: string; bg: string }> = {
    out: { color: "#dc2626", bg: "#fef2f2" },
    expired: { color: "#dc2626", bg: "#fef2f2" },
    expiring: { color: "#d97706", bg: "#fef3c7" },
    low: { color: "#d97706", bg: "#fef3c7" },
    ok: { color: "#16a34a", bg: "#f0fdf4" },
  }
  const STOCK_STATUS_LABEL: Record<StockStatusRow["status"], string> = {
    out: t("analyticsPage.stockOut"), expired: t("analyticsPage.stockExpired"), expiring: t("analyticsPage.stockExpiring"),
    low: t("analyticsPage.stockLow"), ok: t("analyticsPage.stockOk"),
  }
  const STOCK_FILTER_LABEL: Record<StockFilter, string> = {
    all: t("analyticsPage.stockAll"), low: t("analyticsPage.stockLow"), out: t("analyticsPage.stockOut"),
    expiring: t("analyticsPage.stockExpiring"), expired: t("analyticsPage.stockExpired"),
  }

  const [snapshot, setSnapshot] = useState<BranchSnapshot | null>(null)
  const [snapshotLoading, setSnapshotLoading] = useState(true)

  // dateFrom through retentionInactive below all survive navigating to
  // another page and back (Sales, Alerts, anywhere) via useSessionDraft --
  // see lib/sessionDraft.ts. This is filter/configuration state, not raw
  // data (the data itself is always re-fetched fresh from these values by
  // the effects below), but re-picking a custom date range, forecast
  // product, or retention window every time is exactly the kind of lost
  // work this page shouldn't force after a quick trip to check something
  // else.
  const [dateFrom, setDateFrom] = useSessionDraft("analytics_dateFrom", daysAgo(30))
  const [dateTo, setDateTo] = useSessionDraft("analytics_dateTo", daysAgo(0))
  const [bucket, setBucket] = useSessionDraft<TrendBucket>("analytics_bucket", "day")
  const [trend, setTrend] = useState<SalesTrendPoint[]>([])
  const [trendLoading, setTrendLoading] = useState(true)

  // Top-bar date-range dropdown pre-fills From/To below, same as
  // Transactions/History -- "Custom Range" leaves whatever's already picked
  // here alone, since this page's own inputs already are the custom range.
  useEffect(() => {
    if (!period || period === "custom") return
    const range = resolveRange(period)
    setDateFrom(toDateInputValue(range.start))
    setDateTo(toDateInputValue(range.end))
  }, [period])

  const [topMetric, setTopMetric] = useSessionDraft<"revenue" | "quantity">("analytics_topMetric", "revenue")
  const [topDirection, setTopDirection] = useSessionDraft<"asc" | "desc">("analytics_topDirection", "desc")
  const [topProducts, setTopProducts] = useState<TopProductRow[]>([])

  const [categoryBreakdown, setCategoryBreakdown] = useState<CategoryBreakdownRow[]>([])

  const [stockFilter, setStockFilter] = useSessionDraft<StockFilter>("analytics_stockFilter", "all")
  const [stockRows, setStockRows] = useState<StockStatusRow[]>([])
  const [stockLoading, setStockLoading] = useState(true)

  const [reference, setReference] = useState<{ products: ReceivingProduct[]; categories: ReceivingCategory[] } | null>(null)
  const [forecastProductId, setForecastProductId] = useSessionDraft("analytics_forecastProductId", "")
  const [forecastCategoryId, setForecastCategoryId] = useSessionDraft("analytics_forecastCategoryId", "")
  const [forecastHorizon, setForecastHorizon] = useSessionDraft("analytics_forecastHorizon", 30)
  const [forecastHistory, setForecastHistory] = useSessionDraft("analytics_forecastHistory", 90)
  const [forecast, setForecast] = useState<SalesForecast | null>(null)
  const [forecastSeries, setForecastSeries] = useState<SalesForecastPoint[]>([])
  const [forecastAccuracy, setForecastAccuracy] = useState<SalesForecastAccuracyPoint[]>([])
  const [forecastLoading, setForecastLoading] = useState(false)

  const [insurance, setInsurance] = useState<InsuranceSummaryRow[]>([])
  const [sellers, setSellers] = useState<SellerPerformanceRow[]>([])
  const [patients, setPatients] = useState<PatientSummary | null>(null)

  // ── Inventory operations, sales patterns, insurance depth (share the same
  // date range + bucket above) ──
  const [stockAdjustments, setStockAdjustments] = useState<StockAdjustmentRow[]>([])
  const [inventoryTurnover, setInventoryTurnover] = useState<InventoryTurnoverRow[]>([])
  const [supplierPerformance, setSupplierPerformance] = useState<SupplierPerformanceRow[]>([])
  const [salesHeatmap, setSalesHeatmap] = useState<SalesHeatmapCell[]>([])
  const [basketSize, setBasketSize] = useState<BasketSizePoint[]>([])
  const [discountUsage, setDiscountUsage] = useState<DiscountUsageRow[]>([])
  const [providerComparison, setProviderComparison] = useState<ProviderComparisonRow[]>([])
  const [sellerProductivity, setSellerProductivity] = useState<SellerProductivityRow[]>([])

  // ── Extras with their own controls ──
  const [deadStockDays, setDeadStockDays] = useSessionDraft("analytics_deadStockDays", 60)
  const [deadStock, setDeadStock] = useState<DeadStockRow[]>([])
  const [deadStockLoading, setDeadStockLoading] = useState(true)

  const [claimAging, setClaimAging] = useState<ClaimAgingBucket[]>([])
  const [recallLog, setRecallLog] = useState<RecallLogRow[]>([])

  const [retentionLookback, setRetentionLookback] = useSessionDraft("analytics_retentionLookback", 180)
  const [retentionInactive, setRetentionInactive] = useSessionDraft("analytics_retentionInactive", 60)
  const [patientRetention, setPatientRetention] = useState<PatientRetentionRow[]>([])
  const [retentionLoading, setRetentionLoading] = useState(true)

  useEffect(() => {
    setSnapshotLoading(true)
    loadBranchSnapshot(branchId).then(setSnapshot).catch(reason => setError(reason instanceof Error ? reason.message : t("analyticsPage.errorSnapshot"))).finally(() => setSnapshotLoading(false))
    loadReceivingReference().then(ref => setReference({ products: ref.products, categories: ref.categories })).catch(() => { /* forecast pickers just stay empty */ })
    loadInsuranceClaimAging(branchId).then(setClaimAging).catch(reason => setError(reason instanceof Error ? reason.message : t("analyticsPage.errorClaimAging")))
    loadRecallLog(50).then(setRecallLog).catch(reason => setError(reason instanceof Error ? reason.message : t("analyticsPage.errorRecallLog")))
    loadInsuranceProviders().then(setInsuranceProviders).catch(reason => setError(reason instanceof Error ? reason.message : t("analyticsPage.errorInsuranceProviders")))
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [branchId])

  useEffect(() => {
    setTrendLoading(true)
    setStockLoading(true)
    Promise.all([
      loadSalesTrend(dateFrom, dateTo, bucket, branchId).then(setTrend),
      loadTopProducts(dateFrom, dateTo, topMetric, topDirection, 10, branchId).then(setTopProducts),
      loadCategoryBreakdown(dateFrom, dateTo, branchId).then(setCategoryBreakdown),
      loadInsuranceSummary(dateFrom, dateTo, branchId).then(setInsurance),
      loadSellerPerformance(dateFrom, dateTo, branchId).then(setSellers),
      loadPatientSummary(dateFrom, dateTo, branchId).then(setPatients),
      loadStockAdjustments(dateFrom, dateTo, branchId).then(setStockAdjustments),
      loadInventoryTurnover(dateFrom, dateTo, branchId).then(setInventoryTurnover),
      loadSupplierPerformance(dateFrom, dateTo, branchId).then(setSupplierPerformance),
      loadSalesHeatmap(dateFrom, dateTo, branchId).then(setSalesHeatmap),
      loadBasketSize(dateFrom, dateTo, bucket, branchId).then(setBasketSize),
      loadDiscountUsage(dateFrom, dateTo, branchId).then(setDiscountUsage),
      loadInsuranceProviderComparison(dateFrom, dateTo, branchId).then(setProviderComparison),
      loadSellerProductivity(dateFrom, dateTo, branchId).then(setSellerProductivity),
    ]).catch(reason => setError(reason instanceof Error ? reason.message : t("analyticsPage.errorRange"))).finally(() => setTrendLoading(false))
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [dateFrom, dateTo, bucket, topMetric, topDirection, branchId])

  useEffect(() => {
    setStockLoading(true)
    loadStockStatus(stockFilter, branchId).then(setStockRows).catch(reason => setError(reason instanceof Error ? reason.message : t("analyticsPage.errorStock"))).finally(() => setStockLoading(false))
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [stockFilter, branchId])

  useEffect(() => {
    setDeadStockLoading(true)
    loadDeadStock(deadStockDays, 50, branchId).then(setDeadStock).catch(reason => setError(reason instanceof Error ? reason.message : t("analyticsPage.errorDeadStock"))).finally(() => setDeadStockLoading(false))
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [deadStockDays, branchId])

  async function runPatientRetention() {
    setRetentionLoading(true)
    try {
      setPatientRetention(await loadPatientRetention({ lookbackDays: retentionLookback, inactiveDays: retentionInactive, limit: 20, branchId }))
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : t("analyticsPage.errorRetention"))
    } finally {
      setRetentionLoading(false)
    }
  }

  useEffect(() => {
    void runPatientRetention()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [branchId])

  async function runForecast() {
    setForecastLoading(true)
    setError("")
    try {
      const scope = { productId: forecastProductId || null, categoryId: forecastCategoryId || null, daysHistory: forecastHistory, horizonDays: forecastHorizon, branchId }
      const [summary, series] = await Promise.all([loadSalesForecast(scope), loadSalesForecastSeries(scope)])
      setForecast(summary)
      setForecastSeries(series)

      // Remember this run's future points (deduped to one per day server-
      // side) so a later run can show what was predicted next to what
      // actually happened -- see the forecastAccuracy line on the chart.
      // Best-effort: a failure here shouldn't block showing the forecast
      // itself, just means today's snapshot didn't get saved.
      const actualPeriods = series.filter(p => !p.isForecast).map(p => p.periodStart)
      const futurePoints = series.filter(p => p.isForecast)
      if (futurePoints.length > 0) {
        const bucket = inferForecastGranularity(series.map(p => p.periodStart))
        void saveSalesForecastSnapshot({
          productId: scope.productId, categoryId: scope.categoryId, bucket,
          points: futurePoints.map(p => ({
            periodStart: p.periodStart, predictedRevenue: p.forecastRevenue, predictedQuantity: p.forecastQuantity,
            lowerBound: p.lowerBound, upperBound: p.upperBound,
          })),
          branchId,
        }).catch(reason => console.error("Could not save forecast snapshot:", reason))
      }
      if (actualPeriods.length > 0) {
        loadSalesForecastAccuracy({
          productId: scope.productId, categoryId: scope.categoryId,
          from: actualPeriods[0], to: actualPeriods[actualPeriods.length - 1], branchId,
        }).then(setForecastAccuracy).catch(reason => console.error("Could not load forecast accuracy:", reason))
      } else {
        setForecastAccuracy([])
      }
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : t("analyticsPage.errorForecast"))
    } finally {
      setForecastLoading(false)
    }
  }

  // Runs on its own -- on first load, and again whenever the picked medicine/
  // category or the history/horizon window changes -- so the chart is always
  // showing the current selection without waiting on a button click. The
  // 400ms debounce is only to stop every keystroke in the history/horizon
  // number inputs from firing its own request; picking a product still feels
  // instant since a select's onChange only fires once per pick anyway.
  useEffect(() => {
    const handle = setTimeout(() => { void runForecast() }, 400)
    return () => clearTimeout(handle)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [forecastProductId, forecastCategoryId, forecastHistory, forecastHorizon, branchId])

  const forecastGranularity = useMemo(() => inferForecastGranularity(forecastSeries.map(p => p.periodStart)), [forecastSeries])
  const forecastChartData = useMemo(() => {
    const accuracyByPeriod = new Map(forecastAccuracy.map(a => [a.periodStart, a.predictedRevenue]))
    return forecastSeries.map(p => ({
      label: formatForecastPeriodLabel(p.periodStart, forecastGranularity, lang),
      actualRevenue: p.actualRevenue,
      forecastRevenue: p.forecastRevenue,
      previouslyPredictedRevenue: accuracyByPeriod.get(p.periodStart) ?? undefined,
      range: p.lowerBound != null && p.upperBound != null ? [p.lowerBound, p.upperBound] : undefined,
    }))
  }, [forecastSeries, forecastAccuracy, forecastGranularity, lang])

  const [pickerDef, setPickerDef] = useState<ReportDef | null>(null)
  const [reportLoadingId, setReportLoadingId] = useState<string | null>(null)
  const [activeReport, setActiveReport] = useState<{ def: ReportDef; period: ResolvedPeriod; insuranceProviderName?: string | null } | null>(null)
  const [reportSections, setReportSections] = useState<ReportSection[] | null>(null)
  // Insurance report only: period is picked first (same as every other
  // report), then this holds it while the provider picker (below) asks which
  // insurer -- or "all providers" -- before generateReport() actually runs.
  const [pendingInsuranceReport, setPendingInsuranceReport] = useState<{ def: ReportDef; period: ResolvedPeriod } | null>(null)
  const [insuranceProviders, setInsuranceProviders] = useState<InsuranceProvider[]>([])

  // Days between the chosen from/to, inclusive -- used to translate a
  // calendar period into the "how many days back" windows a few analytics_*
  // functions take instead of a plain from/to range (dead stock, patient
  // retention, the forecast's training history).
  function periodSpanDays(period: ResolvedPeriod): number {
    const ms = new Date(period.to).getTime() - new Date(period.from).getTime()
    return Math.max(1, Math.round(ms / 86_400_000) + 1)
  }

  // Every report fetches its own fresh data for the chosen period -- it does
  // NOT reuse this page's own dateFrom/dateTo state, so picking "Today" for a
  // report works regardless of what date range the charts elsewhere on this
  // page currently happen to be showing.
  async function generateReport(def: ReportDef, period: ResolvedPeriod, insuranceProviderId?: string | null, insuranceProviderName?: string | null) {
    setReportLoadingId(def.id)
    setError("")
    try {
      let sections: ReportSection[]
      if (def.id === "sales") {
        const [trendData, topData] = await Promise.all([
          loadSalesTrend(period.from, period.to, "day", branchId),
          loadTopProducts(period.from, period.to, "revenue", "desc", 10, branchId),
        ])
        sections = [
          {
            title: "Sales Performance",
            headers: ["Period", "Revenue (RWF)", "Transactions", "Avg Basket (RWF)", "Tax (RWF)"],
            rows: trendData.map(p => [
              new Date(p.periodStart).toLocaleDateString(), Math.round(p.revenue), p.transactionCount,
              p.transactionCount > 0 ? Math.round(p.revenue / p.transactionCount) : 0, Math.round(p.tax),
            ]),
          },
          {
            title: "Top Products",
            headers: ["Product", "Dosage", "Units Sold", "Revenue (RWF)"],
            rows: topData.map(p => [p.productName, p.dosage ?? "—", p.quantitySold, Math.round(p.revenue)]),
          },
        ]
      } else if (def.id === "inventory") {
        const [turnoverData, deadStockData] = await Promise.all([
          loadInventoryTurnover(period.from, period.to, branchId),
          loadDeadStock(periodSpanDays(period), 50, branchId),
        ])
        sections = [
          {
            title: "Turnover by Category",
            headers: ["Category", "COGS (RWF)", "Current Inventory Value (RWF)", "Turnover Ratio"],
            rows: turnoverData.map(r => [r.categoryName, Math.round(r.cogs), Math.round(r.currentInventoryValue), r.turnoverRatio == null ? "—" : r.turnoverRatio.toFixed(2)]),
          },
          {
            title: "Slow-Moving Stock",
            headers: ["Product", "Dosage", "Qty on Hand", "Stock Value (RWF)", "Days Since Last Sale"],
            rows: deadStockData.map(r => [r.productName, r.dosage ?? "—", r.quantityOnHand, Math.round(r.stockValue), r.daysSinceLastSale ?? "Never sold"]),
          },
        ]
      } else if (def.id === "insurance") {
        if (insuranceProviderId) {
          // One insurer's own itemized claim list -- the document that
          // actually gets submitted for reimbursement, not an aggregate
          // mixing every insurer together. Claim aging (a live, all-providers
          // snapshot with no provider column of its own) doesn't belong in a
          // single insurer's document, so it's left out of this branch only.
          const from = new Date(period.from).getTime()
          const to = new Date(`${period.to}T23:59:59`).getTime()
          const claims = (await loadBranchInsuranceClaims()).filter(c => {
            const at = new Date(c.submittedAt).getTime()
            return c.providerId === insuranceProviderId && at >= from && at <= to
          })
          sections = [
            {
              title: `Claims — ${insuranceProviderName ?? "Insurer"}`,
              headers: ["Receipt #", "Patient", "Insurance No.", "Date", "Coverage %", "Sale Total (RWF)", "Claim Amount (RWF)", "Status"],
              rows: claims.map(c => [
                c.receiptNumber ?? "—", c.patientName ?? "—", c.patientInsuranceNumber ?? "—",
                new Date(c.submittedAt).toLocaleDateString(), `${c.coveragePercentageApplied}%`,
                Math.round(c.saleTotal), Math.round(c.claimAmount), c.status,
              ]),
            },
          ]
        } else {
          // Claim aging has no from/to of its own -- it's "how old are claims
          // still pending right now", a live snapshot regardless of period.
          const [insuranceData, agingData] = await Promise.all([
            loadInsuranceSummary(period.from, period.to, branchId),
            loadInsuranceClaimAging(branchId),
          ])
          sections = [
            {
              title: "Claims by Insurer",
              headers: ["Provider", "Claims", "Total Claimed (RWF)", "Paid Out (RWF)", "Pending (RWF)"],
              rows: insuranceData.map(r => [r.providerName, r.claimCount, Math.round(r.totalClaimed), Math.round(r.paidOut), Math.round(r.pending)]),
            },
            {
              title: "Claim Aging (live, all pending claims)",
              headers: ["Age", "Claims", "Total Amount (RWF)"],
              rows: agingData.map(r => [r.ageBucket, r.claimCount, Math.round(r.totalAmount)]),
            },
          ]
        }
      } else if (def.id === "patients") {
        // listBranchPatients() has no date filter (a patient's gender/age
        // aren't period-scoped data) -- summary and retention are.
        const spanDays = periodSpanDays(period)
        const [summary, retention, list] = await Promise.all([
          loadPatientSummary(period.from, period.to, branchId),
          loadPatientRetention({ lookbackDays: spanDays, inactiveDays: Math.min(60, spanDays), limit: 20, branchId }),
          listBranchPatients(branchId),
        ])
        let male = 0, female = 0, other = 0, unspecified = 0, ageSum = 0, ageCount = 0
        for (const p of list) {
          if (p.gender === "male") male++
          else if (p.gender === "female") female++
          else if (p.gender === "other") other++
          else unspecified++
          if (p.age != null) { ageSum += p.age; ageCount++ }
        }
        sections = [
          {
            title: "Patient Summary",
            headers: ["Metric", "Value"],
            rows: [
              ["Total Patients Served", summary.totalPatientsServed],
              ["New Patients", summary.newPatients],
              ["Repeat Patients", summary.repeatPatients],
              ["Top Patient", summary.topPatientName ?? "—"],
              ["Top Patient Spend (RWF)", summary.topPatientSpend != null ? Math.round(summary.topPatientSpend) : "—"],
            ],
          },
          {
            title: "Visit Frequency & Spending",
            headers: ["Patient", "Last Visit", "Days Since", "Past Visits", "Lifetime Spend (RWF)"],
            rows: retention.map(r => [r.patientName, new Date(r.lastVisit).toLocaleDateString(), r.daysSinceLastVisit, r.pastVisitCount, Math.round(r.lifetimeSpend)]),
          },
          {
            title: "Demographics (all patients on file)",
            headers: ["Metric", "Value"],
            rows: [
              ["Male", male], ["Female", female], ["Other", other], ["Unspecified", unspecified],
              ["Average Age", ageCount > 0 ? Math.round(ageSum / ageCount) : "—"],
            ],
          },
        ]
      } else if (def.id === "productivity") {
        const data = await loadSellerProductivity(period.from, period.to, branchId)
        sections = [{
          title: "Seller Productivity",
          headers: ["Seller", "Role", "Transactions", "Revenue (RWF)", "Active Hours", "Revenue/Hour (RWF)", "Transactions/Hour"],
          rows: data.map(r => [
            r.sellerName, r.sellerRole, r.transactionCount, Math.round(r.revenue), r.activeHours.toFixed(1),
            r.revenuePerHour == null ? "—" : Math.round(r.revenuePerHour), r.transactionsPerHour == null ? "—" : r.transactionsPerHour.toFixed(2),
          ]),
        }]
      } else if (def.id === "recalls") {
        // analytics_recall_log() takes a row limit, not a date range -- fetch
        // a generous batch and filter to the chosen period client-side.
        const all = await loadRecallLog(500)
        const fromMs = new Date(period.from).getTime()
        const toMs = new Date(period.to).getTime() + 86_400_000 - 1
        const filtered = all.filter(r => { const at = new Date(r.recalledAt).getTime(); return at >= fromMs && at <= toMs })
        sections = [{
          title: "Batch Recall Log",
          headers: ["Product", "Dosage", "Batch Number", "Manufacturer", "Reason", "Recalled By", "Recalled At"],
          rows: filtered.map(r => [r.productName, r.dosage ?? "—", r.batchNumber, r.manufacturerName ?? "—", r.reason, r.recalledByName ?? "—", new Date(r.recalledAt).toLocaleString()]),
        }]
      } else if (def.id === "forecast") {
        // A forecast has no "from/to" of its own -- the chosen period becomes
        // how much sales history to train the projection on.
        const spanDays = periodSpanDays(period)
        const data = await loadSalesForecast({ daysHistory: spanDays, horizonDays: Math.min(90, Math.max(7, spanDays)), branchId })
        sections = [{
          title: "Sales Forecast",
          headers: ["Metric", "Value"],
          rows: [
            ["Scope", data.scope],
            ["Days of History Used", data.daysOfHistory],
            ["Avg Daily Quantity", data.avgDailyQuantity.toFixed(1)],
            ["Trend per Day", data.trendPerDay.toFixed(2)],
            ["Projected Quantity (next period)", Math.round(data.projectedQuantityNextPeriod)],
            ["Projected Revenue (next period, RWF)", Math.round(data.projectedRevenueNextPeriod)],
          ],
        }]
      } else if (def.id === "category") {
        const [catData, discData] = await Promise.all([
          loadCategoryBreakdown(period.from, period.to, branchId),
          loadDiscountUsage(period.from, period.to, branchId),
        ])
        sections = [
          {
            title: "Sales by Category",
            headers: ["Category", "Revenue (RWF)", "Units Sold"],
            rows: catData.map(r => [r.categoryName, Math.round(r.revenue), r.quantitySold]),
          },
          {
            title: "Discount Usage",
            headers: ["Discount", "Type", "Times Used", "Revenue with Discount (RWF)", "Estimated Discount Value (RWF)"],
            rows: discData.map(r => [r.discountName, r.discountType, r.usageCount, Math.round(r.revenueWithDiscount), Math.round(r.estimatedDiscountValue)]),
          },
        ]
      } else {
        const [supData, adjData] = await Promise.all([
          loadSupplierPerformance(period.from, period.to, branchId),
          loadStockAdjustments(period.from, period.to, branchId),
        ])
        sections = [
          {
            title: "Supplier Performance",
            headers: ["Supplier", "Deliveries", "Units Received", "Total Cost (RWF)", "Avg Unit Cost (RWF)"],
            rows: supData.map(r => [r.supplierName, r.deliveryCount, Math.round(r.unitsReceived), Math.round(r.totalCost), r.avgUnitCost != null ? Math.round(r.avgUnitCost) : "—"]),
          },
          {
            title: "Stock Adjustments",
            headers: ["Type", "Staff", "Quantity", "Adjustment Count", "Estimated Value (RWF)"],
            rows: adjData.map(r => [r.adjustmentType, r.staffName, r.quantity, r.adjustmentCount, Math.round(r.estimatedValue)]),
          },
        ]
      }
      setActiveReport({ def, period, insuranceProviderName })
      setReportSections(sections)
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : t("analyticsPage.errorReport"))
    } finally {
      setReportLoadingId(null)
    }
  }

  const categoryChartData = useMemo(
    () => categoryBreakdown.filter(c => c.revenue > 0).map((c, i) => ({ name: c.categoryName, value: c.revenue, color: CATEGORICAL_COLORS[i % CATEGORICAL_COLORS.length] })),
    [categoryBreakdown],
  )
  const trendChartData = useMemo(() => trend.map(p => ({ name: new Date(p.periodStart).toLocaleDateString(undefined, { month: "short", day: "numeric" }), revenue: p.revenue })), [trend])
  const basketChartData = useMemo(() => basketSize.map(p => ({ name: new Date(p.periodStart).toLocaleDateString(undefined, { month: "short", day: "numeric" }), items: p.avgItemsPerSale })), [basketSize])

  const weekdayLabels = useMemo(() => {
    try {
      const fmt = new Intl.DateTimeFormat(lang, { weekday: "short" })
      // 2023-01-01 was a Sunday -- gives day indices 0..6 matching Postgres extract(dow).
      return Array.from({ length: 7 }, (_, i) => fmt.format(new Date(2023, 0, 1 + i)))
    } catch {
      return ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"]
    }
  }, [lang])
  const heatmapMax = useMemo(() => salesHeatmap.reduce((m, c) => Math.max(m, c.revenue), 0), [salesHeatmap])
  const heatmapByCell = useMemo(() => {
    const map = new Map<string, SalesHeatmapCell>()
    salesHeatmap.forEach(c => map.set(`${c.dayOfWeek}-${c.hourOfDay}`, c))
    return map
  }, [salesHeatmap])

  const bucketLabel = bucket === "day" ? t("analyticsPage.bucketDay") : bucket === "week" ? t("analyticsPage.bucketWeek") : t("analyticsPage.bucketMonth")
  const metricLabel = topMetric === "revenue" ? t("analyticsPage.metricRevenue") : t("analyticsPage.metricQuantity")
  const directionLabel = topDirection === "desc" ? t("analyticsPage.directionBest") : t("analyticsPage.directionSlowest")
  const trendWord = forecast && forecast.trendPerDay > 0.01 ? t("analyticsPage.forecastTrendRising")
    : forecast && forecast.trendPerDay < -0.01 ? t("analyticsPage.forecastTrendFalling") : t("analyticsPage.forecastTrendFlat")

  return (
    <div className="animate-fade-in" style={{ display: "flex", flexDirection: "column", gap: 16 }}>
      {error && <CenterAlert key={error} message={error} />}
      <SectionHeader title={t("page.analytics")} subtitle={t("analyticsPage.subtitle")} />

      {/* Snapshot */}
      <div style={{ display: "flex", gap: 10, flexWrap: "wrap" }}>
        <StatTile label={t("analyticsPage.statTodayRevenue")} value={snapshotLoading ? "…" : fmtRWFExact(snapshot?.todayRevenue ?? 0)} accent="var(--primary)" />
        <StatTile label={t("analyticsPage.statWeekToDate")} value={snapshotLoading ? "…" : fmtRWFExact(snapshot?.weekToDateRevenue ?? 0)} />
        <StatTile label={t("analyticsPage.statMonthToDate")} value={snapshotLoading ? "…" : fmtRWFExact(snapshot?.monthToDateRevenue ?? 0)} />
        <StatTile label={t("analyticsPage.statActiveProducts")} value={snapshotLoading ? "…" : String(snapshot?.activeProductCount ?? 0)} />
        <StatTile label={t("analyticsPage.statOutOfStock")} value={snapshotLoading ? "…" : String(snapshot?.outOfStockCount ?? 0)} accent={snapshot?.outOfStockCount ? "#dc2626" : undefined} />
        <StatTile label={t("analyticsPage.statLowStock")} value={snapshotLoading ? "…" : String(snapshot?.lowStockCount ?? 0)} accent={snapshot?.lowStockCount ? "#d97706" : undefined} />
        <StatTile label={t("analyticsPage.statExpiringSoon")} value={snapshotLoading ? "…" : String(snapshot?.expiringSoonCount ?? 0)} accent={snapshot?.expiringSoonCount ? "#d97706" : undefined} />
        <StatTile label={t("analyticsPage.statUnreadAlerts")} value={snapshotLoading ? "…" : String(snapshot?.unreadAlerts ?? 0)} />
      </div>

      {/* Shared date range */}
      <div style={{ display: "flex", gap: 10, flexWrap: "wrap", alignItems: "flex-end" }}>
        <div>
          <label style={FIELD_LABEL_STYLE}>{t("analyticsPage.dateFromLabel")}</label>
          <input type="date" value={dateFrom} onChange={e => setDateFrom(e.target.value)} style={DATE_INPUT_STYLE} />
        </div>
        <div>
          <label style={FIELD_LABEL_STYLE}>{t("analyticsPage.dateToLabel")}</label>
          <input type="date" value={dateTo} onChange={e => setDateTo(e.target.value)} style={DATE_INPUT_STYLE} />
        </div>
        <div>
          <label style={FIELD_LABEL_STYLE}>{t("analyticsPage.bucketLabel")}</label>
          <select value={bucket} onChange={e => setBucket(e.target.value as TrendBucket)} style={SELECT_STYLE}>
            <option value="day">{t("analyticsPage.bucketDay")}</option>
            <option value="week">{t("analyticsPage.bucketWeek")}</option>
            <option value="month">{t("analyticsPage.bucketMonth")}</option>
          </select>
        </div>
        <div style={{ fontSize: 11, color: "var(--ink-faint)" }}>{t("analyticsPage.dateRangeHint")}</div>
      </div>

      {/* Customizable Reports */}
      <Card>
        <SectionHeader title={t("analyticsPage.reportsTitle")} subtitle={t("analyticsPage.reportsSubtitle")} />
        <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fill, minmax(230px, 1fr))", gap: 12 }}>
          {REPORT_DEFS.map(def => (
            <button
              key={def.id}
              onClick={() => setPickerDef(def)}
              disabled={reportLoadingId === def.id}
              style={{
                textAlign: "left", display: "flex", flexDirection: "column", gap: 8, padding: "16px 18px",
                borderRadius: 12, border: "1px solid var(--border)", background: "var(--surface)",
                cursor: reportLoadingId === def.id ? "wait" : "pointer", fontFamily: "inherit", transition: "box-shadow 0.15s, border-color 0.15s",
              }}
              onMouseEnter={e => { (e.currentTarget as HTMLButtonElement).style.borderColor = def.color; (e.currentTarget as HTMLButtonElement).style.boxShadow = `0 4px 16px ${def.color}1A` }}
              onMouseLeave={e => { (e.currentTarget as HTMLButtonElement).style.borderColor = "var(--border)"; (e.currentTarget as HTMLButtonElement).style.boxShadow = "none" }}
            >
              <span style={{ fontSize: 22 }}>{def.icon}</span>
              <div style={{ fontWeight: 700, fontSize: 14, color: "var(--ink)" }}>{t(def.titleKey)}</div>
              <div style={{ fontSize: 11, color: "var(--ink-muted)", lineHeight: 1.4 }}>{t(def.descKey)}</div>
              <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginTop: 2 }}>
                <StatusBadge label={t(def.tagKey)} color={def.color} bg={`${def.color}1A`} />
                <span style={{ fontSize: 11, fontWeight: 600, color: "var(--primary)" }}>
                  {reportLoadingId === def.id ? t("analyticsPage.reportGenerating") : t("analyticsPage.reportGenerateCta")}
                </span>
              </div>
            </button>
          ))}
        </div>
      </Card>

      {pickerDef && (
        <PeriodPickerModal
          def={pickerDef}
          onClose={() => setPickerDef(null)}
          onConfirm={period => {
            setPickerDef(null)
            // Insurance report only: ask which insurer before generating --
            // see InsuranceProviderPickerModal below.
            if (pickerDef.id === "insurance") setPendingInsuranceReport({ def: pickerDef, period })
            else void generateReport(pickerDef, period)
          }}
        />
      )}

      {pendingInsuranceReport && (
        <InsuranceProviderPickerModal
          providers={insuranceProviders}
          onClose={() => setPendingInsuranceReport(null)}
          onConfirm={(providerId, providerName) => {
            const { def, period } = pendingInsuranceReport
            setPendingInsuranceReport(null)
            void generateReport(def, period, providerId, providerName)
          }}
        />
      )}

      {reportSections && activeReport && (
        <ExportModal
          title={`${t(activeReport.def.titleKey)}${activeReport.insuranceProviderName ? ` — ${activeReport.insuranceProviderName}` : ""} — ${activeReport.period.label}`}
          sections={reportSections}
          filenameBase={`${activeReport.def.id}-report${activeReport.insuranceProviderName ? `-${activeReport.insuranceProviderName.replace(/[^a-z0-9]+/gi, "-").toLowerCase()}` : ""}-${activeReport.period.from}-to-${activeReport.period.to}`}
          onClose={() => { setReportSections(null); setActiveReport(null) }}
          formatLabel={t("overviewPage.exportFormatLabel")}
          cancelLabel={t("overviewPage.exportCancel")}
          downloadLabel={format => t("overviewPage.exportDownload", { format })}
        />
      )}

      {/* Sales trend */}
      <Card>
        <SectionHeader title={t("analyticsPage.trendTitle")} subtitle={t("analyticsPage.trendSubtitle", { bucket: bucketLabel })} />
        {trendLoading ? (
          <div style={{ padding: 30, textAlign: "center", color: "var(--ink-muted)", fontSize: 12 }}>{t("analyticsPage.loading")}</div>
        ) : trendChartData.length === 0 ? (
          <div style={{ padding: 30, textAlign: "center", color: "var(--ink-muted)", fontSize: 12 }}>{t("analyticsPage.noSalesRange")}</div>
        ) : (
          <ResponsiveContainer width="100%" height={220}>
            <BarChart data={trendChartData} margin={{ bottom: 8 }}>
              <CartesianGrid strokeDasharray="4 4" stroke="var(--border)" />
              <XAxis dataKey="name" tick={{ fontSize: 10, fill: "var(--ink-muted)" }} />
              <YAxis tick={{ fontSize: 10, fill: "var(--ink-muted)" }} />
              <Tooltip content={<ChartTooltip />} />
              <Bar dataKey="revenue" name={t("analyticsPage.colRevenue")} fill="#2a78d6" radius={[5, 5, 0, 0]} />
            </BarChart>
          </ResponsiveContainer>
        )}
      </Card>

      {/* Top products + category breakdown */}
      <div style={{ display: "flex", gap: 16, flexWrap: "wrap" }}>
        <Card style={{ flex: "2 1 420px", minWidth: 340 }}>
          <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", flexWrap: "wrap", gap: 8, marginBottom: 10 }}>
            <div>
              <h2 style={{ margin: 0, fontSize: 14, fontWeight: 600 }}>{t("analyticsPage.topProductsTitle")}</h2>
              <p style={{ margin: "2px 0 0", fontSize: 11, color: "var(--ink-muted)" }}>{t("analyticsPage.topProductsSubtitle", { metric: metricLabel, direction: directionLabel })}</p>
            </div>
            <div style={{ display: "flex", gap: 6 }}>
              <select value={topMetric} onChange={e => setTopMetric(e.target.value as "revenue" | "quantity")} style={SELECT_STYLE}>
                <option value="revenue">{t("analyticsPage.sortByRevenue")}</option>
                <option value="quantity">{t("analyticsPage.sortByQuantity")}</option>
              </select>
              <select value={topDirection} onChange={e => setTopDirection(e.target.value as "asc" | "desc")} style={SELECT_STYLE}>
                <option value="desc">{t("analyticsPage.sortBestSellers")}</option>
                <option value="asc">{t("analyticsPage.sortSlowestMovers")}</option>
              </select>
            </div>
          </div>
          <Table
            columns={[{ key: "product", label: t("analyticsPage.colProduct") }, { key: "qty", label: t("analyticsPage.colQtySold") }, { key: "revenue", label: t("analyticsPage.colRevenue") }]}
            rows={topProducts.map(p => ({ product: `${p.productName}${p.dosage ? ` · ${p.dosage}` : ""}`, qty: p.quantitySold, revenue: fmtRWFExact(p.revenue) }))}
          />
          {!trendLoading && topProducts.length === 0 && <div style={EMPTY_STATE_STYLE}>{t("analyticsPage.noSalesRange")}</div>}
        </Card>

        <Card style={{ flex: "1 1 280px", minWidth: 260 }}>
          <SectionHeader title={t("analyticsPage.categoryTitle")} subtitle={t("analyticsPage.categorySubtitle")} />
          {categoryChartData.length === 0 ? (
            <div style={EMPTY_STATE_STYLE}>{t("analyticsPage.noSalesRange")}</div>
          ) : (
            <ResponsiveContainer width="100%" height={220}>
              <PieChart>
                <Pie data={categoryChartData} dataKey="value" nameKey="name" innerRadius={50} outerRadius={80} paddingAngle={2} stroke="var(--surface)" strokeWidth={2}>
                  {categoryChartData.map((d, i) => <Cell key={i} fill={d.color} />)}
                </Pie>
                <Tooltip
                  formatter={(v: any) => fmtRWFExact(Number(v))}
                  contentStyle={{ background: "var(--surface)", border: "1px solid var(--border)", borderRadius: 8 }}
                  itemStyle={{ color: "var(--ink)" }}
                  labelStyle={{ color: "var(--ink-muted)" }}
                />
                <Legend formatter={(value: string) => <span style={{ fontSize: 11, color: "var(--ink-mid)" }}>{value}</span>} />
              </PieChart>
            </ResponsiveContainer>
          )}
        </Card>
      </div>

      {/* Forecast */}
      <Card>
        <SectionHeader title={t("analyticsPage.forecastTitle")} subtitle={t("analyticsPage.forecastSubtitle")} />
        <div style={{ display: "flex", gap: 10, flexWrap: "wrap", alignItems: "flex-end", marginBottom: 14 }}>
          <div>
            <label style={FIELD_LABEL_STYLE}>{t("analyticsPage.forecastProductLabel")}</label>
            <select value={forecastProductId} onChange={e => { setForecastProductId(e.target.value); if (e.target.value) setForecastCategoryId("") }} style={{ ...SELECT_STYLE, minWidth: 180 }}>
              <option value="">{t("analyticsPage.forecastWholeBranch")}</option>
              {reference?.products.map(p => <option key={p.id} value={p.id}>{p.name}{p.generic_name ? ` (${p.generic_name})` : ""}</option>)}
            </select>
          </div>
          <div>
            <label style={FIELD_LABEL_STYLE}>{t("analyticsPage.forecastCategoryLabel")}</label>
            <select value={forecastCategoryId} onChange={e => { setForecastCategoryId(e.target.value); if (e.target.value) setForecastProductId("") }} style={{ ...SELECT_STYLE, minWidth: 160 }}>
              <option value="">{t("analyticsPage.forecastAnyCategory")}</option>
              {reference?.categories.map(c => <option key={c.id} value={c.id}>{c.name}</option>)}
            </select>
          </div>
          <div>
            <label style={FIELD_LABEL_STYLE}>{t("analyticsPage.forecastHistoryLabel")}</label>
            <input type="number" min={7} max={730} value={forecastHistory} onChange={e => setForecastHistory(Number(e.target.value) || 90)} style={{ ...DATE_INPUT_STYLE, width: 90 }} />
          </div>
          <div>
            <label style={FIELD_LABEL_STYLE}>{t("analyticsPage.forecastHorizonLabel")}</label>
            <input type="number" min={1} max={365} value={forecastHorizon} onChange={e => setForecastHorizon(Number(e.target.value) || 30)} style={{ ...DATE_INPUT_STYLE, width: 90 }} />
          </div>
          <button
            onClick={() => void runForecast()}
            disabled={forecastLoading}
            style={{ padding: "8px 18px", borderRadius: 8, border: "none", background: "var(--primary)", color: "#fff", fontSize: 12, fontWeight: 600, cursor: forecastLoading ? "not-allowed" : "pointer", opacity: forecastLoading ? 0.6 : 1, fontFamily: "inherit" }}
          >
            {forecastLoading ? t("analyticsPage.forecastCalculating") : t("analyticsPage.forecastRun")}
          </button>
        </div>

        {forecast && (
          <div>
            {forecastChartData.length > 1 && (
              <div style={{ marginBottom: 16 }}>
                <ResponsiveContainer width="100%" height={280}>
                  <ComposedChart data={forecastChartData} margin={{ top: 8, right: 12, bottom: 0, left: 0 }}>
                    <defs>
                      <linearGradient id="gForecastBand" x1="0" y1="0" x2="0" y2="1">
                        <stop offset="0%" stopColor="#16a34a" stopOpacity={0.18} />
                        <stop offset="100%" stopColor="#16a34a" stopOpacity={0.02} />
                      </linearGradient>
                    </defs>
                    <CartesianGrid stroke="#f0f0f0" strokeDasharray="4 4" />
                    <XAxis dataKey="label" tick={{ fontSize: 10 }} axisLine={false} tickLine={false} />
                    <YAxis tick={{ fontSize: 10 }} axisLine={false} tickLine={false} width={70} tickFormatter={v => fmtRWFExact(v)} />
                    <Tooltip content={(props: any) => <ChartTooltip {...props} payload={props.payload?.filter((p: any) => p.value != null && p.dataKey !== "range")} />} />
                    <Legend wrapperStyle={{ fontSize: 11 }} />
                    <Area type="monotone" dataKey="range" name={t("analyticsPage.forecastBandLabel")} stroke="none" fill="url(#gForecastBand)" connectNulls legendType="none" />
                    <Line type="monotone" dataKey="actualRevenue" name={t("analyticsPage.forecastActualLabel")} stroke="#16a34a" strokeWidth={2.5} dot={{ r: 3 }} />
                    <Line type="monotone" dataKey="forecastRevenue" name={t("analyticsPage.forecastDashedLabel")} stroke="#16a34a" strokeWidth={2.5} strokeDasharray="6 4" dot={{ r: 3 }} />
                    <Line type="monotone" dataKey="previouslyPredictedRevenue" name={t("analyticsPage.forecastPredictedLabel")} stroke="#eb6834" strokeWidth={2} strokeDasharray="2 3" dot={{ r: 3 }} connectNulls={false} />
                  </ComposedChart>
                </ResponsiveContainer>
                <div style={{ fontSize: 11, color: "var(--ink-faint)", textAlign: "center", marginTop: 4 }}>{t("analyticsPage.forecastBandCaption")}</div>
                {forecastAccuracy.length > 0 && (
                  <div style={{ fontSize: 11, color: "var(--ink-faint)", textAlign: "center", marginTop: 2 }}>{t("analyticsPage.forecastAccuracyCaption")}</div>
                )}
              </div>
            )}
            <div style={{ fontSize: 12, color: "var(--ink-muted)", marginBottom: 10 }}>
              <strong style={{ color: "var(--ink)" }}>{forecast.scope}</strong> · {t("analyticsPage.forecastBasedOn", { days: forecast.daysOfHistory })} ·{" "}
              {t("analyticsPage.forecastTrendIs")}{" "}
              <span style={{ fontWeight: 700, color: forecast.trendPerDay > 0.01 ? "#16a34a" : forecast.trendPerDay < -0.01 ? "#dc2626" : "var(--ink)" }}>
                {trendWord}
              </span>{" "}
              ({forecast.trendPerDay >= 0 ? "+" : ""}{forecast.trendPerDay} {t("analyticsPage.forecastUnitsPerDay")})
            </div>
            <div style={{ display: "flex", gap: 10, flexWrap: "wrap" }}>
              <StatTile label={t("analyticsPage.forecastAvgDailyQty")} value={String(forecast.avgDailyQuantity)} />
              <StatTile label={t("analyticsPage.forecastProjectedQty", { days: forecastHorizon })} value={String(forecast.projectedQuantityNextPeriod)} accent="var(--primary)" />
              <StatTile label={t("analyticsPage.forecastProjectedRevenue", { days: forecastHorizon })} value={fmtRWFExact(forecast.projectedRevenueNextPeriod)} accent="var(--primary)" />
            </div>
          </div>
        )}
      </Card>

      {/* Stock status */}
      <Card>
        <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", flexWrap: "wrap", gap: 8, marginBottom: 10 }}>
          <h2 style={{ margin: 0, fontSize: 14, fontWeight: 600 }}>{t("analyticsPage.stockStatusTitle")}</h2>
          <div style={{ display: "flex", gap: 6, flexWrap: "wrap" }}>
            {(["all", "low", "out", "expiring", "expired"] as StockFilter[]).map(f => (
              <button
                key={f}
                onClick={() => setStockFilter(f)}
                style={{
                  padding: "5px 12px", borderRadius: 999, fontSize: 11, fontWeight: 600, cursor: "pointer", fontFamily: "inherit",
                  border: `1px solid ${stockFilter === f ? "var(--primary)" : "var(--border)"}`,
                  background: stockFilter === f ? "var(--primary-light)" : "var(--surface)",
                  color: stockFilter === f ? "var(--primary)" : "var(--ink-mid)",
                }}
              >
                {STOCK_FILTER_LABEL[f]}
              </button>
            ))}
          </div>
        </div>
        {stockLoading ? (
          <div style={EMPTY_STATE_STYLE}>{t("analyticsPage.loading")}</div>
        ) : (
          <Table
            columns={[
              { key: "product", label: t("analyticsPage.colProduct") }, { key: "available", label: t("analyticsPage.colAvailable") }, { key: "min", label: t("analyticsPage.colMin") },
              { key: "expiry", label: t("analyticsPage.colExpiry") }, { key: "status", label: t("analyticsPage.colStatus") },
            ]}
            rows={stockRows.map(r => ({
              product: `${r.productName}${r.dosage ? ` · ${r.dosage}` : ""}`,
              available: r.quantityAvailable, min: r.minQuantity,
              expiry: r.expiryDate ? `${r.expiryDate}${r.daysToExpiry != null ? ` (${r.daysToExpiry}d)` : ""}` : "—",
              status: <StatusBadge label={STOCK_STATUS_LABEL[r.status]} color={STOCK_STATUS_STYLE[r.status].color} bg={STOCK_STATUS_STYLE[r.status].bg} />,
            }))}
          />
        )}
        {!stockLoading && stockRows.length === 0 && <div style={EMPTY_STATE_STYLE}>{t("analyticsPage.noMatchFilter")}</div>}
      </Card>

      {/* Insurance + Seller performance */}
      <div style={{ display: "flex", gap: 16, flexWrap: "wrap" }}>
        <Card style={{ flex: "1 1 380px", minWidth: 320 }}>
          <SectionHeader title={t("analyticsPage.insuranceTitle")} subtitle={t("analyticsPage.insuranceSubtitle")} />
          <Table
            columns={[{ key: "provider", label: t("analyticsPage.colProvider") }, { key: "claims", label: t("analyticsPage.colClaims") }, { key: "claimed", label: t("analyticsPage.colClaimed") }, { key: "paid", label: t("analyticsPage.colPaid") }, { key: "pending", label: t("analyticsPage.colPending") }]}
            rows={insurance.map(r => ({ provider: r.providerName, claims: r.claimCount, claimed: fmtRWFExact(r.totalClaimed), paid: fmtRWFExact(r.paidOut), pending: fmtRWFExact(r.pending) }))}
          />
          {!trendLoading && insurance.length === 0 && <div style={EMPTY_STATE_STYLE}>{t("analyticsPage.noClaimsRange")}</div>}
        </Card>

        <Card style={{ flex: "1 1 320px", minWidth: 280 }}>
          <SectionHeader title={t("analyticsPage.staffTitle")} subtitle={t("analyticsPage.staffSubtitle")} />
          <Table
            columns={[{ key: "seller", label: t("analyticsPage.colStaff") }, { key: "role", label: t("analyticsPage.colRole") }, { key: "txns", label: t("analyticsPage.colSales") }, { key: "revenue", label: t("analyticsPage.colRevenue") }]}
            rows={sellers.map(r => ({ seller: r.sellerName, role: r.sellerRole, txns: r.transactionCount, revenue: fmtRWFExact(r.revenue) }))}
          />
          {!trendLoading && sellers.length === 0 && <div style={EMPTY_STATE_STYLE}>{t("analyticsPage.noSalesRange")}</div>}
        </Card>
      </div>

      {/* Patients */}
      <Card>
        <SectionHeader title={t("analyticsPage.patientsTitle")} subtitle={t("analyticsPage.patientsSubtitle")} />
        <div style={{ display: "flex", gap: 10, flexWrap: "wrap" }}>
          <StatTile label={t("analyticsPage.patientsServed")} value={String(patients?.totalPatientsServed ?? 0)} />
          <StatTile label={t("analyticsPage.patientsNew")} value={String(patients?.newPatients ?? 0)} />
          <StatTile label={t("analyticsPage.patientsRepeat")} value={String(patients?.repeatPatients ?? 0)} />
          <StatTile label={t("analyticsPage.patientsTop")} value={patients?.topPatientName ?? "—"} />
          {patients?.topPatientSpend != null && <StatTile label={t("analyticsPage.patientsTopSpend")} value={fmtRWFExact(patients.topPatientSpend)} accent="var(--primary)" />}
        </div>
      </Card>

      {/* ═══ Inventory operations ═══ */}
      <SectionHeader title={t("analyticsPage.invOpsTitle")} subtitle={t("analyticsPage.invOpsSubtitle")} />

      <div style={{ display: "flex", gap: 16, flexWrap: "wrap" }}>
        <Card style={{ flex: "1 1 380px", minWidth: 320 }}>
          <SectionHeader title={t("analyticsPage.adjustmentsTitle")} subtitle={t("analyticsPage.adjustmentsSubtitle")} />
          <Table
            columns={[{ key: "type", label: t("analyticsPage.colType") }, { key: "staff", label: t("analyticsPage.colStaff") }, { key: "qty", label: t("analyticsPage.colQuantity") }, { key: "count", label: t("analyticsPage.colCount") }, { key: "value", label: t("analyticsPage.colValue") }]}
            rows={stockAdjustments.map(r => ({ type: r.adjustmentType, staff: r.staffName, qty: r.quantity, count: r.adjustmentCount, value: fmtRWFExact(r.estimatedValue) }))}
          />
          {!trendLoading && stockAdjustments.length === 0 && <div style={EMPTY_STATE_STYLE}>{t("analyticsPage.noAdjustments")}</div>}
        </Card>

        <Card style={{ flex: "1 1 380px", minWidth: 320 }}>
          <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", flexWrap: "wrap", gap: 8, marginBottom: 10 }}>
            <div>
              <h2 style={{ margin: 0, fontSize: 14, fontWeight: 600 }}>{t("analyticsPage.deadStockTitle")}</h2>
              <p style={{ margin: "2px 0 0", fontSize: 11, color: "var(--ink-muted)" }}>{t("analyticsPage.deadStockSubtitle")}</p>
            </div>
            <div style={{ display: "flex", alignItems: "center", gap: 6 }}>
              <label style={{ fontSize: 11, color: "var(--ink-muted)" }}>{t("analyticsPage.deadStockDaysLabel")}</label>
              <input type="number" min={1} max={730} value={deadStockDays} onChange={e => setDeadStockDays(Number(e.target.value) || 60)} style={{ ...DATE_INPUT_STYLE, width: 70 }} />
            </div>
          </div>
          {deadStockLoading ? (
            <div style={EMPTY_STATE_STYLE}>{t("analyticsPage.loading")}</div>
          ) : (
            <Table
              columns={[{ key: "product", label: t("analyticsPage.colProduct") }, { key: "qty", label: t("analyticsPage.colOnHand") }, { key: "value", label: t("analyticsPage.colValue") }, { key: "days", label: t("analyticsPage.colDaysSinceSale") }]}
              rows={deadStock.map(r => ({
                product: `${r.productName}${r.dosage ? ` · ${r.dosage}` : ""}`, qty: r.quantityOnHand,
                value: fmtRWFExact(r.stockValue), days: r.daysSinceLastSale ?? t("analyticsPage.neverSold"),
              }))}
            />
          )}
          {!deadStockLoading && deadStock.length === 0 && <div style={EMPTY_STATE_STYLE}>{t("analyticsPage.noDeadStock")}</div>}
        </Card>
      </div>

      <div style={{ display: "flex", gap: 16, flexWrap: "wrap" }}>
        <Card style={{ flex: "1 1 380px", minWidth: 320 }}>
          <SectionHeader title={t("analyticsPage.turnoverTitle")} subtitle={t("analyticsPage.turnoverSubtitle")} />
          <Table
            columns={[{ key: "category", label: t("analyticsPage.colCategory") }, { key: "cogs", label: t("analyticsPage.colCogs") }, { key: "value", label: t("analyticsPage.colInventoryValue") }, { key: "ratio", label: t("analyticsPage.colTurnoverRatio") }]}
            rows={inventoryTurnover.map(r => ({ category: r.categoryName, cogs: fmtRWFExact(r.cogs), value: fmtRWFExact(r.currentInventoryValue), ratio: r.turnoverRatio != null ? r.turnoverRatio.toFixed(2) : "—" }))}
          />
          {!trendLoading && inventoryTurnover.length === 0 && <div style={EMPTY_STATE_STYLE}>{t("analyticsPage.noSalesRange")}</div>}
        </Card>

        <Card style={{ flex: "1 1 380px", minWidth: 320 }}>
          <SectionHeader title={t("analyticsPage.supplierTitle")} subtitle={t("analyticsPage.supplierSubtitle")} />
          <Table
            columns={[{ key: "supplier", label: t("analyticsPage.colSupplier") }, { key: "deliveries", label: t("analyticsPage.colDeliveries") }, { key: "units", label: t("analyticsPage.colUnitsReceived") }, { key: "cost", label: t("analyticsPage.colTotalCost") }, { key: "unitCost", label: t("analyticsPage.colAvgUnitCost") }]}
            rows={supplierPerformance.map(r => ({ supplier: r.supplierName, deliveries: r.deliveryCount, units: r.unitsReceived, cost: fmtRWFExact(r.totalCost), unitCost: r.avgUnitCost != null ? fmtRWFExact(r.avgUnitCost) : "—" }))}
          />
          {!trendLoading && supplierPerformance.length === 0 && <div style={EMPTY_STATE_STYLE}>{t("analyticsPage.noDeliveries")}</div>}
        </Card>
      </div>

      {/* ═══ Sales patterns ═══ */}
      <SectionHeader title={t("analyticsPage.salesPatternsTitle")} subtitle={t("analyticsPage.salesPatternsSubtitle")} />

      <Card>
        <SectionHeader title={t("analyticsPage.heatmapTitle")} subtitle={t("analyticsPage.heatmapSubtitle")} />
        {trendLoading ? (
          <div style={EMPTY_STATE_STYLE}>{t("analyticsPage.loading")}</div>
        ) : salesHeatmap.length === 0 ? (
          <div style={EMPTY_STATE_STYLE}>{t("analyticsPage.noSalesRange")}</div>
        ) : (
          <div style={{ overflowX: "auto" }}>
            <div style={{ display: "grid", gridTemplateColumns: "44px repeat(7, minmax(30px, 1fr))", gap: 2, minWidth: 420 }}>
              <div />
              {weekdayLabels.map((label, d) => (
                <div key={d} style={{ fontSize: 10, color: "var(--ink-muted)", textAlign: "center", fontWeight: 600 }}>{label}</div>
              ))}
              {Array.from({ length: 24 }, (_, hour) => (
                <Fragment key={hour}>
                  <div style={{ fontSize: 10, color: "var(--ink-faint)", textAlign: "right", paddingRight: 4, lineHeight: "16px" }}>{hour}:00</div>
                  {weekdayLabels.map((_, d) => {
                    const cell = heatmapByCell.get(`${d}-${hour}`)
                    const alpha = cell && heatmapMax > 0 ? 0.12 + 0.8 * (cell.revenue / heatmapMax) : 0
                    return (
                      <div
                        key={`${d}-${hour}`}
                        title={cell ? `${weekdayLabels[d]} ${hour}:00 — ${fmtRWFExact(cell.revenue)} (${cell.transactionCount})` : undefined}
                        style={{ height: 16, borderRadius: 3, background: cell ? `rgba(30,95,168,${alpha})` : "#f4f6f8" }}
                      />
                    )
                  })}
                </Fragment>
              ))}
            </div>
          </div>
        )}
      </Card>

      <div style={{ display: "flex", gap: 16, flexWrap: "wrap" }}>
        <Card style={{ flex: "1 1 380px", minWidth: 320 }}>
          <SectionHeader title={t("analyticsPage.basketTitle")} subtitle={t("analyticsPage.basketSubtitle", { bucket: bucketLabel })} />
          {basketChartData.length === 0 ? (
            <div style={EMPTY_STATE_STYLE}>{t("analyticsPage.noSalesRange")}</div>
          ) : (
            <ResponsiveContainer width="100%" height={200}>
              <BarChart data={basketChartData} margin={{ bottom: 8 }}>
                <CartesianGrid strokeDasharray="4 4" stroke="var(--border)" />
                <XAxis dataKey="name" tick={{ fontSize: 10, fill: "var(--ink-muted)" }} />
                <YAxis tick={{ fontSize: 10, fill: "var(--ink-muted)" }} />
                <Tooltip content={<ChartTooltip />} />
                <Bar dataKey="items" name={t("analyticsPage.colItemsPerSale")} fill="#1baf7a" radius={[5, 5, 0, 0]} />
              </BarChart>
            </ResponsiveContainer>
          )}
        </Card>

        <Card style={{ flex: "1 1 380px", minWidth: 320 }}>
          <SectionHeader title={t("analyticsPage.discountTitle")} subtitle={t("analyticsPage.discountSubtitle")} />
          <Table
            columns={[{ key: "name", label: t("analyticsPage.colDiscount") }, { key: "type", label: t("analyticsPage.colType") }, { key: "usage", label: t("analyticsPage.colUsageCount") }, { key: "revenue", label: t("analyticsPage.colRevenue") }, { key: "value", label: t("analyticsPage.colDiscountValue") }]}
            rows={discountUsage.map(r => ({ name: r.discountName, type: r.discountType, usage: r.usageCount, revenue: fmtRWFExact(r.revenueWithDiscount), value: fmtRWFExact(r.estimatedDiscountValue) }))}
          />
          {!trendLoading && discountUsage.length === 0 && <div style={EMPTY_STATE_STYLE}>{t("analyticsPage.noDiscounts")}</div>}
        </Card>
      </div>

      {/* ═══ Insurance depth ═══ */}
      <SectionHeader title={t("analyticsPage.insuranceDepthTitle")} subtitle={t("analyticsPage.insuranceDepthSubtitle")} />

      <div style={{ display: "flex", gap: 16, flexWrap: "wrap" }}>
        <Card style={{ flex: "1 1 320px", minWidth: 280 }}>
          <SectionHeader title={t("analyticsPage.claimAgingTitle")} subtitle={t("analyticsPage.claimAgingSubtitle")} />
          <Table
            columns={[{ key: "bucket", label: t("analyticsPage.colAgeBucket") }, { key: "count", label: t("analyticsPage.colCount") }, { key: "amount", label: t("analyticsPage.colTotalAmount") }]}
            rows={claimAging.map(r => ({ bucket: r.ageBucket, count: r.claimCount, amount: fmtRWFExact(r.totalAmount) }))}
          />
          {claimAging.length === 0 && <div style={EMPTY_STATE_STYLE}>{t("analyticsPage.noPendingClaims")}</div>}
        </Card>

        <Card style={{ flex: "1 1 380px", minWidth: 320 }}>
          <SectionHeader title={t("analyticsPage.providerComparisonTitle")} subtitle={t("analyticsPage.providerComparisonSubtitle")} />
          <Table
            columns={[
              { key: "provider", label: t("analyticsPage.colProvider") }, { key: "claims", label: t("analyticsPage.colClaims") },
              { key: "approved", label: t("analyticsPage.colApproved") }, { key: "rate", label: t("analyticsPage.colApprovalRate") },
              { key: "avgClaim", label: t("analyticsPage.colAvgClaim") }, { key: "avgCoverage", label: t("analyticsPage.colAvgCoverage") },
            ]}
            rows={providerComparison.map(r => ({
              provider: r.providerName, claims: r.claimCount, approved: r.approvedCount,
              rate: r.approvalRate != null ? `${r.approvalRate}%` : "—", avgClaim: fmtRWFExact(r.avgClaimAmount),
              avgCoverage: r.avgCoveragePercentage != null ? `${r.avgCoveragePercentage}%` : "—",
            }))}
          />
          {!trendLoading && providerComparison.length === 0 && <div style={EMPTY_STATE_STYLE}>{t("analyticsPage.noClaimsRange")}</div>}
        </Card>
      </div>

      {/* ═══ Extras: seller productivity, recalls, patient retention ═══ */}
      <SectionHeader title={t("analyticsPage.extrasTitle")} subtitle={t("analyticsPage.extrasSubtitle")} />

      <Card>
        <SectionHeader title={t("analyticsPage.productivityTitle")} subtitle={t("analyticsPage.productivitySubtitle")} />
        <Table
          columns={[
            { key: "seller", label: t("analyticsPage.colStaff") }, { key: "role", label: t("analyticsPage.colRole") },
            { key: "txns", label: t("analyticsPage.colSales") }, { key: "revenue", label: t("analyticsPage.colRevenue") },
            { key: "hours", label: t("analyticsPage.colActiveHours") }, { key: "revPerHour", label: t("analyticsPage.colRevenuePerHour") },
            { key: "txnPerHour", label: t("analyticsPage.colSalesPerHour") },
          ]}
          rows={sellerProductivity.map(r => ({
            seller: r.sellerName, role: r.sellerRole, txns: r.transactionCount, revenue: fmtRWFExact(r.revenue),
            hours: r.activeHours, revPerHour: r.revenuePerHour != null ? fmtRWFExact(r.revenuePerHour) : "—",
            txnPerHour: r.transactionsPerHour != null ? r.transactionsPerHour.toFixed(2) : "—",
          }))}
        />
        {!trendLoading && sellerProductivity.length === 0 && <div style={EMPTY_STATE_STYLE}>{t("analyticsPage.noSalesRange")}</div>}
      </Card>

      <div style={{ display: "flex", gap: 16, flexWrap: "wrap" }}>
        <Card style={{ flex: "1 1 380px", minWidth: 320 }}>
          <SectionHeader title={t("analyticsPage.recallTitle")} subtitle={t("analyticsPage.recallSubtitle")} />
          <Table
            columns={[
              { key: "product", label: t("analyticsPage.colProduct") }, { key: "batch", label: t("analyticsPage.colBatch") },
              { key: "manufacturer", label: t("analyticsPage.colManufacturer") }, { key: "reason", label: t("analyticsPage.colReason") },
              { key: "by", label: t("analyticsPage.colRecalledBy") }, { key: "date", label: t("analyticsPage.colRecalledAt") },
            ]}
            rows={recallLog.map(r => ({
              product: `${r.productName}${r.dosage ? ` · ${r.dosage}` : ""}`, batch: r.batchNumber, manufacturer: r.manufacturerName ?? "—",
              reason: r.reason, by: r.recalledByName ?? "—", date: new Date(r.recalledAt).toLocaleDateString(),
            }))}
          />
          {recallLog.length === 0 && <div style={EMPTY_STATE_STYLE}>{t("analyticsPage.noRecalls")}</div>}
        </Card>

        <Card style={{ flex: "1 1 380px", minWidth: 320 }}>
          <div style={{ display: "flex", justifyContent: "space-between", alignItems: "flex-end", flexWrap: "wrap", gap: 8, marginBottom: 10 }}>
            <div>
              <h2 style={{ margin: 0, fontSize: 14, fontWeight: 600 }}>{t("analyticsPage.retentionTitle")}</h2>
              <p style={{ margin: "2px 0 0", fontSize: 11, color: "var(--ink-muted)" }}>{t("analyticsPage.retentionSubtitle")}</p>
            </div>
            <div style={{ display: "flex", gap: 8, alignItems: "flex-end", flexWrap: "wrap" }}>
              <div>
                <label style={FIELD_LABEL_STYLE}>{t("analyticsPage.retentionLookbackLabel")}</label>
                <input type="number" min={1} max={1825} value={retentionLookback} onChange={e => setRetentionLookback(Number(e.target.value) || 180)} style={{ ...DATE_INPUT_STYLE, width: 80 }} />
              </div>
              <div>
                <label style={FIELD_LABEL_STYLE}>{t("analyticsPage.retentionInactiveLabel")}</label>
                <input type="number" min={1} max={730} value={retentionInactive} onChange={e => setRetentionInactive(Number(e.target.value) || 60)} style={{ ...DATE_INPUT_STYLE, width: 80 }} />
              </div>
              <button
                onClick={() => void runPatientRetention()}
                disabled={retentionLoading}
                style={{ padding: "7px 14px", borderRadius: 8, border: "none", background: "var(--primary)", color: "#fff", fontSize: 12, fontWeight: 600, cursor: retentionLoading ? "not-allowed" : "pointer", opacity: retentionLoading ? 0.6 : 1, fontFamily: "inherit" }}
              >
                {retentionLoading ? t("analyticsPage.forecastCalculating") : t("analyticsPage.retentionRun")}
              </button>
            </div>
          </div>
          <Table
            columns={[
              { key: "patient", label: t("analyticsPage.colPatient") }, { key: "lastVisit", label: t("analyticsPage.colLastVisit") },
              { key: "daysSince", label: t("analyticsPage.colDaysSince") }, { key: "visits", label: t("analyticsPage.colPastVisits") },
              { key: "spend", label: t("analyticsPage.colLifetimeSpend") },
            ]}
            rows={patientRetention.map(r => ({
              patient: r.patientName, lastVisit: r.lastVisit, daysSince: r.daysSinceLastVisit,
              visits: r.pastVisitCount, spend: fmtRWFExact(r.lifetimeSpend),
            }))}
          />
          {!retentionLoading && patientRetention.length === 0 && <div style={EMPTY_STATE_STYLE}>{t("analyticsPage.noLapsedPatients")}</div>}
        </Card>
      </div>
    </div>
  )
}
