import { useEffect, useState } from "react"
import { CenterAlert, SectionHeader, Table } from "../components"
import { fmtRWFExact } from "../data"
import { getSaleReceipt, listSaleHistory, type ReceiptData, type SaleHistoryRow } from "../lib/sales"
import { ReceiptView } from "./SalesPage"

// Every completed sale is written atomically by complete_sale() — this page
// reads that same stored record back, so "stored receipt" means a real trip
// to the database, not anything cached from the moment of sale.
export default function TransactionsPage() {
  const [rows, setRows] = useState<SaleHistoryRow[]>([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState("")
  const [receipt, setReceipt] = useState<ReceiptData | null>(null)

  useEffect(() => {
    setLoading(true)
    listSaleHistory()
      .then(setRows)
      .catch(reason => setError(reason instanceof Error ? reason.message : "Could not load sales history."))
      .finally(() => setLoading(false))
  }, [])

  async function openReceipt(saleId: string) {
    setError("")
    try {
      setReceipt(await getSaleReceipt(saleId))
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : "Could not load this receipt.")
    }
  }

  if (receipt) return <ReceiptView data={receipt} onClose={() => setReceipt(null)} closeLabel="Back to Transactions" />

  return (
    <div>
      {error && <CenterAlert key={error} message={error} />}
      <SectionHeader title="Transactions" subtitle="Every completed sale, with the full list of products sold and its stored, reprintable receipt." />
      <div style={{ background: "#fff", border: "1px solid var(--border)", borderRadius: 12, overflow: "hidden" }}>
        {loading ? (
          <div style={{ padding: 40, textAlign: "center", color: "var(--ink-muted)", fontSize: 13 }}>Loading…</div>
        ) : rows.length === 0 ? (
          <div style={{ padding: 40, textAlign: "center", color: "var(--ink-muted)", fontSize: 13 }}>No sales recorded yet.</div>
        ) : (
          <Table
            columns={[
              { key: "receipt", label: "Receipt" },
              { key: "when", label: "Date" },
              { key: "items", label: "Items" },
              { key: "cashier", label: "Cashier" },
              { key: "insurance", label: "Insurance" },
              { key: "total", label: "Total" },
            ]}
            rows={rows.map(r => ({
              receipt: <span style={{ fontFamily: 'var(--font-mono)', fontWeight: 600 }}>{r.receiptNumber}</span>,
              when: new Date(r.soldAt).toLocaleString(),
              items: r.itemCount,
              cashier: r.cashierName,
              insurance: r.insuranceProviderName ?? <span style={{ color: "var(--ink-faint)" }}>Self-pay</span>,
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
