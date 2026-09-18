import { useState, useEffect, useCallback, useMemo } from "react";
import {
  AreaChart, Area, XAxis, YAxis, CartesianGrid, Tooltip, ResponsiveContainer, PieChart, Pie, Cell, Legend,
} from "recharts";
import { ChartTooltip } from "../components";
import { usePagedList, LoadMoreButton } from "../lib/pagination";
import {
  LayoutDashboard, CheckSquare, Building2, ShieldAlert, Ticket,
  Phone, Mail, MapPin, Clock, AlertTriangle, CheckCircle2, XCircle,
  Lock, Unlock, RefreshCw, ChevronRight, Eye, Send, Bell, Activity,
  Users, TrendingUp, X, Check, ArrowLeft, Trash2, KeyRound, Package, Plus, Ban, Tag, Percent, Pencil,
  Upload, FileSpreadsheet,
} from "lucide-react";
import type { BranchRecord, BranchStatus, OrganizationApplicationRecord } from "../lib/store";
import {
  approvePharmacyApplication,
  deleteBranch,
  denyPharmacyApplication,
  isSuperAdminSession,
  listPharmacyApplications,
  adminUpdateBranchDetails,
  expireStaleApplications,
  applicationDaysLeft,
  listDeletedBranches,
  type DeletedBranchRecord,
  markPharmacyCalled,
  requestAdminOtp,
  requestPharmacyOtp,
  setBranchLock,
  signOutAdmin,
  verifyAdminOtp,
  approveOrganizationApplication,
  denyOrganizationApplication,
  listOrganizationApplications,
  markOrganizationApplicationCalled,
  expireStaleOrganizationApplications,
  adminListAllBranches,
  adminListOrganizations,
  adminSetOrganizationStatus,
  adminUpdateOrganizationDetails,
  adminPlatformStats,
  adminPatientsTimeSeries,
  type AllBranchRecord,
  type AdminOrganizationRecord,
  type AdminPlatformStats,
  type AdminPatientsTimeSeriesPoint,
  type AdminStatsInterval,
} from "../lib/onboarding";
import {
  adminListSupportTickets,
  adminUpdateTicketStatus,
  type AdminTicketRow,
  type TicketStatus,
} from "../lib/tickets";
import {
  adminApproveProductRequest,
  adminBackfillCategoriesToAllBranches,
  adminCreateCategory,
  adminCreateProduct,
  adminCreateTaxRate,
  adminListCategories,
  adminListProductRequests,
  adminListProducts,
  adminListTaxRates,
  adminRejectProductRequest,
  adminSetProductTax,
  productRequestImageUrl,
  type AdminCategoryRow,
  type AdminProduct,
  type AdminProductRequestRow,
  type ProductVariantInput,
  type TaxRate,
} from "../lib/products";
import {
  adminClearInsuranceCoverage,
  adminCreateInsuranceProvider,
  adminImportInsurancePriceList,
  adminLoadCoverageOverridesWithNames,
  adminLoadInsuranceProviders,
  adminSetInsuranceCoverage,
  adminUpdateInsuranceProvider,
  type CoverageOverrideRow,
  type InsuranceImportResult,
  type InsuranceImportRow,
  type InsuranceProvider,
} from "../lib/sales";
import {
  autoMapColumns,
  buildImportPreview,
  detectHeaderRow,
  IMPORT_FIELDS,
  parseSpreadsheetFile,
  type ColumnMapping,
  type ImportField,
  type SkippedRow,
} from "../lib/insuranceImport";
import { Logo } from "../components";
import { useTranslation, LanguageSwitcher } from "../lib/i18n";
import type { TranslationKey } from "../lib/i18n/en";

type NavId = "dashboard" | "approvals" | "branches" | "organizations" | "security" | "tickets" | "products" | "categories" | "productRequests" | "insurance";

// How many buckets the Dashboard's "patients over time" chart pulls per
// interval -- 30 days, 12 weeks, or 12 months, all comfortably one screen's
// worth of chart points. Module-level (not recreated every render) since
// it's read inside AdminPortal's refresh() useCallback below.
const PATIENTS_SERIES_PERIODS: Record<AdminStatsInterval, number> = { day: 30, week: 12, month: 12 };

function statusLabelKey(status: BranchStatus | TicketStatus): TranslationKey {
  const map: Record<string, TranslationKey> = {
    pending: "admin.statusPending",
    approved: "admin.statusApproved",
    otp_sent: "admin.statusOtpSent",
    active: "admin.statusActive",
    locked: "admin.statusLocked",
    denied: "admin.statusDenied",
    open: "admin.statusOpen",
    in_progress: "admin.statusInProgress",
    resolved: "admin.statusResolved",
    closed: "admin.statusClosed",
  };
  return map[status] ?? "admin.statusPending";
}

/** Clears the #admin hash, handing control back to App's router (the PharmSync home/dashboard). */
function backToHome() {
  window.location.hash = "";
}

// ── Small reusable pieces ─────────────────────────────────────────────────────

function Badge({ status }: { status: BranchStatus | TicketStatus }) {
  const { t } = useTranslation();
  const map: Record<string, string> = {
    pending:     "bg-amber-100 text-amber-700 border-amber-200",
    approved:    "bg-blue-100 text-blue-700 border-blue-200",
    otp_sent:    "bg-violet-100 text-violet-700 border-violet-200",
    active:      "bg-blue-100 text-blue-700 border-blue-200",
    locked:      "bg-orange-100 text-orange-700 border-orange-200",
    denied:      "bg-red-100 text-red-700 border-red-200",
    open:        "bg-red-100 text-red-700 border-red-200",
    in_progress: "bg-blue-100 text-blue-700 border-blue-200",
    resolved:    "bg-blue-100 text-blue-700 border-blue-200",
    closed:      "bg-slate-100 text-slate-600 border-slate-200",
  };
  return (
    <span className={`inline-flex items-center px-2 py-0.5 rounded-md border text-[10px] font-semibold uppercase tracking-wide ${map[status] ?? ""}`}>
      {t(statusLabelKey(status))}
    </span>
  );
}

function StatCard({ icon, label, value, sub, color, delay }: {
  icon: React.ReactNode; label: string; value: number | string;
  sub?: string; color: string; delay?: number;
}) {
  return (
    <div className="bg-white rounded-xl border border-blue-100 p-5 shadow-sm animate-fade-up" style={delay ? { animationDelay: `${delay}ms` } : undefined}>
      <div className={`w-10 h-10 rounded-lg flex items-center justify-center mb-3 ${color}`}>
        {icon}
      </div>
      <p className="text-2xl font-bold text-slate-800">{value}</p>
      <p className="text-xs font-semibold text-slate-600 mt-0.5">{label}</p>
      {sub && <p className="text-[10px] text-slate-400 mt-0.5">{sub}</p>}
    </div>
  );
}

function Modal({ title, onClose, children, wide }: {
  title: string; onClose: () => void; children: React.ReactNode; wide?: boolean;
}) {
  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 backdrop-blur-sm p-4">
      <div className={`bg-white rounded-2xl shadow-xl border border-blue-100 w-full ${wide ? "max-w-2xl" : "max-w-md"} max-h-[90vh] overflow-y-auto`}>
        <div className="flex items-center justify-between px-5 py-4 border-b border-slate-100">
          <h3 className="font-semibold text-slate-800">{title}</h3>
          <button onClick={onClose} className="text-slate-400 hover:text-slate-600 transition-colors rounded-lg p-1 hover:bg-slate-100">
            <X className="w-4 h-4" />
          </button>
        </div>
        <div className="p-5">{children}</div>
      </div>
    </div>
  );
}

function timeAgo(iso: string) {
  const d = Math.floor((Date.now() - new Date(iso).getTime()) / 60000);
  if (d < 60) return `${d}m ago`;
  if (d < 1440) return `${Math.floor(d / 60)}h ago`;
  return `${Math.floor(d / 1440)}d ago`;
}

function fmt(iso: string) {
  return new Date(iso).toLocaleString("en-GB", {
    day: "2-digit", month: "short", year: "numeric", hour: "2-digit", minute: "2-digit",
  });
}

// ── Dashboard ─────────────────────────────────────────────────────────────────

// Interval labels for the platform-wide "patients received" chart --
// date-only period_start values from admin_patients_time_series() formatted
// per bucket size (a day gets "12 Sep", a week/month gets "Sep 2026" would
// be misleading for weekly buckets, so week/month both just show the
// bucket's start date -- exact enough at a glance, consistent either way).
function formatPeriodLabel(periodStart: string, interval: AdminStatsInterval): string {
  const d = new Date(periodStart + "T00:00:00");
  if (interval === "day") return d.toLocaleDateString("en-GB", { day: "2-digit", month: "short" });
  return d.toLocaleDateString("en-GB", { day: "2-digit", month: "short", year: "2-digit" });
}

function Dashboard({
  branches, tickets, platformStats, patientsSeries, patientsInterval, onPatientsIntervalChange,
}: {
  branches: BranchRecord[]; tickets: AdminTicketRow[];
  platformStats: AdminPlatformStats | null;
  patientsSeries: AdminPatientsTimeSeriesPoint[];
  patientsInterval: AdminStatsInterval;
  onPatientsIntervalChange: (interval: AdminStatsInterval) => void;
}) {
  const { t } = useTranslation();
  const pending = branches.filter((b) => b.status === "pending").length;
  const active  = branches.filter((b) => b.status === "active").length;
  const locked  = branches.filter((b) => b.status === "locked").length;
  const openTix = tickets.filter((t) => t.status === "open").length;
  const chartData = patientsSeries.map((p) => ({ label: formatPeriodLabel(p.periodStart, patientsInterval), count: p.patientCount }));

  const feed = [
    ...branches.map((b) => ({
      time: b.submittedAt,
      icon: <Building2 className="w-3.5 h-3.5 text-blue-500" />,
      text: `${b.pharmacyName} — ${t(statusLabelKey(b.status))}`,
    })),
    ...tickets.map((tk) => ({
      time: tk.created_at,
      icon: <Ticket className="w-3.5 h-3.5 text-violet-500" />,
      text: `[Ticket] ${tk.branch_name}: "${tk.subject}"`,
    })),
  ].sort((a, b) => new Date(b.time).getTime() - new Date(a.time).getTime()).slice(0, 8);

  return (
    <div className="space-y-6">
      <div>
        <h2 className="text-xl font-bold text-slate-800">{t("admin.systemOverview")}</h2>
        <p className="text-xs text-slate-400 mt-0.5 font-mono">
          {t("admin.systemOverviewSubtitle", { date: new Date().toDateString() })}
        </p>
      </div>

      <div className="grid grid-cols-2 lg:grid-cols-4 gap-4">
        <StatCard icon={<Clock className="w-5 h-5 text-amber-600" />} label={t("admin.pendingApproval")} value={pending} color="bg-amber-50" delay={0} />
        <StatCard icon={<Activity className="w-5 h-5 text-blue-600" />} label={t("admin.activeBranches")} value={active} color="bg-blue-50" delay={60} />
        <StatCard icon={<Lock className="w-5 h-5 text-orange-600" />} label={t("admin.lockedBranchesLabel")} value={locked} color="bg-orange-50" delay={120} />
        <StatCard icon={<Ticket className="w-5 h-5 text-violet-600" />} label={t("admin.openTicketsLabel")} value={openTix} color="bg-violet-50" delay={180} />
      </div>

      {/* Platform-wide usage, across every organization -- how many chains,
          how many branches/staff are actually on the system, and how many
          patients the whole platform has served. Settled independently in
          refresh() like every other admin_* call, so a not-yet-applied
          migration only blanks this one section, never the whole console. */}
      <div>
        <p className="text-[10px] font-mono text-slate-400 uppercase tracking-widest mb-3">{t("admin.platformUsageTitle")}</p>
        <div className="grid grid-cols-2 lg:grid-cols-5 gap-4">
          <StatCard icon={<Building2 className="w-5 h-5 text-blue-600" />} label={t("admin.statOrganizations")} value={platformStats?.totalOrganizations ?? "—"} color="bg-blue-50" />
          <StatCard icon={<MapPin className="w-5 h-5 text-blue-600" />} label={t("admin.statTotalBranches")} value={platformStats?.totalBranches ?? "—"} sub={platformStats ? t("admin.statActiveOfTotal", { active: platformStats.activeBranches }) : undefined} color="bg-blue-50" />
          <StatCard icon={<Users className="w-5 h-5 text-emerald-600" />} label={t("admin.statTotalMembers")} value={platformStats?.totalMembers ?? "—"} sub={platformStats ? t("admin.statActiveOfTotal", { active: platformStats.activeMembers }) : undefined} color="bg-emerald-50" />
          <StatCard icon={<Users className="w-5 h-5 text-violet-600" />} label={t("admin.statTotalPatients")} value={platformStats?.totalPatients ?? "—"} color="bg-violet-50" />
        </div>
      </div>

      <div className="grid lg:grid-cols-3 gap-4">
        <div className="lg:col-span-2 bg-white rounded-xl border border-blue-100 shadow-sm overflow-hidden p-5">
          <div className="flex items-center justify-between gap-3 flex-wrap mb-4">
            <div className="flex items-center gap-2">
              <TrendingUp className="w-4 h-4 text-blue-600" />
              <p className="font-semibold text-sm text-slate-700">{t("admin.patientsOverTimeTitle")}</p>
            </div>
            <div className="flex gap-1">
              {(["day", "week", "month"] as AdminStatsInterval[]).map((iv) => (
                <button key={iv} onClick={() => onPatientsIntervalChange(iv)}
                  className={`px-2.5 py-1 text-[10px] font-semibold uppercase tracking-wide rounded-lg border transition-colors ${
                    patientsInterval === iv ? "border-blue-500 bg-blue-50 text-blue-700" : "border-slate-200 text-slate-500 hover:border-blue-300"
                  }`}>
                  {t(iv === "day" ? "admin.intervalDaily" : iv === "week" ? "admin.intervalWeekly" : "admin.intervalMonthly")}
                </button>
              ))}
            </div>
          </div>
          {chartData.length === 0 ? (
            <p className="text-center py-10 text-xs text-slate-400">{t("admin.patientsOverTimeEmpty")}</p>
          ) : (
            <ResponsiveContainer width="100%" height={220}>
              <AreaChart data={chartData} margin={{ top: 4, right: 8, bottom: 0, left: 0 }}>
                <defs>
                  <linearGradient id="gPatients" x1="0" y1="0" x2="0" y2="1">
                    <stop offset="5%" stopColor="#2563eb" stopOpacity={0.25} />
                    <stop offset="95%" stopColor="#2563eb" stopOpacity={0} />
                  </linearGradient>
                </defs>
                <CartesianGrid stroke="#e2e8f0" strokeDasharray="4 4" />
                <XAxis dataKey="label" tick={{ fontSize: 11, fill: "#94a3b8" }} axisLine={false} tickLine={false} minTickGap={16} />
                <YAxis tick={{ fontSize: 11, fill: "#94a3b8" }} axisLine={false} tickLine={false} allowDecimals={false} />
                <Tooltip content={<ChartTooltip />} />
                <Area
                  type="monotone" dataKey="count" name={t("admin.statTotalPatients")} stroke="#2563eb" fill="url(#gPatients)"
                  strokeWidth={2} dot={false} activeDot={{ r: 4 }}
                  animationDuration={900} animationEasing="ease-out"
                />
              </AreaChart>
            </ResponsiveContainer>
          )}
        </div>

        {/* A quick "what state are our branches in" breakdown next to the
            trend line -- the same three counts already shown as StatCards
            above, just visualized as proportions instead of raw numbers,
            which is the thing a flat number grid can't show at a glance. */}
        <div className="bg-white rounded-xl border border-blue-100 shadow-sm overflow-hidden p-5 flex flex-col">
          <div className="flex items-center gap-2 mb-4">
            <Activity className="w-4 h-4 text-blue-600" />
            <p className="font-semibold text-sm text-slate-700">{t("admin.branchStatusBreakdownTitle")}</p>
          </div>
          {active + pending + locked === 0 ? (
            <p className="text-center py-10 text-xs text-slate-400 flex-1">{t("admin.patientsOverTimeEmpty")}</p>
          ) : (
            <ResponsiveContainer width="100%" height={220}>
              <PieChart>
                <Pie
                  data={[
                    { name: t("admin.activeBranches"), value: active, color: "#2563eb" },
                    { name: t("admin.pendingApproval"), value: pending, color: "#d97706" },
                    { name: t("admin.lockedBranchesLabel"), value: locked, color: "#ea580c" },
                  ].filter((slice) => slice.value > 0)}
                  dataKey="value" nameKey="name" cx="50%" cy="46%" innerRadius={45} outerRadius={72} paddingAngle={3}
                  animationDuration={900} animationEasing="ease-out"
                >
                  {[
                    { name: t("admin.activeBranches"), value: active, color: "#2563eb" },
                    { name: t("admin.pendingApproval"), value: pending, color: "#d97706" },
                    { name: t("admin.lockedBranchesLabel"), value: locked, color: "#ea580c" },
                  ].filter((slice) => slice.value > 0).map((slice) => (
                    <Cell key={slice.name} fill={slice.color} stroke="#fff" strokeWidth={2} />
                  ))}
                </Pie>
                <Tooltip content={<ChartTooltip />} />
                <Legend verticalAlign="bottom" height={32} iconType="circle" iconSize={8} wrapperStyle={{ fontSize: 11, color: "#64748b" }} />
              </PieChart>
            </ResponsiveContainer>
          )}
        </div>
      </div>

      {locked > 0 && (
        <div className="bg-orange-50 border border-orange-200 rounded-xl p-4 flex items-start gap-3">
          <AlertTriangle className="w-5 h-5 text-orange-500 shrink-0 mt-0.5" />
          <div>
            <p className="font-semibold text-orange-700 text-sm">{t("admin.securityAlert")}</p>
            <p className="text-xs text-orange-600 mt-0.5">
              {t(locked > 1 ? "admin.securityAlertPlural" : "admin.securityAlertSingular", { count: locked })}
            </p>
          </div>
        </div>
      )}

      {openTix > 0 && (
        <div className="bg-violet-50 border border-violet-200 rounded-xl p-4 flex items-start gap-3">
          <Bell className="w-5 h-5 text-violet-500 shrink-0 mt-0.5" />
          <div>
            <p className="font-semibold text-violet-700 text-sm">{t(openTix > 1 ? "admin.openTicketsHeadlinePlural" : "admin.openTicketsHeadlineSingular", { count: openTix })}</p>
            <p className="text-xs text-violet-600 mt-0.5">{t(openTix > 1 ? "admin.needsHelpPlural" : "admin.needsHelpSingular")}</p>
          </div>
        </div>
      )}

      <div className="bg-white rounded-xl border border-blue-100 shadow-sm overflow-hidden">
        <div className="px-5 py-3 border-b border-slate-100 flex items-center gap-2">
          <TrendingUp className="w-4 h-4 text-blue-600" />
          <p className="font-semibold text-sm text-slate-700">{t("admin.recentActivity")}</p>
        </div>
        <div className="divide-y divide-slate-50">
          {feed.map((f, i) => (
            <div key={i} className="px-5 py-3 flex items-center gap-3">
              <span className="shrink-0">{f.icon}</span>
              <p className="text-xs text-slate-600 flex-1 truncate">{f.text}</p>
              <span className="text-[10px] text-slate-400 font-mono shrink-0">{timeAgo(f.time)}</span>
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}

// ── Approvals ─────────────────────────────────────────────────────────────────

function Approvals({
  applications,
  orgBranches,
  onChange,
}: {
  applications: OrganizationApplicationRecord[];
  orgBranches: AllBranchRecord[];
  onChange: () => void;
}) {
  const { t } = useTranslation();
  const [detailBranch, setDetailBranch] = useState<OrganizationApplicationRecord | null>(null);
  const [action, setAction] = useState<"approve" | "deny" | null>(null);
  const [denyReason, setDenyReason] = useState("");
  const [sendingOtp, setSendingOtp] = useState(false);

  const pending = applications.filter((b) => b.status === "pending");
  const processed = applications.filter((b) => ["otp_sent","active","denied"].includes(b.status));

  async function markCalled(id: string) {
    await markOrganizationApplicationCalled(id);
    onChange();
    if (detailBranch?.id === id) setDetailBranch((p) => p ? { ...p, calledAt: new Date().toISOString() } : p);
  }

  async function handleApprove() {
    if (!detailBranch) return;
    setSendingOtp(true);
    try {
      await approveOrganizationApplication(detailBranch.id);
      setDetailBranch(null);
      setAction(null);
      onChange();
    } catch (reason) {
      window.alert(reason instanceof Error ? reason.message : t("admin.approvalFailed"));
    } finally {
      setSendingOtp(false);
    }
  }

  async function handleDeny() {
    if (!detailBranch) return;
    try {
      await denyOrganizationApplication(detailBranch.id, denyReason);
      setDetailBranch(null);
      setAction(null);
      setDenyReason("");
      onChange();
    } catch (reason) {
      window.alert(reason instanceof Error ? reason.message : t("admin.denialFailed"));
    }
  }

  return (
    <div className="space-y-6">
      <div>
        <h2 className="text-xl font-bold text-slate-800">{t("admin.branchApprovals")}</h2>
        <p className="text-xs text-slate-400 mt-0.5">{t(pending.length !== 1 ? "admin.requestsAwaitingPlural" : "admin.requestsAwaitingSingular", { count: pending.length })}</p>
      </div>

      {pending.length === 0 ? (
        <div className="bg-white rounded-xl border border-blue-100 p-12 text-center">
          <CheckCircle2 className="w-10 h-10 text-blue-400 mx-auto mb-3" />
          <p className="text-sm text-slate-500">{t("admin.allCaughtUp")}</p>
        </div>
      ) : (
        <div className="space-y-3">
          {pending.map((b) => (
            <div key={b.id} className="bg-white rounded-xl border border-blue-100 shadow-sm p-5 hover:border-blue-300 transition-colors">
              <div className="flex items-start justify-between gap-4 flex-wrap">
                <div className="space-y-1 min-w-0">
                  <div className="flex items-center gap-2 flex-wrap">
                    <span className="font-mono text-[10px] text-slate-400">{b.applicationCode ?? b.id.slice(0, 8)}</span>
                    <Badge status={b.status} />
                    {b.calledAt && (
                      <span className="flex items-center gap-1 text-[10px] text-blue-600 font-semibold">
                        <Phone className="w-3 h-3" /> {t("admin.called")}
                      </span>
                    )}
                  </div>
                  <p className="font-bold text-slate-800">{b.legalName}</p>
                  <div className="flex flex-col gap-0.5 text-[11px] text-slate-500">
                    <span className="flex items-center gap-1"><Phone className="w-3 h-3" />{b.phone}</span>
                    <span className="flex items-center gap-1"><Mail className="w-3 h-3" />{b.email}</span>
                    <span className="flex items-center gap-1"><MapPin className="w-3 h-3" />{b.location}</span>
                    <span className="flex items-center gap-1"><Clock className="w-3 h-3" />{timeAgo(b.submittedAt)}</span>
                  </div>
                </div>
                <div className="flex flex-col gap-2">
                  {!b.calledAt && (
                    <button
                      onClick={() => markCalled(b.id)}
                      className="flex items-center gap-1.5 px-3 py-1.5 text-xs font-medium border border-blue-200 text-blue-600 rounded-lg hover:bg-blue-50 transition-colors"
                    >
                      <Phone className="w-3.5 h-3.5" /> {t("admin.markAsCalled")}
                    </button>
                  )}
                  <button
                    onClick={() => { setDetailBranch(b); setAction("deny"); }}
                    className="flex items-center gap-1.5 px-3 py-1.5 text-xs font-medium border border-red-200 text-red-600 rounded-lg hover:bg-red-50 transition-colors"
                  >
                    <XCircle className="w-3.5 h-3.5" /> {t("admin.deny")}
                  </button>
                  <button
                    disabled={!b.calledAt}
                    onClick={() => { setDetailBranch(b); setAction("approve"); }}
                    className="flex items-center gap-1.5 px-3 py-1.5 text-xs font-medium bg-blue-600 text-white rounded-lg hover:bg-blue-700 transition-colors disabled:opacity-40 disabled:cursor-not-allowed"
                    title={!b.calledAt ? t("admin.mustCallFirst") : ""}
                  >
                    <CheckCircle2 className="w-3.5 h-3.5" /> {t("admin.approveAndSendOtp")}
                  </button>
                </div>
              </div>
            </div>
          ))}
        </div>
      )}

      {processed.length > 0 && (
        <div>
          <p className="text-[10px] font-mono text-slate-400 uppercase tracking-widest mb-3">{t("admin.processed")}</p>
          <div className="space-y-2">
            {processed.map((b) => (
              <div key={b.id} className="bg-white rounded-lg border border-slate-100 px-4 py-3 flex items-center justify-between gap-4 flex-wrap">
                <div className="flex items-center gap-3">
                  <span className="font-mono text-[10px] text-slate-400">{b.id}</span>
                  <p className="text-sm font-medium text-slate-700">{b.legalName}</p>
                  <span className="text-[10px] text-slate-400">{b.location.split(",")[0]}</span>
                </div>
                <div className="flex items-center gap-2">
                  {b.status === "otp_sent" && (
                    <span className="font-mono text-xs bg-violet-50 border border-violet-200 text-violet-700 px-2 py-0.5 rounded-md">
                      {t("admin.awaitingEmailOtp")}
                    </span>
                  )}
                  <Badge status={b.status} />
                </div>
              </div>
            ))}
          </div>
        </div>
      )}

      {/* Every branch created via the organization flow -- registering a
          first branch, or an org_owner adding another one later -- read-only,
          no lock/delete/edit here; those stay on the pharmacy-flow-specific
          Branch Directory/Security pages, unchanged. */}
      {orgBranches.length > 0 && (
        <div>
          <p className="text-[10px] font-mono text-slate-400 uppercase tracking-widest mb-3">{t("admin.orgBranchesTitle")}</p>
          <div className="space-y-2">
            {orgBranches.map((b) => (
              <div key={b.id} className="bg-white rounded-lg border border-slate-100 px-4 py-3 flex items-center justify-between gap-4 flex-wrap">
                <div className="flex items-center gap-3">
                  <span className="font-mono text-[10px] text-slate-400">{b.branchCode ?? b.id.slice(0, 8)}</span>
                  <p className="text-sm font-medium text-slate-700">{b.name}</p>
                  <span className="text-[10px] text-slate-400">{b.organizationLegalName}</span>
                </div>
                <Badge status={b.status as BranchStatus} />
              </div>
            ))}
          </div>
        </div>
      )}

      {/* Approve modal */}
      {detailBranch && action === "approve" && (
        <Modal title={t("admin.approveAndSendOtp")} onClose={() => { setDetailBranch(null); setAction(null); }}>
          <div className="space-y-4">
            <p className="text-sm text-slate-600">
              {t("admin.approvePortalAccessFor")}{" "}
              <span className="font-semibold text-slate-800">{detailBranch.legalName}</span>?
            </p>
            <div className="bg-blue-50 border border-blue-200 rounded-xl p-3 space-y-1.5 text-xs">
              <p className="font-semibold text-blue-800 flex items-center gap-1.5"><Send className="w-3 h-3" /> {t("admin.whatWillHappen")}</p>
              <p className="text-blue-700">{t("admin.approveBullet1", { email: detailBranch.email })}</p>
              <p className="text-blue-700">{t("admin.approveBullet2")}</p>
              <p className="text-blue-700">{t("admin.approveBullet3")}</p>
            </div>
            <div className="flex justify-end gap-2">
              <button onClick={() => { setDetailBranch(null); setAction(null); }}
                className="px-4 py-2 text-sm border border-slate-200 text-slate-500 rounded-lg hover:bg-slate-50 transition-colors">
                {t("admin.cancel")}
              </button>
              <button onClick={handleApprove} disabled={sendingOtp}
                className="flex items-center gap-2 px-4 py-2 text-sm bg-blue-600 text-white rounded-lg hover:bg-blue-700 transition-colors disabled:opacity-60">
                {sendingOtp ? <RefreshCw className="w-3.5 h-3.5 animate-spin" /> : <Send className="w-3.5 h-3.5" />}
                {sendingOtp ? t("admin.sendingOtp") : t("admin.approveAndSendOtp")}
              </button>
            </div>
          </div>
        </Modal>
      )}

      {/* Deny modal */}
      {detailBranch && action === "deny" && (
        <Modal title={t("admin.denyApplication")} onClose={() => { setDetailBranch(null); setAction(null); setDenyReason(""); }}>
          <div className="space-y-4">
            <p className="text-sm text-slate-600">
              {t("admin.denyPortalAccessFor")}{" "}
              <span className="font-semibold text-slate-800">{detailBranch.legalName}</span>?
            </p>
            <div>
              <label className="text-xs font-semibold text-slate-600 block mb-1">{t("admin.reasonOptional")}</label>
              <textarea
                value={denyReason} onChange={(e) => setDenyReason(e.target.value)}
                rows={3} placeholder={t("admin.enterDenialReason")}
                className="w-full border border-slate-200 rounded-lg px-3 py-2 text-sm text-slate-700 resize-none focus:border-blue-400 focus:ring-1 focus:ring-blue-200 transition-colors"
              />
            </div>
            <div className="flex justify-end gap-2">
              <button onClick={() => { setDetailBranch(null); setAction(null); setDenyReason(""); }}
                className="px-4 py-2 text-sm border border-slate-200 text-slate-500 rounded-lg hover:bg-slate-50 transition-colors">
                {t("admin.cancel")}
              </button>
              <button onClick={handleDeny}
                className="flex items-center gap-2 px-4 py-2 text-sm bg-red-600 text-white rounded-lg hover:bg-red-700 transition-colors">
                <XCircle className="w-3.5 h-3.5" /> {t("admin.denyAccess")}
              </button>
            </div>
          </div>
        </Modal>
      )}
    </div>
  );
}

// ── Branches directory ────────────────────────────────────────────────────────

// One row shape both branch sources (the old pharmacy-application flow and
// the newer organization flow) can be displayed through, so the directory
// is a genuine "every branch on the platform" list instead of only ever
// showing the old flow -- which is why this tab used to look empty for an
// org-only setup: org-flow branches (add_branch_to_organization()) have no
// application row at all, so they were invisible here even though they're
// real, active branches.
type UnifiedBranchRow = {
  id: string; code: string; name: string; location: string; phone: string;
  branchCode: string | null; status: BranchStatus; failedLogins: number; org: string | null;
} & ({ kind: "application"; source: BranchRecord } | { kind: "org"; source: AllBranchRecord });

function BranchDirectory({ branches, orgBranches, adminEmail, onChange }: {
  branches: BranchRecord[]; orgBranches: AllBranchRecord[]; adminEmail: string; onChange: () => void;
}) {
  const { t } = useTranslation();
  const [filter, setFilter] = useState<BranchStatus | "all">("all");
  const [detail, setDetail] = useState<BranchRecord | null>(null);
  const [deleteTarget, setDeleteTarget] = useState<BranchRecord | null>(null);
  const [orgDetail, setOrgDetail] = useState<AllBranchRecord | null>(null);
  const [lockTarget, setLockTarget] = useState<AllBranchRecord | null>(null);
  const [releaseTarget, setReleaseTarget] = useState<AllBranchRecord | null>(null);

  const rows: UnifiedBranchRow[] = [
    ...branches.map((b): UnifiedBranchRow => ({
      kind: "application", source: b, id: b.id, code: b.applicationCode ?? b.id.slice(0, 8),
      name: b.pharmacyName, location: b.location.split(",")[0], phone: b.phone,
      branchCode: b.branchCode ?? null, status: b.status, failedLogins: b.failedLogins, org: null,
    })),
    ...orgBranches.map((b): UnifiedBranchRow => ({
      kind: "org", source: b, id: b.id, code: b.branchCode ?? b.id.slice(0, 8),
      name: b.name, location: (b.address ?? "—").split(",")[0], phone: b.phone ?? "—",
      branchCode: b.branchCode, status: b.status as BranchStatus, failedLogins: b.failedLogins,
      org: b.organizationLegalName ?? null,
    })),
  ];

  const filtered = filter === "all" ? rows : rows.filter((r) => r.status === filter);
  const { visible: shown, hasMore, showMore, shown: shownCount, total } = usePagedList(filtered, [filter]);
  const opts: (BranchStatus | "all")[] = ["all","pending","otp_sent","active","locked","denied"];

  // A full in-page view, not a popup — the eye icon drills into it the same
  // way clicking a row in any modern admin table does, with a plain CSS
  // entrance animation (index.css's .animate-fade-up, shared with the
  // marketing site) instead of a modal overlay.
  if (detail) {
    return (
      <BranchDetailView
        branch={detail}
        onBack={() => setDetail(null)}
        onDelete={() => setDeleteTarget(detail)}
        onSaved={() => { setDetail(null); onChange(); }}
      >
        {deleteTarget && (
          <DeleteBranchModal
            branch={deleteTarget}
            adminEmail={adminEmail}
            onClose={() => setDeleteTarget(null)}
            onDeleted={() => { setDeleteTarget(null); setDetail(null); onChange(); }}
          />
        )}
      </BranchDetailView>
    );
  }

  // Organization-flow branches don't have the old flow's application-based
  // detail view (no applicationCode/submittedAt/deniedReason to show) -- a
  // full page here too, same OrgBranchEditForm the Organizations tab uses,
  // so editing one reads identically no matter which tab it's reached from.
  if (orgDetail) {
    return (
      <div className="space-y-6 animate-fade-up">
        <button onClick={() => setOrgDetail(null)} className="flex items-center gap-1.5 text-xs font-semibold text-slate-500 hover:text-blue-700 transition-colors">
          <ArrowLeft className="w-3.5 h-3.5" /> {t("admin.backToBranches")}
        </button>
        <div className="flex items-center gap-3 flex-wrap">
          <h2 className="text-xl font-bold text-slate-800">{orgDetail.name}</h2>
          <Badge status={orgDetail.status as BranchStatus} />
        </div>
        {orgDetail.organizationLegalName && <p className="text-xs text-slate-400 -mt-4">{orgDetail.organizationLegalName}</p>}
        <OrgBranchEditForm branch={orgDetail} onCancel={() => setOrgDetail(null)} onSaved={() => { setOrgDetail(null); onChange(); }} />
        {lockTarget && (
          <LockOrgBranchModal branch={lockTarget} onClose={() => setLockTarget(null)} onLocked={() => { setLockTarget(null); setOrgDetail(null); onChange(); }} />
        )}
        {releaseTarget && (
          <ReleaseOrgBranchModal branch={releaseTarget} onClose={() => setReleaseTarget(null)} onReleased={() => { setReleaseTarget(null); setOrgDetail(null); onChange(); }} />
        )}
        <div className="bg-white rounded-xl border border-red-100 shadow-sm p-5 max-w-lg">
          <p className="text-sm font-bold text-slate-800">{t("admin.dangerZone")}</p>
          {orgDetail.status === "locked" ? (
            <button onClick={() => setReleaseTarget(orgDetail)}
              className="mt-3 flex items-center gap-2 border border-blue-200 text-blue-700 hover:bg-blue-50 font-semibold py-2.5 px-5 rounded-lg text-xs transition-colors">
              <Unlock className="w-3.5 h-3.5" /> {t("admin.releaseBranch")}
            </button>
          ) : (
            <button onClick={() => setLockTarget(orgDetail)}
              className="mt-3 flex items-center gap-2 border border-orange-200 text-orange-600 hover:bg-orange-50 font-semibold py-2.5 px-5 rounded-lg text-xs transition-colors">
              <Lock className="w-3.5 h-3.5" /> {t("admin.temporarilyLock")}
            </button>
          )}
        </div>
      </div>
    );
  }

  const colHeaders: TranslationKey[] = [
    "admin.colAppId", "admin.colPharmacy", "admin.colLocation", "admin.colPhone",
    "admin.colBranchCode", "admin.colOrganization", "admin.colStatus", "admin.colFailedLogins",
  ];

  return (
    <div className="space-y-6 animate-fade-up">
      <div>
        <h2 className="text-xl font-bold text-slate-800">{t("admin.branchDirectory")}</h2>
        <p className="text-xs text-slate-400 mt-0.5">{t("admin.branchesRegistered", { count: rows.length })}</p>
      </div>


      <div className="flex gap-2 flex-wrap">
        {opts.map((s) => (
          <button key={s} onClick={() => setFilter(s)}
            className={`text-[10px] font-mono uppercase tracking-widest px-3 py-1.5 rounded-lg border transition-colors ${
              filter === s
                ? "border-blue-500 text-blue-700 bg-blue-50"
                : "border-slate-200 text-slate-500 hover:border-blue-300"
            }`}>
            {s === "all" ? t("admin.statusAll") : t(statusLabelKey(s))}
          </button>
        ))}
      </div>

      <div className="bg-white rounded-xl border border-blue-100 shadow-sm overflow-hidden">
        <div className="overflow-x-auto">
          <table className="w-full text-xs">
            <thead>
              <tr className="bg-slate-50 border-b border-slate-100">
                {colHeaders.map((h) => (
                  <th key={h} className="text-left px-4 py-3 font-semibold text-slate-500 text-[10px] uppercase tracking-wide whitespace-nowrap">{t(h)}</th>
                ))}
                <th />
              </tr>
            </thead>
            <tbody className="divide-y divide-slate-50">
              {shown.map((r) => (
                <tr key={r.id} onClick={() => r.kind === "application" ? setDetail(r.source) : setOrgDetail(r.source)} className="hover:bg-blue-50/30 transition-colors cursor-pointer">
                  <td className="px-4 py-3 font-mono text-slate-400">{r.code}</td>
                  <td className="px-4 py-3 font-semibold text-slate-700 whitespace-nowrap">
                    {r.name}
                    {r.kind === "application" && <ExpiryWarning branch={r.source} />}
                  </td>
                  <td className="px-4 py-3 text-slate-500 whitespace-nowrap">{r.location}</td>
                  <td className="px-4 py-3 font-mono text-slate-500">{r.phone}</td>
                  <td className="px-4 py-3 font-mono text-blue-700 font-semibold">{r.branchCode ?? "—"}</td>
                  <td className="px-4 py-3 text-slate-500 whitespace-nowrap">{r.org ?? "—"}</td>
                  <td className="px-4 py-3"><Badge status={r.status} /></td>
                  <td className="px-4 py-3 font-mono">
                    <span className={r.failedLogins >= 5 ? "text-red-500 font-bold" : r.failedLogins >= 3 ? "text-amber-500 font-bold" : "text-slate-400"}>
                      {r.failedLogins}
                    </span>
                  </td>
                  <td className="px-4 py-3">
                    <span className="text-blue-600">
                      <Eye className="w-3.5 h-3.5" />
                    </span>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
          {filtered.length === 0 && (
            <p className="text-center py-10 text-xs text-slate-400">{t("admin.noBranchesWithStatus", { filter: filter === "all" ? t("admin.statusAll") : t(statusLabelKey(filter)) })}</p>
          )}
        </div>
        <LoadMoreButton hasMore={hasMore} shown={shownCount} total={total} onClick={showMore} />
      </div>

      <DeletedBranchesPanel />
    </div>
  );
}

// Organization-level status only has two values, unlike BranchStatus/
// TicketStatus's larger set Badge already covers -- a small dedicated
// component instead of widening that shared one for a status space it
// doesn't otherwise deal with.
function OrgStatusBadge({ status }: { status: "active" | "suspended" }) {
  const { t } = useTranslation();
  return (
    <span className={`inline-flex items-center px-2 py-0.5 rounded-md border text-[10px] font-semibold uppercase tracking-wide ${
      status === "active" ? "bg-blue-100 text-blue-700 border-blue-200" : "bg-red-100 text-red-700 border-red-200"
    }`}>
      {status === "active" ? t("admin.statusActive") : t("admin.orgStatusSuspended")}
    </span>
  );
}

// Corrects an organization's legal name / trade name / TIN -- mirrors
// EditBranchModal's existing pattern one section down. Suspend/reactivate
// stays its own dedicated action (the table row's toggle button), not
// folded in here.
// A full in-dashboard page section, not a modal -- editing an organization
// used to pop a dialog on top of the page, which read as a "dropdown," not
// a proper admin action. The caller wraps this in its own Back link/heading
// (different text depending on where it's reached from), this component is
// just the form + its own Cancel/Save row.
function OrganizationEditForm({ organization, onCancel, onSaved }: {
  organization: AdminOrganizationRecord; onCancel: () => void; onSaved: () => void;
}) {
  const { t } = useTranslation();
  const [legalName, setLegalName] = useState(organization.legalName);
  const [tradeName, setTradeName] = useState(organization.tradeName ?? "");
  const [tin, setTin] = useState(organization.tin ?? "");
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);

  async function submit() {
    if (!legalName.trim()) { setError(t("admin.editOrgNameRequired")); return; }
    setBusy(true);
    setError("");
    try {
      await adminUpdateOrganizationDetails(organization.id, { legalName, tradeName, tin });
      onSaved();
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : t("admin.editOrgSaveError"));
    } finally {
      setBusy(false);
    }
  }

  const field = "w-full border border-slate-200 rounded-lg px-3 py-2 text-sm focus:border-blue-400 focus:ring-1 focus:ring-blue-200 transition-colors";
  const label = "text-xs font-semibold text-slate-600 block mb-1";

  return (
    <div className="bg-white rounded-xl border border-blue-100 shadow-sm p-6 max-w-xl mx-auto space-y-4">
      {error && <p className="text-xs text-red-600">{error}</p>}
      <div><label className={label}>{t("admin.colOrgLegalName")}</label>
        <input value={legalName} onChange={(e) => setLegalName(e.target.value)} className={field} /></div>
      <div className="grid grid-cols-2 gap-3">
        <div><label className={label}>{t("admin.colOrgTradeName")}</label>
          <input value={tradeName} onChange={(e) => setTradeName(e.target.value)} className={field} /></div>
        <div><label className={label}>{t("admin.colOrgTin")}</label>
          <input value={tin} onChange={(e) => setTin(e.target.value)} className={field} /></div>
      </div>
      <div className="flex justify-center gap-2 pt-2">
        <button onClick={onCancel} className="px-4 py-2 text-sm border border-slate-200 text-slate-500 rounded-lg hover:bg-slate-50 transition-colors">{t("admin.cancel")}</button>
        <button onClick={() => void submit()} disabled={busy}
          className="px-4 py-2 text-sm bg-blue-600 text-white rounded-lg hover:bg-blue-700 transition-colors disabled:opacity-60">
          {busy ? t("admin.saving") : t("admin.saveChanges")}
        </button>
      </div>
    </div>
  );
}

// Edits a branch reached from an organization's detail view, or from the
// unified Branches directory -- AllBranchRecord's shape (id/name, not
// applicationCode/pharmacyName), but the same admin_update_branch_details()
// RPC underneath as EditBranchModal (old pharmacy-flow directory) uses,
// since that function updates by branch id regardless of which flow the
// branch was created through. A full page section, not a modal -- same
// reasoning as OrganizationEditForm above.
function OrgBranchEditForm({ branch, onCancel, onSaved }: {
  branch: AllBranchRecord; onCancel: () => void; onSaved: () => void;
}) {
  const { t } = useTranslation();
  const [name, setName] = useState(branch.name);
  const [phone, setPhone] = useState(branch.phone ?? "");
  const [email, setEmail] = useState(branch.email ?? "");
  const [address, setAddress] = useState(branch.address ?? "");
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);

  async function submit() {
    if (!name.trim()) { setError(t("admin.editBranchNameRequired")); return; }
    setBusy(true);
    setError("");
    try {
      await adminUpdateBranchDetails(branch.id, { name, phone, email, address });
      onSaved();
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : t("admin.editBranchSaveError"));
    } finally {
      setBusy(false);
    }
  }

  const field = "w-full border border-slate-200 rounded-lg px-3 py-2 text-sm focus:border-blue-400 focus:ring-1 focus:ring-blue-200 transition-colors";
  const label = "text-xs font-semibold text-slate-600 block mb-1";

  return (
    <div className="bg-white rounded-xl border border-blue-100 shadow-sm p-6 max-w-xl mx-auto space-y-4">
      {error && <p className="text-xs text-red-600">{error}</p>}
      <div><label className={label}>{t("admin.fieldPharmacyName")}</label>
        <input value={name} onChange={(e) => setName(e.target.value)} className={field} /></div>
      <div className="grid grid-cols-2 gap-3">
        <div><label className={label}>{t("admin.fieldPhone")}</label>
          <input value={phone} onChange={(e) => setPhone(e.target.value)} className={field} /></div>
        <div><label className={label}>{t("admin.fieldEmail")}</label>
          <input value={email} onChange={(e) => setEmail(e.target.value)} className={field} /></div>
      </div>
      <div><label className={label}>{t("admin.fieldLocation")}</label>
        <input value={address} onChange={(e) => setAddress(e.target.value)} className={field} /></div>
      <div className="flex justify-center gap-2 pt-2">
        <button onClick={onCancel} className="px-4 py-2 text-sm border border-slate-200 text-slate-500 rounded-lg hover:bg-slate-50 transition-colors">{t("admin.cancel")}</button>
        <button onClick={() => void submit()} disabled={busy}
          className="px-4 py-2 text-sm bg-blue-600 text-white rounded-lg hover:bg-blue-700 transition-colors disabled:opacity-60">
          {busy ? t("admin.saving") : t("admin.saveChanges")}
        </button>
      </div>
    </div>
  );
}

// Lock/release for a branch reached from an organization's detail view --
// until now, organization-flow branches (AllBranchRecord) had NO lock/
// unlock control anywhere in this console; the Security tab only ever
// covers branches.ts's old pharmacy-application-flow list. Same confirm-
// then-act shape as Security's own lock/release modals, just addressed at
// an AllBranchRecord instead of a BranchRecord.
function LockOrgBranchModal({ branch, onClose, onLocked }: { branch: AllBranchRecord; onClose: () => void; onLocked: () => void }) {
  const { t } = useTranslation();
  const [busy, setBusy] = useState(false);
  async function confirm() {
    setBusy(true);
    try { await setBranchLock(branch.id, true); onLocked(); } finally { setBusy(false); }
  }
  return (
    <Modal title={t("admin.lockModalTitle")} onClose={onClose}>
      <div className="space-y-4">
        <p className="text-sm text-slate-600">{t("admin.lockConfirmBody", { name: branch.name, count: branch.failedLogins })}</p>
        <div className="bg-orange-50 border border-orange-200 rounded-xl p-3 text-xs text-orange-700">{t("admin.lockConfirmNote")}</div>
        <div className="flex justify-end gap-2">
          <button onClick={onClose} className="px-4 py-2 text-sm border border-slate-200 text-slate-500 rounded-lg hover:bg-slate-50 transition-colors">{t("admin.cancel")}</button>
          <button onClick={() => void confirm()} disabled={busy} className="flex items-center gap-2 px-4 py-2 text-sm bg-orange-600 text-white rounded-lg hover:bg-orange-700 transition-colors disabled:opacity-60">
            <Lock className="w-3.5 h-3.5" /> {t("admin.lockBranchBtn")}
          </button>
        </div>
      </div>
    </Modal>
  );
}

function ReleaseOrgBranchModal({ branch, onClose, onReleased }: { branch: AllBranchRecord; onClose: () => void; onReleased: () => void }) {
  const { t } = useTranslation();
  const [busy, setBusy] = useState(false);
  async function confirm() {
    setBusy(true);
    try { await setBranchLock(branch.id, false); onReleased(); } finally { setBusy(false); }
  }
  return (
    <Modal title={t("admin.releaseModalTitle")} onClose={onClose}>
      <div className="space-y-4">
        <p className="text-sm text-slate-600">{t("admin.releaseConfirmBody", { name: branch.name })}</p>
        <div className="bg-blue-50 border border-blue-200 rounded-xl p-3 text-xs text-blue-700">{t("admin.releaseConfirmNote", { email: branch.email ?? "—" })}</div>
        <div className="flex justify-end gap-2">
          <button onClick={onClose} className="px-4 py-2 text-sm border border-slate-200 text-slate-500 rounded-lg hover:bg-slate-50 transition-colors">{t("admin.cancel")}</button>
          <button onClick={() => void confirm()} disabled={busy} className="flex items-center gap-2 px-4 py-2 text-sm bg-blue-600 text-white rounded-lg hover:bg-blue-700 transition-colors disabled:opacity-60">
            <Unlock className="w-3.5 h-3.5" /> {t("admin.releaseBranch")}
          </button>
        </div>
      </div>
    </Modal>
  );
}

// Organizations tab: every organization on the platform as a chain (branch
// count, TIN, status), with the one admin action that exists for an
// organization today -- suspend/reactivate (admin_set_organization_status(),
// mirroring admin_set_branch_lock()'s existing pattern). Branch-level detail
// for one org reuses `orgBranches` (already fetched for the Approvals tab)
// filtered by organizationId, rather than a second query.
function OrganizationsView({ organizations, orgBranches, onChange }: {
  organizations: AdminOrganizationRecord[]; orgBranches: AllBranchRecord[]; onChange: () => void;
}) {
  const { t } = useTranslation();
  const [detail, setDetail] = useState<AdminOrganizationRecord | null>(null);
  const [busyId, setBusyId] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [editingOrg, setEditingOrg] = useState(false);
  const [editingBranch, setEditingBranch] = useState<AllBranchRecord | null>(null);
  const [lockTarget, setLockTarget] = useState<AllBranchRecord | null>(null);
  const [releaseTarget, setReleaseTarget] = useState<AllBranchRecord | null>(null);

  // Keeps the open detail view in sync with the freshly-refetched
  // organizations list after an edit -- `detail` is otherwise a snapshot
  // captured at the moment its row was clicked, which would keep showing
  // the pre-edit legal name/TIN even though the save already succeeded.
  useEffect(() => {
    if (detail) {
      const fresh = organizations.find((o) => o.id === detail.id);
      if (fresh) setDetail(fresh);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [organizations]);

  async function toggleStatus(org: AdminOrganizationRecord) {
    setBusyId(org.id);
    setError(null);
    try {
      await adminSetOrganizationStatus(org.id, org.status === "active" ? "suspended" : "active");
      onChange();
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : t("admin.orgStatusError"));
    } finally {
      setBusyId(null);
    }
  }

  if (detail && editingOrg) {
    return (
      <div className="space-y-6 animate-fade-up">
        <button onClick={() => setEditingOrg(false)} className="flex items-center gap-1.5 text-xs font-semibold text-blue-600 hover:text-blue-700">
          <ArrowLeft className="w-3.5 h-3.5" /> {t("admin.backTo", { name: detail.legalName })}
        </button>
        <h2 className="text-xl font-bold text-slate-800">{t("admin.editOrgTitle", { name: detail.legalName })}</h2>
        <OrganizationEditForm organization={detail} onCancel={() => setEditingOrg(false)} onSaved={() => { setEditingOrg(false); onChange(); }} />
      </div>
    );
  }

  if (detail && editingBranch) {
    return (
      <div className="space-y-6 animate-fade-up">
        <button onClick={() => setEditingBranch(null)} className="flex items-center gap-1.5 text-xs font-semibold text-blue-600 hover:text-blue-700">
          <ArrowLeft className="w-3.5 h-3.5" /> {t("admin.backTo", { name: detail.legalName })}
        </button>
        <h2 className="text-xl font-bold text-slate-800">{t("admin.editBranchTitle", { pharmacy: editingBranch.name })}</h2>
        <OrgBranchEditForm branch={editingBranch} onCancel={() => setEditingBranch(null)} onSaved={() => { setEditingBranch(null); onChange(); }} />
      </div>
    );
  }

  if (detail) {
    const orgBranchRows = orgBranches.filter((b) => b.organizationId === detail.id);
    return (
      <div className="space-y-6 animate-fade-up">
        <button onClick={() => setDetail(null)} className="flex items-center gap-1.5 text-xs font-semibold text-blue-600 hover:text-blue-700">
          <ArrowLeft className="w-3.5 h-3.5" /> {t("admin.orgBackToList")}
        </button>
        <div className="flex items-start justify-between gap-4 flex-wrap">
          <div>
            <div className="flex items-center gap-3 flex-wrap">
              <h2 className="text-xl font-bold text-slate-800">{detail.legalName}</h2>
              <OrgStatusBadge status={detail.status} />
            </div>
            <p className="text-xs text-slate-400 mt-0.5">
              {detail.tradeName ?? "—"}{detail.tin ? ` · ${t("admin.colOrgTin")}: ${detail.tin}` : ""} · {t("admin.orgCreatedAt", { date: fmt(detail.createdAt) })}
            </p>
          </div>
          <button onClick={() => setEditingOrg(true)}
            className="flex items-center gap-1.5 text-xs font-semibold px-3 py-2 rounded-lg border border-slate-200 text-slate-600 hover:border-blue-300 hover:text-blue-700 transition-colors">
            <Pencil className="w-3.5 h-3.5" /> {t("admin.editOrgButton")}
          </button>
        </div>

        <div className="bg-white rounded-xl border border-blue-100 shadow-sm overflow-hidden">
          <div className="overflow-x-auto">
            <table className="w-full text-xs">
              <thead>
                <tr className="bg-slate-50 border-b border-slate-100">
                  {(["admin.colBranchCode", "admin.colPharmacy", "admin.colLocation", "admin.colPhone", "admin.colStatus"] as TranslationKey[]).map((h) => (
                    <th key={h} className="text-left px-4 py-3 font-semibold text-slate-500 text-[10px] uppercase tracking-wide whitespace-nowrap">{t(h)}</th>
                  ))}
                  <th />
                </tr>
              </thead>
              <tbody className="divide-y divide-slate-50">
                {orgBranchRows.map((b) => (
                  <tr key={b.id} className="hover:bg-blue-50/30 transition-colors">
                    <td className="px-4 py-3 font-mono text-blue-700 font-semibold">{b.branchCode ?? b.id.slice(0, 8)}</td>
                    <td className="px-4 py-3 font-semibold text-slate-700 whitespace-nowrap">
                      {b.name}
                      {b.failedLogins >= 3 && (
                        <span className={`ml-2 font-mono text-[10px] ${b.failedLogins >= 5 ? "text-red-500 font-bold" : "text-amber-500 font-bold"}`}>
                          {t("admin.fieldFailedLogins")}: {b.failedLogins}
                        </span>
                      )}
                    </td>
                    <td className="px-4 py-3 text-slate-500 whitespace-nowrap">{b.address ?? "—"}</td>
                    <td className="px-4 py-3 font-mono text-slate-500">{b.phone ?? "—"}</td>
                    <td className="px-4 py-3"><Badge status={b.status as BranchStatus} /></td>
                    <td className="px-4 py-3">
                      <div className="flex items-center gap-1.5 justify-end">
                        <button onClick={() => setEditingBranch(b)} title={t("admin.editBranchDetails")}
                          className="p-1.5 rounded-lg text-slate-400 hover:text-blue-700 hover:bg-blue-50 transition-colors">
                          <Pencil className="w-3.5 h-3.5" />
                        </button>
                        {b.status === "locked" ? (
                          <button onClick={() => setReleaseTarget(b)} title={t("admin.releaseBranch")}
                            className="p-1.5 rounded-lg text-slate-400 hover:text-blue-700 hover:bg-blue-50 transition-colors">
                            <Unlock className="w-3.5 h-3.5" />
                          </button>
                        ) : (
                          <button onClick={() => setLockTarget(b)} title={t("admin.temporarilyLock")}
                            className="p-1.5 rounded-lg text-slate-400 hover:text-orange-600 hover:bg-orange-50 transition-colors">
                            <Lock className="w-3.5 h-3.5" />
                          </button>
                        )}
                      </div>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
            {orgBranchRows.length === 0 && <p className="text-center py-10 text-xs text-slate-400">{t("admin.orgNoBranches")}</p>}
          </div>
        </div>

        {lockTarget && (
          <LockOrgBranchModal branch={lockTarget} onClose={() => setLockTarget(null)} onLocked={() => { setLockTarget(null); onChange(); }} />
        )}
        {releaseTarget && (
          <ReleaseOrgBranchModal branch={releaseTarget} onClose={() => setReleaseTarget(null)} onReleased={() => { setReleaseTarget(null); onChange(); }} />
        )}
      </div>
    );
  }

  return (
    <div className="space-y-6 animate-fade-up">
      <div>
        <h2 className="text-xl font-bold text-slate-800">{t("admin.orgTitle")}</h2>
        <p className="text-xs text-slate-400 mt-0.5">{t("admin.orgSubtitle", { count: organizations.length })}</p>
      </div>
      {error && <div className="rounded-xl border border-red-200 bg-red-50 px-4 py-3 text-xs text-red-700">{error}</div>}
      <div className="bg-white rounded-xl border border-blue-100 shadow-sm overflow-hidden">
        <div className="overflow-x-auto">
          <table className="w-full text-xs">
            <thead>
              <tr className="bg-slate-50 border-b border-slate-100">
                {(["admin.colOrgLegalName", "admin.colOrgTradeName", "admin.colOrgTin", "admin.colOrgBranchCount", "admin.colStatus"] as TranslationKey[]).map((h) => (
                  <th key={h} className="text-left px-4 py-3 font-semibold text-slate-500 text-[10px] uppercase tracking-wide whitespace-nowrap">{t(h)}</th>
                ))}
                <th />
              </tr>
            </thead>
            <tbody className="divide-y divide-slate-50">
              {organizations.map((o) => (
                <tr key={o.id} className="hover:bg-blue-50/30 transition-colors">
                  <td className="px-4 py-3 font-semibold text-slate-700 whitespace-nowrap cursor-pointer" onClick={() => setDetail(o)}>{o.legalName}</td>
                  <td className="px-4 py-3 text-slate-500 whitespace-nowrap">{o.tradeName ?? "—"}</td>
                  <td className="px-4 py-3 font-mono text-slate-500">{o.tin ?? "—"}</td>
                  <td className="px-4 py-3 font-mono text-slate-700 cursor-pointer" onClick={() => setDetail(o)}>{o.branchCount}</td>
                  <td className="px-4 py-3"><OrgStatusBadge status={o.status} /></td>
                  <td className="px-4 py-3">
                    <button
                      onClick={() => void toggleStatus(o)}
                      disabled={busyId === o.id}
                      className={`text-[10px] font-semibold uppercase tracking-wide px-2.5 py-1 rounded-lg border transition-colors disabled:opacity-50 ${
                        o.status === "active" ? "border-red-200 text-red-600 hover:bg-red-50" : "border-blue-200 text-blue-600 hover:bg-blue-50"
                      }`}
                    >
                      {busyId === o.id ? t("admin.orgStatusUpdating") : o.status === "active" ? t("admin.orgSuspend") : t("admin.orgReactivate")}
                    </button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
          {organizations.length === 0 && <p className="text-center py-10 text-xs text-slate-400">{t("admin.orgEmpty")}</p>}
        </div>
      </div>
    </div>
  );
}

// Log left behind by admin_delete_branch() -- who/what/when, not a way to
// bring the branch back (its actual data really is gone). Collapsed and
// lazily fetched: an admin who never deletes anything should never pay for
// this query on every visit to the branches tab.
function DeletedBranchesPanel() {
  const { t } = useTranslation();
  const [open, setOpen] = useState(false);
  const [rows, setRows] = useState<DeletedBranchRecord[] | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState("");

  async function toggle() {
    const next = !open;
    setOpen(next);
    if (next && rows === null) {
      setLoading(true);
      setError("");
      try {
        setRows(await listDeletedBranches());
      } catch (reason) {
        setError(reason instanceof Error ? reason.message : t("admin.deletedBranchesLoadError"));
      } finally {
        setLoading(false);
      }
    }
  }

  const all = rows ?? [];
  const { visible: paged, hasMore, showMore, shown, total } = usePagedList(all, []);

  return (
    <div className="bg-white rounded-xl border border-slate-200 shadow-sm overflow-hidden">
      <button onClick={() => void toggle()}
        className="w-full flex items-center justify-between gap-3 px-4 py-3 text-left hover:bg-slate-50 transition-colors">
        <span className="text-sm font-semibold text-slate-600">{t("admin.deletedBranchesTitle")}</span>
        <ChevronRight className={`w-4 h-4 text-slate-400 transition-transform ${open ? "rotate-90" : ""}`} />
      </button>
      {open && (
        <div className="border-t border-slate-100">
          {error && <div className="bg-red-50 border-b border-red-200 text-red-700 text-xs px-4 py-2">{error}</div>}
          {loading ? (
            <p className="text-center py-8 text-xs text-slate-400">{t("admin.loading")}</p>
          ) : all.length === 0 ? (
            <p className="text-center py-8 text-xs text-slate-400">{t("admin.deletedBranchesEmpty")}</p>
          ) : (
            <div className="overflow-x-auto">
              <table className="w-full text-xs">
                <thead>
                  <tr className="bg-slate-50 border-b border-slate-100">
                    {[t("admin.colPharmacy"), t("admin.colEmail"), t("admin.colPhone"), t("admin.colBranchCode"), t("admin.deletedBranchesReasonCol"), t("admin.deletedBranchesByCol"), t("admin.deletedBranchesWhenCol")].map((h) => (
                      <th key={h} className="text-left px-4 py-2.5 font-semibold text-slate-500 text-[10px] uppercase tracking-wide whitespace-nowrap">{h}</th>
                    ))}
                  </tr>
                </thead>
                <tbody className="divide-y divide-slate-50">
                  {paged.map((r) => (
                    <tr key={r.id}>
                      <td className="px-4 py-2.5 font-semibold text-slate-700 whitespace-nowrap">{r.pharmacyName}</td>
                      <td className="px-4 py-2.5 text-slate-500">{r.email ?? "—"}</td>
                      <td className="px-4 py-2.5 font-mono text-slate-500">{r.phone ?? "—"}</td>
                      <td className="px-4 py-2.5 font-mono text-slate-500">{r.branchCode ?? "—"}</td>
                      <td className="px-4 py-2.5 text-slate-500 max-w-xs truncate">{r.reason ?? "—"}</td>
                      <td className="px-4 py-2.5 text-slate-500">{r.deletedByEmail ?? "—"}</td>
                      <td className="px-4 py-2.5 text-slate-400 whitespace-nowrap">{fmt(r.deletedAt)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
              <LoadMoreButton hasMore={hasMore} shown={shown} total={total} onClick={showMore} />
            </div>
          )}
        </div>
      )}
    </div>
  );
}

// Full-page branch detail — replaces the directory table in place (same nav
// tab, same scroll container) with a smooth fade/slide-up entrance, instead
// of interrupting the page with a popup.
// How long a pending registration has before it is deleted. Silent until
// there are two days left, then it counts down -- an approval queue that
// nags from day one is one people learn to ignore.
function ExpiryWarning({ branch }: { branch: BranchRecord }) {
  const { t } = useTranslation();
  if (branch.status !== "pending") return null;
  const daysLeft = applicationDaysLeft(branch.submittedAt);
  if (daysLeft > 2) return null;
  const urgent = daysLeft <= 1;
  return (
    <span className={`ml-2 inline-block text-[9px] font-bold uppercase tracking-wide px-1.5 py-0.5 rounded ${
      urgent ? "bg-red-50 text-red-600" : "bg-amber-50 text-amber-700"
    }`}>
      {daysLeft <= 0 ? t("admin.expiryToday") : t("admin.expiryDaysLeft", { count: daysLeft })}
    </span>
  );
}

function EditBranchModal({ branch, onClose, onSaved }: {
  branch: BranchRecord; onClose: () => void; onSaved: () => void;
}) {
  const { t } = useTranslation();
  const [name, setName] = useState(branch.pharmacyName);
  const [phone, setPhone] = useState(branch.phone);
  const [email, setEmail] = useState(branch.email);
  const [address, setAddress] = useState(branch.location);
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);

  async function submit() {
    if (!name.trim()) { setError(t("admin.editBranchNameRequired")); return; }
    setBusy(true);
    setError("");
    try {
      await adminUpdateBranchDetails(branch.branchId!, { name, phone, email, address });
      onSaved();
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : t("admin.editBranchSaveError"));
    } finally {
      setBusy(false);
    }
  }

  const field = "w-full border border-slate-200 rounded-lg px-3 py-2 text-sm focus:border-blue-400 focus:ring-1 focus:ring-blue-200 transition-colors";
  const label = "text-xs font-semibold text-slate-600 block mb-1";

  return (
    <Modal title={t("admin.editBranchTitle", { pharmacy: branch.pharmacyName })} onClose={onClose}>
      <div className="space-y-3">
        <p className="text-xs text-slate-400">{t("admin.editBranchIntro")}</p>
        {error && <p className="text-xs text-red-600">{error}</p>}
        <div><label className={label}>{t("admin.fieldPharmacyName")}</label>
          <input value={name} onChange={(e) => setName(e.target.value)} className={field} /></div>
        <div><label className={label}>{t("admin.fieldPhone")}</label>
          <input value={phone} onChange={(e) => setPhone(e.target.value)} className={field} /></div>
        <div><label className={label}>{t("admin.fieldEmail")}</label>
          <input value={email} onChange={(e) => setEmail(e.target.value)} className={field} /></div>
        <div><label className={label}>{t("admin.fieldLocation")}</label>
          <input value={address} onChange={(e) => setAddress(e.target.value)} className={field} /></div>
        <div className="flex justify-end gap-2 pt-2">
          <button onClick={onClose} className="px-4 py-2 text-sm border border-slate-200 text-slate-500 rounded-lg hover:bg-slate-50 transition-colors">{t("admin.cancel")}</button>
          <button onClick={() => void submit()} disabled={busy}
            className="px-4 py-2 text-sm bg-blue-600 text-white rounded-lg hover:bg-blue-700 transition-colors disabled:opacity-60">
            {busy ? t("admin.saving") : t("admin.saveChanges")}
          </button>
        </div>
      </div>
    </Modal>
  );
}

function BranchDetailView({
  branch, onBack, onDelete, onSaved, children,
}: {
  branch: BranchRecord; onBack: () => void; onDelete: () => void; onSaved: () => void; children: React.ReactNode;
}) {
  const { t } = useTranslation();
  const [resending, setResending] = useState(false);
  const [editing, setEditing] = useState(false);
  const [resendResult, setResendResult] = useState<{ ok: boolean; message: string } | null>(null);

  async function resend() {
    setResending(true);
    setResendResult(null);
    try {
      await requestPharmacyOtp(branch.email);
      setResendResult({ ok: true, message: t("admin.resendSentTo", { email: branch.email }) });
    } catch (reason) {
      setResendResult({ ok: false, message: reason instanceof Error ? reason.message : t("admin.resendFailed") });
    } finally {
      setResending(false);
    }
  }

  return (
    <div className="space-y-6 animate-fade-up">
      <button onClick={onBack}
        className="flex items-center gap-1.5 text-xs font-semibold text-slate-500 hover:text-blue-700 transition-colors">
        <ArrowLeft className="w-3.5 h-3.5" /> {t("admin.backToBranches")}
      </button>

      <div className="flex items-start justify-between gap-4 flex-wrap">
        <div>
          <div className="flex items-center gap-3 flex-wrap">
            <h2 className="text-2xl font-bold text-slate-800">{branch.pharmacyName}</h2>
            <Badge status={branch.status} />
          </div>
          <p className="text-xs text-slate-400 mt-1 font-mono">{branch.applicationCode ?? branch.id}</p>
        </div>
        {/* Only once a branch row actually exists -- a pending application has
            no branch to edit yet, it is still just a form someone submitted. */}
        {branch.branchId && (
          <button onClick={() => setEditing(true)}
            className="flex items-center gap-1.5 text-xs font-semibold px-3 py-2 rounded-lg border border-slate-200 text-slate-600 hover:border-blue-300 hover:text-blue-700 transition-colors">
            {t("admin.editBranchDetails")}
          </button>
        )}
      </div>

      {editing && branch.branchId && (
        <EditBranchModal branch={branch} onClose={() => setEditing(false)} onSaved={() => { setEditing(false); onSaved(); }} />
      )}

      <div className="grid sm:grid-cols-2 lg:grid-cols-4 gap-4">
        {[
          { label: t("admin.fieldPhone"), value: branch.phone, mono: true, icon: <Phone className="w-3.5 h-3.5" /> },
          { label: t("admin.fieldEmail"), value: branch.email, mono: true, icon: <Mail className="w-3.5 h-3.5" /> },
          { label: t("admin.fieldLocation"), value: branch.location, icon: <MapPin className="w-3.5 h-3.5" /> },
          { label: t("admin.fieldFailedLogins"), value: branch.failedLogins, icon: <AlertTriangle className="w-3.5 h-3.5" /> },
          { label: t("admin.fieldBranchCode"), value: branch.branchCode ?? "—", mono: true, icon: <Building2 className="w-3.5 h-3.5" /> },
          { label: t("admin.fieldActivationCode"), value: branch.activationCode ?? "—", mono: true, icon: <KeyRound className="w-3.5 h-3.5" /> },
        ].map((row, i) => (
          <div key={i} className="bg-white rounded-xl border border-blue-100 shadow-sm p-4"
            style={{ animation: `fadeUp 0.4s cubic-bezier(.22,.68,0,1.2) both`, animationDelay: `${i * 0.04}s` }}>
            <div className="flex items-center gap-1.5 text-slate-400 mb-2">
              {row.icon}
              <p className="text-[10px] font-mono uppercase tracking-wide">{row.label}</p>
            </div>
            <p className={`text-slate-700 text-sm font-semibold ${row.mono ? "font-mono" : ""} break-all`}>{row.value}</p>
          </div>
        ))}
      </div>

      {branch.status === "otp_sent" && (
        <div className="bg-violet-50 border border-violet-200 rounded-xl p-4">
          <p className="text-xs text-violet-700 mb-3">{t("admin.otpSentNotice")}</p>
          <button onClick={() => void resend()} disabled={resending}
            className="flex items-center gap-1.5 text-xs font-semibold px-3 py-2 rounded-lg border border-violet-300 text-violet-700 hover:bg-violet-100 transition-colors disabled:opacity-60">
            {resending ? <RefreshCw className="w-3.5 h-3.5 animate-spin" /> : <Send className="w-3.5 h-3.5" />}
            {resending ? t("admin.resending") : t("admin.resendActivationEmail")}
          </button>
          {resendResult && (
            <p className={`text-xs mt-2 ${resendResult.ok ? "text-violet-700" : "text-red-600 font-semibold"}`}>
              {resendResult.ok ? "✓ " : "✕ "}{resendResult.message}
            </p>
          )}
        </div>
      )}
      {branch.deniedReason && (
        <div className="bg-red-50 border border-red-200 rounded-xl p-4">
          <p className="text-xs font-semibold text-red-700 mb-0.5">{t("admin.denialReasonLabel")}</p>
          <p className="text-xs text-red-600">{branch.deniedReason}</p>
        </div>
      )}

      {branch.branchId && (
        <div className="bg-white rounded-xl border border-red-100 shadow-sm p-5">
          <p className="text-sm font-bold text-slate-800">{t("admin.dangerZone")}</p>
          <p className="text-xs text-slate-500 mt-1 mb-4">
            {t("admin.dangerZoneBody")}
          </p>
          <button
            onClick={onDelete}
            className="flex items-center justify-center gap-2 border border-red-200 text-red-600 hover:bg-red-50 font-semibold py-2.5 px-5 rounded-lg text-xs transition-colors"
          >
            <Trash2 className="w-3.5 h-3.5" /> {t("admin.deleteThisBranch")}
          </button>
        </div>
      )}

      {children}
    </div>
  );
}

// Destructive step-up flow: deleting a branch wipes every row it owns
// (admin_delete_branch in the schema), so it isn't gated by the admin's
// existing session alone — they have to re-enter their email and a fresh
// emailed OTP right here, immediately before the delete fires. The RPC
// itself still re-checks assert_super_admin() regardless; this is a human
// confirmation gate on top of that, not a substitute for it.
function DeleteBranchModal({
  branch, adminEmail, onClose, onDeleted,
}: {
  branch: BranchRecord; adminEmail: string; onClose: () => void; onDeleted: () => void;
}) {
  const { t } = useTranslation();
  const [step, setStep] = useState<"warn" | "email" | "otp">("warn");
  const [reason, setReason] = useState("");
  const [email, setEmail] = useState(adminEmail);
  const [otp, setOtp] = useState(["", "", "", "", "", ""]);
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);

  async function sendCode() {
    if (!email.trim()) { setError(t("admin.enterEmailError")); return; }
    setBusy(true);
    setError("");
    try {
      await requestAdminOtp(email.trim());
      setStep("otp");
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : t("admin.couldNotSendCode"));
    } finally {
      setBusy(false);
    }
  }

  async function confirmDelete() {
    const token = otp.join("");
    if (token.length < 6) { setError(t("admin.enterFullCodeError")); return; }
    setBusy(true);
    setError("");
    try {
      await verifyAdminOtp(email.trim(), token);
      await deleteBranch(branch.branchId!, reason);
      onDeleted();
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : t("admin.couldNotDelete"));
    } finally {
      setBusy(false);
    }
  }

  function setDigit(i: number, v: string) {
    if (!/^[0-9]?$/.test(v)) return;
    const next = [...otp]; next[i] = v; setOtp(next); setError("");
    if (v && i < 5) document.getElementById(`del-otp-${i + 1}`)?.focus();
  }

  return (
    <Modal title={t("admin.deleteBranchModalTitle")} onClose={onClose}>
      {step === "warn" && (
        <div className="space-y-4">
          <div className="bg-red-50 border border-red-200 rounded-lg p-3 flex gap-2">
            <AlertTriangle className="w-4 h-4 text-red-500 shrink-0 mt-0.5" />
            <p className="text-xs text-red-700">
              {t("admin.deleteWarnBody", { name: branch.pharmacyName })}
            </p>
          </div>
          <p className="text-xs text-slate-500">
            {t("admin.deleteWarnNote")}
          </p>
          <div>
            <label className="text-xs font-semibold text-slate-600 block mb-1">{t("admin.deleteReasonLabel")}</label>
            <textarea
              value={reason} onChange={(e) => setReason(e.target.value)} rows={2}
              placeholder={t("admin.deleteReasonPlaceholder")}
              className="w-full border border-slate-200 rounded-lg px-3 py-2 text-sm focus:border-red-400 focus:ring-1 focus:ring-red-200 transition-colors resize-none"
            />
          </div>
          <div className="flex gap-2">
            <button onClick={onClose} className="flex-1 py-2.5 rounded-lg text-xs font-semibold border border-slate-200 text-slate-600 hover:bg-slate-50 transition-colors">
              {t("admin.cancel")}
            </button>
            <button onClick={() => setStep("email")} className="flex-1 flex items-center justify-center gap-1.5 py-2.5 rounded-lg text-xs font-semibold bg-red-600 text-white hover:bg-red-700 transition-colors">
              <Trash2 className="w-3.5 h-3.5" /> {t("admin.continue")}
            </button>
          </div>
        </div>
      )}

      {step === "email" && (
        <div className="space-y-3">
          <p className="text-xs text-slate-500">{t("admin.reenterEmailPrompt")}</p>
          <input
            type="email" value={email} onChange={(e) => { setEmail(e.target.value); setError(""); }}
            placeholder={t("admin.adminEmailPlaceholder")}
            className="w-full border border-slate-200 rounded-lg px-3 py-2.5 text-sm focus:border-red-400 focus:ring-1 focus:ring-red-200 transition-colors"
          />
          {error && <p className="text-xs text-red-600">{error}</p>}
          <button onClick={() => void sendCode()} disabled={busy}
            className="w-full flex items-center justify-center gap-2 px-4 py-2.5 text-sm bg-red-600 text-white rounded-lg hover:bg-red-700 transition-colors disabled:opacity-60">
            {busy ? <RefreshCw className="w-3.5 h-3.5 animate-spin" /> : <KeyRound className="w-3.5 h-3.5" />}
            {busy ? t("admin.sending") : t("admin.sendVerificationCode")}
          </button>
        </div>
      )}

      {step === "otp" && (
        <div className="space-y-3">
          <p className="text-xs text-slate-500">{t("admin.enterCodeToDelete", { email })}</p>
          <div className="flex gap-2 justify-between">
            {otp.map((digit, i) => (
              <input
                key={i} id={`del-otp-${i}`} value={digit} maxLength={1} inputMode="numeric"
                onChange={(e) => setDigit(i, e.target.value)}
                onKeyDown={(e) => { if (e.key === "Backspace" && !otp[i] && i > 0) document.getElementById(`del-otp-${i - 1}`)?.focus(); }}
                className="w-10 h-12 text-center text-lg font-bold border border-slate-200 rounded-lg focus:border-red-400 focus:ring-1 focus:ring-red-200 transition-colors"
              />
            ))}
          </div>
          {error && <p className="text-xs text-red-600">{error}</p>}
          <button onClick={() => void confirmDelete()} disabled={busy}
            className="w-full flex items-center justify-center gap-2 px-4 py-2.5 text-sm bg-red-600 text-white rounded-lg hover:bg-red-700 transition-colors disabled:opacity-60">
            {busy ? <RefreshCw className="w-3.5 h-3.5 animate-spin" /> : <Trash2 className="w-3.5 h-3.5" />}
            {busy ? t("admin.deleting") : t("admin.verifyAndDelete")}
          </button>
        </div>
      )}
    </Modal>
  );
}

// ── Security ──────────────────────────────────────────────────────────────────

function Security({ branches, onChange }: { branches: BranchRecord[]; onChange: () => void }) {
  const { t } = useTranslation();
  const [confirmLock, setConfirmLock]       = useState<BranchRecord | null>(null);
  const [confirmRelease, setConfirmRelease] = useState<BranchRecord | null>(null);

  const highRisk = branches.filter((b) => b.failedLogins >= 5 && b.status !== "locked" && b.status === "active");
  const locked   = branches.filter((b) => b.status === "locked");

  async function lock(record: BranchRecord) {
    if (!record.branchId) return;
    await setBranchLock(record.branchId, true);
    setConfirmLock(null);
    onChange();
  }

  async function release(record: BranchRecord) {
    if (!record.branchId) return;
    await setBranchLock(record.branchId, false);
    setConfirmRelease(null);
    onChange();
  }

  return (
    <div className="space-y-6">
      <div>
        <h2 className="text-xl font-bold text-slate-800">{t("admin.securityManagement")}</h2>
        <p className="text-xs text-slate-400 mt-0.5">{t("admin.securitySubtitle")}</p>
      </div>

      {highRisk.length > 0 && (
        <div className="space-y-3">
          <div className="flex items-center gap-2">
            <AlertTriangle className="w-4 h-4 text-amber-500" />
            <p className="text-sm font-semibold text-amber-700">{t("admin.highRiskBranches", { count: highRisk.length })}</p>
          </div>
          {highRisk.map((b) => (
            <div key={b.id} className="bg-white border border-amber-200 rounded-xl p-4 flex items-start justify-between gap-4 flex-wrap shadow-sm">
              <div>
                <div className="flex items-center gap-2 mb-1">
                  <span className="font-mono text-[10px] text-slate-400">{b.id}</span>
                  <Badge status={b.status} />
                </div>
                <p className="font-bold text-slate-800">{b.pharmacyName}</p>
                <p className="text-xs text-slate-500 mt-0.5">{b.email}</p>
                <p className="text-xs text-amber-600 font-semibold mt-1 flex items-center gap-1">
                  <AlertTriangle className="w-3 h-3" /> {t("admin.failedLoginAttemptsCount", { count: b.failedLogins })}
                </p>
              </div>
              <button onClick={() => setConfirmLock(b)}
                className="flex items-center gap-1.5 px-3 py-1.5 text-xs font-medium border border-orange-300 text-orange-600 rounded-lg hover:bg-orange-50 transition-colors">
                <Lock className="w-3.5 h-3.5" /> {t("admin.temporarilyLock")}
              </button>
            </div>
          ))}
        </div>
      )}

      <div className="space-y-3">
        <div className="flex items-center gap-2">
          <Lock className="w-4 h-4 text-orange-500" />
          <p className="text-sm font-semibold text-slate-700">{t("admin.lockedBranchesCount", { count: locked.length })}</p>
        </div>
        {locked.length === 0 ? (
          <div className="bg-white rounded-xl border border-blue-100 p-10 text-center">
            <ShieldAlert className="w-8 h-8 text-blue-300 mx-auto mb-2" />
            <p className="text-xs text-slate-400">{t("admin.noBranchesLocked")}</p>
          </div>
        ) : (
          locked.map((b) => (
            <div key={b.id} className="bg-white border border-orange-200 rounded-xl p-4 shadow-sm">
              <div className="flex items-start justify-between gap-4 flex-wrap">
                <div>
                  <div className="flex items-center gap-2 mb-1">
                    <span className="font-mono text-[10px] text-slate-400">{b.id}</span>
                    <Badge status="locked" />
                  </div>
                  <p className="font-bold text-slate-800">{b.pharmacyName}</p>
                  <p className="text-xs text-slate-500">{b.email}</p>
                  <div className="mt-2 space-y-0.5">
                    <p className="text-[11px] text-orange-600 font-mono">{t("admin.lockedAtLabel", { date: b.lockedAt ? fmt(b.lockedAt) : "—" })}</p>
                    <p className="text-[11px] text-slate-400 font-mono">{t("admin.failedLoginsLabel", { count: b.failedLogins })}</p>
                  </div>
                  <div className="mt-2 bg-orange-50 border border-orange-100 rounded-lg px-3 py-2">
                    <p className="text-[10px] text-orange-600 font-mono italic">
                      {t("admin.suspendedQuote")}
                    </p>
                  </div>
                </div>
                <button onClick={() => setConfirmRelease(b)}
                  className="flex items-center gap-1.5 px-3 py-1.5 text-xs font-medium border border-blue-300 text-blue-700 rounded-lg hover:bg-blue-50 transition-colors">
                  <Unlock className="w-3.5 h-3.5" /> {t("admin.releaseBranch")}
                </button>
              </div>
            </div>
          ))
        )}
      </div>

      {confirmLock && (
        <Modal title={t("admin.lockModalTitle")} onClose={() => setConfirmLock(null)}>
          <div className="space-y-4">
            <p className="text-sm text-slate-600">
              {t("admin.lockConfirmBody", { name: confirmLock.pharmacyName, count: confirmLock.failedLogins })}
            </p>
            <div className="bg-orange-50 border border-orange-200 rounded-xl p-3 text-xs text-orange-700">
              {t("admin.lockConfirmNote")}
            </div>
            <div className="flex justify-end gap-2">
              <button onClick={() => setConfirmLock(null)} className="px-4 py-2 text-sm border border-slate-200 text-slate-500 rounded-lg hover:bg-slate-50 transition-colors">{t("admin.cancel")}</button>
              <button onClick={() => void lock(confirmLock)} className="flex items-center gap-2 px-4 py-2 text-sm bg-orange-600 text-white rounded-lg hover:bg-orange-700 transition-colors">
                <Lock className="w-3.5 h-3.5" /> {t("admin.lockBranchBtn")}
              </button>
            </div>
          </div>
        </Modal>
      )}

      {confirmRelease && (
        <Modal title={t("admin.releaseModalTitle")} onClose={() => setConfirmRelease(null)}>
          <div className="space-y-4">
            <p className="text-sm text-slate-600">
              {t("admin.releaseConfirmBody", { name: confirmRelease.pharmacyName })}
            </p>
            <div className="bg-blue-50 border border-blue-200 rounded-xl p-3 text-xs text-blue-700">
              {t("admin.releaseConfirmNote", { email: confirmRelease.email })}
            </div>
            <div className="flex justify-end gap-2">
              <button onClick={() => setConfirmRelease(null)} className="px-4 py-2 text-sm border border-slate-200 text-slate-500 rounded-lg hover:bg-slate-50 transition-colors">{t("admin.cancel")}</button>
              <button onClick={() => void release(confirmRelease)} className="flex items-center gap-2 px-4 py-2 text-sm bg-blue-600 text-white rounded-lg hover:bg-blue-700 transition-colors">
                <Unlock className="w-3.5 h-3.5" /> {t("admin.releaseBranch")}
              </button>
            </div>
          </div>
        </Modal>
      )}
    </div>
  );
}

// ── Tickets ───────────────────────────────────────────────────────────────────

function TicketsView({ tickets, onChange }: { tickets: AdminTicketRow[]; onChange: () => void }) {
  const { t } = useTranslation();
  const [detail, setDetail] = useState<AdminTicketRow | null>(null);
  const [updating, setUpdating] = useState(false);

  const priorityOrder = { high: 0, medium: 1, low: 2 };
  const sorted = [...tickets].sort((a, b) => priorityOrder[a.priority] - priorityOrder[b.priority]);
  const { visible: paged, hasMore, showMore, shown, total } = usePagedList(sorted, []);

  async function updateStatus(id: string, status: TicketStatus) {
    setUpdating(true);
    try {
      await adminUpdateTicketStatus(id, status);
      onChange();
      if (detail?.id === id) setDetail((p) => p ? { ...p, status } : p);
    } catch (reason) {
      window.alert(reason instanceof Error ? reason.message : "Could not update this ticket.");
    } finally {
      setUpdating(false);
    }
  }

  const priorityStyles = {
    high:   "bg-red-100 text-red-700 border-red-200",
    medium: "bg-amber-100 text-amber-700 border-amber-200",
    low:    "bg-slate-100 text-slate-600 border-slate-200",
  };
  const priorityLabelKey: Record<AdminTicketRow["priority"], TranslationKey> = {
    high: "admin.priorityHigh", medium: "admin.priorityMedium", low: "admin.priorityLow",
  };

  const open = tickets.filter((tk) => tk.status === "open").length;

  return (
    <div className="space-y-6">
      <div>
        <h2 className="text-xl font-bold text-slate-800">{t("admin.supportTickets")}</h2>
        <p className="text-xs text-slate-400 mt-0.5">{t("admin.openInProgressSummary", { open, inProgress: tickets.filter((tk) => tk.status === "in_progress").length })}</p>
      </div>

      {open > 0 && (
        <div className="bg-red-50 border border-red-200 rounded-xl p-4 flex items-center gap-3">
          <Bell className="w-5 h-5 text-red-500 shrink-0" />
          <p className="text-sm text-red-700">
            <span className="font-semibold">{t(open > 1 ? "admin.openTicketsRequireAttentionPlural" : "admin.openTicketsRequireAttentionSingular", { count: open })}</span>
          </p>
        </div>
      )}

      <div className="space-y-3">
        {paged.map((tk) => (
          <div key={tk.id} onClick={() => setDetail(tk)}
            className="bg-white rounded-xl border border-blue-100 shadow-sm p-4 cursor-pointer hover:border-blue-300 transition-colors">
            <div className="flex items-start justify-between gap-4 flex-wrap">
              <div className="flex-1 min-w-0">
                <div className="flex items-center gap-2 flex-wrap mb-1">
                  <span className="font-mono text-[10px] text-slate-400">{tk.id}</span>
                  <Badge status={tk.status} />
                  <span className={`text-[10px] font-semibold uppercase tracking-wide px-2 py-0.5 rounded-md border ${priorityStyles[tk.priority]}`}>
                    {t(priorityLabelKey[tk.priority])}
                  </span>
                </div>
                <p className="font-bold text-slate-800 truncate">{tk.subject}</p>
                <p className="text-xs text-slate-500 mt-0.5">{tk.branch_name} · {tk.raised_by_name} · {timeAgo(tk.created_at)}</p>
                <p className="text-xs text-slate-400 mt-1.5 line-clamp-1">{tk.description}</p>
              </div>
              <ChevronRight className="w-4 h-4 text-slate-300 shrink-0 mt-1" />
            </div>
          </div>
        ))}
        {sorted.length === 0 && (
          <div className="bg-white rounded-xl border border-blue-100 p-12 text-center">
            <Ticket className="w-8 h-8 text-blue-300 mx-auto mb-2" />
            <p className="text-xs text-slate-400">{t("admin.noSupportTickets")}</p>
          </div>
        )}
        <LoadMoreButton hasMore={hasMore} shown={shown} total={total} onClick={showMore} />
      </div>

      {detail && (
        <Modal title={t("admin.ticketModalTitle", { id: detail.id })} onClose={() => setDetail(null)}>
          <div className="space-y-4">
            <div className="flex items-center gap-2 flex-wrap">
              <Badge status={detail.status} />
              <span className={`text-[10px] font-semibold uppercase tracking-wide px-2 py-0.5 rounded-md border ${
                { high: "bg-red-100 text-red-700 border-red-200", medium: "bg-amber-100 text-amber-700 border-amber-200", low: "bg-slate-100 text-slate-600 border-slate-200" }[detail.priority]
              }`}>{t(priorityLabelKey[detail.priority])}</span>
              <span className="font-mono text-[10px] text-slate-400">{fmt(detail.created_at)}</span>
            </div>
            <div>
              <p className="font-bold text-slate-800">{detail.subject}</p>
              <p className="text-xs text-blue-700 font-semibold mt-0.5">{detail.branch_name} · {detail.raised_by_name}</p>
            </div>
            <div className="bg-slate-50 border border-slate-200 rounded-xl p-3">
              <p className="text-xs text-slate-600 leading-relaxed">{detail.description || "—"}</p>
            </div>
            <div>
              <label className="text-[10px] font-mono uppercase tracking-widest text-slate-400 block mb-2">{t("admin.updateStatus")}</label>
              <div className="flex gap-2 flex-wrap">
                {(["open","in_progress","resolved","closed"] as TicketStatus[]).map((s) => (
                  <button key={s} disabled={updating} onClick={() => void updateStatus(detail.id, s)}
                    className={`px-3 py-1.5 text-xs font-semibold rounded-lg border transition-colors disabled:opacity-50 ${
                      detail.status === s
                        ? "border-blue-500 bg-blue-50 text-blue-700"
                        : "border-slate-200 text-slate-500 hover:border-blue-300"
                    }`}>
                    {t(statusLabelKey(s))}
                  </button>
                ))}
              </div>
            </div>
          </div>
        </Modal>
      )}
    </div>
  );
}

// ── Products & Tax ───────────────────────────────────────────────────────────
// Products are super-admin managed only -- branches can no longer create one
// while receiving stock (see StockReceivingPage.tsx / product_requests
// below). Tax is set here, per product, never per category, and defaults to
// Exempt (0%) until an admin changes it.

function VariantRow({ variant, onChange, onRemove, canRemove }: {
  variant: ProductVariantInput; onChange: (v: ProductVariantInput) => void; onRemove: () => void; canRemove: boolean;
}) {
  const { t } = useTranslation();
  return (
    <div className="flex items-center gap-2">
      <input value={variant.dosage ?? ""} onChange={(e) => onChange({ ...variant, dosage: e.target.value })}
        placeholder={t("admin.dosagePlaceholder")}
        className="flex-1 border border-slate-200 rounded-lg px-2.5 py-1.5 text-xs focus:border-blue-400 focus:ring-1 focus:ring-blue-200 transition-colors" />
      <input value={variant.form ?? ""} onChange={(e) => onChange({ ...variant, form: e.target.value })}
        placeholder={t("admin.formPlaceholder")}
        className="flex-1 border border-slate-200 rounded-lg px-2.5 py-1.5 text-xs focus:border-blue-400 focus:ring-1 focus:ring-blue-200 transition-colors" />
      <input value={variant.unit ?? ""} onChange={(e) => onChange({ ...variant, unit: e.target.value })}
        placeholder={t("admin.unitPlaceholder")}
        className="flex-1 border border-slate-200 rounded-lg px-2.5 py-1.5 text-xs focus:border-blue-400 focus:ring-1 focus:ring-blue-200 transition-colors" />
      {canRemove && (
        <button type="button" onClick={onRemove} className="text-slate-400 hover:text-red-600 transition-colors shrink-0">
          <X className="w-3.5 h-3.5" />
        </button>
      )}
    </div>
  );
}

function VariantEditor({ variants, onChange }: { variants: ProductVariantInput[]; onChange: (v: ProductVariantInput[]) => void }) {
  const { t } = useTranslation();
  return (
    <div className="space-y-2">
      <label className="text-xs font-semibold text-slate-600 block">{t("admin.variants")}</label>
      {variants.map((variant, i) => (
        <VariantRow key={i} variant={variant}
          onChange={(v) => onChange(variants.map((item, idx) => (idx === i ? v : item)))}
          onRemove={() => onChange(variants.filter((_, idx) => idx !== i))}
          canRemove={variants.length > 1}
        />
      ))}
      <button type="button" onClick={() => onChange([...variants, {}])}
        className="text-xs font-semibold text-blue-700 hover:text-blue-800 transition-colors">+ {t("admin.addVariant")}</button>
    </div>
  );
}

function AddProductModal({ taxRates, onClose, onCreated }: { taxRates: TaxRate[]; onClose: () => void; onCreated: () => void }) {
  const { t } = useTranslation();
  const [name, setName] = useState("");
  const [genericName, setGenericName] = useState("");
  const [productType, setProductType] = useState("medicine");
  const [taxRateId, setTaxRateId] = useState(taxRates.find((r) => r.rate_percentage === 0)?.id ?? taxRates[0]?.id ?? "");
  const [variants, setVariants] = useState<ProductVariantInput[]>([{}]);
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);

  async function submit() {
    if (!name.trim()) { setError(t("admin.productNameRequired")); return; }
    if (!taxRateId) { setError(t("admin.selectTaxRate")); return; }
    setBusy(true);
    setError("");
    try {
      await adminCreateProduct({ name: name.trim(), genericName: genericName.trim() || undefined, productType, taxRateId, variants });
      onCreated();
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : "Could not create this product.");
    } finally {
      setBusy(false);
    }
  }

  return (
    <Modal title={t("admin.addProduct")} onClose={onClose}>
      <div className="space-y-3">
        {error && <p className="text-xs text-red-600">{error}</p>}
        <div>
          <label className="text-xs font-semibold text-slate-600 block mb-1">{t("admin.productName")}</label>
          <input value={name} onChange={(e) => setName(e.target.value)} placeholder={t("admin.productSearchExample")}
            className="w-full border border-slate-200 rounded-lg px-3 py-2 text-sm focus:border-blue-400 focus:ring-1 focus:ring-blue-200 transition-colors" />
        </div>
        <div className="grid grid-cols-2 gap-3">
          <div>
            <label className="text-xs font-semibold text-slate-600 block mb-1">{t("admin.genericName")}</label>
            <input value={genericName} onChange={(e) => setGenericName(e.target.value)}
              className="w-full border border-slate-200 rounded-lg px-3 py-2 text-sm focus:border-blue-400 focus:ring-1 focus:ring-blue-200 transition-colors" />
          </div>
          <div>
            <label className="text-xs font-semibold text-slate-600 block mb-1">{t("admin.productType")}</label>
            <select value={productType} onChange={(e) => setProductType(e.target.value)}
              className="w-full border border-slate-200 rounded-lg px-3 py-2 text-sm focus:border-blue-400 focus:ring-1 focus:ring-blue-200 transition-colors">
              <option value="medicine">{t("admin.productTypeMedicine")}</option>
              <option value="supply">{t("admin.productTypeSupply")}</option>
              <option value="other">{t("admin.productTypeOther")}</option>
            </select>
          </div>
        </div>
        <div>
          <label className="text-xs font-semibold text-slate-600 block mb-1">{t("admin.taxRate")}</label>
          <select value={taxRateId} onChange={(e) => setTaxRateId(e.target.value)}
            className="w-full border border-slate-200 rounded-lg px-3 py-2 text-sm focus:border-blue-400 focus:ring-1 focus:ring-blue-200 transition-colors">
            {taxRates.map((rate) => (
              <option key={rate.id} value={rate.id}>{rate.name} ({rate.rate_percentage}%)</option>
            ))}
          </select>
        </div>
        <VariantEditor variants={variants} onChange={setVariants} />
        <div className="flex justify-end gap-2 pt-2">
          <button onClick={onClose} className="px-4 py-2 text-sm border border-slate-200 text-slate-500 rounded-lg hover:bg-slate-50 transition-colors">{t("admin.cancel")}</button>
          <button onClick={() => void submit()} disabled={busy}
            className="flex items-center gap-2 px-4 py-2 text-sm bg-blue-600 text-white rounded-lg hover:bg-blue-700 transition-colors disabled:opacity-60">
            {busy ? <RefreshCw className="w-3.5 h-3.5 animate-spin" /> : <Plus className="w-3.5 h-3.5" />}
            {t("admin.addProduct")}
          </button>
        </div>
      </div>
    </Modal>
  );
}

function AddTaxRateModal({ onClose, onCreated }: { onClose: () => void; onCreated: () => void }) {
  const { t } = useTranslation();
  const [name, setName] = useState("");
  const [rate, setRate] = useState("");
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);

  async function submit() {
    const parsed = Number(rate);
    if (!name.trim()) { setError(t("admin.taxRateNameRequired")); return; }
    if (!Number.isFinite(parsed) || parsed < 0 || parsed > 100) { setError(t("admin.taxRateInvalid")); return; }
    setBusy(true);
    setError("");
    try {
      await adminCreateTaxRate(name.trim(), parsed);
      onCreated();
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : "Could not create this tax rate.");
    } finally {
      setBusy(false);
    }
  }

  return (
    <Modal title={t("admin.addTaxRate")} onClose={onClose}>
      <div className="space-y-3">
        {error && <p className="text-xs text-red-600">{error}</p>}
        <div>
          <label className="text-xs font-semibold text-slate-600 block mb-1">{t("admin.taxRateName")}</label>
          <input value={name} onChange={(e) => setName(e.target.value)} placeholder={t("admin.taxRateNamePlaceholder")}
            className="w-full border border-slate-200 rounded-lg px-3 py-2 text-sm focus:border-blue-400 focus:ring-1 focus:ring-blue-200 transition-colors" />
        </div>
        <div>
          <label className="text-xs font-semibold text-slate-600 block mb-1">{t("admin.taxRatePercentage")}</label>
          <input type="number" min="0" max="100" step="0.01" value={rate} onChange={(e) => setRate(e.target.value)}
            className="w-full border border-slate-200 rounded-lg px-3 py-2 text-sm focus:border-blue-400 focus:ring-1 focus:ring-blue-200 transition-colors" />
        </div>
        <div className="flex justify-end gap-2 pt-2">
          <button onClick={onClose} className="px-4 py-2 text-sm border border-slate-200 text-slate-500 rounded-lg hover:bg-slate-50 transition-colors">{t("admin.cancel")}</button>
          <button onClick={() => void submit()} disabled={busy}
            className="flex items-center gap-2 px-4 py-2 text-sm bg-blue-600 text-white rounded-lg hover:bg-blue-700 transition-colors disabled:opacity-60">
            {busy ? <RefreshCw className="w-3.5 h-3.5 animate-spin" /> : <Plus className="w-3.5 h-3.5" />}
            {t("admin.addTaxRate")}
          </button>
        </div>
      </div>
    </Modal>
  );
}

function ProductsView() {
  const { t } = useTranslation();
  const [products, setProducts] = useState<AdminProduct[]>([]);
  const [taxRates, setTaxRates] = useState<TaxRate[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const [query, setQuery] = useState("");
  const [showAdd, setShowAdd] = useState(false);
  const [showAddTax, setShowAddTax] = useState(false);
  const [savingTaxFor, setSavingTaxFor] = useState<string | null>(null);

  const refresh = useCallback(async () => {
    setLoading(true);
    setError("");
    try {
      const [productList, rates] = await Promise.all([adminListProducts(), adminListTaxRates()]);
      setProducts(productList);
      setTaxRates(rates);
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : "Could not load products.");
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => { void refresh(); }, [refresh]);

  async function changeTax(productId: string, taxRateId: string) {
    setSavingTaxFor(productId);
    try {
      await adminSetProductTax(productId, taxRateId);
      setProducts((current) => current.map((p) => {
        if (p.id !== productId) return p;
        const rate = taxRates.find((r) => r.id === taxRateId);
        return { ...p, taxRateId, taxRateName: rate?.name ?? p.taxRateName, taxRatePercentage: rate?.rate_percentage ?? p.taxRatePercentage };
      }));
    } catch (reason) {
      window.alert(reason instanceof Error ? reason.message : "Could not update the tax rate.");
    } finally {
      setSavingTaxFor(null);
    }
  }

  const needle = query.trim().toLowerCase();
  const filtered = products.filter((p) => !needle || p.name.toLowerCase().includes(needle) || (p.genericName ?? "").toLowerCase().includes(needle));
  const { visible: shown, hasMore, showMore, shown: shownCount, total } = usePagedList(filtered, [needle]);

  return (
    <div className="space-y-6">
      <div className="flex items-start justify-between gap-4 flex-wrap">
        <div>
          <h2 className="text-xl font-bold text-slate-800">{t("admin.productsAndTax")}</h2>
          <p className="text-xs text-slate-400 mt-0.5">{t("admin.productsCount", { count: products.length })}</p>
        </div>
        <div className="flex items-center gap-2">
          <button onClick={() => setShowAddTax(true)}
            className="flex items-center gap-1.5 px-3 py-2 text-xs font-semibold border border-blue-200 text-blue-700 rounded-lg hover:bg-blue-50 transition-colors">
            <Tag className="w-3.5 h-3.5" /> {t("admin.addTaxRate")}
          </button>
          <button onClick={() => setShowAdd(true)}
            className="flex items-center gap-1.5 px-3 py-2 text-xs font-semibold bg-blue-600 text-white rounded-lg hover:bg-blue-700 transition-colors">
            <Plus className="w-3.5 h-3.5" /> {t("admin.addProduct")}
          </button>
        </div>
      </div>

      {error && <div className="bg-red-50 border border-red-200 text-red-700 text-xs rounded-lg px-3 py-2">{error}</div>}

      <input value={query} onChange={(e) => setQuery(e.target.value)} placeholder={t("admin.searchProducts")}
        className="w-full max-w-sm border border-slate-200 rounded-lg px-3 py-2 text-sm focus:border-blue-400 focus:ring-1 focus:ring-blue-200 transition-colors" />

      <div className="bg-white rounded-xl border border-blue-100 shadow-sm overflow-hidden">
        <div className="overflow-x-auto">
          <table className="w-full text-xs">
            <thead>
              <tr className="bg-slate-50 border-b border-slate-100">
                {[t("admin.colPharmacy"), t("admin.colProductType"), t("admin.colVariants"), t("admin.colTaxRate")].map((h) => (
                  <th key={h} className="text-left px-4 py-3 font-semibold text-slate-500 text-[10px] uppercase tracking-wide whitespace-nowrap">{h}</th>
                ))}
              </tr>
            </thead>
            <tbody className="divide-y divide-slate-50">
              {shown.map((p) => (
                <tr key={p.id} className="hover:bg-blue-50/30 transition-colors">
                  <td className="px-4 py-3">
                    <p className="font-semibold text-slate-700">{p.name}</p>
                    {p.genericName && <p className="text-[10px] text-slate-400">{p.genericName}</p>}
                  </td>
                  <td className="px-4 py-3 text-slate-500 capitalize">{p.productType}</td>
                  <td className="px-4 py-3 text-slate-500">
                    {p.variants.length === 0 ? "—" : p.variants.map((v) => [v.dosage, v.form, v.unit].filter(Boolean).join(" · ") || "—").join(", ")}
                  </td>
                  <td className="px-4 py-3">
                    <select
                      value={p.taxRateId}
                      disabled={savingTaxFor === p.id}
                      onChange={(e) => void changeTax(p.id, e.target.value)}
                      className="border border-slate-200 rounded-lg px-2 py-1 text-xs focus:border-blue-400 focus:ring-1 focus:ring-blue-200 transition-colors disabled:opacity-50"
                    >
                      {taxRates.map((rate) => (
                        <option key={rate.id} value={rate.id}>{rate.name} ({rate.rate_percentage}%)</option>
                      ))}
                    </select>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
          {!loading && filtered.length === 0 && (
            <p className="text-center py-10 text-xs text-slate-400">{t("admin.noProductsFound")}</p>
          )}
        </div>
        <LoadMoreButton hasMore={hasMore} shown={shownCount} total={total} onClick={showMore} />
      </div>

      {showAdd && (
        <AddProductModal taxRates={taxRates} onClose={() => setShowAdd(false)} onCreated={() => { setShowAdd(false); void refresh(); }} />
      )}
      {showAddTax && (
        <AddTaxRateModal onClose={() => setShowAddTax(false)} onCreated={() => { setShowAddTax(false); void refresh(); }} />
      )}
    </div>
  );
}

// ── Categories ───────────────────────────────────────────────────────────────
// Categories are still branch-owned (private lists a branch files its own
// products under), but the super admin gets a system-wide view across every
// branch here, plus the ability to push a new one out -- to one branch, or
// every branch at once (e.g. a Ministry of Health mandated category).

function AddCategoryModal({ branches, onClose, onCreated }: {
  branches: { id: string; name: string }[]; onClose: () => void; onCreated: () => void;
}) {
  const { t } = useTranslation();
  const [name, setName] = useState("");
  const [description, setDescription] = useState("");
  const [branchId, setBranchId] = useState("");
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);

  async function submit() {
    if (!name.trim()) { setError(t("admin.categoryNameRequired")); return; }
    setBusy(true);
    setError("");
    try {
      await adminCreateCategory(name.trim(), description.trim(), branchId || null);
      onCreated();
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : "Could not create this category.");
    } finally {
      setBusy(false);
    }
  }

  return (
    <Modal title={t("admin.addCategory")} onClose={onClose}>
      <div className="space-y-3">
        {error && <p className="text-xs text-red-600">{error}</p>}
        <div>
          <label className="text-xs font-semibold text-slate-600 block mb-1">{t("admin.categoryName")}</label>
          <input value={name} onChange={(e) => setName(e.target.value)}
            className="w-full border border-slate-200 rounded-lg px-3 py-2 text-sm focus:border-blue-400 focus:ring-1 focus:ring-blue-200 transition-colors" />
        </div>
        <div>
          <label className="text-xs font-semibold text-slate-600 block mb-1">{t("admin.categoryDescription")}</label>
          <input value={description} onChange={(e) => setDescription(e.target.value)}
            className="w-full border border-slate-200 rounded-lg px-3 py-2 text-sm focus:border-blue-400 focus:ring-1 focus:ring-blue-200 transition-colors" />
        </div>
        <div>
          <label className="text-xs font-semibold text-slate-600 block mb-1">{t("admin.categoryTarget")}</label>
          <select value={branchId} onChange={(e) => setBranchId(e.target.value)}
            className="w-full border border-slate-200 rounded-lg px-3 py-2 text-sm focus:border-blue-400 focus:ring-1 focus:ring-blue-200 transition-colors">
            <option value="">{t("admin.categoryAllBranches")}</option>
            {branches.map((b) => (
              <option key={b.id} value={b.id}>{b.name}</option>
            ))}
          </select>
        </div>
        <div className="flex justify-end gap-2 pt-2">
          <button onClick={onClose} className="px-4 py-2 text-sm border border-slate-200 text-slate-500 rounded-lg hover:bg-slate-50 transition-colors">{t("admin.cancel")}</button>
          <button onClick={() => void submit()} disabled={busy}
            className="flex items-center gap-2 px-4 py-2 text-sm bg-blue-600 text-white rounded-lg hover:bg-blue-700 transition-colors disabled:opacity-60">
            {busy ? <RefreshCw className="w-3.5 h-3.5 animate-spin" /> : <Plus className="w-3.5 h-3.5" />}
            {t("admin.addCategory")}
          </button>
        </div>
      </div>
    </Modal>
  );
}

// Sentinel for "branches with no organization" in the org filter -- a real
// (if increasingly rare) case for a branch created before organizations
// existed, or never assigned one. Not a valid uuid, so it can never collide
// with a real organization_id.
const NO_ORG_FILTER = "__none__";

type CategorySortKey = "category" | "organization" | "pharmacy";

function CategoriesView({ branches }: { branches: BranchRecord[] }) {
  const { t } = useTranslation();
  const [categories, setCategories] = useState<AdminCategoryRow[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const [query, setQuery] = useState("");
  const [orgFilter, setOrgFilter] = useState("");
  const [branchFilter, setBranchFilter] = useState("");
  const [sortKey, setSortKey] = useState<CategorySortKey>("pharmacy");
  const [sortDir, setSortDir] = useState<"asc" | "desc">("asc");
  const [showAdd, setShowAdd] = useState(false);
  const [syncing, setSyncing] = useState(false);
  const [syncResult, setSyncResult] = useState<string | null>(null);

  function toggleSort(key: CategorySortKey) {
    if (sortKey === key) { setSortDir((d) => (d === "asc" ? "desc" : "asc")); return; }
    setSortKey(key);
    setSortDir("asc");
  }

  const refresh = useCallback(async () => {
    setLoading(true);
    setError("");
    try {
      setCategories(await adminListCategories());
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : "Could not load categories.");
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => { void refresh(); }, [refresh]);

  // "Push to every branch" (the target picker in Add Category) only ever
  // reaches branches that exist at that moment -- a branch onboarded later
  // never retroactively gets categories broadcast before it existed. This
  // is the catch-up: re-runnable any time, harmless to click again (already-
  // present rows are never touched), so it doubles as "run this again
  // whenever a new branch needs to catch up" rather than a one-off fix.
  async function syncToAllBranches() {
    setSyncing(true);
    setSyncResult(null);
    setError("");
    try {
      const added = await adminBackfillCategoriesToAllBranches();
      const key = added === 0 ? "admin.categoriesSyncedNoneNeeded" : added === 1 ? "admin.categoriesSyncedResultSingular" : "admin.categoriesSyncedResultPlural";
      setSyncResult(t(key, { count: added }));
      await refresh();
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : "Could not sync categories to all branches.");
    } finally {
      setSyncing(false);
    }
  }

  const needle = query.trim().toLowerCase();

  // Built from the categories rows themselves (not a separate query) --
  // every organization/branch that actually has at least one category is
  // already right there. Branch options narrow to whichever organization
  // is currently selected, so picking an org first can't leave a stale
  // branch choice from a different one selected underneath it.
  const organizationOptions = (() => {
    const map = new Map<string, string>();
    let hasNoOrg = false;
    for (const c of categories) {
      if (c.organization_id) map.set(c.organization_id, c.organization_name ?? c.organization_id);
      else hasNoOrg = true;
    }
    const opts = Array.from(map, ([id, name]) => ({ id, name })).sort((a, b) => a.name.localeCompare(b.name));
    if (hasNoOrg) opts.push({ id: NO_ORG_FILTER, name: t("admin.categoriesNoOrganization") });
    return opts;
  })();
  const branchOptions = (() => {
    const map = new Map<string, string>();
    for (const c of categories) {
      if (orgFilter === NO_ORG_FILTER && c.organization_id) continue;
      if (orgFilter && orgFilter !== NO_ORG_FILTER && c.organization_id !== orgFilter) continue;
      map.set(c.branch_id, c.branch_name);
    }
    return Array.from(map, ([id, name]) => ({ id, name })).sort((a, b) => a.name.localeCompare(b.name));
  })();

  const filtered = categories.filter((c) => {
    if (orgFilter === NO_ORG_FILTER && c.organization_id) return false;
    if (orgFilter && orgFilter !== NO_ORG_FILTER && c.organization_id !== orgFilter) return false;
    if (branchFilter && c.branch_id !== branchFilter) return false;
    if (needle && !c.name.toLowerCase().includes(needle) && !c.branch_name.toLowerCase().includes(needle)) return false;
    return true;
  });
  const sorted = [...filtered].sort((a, b) => {
    const value = (row: AdminCategoryRow) =>
      sortKey === "category" ? row.name : sortKey === "organization" ? (row.organization_name ?? "") : row.branch_name;
    const cmp = value(a).localeCompare(value(b));
    return sortDir === "asc" ? cmp : -cmp;
  });
  const { visible: shown, hasMore, showMore, shown: shownCount, total } = usePagedList(sorted, [needle, orgFilter, branchFilter, sortKey, sortDir]);
  const activeBranches = branches.filter((b) => b.branchId).map((b) => ({ id: b.branchId!, name: b.pharmacyName }));
  // categories.length is one row PER (branch, category name) PAIR -- the
  // same name shared by 5 branches is 5 rows here, but exactly 1 option in
  // any one of those branches' own picker. Showing only that raw row count
  // reads as "how many distinct categories are there", which it isn't --
  // confirmed live: a branch showing its correct, complete 22-category
  // picker was mistaken for "missing categories" next to this page's own
  // much larger cross-branch row total. Both numbers now shown, labeled.
  const distinctCategoryCount = new Set(categories.map((c) => c.name.trim().toLowerCase())).size;

  function sortIndicator(key: CategorySortKey) {
    if (sortKey !== key) return null;
    return <span className="text-blue-500">{sortDir === "asc" ? "▲" : "▼"}</span>;
  }

  return (
    <div className="space-y-6">
      <div className="flex items-start justify-between gap-4 flex-wrap">
        <div>
          <h2 className="text-xl font-bold text-slate-800">{t("admin.categoriesSystemWide")}</h2>
          <p className="text-xs text-slate-400 mt-0.5">
            {t("admin.categoriesDistinctCount", { count: distinctCategoryCount })} · {t("admin.categoriesCount", { count: categories.length })}
          </p>
        </div>
        <div className="flex items-center gap-2">
          <button onClick={() => void syncToAllBranches()} disabled={syncing}
            title={t("admin.categoriesSyncHint")}
            className="flex items-center gap-1.5 px-3 py-2 text-xs font-semibold border border-blue-200 text-blue-700 rounded-lg hover:bg-blue-50 transition-colors disabled:opacity-60">
            <RefreshCw className={`w-3.5 h-3.5 ${syncing ? "animate-spin" : ""}`} /> {t("admin.categoriesSyncButton")}
          </button>
          <button onClick={() => setShowAdd(true)}
            className="flex items-center gap-1.5 px-3 py-2 text-xs font-semibold bg-blue-600 text-white rounded-lg hover:bg-blue-700 transition-colors">
            <Plus className="w-3.5 h-3.5" /> {t("admin.addCategory")}
          </button>
        </div>
      </div>

      {syncResult && <div className="bg-blue-50 border border-blue-200 text-blue-700 text-xs rounded-lg px-3 py-2">{syncResult}</div>}

      {error && <div className="bg-red-50 border border-red-200 text-red-700 text-xs rounded-lg px-3 py-2">{error}</div>}

      <div className="flex items-center gap-2 flex-wrap">
        <input value={query} onChange={(e) => setQuery(e.target.value)} placeholder={t("admin.searchCategories")}
          className="w-full max-w-sm border border-slate-200 rounded-lg px-3 py-2 text-sm focus:border-blue-400 focus:ring-1 focus:ring-blue-200 transition-colors" />
        <select value={orgFilter} onChange={(e) => { setOrgFilter(e.target.value); setBranchFilter(""); }}
          className="border border-slate-200 rounded-lg px-3 py-2 text-sm focus:border-blue-400 focus:ring-1 focus:ring-blue-200 transition-colors">
          <option value="">{t("admin.categoriesFilterAllOrgs")}</option>
          {organizationOptions.map((o) => <option key={o.id} value={o.id}>{o.name}</option>)}
        </select>
        <select value={branchFilter} onChange={(e) => setBranchFilter(e.target.value)}
          className="border border-slate-200 rounded-lg px-3 py-2 text-sm focus:border-blue-400 focus:ring-1 focus:ring-blue-200 transition-colors">
          <option value="">{t("admin.categoriesFilterAllBranches")}</option>
          {branchOptions.map((b) => <option key={b.id} value={b.id}>{b.name}</option>)}
        </select>
      </div>

      <div className="bg-white rounded-xl border border-blue-100 shadow-sm overflow-hidden">
        <div className="overflow-x-auto">
          <table className="w-full text-xs">
            <thead>
              <tr className="bg-slate-50 border-b border-slate-100">
                {([
                  ["category", t("admin.colCategory")],
                  [null, t("admin.colDescription")],
                  ["organization", t("admin.colOrganization")],
                  ["pharmacy", t("admin.colPharmacy")],
                ] as const).map(([key, label]) => (
                  <th key={label} className="text-left px-4 py-3 font-semibold text-slate-500 text-[10px] uppercase tracking-wide whitespace-nowrap">
                    {key ? (
                      <button type="button" onClick={() => toggleSort(key)}
                        className="flex items-center gap-1 hover:text-blue-600 transition-colors"
                        style={{ background: "none", border: "none", padding: 0, font: "inherit", cursor: "pointer", color: "inherit" }}>
                        {label} {sortIndicator(key)}
                      </button>
                    ) : label}
                  </th>
                ))}
              </tr>
            </thead>
            <tbody className="divide-y divide-slate-50">
              {shown.map((c) => (
                <tr key={c.id} className="hover:bg-blue-50/30 transition-colors">
                  <td className="px-4 py-3 font-semibold text-slate-700">{c.name}</td>
                  <td className="px-4 py-3 text-slate-500">{c.description ?? "—"}</td>
                  <td className="px-4 py-3 text-slate-500">{c.organization_name ?? t("admin.categoriesNoOrganization")}</td>
                  <td className="px-4 py-3 text-slate-500">{c.branch_name}</td>
                </tr>
              ))}
            </tbody>
          </table>
          {!loading && sorted.length === 0 && (
            <p className="text-center py-10 text-xs text-slate-400">{t("admin.noCategoriesFound")}</p>
          )}
        </div>
        <LoadMoreButton hasMore={hasMore} shown={shownCount} total={total} onClick={showMore} />
      </div>

      {showAdd && (
        <AddCategoryModal branches={activeBranches} onClose={() => setShowAdd(false)} onCreated={() => { setShowAdd(false); void refresh(); }} />
      )}
    </div>
  );
}

// ── Insurance ────────────────────────────────────────────────────────────────
// Each provider has one default_coverage_percentage applied to every product
// by default; insurance_product_coverage holds only the exceptions (a row
// existing there IS the "differs from default" flag — 0% is a real override
// meaning "not covered at all", not a special case).

function ProviderFormModal({ provider, onClose, onSaved }: {
  provider?: InsuranceProvider; onClose: () => void; onSaved: () => void;
}) {
  const [name, setName] = useState(provider?.name ?? "");
  const [rate, setRate] = useState(provider ? String(provider.defaultCoveragePercentage) : "");
  const [contact, setContact] = useState(provider?.contactInfo ?? "");
  const [tin, setTin] = useState(provider?.tin ?? "");
  const { t } = useTranslation();
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);

  async function submit() {
    const parsed = Number(rate);
    if (!name.trim()) { setError(t("admin.insNameRequired")); return; }
    if (!Number.isFinite(parsed) || parsed < 0 || parsed > 100) { setError(t("admin.insCoverageRange")); return; }
    setBusy(true);
    setError("");
    try {
      if (provider) await adminUpdateInsuranceProvider(provider.id, name.trim(), parsed, contact.trim(), tin.trim());
      else await adminCreateInsuranceProvider(name.trim(), parsed, contact.trim(), tin.trim());
      onSaved();
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : t("admin.insSaveError"));
    } finally {
      setBusy(false);
    }
  }

  return (
    <Modal title={provider ? t("admin.insEditTitle") : t("admin.insAddTitle")} onClose={onClose}>
      <div className="space-y-3">
        {error && <p className="text-xs text-red-600">{error}</p>}
        <div>
          <label className="text-xs font-semibold text-slate-600 block mb-1">{t("admin.insProviderName")}</label>
          <input value={name} onChange={(e) => setName(e.target.value)} placeholder={t("admin.insProviderNamePlaceholder")}
            className="w-full border border-slate-200 rounded-lg px-3 py-2 text-sm focus:border-blue-400 focus:ring-1 focus:ring-blue-200 transition-colors" />
        </div>
        <div>
          <label className="text-xs font-semibold text-slate-600 block mb-1">{t("admin.insTinLabel")}</label>
          <input value={tin} onChange={(e) => setTin(e.target.value)} placeholder={t("admin.insTinPlaceholder")}
            className="w-full border border-slate-200 rounded-lg px-3 py-2 text-sm focus:border-blue-400 focus:ring-1 focus:ring-blue-200 transition-colors" />
          <p className="text-[11px] text-slate-400 mt-1">{t("admin.insTinHint")}</p>
        </div>
        <div>
          <label className="text-xs font-semibold text-slate-600 block mb-1">{t("admin.insDefaultCoverageLabel")}</label>
          <input type="number" min="0" max="100" step="0.01" value={rate} onChange={(e) => setRate(e.target.value)}
            className="w-full border border-slate-200 rounded-lg px-3 py-2 text-sm focus:border-blue-400 focus:ring-1 focus:ring-blue-200 transition-colors" />
        </div>
        <div>
          <label className="text-xs font-semibold text-slate-600 block mb-1">{t("admin.insContactLabel")}</label>
          <input value={contact} onChange={(e) => setContact(e.target.value)}
            className="w-full border border-slate-200 rounded-lg px-3 py-2 text-sm focus:border-blue-400 focus:ring-1 focus:ring-blue-200 transition-colors" />
        </div>
        <div className="flex justify-end gap-2 pt-2">
          <button onClick={onClose} className="px-4 py-2 text-sm border border-slate-200 text-slate-500 rounded-lg hover:bg-slate-50 transition-colors">{t("admin.cancel")}</button>
          <button onClick={() => void submit()} disabled={busy}
            className="flex items-center gap-2 px-4 py-2 text-sm bg-blue-600 text-white rounded-lg hover:bg-blue-700 transition-colors disabled:opacity-60">
            {busy ? <RefreshCw className="w-3.5 h-3.5 animate-spin" /> : <Plus className="w-3.5 h-3.5" />}
            {provider ? t("admin.insSaveChanges") : t("admin.insAddButton")}
          </button>
        </div>
      </div>
    </Modal>
  );
}

function ManageCoverageModal({ provider, onClose }: { provider: InsuranceProvider; onClose: () => void }) {
  const { t } = useTranslation();
  const [overrides, setOverrides] = useState<CoverageOverrideRow[]>([]);
  const [products, setProducts] = useState<AdminProduct[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const [productQuery, setProductQuery] = useState("");
  const [pickedProductId, setPickedProductId] = useState("");
  const [pct, setPct] = useState("");
  const [busy, setBusy] = useState(false);

  const refresh = useCallback(async () => {
    setLoading(true);
    setError("");
    try {
      const [rows, productList] = await Promise.all([adminLoadCoverageOverridesWithNames(provider.id), adminListProducts()]);
      setOverrides(rows);
      setProducts(productList);
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : "Could not load coverage for this provider.");
    } finally {
      setLoading(false);
    }
  }, [provider.id]);

  useEffect(() => { void refresh(); }, [refresh]);

  const overriddenIds = new Set(overrides.map((o) => o.productId));
  const needle = productQuery.trim().toLowerCase();
  const candidates = products.filter((p) => !overriddenIds.has(p.id) && (!needle || p.name.toLowerCase().includes(needle)));

  async function saveOverride(productId: string, coveragePercentage: number) {
    setBusy(true);
    setError("");
    try {
      await adminSetInsuranceCoverage(provider.id, productId, coveragePercentage);
      setPickedProductId("");
      setPct("");
      setProductQuery("");
      await refresh();
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : "Could not save this coverage override.");
    } finally {
      setBusy(false);
    }
  }

  async function clearOverride(productId: string) {
    setBusy(true);
    setError("");
    try {
      await adminClearInsuranceCoverage(provider.id, productId);
      await refresh();
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : "Could not clear this override.");
    } finally {
      setBusy(false);
    }
  }

  return (
    <Modal title={t("admin.insCoverageTitle", { provider: provider.name })} onClose={onClose}>
      <div className="space-y-4 max-h-[65vh] overflow-y-auto">
        <p className="text-xs text-slate-500">{t("admin.insCoverageIntro", { percent: provider.defaultCoveragePercentage })}</p>
        {error && <p className="text-xs text-red-600">{error}</p>}

        {loading ? (
          <p className="text-xs text-slate-400">{t("admin.insCoverageLoading")}</p>
        ) : overrides.length === 0 ? (
          <p className="text-xs text-slate-400">{t("admin.insCoverageNone")}</p>
        ) : (
          <div className="space-y-1.5">
            {overrides.map((o) => (
              <div key={o.productId} className="flex items-center justify-between gap-2 bg-slate-50 rounded-lg px-3 py-2">
                <span className="text-sm text-slate-700">{o.productName}</span>
                <div className="flex items-center gap-2 shrink-0">
                  <span className={`text-xs font-bold ${o.coveragePercentage === 0 ? "text-red-600" : "text-blue-700"}`}>
                    {o.coveragePercentage === 0 ? t("admin.insNotCovered") : `${o.coveragePercentage}%`}
                  </span>
                  <button onClick={() => void clearOverride(o.productId)} disabled={busy} title={t("admin.insRevertToDefault")}
                    className="text-slate-400 hover:text-red-600 transition-colors disabled:opacity-50">
                    <X className="w-3.5 h-3.5" />
                  </button>
                </div>
              </div>
            ))}
          </div>
        )}

        <div className="border-t border-slate-100 pt-3 space-y-2">
          <label className="text-xs font-semibold text-slate-600 block">{t("admin.insAddOverride")}</label>
          <input value={pickedProductId ? products.find((p) => p.id === pickedProductId)?.name ?? "" : productQuery}
            onChange={(e) => { setProductQuery(e.target.value); setPickedProductId(""); }}
            placeholder={t("admin.insSearchProduct")}
            className="w-full border border-slate-200 rounded-lg px-3 py-2 text-sm focus:border-blue-400 focus:ring-1 focus:ring-blue-200 transition-colors" />
          {!pickedProductId && productQuery.trim() && (
            <div className="border border-slate-100 rounded-lg max-h-32 overflow-y-auto">
              {candidates.slice(0, 20).map((p) => (
                <button key={p.id} onClick={() => { setPickedProductId(p.id); setProductQuery(""); }}
                  className="w-full text-left px-3 py-1.5 text-xs text-slate-700 hover:bg-blue-50 transition-colors">
                  {p.name}
                </button>
              ))}
              {candidates.length === 0 && <p className="px-3 py-1.5 text-xs text-slate-400">{t("admin.insNoProductMatch")}</p>}
            </div>
          )}
          {pickedProductId && (
            <div className="flex items-center gap-2">
              <input type="number" min="0" max="100" step="0.01" value={pct} onChange={(e) => setPct(e.target.value)}
                placeholder={t("admin.insCoveragePercent")} className="w-28 border border-slate-200 rounded-lg px-3 py-2 text-sm focus:border-blue-400 focus:ring-1 focus:ring-blue-200 transition-colors" />
              <button onClick={() => setPct("0")} className="text-xs font-semibold text-red-600 hover:underline">{t("admin.insNotCovered")}</button>
              <div className="flex-1" />
              <button onClick={() => void saveOverride(pickedProductId, Number(pct))} disabled={busy || pct.trim() === "" || !Number.isFinite(Number(pct))}
                className="flex items-center gap-1.5 px-3 py-2 text-xs font-semibold bg-blue-600 text-white rounded-lg hover:bg-blue-700 transition-colors disabled:opacity-60">
                {busy ? <RefreshCw className="w-3.5 h-3.5 animate-spin" /> : <Plus className="w-3.5 h-3.5" />} {t("admin.insSave")}
              </button>
            </div>
          )}
        </div>
      </div>
    </Modal>
  );
}

// Admin-facing bulk import for an insurer's reimbursable-medicines price
// list -- CSV or Excel, in whatever column layout that insurer uses. Three
// steps: pick a file (auto-parsed + header/column-guessed by
// lib/insuranceImport.ts), confirm/correct the guessed column mapping while
// previewing what will and won't be imported, then commit via
// admin_import_insurance_price_list(). Re-uploading the same provider's next
// revision later updates existing products/prices in place instead of
// duplicating them -- see that RPC's own comment for why.
type ImportStep = "upload" | "map" | "result";

function ImportPriceListModal({ provider, taxRates, onClose, onImported }: {
  provider: InsuranceProvider; taxRates: TaxRate[]; onClose: () => void; onImported: () => void;
}) {
  const { t } = useTranslation();
  const [step, setStep] = useState<ImportStep>("upload");
  const [fileName, setFileName] = useState("");
  const [parsing, setParsing] = useState(false);
  const [error, setError] = useState("");
  const [rawRows, setRawRows] = useState<string[][]>([]);
  const [headerRowIndex, setHeaderRowIndex] = useState(0);
  const [mapping, setMapping] = useState<ColumnMapping>({ code: null, name: null, genericName: null, unit: null, price: null });
  const [taxRateId, setTaxRateId] = useState(taxRates.find((r) => r.rate_percentage === 0)?.id ?? taxRates[0]?.id ?? "");
  const [busy, setBusy] = useState(false);
  const [showSkipped, setShowSkipped] = useState(false);
  const [result, setResult] = useState<InsuranceImportResult | null>(null);

  async function handleFile(file: File) {
    setError("");
    setParsing(true);
    setFileName(file.name);
    try {
      const rows = await parseSpreadsheetFile(file);
      if (rows.length === 0) throw new Error(t("admin.insImportEmptyFile"));
      const headerIdx = detectHeaderRow(rows);
      setRawRows(rows);
      setHeaderRowIndex(headerIdx);
      setMapping(autoMapColumns(rows[headerIdx] ?? []));
      setStep("map");
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : t("admin.insImportParseError"));
    } finally {
      setParsing(false);
    }
  }

  const headerRow = rawRows[headerRowIndex] ?? [];
  const preview = useMemo(() => buildImportPreview(rawRows, headerRowIndex, mapping), [rawRows, headerRowIndex, mapping]);

  async function submit() {
    if (preview.rows.length === 0) { setError(t("admin.insImportNoRowsError")); return; }
    setBusy(true);
    setError("");
    try {
      const outcome = await adminImportInsurancePriceList(provider.id, taxRateId, preview.rows);
      setResult(outcome);
      setStep("result");
      onImported();
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : "Could not import this price list.");
    } finally {
      setBusy(false);
    }
  }

  return (
    <Modal title={t("admin.insImportTitle", { provider: provider.name })} onClose={onClose} wide>
      <div className="space-y-4">
        {error && <p className="text-xs text-red-600">{error}</p>}

        {step === "upload" && (
          <div className="space-y-4">
            <p className="text-xs text-slate-500">{t("admin.insImportIntro")}</p>
            <div>
              <label className="text-xs font-semibold text-slate-600 block mb-1">{t("admin.insImportTaxRateLabel")}</label>
              <select value={taxRateId} onChange={(e) => setTaxRateId(e.target.value)}
                className="w-full border border-slate-200 rounded-lg px-3 py-2 text-sm focus:border-blue-400 focus:ring-1 focus:ring-blue-200 transition-colors">
                {taxRates.map((r) => <option key={r.id} value={r.id}>{r.name} ({r.rate_percentage}%)</option>)}
              </select>
            </div>
            <label className="flex flex-col items-center justify-center gap-2 border-2 border-dashed border-slate-200 rounded-xl py-10 cursor-pointer hover:border-blue-300 hover:bg-blue-50/30 transition-colors">
              <Upload className="w-6 h-6 text-slate-400" />
              <span className="text-sm font-semibold text-slate-600">{parsing ? t("admin.insImportParsing") : t("admin.insImportChooseFile")}</span>
              <span className="text-[10px] text-slate-400">{t("admin.insImportFileHint")}</span>
              <input type="file" accept=".csv,.xlsx,.xls" className="hidden" disabled={parsing}
                onChange={(e) => { const f = e.target.files?.[0]; if (f) void handleFile(f); e.target.value = ""; }} />
            </label>
          </div>
        )}

        {step === "map" && (
          <div className="space-y-4">
            <div className="flex items-center gap-2 text-xs text-slate-500">
              <FileSpreadsheet className="w-3.5 h-3.5" /> {fileName}
            </div>
            <div>
              <p className="text-xs font-semibold text-slate-600 mb-2">{t("admin.insImportMappingTitle")}</p>
              <div className="grid grid-cols-2 gap-3">
                {IMPORT_FIELDS.map((field) => (
                  <div key={field}>
                    <label className="text-[10px] font-semibold text-slate-500 uppercase tracking-wide block mb-1">
                      {t(`admin.insImportCol_${field}` as TranslationKey)}
                    </label>
                    <select value={mapping[field] ?? ""} onChange={(e) => setMapping((m) => ({ ...m, [field]: e.target.value === "" ? null : Number(e.target.value) }))}
                      className="w-full border border-slate-200 rounded-lg px-2 py-1.5 text-xs focus:border-blue-400 focus:ring-1 focus:ring-blue-200 transition-colors">
                      <option value="">{t("admin.insImportColumnNone")}</option>
                      {headerRow.map((h, i) => (
                        <option key={i} value={i}>{h.trim() || `Column ${i + 1}`}</option>
                      ))}
                    </select>
                  </div>
                ))}
              </div>
            </div>

            <div className="bg-slate-50 border border-slate-200 rounded-lg p-3 flex items-center justify-between text-xs flex-wrap gap-2">
              <span className="font-semibold text-slate-700">{t("admin.insImportValidCount", { count: preview.rows.length })}</span>
              {preview.skipped.length > 0 && (
                <button onClick={() => setShowSkipped((v) => !v)} className="text-blue-700 font-semibold hover:underline">
                  {t("admin.insImportSkippedCount", { count: preview.skipped.length })}
                </button>
              )}
            </div>

            {showSkipped && preview.skipped.length > 0 && (
              <div className="border border-slate-100 rounded-lg max-h-32 overflow-y-auto">
                <table className="w-full text-[10px]">
                  <tbody className="divide-y divide-slate-50">
                    {preview.skipped.slice(0, 50).map((s) => (
                      <tr key={s.rowNumber}>
                        <td className="px-2 py-1 text-slate-400 whitespace-nowrap">{t("admin.insImportRowLabel", { row: s.rowNumber })}</td>
                        <td className="px-2 py-1 text-slate-500">{s.reason}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}

            {preview.rows.length > 0 && (
              <div className="border border-slate-100 rounded-lg overflow-x-auto max-h-48 overflow-y-auto">
                <table className="w-full text-[10px]">
                  <thead className="bg-slate-50 sticky top-0">
                    <tr>
                      <th className="text-left px-2 py-1.5 font-semibold text-slate-500">{t("admin.insImportPreviewName")}</th>
                      <th className="text-left px-2 py-1.5 font-semibold text-slate-500">{t("admin.insImportPreviewGeneric")}</th>
                      <th className="text-left px-2 py-1.5 font-semibold text-slate-500">{t("admin.insImportPreviewUnit")}</th>
                      <th className="text-right px-2 py-1.5 font-semibold text-slate-500">{t("admin.insImportPreviewPrice")}</th>
                    </tr>
                  </thead>
                  <tbody className="divide-y divide-slate-50">
                    {preview.rows.slice(0, 8).map((r, i) => (
                      <tr key={i}>
                        <td className="px-2 py-1 text-slate-700">{r.productName}</td>
                        <td className="px-2 py-1 text-slate-500">{r.genericName ?? "—"}</td>
                        <td className="px-2 py-1 text-slate-500">{r.unit}</td>
                        <td className="px-2 py-1 text-right text-slate-700 font-mono">{r.price.toLocaleString()}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}

            <div className="flex justify-between gap-2 pt-2">
              <button onClick={() => setStep("upload")} className="flex items-center gap-1.5 px-4 py-2 text-sm border border-slate-200 text-slate-500 rounded-lg hover:bg-slate-50 transition-colors">
                <ArrowLeft className="w-3.5 h-3.5" /> {t("admin.insImportBack")}
              </button>
              <button onClick={() => void submit()} disabled={busy || preview.rows.length === 0}
                className="flex items-center gap-2 px-4 py-2 text-sm bg-blue-600 text-white rounded-lg hover:bg-blue-700 transition-colors disabled:opacity-60">
                {busy ? <RefreshCw className="w-3.5 h-3.5 animate-spin" /> : <Upload className="w-3.5 h-3.5" />}
                {t("admin.insImportConfirmButton", { count: preview.rows.length })}
              </button>
            </div>
          </div>
        )}

        {step === "result" && result && (
          <div className="space-y-4">
            <div className="flex items-center gap-2 text-blue-700">
              <CheckCircle2 className="w-5 h-5" />
              <p className="text-sm font-semibold">{t("admin.insImportSuccess")}</p>
            </div>
            <div className="grid grid-cols-2 gap-2 text-xs">
              <div className="bg-slate-50 rounded-lg px-3 py-2"><span className="block text-slate-400">{t("admin.insImportResultNewProducts")}</span><span className="font-bold text-slate-700">{result.createdProducts}</span></div>
              <div className="bg-slate-50 rounded-lg px-3 py-2"><span className="block text-slate-400">{t("admin.insImportResultUpdatedProducts")}</span><span className="font-bold text-slate-700">{result.updatedProducts}</span></div>
              <div className="bg-slate-50 rounded-lg px-3 py-2"><span className="block text-slate-400">{t("admin.insImportResultNewVariants")}</span><span className="font-bold text-slate-700">{result.createdVariants}</span></div>
              <div className="bg-slate-50 rounded-lg px-3 py-2"><span className="block text-slate-400">{t("admin.insImportResultPrices")}</span><span className="font-bold text-slate-700">{result.pricesSet}</span></div>
            </div>
            <div className="flex justify-end pt-2">
              <button onClick={onClose} className="px-4 py-2 text-sm bg-blue-600 text-white rounded-lg hover:bg-blue-700 transition-colors">{t("admin.insImportDone")}</button>
            </div>
          </div>
        )}
      </div>
    </Modal>
  );
}

function InsuranceView() {
  const { t } = useTranslation();
  const [providers, setProviders] = useState<InsuranceProvider[]>([]);
  const [taxRates, setTaxRates] = useState<TaxRate[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const [showAdd, setShowAdd] = useState(false);
  const [editing, setEditing] = useState<InsuranceProvider | null>(null);
  const [managing, setManaging] = useState<InsuranceProvider | null>(null);
  const [importing, setImporting] = useState<InsuranceProvider | null>(null);

  const refresh = useCallback(async () => {
    setLoading(true);
    setError("");
    try {
      const [providerList, rates] = await Promise.all([adminLoadInsuranceProviders(), adminListTaxRates()]);
      setProviders(providerList);
      setTaxRates(rates);
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : t("admin.insLoadError"));
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => { void refresh(); }, [refresh]);
  const { visible: pagedProviders, hasMore, showMore, shown, total } = usePagedList(providers, []);

  return (
    <div className="space-y-6">
      <div className="flex items-start justify-between gap-4 flex-wrap">
        <div>
          <h2 className="text-xl font-bold text-slate-800">{t("admin.insHeading")}</h2>
          <p className="text-xs text-slate-400 mt-0.5">{t("admin.insProviderCount", { count: providers.length })}</p>
        </div>
        <button onClick={() => setShowAdd(true)}
          className="flex items-center gap-1.5 px-3 py-2 text-xs font-semibold bg-blue-600 text-white rounded-lg hover:bg-blue-700 transition-colors">
          <Plus className="w-3.5 h-3.5" /> {t("admin.insAddButton")}
        </button>
      </div>

      {error && <div className="bg-red-50 border border-red-200 text-red-700 text-xs rounded-lg px-3 py-2">{error}</div>}

      <div className="bg-white rounded-xl border border-blue-100 shadow-sm overflow-hidden">
        <div className="overflow-x-auto">
          <table className="w-full text-xs">
            <thead>
              <tr className="bg-slate-50 border-b border-slate-100">
                {([["admin.insColProvider", 0], ["admin.insColTin", 1], ["admin.insColDefaultCoverage", 2], ["admin.insColContact", 3], [null, 4]] as const).map(([key, i]) => (
                  <th key={i} className="text-left px-4 py-3 font-semibold text-slate-500 text-[10px] uppercase tracking-wide whitespace-nowrap">{key ? t(key) : ""}</th>
                ))}
              </tr>
            </thead>
            <tbody className="divide-y divide-slate-50">
              {pagedProviders.map((p) => (
                <tr key={p.id} className="hover:bg-blue-50/30 transition-colors">
                  <td className="px-4 py-3 font-semibold text-slate-700">{p.name}</td>
                  <td className="px-4 py-3 text-slate-500 font-mono">{p.tin || "—"}</td>
                  <td className="px-4 py-3 text-slate-500">{p.defaultCoveragePercentage}%</td>
                  <td className="px-4 py-3 text-slate-500">{p.contactInfo || "—"}</td>
                  <td className="px-4 py-3">
                    <div className="flex items-center justify-end gap-3">
                      <button onClick={() => setImporting(p)} className="text-xs font-semibold text-blue-700 hover:underline">{t("admin.insImportButton")}</button>
                      <button onClick={() => setManaging(p)} className="text-xs font-semibold text-blue-700 hover:underline">{t("admin.insManageCoverage")}</button>
                      <button onClick={() => setEditing(p)} className="text-xs font-semibold text-slate-500 hover:underline">{t("admin.insEdit")}</button>
                    </div>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
          {!loading && providers.length === 0 && (
            <p className="text-center py-10 text-xs text-slate-400">{t("admin.insEmpty")}</p>
          )}
        </div>
        <LoadMoreButton hasMore={hasMore} shown={shown} total={total} onClick={showMore} />
      </div>

      {showAdd && <ProviderFormModal onClose={() => setShowAdd(false)} onSaved={() => { setShowAdd(false); void refresh(); }} />}
      {editing && <ProviderFormModal provider={editing} onClose={() => setEditing(null)} onSaved={() => { setEditing(null); void refresh(); }} />}
      {managing && <ManageCoverageModal provider={managing} onClose={() => setManaging(null)} />}
      {importing && (
        <ImportPriceListModal provider={importing} taxRates={taxRates} onClose={() => setImporting(null)} onImported={() => void refresh()} />
      )}
    </div>
  );
}

// ── Product Requests ────────────────────────────────────────────────────────
// A branch that can't find a product while receiving stock sends a free-text
// message (with an optional photo) instead of filling in a structured form
// (see StockReceivingPage.tsx's "Request a new product"). Approving here is
// where the admin turns that message into a real, structured catalogue
// entry — name, variants, tax — using the message/photo as their reference.

function ApproveRequestModal({ request, taxRates, onClose, onApproved }: {
  request: AdminProductRequestRow; taxRates: TaxRate[]; onClose: () => void; onApproved: () => void;
}) {
  const { t } = useTranslation();
  const [name, setName] = useState("");
  const [genericName, setGenericName] = useState("");
  const [productType, setProductType] = useState("medicine");
  const [taxRateId, setTaxRateId] = useState(taxRates.find((r) => r.rate_percentage === 0)?.id ?? taxRates[0]?.id ?? "");
  const [variants, setVariants] = useState<ProductVariantInput[]>([{}]);
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);

  async function submit() {
    if (!name.trim()) { setError(t("admin.productNameRequired")); return; }
    if (!taxRateId) { setError(t("admin.selectTaxRate")); return; }
    setBusy(true);
    setError("");
    try {
      await adminApproveProductRequest({
        requestId: request.id, productName: name.trim(), genericName: genericName.trim() || undefined,
        productType, taxRateId, variants,
      });
      onApproved();
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : "Could not approve this request.");
    } finally {
      setBusy(false);
    }
  }

  return (
    <Modal title={t("admin.approveRequest")} onClose={onClose}>
      <div className="space-y-3">
        {error && <p className="text-xs text-red-600">{error}</p>}
        <p className="text-xs text-slate-500">{t("admin.approveRequestIntro", { branch: request.branch_name })}</p>
        <div className="bg-slate-50 border border-slate-200 rounded-lg p-3 flex gap-3">
          {request.image_path && (
            <img src={productRequestImageUrl(request.image_path)} alt="" className="w-16 h-16 rounded-lg object-cover shrink-0" />
          )}
          <p className="text-xs text-slate-600 leading-relaxed">{request.message}</p>
        </div>
        <div>
          <label className="text-xs font-semibold text-slate-600 block mb-1">{t("admin.productName")}</label>
          <input value={name} onChange={(e) => setName(e.target.value)}
            className="w-full border border-slate-200 rounded-lg px-3 py-2 text-sm focus:border-blue-400 focus:ring-1 focus:ring-blue-200 transition-colors" />
        </div>
        <div className="grid grid-cols-2 gap-3">
          <div>
            <label className="text-xs font-semibold text-slate-600 block mb-1">{t("admin.genericName")}</label>
            <input value={genericName} onChange={(e) => setGenericName(e.target.value)}
              className="w-full border border-slate-200 rounded-lg px-3 py-2 text-sm focus:border-blue-400 focus:ring-1 focus:ring-blue-200 transition-colors" />
          </div>
          <div>
            <label className="text-xs font-semibold text-slate-600 block mb-1">{t("admin.productType")}</label>
            <select value={productType} onChange={(e) => setProductType(e.target.value)}
              className="w-full border border-slate-200 rounded-lg px-3 py-2 text-sm focus:border-blue-400 focus:ring-1 focus:ring-blue-200 transition-colors">
              <option value="medicine">{t("admin.productTypeMedicine")}</option>
              <option value="supply">{t("admin.productTypeSupply")}</option>
              <option value="other">{t("admin.productTypeOther")}</option>
            </select>
          </div>
        </div>
        <div>
          <label className="text-xs font-semibold text-slate-600 block mb-1">{t("admin.taxRate")}</label>
          <select value={taxRateId} onChange={(e) => setTaxRateId(e.target.value)}
            className="w-full border border-slate-200 rounded-lg px-3 py-2 text-sm focus:border-blue-400 focus:ring-1 focus:ring-blue-200 transition-colors">
            {taxRates.map((rate) => (
              <option key={rate.id} value={rate.id}>{rate.name} ({rate.rate_percentage}%)</option>
            ))}
          </select>
        </div>
        <VariantEditor variants={variants} onChange={setVariants} />
        <div className="flex justify-end gap-2 pt-2">
          <button onClick={onClose} className="px-4 py-2 text-sm border border-slate-200 text-slate-500 rounded-lg hover:bg-slate-50 transition-colors">{t("admin.cancel")}</button>
          <button onClick={() => void submit()} disabled={busy}
            className="flex items-center gap-2 px-4 py-2 text-sm bg-blue-600 text-white rounded-lg hover:bg-blue-700 transition-colors disabled:opacity-60">
            {busy ? <RefreshCw className="w-3.5 h-3.5 animate-spin" /> : <CheckCircle2 className="w-3.5 h-3.5" />}
            {t("admin.approveRequest")}
          </button>
        </div>
      </div>
    </Modal>
  );
}

function RejectRequestModal({ request, onClose, onRejected }: { request: AdminProductRequestRow; onClose: () => void; onRejected: () => void }) {
  const { t } = useTranslation();
  const [reason, setReason] = useState("");
  const [busy, setBusy] = useState(false);

  async function submit() {
    setBusy(true);
    try {
      await adminRejectProductRequest(request.id, reason);
      onRejected();
    } catch (caught) {
      window.alert(caught instanceof Error ? caught.message : "Could not reject this request.");
    } finally {
      setBusy(false);
    }
  }

  return (
    <Modal title={t("admin.rejectRequest")} onClose={onClose}>
      <div className="space-y-4">
        <p className="text-sm text-slate-600">{t("admin.rejectRequestConfirm", { product: request.message.length > 60 ? `${request.message.slice(0, 60)}…` : request.message })}</p>
        <div>
          <label className="text-xs font-semibold text-slate-600 block mb-1">{t("admin.reasonOptional")}</label>
          <textarea value={reason} onChange={(e) => setReason(e.target.value)} rows={3}
            className="w-full border border-slate-200 rounded-lg px-3 py-2 text-sm text-slate-700 resize-none focus:border-blue-400 focus:ring-1 focus:ring-blue-200 transition-colors" />
        </div>
        <div className="flex justify-end gap-2">
          <button onClick={onClose} className="px-4 py-2 text-sm border border-slate-200 text-slate-500 rounded-lg hover:bg-slate-50 transition-colors">{t("admin.cancel")}</button>
          <button onClick={() => void submit()} disabled={busy}
            className="flex items-center gap-2 px-4 py-2 text-sm bg-red-600 text-white rounded-lg hover:bg-red-700 transition-colors disabled:opacity-60">
            <Ban className="w-3.5 h-3.5" /> {t("admin.rejectRequest")}
          </button>
        </div>
      </div>
    </Modal>
  );
}

function ProductRequestsView() {
  const { t } = useTranslation();
  const [requests, setRequests] = useState<AdminProductRequestRow[]>([]);
  const [taxRates, setTaxRates] = useState<TaxRate[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const [approveTarget, setApproveTarget] = useState<AdminProductRequestRow | null>(null);
  const [rejectTarget, setRejectTarget] = useState<AdminProductRequestRow | null>(null);

  const refresh = useCallback(async () => {
    setLoading(true);
    setError("");
    try {
      const [list, rates] = await Promise.all([adminListProductRequests(), adminListTaxRates()]);
      setRequests(list);
      setTaxRates(rates);
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : "Could not load product requests.");
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => { void refresh(); }, [refresh]);

  const pending = requests.filter((r) => r.status === "pending");
  const resolvedAll = requests.filter((r) => r.status !== "pending");
  const { visible: resolved, hasMore: hasMoreResolved, showMore: showMoreResolved, shown: shownResolved, total: totalResolved } = usePagedList(resolvedAll, []);

  return (
    <div className="space-y-6">
      <div>
        <h2 className="text-xl font-bold text-slate-800">{t("admin.productRequests")}</h2>
        <p className="text-xs text-slate-400 mt-0.5">{t(pending.length !== 1 ? "admin.requestsAwaitingPlural" : "admin.requestsAwaitingSingular", { count: pending.length })}</p>
      </div>

      {error && <div className="bg-red-50 border border-red-200 text-red-700 text-xs rounded-lg px-3 py-2">{error}</div>}

      {pending.length === 0 && !loading ? (
        <div className="bg-white rounded-xl border border-blue-100 p-12 text-center">
          <CheckCircle2 className="w-10 h-10 text-blue-400 mx-auto mb-3" />
          <p className="text-sm text-slate-500">{t("admin.allCaughtUp")}</p>
        </div>
      ) : (
        <div className="space-y-3">
          {pending.map((r) => (
            <div key={r.id} className="bg-white rounded-xl border border-blue-100 shadow-sm p-5 hover:border-blue-300 transition-colors">
              <div className="flex items-start justify-between gap-4 flex-wrap">
                <div className="flex gap-3 min-w-0 flex-1">
                  {r.image_path && (
                    <img src={productRequestImageUrl(r.image_path)} alt="" className="w-14 h-14 rounded-lg object-cover shrink-0 border border-slate-100" />
                  )}
                  <div className="space-y-1 min-w-0">
                    <span className="font-mono text-[10px] text-slate-400">{timeAgo(r.created_at)}</span>
                    <p className="text-sm text-slate-800 leading-relaxed">{r.message}</p>
                    <p className="text-[11px] text-slate-400">{r.branch_name} · {r.requested_by_name}</p>
                  </div>
                </div>
                <div className="flex flex-col gap-2">
                  <button onClick={() => setRejectTarget(r)}
                    className="flex items-center gap-1.5 px-3 py-1.5 text-xs font-medium border border-red-200 text-red-600 rounded-lg hover:bg-red-50 transition-colors">
                    <Ban className="w-3.5 h-3.5" /> {t("admin.deny")}
                  </button>
                  <button onClick={() => setApproveTarget(r)}
                    className="flex items-center gap-1.5 px-3 py-1.5 text-xs font-medium bg-blue-600 text-white rounded-lg hover:bg-blue-700 transition-colors">
                    <CheckCircle2 className="w-3.5 h-3.5" /> {t("admin.approveRequest")}
                  </button>
                </div>
              </div>
            </div>
          ))}
        </div>
      )}

      {resolvedAll.length > 0 && (
        <div>
          <p className="text-[10px] font-mono text-slate-400 uppercase tracking-widest mb-3">{t("admin.processed")}</p>
          <div className="space-y-2">
            {resolved.map((r) => (
              <div key={r.id} className="bg-white rounded-lg border border-slate-100 px-4 py-3 flex items-center justify-between gap-4 flex-wrap">
                <div className="min-w-0">
                  <p className="text-sm font-medium text-slate-700 truncate max-w-md">{r.message}</p>
                  <p className="text-[10px] text-slate-400">{r.branch_name}</p>
                </div>
                <span className={`text-[10px] font-semibold uppercase tracking-wide px-2 py-0.5 rounded-md border ${
                  r.status === "approved" ? "bg-blue-100 text-blue-700 border-blue-200" : "bg-red-100 text-red-700 border-red-200"
                }`}>
                  {r.status === "approved" ? t("admin.statusApproved") : t("admin.statusDenied")}
                </span>
              </div>
            ))}
          </div>
          <LoadMoreButton hasMore={hasMoreResolved} shown={shownResolved} total={totalResolved} onClick={showMoreResolved} />
        </div>
      )}

      {approveTarget && (
        <ApproveRequestModal
          request={approveTarget}
          taxRates={taxRates}
          onClose={() => setApproveTarget(null)}
          onApproved={() => { setApproveTarget(null); void refresh(); }}
        />
      )}
      {rejectTarget && (
        <RejectRequestModal
          request={rejectTarget}
          onClose={() => setRejectTarget(null)}
          onRejected={() => { setRejectTarget(null); void refresh(); }}
        />
      )}
    </div>
  );
}

// ── Admin sign-in gate ─────────────────────────────────────────────────────────
// Route guard: no dashboard data is fetched until a real super-admin session
// exists. The RPCs (admin_list_pharmacy_applications, etc.) already reject a
// non-admin caller server-side, but until this gate existed the UI never even
// asked for credentials — anyone opening #admin saw the dashboard shell.

function AdminAuthGate({ onAuthed }: { onAuthed: (email: string) => void }) {
  const { t } = useTranslation();
  const [step, setStep] = useState<"email" | "otp">("email");
  const [email, setEmail] = useState("");
  const [otp, setOtp] = useState(["", "", "", "", "", ""]);
  const [error, setError] = useState("");
  const [sending, setSending] = useState(false);
  const [verifying, setVerifying] = useState(false);

  async function sendCode() {
    if (!email.trim()) { setError(t("admin.enterEmailError")); return; }
    setSending(true);
    setError("");
    try {
      await requestAdminOtp(email.trim());
      setStep("otp");
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : t("admin.couldNotSendCode"));
    } finally {
      setSending(false);
    }
  }

  async function verify() {
    const token = otp.join("");
    if (token.length < 6) { setError(t("admin.enterFullCodeError")); return; }
    setVerifying(true);
    setError("");
    try {
      await verifyAdminOtp(email.trim(), token);
      onAuthed(email.trim());
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : t("admin.incorrectCodeError"));
    } finally {
      setVerifying(false);
    }
  }

  function setDigit(i: number, v: string) {
    if (!/^[0-9]?$/.test(v)) return;
    const next = [...otp]; next[i] = v; setOtp(next); setError("");
    if (v && i < 5) document.getElementById(`admin-otp-${i + 1}`)?.focus();
  }

  return (
    <div className="min-h-screen flex items-center justify-center bg-gradient-to-br from-blue-50 via-white to-sky-50 px-4">
      <div className="w-full max-w-sm">
        <div className="flex items-center justify-between mb-4">
          <a href="#" onClick={(e) => { e.preventDefault(); backToHome(); }}
            className="inline-flex items-center gap-1.5 text-xs font-semibold text-slate-500 hover:text-blue-600 transition-colors">
            <ArrowLeft className="w-3.5 h-3.5" /> {t("common.backToPharmSync")}
          </a>
          <LanguageSwitcher />
        </div>
      <div className="w-full bg-white rounded-2xl border border-blue-100 shadow-sm p-7">
        {/* Same mark the branch sign-in shows, so both doors into the product
            look like the same product. */}
        <div className="mb-5">
          <Logo size={40} />
        </div>
        <h1 className="font-bold text-slate-800 text-lg mb-1">{t("admin.gateTitle")}</h1>
        <p className="text-xs text-slate-500 mb-5">{t("admin.gateSubtitle")}</p>

        {step === "email" ? (
          <div className="space-y-3">
            <input
              type="email" value={email} onChange={(e) => { setEmail(e.target.value); setError(""); }}
              placeholder={t("admin.adminEmailPlaceholder")}
              className="w-full border border-slate-200 rounded-lg px-3 py-2.5 text-sm focus:border-blue-400 focus:ring-1 focus:ring-blue-200 transition-colors"
            />
            {error && <p className="text-xs text-red-600">{error}</p>}
            <button onClick={() => void sendCode()} disabled={sending}
              className="w-full flex items-center justify-center gap-2 px-4 py-2.5 text-sm bg-blue-600 text-white rounded-lg hover:bg-blue-700 transition-colors disabled:opacity-60">
              {sending ? <RefreshCw className="w-3.5 h-3.5 animate-spin" /> : null}
              {sending ? t("admin.sending") : t("admin.sendCode")}
            </button>
          </div>
        ) : (
          <div className="space-y-3">
            <p className="text-xs text-slate-500">{t("admin.enterCodeInstructions", { email })}</p>
            <div className="flex gap-2 justify-between">
              {otp.map((digit, i) => (
                <input
                  key={i} id={`admin-otp-${i}`} value={digit} maxLength={1} inputMode="numeric"
                  onChange={(e) => setDigit(i, e.target.value)}
                  onKeyDown={(e) => { if (e.key === "Backspace" && !otp[i] && i > 0) document.getElementById(`admin-otp-${i - 1}`)?.focus(); }}
                  className="w-10 h-12 text-center text-lg font-bold border border-slate-200 rounded-lg focus:border-blue-400 focus:ring-1 focus:ring-blue-200 transition-colors"
                />
              ))}
            </div>
            {error && <p className="text-xs text-red-600">{error}</p>}
            <button onClick={() => void verify()} disabled={verifying}
              className="w-full flex items-center justify-center gap-2 px-4 py-2.5 text-sm bg-blue-600 text-white rounded-lg hover:bg-blue-700 transition-colors disabled:opacity-60">
              {verifying ? <RefreshCw className="w-3.5 h-3.5 animate-spin" /> : null}
              {verifying ? t("admin.verifying") : t("admin.verifyAndSignIn")}
            </button>
            <button onClick={() => { setStep("email"); setOtp(["", "", "", "", "", ""]); setError(""); }}
              className="w-full text-xs text-slate-400 hover:text-slate-600 transition-colors">{t("admin.useDifferentEmail")}</button>
          </div>
        )}
      </div>
      </div>
    </div>
  );
}

// ── Main AdminPortal ──────────────────────────────────────────────────────────

const NAV: { id: NavId; labelKey: TranslationKey; icon: React.ReactNode }[] = [
  { id: "dashboard", labelKey: "admin.navDashboard", icon: <LayoutDashboard className="w-4 h-4" /> },
  { id: "approvals", labelKey: "admin.navApprovals", icon: <CheckSquare className="w-4 h-4" /> },
  { id: "branches",  labelKey: "admin.navBranches",  icon: <Users className="w-4 h-4" /> },
  { id: "organizations", labelKey: "admin.navOrganizations", icon: <Building2 className="w-4 h-4" /> },
  { id: "products",  labelKey: "admin.navProducts",  icon: <Package className="w-4 h-4" /> },
  { id: "categories", labelKey: "admin.navCategories", icon: <Tag className="w-4 h-4" /> },
  { id: "productRequests", labelKey: "admin.navProductRequests", icon: <Plus className="w-4 h-4" /> },
  { id: "insurance", labelKey: "admin.navInsurance", icon: <Percent className="w-4 h-4" /> },
  { id: "security",  labelKey: "admin.navSecurity",  icon: <ShieldAlert className="w-4 h-4" /> },
  { id: "tickets",   labelKey: "admin.navTickets",   icon: <Ticket className="w-4 h-4" /> },
];

export default function AdminPortal() {
  const { t } = useTranslation();
  const [authChecked, setAuthChecked] = useState(false);
  const [authed, setAuthed]           = useState(false);
  const [adminEmail, setAdminEmail]   = useState("");
  const [nav, setNav]             = useState<NavId>("dashboard");
  const [branches, setBranches]   = useState<BranchRecord[]>([]);
  const [orgApplications, setOrgApplications] = useState<OrganizationApplicationRecord[]>([]);
  // admin_list_pharmacy_applications()'s join (the `branches` state above)
  // only ever surfaces branches that came through the old pharmacy-
  // application flow -- a branch created via the organization flow
  // (register_first_branch()/add_branch_to_organization()) has no
  // application row at all, so it would otherwise be invisible anywhere in
  // this console. Filtered to organization-owned branches only, since
  // pharmacy-flow branches are already covered by `branches` above.
  const [orgBranches, setOrgBranches] = useState<AllBranchRecord[]>([]);
  const [organizations, setOrganizations] = useState<AdminOrganizationRecord[]>([]);
  const [tickets, setTickets]     = useState<AdminTicketRow[]>([]);
  const [pendingRequestCount, setPendingRequestCount] = useState(0);
  const [sidebarOpen, setSidebarOpen] = useState(false);
  const [platformStats, setPlatformStats] = useState<AdminPlatformStats | null>(null);
  const [patientsSeries, setPatientsSeries] = useState<AdminPatientsTimeSeriesPoint[]>([]);
  const [patientsInterval, setPatientsInterval] = useState<AdminStatsInterval>("day");

  useEffect(() => {
    void isSuperAdminSession().then((ok) => { setAuthed(ok); setAuthChecked(true); });
  }, []);

  const [expiredCount, setExpiredCount] = useState(0);

  const refresh = useCallback(async () => {
    try {
      // Applications nobody approved inside 7 days are deleted server-side.
      // Swept before the lists are read so the console never shows a row
      // that has already aged out. Both the old pharmacy-application flow
      // and the new organization-first flow can still have stale pending
      // rows -- old standalone branches keep working through the pharmacy
      // flow untouched, so both sweeps/lists run side by side rather than
      // one replacing the other.
      const [expired, orgExpired] = await Promise.all([
        expireStaleApplications().catch(() => 0),
        expireStaleOrganizationApplications().catch(() => 0),
      ]);
      // Each list is settled independently on purpose. One failing RPC --
      // most often a migration that has not been applied to this project
      // yet -- must never blank the whole console, and (see the check
      // below) must never be mistaken for a lost session.
      const [apps, orgApps, allBranchRows, orgRows, ticketRows, requestRows, stats, series] = await Promise.all([
        listPharmacyApplications().catch(() => null),
        listOrganizationApplications().catch(() => null),
        adminListAllBranches().catch(() => null),
        adminListOrganizations().catch(() => null),
        adminListSupportTickets().catch(() => null),
        adminListProductRequests().catch(() => null),
        adminPlatformStats().catch(() => null),
        adminPatientsTimeSeries(patientsInterval, PATIENTS_SERIES_PERIODS[patientsInterval]).catch(() => null),
      ]);
      setExpiredCount(expired + orgExpired);
      if (apps) setBranches(apps);
      if (orgApps) setOrgApplications(orgApps);
      if (allBranchRows) setOrgBranches(allBranchRows.filter((b) => b.organizationId));
      if (orgRows) setOrganizations(orgRows);
      if (ticketRows) setTickets(ticketRows);
      if (requestRows) setPendingRequestCount(requestRows.filter((r) => r.status === "pending").length);
      if (stats) setPlatformStats(stats);
      if (series) setPatientsSeries(series);

      // Only an actually-lost session drops back to the gate, and only
      // after re-asking the server. This used to be a regex for /admin/i
      // on the error message, which matched the NAME of any admin_* RPC --
      // so one missing function (admin_list_organizations, before its
      // migration was applied) read as "not an admin anymore" and signed
      // the user out seconds after every sign-in, with nothing on screen
      // explaining why.
      if (!apps && !allBranchRows && !ticketRows && !(await isSuperAdminSession())) setAuthed(false);
    } catch {
      // Unexpected/transport failure -- keep whatever is already on screen
      // rather than throwing the admin out; the 3s poll retries anyway.
    }
  }, [patientsInterval]);

  useEffect(() => { if (authed) void refresh(); }, [authed, refresh]);

  // Poll every 3 seconds so admin sees branch submissions live
  useEffect(() => {
    if (!authed) return;
    const t = setInterval(() => void refresh(), 3000);
    return () => clearInterval(t);
  }, [authed, refresh]);

  function handleSignOut() {
    void signOutAdmin();
    setAuthed(false);
    setAuthChecked(true);
    setAdminEmail("");
  }

  if (!authChecked) {
    return <div className="min-h-screen flex items-center justify-center bg-[var(--bg)]"><RefreshCw className="w-5 h-5 text-blue-500 animate-spin" /></div>;
  }
  if (!authed) {
    return <AdminAuthGate onAuthed={(email) => { setAuthed(true); setAdminEmail(email); }} />;
  }

  const pending   = branches.filter((b) => b.status === "pending").length;
  const locked    = branches.filter((b) => b.status === "locked").length;
  const openTix   = tickets.filter((tk) => tk.status === "open").length;
  const badges: Partial<Record<NavId, number>> = {
    approvals: pending, security: locked, tickets: openTix, productRequests: pendingRequestCount,
  };

  return (
    <div className="flex h-screen overflow-hidden bg-[var(--bg)]">
      {sidebarOpen && (
        <div className="fixed inset-0 z-20 bg-black/30 lg:hidden" onClick={() => setSidebarOpen(false)} />
      )}

      {/* Sidebar */}
      <aside className={`fixed lg:static z-30 flex flex-col w-60 h-full bg-white border-r border-blue-100 shadow-sm transition-transform lg:translate-x-0 ${sidebarOpen ? "translate-x-0" : "-translate-x-full"}`}>
        <div className="px-5 py-5 border-b border-blue-100">
          {/* Shared brand mark. This used to be a ShieldAlert glyph beside the
              name "PharmacySync" -- a third logo AND a third spelling, against
              "PharmSync" on the home page and in the pharmacy dashboard. */}
          <div className="flex items-center gap-3">
            <Logo size={36} showWordmark={false} />
            <div>
              <p className="font-bold text-sm" style={{ fontFamily: "var(--font-display)", color: "var(--ink)" }}>
                Pharm<span style={{ color: "var(--primary)" }}>Sync</span>
              </p>
              <p className="text-[10px]" style={{ fontFamily: "var(--font-mono)", color: "var(--primary)" }}>{t("admin.brandSuperAdmin")}</p>
            </div>
          </div>
        </div>

        <nav className="flex-1 py-3 px-3 space-y-0.5 overflow-y-auto">
          {NAV.map((item) => (
            <button key={item.id}
              onClick={() => { setNav(item.id); setSidebarOpen(false); }}
              className={`w-full flex items-center justify-between gap-2.5 px-3 py-2.5 rounded-xl text-sm transition-colors ${
                nav === item.id
                  ? "bg-blue-600 text-white shadow-sm shadow-blue-200"
                  : "text-slate-600 hover:bg-blue-50 hover:text-blue-700"
              }`}>
              <span className="flex items-center gap-2.5 font-medium">
                {item.icon}
                {t(item.labelKey)}
              </span>
              {badges[item.id] ? (
                <span className={`text-[10px] font-bold px-1.5 py-0.5 rounded-full min-w-[18px] text-center ${
                  nav === item.id ? "bg-white/30 text-white" : "bg-blue-100 text-blue-700"
                }`}>
                  {badges[item.id]}
                </span>
              ) : null}
            </button>
          ))}
        </nav>

        {/* Language switcher lives in the sidebar (not the top bar) — the
            top bar in the branch dashboard was already found to clip
            controls appended after its crowded flex row, so this control
            gets its own guaranteed-visible spot instead. */}
        <div className="px-4 pb-3">
          <LanguageSwitcher />
        </div>

        <div className="px-4 py-4 border-t border-blue-100">
          <div className="flex items-center gap-2.5 bg-blue-50 rounded-xl p-2.5">
            <div className="w-8 h-8 bg-blue-600 rounded-lg flex items-center justify-center shrink-0">
              <span className="text-white text-[10px] font-bold">SA</span>
            </div>
            <div className="min-w-0 flex-1">
              <p className="text-xs font-semibold text-slate-700">{t("admin.brandSuperAdmin")}</p>
              <p className="text-[10px] text-slate-400 font-mono truncate">{adminEmail || "signed in"}</p>
            </div>
            <button onClick={handleSignOut} title={t("admin.signOutTitle")} className="shrink-0 text-slate-400 hover:text-red-600 transition-colors">
              <XCircle className="w-4 h-4" />
            </button>
          </div>
        </div>
      </aside>

      {/* Main */}
      <div className="flex-1 flex flex-col min-w-0 overflow-hidden">
        <header className="flex items-center justify-between px-4 lg:px-6 py-3.5 bg-white border-b border-blue-100 shadow-sm shrink-0">
          <div className="flex items-center gap-3">
            <button className="lg:hidden text-slate-500 hover:text-slate-700 transition-colors" onClick={() => setSidebarOpen(true)}>
              <svg className="w-5 h-5" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M4 6h16M4 12h16M4 18h16" /></svg>
            </button>
            <div>
              <h1 className="font-bold text-slate-800">{t(NAV.find((n) => n.id === nav)?.labelKey ?? "admin.navDashboard")}</h1>
            </div>
          </div>
          <div className="flex items-center gap-3">
            <a href="#" onClick={(e) => { e.preventDefault(); backToHome(); }} className="flex items-center gap-1.5 text-xs font-semibold text-slate-500 hover:text-blue-600 transition-colors">
              <ArrowLeft className="w-3.5 h-3.5" /> <span className="hidden sm:inline">{t("common.backToPharmSync")}</span>
            </a>
            <span className="font-mono text-[10px] text-slate-400 hidden sm:block">{t("admin.version")}</span>
            <div className="flex items-center gap-1.5">
              <span className="w-2 h-2 rounded-full bg-blue-500 animate-pulse" />
              <span className="text-[10px] text-blue-600 font-semibold">{t("admin.live")}</span>
            </div>
          </div>
        </header>

        <main className="flex-1 overflow-y-auto p-4 lg:p-6">
          {/* Centered, capped-width content column -- on a wide screen a
              single-column view (branch/organization edit, detail pages)
              used to sit flush against the sidebar with the whole rest of
              the screen empty, which read as broken/unfinished rather than
              a deliberate layout. Wide grids (stat cards, tables) still
              have plenty of room inside this width. */}
          <div key={nav} className="animate-fade-in max-w-6xl mx-auto w-full">
            {nav === "dashboard" && (
              <Dashboard
                branches={branches} tickets={tickets} platformStats={platformStats}
                patientsSeries={patientsSeries} patientsInterval={patientsInterval}
                onPatientsIntervalChange={setPatientsInterval}
              />
            )}
            {nav === "approvals" && <Approvals applications={orgApplications} orgBranches={orgBranches} onChange={refresh} />}
            {expiredCount > 0 && (
              <div className="rounded-xl border border-amber-200 bg-amber-50 px-4 py-3 text-xs text-amber-800 mb-4">
                {t("admin.expiredSwept", { count: expiredCount })}
              </div>
            )}
            {nav === "branches"  && <BranchDirectory branches={branches} orgBranches={orgBranches} adminEmail={adminEmail} onChange={refresh} />}
            {nav === "organizations" && <OrganizationsView organizations={organizations} orgBranches={orgBranches} onChange={refresh} />}
            {nav === "products"  && <ProductsView />}
            {nav === "categories" && <CategoriesView branches={branches} />}
            {nav === "productRequests" && <ProductRequestsView />}
            {nav === "insurance" && <InsuranceView />}
            {nav === "security"  && <Security branches={branches} onChange={refresh} />}
            {nav === "tickets"   && <TicketsView tickets={tickets} onChange={refresh} />}
          </div>
        </main>
      </div>
    </div>
  );
}
