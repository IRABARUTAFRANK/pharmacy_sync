import { useState, useEffect, useLayoutEffect, useCallback, useRef, lazy, Suspense, Component, type ComponentType, type ReactNode, type ErrorInfo } from 'react'
import { NAV_ITEMS, fmtRWFExact, type Role } from './data'
import { useTranslation, LanguageSwitcher, hasExplicitLangPreference } from './lib/i18n'
import { useGlobalSearch } from './lib/search'
import type { TranslationKey } from './lib/i18n/en'
import DatabaseBackedPage from './pages/DatabaseBackedPage'
import BranchAccessPage from './pages/BranchAccessPage'
import { Logo } from './components'
import { Sidebar } from './Sidebar'



import HistoryPage from './pages/HistoryPage'

import { restoreBranchAccess, signOutFromBranch, type BranchAccess } from './lib/auth'
import { branchLogoUrl, getMyBranchDetails } from './lib/branch'
import { getMyBranchOrganizationId, getMyOrganization, listOrganizationBranches, type OrganizationSummary, type OrganizationBranch } from './lib/organization'
import { loadBranchSnapshot, type BranchSnapshot } from './lib/analytics'
import { alertActionTarget, checkExpiredStock, checkForecastAccuracyNotifications, checkLicenseExpiry, checkMissingBranchLocation, checkMissingReorderPoints, checkOutOfStockAlerts, checkRestockRecommendations, loadLiveAlerts, markAlertRead, markAllAlertsRead, resolveAlertMessage, type LiveAlert } from './lib/alerts'
import { useBarcodeScannerListener, useScanner } from './lib/scanner'
import { getSavedThemeId, setTheme, THEME_PRESETS } from './lib/theme'
import { GuidedTour, hasCompletedTour, markTourComplete } from './lib/tour'

// Code-split every page behind the sidebar (and the admin/branch/reset
// top-level routes) so the first load only ships what's needed to sign in --
// each page's own JS is fetched the first time it's actually opened, not
// bundled into the initial download. BranchAccessPage stays a static import
// above: it's needed immediately for anyone who isn't signed in yet, so
// lazy-loading it would only add a waterfall in the most latency-sensitive path.
//
// PAGE_LOADERS is the single source of truth for each nav page's dynamic
// import -- lazy() below wraps it for React, and prefetchPage() (used on nav
// hover and for idle warm-up, further down this file) calls the exact same
// function so the browser fetches/parses the chunk BEFORE the click that
// needs it, rather than starting cold at click time. Keying both off one map
// means a page added here only needs a route case in renderPage(), not a
// second place to remember for prefetching.
const PAGE_LOADERS = {
  overview: () => import('./pages/OverviewPage'),
  inventory: () => import('./pages/LiveInventoryPage'),
  receiving: () => import('./pages/StockReceivingPage'),
  barcode: () => import('./pages/BarcodeManagerPage'),
  sales: () => import('./pages/SalesPage'),
  locate: () => import('./pages/LocateProductPage'),
  transactions: () => import('./pages/TransactionsPage'),
  insurance: () => import('./pages/InsurancePage'),
  alerts: () => import('./pages/AlertsPage'),
  help: () => import('./pages/HelpPage'),
  analyst: () => import('./pages/AnalystPage'),
  analytics: () => import('./pages/AnalyticsPage'),
  compliance: () => import('./pages/CompliancePage'),
  patients: () => import('./pages/PatientsPage'),
  reports: () => import('./pages/ReportsPage'),
  branch: () => import('./pages/BranchSettingsPage'),
  organization: () => import('./pages/OrganizationPage'),
} satisfies Record<string, () => Promise<{ default: ComponentType<any> }>>

const OverviewPage        = lazy(PAGE_LOADERS.overview)
const LiveInventoryPage   = lazy(PAGE_LOADERS.inventory)
const StockReceivingPage  = lazy(PAGE_LOADERS.receiving)
const BarcodeManagerPage  = lazy(PAGE_LOADERS.barcode)
const SalesPage           = lazy(PAGE_LOADERS.sales)
const LocateProductPage   = lazy(PAGE_LOADERS.locate)
const TransactionsPage    = lazy(PAGE_LOADERS.transactions)
const InsurancePage       = lazy(PAGE_LOADERS.insurance)
const AlertsPage          = lazy(PAGE_LOADERS.alerts)
const HelpPage            = lazy(PAGE_LOADERS.help)
const AnalystPage           = lazy(PAGE_LOADERS.analyst)
const AnalyticsPage         = lazy(PAGE_LOADERS.analytics)
const CompliancePage        = lazy(PAGE_LOADERS.compliance)
const PatientsPage         = lazy(PAGE_LOADERS.patients)
const ReportsPage          = lazy(PAGE_LOADERS.reports)
const BranchSettingsPage   = lazy(PAGE_LOADERS.branch)
const OrganizationPage     = lazy(PAGE_LOADERS.organization)
const AdminPortal          = lazy(() => import('./pages/AdminPortal'))
const BranchPortal         = lazy(() => import('./pages/BranchPortal'))
const ResetPassword        = lazy(() => import('./pages/ResetPassword'))
const PublicReceiptPage    = lazy(() => import('./pages/PublicReceiptPage'))

// Every NAV_ITEMS row gated by role, plus two extra rules neither one can
// express through Role alone (an org role is additive to, not a replacement
// for, the branch owner/manager/seller role NAV_ITEMS itself gates on):
//
//   'organization' -- a branch owner always sees it (they can found a new
//   organization from inside it even with none yet), but a manager only sees
//   it once they actually hold an org_owner/org_manager role somewhere
//   (organization !== null) -- a manager has no standing authority to create
//   an organization, so the item would otherwise be a dead end for them.
//
//   'overview' -- hidden for an org_owner once they've delegated to an
//   org_manager, but ONLY for their own home-branch nav. They still have the
//   identical org-wide view at Organization > Dashboard; this just removes
//   the redundant, now-unstaffed duty of also running their own branch's
//   day-to-day dashboard once someone else (the org_manager) is doing that.
//   Only the owner loses just this one item, and keeps the rest of their
//   own branch's nav (Sales, Inventory, Receiving, ...) -- unlike an
//   org_manager below, the owner's own home branch is genuinely, foundingly
//   theirs, not a placeholder or a former assignment, so there's no reason
//   they can't keep personally running it day to day alongside delegating
//   every OTHER branch. `viewingOtherBranch` (true while drilled into a
//   DIFFERENT branch from Organization > Branches, see App's `viewingBranch`
//   state) suppresses this exclusion entirely -- that other branch's
//   dashboard was never the redundant one, so without this an org_owner
//   who'd delegated away their own Overview would land on whatever nav item
//   happened to sort first (Inventory Dashboard) instead of that branch's
//   Overview.
//
//   Every branch-scoped item (all of NAV_ITEMS except 'organization' and
//   'help') -- hidden entirely for a real, dedicated org_manager, in their
//   own regular nav. Unlike the org_owner above, an org_manager's own
//   users.branch_id is NEVER genuinely theirs to run day to day: either a
//   purely technical placeholder (a brand-new hire, picked automatically --
//   see 2026-09-15_org_manager_not_tied_to_branch.sql) or a branch they were
//   just promoted OUT of (an ex-branch_manager) which the org_owner is free
//   to staff with someone new at any time. Their own-branch dashboard
//   "sleeping" on promotion IS this rule -- every branch, including a
//   former one of their own, is reached the same way from here on: through
//   Organization > Branches "View Branch". `viewingOtherBranch` suppresses
//   this the same way as above, for the same reason.
//
// Centralized here so the redirect guard, the prefetch warm-up, and the
// sidebar's own item list can never disagree with each other.
// myBranchOrganizationId: set even for a plain branch owner/manager who
// holds no org_owner/org_manager role themselves, as long as their own
// branch belongs to an organization -- see getMyBranchOrganizationId()'s own
// comment for why this needs to be a separate signal from `organization`.
// Without it, such a person could never reach the Organization tab at all,
// including to respond to a stock request addressed to their own branch.
function computeVisibleNav(
  role: Role, organization: OrganizationSummary | null, viewingOtherBranch = false, myBranchOrganizationId: string | null = null,
) {
  const ownerDelegatedAway = !viewingOtherBranch && role === 'owner' && organization?.myRole === 'org_owner' && organization.hasOrgManager
  const isDedicatedOrgManagerOwnNav = !viewingOtherBranch && organization?.myRole === 'org_manager'
  return NAV_ITEMS.filter(n =>
    n.roles.includes(role)
    && (n.id !== 'organization' || role === 'owner' || organization !== null || myBranchOrganizationId !== null)
    && (n.id !== 'overview' || !ownerDelegatedAway)
    && (!isDedicatedOrgManagerOwnNav || n.id === 'organization' || n.id === 'help'),
  )
}

// Falls back to the least-privileged role, not the broadest one, for any
// legacy/unrecognized role value (pharmacist/staff exist in the database's
// check constraint but nothing has ever created one) -- an unknown role
// should never silently grant full access.
function roleFromAccess(access: BranchAccess | null): Role {
  return access?.role === 'owner' || access?.role === 'manager' || access?.role === 'seller' ? access.role : 'seller'
}

// Where someone lands the moment they sign in (or a restored session
// resolves), most-privileged-first: an org_owner/org_manager's highest-level
// view is the cross-branch Organization dashboard, not any one branch's own
// Overview; a plain branch owner/manager still lands on their branch's
// Overview same as always; a seller (no dashboard access at all) lands
// straight on Sales/POS, the only page most of their nav even includes.
// Deliberately computed once at the sign-in moment (both call sites below
// resolve `organization` before calling this), not as an ongoing redirect --
// see the useLayoutEffect guard further down, which only corrects `page`
// when it's actually invalid for the role, never overriding a deliberate,
// still-valid manual navigation just because this function would have
// picked something else.
function computeDefaultPage(role: Role, organization: OrganizationSummary | null): string {
  if (organization) return 'organization'
  if (role === 'seller') return 'sales'
  return 'overview'
}

// Fetches a page's chunk ahead of the click that needs it -- on nav-button
// hover, and once more as a background warm-up shortly after sign-in (see
// the effect below). Calling the same dynamic import() a lazy() component
// already uses just resolves against the browser's in-flight/cached request
// for that chunk, so a hover-prefetch followed by an actual click never
// double-fetches. The Set only prevents re-triggering the *request*, not
// re-renders -- it's fine for it to never shrink for the life of the tab.
const prefetchedPages = new Set<string>()
function prefetchPage(id: string) {
  if (prefetchedPages.has(id)) return
  const loader = (PAGE_LOADERS as Record<string, (() => Promise<unknown>) | undefined>)[id]
  if (!loader) return
  prefetchedPages.add(id)
  loader().catch(() => { prefetchedPages.delete(id) }) // let a failed prefetch (e.g. offline) retry later
}

// ─── Top-level hash router ──────────────────────────────────────────────────────
// #admin and #branch are the super-admin console and pharmacy registration —
// both used to live in a separately deployed app; they're now plain in-app
// views reached by URL fragment, with no page reload and no second server.

type HashRoute = 'home' | 'admin' | 'branch' | 'reset' | 'receipt' | 'payment-return'

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
  // Scanned from the "share this receipt" QR printed on a receipt --
  // #receipt?id=<sale uuid> -- see PublicReceiptPage.tsx for the parser.
  if (hash === '#receipt' || hash.startsWith('#receipt?')) return 'receipt'
  // Where a CUSTOMER's own browser lands after finishing a mobile money/
  // card payment on the gateway's hosted page (see initiatePayment() in
  // lib/payments.ts) -- purely a friendly "you can close this" message.
  // The till itself never depends on this page; it polls check-status
  // independently, so this redirect landing (or not) changes nothing about
  // whether the sale actually completes.
  if (hash === '#payment-return' || hash.startsWith('#payment-return?')) return 'payment-return'
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

// ─── Organization-mode sidebar ─────────────────────────────────────────────────
// Mirrors OrganizationPage.tsx's own OrgTab/ORG_TABS (kept as a separate,
// duplicated constant rather than a shared import -- see the `orgTab` state
// comment above for why).

type OrgTab = 'dashboard' | 'transfers' | 'branches' | 'members' | 'settings'

const ORG_TABS: { id: OrgTab; icon: string; labelKey: TranslationKey }[] = [
  { id: 'dashboard', icon: '📊', labelKey: 'organization.tabDashboard' },
  { id: 'transfers', icon: '🔁', labelKey: 'organization.tabTransfers' },
  { id: 'branches', icon: '🏬', labelKey: 'organization.tabBranches' },
  { id: 'members', icon: '👥', labelKey: 'organization.tabMembers' },
  { id: 'settings', icon: '⚙️', labelKey: 'organization.tabSettings' },
]

// ─── Role Config ──────────────────────────────────────────────────────────────

const ROLES: { id: Role; abbr: string; color: string }[] = [
  { id: 'owner',      abbr: 'OW', color: '#1e5fa8' },
  { id: 'manager',    abbr: 'MG', color: '#0284c7' },
  { id: 'seller',     abbr: 'SL', color: '#7c3aed' },
]

function roleLabelKey(id: Role): TranslationKey {
  return id === 'owner' ? 'shell.roleOwner' : id === 'manager' ? 'shell.roleManager' : 'shell.roleSeller'
}

// ─── Page Error Boundary ──────────────────────────────────────────────────────
// Nothing in this app ever caught a render-time exception before -- an error
// thrown while rendering any page (a bad data shape from a real database
// row the code didn't expect, a library choking on unusual input, etc.)
// unmounted the ENTIRE app with no message at all, leaving a plain white
// screen with no way back short of a manual refresh. This scopes that
// failure to just the page content area: the sidebar/topbar stay usable,
// there's a visible error instead of blank white, and a "Back to Overview"
// escape hatch. Keyed by `page` in the render call below, so switching to a
// different nav item remounts this fresh and clears a stuck error state
// automatically, without needing a full page reload.
class PageErrorBoundary extends Component<{ children: ReactNode; onReset: () => void }, { error: Error | null }> {
  state: { error: Error | null } = { error: null }
  static getDerivedStateFromError(error: Error) { return { error } }
  componentDidCatch(error: Error, info: ErrorInfo) { console.error('Page failed to render:', error, info.componentStack) }
  render() {
    if (this.state.error) {
      return (
        <div style={{ padding: '48px 24px', textAlign: 'center', maxWidth: 480, margin: '0 auto' }}>
          <div style={{ fontSize: 32, marginBottom: 12 }}>⚠️</div>
          <p style={{ fontWeight: 700, fontSize: 15, color: 'var(--ink)', margin: '0 0 6px' }}>This page ran into a problem.</p>
          <p style={{ fontSize: 12, color: 'var(--ink-muted)', margin: '0 0 18px', fontFamily: 'var(--font-mono, monospace)' }}>
            {this.state.error.message || String(this.state.error)}
          </p>
          <button
            onClick={this.props.onReset}
            style={{
              padding: '9px 18px', borderRadius: 8, border: '1px solid var(--border)', background: 'var(--surface)',
              color: 'var(--ink)', fontWeight: 600, fontSize: 13, cursor: 'pointer', fontFamily: 'inherit',
            }}
          >
            ← Back to Overview
          </button>
        </div>
      )
    }
    return this.props.children
  }
}

// ─── Notifications Dropdown ───────────────────────────────────────────────────

// Shared by the dropdown and the toast stack below, so the same alert
// always reads with the same color in both places.
const SEVERITY_DOT: Record<string, string> = { critical: '#dc2626', warning: '#d97706', info: '#16a34a' }
const SEVERITY_BG: Record<string, string> = { critical: '#fef2f2', warning: '#fffbeb', info: '#f0fdf4' }

function alertTimeAgo(iso: string): string {
  const minutes = Math.floor((Date.now() - new Date(iso).getTime()) / 60000)
  if (minutes < 1) return 'just now'
  if (minutes < 60) return `${minutes}m ago`
  if (minutes < 1440) return `${Math.floor(minutes / 60)}h ago`
  return `${Math.floor(minutes / 1440)}d ago`
}

function NotifDropdown({ alerts, onSelectAlert, onViewAll }: {
  alerts: LiveAlert[]
  onSelectAlert: (alert: LiveAlert) => void
  onViewAll: () => void
}) {
  const { t } = useTranslation()
  const active = alerts.filter(a => !a.isRead)
  return (
    <div style={{
      position: 'absolute', right: 0, top: '110%', width: 340, zIndex: 100,
      background: 'var(--surface)', border: '1px solid var(--border)', borderRadius: 12,
      boxShadow: '0 8px 32px rgba(0,0,0,0.10)', overflow: 'hidden',
    }}>
      <div style={{ padding: '12px 14px', borderBottom: '1px solid var(--border)', display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
        <span style={{ fontWeight: 600, fontSize: 13, color: 'var(--ink)' }}>{t('shell.notifications')}</span>
        <span style={{ fontSize: 11, fontWeight: 600, background: '#fee2e2', color: '#dc2626', borderRadius: 10, padding: '1px 7px' }}>{t('shell.activeAlerts', { count: active.length })}</span>
      </div>
      <div style={{ maxHeight: 340, overflowY: 'auto' }}>
        {active.map(a => {
          const actionable = !!alertActionTarget(a)
          return (
            <div
              key={a.id}
              onClick={() => onSelectAlert(a)}
              title={actionable ? t('shell.notifGoToFix') : undefined}
              style={{
                padding: '10px 14px', borderBottom: '1px solid var(--bg-alt)', display: 'flex', gap: 10,
                background: SEVERITY_BG[a.type] + '60', cursor: actionable ? 'pointer' : 'default',
              }}
            >
              <div style={{ width: 7, height: 7, borderRadius: '50%', background: SEVERITY_DOT[a.type], marginTop: 4, flexShrink: 0 }} />
              <div style={{ flex: 1, minWidth: 0 }}>
                <div style={{ fontSize: 12, fontWeight: 600, color: SEVERITY_DOT[a.type] }}>{t(a.titleKey)}</div>
                <div style={{ fontSize: 11, color: 'var(--ink-mid)', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{resolveAlertMessage(a, t)}</div>
                <div style={{ fontSize: 10, color: 'var(--ink-faint)', marginTop: 2 }}>{alertTimeAgo(a.createdAt)}</div>
              </div>
              {actionable && <span style={{ alignSelf: 'center', color: 'var(--primary)', fontSize: 14, flexShrink: 0 }}>›</span>}
            </div>
          )
        })}
        {active.length === 0 && (
          <div style={{ padding: '20px 14px', textAlign: 'center', fontSize: 12, color: 'var(--ink-faint)' }}>{t('shell.noNewAlerts')}</div>
        )}
      </div>
      <div style={{ padding: '10px 14px', borderTop: '1px solid var(--border)', textAlign: 'center' }}>
        <button onClick={onViewAll} style={{ fontSize: 12, color: 'var(--primary)', background: 'none', border: 'none', cursor: 'pointer', fontWeight: 600, fontFamily: 'inherit' }}>{t('shell.viewAllAlerts')}</button>
      </div>
    </div>
  )
}

// ─── Toast stack ───────────────────────────────────────────────────────────────
// Proactive counterpart to the dropdown above: a newly-arrived unread alert
// (see refreshAlerts' new-vs-seen diff) gets a brief, animated card here so
// it's noticed without having to think to open the bell. Purely a visual
// nudge -- dismissing or letting one time out never changes is_read itself;
// only actually opening the dropdown (clicking a card, or the bell) does
// that, via the same openNotifDropdown() the bell button uses.

const TOAST_AUTO_DISMISS_MS = 10000
const TOAST_EXIT_ANIMATION_MS = 220

function ToastCard({ alert, onDismiss, onOpen }: { alert: LiveAlert; onDismiss: () => void; onOpen: (alert: LiveAlert) => void }) {
  const { t } = useTranslation()
  const [closing, setClosing] = useState(false)

  useEffect(() => {
    const timer = setTimeout(() => setClosing(true), TOAST_AUTO_DISMISS_MS)
    return () => clearTimeout(timer)
  }, [])

  useEffect(() => {
    if (!closing) return
    const timer = setTimeout(onDismiss, TOAST_EXIT_ANIMATION_MS)
    return () => clearTimeout(timer)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [closing])

  return (
    <div
      className={closing ? 'toast-card toast-card-out' : 'toast-card toast-card-in'}
      role="status"
      style={{
        pointerEvents: 'auto', display: 'flex', gap: 10, padding: '12px 14px', borderRadius: 12,
        background: 'var(--surface)', border: '1px solid var(--border)', boxShadow: '0 10px 30px rgba(0,0,0,0.16)',
        cursor: 'pointer',
      }}
      onClick={() => { setClosing(true); onOpen(alert) }}
    >
      <div style={{ width: 8, height: 8, borderRadius: '50%', background: SEVERITY_DOT[alert.type], marginTop: 4, flexShrink: 0 }} />
      <div style={{ flex: 1, minWidth: 0 }}>
        <div style={{ fontSize: 12, fontWeight: 700, color: SEVERITY_DOT[alert.type] }}>{t(alert.titleKey)}</div>
        <div style={{
          fontSize: 11, color: 'var(--ink-mid)', marginTop: 2, overflow: 'hidden',
          display: '-webkit-box', WebkitLineClamp: 2, WebkitBoxOrient: 'vertical',
        }}>{resolveAlertMessage(alert, t)}</div>
      </div>
      <button
        onClick={e => { e.stopPropagation(); setClosing(true) }}
        aria-label={t('shell.dismiss')}
        style={{ background: 'none', border: 'none', cursor: 'pointer', color: 'var(--ink-faint)', fontSize: 15, padding: 0, flexShrink: 0, lineHeight: 1 }}
      >×</button>
    </div>
  )
}

function ToastStack({ toasts, onDismiss, onOpen }: { toasts: LiveAlert[]; onDismiss: (id: string) => void; onOpen: (alert: LiveAlert) => void }) {
  if (toasts.length === 0) return null
  return (
    <div style={{
      position: 'fixed', top: 72, right: 20, zIndex: 200, width: 320,
      display: 'flex', flexDirection: 'column', gap: 10, pointerEvents: 'none',
    }}>
      {toasts.map(a => (
        <ToastCard key={a.id} alert={a} onDismiss={() => onDismiss(a.id)} onOpen={onOpen} />
      ))}
    </div>
  )
}

// ─── Search "go to section" dropdown ──────────────────────────────────────────
// Not a content filter — a jump list. Typing "inventory dash" (or just "inv")
// narrows to the matching sidebar section live, on every keystroke; picking
// one (click, or Enter) navigates straight there and clears the box.

function HighlightedLabel({ label, needle }: { label: string; needle: string }) {
  const i = label.toLowerCase().indexOf(needle)
  if (i === -1) return <>{label}</>
  return (
    <>
      {label.slice(0, i)}
      <strong style={{ color: 'var(--primary)', fontWeight: 700 }}>{label.slice(i, i + needle.length)}</strong>
      {label.slice(i + needle.length)}
    </>
  )
}

function SearchNavDropdown({ matches, needle, highlight, onSelect }: {
  matches: { item: { id: string; icon: string }; label: string }[]
  needle: string
  highlight: number
  onSelect: (id: string) => void
}) {
  return (
    <div style={{
      position: 'absolute', left: 0, right: 0, top: '110%', zIndex: 100,
      background: 'var(--surface)', border: '1px solid var(--border)', borderRadius: 12,
      boxShadow: '0 8px 32px rgba(0,0,0,0.10)', overflow: 'hidden',
    }}>
      <div style={{ maxHeight: 280, overflowY: 'auto' }}>
        {matches.map(({ item, label }, i) => (
          <button
            key={item.id}
            onMouseDown={e => e.preventDefault()}
            onClick={() => onSelect(item.id)}
            style={{
              width: '100%', display: 'flex', alignItems: 'center', gap: 10,
              padding: '9px 14px', border: 'none', cursor: 'pointer', fontFamily: 'inherit',
              background: i === highlight ? 'var(--bg)' : 'transparent', textAlign: 'left',
            }}
          >
            <span style={{ fontSize: 15, flexShrink: 0 }}>{item.icon}</span>
            <span style={{ fontSize: 13, color: 'var(--ink)' }}><HighlightedLabel label={label} needle={needle} /></span>
          </button>
        ))}
      </div>
    </div>
  )
}

// ─── User Menu ────────────────────────────────────────────────────────────────

function UserMenu({ access, role, onRoleChange, onSignOut, onClose, onReplayTour }: { access: BranchAccess; role: Role; onRoleChange: (r: Role) => void; onSignOut: () => void; onClose: () => void; onReplayTour: () => void }) {
  const { t } = useTranslation()
  const [activeTheme, setActiveTheme] = useState(getSavedThemeId())
  return (
    <div style={{
      position: 'absolute', right: 0, top: '110%', width: 220, zIndex: 100,
      background: 'var(--surface)', border: '1px solid var(--border)', borderRadius: 12,
      boxShadow: '0 8px 32px rgba(0,0,0,0.10)', overflow: 'hidden',
    }}>
      <div style={{ padding: '12px 14px', borderBottom: '1px solid var(--border)' }}>
        <div style={{ fontSize: 13, fontWeight: 700, color: 'var(--ink)' }}>{access.fullName}</div>
        <div style={{ fontSize: 11, color: 'var(--ink-muted)' }}>{access.branchName} · {t(roleLabelKey(role))}</div>
      </div>
      <div style={{ padding: '12px 14px', borderBottom: '1px solid var(--border)' }}>
        <div style={{ fontSize: 10, fontWeight: 600, color: 'var(--ink-muted)', textTransform: 'uppercase', letterSpacing: '0.06em', marginBottom: 8 }}>{t('shell.themeColor')}</div>
        <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
          {THEME_PRESETS.map(preset => (
            <button
              key={preset.id}
              type="button"
              title={preset.label}
              onClick={() => { setTheme(preset.id); setActiveTheme(preset.id) }}
              style={{
                width: 22, height: 22, borderRadius: '50%', background: preset.swatch, cursor: 'pointer', padding: 0, flexShrink: 0,
                border: '2px solid var(--surface)',
                boxShadow: activeTheme === preset.id ? '0 0 0 2px var(--ink)' : '0 0 0 1px var(--border)',
              }}
            />
          ))}
        </div>
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
        <button onClick={() => { onClose(); onReplayTour() }} style={{ width: '100%', textAlign: 'left', padding: '8px 10px', borderRadius: 7, border: 'none', background: 'none', color: 'var(--ink-mid)', fontSize: 12, cursor: 'pointer', fontFamily: 'inherit' }}>{t('shell.replayTour')}</button>
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
  const { t, setLang } = useTranslation()
  const [page, setPage]             = useState('overview')
  const [access, setAccess]         = useState<BranchAccess | null>(null)
  const [accessLoading, setAccessLoading] = useState(true)
  // Whether the signed-in owner/manager also holds an org_owner/org_manager
  // role somewhere -- null until known, i.e. "no organization" and "not
  // checked yet" render the same way (Organization nav item stays hidden).
  // Not folded into `role`/Role itself: an org role is additive to, not a
  // replacement for, the existing owner/manager/seller branch role.
  const [organization, setOrganization] = useState<OrganizationSummary | null>(null)
  // Set even without an org role, as long as the caller's own branch
  // belongs to an organization -- see computeVisibleNav's own comment.
  const [myBranchOrganizationId, setMyBranchOrganizationId] = useState<string | null>(null)
  const refreshOrganization = useCallback(async () => {
    try { setOrganization(await getMyOrganization()) } catch { setOrganization(null) }
    try { setMyBranchOrganizationId(await getMyBranchOrganizationId()) } catch { setMyBranchOrganizationId(null) }
  }, [])
  // Branch list for an org_owner/org_manager's "All branches" / per-branch
  // picker on Overview -- fetched only once they actually have an
  // organization, same lazy-on-demand shape as `organization` itself.
  const [orgBranches, setOrgBranches] = useState<OrganizationBranch[]>([])
  useEffect(() => {
    if (!organization) { setOrgBranches([]); return }
    let cancelled = false
    listOrganizationBranches(organization.organizationId)
      .then(list => { if (!cancelled) setOrgBranches(list) })
      .catch(() => { if (!cancelled) setOrgBranches([]) })
    return () => { cancelled = true }
  }, [organization])
  // An org_owner/org_manager "drilling into" one branch's own operational
  // dashboard from the Organization > Branches tab. Deliberately top-level
  // state (not something nested inside OrganizationPage) so that jumping
  // here always goes through the same exclusive `page` switch every other
  // nav transition does -- OrganizationPage fully unmounts instead of a
  // branch dashboard rendering stacked on top of it. Cleared below whenever
  // `page` goes back to 'organization', and on sign-out.
  const [viewingBranch, setViewingBranch] = useState<{ branchId: string; branchName: string; branchCode?: string | null } | null>(null)
  useEffect(() => { if (page === 'organization') setViewingBranch(null) }, [page])
  // Remembers whichever branch-dashboard page was open right before
  // entering Organization mode, so a "← Back" control can return there --
  // without this, the only way out of Organization (for anyone whose
  // visibleOrgTabs is short, e.g. a plain branch owner/manager who can only
  // reach Stock Transfers) was the "Today so far" sidebar card, which
  // doesn't read as a navigation control at all. A ref, not state: it must
  // survive without forcing a re-render on every ordinary page change, and
  // is only ever read at the moment the back button is clicked.
  const lastNonOrgPageRef = useRef<string>('overview')
  useEffect(() => { if (page !== 'organization') lastNonOrgPageRef.current = page }, [page])
  // While `page === 'organization'`, the sidebar shows ONLY these org-level
  // tabs (Dashboard/Stock Transfers/Branches/Members/Settings) instead of
  // the full branch nav -- an org owner looking at their organization should
  // see just the organization dashboard, nothing else on the side. The
  // branch nav (Overview/Inventory/Sales/etc.) only reappears once they've
  // actually drilled into one branch via "View Branch" (page leaves
  // 'organization', viewingBranch gets set). Kept as a small local constant
  // rather than imported from OrganizationPage.tsx so that page stays
  // code-split (importing from it here would pull its whole module into
  // this always-loaded top-level bundle).
  const [orgTab, setOrgTab] = useState<OrgTab>('dashboard')
  // The pharmacy's own uploaded logo, shown in the sidebar in place of the
  // generic PharmSync mark once one exists (falls back to the mark when
  // null). Every role sees it, not just the owner -- it's branch branding,
  // not an owner-only setting, and getMyBranchDetails() has no role gate.
  const [pharmacyLogoUrl, setPharmacyLogoUrl] = useState<string | null>(null)
  // Sidebar's "today so far" card, replacing what used to be a role/branch
  // pill that just repeated info already shown in the top bar (branch name)
  // and the avatar (who's signed in). ai_branch_snapshot() is owner/manager-
  // gated -- a seller's fetch fails, caught silently below, and the card
  // just doesn't render for them rather than showing an error.
  const [todaySnapshot, setTodaySnapshot] = useState<BranchSnapshot | null>(null)
  // Set only by the "N need attention" click, and cleared as soon as the
  // user leaves the Inventory Dashboard page again -- so a later, ordinary
  // sidebar-nav visit to Inventory starts back on "all" rather than getting
  // stuck on "attention" forever. `seq` (not just presence of the object) is
  // LiveInventoryPage's key below: it forces a fresh mount, and therefore a
  // re-applied initialStatus, even in the one case setPage('inventory')
  // alone wouldn't cover -- already being on that page when "N need
  // attention" is clicked, where setPage is a no-op and the page would
  // otherwise keep whatever filter a manual tile click had already set.
  const [inventoryFocus, setInventoryFocus] = useState<{ seq: number } | null>(null)
  function goToInventoryAttention() {
    setInventoryFocus(prev => ({ seq: (prev?.seq ?? 0) + 1 }))
    setPage('inventory')
  }
  useEffect(() => { if (page !== 'inventory') setInventoryFocus(null) }, [page])
  const { term: search, setTerm: setSearch } = useGlobalSearch()
  const [showSearchNav, setShowSearchNav] = useState(false)
  const [searchNavHighlight, setSearchNavHighlight] = useState(0)
  const [dateRange, setDateRange]   = useState<DateRangeOption>('thisMonth')
  // Sidebar defaults to collapsed (hover-to-expand); this only "pins" it open.
  const [sidebarOpen, setSidebarOpen] = useState(false)

  // First-run walkthrough. Opens for anyone who has not finished it yet --
  // not just brand-new accounts, so existing users who never saw it still get
  // it once. Deliberately not gated on "is this a new signup".
  const [tourOpen, setTourOpen] = useState(false)
  // Held until the "Today so far" fetch settles: that card renders async, and
  // the tour resolves its steps once, so opening earlier would drop that step
  // as "not on screen". A seller, whose fetch legitimately fails, settles too.
  const [snapshotSettled, setSnapshotSettled] = useState(false)
  useEffect(() => {
    if (access && snapshotSettled && !hasCompletedTour(access.userId)) setTourOpen(true)
  }, [access, snapshotSettled])
  const [showNotif, setShowNotif]   = useState(false)
  const [notifSnapshot, setNotifSnapshot] = useState<LiveAlert[]>([])
  const [showUser, setShowUser]     = useState(false)

  const [isOnline, setIsOnline] = useState(navigator.onLine)
  const [pendingSync, setPendingSync] = useState(0)
  const [alerts, setAlerts] = useState<LiveAlert[]>([])
  // Newly-arrived unread alerts, shown as animated toast cards until
  // dismissed or auto-expired -- populated by refreshAlerts' new-vs-seen
  // diff below, not a straight mirror of `alerts` itself.
  const [toasts, setToasts] = useState<LiveAlert[]>([])
  // Set right before navigating to 'reports' from a "reorder point missing"
  // notification (see goToAlertTarget below) so ReportsPage can open that
  // exact product's reorder modal on arrival instead of just landing on the
  // page. Cleared via ReportsPage's onFocusHandled once consumed.
  const [reportsFocusProductId, setReportsFocusProductId] = useState<string | null>(null)

  useEffect(() => {
    const up   = () => { setIsOnline(true);  setPendingSync(0) }
    const down = () => { setIsOnline(false); setPendingSync(p => p + Math.floor(Math.random() * 3) + 1) }
    window.addEventListener('online', up)
    window.addEventListener('offline', down)
    return () => { window.removeEventListener('online', up); window.removeEventListener('offline', down) }
  }, [])

  // Resolves organization membership as PART of session restore, before the
  // loading screen ever clears -- so a restored org_owner/org_manager lands
  // straight on the Organization dashboard with no visible flash through
  // Overview first. (An interactive sign-in, below in the `!access` render
  // branch, does the same two-step-before-render dance for the same reason.)
  useEffect(() => {
    (async () => {
      const restored = await restoreBranchAccess()
      setAccess(restored)
      if (restored) {
        const org = await getMyOrganization().catch(() => null)
        setOrganization(org)
        setPage(computeDefaultPage(roleFromAccess(restored), org))
      }
      setAccessLoading(false)
    })()
  }, [])

  // Fetched fresh on sign-in/session restore; BranchSettingsPage's
  // onLogoSaved callback (passed to it below) keeps this live after that
  // without requiring a reload, the same way the receipt already picks up a
  // saved logo change on its own next fetch.
  useEffect(() => {
    if (!access) { setPharmacyLogoUrl(null); return }
    let cancelled = false
    void getMyBranchDetails()
      .then(details => {
        if (cancelled) return
        setPharmacyLogoUrl(details.logoPath ? branchLogoUrl(details.logoPath) : null)
        // Seeds a first-time viewer's language from the branch's own default
        // (Branch Settings' Locale card) -- never overrides a real personal
        // choice, including one this same seeding already made last visit.
        if (!hasExplicitLangPreference()) setLang(details.defaultLanguage)
      })
      .catch(() => { /* sidebar just keeps the default PharmSync mark */ })
    return () => { cancelled = true }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [access])

  // Tracks which alert ids have already been seen, purely so refreshAlerts
  // (below) can tell "genuinely new since last poll" apart from "already
  // known, just re-fetched again" -- a plain ref, not state, since nothing
  // should re-render when it changes; it's read only inside that same
  // callback. hasSeenFirstLoadRef additionally suppresses toasting the
  // very first fetch of a session (pre-existing unread alerts should
  // populate the badge quietly, not fire a toast burst on sign-in).
  const seenAlertIdsRef = useRef<Set<string>>(new Set())
  const hasSeenFirstLoadRef = useRef(false)

  const refreshAlerts = useCallback(async () => {
    // Best-effort and silent: a missed check here just means an overdue
    // out-of-stock reminder, or a not-yet-written-off expired batch,
    // surfaces on the next poll instead of this one.
    try { await checkOutOfStockAlerts() } catch { /* ignore */ }
    try { await checkExpiredStock() } catch { /* ignore */ }
    try { await checkLicenseExpiry() } catch { /* ignore */ }
    try { await checkForecastAccuracyNotifications() } catch { /* ignore */ }
    try { await checkMissingReorderPoints() } catch { /* ignore */ }
    try { await checkRestockRecommendations() } catch { /* ignore */ }
    try { await checkMissingBranchLocation() } catch { /* ignore */ }
    try {
      const next = await loadLiveAlerts()
      if (hasSeenFirstLoadRef.current) {
        const freshlyUnread = next.filter(a => !a.isRead && !seenAlertIdsRef.current.has(a.id))
        if (freshlyUnread.length > 0) {
          // Cap how many stack up at once -- a burst of many at once (e.g.
          // several checks firing together) should still read as "you have
          // new alerts", not paper the screen with cards.
          setToasts(current => [...current, ...freshlyUnread].slice(-3))
        }
      } else {
        hasSeenFirstLoadRef.current = true
      }
      seenAlertIdsRef.current = new Set(next.map(a => a.id))
      setAlerts(next)
    } catch { /* best-effort -- badge just stays at its last known count */ }
  }, [])

  useEffect(() => { if (access) void refreshAlerts() }, [access, refreshAlerts])
  useEffect(() => {
    if (!access) return
    const id = setInterval(() => void refreshAlerts(), 30000)
    return () => clearInterval(id)
  }, [access, refreshAlerts])

  const refreshTodaySnapshot = useCallback(async () => {
    try { setTodaySnapshot(await loadBranchSnapshot()) } catch { setTodaySnapshot(null) }
    finally { setSnapshotSettled(true) }
  }, [])

  useEffect(() => { if (access) void refreshTodaySnapshot() }, [access, refreshTodaySnapshot])
  useEffect(() => { if (access) void refreshOrganization(); else setOrganization(null) }, [access, refreshOrganization])
  useEffect(() => {
    if (!access) return
    const id = setInterval(() => void refreshTodaySnapshot(), 30000)
    return () => clearInterval(id)
  }, [access, refreshTodaySnapshot])

  const role: Role = roleFromAccess(access)

  // A role only ever sees the pages listed for it in NAV_ITEMS -- this guard
  // makes that true regardless of how `page` got its current value. It
  // matters most on session restore (restoreBranchAccess() → setAccess(),
  // above): that path never calls setPage, so without this a seller whose
  // browser still holds a valid session would land on `page`'s stale
  // 'overview' default despite Overview never appearing in their sidebar.
  // useLayoutEffect (not useEffect) so the correction lands before paint --
  // no single-frame flash of a page this role shouldn't see.
  useLayoutEffect(() => {
    if (!access) return
    const allowed = computeVisibleNav(role, organization, !!viewingBranch, myBranchOrganizationId)
    if (!allowed.some(n => n.id === page)) {
      // Prefer 'organization' over whatever sorts first in NAV_ITEMS (would
      // otherwise be 'help', which sits before it in that array) -- matters
      // now that a dedicated org_manager's own allowed list is just
      // ['help', 'organization'], so this guard firing for them (e.g. an
      // in-progress session promoted mid-visit) lands on their real new
      // home, same as computeDefaultPage would on a fresh sign-in.
      setPage(allowed.find(n => n.id === 'organization')?.id ?? allowed[0]?.id ?? 'help')
    }
  }, [access, role, organization, page, viewingBranch, myBranchOrganizationId])

  // Same correction, one level down: an org_manager only gets Dashboard/
  // Stock Transfers/Members inside the Organization section (see
  // visibleOrgTabs below) -- if orgTab is sitting on Branches or Settings
  // when that restriction takes effect (e.g. right after being demoted from
  // org_owner), snap back to Dashboard rather than showing a tab they no
  // longer have a sidebar entry for.
  useLayoutEffect(() => {
    if (organization?.myRole === 'org_manager') {
      if (orgTab !== 'dashboard' && orgTab !== 'transfers' && orgTab !== 'members') setOrgTab('dashboard')
      return
    }
    // A plain branch owner/manager with no org role of their own, whose
    // branch merely belongs to an organization -- Stock Transfers is the
    // only tab they have (see visibleOrgTabs above).
    if (!organization && myBranchOrganizationId && orgTab !== 'transfers') setOrgTab('transfers')
  }, [organization, orgTab, myBranchOrganizationId])

  // Background warm-up: once signed in, prefetch every page chunk this role
  // can navigate to, so clicking around later never pays a per-page fetch
  // cost -- not right away (that would compete with the current page's own
  // data requests), and not on a metered/data-saver connection. Runs once
  // per role per tab; prefetchPage()'s own Set makes a second run harmless.
  useEffect(() => {
    if (!access) return
    const saveData = (navigator as { connection?: { saveData?: boolean } }).connection?.saveData
    if (saveData) return
    const allowed = computeVisibleNav(role, organization, false, myBranchOrganizationId)
    const warmUp = () => { allowed.forEach(item => prefetchPage(item.id)) }
    const hasIdleCallback = typeof window.requestIdleCallback === 'function'
    const handle = hasIdleCallback ? window.requestIdleCallback(warmUp, { timeout: 4000 }) : window.setTimeout(warmUp, 1500)
    return () => {
      if (hasIdleCallback) window.cancelIdleCallback(handle as number)
      else window.clearTimeout(handle as number)
    }
  }, [access, role, organization, myBranchOrganizationId])

  // Global barcode scanner: active only inside the authenticated pharmacy
  // app (never during sign-in, the admin console, branch registration, or
  // password reset -- hashRoute is anything other than 'home' there). The
  // listener itself lives in lib/scanner.tsx; this is only the navigation
  // half -- if a scan is recognized while on any other page, jump to Sales
  // so it can be picked up there. Consuming (and clearing) the scanned code
  // is SalesPage's own responsibility once mounted, not this effect's.
  const scanner = useScanner()
  const scannerEnabled = !!access && hashRoute === 'home'
  const scannerCatcher = useBarcodeScannerListener(scannerEnabled)
  useEffect(() => {
    if (scannerEnabled && scanner.barcode && page !== 'sales') {
      setPage('sales')
    }
  }, [scanner.barcode, scannerEnabled, page])

  async function handleSignOut() {
    await signOutFromBranch()
    setAccess(null)
    setPage('overview')
    setViewingBranch(null)
    setShowUser(false)
  }

  const loadingFallback = <main style={{ minHeight: '100vh', display: 'grid', placeItems: 'center', background: 'var(--bg)', color: 'var(--ink-muted)', fontFamily: 'var(--font-body)' }}>{t('shell.loadingWorkspace')}</main>

  if (hashRoute === 'admin') return <Suspense fallback={loadingFallback}><AdminPortal /></Suspense>
  if (hashRoute === 'branch') return <Suspense fallback={loadingFallback}><BranchPortal /></Suspense>
  if (hashRoute === 'reset') return <Suspense fallback={loadingFallback}><ResetPassword /></Suspense>
  if (hashRoute === 'receipt') return <Suspense fallback={loadingFallback}><PublicReceiptPage /></Suspense>
  if (hashRoute === 'payment-return') {
    return (
      <main style={{ minHeight: '100vh', display: 'grid', placeItems: 'center', background: 'var(--bg)', padding: 24, textAlign: 'center' }}>
        <div>
          <div style={{ fontSize: 40, marginBottom: 12 }}>👍</div>
          <p style={{ fontWeight: 700, fontSize: 16, color: 'var(--ink)', margin: '0 0 6px' }}>{t('shell.paymentReturnTitle')}</p>
          <p style={{ fontSize: 13, color: 'var(--ink-muted)', margin: 0 }}>{t('shell.paymentReturnBody')}</p>
        </div>
      </main>
    )
  }

  if (introPhase !== 'done') return <IntroSplash exiting={introPhase === 'exiting'} />

  if (accessLoading) {
    return loadingFallback
  }

  if (!access) {
    return <BranchAccessPage onAccess={async branchAccess => {
      // Resolve organization membership BEFORE setting access/page, so both
      // land in the same render -- otherwise access would briefly go
      // non-null with the stale 'overview' page still showing before this
      // resolves, flashing an org_owner through Overview for a beat first.
      const org = await getMyOrganization().catch(() => null)
      setOrganization(org)
      setAccess(branchAccess)
      setPage(computeDefaultPage(roleFromAccess(branchAccess), org))
    }} />
  }

  const currentRole = ROLES.find(r => r.id === role)!
  const visibleNav = computeVisibleNav(role, organization, !!viewingBranch, myBranchOrganizationId)
  // An org_manager only gets Dashboard/Stock Transfers/Members inside the
  // Organization section -- Branches and Settings stay owner-only. An
  // org_owner keeps all five.
  // A plain branch owner/manager with no org_owner/org_manager role of their
  // own (organization is null) but whose branch belongs to one
  // (myBranchOrganizationId isn't) only ever needs Stock Transfers here --
  // every other tab's own RPCs require real org membership and would just
  // fail for them.
  const visibleOrgTabs = organization?.myRole === 'org_manager'
    ? ORG_TABS.filter(tab => tab.id === 'dashboard' || tab.id === 'transfers' || tab.id === 'members')
    : !organization && myBranchOrganizationId
      ? ORG_TABS.filter(tab => tab.id === 'transfers')
      : ORG_TABS
  const alertCount = alerts.filter(a => !a.isRead).length
  const navBadge = (id: string) => (id === 'alerts' ? alertCount : undefined)

  // Drilling into one branch from Organization > Branches used to swap the
  // org sidebar away entirely (page became 'overview'). Now it renders a
  // second, persistent org-tab rail alongside the branch's own nav -- see
  // the two-<Sidebar> block below -- so the org context never disappears.
  const showingBranchDrillIn = !!(organization && viewingBranch)

  // "Go to a section as you type": ranks a label that STARTS WITH what's been
  // typed so far above one that merely contains it somewhere in the middle —
  // typing "inv" should surface "Inventory Dashboard" before something like
  // "Receive Stock" would ever tie on a looser match.
  const searchNeedle = search.trim().toLowerCase()
  const searchNavMatches = searchNeedle
    ? visibleNav
        .map(item => ({ item, label: t(`nav.${item.id}` as TranslationKey) }))
        .filter(({ label }) => label.toLowerCase().includes(searchNeedle))
        .sort((a, b) => {
          const aStarts = a.label.toLowerCase().startsWith(searchNeedle)
          const bStarts = b.label.toLowerCase().startsWith(searchNeedle)
          return aStarts === bStarts ? 0 : aStarts ? -1 : 1
        })
    : []

  function goToSearchResult(pageId: string) {
    setPage(pageId)
    setSearch('')
    setShowSearchNav(false)
  }

  // Opening the bell marks whatever was unread at that instant as read —
  // no separate click required. The dropdown itself still renders from a
  // frozen snapshot taken right here, so the cashier can see what was just
  // read instead of the list emptying out from under them the moment it
  // marks itself read.
  // Snapshots the currently-unread alerts for the dropdown to display, and
  // marks them all read (both locally and server-side) -- shared by the
  // bell button's own open case and a toast click, so the two entry points
  // into "look at my notifications" behave identically.
  function openNotifDropdown() {
    const unread = alerts.filter(a => !a.isRead)
    setNotifSnapshot(unread)
    if (unread.length > 0) {
      void markAllAlertsRead(unread.map(a => a.id)).catch(() => { /* best-effort; next poll reconciles */ })
      setAlerts(current => current.map(a => a.isRead ? a : { ...a, isRead: true }))
    }
    setShowNotif(true)
    setShowUser(false)
  }

  function toggleNotif() {
    setShowNotif(open => {
      if (!open) { openNotifDropdown(); return true }
      return false
    })
    setShowUser(false)
  }

  // A toast is a copy of an alert row taken at the moment it arrived --
  // dismissing it (by timeout or by hand) never needs to touch is_read
  // itself, since opening the dropdown (openNotifDropdown, above) already
  // marks the real row read the same way clicking the bell does.
  function dismissToast(id: string) {
    setToasts(current => current.filter(t => t.id !== id))
  }

  // Shared by a dropdown row click and a toast click: an actionable "this
  // isn't configured yet" alert (see alertActionTarget()) navigates
  // straight to where it gets fixed instead of just opening the dropdown,
  // and marks that one alert read on the way. Returns whether it actually
  // navigated, so a toast click that isn't actionable can fall back to
  // opening the dropdown instead (its previous behavior).
  function goToAlertTarget(alert: LiveAlert): boolean {
    const target = alertActionTarget(alert)
    if (!target) return false
    void markAlertRead(alert.id).catch(() => { /* best-effort; next poll reconciles */ })
    setAlerts(current => current.map(a => a.id === alert.id ? { ...a, isRead: true } : a))
    setNotifSnapshot(current => current.map(a => a.id === alert.id ? { ...a, isRead: true } : a))
    if (target.page === 'reports') setReportsFocusProductId(target.productId ?? null)
    setPage(target.page)
    setShowNotif(false)
    return true
  }

  const closeMenus = () => { setShowNotif(false); setShowUser(false); setShowSearchNav(false) }

  const viewingBranchId = viewingBranch?.branchId

  // Extracted so the two-rail layout (org tabs + branch nav side by side
  // while drilled into a branch, see showingBranchDrillIn) can give the
  // branch-context <Sidebar> the exact same header/topContent/footer as the
  // single-sidebar layout does, without duplicating this JSX twice.
  const sidebarHeader = (expanded: boolean) => (
    // The pharmacy's own uploaded logo (Branch Settings) replaces the
    // shared <Logo /> mark once one exists -- same mark used on the
    // home page and sign-in otherwise. The "PharmSync" wordmark next
    // to it always stays the product name, not the pharmacy's own.
    <div style={{ height: 60, padding: expanded ? '0 16px' : '0 14px', display: 'flex', alignItems: 'center', gap: 10, borderBottom: '1px solid var(--border)', flexShrink: 0 }}>
      {pharmacyLogoUrl
        ? <img src={pharmacyLogoUrl} alt="" width={32} height={32} style={{ objectFit: 'contain', borderRadius: 6, flexShrink: 0 }} />
        : <Logo size={32} showWordmark={false} />}
      {expanded && (
        <div style={{ overflow: 'hidden', whiteSpace: 'nowrap' }}>
          <div style={{ fontSize: 14, fontWeight: 700, color: 'var(--ink)', fontFamily: 'var(--font-display)', letterSpacing: '-0.01em' }}>
            Pharm<span style={{ color: 'var(--primary)' }}>Sync</span>
          </div>
          <div style={{ fontSize: 10, color: 'var(--ink-muted)', fontWeight: 500, marginTop: 1 }}>{t('shell.tagline')}</div>
        </div>
      )}
    </div>
  )

  // The org rail is the leftmost element on screen whenever it renders
  // (showingBranchDrillIn), so IT carries the logo mark there -- not the
  // branch rail beside it. Giving both rails their own copy of the logo
  // used to put the mark in the second column instead of the true top-left
  // corner (and looked like two logos colliding); the branch rail skips its
  // own header entirely in that state instead (see the two-<Sidebar> block
  // below). Icon-only, matching the rail's permanent 60px width.
  const orgRailHeader = () => (
    <div style={{ height: 60, display: 'flex', alignItems: 'center', justifyContent: 'center', borderBottom: '1px solid var(--border)', flexShrink: 0 }}>
      {pharmacyLogoUrl
        ? <img src={pharmacyLogoUrl} alt="" width={28} height={28} style={{ objectFit: 'contain', borderRadius: 6 }} />
        : <Logo size={28} showWordmark={false} />}
    </div>
  )

  const sidebarTopContent = (expanded: boolean) => expanded && (
    <>
      {/* Org role badge -- the sidebar's own persistent identity cue for an
          org_owner/org_manager, alongside the top bar. Shown for every page
          while an org role exists, not just the dashboard, so it doesn't pop
          in and out. */}
      {organization && (
        <div style={{ padding: '10px 12px 0', flexShrink: 0 }}>
          <span style={{
            display: 'inline-flex', alignItems: 'center', padding: '3px 9px', borderRadius: 999,
            fontSize: 10, fontWeight: 700, letterSpacing: '0.04em', textTransform: 'uppercase',
            background: 'var(--primary-light)', color: 'var(--primary)',
          }}>
            {t(organization.myRole === 'org_owner' ? 'shell.roleOrgOwner' : 'shell.roleOrgManager')}
          </span>
        </div>
      )}

      {/* "Today so far" -- replaces a role/branch pill that only ever
          repeated info already shown in the top bar (branch name) and
          the avatar (who's signed in). Not shown at all if the fetch
          failed, which is expected for a seller (ai_branch_snapshot()
          is owner/manager-only) rather than an error worth surfacing. */}
      {todaySnapshot && (
        <div data-tour="today-snapshot" style={{ padding: '10px 12px', borderBottom: '1px solid var(--bg-alt)', flexShrink: 0 }}>
          <div style={{ background: 'var(--primary-light)', border: '1px solid var(--border)', borderRadius: 8, padding: '9px 10px', display: 'flex', flexDirection: 'column', gap: 3 }}>
            <button
              onClick={() => setPage('overview')}
              style={{ display: 'block', width: '100%', textAlign: 'left', fontFamily: 'inherit', cursor: 'pointer', background: 'none', border: 'none', padding: 0 }}
            >
              <div style={{ fontSize: 10, fontWeight: 600, color: 'var(--ink-muted)', textTransform: 'uppercase', letterSpacing: '0.05em' }}>
                {t('shell.todaySnapshotLabel')}
              </div>
              <div style={{ fontSize: 17, fontWeight: 800, color: 'var(--primary)', marginTop: 2 }}>
                {fmtRWFExact(todaySnapshot.todayRevenue)}
              </div>
            </button>
            {(todaySnapshot.outOfStockCount + todaySnapshot.lowStockCount + todaySnapshot.expiringSoonCount) > 0 && (
              <button
                onClick={goToInventoryAttention}
                title={t('shell.todaySnapshotAttentionHint')}
                style={{
                  display: 'block', width: '100%', textAlign: 'left', fontFamily: 'inherit', cursor: 'pointer',
                  background: 'none', border: 'none', padding: 0, fontSize: 11, color: '#b45309', fontWeight: 600,
                  textDecoration: 'underline', textUnderlineOffset: 2,
                }}
              >
                ⚠ {t('shell.todaySnapshotAttention', { count: todaySnapshot.outOfStockCount + todaySnapshot.lowStockCount + todaySnapshot.expiringSoonCount })}
              </button>
            )}
          </div>
        </div>
      )}

      {/* Language switcher — lives here, not the top bar, because the top
          bar's search box + date filter + branch badge + notif bell +
          avatar already crowd a laptop-width screen; anything appended
          after them there risked being squeezed past the app-shell's
          overflow:hidden and never rendering at all. The sidebar has its
          own space that isn't competing with anything else. */}
      <div style={{ padding: '0 12px 10px', borderBottom: '1px solid var(--bg-alt)', flexShrink: 0, display: 'flex', flexDirection: 'column', gap: 8 }}>
        <div data-tour="language"><LanguageSwitcher /></div>
        <div data-tour="connection" style={{
          display: 'flex', alignItems: 'center', gap: 6, padding: '5px 9px', borderRadius: 8,
          background: isOnline ? '#f0fdf4' : '#fef3c7',
          border: `1px solid ${isOnline ? '#86efac' : '#fcd34d'}`,
        }}>
          <div style={{ width: 7, height: 7, borderRadius: '50%', background: isOnline ? '#16a34a' : '#d97706', flexShrink: 0 }} />
          <span style={{ fontSize: 11, fontWeight: 600, color: isOnline ? '#16a34a' : '#d97706', whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>
            {isOnline ? t('shell.online') : pendingSync > 0 ? t('shell.offlineQueued', { count: pendingSync }) : t('shell.offline')}
          </span>
        </div>
      </div>
    </>
  )

  const sidebarFooter = (expanded: boolean) => (
    <div style={{ padding: '10px 8px', borderTop: '1px solid var(--border)', flexShrink: 0 }}>
      <button
        onClick={() => { setShowUser(u => !u); setShowNotif(false) }}
        style={{
          width: '100%', display: 'flex', alignItems: 'center', gap: expanded ? 8 : 0,
          justifyContent: expanded ? 'flex-start' : 'center',
          padding: '7px 8px', borderRadius: 8, border: 'none', background: 'transparent',
          cursor: 'pointer', fontFamily: 'inherit', transition: 'background 0.14s',
        }}
        onMouseEnter={e => { (e.currentTarget as HTMLButtonElement).style.background = 'var(--bg)' }}
        onMouseLeave={e => { (e.currentTarget as HTMLButtonElement).style.background = 'transparent' }}
      >
        {pharmacyLogoUrl
          ? <img src={pharmacyLogoUrl} alt="" width={32} height={32} style={{ borderRadius: '50%', objectFit: 'cover', flexShrink: 0 }} />
          : <div style={{
              width: 32, height: 32, borderRadius: '50%', background: currentRole.color,
              color: '#fff', display: 'flex', alignItems: 'center', justifyContent: 'center',
              fontSize: 12, fontWeight: 700, flexShrink: 0,
            }}>{currentRole.abbr}</div>}
        {expanded && (
          <div style={{ overflow: 'hidden', textAlign: 'left' }}>
            <div style={{ fontSize: 12, fontWeight: 600, color: 'var(--ink)', whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>{access.fullName}</div>
            <div style={{ fontSize: 10, color: 'var(--ink-muted)' }}>{t(roleLabelKey(currentRole.id))}</div>
          </div>
        )}
      </button>
    </div>
  )

  function renderPage() {
    switch (page) {
      case 'overview':      return <OverviewPage
                                     period={dateRange}
                                     branchName={access!.branchName}
                                     alerts={alerts}
                                     onViewAlerts={() => setPage('alerts')}
                                     onViewFullReport={() => setPage('analytics')}
                                     organization={organization}
                                     branches={orgBranches}
                                     initialScopeBranchId={viewingBranchId}
                                   />
      case 'inventory':     return <LiveInventoryPage key={inventoryFocus?.seq ?? 0} initialStatus={inventoryFocus ? 'attention' : undefined} branchId={viewingBranchId} />
      case 'receiving':     return <StockReceivingPage branchId={viewingBranchId} />
      case 'barcode':       return <BarcodeManagerPage branchId={viewingBranchId} />
      case 'sales':         return <SalesPage onViewAllTransactions={() => setPage('transactions')} branchId={viewingBranchId} role={role} />
      case 'locate':        return <LocateProductPage role={role} />
      case 'reports':       return <ReportsPage focusProductId={reportsFocusProductId} onFocusHandled={() => setReportsFocusProductId(null)} />
      case 'alerts':        return <AlertsPage branchId={viewingBranchId} onSelectAlert={goToAlertTarget} />
      case 'transactions':  return <TransactionsPage period={dateRange} branchId={viewingBranchId} />
      case 'insurance':     return <InsurancePage branchId={viewingBranchId} />
      case 'analyst':       return <AnalystPage />
      case 'analytics':     return <AnalyticsPage period={dateRange} branchId={viewingBranchId} />
      case 'compliance':    return <CompliancePage branchId={viewingBranchId} />
      case 'patients':      return <PatientsPage branchId={viewingBranchId} />
      // Viewing a DIFFERENT branch than your own only ever happens for an
      // org_owner/org_manager (effective_branch_id() on the server enforces
      // this) -- that's full settings authority there, same as that branch's
      // own owner, so "owner" is passed regardless of the caller's own home
      // role. Viewing your own branch (or not viewing one at all) keeps your
      // real role, preserving the existing owner-vs-manager split.
      case 'branch':        return <BranchSettingsPage onLogoSaved={setPharmacyLogoUrl} role={viewingBranchId && viewingBranchId !== access?.branchId ? 'owner' : role} branchId={viewingBranchId} />
      case 'organization':  return <OrganizationPage
                                     currentUserId={access!.userId}
                                     currentBranchId={access!.branchId}
                                     organization={organization}
                                     myBranchOrganizationId={myBranchOrganizationId}
                                     onOrganizationChanged={refreshOrganization}
                                     onViewBranch={branch => { setViewingBranch(branch); setPage('overview') }}
                                     activeTab={orgTab}
                                     period={dateRange}
                                     alerts={alerts}
                                     onViewAlerts={() => setPage('alerts')}
                                     onGoToTransfers={() => setOrgTab('transfers')}
                                   />
      case 'history':       return <HistoryPage period={dateRange} branchId={viewingBranchId} />
      case 'help':          return <HelpPage />
      default:              return null
    }
  }

  return (
    <div className="app-shell" style={{ display: 'flex', height: '100vh', overflow: 'hidden', background: 'var(--bg)', fontFamily: 'var(--font-body)', fontSize: 13 }}>

      {/* ── Sidebar ──────────────────────────────────────────────────────────── */}
      {/* Hover-to-expand by default; the collapse/expand button in the top
          bar sets `pinned`, which locks it open regardless of hover -- for a
          large monitor, or anyone who'd rather not re-hover constantly. */}
      {/* Drawer backdrop -- phone only (CSS hides it above 640px). Tapping it
          closes the sidebar, the behaviour every drawer on a phone has;
          without it the drawer just sat over the dashboard with no way out
          except finding the hamburger again. */}
      <div
        className={`app-drawer-backdrop${sidebarOpen ? ' is-open' : ''}`}
        onClick={() => setSidebarOpen(false)}
        aria-hidden="true"
      />

      {/* Drilled into one branch from Organization > Branches: the org-tab
          rail stays put (icon-only, like Supabase's far-left project rail)
          instead of disappearing, with the branch's own full nav rendered
          as a second, normal rail right beside it -- see showingBranchDrillIn
          above. Clicking any org-rail item exits the branch view back into
          that org tab. */}
      {showingBranchDrillIn && (
        <Sidebar
          className="app-chrome app-org-rail"
          collapsedWidth={60}
          expandedWidth={60}
          items={visibleOrgTabs.map(tab => ({ id: tab.id, icon: tab.icon }))}
          activeId="branches"
          onSelect={id => { setViewingBranch(null); setOrgTab(id as OrgTab); setPage('organization') }}
          getLabel={id => t(ORG_TABS.find(tab => tab.id === id)!.labelKey)}
          header={orgRailHeader}
        />
      )}

      <Sidebar
        className={`app-chrome app-sidebar${sidebarOpen ? ' sidebar-open' : ''}`}
        dataTour="sidebar"
        /* The tour explains the nav items, so the sidebar has to stay open
           for the whole walkthrough rather than collapsing on mouse-out. */
        pinned={sidebarOpen || tourOpen}
        items={showingBranchDrillIn
          ? visibleNav.map(item => ({ id: item.id, icon: item.icon, badge: navBadge(item.id) }))
          : page === 'organization'
            ? visibleOrgTabs.map(tab => ({ id: tab.id, icon: tab.icon }))
            : visibleNav.map(item => ({ id: item.id, icon: item.icon, badge: navBadge(item.id) }))}
        activeId={showingBranchDrillIn ? page : page === 'organization' ? orgTab : page}
        onSelect={id => {
          if (!showingBranchDrillIn && page === 'organization') { setOrgTab(id as OrgTab); return }
          setPage(id)
          if (window.matchMedia('(max-width: 640px)').matches) setSidebarOpen(false)
        }}
        getLabel={id => (!showingBranchDrillIn && page === 'organization')
          ? t(ORG_TABS.find(tab => tab.id === id)!.labelKey)
          : t(`nav.${id}` as TranslationKey)}
        onItemHover={prefetchPage}
        // The org rail already carries the logo while it's on screen
        // (showingBranchDrillIn) -- this rail skips its own header entirely
        // rather than showing a second, redundant mark in the wrong corner.
        header={showingBranchDrillIn ? undefined : sidebarHeader}
        topContent={sidebarTopContent}
        footer={sidebarFooter}
      />

      {/* ── Main area ─────────────────────────────────────────────────────────── */}
      <div style={{ flex: 1, display: 'flex', flexDirection: 'column', overflow: 'hidden', minWidth: 0 }}>

        {/* Top Bar */}
        <header className="app-chrome app-topbar" style={{
          height: 60, background: 'var(--surface)', borderBottom: '1px solid var(--border)',
          display: 'flex', alignItems: 'center', padding: '0 20px', gap: 10, flexShrink: 0,
        }}>
          {/* Pins the sidebar expanded, overriding hover-to-collapse (Sidebar.tsx's `pinned` prop) --
              not a plain show/hide toggle anymore, so it's visually "on" while pinned. */}
          <button
            data-tour="pin-sidebar"
            onClick={() => setSidebarOpen(o => !o)}
            title={sidebarOpen ? t('shell.unpinSidebar') : t('shell.pinSidebar')}
            style={{
              width: 32, height: 32, background: sidebarOpen ? 'var(--primary-light)' : 'none',
              border: `1px solid ${sidebarOpen ? 'var(--border-strong)' : 'var(--border)'}`,
              borderRadius: 7, cursor: 'pointer', display: 'flex', alignItems: 'center',
              justifyContent: 'center', fontSize: 14, color: sidebarOpen ? 'var(--primary)' : 'var(--ink-muted)', flexShrink: 0,
              transition: 'background 0.14s',
            }}
            onMouseEnter={e => { (e.currentTarget as HTMLButtonElement).style.background = 'var(--bg)' }}
            onMouseLeave={e => { (e.currentTarget as HTMLButtonElement).style.background = sidebarOpen ? 'var(--primary-light)' : 'none' }}
          >☰</button>

          {/* Symmetric counterpart to the "← Back to Organization" pill
              further down: the only way out of Organization mode used to be
              the "Today so far" sidebar card, which doesn't read as
              navigation at all -- most acute for a plain branch owner/
              manager whose org access is Stock Transfers alone, where the
              org sidebar has nothing else to click. Hidden if the
              remembered page turns out invalid for this role (e.g. an
              org_owner who has delegated 'overview' away) -- the
              useLayoutEffect role guard would otherwise just bounce them
              right back to Organization anyway. */}
          {page === 'organization' && !showingBranchDrillIn && visibleNav.some(item => item.id === lastNonOrgPageRef.current) && (
            <button
              onClick={() => setPage(lastNonOrgPageRef.current)}
              style={{
                fontSize: 12, fontWeight: 600, color: 'var(--primary)', background: 'var(--primary-light)',
                border: '1px solid var(--border)', borderRadius: 6, padding: '5px 9px', cursor: 'pointer',
                fontFamily: 'inherit', flexShrink: 0, whiteSpace: 'nowrap',
              }}
            >
              ← {t('shell.backToDashboard')}
            </button>
          )}

          <div style={{ fontSize: 14, fontWeight: 700, color: 'var(--ink)', whiteSpace: 'nowrap', letterSpacing: '-0.01em' }}>
            {t(`page.${page}` as TranslationKey)}
          </div>

          <div style={{ flex: 1 }} />

          {/* Global Search — doubles as a "go to section" jump list. Typing
              narrows the sidebar sections that match live; Enter or a click
              jumps straight there. The typed term also still reaches every
              page's own filter (src/lib/search.tsx) for pages that have one. */}
          <div data-tour="search" style={{ position: 'relative', width: 280, flexShrink: 1, minWidth: 160 }}>
            <span style={{ position: 'absolute', left: 9, top: '50%', transform: 'translateY(-50%)', fontSize: 12, color: 'var(--ink-faint)', pointerEvents: 'none' }}>🔍</span>
            <input
              value={search}
              onChange={e => { setSearch(e.target.value); setSearchNavHighlight(0); setShowSearchNav(true) }}
              placeholder={t('shell.searchPlaceholder')}
              style={{
                width: '100%', padding: '7px 10px 7px 28px', borderRadius: 8,
                border: '1px solid var(--border)', fontSize: 12, outline: 'none',
                fontFamily: 'inherit', background: 'var(--bg)', color: 'var(--ink)',
                transition: 'border 0.15s',
              }}
              onFocus={e => { (e.target as HTMLInputElement).style.borderColor = 'var(--primary)'; setShowNotif(false); setShowUser(false); setShowSearchNav(true) }}
              onBlur={e => { (e.target as HTMLInputElement).style.borderColor = 'var(--border)' }}
              onKeyDown={e => {
                if (e.key === 'ArrowDown') { e.preventDefault(); setSearchNavHighlight(h => Math.min(h + 1, searchNavMatches.length - 1)) }
                else if (e.key === 'ArrowUp') { e.preventDefault(); setSearchNavHighlight(h => Math.max(h - 1, 0)) }
                else if (e.key === 'Enter') { const hit = searchNavMatches[searchNavHighlight]; if (hit) { e.preventDefault(); goToSearchResult(hit.item.id) } }
                else if (e.key === 'Escape') { setShowSearchNav(false); (e.target as HTMLInputElement).blur() }
              }}
            />
            {showSearchNav && searchNavMatches.length > 0 && (
              <SearchNavDropdown matches={searchNavMatches} needle={searchNeedle} highlight={searchNavHighlight} onSelect={goToSearchResult} />
            )}
          </div>

          {/* Date filter */}
          <select data-tour="date-range" value={dateRange} onChange={e => setDateRange(e.target.value as DateRangeOption)} style={{
            padding: '7px 10px', borderRadius: 8, border: '1px solid var(--border)',
            fontSize: 12, fontFamily: 'inherit', background: 'var(--bg)', color: 'var(--ink)',
            cursor: 'pointer', outline: 'none', flexShrink: 0,
          }}>
            {DATE_RANGE_OPTIONS.map(opt => <option key={opt} value={opt}>{t(dateRangeLabelKey[opt])}</option>)}
          </select>

          {/* While an org_owner/org_manager is drilling into another
              branch's dashboard (viewingBranch set from Organization >
              Branches), this pill swaps to show THAT branch plus an "Org
              view" tag and a one-click way back -- the visible half of the
              fix for the two-dashboards-at-once confusion; the state-machine
              half (renderPage()'s exclusive switch) is what actually
              prevents both from mounting together. */}
          {viewingBranch ? (
            <div data-tour="branch" title={t('shell.viewingBranchNotice')} style={{
              display: 'flex', alignItems: 'center', gap: 8, padding: '5px 6px 5px 10px', borderRadius: 8,
              border: '1px solid var(--border-strong)', background: 'var(--primary-light)',
              fontSize: 12, fontFamily: 'inherit', flexShrink: 0,
            }}>
              <span style={{ fontWeight: 600, color: 'var(--ink)' }}>
                {viewingBranch.branchName}
                {viewingBranch.branchCode && <span style={{ marginLeft: 6, fontWeight: 500, color: 'var(--ink-muted)', fontFamily: 'var(--font-mono)', fontSize: 11 }}>{viewingBranch.branchCode}</span>}
              </span>
              <span style={{ fontSize: 10, fontWeight: 700, color: 'var(--primary)', background: 'var(--surface)', borderRadius: 999, padding: '2px 7px', textTransform: 'uppercase', letterSpacing: '0.03em' }}>
                {t('shell.viewingBranchBadge')}
              </span>
              <button
                onClick={() => { setViewingBranch(null); setPage('organization') }}
                style={{
                  fontSize: 11, fontWeight: 600, color: 'var(--primary)', background: 'var(--surface)',
                  border: '1px solid var(--border)', borderRadius: 6, padding: '4px 8px', cursor: 'pointer', fontFamily: 'inherit',
                }}
              >
                ← {t('shell.backToOrganization')}
              </button>
            </div>
          ) : (
            <div data-tour="branch" title={t('shell.branchScopedNotice')} style={{
              padding: '7px 10px', borderRadius: 8, border: '1px solid var(--border)',
              fontSize: 12, fontFamily: 'inherit', background: 'var(--bg)', color: 'var(--ink)',
              fontWeight: 600, flexShrink: 0,
            }}>
              {access.branchName}
              {access.branchCode && <span style={{ marginLeft: 6, fontWeight: 500, color: 'var(--ink-muted)', fontFamily: 'var(--font-mono)', fontSize: 11 }}>{access.branchCode}</span>}
            </div>
          )}

          {/* Walkthrough. This slot used to hold the online pill; the
              connection state moved into the sidebar (topContent above) so
              an offline cashier can still see it -- losing that entirely
              would matter on a POS that keeps working without a network. */}
          <button
            data-tour="walkthrough"
            onClick={() => setTourOpen(true)}
            style={{
              display: 'flex', alignItems: 'center', gap: 6, padding: '6px 11px', borderRadius: 8,
              border: '1px solid var(--border)', background: 'none', cursor: 'pointer',
              fontFamily: 'inherit', fontSize: 12, fontWeight: 600, color: 'var(--ink-mid)',
              flexShrink: 0, whiteSpace: 'nowrap', transition: 'background 0.14s',
            }}
            onMouseEnter={e => { (e.currentTarget as HTMLButtonElement).style.background = 'var(--bg)' }}
            onMouseLeave={e => { (e.currentTarget as HTMLButtonElement).style.background = 'none' }}
          >
            <span aria-hidden="true">🧭</span>
            <span className="hide-sm">{t('shell.walkthrough')}</span>
          </button>

          {/* Notifications */}
          <div data-tour="notifications" style={{ position: 'relative', flexShrink: 0 }}>
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
              {/* The count itself, not just a dot -- clicking it (the whole
                  button) already opens the dropdown AND marks everything
                  read immediately, see toggleNotif() above; this just makes
                  that number visible instead of a plain unread indicator. */}
              {alertCount > 0 && (
                <span style={{
                  position: 'absolute', top: -3, right: -3, minWidth: 16, height: 16, padding: '0 3px',
                  background: '#dc2626', color: '#fff', borderRadius: 999, border: '2px solid var(--surface)',
                  fontSize: 9, fontWeight: 700, display: 'flex', alignItems: 'center', justifyContent: 'center', lineHeight: 1,
                }}>
                  {alertCount > 99 ? '99+' : alertCount}
                </span>
              )}
            </button>
            {showNotif && (
              <NotifDropdown
                alerts={notifSnapshot}
                onSelectAlert={alert => goToAlertTarget(alert)}
                onViewAll={() => { setPage('alerts'); setShowNotif(false) }}
              />
            )}
          </div>

          <ToastStack toasts={toasts} onDismiss={dismissToast} onOpen={alert => { if (!goToAlertTarget(alert)) openNotifDropdown() }} />

          {/* User avatar -- the pharmacy's own uploaded logo once one exists,
              same as the sidebar footer's copy of this same button. */}
          <div data-tour="account" style={{ position: 'relative', flexShrink: 0 }}>
            <button onClick={() => { setShowUser(u => !u); setShowNotif(false) }} style={{
              width: 34, height: 34, borderRadius: '50%', background: pharmacyLogoUrl ? '#fff' : currentRole.color,
              color: '#fff', display: 'flex', alignItems: 'center', justifyContent: 'center', overflow: 'hidden',
              fontSize: 12, fontWeight: 700, cursor: 'pointer', border: 'none', flexShrink: 0, padding: 0,
              boxShadow: showUser ? `0 0 0 3px ${currentRole.color}30` : 'none', transition: 'box-shadow 0.15s',
            }}>
              {pharmacyLogoUrl ? <img src={pharmacyLogoUrl} alt="" width={34} height={34} style={{ objectFit: 'cover' }} /> : currentRole.abbr}
            </button>
            {showUser && <UserMenu access={access} role={role} onRoleChange={() => undefined} onSignOut={() => { void handleSignOut() }} onClose={() => setShowUser(false)} onReplayTour={() => setTourOpen(true)} />}
          </div>
        </header>

        {/* Page content */}
        <main
          data-tour="main"
          className="app-main"
          style={{ flex: 1, overflowY: 'auto', padding: '20px 24px' }}
          onClick={closeMenus}
        >
          <Suspense fallback={<div style={{ padding: 40, textAlign: 'center', color: 'var(--ink-muted)', fontSize: 13 }}>{t('shell.loadingWorkspace')}</div>}>
            <PageErrorBoundary key={page} onReset={() => setPage('overview')}>
              {renderPage()}
            </PageErrorBoundary>
          </Suspense>
        </main>
      </div>

      {/* The global-scanner catcher: one real, invisible <input> that
          lib/scanner.tsx keeps focused whenever nothing else legitimately
          holds focus (see claimFocusIfIdle() there). Its normal browser text
          composition is what reliably handles "Barcode to PC"-style input
          (confirmed against a real device -- a hand-rolled keydown parser
          did not, since that app types via Alt+Numpad Unicode entry) -- this
          element exists so that composition happens somewhere even when the
          user isn't looking at Sales. tabIndex={-1} keeps it out of normal
          Tab navigation; it is never visible and never intercepts a click. */}
      {tourOpen && (
        <GuidedTour onFinish={() => { markTourComplete(access.userId); setTourOpen(false) }} />
      )}

      {scannerEnabled && (
        <input
          ref={scannerCatcher.inputRef}
          onKeyDown={scannerCatcher.onKeyDown}
          tabIndex={-1}
          aria-hidden="true"
          autoComplete="off"
          style={{ position: 'fixed', top: 0, left: 0, width: 1, height: 1, opacity: 0, border: 'none', padding: 0, pointerEvents: 'none' }}
        />
      )}
    </div>
  )
}
