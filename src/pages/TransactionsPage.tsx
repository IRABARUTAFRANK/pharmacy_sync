import { useEffect, useMemo, useState } from "react"
import { Area, AreaChart, CartesianGrid, ResponsiveContainer, Tooltip, XAxis, YAxis } from "recharts"
import { CenterAlert, ChartTooltip, ColumnPicker, ProgressBar, SectionHeader, StatusBadge, Table } from "../components"
import { fmtRWFExact } from "../data"
import { useTranslation } from "../lib/i18n"
import { resolveRange, toDateInputValue, type OverviewPeriod } from "../lib/overview"
import { useGlobalSearch } from "../lib/search"
import {
  getSaleReceipt, listSaleHistory, loadDailyRevenueTrend,
  type DailyRevenuePoint, type InsuranceClaimStatus, type ReceiptData, type SaleHistoryRow,
} from "../lib/sales"
import { ReceiptView } from "./SalesPage"

// Self-pay vs. which insurer covered a sale -- the real axis this schema has,
// used everywhere the reference design wanted a cash/card/mobile-money split.
// public.sales has no payment_method column (see lib/overview.ts's own note
// on this), so that split isn't invented here either.
const SELF_PAY_KEY = "__self_pay__"
const SOURCE_COLORS = ["#16a34a", "#64748b", "#7c3aed", "#0ea5e9", "#f59e0b", "#ec4899", "#eb6834", "#2563eb"]

type TxnColumn = "receipt" | "when" | "patient" | "cashier" | "items" | "insurance" | "claimStatus" | "total"

function StatTile({ icon, value, valueColor, tint, label }: { icon: string; value: string; valueColor: string; tint: string; label: string }) {
  return (
    <div style={{ flex: "1 1 220px", background: tint, borderRadius: 14, padding: "18px 20px", display: "flex", flexDirection: "column", gap: 10 }}>
      <span style={{ fontSize: 20 }}>{icon}</span>
      <span style={{ fontSize: 24, fontWeight: 800, color: valueColor, fontFamily: "var(--font-display)", letterSpacing: "-0.02em" }}>{value}</span>
      <span style={{ fontSize: 13, color: "var(--ink-mid)", fontWeight: 500 }}>{label}</span>
    </div>
  )
}

// Every completed sale is written atomically by complete_sale() — this page
// reads that same stored record back, so "stored receipt" means a real trip
// to the database, not anything cached from the moment of sale.
export default function TransactionsPage({ period }: { period?: OverviewPeriod }) {
  const { t } = useTranslation()
  const [rows, setRows] = useState<SaleHistoryRow[]>([])
  const [trend, setTrend] = useState<DailyRevenuePoint[]>([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState("")
  const [receipt, setReceipt] = useState<ReceiptData | null>(null)
  const { term: globalTerm, setTerm: setGlobalTerm } = useGlobalSearch()
  const [query, setQuery] = useState(globalTerm)
  useEffect(() => setQuery(globalTerm), [globalTerm])
  const [dateFrom, setDateFrom] = useState("")
  const [dateTo, setDateTo] = useState("")
  const [sourceFilter, setSourceFilter] = useState("")
  const [claimStatusFilter, setClaimStatusFilter] = useState<"" | InsuranceClaimStatus>("")

  const TXN_COLUMNS: { key: TxnColumn; label: string }[] = [
    { key: "receipt", label: t("transactions.colReceipt") },
    { key: "when", label: t("transactions.colDate") },
    { key: "patient", label: t("transactions.colPatient") },
    { key: "cashier", label: t("transactions.colCashier") },
    { key: "items", label: t("transactions.colItems") },
    { key: "insurance", label: t("transactions.colInsurance") },
    { key: "claimStatus", label: t("transactions.colClaimStatus") },
    { key: "total", label: t("transactions.colTotal") },
  ]
  const [visibleColumns, setVisibleColumns] = useState<Set<TxnColumn>>(new Set(TXN_COLUMNS.map(c => c.key)))
  const toggleColumn = (key: TxnColumn) => setVisibleColumns(current => {
    const next = new Set(current)
    if (next.has(key) && next.size > 1) next.delete(key)
    else next.add(key)
    return next
  })

  const CLAIM_STATUS_STYLE: Record<InsuranceClaimStatus, { label: string; color: string; bg: string }> = {
    submitted: { label: t("insurancePage.statusSubmitted"), color: "#2563eb", bg: "#eff6ff" },
    approved: { label: t("insurancePage.statusApproved"), color: "#16a34a", bg: "#f0fdf4" },
    paid: { label: t("insurancePage.statusPaid"), color: "#7c3aed", bg: "#f5f3ff" },
    rejected: { label: t("insurancePage.statusRejected"), color: "#dc2626", bg: "#fef2f2" },
  }

  // The top bar's date-range dropdown pre-fills the fields below; picking
  // "Custom Range" up there leaves whatever the user already typed here
  // alone instead of stomping it, since resolveRange() has no real "custom"
  // behavior of its own yet (it falls back to "this month").
  useEffect(() => {
    if (!period || period === "custom") return
    const range = resolveRange(period)
    setDateFrom(toDateInputValue(range.start))
    setDateTo(toDateInputValue(range.end))
  }, [period])

  useEffect(() => {
    setLoading(true)
    Promise.all([listSaleHistory(), loadDailyRevenueTrend(7)])
      .then(([history, dailyTrend]) => { setRows(history); setTrend(dailyTrend) })
      .catch(reason => setError(reason instanceof Error ? reason.message : t("transactions.loadHistoryError")))
      .finally(() => setLoading(false))
  }, [t])

  async function openReceipt(saleId: string) {
    setError("")
    try {
      setReceipt(await getSaleReceipt(saleId))
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : t("transactions.loadReceiptError"))
    }
  }

  const sourceOptions = useMemo(
    () => Array.from(new Set(rows.map(r => r.insuranceProviderName).filter((n): n is string => !!n))).sort(),
    [rows],
  )

  const filtered = useMemo(() => {
    const needle = query.trim().toLowerCase()
    const from = dateFrom ? new Date(`${dateFrom}T00:00:00`).getTime() : null
    const to = dateTo ? new Date(`${dateTo}T23:59:59.999`).getTime() : null
    return rows.filter(r => {
      const matchesQuery = !needle || `${r.receiptNumber} ${r.cashierName} ${r.patientName ?? ""}`.toLowerCase().includes(needle)
      const soldAtMs = new Date(r.soldAt).getTime()
      const matchesFrom = from === null || soldAtMs >= from
      const matchesTo = to === null || soldAtMs <= to
      const matchesSource = !sourceFilter || (sourceFilter === SELF_PAY_KEY ? !r.insuranceProviderName : r.insuranceProviderName === sourceFilter)
      const matchesClaimStatus = !claimStatusFilter || r.claimStatus === claimStatusFilter
      return matchesQuery && matchesFrom && matchesTo && matchesSource && matchesClaimStatus
    })
  }, [rows, query, dateFrom, dateTo, sourceFilter, claimStatusFilter])

  // Every tile reflects whatever the filters above currently show, so the
  // number on screen always matches the rows underneath it.
  const grossRevenue = filtered.reduce((sum, r) => sum + r.totalAmount, 0)
  const insuranceRevenue = filtered.filter(r => r.insuranceProviderName).reduce((sum, r) => sum + r.totalAmount, 0)
  const pendingClaimsCount = filtered.filter(r => r.claimStatus === "submitted" || r.claimStatus === "approved").length
  const totalClaimsCount = filtered.filter(r => r.claimStatus != null).length

  // Real substitute for a cash/card/mobile-money split this schema doesn't
  // have -- grouped by the one payment-source axis that IS real: self-pay
  // vs. which insurer covered the sale.
  const paymentSources = useMemo(() => {
    const groups = new Map<string, { count: number; amount: number }>()
    for (const r of filtered) {
      const key = r.insuranceProviderName ?? t("transactions.selfPay")
      const g = groups.get(key) ?? { count: 0, amount: 0 }
      g.count += 1
      g.amount += r.totalAmount
      groups.set(key, g)
    }
    return Array.from(groups.entries())
      .map(([name, g]) => ({ name, ...g }))
      .sort((a, b) => b.amount - a.amount)
  }, [filtered, t])
  const maxSourceAmount = Math.max(1, ...paymentSources.map(s => s.amount))

  function downloadLedgerCsv() {
    const header = ["Receipt", "Date", "Patient", "Cashier", "Items", "Insurance", "Claim Status", "Total (RWF)"].join(",")
    const escape = (v: string) => (/[",\n]/.test(v) ? `"${v.replace(/"/g, '""')}"` : v)
    const lines = filtered.map(r => [
      r.receiptNumber,
      new Date(r.soldAt).toLocaleString(),
      r.patientName ?? "",
      r.cashierName,
      String(r.itemCount),
      r.insuranceProviderName ?? t("transactions.selfPay"),
      r.claimStatus ? CLAIM_STATUS_STYLE[r.claimStatus].label : "",
      String(Math.round(r.totalAmount)),
    ].map(escape).join(","))
    const blob = new Blob([[header, ...lines].join("\n")], { type: "text/csv;charset=utf-8;" })
    const url = URL.createObjectURL(blob)
    const a = document.createElement("a")
    a.href = url
    a.download = `transactions-${new Date().toISOString().slice(0, 10)}.csv`
    document.body.appendChild(a)
    a.click()
    document.body.removeChild(a)
    URL.revokeObjectURL(url)
  }

  if (receipt) return <ReceiptView data={receipt} onClose={() => setReceipt(null)} closeLabel={t("transactions.backToTransactions")} />

  return (
    <div className="animate-fade-in">
      {error && <CenterAlert key={error} message={error} />}
      <SectionHeader title={t("page.transactions")} subtitle={t("transactions.subtitle")} />

      <div style={{ display: "flex", gap: 14, flexWrap: "wrap", marginBottom: 14 }}>
        <StatTile icon="💳" tint="#eafaf1" valueColor="#16a34a" value={filtered.length.toLocaleString()} label={t("transactions.statTotalTransactions")} />
        <StatTile icon="📈" tint="#eaf2fb" valueColor="#1e5fa8" value={fmtRWFExact(grossRevenue)} label={t("transactions.statGrossRevenue")} />
        <StatTile icon="🏥" tint="#f5f3ff" valueColor="#7c3aed" value={fmtRWFExact(insuranceRevenue)} label={t("transactions.statInsuranceTxns")} />
        <StatTile icon="⏳" tint="#fff8e6" valueColor="#d97706" value={`${pendingClaimsCount} / ${totalClaimsCount}`} label={t("transactions.statPendingClaims")} />
      </div>

      <div style={{ display: "grid", gridTemplateColumns: "1.6fr 1fr", gap: 14, marginBottom: 14 }}>
        <div style={{ background: "#fff", border: "1px solid var(--border)", borderRadius: 12, padding: 16 }}>
          <div style={{ fontSize: 14, fontWeight: 700, color: "var(--ink)" }}>{t("transactions.trendTitle")}</div>
          <div style={{ fontSize: 11, color: "var(--ink-muted)", marginBottom: 10, fontFamily: "var(--font-mono)" }}>{t("transactions.trendSubtitle")}</div>
          <ResponsiveContainer width="100%" height={220}>
            <AreaChart data={trend} margin={{ top: 4, right: 8, bottom: 0, left: 0 }}>
              <defs>
                <linearGradient id="gTxnTrend" x1="0" y1="0" x2="0" y2="1">
                  <stop offset="5%" stopColor="#16a34a" stopOpacity={0.18} />
                  <stop offset="95%" stopColor="#16a34a" stopOpacity={0} />
                </linearGradient>
              </defs>
              <CartesianGrid stroke="#f0f0f0" strokeDasharray="4 4" />
              <XAxis dataKey="label" tick={{ fontSize: 11 }} axisLine={false} tickLine={false} />
              <YAxis tick={{ fontSize: 11 }} axisLine={false} tickLine={false} tickFormatter={v => Math.round(v).toLocaleString()} />
              <Tooltip content={<ChartTooltip />} />
              <Area type="monotone" dataKey="revenue" name={t("transactions.trendRevenueLabel")} stroke="#16a34a" fill="url(#gTxnTrend)" strokeWidth={2.5} dot={false} activeDot={{ r: 5 }} />
            </AreaChart>
          </ResponsiveContainer>
        </div>

        <div style={{ background: "#fff", border: "1px solid var(--border)", borderRadius: 12, padding: 16 }}>
          <div style={{ fontSize: 14, fontWeight: 700, color: "var(--ink)" }}>{t("transactions.paymentSourcesTitle")}</div>
          <div style={{ fontSize: 11, color: "var(--ink-muted)", marginBottom: 12, fontFamily: "var(--font-mono)" }}>{t("transactions.paymentSourcesSubtitle")}</div>
          {paymentSources.length === 0 ? (
            <div style={{ padding: "20px 0", textAlign: "center", color: "var(--ink-faint)", fontSize: 12 }}>{t("transactions.emptyFiltered")}</div>
          ) : (
            <div style={{ display: "flex", flexDirection: "column", gap: 12 }}>
              {paymentSources.map((source, i) => (
                <div key={source.name}>
                  <div style={{ display: "flex", justifyContent: "space-between", fontSize: 12, marginBottom: 5 }}>
                    <span style={{ fontWeight: 600, color: "var(--ink)" }}>{source.name}</span>
                    <span style={{ color: "var(--ink-muted)" }}>{source.count} · {fmtRWFExact(source.amount)}</span>
                  </div>
                  <ProgressBar value={source.amount} max={maxSourceAmount} color={SOURCE_COLORS[i % SOURCE_COLORS.length]} height={7} />
                </div>
              ))}
            </div>
          )}
        </div>
      </div>

      <div style={{ background: "#fff", border: "1px solid var(--border)", borderRadius: 12, overflow: "hidden" }}>
        <div style={{ padding: 16 }}>
          <div style={{ fontWeight: 700, fontSize: 14, color: "var(--ink)", marginBottom: 2 }}>{t("transactions.ledgerTitle")}</div>
          <div style={{ fontSize: 11, color: "var(--ink-faint)", fontFamily: "var(--font-mono)", marginBottom: 12 }}>{t("transactions.ledgerSubtitle")}</div>

          <div style={{ display: "flex", flexWrap: "wrap", alignItems: "flex-end", gap: 10, marginBottom: 10 }}>
            <input
              value={query} onChange={e => { setQuery(e.target.value); setGlobalTerm(e.target.value) }}
              placeholder={t("transactions.searchPlaceholder")}
              style={{ maxWidth: 320, flex: "1 1 240px", padding: "8px 12px", border: "1px solid var(--border)", borderRadius: 8, fontFamily: "inherit", fontSize: 12 }}
            />
            <div>
              <label style={{ display: "block", fontSize: 10, fontWeight: 600, color: "var(--ink-muted)", textTransform: "uppercase", letterSpacing: "0.05em", marginBottom: 4 }}>{t("transactions.dateFromLabel")}</label>
              <input
                type="date" value={dateFrom} onChange={e => setDateFrom(e.target.value)}
                style={{ padding: "7px 10px", border: "1px solid var(--border)", borderRadius: 8, fontFamily: "inherit", fontSize: 12 }}
              />
            </div>
            <div>
              <label style={{ display: "block", fontSize: 10, fontWeight: 600, color: "var(--ink-muted)", textTransform: "uppercase", letterSpacing: "0.05em", marginBottom: 4 }}>{t("transactions.dateToLabel")}</label>
              <input
                type="date" value={dateTo} onChange={e => setDateTo(e.target.value)}
                style={{ padding: "7px 10px", border: "1px solid var(--border)", borderRadius: 8, fontFamily: "inherit", fontSize: 12 }}
              />
            </div>
            {(dateFrom || dateTo) && (
              <button
                onClick={() => { setDateFrom(""); setDateTo("") }}
                style={{ padding: "7px 12px", border: "1px solid var(--border)", borderRadius: 8, background: "#fff", fontFamily: "inherit", fontSize: 12, color: "var(--ink-muted)", cursor: "pointer" }}
              >
                {t("transactions.clearDates")}
              </button>
            )}
            <select
              value={sourceFilter} onChange={e => setSourceFilter(e.target.value)}
              style={{ padding: "8px 10px", borderRadius: 8, border: "1px solid var(--border)", fontSize: 12, fontFamily: "inherit", background: "var(--bg)" }}
            >
              <option value="">{t("transactions.allSources")}</option>
              <option value={SELF_PAY_KEY}>{t("transactions.selfPay")}</option>
              {sourceOptions.map(name => <option key={name} value={name}>{name}</option>)}
            </select>
          </div>

          <div style={{ display: "flex", flexWrap: "wrap", gap: 10 }}>
            <select
              value={claimStatusFilter} onChange={e => setClaimStatusFilter(e.target.value as "" | InsuranceClaimStatus)}
              style={{ padding: "8px 10px", borderRadius: 8, border: "1px solid var(--border)", fontSize: 12, fontFamily: "inherit", background: "var(--bg)" }}
            >
              <option value="">{t("transactions.allClaimStatuses")}</option>
              {(Object.entries(CLAIM_STATUS_STYLE) as [InsuranceClaimStatus, { label: string }][]).map(([value, s]) => (
                <option key={value} value={value}>{s.label}</option>
              ))}
            </select>
            <ColumnPicker columns={TXN_COLUMNS} visible={visibleColumns} onToggle={toggleColumn} />
            <button
              onClick={downloadLedgerCsv}
              style={{ display: "flex", alignItems: "center", gap: 5, padding: "5px 11px", borderRadius: 8, border: "1px solid var(--border)", background: "#fff", color: "var(--ink-mid)", fontSize: 11, fontWeight: 600, cursor: "pointer", fontFamily: "inherit" }}
            >
              ↓ {t("transactions.exportCsv")}
            </button>
          </div>
        </div>

        {loading ? (
          <div style={{ padding: 40, textAlign: "center", color: "var(--ink-muted)", fontSize: 13 }}>{t("transactions.loading")}</div>
        ) : filtered.length === 0 ? (
          <div style={{ padding: 40, textAlign: "center", color: "var(--ink-muted)", fontSize: 13 }}>{rows.length === 0 ? t("transactions.empty") : t("transactions.emptyFiltered")}</div>
        ) : (
          <Table
            columns={TXN_COLUMNS.filter(c => visibleColumns.has(c.key))}
            rows={filtered.map(r => ({
              receipt: <span style={{ fontFamily: 'var(--font-mono)', fontWeight: 600 }}>{r.receiptNumber}</span>,
              when: new Date(r.soldAt).toLocaleString(),
              patient: r.patientName ?? <span style={{ color: "var(--ink-faint)" }}>{t("transactions.noPatient")}</span>,
              cashier: r.cashierName,
              items: r.itemCount,
              insurance: r.insuranceProviderName ?? <span style={{ color: "var(--ink-faint)" }}>{t("transactions.selfPay")}</span>,
              claimStatus: r.claimStatus
                ? <StatusBadge label={CLAIM_STATUS_STYLE[r.claimStatus].label} color={CLAIM_STATUS_STYLE[r.claimStatus].color} bg={CLAIM_STATUS_STYLE[r.claimStatus].bg} />
                : <span style={{ color: "var(--ink-faint)" }}>—</span>,
              total: fmtRWFExact(r.totalAmount),
              _saleId: r.saleId,
            }))}
            onRowClick={row => void openReceipt(row._saleId as string)}
          />
        )}
      </div>
    </div>
  )
}
