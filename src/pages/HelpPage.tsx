import { useState, useMemo, useEffect, useCallback } from 'react'
import { listMySupportTickets, submitSupportTicket, type MyTicketRow, type TicketPriority } from '../lib/tickets'
import { errorMessage } from '../lib/supabase'
import { Card, StatusBadge, Modal, Btn, ColumnPicker } from '../components'

type ColKey = 'priority' | 'status' | 'created_at' | 'description'

const COLUMN_DEFS: { key: ColKey; label: string }[] = [
  { key: 'priority',    label: 'Priority' },
  { key: 'status',      label: 'Status' },
  { key: 'created_at',  label: 'Date' },
  { key: 'description', label: 'Description' },
]

const DEFAULT_VISIBLE = new Set<ColKey>(['priority', 'status', 'created_at'])

const statusColors: Record<string, { c: string; bg: string }> = {
  open:        { c: '#dc2626', bg: '#fef2f2' },
  in_progress: { c: '#d97706', bg: '#fef3c7' },
  resolved:    { c: '#16a34a', bg: '#d1fae5' },
  closed:      { c: '#6b7280', bg: '#f3f4f6' },
}

const priorityColors: Record<TicketPriority, { c: string; bg: string }> = {
  high:   { c: '#dc2626', bg: '#fef2f2' },
  medium: { c: '#d97706', bg: '#fef3c7' },
  low:    { c: '#6b7280', bg: '#f3f4f6' },
}

function TicketModal({ ticket, onClose }: { ticket: MyTicketRow; onClose: () => void }) {
  const sc = statusColors[ticket.status] ?? statusColors.open
  const pc = priorityColors[ticket.priority]
  return (
    <Modal title={ticket.subject} onClose={onClose} width={520}>
      <div style={{ display: 'flex', flexDirection: 'column', gap: 14 }}>
        <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 8 }}>
          <div style={{ background: 'var(--bg)', borderRadius: 7, padding: '9px 10px' }}>
            <div style={{ fontSize: 9, fontWeight: 600, color: 'var(--ink-muted)', textTransform: 'uppercase', letterSpacing: '0.05em', marginBottom: 2 }}>Created At</div>
            <div style={{ fontSize: 12, fontWeight: 600, color: 'var(--ink)' }}>{new Date(ticket.created_at).toLocaleString()}</div>
          </div>
          <div style={{ background: 'var(--bg)', borderRadius: 7, padding: '9px 10px' }}>
            <div style={{ fontSize: 9, fontWeight: 600, color: 'var(--ink-muted)', textTransform: 'uppercase', letterSpacing: '0.05em', marginBottom: 4 }}>Priority</div>
            <StatusBadge label={ticket.priority} color={pc.c} bg={pc.bg} />
          </div>
          <div style={{ background: 'var(--bg)', borderRadius: 7, padding: '9px 10px' }}>
            <div style={{ fontSize: 9, fontWeight: 600, color: 'var(--ink-muted)', textTransform: 'uppercase', letterSpacing: '0.05em', marginBottom: 4 }}>Status</div>
            <StatusBadge label={ticket.status.replace('_', ' ')} color={sc.c} bg={sc.bg} />
          </div>
        </div>
        {ticket.description && (
          <div style={{ background: 'var(--bg)', borderRadius: 8, padding: '12px 14px' }}>
            <div style={{ fontSize: 10, fontWeight: 600, color: 'var(--ink-muted)', textTransform: 'uppercase', letterSpacing: '0.05em', marginBottom: 6 }}>Description</div>
            <p style={{ margin: 0, fontSize: 13, color: 'var(--ink)', lineHeight: 1.6 }}>{ticket.description}</p>
          </div>
        )}
        <p style={{ margin: 0, fontSize: 11, color: 'var(--ink-faint)' }}>Only the super admin can change a ticket's status.</p>
        <div style={{ display: 'flex', gap: 8, justifyContent: 'flex-end' }}>
          <Btn variant="ghost" onClick={onClose}>Close</Btn>
        </div>
      </div>
    </Modal>
  )
}

function NewTicketModal({ onClose, onSubmitted }: { onClose: () => void; onSubmitted: () => void }) {
  const [subject, setSubject] = useState('')
  const [description, setDescription] = useState('')
  const [priority, setPriority] = useState<TicketPriority>('medium')
  const [error, setError] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)
  const inputStyle = { width: '100%', padding: '8px 10px', border: '1px solid var(--border)', borderRadius: 7, fontSize: 12, fontFamily: 'inherit', outline: 'none', boxSizing: 'border-box' as const }

  async function submit() {
    if (!subject.trim()) { setError('A subject is required.'); return }
    setBusy(true)
    setError(null)
    try {
      await submitSupportTicket(subject.trim(), description.trim(), priority)
      onSubmitted()
    } catch (reason) {
      setError(errorMessage(reason, 'Could not submit this ticket.'))
    } finally {
      setBusy(false)
    }
  }

  return (
    <Modal title="Submit Support Ticket" onClose={onClose} width={480}>
      <div style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
        {error && <p style={{ margin: 0, fontSize: 12, color: '#dc2626' }}>{error}</p>}
        <div>
          <label style={{ fontSize: 10, fontWeight: 600, color: 'var(--ink-muted)', textTransform: 'uppercase', letterSpacing: '0.05em', display: 'block', marginBottom: 4 }}>Subject *</label>
          <input value={subject} onChange={e => setSubject(e.target.value)} placeholder="Brief summary of the issue…"
            style={inputStyle}
            onFocus={e => e.target.style.borderColor = 'var(--primary)'}
            onBlur={e => e.target.style.borderColor = 'var(--border)'}
          />
        </div>
        <div>
          <label style={{ fontSize: 10, fontWeight: 600, color: 'var(--ink-muted)', textTransform: 'uppercase', letterSpacing: '0.05em', display: 'block', marginBottom: 4 }}>Priority</label>
          <div style={{ display: 'flex', gap: 6 }}>
            {(['low', 'medium', 'high'] as TicketPriority[]).map(p => {
              const pc = priorityColors[p]
              return (
                <button key={p} type="button" onClick={() => setPriority(p)}
                  style={{ flex: 1, padding: '6px 10px', borderRadius: 7, border: `1px solid ${priority === p ? pc.c : 'var(--border)'}`, background: priority === p ? pc.bg : '#fff', color: priority === p ? pc.c : 'var(--ink-mid)', fontSize: 11, fontWeight: 600, cursor: 'pointer', fontFamily: 'inherit', textTransform: 'capitalize' }}
                >{p}</button>
              )
            })}
          </div>
        </div>
        <div>
          <label style={{ fontSize: 10, fontWeight: 600, color: 'var(--ink-muted)', textTransform: 'uppercase', letterSpacing: '0.05em', display: 'block', marginBottom: 4 }}>Description</label>
          <textarea value={description} onChange={e => setDescription(e.target.value)} placeholder="Describe the issue in detail…"
            rows={5} style={{ ...inputStyle, resize: 'vertical' }}
            onFocus={e => e.target.style.borderColor = 'var(--primary)'}
            onBlur={e => e.target.style.borderColor = 'var(--border)'}
          />
        </div>
        <div style={{ display: 'flex', gap: 8, justifyContent: 'flex-end' }}>
          <Btn variant="ghost" onClick={onClose}>Cancel</Btn>
          <Btn variant="primary" onClick={() => void submit()}>{busy ? 'Submitting…' : 'Submit Ticket'}</Btn>
        </div>
      </div>
    </Modal>
  )
}

export default function HelpPage() {
  const [tickets, setTickets] = useState<MyTicketRow[]>([])
  const [loading, setLoading] = useState(true)
  const [loadError, setLoadError] = useState<string | null>(null)
  const [selected, setSelected]       = useState<MyTicketRow | null>(null)
  const [showNew, setShowNew]         = useState(false)
  const [statusFilter, setStatusFilter] = useState('all')
  const [search, setSearch]           = useState('')
  const [visibleCols, setVisibleCols] = useState<Set<ColKey>>(new Set(DEFAULT_VISIBLE))

  const refresh = useCallback(async () => {
    setLoading(true)
    setLoadError(null)
    try {
      setTickets(await listMySupportTickets())
    } catch (reason) {
      setLoadError(errorMessage(reason, 'Unable to load your tickets from the database.'))
    } finally {
      setLoading(false)
    }
  }, [])

  useEffect(() => { void refresh() }, [refresh])

  const toggleCol = (key: ColKey) =>
    setVisibleCols(prev => { const next = new Set(prev); next.has(key) ? next.delete(key) : next.add(key); return next })

  const filtered = useMemo(() => {
    let ts = tickets
    if (statusFilter !== 'all') ts = ts.filter(t => t.status === statusFilter)
    if (search) { const q = search.toLowerCase(); ts = ts.filter(t => t.subject.toLowerCase().includes(q) || (t.description ?? '').toLowerCase().includes(q)) }
    return [...ts].sort((a, b) => new Date(b.created_at).getTime() - new Date(a.created_at).getTime())
  }, [tickets, statusFilter, search])

  const counts = {
    open: tickets.filter(t => t.status === 'open').length,
    in_progress: tickets.filter(t => t.status === 'in_progress').length,
    resolved: tickets.filter(t => t.status === 'resolved').length,
    closed: tickets.filter(t => t.status === 'closed').length,
  }

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 16 }}>
      {loadError && <div style={{ background: '#fef2f2', color: '#b91c1c', border: '1px solid #fecaca', borderRadius: 10, padding: '12px 14px', fontSize: 12 }}>{loadError}</div>}

      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(4, 1fr)', gap: 10 }}>
        {([['open','Open'],['in_progress','In Progress'],['resolved','Resolved'],['closed','Closed']] as const).map(([k, l]) => {
          const c = statusColors[k]
          return (
            <div key={k} onClick={() => setStatusFilter(statusFilter === k ? 'all' : k)}
              style={{ background: statusFilter === k ? c.bg : '#fff', border: `1.5px solid ${statusFilter === k ? c.c + '60' : 'var(--border)'}`, borderRadius: 10, padding: '12px 16px', cursor: 'pointer', display: 'flex', alignItems: 'center', gap: 10 }}>
              <div style={{ fontSize: 22, fontWeight: 800, color: c.c, fontFamily: 'DM Sans' }}>{loading ? '—' : counts[k]}</div>
              <div style={{ fontSize: 11, fontWeight: 600, color: 'var(--ink)' }}>{l}</div>
            </div>
          )
        })}
      </div>

      <Card>
        <div style={{ display: 'flex', gap: 8, marginBottom: 14, flexWrap: 'wrap', alignItems: 'center' }}>
          <h2 style={{ margin: 0, fontSize: 14, fontWeight: 600, color: 'var(--ink)', flex: 1 }}>Support Tickets</h2>
          <div style={{ position: 'relative', width: 200 }}>
            <span style={{ position: 'absolute', left: 8, top: '50%', transform: 'translateY(-50%)', fontSize: 11, color: 'var(--ink-faint)' }}>🔍</span>
            <input value={search} onChange={e => setSearch(e.target.value)} placeholder="Search tickets…"
              style={{ width: '100%', padding: '6px 8px 6px 24px', border: '1px solid var(--border)', borderRadius: 7, fontSize: 11, fontFamily: 'inherit', outline: 'none', background: 'var(--bg)', boxSizing: 'border-box' as const }}
              onFocus={e => e.target.style.borderColor = 'var(--primary)'}
              onBlur={e => e.target.style.borderColor = 'var(--border)'}
            />
          </div>
          <ColumnPicker columns={COLUMN_DEFS} visible={visibleCols} onToggle={toggleCol} />
          <Btn variant="secondary" small onClick={() => void refresh()}>Refresh</Btn>
          <Btn variant="primary" small onClick={() => setShowNew(true)}>+ New Ticket</Btn>
        </div>

        <div style={{ overflowX: 'auto' }}>
          <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 12 }}>
            <thead>
              <tr style={{ borderBottom: '1px solid var(--border)' }}>
                <th style={{ textAlign: 'left', padding: '7px 10px', fontSize: 10, fontWeight: 600, color: 'var(--ink-muted)', textTransform: 'uppercase', letterSpacing: '0.04em' }}>Subject</th>
                {visibleCols.has('priority')     && <th style={{ textAlign: 'left', padding: '7px 10px', fontSize: 10, fontWeight: 600, color: 'var(--ink-muted)', textTransform: 'uppercase', letterSpacing: '0.04em' }}>Priority</th>}
                {visibleCols.has('status')       && <th style={{ textAlign: 'left', padding: '7px 10px', fontSize: 10, fontWeight: 600, color: 'var(--ink-muted)', textTransform: 'uppercase', letterSpacing: '0.04em' }}>Status</th>}
                {visibleCols.has('created_at')   && <th style={{ textAlign: 'left', padding: '7px 10px', fontSize: 10, fontWeight: 600, color: 'var(--ink-muted)', textTransform: 'uppercase', letterSpacing: '0.04em' }}>Date</th>}
                {visibleCols.has('description')  && <th style={{ textAlign: 'left', padding: '7px 10px', fontSize: 10, fontWeight: 600, color: 'var(--ink-muted)', textTransform: 'uppercase', letterSpacing: '0.04em' }}>Description</th>}
                <th></th>
              </tr>
            </thead>
            <tbody>
              {filtered.map(t => {
                const sc = statusColors[t.status] ?? statusColors.open
                const pc = priorityColors[t.priority]
                return (
                  <tr key={t.id} style={{ borderBottom: '1px solid var(--bg-alt)', cursor: 'pointer', transition: 'background 0.12s' }}
                    onMouseEnter={e => (e.currentTarget.style.background = 'var(--bg)')}
                    onMouseLeave={e => (e.currentTarget.style.background = 'transparent')}
                    onClick={() => setSelected(t)}
                  >
                    <td style={{ padding: '9px 10px', fontWeight: 600, color: 'var(--ink)', maxWidth: 280 }}>
                      <div style={{ whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>{t.subject}</div>
                    </td>
                    {visibleCols.has('priority')    && <td style={{ padding: '9px 10px' }}><StatusBadge label={t.priority} color={pc.c} bg={pc.bg} /></td>}
                    {visibleCols.has('status')      && <td style={{ padding: '9px 10px' }}><StatusBadge label={t.status.replace('_', ' ')} color={sc.c} bg={sc.bg} /></td>}
                    {visibleCols.has('created_at')  && <td style={{ padding: '9px 10px', fontSize: 11, color: 'var(--ink-faint)', whiteSpace: 'nowrap' }}>{new Date(t.created_at).toLocaleDateString()}</td>}
                    {visibleCols.has('description') && <td style={{ padding: '9px 10px', fontSize: 11, color: 'var(--ink-muted)', maxWidth: 200 }}>
                      <div style={{ whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>{t.description ?? '—'}</div>
                    </td>}
                    <td style={{ padding: '9px 10px' }}>
                      <button onClick={e => { e.stopPropagation(); setSelected(t) }}
                        style={{ fontSize: 11, color: 'var(--primary)', background: 'none', border: 'none', cursor: 'pointer', fontWeight: 600, fontFamily: 'inherit' }}>View →</button>
                    </td>
                  </tr>
                )
              })}
              {!loading && filtered.length === 0 && (
                <tr><td colSpan={10} style={{ padding: 28, textAlign: 'center', color: 'var(--ink-muted)', fontSize: 13 }}>
                  {tickets.length === 0 ? "You haven't submitted any tickets yet." : 'No tickets found.'}
                </td></tr>
              )}
            </tbody>
          </table>
        </div>
        <div style={{ marginTop: 10, fontSize: 11, color: 'var(--ink-faint)' }}>
          {filtered.length} ticket{filtered.length !== 1 ? 's' : ''} · {visibleCols.size} of {COLUMN_DEFS.length} extra columns visible
        </div>
      </Card>

      {selected  && <TicketModal ticket={selected} onClose={() => setSelected(null)} />}
      {showNew   && <NewTicketModal onClose={() => setShowNew(false)} onSubmitted={() => { setShowNew(false); void refresh() }} />}
    </div>
  )
}
