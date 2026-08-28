import { useState, useEffect, useCallback, useMemo } from 'react'
import { ALERT_SOURCE_TITLE_KEYS, loadLiveAlerts, markAlertRead, markAllAlertsRead, type LiveAlert } from '../lib/alerts'
import { useTranslation } from '../lib/i18n'
import { useGlobalSearch } from '../lib/search'
import { errorMessage } from '../lib/supabase'
import { Card, StatusBadge, Btn, ColumnPicker } from '../components'

type ColKey = 'source_type' | 'is_read' | 'created_at'

const DEFAULT_VISIBLE = new Set<ColKey>(['source_type', 'is_read', 'created_at'])

const sourceColors: Record<string, { c: string; bg: string }> = {
  batch_recall:              { c: '#dc2626', bg: '#fef2f2' },
  stock_adjustment:          { c: '#d97706', bg: '#fef3c7' },
  product_request_approved:  { c: '#16a34a', bg: '#d1fae5' },
  product_request_rejected:  { c: '#d97706', bg: '#fef3c7' },
  out_of_stock:              { c: '#dc2626', bg: '#fef2f2' },
}

export default function AlertsPage() {
  const { t } = useTranslation()
  const COLUMN_DEFS: { key: ColKey; label: string }[] = [
    { key: 'source_type', label: t('alertsPage.colSourceType') },
    { key: 'is_read',     label: t('alertsPage.colReadStatus') },
    { key: 'created_at',  label: t('alertsPage.colDate') },
  ]

  const [alerts, setAlerts] = useState<LiveAlert[]>([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const [sourceFilter, setSourceFilter] = useState<'all' | string>('all')
  const [readFilter, setReadFilter]     = useState<'all' | 'unread' | 'read'>('all')
  const [visibleCols, setVisibleCols]   = useState<Set<ColKey>>(new Set(DEFAULT_VISIBLE))

  const refresh = useCallback(async () => {
    setLoading(true)
    setError(null)
    try {
      const rows = await loadLiveAlerts()
      setAlerts(rows)
      // Opening this page IS reading its notifications -- no separate click
      // required. Best-effort: a failed mark-read here just leaves the row
      // unread until the next visit, same as any other transient failure.
      const unreadIds = rows.filter(n => !n.isRead).map(n => n.id)
      if (unreadIds.length > 0) {
        void markAllAlertsRead(unreadIds).catch(() => { /* retried on next visit */ })
        setAlerts(rows.map(n => ({ ...n, isRead: true })))
      }
    } catch (reason) {
      setError(errorMessage(reason, t('alertsPage.loadError')))
    } finally {
      setLoading(false)
    }
  }, [t])

  useEffect(() => { void refresh() }, [refresh])

  const toggleCol = (key: ColKey) =>
    setVisibleCols(prev => { const next = new Set(prev); next.has(key) ? next.delete(key) : next.add(key); return next })

  async function markRead(id: string) {
    setAlerts(ns => ns.map(n => n.id === id ? { ...n, isRead: true } : n))
    try {
      await markAlertRead(id)
    } catch (reason) {
      setError(errorMessage(reason, t('alertsPage.markReadError')))
      void refresh()
    }
  }

  async function markAllRead() {
    const unreadIds = alerts.filter(n => !n.isRead).map(n => n.id)
    setAlerts(ns => ns.map(n => ({ ...n, isRead: true })))
    try {
      await markAllAlertsRead(unreadIds)
    } catch (reason) {
      setError(errorMessage(reason, t('alertsPage.markAllReadError')))
      void refresh()
    }
  }

  const { term: searchTerm } = useGlobalSearch()

  const filtered = useMemo(() => {
    let ns = alerts
    if (sourceFilter !== 'all') ns = ns.filter(n => n.sourceType === sourceFilter)
    if (readFilter === 'unread') ns = ns.filter(n => !n.isRead)
    if (readFilter === 'read')   ns = ns.filter(n => n.isRead)
    const needle = searchTerm.trim().toLowerCase()
    if (needle) ns = ns.filter(n => `${t(n.titleKey)} ${n.msg}`.toLowerCase().includes(needle))
    return ns
  }, [alerts, sourceFilter, readFilter, searchTerm, t])

  const unreadCount = alerts.filter(n => !n.isRead).length
  const recallCount = alerts.filter(n => n.sourceType === 'batch_recall').length
  const outOfStockCount = alerts.filter(n => n.sourceType === 'out_of_stock' && !n.isRead).length

  return (
    <div className="animate-fade-in" style={{ display: 'flex', flexDirection: 'column', gap: 16 }}>
      {error && <div style={{ background: '#fef2f2', color: '#b91c1c', border: '1px solid #fecaca', borderRadius: 10, padding: '12px 14px', fontSize: 12 }}>
        {error}
      </div>}

      {/* KPIs */}
      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(4, 1fr)', gap: 10 }}>
        {[
          { label: t('alertsPage.kpiTotal'),      value: alerts.length,     c: '#1e8a4a', bg: '#d1fae5' },
          { label: t('alertsPage.kpiUnread'),      value: unreadCount,       c: '#dc2626', bg: '#fef2f2' },
          { label: t('alertsPage.kpiOutOfStock'), value: outOfStockCount, c: '#dc2626', bg: '#fef2f2' },
          { label: t('alertsPage.kpiRecalls'),       value: recallCount,       c: '#d97706', bg: '#fef3c7' },
        ].map((k, i) => (
          <div key={i} className="animate-fade-up" style={{ animationDelay: `${i * 60}ms`, background: k.bg, border: `1px solid ${k.c}30`, borderRadius: 10, padding: '14px 16px', display: 'flex', alignItems: 'center', gap: 10 }}>
            <div style={{ fontSize: 26, fontWeight: 800, color: k.c, fontFamily: 'var(--font-display)' }}>{loading ? '—' : k.value}</div>
            <div style={{ fontSize: 12, fontWeight: 600, color: 'var(--ink)' }}>{k.label}</div>
          </div>
        ))}
      </div>

      <Card>
        <div style={{ display: 'flex', gap: 8, marginBottom: 14, flexWrap: 'wrap', alignItems: 'center' }}>
          <h2 style={{ margin: 0, fontSize: 14, fontWeight: 600, color: 'var(--ink)', flex: 1 }}>{t('alertsPage.title')}</h2>
          <span style={{ fontSize: 11, color: 'var(--ink-muted)' }}>{t('alertsPage.liveDataNotice')}</span>
          <select value={sourceFilter} onChange={e => setSourceFilter(e.target.value)}
            style={{ padding: '6px 8px', border: '1px solid var(--border)', borderRadius: 7, fontSize: 11, fontFamily: 'inherit', background: 'var(--bg)', cursor: 'pointer', outline: 'none' }}>
            <option value="all">{t('alertsPage.allSources')}</option>
            {Object.entries(ALERT_SOURCE_TITLE_KEYS).map(([key, titleKey]) => <option key={key} value={key}>{t(titleKey)}</option>)}
          </select>
          <select value={readFilter} onChange={e => setReadFilter(e.target.value as typeof readFilter)}
            style={{ padding: '6px 8px', border: '1px solid var(--border)', borderRadius: 7, fontSize: 11, fontFamily: 'inherit', background: 'var(--bg)', cursor: 'pointer', outline: 'none' }}>
            <option value="all">{t('alertsPage.all')}</option>
            <option value="unread">{t('alertsPage.unread')}</option>
            <option value="read">{t('alertsPage.read')}</option>
          </select>
          <ColumnPicker columns={COLUMN_DEFS} visible={visibleCols} onToggle={toggleCol} />
          <Btn variant="secondary" small onClick={() => void refresh()}>{t('alertsPage.refresh')}</Btn>
          {unreadCount > 0 && <Btn variant="secondary" small onClick={() => void markAllRead()}>{t('alertsPage.markAllRead', { count: unreadCount })}</Btn>}
        </div>

        <div style={{ overflowX: 'auto' }}>
          <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 12 }}>
            <thead>
              <tr style={{ borderBottom: '1px solid var(--border)' }}>
                <th style={{ textAlign: 'left', padding: '7px 10px', fontSize: 10, fontWeight: 600, color: 'var(--ink-muted)', textTransform: 'uppercase', letterSpacing: '0.04em' }}>{t('alertsPage.colMessage')}</th>
                {visibleCols.has('source_type') && <th style={{ textAlign: 'left', padding: '7px 10px', fontSize: 10, fontWeight: 600, color: 'var(--ink-muted)', textTransform: 'uppercase', letterSpacing: '0.04em' }}>{t('alertsPage.colSourceType')}</th>}
                {visibleCols.has('is_read')     && <th style={{ textAlign: 'left', padding: '7px 10px', fontSize: 10, fontWeight: 600, color: 'var(--ink-muted)', textTransform: 'uppercase', letterSpacing: '0.04em' }}>{t('alertsPage.colStatus')}</th>}
                {visibleCols.has('created_at')  && <th style={{ textAlign: 'left', padding: '7px 10px', fontSize: 10, fontWeight: 600, color: 'var(--ink-muted)', textTransform: 'uppercase', letterSpacing: '0.04em' }}>{t('alertsPage.colDate')}</th>}
                <th></th>
              </tr>
            </thead>
            <tbody>
              {filtered.map(n => {
                const sc = sourceColors[n.sourceType] ?? { c: '#475569', bg: '#e2e8f0' }
                const label = ALERT_SOURCE_TITLE_KEYS[n.sourceType] ? t(ALERT_SOURCE_TITLE_KEYS[n.sourceType]) : n.sourceType
                return (
                  <tr key={n.id} style={{ borderBottom: '1px solid var(--bg-alt)', background: n.isRead ? 'transparent' : '#fffbf0', transition: 'background 0.12s' }}>
                    <td style={{ padding: '10px 10px', maxWidth: 380 }}>
                      <div style={{ fontWeight: n.isRead ? 400 : 600, color: 'var(--ink)', fontSize: 12 }}>{t(n.titleKey)}</div>
                      <div style={{ fontSize: 10, color: 'var(--ink-muted)', marginTop: 3, lineHeight: 1.4 }}>{n.msg}</div>
                    </td>
                    {visibleCols.has('source_type') && <td style={{ padding: '10px 10px' }}><StatusBadge label={label} color={sc.c} bg={sc.bg} /></td>}
                    {visibleCols.has('is_read')     && <td style={{ padding: '10px 10px' }}><StatusBadge label={n.isRead ? t('alertsPage.read') : t('alertsPage.unread')} color={n.isRead ? '#16a34a' : '#dc2626'} bg={n.isRead ? '#d1fae5' : '#fef2f2'} /></td>}
                    {visibleCols.has('created_at')  && <td style={{ padding: '10px 10px', fontSize: 11, color: 'var(--ink-faint)', whiteSpace: 'nowrap' }}>{new Date(n.createdAt).toLocaleString()}</td>}
                    <td style={{ padding: '10px 10px' }}>
                      {!n.isRead && (
                        <button onClick={() => void markRead(n.id)}
                          style={{ fontSize: 10, color: 'var(--primary)', background: 'none', border: '1px solid var(--border)', borderRadius: 5, padding: '3px 8px', cursor: 'pointer', fontFamily: 'inherit', fontWeight: 600 }}>
                          {t('alertsPage.markRead')}
                        </button>
                      )}
                    </td>
                  </tr>
                )
              })}
              {!loading && filtered.length === 0 && (
                <tr><td colSpan={10} style={{ padding: 28, textAlign: 'center', color: 'var(--ink-muted)', fontSize: 13 }}>
                  {alerts.length === 0 ? t('alertsPage.emptyBranch') : t('alertsPage.emptyFiltered')}
                </td></tr>
              )}
            </tbody>
          </table>
        </div>
        <div style={{ marginTop: 10, fontSize: 11, color: 'var(--ink-faint)' }}>
          {t('alertsPage.footerCount', { count: filtered.length })} · {t('alertsPage.footerColumns', { visible: visibleCols.size, total: COLUMN_DEFS.length })}
        </div>
      </Card>
    </div>
  )
}
