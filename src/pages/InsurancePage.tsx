import { useEffect, useState } from "react"
import { CenterAlert, SectionHeader } from "../components"
import { loadCoverageOverridesWithNames, loadInsuranceProviders, type CoverageOverrideRow, type InsuranceProvider } from "../lib/sales"

// Read-only for branch users — providers and coverage are managed by the
// super admin (Super Admin Portal → Insurance). This just answers "what does
// this insurer cover?" before a pharmacist rings up a sale.
function ProviderCard({ provider }: { provider: InsuranceProvider }) {
  const [open, setOpen] = useState(false)
  const [overrides, setOverrides] = useState<CoverageOverrideRow[] | null>(null)
  const [loading, setLoading] = useState(false)

  async function toggle() {
    const next = !open
    setOpen(next)
    if (next && overrides === null) {
      setLoading(true)
      try { setOverrides(await loadCoverageOverridesWithNames(provider.id)) } finally { setLoading(false) }
    }
  }

  return (
    <div style={{ background: "#fff", border: "1px solid var(--border)", borderRadius: 12, overflow: "hidden" }}>
      <button onClick={() => void toggle()} style={{ width: "100%", display: "flex", justifyContent: "space-between", alignItems: "center", padding: "14px 16px", background: "none", border: "none", cursor: "pointer", fontFamily: "inherit" }}>
        <div style={{ textAlign: "left" }}>
          <div style={{ fontWeight: 700, fontSize: 14, color: "var(--ink)" }}>{provider.name}</div>
          {provider.contactInfo && <div style={{ fontSize: 11, color: "var(--ink-muted)" }}>{provider.contactInfo}</div>}
        </div>
        <div style={{ display: "flex", alignItems: "center", gap: 10 }}>
          <span style={{ fontSize: 12, fontWeight: 600, color: "var(--primary)", background: "var(--primary-light)", borderRadius: 8, padding: "4px 10px" }}>
            Default {provider.defaultCoveragePercentage}% covered
          </span>
          <span style={{ color: "var(--ink-faint)", transform: open ? "rotate(90deg)" : "none", transition: "transform 0.15s" }}>›</span>
        </div>
      </button>
      {open && (
        <div style={{ borderTop: "1px solid var(--bg-alt)", padding: "10px 16px 14px" }}>
          {loading && <div style={{ fontSize: 12, color: "var(--ink-muted)" }}>Loading exceptions…</div>}
          {!loading && overrides && overrides.length === 0 && (
            <div style={{ fontSize: 12, color: "var(--ink-muted)" }}>Every product uses the default {provider.defaultCoveragePercentage}% — no exceptions.</div>
          )}
          {!loading && overrides && overrides.length > 0 && (
            <div>
              <div style={{ fontSize: 11, fontWeight: 700, color: "var(--ink-muted)", textTransform: "uppercase", letterSpacing: "0.05em", marginBottom: 6 }}>
                Product-specific coverage (overrides the default above)
              </div>
              <div style={{ display: "flex", flexDirection: "column", gap: 4 }}>
                {overrides.map(o => (
                  <div key={o.productId} style={{ display: "flex", justifyContent: "space-between", fontSize: 12, padding: "4px 0" }}>
                    <span style={{ color: "var(--ink)" }}>{o.productName}</span>
                    <span style={{ fontWeight: 600, color: o.coveragePercentage === 0 ? "#dc2626" : "var(--ink)" }}>
                      {o.coveragePercentage === 0 ? "Not covered" : `${o.coveragePercentage}%`}
                    </span>
                  </div>
                ))}
              </div>
            </div>
          )}
        </div>
      )}
    </div>
  )
}

export default function InsurancePage() {
  const [providers, setProviders] = useState<InsuranceProvider[]>([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState("")

  useEffect(() => {
    loadInsuranceProviders()
      .then(setProviders)
      .catch(reason => setError(reason instanceof Error ? reason.message : "Could not load insurance providers."))
      .finally(() => setLoading(false))
  }, [])

  return (
    <div>
      {error && <CenterAlert key={error} message={error} />}
      <SectionHeader title="Insurance" subtitle="Coverage accepted at this pharmacy. Providers and coverage rates are managed by the super admin." />
      {loading ? (
        <div style={{ padding: 40, textAlign: "center", color: "var(--ink-muted)", fontSize: 13 }}>Loading…</div>
      ) : providers.length === 0 ? (
        <div style={{ padding: 40, textAlign: "center", color: "var(--ink-muted)", fontSize: 13, background: "#fff", border: "1px solid var(--border)", borderRadius: 12 }}>No insurance providers have been set up yet.</div>
      ) : (
        <div style={{ display: "flex", flexDirection: "column", gap: 10 }}>
          {providers.map(p => <ProviderCard key={p.id} provider={p} />)}
        </div>
      )}
    </div>
  )
}
