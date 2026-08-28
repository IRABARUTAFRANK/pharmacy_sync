import { useCallback, useEffect, useMemo, useState } from "react"
import { Card, SectionHeader } from "../components"
import { fmtRWFExact } from "../data"
import { useTranslation } from "../lib/i18n"
import { useGlobalSearch } from "../lib/search"
import { listBranchPatients, type PatientListRow } from "../lib/patients"
import { listSaleHistory, type SaleHistoryRow } from "../lib/sales"
import { errorMessage } from "../lib/supabase"

function VisitHistory({ patientId }: { patientId: string }) {
  const { t } = useTranslation()
  const [rows, setRows] = useState<SaleHistoryRow[] | null>(null)
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    let cancelled = false
    listSaleHistory(50, patientId)
      .then(data => { if (!cancelled) setRows(data) })
      .catch(reason => { if (!cancelled) setError(errorMessage(reason, t("patients.historyError"))) })
    return () => { cancelled = true }
  }, [patientId, t])

  if (error) return <p style={{ fontSize: 11, color: "#dc2626", padding: "8px 12px" }}>{error}</p>
  if (!rows) return <p style={{ fontSize: 11, color: "var(--ink-muted)", padding: "8px 12px" }}>{t("patients.historyLoading")}</p>
  if (rows.length === 0) return <p style={{ fontSize: 11, color: "var(--ink-muted)", padding: "8px 12px" }}>{t("patients.historyEmpty")}</p>

  return <div style={{ padding: "6px 12px 12px", overflowX: "auto" }}>
    <table style={{ width: "100%", borderCollapse: "collapse", fontSize: 11 }}>
      <thead><tr>{[t("patients.colReceipt"), t("patients.colDate"), t("patients.colItems"), t("patients.colTotal")].map(l => <th key={l} style={{ textAlign: "left", padding: "4px 8px", color: "var(--ink-muted)", fontSize: 10 }}>{l}</th>)}</tr></thead>
      <tbody>
        {rows.map(row => (
          <tr key={row.saleId} style={{ borderTop: "1px solid var(--bg-alt)" }}>
            <td style={{ padding: "5px 8px", fontFamily: "var(--font-mono)" }}>{row.receiptNumber}</td>
            <td style={{ padding: "5px 8px" }}>{new Date(row.soldAt).toLocaleString()}</td>
            <td style={{ padding: "5px 8px" }}>{row.itemCount}</td>
            <td style={{ padding: "5px 8px", fontWeight: 600 }}>{fmtRWFExact(row.totalAmount)}</td>
          </tr>
        ))}
      </tbody>
    </table>
  </div>
}

export default function PatientsPage() {
  const { t } = useTranslation()
  const [patients, setPatients] = useState<PatientListRow[]>([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const { term: globalTerm, setTerm: setGlobalTerm } = useGlobalSearch()
  const [query, setQuery] = useState(globalTerm)
  useEffect(() => setQuery(globalTerm), [globalTerm])
  const [expanded, setExpanded] = useState<string | null>(null)

  const genderLabel = (g: PatientListRow["gender"]) =>
    g === "male" ? t("patients.genderMale") : g === "female" ? t("patients.genderFemale") : g === "other" ? t("patients.genderOther") : "—"

  const refresh = useCallback(async () => {
    setLoading(true)
    setError(null)
    try {
      setPatients(await listBranchPatients())
    } catch (reason) {
      setError(errorMessage(reason, t("patients.loadError")))
    } finally {
      setLoading(false)
    }
  }, [t])

  useEffect(() => { void refresh() }, [refresh])

  const filtered = useMemo(() => {
    const needle = query.trim().toLowerCase()
    if (!needle) return patients
    return patients.filter(p => `${p.fullName} ${p.tinOrPhone}`.toLowerCase().includes(needle))
  }, [patients, query])

  return <div className="animate-fade-in" style={{ display: "flex", flexDirection: "column", gap: 16 }}>
    {error && <div style={{ background: "#fef2f2", color: "#b91c1c", border: "1px solid #fecaca", borderRadius: 10, padding: "12px 14px", fontSize: 12 }}>{error}</div>}

    <SectionHeader title={t("page.patients")} subtitle={t("patients.subtitle")} action={t("patients.refresh")} onAction={() => void refresh()} />

    <input
      value={query} onChange={e => { setQuery(e.target.value); setGlobalTerm(e.target.value) }}
      placeholder={t("patients.searchPlaceholder")}
      style={{ maxWidth: 360, padding: "8px 12px", border: "1px solid var(--border)", borderRadius: 8, fontFamily: "inherit", fontSize: 12 }}
    />

    <Card>
      <div style={{ overflowX: "auto" }}>
        <table style={{ width: "100%", borderCollapse: "collapse", fontSize: 12 }}>
          <thead><tr style={{ borderBottom: "1px solid var(--border)" }}>
            {[t("patients.colName"), t("patients.colGender"), t("patients.colAge"), t("patients.colContact"), t("patients.colVisits"), t("patients.colLastVisit"), t("patients.colLifetimeSpend")].map(l => <th key={l} style={{ textAlign: "left", padding: "8px 10px", color: "var(--ink-muted)", fontSize: 10 }}>{l}</th>)}
          </tr></thead>
          <tbody>
            {filtered.map(p => (
              <>
                <tr key={p.id} onClick={() => setExpanded(expanded === p.id ? null : p.id)} style={{ borderBottom: "1px solid var(--bg-alt)", cursor: "pointer" }}>
                  <td style={{ padding: "9px 10px", fontWeight: 600 }}>{p.fullName}</td>
                  <td style={{ padding: "9px 10px" }}>{genderLabel(p.gender)}</td>
                  <td style={{ padding: "9px 10px" }}>{p.age ?? "—"}</td>
                  <td style={{ padding: "9px 10px", fontFamily: "var(--font-mono)" }}>{p.tinOrPhone}</td>
                  <td style={{ padding: "9px 10px" }}>{p.visitCount}</td>
                  <td style={{ padding: "9px 10px", color: "var(--ink-muted)" }}>{p.lastVisitAt ? new Date(p.lastVisitAt).toLocaleDateString() : "—"}</td>
                  <td style={{ padding: "9px 10px", fontWeight: 600 }}>{fmtRWFExact(p.lifetimeSpend)}</td>
                </tr>
                {expanded === p.id && (
                  <tr key={`${p.id}-detail`}>
                    <td colSpan={7} style={{ background: "var(--bg)", padding: 0 }}>
                      <VisitHistory patientId={p.id} />
                    </td>
                  </tr>
                )}
              </>
            ))}
            {!loading && filtered.length === 0 && <tr><td colSpan={7} style={{ padding: 28, textAlign: "center", color: "var(--ink-muted)" }}>{patients.length === 0 ? t("patients.emptyNone") : t("patients.emptyFiltered")}</td></tr>}
          </tbody>
        </table>
      </div>
    </Card>
  </div>
}
