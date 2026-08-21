import { useEffect, useState } from "react"
import { createBranchPreviewAccess, listBranchDirectory, type BranchAccess, type BranchDirectoryEntry } from "../lib/auth"

export default function BranchAccessPage({ onAccess }: { onAccess: (access: BranchAccess) => void }) {
  const [branches, setBranches] = useState<BranchDirectoryEntry[]>([])
  const [branchId, setBranchId] = useState("")
  const [error, setError] = useState<string | null>(null)
  const [loading, setLoading] = useState(true)
  const [submitting, setSubmitting] = useState(false)

  useEffect(() => {
    void (async () => {
      try {
        const items = await listBranchDirectory()
        setBranches(items)
        setBranchId(items[0]?.id ?? "")
      } catch {
        setError("The branch directory is not available yet. Run branch_access_setup.sql in Supabase SQL Editor.")
      } finally {
        setLoading(false)
      }
    })()
  }, [])

  function accessDashboard() {
    if (!branchId) return setError("Choose a branch first.")
    const branch = branches.find(item => item.id === branchId)
    if (!branch) return setError("The selected branch is no longer available.")
    setSubmitting(true)
    setError(null)
    onAccess(createBranchPreviewAccess(branch))
  }

  return <main style={{ minHeight: "100vh", display: "grid", placeItems: "center", padding: 24, background: "var(--bg)" }}>
    <section style={{ width: "100%", maxWidth: 430, background: "#fff", border: "1px solid var(--border)", borderRadius: 16, padding: 30, boxShadow: "0 18px 50px rgba(12,30,18,.08)" }}>
      <div style={{ width: 42, height: 42, borderRadius: 11, background: "var(--primary)", color: "#fff", display: "grid", placeItems: "center", fontWeight: 800, marginBottom: 16 }}>Rx</div>
      <h1 style={{ margin: 0, fontSize: 22, color: "var(--ink)" }}>Enter your pharmacy workspace</h1>
      <p style={{ color: "var(--ink-muted)", margin: "8px 0 22px", lineHeight: 1.5, fontSize: 13 }}>Choose a branch to open its dashboard preview.</p>
      <label style={{ display: "block", fontSize: 12, fontWeight: 700, marginBottom: 6 }}>Branch</label>
      <select value={branchId} onChange={event => setBranchId(event.target.value)} disabled={loading} style={{ width: "100%", padding: "10px 12px", border: "1px solid var(--border)", borderRadius: 8, font: "inherit" }}>
        <option value="">{loading ? "Loading branches…" : "Choose a branch"}</option>
        {branches.map(branch => <option key={branch.id} value={branch.id}>{branch.name}</option>)}
      </select>
      {error && <p style={{ color: "#b91c1c", background: "#fef2f2", borderRadius: 7, padding: 10, fontSize: 12, lineHeight: 1.4 }}>{error}</p>}
      <button type="button" onClick={accessDashboard} disabled={loading || submitting} style={{ width: "100%", marginTop: 18, padding: "11px 14px", background: "var(--primary)", color: "#fff", border: 0, borderRadius: 8, font: "inherit", fontWeight: 700, cursor: "pointer", opacity: loading || submitting ? .65 : 1 }}>{submitting ? "Opening dashboard…" : "Access dashboard"}</button>
      <p style={{ textAlign: "center", color: "#b45309", margin: "14px 0 0", fontSize: 11, lineHeight: 1.45 }}>Temporary preview mode: selecting a branch is not a secure sign-in and does not grant access to protected Supabase data.</p>
    </section>
  </main>
}
