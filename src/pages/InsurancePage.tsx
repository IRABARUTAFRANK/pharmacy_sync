import { useEffect, useMemo, useState } from "react"
import { PieChart, Pie, Cell, Tooltip, Legend, ResponsiveContainer } from "recharts"
import { CenterAlert, ColumnPicker, SectionHeader, StatusBadge } from "../components"
import { fmtRWF } from "../data"
import {
  loadBranchInsuranceClaims, loadCoverageOverridesWithNames, loadInsuranceProviders,
  type BranchInsuranceClaim, type CoverageOverrideRow, type InsuranceClaimStatus, type InsuranceProvider,
} from "../lib/sales"

const STATUS_STYLE: Record<InsuranceClaimStatus, { label: string; color: string; bg: string }> = {
  submitted: { label: "Submitted", color: "#2563eb", bg: "#eff6ff" },
  approved: { label: "Approved", color: "#16a34a", bg: "#f0fdf4" },
  paid: { label: "Paid", color: "#7c3aed", bg: "#f5f3ff" },
  rejected: { label: "Rejected", color: "#dc2626", bg: "#fef2f2" },
}

type ClaimColumn = "claimId" | "provider" | "coverage" | "amount" | "status" | "submittedAt"
const CLAIM_COLUMNS: { key: ClaimColumn; label: string }[] = [
  { key: "claimId", label: "Claim ID" }, { key: "provider", label: "Provider" }, { key: "coverage", label: "Coverage %" },
  { key: "amount", label: "Claim amount" }, { key: "status", label: "Status" }, { key: "submittedAt", label: "Submitted at" },
]

// Fixed categorical order, never cycled/reassigned per filter — first 5 slots
// of the validated palette (node scripts/validate_palette.js, light mode,
// surface #fff): passes lightness/chroma/CVD-adjacent/normal-vision-adjacent.
// Identity is never carried by color alone here — every segment also has a
// text legend row and a named table row, so the all-pairs CVD floor (which
// this order doesn't clear past 3 slots) isn't the sole identification path.
const PROVIDER_COLORS = ["#2a78d6", "#eb6834", "#1baf7a", "#eda100", "#e87ba4", "#4a3aa7", "#e34948", "#008300"]
const OTHER_COLOR = "#9ab8a0"

function StatTile({ label, value, accent }: { label: string; value: string; accent?: string }) {
  return (
    <div style={{ flex: "1 1 180px", minWidth: 160, background: "#fff", border: "1px solid var(--border)", borderRadius: 12, padding: "16px 18px" }}>
      <div style={{ fontSize: 22, fontWeight: 700, color: accent ?? "var(--ink)", letterSpacing: "-0.01em" }}>{value}</div>
      <div style={{ fontSize: 12, color: "var(--ink-muted)", marginTop: 2 }}>{label}</div>
    </div>
  )
}

function ClaimsPieTooltip({ active, payload }: any) {
  if (!active || !payload?.length) return null
  const p = payload[0]
  return (
    <div style={{ background: "#fff", border: "1px solid var(--border)", borderRadius: 8, padding: "8px 12px", boxShadow: "0 4px 20px rgba(0,0,0,0.08)", fontSize: 12 }}>
      <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
        <div style={{ width: 8, height: 8, borderRadius: "50%", background: p.payload.color, flexShrink: 0 }} />
        <span style={{ fontWeight: 600, color: "var(--ink)" }}>{p.name}</span>
      </div>
      <div style={{ color: "var(--ink-muted)", marginTop: 3 }}>{fmtRWF(p.value)} claimed</div>
    </div>
  )
}

interface ProviderRow {
  provider: InsuranceProvider
  color: string
  claimCount: number
  totalClaimed: number
}

function ProviderTableRow({ row }: { row: ProviderRow }) {
  const [open, setOpen] = useState(false)
  const [overrides, setOverrides] = useState<CoverageOverrideRow[] | null>(null)
  const [loading, setLoading] = useState(false)

  async function toggle() {
    const next = !open
    setOpen(next)
    if (next && overrides === null) {
      setLoading(true)
      try { setOverrides(await loadCoverageOverridesWithNames(row.provider.id)) } finally { setLoading(false) }
    }
  }

  return (
    <>
      <tr onClick={() => void toggle()} style={{ borderBottom: "1px solid var(--bg-alt)", cursor: "pointer" }}>
        <td style={{ padding: "10px 12px" }}>
          <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
            <span style={{ width: 8, height: 8, borderRadius: "50%", background: row.color, flexShrink: 0 }} />
            <span style={{ fontWeight: 600, color: "var(--ink)" }}>{row.provider.name}</span>
            <span style={{ color: "var(--ink-faint)", fontSize: 11, transform: open ? "rotate(90deg)" : "none", transition: "transform 0.15s" }}>›</span>
          </div>
        </td>
        <td style={{ padding: "10px 12px", color: "var(--ink-mid)" }}>{row.provider.defaultCoveragePercentage}%</td>
        <td style={{ padding: "10px 12px", color: "var(--ink-mid)" }}>{row.claimCount}</td>
        <td style={{ padding: "10px 12px", fontWeight: 700, color: "var(--ink)" }}>{fmtRWF(row.totalClaimed)}</td>
        <td style={{ padding: "10px 12px", color: "var(--ink-muted)", fontSize: 12 }}>{row.provider.contactInfo || "—"}</td>
      </tr>
      {open && (
        <tr>
          <td colSpan={5} style={{ padding: "6px 12px 14px 30px", background: "var(--bg)" }}>
            {loading && <div style={{ fontSize: 12, color: "var(--ink-muted)" }}>Loading coverage…</div>}
            {!loading && overrides && overrides.length === 0 && (
              <div style={{ fontSize: 12, color: "var(--ink-muted)" }}>Every product uses the default {row.provider.defaultCoveragePercentage}% — no exceptions.</div>
            )}
            {!loading && overrides && overrides.length > 0 && (
              <div style={{ display: "flex", flexDirection: "column", gap: 4 }}>
                <div style={{ fontSize: 10, fontWeight: 700, color: "var(--ink-muted)", textTransform: "uppercase", letterSpacing: "0.05em", marginBottom: 2 }}>
                  Product-specific coverage (overrides the default)
                </div>
                {overrides.map(o => (
                  <div key={o.productId} style={{ display: "flex", justifyContent: "space-between", fontSize: 12, maxWidth: 420 }}>
                    <span style={{ color: "var(--ink)" }}>{o.productName}</span>
                    <span style={{ fontWeight: 600, color: o.coveragePercentage === 0 ? "#dc2626" : "var(--ink)" }}>
                      {o.coveragePercentage === 0 ? "Not covered" : `${o.coveragePercentage}%`}
                    </span>
                  </div>
                ))}
              </div>
            )}
          </td>
        </tr>
      )}
    </>
  )
}

// The individual claims behind the summary above. Deliberately no "add a
// claim" action here (a template this was modeled on had one) — a claim is
// never created by hand. It's a byproduct of complete_sale(): every sale
// that uses insurance writes exactly one insurance_claims row atomically
// alongside the sale itself, so the list here can only ever reflect a real
// completed sale, never a fabricated one. Same reasoning applies to status —
// only the insurer's own decision should move a claim from submitted to
// approved/paid/rejected, and there's no RPC for that yet, so it's read-only
// here too.
function ClaimsTable({ claims, providers }: { claims: BranchInsuranceClaim[]; providers: InsuranceProvider[] }) {
  const [providerFilter, setProviderFilter] = useState<string>("")
  const [statusFilter, setStatusFilter] = useState<string>("")
  const [visibleColumns, setVisibleColumns] = useState<Set<ClaimColumn>>(new Set(CLAIM_COLUMNS.map(c => c.key)))
  const providerById = new Map(providers.map(p => [p.id, p]))

  const filtered = claims.filter(c => (!providerFilter || c.providerId === providerFilter) && (!statusFilter || c.status === statusFilter))
  const toggleColumn = (key: ClaimColumn) => setVisibleColumns(current => {
    const next = new Set(current)
    if (next.has(key) && next.size > 1) next.delete(key)
    else next.add(key)
    return next
  })

  return (
    <div style={{ background: "#fff", border: "1px solid var(--border)", borderRadius: 12, overflow: "hidden", marginTop: 16 }}>
      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", flexWrap: "wrap", gap: 10, padding: 16 }}>
        <div style={{ fontWeight: 700, fontSize: 14, color: "var(--ink)" }}>Insurance Claims <span style={{ fontWeight: 400, color: "var(--ink-faint)", fontFamily: "monospace", fontSize: 11 }}>— insurance_claims</span></div>
        <div style={{ display: "flex", gap: 8, flexWrap: "wrap" }}>
          <select value={providerFilter} onChange={e => setProviderFilter(e.target.value)} style={{ padding: "6px 10px", borderRadius: 8, border: "1px solid var(--border)", fontSize: 12, fontFamily: "inherit", background: "var(--bg)" }}>
            <option value="">All Providers</option>
            {providers.map(p => <option key={p.id} value={p.id}>{p.name}</option>)}
          </select>
          <select value={statusFilter} onChange={e => setStatusFilter(e.target.value)} style={{ padding: "6px 10px", borderRadius: 8, border: "1px solid var(--border)", fontSize: 12, fontFamily: "inherit", background: "var(--bg)" }}>
            <option value="">All Statuses</option>
            {Object.entries(STATUS_STYLE).map(([value, s]) => <option key={value} value={value}>{s.label}</option>)}
          </select>
          <ColumnPicker columns={CLAIM_COLUMNS} visible={visibleColumns} onToggle={toggleColumn} />
        </div>
      </div>
      <div style={{ overflowX: "auto" }}>
        <table style={{ width: "100%", borderCollapse: "collapse", fontSize: 13 }}>
          <thead>
            <tr style={{ borderBottom: "1px solid var(--border)" }}>
              {CLAIM_COLUMNS.filter(c => visibleColumns.has(c.key)).map(c => (
                <th key={c.key} style={{ textAlign: "left", padding: "8px 16px", fontWeight: 500, fontSize: 11, color: "var(--ink-muted)", letterSpacing: "0.03em", textTransform: "uppercase" }}>{c.label}</th>
              ))}
            </tr>
          </thead>
          <tbody>
            {filtered.map(claim => {
              const provider = providerById.get(claim.providerId)
              const status = STATUS_STYLE[claim.status]
              return (
                <tr key={claim.id} style={{ borderBottom: "1px solid var(--bg-alt)" }}>
                  {visibleColumns.has("claimId") && <td style={{ padding: "10px 16px", fontFamily: "monospace", fontSize: 12, color: "var(--primary)" }}>CLM-{claim.id.slice(0, 6).toUpperCase()}</td>}
                  {visibleColumns.has("provider") && <td style={{ padding: "10px 16px" }}><StatusBadge label={provider?.name ?? "Unknown"} color="var(--primary)" bg="var(--primary-light)" /></td>}
                  {visibleColumns.has("coverage") && <td style={{ padding: "10px 16px", fontWeight: 600, color: "var(--ink)" }}>{claim.coveragePercentageApplied}%</td>}
                  {visibleColumns.has("amount") && <td style={{ padding: "10px 16px", fontWeight: 700, color: "var(--ink)" }}>{fmtRWF(claim.claimAmount)}</td>}
                  {visibleColumns.has("status") && <td style={{ padding: "10px 16px" }}><StatusBadge label={status.label} color={status.color} bg={status.bg} /></td>}
                  {visibleColumns.has("submittedAt") && <td style={{ padding: "10px 16px", color: "var(--ink-muted)", fontSize: 12 }}>{new Date(claim.submittedAt).toLocaleString()}</td>}
                </tr>
              )
            })}
          </tbody>
        </table>
        {filtered.length === 0 && <div style={{ padding: 30, textAlign: "center", fontSize: 12, color: "var(--ink-muted)" }}>No claims match these filters.</div>}
      </div>
      <div style={{ padding: "10px 16px", borderTop: "1px solid var(--bg-alt)", fontSize: 11, color: "var(--ink-faint)" }}>
        {filtered.length} claim{filtered.length === 1 ? "" : "s"} · {visibleColumns.size} of {CLAIM_COLUMNS.length} columns visible
      </div>
    </div>
  )
}

// What each insurer owes this branch: real insurance_claims rows, one per
// sale that used insurance (see complete_sale()), scoped to this branch by
// RLS. Coverage-rate management (default % + per-product overrides,
// including "not covered") lives in the Super Admin Portal — this page is
// the branch's own view of the money side, plus a read-only look at why a
// given product's coverage is what it is.
export default function InsurancePage() {
  const [providers, setProviders] = useState<InsuranceProvider[]>([])
  const [claims, setClaims] = useState<BranchInsuranceClaim[]>([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState("")

  useEffect(() => {
    Promise.all([loadInsuranceProviders(), loadBranchInsuranceClaims()])
      .then(([p, c]) => { setProviders(p); setClaims(c) })
      .catch(reason => setError(reason instanceof Error ? reason.message : "Could not load insurance data."))
      .finally(() => setLoading(false))
  }, [])

  const { rows, chartData, totalClaimed, paidOut, pendingPayout } = useMemo(() => {
    const claimsByProvider = new Map<string, BranchInsuranceClaim[]>()
    for (const claim of claims) {
      const list = claimsByProvider.get(claim.providerId) ?? []
      list.push(claim)
      claimsByProvider.set(claim.providerId, list)
    }

    const rows: ProviderRow[] = providers
      .map((provider, i) => {
        const providerClaims = claimsByProvider.get(provider.id) ?? []
        return {
          provider,
          color: PROVIDER_COLORS[i] ?? OTHER_COLOR,
          claimCount: providerClaims.length,
          totalClaimed: providerClaims.reduce((sum, c) => sum + c.claimAmount, 0),
        }
      })
      .sort((a, b) => b.totalClaimed - a.totalClaimed)

    const chartData = rows.filter(r => r.totalClaimed > 0).map(r => ({ name: r.provider.name, value: r.totalClaimed, color: r.color }))
    const totalClaimed = claims.reduce((sum, c) => sum + c.claimAmount, 0)
    const paidOut = claims.filter(c => c.status === "paid").reduce((sum, c) => sum + c.claimAmount, 0)
    const pendingPayout = claims.filter(c => c.status === "submitted" || c.status === "approved").length

    return { rows, chartData, totalClaimed, paidOut, pendingPayout }
  }, [providers, claims])

  return (
    <div>
      {error && <CenterAlert key={error} message={error} />}
      <SectionHeader title="Insurance" subtitle="What each insurer owes this branch, from real completed sales. Coverage rates are managed by the super admin." />

      {loading ? (
        <div style={{ padding: 40, textAlign: "center", color: "var(--ink-muted)", fontSize: 13 }}>Loading…</div>
      ) : providers.length === 0 ? (
        <div style={{ padding: 40, textAlign: "center", color: "var(--ink-muted)", fontSize: 13, background: "#fff", border: "1px solid var(--border)", borderRadius: 12 }}>No insurance providers have been set up yet.</div>
      ) : (
        <div>
          <div style={{ display: "flex", gap: 12, flexWrap: "wrap", marginBottom: 16 }}>
            <StatTile label="Providers" value={String(providers.length)} />
            <StatTile label="Total claimed" value={fmtRWF(totalClaimed)} accent="var(--primary)" />
            <StatTile label="Paid out" value={fmtRWF(paidOut)} accent="#16a34a" />
            <StatTile label="Pending payout" value={String(pendingPayout)} accent={pendingPayout > 0 ? "#d97706" : undefined} />
          </div>

          <div style={{ display: "flex", gap: 16, flexWrap: "wrap", alignItems: "stretch" }}>
            <div style={{ flex: "1 1 320px", minWidth: 300, background: "#fff", border: "1px solid var(--border)", borderRadius: 12, padding: 16 }}>
              <div style={{ fontWeight: 700, fontSize: 14, color: "var(--ink)" }}>Claims by Provider</div>
              <div style={{ fontSize: 11, color: "var(--ink-muted)", marginBottom: 8 }}>insurance_claims grouped by provider</div>
              {chartData.length === 0 ? (
                <div style={{ padding: "30px 0", textAlign: "center", fontSize: 12, color: "var(--ink-muted)" }}>No claims yet.</div>
              ) : (
                <ResponsiveContainer width="100%" height={260}>
                  <PieChart>
                    <Pie data={chartData} dataKey="value" nameKey="name" innerRadius={62} outerRadius={92} paddingAngle={2} stroke="#fff" strokeWidth={2}>
                      {chartData.map((d, i) => <Cell key={i} fill={d.color} />)}
                    </Pie>
                    <Tooltip content={<ClaimsPieTooltip />} />
                    <Legend
                      layout="vertical" verticalAlign="middle" align="right"
                      formatter={(value: string) => <span style={{ fontSize: 12, color: "var(--ink-mid)" }}>{value}</span>}
                    />
                  </PieChart>
                </ResponsiveContainer>
              )}
            </div>

            <div style={{ flex: "2 1 480px", minWidth: 380, background: "#fff", border: "1px solid var(--border)", borderRadius: 12, overflow: "hidden" }}>
              <div style={{ padding: "16px 16px 4px", fontWeight: 700, fontSize: 14, color: "var(--ink)" }}>Insurance Providers</div>
              <div style={{ overflowX: "auto" }}>
                <table style={{ width: "100%", borderCollapse: "collapse", fontSize: 13 }}>
                  <thead>
                    <tr style={{ borderBottom: "1px solid var(--border)" }}>
                      {["Provider", "Default coverage %", "Claims", "Total claimed", "Contact"].map(h => (
                        <th key={h} style={{ textAlign: "left", padding: "8px 12px", fontWeight: 500, fontSize: 11, color: "var(--ink-muted)", letterSpacing: "0.03em" }}>{h}</th>
                      ))}
                    </tr>
                  </thead>
                  <tbody>
                    {rows.map(row => <ProviderTableRow key={row.provider.id} row={row} />)}
                  </tbody>
                </table>
              </div>
            </div>
          </div>

          <ClaimsTable claims={claims} providers={providers} />
        </div>
      )}
    </div>
  )
}
