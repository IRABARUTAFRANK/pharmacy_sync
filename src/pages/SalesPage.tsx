import { useState } from 'react'
import {
  AreaChart, Area, BarChart, Bar, XAxis, YAxis, CartesianGrid,
  Tooltip, Legend, ResponsiveContainer,
} from 'recharts'
import { transactions, dailySales, inventoryItems, fmtRWF, type Transaction } from '../data'
import { Card, SectionHeader, StatusBadge, Modal, Btn, ChartTooltip } from '../components'

// ─── Transaction Detail Modal ─────────────────────────────────────────────────

function TxnModal({ txn, onClose }: { txn: Transaction; onClose: () => void }) {
  const statusColor = txn.status === 'paid' ? '#16a34a' : txn.status === 'pending' ? '#d97706' : '#dc2626'
  const statusBg = txn.status === 'paid' ? '#d1fae5' : txn.status === 'pending' ? '#fef3c7' : '#fee2e2'
  return (
    <Modal title={`Transaction — ${txn.id}`} onClose={onClose} width={560}>
      <div style={{ display: 'flex', gap: 10, marginBottom: 16, flexWrap: 'wrap' }}>
        {[
          ['Date', txn.date],
          ['Patient', txn.patient],
          ['Pharmacist', txn.pharmacist],
          ['Branch', txn.branch],
          ['Payment', txn.payment],
          ['Receipt', txn.receipt],
          txn.insurance ? ['Insurer', txn.insurance] : null,
        ].filter(Boolean).map((pair) => { const [l, v] = pair as [string, string]; return (
          <div key={l as string} style={{ background: 'var(--bg)', borderRadius: 8, padding: '8px 12px', minWidth: 120, flex: 1 }}>
            <div style={{ fontSize: 10, color: 'var(--ink-muted)', fontWeight: 500, textTransform: 'uppercase', letterSpacing: '0.05em', marginBottom: 2 }}>{l}</div>
            <div style={{ fontSize: 13, fontWeight: 600, color: 'var(--ink)' }}>{v}</div>
          </div>
        )}) }
      </div>

      <div style={{ marginBottom: 16 }}>
        <div style={{ fontSize: 12, fontWeight: 600, color: 'var(--ink)', marginBottom: 8 }}>Items</div>
        <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 12 }}>
          <thead>
            <tr style={{ borderBottom: '1px solid var(--border)' }}>
              {['Product', 'Qty', 'Unit Price', 'Total'].map(h => (
                <th key={h} style={{ textAlign: 'left', padding: '6px 8px', fontSize: 11, color: 'var(--ink-muted)', fontWeight: 500 }}>{h}</th>
              ))}
            </tr>
          </thead>
          <tbody>
            {txn.items.map((item, i) => (
              <tr key={i} style={{ borderBottom: '1px solid var(--bg-alt)' }}>
                <td style={{ padding: '8px 8px', fontWeight: 500 }}>{item.name}</td>
                <td style={{ padding: '8px 8px', fontFamily: 'JetBrains Mono, monospace' }}>{item.qty}</td>
                <td style={{ padding: '8px 8px' }}>{fmtRWF(item.unitPrice)}</td>
                <td style={{ padding: '8px 8px', fontWeight: 600 }}>{fmtRWF(item.total)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', borderTop: '1px solid var(--border)', paddingTop: 12 }}>
        <div>
          <StatusBadge label={txn.status.toUpperCase()} color={statusColor} bg={statusBg} />
        </div>
        <div style={{ textAlign: 'right' }}>
          <div style={{ fontSize: 11, color: 'var(--ink-muted)' }}>Total</div>
          <div style={{ fontSize: 22, fontWeight: 700, color: 'var(--ink)', fontFamily: 'DM Sans' }}>{fmtRWF(txn.total)}</div>
        </div>
      </div>

      <div style={{ display: 'flex', gap: 8, justifyContent: 'flex-end', marginTop: 14 }}>
        <Btn variant="ghost" small>🖨 Print Receipt</Btn>
        <Btn variant="secondary" small>📱 Resend E-Receipt</Btn>
        {txn.status === 'paid' && <Btn variant="danger" small>↩ Refund</Btn>}
      </div>
    </Modal>
  )
}

// ─── New Sale Modal (POS) ─────────────────────────────────────────────────────

function NewSaleModal({ onClose }: { onClose: () => void }) {
  const [cartItems, setCartItems] = useState<Array<{ product: typeof inventoryItems[0]; qty: number }>>([])
  const [searchProd, setSearchProd] = useState('')
  const [payment, setPayment] = useState<'Cash' | 'Mobile Money' | 'Insurance' | 'Card'>('Cash')

  const filteredProd = inventoryItems.filter(p =>
    p.name.toLowerCase().includes(searchProd.toLowerCase()) && p.stock > 0
  )

  const addToCart = (product: typeof inventoryItems[0]) => {
    setCartItems(prev => {
      const existing = prev.find(c => c.product.id === product.id)
      if (existing) return prev.map(c => c.product.id === product.id ? { ...c, qty: c.qty + 1 } : c)
      return [...prev, { product, qty: 1 }]
    })
  }

  const total = cartItems.reduce((sum, c) => sum + c.product.unitPrice * c.qty, 0)

  return (
    <Modal title="New Sale — POS" onClose={onClose} width={700}>
      <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 16, height: 440 }}>
        {/* Left: product search */}
        <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
          <div style={{ fontSize: 12, fontWeight: 600, color: 'var(--ink-muted)', textTransform: 'uppercase', letterSpacing: '0.05em' }}>Search / Scan Medicine</div>
          <div style={{ position: 'relative' }}>
            <span style={{ position: 'absolute', left: 9, top: '50%', transform: 'translateY(-50%)', fontSize: 12, color: 'var(--ink-faint)' }}>🔍</span>
            <input
              value={searchProd} onChange={e => setSearchProd(e.target.value)}
              placeholder="Medicine name or scan barcode…"
              style={{ width: '100%', padding: '8px 10px 8px 28px', border: '1px solid var(--border)', borderRadius: 8, fontSize: 12, fontFamily: 'inherit', outline: 'none' }}
              onFocus={e => (e.target.style.borderColor = 'var(--primary)')}
              onBlur={e => (e.target.style.borderColor = 'var(--border)')}
            />
          </div>
          <div style={{ overflowY: 'auto', flex: 1, display: 'flex', flexDirection: 'column', gap: 4 }}>
            {(searchProd ? filteredProd : inventoryItems.filter(p => p.stock > 0)).slice(0, 8).map(p => (
              <div key={p.id}
                onClick={() => addToCart(p)}
                style={{
                  padding: '9px 12px', border: '1px solid var(--border)', borderRadius: 8,
                  cursor: 'pointer', transition: 'all 0.13s', display: 'flex', justifyContent: 'space-between', alignItems: 'center',
                }}
                onMouseEnter={e => { (e.currentTarget as HTMLDivElement).style.background = 'var(--primary-light)'; (e.currentTarget as HTMLDivElement).style.borderColor = 'var(--border-strong)' }}
                onMouseLeave={e => { (e.currentTarget as HTMLDivElement).style.background = ''; (e.currentTarget as HTMLDivElement).style.borderColor = 'var(--border)' }}
              >
                <div>
                  <div style={{ fontSize: 12, fontWeight: 600, color: 'var(--ink)' }}>{p.name}</div>
                  <div style={{ fontSize: 10, color: 'var(--ink-muted)' }}>{p.category} · {p.stock} in stock</div>
                </div>
                <div style={{ fontSize: 12, fontWeight: 700, color: 'var(--primary)' }}>{fmtRWF(p.unitPrice)}</div>
              </div>
            ))}
          </div>
        </div>

        {/* Right: cart */}
        <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
          <div style={{ fontSize: 12, fontWeight: 600, color: 'var(--ink-muted)', textTransform: 'uppercase', letterSpacing: '0.05em' }}>Cart ({cartItems.length} items)</div>
          <div style={{ flex: 1, overflowY: 'auto', display: 'flex', flexDirection: 'column', gap: 4 }}>
            {cartItems.length === 0 && (
              <div style={{ textAlign: 'center', color: 'var(--ink-faint)', fontSize: 13, marginTop: 40 }}>Add items from the left panel</div>
            )}
            {cartItems.map(c => (
              <div key={c.product.id} style={{ padding: '8px 10px', border: '1px solid var(--border)', borderRadius: 8, display: 'flex', alignItems: 'center', gap: 8 }}>
                <div style={{ flex: 1, minWidth: 0 }}>
                  <div style={{ fontSize: 12, fontWeight: 500, color: 'var(--ink)', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{c.product.name}</div>
                  <div style={{ fontSize: 10, color: 'var(--ink-muted)' }}>{fmtRWF(c.product.unitPrice)} each</div>
                </div>
                <div style={{ display: 'flex', alignItems: 'center', gap: 4 }}>
                  <button onClick={() => setCartItems(p => p.map(x => x.product.id === c.product.id ? { ...x, qty: Math.max(1, x.qty - 1) } : x))}
                    style={{ width: 22, height: 22, borderRadius: 4, border: '1px solid var(--border)', background: '#fff', cursor: 'pointer', fontSize: 12, fontWeight: 700 }}>−</button>
                  <span style={{ fontSize: 12, fontWeight: 600, minWidth: 20, textAlign: 'center' }}>{c.qty}</span>
                  <button onClick={() => setCartItems(p => p.map(x => x.product.id === c.product.id ? { ...x, qty: x.qty + 1 } : x))}
                    style={{ width: 22, height: 22, borderRadius: 4, border: '1px solid var(--border)', background: '#fff', cursor: 'pointer', fontSize: 12, fontWeight: 700 }}>+</button>
                </div>
                <div style={{ fontSize: 12, fontWeight: 700, color: 'var(--ink)', minWidth: 60, textAlign: 'right' }}>{fmtRWF(c.product.unitPrice * c.qty)}</div>
                <button onClick={() => setCartItems(p => p.filter(x => x.product.id !== c.product.id))}
                  style={{ background: 'none', border: 'none', cursor: 'pointer', color: 'var(--ink-faint)', fontSize: 14, padding: '0 2px' }}>×</button>
              </div>
            ))}
          </div>

          {/* Payment + total */}
          <div style={{ borderTop: '1px solid var(--border)', paddingTop: 10, display: 'flex', flexDirection: 'column', gap: 8 }}>
            <div style={{ display: 'flex', gap: 4 }}>
              {(['Cash', 'Mobile Money', 'Insurance', 'Card'] as const).map(p => (
                <button key={p} onClick={() => setPayment(p)} style={{
                  flex: 1, padding: '6px 4px', borderRadius: 6, border: `1.5px solid ${payment === p ? 'var(--primary)' : 'var(--border)'}`,
                  background: payment === p ? 'var(--primary-light)' : '#fff',
                  color: payment === p ? 'var(--primary)' : 'var(--ink-muted)',
                  fontSize: 10, fontWeight: payment === p ? 700 : 400, cursor: 'pointer', fontFamily: 'inherit',
                }}>{p}</button>
              ))}
            </div>
            <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
              <div>
                <div style={{ fontSize: 11, color: 'var(--ink-muted)' }}>Total Amount</div>
                <div style={{ fontSize: 22, fontWeight: 700, color: 'var(--ink)', fontFamily: 'DM Sans' }}>{fmtRWF(total)}</div>
              </div>
              <Btn variant="primary" onClick={onClose} style={{ fontSize: 13, padding: '10px 20px' }}>
                {cartItems.length > 0 ? '✓ Complete Sale' : 'Cancel'}
              </Btn>
            </div>
          </div>
        </div>
      </div>
    </Modal>
  )
}

// ─── Sales Page ───────────────────────────────────────────────────────────────

export default function SalesPage() {
  const [selectedTxn, setSelectedTxn] = useState<Transaction | null>(null)
  const [showNewSale, setShowNewSale] = useState(false)

  const hourlyData = [
    { hr: '08:00', amount: 120000 }, { hr: '09:00', amount: 280000 },
    { hr: '10:00', amount: 420000 }, { hr: '11:00', amount: 380000 },
    { hr: '12:00', amount: 310000 }, { hr: '13:00', amount: 250000 },
    { hr: '14:00', amount: 390000 }, { hr: '15:00', amount: 460000 },
    { hr: '16:00', amount: 520000 }, { hr: '17:00', amount: 380000 },
  ]

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 18 }}>
      {/* KPIs */}
      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(4, 1fr)', gap: 12 }}>
        {[
          { label: "Today's Revenue", value: 'RWF 1.64M', sub: '214 transactions', color: '#1e8a4a', icon: '💰' },
          { label: 'Avg. Basket Value', value: 'RWF 7,664', sub: '+5.2% vs monthly avg', color: '#059669', icon: '🧺' },
          { label: 'Cash Sales', value: '42%', sub: 'RWF 688K today', color: '#0284c7', icon: '💵' },
          { label: 'Insurance Claims', value: '18%', sub: '38 claims pending', color: '#7c3aed', icon: '🏥' },
        ].map(k => (
          <div key={k.label} style={{ background: '#fff', borderRadius: 12, padding: '16px 18px', border: '1px solid var(--border)' }}>
            <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start' }}>
              <div>
                <div style={{ fontSize: 22, fontWeight: 700, color: k.color, fontFamily: 'DM Sans' }}>{k.value}</div>
                <div style={{ fontSize: 12, fontWeight: 500, color: 'var(--ink)', marginTop: 2 }}>{k.label}</div>
                <div style={{ fontSize: 11, color: 'var(--ink-muted)', marginTop: 1 }}>{k.sub}</div>
              </div>
              <div style={{ fontSize: 20 }}>{k.icon}</div>
            </div>
          </div>
        ))}
      </div>

      <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 14 }}>
        <Card>
          <SectionHeader title="Hourly Sales — Today" subtitle="Revenue by hour (Aug 15, 2026)" />
          <ResponsiveContainer width="100%" height={210}>
            <AreaChart data={hourlyData} margin={{ top: 4, right: 4, bottom: 0, left: 0 }}>
              <defs>
                <linearGradient id="gHour" x1="0" y1="0" x2="0" y2="1">
                  <stop offset="5%" stopColor="#1e8a4a" stopOpacity={0.18} />
                  <stop offset="95%" stopColor="#1e8a4a" stopOpacity={0} />
                </linearGradient>
              </defs>
              <CartesianGrid stroke="#f0f0f0" strokeDasharray="4 4" />
              <XAxis dataKey="hr" tick={{ fontSize: 10 }} axisLine={false} tickLine={false} />
              <YAxis tick={{ fontSize: 10 }} axisLine={false} tickLine={false} tickFormatter={v => `${v / 1000}K`} />
              <Tooltip content={<ChartTooltip />} />
              <Area type="monotone" dataKey="amount" name="Revenue" stroke="#1e8a4a" fill="url(#gHour)" strokeWidth={2.5} dot={false} activeDot={{ r: 5 }} />
            </AreaChart>
          </ResponsiveContainer>
        </Card>

        <Card>
          <SectionHeader title="Daily Sales Split" subtitle="By payment method this week" />
          <ResponsiveContainer width="100%" height={210}>
            <BarChart data={dailySales} margin={{ top: 4, right: 4, bottom: 0, left: 0 }}>
              <CartesianGrid stroke="#f0f0f0" strokeDasharray="4 4" />
              <XAxis dataKey="day" tick={{ fontSize: 11 }} axisLine={false} tickLine={false} />
              <YAxis tick={{ fontSize: 10 }} axisLine={false} tickLine={false} tickFormatter={v => `${v / 1000}K`} />
              <Tooltip content={<ChartTooltip />} />
              <Legend iconType="circle" iconSize={8} wrapperStyle={{ fontSize: 11 }} />
              <Bar dataKey="cash"      name="Cash"         stackId="a" fill="#1e8a4a" />
              <Bar dataKey="momo"      name="Mobile Money" stackId="a" fill="#34d399" />
              <Bar dataKey="insurance" name="Insurance"    stackId="a" fill="#a7f3d0" />
              <Bar dataKey="card"      name="Card"         stackId="a" fill="#d1fae5" radius={[4, 4, 0, 0]} />
            </BarChart>
          </ResponsiveContainer>
        </Card>
      </div>

      {/* Transactions */}
      <Card>
        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 14 }}>
          <div>
            <h2 style={{ margin: 0, fontSize: 14, fontWeight: 600, color: 'var(--ink)' }}>Recent Transactions</h2>
            <p style={{ margin: '2px 0 0', fontSize: 11, color: 'var(--ink-muted)' }}>Click any row to view full receipt and items</p>
          </div>
          <Btn variant="primary" onClick={() => setShowNewSale(true)}>+ New Sale</Btn>
        </div>

        <div style={{ overflowX: 'auto' }}>
          <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 12 }}>
            <thead>
              <tr style={{ borderBottom: '1px solid var(--border)' }}>
                {['TXN ID', 'Date & Time', 'Patient', 'Pharmacist', 'Items', 'Total', 'Payment', 'Branch', 'Status'].map(h => (
                  <th key={h} style={{ textAlign: 'left', padding: '7px 10px', color: 'var(--ink-muted)', fontWeight: 500, fontSize: 11, whiteSpace: 'nowrap' }}>{h}</th>
                ))}
              </tr>
            </thead>
            <tbody>
              {transactions.map(t => {
                const sc = t.status === 'paid' ? { bg: '#d1fae5', c: '#16a34a' } : t.status === 'pending' ? { bg: '#fef3c7', c: '#d97706' } : { bg: '#fee2e2', c: '#dc2626' }
                return (
                  <tr key={t.id}
                    onClick={() => setSelectedTxn(t)}
                    style={{ borderBottom: '1px solid var(--bg-alt)', cursor: 'pointer', transition: 'background 0.13s' }}
                    onMouseEnter={e => (e.currentTarget.style.background = 'var(--bg)')}
                    onMouseLeave={e => (e.currentTarget.style.background = 'transparent')}
                  >
                    <td style={{ padding: '9px 10px', fontFamily: 'JetBrains Mono, monospace', fontSize: 11, color: 'var(--primary)', fontWeight: 600 }}>{t.id}</td>
                    <td style={{ padding: '9px 10px', fontSize: 11, color: 'var(--ink-muted)', whiteSpace: 'nowrap' }}>{t.date}</td>
                    <td style={{ padding: '9px 10px', fontWeight: 500, whiteSpace: 'nowrap' }}>{t.patient}</td>
                    <td style={{ padding: '9px 10px', color: 'var(--ink-muted)', whiteSpace: 'nowrap' }}>{t.pharmacist}</td>
                    <td style={{ padding: '9px 10px', textAlign: 'center', fontFamily: 'JetBrains Mono, monospace' }}>{t.items.length}</td>
                    <td style={{ padding: '9px 10px', fontWeight: 700 }}>{fmtRWF(t.total)}</td>
                    <td style={{ padding: '9px 10px', fontSize: 11, color: 'var(--ink-muted)' }}>{t.payment}</td>
                    <td style={{ padding: '9px 10px', fontSize: 11, color: 'var(--ink-muted)' }}>{t.branch}</td>
                    <td style={{ padding: '9px 10px' }}>
                      <StatusBadge label={t.status} color={sc.c} bg={sc.bg} />
                    </td>
                  </tr>
                )
              })}
            </tbody>
          </table>
        </div>
      </Card>

      {selectedTxn && <TxnModal txn={selectedTxn} onClose={() => setSelectedTxn(null)} />}
      {showNewSale && <NewSaleModal onClose={() => setShowNewSale(false)} />}
    </div>
  )
}
