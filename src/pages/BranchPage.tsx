import { Card, SectionHeader, Btn, ProgressBar } from '../components'

const branchData = [
  { name: 'Kigali HQ',   revenue: 3840000, staff: 8,  status: 'active', manager: 'Dr. Alice Kayitesi',    address: 'KG 12 Ave, Kiyovu, Kigali' },
  { name: 'Musanze',     revenue: 1280000, staff: 4,  status: 'active', manager: 'Pharm. Bob Mugisha',     address: 'Musanze Market Street, Ruhengeri' },
  { name: 'Butare',      revenue: 760000,  staff: 3,  status: 'active', manager: 'Pharm. Claire Nzeyimana', address: 'NUR Campus Road, Huye' },
  { name: 'Gisenyi',     revenue: 520000,  staff: 3,  status: 'active', manager: 'Pharm. David Habimana',  address: 'Rubavu Lakeshore Road' },
  { name: 'Ruhango',     revenue: 0,        staff: 0,  status: 'opening', manager: '—',                   address: 'TBD — Opening Oct 2026' },
]

const maxRevenue = Math.max(...branchData.map(b => b.revenue))

export default function BranchPage() {
  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 18 }}>
      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(3, 1fr)', gap: 12 }}>
        {[
          { label: 'Active Branches',  value: '4', icon: '🏪', color: '#1e5fa8' },
          { label: 'Total Staff',      value: '18', icon: '👥', color: '#0284c7' },
          { label: 'Opening Soon',     value: '1', icon: '🔜', color: '#d97706' },
        ].map(k => (
          <div key={k.label} style={{ background: '#fff', borderRadius: 12, padding: '16px 18px', border: '1px solid var(--border)', display: 'flex', alignItems: 'center', gap: 12 }}>
            <div style={{ fontSize: 24 }}>{k.icon}</div>
            <div>
              <div style={{ fontSize: 26, fontWeight: 700, color: k.color, fontFamily: 'var(--font-display)' }}>{k.value}</div>
              <div style={{ fontSize: 12, color: 'var(--ink-muted)', fontWeight: 500 }}>{k.label}</div>
            </div>
          </div>
        ))}
      </div>

      <Card>
        <div style={{ display: 'flex', justifyContent: 'space-between', marginBottom: 14 }}>
          <div>
            <h2 style={{ margin: 0, fontSize: 14, fontWeight: 600, color: 'var(--ink)' }}>Branch Overview</h2>
            <p style={{ margin: '2px 0 0', fontSize: 11, color: 'var(--ink-muted)' }}>Click a branch to configure settings</p>
          </div>
          <Btn variant="primary" small>+ New Branch</Btn>
        </div>

        <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
          {branchData.map(b => (
            <div key={b.name} style={{
              padding: '14px 16px', border: '1px solid var(--border)', borderRadius: 10,
              display: 'flex', alignItems: 'center', gap: 16, cursor: 'pointer', transition: 'all 0.15s',
            }}
              onMouseEnter={e => { (e.currentTarget as HTMLDivElement).style.background = 'var(--bg)'; (e.currentTarget as HTMLDivElement).style.borderColor = 'var(--border-strong)' }}
              onMouseLeave={e => { (e.currentTarget as HTMLDivElement).style.background = ''; (e.currentTarget as HTMLDivElement).style.borderColor = 'var(--border)' }}
            >
              <div style={{ width: 36, height: 36, borderRadius: 9, background: b.status === 'active' ? 'var(--primary-light)' : '#fef3c7', display: 'flex', alignItems: 'center', justifyContent: 'center', fontSize: 18, flexShrink: 0 }}>
                {b.status === 'active' ? '🏪' : '🔜'}
              </div>
              <div style={{ flex: 1, minWidth: 0 }}>
                <div style={{ fontSize: 14, fontWeight: 700, color: 'var(--ink)' }}>{b.name}</div>
                <div style={{ fontSize: 11, color: 'var(--ink-muted)', marginTop: 1 }}>{b.address}</div>
                <div style={{ fontSize: 11, color: 'var(--ink-muted)' }}>Manager: {b.manager} · {b.staff} staff</div>
              </div>
              <div style={{ width: 160, flexShrink: 0 }}>
                {b.status === 'active' ? (
                  <>
                    <div style={{ display: 'flex', justifyContent: 'space-between', fontSize: 12, marginBottom: 4 }}>
                      <span style={{ color: 'var(--ink-muted)' }}>Revenue</span>
                      <span style={{ fontWeight: 700, color: 'var(--ink)' }}>{b.revenue >= 1000000 ? `RWF ${(b.revenue / 1000000).toFixed(2)}M` : `RWF ${(b.revenue / 1000).toFixed(0)}K`}</span>
                    </div>
                    <ProgressBar value={b.revenue} max={maxRevenue} height={6} />
                    <div style={{ fontSize: 10, color: 'var(--ink-faint)', marginTop: 3, textAlign: 'right' }}>
                      {Math.round((b.revenue / branchData.filter(x => x.status === 'active').reduce((s, x) => s + x.revenue, 0)) * 100)}% of total
                    </div>
                  </>
                ) : (
                  <span style={{ fontSize: 11, fontWeight: 600, background: '#fef3c7', color: '#d97706', borderRadius: 5, padding: '3px 8px' }}>Opening Oct 2026</span>
                )}
              </div>
              <Btn variant="ghost" small>Configure →</Btn>
            </div>
          ))}
        </div>
      </Card>

      {/* Settings panels */}
      <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 14 }}>
        <Card>
          <SectionHeader title="Tax & Compliance Settings" />
          <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
            {[
              { label: 'TIN Number',    value: '102381027', editable: false },
              { label: 'VAT Rate',      value: '18%',       editable: false },
              { label: 'RRA API Key',   value: '••••••••••••••••', editable: true },
              { label: 'Filing Period', value: 'Monthly',   editable: true },
            ].map(s => (
              <div key={s.label} style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', padding: '8px 0', borderBottom: '1px solid var(--bg-alt)' }}>
                <div>
                  <div style={{ fontSize: 12, fontWeight: 500, color: 'var(--ink)' }}>{s.label}</div>
                  <div style={{ fontSize: 12, color: 'var(--ink-muted)', fontFamily: 'var(--font-mono)' }}>{s.value}</div>
                </div>
                {s.editable && <Btn variant="ghost" small>Edit</Btn>}
              </div>
            ))}
          </div>
        </Card>

        <Card>
          <SectionHeader title="Role & Access Management" />
          <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
            {[
              { role: 'Owner',      access: 'All modules + branch settings', count: 1, color: '#1e5fa8' },
              { role: 'Manager',    access: 'All except branch settings',    count: 4, color: '#0284c7' },
              { role: 'Pharmacist', access: 'Inventory, POS, alerts',        count: 12, color: '#7c3aed' },
              { role: 'Auditor',    access: 'Read-only — all reports',       count: 1, color: '#d97706' },
            ].map(r => (
              <div key={r.role} style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', padding: '8px 0', borderBottom: '1px solid var(--bg-alt)' }}>
                <div style={{ display: 'flex', gap: 10, alignItems: 'center' }}>
                  <div style={{ width: 32, height: 32, borderRadius: 8, background: r.color + '18', display: 'flex', alignItems: 'center', justifyContent: 'center', fontSize: 12, fontWeight: 700, color: r.color }}>{r.count}</div>
                  <div>
                    <div style={{ fontSize: 12, fontWeight: 600, color: 'var(--ink)' }}>{r.role}</div>
                    <div style={{ fontSize: 11, color: 'var(--ink-muted)' }}>{r.access}</div>
                  </div>
                </div>
                <Btn variant="ghost" small>Manage</Btn>
              </div>
            ))}
          </div>
        </Card>
      </div>
    </div>
  )
}
