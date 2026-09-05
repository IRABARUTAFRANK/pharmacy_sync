import { Fragment, useEffect, useMemo, useState } from "react"
import { Bar, BarChart, CartesianGrid, Cell, Legend, Pie, PieChart, ResponsiveContainer, Tooltip, XAxis, YAxis } from "recharts"
import { Card, CenterAlert, ChartTooltip, SectionHeader, StatusBadge, Table } from "../components"
import { fmtRWFExact } from "../data"
import { useTranslation } from "../lib/i18n"
import { resolveRange, toDateInputValue, type OverviewPeriod } from "../lib/overview"
import { loadReceivingReference, type ReceivingCategory, type ReceivingProduct } from "../lib/receiving"
import {
  loadBasketSize, loadBranchSnapshot, loadCategoryBreakdown, loadDeadStock, loadDiscountUsage, loadInsuranceClaimAging,
  loadInsuranceProviderComparison, loadInsuranceSummary, loadInventoryTurnover, loadPatientRetention, loadPatientSummary,
  loadRecallLog, loadSalesForecast, loadSalesHeatmap, loadSalesTrend, loadSellerPerformance, loadSellerProductivity,
  loadStockAdjustments, loadStockStatus, loadSupplierPerformance, loadTopProducts,
  type BasketSizePoint, type BranchSnapshot, type CategoryBreakdownRow, type ClaimAgingBucket, type DeadStockRow,
  type DiscountUsageRow, type InsuranceSummaryRow, type InventoryTurnoverRow, type PatientRetentionRow, type PatientSummary,
  type ProviderComparisonRow, type RecallLogRow, type SalesForecast, type SalesHeatmapCell, type SalesTrendPoint,
  type SellerPerformanceRow, type SellerProductivityRow, type StockAdjustmentRow, type StockFilter, type StockStatusRow,
  type SupplierPerformanceRow, type TopProductRow, type TrendBucket,
} from "../lib/analytics"

// Same validated categorical palette as InsurancePage.tsx's donut chart --
// see that file's comment for the ΔE/contrast numbers this order clears.
const CATEGORICAL_COLORS = ["#2a78d6", "#eb6834", "#1baf7a", "#eda100", "#e87ba4", "#4a3aa7", "#e34948", "#008300"]

function isoDate(d: Date): string {
  return d.toISOString().slice(0, 10)
}
function daysAgo(n: number): string {
  const d = new Date()
  d.setDate(d.getDate() - n)
  return isoDate(d)
}

function StatTile({ label, value, accent }: { label: string; value: string; accent?: string }) {
  return (
    <div style={{ flex: "1 1 150px", minWidth: 140, background: "#fff", border: "1px solid var(--border)", borderRadius: 12, padding: "14px 16px" }}>
      <div style={{ fontSize: 19, fontWeight: 700, color: accent ?? "var(--ink)", letterSpacing: "-0.01em" }}>{value}</div>
      <div style={{ fontSize: 11, color: "var(--ink-muted)", marginTop: 2 }}>{label}</div>
    </div>
  )
}

const DATE_INPUT_STYLE = { padding: "7px 10px", border: "1px solid var(--border)", borderRadius: 8, fontFamily: "inherit", fontSize: 12 }
const SELECT_STYLE = { padding: "7px 10px", border: "1px solid var(--border)", borderRadius: 8, fontFamily: "inherit", fontSize: 12, background: "#fff" }
const FIELD_LABEL_STYLE = { display: "block", fontSize: 10, fontWeight: 600, color: "var(--ink-muted)", textTransform: "uppercase" as const, letterSpacing: "0.05em", marginBottom: 4 }
const EMPTY_STATE_STYLE = { padding: 20, textAlign: "center" as const, color: "var(--ink-muted)", fontSize: 12 }

// Everything on this page calls the same read-only, branch-scoped SQL
// functions the AI analyst uses as tools -- directly, no LLM involved. Real
// numbers (the forecast is real linear regression, computed in Postgres),
// zero API cost, and it works even when the AI analyst doesn't.
export default function AnalyticsPage({ period }: { period?: OverviewPeriod }) {
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

  const [dateFrom, setDateFrom] = useState(daysAgo(30))
  const [dateTo, setDateTo] = useState(daysAgo(0))
  const [bucket, setBucket] = useState<TrendBucket>("day")
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

  const [topMetric, setTopMetric] = useState<"revenue" | "quantity">("revenue")
  const [topDirection, setTopDirection] = useState<"asc" | "desc">("desc")
  const [topProducts, setTopProducts] = useState<TopProductRow[]>([])

  const [categoryBreakdown, setCategoryBreakdown] = useState<CategoryBreakdownRow[]>([])

  const [stockFilter, setStockFilter] = useState<StockFilter>("all")
  const [stockRows, setStockRows] = useState<StockStatusRow[]>([])
  const [stockLoading, setStockLoading] = useState(true)

  const [reference, setReference] = useState<{ products: ReceivingProduct[]; categories: ReceivingCategory[] } | null>(null)
  const [forecastProductId, setForecastProductId] = useState("")
  const [forecastCategoryId, setForecastCategoryId] = useState("")
  const [forecastHorizon, setForecastHorizon] = useState(30)
  const [forecastHistory, setForecastHistory] = useState(90)
  const [forecast, setForecast] = useState<SalesForecast | null>(null)
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
  const [deadStockDays, setDeadStockDays] = useState(60)
  const [deadStock, setDeadStock] = useState<DeadStockRow[]>([])
  const [deadStockLoading, setDeadStockLoading] = useState(true)

  const [claimAging, setClaimAging] = useState<ClaimAgingBucket[]>([])
  const [recallLog, setRecallLog] = useState<RecallLogRow[]>([])

  const [retentionLookback, setRetentionLookback] = useState(180)
  const [retentionInactive, setRetentionInactive] = useState(60)
  const [patientRetention, setPatientRetention] = useState<PatientRetentionRow[]>([])
  const [retentionLoading, setRetentionLoading] = useState(true)

  useEffect(() => {
    setSnapshotLoading(true)
    loadBranchSnapshot().then(setSnapshot).catch(reason => setError(reason instanceof Error ? reason.message : t("analyticsPage.errorSnapshot"))).finally(() => setSnapshotLoading(false))
    loadReceivingReference().then(ref => setReference({ products: ref.products, categories: ref.categories })).catch(() => { /* forecast pickers just stay empty */ })
    loadInsuranceClaimAging().then(setClaimAging).catch(reason => setError(reason instanceof Error ? reason.message : t("analyticsPage.errorClaimAging")))
    loadRecallLog(50).then(setRecallLog).catch(reason => setError(reason instanceof Error ? reason.message : t("analyticsPage.errorRecallLog")))
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  useEffect(() => {
    setTrendLoading(true)
    setStockLoading(true)
    Promise.all([
      loadSalesTrend(dateFrom, dateTo, bucket).then(setTrend),
      loadTopProducts(dateFrom, dateTo, topMetric, topDirection, 10).then(setTopProducts),
      loadCategoryBreakdown(dateFrom, dateTo).then(setCategoryBreakdown),
      loadInsuranceSummary(dateFrom, dateTo).then(setInsurance),
      loadSellerPerformance(dateFrom, dateTo).then(setSellers),
      loadPatientSummary(dateFrom, dateTo).then(setPatients),
      loadStockAdjustments(dateFrom, dateTo).then(setStockAdjustments),
      loadInventoryTurnover(dateFrom, dateTo).then(setInventoryTurnover),
      loadSupplierPerformance(dateFrom, dateTo).then(setSupplierPerformance),
      loadSalesHeatmap(dateFrom, dateTo).then(setSalesHeatmap),
      loadBasketSize(dateFrom, dateTo, bucket).then(setBasketSize),
      loadDiscountUsage(dateFrom, dateTo).then(setDiscountUsage),
      loadInsuranceProviderComparison(dateFrom, dateTo).then(setProviderComparison),
      loadSellerProductivity(dateFrom, dateTo).then(setSellerProductivity),
    ]).catch(reason => setError(reason instanceof Error ? reason.message : t("analyticsPage.errorRange"))).finally(() => setTrendLoading(false))
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [dateFrom, dateTo, bucket, topMetric, topDirection])

  useEffect(() => {
    setStockLoading(true)
    loadStockStatus(stockFilter).then(setStockRows).catch(reason => setError(reason instanceof Error ? reason.message : t("analyticsPage.errorStock"))).finally(() => setStockLoading(false))
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [stockFilter])

  useEffect(() => {
    setDeadStockLoading(true)
    loadDeadStock(deadStockDays, 50).then(setDeadStock).catch(reason => setError(reason instanceof Error ? reason.message : t("analyticsPage.errorDeadStock"))).finally(() => setDeadStockLoading(false))
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [deadStockDays])

  async function runPatientRetention() {
    setRetentionLoading(true)
    try {
      setPatientRetention(await loadPatientRetention({ lookbackDays: retentionLookback, inactiveDays: retentionInactive, limit: 20 }))
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : t("analyticsPage.errorRetention"))
    } finally {
      setRetentionLoading(false)
    }
  }

  useEffect(() => {
    void runPatientRetention()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  async function runForecast() {
    setForecastLoading(true)
    setError("")
    try {
      setForecast(await loadSalesForecast({
        productId: forecastProductId || null, categoryId: forecastCategoryId || null,
        daysHistory: forecastHistory, horizonDays: forecastHorizon,
      }))
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : t("analyticsPage.errorForecast"))
    } finally {
      setForecastLoading(false)
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
              <CartesianGrid strokeDasharray="4 4" />
              <XAxis dataKey="name" tick={{ fontSize: 10 }} />
              <YAxis tick={{ fontSize: 10 }} />
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
                <Pie data={categoryChartData} dataKey="value" nameKey="name" innerRadius={50} outerRadius={80} paddingAngle={2} stroke="#fff" strokeWidth={2}>
                  {categoryChartData.map((d, i) => <Cell key={i} fill={d.color} />)}
                </Pie>
                <Tooltip formatter={(v: any) => fmtRWFExact(Number(v))} />
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
                  background: stockFilter === f ? "var(--primary-light)" : "#fff",
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
                <CartesianGrid strokeDasharray="4 4" />
                <XAxis dataKey="name" tick={{ fontSize: 10 }} />
                <YAxis tick={{ fontSize: 10 }} />
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
