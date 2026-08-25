import { useState } from 'react'
import {
  LineChart, Line, BarChart, Bar, AreaChart, Area, ScatterChart, Scatter,
  XAxis, YAxis, CartesianGrid, Tooltip, Legend, ResponsiveContainer, ReferenceLine,
} from 'recharts'
import { revenueData, categoryData, fmtRWF, pct } from '../data'
import { Card, SectionHeader, ChartTooltip, Btn } from '../components'

const SCENARIOS = [
  { id: 'conservative', label: 'Conservative', growth: 8,   revenue: 6912000,  confidence: 92, color: '#16a34a', desc: 'Based on historical averages with no seasonal adjustments.' },
  { id: 'base',         label: 'Base Case',    growth: 12.5, revenue: 7200000, confidence: 78, color: '#3b82f6', desc: 'AI model using 8-month trends + seasonal patterns.' },
  { id: 'optimistic',   label: 'Optimistic',   growth: 18,  revenue: 7552000,  confidence: 54, color: '#d97706', desc: 'Assumes successful campaigns + supplier discount negotiations.' },
]

const profitLossData = [
  { month: 'Jan', revenue: 4200000, expenses: 3220000, profit: 980000, taxable: 784000 },
  { month: 'Feb', revenue: 3800000, expenses: 2980000, profit: 820000, taxable: 656000 },
  { month: 'Mar', revenue: 5100000, expenses: 3860000, profit: 1240000, taxable: 992000 },
  { month: 'Apr', revenue: 4700000, expenses: 3600000, profit: 1100000, taxable: 880000 },
  { month: 'May', revenue: 5600000, expenses: 4220000, profit: 1380000, taxable: 1104000 },
  { month: 'Jun', revenue: 6100000, expenses: 4480000, profit: 1620000, taxable: 1296000 },
  { month: 'Jul', revenue: 5800000, expenses: 4310000, profit: 1490000, taxable: 1192000 },
  { month: 'Aug', revenue: 6400000, expenses: 4650000, profit: 1750000, taxable: 1400000 },
]

const marginData = categoryData.map(c => ({
  name: c.name.substring(0, 8),
  margin: c.margin,
  revenue: c.sales / 1000000,
}))

const forecastData = [
  ...revenueData.map(d => ({ month: d.month, actual: d.revenue, forecast: null, upper: null, lower: null })),
  { month: 'Sep', actual: null, forecast: 6900000, upper: 7400000, lower: 6400000 },
  { month: 'Oct', actual: null, forecast: 7200000, upper: 7900000, lower: 6500000 },
  { month: 'Nov', actual: null, forecast: 7600000, upper: 8500000, lower: 6700000 },
]

export default function AnalyticsPage() {
  const [activeScenario, setActiveScenario] = useState('base')
  const [activeMetric, setActiveMetric] = useState<'revenue' | 'profit' | 'expenses'>('revenue')

  const scenario = SCENARIOS.find(s => s.id === activeScenario)!

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 18 }}>
      {/* AI Insight Banner */}
      <div style={{
        background: 'linear-gradient(135deg, #ecfdf5 0%, #f0fdf4 50%, #f8fffe 100%)',
        borderRadius: 12, padding: '16px 20px',
        border: '1.5px solid var(--border-strong)',
        display: 'flex', gap: 16, alignItems: 'flex-start',
      }}>
        <div style={{ fontSize: 32, flexShrink: 0 }}>🤖</div>
        <div style={{ flex: 1 }}>
          <div style={{ fontWeight: 700, fontSize: 14, color: 'var(--ink)', marginBottom: 4 }}>AI Forecast Insight — August 15, 2026</div>
          <div style={{ fontSize: 13, color: 'var(--ink-mid)', lineHeight: 1.6 }}>
            Revenue is projected to reach <strong style={{ color: 'var(--primary)' }}>RWF 7.2M</strong> next month (+12.5%).
            Demand spike predicted for <strong>Antibiotics</strong> and <strong>Antidiabetics</strong> due to seasonal patterns.
            Recommend stocking 30% more Amoxicillin before Aug 20. Profit margin trending <strong>+2.4pp</strong> due to improved supplier terms.
          </div>
        </div>
        <div style={{ display: 'flex', flexDirection: 'column', gap: 6, flexShrink: 0 }}>
          <Btn variant="secondary" small>View Details</Btn>
          <Btn variant="ghost" small>Dismiss</Btn>
        </div>
      </div>

      {/* Revenue Forecast */}
      <Card>
        <SectionHeader title="Revenue Forecast — Aug to Nov 2026" subtitle="Shaded area shows 80% confidence interval" action="Export" />
        <ResponsiveContainer width="100%" height={240}>
          <AreaChart data={forecastData} margin={{ top: 4, right: 8, bottom: 0, left: 0 }}>
            <defs>
              <linearGradient id="gActual" x1="0" y1="0" x2="0" y2="1">
                <stop offset="5%" stopColor="#1e5fa8" stopOpacity={0.18} />
                <stop offset="95%" stopColor="#1e5fa8" stopOpacity={0} />
              </linearGradient>
              <linearGradient id="gUpper" x1="0" y1="0" x2="0" y2="1">
                <stop offset="5%" stopColor="#a7f3d0" stopOpacity={0.35} />
                <stop offset="95%" stopColor="#a7f3d0" stopOpacity={0} />
              </linearGradient>
            </defs>
            <CartesianGrid stroke="#f0f0f0" strokeDasharray="4 4" />
            <XAxis dataKey="month" tick={{ fontSize: 11 }} axisLine={false} tickLine={false} />
            <YAxis tick={{ fontSize: 11 }} axisLine={false} tickLine={false} tickFormatter={v => `${(v / 1000000).toFixed(1)}M`} />
            <Tooltip content={<ChartTooltip />} />
            <Legend iconType="circle" iconSize={8} wrapperStyle={{ fontSize: 11 }} />
            <ReferenceLine x="Sep" stroke="#d1d5db" strokeDasharray="4 4" label={{ value: 'Forecast →', position: 'top', fontSize: 10, fill: '#9ab8a0' }} />
            <Area type="monotone" dataKey="upper" name="Upper bound" stroke="none" fill="url(#gUpper)" />
            <Area type="monotone" dataKey="actual" name="Actual Revenue" stroke="#1e5fa8" fill="url(#gActual)" strokeWidth={2.5} dot={{ r: 4, fill: '#1e5fa8' }} connectNulls />
            <Line type="monotone" dataKey="forecast" name="Forecast" stroke="#3b82f6" strokeDasharray="7 4" strokeWidth={2} dot={{ r: 4, fill: '#3b82f6' }} connectNulls />
          </AreaChart>
        </ResponsiveContainer>
      </Card>

      {/* P&L + Margin */}
      <div style={{ display: 'grid', gridTemplateColumns: '1.4fr 1fr', gap: 14 }}>
        <Card>
          <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 14 }}>
            <div>
              <h2 style={{ margin: 0, fontSize: 14, fontWeight: 600, color: 'var(--ink)' }}>Profit & Loss Statement</h2>
              <p style={{ margin: '2px 0 0', fontSize: 11, color: 'var(--ink-muted)' }}>8-month cumulative view</p>
            </div>
            <div style={{ display: 'flex', gap: 6 }}>
              {(['revenue', 'profit', 'expenses'] as const).map(m => (
                <button key={m} onClick={() => setActiveMetric(m)} style={{
                  padding: '4px 10px', borderRadius: 6, border: `1px solid ${activeMetric === m ? 'var(--primary)' : 'var(--border)'}`,
                  background: activeMetric === m ? 'var(--primary-light)' : '#fff',
                  color: activeMetric === m ? 'var(--primary)' : 'var(--ink-muted)',
                  fontSize: 11, fontWeight: activeMetric === m ? 600 : 400, cursor: 'pointer', fontFamily: 'inherit',
                }}>{m.charAt(0).toUpperCase() + m.slice(1)}</button>
              ))}
            </div>
          </div>
          <ResponsiveContainer width="100%" height={220}>
            <BarChart data={profitLossData} margin={{ top: 4, right: 4, bottom: 0, left: 0 }}>
              <CartesianGrid stroke="#f0f0f0" strokeDasharray="4 4" />
              <XAxis dataKey="month" tick={{ fontSize: 11 }} axisLine={false} tickLine={false} />
              <YAxis tick={{ fontSize: 11 }} axisLine={false} tickLine={false} tickFormatter={v => `${(v / 1000000).toFixed(1)}M`} />
              <Tooltip content={<ChartTooltip />} />
              {activeMetric === 'revenue' && <Bar dataKey="revenue" name="Revenue" fill="#1e5fa8" radius={[4, 4, 0, 0]} />}
              {activeMetric === 'profit' && <Bar dataKey="profit" name="Net Profit" fill="#60a5fa" radius={[4, 4, 0, 0]} />}
              {activeMetric === 'expenses' && <Bar dataKey="expenses" name="Expenses" fill="#fca5a5" radius={[4, 4, 0, 0]} />}
            </BarChart>
          </ResponsiveContainer>
        </Card>

        <Card>
          <SectionHeader title="Margin by Category" subtitle="Gross margin % per category" />
          <ResponsiveContainer width="100%" height={220}>
            <BarChart data={marginData} layout="vertical" margin={{ left: 0, right: 8 }}>
              <CartesianGrid strokeDasharray="4 4" stroke="#f0f0f0" horizontal={false} />
              <XAxis type="number" tick={{ fontSize: 10 }} axisLine={false} tickLine={false} domain={[0, 45]} tickFormatter={v => `${v}%`} />
              <YAxis type="category" dataKey="name" tick={{ fontSize: 10 }} axisLine={false} tickLine={false} width={70} />
              <Tooltip content={<ChartTooltip />} />
              <Bar dataKey="margin" name="Margin %" fill="#1e5fa8" radius={[0, 5, 5, 0]} barSize={13} />
            </BarChart>
          </ResponsiveContainer>
        </Card>
      </div>

      {/* Scenario Planner */}
      <Card>
        <SectionHeader title="AI Autonomous Predictions — Scenario Planner" subtitle="Select a scenario to explore next-month outcomes" />
        <div style={{ display: 'grid', gridTemplateColumns: 'repeat(3, 1fr)', gap: 12, marginBottom: 18 }}>
          {SCENARIOS.map(s => (
            <div key={s.id}
              onClick={() => setActiveScenario(s.id)}
              style={{
                borderRadius: 10, padding: '16px 18px',
                border: `2px solid ${activeScenario === s.id ? s.color : 'var(--border)'}`,
                background: activeScenario === s.id ? s.color + '08' : 'var(--bg)',
                cursor: 'pointer', transition: 'all 0.18s',
              }}>
              <div style={{ fontSize: 11, fontWeight: 600, color: 'var(--ink-muted)', marginBottom: 4, textTransform: 'uppercase', letterSpacing: '0.06em' }}>{s.label}</div>
              <div style={{ fontSize: 28, fontWeight: 800, color: s.color, fontFamily: 'var(--font-display)', letterSpacing: '-0.02em' }}>{pct(s.growth)}</div>
              <div style={{ fontSize: 13, color: 'var(--ink)', fontWeight: 600, marginTop: 2 }}>{fmtRWF(s.revenue)}</div>
              <div style={{ fontSize: 11, color: 'var(--ink-muted)', marginTop: 6, lineHeight: 1.5 }}>{s.desc}</div>
              <div style={{ marginTop: 8, display: 'flex', alignItems: 'center', gap: 6 }}>
                <div style={{ flex: 1, height: 5, background: 'var(--border)', borderRadius: 3, overflow: 'hidden' }}>
                  <div style={{ width: `${s.confidence}%`, height: '100%', background: s.color, borderRadius: 3, transition: 'width 0.4s' }} />
                </div>
                <span style={{ fontSize: 11, fontWeight: 700, color: s.color }}>{s.confidence}%</span>
              </div>
              <div style={{ fontSize: 10, color: 'var(--ink-muted)', marginTop: 1 }}>Confidence</div>
            </div>
          ))}
        </div>

        {/* Selected scenario detail */}
        <div style={{
          background: 'var(--bg)', borderRadius: 10, padding: '16px 18px',
          border: `1px solid ${scenario.color}30`,
          display: 'grid', gridTemplateColumns: 'repeat(5, 1fr)', gap: 12,
        }}>
          <div>
            <div style={{ fontSize: 10, color: 'var(--ink-muted)', fontWeight: 500, textTransform: 'uppercase', marginBottom: 3 }}>Projected Revenue</div>
            <div style={{ fontSize: 18, fontWeight: 700, color: scenario.color, fontFamily: 'var(--font-display)' }}>{fmtRWF(scenario.revenue)}</div>
          </div>
          <div>
            <div style={{ fontSize: 10, color: 'var(--ink-muted)', fontWeight: 500, textTransform: 'uppercase', marginBottom: 3 }}>Growth Rate</div>
            <div style={{ fontSize: 18, fontWeight: 700, color: scenario.color, fontFamily: 'var(--font-display)' }}>{pct(scenario.growth)}</div>
          </div>
          <div>
            <div style={{ fontSize: 10, color: 'var(--ink-muted)', fontWeight: 500, textTransform: 'uppercase', marginBottom: 3 }}>Est. Profit</div>
            <div style={{ fontSize: 18, fontWeight: 700, color: 'var(--ink)', fontFamily: 'var(--font-display)' }}>{fmtRWF(scenario.revenue * 0.27)}</div>
          </div>
          <div>
            <div style={{ fontSize: 10, color: 'var(--ink-muted)', fontWeight: 500, textTransform: 'uppercase', marginBottom: 3 }}>Confidence</div>
            <div style={{ fontSize: 18, fontWeight: 700, color: scenario.color, fontFamily: 'var(--font-display)' }}>{scenario.confidence}%</div>
          </div>
          <div>
            <div style={{ fontSize: 10, color: 'var(--ink-muted)', fontWeight: 500, textTransform: 'uppercase', marginBottom: 3 }}>Key Driver</div>
            <div style={{ fontSize: 13, fontWeight: 600, color: 'var(--ink)', marginTop: 4 }}>Antibiotics demand ↑</div>
          </div>
        </div>
      </Card>

      {/* Customizable Reports */}
      <Card>
        <SectionHeader title="Customizable Reports" action="Generate Report" />
        <div style={{ display: 'grid', gridTemplateColumns: 'repeat(3, 1fr)', gap: 10 }}>
          {[
            { icon: '📊', title: 'Sales Performance', desc: 'Revenue, transactions, avg basket by branch', type: 'Sales' },
            { icon: '📦', title: 'Inventory Turnover', desc: 'Stock velocity, slow-movers, reorder analysis', type: 'Inventory' },
            { icon: '💰', title: 'Profit & Loss', desc: 'Full P&L with tax deductions by period', type: 'Finance' },
            { icon: '🏥', title: 'Insurance Claims', desc: 'Claims by insurer, pending, approved amounts', type: 'Insurance' },
            { icon: '👤', title: 'Patient Analytics', desc: 'Visit frequency, spending patterns, demographics', type: 'Patients' },
            { icon: '📋', title: 'RRA Compliance', desc: 'Tax report ready for RRA portal submission', type: 'Compliance' },
          ].map(r => (
            <div key={r.title} style={{
              padding: '14px 16px', border: '1px solid var(--border)', borderRadius: 10,
              cursor: 'pointer', transition: 'all 0.15s', background: '#fff',
            }}
              onMouseEnter={e => { (e.currentTarget as HTMLDivElement).style.borderColor = 'var(--border-strong)'; (e.currentTarget as HTMLDivElement).style.background = 'var(--bg)' }}
              onMouseLeave={e => { (e.currentTarget as HTMLDivElement).style.borderColor = 'var(--border)'; (e.currentTarget as HTMLDivElement).style.background = '#fff' }}
            >
              <div style={{ fontSize: 20, marginBottom: 6 }}>{r.icon}</div>
              <div style={{ fontSize: 13, fontWeight: 600, color: 'var(--ink)', marginBottom: 3 }}>{r.title}</div>
              <div style={{ fontSize: 11, color: 'var(--ink-muted)', lineHeight: 1.4 }}>{r.desc}</div>
              <div style={{ marginTop: 8, fontSize: 10, fontWeight: 600, color: 'var(--primary)', textTransform: 'uppercase', letterSpacing: '0.05em' }}>{r.type}</div>
            </div>
          ))}
        </div>
      </Card>
    </div>
  )
}
