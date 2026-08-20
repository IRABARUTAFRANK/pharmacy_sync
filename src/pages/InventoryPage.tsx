import { useState, useMemo } from 'react'
import { BarChart, Bar, XAxis, YAxis, CartesianGrid, Tooltip, ResponsiveContainer, Cell } from 'recharts'
import {
  dbProducts, dbProductVariants, dbStockBatches, dbBarcodes, dbSuppliers,
  dbProductCategories, dbReorderPoints, dbTaxRates,
  inventoryItems, categoryData, fmtRWF,
} from '../data'
import { Card, SectionHeader, StatusBadge, Modal, Btn, ProgressBar, ChartTooltip, ColumnPicker } from '../components'

// ─── Enriched row (joins product + variant + batch + barcode + supplier) ───────

interface InventoryRow {
  product_id: string
  product_type: 'medicine' | 'supply' | 'other'
  name: string
  generic_name?: string
  tax_rate: string
  variant_id: string
  dosage?: string
  form?: string
  unit?: string
  category: string
  batch_id: string
  batch_number: string
  expiry_date: string
  cost_price: number
  selling_price: number
  quantity_received: number
  received_at: string
  manufacturer_name?: string
  delivery_code?: string
  supplier_name: string
  quantity_available: number
  barcode_status: string
  min_quantity: number
  max_quantity?: number
  stock_status: 'ok' | 'low' | 'zero' | 'expiry'
}

function buildRows(): InventoryRow[] {
  return dbStockBatches.map(batch => {
    const variant  = dbProductVariants.find(v => v.id === batch.product_variant_id)
    const product  = variant ? dbProducts.find(p => p.id === variant.product_id) : undefined
    const supplier = batch.supplier_id ? dbSuppliers.find(s => s.id === batch.supplier_id) : undefined
    const taxRate  = product ? dbTaxRates.find(t => t.id === product.tax_rate_id) : undefined
    const reorder  = product ? dbReorderPoints.find(r => r.product_id === product.id && r.branch_id === batch.branch_id) : undefined
    const barcodes = dbBarcodes.filter(b => b.stock_batch_id === batch.id)
    const boxBarcode = barcodes.find(b => b.barcode_type === 'box') ?? barcodes[0]
    const qtyAvail = barcodes.reduce((s, b) => s + b.quantity_available, 0)
    const bcStatus = boxBarcode?.status ?? 'active'
    const legacyItem = inventoryItems.find(i => i.batch === batch.batch_number)
    const category = legacyItem?.category ?? 'Other'
    const minQ = reorder?.min_quantity ?? 100
    const expiryDate = new Date(batch.expiry_date)
    const today = new Date('2026-08-20')
    const daysToExpiry = Math.round((expiryDate.getTime() - today.getTime()) / 86400000)
    let stock_status: InventoryRow['stock_status'] = 'ok'
    if (qtyAvail === 0 || bcStatus === 'sold_out')              stock_status = 'zero'
    else if (daysToExpiry < 60 || bcStatus === 'expired')       stock_status = 'expiry'
    else if (qtyAvail < minQ || bcStatus === 'recalled' || bcStatus === 'damaged') stock_status = 'low'
    return {
      product_id: product?.id ?? '', product_type: product?.product_type ?? 'medicine',
      name: product ? `${product.name}${variant?.dosage ? ' ' + variant.dosage : ''}` : 'Unknown',
      generic_name: product?.generic_name, tax_rate: taxRate ? (taxRate.rate_percentage === 0 ? 'Exempt' : `${taxRate.rate_percentage}%`) : '—',
      variant_id: variant?.id ?? '', dosage: variant?.dosage, form: variant?.form, unit: variant?.unit,
      category, batch_id: batch.id, batch_number: batch.batch_number, expiry_date: batch.expiry_date,
      cost_price: batch.cost_price, selling_price: batch.selling_price, quantity_received: batch.quantity_received,
      received_at: batch.received_at, manufacturer_name: batch.manufacturer_name, delivery_code: batch.delivery_code,
      supplier_name: supplier?.supplier_name ?? '—', quantity_available: qtyAvail, barcode_status: bcStatus,
      min_quantity: minQ, max_quantity: reorder?.max_quantity, stock_status,
    }
  })
}

const ALL_ROWS = buildRows()

type ColKey =
  | 'product_type' | 'generic_name' | 'dosage' | 'form' | 'unit'
  | 'category' | 'batch_number' | 'delivery_code' | 'expiry_date'
  | 'cost_price' | 'selling_price' | 'quantity_received' | 'quantity_available'
  | 'min_quantity' | 'max_quantity' | 'manufacturer_name' | 'supplier_name'
  | 'tax_rate' | 'received_at' | 'status'

const COLUMN_DEFS: { key: ColKey; label: string }[] = [
  { key: 'product_type',      label: 'Product Type' },
  { key: 'generic_name',      label: 'Generic Name' },
  { key: 'dosage',            label: 'Dosage' },
  { key: 'form',              label: 'Form' },
  { key: 'unit',              label: 'Unit' },
  { key: 'category',          label: 'Category' },
  { key: 'batch_number',      label: 'Batch Number' },
  { key: 'delivery_code',     label: 'Delivery Code' },
  { key: 'expiry_date',       label: 'Expiry Date' },
  { key: 'cost_price',        label: 'Cost Price' },
  { key: 'selling_price',     label: 'Selling Price' },
  { key: 'quantity_received', label: 'Qty Received' },
  { key: 'quantity_available',label: 'Qty Available' },
  { key: 'min_quantity',      label: 'Reorder Min' },
  { key: 'max_quantity',      label: 'Reorder Max' },
  { key: 'manufacturer_name', label: 'Manufacturer' },
  { key: 'supplier_name',     label: 'Supplier' },
  { key: 'tax_rate',          label: 'Tax Rate' },
  { key: 'received_at',       label: 'Received At' },
  { key: 'status',            label: 'Status' },
]

const DEFAULT_VISIBLE = new Set<ColKey>([
  'product_type', 'dosage', 'form', 'category', 'batch_number',
  'expiry_date', 'selling_price', 'quantity_available', 'min_quantity',
  'supplier_name', 'status',
])

const statusColors: Record<string, { c: string; bg: string; label: string }> = {
  ok:     { c: '#16a34a', bg: '#d1fae5', label: 'In Stock' },
  low:    { c: '#d97706', bg: '#fef3c7', label: 'Low / Damaged' },
  zero:   { c: '#dc2626', bg: '#fef2f2', label: 'Out of Stock' },
  expiry: { c: '#9333ea', bg: '#f5f3ff', label: 'Expiry Risk' },
}

const barcodeStatusColors: Record<string, { c: string; bg: string }> = {
  active:   { c: '#16a34a', bg: '#d1fae5' },
  sold_out: { c: '#dc2626', bg: '#fef2f2' },
  expired:  { c: '#9333ea', bg: '#f5f3ff' },
  recalled: { c: '#dc2626', bg: '#fef2f2' },
  damaged:  { c: '#d97706', bg: '#fef3c7' },
}

// ─── Row Detail Modal ─────────────────────────────────────────────────────────

function RowDetailModal({ row, onClose }: { row: InventoryRow; onClose: () => void }) {
  const barcodes = dbBarcodes.filter(b => b.stock_batch_id === row.batch_id)
  const sc = statusColors[row.stock_status]
  const margin = row.selling_price > 0 ? ((row.selling_price - row.cost_price) / row.selling_price * 100).toFixed(1) : '0'
  return (
    <Modal title={`${row.name} — Batch ${row.batch_number}`} onClose={onClose} width={640}>
      <div style={{ display: 'flex', flexDirection: 'column', gap: 14 }}>
        <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr 1fr', gap: 8 }}>
          {[
            ['Product ID',    row.product_id],       ['Generic Name',  row.generic_name ?? '—'],
            ['Product Type',  row.product_type],     ['Dosage',        row.dosage ?? '—'],
            ['Form',          row.form ?? '—'],      ['Unit',          row.unit ?? '—'],
            ['Category',      row.category],         ['Tax Rate',      row.tax_rate],
            ['Batch Number',  row.batch_number],     ['Expiry Date',   row.expiry_date],
            ['Delivery Code', row.delivery_code ?? '—'], ['Received At', row.received_at],
            ['Manufacturer',  row.manufacturer_name ?? '—'], ['Supplier', row.supplier_name],
            ['Qty Received',  row.quantity_received.toString()],
          ].map(([l, v]) => (
            <div key={l} style={{ background: 'var(--bg)', borderRadius: 7, padding: '9px 10px' }}>
              <div style={{ fontSize: 9, fontWeight: 600, color: 'var(--ink-muted)', textTransform: 'uppercase', letterSpacing: '0.05em', marginBottom: 2 }}>{l}</div>
              <div style={{ fontSize: 12, fontWeight: 600, color: 'var(--ink)', wordBreak: 'break-word' }}>{v}</div>
            </div>
          ))}
        </div>
        <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr 1fr 1fr', gap: 8 }}>
          {[
            { label: 'Cost Price',       value: fmtRWF(row.cost_price),    color: '#dc2626' },
            { label: 'Selling Price',    value: fmtRWF(row.selling_price), color: '#16a34a' },
            { label: 'Gross Margin',     value: `${margin}%`,              color: '#0284c7' },
            { label: 'Reorder Min/Max',  value: `${row.min_quantity}${row.max_quantity ? ' / ' + row.max_quantity : ''}`, color: '#d97706' },
          ].map(k => (
            <div key={k.label} style={{ background: 'var(--bg)', borderRadius: 7, padding: '10px 12px', textAlign: 'center' }}>
              <div style={{ fontSize: 16, fontWeight: 800, color: k.color, fontFamily: 'DM Sans' }}>{k.value}</div>
              <div style={{ fontSize: 10, color: 'var(--ink-muted)', fontWeight: 500, marginTop: 2 }}>{k.label}</div>
            </div>
          ))}
        </div>
        <div>
          <div style={{ display: 'flex', justifyContent: 'space-between', fontSize: 12, marginBottom: 6 }}>
            <span style={{ fontWeight: 600, color: 'var(--ink)' }}>Stock Availability</span>
            <StatusBadge label={sc.label} color={sc.c} bg={sc.bg} />
          </div>
          <ProgressBar value={row.quantity_available} max={row.quantity_received} height={8} />
          <div style={{ display: 'flex', justifyContent: 'space-between', fontSize: 10, color: 'var(--ink-muted)', marginTop: 4 }}>
            <span>{row.quantity_available} of {row.quantity_received} units available</span>
            <span>Reorder point: {row.min_quantity} units</span>
          </div>
        </div>
        <div>
          <div style={{ fontSize: 12, fontWeight: 600, color: 'var(--ink)', marginBottom: 8 }}>Barcodes — {barcodes.length} record{barcodes.length !== 1 ? 's' : ''}</div>
          {barcodes.map(bc => {
            const bsc = barcodeStatusColors[bc.status] ?? barcodeStatusColors.active
            return (
              <div key={bc.id} style={{ display: 'flex', gap: 10, alignItems: 'center', padding: '8px 10px', borderRadius: 7, background: 'var(--bg)', marginBottom: 6, fontSize: 12 }}>
                <span style={{ fontFamily: 'JetBrains Mono, monospace', fontSize: 10, fontWeight: 700, color: 'var(--primary)', flex: 1 }}>{bc.code}</span>
                <span style={{ fontSize: 10, color: 'var(--ink-muted)' }}>{bc.barcode_type === 'box' ? `Box · ${bc.child_count} packs` : `Pack · ${bc.pieces_per_pack ?? 1} pcs`}</span>
                <span style={{ fontSize: 10, color: 'var(--ink-muted)', textTransform: 'capitalize' }}>{bc.code_source}</span>
                <StatusBadge label={bc.status} color={bsc.c} bg={bsc.bg} />
                <span style={{ fontSize: 11, fontWeight: 700 }}>{bc.quantity_available} avail.</span>
              </div>
            )
          })}
        </div>
        <div style={{ display: 'flex', gap: 8, justifyContent: 'flex-end' }}>
          <Btn variant="ghost" small onClick={onClose}>Stock Adjustment</Btn>
          <Btn variant="secondary" small onClick={onClose}>Edit Batch</Btn>
          <Btn variant="primary" small onClick={onClose}>Print Labels</Btn>
        </div>
      </div>
    </Modal>
  )
}

// ─── Add Batch Modal ──────────────────────────────────────────────────────────

function AddBatchModal({ onClose }: { onClose: () => void }) {
  const [form, setForm] = useState({ product_id: 'P001', variant_id: 'PV-001', supplier_id: 'SUP-001', batch_number: '', expiry_date: '', cost_price: '', selling_price: '', quantity_received: '', manufacturer_name: '', delivery_code: '' })
  const set = (k: string) => (e: any) => setForm(f => ({ ...f, [k]: e.target.value }))
  const inputStyle = { width: '100%', padding: '8px 10px', border: '1px solid var(--border)', borderRadius: 7, fontSize: 12, fontFamily: 'inherit', outline: 'none', boxSizing: 'border-box' as const }
  return (
    <Modal title="Log New Stock Batch" onClose={onClose} width={640}>
      <div style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
        <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 10 }}>
          {([
            ['Product', 'product_id', 'select', dbProducts.map(p => ({ value: p.id, label: `${p.name} (${p.product_type})` }))],
            ['Variant (Dosage/Form)', 'variant_id', 'select', dbProductVariants.map(v => ({ value: v.id, label: `${v.dosage ?? ''} ${v.form ?? ''}`.trim() }))],
            ['Supplier', 'supplier_id', 'select', dbSuppliers.map(s => ({ value: s.id, label: s.supplier_name }))],
          ] as any[]).map(([label, key, , opts]: any) => (
            <div key={key}>
              <label style={{ fontSize: 10, fontWeight: 600, color: 'var(--ink-muted)', textTransform: 'uppercase', letterSpacing: '0.05em', display: 'block', marginBottom: 4 }}>{label}</label>
              <select value={(form as any)[key]} onChange={set(key)} style={{ ...inputStyle, cursor: 'pointer' }}>
                {opts.map((o: any) => <option key={o.value} value={o.value}>{o.label}</option>)}
              </select>
            </div>
          ))}
          {([
            ['Batch Number *',       'batch_number',      'text',   'e.g. BT-2026-441'],
            ['Manufacturer',         'manufacturer_name', 'text',   'e.g. GSK Rwanda'],
            ['Delivery Code',        'delivery_code',     'text',   'e.g. DEL-2026-0050'],
            ['Expiry Date *',        'expiry_date',       'date',   ''],
            ['Cost Price (RWF) *',   'cost_price',        'number', ''],
            ['Selling Price (RWF) *','selling_price',     'number', ''],
            ['Qty Received *',       'quantity_received', 'number', ''],
          ] as [string, string, string, string][]).map(([label, key, type, ph]) => (
            <div key={key}>
              <label style={{ fontSize: 10, fontWeight: 600, color: 'var(--ink-muted)', textTransform: 'uppercase', letterSpacing: '0.05em', display: 'block', marginBottom: 4 }}>{label}</label>
              <input type={type} value={(form as any)[key]} onChange={set(key)} placeholder={ph} style={inputStyle}
                onFocus={e => e.target.style.borderColor = 'var(--primary)'}
                onBlur={e => e.target.style.borderColor = 'var(--border)'}
              />
            </div>
          ))}
        </div>
        <div style={{ background: 'var(--bg)', borderRadius: 8, padding: '10px 12px', fontSize: 11, color: 'var(--ink-muted)' }}>
          After logging, go to <strong>Barcode Manager</strong> to generate box/pack barcodes for this batch.
        </div>
        <div style={{ display: 'flex', gap: 8, justifyContent: 'flex-end' }}>
          <Btn variant="ghost" onClick={onClose}>Cancel</Btn>
          <Btn variant="primary" onClick={onClose}>Log Stock Batch →</Btn>
        </div>
      </div>
    </Modal>
  )
}

// ─── Inventory Page ───────────────────────────────────────────────────────────

export default function InventoryPage() {
  const [selectedRow, setSelectedRow] = useState<InventoryRow | null>(null)
  const [showAdd, setShowAdd]         = useState(false)
  const [sortKey, setSortKey]         = useState<keyof InventoryRow>('name')
  const [sortAsc, setSortAsc]         = useState(true)
  const [statusFilter, setStatusFilter]   = useState<string>('all')
  const [typeFilter, setTypeFilter]       = useState<string>('all')
  const [categoryFilter, setCategoryFilter] = useState<string>('all')
  const [search, setSearch]           = useState('')
  const [visibleCols, setVisibleCols] = useState<Set<ColKey>>(new Set(DEFAULT_VISIBLE))

  const toggleCol = (key: ColKey) =>
    setVisibleCols(prev => { const next = new Set(prev); next.has(key) ? next.delete(key) : next.add(key); return next })

  const categories = Array.from(new Set(ALL_ROWS.map(r => r.category)))

  const filtered = useMemo(() => {
    let rows = ALL_ROWS
    if (statusFilter !== 'all')   rows = rows.filter(r => r.stock_status === statusFilter)
    if (typeFilter !== 'all')     rows = rows.filter(r => r.product_type === typeFilter)
    if (categoryFilter !== 'all') rows = rows.filter(r => r.category === categoryFilter)
    if (search) {
      const q = search.toLowerCase()
      rows = rows.filter(r => r.name.toLowerCase().includes(q) || (r.generic_name ?? '').toLowerCase().includes(q) || r.batch_number.toLowerCase().includes(q) || r.supplier_name.toLowerCase().includes(q) || (r.delivery_code ?? '').toLowerCase().includes(q))
    }
    return [...rows].sort((a, b) => {
      const av = a[sortKey], bv = b[sortKey]
      if (typeof av === 'number' && typeof bv === 'number') return sortAsc ? av - bv : bv - av
      return sortAsc ? String(av).localeCompare(String(bv)) : String(bv).localeCompare(String(av))
    })
  }, [statusFilter, typeFilter, categoryFilter, search, sortKey, sortAsc])

  const toggleSort = (key: keyof InventoryRow) => {
    if (sortKey === key) setSortAsc(a => !a); else { setSortKey(key); setSortAsc(true) }
  }

  const thStyle = (key: keyof InventoryRow): React.CSSProperties => ({
    textAlign: 'left', padding: '7px 10px', fontSize: 10, fontWeight: 600,
    color: 'var(--ink-muted)', cursor: 'pointer', whiteSpace: 'nowrap',
    textTransform: 'uppercase', letterSpacing: '0.04em', userSelect: 'none',
  })
  const SI = ({ col }: { col: keyof InventoryRow }) => sortKey === col ? <span>{sortAsc ? ' ▲' : ' ▼'}</span> : null

  const summary = { ok: ALL_ROWS.filter(r => r.stock_status === 'ok').length, low: ALL_ROWS.filter(r => r.stock_status === 'low').length, zero: ALL_ROWS.filter(r => r.stock_status === 'zero').length, expiry: ALL_ROWS.filter(r => r.stock_status === 'expiry').length }

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 16 }}>

      {/* Status KPI chips */}
      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(4, 1fr)', gap: 10 }}>
        {([ ['ok','ok'],['low','low'],['zero','zero'],['expiry','expiry'] ] as [keyof typeof summary, string][]).map(([k, f]) => {
          const s = statusColors[k]; const count = summary[k]
          return (
            <div key={k} onClick={() => setStatusFilter(statusFilter === f ? 'all' : f)}
              style={{ background: statusFilter === f ? s.bg : '#fff', border: `1.5px solid ${statusFilter === f ? s.c + '60' : 'var(--border)'}`, borderRadius: 10, padding: '12px 16px', cursor: 'pointer', display: 'flex', alignItems: 'center', gap: 10, transition: 'all 0.15s' }}>
              <div style={{ fontSize: 22, fontWeight: 800, color: s.c, fontFamily: 'DM Sans' }}>{count}</div>
              <div style={{ fontSize: 11, fontWeight: 600, color: 'var(--ink)' }}>{s.label}</div>
            </div>
          )
        })}
      </div>

      {/* Charts */}
      <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 14 }}>
        <Card>
          <SectionHeader title="Revenue by Category" subtitle="This branch — product_categories" />
          <ResponsiveContainer width="100%" height={180}>
            <BarChart data={categoryData} layout="vertical" margin={{ left: 0, right: 8 }}>
              <CartesianGrid strokeDasharray="4 4" stroke="#f0f0f0" horizontal={false} />
              <XAxis type="number" tick={{ fontSize: 10 }} axisLine={false} tickLine={false} tickFormatter={v => `${(v / 1000000).toFixed(1)}M`} />
              <YAxis type="category" dataKey="name" tick={{ fontSize: 10 }} axisLine={false} tickLine={false} width={90} />
              <Tooltip content={<ChartTooltip />} />
              <Bar dataKey="sales" name="Revenue" radius={[0, 5, 5, 0]} barSize={12}>
                {categoryData.map((_, i) => <Cell key={i} fill={['#1e8a4a', '#34d399', '#059669', '#a7f3d0', '#6ee7b7', '#86efac', '#d1fae5'][i % 7]} />)}
              </Bar>
            </BarChart>
          </ResponsiveContainer>
        </Card>
        <Card>
          <SectionHeader title="Units by Supplier" subtitle="stock_batches.quantity_received grouped by supplier_id" />
          <ResponsiveContainer width="100%" height={180}>
            <BarChart
              data={dbSuppliers.map(s => ({ name: s.supplier_name.split(' ')[0], units: dbStockBatches.filter(b => b.supplier_id === s.id).reduce((sum, b) => sum + b.quantity_received, 0) })).filter(s => s.units > 0)}
              margin={{ top: 4, right: 4, bottom: 0, left: 0 }}
            >
              <CartesianGrid stroke="#f0f0f0" strokeDasharray="4 4" />
              <XAxis dataKey="name" tick={{ fontSize: 10 }} axisLine={false} tickLine={false} />
              <YAxis tick={{ fontSize: 10 }} axisLine={false} tickLine={false} />
              <Tooltip content={<ChartTooltip />} />
              <Bar dataKey="units" name="Units Received" fill="#1e8a4a" radius={[5, 5, 0, 0]} barSize={22} />
            </BarChart>
          </ResponsiveContainer>
        </Card>
      </div>

      {/* Main Table */}
      <Card>
        <div style={{ display: 'flex', gap: 8, marginBottom: 14, flexWrap: 'wrap', alignItems: 'center' }}>
          <h2 style={{ margin: 0, fontSize: 14, fontWeight: 600, color: 'var(--ink)', flex: 1 }}>Stock Batches Inventory</h2>
          <div style={{ position: 'relative', width: 220 }}>
            <span style={{ position: 'absolute', left: 8, top: '50%', transform: 'translateY(-50%)', fontSize: 11, color: 'var(--ink-faint)' }}>🔍</span>
            <input value={search} onChange={e => setSearch(e.target.value)} placeholder="Name, batch, supplier, delivery…"
              style={{ width: '100%', padding: '6px 8px 6px 24px', border: '1px solid var(--border)', borderRadius: 7, fontSize: 11, fontFamily: 'inherit', outline: 'none', background: 'var(--bg)', boxSizing: 'border-box' as const }}
              onFocus={e => e.target.style.borderColor = 'var(--primary)'}
              onBlur={e => e.target.style.borderColor = 'var(--border)'}
            />
          </div>
          {[
            { value: typeFilter, set: setTypeFilter, opts: [['all','All Types'],['medicine','Medicine'],['supply','Supply'],['other','Other']] },
            { value: categoryFilter, set: setCategoryFilter, opts: [['all','All Categories'], ...categories.map(c => [c, c])] },
          ].map((f, fi) => (
            <select key={fi} value={f.value} onChange={e => f.set(e.target.value)}
              style={{ padding: '6px 8px', border: '1px solid var(--border)', borderRadius: 7, fontSize: 11, fontFamily: 'inherit', background: 'var(--bg)', cursor: 'pointer', outline: 'none' }}>
              {f.opts.map(([v, l]) => <option key={v} value={v}>{l}</option>)}
            </select>
          ))}
          <ColumnPicker columns={COLUMN_DEFS} visible={visibleCols} onToggle={toggleCol} />
          <Btn variant="primary" small onClick={() => setShowAdd(true)}>+ Log Batch</Btn>
        </div>

        <div style={{ overflowX: 'auto' }}>
          <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 12 }}>
            <thead>
              <tr style={{ borderBottom: '1px solid var(--border)' }}>
                <th onClick={() => toggleSort('name')} style={thStyle('name')}>Product Name <SI col="name" /></th>
                {visibleCols.has('product_type')       && <th onClick={() => toggleSort('product_type')} style={thStyle('product_type')}>Type <SI col="product_type" /></th>}
                {visibleCols.has('generic_name')       && <th style={thStyle('name')}>Generic Name</th>}
                {visibleCols.has('dosage')             && <th style={thStyle('name')}>Dosage</th>}
                {visibleCols.has('form')               && <th style={thStyle('name')}>Form</th>}
                {visibleCols.has('unit')               && <th style={thStyle('name')}>Unit</th>}
                {visibleCols.has('category')           && <th onClick={() => toggleSort('category')} style={thStyle('category')}>Category <SI col="category" /></th>}
                {visibleCols.has('batch_number')       && <th onClick={() => toggleSort('batch_number')} style={thStyle('batch_number')}>Batch No. <SI col="batch_number" /></th>}
                {visibleCols.has('delivery_code')      && <th style={thStyle('name')}>Delivery Code</th>}
                {visibleCols.has('expiry_date')        && <th onClick={() => toggleSort('expiry_date')} style={thStyle('expiry_date')}>Expiry Date <SI col="expiry_date" /></th>}
                {visibleCols.has('cost_price')         && <th onClick={() => toggleSort('cost_price')} style={thStyle('cost_price')}>Cost Price <SI col="cost_price" /></th>}
                {visibleCols.has('selling_price')      && <th onClick={() => toggleSort('selling_price')} style={thStyle('selling_price')}>Selling Price <SI col="selling_price" /></th>}
                {visibleCols.has('quantity_received')  && <th onClick={() => toggleSort('quantity_received')} style={thStyle('quantity_received')}>Qty Recv. <SI col="quantity_received" /></th>}
                {visibleCols.has('quantity_available') && <th onClick={() => toggleSort('quantity_available')} style={thStyle('quantity_available')}>Qty Avail. <SI col="quantity_available" /></th>}
                {visibleCols.has('min_quantity')       && <th onClick={() => toggleSort('min_quantity')} style={thStyle('min_quantity')}>Reorder Min <SI col="min_quantity" /></th>}
                {visibleCols.has('max_quantity')       && <th style={thStyle('name')}>Reorder Max</th>}
                {visibleCols.has('manufacturer_name')  && <th style={thStyle('name')}>Manufacturer</th>}
                {visibleCols.has('supplier_name')      && <th onClick={() => toggleSort('supplier_name')} style={thStyle('supplier_name')}>Supplier <SI col="supplier_name" /></th>}
                {visibleCols.has('tax_rate')           && <th style={thStyle('name')}>Tax Rate</th>}
                {visibleCols.has('received_at')        && <th style={thStyle('name')}>Received At</th>}
                {visibleCols.has('status')             && <th style={thStyle('name')}>Status</th>}
                <th style={thStyle('name')}></th>
              </tr>
            </thead>
            <tbody>
              {filtered.map((row, i) => {
                const sc  = statusColors[row.stock_status]
                const bsc = barcodeStatusColors[row.barcode_status] ?? barcodeStatusColors.active
                return (
                  <tr key={i} style={{ borderBottom: '1px solid var(--bg-alt)', cursor: 'pointer', transition: 'background 0.12s' }}
                    onMouseEnter={e => (e.currentTarget.style.background = 'var(--bg)')}
                    onMouseLeave={e => (e.currentTarget.style.background = 'transparent')}
                    onClick={() => setSelectedRow(row)}
                  >
                    <td style={{ padding: '9px 10px', fontWeight: 600, color: 'var(--ink)', whiteSpace: 'nowrap' }}>{row.name}</td>
                    {visibleCols.has('product_type')       && <td style={{ padding: '9px 10px' }}><StatusBadge label={row.product_type} color={row.product_type === 'medicine' ? '#0284c7' : '#7c3aed'} bg={row.product_type === 'medicine' ? '#e0f2fe' : '#f5f3ff'} /></td>}
                    {visibleCols.has('generic_name')       && <td style={{ padding: '9px 10px', color: 'var(--ink-muted)', fontSize: 11 }}>{row.generic_name ?? '—'}</td>}
                    {visibleCols.has('dosage')             && <td style={{ padding: '9px 10px', fontFamily: 'JetBrains Mono, monospace', fontSize: 11 }}>{row.dosage ?? '—'}</td>}
                    {visibleCols.has('form')               && <td style={{ padding: '9px 10px', color: 'var(--ink-mid)' }}>{row.form ?? '—'}</td>}
                    {visibleCols.has('unit')               && <td style={{ padding: '9px 10px', color: 'var(--ink-muted)', fontSize: 11 }}>{row.unit ?? '—'}</td>}
                    {visibleCols.has('category')           && <td style={{ padding: '9px 10px' }}><StatusBadge label={row.category} color="var(--primary)" bg="var(--primary-light)" /></td>}
                    {visibleCols.has('batch_number')       && <td style={{ padding: '9px 10px', fontFamily: 'JetBrains Mono, monospace', fontSize: 10, color: 'var(--ink-mid)', whiteSpace: 'nowrap' }}>{row.batch_number}</td>}
                    {visibleCols.has('delivery_code')      && <td style={{ padding: '9px 10px', fontFamily: 'JetBrains Mono, monospace', fontSize: 10, color: 'var(--ink-faint)' }}>{row.delivery_code ?? '—'}</td>}
                    {visibleCols.has('expiry_date')        && <td style={{ padding: '9px 10px', fontSize: 11, color: row.stock_status === 'expiry' ? '#9333ea' : 'var(--ink-mid)', fontWeight: row.stock_status === 'expiry' ? 700 : 400 }}>{row.expiry_date}</td>}
                    {visibleCols.has('cost_price')         && <td style={{ padding: '9px 10px', color: '#dc2626', fontWeight: 600 }}>{fmtRWF(row.cost_price)}</td>}
                    {visibleCols.has('selling_price')      && <td style={{ padding: '9px 10px', fontWeight: 700 }}>{fmtRWF(row.selling_price)}</td>}
                    {visibleCols.has('quantity_received')  && <td style={{ padding: '9px 10px', fontFamily: 'JetBrains Mono, monospace', textAlign: 'right' }}>{row.quantity_received}</td>}
                    {visibleCols.has('quantity_available') && <td style={{ padding: '9px 10px', fontFamily: 'JetBrains Mono, monospace', textAlign: 'right', fontWeight: 700, color: row.quantity_available === 0 ? '#dc2626' : row.quantity_available < row.min_quantity ? '#d97706' : 'var(--ink)' }}>{row.quantity_available}</td>}
                    {visibleCols.has('min_quantity')       && <td style={{ padding: '9px 10px', fontFamily: 'JetBrains Mono, monospace', fontSize: 11, textAlign: 'right' }}>{row.min_quantity}</td>}
                    {visibleCols.has('max_quantity')       && <td style={{ padding: '9px 10px', fontFamily: 'JetBrains Mono, monospace', fontSize: 11, textAlign: 'right' }}>{row.max_quantity ?? '—'}</td>}
                    {visibleCols.has('manufacturer_name')  && <td style={{ padding: '9px 10px', fontSize: 11, color: 'var(--ink-muted)', whiteSpace: 'nowrap' }}>{row.manufacturer_name ?? '—'}</td>}
                    {visibleCols.has('supplier_name')      && <td style={{ padding: '9px 10px', fontSize: 11, color: 'var(--ink-mid)', whiteSpace: 'nowrap' }}>{row.supplier_name}</td>}
                    {visibleCols.has('tax_rate')           && <td style={{ padding: '9px 10px', fontSize: 11, fontFamily: 'JetBrains Mono, monospace' }}>{row.tax_rate}</td>}
                    {visibleCols.has('received_at')        && <td style={{ padding: '9px 10px', fontSize: 11, color: 'var(--ink-faint)', whiteSpace: 'nowrap' }}>{row.received_at}</td>}
                    {visibleCols.has('status')             && <td style={{ padding: '9px 10px' }}>
                      <div style={{ display: 'flex', gap: 4, flexWrap: 'wrap' }}>
                        <StatusBadge label={sc.label} color={sc.c} bg={sc.bg} />
                        {row.barcode_status !== 'active' && <StatusBadge label={row.barcode_status} color={bsc.c} bg={bsc.bg} />}
                      </div>
                    </td>}
                    <td style={{ padding: '9px 10px' }}>
                      <button onClick={e => { e.stopPropagation(); setSelectedRow(row) }}
                        style={{ fontSize: 11, color: 'var(--primary)', background: 'none', border: 'none', cursor: 'pointer', fontWeight: 600, fontFamily: 'inherit', whiteSpace: 'nowrap' }}>Details →</button>
                    </td>
                  </tr>
                )
              })}
              {filtered.length === 0 && (
                <tr><td colSpan={30} style={{ padding: '28px', textAlign: 'center', color: 'var(--ink-muted)', fontSize: 13 }}>No stock batches match the current filters.</td></tr>
              )}
            </tbody>
          </table>
        </div>
        <div style={{ marginTop: 10, fontSize: 11, color: 'var(--ink-faint)' }}>
          {filtered.length} batch{filtered.length !== 1 ? 'es' : ''} · {ALL_ROWS.length} total · {visibleCols.size} of {COLUMN_DEFS.length} columns visible
        </div>
      </Card>

      {selectedRow && <RowDetailModal row={selectedRow} onClose={() => setSelectedRow(null)} />}
      {showAdd     && <AddBatchModal  onClose={() => setShowAdd(false)} />}
    </div>
  )
}
