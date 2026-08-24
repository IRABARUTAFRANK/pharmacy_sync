import { useCallback, useEffect, useMemo, useState } from "react"
import { Bar, BarChart, CartesianGrid, ResponsiveContainer, Tooltip, XAxis, YAxis } from "recharts"
import { Card, SectionHeader, StatusBadge, Btn, Modal, ChartTooltip } from "../components"
import { fmtRWFExact } from "../data"
import { loadInventoryDataset, upsertReorderPoint, type InventoryDataset, type InventoryRow } from "../lib/inventory"
import { errorMessage } from "../lib/supabase"

const statusMeta = {
  ok: { label: "In Stock", color: "#16a34a", background: "#d1fae5" },
  low: { label: "Low / Damaged", color: "#d97706", background: "#fef3c7" },
  zero: { label: "Out of Stock", color: "#dc2626", background: "#fef2f2" },
  expiry: { label: "Expiry Risk", color: "#9333ea", background: "#f5f3ff" },
}

function ReorderPointModal({ row, onClose, onSaved }: { row: InventoryRow; onClose: () => void; onSaved: () => void }) {
  const [minQuantity, setMinQuantity] = useState(String(row.min_quantity))
  const [maxQuantity, setMaxQuantity] = useState(row.max_quantity != null ? String(row.max_quantity) : "")
  const [error, setError] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)

  async function save() {
    const min = Number.parseInt(minQuantity, 10)
    if (!Number.isFinite(min) || min < 0) { setError("Enter a valid reorder minimum (0 or more)."); return }
    const max = maxQuantity.trim() ? Number.parseInt(maxQuantity, 10) : null
    if (max != null && (!Number.isFinite(max) || max < min)) { setError("Maximum must be at or above the minimum."); return }
    setBusy(true)
    setError(null)
    try {
      await upsertReorderPoint(row.product_id, row.branch_id, min, max)
      onSaved()
    } catch (reason) {
      setError(errorMessage(reason, "Could not save the reorder point."))
    } finally {
      setBusy(false)
    }
  }

  return <Modal title={`Reorder point — ${row.name}`} onClose={onClose} width={420}>
    <div style={{ display: "flex", flexDirection: "column", gap: 12 }}>
      <p style={{ margin: 0, fontSize: 11, color: "var(--ink-muted)" }}>
        When available stock for this product falls below the minimum, it's flagged "Low" on this dashboard.
      </p>
      {error && <p style={{ margin: 0, fontSize: 11, color: "#dc2626" }}>{error}</p>}
      <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 10 }}>
        <div>
          <label style={{ fontSize: 10, fontWeight: 600, color: "var(--ink-muted)", textTransform: "uppercase", letterSpacing: "0.05em", display: "block", marginBottom: 4 }}>Reorder minimum</label>
          <input type="number" min="0" value={minQuantity} onChange={e => setMinQuantity(e.target.value)}
            style={{ width: "100%", padding: "8px 10px", border: "1px solid var(--border)", borderRadius: 7, fontFamily: "inherit", fontSize: 12, boxSizing: "border-box" }} />
        </div>
        <div>
          <label style={{ fontSize: 10, fontWeight: 600, color: "var(--ink-muted)", textTransform: "uppercase", letterSpacing: "0.05em", display: "block", marginBottom: 4 }}>Maximum (optional)</label>
          <input type="number" min="0" value={maxQuantity} onChange={e => setMaxQuantity(e.target.value)}
            style={{ width: "100%", padding: "8px 10px", border: "1px solid var(--border)", borderRadius: 7, fontFamily: "inherit", fontSize: 12, boxSizing: "border-box" }} />
        </div>
      </div>
      <div style={{ display: "flex", justifyContent: "flex-end", gap: 8 }}>
        <Btn variant="ghost" onClick={onClose}>Cancel</Btn>
        <Btn variant="primary" onClick={() => void save()}>{busy ? "Saving…" : "Save reorder point"}</Btn>
      </div>
    </div>
  </Modal>
}

export default function LiveInventoryPage() {
  const [dataset, setDataset] = useState<InventoryDataset>({ rows: [], barcodes: [], supplierUnits: [] })
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const [query, setQuery] = useState("")
  const [status, setStatus] = useState<"all" | InventoryRow["stock_status"]>("all")
  const [reorderTarget, setReorderTarget] = useState<InventoryRow | null>(null)

  const refresh = useCallback(async () => {
    setLoading(true)
    setError(null)
    try {
      setDataset(await loadInventoryDataset())
    } catch (reason) {
      setError(errorMessage(reason, "Unable to load inventory from the database."))
    } finally {
      setLoading(false)
    }
  }, [])

  useEffect(() => { void refresh() }, [refresh])

  const filtered = useMemo(() => dataset.rows.filter(row => {
    const matchesStatus = status === "all" || row.stock_status === status
    const text = `${row.name} ${row.generic_name ?? ""} ${row.batch_number} ${row.supplier_name}`.toLowerCase()
    return matchesStatus && text.includes(query.toLowerCase())
  }), [dataset.rows, query, status])
  const summary = Object.fromEntries(Object.keys(statusMeta).map(key => [key, dataset.rows.filter(row => row.stock_status === key).length])) as Record<InventoryRow["stock_status"], number>
  const categoryData = Object.entries(dataset.rows.reduce<Record<string, number>>((totals, row) => ({ ...totals, [row.category]: (totals[row.category] ?? 0) + row.selling_price * row.quantity_available }), {})).map(([name, sales]) => ({ name, sales }))

  return <div style={{ display: 'flex', flexDirection: 'column', gap: 16 }}>
    {error && <div style={{ background: '#fef2f2', color: '#b91c1c', border: '1px solid #fecaca', borderRadius: 10, padding: '12px 14px', fontSize: 12 }}>
      Could not load inventory: {error}. Sign in with a provisioned pharmacy account and confirm its branch permissions, then try again.
    </div>}
    <div style={{ display: 'grid', gridTemplateColumns: 'repeat(4, 1fr)', gap: 10 }}>
      {(Object.entries(statusMeta) as Array<[InventoryRow["stock_status"], typeof statusMeta.ok]>).map(([key, meta]) => <button key={key} onClick={() => setStatus(status === key ? "all" : key)} style={{ textAlign: 'left', border: `1.5px solid ${status === key ? meta.color : "var(--border)"}`, background: status === key ? meta.background : "#fff", borderRadius: 10, padding: '12px 16px', cursor: 'pointer', fontFamily: 'inherit' }}>
        <div style={{ fontSize: 22, color: meta.color, fontWeight: 800 }}>{loading ? "—" : summary[key]}</div><div style={{ fontSize: 11, fontWeight: 600 }}>{meta.label}</div>
      </button>)}
    </div>
    <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 14 }}>
      <Card><SectionHeader title="Inventory Value by Category" subtitle="Calculated from live batches and available barcodes" /><ResponsiveContainer width="100%" height={200}><BarChart data={categoryData} margin={{ bottom: 28 }}><CartesianGrid strokeDasharray="4 4" /><XAxis dataKey="name" tick={{ fontSize: 10 }} interval={0} angle={-25} textAnchor="end" height={50} /><YAxis tick={{ fontSize: 10 }} /><Tooltip content={<ChartTooltip />} /><Bar dataKey="sales" name="Inventory value" fill="#1e8a4a" radius={[5, 5, 0, 0]} /></BarChart></ResponsiveContainer></Card>
      <Card><SectionHeader title="Units Received by Supplier" subtitle="Live stock-batch records" /><ResponsiveContainer width="100%" height={200}><BarChart data={dataset.supplierUnits} margin={{ bottom: 28 }}><CartesianGrid strokeDasharray="4 4" /><XAxis dataKey="name" tick={{ fontSize: 10 }} interval={0} angle={-25} textAnchor="end" height={50} /><YAxis tick={{ fontSize: 10 }} /><Tooltip content={<ChartTooltip />} /><Bar dataKey="units" name="Units received" fill="#34d399" radius={[5, 5, 0, 0]} /></BarChart></ResponsiveContainer></Card>
    </div>
    <Card>
      <div style={{ display: 'flex', gap: 8, alignItems: 'center', marginBottom: 14 }}><div style={{ flex: 1 }}><h2 style={{ margin: 0, fontSize: 14 }}>Stock Batches Inventory</h2><p style={{ margin: '3px 0 0', color: 'var(--ink-muted)', fontSize: 11 }}>Live data from Supabase — no demo records are used on this screen.</p></div><input value={query} onChange={event => setQuery(event.target.value)} placeholder="Search product, batch, supplier…" style={{ width: 240, padding: '7px 10px', border: '1px solid var(--border)', borderRadius: 7, fontFamily: 'inherit', fontSize: 12 }} /><Btn variant="secondary" small onClick={() => void refresh()}>Refresh</Btn></div>
      <div style={{ overflowX: 'auto' }}>
        <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 12 }}>
          <thead><tr style={{ borderBottom: '1px solid var(--border)' }}>{["Product", "Batch", "Expiry", "Supplier", "Available", "Cost price (buy)", "Sell price (sell)", "Tax", "Status", ""].map(label => <th key={label} style={{ textAlign: 'left', padding: '8px 10px', color: 'var(--ink-muted)', fontSize: 10 }}>{label}</th>)}</tr></thead>
          <tbody>
            {filtered.map(row => {
              const meta = statusMeta[row.stock_status]
              return <tr key={row.batch_id} style={{ borderBottom: '1px solid var(--bg-alt)' }}>
                <td style={{ padding: '10px', fontWeight: 600 }}>{row.name}<div style={{ color: 'var(--ink-muted)', fontWeight: 400, fontSize: 10 }}>{row.category}</div></td>
                <td style={{ padding: '10px', fontFamily: 'monospace' }}>{row.batch_number}</td>
                <td style={{ padding: '10px' }}>{row.expiry_date}</td>
                <td style={{ padding: '10px' }}>{row.supplier_name}</td>
                <td style={{ padding: '10px', fontWeight: 700 }}>{row.quantity_available}</td>
                <td style={{ padding: '10px', color: 'var(--ink-muted)' }}>{fmtRWFExact(row.cost_price)}</td>
                <td style={{ padding: '10px', fontWeight: 600 }}>{fmtRWFExact(row.selling_price)}</td>
                <td style={{ padding: '10px' }}>
                  <span title="Set by the super admin — not editable here." style={{ fontSize: 10, fontWeight: 700, padding: '2px 8px', borderRadius: 999, background: row.tax_rate === 'Exempt' ? '#dcfce7' : '#fef3c7', color: row.tax_rate === 'Exempt' ? '#16a34a' : '#b45309' }}>{row.tax_rate}</span>
                </td>
                <td style={{ padding: '10px' }}><StatusBadge label={meta.label} color={meta.color} bg={meta.background} /></td>
                <td style={{ padding: '10px' }}>
                  <button onClick={() => setReorderTarget(row)}
                    style={{ fontSize: 10, fontWeight: 700, color: 'var(--primary)', background: 'none', border: '1px solid var(--border)', borderRadius: 6, padding: '4px 8px', cursor: 'pointer', fontFamily: 'inherit', whiteSpace: 'nowrap' }}>
                    Reorder point
                  </button>
                </td>
              </tr>
            })}
            {!loading && filtered.length === 0 && <tr><td colSpan={10} style={{ padding: 28, textAlign: 'center', color: 'var(--ink-muted)' }}>No live stock batches are available for this account.</td></tr>}
          </tbody>
        </table>
      </div>
    </Card>
    {reorderTarget && (
      <ReorderPointModal row={reorderTarget} onClose={() => setReorderTarget(null)} onSaved={() => { setReorderTarget(null); void refresh() }} />
    )}
  </div>
}
