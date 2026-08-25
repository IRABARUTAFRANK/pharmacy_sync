import { useState, useEffect, useCallback } from "react";
import {
  LayoutDashboard, CheckSquare, Building2, ShieldAlert, Ticket,
  Phone, Mail, MapPin, Clock, AlertTriangle, CheckCircle2, XCircle,
  Lock, Unlock, RefreshCw, ChevronRight, Eye, Send, Bell, Activity,
  Users, TrendingUp, X, Check, ArrowLeft, Trash2, KeyRound, Package, Plus, Ban, Tag, Percent,
} from "lucide-react";
import type { BranchRecord, BranchStatus } from "../lib/store";
import {
  approvePharmacyApplication,
  deleteBranch,
  denyPharmacyApplication,
  isSuperAdminSession,
  listPharmacyApplications,
  markPharmacyCalled,
  requestAdminOtp,
  requestPharmacyOtp,
  setBranchLock,
  signOutAdmin,
  verifyAdminOtp,
} from "../lib/onboarding";
import {
  adminListSupportTickets,
  adminUpdateTicketStatus,
  type AdminTicketRow,
  type TicketStatus,
} from "../lib/tickets";
import {
  adminApproveProductRequest,
  adminCreateCategory,
  adminCreateProduct,
  adminCreateTaxRate,
  adminListCategories,
  adminListProductRequests,
  adminListProducts,
  adminRejectProductRequest,
  adminSetProductTax,
  listTaxRates,
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
  adminSetInsuranceCoverage,
  adminUpdateInsuranceProvider,
  loadCoverageOverridesWithNames,
  loadInsuranceProviders,
  type CoverageOverrideRow,
  type InsuranceProvider,
} from "../lib/sales";
import { Logo } from "../components";
import { useTranslation, LanguageSwitcher } from "../lib/i18n";
import type { TranslationKey } from "../lib/i18n/en";

type NavId = "dashboard" | "approvals" | "branches" | "security" | "tickets" | "products" | "categories" | "productRequests" | "insurance";

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
    active:      "bg-green-100 text-green-700 border-green-200",
    locked:      "bg-orange-100 text-orange-700 border-orange-200",
    denied:      "bg-red-100 text-red-700 border-red-200",
    open:        "bg-red-100 text-red-700 border-red-200",
    in_progress: "bg-blue-100 text-blue-700 border-blue-200",
    resolved:    "bg-green-100 text-green-700 border-green-200",
    closed:      "bg-slate-100 text-slate-600 border-slate-200",
  };
  return (
    <span className={`inline-flex items-center px-2 py-0.5 rounded-md border text-[10px] font-semibold uppercase tracking-wide ${map[status] ?? ""}`}>
      {t(statusLabelKey(status))}
    </span>
  );
}

function StatCard({ icon, label, value, sub, color }: {
  icon: React.ReactNode; label: string; value: number | string;
  sub?: string; color: string;
}) {
  return (
    <div className="bg-white rounded-xl border border-green-100 p-5 shadow-sm">
      <div className={`w-10 h-10 rounded-lg flex items-center justify-center mb-3 ${color}`}>
        {icon}
      </div>
      <p className="text-2xl font-bold text-slate-800">{value}</p>
      <p className="text-xs font-semibold text-slate-600 mt-0.5">{label}</p>
      {sub && <p className="text-[10px] text-slate-400 mt-0.5">{sub}</p>}
    </div>
  );
}

function Modal({ title, onClose, children }: {
  title: string; onClose: () => void; children: React.ReactNode;
}) {
  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 backdrop-blur-sm p-4">
      <div className="bg-white rounded-2xl shadow-xl border border-green-100 w-full max-w-md">
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

function Dashboard({ branches, tickets }: { branches: BranchRecord[]; tickets: AdminTicketRow[] }) {
  const { t } = useTranslation();
  const pending = branches.filter((b) => b.status === "pending").length;
  const active  = branches.filter((b) => b.status === "active").length;
  const locked  = branches.filter((b) => b.status === "locked").length;
  const openTix = tickets.filter((t) => t.status === "open").length;

  const feed = [
    ...branches.map((b) => ({
      time: b.submittedAt,
      icon: <Building2 className="w-3.5 h-3.5 text-green-500" />,
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
        <StatCard icon={<Clock className="w-5 h-5 text-amber-600" />} label={t("admin.pendingApproval")} value={pending} color="bg-amber-50" />
        <StatCard icon={<Activity className="w-5 h-5 text-green-600" />} label={t("admin.activeBranches")} value={active} color="bg-green-50" />
        <StatCard icon={<Lock className="w-5 h-5 text-orange-600" />} label={t("admin.lockedBranchesLabel")} value={locked} color="bg-orange-50" />
        <StatCard icon={<Ticket className="w-5 h-5 text-violet-600" />} label={t("admin.openTicketsLabel")} value={openTix} color="bg-violet-50" />
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

      <div className="bg-white rounded-xl border border-green-100 shadow-sm overflow-hidden">
        <div className="px-5 py-3 border-b border-slate-100 flex items-center gap-2">
          <TrendingUp className="w-4 h-4 text-green-600" />
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
  branches,
  onChange,
}: {
  branches: BranchRecord[];
  onChange: () => void;
}) {
  const { t } = useTranslation();
  const [detailBranch, setDetailBranch] = useState<BranchRecord | null>(null);
  const [action, setAction] = useState<"approve" | "deny" | null>(null);
  const [denyReason, setDenyReason] = useState("");
  const [sendingOtp, setSendingOtp] = useState(false);

  const pending = branches.filter((b) => b.status === "pending");
  const processed = branches.filter((b) => ["otp_sent","active","denied"].includes(b.status));

  async function markCalled(id: string) {
    await markPharmacyCalled(id);
    onChange();
    if (detailBranch?.id === id) setDetailBranch((p) => p ? { ...p, calledAt: new Date().toISOString() } : p);
  }

  async function handleApprove() {
    if (!detailBranch) return;
    setSendingOtp(true);
    try {
      await approvePharmacyApplication(detailBranch.id);
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
      await denyPharmacyApplication(detailBranch.id, denyReason);
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
        <div className="bg-white rounded-xl border border-green-100 p-12 text-center">
          <CheckCircle2 className="w-10 h-10 text-green-400 mx-auto mb-3" />
          <p className="text-sm text-slate-500">{t("admin.allCaughtUp")}</p>
        </div>
      ) : (
        <div className="space-y-3">
          {pending.map((b) => (
            <div key={b.id} className="bg-white rounded-xl border border-green-100 shadow-sm p-5 hover:border-green-300 transition-colors">
              <div className="flex items-start justify-between gap-4 flex-wrap">
                <div className="space-y-1 min-w-0">
                  <div className="flex items-center gap-2 flex-wrap">
                    <span className="font-mono text-[10px] text-slate-400">{b.applicationCode ?? b.id.slice(0, 8)}</span>
                    <Badge status={b.status} />
                    {b.calledAt && (
                      <span className="flex items-center gap-1 text-[10px] text-green-600 font-semibold">
                        <Phone className="w-3 h-3" /> {t("admin.called")}
                      </span>
                    )}
                  </div>
                  <p className="font-bold text-slate-800">{b.pharmacyName}</p>
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
                    className="flex items-center gap-1.5 px-3 py-1.5 text-xs font-medium bg-green-600 text-white rounded-lg hover:bg-green-700 transition-colors disabled:opacity-40 disabled:cursor-not-allowed"
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
                  <p className="text-sm font-medium text-slate-700">{b.pharmacyName}</p>
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

      {/* Approve modal */}
      {detailBranch && action === "approve" && (
        <Modal title={t("admin.approveAndSendOtp")} onClose={() => { setDetailBranch(null); setAction(null); }}>
          <div className="space-y-4">
            <p className="text-sm text-slate-600">
              {t("admin.approvePortalAccessFor")}{" "}
              <span className="font-semibold text-slate-800">{detailBranch.pharmacyName}</span>?
            </p>
            <div className="bg-green-50 border border-green-200 rounded-xl p-3 space-y-1.5 text-xs">
              <p className="font-semibold text-green-800 flex items-center gap-1.5"><Send className="w-3 h-3" /> {t("admin.whatWillHappen")}</p>
              <p className="text-green-700">{t("admin.approveBullet1", { email: detailBranch.email })}</p>
              <p className="text-green-700">{t("admin.approveBullet2")}</p>
              <p className="text-green-700">{t("admin.approveBullet3")}</p>
            </div>
            <div className="flex justify-end gap-2">
              <button onClick={() => { setDetailBranch(null); setAction(null); }}
                className="px-4 py-2 text-sm border border-slate-200 text-slate-500 rounded-lg hover:bg-slate-50 transition-colors">
                {t("admin.cancel")}
              </button>
              <button onClick={handleApprove} disabled={sendingOtp}
                className="flex items-center gap-2 px-4 py-2 text-sm bg-green-600 text-white rounded-lg hover:bg-green-700 transition-colors disabled:opacity-60">
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
              <span className="font-semibold text-slate-800">{detailBranch.pharmacyName}</span>?
            </p>
            <div>
              <label className="text-xs font-semibold text-slate-600 block mb-1">{t("admin.reasonOptional")}</label>
              <textarea
                value={denyReason} onChange={(e) => setDenyReason(e.target.value)}
                rows={3} placeholder={t("admin.enterDenialReason")}
                className="w-full border border-slate-200 rounded-lg px-3 py-2 text-sm text-slate-700 resize-none focus:border-green-400 focus:ring-1 focus:ring-green-200 transition-colors"
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

function BranchDirectory({ branches, adminEmail, onChange }: { branches: BranchRecord[]; adminEmail: string; onChange: () => void }) {
  const { t } = useTranslation();
  const [filter, setFilter] = useState<BranchStatus | "all">("all");
  const [detail, setDetail] = useState<BranchRecord | null>(null);
  const [deleteTarget, setDeleteTarget] = useState<BranchRecord | null>(null);

  const shown = filter === "all" ? branches : branches.filter((b) => b.status === filter);
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
        onDelete={() => { setDeleteTarget(detail); setDetail(null); }}
      >
        {deleteTarget && (
          <DeleteBranchModal
            branch={deleteTarget}
            adminEmail={adminEmail}
            onClose={() => setDeleteTarget(null)}
            onDeleted={() => { setDeleteTarget(null); onChange(); }}
          />
        )}
      </BranchDetailView>
    );
  }

  const colHeaders: TranslationKey[] = [
    "admin.colAppId", "admin.colPharmacy", "admin.colLocation", "admin.colPhone",
    "admin.colBranchCode", "admin.colStatus", "admin.colFailedLogins",
  ];

  return (
    <div className="space-y-6 animate-fade-up">
      <div>
        <h2 className="text-xl font-bold text-slate-800">{t("admin.branchDirectory")}</h2>
        <p className="text-xs text-slate-400 mt-0.5">{t("admin.branchesRegistered", { count: branches.length })}</p>
      </div>

      <div className="flex gap-2 flex-wrap">
        {opts.map((s) => (
          <button key={s} onClick={() => setFilter(s)}
            className={`text-[10px] font-mono uppercase tracking-widest px-3 py-1.5 rounded-lg border transition-colors ${
              filter === s
                ? "border-green-500 text-green-700 bg-green-50"
                : "border-slate-200 text-slate-500 hover:border-green-300"
            }`}>
            {s === "all" ? t("admin.statusAll") : t(statusLabelKey(s))}
          </button>
        ))}
      </div>

      <div className="bg-white rounded-xl border border-green-100 shadow-sm overflow-hidden">
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
              {shown.map((b) => (
                <tr key={b.id} onClick={() => setDetail(b)} className="hover:bg-green-50/30 transition-colors cursor-pointer">
                  <td className="px-4 py-3 font-mono text-slate-400">{b.applicationCode ?? b.id.slice(0, 8)}</td>
                  <td className="px-4 py-3 font-semibold text-slate-700 whitespace-nowrap">{b.pharmacyName}</td>
                  <td className="px-4 py-3 text-slate-500 whitespace-nowrap">{b.location.split(",")[0]}</td>
                  <td className="px-4 py-3 font-mono text-slate-500">{b.phone}</td>
                  <td className="px-4 py-3 font-mono text-green-700 font-semibold">{b.branchCode ?? "—"}</td>
                  <td className="px-4 py-3"><Badge status={b.status} /></td>
                  <td className="px-4 py-3 font-mono">
                    <span className={b.failedLogins >= 5 ? "text-red-500 font-bold" : b.failedLogins >= 3 ? "text-amber-500 font-bold" : "text-slate-400"}>
                      {b.failedLogins}
                    </span>
                  </td>
                  <td className="px-4 py-3">
                    <span className="text-green-600">
                      <Eye className="w-3.5 h-3.5" />
                    </span>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
          {shown.length === 0 && (
            <p className="text-center py-10 text-xs text-slate-400">{t("admin.noBranchesWithStatus", { filter: filter === "all" ? t("admin.statusAll") : t(statusLabelKey(filter)) })}</p>
          )}
        </div>
      </div>
    </div>
  );
}

// Full-page branch detail — replaces the directory table in place (same nav
// tab, same scroll container) with a smooth fade/slide-up entrance, instead
// of interrupting the page with a popup.
function BranchDetailView({
  branch, onBack, onDelete, children,
}: {
  branch: BranchRecord; onBack: () => void; onDelete: () => void; children: React.ReactNode;
}) {
  const { t } = useTranslation();
  const [resending, setResending] = useState(false);
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
        className="flex items-center gap-1.5 text-xs font-semibold text-slate-500 hover:text-green-700 transition-colors">
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
      </div>

      <div className="grid sm:grid-cols-2 lg:grid-cols-4 gap-4">
        {[
          { label: t("admin.fieldPhone"), value: branch.phone, mono: true, icon: <Phone className="w-3.5 h-3.5" /> },
          { label: t("admin.fieldEmail"), value: branch.email, mono: true, icon: <Mail className="w-3.5 h-3.5" /> },
          { label: t("admin.fieldLocation"), value: branch.location, icon: <MapPin className="w-3.5 h-3.5" /> },
          { label: t("admin.fieldFailedLogins"), value: branch.failedLogins, icon: <AlertTriangle className="w-3.5 h-3.5" /> },
          { label: t("admin.fieldBranchCode"), value: branch.branchCode ?? "—", mono: true, icon: <Building2 className="w-3.5 h-3.5" /> },
          { label: t("admin.fieldActivationCode"), value: branch.activationCode ?? "—", mono: true, icon: <KeyRound className="w-3.5 h-3.5" /> },
        ].map((row, i) => (
          <div key={i} className="bg-white rounded-xl border border-green-100 shadow-sm p-4"
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
      await deleteBranch(branch.branchId!);
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
            placeholder="you@pharmsync.rw"
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
          <div className="bg-white rounded-xl border border-green-100 p-10 text-center">
            <ShieldAlert className="w-8 h-8 text-green-300 mx-auto mb-2" />
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
                  className="flex items-center gap-1.5 px-3 py-1.5 text-xs font-medium border border-green-300 text-green-700 rounded-lg hover:bg-green-50 transition-colors">
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
            <div className="bg-green-50 border border-green-200 rounded-xl p-3 text-xs text-green-700">
              {t("admin.releaseConfirmNote", { email: confirmRelease.email })}
            </div>
            <div className="flex justify-end gap-2">
              <button onClick={() => setConfirmRelease(null)} className="px-4 py-2 text-sm border border-slate-200 text-slate-500 rounded-lg hover:bg-slate-50 transition-colors">{t("admin.cancel")}</button>
              <button onClick={() => void release(confirmRelease)} className="flex items-center gap-2 px-4 py-2 text-sm bg-green-600 text-white rounded-lg hover:bg-green-700 transition-colors">
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
        {sorted.map((tk) => (
          <div key={tk.id} onClick={() => setDetail(tk)}
            className="bg-white rounded-xl border border-green-100 shadow-sm p-4 cursor-pointer hover:border-green-300 transition-colors">
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
          <div className="bg-white rounded-xl border border-green-100 p-12 text-center">
            <Ticket className="w-8 h-8 text-green-300 mx-auto mb-2" />
            <p className="text-xs text-slate-400">{t("admin.noSupportTickets")}</p>
          </div>
        )}
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
              <p className="text-xs text-green-700 font-semibold mt-0.5">{detail.branch_name} · {detail.raised_by_name}</p>
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
                        ? "border-green-500 bg-green-50 text-green-700"
                        : "border-slate-200 text-slate-500 hover:border-green-300"
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
        className="flex-1 border border-slate-200 rounded-lg px-2.5 py-1.5 text-xs focus:border-green-400 focus:ring-1 focus:ring-green-200 transition-colors" />
      <input value={variant.form ?? ""} onChange={(e) => onChange({ ...variant, form: e.target.value })}
        placeholder={t("admin.formPlaceholder")}
        className="flex-1 border border-slate-200 rounded-lg px-2.5 py-1.5 text-xs focus:border-green-400 focus:ring-1 focus:ring-green-200 transition-colors" />
      <input value={variant.unit ?? ""} onChange={(e) => onChange({ ...variant, unit: e.target.value })}
        placeholder={t("admin.unitPlaceholder")}
        className="flex-1 border border-slate-200 rounded-lg px-2.5 py-1.5 text-xs focus:border-green-400 focus:ring-1 focus:ring-green-200 transition-colors" />
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
        className="text-xs font-semibold text-green-700 hover:text-green-800 transition-colors">+ {t("admin.addVariant")}</button>
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
          <input value={name} onChange={(e) => setName(e.target.value)} placeholder="e.g. Amoxicillin"
            className="w-full border border-slate-200 rounded-lg px-3 py-2 text-sm focus:border-green-400 focus:ring-1 focus:ring-green-200 transition-colors" />
        </div>
        <div className="grid grid-cols-2 gap-3">
          <div>
            <label className="text-xs font-semibold text-slate-600 block mb-1">{t("admin.genericName")}</label>
            <input value={genericName} onChange={(e) => setGenericName(e.target.value)}
              className="w-full border border-slate-200 rounded-lg px-3 py-2 text-sm focus:border-green-400 focus:ring-1 focus:ring-green-200 transition-colors" />
          </div>
          <div>
            <label className="text-xs font-semibold text-slate-600 block mb-1">{t("admin.productType")}</label>
            <select value={productType} onChange={(e) => setProductType(e.target.value)}
              className="w-full border border-slate-200 rounded-lg px-3 py-2 text-sm focus:border-green-400 focus:ring-1 focus:ring-green-200 transition-colors">
              <option value="medicine">{t("admin.productTypeMedicine")}</option>
              <option value="supply">{t("admin.productTypeSupply")}</option>
              <option value="other">{t("admin.productTypeOther")}</option>
            </select>
          </div>
        </div>
        <div>
          <label className="text-xs font-semibold text-slate-600 block mb-1">{t("admin.taxRate")}</label>
          <select value={taxRateId} onChange={(e) => setTaxRateId(e.target.value)}
            className="w-full border border-slate-200 rounded-lg px-3 py-2 text-sm focus:border-green-400 focus:ring-1 focus:ring-green-200 transition-colors">
            {taxRates.map((rate) => (
              <option key={rate.id} value={rate.id}>{rate.name} ({rate.rate_percentage}%)</option>
            ))}
          </select>
        </div>
        <VariantEditor variants={variants} onChange={setVariants} />
        <div className="flex justify-end gap-2 pt-2">
          <button onClick={onClose} className="px-4 py-2 text-sm border border-slate-200 text-slate-500 rounded-lg hover:bg-slate-50 transition-colors">{t("admin.cancel")}</button>
          <button onClick={() => void submit()} disabled={busy}
            className="flex items-center gap-2 px-4 py-2 text-sm bg-green-600 text-white rounded-lg hover:bg-green-700 transition-colors disabled:opacity-60">
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
            className="w-full border border-slate-200 rounded-lg px-3 py-2 text-sm focus:border-green-400 focus:ring-1 focus:ring-green-200 transition-colors" />
        </div>
        <div>
          <label className="text-xs font-semibold text-slate-600 block mb-1">{t("admin.taxRatePercentage")}</label>
          <input type="number" min="0" max="100" step="0.01" value={rate} onChange={(e) => setRate(e.target.value)}
            className="w-full border border-slate-200 rounded-lg px-3 py-2 text-sm focus:border-green-400 focus:ring-1 focus:ring-green-200 transition-colors" />
        </div>
        <div className="flex justify-end gap-2 pt-2">
          <button onClick={onClose} className="px-4 py-2 text-sm border border-slate-200 text-slate-500 rounded-lg hover:bg-slate-50 transition-colors">{t("admin.cancel")}</button>
          <button onClick={() => void submit()} disabled={busy}
            className="flex items-center gap-2 px-4 py-2 text-sm bg-green-600 text-white rounded-lg hover:bg-green-700 transition-colors disabled:opacity-60">
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
      const [productList, rates] = await Promise.all([adminListProducts(), listTaxRates()]);
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
  const shown = products.filter((p) => !needle || p.name.toLowerCase().includes(needle) || (p.genericName ?? "").toLowerCase().includes(needle));

  return (
    <div className="space-y-6">
      <div className="flex items-start justify-between gap-4 flex-wrap">
        <div>
          <h2 className="text-xl font-bold text-slate-800">{t("admin.productsAndTax")}</h2>
          <p className="text-xs text-slate-400 mt-0.5">{t("admin.productsCount", { count: products.length })}</p>
        </div>
        <div className="flex items-center gap-2">
          <button onClick={() => setShowAddTax(true)}
            className="flex items-center gap-1.5 px-3 py-2 text-xs font-semibold border border-green-200 text-green-700 rounded-lg hover:bg-green-50 transition-colors">
            <Tag className="w-3.5 h-3.5" /> {t("admin.addTaxRate")}
          </button>
          <button onClick={() => setShowAdd(true)}
            className="flex items-center gap-1.5 px-3 py-2 text-xs font-semibold bg-green-600 text-white rounded-lg hover:bg-green-700 transition-colors">
            <Plus className="w-3.5 h-3.5" /> {t("admin.addProduct")}
          </button>
        </div>
      </div>

      {error && <div className="bg-red-50 border border-red-200 text-red-700 text-xs rounded-lg px-3 py-2">{error}</div>}

      <input value={query} onChange={(e) => setQuery(e.target.value)} placeholder={t("admin.searchProducts")}
        className="w-full max-w-sm border border-slate-200 rounded-lg px-3 py-2 text-sm focus:border-green-400 focus:ring-1 focus:ring-green-200 transition-colors" />

      <div className="bg-white rounded-xl border border-green-100 shadow-sm overflow-hidden">
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
                <tr key={p.id} className="hover:bg-green-50/30 transition-colors">
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
                      className="border border-slate-200 rounded-lg px-2 py-1 text-xs focus:border-green-400 focus:ring-1 focus:ring-green-200 transition-colors disabled:opacity-50"
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
          {!loading && shown.length === 0 && (
            <p className="text-center py-10 text-xs text-slate-400">{t("admin.noProductsFound")}</p>
          )}
        </div>
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
            className="w-full border border-slate-200 rounded-lg px-3 py-2 text-sm focus:border-green-400 focus:ring-1 focus:ring-green-200 transition-colors" />
        </div>
        <div>
          <label className="text-xs font-semibold text-slate-600 block mb-1">{t("admin.categoryDescription")}</label>
          <input value={description} onChange={(e) => setDescription(e.target.value)}
            className="w-full border border-slate-200 rounded-lg px-3 py-2 text-sm focus:border-green-400 focus:ring-1 focus:ring-green-200 transition-colors" />
        </div>
        <div>
          <label className="text-xs font-semibold text-slate-600 block mb-1">{t("admin.categoryTarget")}</label>
          <select value={branchId} onChange={(e) => setBranchId(e.target.value)}
            className="w-full border border-slate-200 rounded-lg px-3 py-2 text-sm focus:border-green-400 focus:ring-1 focus:ring-green-200 transition-colors">
            <option value="">{t("admin.categoryAllBranches")}</option>
            {branches.map((b) => (
              <option key={b.id} value={b.id}>{b.name}</option>
            ))}
          </select>
        </div>
        <div className="flex justify-end gap-2 pt-2">
          <button onClick={onClose} className="px-4 py-2 text-sm border border-slate-200 text-slate-500 rounded-lg hover:bg-slate-50 transition-colors">{t("admin.cancel")}</button>
          <button onClick={() => void submit()} disabled={busy}
            className="flex items-center gap-2 px-4 py-2 text-sm bg-green-600 text-white rounded-lg hover:bg-green-700 transition-colors disabled:opacity-60">
            {busy ? <RefreshCw className="w-3.5 h-3.5 animate-spin" /> : <Plus className="w-3.5 h-3.5" />}
            {t("admin.addCategory")}
          </button>
        </div>
      </div>
    </Modal>
  );
}

function CategoriesView({ branches }: { branches: BranchRecord[] }) {
  const { t } = useTranslation();
  const [categories, setCategories] = useState<AdminCategoryRow[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const [query, setQuery] = useState("");
  const [showAdd, setShowAdd] = useState(false);

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

  const needle = query.trim().toLowerCase();
  const shown = categories.filter((c) => !needle || c.name.toLowerCase().includes(needle) || c.branch_name.toLowerCase().includes(needle));
  const activeBranches = branches.filter((b) => b.branchId).map((b) => ({ id: b.branchId!, name: b.pharmacyName }));

  return (
    <div className="space-y-6">
      <div className="flex items-start justify-between gap-4 flex-wrap">
        <div>
          <h2 className="text-xl font-bold text-slate-800">{t("admin.categoriesSystemWide")}</h2>
          <p className="text-xs text-slate-400 mt-0.5">{t("admin.categoriesCount", { count: categories.length })}</p>
        </div>
        <button onClick={() => setShowAdd(true)}
          className="flex items-center gap-1.5 px-3 py-2 text-xs font-semibold bg-green-600 text-white rounded-lg hover:bg-green-700 transition-colors">
          <Plus className="w-3.5 h-3.5" /> {t("admin.addCategory")}
        </button>
      </div>

      {error && <div className="bg-red-50 border border-red-200 text-red-700 text-xs rounded-lg px-3 py-2">{error}</div>}

      <input value={query} onChange={(e) => setQuery(e.target.value)} placeholder={t("admin.searchCategories")}
        className="w-full max-w-sm border border-slate-200 rounded-lg px-3 py-2 text-sm focus:border-green-400 focus:ring-1 focus:ring-green-200 transition-colors" />

      <div className="bg-white rounded-xl border border-green-100 shadow-sm overflow-hidden">
        <div className="overflow-x-auto">
          <table className="w-full text-xs">
            <thead>
              <tr className="bg-slate-50 border-b border-slate-100">
                {[t("admin.colCategory"), t("admin.colDescription"), t("admin.colPharmacy")].map((h) => (
                  <th key={h} className="text-left px-4 py-3 font-semibold text-slate-500 text-[10px] uppercase tracking-wide whitespace-nowrap">{h}</th>
                ))}
              </tr>
            </thead>
            <tbody className="divide-y divide-slate-50">
              {shown.map((c) => (
                <tr key={c.id} className="hover:bg-green-50/30 transition-colors">
                  <td className="px-4 py-3 font-semibold text-slate-700">{c.name}</td>
                  <td className="px-4 py-3 text-slate-500">{c.description ?? "—"}</td>
                  <td className="px-4 py-3 text-slate-500">{c.branch_name}</td>
                </tr>
              ))}
            </tbody>
          </table>
          {!loading && shown.length === 0 && (
            <p className="text-center py-10 text-xs text-slate-400">{t("admin.noCategoriesFound")}</p>
          )}
        </div>
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
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);

  async function submit() {
    const parsed = Number(rate);
    if (!name.trim()) { setError("Provider name is required."); return; }
    if (!Number.isFinite(parsed) || parsed < 0 || parsed > 100) { setError("Default coverage must be between 0 and 100."); return; }
    setBusy(true);
    setError("");
    try {
      if (provider) await adminUpdateInsuranceProvider(provider.id, name.trim(), parsed, contact.trim());
      else await adminCreateInsuranceProvider(name.trim(), parsed, contact.trim());
      onSaved();
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : "Could not save this insurance provider.");
    } finally {
      setBusy(false);
    }
  }

  return (
    <Modal title={provider ? "Edit Insurance Provider" : "Add Insurance Provider"} onClose={onClose}>
      <div className="space-y-3">
        {error && <p className="text-xs text-red-600">{error}</p>}
        <div>
          <label className="text-xs font-semibold text-slate-600 block mb-1">Provider Name</label>
          <input value={name} onChange={(e) => setName(e.target.value)} placeholder="e.g. RSSB, MMI, Radiant"
            className="w-full border border-slate-200 rounded-lg px-3 py-2 text-sm focus:border-green-400 focus:ring-1 focus:ring-green-200 transition-colors" />
        </div>
        <div>
          <label className="text-xs font-semibold text-slate-600 block mb-1">Default Coverage Applied to All Medicines (%)</label>
          <input type="number" min="0" max="100" step="0.01" value={rate} onChange={(e) => setRate(e.target.value)}
            className="w-full border border-slate-200 rounded-lg px-3 py-2 text-sm focus:border-green-400 focus:ring-1 focus:ring-green-200 transition-colors" />
        </div>
        <div>
          <label className="text-xs font-semibold text-slate-600 block mb-1">Contact Info (optional)</label>
          <input value={contact} onChange={(e) => setContact(e.target.value)}
            className="w-full border border-slate-200 rounded-lg px-3 py-2 text-sm focus:border-green-400 focus:ring-1 focus:ring-green-200 transition-colors" />
        </div>
        <div className="flex justify-end gap-2 pt-2">
          <button onClick={onClose} className="px-4 py-2 text-sm border border-slate-200 text-slate-500 rounded-lg hover:bg-slate-50 transition-colors">Cancel</button>
          <button onClick={() => void submit()} disabled={busy}
            className="flex items-center gap-2 px-4 py-2 text-sm bg-green-600 text-white rounded-lg hover:bg-green-700 transition-colors disabled:opacity-60">
            {busy ? <RefreshCw className="w-3.5 h-3.5 animate-spin" /> : <Plus className="w-3.5 h-3.5" />}
            {provider ? "Save Changes" : "Add Provider"}
          </button>
        </div>
      </div>
    </Modal>
  );
}

function ManageCoverageModal({ provider, onClose }: { provider: InsuranceProvider; onClose: () => void }) {
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
      const [rows, productList] = await Promise.all([loadCoverageOverridesWithNames(provider.id), adminListProducts()]);
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
    <Modal title={`Coverage — ${provider.name}`} onClose={onClose}>
      <div className="space-y-4 max-h-[65vh] overflow-y-auto">
        <p className="text-xs text-slate-500">Default coverage is <strong>{provider.defaultCoveragePercentage}%</strong> for every product. Add a row below only for a product that should differ — including 0% for "not covered at all".</p>
        {error && <p className="text-xs text-red-600">{error}</p>}

        {loading ? (
          <p className="text-xs text-slate-400">Loading…</p>
        ) : overrides.length === 0 ? (
          <p className="text-xs text-slate-400">No exceptions yet — every product uses the default.</p>
        ) : (
          <div className="space-y-1.5">
            {overrides.map((o) => (
              <div key={o.productId} className="flex items-center justify-between gap-2 bg-slate-50 rounded-lg px-3 py-2">
                <span className="text-sm text-slate-700">{o.productName}</span>
                <div className="flex items-center gap-2 shrink-0">
                  <span className={`text-xs font-bold ${o.coveragePercentage === 0 ? "text-red-600" : "text-green-700"}`}>
                    {o.coveragePercentage === 0 ? "Not covered" : `${o.coveragePercentage}%`}
                  </span>
                  <button onClick={() => void clearOverride(o.productId)} disabled={busy} title="Revert to default"
                    className="text-slate-400 hover:text-red-600 transition-colors disabled:opacity-50">
                    <X className="w-3.5 h-3.5" />
                  </button>
                </div>
              </div>
            ))}
          </div>
        )}

        <div className="border-t border-slate-100 pt-3 space-y-2">
          <label className="text-xs font-semibold text-slate-600 block">Add a Product Override</label>
          <input value={pickedProductId ? products.find((p) => p.id === pickedProductId)?.name ?? "" : productQuery}
            onChange={(e) => { setProductQuery(e.target.value); setPickedProductId(""); }}
            placeholder="Search a product…"
            className="w-full border border-slate-200 rounded-lg px-3 py-2 text-sm focus:border-green-400 focus:ring-1 focus:ring-green-200 transition-colors" />
          {!pickedProductId && productQuery.trim() && (
            <div className="border border-slate-100 rounded-lg max-h-32 overflow-y-auto">
              {candidates.slice(0, 20).map((p) => (
                <button key={p.id} onClick={() => { setPickedProductId(p.id); setProductQuery(""); }}
                  className="w-full text-left px-3 py-1.5 text-xs text-slate-700 hover:bg-green-50 transition-colors">
                  {p.name}
                </button>
              ))}
              {candidates.length === 0 && <p className="px-3 py-1.5 text-xs text-slate-400">No matching product.</p>}
            </div>
          )}
          {pickedProductId && (
            <div className="flex items-center gap-2">
              <input type="number" min="0" max="100" step="0.01" value={pct} onChange={(e) => setPct(e.target.value)}
                placeholder="Coverage %" className="w-28 border border-slate-200 rounded-lg px-3 py-2 text-sm focus:border-green-400 focus:ring-1 focus:ring-green-200 transition-colors" />
              <button onClick={() => setPct("0")} className="text-xs font-semibold text-red-600 hover:underline">Not covered</button>
              <div className="flex-1" />
              <button onClick={() => void saveOverride(pickedProductId, Number(pct))} disabled={busy || pct.trim() === "" || !Number.isFinite(Number(pct))}
                className="flex items-center gap-1.5 px-3 py-2 text-xs font-semibold bg-green-600 text-white rounded-lg hover:bg-green-700 transition-colors disabled:opacity-60">
                {busy ? <RefreshCw className="w-3.5 h-3.5 animate-spin" /> : <Plus className="w-3.5 h-3.5" />} Save
              </button>
            </div>
          )}
        </div>
      </div>
    </Modal>
  );
}

function InsuranceView() {
  const [providers, setProviders] = useState<InsuranceProvider[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const [showAdd, setShowAdd] = useState(false);
  const [editing, setEditing] = useState<InsuranceProvider | null>(null);
  const [managing, setManaging] = useState<InsuranceProvider | null>(null);

  const refresh = useCallback(async () => {
    setLoading(true);
    setError("");
    try {
      setProviders(await loadInsuranceProviders());
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : "Could not load insurance providers.");
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => { void refresh(); }, [refresh]);

  return (
    <div className="space-y-6">
      <div className="flex items-start justify-between gap-4 flex-wrap">
        <div>
          <h2 className="text-xl font-bold text-slate-800">Insurance Providers</h2>
          <p className="text-xs text-slate-400 mt-0.5">{providers.length} provider{providers.length === 1 ? "" : "s"}</p>
        </div>
        <button onClick={() => setShowAdd(true)}
          className="flex items-center gap-1.5 px-3 py-2 text-xs font-semibold bg-green-600 text-white rounded-lg hover:bg-green-700 transition-colors">
          <Plus className="w-3.5 h-3.5" /> Add Provider
        </button>
      </div>

      {error && <div className="bg-red-50 border border-red-200 text-red-700 text-xs rounded-lg px-3 py-2">{error}</div>}

      <div className="bg-white rounded-xl border border-green-100 shadow-sm overflow-hidden">
        <div className="overflow-x-auto">
          <table className="w-full text-xs">
            <thead>
              <tr className="bg-slate-50 border-b border-slate-100">
                {["Provider", "Default Coverage", "Contact", ""].map((h) => (
                  <th key={h} className="text-left px-4 py-3 font-semibold text-slate-500 text-[10px] uppercase tracking-wide whitespace-nowrap">{h}</th>
                ))}
              </tr>
            </thead>
            <tbody className="divide-y divide-slate-50">
              {providers.map((p) => (
                <tr key={p.id} className="hover:bg-green-50/30 transition-colors">
                  <td className="px-4 py-3 font-semibold text-slate-700">{p.name}</td>
                  <td className="px-4 py-3 text-slate-500">{p.defaultCoveragePercentage}%</td>
                  <td className="px-4 py-3 text-slate-500">{p.contactInfo || "—"}</td>
                  <td className="px-4 py-3">
                    <div className="flex items-center justify-end gap-3">
                      <button onClick={() => setManaging(p)} className="text-xs font-semibold text-green-700 hover:underline">Manage Coverage</button>
                      <button onClick={() => setEditing(p)} className="text-xs font-semibold text-slate-500 hover:underline">Edit</button>
                    </div>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
          {!loading && providers.length === 0 && (
            <p className="text-center py-10 text-xs text-slate-400">No insurance providers yet — add one to start covering sales.</p>
          )}
        </div>
      </div>

      {showAdd && <ProviderFormModal onClose={() => setShowAdd(false)} onSaved={() => { setShowAdd(false); void refresh(); }} />}
      {editing && <ProviderFormModal provider={editing} onClose={() => setEditing(null)} onSaved={() => { setEditing(null); void refresh(); }} />}
      {managing && <ManageCoverageModal provider={managing} onClose={() => setManaging(null)} />}
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
            className="w-full border border-slate-200 rounded-lg px-3 py-2 text-sm focus:border-green-400 focus:ring-1 focus:ring-green-200 transition-colors" />
        </div>
        <div className="grid grid-cols-2 gap-3">
          <div>
            <label className="text-xs font-semibold text-slate-600 block mb-1">{t("admin.genericName")}</label>
            <input value={genericName} onChange={(e) => setGenericName(e.target.value)}
              className="w-full border border-slate-200 rounded-lg px-3 py-2 text-sm focus:border-green-400 focus:ring-1 focus:ring-green-200 transition-colors" />
          </div>
          <div>
            <label className="text-xs font-semibold text-slate-600 block mb-1">{t("admin.productType")}</label>
            <select value={productType} onChange={(e) => setProductType(e.target.value)}
              className="w-full border border-slate-200 rounded-lg px-3 py-2 text-sm focus:border-green-400 focus:ring-1 focus:ring-green-200 transition-colors">
              <option value="medicine">{t("admin.productTypeMedicine")}</option>
              <option value="supply">{t("admin.productTypeSupply")}</option>
              <option value="other">{t("admin.productTypeOther")}</option>
            </select>
          </div>
        </div>
        <div>
          <label className="text-xs font-semibold text-slate-600 block mb-1">{t("admin.taxRate")}</label>
          <select value={taxRateId} onChange={(e) => setTaxRateId(e.target.value)}
            className="w-full border border-slate-200 rounded-lg px-3 py-2 text-sm focus:border-green-400 focus:ring-1 focus:ring-green-200 transition-colors">
            {taxRates.map((rate) => (
              <option key={rate.id} value={rate.id}>{rate.name} ({rate.rate_percentage}%)</option>
            ))}
          </select>
        </div>
        <VariantEditor variants={variants} onChange={setVariants} />
        <div className="flex justify-end gap-2 pt-2">
          <button onClick={onClose} className="px-4 py-2 text-sm border border-slate-200 text-slate-500 rounded-lg hover:bg-slate-50 transition-colors">{t("admin.cancel")}</button>
          <button onClick={() => void submit()} disabled={busy}
            className="flex items-center gap-2 px-4 py-2 text-sm bg-green-600 text-white rounded-lg hover:bg-green-700 transition-colors disabled:opacity-60">
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
            className="w-full border border-slate-200 rounded-lg px-3 py-2 text-sm text-slate-700 resize-none focus:border-green-400 focus:ring-1 focus:ring-green-200 transition-colors" />
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
      const [list, rates] = await Promise.all([adminListProductRequests(), listTaxRates()]);
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
  const resolved = requests.filter((r) => r.status !== "pending");

  return (
    <div className="space-y-6">
      <div>
        <h2 className="text-xl font-bold text-slate-800">{t("admin.productRequests")}</h2>
        <p className="text-xs text-slate-400 mt-0.5">{t(pending.length !== 1 ? "admin.requestsAwaitingPlural" : "admin.requestsAwaitingSingular", { count: pending.length })}</p>
      </div>

      {error && <div className="bg-red-50 border border-red-200 text-red-700 text-xs rounded-lg px-3 py-2">{error}</div>}

      {pending.length === 0 && !loading ? (
        <div className="bg-white rounded-xl border border-green-100 p-12 text-center">
          <CheckCircle2 className="w-10 h-10 text-green-400 mx-auto mb-3" />
          <p className="text-sm text-slate-500">{t("admin.allCaughtUp")}</p>
        </div>
      ) : (
        <div className="space-y-3">
          {pending.map((r) => (
            <div key={r.id} className="bg-white rounded-xl border border-green-100 shadow-sm p-5 hover:border-green-300 transition-colors">
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
                    className="flex items-center gap-1.5 px-3 py-1.5 text-xs font-medium bg-green-600 text-white rounded-lg hover:bg-green-700 transition-colors">
                    <CheckCircle2 className="w-3.5 h-3.5" /> {t("admin.approveRequest")}
                  </button>
                </div>
              </div>
            </div>
          ))}
        </div>
      )}

      {resolved.length > 0 && (
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
                  r.status === "approved" ? "bg-green-100 text-green-700 border-green-200" : "bg-red-100 text-red-700 border-red-200"
                }`}>
                  {r.status === "approved" ? t("admin.statusApproved") : t("admin.statusDenied")}
                </span>
              </div>
            ))}
          </div>
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
    <div className="min-h-screen flex items-center justify-center bg-gradient-to-br from-green-50 via-white to-emerald-50 px-4">
      <div className="w-full max-w-sm">
        <div className="flex items-center justify-between mb-4">
          <a href="#" onClick={(e) => { e.preventDefault(); backToHome(); }}
            className="inline-flex items-center gap-1.5 text-xs font-semibold text-slate-500 hover:text-green-600 transition-colors">
            <ArrowLeft className="w-3.5 h-3.5" /> {t("common.backToPharmSync")}
          </a>
          <LanguageSwitcher />
        </div>
      <div className="w-full bg-white rounded-2xl border border-green-100 shadow-sm p-7">
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
              placeholder="you@pharmsync.rw"
              className="w-full border border-slate-200 rounded-lg px-3 py-2.5 text-sm focus:border-green-400 focus:ring-1 focus:ring-green-200 transition-colors"
            />
            {error && <p className="text-xs text-red-600">{error}</p>}
            <button onClick={() => void sendCode()} disabled={sending}
              className="w-full flex items-center justify-center gap-2 px-4 py-2.5 text-sm bg-green-600 text-white rounded-lg hover:bg-green-700 transition-colors disabled:opacity-60">
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
                  className="w-10 h-12 text-center text-lg font-bold border border-slate-200 rounded-lg focus:border-green-400 focus:ring-1 focus:ring-green-200 transition-colors"
                />
              ))}
            </div>
            {error && <p className="text-xs text-red-600">{error}</p>}
            <button onClick={() => void verify()} disabled={verifying}
              className="w-full flex items-center justify-center gap-2 px-4 py-2.5 text-sm bg-green-600 text-white rounded-lg hover:bg-green-700 transition-colors disabled:opacity-60">
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
  const [tickets, setTickets]     = useState<AdminTicketRow[]>([]);
  const [pendingRequestCount, setPendingRequestCount] = useState(0);
  const [sidebarOpen, setSidebarOpen] = useState(false);

  useEffect(() => {
    void isSuperAdminSession().then((ok) => { setAuthed(ok); setAuthChecked(true); });
  }, []);

  const refresh = useCallback(async () => {
    try {
      const [apps, ticketRows, requestRows] = await Promise.all([
        listPharmacyApplications(),
        adminListSupportTickets(),
        adminListProductRequests(),
      ]);
      setBranches(apps);
      setTickets(ticketRows);
      setPendingRequestCount(requestRows.filter((r) => r.status === "pending").length);
    } catch (reason) {
      // Session expired or was never a real admin session — drop back to the gate.
      if (reason instanceof Error && /admin/i.test(reason.message)) setAuthed(false);
    }
  }, []);

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
    return <div className="min-h-screen flex items-center justify-center bg-[var(--bg)]"><RefreshCw className="w-5 h-5 text-green-500 animate-spin" /></div>;
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
      <aside className={`fixed lg:static z-30 flex flex-col w-60 h-full bg-white border-r border-green-100 shadow-sm transition-transform lg:translate-x-0 ${sidebarOpen ? "translate-x-0" : "-translate-x-full"}`}>
        <div className="px-5 py-5 border-b border-green-100">
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
                  ? "bg-green-600 text-white shadow-sm shadow-green-200"
                  : "text-slate-600 hover:bg-green-50 hover:text-green-700"
              }`}>
              <span className="flex items-center gap-2.5 font-medium">
                {item.icon}
                {t(item.labelKey)}
              </span>
              {badges[item.id] ? (
                <span className={`text-[10px] font-bold px-1.5 py-0.5 rounded-full min-w-[18px] text-center ${
                  nav === item.id ? "bg-white/30 text-white" : "bg-green-100 text-green-700"
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

        <div className="px-4 py-4 border-t border-green-100">
          <div className="flex items-center gap-2.5 bg-green-50 rounded-xl p-2.5">
            <div className="w-8 h-8 bg-green-600 rounded-lg flex items-center justify-center shrink-0">
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
        <header className="flex items-center justify-between px-4 lg:px-6 py-3.5 bg-white border-b border-green-100 shadow-sm shrink-0">
          <div className="flex items-center gap-3">
            <button className="lg:hidden text-slate-500 hover:text-slate-700 transition-colors" onClick={() => setSidebarOpen(true)}>
              <svg className="w-5 h-5" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M4 6h16M4 12h16M4 18h16" /></svg>
            </button>
            <div>
              <h1 className="font-bold text-slate-800">{t(NAV.find((n) => n.id === nav)?.labelKey ?? "admin.navDashboard")}</h1>
            </div>
          </div>
          <div className="flex items-center gap-3">
            <a href="#" onClick={(e) => { e.preventDefault(); backToHome(); }} className="flex items-center gap-1.5 text-xs font-semibold text-slate-500 hover:text-green-600 transition-colors">
              <ArrowLeft className="w-3.5 h-3.5" /> <span className="hidden sm:inline">{t("common.backToPharmSync")}</span>
            </a>
            <span className="font-mono text-[10px] text-slate-400 hidden sm:block">{t("admin.version")}</span>
            <div className="flex items-center gap-1.5">
              <span className="w-2 h-2 rounded-full bg-green-500 animate-pulse" />
              <span className="text-[10px] text-green-600 font-semibold">{t("admin.live")}</span>
            </div>
          </div>
        </header>

        <main className="flex-1 overflow-y-auto p-4 lg:p-6">
          {nav === "dashboard" && <Dashboard branches={branches} tickets={tickets} />}
          {nav === "approvals" && <Approvals branches={branches} onChange={refresh} />}
          {nav === "branches"  && <BranchDirectory branches={branches} adminEmail={adminEmail} onChange={refresh} />}
          {nav === "products"  && <ProductsView />}
          {nav === "categories" && <CategoriesView branches={branches} />}
          {nav === "productRequests" && <ProductRequestsView />}
          {nav === "insurance" && <InsuranceView />}
          {nav === "security"  && <Security branches={branches} onChange={refresh} />}
          {nav === "tickets"   && <TicketsView tickets={tickets} onChange={refresh} />}
        </main>
      </div>
    </div>
  );
}
