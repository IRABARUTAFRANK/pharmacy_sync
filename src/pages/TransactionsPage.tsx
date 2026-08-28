import { useEffect, useMemo, useState } from "react"
import { CenterAlert, SectionHeader, Table } from "../components"
import { fmtRWFExact } from "../data"
import { useTranslation } from "../lib/i18n"
import { useGlobalSearch } from "../lib/search"
import { getSaleReceipt, listSaleHistory, type ReceiptData, type SaleHistoryRow } from "../lib/sales"
import { ReceiptView } from "./SalesPage"

// Every completed sale is written atomically by complete_sale() — this page
// reads that same stored record back, so "stored receipt" means a real trip
// to the database, not anything cached from the moment of sale.
export default function TransactionsPage() {
  const { t } = useTranslation()
  const [rows, setRows] = useState<SaleHistoryRow[]>([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState("")
  const [receipt, setReceipt] = useState<ReceiptData | null>(null)
  const { term: globalTerm, setTerm: setGlobalTerm } = useGlobalSearch()
  const [query, setQuery] = useState(globalTerm)
  useEffect(() => setQuery(globalTerm), [globalTerm])
  const [dateFrom, setDateFrom] = useState("")
  const [dateTo, setDateTo] = useState("")

  useEffect(() => {
    setLoading(true)
    listSaleHistory()
      .then(setRows)
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

  const filtered = useMemo(() => {
    const needle = query.trim().toLowerCase()
    const from = dateFrom ? new Date(`${dateFrom}T00:00:00`).getTime() : null
    const to = dateTo ? new Date(`${dateTo}T23:59:59.999`).getTime() : null
    return rows.filter(r => {
      const matchesQuery = !needle || `${r.receiptNumber} ${r.cashierName} ${r.patientName ?? ""}`.toLowerCase().includes(needle)
      const soldAtMs = new Date(r.soldAt).getTime()
      const matchesFrom = from === null || soldAtMs >= from
      const matchesTo = to === null || soldAtMs <= to
      return matchesQuery && matchesFrom && matchesTo
    })
  }, [rows, query, dateFrom, dateTo])

  if (receipt) return <ReceiptView data={receipt} onClose={() => setReceipt(null)} closeLabel={t("transactions.backToTransactions")} />

  return (
    <div className="animate-fade-in">
      {error && <CenterAlert key={error} message={error} />}
      <SectionHeader title={t("page.transactions")} subtitle={t("transactions.subtitle")} />
      <div style={{ display: "flex", flexWrap: "wrap", alignItems: "flex-end", gap: 10, marginBottom: 14 }}>
        <input
          value={query} onChange={e => { setQuery(e.target.value); setGlobalTerm(e.target.value) }}
          placeholder={t("transactions.searchPlaceholder")}
          style={{ maxWidth: 360, flex: "1 1 260px", padding: "8px 12px", border: "1px solid var(--border)", borderRadius: 8, fontFamily: "inherit", fontSize: 12 }}
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
      </div>
      <div style={{ background: "#fff", border: "1px solid var(--border)", borderRadius: 12, overflow: "hidden" }}>
        {loading ? (
          <div style={{ padding: 40, textAlign: "center", color: "var(--ink-muted)", fontSize: 13 }}>{t("transactions.loading")}</div>
        ) : filtered.length === 0 ? (
          <div style={{ padding: 40, textAlign: "center", color: "var(--ink-muted)", fontSize: 13 }}>{rows.length === 0 ? t("transactions.empty") : t("transactions.emptyFiltered")}</div>
        ) : (
          <Table
            columns={[
              { key: "receipt", label: t("transactions.colReceipt") },
              { key: "when", label: t("transactions.colDate") },
              { key: "patient", label: t("transactions.colPatient") },
              { key: "items", label: t("transactions.colItems") },
              { key: "cashier", label: t("transactions.colCashier") },
              { key: "insurance", label: t("transactions.colInsurance") },
              { key: "total", label: t("transactions.colTotal") },
            ]}
            rows={filtered.map(r => ({
              receipt: <span style={{ fontFamily: 'var(--font-mono)', fontWeight: 600 }}>{r.receiptNumber}</span>,
              when: new Date(r.soldAt).toLocaleString(),
              patient: r.patientName ?? <span style={{ color: "var(--ink-faint)" }}>{t("transactions.noPatient")}</span>,
              items: r.itemCount,
              cashier: r.cashierName,
              insurance: r.insuranceProviderName ?? <span style={{ color: "var(--ink-faint)" }}>{t("transactions.selfPay")}</span>,
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
