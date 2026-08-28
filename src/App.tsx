import { useState, useEffect, useCallback } from 'react'
import { NAV_ITEMS, type Role } from './data'
import { useTranslation, LanguageSwitcher } from './lib/i18n'
import type { TranslationKey } from './lib/i18n/en'
import OverviewPage from './pages/OverviewPage'
import LiveInventoryPage from './pages/LiveInventoryPage'
import StockReceivingPage from './pages/StockReceivingPage'
import BarcodeManagerPage from './pages/BarcodeManagerPage'
import SalesPage from './pages/SalesPage'
import TransactionsPage from './pages/TransactionsPage'
import InsurancePage from './pages/InsurancePage'
import RequestProductPage from './pages/RequestProductPage'
import AlertsPage from './pages/AlertsPage'
import HelpPage from './pages/HelpPage'
import DatabaseBackedPage from './pages/DatabaseBackedPage'
import BranchAccessPage from './pages/BranchAccessPage'
import AdminPortal from './pages/AdminPortal'
import BranchPortal from './pages/BranchPortal'
import ResetPassword from './pages/ResetPassword'
import { Logo } from './components'
import TeamPage from './pages/TeamPage'
import PatientsPage from './pages/PatientsPage'
import ReportsPage from './pages/ReportsPage'
import BranchSettingsPage from './pages/BranchSettingsPage'
import HistoryPage from './pages/HistoryPage'
import { restoreBranchAccess, signOutFromBranch, type BranchAccess } from './lib/auth'
import { checkExpiredStock, checkOutOfStockAlerts, loadLiveAlerts, markAllAlertsRead, type LiveAlert } from './lib/alerts'

// ─── Top-level hash router ──────────────────────────────────────────────────────
// #admin and #branch are the super-admin console and pharmacy registration —
// both used to live in a separately deployed app; they're now plain in-app
// views reached by URL fragment, with no page reload and no second server.

type HashRoute = 'home' | 'admin' | 'branch' | 'reset'

function hashToRoute(hash: string): HashRoute {
  // A "forgot password" email link lands back here with Supabase's own
  // recovery tokens appended to the hash (#access_token=…&type=recovery&…),
  // not one of our own routes — checked first since it never starts with
  // "#admin"/"#branch" but must still take priority over falling through
  // to "home". An expired/already-used link redirects the same way but with
  // #error=access_denied&error_code=otp_expired&... instead — that must
  // route here too (not fall through to the marketing home page with no
  // explanation) so ResetPassword.tsx can show *why* and offer a new link.
  if (hash.includes('type=recovery') || hash.startsWith('#error=')) return 'reset'
  // startsWith, not ===, so the emailed activation link (#branch?email=...)
  // still routes to the branch portal instead of falling through to home.
  if (hash === '#admin' || hash.startsWith('#admin?')) return 'admin'
  if (hash === '#branch' || hash.startsWith('#branch?')) return 'branch'
  return 'home'
}

function useHashRoute(): HashRoute {
  const [route, setRoute] = useState<HashRoute>(() => hashToRoute(window.location.hash))
  useEffect(() => {
    const handler = () => setRoute(hashToRoute(window.location.hash))
    window.addEventListener('hashchange', handler)
    return () => window.removeEventListener('hashchange', handler)
  }, [])
  return route
}

// ─── Role Config ──────────────────────────────────────────────────────────────

const ROLES: { id: Role; abbr: string; color: string }[] = [
  { id: 'owner',      abbr: 'OW', color: '#1e5fa8' },
  { id: 'manager',    abbr: 'MG', color: '#0284c7' },
  { id: 'seller',     abbr: 'SL', color: '#7c3aed' },
]

function roleLabelKey(id: Role): TranslationKey {
  return id === 'owner' ? 'shell.roleOwner' : id === 'manager' ? 'shell.roleManager' : 'shell.roleSeller'
}

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
                fontSize: 11, fontFamily: 'var(--font-mono)', background: '#fff', outline: 'none',
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

function alertTimeAgo(iso: string): string {
  const minutes = Math.floor((Date.now() - new Date(iso).getTime()) / 60000)
  if (minutes < 1) return 'just now'
  if (minutes < 60) return `${minutes}m ago`
  if (minutes < 1440) return `${Math.floor(minutes / 60)}h ago`
  return `${Math.floor(minutes / 1440)}d ago`
}

function NotifDropdown({ alerts, onClose }: { alerts: LiveAlert[]; onClose: () => void }) {
  const { t } = useTranslation()
  const active = alerts.filter(a => !a.isRead)
  return (
    <div style={{
      position: 'absolute', right: 0, top: '110%', width: 340, zIndex: 100,
      background: '#fff', border: '1px solid var(--border)', borderRadius: 12,
      boxShadow: '0 8px 32px rgba(0,0,0,0.10)', overflow: 'hidden',
    }}>
      <div style={{ padding: '12px 14px', borderBottom: '1px solid var(--border)', display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
        <span style={{ fontWeight: 600, fontSize: 13, color: 'var(--ink)' }}>{t('shell.notifications')}</span>
        <span style={{ fontSize: 11, fontWeight: 600, background: '#fee2e2', color: '#dc2626', borderRadius: 10, padding: '1px 7px' }}>{t('shell.activeAlerts', { count: active.length })}</span>
      </div>
      <div style={{ maxHeight: 340, overflowY: 'auto' }}>
        {active.map(a => {
          const dot: Record<string, string> = { critical: '#dc2626', warning: '#d97706', info: '#16a34a' }
          const bg: Record<string, string> = { critical: '#fef2f2', warning: '#fffbeb', info: '#f0fdf4' }
          return (
            <div key={a.id} style={{ padding: '10px 14px', borderBottom: '1px solid var(--bg-alt)', display: 'flex', gap: 10, background: bg[a.type] + '60' }}>
              <div style={{ width: 7, height: 7, borderRadius: '50%', background: dot[a.type], marginTop: 4, flexShrink: 0 }} />
              <div style={{ flex: 1, minWidth: 0 }}>
                <div style={{ fontSize: 12, fontWeight: 600, color: dot[a.type] }}>{t(a.titleKey)}</div>
                <div style={{ fontSize: 11, color: 'var(--ink-mid)', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{a.msg}</div>
                <div style={{ fontSize: 10, color: 'var(--ink-faint)', marginTop: 2 }}>{alertTimeAgo(a.createdAt)}</div>
              </div>
            </div>
          )
        })}
        {active.length === 0 && (
          <div style={{ padding: '20px 14px', textAlign: 'center', fontSize: 12, color: 'var(--ink-faint)' }}>{t('shell.noNewAlerts')}</div>
        )}
      </div>
      <div style={{ padding: '10px 14px', borderTop: '1px solid var(--border)', textAlign: 'center' }}>
        <button onClick={onClose} style={{ fontSize: 12, color: 'var(--primary)', background: 'none', border: 'none', cursor: 'pointer', fontWeight: 600, fontFamily: 'inherit' }}>{t('shell.viewAllAlerts')}</button>
      </div>
    </div>
  )
}

// ─── User Menu ────────────────────────────────────────────────────────────────

function UserMenu({ access, role, onRoleChange, onSignOut, onClose }: { access: BranchAccess; role: Role; onRoleChange: (r: Role) => void; onSignOut: () => void; onClose: () => void }) {
  const { t } = useTranslation()
  return (
    <div style={{
      position: 'absolute', right: 0, top: '110%', width: 220, zIndex: 100,
      background: '#fff', border: '1px solid var(--border)', borderRadius: 12,
      boxShadow: '0 8px 32px rgba(0,0,0,0.10)', overflow: 'hidden',
    }}>
      <div style={{ padding: '12px 14px', borderBottom: '1px solid var(--border)' }}>
        <div style={{ fontSize: 13, fontWeight: 700, color: 'var(--ink)' }}>{access.fullName}</div>
        <div style={{ fontSize: 11, color: 'var(--ink-muted)' }}>{access.branchName} · {t(roleLabelKey(role))}</div>
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
            {t(roleLabelKey(r.id))}
          </button>
        ))}
      </div>
      <div style={{ padding: '8px 14px', borderTop: '1px solid var(--border)' }}>
        <button onClick={onSignOut} style={{ width: '100%', textAlign: 'left', padding: '8px 10px', borderRadius: 7, border: 'none', background: 'none', color: '#dc2626', fontSize: 12, cursor: 'pointer', fontFamily: 'inherit' }}>{t('shell.signOut')}</button>
      </div>
    </div>
  )
}

// ─── Intro splash ─────────────────────────────────────────────────────────────
// Shown once per browser session (sessionStorage-gated, so it never repeats
// on internal navigation, only on a genuine fresh load) before landing on
// either the marketing home page or the dashboard -- whichever the access
// check above resolves to. Deep-link routes (admin console, branch
// activation, password reset) skip it entirely: a delay in front of a link
// someone followed for a specific task would only be friction, not delight.

const INTRO_SESSION_KEY = 'psync_intro_shown'

function IntroSplash({ exiting }: { exiting: boolean }) {
  return (
    <div className={exiting ? 'intro-exit' : undefined} style={{
      position: 'fixed', inset: 0, zIndex: 9999, display: 'flex', flexDirection: 'column',
      alignItems: 'center', justifyContent: 'center', gap: 14, background: 'var(--bg)',
    }}>
      <div className="intro-mark"><Logo size={56} showWordmark={false} /></div>
      <div className="intro-wordmark" style={{ fontFamily: 'var(--font-display)', fontWeight: 700, fontSize: 22, letterSpacing: '-0.01em', color: 'var(--ink)' }}>
        Pharm<span style={{ color: 'var(--primary)' }}>Sync</span>
      </div>
    </div>
  )
}

function useIntroSplash(): 'visible' | 'exiting' | 'done' {
  const [phase, setPhase] = useState<'visible' | 'exiting' | 'done'>(() => {
    try { return sessionStorage.getItem(INTRO_SESSION_KEY) === '1' ? 'done' : 'visible' } catch { return 'done' }
  })

  useEffect(() => {
    if (phase !== 'visible') return
    const toExit = window.setTimeout(() => setPhase('exiting'), 1000)
    return () => window.clearTimeout(toExit)
  }, [phase])

  useEffect(() => {
    if (phase !== 'exiting') return
    const toDone = window.setTimeout(() => {
      setPhase('done')
      try { sessionStorage.setItem(INTRO_SESSION_KEY, '1') } catch { /* per-viewer convenience only */ }
    }, 320)
    return () => window.clearTimeout(toDone)
  }, [phase])

  return phase
}

// ─── Main App ─────────────────────────────────────────────────────────────────

const DATE_RANGE_OPTIONS = ['today', 'thisWeek', 'thisMonth', 'lastMonth', 'quarter', 'custom'] as const
type DateRangeOption = typeof DATE_RANGE_OPTIONS[number]
const dateRangeLabelKey: Record<DateRangeOption, TranslationKey> = {
  today: 'shell.dateToday', thisWeek: 'shell.dateThisWeek', thisMonth: 'shell.dateThisMonth',
  lastMonth: 'shell.dateLastMonth', quarter: 'shell.dateQuarter', custom: 'shell.dateCustom',
}

export default function App() {
  const hashRoute = useHashRoute()
  const introPhase = useIntroSplash()
  const { t } = useTranslation()
  const [page, setPage]             = useState('overview')
  const [access, setAccess]         = useState<BranchAccess | null>(null)
  const [accessLoading, setAccessLoading] = useState(true)
  const [search, setSearch]         = useState('')
  const [dateRange, setDateRange]   = useState<DateRangeOption>('thisMonth')
  const [sidebarOpen, setSidebarOpen] = useState(true)
  const [showNotif, setShowNotif]   = useState(false)
  const [notifSnapshot, setNotifSnapshot] = useState<LiveAlert[]>([])
  const [showUser, setShowUser]     = useState(false)
  const [showExport, setShowExport] = useState(false)

  const [isOnline, setIsOnline] = useState(navigator.onLine)
  const [pendingSync, setPendingSync] = useState(0)
  const [alerts, setAlerts] = useState<LiveAlert[]>([])

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

  const refreshAlerts = useCallback(async () => {
    // Best-effort and silent: a missed check here just means an overdue
    // out-of-stock reminder, or a not-yet-written-off expired batch,
    // surfaces on the next poll instead of this one.
    try { await checkOutOfStockAlerts() } catch { /* ignore */ }
    try { await checkExpiredStock() } catch { /* ignore */ }
    try { setAlerts(await loadLiveAlerts()) } catch { /* best-effort -- badge just stays at its last known count */ }
  }, [])

  useEffect(() => { if (access) void refreshAlerts() }, [access, refreshAlerts])
  useEffect(() => {
    if (!access) return
    const id = setInterval(() => void refreshAlerts(), 30000)
    return () => clearInterval(id)
  }, [access, refreshAlerts])

  // Falls back to the least-privileged role, not the broadest one, for any
  // legacy/unrecognized role value (pharmacist/staff exist in the database's
  // check constraint but nothing has ever created one) -- an unknown role
  // should never silently grant full access.
  const role: Role = access?.role === 'owner' || access?.role === 'manager' || access?.role === 'seller'
    ? access.role
    : 'seller'

  async function handleSignOut() {
    await signOutFromBranch()
    setAccess(null)
    setPage('overview')
    setShowUser(false)
  }

  if (hashRoute === 'admin') return <AdminPortal />
  if (hashRoute === 'branch') return <BranchPortal />
  if (hashRoute === 'reset') return <ResetPassword />

  if (introPhase !== 'done') return <IntroSplash exiting={introPhase === 'exiting'} />

  if (accessLoading) {
    return <main style={{ minHeight: '100vh', display: 'grid', placeItems: 'center', background: 'var(--bg)', color: 'var(--ink-muted)', fontFamily: 'var(--font-body)' }}>{t('shell.loadingWorkspace')}</main>
  }

  if (!access) {
    return <BranchAccessPage onAccess={branchAccess => { setAccess(branchAccess); setPage('overview') }} />
  }

  const currentRole = ROLES.find(r => r.id === role)!
  const visibleNav = NAV_ITEMS.filter(n => n.roles.includes(role))
  const alertCount = alerts.filter(a => !a.isRead).length
  const navBadge = (id: string) => (id === 'alerts' ? alertCount : undefined)

  // Opening the bell marks whatever was unread at that instant as read —
  // no separate click required. The dropdown itself still renders from a
  // frozen snapshot taken right here, so the cashier can see what was just
  // read instead of the list emptying out from under them the moment it
  // marks itself read.
  function toggleNotif() {
    setShowNotif(open => {
      const next = !open
      if (next) {
        const unread = alerts.filter(a => !a.isRead)
        setNotifSnapshot(unread)
        if (unread.length > 0) {
          void markAllAlertsRead(unread.map(a => a.id)).catch(() => { /* best-effort; next poll reconciles */ })
          setAlerts(current => current.map(a => a.isRead ? a : { ...a, isRead: true }))
        }
      }
      return next
    })
    setShowUser(false)
  }

  const closeMenus = () => { setShowNotif(false); setShowUser(false) }

  function renderPage() {
    switch (page) {
      case 'overview':      return <OverviewPage
                                     role={role}
                                     period={dateRange}
                                     branchName={access!.branchName}
                                     alerts={alerts}
                                     onExport={() => setShowExport(true)}
                                     onViewAlerts={() => setPage('alerts')}
                                   />
      case 'inventory':     return <LiveInventoryPage />
      case 'receiving':     return <StockReceivingPage />
      case 'requestProduct': return <RequestProductPage />
      case 'barcode':       return <BarcodeManagerPage />
      case 'sales':         return <SalesPage />
      case 'reports':       return <ReportsPage />
      case 'alerts':        return <AlertsPage />
      case 'transactions':  return <TransactionsPage />
      case 'insurance':     return <InsurancePage />
      case 'team':          return <TeamPage />
      case 'patients':      return <PatientsPage />
      case 'branch':        return <BranchSettingsPage />
      case 'history':       return <HistoryPage />
      case 'help':          return <HelpPage />
      default:              return null
    }
  }

  const sidebarW = sidebarOpen ? 240 : 60

  return (
    <div className="app-shell" style={{ display: 'flex', height: '100vh', overflow: 'hidden', background: 'var(--bg)', fontFamily: 'var(--font-body)', fontSize: 13 }}>

      {/* ── Sidebar ──────────────────────────────────────────────────────────── */}
      <aside className="app-chrome" style={{
        width: sidebarW, minWidth: sidebarW, background: '#fff',
        borderRight: '1px solid var(--border)', display: 'flex', flexDirection: 'column',
        transition: 'width 0.22s, min-width 0.22s', overflow: 'hidden', flexShrink: 0, zIndex: 10,
      }}>
        {/* Logo — the shared <Logo /> mark, same as the home page and sign-in */}
        <div style={{ height: 60, padding: sidebarOpen ? '0 16px' : '0 14px', display: 'flex', alignItems: 'center', gap: 10, borderBottom: '1px solid var(--border)', flexShrink: 0 }}>
          <Logo size={32} showWordmark={false} />
          {sidebarOpen && (
            <div style={{ overflow: 'hidden', whiteSpace: 'nowrap' }}>
              <div style={{ fontSize: 14, fontWeight: 700, color: 'var(--ink)', fontFamily: 'var(--font-display)', letterSpacing: '-0.01em' }}>
                Pharm<span style={{ color: 'var(--primary)' }}>Sync</span>
              </div>
              <div style={{ fontSize: 10, color: 'var(--ink-muted)', fontWeight: 500, marginTop: 1 }}>{t('shell.tagline')}</div>
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
                <div style={{ fontSize: 12, fontWeight: 700, color: currentRole.color }}>{t(roleLabelKey(currentRole.id))}</div>
                <div style={{ fontSize: 10, color: 'var(--ink-muted)' }}>{access.branchName}</div>
              </div>
            </div>
          </div>
        )}

        {/* Language switcher — lives here, not the top bar, because the top
            bar's search box + date filter + branch badge + notif bell +
            avatar already crowd a laptop-width screen; anything appended
            after them there risked being squeezed past the app-shell's
            overflow:hidden and never rendering at all. The sidebar has its
            own space that isn't competing with anything else. */}
        {sidebarOpen && (
          <div style={{ padding: '0 12px 10px', borderBottom: '1px solid var(--bg-alt)', flexShrink: 0 }}>
            <LanguageSwitcher />
          </div>
        )}

        {/* Nav items */}
        <nav style={{ flex: 1, padding: '10px 8px', overflowY: 'auto', overflowX: 'hidden' }}>
          {visibleNav.map(item => {
            const active = page === item.id
            const navLabel = t(`nav.${item.id}` as TranslationKey)
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
                title={!sidebarOpen ? navLabel : undefined}
              >
                <span style={{ fontSize: 16, flexShrink: 0 }}>{item.icon}</span>
                {sidebarOpen && (
                  <>
                    <span style={{ flex: 1, textAlign: 'left', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{navLabel}</span>
                    {!!navBadge(item.id) && (
                      <span style={{
                        background: '#dc2626',
                        color: '#fff', fontSize: 10, fontWeight: 700,
                        borderRadius: 10, padding: '1px 6px', flexShrink: 0,
                      }}>{navBadge(item.id)}</span>
                    )}
                  </>
                )}
                {!sidebarOpen && !!navBadge(item.id) && (
                  <span style={{ position: 'absolute', top: 6, right: 6, width: 8, height: 8, borderRadius: '50%', background: '#dc2626' }} />
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
                <div style={{ fontSize: 10, color: 'var(--ink-muted)' }}>{t(roleLabelKey(currentRole.id))}</div>
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
            {t(`page.${page}` as TranslationKey)}
          </div>

          <div style={{ flex: 1 }} />

          {/* Global Search */}
          <div style={{ position: 'relative', width: 280, flexShrink: 1, minWidth: 160 }}>
            <span style={{ position: 'absolute', left: 9, top: '50%', transform: 'translateY(-50%)', fontSize: 12, color: 'var(--ink-faint)', pointerEvents: 'none' }}>🔍</span>
            <input
              value={search} onChange={e => setSearch(e.target.value)}
              placeholder={t('shell.searchPlaceholder')}
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
          <select value={dateRange} onChange={e => setDateRange(e.target.value as DateRangeOption)} style={{
            padding: '7px 10px', borderRadius: 8, border: '1px solid var(--border)',
            fontSize: 12, fontFamily: 'inherit', background: 'var(--bg)', color: 'var(--ink)',
            cursor: 'pointer', outline: 'none', flexShrink: 0,
          }}>
            {DATE_RANGE_OPTIONS.map(opt => <option key={opt} value={opt}>{t(dateRangeLabelKey[opt])}</option>)}
          </select>

          <div title={t('shell.branchScopedNotice')} style={{
            padding: '7px 10px', borderRadius: 8, border: '1px solid var(--border)',
            fontSize: 12, fontFamily: 'inherit', background: 'var(--bg)', color: 'var(--ink)',
            fontWeight: 600, flexShrink: 0,
          }}>
            {access.branchName}
            {access.branchCode && <span style={{ marginLeft: 6, fontWeight: 500, color: 'var(--ink-muted)', fontFamily: 'var(--font-mono)', fontSize: 11 }}>{access.branchCode}</span>}
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
              {isOnline ? t('shell.online') : pendingSync > 0 ? t('shell.offlineQueued', { count: pendingSync }) : t('shell.offline')}
            </span>
          </div>

          {/* Notifications */}
          <div style={{ position: 'relative', flexShrink: 0 }}>
            <button onClick={toggleNotif} style={{
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
            {showNotif && <NotifDropdown alerts={notifSnapshot} onClose={() => setShowNotif(false)} />}
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
