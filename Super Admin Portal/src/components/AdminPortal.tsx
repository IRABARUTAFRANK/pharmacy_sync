import { useState, useEffect, useCallback } from "react";
import {
  LayoutDashboard, CheckSquare, Building2, ShieldAlert, Ticket,
  Phone, Mail, MapPin, Clock, AlertTriangle, CheckCircle2, XCircle,
  Lock, Unlock, RefreshCw, ChevronRight, Eye, Send, Bell, Activity,
  Users, TrendingUp, X, Check
} from "lucide-react";
import { getTickets, saveTickets, type BranchRecord, type BranchStatus, type TicketRecord } from "../lib/store";
import {
  approvePharmacyApplication,
  denyPharmacyApplication,
  isSuperAdminSession,
  listPharmacyApplications,
  markPharmacyCalled,
  requestAdminOtp,
  setBranchLock,
  signOutAdmin,
  verifyAdminOtp,
} from "../lib/onboarding";

type NavId = "dashboard" | "approvals" | "branches" | "security" | "tickets";

// ── Small reusable pieces ─────────────────────────────────────────────────────

function Badge({ status }: { status: BranchStatus | TicketRecord["status"] }) {
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
  };
  const labels: Record<string, string> = {
    otp_sent: "OTP Sent", in_progress: "In Progress"
  };
  return (
    <span className={`inline-flex items-center px-2 py-0.5 rounded-md border text-[10px] font-semibold uppercase tracking-wide ${map[status] ?? ""}`}>
      {labels[status] ?? status}
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

function Dashboard({ branches, tickets }: { branches: BranchRecord[]; tickets: TicketRecord[] }) {
  const pending = branches.filter((b) => b.status === "pending").length;
  const active  = branches.filter((b) => b.status === "active").length;
  const locked  = branches.filter((b) => b.status === "locked").length;
  const openTix = tickets.filter((t) => t.status === "open").length;

  const feed = [
    ...branches.map((b) => ({
      time: b.submittedAt,
      icon: <Building2 className="w-3.5 h-3.5 text-green-500" />,
      text: `${b.pharmacyName} — ${b.status}`,
    })),
    ...tickets.map((t) => ({
      time: t.submittedAt,
      icon: <Ticket className="w-3.5 h-3.5 text-violet-500" />,
      text: `[Ticket] ${t.branchName}: "${t.subject}"`,
    })),
  ].sort((a, b) => new Date(b.time).getTime() - new Date(a.time).getTime()).slice(0, 8);

  return (
    <div className="space-y-6">
      <div>
        <h2 className="text-xl font-bold text-slate-800">System Overview</h2>
        <p className="text-xs text-slate-400 mt-0.5 font-mono">
          PharmacySync Admin · {new Date().toDateString()}
        </p>
      </div>

      <div className="grid grid-cols-2 lg:grid-cols-4 gap-4">
        <StatCard icon={<Clock className="w-5 h-5 text-amber-600" />} label="Pending Approval" value={pending} color="bg-amber-50" />
        <StatCard icon={<Activity className="w-5 h-5 text-green-600" />} label="Active Branches" value={active} color="bg-green-50" />
        <StatCard icon={<Lock className="w-5 h-5 text-orange-600" />} label="Locked Branches" value={locked} color="bg-orange-50" />
        <StatCard icon={<Ticket className="w-5 h-5 text-violet-600" />} label="Open Tickets" value={openTix} color="bg-violet-50" />
      </div>

      {locked > 0 && (
        <div className="bg-orange-50 border border-orange-200 rounded-xl p-4 flex items-start gap-3">
          <AlertTriangle className="w-5 h-5 text-orange-500 shrink-0 mt-0.5" />
          <div>
            <p className="font-semibold text-orange-700 text-sm">Security Alert</p>
            <p className="text-xs text-orange-600 mt-0.5">
              {locked} branch{locked > 1 ? "es have" : " has"} been locked due to excessive failed login attempts. Go to Security to manage.
            </p>
          </div>
        </div>
      )}

      {openTix > 0 && (
        <div className="bg-violet-50 border border-violet-200 rounded-xl p-4 flex items-start gap-3">
          <Bell className="w-5 h-5 text-violet-500 shrink-0 mt-0.5" />
          <div>
            <p className="font-semibold text-violet-700 text-sm">{openTix} Open Support {openTix > 1 ? "Tickets" : "Ticket"}</p>
            <p className="text-xs text-violet-600 mt-0.5">Branch{openTix > 1 ? "es" : ""} need help. Check the Tickets tab.</p>
          </div>
        </div>
      )}

      <div className="bg-white rounded-xl border border-green-100 shadow-sm overflow-hidden">
        <div className="px-5 py-3 border-b border-slate-100 flex items-center gap-2">
          <TrendingUp className="w-4 h-4 text-green-600" />
          <p className="font-semibold text-sm text-slate-700">Recent Activity</p>
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
      window.alert(reason instanceof Error ? reason.message : "Approval failed.");
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
      window.alert(reason instanceof Error ? reason.message : "Denial failed.");
    }
  }

  return (
    <div className="space-y-6">
      <div>
        <h2 className="text-xl font-bold text-slate-800">Branch Approvals</h2>
        <p className="text-xs text-slate-400 mt-0.5">{pending.length} request{pending.length !== 1 ? "s" : ""} awaiting review</p>
      </div>

      {pending.length === 0 ? (
        <div className="bg-white rounded-xl border border-green-100 p-12 text-center">
          <CheckCircle2 className="w-10 h-10 text-green-400 mx-auto mb-3" />
          <p className="text-sm text-slate-500">All caught up — no pending approvals</p>
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
                        <Phone className="w-3 h-3" /> Called
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
                      <Phone className="w-3.5 h-3.5" /> Mark as Called
                    </button>
                  )}
                  <button
                    onClick={() => { setDetailBranch(b); setAction("deny"); }}
                    className="flex items-center gap-1.5 px-3 py-1.5 text-xs font-medium border border-red-200 text-red-600 rounded-lg hover:bg-red-50 transition-colors"
                  >
                    <XCircle className="w-3.5 h-3.5" /> Deny
                  </button>
                  <button
                    disabled={!b.calledAt}
                    onClick={() => { setDetailBranch(b); setAction("approve"); }}
                    className="flex items-center gap-1.5 px-3 py-1.5 text-xs font-medium bg-green-600 text-white rounded-lg hover:bg-green-700 transition-colors disabled:opacity-40 disabled:cursor-not-allowed"
                    title={!b.calledAt ? "You must call the branch first" : ""}
                  >
                    <CheckCircle2 className="w-3.5 h-3.5" /> Approve & Send OTP
                  </button>
                </div>
              </div>
            </div>
          ))}
        </div>
      )}

      {processed.length > 0 && (
        <div>
          <p className="text-[10px] font-mono text-slate-400 uppercase tracking-widest mb-3">Processed</p>
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
                      Awaiting email OTP
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
        <Modal title="Approve & Send OTP" onClose={() => { setDetailBranch(null); setAction(null); }}>
          <div className="space-y-4">
            <p className="text-sm text-slate-600">
              Approve portal access for{" "}
              <span className="font-semibold text-slate-800">{detailBranch.pharmacyName}</span>?
            </p>
            <div className="bg-green-50 border border-green-200 rounded-xl p-3 space-y-1.5 text-xs">
              <p className="font-semibold text-green-800 flex items-center gap-1.5"><Send className="w-3 h-3" /> What will happen:</p>
              <p className="text-green-700">• The pharmacy page can request a 6-digit code at <strong>{detailBranch.email}</strong></p>
              <p className="text-green-700">• They enter that code to create the one operator account for this branch</p>
              <p className="text-green-700">• A unique PSYNC branch code is assigned on activation</p>
            </div>
            <div className="flex justify-end gap-2">
              <button onClick={() => { setDetailBranch(null); setAction(null); }}
                className="px-4 py-2 text-sm border border-slate-200 text-slate-500 rounded-lg hover:bg-slate-50 transition-colors">
                Cancel
              </button>
              <button onClick={handleApprove} disabled={sendingOtp}
                className="flex items-center gap-2 px-4 py-2 text-sm bg-green-600 text-white rounded-lg hover:bg-green-700 transition-colors disabled:opacity-60">
                {sendingOtp ? <RefreshCw className="w-3.5 h-3.5 animate-spin" /> : <Send className="w-3.5 h-3.5" />}
                {sendingOtp ? "Sending OTP…" : "Approve & Send OTP"}
              </button>
            </div>
          </div>
        </Modal>
      )}

      {/* Deny modal */}
      {detailBranch && action === "deny" && (
        <Modal title="Deny Application" onClose={() => { setDetailBranch(null); setAction(null); setDenyReason(""); }}>
          <div className="space-y-4">
            <p className="text-sm text-slate-600">
              Deny portal access for{" "}
              <span className="font-semibold text-slate-800">{detailBranch.pharmacyName}</span>?
            </p>
            <div>
              <label className="text-xs font-semibold text-slate-600 block mb-1">Reason (optional)</label>
              <textarea
                value={denyReason} onChange={(e) => setDenyReason(e.target.value)}
                rows={3} placeholder="Enter reason for denial…"
                className="w-full border border-slate-200 rounded-lg px-3 py-2 text-sm text-slate-700 resize-none focus:border-green-400 focus:ring-1 focus:ring-green-200 transition-colors"
              />
            </div>
            <div className="flex justify-end gap-2">
              <button onClick={() => { setDetailBranch(null); setAction(null); setDenyReason(""); }}
                className="px-4 py-2 text-sm border border-slate-200 text-slate-500 rounded-lg hover:bg-slate-50 transition-colors">
                Cancel
              </button>
              <button onClick={handleDeny}
                className="flex items-center gap-2 px-4 py-2 text-sm bg-red-600 text-white rounded-lg hover:bg-red-700 transition-colors">
                <XCircle className="w-3.5 h-3.5" /> Deny Access
              </button>
            </div>
          </div>
        </Modal>
      )}
    </div>
  );
}

// ── Branches directory ────────────────────────────────────────────────────────

function BranchDirectory({ branches }: { branches: BranchRecord[] }) {
  const [filter, setFilter] = useState<BranchStatus | "all">("all");
  const [detail, setDetail] = useState<BranchRecord | null>(null);

  const shown = filter === "all" ? branches : branches.filter((b) => b.status === filter);
  const opts: (BranchStatus | "all")[] = ["all","pending","otp_sent","active","locked","denied"];

  return (
    <div className="space-y-6">
      <div>
        <h2 className="text-xl font-bold text-slate-800">Branch Directory</h2>
        <p className="text-xs text-slate-400 mt-0.5">{branches.length} branches registered</p>
      </div>

      <div className="flex gap-2 flex-wrap">
        {opts.map((s) => (
          <button key={s} onClick={() => setFilter(s)}
            className={`text-[10px] font-mono uppercase tracking-widest px-3 py-1.5 rounded-lg border transition-colors ${
              filter === s
                ? "border-green-500 text-green-700 bg-green-50"
                : "border-slate-200 text-slate-500 hover:border-green-300"
            }`}>
            {s.replace("_", " ")}
          </button>
        ))}
      </div>

      <div className="bg-white rounded-xl border border-green-100 shadow-sm overflow-hidden">
        <div className="overflow-x-auto">
          <table className="w-full text-xs">
            <thead>
              <tr className="bg-slate-50 border-b border-slate-100">
                {["App ID","Pharmacy","Location","Phone","Branch Code","Status","Failed Logins",""].map((h) => (
                  <th key={h} className="text-left px-4 py-3 font-semibold text-slate-500 text-[10px] uppercase tracking-wide whitespace-nowrap">{h}</th>
                ))}
              </tr>
            </thead>
            <tbody className="divide-y divide-slate-50">
              {shown.map((b) => (
                <tr key={b.id} className="hover:bg-green-50/30 transition-colors">
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
                    <button onClick={() => setDetail(b)} className="text-green-600 hover:text-green-800 transition-colors">
                      <Eye className="w-3.5 h-3.5" />
                    </button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
          {shown.length === 0 && (
            <p className="text-center py-10 text-xs text-slate-400">No branches with status "{filter}"</p>
          )}
        </div>
      </div>

      {detail && (
        <Modal title={detail.pharmacyName} onClose={() => setDetail(null)}>
          <div className="space-y-3 text-sm">
            <div className="grid grid-cols-2 gap-3">
              {[
                { label: "Application ID", value: detail.applicationCode ?? detail.id, mono: true },
                { label: "Status", value: <Badge status={detail.status} /> },
                { label: "Phone", value: detail.phone, mono: true },
                { label: "Email", value: detail.email, mono: true },
                { label: "Location", value: detail.location },
                { label: "Branch Code", value: detail.branchCode ?? "—", mono: true },
                { label: "Activation Code", value: detail.activationCode ?? "—", mono: true },
                { label: "Failed Logins", value: detail.failedLogins },
              ].map((row, i) => (
                <div key={i} className="bg-slate-50 rounded-lg p-3">
                  <p className="text-[10px] text-slate-400 font-mono uppercase tracking-wide mb-0.5">{row.label}</p>
                  {typeof row.value === "string" || typeof row.value === "number"
                    ? <p className={`text-slate-700 text-xs font-semibold ${row.mono ? "font-mono" : ""} break-all`}>{row.value}</p>
                    : row.value}
                </div>
              ))}
            </div>
            {detail.status === "otp_sent" && (
              <div className="bg-violet-50 border border-violet-200 rounded-lg p-3">
                <p className="text-xs text-violet-700">A sign-in code was emailed directly to the applicant by Supabase Auth. It is never visible here.</p>
              </div>
            )}
          </div>
        </Modal>
      )}
    </div>
  );
}

// ── Security ──────────────────────────────────────────────────────────────────

function Security({ branches, onChange }: { branches: BranchRecord[]; onChange: () => void }) {
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
        <h2 className="text-xl font-bold text-slate-800">Security Management</h2>
        <p className="text-xs text-slate-400 mt-0.5">Monitor failed logins and manage branch lockouts</p>
      </div>

      {highRisk.length > 0 && (
        <div className="space-y-3">
          <div className="flex items-center gap-2">
            <AlertTriangle className="w-4 h-4 text-amber-500" />
            <p className="text-sm font-semibold text-amber-700">High-Risk Branches ({highRisk.length})</p>
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
                  <AlertTriangle className="w-3 h-3" /> {b.failedLogins} failed login attempts
                </p>
              </div>
              <button onClick={() => setConfirmLock(b)}
                className="flex items-center gap-1.5 px-3 py-1.5 text-xs font-medium border border-orange-300 text-orange-600 rounded-lg hover:bg-orange-50 transition-colors">
                <Lock className="w-3.5 h-3.5" /> Temporarily Lock
              </button>
            </div>
          ))}
        </div>
      )}

      <div className="space-y-3">
        <div className="flex items-center gap-2">
          <Lock className="w-4 h-4 text-orange-500" />
          <p className="text-sm font-semibold text-slate-700">Locked Branches ({locked.length})</p>
        </div>
        {locked.length === 0 ? (
          <div className="bg-white rounded-xl border border-green-100 p-10 text-center">
            <ShieldAlert className="w-8 h-8 text-green-300 mx-auto mb-2" />
            <p className="text-xs text-slate-400">No branches currently locked</p>
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
                    <p className="text-[11px] text-orange-600 font-mono">Locked: {b.lockedAt ? fmt(b.lockedAt) : "—"}</p>
                    <p className="text-[11px] text-slate-400 font-mono">Failed logins: {b.failedLogins}</p>
                  </div>
                  <div className="mt-2 bg-orange-50 border border-orange-100 rounded-lg px-3 py-2">
                    <p className="text-[10px] text-orange-600 font-mono italic">
                      "Your account is temporarily suspended. Contact the super admin to reactivate."
                    </p>
                  </div>
                </div>
                <button onClick={() => setConfirmRelease(b)}
                  className="flex items-center gap-1.5 px-3 py-1.5 text-xs font-medium border border-green-300 text-green-700 rounded-lg hover:bg-green-50 transition-colors">
                  <Unlock className="w-3.5 h-3.5" /> Release Branch
                </button>
              </div>
            </div>
          ))
        )}
      </div>

      {confirmLock && (
        <Modal title="Lock Branch" onClose={() => setConfirmLock(null)}>
          <div className="space-y-4">
            <p className="text-sm text-slate-600">
              Temporarily lock <span className="font-semibold text-slate-800">{confirmLock.pharmacyName}</span> due to {confirmLock.failedLogins} failed login attempts?
            </p>
            <div className="bg-orange-50 border border-orange-200 rounded-xl p-3 text-xs text-orange-700">
              The branch will be suspended and an automated notification will be sent instructing them to contact the super admin for reactivation.
            </div>
            <div className="flex justify-end gap-2">
              <button onClick={() => setConfirmLock(null)} className="px-4 py-2 text-sm border border-slate-200 text-slate-500 rounded-lg hover:bg-slate-50 transition-colors">Cancel</button>
              <button onClick={() => void lock(confirmLock)} className="flex items-center gap-2 px-4 py-2 text-sm bg-orange-600 text-white rounded-lg hover:bg-orange-700 transition-colors">
                <Lock className="w-3.5 h-3.5" /> Lock Branch
              </button>
            </div>
          </div>
        </Modal>
      )}

      {confirmRelease && (
        <Modal title="Release Branch" onClose={() => setConfirmRelease(null)}>
          <div className="space-y-4">
            <p className="text-sm text-slate-600">
              Reactivate <span className="font-semibold text-slate-800">{confirmRelease.pharmacyName}</span>? Failed login count will be reset.
            </p>
            <div className="bg-green-50 border border-green-200 rounded-xl p-3 text-xs text-green-700">
              A confirmation notification will be sent to {confirmRelease.email}.
            </div>
            <div className="flex justify-end gap-2">
              <button onClick={() => setConfirmRelease(null)} className="px-4 py-2 text-sm border border-slate-200 text-slate-500 rounded-lg hover:bg-slate-50 transition-colors">Cancel</button>
              <button onClick={() => void release(confirmRelease)} className="flex items-center gap-2 px-4 py-2 text-sm bg-green-600 text-white rounded-lg hover:bg-green-700 transition-colors">
                <Unlock className="w-3.5 h-3.5" /> Release Branch
              </button>
            </div>
          </div>
        </Modal>
      )}
    </div>
  );
}

// ── Tickets ───────────────────────────────────────────────────────────────────

function TicketsView({ tickets, onChange }: { tickets: TicketRecord[]; onChange: () => void }) {
  const [detail, setDetail] = useState<TicketRecord | null>(null);

  const priorityOrder = { high: 0, medium: 1, low: 2 };
  const sorted = [...tickets].sort((a, b) => priorityOrder[a.priority] - priorityOrder[b.priority]);

  function updateStatus(id: string, status: TicketRecord["status"]) {
    const all = getTickets();
    saveTickets(all.map((t) => (t.id === id ? { ...t, status } : t)));
    onChange();
    if (detail?.id === id) setDetail((p) => p ? { ...p, status } : p);
  }

  const priorityStyles = {
    high:   "bg-red-100 text-red-700 border-red-200",
    medium: "bg-amber-100 text-amber-700 border-amber-200",
    low:    "bg-slate-100 text-slate-600 border-slate-200",
  };

  const open = tickets.filter((t) => t.status === "open").length;

  return (
    <div className="space-y-6">
      <div>
        <h2 className="text-xl font-bold text-slate-800">Support Tickets</h2>
        <p className="text-xs text-slate-400 mt-0.5">{open} open · {tickets.filter((t) => t.status === "in_progress").length} in progress</p>
      </div>

      {open > 0 && (
        <div className="bg-red-50 border border-red-200 rounded-xl p-4 flex items-center gap-3">
          <Bell className="w-5 h-5 text-red-500 shrink-0" />
          <p className="text-sm text-red-700">
            <span className="font-semibold">{open} open ticket{open > 1 ? "s" : ""}</span> require your attention.
          </p>
        </div>
      )}

      <div className="space-y-3">
        {sorted.map((t) => (
          <div key={t.id} onClick={() => setDetail(t)}
            className="bg-white rounded-xl border border-green-100 shadow-sm p-4 cursor-pointer hover:border-green-300 transition-colors">
            <div className="flex items-start justify-between gap-4 flex-wrap">
              <div className="flex-1 min-w-0">
                <div className="flex items-center gap-2 flex-wrap mb-1">
                  <span className="font-mono text-[10px] text-slate-400">{t.id}</span>
                  <Badge status={t.status} />
                  <span className={`text-[10px] font-semibold uppercase tracking-wide px-2 py-0.5 rounded-md border ${priorityStyles[t.priority]}`}>
                    {t.priority}
                  </span>
                </div>
                <p className="font-bold text-slate-800 truncate">{t.subject}</p>
                <p className="text-xs text-slate-500 mt-0.5">{t.branchName} · {timeAgo(t.submittedAt)}</p>
                <p className="text-xs text-slate-400 mt-1.5 line-clamp-1">{t.message}</p>
              </div>
              <ChevronRight className="w-4 h-4 text-slate-300 shrink-0 mt-1" />
            </div>
          </div>
        ))}
        {sorted.length === 0 && (
          <div className="bg-white rounded-xl border border-green-100 p-12 text-center">
            <Ticket className="w-8 h-8 text-green-300 mx-auto mb-2" />
            <p className="text-xs text-slate-400">No support tickets</p>
          </div>
        )}
      </div>

      {detail && (
        <Modal title={`Ticket ${detail.id}`} onClose={() => setDetail(null)}>
          <div className="space-y-4">
            <div className="flex items-center gap-2 flex-wrap">
              <Badge status={detail.status} />
              <span className={`text-[10px] font-semibold uppercase tracking-wide px-2 py-0.5 rounded-md border ${
                { high: "bg-red-100 text-red-700 border-red-200", medium: "bg-amber-100 text-amber-700 border-amber-200", low: "bg-slate-100 text-slate-600 border-slate-200" }[detail.priority]
              }`}>{detail.priority}</span>
              <span className="font-mono text-[10px] text-slate-400">{fmt(detail.submittedAt)}</span>
            </div>
            <div>
              <p className="font-bold text-slate-800">{detail.subject}</p>
              <p className="text-xs text-green-700 font-semibold mt-0.5">{detail.branchName}</p>
            </div>
            <div className="bg-slate-50 border border-slate-200 rounded-xl p-3">
              <p className="text-xs text-slate-600 leading-relaxed">{detail.message}</p>
            </div>
            <div>
              <label className="text-[10px] font-mono uppercase tracking-widest text-slate-400 block mb-2">Update Status</label>
              <div className="flex gap-2 flex-wrap">
                {(["open","in_progress","resolved"] as TicketRecord["status"][]).map((s) => (
                  <button key={s} onClick={() => updateStatus(detail.id, s)}
                    className={`px-3 py-1.5 text-xs font-semibold rounded-lg border transition-colors ${
                      detail.status === s
                        ? "border-green-500 bg-green-50 text-green-700"
                        : "border-slate-200 text-slate-500 hover:border-green-300"
                    }`}>
                    {s.replace("_", " ")}
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

// ── Admin sign-in gate ─────────────────────────────────────────────────────────
// Route guard: no dashboard data is fetched until a real super-admin session
// exists. The RPCs (admin_list_pharmacy_applications, etc.) already reject a
// non-admin caller server-side, but until this gate existed the UI never even
// asked for credentials — anyone opening #admin saw the dashboard shell.

function AdminAuthGate({ onAuthed }: { onAuthed: (email: string) => void }) {
  const [step, setStep] = useState<"email" | "otp">("email");
  const [email, setEmail] = useState("");
  const [otp, setOtp] = useState(["", "", "", "", "", ""]);
  const [error, setError] = useState("");
  const [sending, setSending] = useState(false);
  const [verifying, setVerifying] = useState(false);

  async function sendCode() {
    if (!email.trim()) { setError("Enter your admin email."); return; }
    setSending(true);
    setError("");
    try {
      await requestAdminOtp(email.trim());
      setStep("otp");
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : "Could not send the code.");
    } finally {
      setSending(false);
    }
  }

  async function verify() {
    const token = otp.join("");
    if (token.length < 6) { setError("Enter the complete 6-digit code."); return; }
    setVerifying(true);
    setError("");
    try {
      await verifyAdminOtp(email.trim(), token);
      onAuthed(email.trim());
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : "Incorrect code, or this account is not a super admin.");
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
      <div className="w-full max-w-sm bg-white rounded-2xl border border-green-100 shadow-sm p-7">
        <div className="w-11 h-11 bg-green-600 rounded-xl flex items-center justify-center mb-5 shadow-sm shadow-green-200">
          <ShieldAlert className="w-5 h-5 text-white" />
        </div>
        <h1 className="font-bold text-slate-800 text-lg mb-1">Super Admin sign-in</h1>
        <p className="text-xs text-slate-500 mb-5">This portal requires a verified platform-admin account.</p>

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
              {sending ? "Sending…" : "Send sign-in code"}
            </button>
          </div>
        ) : (
          <div className="space-y-3">
            <p className="text-xs text-slate-500">Enter the 6-digit code emailed to <strong>{email}</strong>.</p>
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
              {verifying ? "Verifying…" : "Verify & sign in"}
            </button>
            <button onClick={() => { setStep("email"); setOtp(["", "", "", "", "", ""]); setError(""); }}
              className="w-full text-xs text-slate-400 hover:text-slate-600 transition-colors">Use a different email</button>
          </div>
        )}
      </div>
    </div>
  );
}

// ── Main AdminPortal ──────────────────────────────────────────────────────────

const NAV: { id: NavId; label: string; icon: React.ReactNode }[] = [
  { id: "dashboard", label: "Dashboard",  icon: <LayoutDashboard className="w-4 h-4" /> },
  { id: "approvals", label: "Approvals",  icon: <CheckSquare className="w-4 h-4" /> },
  { id: "branches",  label: "Branches",   icon: <Users className="w-4 h-4" /> },
  { id: "security",  label: "Security",   icon: <ShieldAlert className="w-4 h-4" /> },
  { id: "tickets",   label: "Tickets",    icon: <Ticket className="w-4 h-4" /> },
];

export default function AdminPortal() {
  const [authChecked, setAuthChecked] = useState(false);
  const [authed, setAuthed]           = useState(false);
  const [adminEmail, setAdminEmail]   = useState("");
  const [nav, setNav]             = useState<NavId>("dashboard");
  const [branches, setBranches]   = useState<BranchRecord[]>([]);
  const [tickets, setTickets]     = useState<TicketRecord[]>([]);
  const [sidebarOpen, setSidebarOpen] = useState(false);

  useEffect(() => {
    void isSuperAdminSession().then((ok) => { setAuthed(ok); setAuthChecked(true); });
  }, []);

  const refresh = useCallback(async () => {
    try {
      const apps = await listPharmacyApplications();
      setBranches(apps);
      setTickets(getTickets());
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
    return <div className="min-h-screen flex items-center justify-center bg-[var(--background)]"><RefreshCw className="w-5 h-5 text-green-500 animate-spin" /></div>;
  }
  if (!authed) {
    return <AdminAuthGate onAuthed={(email) => { setAuthed(true); setAdminEmail(email); }} />;
  }

  const pending   = branches.filter((b) => b.status === "pending").length;
  const locked    = branches.filter((b) => b.status === "locked").length;
  const openTix   = tickets.filter((t) => t.status === "open").length;
  const badges: Partial<Record<NavId, number>> = { approvals: pending, security: locked, tickets: openTix };

  return (
    <div className="flex h-screen overflow-hidden bg-[var(--background)]">
      {sidebarOpen && (
        <div className="fixed inset-0 z-20 bg-black/30 lg:hidden" onClick={() => setSidebarOpen(false)} />
      )}

      {/* Sidebar */}
      <aside className={`fixed lg:static z-30 flex flex-col w-60 h-full bg-white border-r border-green-100 shadow-sm transition-transform lg:translate-x-0 ${sidebarOpen ? "translate-x-0" : "-translate-x-full"}`}>
        <div className="px-5 py-5 border-b border-green-100">
          <div className="flex items-center gap-3">
            <div className="w-9 h-9 bg-green-600 rounded-xl flex items-center justify-center">
              <ShieldAlert className="w-5 h-5 text-white" />
            </div>
            <div>
              <p className="font-bold text-green-900 text-sm">PharmacySync</p>
              <p className="text-[10px] text-green-600 font-mono">Super Admin</p>
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
                {item.label}
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

        <div className="px-4 py-4 border-t border-green-100">
          <div className="flex items-center gap-2.5 bg-green-50 rounded-xl p-2.5">
            <div className="w-8 h-8 bg-green-600 rounded-lg flex items-center justify-center shrink-0">
              <span className="text-white text-[10px] font-bold">SA</span>
            </div>
            <div className="min-w-0 flex-1">
              <p className="text-xs font-semibold text-slate-700">Super Admin</p>
              <p className="text-[10px] text-slate-400 font-mono truncate">{adminEmail || "signed in"}</p>
            </div>
            <button onClick={handleSignOut} title="Sign out" className="shrink-0 text-slate-400 hover:text-red-600 transition-colors">
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
              <h1 className="font-bold text-slate-800">{NAV.find((n) => n.id === nav)?.label}</h1>
            </div>
          </div>
          <div className="flex items-center gap-3">
            <span className="font-mono text-[10px] text-slate-400 hidden sm:block">MVP v1.0</span>
            <div className="flex items-center gap-1.5">
              <span className="w-2 h-2 rounded-full bg-green-500 animate-pulse" />
              <span className="text-[10px] text-green-600 font-semibold">LIVE</span>
            </div>
          </div>
        </header>

        <main className="flex-1 overflow-y-auto p-4 lg:p-6">
          {nav === "dashboard" && <Dashboard branches={branches} tickets={tickets} />}
          {nav === "approvals" && <Approvals branches={branches} onChange={refresh} />}
          {nav === "branches"  && <BranchDirectory branches={branches} />}
          {nav === "security"  && <Security branches={branches} onChange={refresh} />}
          {nav === "tickets"   && <TicketsView tickets={tickets} onChange={refresh} />}
        </main>
      </div>
    </div>
  );
}
