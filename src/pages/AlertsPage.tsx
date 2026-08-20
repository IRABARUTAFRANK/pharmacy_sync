import { useState, useMemo } from 'react'
import { dbNotifications, dbBatchRecalls, dbStockAdjustments, dbProductVariants, dbProducts, type DBNotification } from '../data'
import { Card, SectionHeader, StatusBadge, Btn, ColumnPicker } from '../components'

type ColKey = 'source_type' | 'source_id' | 'branch_id' | 'is_read' | 'created_at'

const COLUMN_DEFS: { key: ColKey; label: string }[] = [
  { key: 'source_type', label: 'Source Type' },
  { key: 'source_id',   label: 'Source ID' },
  { key: 'branch_id',   label: 'Branch' },
  { key: 'is_read',     label: 'Read Status' },
  { key: 'created_at',  label: 'Date' },
]

const DEFAULT_VISIBLE = new Set<ColKey>(['source_type', 'is_read', 'created_at'])

const sourceColors: Record<string, { c: string; bg: string; label: string }> = {
  batch_recall:     { c: '#dc2626', bg: '#fef2f2', label: 'Batch Recall' },
  stock_adjustment: { c: '#d97706', bg: '#fef3c7', label: 'Stock Adjustment' },
}

function getDetail(n: DBNotification): string {
  if (n.source_type === 'batch_recall') {
    const recall = dbBatchRecalls.find(r => r.id === n.source_id)
    if (recall) {
      const variant = dbProductVariants.find(v => v.id === recall.product_variant_id)
      const product = variant ? dbProducts.find(p => p.id === variant.product_id) : undefined
      return `Batch ${recall.batch_number} — ${product?.name ?? 'Unknown product'} — ${recall.manufacturer_name ?? 'Unknown mfr'}: ${recall.reason}`
    }
  }
  if (n.source_type === 'stock_adjustment') {
    const adj = dbStockAdjustments.find(a => a.id === n.source_id)
    if (adj) return `${adj.adjustment_type.replace('_', ' ')} · Qty ${adj.quantity}${adj.reason ? ' — ' + adj.reason : ''}`
  }
  return n.message
}

export default function AlertsPage() {
  const [notifications, setNotifications] = useState<DBNotification[]>(dbNotifications)
  const [sourceFilter, setSourceFilter]   = useState<'all' | 'batch_recall' | 'stock_adjustment'>('all')
  const [readFilter, setReadFilter]       = useState<'all' | 'unread' | 'read'>('all')
  const [visibleCols, setVisibleCols]     = useState<Set<ColKey>>(new Set(DEFAULT_VISIBLE))

  const toggleCol = (key: ColKey) =>
    setVisibleCols(prev => { const next = new Set(prev); next.has(key) ? next.delete(key) : next.add(key); return next })

  const markRead = (id: string) => setNotifications(ns => ns.map(n => n.id === id ? { ...n, is_read: true } : n))
  const markAllRead = () => setNotifications(ns => ns.map(n => ({ ...n, is_read: true })))

  const filtered = useMemo(() => {
    let ns = notifications
    if (sourceFilter !== 'all') ns = ns.filter(n => n.source_type === sourceFilter)
    if (readFilter === 'unread') ns = ns.filter(n => !n.is_read)
    if (readFilter === 'read')   ns = ns.filter(n => n.is_read)
    return [...ns].sort((a, b) => new Date(b.created_at).getTime() - new Date(a.created_at).getTime())
  }, [notifications, sourceFilter, readFilter])

  const unreadCount = notifications.filter(n => !n.is_read).length
  const recallCount = notifications.filter(n => n.source_type === 'batch_recall').length

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 16 }}>
      {/* KPIs */}
      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(3, 1fr)', gap: 10 }}>
        {[
          { label: 'Total Notifications', value: notifications.length, c: '#1e8a4a', bg: '#d1fae5' },
          { label: 'Unread',              value: unreadCount,          c: '#dc2626', bg: '#fef2f2' },
          { label: 'Batch Recalls',       value: recallCount,          c: '#d97706', bg: '#fef3c7' },
        ].map(k => (
          <div key={k.label} style={{ background: k.bg, border: `1px solid ${k.c}30`, borderRadius: 10, padding: '14px 16px', display: 'flex', alignItems: 'center', gap: 10 }}>
            <div style={{ fontSize: 26, fontWeight: 800, color: k.c, fontFamily: 'DM Sans' }}>{k.value}</div>
            <div style={{ fontSize: 12, fontWeight: 600, color: 'var(--ink)' }}>{k.label}</div>
          </div>
        ))}
      </div>

      <Card>
        <div style={{ display: 'flex', gap: 8, marginBottom: 14, flexWrap: 'wrap', alignItems: 'center' }}>
          <h2 style={{ margin: 0, fontSize: 14, fontWeight: 600, color: 'var(--ink)', flex: 1 }}>Notifications</h2>
          <span style={{ fontSize: 11, color: 'var(--ink-muted)' }}>source_type: batch_recall | stock_adjustment</span>
          {[
            { label: 'Source', value: sourceFilter, set: (v: any) => setSourceFilter(v), opts: [['all','All Sources'],['batch_recall','Batch Recall'],['stock_adjustment','Stock Adjustment']] },
            { label: 'Status', value: readFilter,   set: (v: any) => setReadFilter(v),   opts: [['all','All'],['unread','Unread'],['read','Read']] },
          ].map((f, fi) => (
            <select key={fi} value={f.value} onChange={e => f.set(e.target.value)}
              style={{ padding: '6px 8px', border: '1px solid var(--border)', borderRadius: 7, fontSize: 11, fontFamily: 'inherit', background: 'var(--bg)', cursor: 'pointer', outline: 'none' }}>
              {f.opts.map(([v, l]) => <option key={v} value={v}>{l}</option>)}
            </select>
          ))}
          <ColumnPicker columns={COLUMN_DEFS} visible={visibleCols} onToggle={toggleCol} />
          {unreadCount > 0 && <Btn variant="secondary" small onClick={markAllRead}>Mark All Read ({unreadCount})</Btn>}
        </div>

        <div style={{ overflowX: 'auto' }}>
          <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 12 }}>
            <thead>
              <tr style={{ borderBottom: '1px solid var(--border)' }}>
                <th style={{ textAlign: 'left', padding: '7px 10px', fontSize: 10, fontWeight: 600, color: 'var(--ink-muted)', textTransform: 'uppercase', letterSpacing: '0.04em' }}>Message</th>
                {visibleCols.has('source_type') && <th style={{ textAlign: 'left', padding: '7px 10px', fontSize: 10, fontWeight: 600, color: 'var(--ink-muted)', textTransform: 'uppercase', letterSpacing: '0.04em' }}>Source Type</th>}
                {visibleCols.has('source_id')   && <th style={{ textAlign: 'left', padding: '7px 10px', fontSize: 10, fontWeight: 600, color: 'var(--ink-muted)', textTransform: 'uppercase', letterSpacing: '0.04em' }}>Source ID</th>}
                {visibleCols.has('branch_id')   && <th style={{ textAlign: 'left', padding: '7px 10px', fontSize: 10, fontWeight: 600, color: 'var(--ink-muted)', textTransform: 'uppercase', letterSpacing: '0.04em' }}>Branch</th>}
                {visibleCols.has('is_read')     && <th style={{ textAlign: 'left', padding: '7px 10px', fontSize: 10, fontWeight: 600, color: 'var(--ink-muted)', textTransform: 'uppercase', letterSpacing: '0.04em' }}>Status</th>}
                {visibleCols.has('created_at')  && <th style={{ textAlign: 'left', padding: '7px 10px', fontSize: 10, fontWeight: 600, color: 'var(--ink-muted)', textTransform: 'uppercase', letterSpacing: '0.04em' }}>Date</th>}
                <th></th>
              </tr>
            </thead>
            <tbody>
              {filtered.map(n => {
                const sc = sourceColors[n.source_type] ?? sourceColors.stock_adjustment
                return (
                  <tr key={n.id} style={{ borderBottom: '1px solid var(--bg-alt)', background: n.is_read ? 'transparent' : '#fffbf0', transition: 'background 0.12s' }}>
                    <td style={{ padding: '10px 10px', maxWidth: 380 }}>
                      <div style={{ fontWeight: n.is_read ? 400 : 600, color: 'var(--ink)', fontSize: 12 }}>{n.message}</div>
                      <div style={{ fontSize: 10, color: 'var(--ink-muted)', marginTop: 3, lineHeight: 1.4 }}>{getDetail(n)}</div>
                    </td>
                    {visibleCols.has('source_type') && <td style={{ padding: '10px 10px' }}><StatusBadge label={sc.label} color={sc.c} bg={sc.bg} /></td>}
                    {visibleCols.has('source_id')   && <td style={{ padding: '10px 10px', fontFamily: 'JetBrains Mono, monospace', fontSize: 9, color: 'var(--ink-faint)' }}>{n.source_id.slice(0, 16)}…</td>}
                    {visibleCols.has('branch_id')   && <td style={{ padding: '10px 10px', fontFamily: 'JetBrains Mono, monospace', fontSize: 10, color: 'var(--ink-mid)' }}>{n.branch_id}</td>}
                    {visibleCols.has('is_read')     && <td style={{ padding: '10px 10px' }}><StatusBadge label={n.is_read ? 'Read' : 'Unread'} color={n.is_read ? '#16a34a' : '#dc2626'} bg={n.is_read ? '#d1fae5' : '#fef2f2'} /></td>}
                    {visibleCols.has('created_at')  && <td style={{ padding: '10px 10px', fontSize: 11, color: 'var(--ink-faint)', whiteSpace: 'nowrap' }}>{n.created_at}</td>}
                    <td style={{ padding: '10px 10px' }}>
                      {!n.is_read && (
                        <button onClick={() => markRead(n.id)}
                          style={{ fontSize: 10, color: 'var(--primary)', background: 'none', border: '1px solid var(--border)', borderRadius: 5, padding: '3px 8px', cursor: 'pointer', fontFamily: 'inherit', fontWeight: 600 }}>
                          Mark Read
                        </button>
                      )}
                    </td>
                  </tr>
                )
              })}
              {filtered.length === 0 && (
                <tr><td colSpan={10} style={{ padding: 28, textAlign: 'center', color: 'var(--ink-muted)', fontSize: 13 }}>No notifications match the current filters.</td></tr>
              )}
            </tbody>
          </table>
        </div>
        <div style={{ marginTop: 10, fontSize: 11, color: 'var(--ink-faint)' }}>
          {filtered.length} notification{filtered.length !== 1 ? 's' : ''} · {visibleCols.size} of {COLUMN_DEFS.length} extra columns visible
        </div>
      </Card>
    </div>
  )
}
