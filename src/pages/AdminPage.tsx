import { useState } from 'react'
import { BarChart, Bar, XAxis, YAxis, CartesianGrid, Tooltip, ResponsiveContainer, Cell } from 'recharts'
import {
  branchRegistry, helpTickets, fmtRWF,
  type BranchRecord, type HelpTicket, type TicketStatus,
} from '../data'
import { Card, SectionHeader, StatusBadge, Modal, Btn, ProgressBar, ChartTooltip } from '../components'

// ─── Helpers ──────────────────────────────────────────────────────────────────

function ticketStatusColor(s: TicketStatus) {
  if (s === 'open')        return { c: '#d97706', bg: '#fef3c7' }
  if (s === 'in_progress') return { c: '#0284c7', bg: '#e0f2fe' }
  if (s === 'resolved')    return { c: '#16a34a', bg: '#d1fae5' }
  return                          { c: '#6b7280', bg: '#f3f4f6' }
}

function ticketTypeIcon(t: string) {
  if (t === 'help')       return '🆘'
  if (t === 'suggestion') return '💡'
  if (t === 'bug')        return '🐛'
  return                        '✨'
}

function generateCode(prefix: string) {
  const chars = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789'
  const seg1 = Array.from({ length: 4 }, () => chars[Math.floor(Math.random() * chars.length)]).join('')
  const seg2 = Array.from({ length: 4 }, () => chars[Math.floor(Math.random() * chars.length)]).join('')
  return `${prefix}-2026-${seg1}${seg2}`
}

// ─── Branch Detail Modal ──────────────────────────────────────────────────────

function BranchModal({ branch, onClose }: { branch: BranchRecord; onClose: () => void }) {
  const [newCode, setNewCode] = useState<string | null>(null)
  const [copied, setCopied] = useState(false)

  const generate = () => {
    const prefix = branch.name.slice(0, 3).toUpperCase()
    setNewCode(generateCode(prefix))
    setCopied(false)
  }

  const copy = () => {
    if (newCode) { navigator.clipboard.writeText(newCode).catch(() => {}); setCopied(true) }
  }

  return (
    <Modal title={`Branch — ${branch.name}`} onClose={onClose} width={580}>
      <div style={{ display: 'flex', flexDirection: 'column', gap: 16 }}>
        {/* Info grid */}
        <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 10 }}>
          {[
            ['Branch ID',   branch.id],
            ['Manager',     branch.manager],
            ['Address',     branch.address],
            ['Phone',       branch.phone],
            ['TIN Number',  branch.tin],
            ['Registered',  branch.registeredAt],
            ['Monthly Rev', fmtRWF(branch.revenue)],
            ['Staff Count', `${branch.staff} people`],
          ].map(([l, v]) => (
            <div key={l} style={{ background: 'var(--bg)', borderRadius: 8, padding: '10px 12px' }}>
              <div style={{ fontSize: 10, color: 'var(--ink-muted)', fontWeight: 500, textTransform: 'uppercase', letterSpacing: '0.05em', marginBottom: 2 }}>{l}</div>
              <div style={{ fontSize: 13, fontWeight: 600, color: 'var(--ink)' }}>{v}</div>
            </div>
          ))}
        </div>

        {/* Pharmacists */}
        {branch.pharmacists.length > 0 && (
          <div>
            <div style={{ fontSize: 12, fontWeight: 600, color: 'var(--ink)', marginBottom: 8 }}>Registered Pharmacists</div>
            <div style={{ display: 'flex', flexWrap: 'wrap', gap: 6 }}>
              {branch.pharmacists.map(p => (
                <span key={p} style={{ background: 'var(--primary-light)', color: 'var(--primary)', fontSize: 12, fontWeight: 600, padding: '4px 10px', borderRadius: 6 }}>{p}</span>
              ))}
            </div>
          </div>
        )}

        {/* Access Code Section */}
        <div style={{ background: 'var(--bg)', borderRadius: 10, padding: '14px 16px', border: '1px solid var(--border)' }}>
          <div style={{ fontSize: 13, fontWeight: 700, color: 'var(--ink)', marginBottom: 6 }}>🔑 Branch Access Code</div>
          {branch.status === 'pending' ? (
            <div style={{ fontSize: 12, color: 'var(--ink-muted)', marginBottom: 10 }}>
              This branch is pending registration. Generate an access code to allow them to sign in.
            </div>
          ) : (
            <div style={{ marginBottom: 10 }}>
              <div style={{ fontSize: 11, color: 'var(--ink-muted)', marginBottom: 4 }}>Current code:</div>
              <div style={{ fontFamily: 'JetBrains Mono, monospace', fontSize: 16, fontWeight: 700, color: 'var(--primary)', letterSpacing: '0.08em' }}>{branch.accessCode ?? '—'}</div>
              <div style={{ fontSize: 11, color: 'var(--ink-faint)', marginTop: 2 }}>Expires: {branch.accessCodeExpiry ?? 'N/A'}</div>
            </div>
          )}
          {newCode && (
            <div style={{ background: '#f0fdf4', border: '1.5px solid #86efac', borderRadius: 8, padding: '12px 14px', marginBottom: 10 }}>
              <div style={{ fontSize: 11, color: 'var(--ink-muted)', marginBottom: 4 }}>New code generated:</div>
              <div style={{ fontFamily: 'JetBrains Mono, monospace', fontSize: 18, fontWeight: 800, color: '#16a34a', letterSpacing: '0.1em' }}>{newCode}</div>
              <div style={{ fontSize: 11, color: 'var(--ink-muted)', marginTop: 4 }}>Share this code securely with the branch manager. Expires in 12 months.</div>
            </div>
          )}
          <div style={{ display: 'flex', gap: 8 }}>
            <Btn variant="primary" small onClick={generate}>{branch.status === 'pending' ? '✦ Generate First Code' : '🔄 Regenerate Code'}</Btn>
            {newCode && <Btn variant="secondary" small onClick={copy}>{copied ? '✓ Copied!' : '📋 Copy Code'}</Btn>}
          </div>
        </div>

        <div style={{ display: 'flex', gap: 8, justifyContent: 'flex-end' }}>
          <Btn variant="ghost" small onClick={onClose}>View Reports</Btn>
          <Btn variant="primary" small onClick={onClose}>Save Changes</Btn>
        </div>
      </div>
    </Modal>
  )
}

// ─── Ticket Modal (admin reply) ───────────────────────────────────────────────

function TicketModal({ ticket, onClose }: { ticket: HelpTicket; onClose: () => void }) {
  const [reply, setReply] = useState(ticket.adminReply ?? '')
  const [status, setStatus] = useState<TicketStatus>(ticket.status)
  const sc = ticketStatusColor(status)

  return (
    <Modal title={`${ticketTypeIcon(ticket.type)} ${ticket.title}`} onClose={onClose} width={580}>
      <div style={{ display: 'flex', flexDirection: 'column', gap: 14 }}>
        <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
          <StatusBadge label={ticket.type.toUpperCase()} color="var(--primary)" bg="var(--primary-light)" />
          <StatusBadge label={ticket.priority.toUpperCase() + ' PRIORITY'} color={ticket.priority === 'high' ? '#dc2626' : ticket.priority === 'medium' ? '#d97706' : '#16a34a'} bg={ticket.priority === 'high' ? '#fef2f2' : ticket.priority === 'medium' ? '#fef3c7' : '#f0fdf4'} />
          <span style={{ fontSize: 11, color: 'var(--ink-muted)' }}>From: <strong>{ticket.author}</strong> · {ticket.branch} · {ticket.createdAt}</span>
        </div>

        <div style={{ background: 'var(--bg)', borderRadius: 8, padding: '12px 14px', fontSize: 13, color: 'var(--ink-mid)', lineHeight: 1.7 }}>
          {ticket.body}
        </div>

        <div>
          <div style={{ fontSize: 12, fontWeight: 600, color: 'var(--ink)', marginBottom: 6 }}>Admin Reply</div>
          <textarea
            value={reply} onChange={e => setReply(e.target.value)}
            rows={4} placeholder="Write a reply to the branch…"
            style={{ width: '100%', padding: '10px 12px', border: '1px solid var(--border)', borderRadius: 8, fontSize: 13, fontFamily: 'inherit', outline: 'none', resize: 'vertical', lineHeight: 1.6 }}
            onFocus={e => e.target.style.borderColor = 'var(--primary)'}
            onBlur={e => e.target.style.borderColor = 'var(--border)'}
          />
        </div>

        <div>
          <div style={{ fontSize: 12, fontWeight: 600, color: 'var(--ink)', marginBottom: 6 }}>Update Status</div>
          <div style={{ display: 'flex', gap: 6 }}>
            {(['open', 'in_progress', 'resolved', 'closed'] as TicketStatus[]).map(s => (
              <button key={s} onClick={() => setStatus(s)} style={{
                padding: '6px 12px', borderRadius: 7, border: `1.5px solid ${status === s ? ticketStatusColor(s).c : 'var(--border)'}`,
                background: status === s ? ticketStatusColor(s).bg : '#fff',
                color: status === s ? ticketStatusColor(s).c : 'var(--ink-muted)',
                fontWeight: status === s ? 700 : 400, fontSize: 11, cursor: 'pointer', fontFamily: 'inherit',
              }}>{s.replace('_', ' ')}</button>
            ))}
          </div>
        </div>

        <div style={{ display: 'flex', gap: 8, justifyContent: 'flex-end' }}>
          <Btn variant="ghost" onClick={onClose}>Cancel</Btn>
          <Btn variant="primary" onClick={onClose}>Send Reply & Update</Btn>
        </div>
      </div>
    </Modal>
  )
}

// ─── Register Branch Modal ────────────────────────────────────────────────────

function RegisterBranchModal({ onClose }: { onClose: () => void }) {
  const [step, setStep] = useState(0)
  const [form, setForm] = useState({ name: '', address: '', manager: '', phone: '', tin: '' })
  const [code, setCode] = useState<string | null>(null)

  const set = (k: keyof typeof form) => (e: any) => setForm(f => ({ ...f, [k]: e.target.value }))

  const register = () => {
    const prefix = form.name.slice(0, 3).toUpperCase() || 'BRC'
    setCode(generateCode(prefix))
    setStep(1)
  }

  const inputStyle = {
    width: '100%', padding: '9px 11px', border: '1px solid var(--border)',
    borderRadius: 8, fontSize: 13, fontFamily: 'inherit', outline: 'none',
  }

  return (
    <Modal title="Register New Branch" onClose={onClose} width={520}>
      {step === 0 ? (
        <div style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
          <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 10 }}>
            {[
              ['Branch Name', 'name', 'e.g. Nyamirambo'],
              ['Manager Name', 'manager', 'e.g. Dr. Jane Doe'],
              ['Phone Number', 'phone', '+250 7xx xxx xxx'],
              ['TIN Number', 'tin', 'e.g. 102381031'],
            ].map(([label, key, ph]) => (
              <div key={key}>
                <label style={{ fontSize: 11, fontWeight: 600, color: 'var(--ink-muted)', textTransform: 'uppercase', letterSpacing: '0.05em', display: 'block', marginBottom: 5 }}>{label} *</label>
                <input value={form[key as keyof typeof form]} onChange={set(key as any)} placeholder={ph}
                  style={inputStyle}
                  onFocus={e => e.target.style.borderColor = 'var(--primary)'}
                  onBlur={e => e.target.style.borderColor = 'var(--border)'}
                />
              </div>
            ))}
          </div>
          <div>
            <label style={{ fontSize: 11, fontWeight: 600, color: 'var(--ink-muted)', textTransform: 'uppercase', letterSpacing: '0.05em', display: 'block', marginBottom: 5 }}>Physical Address *</label>
            <input value={form.address} onChange={set('address')} placeholder="Street, District, Kigali"
              style={inputStyle}
              onFocus={e => e.target.style.borderColor = 'var(--primary)'}
              onBlur={e => e.target.style.borderColor = 'var(--border)'}
            />
          </div>
          <div style={{ display: 'flex', gap: 8, justifyContent: 'flex-end', paddingTop: 4 }}>
            <Btn variant="ghost" onClick={onClose}>Cancel</Btn>
            <Btn variant="primary" onClick={register}>Register & Generate Code →</Btn>
          </div>
        </div>
      ) : (
        <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', gap: 16, padding: '10px 0', textAlign: 'center' }}>
          <div style={{ fontSize: 48 }}>🎉</div>
          <div style={{ fontSize: 18, fontWeight: 800, color: 'var(--ink)', fontFamily: 'DM Sans' }}>{form.name} Registered!</div>
          <div style={{ fontSize: 13, color: 'var(--ink-muted)' }}>Share this access code with the branch manager to allow sign-in:</div>
          <div style={{
            background: '#f0fdf4', border: '2px solid #86efac', borderRadius: 12,
            padding: '20px 32px', width: '100%',
          }}>
            <div style={{ fontSize: 10, color: 'var(--ink-muted)', textTransform: 'uppercase', letterSpacing: '0.06em', marginBottom: 8 }}>Branch Access Code</div>
            <div style={{ fontFamily: 'JetBrains Mono, monospace', fontSize: 24, fontWeight: 800, color: '#16a34a', letterSpacing: '0.12em' }}>{code}</div>
            <div style={{ fontSize: 11, color: 'var(--ink-faint)', marginTop: 6 }}>Valid for 12 months · Share securely</div>
          </div>
          <div style={{ display: 'flex', gap: 8 }}>
            <Btn variant="secondary" onClick={() => { navigator.clipboard.writeText(code ?? '').catch(() => {}) }}>📋 Copy Code</Btn>
            <Btn variant="primary" onClick={onClose}>Done</Btn>
          </div>
        </div>
      )}
    </Modal>
  )
}

// ─── Admin Page ───────────────────────────────────────────────────────────────

export default function AdminPage() {
  const [tab, setTab]               = useState<'branches' | 'help'>('branches')
  const [selectedBranch, setSelectedBranch] = useState<BranchRecord | null>(null)
  const [selectedTicket, setSelectedTicket] = useState<HelpTicket | null>(null)
  const [showRegister, setShowRegister]     = useState(false)
  const [ticketFilter, setTicketFilter]     = useState<'all' | 'open' | 'in_progress' | 'resolved'>('all')

  const maxRev = Math.max(...branchRegistry.map(b => b.revenue))

  const chartData = branchRegistry.filter(b => b.status === 'active').map(b => ({
    name: b.name, revenue: b.revenue,
  }))

  const filteredTickets = helpTickets.filter(t =>
    ticketFilter === 'all' || t.status === ticketFilter
  )

  const openCount     = helpTickets.filter(t => t.status === 'open').length
  const inProgCount   = helpTickets.filter(t => t.status === 'in_progress').length
  const resolvedCount = helpTickets.filter(t => t.status === 'resolved').length

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 18 }}>
      {/* Header */}
      <div style={{ background: 'linear-gradient(135deg, #ecfdf5, #f0fdf4)', borderRadius: 14, padding: '18px 22px', border: '1.5px solid var(--border-strong)', display: 'flex', alignItems: 'center', gap: 16 }}>
        <div style={{ fontSize: 36 }}>🛡</div>
        <div>
          <div style={{ fontSize: 18, fontWeight: 800, color: 'var(--ink)', fontFamily: 'DM Sans' }}>Admin Control Panel</div>
          <div style={{ fontSize: 13, color: 'var(--ink-mid)', marginTop: 3 }}>Manage all branches, generate access codes, and respond to branch requests.</div>
        </div>
        <div style={{ marginLeft: 'auto', display: 'flex', gap: 8 }}>
          <Btn variant="primary" onClick={() => setShowRegister(true)}>+ Register Branch</Btn>
        </div>
      </div>

      {/* Tabs */}
      <div style={{ display: 'flex', gap: 0, background: 'var(--bg-alt)', borderRadius: 10, padding: 3, border: '1px solid var(--border)', alignSelf: 'flex-start' }}>
        {([['branches', '🏪 Branches'], ['help', `💬 Help Requests (${openCount + inProgCount} active)`]] as const).map(([t, l]) => (
          <button key={t} onClick={() => setTab(t)} style={{
            padding: '9px 18px', borderRadius: 8, border: 'none', cursor: 'pointer',
            background: tab === t ? '#fff' : 'transparent',
            color: tab === t ? 'var(--primary)' : 'var(--ink-muted)',
            fontWeight: tab === t ? 700 : 400, fontSize: 13, fontFamily: 'inherit',
            boxShadow: tab === t ? '0 1px 4px rgba(0,0,0,0.08)' : 'none', transition: 'all 0.15s',
          }}>{l}</button>
        ))}
      </div>

      {/* ── Branches Tab ── */}
      {tab === 'branches' && (
        <>
          {/* KPIs */}
          <div style={{ display: 'grid', gridTemplateColumns: 'repeat(4, 1fr)', gap: 12 }}>
            {[
              { label: 'Total Branches',  value: branchRegistry.length,                                  color: '#1e8a4a', icon: '🏪' },
              { label: 'Active',          value: branchRegistry.filter(b => b.status === 'active').length,  color: '#16a34a', icon: '✅' },
              { label: 'Total Network Rev', value: fmtRWF(branchRegistry.reduce((s, b) => s + b.revenue, 0)), color: '#0284c7', icon: '💰' },
              { label: 'Pending Setup',   value: branchRegistry.filter(b => b.status === 'pending').length,  color: '#d97706', icon: '⏳' },
            ].map(k => (
              <div key={k.label} style={{ background: '#fff', borderRadius: 12, padding: '14px 16px', border: '1px solid var(--border)', display: 'flex', alignItems: 'center', gap: 10 }}>
                <div style={{ fontSize: 22 }}>{k.icon}</div>
                <div>
                  <div style={{ fontSize: 20, fontWeight: 800, color: k.color, fontFamily: 'DM Sans' }}>{k.value}</div>
                  <div style={{ fontSize: 11, color: 'var(--ink-muted)', fontWeight: 500 }}>{k.label}</div>
                </div>
              </div>
            ))}
          </div>

          {/* Revenue chart + branch list */}
          <div style={{ display: 'grid', gridTemplateColumns: '1fr 1.4fr', gap: 14 }}>
            <Card>
              <SectionHeader title="Revenue by Branch" subtitle="This month — active branches only" />
              <ResponsiveContainer width="100%" height={200}>
                <BarChart data={chartData} margin={{ top: 4, right: 4, bottom: 0, left: 0 }}>
                  <CartesianGrid stroke="#f0f0f0" strokeDasharray="4 4" />
                  <XAxis dataKey="name" tick={{ fontSize: 10 }} axisLine={false} tickLine={false} />
                  <YAxis tick={{ fontSize: 10 }} axisLine={false} tickLine={false} tickFormatter={v => `${(v / 1000000).toFixed(1)}M`} />
                  <Tooltip content={<ChartTooltip />} />
                  <Bar dataKey="revenue" name="Revenue" radius={[6, 6, 0, 0]}>
                    {chartData.map((_, i) => <Cell key={i} fill={['#1e8a4a', '#34d399', '#059669', '#a7f3d0'][i % 4]} />)}
                  </Bar>
                </BarChart>
              </ResponsiveContainer>
            </Card>

            <Card>
              <SectionHeader title="Branch Revenue Share" />
              {branchRegistry.filter(b => b.status === 'active').map(b => (
                <div key={b.id} style={{ marginBottom: 12 }}>
                  <div style={{ display: 'flex', justifyContent: 'space-between', fontSize: 12, marginBottom: 4 }}>
                    <span style={{ fontWeight: 500, color: 'var(--ink)' }}>{b.name}</span>
                    <span style={{ fontWeight: 700, color: 'var(--ink)' }}>{fmtRWF(b.revenue)}</span>
                  </div>
                  <ProgressBar value={b.revenue} max={maxRev} height={6} />
                  <div style={{ fontSize: 10, color: 'var(--ink-faint)', marginTop: 2 }}>
                    {Math.round(b.revenue / branchRegistry.filter(x => x.status === 'active').reduce((s, x) => s + x.revenue, 0) * 100)}% of total · {b.manager} · {b.staff} staff
                  </div>
                </div>
              ))}
            </Card>
          </div>

          {/* Branch Registry Table */}
          <Card>
            <SectionHeader title="Registered Branches" action="+ Register New Branch" onAction={() => setShowRegister(true)} />
            <div style={{ overflowX: 'auto' }}>
              <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 12 }}>
                <thead>
                  <tr style={{ borderBottom: '1px solid var(--border)' }}>
                    {['ID', 'Branch Name', 'Manager', 'Location', 'Status', 'Staff', 'Revenue', 'Access Code', 'Code Expiry', ''].map(h => (
                      <th key={h} style={{ textAlign: 'left', padding: '7px 10px', color: 'var(--ink-muted)', fontWeight: 500, fontSize: 11, whiteSpace: 'nowrap' }}>{h}</th>
                    ))}
                  </tr>
                </thead>
                <tbody>
                  {branchRegistry.map(b => (
                    <tr key={b.id}
                      style={{ borderBottom: '1px solid var(--bg-alt)', cursor: 'pointer', transition: 'background 0.13s' }}
                      onMouseEnter={e => (e.currentTarget.style.background = 'var(--bg)')}
                      onMouseLeave={e => (e.currentTarget.style.background = 'transparent')}
                      onClick={() => setSelectedBranch(b)}
                    >
                      <td style={{ padding: '9px 10px', fontFamily: 'JetBrains Mono, monospace', fontSize: 10, color: 'var(--ink-faint)' }}>{b.id}</td>
                      <td style={{ padding: '9px 10px', fontWeight: 700, color: 'var(--ink)', whiteSpace: 'nowrap' }}>{b.name}</td>
                      <td style={{ padding: '9px 10px', whiteSpace: 'nowrap', color: 'var(--ink-mid)' }}>{b.manager}</td>
                      <td style={{ padding: '9px 10px', fontSize: 11, color: 'var(--ink-muted)', maxWidth: 140, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{b.address}</td>
                      <td style={{ padding: '9px 10px' }}>
                        <StatusBadge
                          label={b.status === 'active' ? '✓ Active' : b.status === 'pending' ? '⏳ Pending' : 'Inactive'}
                          color={b.status === 'active' ? '#16a34a' : b.status === 'pending' ? '#d97706' : '#6b7280'}
                          bg={b.status === 'active' ? '#d1fae5' : b.status === 'pending' ? '#fef3c7' : '#f3f4f6'}
                        />
                      </td>
                      <td style={{ padding: '9px 10px', textAlign: 'center', fontFamily: 'JetBrains Mono, monospace' }}>{b.staff}</td>
                      <td style={{ padding: '9px 10px', fontWeight: 700 }}>{b.revenue > 0 ? fmtRWF(b.revenue) : '—'}</td>
                      <td style={{ padding: '9px 10px', fontFamily: 'JetBrains Mono, monospace', fontSize: 10, color: b.accessCode ? 'var(--primary)' : 'var(--ink-faint)', letterSpacing: '0.05em' }}>
                        {b.accessCode ?? '—'}
                      </td>
                      <td style={{ padding: '9px 10px', fontSize: 11, color: 'var(--ink-muted)' }}>{b.accessCodeExpiry ?? '—'}</td>
                      <td style={{ padding: '9px 10px' }}>
                        <button onClick={e => { e.stopPropagation(); setSelectedBranch(b) }}
                          style={{ fontSize: 11, color: 'var(--primary)', background: 'none', border: 'none', cursor: 'pointer', fontWeight: 600, fontFamily: 'inherit' }}>
                          Manage →
                        </button>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </Card>
        </>
      )}

      {/* ── Help Requests Tab ── */}
      {tab === 'help' && (
        <>
          <div style={{ display: 'grid', gridTemplateColumns: 'repeat(3, 1fr)', gap: 12 }}>
            {[
              { label: 'Open',        count: openCount,     color: '#d97706', bg: '#fef3c7', filter: 'open' },
              { label: 'In Progress', count: inProgCount,   color: '#0284c7', bg: '#e0f2fe', filter: 'in_progress' },
              { label: 'Resolved',    count: resolvedCount, color: '#16a34a', bg: '#d1fae5', filter: 'resolved' },
            ].map(k => (
              <div key={k.label}
                onClick={() => setTicketFilter(ticketFilter === k.filter as any ? 'all' : k.filter as any)}
                style={{
                  background: ticketFilter === k.filter ? k.bg : '#fff',
                  border: `1.5px solid ${ticketFilter === k.filter ? k.color + '50' : 'var(--border)'}`,
                  borderRadius: 12, padding: '14px 18px', cursor: 'pointer',
                  display: 'flex', alignItems: 'center', gap: 12, transition: 'all 0.15s',
                }}>
                <div style={{ fontSize: 26, fontWeight: 800, color: k.color, fontFamily: 'DM Sans' }}>{k.count}</div>
                <div style={{ fontSize: 13, fontWeight: 600, color: 'var(--ink)' }}>{k.label} Tickets</div>
              </div>
            ))}
          </div>

          <Card>
            <SectionHeader title="All Help Requests & Suggestions" subtitle="From all branches — click to reply" />
            <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
              {filteredTickets.map(ticket => {
                const sc = ticketStatusColor(ticket.status)
                return (
                  <div key={ticket.id}
                    onClick={() => setSelectedTicket(ticket)}
                    style={{
                      padding: '14px 16px', border: '1px solid var(--border)', borderRadius: 10,
                      cursor: 'pointer', transition: 'all 0.15s', display: 'flex', gap: 14, alignItems: 'flex-start',
                    }}
                    onMouseEnter={e => { (e.currentTarget as HTMLDivElement).style.background = 'var(--bg)'; (e.currentTarget as HTMLDivElement).style.borderColor = 'var(--border-strong)' }}
                    onMouseLeave={e => { (e.currentTarget as HTMLDivElement).style.background = ''; (e.currentTarget as HTMLDivElement).style.borderColor = 'var(--border)' }}
                  >
                    <div style={{ fontSize: 22, flexShrink: 0, marginTop: 2 }}>{ticketTypeIcon(ticket.type)}</div>
                    <div style={{ flex: 1, minWidth: 0 }}>
                      <div style={{ display: 'flex', gap: 8, alignItems: 'center', flexWrap: 'wrap', marginBottom: 4 }}>
                        <span style={{ fontSize: 14, fontWeight: 700, color: 'var(--ink)' }}>{ticket.title}</span>
                        <StatusBadge label={ticket.status.replace('_', ' ')} color={sc.c} bg={sc.bg} />
                        <span style={{ fontSize: 10, fontWeight: 700, color: ticket.priority === 'high' ? '#dc2626' : ticket.priority === 'medium' ? '#d97706' : '#16a34a', textTransform: 'uppercase', letterSpacing: '0.05em' }}>{ticket.priority}</span>
                      </div>
                      <div style={{ fontSize: 12, color: 'var(--ink-mid)', lineHeight: 1.5, overflow: 'hidden', display: '-webkit-box', WebkitLineClamp: 2, WebkitBoxOrient: 'vertical' }}>
                        {ticket.body}
                      </div>
                      {ticket.adminReply && (
                        <div style={{ marginTop: 6, background: 'var(--primary-light)', borderRadius: 6, padding: '6px 10px', fontSize: 11, color: 'var(--primary)', fontWeight: 500 }}>
                          📩 Admin replied: "{ticket.adminReply.slice(0, 80)}…"
                        </div>
                      )}
                    </div>
                    <div style={{ flexShrink: 0, textAlign: 'right' }}>
                      <div style={{ fontSize: 11, color: 'var(--ink-muted)', whiteSpace: 'nowrap' }}>{ticket.branch}</div>
                      <div style={{ fontSize: 10, color: 'var(--ink-faint)', marginTop: 2 }}>{ticket.createdAt}</div>
                      <div style={{ fontSize: 11, color: 'var(--primary)', fontWeight: 600, marginTop: 6 }}>Reply →</div>
                    </div>
                  </div>
                )
              })}
              {filteredTickets.length === 0 && (
                <div style={{ textAlign: 'center', padding: '32px 0', color: 'var(--ink-muted)', fontSize: 13 }}>
                  <div style={{ fontSize: 32, marginBottom: 8 }}>✅</div>
                  No tickets in this category.
                </div>
              )}
            </div>
          </Card>
        </>
      )}

      {selectedBranch && <BranchModal branch={selectedBranch} onClose={() => setSelectedBranch(null)} />}
      {selectedTicket && <TicketModal ticket={selectedTicket} onClose={() => setSelectedTicket(null)} />}
      {showRegister && <RegisterBranchModal onClose={() => setShowRegister(false)} />}
    </div>
  )
}
