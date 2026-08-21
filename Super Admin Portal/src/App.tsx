import { useState, useEffect } from "react";
import { ShieldCheck, Building2, ArrowRight, Activity } from "lucide-react";
import AdminPortal from "./components/AdminPortal";
import BranchPortal from "./components/BranchPortal";

type View = "landing" | "admin" | "branch";

function useHashRouter(): [View, (v: View) => void] {
  const hashToView = (h: string): View => {
    if (h === "#admin") return "admin";
    if (h === "#branch") return "branch";
    return "landing";
  };

  const [view, setViewState] = useState<View>(() => hashToView(window.location.hash));

  useEffect(() => {
    const handler = () => setViewState(hashToView(window.location.hash));
    window.addEventListener("hashchange", handler);
    return () => window.removeEventListener("hashchange", handler);
  }, []);

  function setView(v: View) {
    window.location.hash = v === "landing" ? "" : v;
    setViewState(v);
  }

  return [view, setView];
}

export default function App() {
  const [view, setView] = useHashRouter();

  if (view === "admin")  return <AdminPortal />;
  if (view === "branch") return <BranchPortal />;

  // ── Landing page ───────────────────────────────────────────────────────────
  return (
    <div className="min-h-screen bg-gradient-to-br from-green-50 via-white to-emerald-50 flex flex-col">
      {/* Header */}
      <header className="bg-white/80 backdrop-blur-sm border-b border-green-100 px-6 py-4 sticky top-0 z-10">
        <div className="max-w-5xl mx-auto flex items-center justify-between">
          <div className="flex items-center gap-3">
            <div className="w-9 h-9 bg-green-600 rounded-xl flex items-center justify-center shadow-sm shadow-green-200">
              <Activity className="w-5 h-5 text-white" />
            </div>
            <div>
              <p className="font-bold text-green-900 leading-tight">PharmacySync</p>
              <p className="text-[10px] text-green-600 font-mono uppercase tracking-widest">Management System</p>
            </div>
          </div>
          <span className="font-mono text-[10px] text-slate-400">v1.0 · MVP</span>
        </div>
      </header>

      {/* Hero */}
      <main className="flex-1 flex flex-col items-center justify-center px-4 py-16">
        <div className="max-w-4xl w-full text-center mb-12">
          <div className="inline-flex items-center gap-2 bg-green-100 text-green-700 text-xs font-semibold px-3 py-1.5 rounded-full mb-6">
            <span className="w-1.5 h-1.5 rounded-full bg-green-500 animate-pulse" />
            System Online
          </div>
          <h1 className="text-4xl sm:text-5xl font-bold text-slate-900 leading-tight mb-4">
            Pharmacy Branch<br />
            <span className="text-green-600">Sync System</span>
          </h1>
          <p className="text-slate-500 text-lg max-w-xl mx-auto">
            A unified portal for managing pharmacy branch registrations, verifications, and operations across the network.
          </p>
        </div>

        {/* Portal cards */}
        <div className="grid sm:grid-cols-2 gap-6 w-full max-w-2xl">
          {/* Admin card */}
          <button
            onClick={() => setView("admin")}
            className="group bg-white rounded-2xl border border-green-100 shadow-sm hover:shadow-md hover:border-green-300 p-7 text-left transition-all duration-200"
          >
            <div className="w-12 h-12 bg-green-600 rounded-xl flex items-center justify-center mb-5 group-hover:scale-105 transition-transform shadow-sm shadow-green-200">
              <ShieldCheck className="w-6 h-6 text-white" />
            </div>
            <h2 className="text-lg font-bold text-slate-800 mb-1.5">Super Admin</h2>
            <p className="text-sm text-slate-500 leading-relaxed mb-5">
              Manage branch approvals, review registrations, handle security incidents, and monitor support tickets.
            </p>
            <div className="flex items-center gap-1.5 text-green-600 text-sm font-semibold group-hover:gap-2.5 transition-all">
              Access Admin Portal <ArrowRight className="w-4 h-4" />
            </div>
          </button>

          {/* Branch card */}
          <button
            onClick={() => setView("branch")}
            className="group bg-white rounded-2xl border border-green-100 shadow-sm hover:shadow-md hover:border-green-300 p-7 text-left transition-all duration-200"
          >
            <div className="w-12 h-12 bg-emerald-500 rounded-xl flex items-center justify-center mb-5 group-hover:scale-105 transition-transform shadow-sm shadow-emerald-200">
              <Building2 className="w-6 h-6 text-white" />
            </div>
            <h2 className="text-lg font-bold text-slate-800 mb-1.5">Branch Portal</h2>
            <p className="text-sm text-slate-500 leading-relaxed mb-5">
              Register your pharmacy branch, get verified by our admin team, and activate your PharmacySync account.
            </p>
            <div className="flex items-center gap-1.5 text-emerald-600 text-sm font-semibold group-hover:gap-2.5 transition-all">
              Register Your Branch <ArrowRight className="w-4 h-4" />
            </div>
          </button>
        </div>

        {/* Flow diagram */}
        <div className="mt-14 max-w-3xl w-full">
          <p className="text-[10px] font-mono uppercase tracking-widest text-slate-400 text-center mb-6">How It Works</p>
          <div className="grid grid-cols-2 sm:grid-cols-5 gap-3 items-center">
            {[
              { step: "1", label: "Branch registers with name, phone, email & location" },
              null,
              { step: "2", label: "Admin calls branch to verify, then approves & sends OTP" },
              null,
              { step: "3", label: "Branch enters OTP · receives unique PSYNC code" },
            ].map((item, i) => {
              if (!item) return (
                <div key={i} className="hidden sm:flex items-center justify-center">
                  <ArrowRight className="w-5 h-5 text-green-300" />
                </div>
              );
              return (
                <div key={i} className="bg-white border border-green-100 rounded-xl p-4 text-center">
                  <div className="w-7 h-7 bg-green-600 rounded-full flex items-center justify-center text-white text-xs font-bold mx-auto mb-2">
                    {item.step}
                  </div>
                  <p className="text-[11px] text-slate-500 leading-relaxed">{item.label}</p>
                </div>
              );
            })}
          </div>
        </div>
      </main>

      <footer className="text-center py-6 border-t border-green-100">
        <p className="text-[11px] text-slate-400 font-mono">PharmacySync © 2026 · Secure Branch Management</p>
      </footer>
    </div>
  );
}
