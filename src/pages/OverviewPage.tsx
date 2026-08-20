import { useState } from 'react'
import {
  AreaChart, Area, BarChart, Bar, PieChart, Pie, Cell,
  LineChart, Line, XAxis, YAxis, CartesianGrid, Tooltip,
  Legend, ResponsiveContainer, ReferenceLine,
} from 'recharts'
import {
  KPIS, revenueData, categoryData, dailySales, paymentMethodData, topProducts,
  alertsData, breakEvenData, BREAK_EVEN_REVENUE, generateSmartInsights,
  fmtRWF, pct, type KPIData, type Role,
} from '../data'
import {
  Card, SectionHeader, ChartTooltip, Sparkline, StatusBadge, AlertRow, Modal, Btn,
} from '../components'

// ─── KPI Card ─────────────────────────────────────────────────────────────────

function KPICard({ kpi, active, onClick }: { kpi: KPIData; active: boolean; onClick: () => void }) {
  const pos = kpi.change >= 0
  return (
    <div
      onClick={onClick}
      style={{
        background: active ? kpi.color + '08' : '#fff',
        borderRadius: 12, padding: '18px 20px',
        border: `1.5px solid ${active ? kpi.color + '60' : 'var(--border)'}`,
        display: 'flex', flexDirection: 'column', gap: 10,
        cursor: 'pointer', transition: 'all 0.18s',
        boxShadow: active ? `0 0 0 3px ${kpi.color}18` : 'none',
      }}
      onMouseEnter={e => { if (!active) (e.currentTarget as HTMLDivElement).style.boxShadow = '0 4px 18px rgba(30,138,74,0.09)' }}
      onMouseLeave={e => { if (!active) (e.currentTarget as HTMLDivElement).style.boxShadow = 'none' }}
    >
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start', gap: 8 }}>
        <div style={{ flex: 1, minWidth: 0 }}>
          <div style={{ fontSize: 11, fontWeight: 500, color: 'var(--ink-muted)', textTransform: 'uppercase', letterSpacing: '0.07em' }}>
            {kpi.label}
          </div>
          <div style={{ fontSize: 24, fontWeight: 700, color: 'var(--ink)', marginTop: 4, fontFamily: 'DM Sans, sans-serif', letterSpacing: '-0.02em', lineHeight: 1.1 }}>
            {kpi.value}
          </div>
        </div>
        <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'flex-end', gap: 6 }}>
          <div style={{ width: 36, height: 36, borderRadius: 9, background: kpi.color + '16', display: 'flex', alignItems: 'center', justifyContent: 'center', fontSize: 17, flexShrink: 0 }}>
            {kpi.icon}
          </div>
          <Sparkline data={kpi.sparkline} color={pos ? kpi.color : '#dc2626'} />
        </div>
      </div>
      <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
        <span style={{
          fontSize: 11, fontWeight: 700, color: pos ? 'var(--positive)' : 'var(--negative)',
          background: pos ? '#d1fae5' : '#fee2e2', borderRadius: 4, padding: '2px 7px',
        }}>{pct(kpi.change)}</span>
        <span style={{ fontSize: 11, color: 'var(--ink-muted)' }}>{kpi.sub}</span>
      </div>
    </div>
  )
}

// ─── Drill-down Modal ─────────────────────────────────────────────────────────

function KPIDrillDown({ kpi, onClose }: { kpi: KPIData; onClose: () => void }) {
  const chartData = revenueData.map((d, i) => ({
    month: d.month,
    value: kpi.sparkline[i] ?? 0,
  }))

  return (
    <Modal title={`Drill Down — ${kpi.label}`} onClose={onClose} width={680}>
      <div style={{ display: 'flex', gap: 16, marginBottom: 20 }}>
        <div style={{ flex: 1, background: 'var(--bg)', borderRadius: 10, padding: '14px 16px' }}>
          <div style={{ fontSize: 11, color: 'var(--ink-muted)', fontWeight: 500, textTransform: 'uppercase', letterSpacing: '0.06em' }}>Current</div>
          <div style={{ fontSize: 28, fontWeight: 700, fontFamily: 'DM Sans', color: 'var(--ink)' }}>{kpi.value}</div>
        </div>
        <div style={{ flex: 1, background: kpi.change >= 0 ? '#f0fdf4' : '#fef2f2', borderRadius: 10, padding: '14px 16px' }}>
          <div style={{ fontSize: 11, color: 'var(--ink-muted)', fontWeight: 500, textTransform: 'uppercase', letterSpacing: '0.06em' }}>Change</div>
          <div style={{ fontSize: 28, fontWeight: 700, fontFamily: 'DM Sans', color: kpi.change >= 0 ? 'var(--positive)' : 'var(--negative)' }}>{pct(kpi.change)}</div>
        </div>
        <div style={{ flex: 1, background: 'var(--bg)', borderRadius: 10, padding: '14px 16px' }}>
          <div style={{ fontSize: 11, color: 'var(--ink-muted)', fontWeight: 500, textTransform: 'uppercase', letterSpacing: '0.06em' }}>Period</div>
          <div style={{ fontSize: 14, fontWeight: 600, fontFamily: 'DM Sans', color: 'var(--ink)', marginTop: 4 }}>{kpi.sub}</div>
        </div>
      </div>

      <div style={{ marginBottom: 16 }}>
        <div style={{ fontSize: 13, fontWeight: 600, color: 'var(--ink)', marginBottom: 12 }}>8-Month Trend</div>
        <ResponsiveContainer width="100%" height={200}>
          <AreaChart data={chartData}>
            <defs>
              <linearGradient id="kpiGrad" x1="0" y1="0" x2="0" y2="1">
                <stop offset="5%" stopColor={kpi.color} stopOpacity={0.18} />
                <stop offset="95%" stopColor={kpi.color} stopOpacity={0} />
              </linearGradient>
            </defs>
            <CartesianGrid stroke="#f0f0f0" strokeDasharray="4 4" />
            <XAxis dataKey="month" tick={{ fontSize: 11 }} axisLine={false} tickLine={false} />
            <YAxis tick={{ fontSize: 11 }} axisLine={false} tickLine={false}
              tickFormatter={v => kpi.unit === 'RWF' ? `${(v / 1000000).toFixed(1)}M` : v.toLocaleString()} />
            <Tooltip content={<ChartTooltip />} />
            <Area type="monotone" dataKey="value" name={kpi.label} stroke={kpi.color}
              fill="url(#kpiGrad)" strokeWidth={2.5} dot={{ r: 4, fill: kpi.color }} />
          </AreaChart>
        </ResponsiveContainer>
      </div>

      <div style={{ display: 'flex', gap: 8, justifyContent: 'flex-end' }}>
        <Btn variant="secondary" small onClick={onClose}>Export CSV</Btn>
        <Btn variant="primary" small onClick={onClose}>View Full Report</Btn>
      </div>
    </Modal>
  )
}

// ─── Export Modal ─────────────────────────────────────────────────────────────

function ExportModal({ onClose }: { onClose: () => void }) {
  const [fmt, setFmt] = useState<'csv' | 'pdf' | 'excel'>('csv')
  const [scope, setScope] = useState<'page' | 'all'>('page')

  return (
    <Modal title="Export / Share Dashboard" onClose={onClose} width={480}>
      <div style={{ display: 'flex', flexDirection: 'column', gap: 16 }}>
        <div>
          <div style={{ fontSize: 12, fontWeight: 600, color: 'var(--ink-muted)', marginBottom: 8, textTransform: 'uppercase', letterSpacing: '0.05em' }}>Format</div>
          <div style={{ display: 'flex', gap: 8 }}>
            {(['csv', 'pdf', 'excel'] as const).map(f => (
              <button key={f} onClick={() => setFmt(f)} style={{
                flex: 1, padding: '10px', borderRadius: 8, border: `1.5px solid ${fmt === f ? 'var(--primary)' : 'var(--border)'}`,
                background: fmt === f ? 'var(--primary-light)' : '#fff', color: fmt === f ? 'var(--primary)' : 'var(--ink-mid)',
                fontWeight: fmt === f ? 600 : 400, fontSize: 13, cursor: 'pointer', fontFamily: 'inherit',
              }}>{f.toUpperCase()}</button>
            ))}
          </div>
        </div>

        <div>
          <div style={{ fontSize: 12, fontWeight: 600, color: 'var(--ink-muted)', marginBottom: 8, textTransform: 'uppercase', letterSpacing: '0.05em' }}>Scope</div>
          <div style={{ display: 'flex', gap: 8 }}>
            {([['page', 'Current View'], ['all', 'All Modules']] as const).map(([v, l]) => (
              <button key={v} onClick={() => setScope(v)} style={{
                flex: 1, padding: '10px', borderRadius: 8, border: `1.5px solid ${scope === v ? 'var(--primary)' : 'var(--border)'}`,
                background: scope === v ? 'var(--primary-light)' : '#fff', color: scope === v ? 'var(--primary)' : 'var(--ink-mid)',
                fontWeight: scope === v ? 600 : 400, fontSize: 13, cursor: 'pointer', fontFamily: 'inherit',
              }}>{l}</button>
            ))}
          </div>
        </div>

        <div style={{ background: 'var(--bg)', borderRadius: 8, padding: '12px 14px', fontSize: 12, color: 'var(--ink-muted)' }}>
          <strong style={{ color: 'var(--ink)' }}>Share Link</strong> — copy a read-only snapshot URL to share with your team
          <div style={{ display: 'flex', gap: 6, marginTop: 8 }}>
            <input readOnly value="https://pharmsync.rw/share/dashboard?token=ps_8f4a..." style={{
              flex: 1, padding: '7px 10px', border: '1px solid var(--border)', borderRadius: 6,
              fontSize: 11, fontFamily: 'JetBrains Mono, monospace', background: '#fff', color: 'var(--ink-mid)',
            }} />
            <Btn variant="secondary" small>Copy</Btn>
          </div>
        </div>

        <div style={{ display: 'flex', gap: 8, justifyContent: 'flex-end', paddingTop: 4 }}>
          <Btn variant="ghost" onClick={onClose}>Cancel</Btn>
          <Btn variant="primary" onClick={onClose}>⬇ Download {fmt.toUpperCase()}</Btn>
        </div>
      </div>
    </Modal>
  )
}

// ─── Builder Panel ────────────────────────────────────────────────────────────

function BuilderPanel({ visible, onToggle, widgetState, onWidgetToggle }: {
  visible: boolean; onToggle: () => void
  widgetState: Record<string, boolean>; onWidgetToggle: (key: string) => void
}) {
  if (!visible) return null
  const widgets = [
    { key: 'kpis', label: 'KPI Cards' },
    { key: 'revChart', label: 'Revenue Trend' },
    { key: 'catChart', label: 'Category Sales' },
    { key: 'daily', label: 'Daily Transactions' },
    { key: 'payment', label: 'Payment Methods' },
    { key: 'alertsFeed', label: 'Alerts Feed' },
    { key: 'topProducts', label: 'Top Products Table' },
  ]

  return (
    <div style={{
      position: 'fixed', right: 0, top: 60, bottom: 0, width: 260, zIndex: 90,
      background: '#fff', borderLeft: '1px solid var(--border)', padding: '16px',
      overflowY: 'auto', boxShadow: '-4px 0 20px rgba(0,0,0,0.06)',
    }}>
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 16 }}>
        <span style={{ fontSize: 14, fontWeight: 700, color: 'var(--ink)' }}>Dashboard Builder</span>
        <button onClick={onToggle} style={{ background: 'none', border: 'none', cursor: 'pointer', fontSize: 16, color: 'var(--ink-muted)' }}>×</button>
      </div>
      <div style={{ fontSize: 11, color: 'var(--ink-muted)', marginBottom: 14 }}>Toggle widgets to customize your layout</div>
      {widgets.map(w => (
        <div key={w.key} style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', padding: '10px 0', borderBottom: '1px solid var(--bg-alt)' }}>
          <span style={{ fontSize: 13, color: 'var(--ink)' }}>{w.label}</span>
          <button onClick={() => onWidgetToggle(w.key)} style={{
            width: 36, height: 20, borderRadius: 10, border: 'none', cursor: 'pointer',
            background: widgetState[w.key] ? 'var(--primary)' : '#d1d5db',
            position: 'relative', transition: 'background 0.2s',
          }}>
            <span style={{
              position: 'absolute', top: 2, left: widgetState[w.key] ? 18 : 2,
              width: 16, height: 16, borderRadius: '50%', background: '#fff',
              transition: 'left 0.2s', boxShadow: '0 1px 3px rgba(0,0,0,0.15)',
            }} />
          </button>
        </div>
      ))}
    </div>
  )
}

// ─── Overview Page ────────────────────────────────────────────────────────────

export default function OverviewPage({
  role, onExport, showBuilder, onToggleBuilder,
}: {
  role: Role; onExport: () => void; showBuilder: boolean; onToggleBuilder: () => void
}) {
  const [activeKPI, setActiveKPI] = useState<string | null>(null)
  const [drillKPI, setDrillKPI] = useState<KPIData | null>(null)
  const [activeCategory, setActiveCategory] = useState<string | null>(null)
  const [widgets, setWidgets] = useState<Record<string, boolean>>({
    kpis: true, revChart: true, catChart: true, daily: true,
    payment: true, alertsFeed: true, topProducts: true,
  })

  const toggleWidget = (key: string) => setWidgets(p => ({ ...p, [key]: !p[key] }))

  const isPharmacist = role === 'pharmacist'
  const MY_BRANCH    = 'Kigali HQ'

  const visibleKPIs = isPharmacist
    ? KPIS.filter(k => ['transactions', 'inventory', 'alerts'].includes(k.id))
    : KPIS

  // Branch isolation: pharmacist only sees their own branch
  const ownBranchProducts = isPharmacist
    ? topProducts.filter(p => p.branch === MY_BRANCH)
    : topProducts

  const filteredProducts = activeCategory
    ? ownBranchProducts.filter(p => p.category === activeCategory)
    : ownBranchProducts

  // Smart insights
  const revenueArr = revenueData.map(d => d.revenue)
  const profitArr  = revenueData.map(d => d.profit)
  const smartInsights = generateSmartInsights(revenueArr, profitArr)

  const filteredCategory = activeCategory
    ? categoryData.filter(c => c.name === activeCategory)
    : categoryData

  return (
    <>
      {/* Toolbar */}
      <div style={{ display: 'flex', gap: 8, marginBottom: 18, alignItems: 'center' }}>
        <span style={{ fontSize: 12, color: 'var(--ink-muted)', flex: 1 }}>
          {activeCategory ? (
            <span>Filtered by: <strong style={{ color: 'var(--primary)' }}>{activeCategory}</strong> &nbsp;
              <button onClick={() => setActiveCategory(null)} style={{ fontSize: 11, color: 'var(--negative)', background: 'none', border: 'none', cursor: 'pointer', fontFamily: 'inherit' }}>✕ Clear</button>
            </span>
          ) : 'Click any chart bar or KPI to filter and drill down'}
        </span>
        <Btn variant="ghost" small onClick={onExport}>↗ Export</Btn>
        <Btn variant={showBuilder ? 'primary' : 'ghost'} small onClick={onToggleBuilder}>⊞ Customize</Btn>
      </div>

      {/* KPI Grid */}
      {widgets.kpis && (
        <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(200px, 1fr))', gap: 12, marginBottom: 16 }}>
          {visibleKPIs.map(k => (
            <KPICard
              key={k.id} kpi={k}
              active={activeKPI === k.id}
              onClick={() => {
                setActiveKPI(activeKPI === k.id ? null : k.id)
                setDrillKPI(k)
              }}
            />
          ))}
        </div>
      )}

      {/* Revenue + Category */}
      <div style={{ display: 'grid', gridTemplateColumns: '1.65fr 1fr', gap: 14, marginBottom: 14 }}>
        {widgets.revChart && (
          <Card>
            <SectionHeader
              title="Revenue & Profit Trend"
              subtitle="Monthly performance vs. target"
              action="Full Report"
              onAction={onExport}
            />
            <ResponsiveContainer width="100%" height={230}>
              <AreaChart data={revenueData} margin={{ top: 4, right: 8, bottom: 0, left: 0 }}>
                <defs>
                  <linearGradient id="gRev" x1="0" y1="0" x2="0" y2="1">
                    <stop offset="5%" stopColor="#1e8a4a" stopOpacity={0.16} />
                    <stop offset="95%" stopColor="#1e8a4a" stopOpacity={0} />
                  </linearGradient>
                  <linearGradient id="gProf" x1="0" y1="0" x2="0" y2="1">
                    <stop offset="5%" stopColor="#34d399" stopOpacity={0.2} />
                    <stop offset="95%" stopColor="#34d399" stopOpacity={0} />
                  </linearGradient>
                </defs>
                <CartesianGrid stroke="#f0f0f0" strokeDasharray="4 4" />
                <XAxis dataKey="month" tick={{ fontSize: 11 }} axisLine={false} tickLine={false} />
                <YAxis tick={{ fontSize: 11 }} axisLine={false} tickLine={false} tickFormatter={v => `${(v / 1000000).toFixed(1)}M`} />
                <Tooltip content={<ChartTooltip />} />
                <Legend iconType="circle" iconSize={8} wrapperStyle={{ fontSize: 11 }} />
                <Area type="monotone" dataKey="revenue" name="Revenue" stroke="#1e8a4a" fill="url(#gRev)" strokeWidth={2.5} dot={false} activeDot={{ r: 5 }} />
                <Area type="monotone" dataKey="profit"  name="Profit"  stroke="#34d399" fill="url(#gProf)" strokeWidth={2.5} dot={false} activeDot={{ r: 5 }} />
                <Line  type="monotone" dataKey="target"  name="Target"  stroke="#d1d5db" strokeDasharray="5 5" strokeWidth={1.5} dot={false} />
              </AreaChart>
            </ResponsiveContainer>
          </Card>
        )}

        {widgets.catChart && (
          <Card>
            <SectionHeader
              title="Sales by Category"
              subtitle={activeCategory ? `Showing: ${activeCategory}` : 'Click a bar to cross-filter'}
            />
            <ResponsiveContainer width="100%" height={230}>
              <BarChart data={filteredCategory} layout="vertical" margin={{ left: 0, right: 8 }}>
                <CartesianGrid strokeDasharray="4 4" stroke="#f0f0f0" horizontal={false} />
                <XAxis type="number" tick={{ fontSize: 10 }} axisLine={false} tickLine={false} tickFormatter={v => `${(v / 1000000).toFixed(1)}M`} />
                <YAxis type="category" dataKey="name" tick={{ fontSize: 10 }} axisLine={false} tickLine={false} width={88} />
                <Tooltip content={<ChartTooltip />} />
                <Bar dataKey="sales" name="Revenue" radius={[0, 5, 5, 0]} barSize={13}
                  onClick={(data: any) => setActiveCategory(activeCategory === data.name ? null : data.name)}
                  cursor="pointer">
                  {filteredCategory.map((c, i) => (
                    <Cell key={i} fill={activeCategory === c.name ? '#1e8a4a' : '#a7f3d0'} />
                  ))}
                </Bar>
              </BarChart>
            </ResponsiveContainer>
          </Card>
        )}
      </div>

      {/* Daily + Payment + Alerts */}
      <div style={{ display: 'grid', gridTemplateColumns: '1fr 0.52fr 0.75fr', gap: 14, marginBottom: 14 }}>
        {widgets.daily && (
          <Card>
            <SectionHeader title="Daily Transactions" subtitle="Volume and amount — this week" />
            <ResponsiveContainer width="100%" height={185}>
              <BarChart data={dailySales} margin={{ top: 4, right: 4, bottom: 0, left: 0 }}>
                <CartesianGrid stroke="#f0f0f0" strokeDasharray="4 4" />
                <XAxis dataKey="day" tick={{ fontSize: 11 }} axisLine={false} tickLine={false} />
                <YAxis tick={{ fontSize: 11 }} axisLine={false} tickLine={false} />
                <Tooltip content={<ChartTooltip />} />
                <Legend iconType="circle" iconSize={8} wrapperStyle={{ fontSize: 11 }} />
                <Bar dataKey="txn" name="Transactions" fill="#1e8a4a" radius={[4, 4, 0, 0]} barSize={22} />
              </BarChart>
            </ResponsiveContainer>
          </Card>
        )}

        {widgets.payment && (
          <Card>
            <SectionHeader title="Payment Mix" />
            <ResponsiveContainer width="100%" height={130}>
              <PieChart>
                <Pie data={paymentMethodData} cx="50%" cy="50%" innerRadius={38} outerRadius={58} paddingAngle={3} dataKey="value">
                  {paymentMethodData.map((e, i) => <Cell key={i} fill={e.color} />)}
                </Pie>
                <Tooltip formatter={(v) => `${v}%`} />
              </PieChart>
            </ResponsiveContainer>
            <div style={{ display: 'flex', flexDirection: 'column', gap: 4, marginTop: 6 }}>
              {paymentMethodData.map(p => (
                <div key={p.name} style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', fontSize: 11 }}>
                  <div style={{ display: 'flex', alignItems: 'center', gap: 5 }}>
                    <div style={{ width: 8, height: 8, borderRadius: 2, background: p.color, flexShrink: 0 }} />
                    <span style={{ color: 'var(--ink-muted)' }}>{p.name}</span>
                  </div>
                  <span style={{ fontWeight: 600, color: 'var(--ink)' }}>{p.value}%</span>
                </div>
              ))}
            </div>
          </Card>
        )}

        {widgets.alertsFeed && (
          <Card style={{ padding: '16px 14px' }}>
            <SectionHeader title="Active Alerts" action={`View all (${alertsData.filter(a => !a.dismissed).length})`} />
            <div style={{ display: 'flex', flexDirection: 'column', gap: 7, overflowY: 'auto', maxHeight: 220 }}>
              {alertsData.filter(a => !a.dismissed).slice(0, 4).map(a => (
                <AlertRow key={a.id} title={a.title} msg={a.msg} time={a.time} type={a.type} />
              ))}
            </div>
          </Card>
        )}
      </div>

      {/* Smart Insights */}
      <div style={{ background: 'linear-gradient(135deg, #ecfdf5, #f0fdf4)', border: '1.5px solid var(--border-strong)', borderRadius: 12, padding: '14px 18px', marginBottom: 14 }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 10 }}>
          <span style={{ fontSize: 18 }}>💡</span>
          <span style={{ fontSize: 14, fontWeight: 700, color: 'var(--ink)', fontFamily: 'DM Sans' }}>Smart Insights</span>
          <span style={{ fontSize: 10, fontWeight: 600, background: 'var(--primary)', color: '#fff', borderRadius: 10, padding: '2px 7px', marginLeft: 2 }}>BETA</span>
          <span style={{ fontSize: 11, color: 'var(--ink-muted)', marginLeft: 4 }}>Powered by moving average trend analysis</span>
        </div>
        <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(260px, 1fr))', gap: 8 }}>
          {smartInsights.map((insight, i) => (
            <div key={i} style={{ background: '#fff', borderRadius: 8, padding: '10px 12px', display: 'flex', gap: 8, alignItems: 'flex-start', border: '1px solid var(--border)' }}>
              <span style={{ fontSize: 14, flexShrink: 0, marginTop: 1 }}>{['📈', '💰', '⚠️', '🎯'][i % 4]}</span>
              <span style={{ fontSize: 12, color: 'var(--ink-mid)', lineHeight: 1.5 }}>{insight}</span>
            </div>
          ))}
        </div>
      </div>

      {/* Break-Even Analysis */}
      <Card style={{ marginBottom: 14 }}>
        <SectionHeader
          title="Break-Even Analysis"
          subtitle={`Break-even point: ${fmtRWF(BREAK_EVEN_REVENUE)} / month — Fixed Costs ÷ (1 − Variable Cost Ratio)`}
        />
        <div style={{ display: 'grid', gridTemplateColumns: '1fr auto', gap: 20, alignItems: 'start' }}>
          <ResponsiveContainer width="100%" height={210}>
            <AreaChart data={breakEvenData} margin={{ top: 6, right: 8, bottom: 0, left: 0 }}>
              <defs>
                <linearGradient id="gRevBE" x1="0" y1="0" x2="0" y2="1">
                  <stop offset="5%" stopColor="#1e8a4a" stopOpacity={0.14} />
                  <stop offset="95%" stopColor="#1e8a4a" stopOpacity={0} />
                </linearGradient>
                <linearGradient id="gCostBE" x1="0" y1="0" x2="0" y2="1">
                  <stop offset="5%" stopColor="#dc2626" stopOpacity={0.1} />
                  <stop offset="95%" stopColor="#dc2626" stopOpacity={0} />
                </linearGradient>
              </defs>
              <CartesianGrid stroke="#f0f0f0" strokeDasharray="4 4" />
              <XAxis dataKey="month" tick={{ fontSize: 11 }} axisLine={false} tickLine={false} />
              <YAxis tick={{ fontSize: 10 }} axisLine={false} tickLine={false} tickFormatter={v => `${(v / 1000000).toFixed(1)}M`} />
              <Tooltip content={<ChartTooltip />} />
              <Legend iconType="circle" iconSize={8} wrapperStyle={{ fontSize: 11 }} />
              <ReferenceLine y={BREAK_EVEN_REVENUE} stroke="#d97706" strokeDasharray="6 3" strokeWidth={1.5} label={{ value: 'Break-Even', fill: '#d97706', fontSize: 10, position: 'insideTopRight' }} />
              <Area type="monotone" dataKey="revenue" name="Revenue" stroke="#1e8a4a" fill="url(#gRevBE)" strokeWidth={2.5} dot={false} activeDot={{ r: 4 }} />
              <Area type="monotone" dataKey="totalCosts" name="Total Costs" stroke="#dc2626" fill="url(#gCostBE)" strokeWidth={2} dot={false} activeDot={{ r: 4 }} />
              <Line type="monotone" dataKey="fixedCosts" name="Fixed Costs" stroke="#9ca3af" strokeDasharray="4 4" strokeWidth={1.5} dot={false} />
            </AreaChart>
          </ResponsiveContainer>
          <div style={{ display: 'flex', flexDirection: 'column', gap: 10, minWidth: 180 }}>
            {[
              { label: 'Break-Even Revenue', value: fmtRWF(BREAK_EVEN_REVENUE), color: '#d97706', icon: '⚖️' },
              { label: 'Fixed Costs/month',  value: fmtRWF(1800000),             color: '#6b7280', icon: '🏢' },
              { label: 'Variable Cost Ratio', value: '45%',                      color: '#dc2626', icon: '📦' },
              { label: 'Profit Zone',         value: breakEvenData.filter(d => d.revenue > BREAK_EVEN_REVENUE).length + ' of 8 months', color: '#16a34a', icon: '✅' },
            ].map(stat => (
              <div key={stat.label} style={{ background: 'var(--bg)', borderRadius: 8, padding: '10px 12px' }}>
                <div style={{ display: 'flex', alignItems: 'center', gap: 5, marginBottom: 2 }}>
                  <span style={{ fontSize: 12 }}>{stat.icon}</span>
                  <span style={{ fontSize: 10, color: 'var(--ink-muted)', fontWeight: 500, textTransform: 'uppercase', letterSpacing: '0.05em' }}>{stat.label}</span>
                </div>
                <div style={{ fontSize: 15, fontWeight: 700, color: stat.color, fontFamily: 'DM Sans' }}>{stat.value}</div>
              </div>
            ))}
          </div>
        </div>
      </Card>

      {/* Top Products */}
      {widgets.topProducts && (
        <Card>
          <SectionHeader
            title={activeCategory ? `Top Products — ${activeCategory}` : 'Top Products by Revenue'}
            action="Export"
            onAction={onExport}
          />
          <div style={{ overflowX: 'auto' }}>
            <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 12 }}>
              <thead>
                <tr style={{ borderBottom: '1px solid var(--border)' }}>
                  {['#', 'Product', 'Category', 'Units Sold', 'Revenue', 'Stock', ...(isPharmacist ? [] : ['Branch']), 'Trend'].map(h => (
                    <th key={h} style={{ textAlign: 'left', padding: '7px 10px', color: 'var(--ink-muted)', fontWeight: 500, fontSize: 11, letterSpacing: '0.04em', whiteSpace: 'nowrap' }}>{h}</th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {filteredProducts.map(p => (
                  <tr key={p.rank}
                    style={{ borderBottom: '1px solid var(--bg-alt)', cursor: 'pointer', transition: 'background 0.13s' }}
                    onMouseEnter={e => (e.currentTarget.style.background = 'var(--bg)')}
                    onMouseLeave={e => (e.currentTarget.style.background = 'transparent')}
                    onClick={() => setActiveCategory(p.category)}
                  >
                    <td style={{ padding: '9px 10px', color: 'var(--ink-faint)', fontFamily: 'JetBrains Mono, monospace', fontSize: 11 }}>{p.rank}</td>
                    <td style={{ padding: '9px 10px', fontWeight: 500, color: 'var(--ink)', whiteSpace: 'nowrap' }}>{p.name}</td>
                    <td style={{ padding: '9px 10px' }}>
                      <StatusBadge label={p.category} color="var(--primary)" bg="var(--primary-light)" />
                    </td>
                    <td style={{ padding: '9px 10px', fontFamily: 'JetBrains Mono, monospace' }}>{p.sold.toLocaleString()}</td>
                    <td style={{ padding: '9px 10px', fontWeight: 600 }}>{fmtRWF(p.revenue)}</td>
                    <td style={{ padding: '9px 10px', fontFamily: 'JetBrains Mono, monospace' }}>{p.stock.toLocaleString()}</td>
                    {!isPharmacist && <td style={{ padding: '9px 10px', fontSize: 11, color: 'var(--ink-muted)' }}>{p.branch}</td>}
                    <td style={{ padding: '9px 10px' }}>
                      <span style={{ fontWeight: 700, fontSize: 12, color: p.trend >= 0 ? 'var(--positive)' : 'var(--negative)' }}>
                        {p.trend >= 0 ? '↑' : '↓'} {Math.abs(p.trend)}%
                      </span>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </Card>
      )}

      {/* Drill-down modal */}
      {drillKPI && activeKPI && (
        <KPIDrillDown kpi={drillKPI} onClose={() => { setDrillKPI(null); setActiveKPI(null) }} />
      )}

      {/* Builder side panel */}
      <BuilderPanel visible={showBuilder} onToggle={onToggleBuilder} widgetState={widgets} onWidgetToggle={toggleWidget} />
    </>
  )
}
