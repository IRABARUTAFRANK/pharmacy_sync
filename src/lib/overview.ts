import { supabase } from "./supabase"

// Live data behind pages/OverviewPage.tsx. Every figure here traces to a real
// table -- nothing is padded to make the dashboard look busier than the
// pharmacy actually is, and anything with no rows behind it reports 0 rather
// than being hidden. Where the old mock dashboard showed a number the schema
// cannot produce (net profit, break-even, "active patients", a
// cash/mobile-money/card payment mix) that tile was dropped or replaced
// rather than faked; see the notes at each computation below.
//
// Branch scoping is handled entirely by RLS: public.sales, stock_batches,
// reorder_points and product_categories carry the shared "branch access"
// policy (branch_id = current_branch_id()), while sale_items and barcodes are
// scoped through their parent sale/batch. So none of the reads below filter
// on branch_id themselves -- Postgres already did.

// ── Period ──────────────────────────────────────────────────────────────────
// Mirrors DATE_RANGE_OPTIONS in App.tsx so the existing top-bar selector
// drives this page without a second control.

export type OverviewPeriod = "today" | "thisWeek" | "thisMonth" | "lastMonth" | "quarter" | "custom"

const DAY_MS = 86_400_000

interface Range {
  start: Date
  end: Date
  prevStart: Date
  prevEnd: Date
  label: string
  bucket: "day" | "month"
}

function startOfDay(value: Date): Date {
  const copy = new Date(value)
  copy.setHours(0, 0, 0, 0)
  return copy
}

// Monday-first: getDay() is Sunday-first, so shift back by (day + 6) % 7.
function startOfWeek(value: Date): Date {
  const day = startOfDay(value)
  return new Date(day.getTime() - ((day.getDay() + 6) % 7) * DAY_MS)
}

export function resolveRange(period: OverviewPeriod, now: Date = new Date()): Range {
  let start: Date
  let end: Date = now
  let label: string

  switch (period) {
    case "today":
      start = startOfDay(now)
      label = "Today"
      break
    case "thisWeek":
      start = startOfWeek(now)
      label = "This week"
      break
    case "lastMonth":
      start = new Date(now.getFullYear(), now.getMonth() - 1, 1)
      end = new Date(now.getFullYear(), now.getMonth(), 1)
      label = "Last month"
      break
    case "quarter":
      start = new Date(now.getFullYear(), Math.floor(now.getMonth() / 3) * 3, 1)
      label = "This quarter"
      break
    case "thisMonth":
    case "custom":
    default:
      start = new Date(now.getFullYear(), now.getMonth(), 1)
      label = "This month"
      break
  }

  // The comparison window is the same length immediately before this one, so
  // "vs previous" stays honest for a part-finished month: a month that is 9
  // days old compares against the 9 days before it, not a full 30.
  const span = Math.max(end.getTime() - start.getTime(), DAY_MS)
  return {
    start,
    end,
    prevStart: new Date(start.getTime() - span),
    prevEnd: start,
    label,
    bucket: span > 62 * DAY_MS ? "month" : "day",
  }
}

// For <input type="date"> values -- local calendar date, not toISOString()'s
// UTC one. resolveRange()'s start/end are built from local Y/M/D components
// (see startOfDay/startOfWeek above), so converting through UTC here could
// shift the date by one depending on the viewer's timezone offset.
export function toDateInputValue(d: Date): string {
  const y = d.getFullYear()
  const m = String(d.getMonth() + 1).padStart(2, "0")
  const day = String(d.getDate()).padStart(2, "0")
  return `${y}-${m}-${day}`
}

// ── Shapes ──────────────────────────────────────────────────────────────────

export interface Delta {
  value: number
  changePct: number | null
}

export interface TrendPoint {
  label: string
  revenue: number
  vat: number
}

export interface CategorySlice {
  name: string
  sales: number
}

export interface DayBar {
  day: string
  txn: number
  amount: number
}

export interface SplitSlice {
  name: string
  value: number
  amount: number
  color: string
}

export interface TopProduct {
  rank: number
  variantId: string
  name: string
  category: string
  units: number
  revenue: number
  stock: number
  trendPct: number | null
}

export interface Insight {
  tone: "good" | "warn" | "bad" | "info"
  text: string
}

export interface OverviewData {
  periodLabel: string
  bucket: "day" | "month"
  revenue: Delta
  transactions: Delta
  itemsDispensed: Delta
  inventoryValue: number
  expiring: { count: number; value: number }
  belowReorder: number
  revenueTrend: TrendPoint[]
  categoryMix: CategorySlice[]
  dailyTransactions: DayBar[]
  paymentSplit: SplitSlice[]
  topProducts: TopProduct[]
  insights: Insight[]
}

const asNumber = (value: string | number | null | undefined) => Number(value ?? 0)

function changePct(current: number, previous: number): number | null {
  // No previous activity means "no comparison", not "+100%". Showing a growth
  // badge against a zero baseline is the kind of number that looks great and
  // means nothing.
  if (previous <= 0) return null
  return ((current - previous) / previous) * 100
}

// ── Paging ──────────────────────────────────────────────────────────────────
// PostgREST caps a single select at 1000 rows. public.barcodes holds ONE ROW
// PER PHYSICAL PACK, so a real pharmacy passes that cap quickly -- a plain
// select would silently truncate and the dashboard would report less stock
// than the branch actually holds. Everything unbounded is paged to exhaustion
// so the screen and the database always agree.
//
// This is also the clearest argument for moving these aggregates into a
// branch_overview() security-definer RPC: Postgres can sum them in one pass
// instead of shipping every pack row to the browser.

const PAGE = 1000

async function fetchAll<T>(table: string, columns: string, tune?: (q: any) => any): Promise<T[]> {
  const rows: T[] = []
  for (let page = 0; ; page++) {
    let query = supabase.from(table).select(columns)
    if (tune) query = tune(query)
    const { data, error } = await query.range(page * PAGE, page * PAGE + PAGE - 1)
    if (error) throw new Error(`${table}: ${error.message}`)
    const batch = (data ?? []) as T[]
    rows.push(...batch)
    if (batch.length < PAGE) return rows
  }
}

// .in() with thousands of uuids would blow the URL length limit, so sale ids
// are queried in chunks and stitched back together.
const ID_CHUNK = 200

async function fetchSaleItems(saleIds: string[]): Promise<any[]> {
  if (saleIds.length === 0) return []
  const chunks: string[][] = []
  for (let i = 0; i < saleIds.length; i += ID_CHUNK) chunks.push(saleIds.slice(i, i + ID_CHUNK))
  const results = await Promise.all(
    chunks.map(chunk =>
      fetchAll<any>("sale_items", "sale_id, barcode_id, tax_rate_id, quantity, unit_price, subtotal, insurance_covered_amount", q => q.in("sale_id", chunk)),
    ),
  )
  return results.flat()
}

// ── Load ────────────────────────────────────────────────────────────────────

export async function loadOverview(period: OverviewPeriod): Promise<OverviewData> {
  const now = new Date()
  const range = resolveRange(period, now)

  // The Daily Transactions card always covers the current Monday..Sunday week,
  // which for period="today" starts BEFORE prevStart. Fetch from whichever is
  // earlier, or that card renders a week of false zeros.
  const weekStart = startOfWeek(now)
  const fetchFrom = new Date(Math.min(range.prevStart.getTime(), weekStart.getTime()))
  const fetchTo = new Date(Math.max(range.end.getTime(), now.getTime()))

  const [sales, taxRates, barcodes, batches, variants, products, categories, categorization, reorderPoints] =
    await Promise.all([
      fetchAll<any>("sales", "id, total_amount, sold_at", q =>
        q.gte("sold_at", fetchFrom.toISOString()).lt("sold_at", fetchTo.toISOString()).order("sold_at", { ascending: true })),
      fetchAll<any>("tax_rates", "id, rate_percentage"),
      fetchAll<any>("barcodes", "id, stock_batch_id, barcode_type, pieces_per_pack, quantity_available, status"),
      fetchAll<any>("stock_batches", "id, product_variant_id, expiry_date, selling_price"),
      fetchAll<any>("product_variants", "id, product_id, dosage, form"),
      fetchAll<any>("products", "id, name"),
      fetchAll<any>("product_categories", "id, name"),
      fetchAll<any>("branch_product_categorization", "product_id, category_id"),
      fetchAll<any>("reorder_points", "product_id, min_quantity"),
    ])

  // sale_items has no timestamp of its own, so it is fetched by the sale ids
  // that actually fell inside the window rather than pulled wholesale.
  const items = await fetchSaleItems(sales.map(sale => sale.id))

  const taxPctById = new Map<string, number>(taxRates.map(t => [t.id, asNumber(t.rate_percentage)]))
  const batchById = new Map<string, any>(batches.map(b => [b.id, b]))
  const barcodeById = new Map<string, any>(barcodes.map(b => [b.id, b]))
  const variantById = new Map<string, any>(variants.map(v => [v.id, v]))
  const productById = new Map<string, any>(products.map(p => [p.id, p]))
  const categoryById = new Map<string, string>(categories.map(c => [c.id, c.name as string]))
  const categoryByProduct = new Map<string, string>(categorization.map(c => [c.product_id, categoryById.get(c.category_id) ?? "Uncategorised"]))

  const variantLabel = (variantId: string): string => {
    const variant = variantById.get(variantId)
    if (!variant) return "Unknown product"
    const name = productById.get(variant.product_id)?.name
    // Label from the variant that was actually sold -- dosage belongs to the
    // variant, so picking any other one would print the wrong strength.
    return [name, variant.dosage, variant.form].filter(Boolean).join(" ") || "Unnamed product"
  }

  // ── Current stock ────────────────────────────────────────────────────────
  // Pack rows only. A "box" row's quantity_available is a 1-or-0 "this carton
  // exists" flag, so adding it on top would inflate every carton by one unit
  // -- the same rule loadInventoryDataset() applies, kept identical here on
  // purpose so Inventory and Overview never disagree about stock on hand.
  let inventoryValue = 0
  const stockByVariant = new Map<string, number>()
  const stockByProduct = new Map<string, number>()
  const expiringBatches = new Set<string>()
  let expiringValue = 0
  const horizon = now.getTime() + 90 * DAY_MS

  for (const barcode of barcodes) {
    if (barcode.barcode_type !== "pack") continue
    if (barcode.status !== "active") continue
    const units = asNumber(barcode.quantity_available) * asNumber(barcode.pieces_per_pack)
    if (units <= 0) continue

    const batch = batchById.get(barcode.stock_batch_id)
    if (!batch) continue
    const value = units * asNumber(batch.selling_price)
    inventoryValue += value

    const variant = variantById.get(batch.product_variant_id)
    if (variant) {
      stockByVariant.set(variant.id, (stockByVariant.get(variant.id) ?? 0) + units)
      stockByProduct.set(variant.product_id, (stockByProduct.get(variant.product_id) ?? 0) + units)
    }

    // Expiry risk is measured on stock that still exists -- a long-expired
    // batch with nothing left in it is not money at risk. Anything already
    // past its date is included, since nothing flips status to 'expired'
    // automatically and that stock still needs writing off.
    if (new Date(batch.expiry_date).getTime() <= horizon) {
      expiringBatches.add(batch.id)
      expiringValue += value
    }
  }

  const belowReorder = reorderPoints.filter(
    point => asNumber(point.min_quantity) > 0 && (stockByProduct.get(point.product_id) ?? 0) < asNumber(point.min_quantity),
  ).length

  // ── Split sales into the two comparison windows ──────────────────────────
  const currentSaleIds = new Set<string>()
  const previousSaleIds = new Set<string>()
  let revenueNow = 0
  let revenuePrev = 0

  for (const sale of sales) {
    const at = new Date(sale.sold_at).getTime()
    const amount = asNumber(sale.total_amount)
    if (at >= range.start.getTime() && at < range.end.getTime()) {
      currentSaleIds.add(sale.id)
      revenueNow += amount
    } else if (at >= range.prevStart.getTime() && at < range.prevEnd.getTime()) {
      previousSaleIds.add(sale.id)
      revenuePrev += amount
    }
  }

  // VAT is recomputed the same way complete_sale() and buildReceipt() do it:
  // round(subtotal * rate) / 100. sales.total_amount is already tax-inclusive
  // (complete_sale sums subtotal + tax per line), so revenue and the sum of
  // these line totals agree by construction.
  const lineOf = (item: any) => {
    const subtotal = asNumber(item.subtotal)
    const vat = Math.round(subtotal * (taxPctById.get(item.tax_rate_id) ?? 0)) / 100
    return { subtotal, vat, total: subtotal + vat, covered: asNumber(item.insurance_covered_amount), qty: asNumber(item.quantity) }
  }

  const currentItems = items.filter(item => currentSaleIds.has(item.sale_id))
  const previousItems = items.filter(item => previousSaleIds.has(item.sale_id))

  const unitsNow = currentItems.reduce((sum, item) => sum + asNumber(item.quantity), 0)
  const unitsPrev = previousItems.reduce((sum, item) => sum + asNumber(item.quantity), 0)

  // ── Revenue trend ────────────────────────────────────────────────────────
  const vatBySale = new Map<string, number>()
  for (const item of currentItems) {
    vatBySale.set(item.sale_id, (vatBySale.get(item.sale_id) ?? 0) + lineOf(item).vat)
  }

  const bucketKey = (date: Date) =>
    range.bucket === "month"
      ? date.toLocaleDateString(undefined, { month: "short" })
      : date.toLocaleDateString(undefined, { day: "numeric", month: "short" })

  // Seed every bucket in the window so a day with no sales renders as a real
  // zero instead of vanishing and making the line look continuous.
  const trendBuckets = new Map<string, TrendPoint>()
  if (range.bucket === "day") {
    for (let t = startOfDay(range.start).getTime(); t <= range.end.getTime(); t += DAY_MS) {
      const key = bucketKey(new Date(t))
      trendBuckets.set(key, { label: key, revenue: 0, vat: 0 })
    }
  } else {
    const cursor = new Date(range.start.getFullYear(), range.start.getMonth(), 1)
    while (cursor <= range.end) {
      const key = bucketKey(cursor)
      trendBuckets.set(key, { label: key, revenue: 0, vat: 0 })
      cursor.setMonth(cursor.getMonth() + 1)
    }
  }

  for (const sale of sales) {
    if (!currentSaleIds.has(sale.id)) continue
    const point = trendBuckets.get(bucketKey(new Date(sale.sold_at)))
    if (!point) continue
    point.revenue += asNumber(sale.total_amount)
    point.vat += vatBySale.get(sale.id) ?? 0
  }
  const revenueTrend = Array.from(trendBuckets.values())

  // ── Daily transactions, Monday..Sunday of the current week ───────────────
  const DAY_LABELS = ["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"]
  const dailyTransactions: DayBar[] = DAY_LABELS.map(day => ({ day, txn: 0, amount: 0 }))
  for (const sale of sales) {
    const offset = Math.floor((startOfDay(new Date(sale.sold_at)).getTime() - weekStart.getTime()) / DAY_MS)
    if (offset < 0 || offset > 6) continue
    dailyTransactions[offset].txn += 1
    dailyTransactions[offset].amount += asNumber(sale.total_amount)
  }

  // ── Category mix + top products ──────────────────────────────────────────
  // Aggregated by VARIANT, not product: "Amoxicillin 500mg" and "Amoxicillin
  // 250mg" are different things to a pharmacist, and the screenshots show the
  // strength on every row.
  const categoryTotals = new Map<string, number>()
  const variantAgg = new Map<string, { units: number; revenue: number }>()
  const variantRevenuePrev = new Map<string, number>()

  const variantOf = (item: any): string | null => {
    const barcode = barcodeById.get(item.barcode_id)
    if (!barcode) return null
    const batch = batchById.get(barcode.stock_batch_id)
    return batch?.product_variant_id ?? null
  }

  for (const item of currentItems) {
    const variantId = variantOf(item)
    if (!variantId) continue
    const line = lineOf(item)
    const productId = variantById.get(variantId)?.product_id
    const category = (productId && categoryByProduct.get(productId)) || "Uncategorised"
    categoryTotals.set(category, (categoryTotals.get(category) ?? 0) + line.total)
    const agg = variantAgg.get(variantId) ?? { units: 0, revenue: 0 }
    agg.units += line.qty
    agg.revenue += line.total
    variantAgg.set(variantId, agg)
  }

  for (const item of previousItems) {
    const variantId = variantOf(item)
    if (!variantId) continue
    variantRevenuePrev.set(variantId, (variantRevenuePrev.get(variantId) ?? 0) + lineOf(item).total)
  }

  const categoryMix = Array.from(categoryTotals.entries())
    .map(([name, sales]) => ({ name, sales }))
    .sort((a, b) => b.sales - a.sales)
    .slice(0, 8)

  const topProducts: TopProduct[] = Array.from(variantAgg.entries())
    .sort((a, b) => b[1].revenue - a[1].revenue)
    .slice(0, 8)
    .map(([variantId, agg], index) => {
      const productId = variantById.get(variantId)?.product_id
      return {
        rank: index + 1,
        variantId,
        name: variantLabel(variantId),
        category: (productId && categoryByProduct.get(productId)) || "Uncategorised",
        units: agg.units,
        revenue: agg.revenue,
        stock: stockByVariant.get(variantId) ?? 0,
        trendPct: changePct(agg.revenue, variantRevenuePrev.get(variantId) ?? 0),
      }
    })

  // ── Payment split ────────────────────────────────────────────────────────
  // NOT the cash / mobile-money / card mix the mock dashboard showed:
  // public.sales has no payment_method column. That column is required by the
  // RRA VSDC invoice spec, and once it exists this becomes a real four-way
  // mix. Until then the split that IS recorded -- insurance-covered vs
  // patient-paid, from sale_items.insurance_covered_amount -- is what shows.
  const grossNow = currentItems.reduce((sum, item) => sum + lineOf(item).total, 0)
  const coveredNow = currentItems.reduce((sum, item) => sum + lineOf(item).covered, 0)
  const patientNow = Math.max(grossNow - coveredNow, 0)
  const splitBase = coveredNow + patientNow
  const paymentSplit: SplitSlice[] = splitBase > 0
    ? [
        { name: "Patient paid", value: Math.round((patientNow / splitBase) * 100), amount: patientNow, color: "#1e5fa8" },
        { name: "Insurance", value: Math.round((coveredNow / splitBase) * 100), amount: coveredNow, color: "#60a5fa" },
      ]
    : []

  // ── Insights ─────────────────────────────────────────────────────────────
  const insights: Insight[] = []
  const revenueChange = changePct(revenueNow, revenuePrev)

  if (revenueChange !== null) {
    insights.push({
      tone: revenueChange >= 0 ? "good" : "warn",
      text: `Revenue is ${revenueChange >= 0 ? "up" : "down"} ${Math.abs(revenueChange).toFixed(1)}% against the previous window of equal length.`,
    })
  } else if (revenueNow > 0) {
    insights.push({ tone: "info", text: "First period with recorded sales — no earlier window to compare against yet." })
  }

  if (expiringBatches.size > 0) {
    insights.push({
      tone: expiringValue > inventoryValue * 0.1 ? "bad" : "warn",
      text: `${expiringBatches.size} batch${expiringBatches.size === 1 ? "" : "es"} holding RWF ${Math.round(expiringValue).toLocaleString()} of stock expire within 90 days.`,
    })
  }

  if (belowReorder > 0) {
    insights.push({ tone: "warn", text: `${belowReorder} product${belowReorder === 1 ? " is" : "s are"} below their reorder point and should be restocked.` })
  }

  // Days of cover: how long current stock lasts at this period's selling rate.
  const days = Math.max((range.end.getTime() - range.start.getTime()) / DAY_MS, 1)
  const dailyRevenue = revenueNow / days
  if (dailyRevenue > 0 && inventoryValue > 0) {
    insights.push({
      tone: inventoryValue / dailyRevenue < 21 ? "warn" : "info",
      text: `At the current selling rate, stock on hand covers about ${Math.round(inventoryValue / dailyRevenue)} days of trading.`,
    })
  }

  if (insights.length === 0) {
    insights.push({ tone: "info", text: "No sales recorded in this period yet — every figure above reads zero until the pharmacy trades." })
  }

  return {
    periodLabel: range.label,
    bucket: range.bucket,
    revenue: { value: revenueNow, changePct: revenueChange },
    transactions: { value: currentSaleIds.size, changePct: changePct(currentSaleIds.size, previousSaleIds.size) },
    itemsDispensed: { value: unitsNow, changePct: changePct(unitsNow, unitsPrev) },
    inventoryValue,
    expiring: { count: expiringBatches.size, value: expiringValue },
    belowReorder,
    revenueTrend,
    categoryMix,
    dailyTransactions,
    paymentSplit,
    topProducts,
    insights,
  }
}
