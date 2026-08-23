import { useState, useEffect } from 'react'
import { NAV_ITEMS, alertsData, PAGE_LABELS, type Role } from './data'
import LiveInventoryPage from './pages/LiveInventoryPage'
import StockReceivingPage from './pages/StockReceivingPage'
import BarcodeManagerPage from './pages/BarcodeManagerPage'
import DatabaseBackedPage from './pages/DatabaseBackedPage'
import BranchAccessPage from './pages/BranchAccessPage'
import { restoreBranchAccess, signOutFromBranch, type BranchAccess } from './lib/auth'

// ─── Role Config ──────────────────────────────────────────────────────────────

const ROLES: { id: Role; label: string; abbr: string; color: string }[] = [
  { id: 'owner',      label: 'Owner',      abbr: 'OW', color: '#1e8a4a' },
  { id: 'manager',    label: 'Manager',    abbr: 'MG', color: '#0284c7' },
  { id: 'pharmacist', label: 'Pharmacist', abbr: 'PH', color: '#7c3aed' },
]

// ─── Export Modal (inline here, used from any page) ───────────────────────────

function ExportModal({ onClose }: { onClose: () => void }) {
  const [fmt, setFmt] = useState<'csv' | 'pdf' | 'excel'>('pdf')
  return (
    <div style={{ position: 'fixed', inset: 0, zIndex: 300, background: 'rgba(13,31,18,0.45)', display: 'flex', alignItems: 'center', justifyContent: 'center', padding: 20 }}
      onClick={onClose}
    >
      <div style={{ background: '#fff', borderRadius: 14, width: '100%', maxWidth: 440, boxShadow: '0 24px 64px rgba(0,0,0,0.14)', overflow: 'hidden' }}
        onClick={e => e.stopPropagation()}
      >
        <div style={{ padding: '16px 20px', borderBottom: '1px solid var(--border)', display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
          <span style={{ fontWeight: 700, fontSize: 15 }}>Export Dashboard</span>
          <button onClick={onClose} style={{ background: 'none', border: 'none', cursor: 'pointer', fontSize: 20, color: 'var(--ink-muted)', lineHeight: 1 }}>×</button>
        </div>
        <div style={{ padding: 20, display: 'flex', flexDirection: 'column', gap: 14 }}>
          <div>
            <div style={{ fontSize: 11, fontWeight: 600, color: 'var(--ink-muted)', textTransform: 'uppercase', letterSpacing: '0.05em', marginBottom: 8 }}>Format</div>
            <div style={{ display: 'flex', gap: 8 }}>
              {(['csv', 'pdf', 'excel'] as const).map(f => (
                <button key={f} onClick={() => setFmt(f)} style={{
                  flex: 1, padding: '10px', borderRadius: 8, fontFamily: 'inherit', cursor: 'pointer',
                  border: `1.5px solid ${fmt === f ? 'var(--primary)' : 'var(--border)'}`,
                  background: fmt === f ? 'var(--primary-light)' : '#fff',
                  color: fmt === f ? 'var(--primary)' : 'var(--ink-mid)',
                  fontWeight: fmt === f ? 700 : 400, fontSize: 13,
                }}>{f.toUpperCase()}</button>
              ))}
            </div>
          </div>
          <div style={{ background: 'var(--bg)', borderRadius: 8, padding: '12px 14px', fontSize: 12, color: 'var(--ink-muted)' }}>
            <strong style={{ color: 'var(--ink)' }}>Share Link</strong>
            <div style={{ display: 'flex', gap: 6, marginTop: 8 }}>
              <input readOnly value="https://pharmsync.rw/share?token=ps_8f4a2c..." style={{
                flex: 1, padding: '7px 10px', border: '1px solid var(--border)', borderRadius: 6,
                fontSize: 11, fontFamily: 'JetBrains Mono, monospace', background: '#fff', outline: 'none',
              }} />
              <button style={{ padding: '7px 12px', background: 'var(--primary-light)', color: 'var(--primary)', border: '1px solid var(--border-strong)', borderRadius: 6, fontSize: 11, fontWeight: 600, cursor: 'pointer', fontFamily: 'inherit' }}>Copy</button>
            </div>
          </div>
          <div style={{ display: 'flex', gap: 8, justifyContent: 'flex-end' }}>
            <button onClick={onClose} style={{ padding: '8px 16px', background: '#fff', border: '1px solid var(--border)', borderRadius: 8, fontSize: 13, cursor: 'pointer', fontFamily: 'inherit', color: 'var(--ink-mid)' }}>Cancel</button>
            <button onClick={onClose} style={{ padding: '8px 20px', background: 'var(--primary)', border: 'none', borderRadius: 8, fontSize: 13, fontWeight: 600, cursor: 'pointer', fontFamily: 'inherit', color: '#fff' }}>⬇ Download {fmt.toUpperCase()}</button>
          </div>
        </div>
      </div>
    </div>
  )
}

// ─── Notifications Dropdown ───────────────────────────────────────────────────

function NotifDropdown({ onClose }: { onClose: () => void }) {
  const active = alertsData.filter(a => !a.dismissed)
  return (
    <div style={{
      position: 'absolute', right: 0, top: '110%', width: 340, zIndex: 100,
      background: '#fff', border: '1px solid var(--border)', borderRadius: 12,
      boxShadow: '0 8px 32px rgba(0,0,0,0.10)', overflow: 'hidden',
    }}>
      <div style={{ padding: '12px 14px', borderBottom: '1px solid var(--border)', display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
        <span style={{ fontWeight: 600, fontSize: 13, color: 'var(--ink)' }}>Notifications</span>
        <span style={{ fontSize: 11, fontWeight: 600, background: '#fee2e2', color: '#dc2626', borderRadius: 10, padding: '1px 7px' }}>{active.length} active</span>
      </div>
      <div style={{ maxHeight: 340, overflowY: 'auto' }}>
        {active.map(a => {
          const dot: Record<string, string> = { critical: '#dc2626', warning: '#d97706', info: '#16a34a' }
          const bg: Record<string, string> = { critical: '#fef2f2', warning: '#fffbeb', info: '#f0fdf4' }
          return (
            <div key={a.id} style={{ padding: '10px 14px', borderBottom: '1px solid var(--bg-alt)', display: 'flex', gap: 10, background: bg[a.type] + '60' }}>
              <div style={{ width: 7, height: 7, borderRadius: '50%', background: dot[a.type], marginTop: 4, flexShrink: 0 }} />
              <div style={{ flex: 1, minWidth: 0 }}>
                <div style={{ fontSize: 12, fontWeight: 600, color: dot[a.type] }}>{a.title}</div>
                <div style={{ fontSize: 11, color: 'var(--ink-mid)', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{a.msg}</div>
                <div style={{ fontSize: 10, color: 'var(--ink-faint)', marginTop: 2 }}>{a.branch} · {a.time}</div>
              </div>
            </div>
          )
        })}
      </div>
      <div style={{ padding: '10px 14px', borderTop: '1px solid var(--border)', textAlign: 'center' }}>
        <button onClick={onClose} style={{ fontSize: 12, color: 'var(--primary)', background: 'none', border: 'none', cursor: 'pointer', fontWeight: 600, fontFamily: 'inherit' }}>View all alerts →</button>
      </div>
    </div>
  )
}

// ─── User Menu ────────────────────────────────────────────────────────────────

function UserMenu({ access, role, onRoleChange, onSignOut, onClose }: { access: BranchAccess; role: Role; onRoleChange: (r: Role) => void; onSignOut: () => void; onClose: () => void }) {
  return (
    <div style={{
      position: 'absolute', right: 0, top: '110%', width: 220, zIndex: 100,
      background: '#fff', border: '1px solid var(--border)', borderRadius: 12,
      boxShadow: '0 8px 32px rgba(0,0,0,0.10)', overflow: 'hidden',
    }}>
      <div style={{ padding: '12px 14px', borderBottom: '1px solid var(--border)' }}>
        <div style={{ fontSize: 13, fontWeight: 700, color: 'var(--ink)' }}>{access.fullName}</div>
        <div style={{ fontSize: 11, color: 'var(--ink-muted)' }}>{access.branchName} · {ROLES.find(r => r.id === role)?.label}</div>
      </div>
      <div style={{ display: 'none' }} aria-hidden="true">
        <div style={{ fontSize: 10, fontWeight: 600, color: 'var(--ink-muted)', textTransform: 'uppercase', letterSpacing: '0.06em', marginBottom: 6 }}>Switch Role (Demo)</div>
        {ROLES.map(r => (
          <button key={r.id} onClick={() => { onRoleChange(r.id); onClose() }} style={{
            width: '100%', textAlign: 'left', padding: '8px 10px', borderRadius: 7, border: 'none',
            background: role === r.id ? r.color + '12' : 'none',
            color: role === r.id ? r.color : 'var(--ink-mid)',
            fontWeight: role === r.id ? 700 : 400, fontSize: 12, cursor: 'pointer', fontFamily: 'inherit',
            display: 'flex', alignItems: 'center', gap: 8, transition: 'background 0.13s',
          }}
            onMouseEnter={e => { if (role !== r.id) (e.currentTarget as HTMLButtonElement).style.background = 'var(--bg)' }}
            onMouseLeave={e => { if (role !== r.id) (e.currentTarget as HTMLButtonElement).style.background = 'none' }}
          >
            <span style={{ width: 24, height: 24, borderRadius: 6, background: r.color + '20', display: 'flex', alignItems: 'center', justifyContent: 'center', fontSize: 10, fontWeight: 700, color: r.color }}>
              {r.abbr}
            </span>
            {r.label}
          </button>
        ))}
      </div>
      <div style={{ padding: '8px 14px', borderTop: '1px solid var(--border)' }}>
        <button onClick={onSignOut} style={{ width: '100%', textAlign: 'left', padding: '8px 10px', borderRadius: 7, border: 'none', background: 'none', color: '#dc2626', fontSize: 12, cursor: 'pointer', fontFamily: 'inherit' }}>Sign Out</button>
      </div>
    </div>
  )
}

// ─── Main App ─────────────────────────────────────────────────────────────────

export default function App() {
  const [page, setPage]             = useState('overview')
  const [access, setAccess]         = useState<BranchAccess | null>(null)
  const [accessLoading, setAccessLoading] = useState(true)
  const [search, setSearch]         = useState('')
  const [dateRange, setDateRange]   = useState('This Month')
  const [sidebarOpen, setSidebarOpen] = useState(true)
  const [showNotif, setShowNotif]   = useState(false)
  const [showUser, setShowUser]     = useState(false)
  const [showExport, setShowExport] = useState(false)

  const [isOnline, setIsOnline] = useState(navigator.onLine)
  const [pendingSync, setPendingSync] = useState(0)

  useEffect(() => {
    const up   = () => { setIsOnline(true);  setPendingSync(0) }
    const down = () => { setIsOnline(false); setPendingSync(p => p + Math.floor(Math.random() * 3) + 1) }
    window.addEventListener('online', up)
    window.addEventListener('offline', down)
    return () => { window.removeEventListener('online', up); window.removeEventListener('offline', down) }
  }, [])

  useEffect(() => {
    void restoreBranchAccess().then(setAccess).finally(() => setAccessLoading(false))
  }, [])

  const role: Role = access?.role === 'owner' || access?.role === 'manager' || access?.role === 'pharmacist'
    ? access.role
    : 'pharmacist'

  async function handleSignOut() {
    await signOutFromBranch()
    setAccess(null)
    setPage('overview')
    setShowUser(false)
  }

  if (accessLoading) {
    return <main style={{ minHeight: '100vh', display: 'grid', placeItems: 'center', background: 'var(--bg)', color: 'var(--ink-muted)', fontFamily: 'Inter, sans-serif' }}>Loading workspace…</main>
  }

  if (!access) {
    return <BranchAccessPage onAccess={branchAccess => { setAccess(branchAccess); setPage('overview') }} />
  }

  const currentRole = ROLES.find(r => r.id === role)!
  const visibleNav = NAV_ITEMS.filter(n => n.roles.includes(role))
  const alertCount = alertsData.filter(a => !a.dismissed).length

  const closeMenus = () => { setShowNotif(false); setShowUser(false) }

  function renderPage() {
    switch (page) {
      case 'overview':      return <DatabaseBackedPage title="Dashboard" tables="sales · sale_items · stock_batches · notifications" />
      case 'inventory':     return <LiveInventoryPage />
      case 'receiving':     return <StockReceivingPage />
      case 'barcode':       return <BarcodeManagerPage />
      case 'sales':         return <DatabaseBackedPage title="Sales & POS" tables="sales · sale_items · receipts" />
      case 'analytics':     return <DatabaseBackedPage title="Analytics" tables="sales · sale_items · sales_forecasts" />
      case 'alerts':        return <DatabaseBackedPage title="Alerts" tables="notifications · batch_recalls · stock_adjustments" />
      case 'transactions':  return <DatabaseBackedPage title="Transactions" tables="sales · sale_items · receipts" />
      case 'compliance':    return <DatabaseBackedPage title="Compliance" tables="sales · tax_rates" />
      case 'insurance':     return <DatabaseBackedPage title="Insurance" tables="insurance_claims · insurance_providers" />
      case 'branch':        return <DatabaseBackedPage title="Branch Management" tables="branches · users · branch_settings" />
      case 'help':          return <DatabaseBackedPage title="Support" tables="support_tickets" />
      default:              return null
    }
  }

  const sidebarW = sidebarOpen ? 240 : 60

  return (
    <div className="app-shell" style={{ display: 'flex', height: '100vh', overflow: 'hidden', background: 'var(--bg)', fontFamily: 'Inter, sans-serif', fontSize: 13 }}>

      {/* ── Sidebar ──────────────────────────────────────────────────────────── */}
      <aside className="app-chrome" style={{
        width: sidebarW, minWidth: sidebarW, background: '#fff',
        borderRight: '1px solid var(--border)', display: 'flex', flexDirection: 'column',
        transition: 'width 0.22s, min-width 0.22s', overflow: 'hidden', flexShrink: 0, zIndex: 10,
      }}>
        {/* Logo */}
        <div style={{ height: 60, padding: sidebarOpen ? '0 16px' : '0 14px', display: 'flex', alignItems: 'center', gap: 10, borderBottom: '1px solid var(--border)', flexShrink: 0 }}>
          <div style={{
            width: 32, height: 32, borderRadius: 9, background: 'var(--primary)',
            display: 'flex', alignItems: 'center', justifyContent: 'center',
            fontWeight: 800, fontSize: 13, color: '#fff', flexShrink: 0, fontFamily: 'DM Sans, sans-serif',
          }}>Rx</div>
          {sidebarOpen && (
            <div style={{ overflow: 'hidden', whiteSpace: 'nowrap' }}>
              <div style={{ fontSize: 14, fontWeight: 700, color: 'var(--ink)', fontFamily: 'DM Sans, sans-serif', letterSpacing: '-0.01em' }}>PharmSync</div>
              <div style={{ fontSize: 10, color: 'var(--ink-muted)', fontWeight: 500, marginTop: 1 }}>The Pharmacy Sync</div>
            </div>
          )}
        </div>

        {/* Role pill */}
        {sidebarOpen && (
          <div style={{ padding: '10px 12px', borderBottom: '1px solid var(--bg-alt)', flexShrink: 0 }}>
            <div style={{
              background: currentRole.color + '14', border: `1px solid ${currentRole.color}30`,
              borderRadius: 8, padding: '7px 10px', display: 'flex', alignItems: 'center', gap: 8,
            }}>
              <div style={{ width: 26, height: 26, borderRadius: 6, background: currentRole.color + '22', display: 'flex', alignItems: 'center', justifyContent: 'center', fontSize: 10, fontWeight: 800, color: currentRole.color }}>
                {currentRole.abbr}
              </div>
              <div>
                <div style={{ fontSize: 12, fontWeight: 700, color: currentRole.color }}>{currentRole.label}</div>
                <div style={{ fontSize: 10, color: 'var(--ink-muted)' }}>{access.branchName}</div>
              </div>
            </div>
          </div>
        )}

        {/* Nav items */}
        <nav style={{ flex: 1, padding: '10px 8px', overflowY: 'auto', overflowX: 'hidden' }}>
          {visibleNav.map(item => {
            const active = page === item.id
            return (
              <button key={item.id} onClick={() => setPage(item.id)} style={{
                width: '100%', display: 'flex', alignItems: 'center',
                gap: sidebarOpen ? 10 : 0, justifyContent: sidebarOpen ? 'flex-start' : 'center',
                padding: sidebarOpen ? '9px 10px' : '9px 12px', borderRadius: 8,
                border: 'none', background: active ? 'var(--primary-light)' : 'transparent',
                color: active ? 'var(--primary)' : 'var(--ink-mid)',
                fontWeight: active ? 600 : 400, fontSize: 13, cursor: 'pointer',
                marginBottom: 2, fontFamily: 'inherit', transition: 'all 0.14s',
                position: 'relative',
              }}
                onMouseEnter={e => { if (!active) (e.currentTarget as HTMLButtonElement).style.background = 'var(--bg)' }}
                onMouseLeave={e => { if (!active) (e.currentTarget as HTMLButtonElement).style.background = 'transparent' }}
                title={!sidebarOpen ? item.label : undefined}
              >
                <span style={{ fontSize: 16, flexShrink: 0 }}>{item.icon}</span>
                {sidebarOpen && (
                  <>
                    <span style={{ flex: 1, textAlign: 'left', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{item.label}</span>
                    {item.badge !== undefined && (
                      <span style={{
                        background: item.id === 'alerts' ? '#dc2626' : 'var(--primary)',
                        color: '#fff', fontSize: 10, fontWeight: 700,
                        borderRadius: 10, padding: '1px 6px', flexShrink: 0,
                      }}>{item.badge}</span>
                    )}
                  </>
                )}
                {!sidebarOpen && item.badge !== undefined && (
                  <span style={{ position: 'absolute', top: 6, right: 6, width: 8, height: 8, borderRadius: '50%', background: item.id === 'alerts' ? '#dc2626' : 'var(--primary)' }} />
                )}
              </button>
            )
          })}
        </nav>

        {/* User footer */}
        <div style={{ padding: '10px 8px', borderTop: '1px solid var(--border)', flexShrink: 0 }}>
          <button
            onClick={() => { setShowUser(u => !u); setShowNotif(false) }}
            style={{
              width: '100%', display: 'flex', alignItems: 'center', gap: sidebarOpen ? 8 : 0,
              justifyContent: sidebarOpen ? 'flex-start' : 'center',
              padding: '7px 8px', borderRadius: 8, border: 'none', background: 'transparent',
              cursor: 'pointer', fontFamily: 'inherit', transition: 'background 0.14s',
            }}
            onMouseEnter={e => { (e.currentTarget as HTMLButtonElement).style.background = 'var(--bg)' }}
            onMouseLeave={e => { (e.currentTarget as HTMLButtonElement).style.background = 'transparent' }}
          >
            <div style={{
              width: 32, height: 32, borderRadius: '50%', background: currentRole.color,
              color: '#fff', display: 'flex', alignItems: 'center', justifyContent: 'center',
              fontSize: 12, fontWeight: 700, flexShrink: 0,
            }}>{currentRole.abbr}</div>
            {sidebarOpen && (
              <div style={{ overflow: 'hidden', textAlign: 'left' }}>
                <div style={{ fontSize: 12, fontWeight: 600, color: 'var(--ink)', whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>{access.fullName}</div>
                <div style={{ fontSize: 10, color: 'var(--ink-muted)' }}>{currentRole.label}</div>
              </div>
            )}
          </button>
        </div>
      </aside>

      {/* ── Main area ─────────────────────────────────────────────────────────── */}
      <div style={{ flex: 1, display: 'flex', flexDirection: 'column', overflow: 'hidden', minWidth: 0 }}>

        {/* Top Bar */}
        <header className="app-chrome" style={{
          height: 60, background: '#fff', borderBottom: '1px solid var(--border)',
          display: 'flex', alignItems: 'center', padding: '0 20px', gap: 10, flexShrink: 0,
        }}>
          {/* Collapse button */}
          <button onClick={() => setSidebarOpen(o => !o)} style={{
            width: 32, height: 32, background: 'none', border: '1px solid var(--border)',
            borderRadius: 7, cursor: 'pointer', display: 'flex', alignItems: 'center',
            justifyContent: 'center', fontSize: 14, color: 'var(--ink-muted)', flexShrink: 0,
            transition: 'background 0.14s',
          }}
            onMouseEnter={e => { (e.currentTarget as HTMLButtonElement).style.background = 'var(--bg)' }}
            onMouseLeave={e => { (e.currentTarget as HTMLButtonElement).style.background = 'none' }}
          >☰</button>

          <div style={{ fontSize: 14, fontWeight: 700, color: 'var(--ink)', whiteSpace: 'nowrap', letterSpacing: '-0.01em' }}>
            {PAGE_LABELS[page]}
          </div>

          <div style={{ flex: 1 }} />

          {/* Global Search */}
          <div style={{ position: 'relative', width: 280, flexShrink: 1, minWidth: 160 }}>
            <span style={{ position: 'absolute', left: 9, top: '50%', transform: 'translateY(-50%)', fontSize: 12, color: 'var(--ink-faint)', pointerEvents: 'none' }}>🔍</span>
            <input
              value={search} onChange={e => setSearch(e.target.value)}
              placeholder="Search patients, products, TXN…"
              style={{
                width: '100%', padding: '7px 10px 7px 28px', borderRadius: 8,
                border: '1px solid var(--border)', fontSize: 12, outline: 'none',
                fontFamily: 'inherit', background: 'var(--bg)', color: 'var(--ink)',
                transition: 'border 0.15s',
              }}
              onFocus={e => { (e.target as HTMLInputElement).style.borderColor = 'var(--primary)'; closeMenus() }}
              onBlur={e => { (e.target as HTMLInputElement).style.borderColor = 'var(--border)' }}
            />
          </div>

          {/* Date filter */}
          <select value={dateRange} onChange={e => setDateRange(e.target.value)} style={{
            padding: '7px 10px', borderRadius: 8, border: '1px solid var(--border)',
            fontSize: 12, fontFamily: 'inherit', background: 'var(--bg)', color: 'var(--ink)',
            cursor: 'pointer', outline: 'none', flexShrink: 0,
          }}>
            {['Today', 'This Week', 'This Month', 'Last Month', 'Q3 2026', 'Custom Range'].map(d => <option key={d}>{d}</option>)}
          </select>

          <div title="This dashboard is limited to your assigned branch" style={{
            padding: '7px 10px', borderRadius: 8, border: '1px solid var(--border)',
            fontSize: 12, fontFamily: 'inherit', background: 'var(--bg)', color: 'var(--ink)',
            fontWeight: 600, flexShrink: 0,
          }}>
            {access.branchName}
            {access.branchCode && <span style={{ marginLeft: 6, fontWeight: 500, color: 'var(--ink-muted)', fontFamily: 'monospace', fontSize: 11 }}>{access.branchCode}</span>}
          </div>

          {/* Offline indicator */}
          <div style={{
            display: 'flex', alignItems: 'center', gap: 5, padding: '5px 10px', borderRadius: 20,
            background: isOnline ? '#f0fdf4' : '#fef3c7',
            border: `1px solid ${isOnline ? '#86efac' : '#fcd34d'}`,
            flexShrink: 0,
          }}>
            <div style={{ width: 7, height: 7, borderRadius: '50%', background: isOnline ? '#16a34a' : '#d97706', flexShrink: 0 }} />
            <span style={{ fontSize: 11, fontWeight: 600, color: isOnline ? '#16a34a' : '#d97706', whiteSpace: 'nowrap' }}>
              {isOnline ? 'Online' : `Offline${pendingSync > 0 ? ` · ${pendingSync} queued` : ''}`}
            </span>
          </div>

          {/* Notifications */}
          <div style={{ position: 'relative', flexShrink: 0 }}>
            <button onClick={() => { setShowNotif(n => !n); setShowUser(false) }} style={{
              width: 36, height: 36, borderRadius: 8, border: '1px solid var(--border)',
              background: showNotif ? 'var(--bg)' : 'none', cursor: 'pointer',
              display: 'flex', alignItems: 'center', justifyContent: 'center',
              fontSize: 16, position: 'relative', transition: 'background 0.14s',
            }}
              onMouseEnter={e => { (e.currentTarget as HTMLButtonElement).style.background = 'var(--bg)' }}
              onMouseLeave={e => { (e.currentTarget as HTMLButtonElement).style.background = showNotif ? 'var(--bg)' : 'none' }}
            >
              🔔
              {alertCount > 0 && (
                <span style={{ position: 'absolute', top: 6, right: 6, width: 8, height: 8, background: '#dc2626', borderRadius: '50%', border: '2px solid #fff' }} />
              )}
            </button>
            {showNotif && <NotifDropdown onClose={() => setShowNotif(false)} />}
          </div>

          {/* User avatar */}
          <div style={{ position: 'relative', flexShrink: 0 }}>
            <button onClick={() => { setShowUser(u => !u); setShowNotif(false) }} style={{
              width: 34, height: 34, borderRadius: '50%', background: currentRole.color,
              color: '#fff', display: 'flex', alignItems: 'center', justifyContent: 'center',
              fontSize: 12, fontWeight: 700, cursor: 'pointer', border: 'none', flexShrink: 0,
              boxShadow: showUser ? `0 0 0 3px ${currentRole.color}30` : 'none', transition: 'box-shadow 0.15s',
            }}>{currentRole.abbr}</button>
            {showUser && <UserMenu access={access} role={role} onRoleChange={() => undefined} onSignOut={() => { void handleSignOut() }} onClose={() => setShowUser(false)} />}
          </div>
        </header>

        {/* Page content */}
        <main
          className="app-main"
          style={{ flex: 1, overflowY: 'auto', padding: '20px 24px' }}
          onClick={closeMenus}
        >
          {renderPage()}
        </main>
      </div>

      {showExport && <ExportModal onClose={() => setShowExport(false)} />}
    </div>
  )
}
