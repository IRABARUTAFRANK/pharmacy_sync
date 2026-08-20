import { useState, useMemo } from 'react'
import { PieChart, Pie, Cell, Tooltip, ResponsiveContainer, BarChart, Bar, XAxis, YAxis, CartesianGrid } from 'recharts'
import {
  dbInsuranceClaims, dbInsuranceProviders, insuranceProviders, transactions,
  fmtRWF, type DBInsuranceClaim, type DBInsuranceProvider,
} from '../data'
import { Card, SectionHeader, StatusBadge, Modal, Btn, ProgressBar, ChartTooltip, ColumnPicker } from '../components'

// ─── Claim status colours ──────────────────────────────────────────────────────

const claimStatusColor: Record<string, { c: string; bg: string }> = {
  submitted: { c: '#0284c7', bg: '#e0f2fe' },
  approved:  { c: '#16a34a', bg: '#d1fae5' },
  rejected:  { c: '#dc2626', bg: '#fef2f2' },
  paid:      { c: '#7c3aed', bg: '#f5f3ff' },
}

// ─── Column picker ────────────────────────────────────────────────────────────

type ClaimColKey = 'sale_id' | 'provider_name' | 'coverage_percentage_applied' | 'claim_amount' | 'status' | 'submitted_at'

const CLAIM_COLS: { key: ClaimColKey; label: string }[] = [
  { key: 'sale_id',                      label: 'Sale ID' },
  { key: 'provider_name',                label: 'Provider' },
  { key: 'coverage_percentage_applied',  label: 'Coverage %' },
  { key: 'claim_amount',                 label: 'Claim Amount' },
  { key: 'status',                       label: 'Status' },
  { key: 'submitted_at',                 label: 'Submitted At' },
]

const DEFAULT_CLAIM_COLS = new Set<ClaimColKey>(['provider_name', 'coverage_percentage_applied', 'claim_amount', 'status', 'submitted_at'])

// ─── Provider Detail Modal ────────────────────────────────────────────────────

function ProviderModal({ prov, onClose }: { prov: DBInsuranceProvider; onClose: () => void }) {
  const claims = dbInsuranceClaims.filter(c => c.insurance_provider_id === prov.id)
  const claimHistory = [
    { month: 'Apr', claims: 6,  amount: 480000 },
    { month: 'May', claims: 8,  amount: 620000 },
    { month: 'Jun', claims: 11, amount: 880000 },
    { month: 'Jul', claims: 9,  amount: 720000 },
    { month: 'Aug', claims: claims.length, amount: claims.reduce((s, c) => s + c.claim_amount, 0) },
  ]
  const totalClaimAmt = claims.reduce((s, c) => s + c.claim_amount, 0)
  return (
    <Modal title={`Insurance Provider — ${prov.name}`} onClose={onClose} width={580}>
      <div style={{ display: 'flex', flexDirection: 'column', gap: 16 }}>
        <div style={{ display: 'grid', gridTemplateColumns: 'repeat(3, 1fr)', gap: 8 }}>
          {[
            ['Default Coverage',  `${prov.default_coverage_percentage}%`],
            ['Claims (this data)', claims.length.toString()],
            ['Total Claimed',     fmtRWF(totalClaimAmt)],
          ].map(([l, v]) => (
            <div key={l} style={{ background: 'var(--bg)', borderRadius: 8, padding: '10px 12px' }}>
              <div style={{ fontSize: 10, color: 'var(--ink-muted)', fontWeight: 500, textTransform: 'uppercase', letterSpacing: '0.05em', marginBottom: 2 }}>{l}</div>
              <div style={{ fontSize: 16, fontWeight: 700, color: 'var(--ink)', fontFamily: 'DM Sans' }}>{v}</div>
            </div>
          ))}
        </div>
        {prov.contact_info && (
          <div style={{ background: 'var(--bg)', borderRadius: 8, padding: '10px 12px', fontSize: 12, color: 'var(--ink-mid)' }}>
            <span style={{ fontWeight: 600, color: 'var(--ink)' }}>Contact:</span> {prov.contact_info}
          </div>
        )}
        <div>
          <div style={{ fontSize: 13, fontWeight: 600, color: 'var(--ink)', marginBottom: 8 }}>Claim Volume Trend</div>
          <ResponsiveContainer width="100%" height={150}>
            <BarChart data={claimHistory} margin={{ top: 4, right: 4, bottom: 0, left: 0 }}>
              <CartesianGrid stroke="#f0f0f0" strokeDasharray="4 4" />
              <XAxis dataKey="month" tick={{ fontSize: 11 }} axisLine={false} tickLine={false} />
              <YAxis tick={{ fontSize: 11 }} axisLine={false} tickLine={false} />
              <Tooltip content={<ChartTooltip />} />
              <Bar dataKey="claims" name="Claims" fill="#1e8a4a" radius={[4, 4, 0, 0]} />
            </BarChart>
          </ResponsiveContainer>
        </div>
        {claims.length > 0 && (
          <div>
            <div style={{ fontSize: 12, fontWeight: 600, color: 'var(--ink)', marginBottom: 6 }}>Claims on record</div>
            {claims.map(c => {
              const sc = claimStatusColor[c.status] ?? claimStatusColor.submitted
              return (
                <div key={c.id} style={{ display: 'flex', gap: 10, alignItems: 'center', padding: '7px 10px', background: 'var(--bg)', borderRadius: 7, marginBottom: 5, fontSize: 12 }}>
                  <span style={{ flex: 1, fontFamily: 'JetBrains Mono, monospace', fontSize: 10, color: 'var(--ink-faint)' }}>{c.sale_id.slice(0, 18)}…</span>
                  <span style={{ fontWeight: 600 }}>{c.coverage_percentage_applied}% · {fmtRWF(c.claim_amount)}</span>
                  <StatusBadge label={c.status} color={sc.c} bg={sc.bg} />
                </div>
              )
            })}
          </div>
        )}
        <div style={{ display: 'flex', gap: 8, justifyContent: 'flex-end' }}>
          <Btn variant="ghost" small onClick={onClose}>Export Claims</Btn>
          <Btn variant="secondary" small onClick={onClose}>Product Overrides</Btn>
          <Btn variant="primary" small onClick={onClose}>Submit Claim</Btn>
        </div>
      </div>
    </Modal>
  )
}

// ─── Main Page ────────────────────────────────────────────────────────────────

export default function InsurancePage() {
  const [selectedProv, setSelectedProv] = useState<DBInsuranceProvider | null>(null)
  const [statusFilter, setStatusFilter] = useState('all')
  const [providerFilter, setProviderFilter] = useState('all')
  const [visibleCols, setVisibleCols]   = useState<Set<ClaimColKey>>(new Set(DEFAULT_CLAIM_COLS))

  const toggleCol = (key: ClaimColKey) =>
    setVisibleCols(prev => { const next = new Set(prev); next.has(key) ? next.delete(key) : next.add(key); return next })

  const filteredClaims = useMemo(() => {
    let cs = dbInsuranceClaims
    if (statusFilter !== 'all')   cs = cs.filter(c => c.status === statusFilter)
    if (providerFilter !== 'all') cs = cs.filter(c => c.insurance_provider_id === providerFilter)
    return [...cs].sort((a, b) => new Date(b.submitted_at).getTime() - new Date(a.submitted_at).getTime())
  }, [statusFilter, providerFilter])

  const totalClaimed  = dbInsuranceClaims.reduce((s, c) => s + c.claim_amount, 0)
  const paid          = dbInsuranceClaims.filter(c => c.status === 'paid').reduce((s, c) => s + c.claim_amount, 0)
  const approved      = dbInsuranceClaims.filter(c => c.status === 'approved').length
  const submitted     = dbInsuranceClaims.filter(c => c.status === 'submitted').length

  const pieData = dbInsuranceProviders.map((p, i) => {
    const amt = dbInsuranceClaims.filter(c => c.insurance_provider_id === p.id).reduce((s, c) => s + c.claim_amount, 0)
    return { name: p.name, value: amt, color: ['#1e8a4a','#34d399','#059669','#a7f3d0','#6ee7b7'][i] ?? '#86efac' }
  }).filter(d => d.value > 0)

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 18 }}>
      {/* KPIs */}
      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(4, 1fr)', gap: 12 }}>
        {[
          { label: 'Providers',       value: dbInsuranceProviders.length.toString(), icon: '🏥', c: '#1e8a4a' },
          { label: 'Total Claimed',   value: fmtRWF(totalClaimed),                  icon: '📋', c: '#0284c7' },
          { label: 'Paid Out',        value: fmtRWF(paid),                           icon: '✅', c: '#059669' },
          { label: 'Pending Approval',value: (submitted + approved).toString(),       icon: '⏳', c: '#d97706' },
        ].map(k => (
          <div key={k.label} style={{ background: '#fff', borderRadius: 12, padding: '16px 18px', border: '1px solid var(--border)', display: 'flex', alignItems: 'center', gap: 12 }}>
            <div style={{ fontSize: 22 }}>{k.icon}</div>
            <div>
              <div style={{ fontSize: 20, fontWeight: 700, color: k.c, fontFamily: 'DM Sans' }}>{k.value}</div>
              <div style={{ fontSize: 11, color: 'var(--ink-muted)', fontWeight: 500 }}>{k.label}</div>
            </div>
          </div>
        ))}
      </div>

      {/* Pie + Provider table */}
      <div style={{ display: 'grid', gridTemplateColumns: '0.7fr 1.3fr', gap: 14 }}>
        <Card>
          <SectionHeader title="Claims by Provider" subtitle="insurance_claims grouped by provider" />
          <ResponsiveContainer width="100%" height={160}>
            <PieChart>
              <Pie data={pieData} cx="50%" cy="50%" innerRadius={44} outerRadius={68} paddingAngle={3} dataKey="value">
                {pieData.map((e, i) => <Cell key={i} fill={e.color} />)}
              </Pie>
              <Tooltip formatter={(v) => fmtRWF(Number(v))} />
            </PieChart>
          </ResponsiveContainer>
          <div style={{ display: 'flex', flexDirection: 'column', gap: 4, marginTop: 8 }}>
            {pieData.map(p => (
              <div key={p.name} style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', fontSize: 11 }}>
                <div style={{ display: 'flex', alignItems: 'center', gap: 5 }}>
                  <div style={{ width: 8, height: 8, borderRadius: 2, background: p.color, flexShrink: 0 }} />
                  <span style={{ color: 'var(--ink-muted)' }}>{p.name}</span>
                </div>
                <span style={{ fontWeight: 600, color: 'var(--ink)' }}>{fmtRWF(p.value)}</span>
              </div>
            ))}
          </div>
        </Card>

        <Card>
          <SectionHeader title="Insurance Providers" action="+ Add Provider" />
          <div style={{ overflowX: 'auto' }}>
            <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 12 }}>
              <thead>
                <tr style={{ borderBottom: '1px solid var(--border)' }}>
                  {['Provider', 'Default Coverage %', 'Claims', 'Total Claimed', 'Contact', ''].map(h => (
                    <th key={h} style={{ textAlign: 'left', padding: '7px 10px', color: 'var(--ink-muted)', fontWeight: 500, fontSize: 11, whiteSpace: 'nowrap' }}>{h}</th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {dbInsuranceProviders.map(prov => {
                  const claims = dbInsuranceClaims.filter(c => c.insurance_provider_id === prov.id)
                  const total  = claims.reduce((s, c) => s + c.claim_amount, 0)
                  return (
                    <tr key={prov.id}
                      style={{ borderBottom: '1px solid var(--bg-alt)', cursor: 'pointer', transition: 'background 0.13s' }}
                      onMouseEnter={e => (e.currentTarget.style.background = 'var(--bg)')}
                      onMouseLeave={e => (e.currentTarget.style.background = 'transparent')}
                      onClick={() => setSelectedProv(prov)}
                    >
                      <td style={{ padding: '10px 10px', fontWeight: 600 }}>{prov.name}</td>
                      <td style={{ padding: '10px 10px' }}>
                        <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                          <ProgressBar value={prov.default_coverage_percentage} max={100} height={5} />
                          <span style={{ fontSize: 11, fontWeight: 600, minWidth: 32 }}>{prov.default_coverage_percentage}%</span>
                        </div>
                      </td>
                      <td style={{ padding: '10px 10px', fontFamily: 'JetBrains Mono, monospace' }}>{claims.length}</td>
                      <td style={{ padding: '10px 10px', fontWeight: 600 }}>{fmtRWF(total)}</td>
                      <td style={{ padding: '10px 10px', fontSize: 11, color: 'var(--ink-muted)', maxWidth: 160, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{prov.contact_info ?? '—'}</td>
                      <td style={{ padding: '10px 10px' }}>
                        <button style={{ fontSize: 11, color: 'var(--primary)', background: 'none', border: 'none', cursor: 'pointer', fontWeight: 600, fontFamily: 'inherit' }}>Details →</button>
                      </td>
                    </tr>
                  )
                })}
              </tbody>
            </table>
          </div>
        </Card>
      </div>

      {/* Insurance Claims Table */}
      <Card>
        <div style={{ display: 'flex', gap: 8, marginBottom: 14, flexWrap: 'wrap', alignItems: 'center' }}>
          <h2 style={{ margin: 0, fontSize: 14, fontWeight: 600, color: 'var(--ink)', flex: 1 }}>Insurance Claims — insurance_claims</h2>
          <select value={providerFilter} onChange={e => setProviderFilter(e.target.value)}
            style={{ padding: '6px 8px', border: '1px solid var(--border)', borderRadius: 7, fontSize: 11, fontFamily: 'inherit', background: 'var(--bg)', cursor: 'pointer', outline: 'none' }}>
            <option value="all">All Providers</option>
            {dbInsuranceProviders.map(p => <option key={p.id} value={p.id}>{p.name}</option>)}
          </select>
          <select value={statusFilter} onChange={e => setStatusFilter(e.target.value)}
            style={{ padding: '6px 8px', border: '1px solid var(--border)', borderRadius: 7, fontSize: 11, fontFamily: 'inherit', background: 'var(--bg)', cursor: 'pointer', outline: 'none' }}>
            <option value="all">All Statuses</option>
            <option value="submitted">Submitted</option>
            <option value="approved">Approved</option>
            <option value="rejected">Rejected</option>
            <option value="paid">Paid</option>
          </select>
          <ColumnPicker columns={CLAIM_COLS} visible={visibleCols} onToggle={toggleCol} />
          <Btn variant="primary" small>+ New Claim</Btn>
        </div>

        <div style={{ overflowX: 'auto' }}>
          <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 12 }}>
            <thead>
              <tr style={{ borderBottom: '1px solid var(--border)' }}>
                <th style={{ textAlign: 'left', padding: '7px 10px', fontSize: 10, fontWeight: 600, color: 'var(--ink-muted)', textTransform: 'uppercase', letterSpacing: '0.04em' }}>Claim ID</th>
                {visibleCols.has('sale_id')                     && <th style={{ textAlign: 'left', padding: '7px 10px', fontSize: 10, fontWeight: 600, color: 'var(--ink-muted)', textTransform: 'uppercase', letterSpacing: '0.04em' }}>Sale ID</th>}
                {visibleCols.has('provider_name')               && <th style={{ textAlign: 'left', padding: '7px 10px', fontSize: 10, fontWeight: 600, color: 'var(--ink-muted)', textTransform: 'uppercase', letterSpacing: '0.04em' }}>Provider</th>}
                {visibleCols.has('coverage_percentage_applied') && <th style={{ textAlign: 'left', padding: '7px 10px', fontSize: 10, fontWeight: 600, color: 'var(--ink-muted)', textTransform: 'uppercase', letterSpacing: '0.04em' }}>Coverage %</th>}
                {visibleCols.has('claim_amount')                && <th style={{ textAlign: 'left', padding: '7px 10px', fontSize: 10, fontWeight: 600, color: 'var(--ink-muted)', textTransform: 'uppercase', letterSpacing: '0.04em' }}>Claim Amount</th>}
                {visibleCols.has('status')                      && <th style={{ textAlign: 'left', padding: '7px 10px', fontSize: 10, fontWeight: 600, color: 'var(--ink-muted)', textTransform: 'uppercase', letterSpacing: '0.04em' }}>Status</th>}
                {visibleCols.has('submitted_at')                && <th style={{ textAlign: 'left', padding: '7px 10px', fontSize: 10, fontWeight: 600, color: 'var(--ink-muted)', textTransform: 'uppercase', letterSpacing: '0.04em' }}>Submitted At</th>}
              </tr>
            </thead>
            <tbody>
              {filteredClaims.map(claim => {
                const provider = dbInsuranceProviders.find(p => p.id === claim.insurance_provider_id)
                const sc = claimStatusColor[claim.status] ?? claimStatusColor.submitted
                return (
                  <tr key={claim.id}
                    style={{ borderBottom: '1px solid var(--bg-alt)', cursor: 'pointer', transition: 'background 0.12s' }}
                    onMouseEnter={e => (e.currentTarget.style.background = 'var(--bg)')}
                    onMouseLeave={e => (e.currentTarget.style.background = 'transparent')}
                  >
                    <td style={{ padding: '9px 10px', fontFamily: 'JetBrains Mono, monospace', fontSize: 10, color: 'var(--primary)', fontWeight: 600 }}>{claim.id.slice(0, 16)}…</td>
                    {visibleCols.has('sale_id')                     && <td style={{ padding: '9px 10px', fontFamily: 'JetBrains Mono, monospace', fontSize: 10, color: 'var(--ink-faint)' }}>{claim.sale_id.slice(0, 14)}…</td>}
                    {visibleCols.has('provider_name')               && <td style={{ padding: '9px 10px', fontWeight: 600 }}><StatusBadge label={provider?.name ?? '—'} color="var(--primary)" bg="var(--primary-light)" /></td>}
                    {visibleCols.has('coverage_percentage_applied') && <td style={{ padding: '9px 10px' }}>
                      <div style={{ display: 'flex', alignItems: 'center', gap: 7 }}>
                        <ProgressBar value={claim.coverage_percentage_applied} max={100} height={5} />
                        <span style={{ fontSize: 11, fontWeight: 600, minWidth: 28 }}>{claim.coverage_percentage_applied}%</span>
                      </div>
                    </td>}
                    {visibleCols.has('claim_amount')                && <td style={{ padding: '9px 10px', fontWeight: 700 }}>{fmtRWF(claim.claim_amount)}</td>}
                    {visibleCols.has('status')                      && <td style={{ padding: '9px 10px' }}><StatusBadge label={claim.status} color={sc.c} bg={sc.bg} /></td>}
                    {visibleCols.has('submitted_at')                && <td style={{ padding: '9px 10px', fontSize: 11, color: 'var(--ink-faint)', whiteSpace: 'nowrap' }}>{claim.submitted_at}</td>}
                  </tr>
                )
              })}
              {filteredClaims.length === 0 && (
                <tr><td colSpan={10} style={{ padding: 28, textAlign: 'center', color: 'var(--ink-muted)', fontSize: 13 }}>No claims match the current filters.</td></tr>
              )}
            </tbody>
          </table>
        </div>
        <div style={{ marginTop: 10, fontSize: 11, color: 'var(--ink-faint)' }}>
          {filteredClaims.length} claim{filteredClaims.length !== 1 ? 's' : ''} · {visibleCols.size} of {CLAIM_COLS.length} columns visible
        </div>
      </Card>

      {selectedProv && <ProviderModal prov={selectedProv} onClose={() => setSelectedProv(null)} />}
    </div>
  )
}
