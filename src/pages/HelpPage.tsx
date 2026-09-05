import { useState, useMemo, useEffect, useCallback } from 'react'
import { listMySupportTickets, submitSupportTicket, type MyTicketRow, type TicketPriority } from '../lib/tickets'
import { listMyProductRequests, productRequestImageUrl, submitProductRequest, uploadProductRequestImage, type ProductRequestRow } from '../lib/products'
import { useTranslation } from '../lib/i18n'
import { useGlobalSearch } from '../lib/search'
import { errorMessage } from '../lib/supabase'
import { Card, StatusBadge, Modal, Btn, ColumnPicker } from '../components'

// Product requests (public.product_requests) and support tickets
// (public.support_tickets) stay two separate tables and two separate admin
// review flows -- approving a product request creates a real catalogue
// entry with its own tax/variant setup, nothing like closing a ticket, so
// merging them on the backend would be a much bigger change than what was
// actually asked for. What changed is the FRONT END: there's no longer a
// dedicated "Request Product" page, so a product request is just one
// category of "New Request" here, alongside everything else this page
// already handled. UnifiedRow gives both kinds one shape so the table below
// doesn't need two parallel render paths for what a user experiences as one
// list of "things I've asked for."

type ColKey = 'type' | 'priority' | 'status' | 'created_at' | 'description'

const DEFAULT_VISIBLE = new Set<ColKey>(['type', 'priority', 'status', 'created_at'])

const statusColors: Record<string, { c: string; bg: string }> = {
  open:        { c: '#dc2626', bg: '#fef2f2' },
  in_progress: { c: '#d97706', bg: '#fef3c7' },
  resolved:    { c: '#16a34a', bg: '#d1fae5' },
  closed:      { c: '#6b7280', bg: '#f3f4f6' },
  pending:     { c: '#b45309', bg: '#fef3c7' },
  approved:    { c: '#16a34a', bg: '#dcfce7' },
  rejected:    { c: '#b91c1c', bg: '#fef2f2' },
}

const priorityColors: Record<TicketPriority, { c: string; bg: string }> = {
  high:   { c: '#dc2626', bg: '#fef2f2' },
  medium: { c: '#d97706', bg: '#fef3c7' },
  low:    { c: '#6b7280', bg: '#f3f4f6' },
}

// 'product' submits to product_requests via submitProductRequest(); every
// other category submits to support_tickets via submitSupportTicket(), with
// the category folded into the subject as a "[Tag] " prefix -- support
// tickets have no category column of their own, and adding one (plus
// teaching AdminPortal's ticket view about it) is a bigger change than a
// plain-text tag the admin can already see in the existing subject column.
type TicketCategory = 'product' | 'bug' | 'printer' | 'account' | 'feature' | 'other'

const CATEGORY_TAGS: Record<Exclude<TicketCategory, 'product'>, string> = {
  bug: 'Bug', printer: 'Printer/Scanner', account: 'Account', feature: 'Feature idea', other: 'Other',
}

interface UnifiedRow {
  id: string
  kind: 'product' | 'ticket'
  subject: string
  typeLabel: string
  description: string
  statusKey: string
  statusLabel: string
  priorityLabel: string | null
  priority: TicketPriority | null
  createdAt: string
  imagePath?: string | null
  rejectionReason?: string | null
}

function truncate(text: string, max: number): string {
  return text.length > max ? `${text.slice(0, max)}…` : text
}

function DetailModal({ row, onClose }: { row: UnifiedRow; onClose: () => void }) {
  const { t } = useTranslation()
  const sc = statusColors[row.statusKey] ?? statusColors.open
  return (
    <Modal title={row.kind === 'product' ? t('helpPage.typeProduct') : row.subject} onClose={onClose} width={520}>
      <div style={{ display: 'flex', flexDirection: 'column', gap: 14 }}>
        <div style={{ display: 'grid', gridTemplateColumns: row.priorityLabel ? '1fr 1fr 1fr' : '1fr 1fr', gap: 8 }}>
          <div style={{ background: 'var(--bg)', borderRadius: 7, padding: '9px 10px' }}>
            <div style={{ fontSize: 9, fontWeight: 600, color: 'var(--ink-muted)', textTransform: 'uppercase', letterSpacing: '0.05em', marginBottom: 2 }}>{t('helpPage.modalCreatedAt')}</div>
            <div style={{ fontSize: 12, fontWeight: 600, color: 'var(--ink)' }}>{new Date(row.createdAt).toLocaleString()}</div>
          </div>
          {row.priorityLabel && (
            <div style={{ background: 'var(--bg)', borderRadius: 7, padding: '9px 10px' }}>
              <div style={{ fontSize: 9, fontWeight: 600, color: 'var(--ink-muted)', textTransform: 'uppercase', letterSpacing: '0.05em', marginBottom: 4 }}>{t('helpPage.modalPriority')}</div>
              <StatusBadge label={row.priorityLabel} color={priorityColors[row.priority!].c} bg={priorityColors[row.priority!].bg} />
            </div>
          )}
          <div style={{ background: 'var(--bg)', borderRadius: 7, padding: '9px 10px' }}>
            <div style={{ fontSize: 9, fontWeight: 600, color: 'var(--ink-muted)', textTransform: 'uppercase', letterSpacing: '0.05em', marginBottom: 4 }}>{t('helpPage.modalStatus')}</div>
            <StatusBadge label={row.statusLabel} color={sc.c} bg={sc.bg} />
          </div>
        </div>
        {row.description && (
          <div style={{ background: 'var(--bg)', borderRadius: 8, padding: '12px 14px' }}>
            <div style={{ fontSize: 10, fontWeight: 600, color: 'var(--ink-muted)', textTransform: 'uppercase', letterSpacing: '0.05em', marginBottom: 6 }}>
              {row.kind === 'product' ? t('requestProduct.describeLabel') : t('helpPage.modalDescription')}
            </div>
            <p style={{ margin: 0, fontSize: 13, color: 'var(--ink)', lineHeight: 1.6 }}>{row.description}</p>
          </div>
        )}
        {row.imagePath && (
          <img src={productRequestImageUrl(row.imagePath)} alt="" style={{ maxWidth: '100%', maxHeight: 220, borderRadius: 8, border: '1px solid var(--border)' }} />
        )}
        {row.rejectionReason && (
          <div style={{ background: '#fef2f2', border: '1px solid #fecaca', borderRadius: 8, padding: '10px 12px' }}>
            <div style={{ fontSize: 10, fontWeight: 600, color: '#b91c1c', textTransform: 'uppercase', letterSpacing: '0.05em', marginBottom: 4 }}>{t('requestProduct.reasonPrefix')}</div>
            <p style={{ margin: 0, fontSize: 12, color: '#b91c1c' }}>{row.rejectionReason}</p>
          </div>
        )}
        <p style={{ margin: 0, fontSize: 11, color: 'var(--ink-faint)' }}>{t('helpPage.modalAdminOnlyNotice')}</p>
        <div style={{ display: 'flex', gap: 8, justifyContent: 'flex-end' }}>
          <Btn variant="ghost" onClick={onClose}>{t('helpPage.close')}</Btn>
        </div>
      </div>
    </Modal>
  )
}

function NewRequestModal({ onClose, onSubmitted }: { onClose: () => void; onSubmitted: () => void }) {
  const { t } = useTranslation()
  const priorityLabels: Record<TicketPriority, string> = { low: t('helpPage.priorityLow'), medium: t('helpPage.priorityMedium'), high: t('helpPage.priorityHigh') }

  const CATEGORIES: { id: TicketCategory; icon: string; label: string; hint: string }[] = [
    { id: 'product', icon: '💊', label: t('helpPage.catProduct'), hint: t('helpPage.catProductHint') },
    { id: 'bug',     icon: '🐛', label: t('helpPage.catBug'), hint: t('helpPage.catBugHint') },
    { id: 'printer', icon: '🖨️', label: t('helpPage.catPrinter'), hint: t('helpPage.catPrinterHint') },
    { id: 'account', icon: '🔒', label: t('helpPage.catAccount'), hint: t('helpPage.catAccountHint') },
    { id: 'feature', icon: '💡', label: t('helpPage.catFeature'), hint: t('helpPage.catFeatureHint') },
    { id: 'other',   icon: '❓', label: t('helpPage.catOther'), hint: t('helpPage.catOtherHint') },
  ]

  const [category, setCategory] = useState<TicketCategory | null>(null)
  // Product-request fields
  const [message, setMessage] = useState('')
  const [file, setFile] = useState<File | null>(null)
  const [preview, setPreview] = useState<string | null>(null)
  // Generic ticket fields
  const [subject, setSubject] = useState('')
  const [description, setDescription] = useState('')
  const [priority, setPriority] = useState<TicketPriority>('medium')

  const [error, setError] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)

  function chooseCategory(next: TicketCategory) {
    setCategory(next)
    setError(null)
    if (next !== 'product') setSubject(`[${CATEGORY_TAGS[next]}] `)
  }

  function pickFile(f: File | null) {
    setFile(f)
    setPreview(f ? URL.createObjectURL(f) : null)
  }

  async function submit() {
    setError(null)
    if (category === 'product') {
      if (!message.trim()) { setError(t('requestProduct.describeRequired')); return }
      setBusy(true)
      try {
        const imagePath = file ? await uploadProductRequestImage(file) : undefined
        await submitProductRequest(message.trim(), imagePath)
        onSubmitted()
      } catch (reason) {
        setError(errorMessage(reason, t('requestProduct.submitError')))
      } finally {
        setBusy(false)
      }
      return
    }
    if (!subject.trim()) { setError(t('helpPage.subjectRequired')); return }
    setBusy(true)
    try {
      await submitSupportTicket(subject.trim(), description.trim(), priority)
      onSubmitted()
    } catch (reason) {
      setError(errorMessage(reason, t('helpPage.submitError')))
    } finally {
      setBusy(false)
    }
  }

  const inputStyle = { width: '100%', padding: '8px 10px', border: '1px solid var(--border)', borderRadius: 7, fontSize: 12, fontFamily: 'inherit', outline: 'none', boxSizing: 'border-box' as const }

  return (
    <Modal title={t('helpPage.newTicketTitle')} onClose={onClose} width={560}>
      <div style={{ display: 'flex', flexDirection: 'column', gap: 14 }}>
        <p style={{ margin: 0, fontSize: 11, color: 'var(--ink-muted)', lineHeight: 1.5 }}>{t('helpPage.newRequestIntro')}</p>

        {!category && (
          <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 8 }}>
            {CATEGORIES.map(opt => (
              <button
                key={opt.id}
                type="button"
                onClick={() => chooseCategory(opt.id)}
                style={{
                  textAlign: 'left', padding: '10px 12px', borderRadius: 10, cursor: 'pointer', fontFamily: 'inherit',
                  border: '1.5px solid var(--border)', background: '#fff', display: 'flex', gap: 8, alignItems: 'flex-start',
                }}
              >
                <span style={{ fontSize: 17, flexShrink: 0 }}>{opt.icon}</span>
                <span>
                  <div style={{ fontSize: 12, fontWeight: 700, color: 'var(--ink)' }}>{opt.label}</div>
                  <div style={{ fontSize: 10, color: 'var(--ink-muted)', marginTop: 1 }}>{opt.hint}</div>
                </span>
              </button>
            ))}
          </div>
        )}

        {category && (
          <>
            <button
              type="button"
              onClick={() => setCategory(null)}
              style={{ alignSelf: 'flex-start', fontSize: 11, color: 'var(--primary)', background: 'none', border: 'none', cursor: 'pointer', fontFamily: 'inherit', padding: 0 }}
            >
              ← {t('helpPage.changeCategory')}
            </button>

            {error && <p style={{ margin: 0, fontSize: 12, color: '#dc2626' }}>{error}</p>}

            {category === 'product' ? (
              <>
                <div>
                  <label style={{ fontSize: 11, fontWeight: 600, color: 'var(--ink-mid)', display: 'block', marginBottom: 4 }}>{t('requestProduct.describeLabel')}</label>
                  <textarea
                    value={message} onChange={e => setMessage(e.target.value)} rows={5}
                    placeholder={t('requestProduct.describePlaceholder')}
                    style={{ ...inputStyle, resize: 'vertical' }}
                  />
                </div>
                <div>
                  <label style={{ fontSize: 11, fontWeight: 600, color: 'var(--ink-mid)', display: 'block', marginBottom: 4 }}>{t('requestProduct.photoLabel')}</label>
                  <input type="file" accept="image/*" onChange={e => pickFile(e.target.files?.[0] ?? null)} style={{ fontSize: 12 }} />
                  {preview && <img src={preview} alt={t('requestProduct.photoPreviewAlt')} style={{ marginTop: 8, maxWidth: '100%', maxHeight: 160, borderRadius: 8, border: '1px solid var(--border)' }} />}
                </div>
              </>
            ) : (
              <>
                <div>
                  <label style={{ fontSize: 10, fontWeight: 600, color: 'var(--ink-muted)', textTransform: 'uppercase', letterSpacing: '0.05em', display: 'block', marginBottom: 4 }}>{t('helpPage.subjectLabel')}</label>
                  <input value={subject} onChange={e => setSubject(e.target.value)} placeholder={t('helpPage.subjectPlaceholder')} style={inputStyle} />
                </div>
                <div>
                  <label style={{ fontSize: 10, fontWeight: 600, color: 'var(--ink-muted)', textTransform: 'uppercase', letterSpacing: '0.05em', display: 'block', marginBottom: 4 }}>{t('helpPage.priorityLabel')}</label>
                  <div style={{ display: 'flex', gap: 6 }}>
                    {(['low', 'medium', 'high'] as TicketPriority[]).map(p => {
                      const pc = priorityColors[p]
                      return (
                        <button key={p} type="button" onClick={() => setPriority(p)}
                          style={{ flex: 1, padding: '6px 10px', borderRadius: 7, border: `1px solid ${priority === p ? pc.c : 'var(--border)'}`, background: priority === p ? pc.bg : '#fff', color: priority === p ? pc.c : 'var(--ink-mid)', fontSize: 11, fontWeight: 600, cursor: 'pointer', fontFamily: 'inherit' }}
                        >{priorityLabels[p]}</button>
                      )
                    })}
                  </div>
                </div>
                <div>
                  <label style={{ fontSize: 10, fontWeight: 600, color: 'var(--ink-muted)', textTransform: 'uppercase', letterSpacing: '0.05em', display: 'block', marginBottom: 4 }}>{t('helpPage.descriptionLabel')}</label>
                  <textarea value={description} onChange={e => setDescription(e.target.value)} placeholder={t('helpPage.descriptionPlaceholder')} rows={5} style={{ ...inputStyle, resize: 'vertical' }} />
                </div>
              </>
            )}

            <div style={{ display: 'flex', gap: 8, justifyContent: 'flex-end' }}>
              <Btn variant="ghost" onClick={onClose}>{t('helpPage.cancel')}</Btn>
              <Btn variant="primary" onClick={() => void submit()} style={busy ? { opacity: 0.6, pointerEvents: 'none' } : undefined}>
                {busy ? t('helpPage.submitting') : t('helpPage.submitTicket')}
              </Btn>
            </div>
          </>
        )}
      </div>
    </Modal>
  )
}

export default function HelpPage() {
  const { t } = useTranslation()
  const COLUMN_DEFS: { key: ColKey; label: string }[] = [
    { key: 'type',        label: t('helpPage.colType') },
    { key: 'priority',    label: t('helpPage.colPriority') },
    { key: 'status',      label: t('helpPage.colStatus') },
    { key: 'created_at',  label: t('helpPage.colDate') },
    { key: 'description', label: t('helpPage.colDescription') },
  ]
  const statusLabels: Record<string, string> = {
    open: t('helpPage.statusOpen'), in_progress: t('helpPage.statusInProgress'), resolved: t('helpPage.statusResolved'), closed: t('helpPage.statusClosed'),
    pending: t('requestProduct.statusPending'), approved: t('requestProduct.statusApproved'), rejected: t('requestProduct.statusRejected'),
  }
  const priorityLabels: Record<TicketPriority, string> = { low: t('helpPage.priorityLow'), medium: t('helpPage.priorityMedium'), high: t('helpPage.priorityHigh') }

  const [tickets, setTickets] = useState<MyTicketRow[]>([])
  const [productRequests, setProductRequests] = useState<ProductRequestRow[]>([])
  const [loading, setLoading] = useState(true)
  const [loadError, setLoadError] = useState<string | null>(null)
  const [selected, setSelected]       = useState<UnifiedRow | null>(null)
  const [showNew, setShowNew]         = useState(false)
  const [statusFilter, setStatusFilter] = useState('all')
  const { term: globalTerm, setTerm: setGlobalTerm } = useGlobalSearch()
  const [search, setSearch]           = useState(globalTerm)
  useEffect(() => setSearch(globalTerm), [globalTerm])
  const [visibleCols, setVisibleCols] = useState<Set<ColKey>>(new Set(DEFAULT_VISIBLE))

  const refresh = useCallback(async () => {
    setLoading(true)
    setLoadError(null)
    try {
      const [t1, t2] = await Promise.all([listMySupportTickets(), listMyProductRequests()])
      setTickets(t1)
      setProductRequests(t2)
    } catch (reason) {
      setLoadError(errorMessage(reason, t('helpPage.loadError')))
    } finally {
      setLoading(false)
    }
  }, [t])

  useEffect(() => { void refresh() }, [refresh])

  const toggleCol = (key: ColKey) =>
    setVisibleCols(prev => { const next = new Set(prev); next.has(key) ? next.delete(key) : next.add(key); return next })

  // Both sources folded into one list a user experiences as "things I've
  // asked for" -- a ticket's category tag (the "[Tag] " prefix
  // NewRequestModal writes into the subject) is read back here best-effort
  // for the Type column; an untagged subject (typed before this feature
  // existed, or just typed without one) just shows as a plain "Ticket".
  const rows: UnifiedRow[] = useMemo(() => {
    const fromTickets: UnifiedRow[] = tickets.map(tk => {
      const tagMatch = /^\[([^\]]+)]\s*/.exec(tk.subject)
      return {
        id: `ticket-${tk.id}`, kind: 'ticket', subject: tk.subject,
        typeLabel: tagMatch ? tagMatch[1] : t('helpPage.typeTicket'),
        description: tk.description ?? '', statusKey: tk.status, statusLabel: statusLabels[tk.status] ?? tk.status,
        priorityLabel: priorityLabels[tk.priority], priority: tk.priority, createdAt: tk.created_at,
      }
    })
    const fromProducts: UnifiedRow[] = productRequests.map(r => ({
      id: `product-${r.id}`, kind: 'product', subject: truncate(r.message, 60), typeLabel: t('helpPage.typeProduct'),
      description: r.message, statusKey: r.status, statusLabel: statusLabels[r.status] ?? r.status,
      priorityLabel: null, priority: null, createdAt: r.created_at,
      imagePath: r.image_path, rejectionReason: r.rejection_reason,
    }))
    return [...fromTickets, ...fromProducts].sort((a, b) => new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime())
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [tickets, productRequests, t])

  const filtered = useMemo(() => {
    let rs = rows
    if (statusFilter !== 'all') rs = rs.filter(r => r.statusKey === statusFilter)
    if (search) { const q = search.toLowerCase(); rs = rs.filter(r => r.subject.toLowerCase().includes(q) || r.description.toLowerCase().includes(q)) }
    return rs
  }, [rows, statusFilter, search])

  // One combined "needs a look" bucket (open tickets + pending product
  // requests) plus resolved/closed/approved/rejected, rather than exposing
  // seven raw statuses across two different vocabularies as separate tiles.
  const counts = {
    needsReview: rows.filter(r => r.statusKey === 'open' || r.statusKey === 'pending').length,
    in_progress: rows.filter(r => r.statusKey === 'in_progress').length,
    done: rows.filter(r => r.statusKey === 'resolved' || r.statusKey === 'approved').length,
    closed: rows.filter(r => r.statusKey === 'closed' || r.statusKey === 'rejected').length,
  }

  return (
    <div className="animate-fade-in" style={{ display: 'flex', flexDirection: 'column', gap: 16 }}>
      {loadError && <div style={{ background: '#fef2f2', color: '#b91c1c', border: '1px solid #fecaca', borderRadius: 10, padding: '12px 14px', fontSize: 12 }}>{loadError}</div>}

      <div style={{ background: 'var(--primary-light)', border: '1px solid var(--border)', borderRadius: 10, padding: '12px 16px', display: 'flex', gap: 12, alignItems: 'flex-start' }}>
        <span style={{ fontSize: 18, flexShrink: 0 }}>🎫</span>
        <div>
          <div style={{ fontSize: 12, fontWeight: 700, color: 'var(--ink)' }}>{t('helpPage.explainerTitle')}</div>
          <div style={{ fontSize: 11, color: 'var(--ink-mid)', marginTop: 3, lineHeight: 1.5 }}>{t('helpPage.explainerBody')}</div>
        </div>
      </div>

      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(4, 1fr)', gap: 10 }}>
        {([
          ['needsReview', 'open', t('helpPage.tileNeedsReview')],
          ['in_progress', 'in_progress', statusLabels.in_progress],
          ['done', 'resolved', t('helpPage.tileDone')],
          ['closed', 'closed', t('helpPage.tileClosed')],
        ] as const).map(([countKey, filterKey, label], i) => {
          const c = statusColors[filterKey]
          return (
            <div key={countKey} onClick={() => setStatusFilter(statusFilter === filterKey ? 'all' : filterKey)}
              className="animate-fade-up" style={{ animationDelay: `${i * 60}ms`, background: statusFilter === filterKey ? c.bg : '#fff', border: `1.5px solid ${statusFilter === filterKey ? c.c + '60' : 'var(--border)'}`, borderRadius: 10, padding: '12px 16px', cursor: 'pointer', display: 'flex', alignItems: 'center', gap: 10 }}>
              <div style={{ fontSize: 22, fontWeight: 800, color: c.c, fontFamily: 'var(--font-display)' }}>{loading ? '—' : counts[countKey]}</div>
              <div style={{ fontSize: 11, fontWeight: 600, color: 'var(--ink)' }}>{label}</div>
            </div>
          )
        })}
      </div>

      <Card>
        <div style={{ display: 'flex', gap: 8, marginBottom: 14, flexWrap: 'wrap', alignItems: 'center' }}>
          <h2 style={{ margin: 0, fontSize: 14, fontWeight: 600, color: 'var(--ink)', flex: 1 }}>{t('helpPage.title')}</h2>
          <div style={{ position: 'relative', width: 200 }}>
            <span style={{ position: 'absolute', left: 8, top: '50%', transform: 'translateY(-50%)', fontSize: 11, color: 'var(--ink-faint)' }}>🔍</span>
            <input value={search} onChange={e => { setSearch(e.target.value); setGlobalTerm(e.target.value) }} placeholder={t('helpPage.searchPlaceholder')}
              style={{ width: '100%', padding: '6px 8px 6px 24px', border: '1px solid var(--border)', borderRadius: 7, fontSize: 11, fontFamily: 'inherit', outline: 'none', background: 'var(--bg)', boxSizing: 'border-box' as const }}
              onFocus={e => e.target.style.borderColor = 'var(--primary)'}
              onBlur={e => e.target.style.borderColor = 'var(--border)'}
            />
          </div>
          <ColumnPicker columns={COLUMN_DEFS} visible={visibleCols} onToggle={toggleCol} />
          <Btn variant="secondary" small onClick={() => void refresh()}>{t('helpPage.refresh')}</Btn>
          <Btn variant="primary" small onClick={() => setShowNew(true)}>{t('helpPage.newTicketButton')}</Btn>
        </div>

        <div style={{ overflowX: 'auto' }}>
          <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 12 }}>
            <thead>
              <tr style={{ borderBottom: '1px solid var(--border)' }}>
                <th style={{ textAlign: 'left', padding: '7px 10px', fontSize: 10, fontWeight: 600, color: 'var(--ink-muted)', textTransform: 'uppercase', letterSpacing: '0.04em' }}>{t('helpPage.colSubject')}</th>
                {visibleCols.has('type')         && <th style={{ textAlign: 'left', padding: '7px 10px', fontSize: 10, fontWeight: 600, color: 'var(--ink-muted)', textTransform: 'uppercase', letterSpacing: '0.04em' }}>{t('helpPage.colType')}</th>}
                {visibleCols.has('priority')     && <th style={{ textAlign: 'left', padding: '7px 10px', fontSize: 10, fontWeight: 600, color: 'var(--ink-muted)', textTransform: 'uppercase', letterSpacing: '0.04em' }}>{t('helpPage.colPriority')}</th>}
                {visibleCols.has('status')       && <th style={{ textAlign: 'left', padding: '7px 10px', fontSize: 10, fontWeight: 600, color: 'var(--ink-muted)', textTransform: 'uppercase', letterSpacing: '0.04em' }}>{t('helpPage.colStatus')}</th>}
                {visibleCols.has('created_at')   && <th style={{ textAlign: 'left', padding: '7px 10px', fontSize: 10, fontWeight: 600, color: 'var(--ink-muted)', textTransform: 'uppercase', letterSpacing: '0.04em' }}>{t('helpPage.colDate')}</th>}
                {visibleCols.has('description')  && <th style={{ textAlign: 'left', padding: '7px 10px', fontSize: 10, fontWeight: 600, color: 'var(--ink-muted)', textTransform: 'uppercase', letterSpacing: '0.04em' }}>{t('helpPage.colDescription')}</th>}
                <th></th>
              </tr>
            </thead>
            <tbody>
              {filtered.map(row => {
                const sc = statusColors[row.statusKey] ?? statusColors.open
                return (
                  <tr key={row.id} style={{ borderBottom: '1px solid var(--bg-alt)', cursor: 'pointer', transition: 'background 0.12s' }}
                    onMouseEnter={e => (e.currentTarget.style.background = 'var(--bg)')}
                    onMouseLeave={e => (e.currentTarget.style.background = 'transparent')}
                    onClick={() => setSelected(row)}
                  >
                    <td style={{ padding: '9px 10px', fontWeight: 600, color: 'var(--ink)', maxWidth: 280 }}>
                      <div style={{ whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>{row.subject}</div>
                    </td>
                    {visibleCols.has('type')        && <td style={{ padding: '9px 10px', fontSize: 11, color: 'var(--ink-mid)' }}>{row.typeLabel}</td>}
                    {visibleCols.has('priority')    && <td style={{ padding: '9px 10px' }}>{row.priorityLabel && <StatusBadge label={row.priorityLabel} color={priorityColors[row.priority!].c} bg={priorityColors[row.priority!].bg} />}</td>}
                    {visibleCols.has('status')      && <td style={{ padding: '9px 10px' }}><StatusBadge label={row.statusLabel} color={sc.c} bg={sc.bg} /></td>}
                    {visibleCols.has('created_at')  && <td style={{ padding: '9px 10px', fontSize: 11, color: 'var(--ink-faint)', whiteSpace: 'nowrap' }}>{new Date(row.createdAt).toLocaleDateString()}</td>}
                    {visibleCols.has('description') && <td style={{ padding: '9px 10px', fontSize: 11, color: 'var(--ink-muted)', maxWidth: 200 }}>
                      <div style={{ whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>{row.description || '—'}</div>
                    </td>}
                    <td style={{ padding: '9px 10px' }}>
                      <button onClick={e => { e.stopPropagation(); setSelected(row) }}
                        style={{ fontSize: 11, color: 'var(--primary)', background: 'none', border: 'none', cursor: 'pointer', fontWeight: 600, fontFamily: 'inherit' }}>{t('helpPage.view')}</button>
                    </td>
                  </tr>
                )
              })}
              {!loading && filtered.length === 0 && (
                <tr><td colSpan={10} style={{ padding: 28, textAlign: 'center', color: 'var(--ink-muted)', fontSize: 13 }}>
                  {rows.length === 0 ? t('helpPage.emptyNone') : t('helpPage.emptyFiltered')}
                </td></tr>
              )}
            </tbody>
          </table>
        </div>
        <div style={{ marginTop: 10, fontSize: 11, color: 'var(--ink-faint)' }}>
          {t('helpPage.footerCount', { count: filtered.length })} · {t('helpPage.footerColumns', { visible: visibleCols.size, total: COLUMN_DEFS.length })}
        </div>
      </Card>

      {selected  && <DetailModal row={selected} onClose={() => setSelected(null)} />}
      {showNew   && <NewRequestModal onClose={() => setShowNew(false)} onSubmitted={() => { setShowNew(false); void refresh() }} />}
    </div>
  )
}
