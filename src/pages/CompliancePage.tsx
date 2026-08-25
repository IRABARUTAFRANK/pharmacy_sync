import { BarChart, Bar, XAxis, YAxis, CartesianGrid, Tooltip, ResponsiveContainer } from 'recharts'
import { transactions, fmtRWF } from '../data'
import { Card, SectionHeader, StatusBadge, ChartTooltip, Btn } from '../components'

const taxData = [
  { month: 'Jan', tax: 151200 }, { month: 'Feb', tax: 136800 }, { month: 'Mar', tax: 183600 },
  { month: 'Apr', tax: 169200 }, { month: 'May', tax: 201600 }, { month: 'Jun', tax: 219600 },
  { month: 'Jul', tax: 208800 }, { month: 'Aug', tax: 252000 },
]

export default function CompliancePage() {
  const totalTax = taxData.reduce((s, d) => s + d.tax, 0)
  const totalRevenue = 6400000
  const taxRate = 18

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 18 }}>
      {/* Summary KPIs */}
      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(4, 1fr)', gap: 12 }}>
        {[
          { label: 'Tax Deducted (Aug)',  value: 'RWF 252,000', sub: `${taxRate}% VAT applied`,     color: '#1e5fa8', icon: '🏛️' },
          { label: 'YTD Tax (8 months)',  value: fmtRWF(totalTax),  sub: 'Submitted to RRA',        color: '#3b82f6', icon: '📊' },
          { label: 'RRA Compliance',      value: '100%',             sub: 'All receipts compliant', color: '#16a34a', icon: '✅' },
          { label: 'Next Filing Date',    value: 'Sep 15, 2026',     sub: 'Monthly VAT return',     color: '#d97706', icon: '📅' },
        ].map(k => (
          <div key={k.label} style={{ background: '#fff', borderRadius: 12, padding: '16px 18px', border: '1px solid var(--border)' }}>
            <div style={{ display: 'flex', justifyContent: 'space-between' }}>
              <div>
                <div style={{ fontSize: 20, fontWeight: 700, color: k.color, fontFamily: 'var(--font-display)' }}>{k.value}</div>
                <div style={{ fontSize: 12, fontWeight: 500, color: 'var(--ink)', marginTop: 2 }}>{k.label}</div>
                <div style={{ fontSize: 11, color: 'var(--ink-muted)', marginTop: 1 }}>{k.sub}</div>
              </div>
              <div style={{ fontSize: 22 }}>{k.icon}</div>
            </div>
          </div>
        ))}
      </div>

      {/* Tax chart + Reports */}
      <div style={{ display: 'grid', gridTemplateColumns: '1.4fr 1fr', gap: 14 }}>
        <Card>
          <SectionHeader title="Monthly VAT Deductions" subtitle="18% VAT applied per month" action="Export" />
          <ResponsiveContainer width="100%" height={220}>
            <BarChart data={taxData} margin={{ top: 4, right: 4, bottom: 0, left: 0 }}>
              <CartesianGrid stroke="#f0f0f0" strokeDasharray="4 4" />
              <XAxis dataKey="month" tick={{ fontSize: 11 }} axisLine={false} tickLine={false} />
              <YAxis tick={{ fontSize: 11 }} axisLine={false} tickLine={false} tickFormatter={v => `${v / 1000}K`} />
              <Tooltip content={<ChartTooltip />} />
              <Bar dataKey="tax" name="VAT (RWF)" fill="#1e5fa8" radius={[4, 4, 0, 0]} />
            </BarChart>
          </ResponsiveContainer>
        </Card>

        <div style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
          <Card>
            <SectionHeader title="RRA Report Portal" />
            <p style={{ fontSize: 13, color: 'var(--ink-mid)', margin: '0 0 12px', lineHeight: 1.5 }}>
              Submit VAT returns directly to the Rwanda Revenue Authority portal. All transactions include RRA-compliant TIN, medication breakdown, and receipt numbers.
            </p>
            <div style={{ display: 'flex', gap: 8 }}>
              <Btn variant="primary" style={{ flex: 1, justifyContent: 'center' }}>Submit Aug Return</Btn>
              <Btn variant="ghost">View Portal</Btn>
            </div>
          </Card>

          <Card>
            <SectionHeader title="Report Downloads" />
            <div style={{ display: 'flex', flexDirection: 'column', gap: 2 }}>
              {[
                ['Daily Receipt Summary', 'Aug 15'],
                ['Weekly Sales Report', 'Aug 11–15'],
                ['Monthly VAT Statement', 'August 2026'],
                ['Annual Tax Summary', '2025–2026'],
              ].map(([label, period]) => (
                <div key={label} style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', padding: '9px 0', borderBottom: '1px solid var(--bg-alt)' }}>
                  <div>
                    <div style={{ fontSize: 12, fontWeight: 500, color: 'var(--ink)' }}>{label}</div>
                    <div style={{ fontSize: 10, color: 'var(--ink-muted)' }}>{period}</div>
                  </div>
                  <Btn variant="secondary" small>⬇ PDF</Btn>
                </div>
              ))}
            </div>
          </Card>
        </div>
      </div>

      {/* Transaction Compliance Table */}
      <Card>
        <SectionHeader title="RRA-Compliant Transaction Records" action="Export CSV" />
        <div style={{ overflowX: 'auto' }}>
          <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 12 }}>
            <thead>
              <tr style={{ borderBottom: '1px solid var(--border)' }}>
                {['TXN ID', 'Date', 'Patient', 'Items', 'Subtotal', 'VAT (18%)', 'Total', 'Payment', 'Receipt', 'RRA Status'].map(h => (
                  <th key={h} style={{ textAlign: 'left', padding: '7px 10px', color: 'var(--ink-muted)', fontWeight: 500, fontSize: 11, whiteSpace: 'nowrap' }}>{h}</th>
                ))}
              </tr>
            </thead>
            <tbody>
              {transactions.map(t => {
                const vat = Math.round(t.total * 0.18)
                const sub = t.total - vat
                return (
                  <tr key={t.id}
                    style={{ borderBottom: '1px solid var(--bg-alt)', cursor: 'pointer', transition: 'background 0.13s' }}
                    onMouseEnter={e => (e.currentTarget.style.background = 'var(--bg)')}
                    onMouseLeave={e => (e.currentTarget.style.background = 'transparent')}
                  >
                    <td style={{ padding: '9px 10px', fontFamily: 'var(--font-mono)', fontSize: 11, color: 'var(--primary)', fontWeight: 600 }}>{t.id}</td>
                    <td style={{ padding: '9px 10px', fontSize: 11, color: 'var(--ink-muted)', whiteSpace: 'nowrap' }}>{t.date}</td>
                    <td style={{ padding: '9px 10px', whiteSpace: 'nowrap' }}>{t.patient}</td>
                    <td style={{ padding: '9px 10px', textAlign: 'center', fontFamily: 'var(--font-mono)' }}>{t.items.length}</td>
                    <td style={{ padding: '9px 10px' }}>{fmtRWF(sub)}</td>
                    <td style={{ padding: '9px 10px', color: 'var(--ink-muted)' }}>{fmtRWF(vat)}</td>
                    <td style={{ padding: '9px 10px', fontWeight: 700 }}>{fmtRWF(t.total)}</td>
                    <td style={{ padding: '9px 10px', fontSize: 11, color: 'var(--ink-muted)' }}>{t.payment}</td>
                    <td style={{ padding: '9px 10px', fontSize: 11, color: 'var(--ink-muted)' }}>{t.receipt}</td>
                    <td style={{ padding: '9px 10px' }}>
                      <StatusBadge label="✓ Compliant" color="#16a34a" bg="#d1fae5" />
                    </td>
                  </tr>
                )
              })}
            </tbody>
          </table>
        </div>
      </Card>
    </div>
  )
}
