import { useEffect, useMemo, useState } from "react"
import { Btn, CenterAlert, SectionHeader } from "../components"
import { fmtRWFExact } from "../data"
import { useTranslation } from "../lib/i18n"
import { HISTORY_CATEGORIES, loadBranchHistory, type HistoryCategory, type HistoryEvent } from "../lib/history"

// Fixed order, not cycled — the same validated 8-slot categorical palette
// used for the Insurance donut chart. Every use here is a badge with its own
// text label right next to it, so unlike a bare legend this never leans on
// hue alone for identity; the order is kept anyway for consistency with the
// rest of the app's charts.
const CATEGORY_COLOR: Record<HistoryCategory, string> = {
  sale: "#2a78d6", stock_adjustment: "#eb6834", stock_received: "#1baf7a", insurance_claim: "#eda100",
  patient: "#e87ba4", product_request: "#008300", staff: "#4a3aa7", batch_recall: "#e34948",
}

function CategoryBadge({ category, label }: { category: HistoryCategory; label: string }) {
  const color = CATEGORY_COLOR[category]
  return (
    <span style={{ display: "inline-block", fontSize: 11, fontWeight: 600, color, background: `${color}1A`, borderRadius: 6, padding: "3px 8px", whiteSpace: "nowrap" }}>
      {label}
    </span>
  )
}

function csvEscape(value: string): string {
  return /[",\n]/.test(value) ? `"${value.replace(/"/g, '""')}"` : value
}

// Owner-only, enforced by list_branch_history() itself (raises if the caller
// isn't the branch owner) — App.tsx's nav also hides this page from anyone
// else, but that's convenience, not the actual gate.
export default function HistoryPage() {
  const { t } = useTranslation()
  const [events, setEvents] = useState<HistoryEvent[]>([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState("")
  const [query, setQuery] = useState("")
  const [dateFrom, setDateFrom] = useState("")
  const [dateTo, setDateTo] = useState("")
  const [activeCategories, setActiveCategories] = useState<Set<HistoryCategory>>(new Set(HISTORY_CATEGORIES))

  const refresh = useMemo(() => async () => {
    setLoading(true)
    setError("")
    try {
      const from = dateFrom ? new Date(`${dateFrom}T00:00:00`).toISOString() : undefined
      const to = dateTo ? new Date(`${dateTo}T23:59:59.999`).toISOString() : undefined
      setEvents(await loadBranchHistory(from, to))
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : t("history.loadError"))
    } finally {
      setLoading(false)
    }
  }, [dateFrom, dateTo, t])

  useEffect(() => { void refresh() }, [refresh])

  function toggleCategory(cat: HistoryCategory) {
    setActiveCategories(current => {
      const next = new Set(current)
      if (next.has(cat) && next.size > 1) next.delete(cat)
      else next.add(cat)
      return next
    })
  }

  const filtered = useMemo(() => {
    const needle = query.trim().toLowerCase()
    return events.filter(e => activeCategories.has(e.category) && (!needle || `${e.title} ${e.description} ${e.actorName ?? ""}`.toLowerCase().includes(needle)))
  }, [events, activeCategories, query])

  function downloadCsv() {
    const header = ["Date & Time", "Category", "Event", "Description", "Amount", "By"]
    const rows = filtered.map(e => [
      new Date(e.eventAt).toLocaleString(), t(`history.category.${e.category}` as any), e.title, e.description,
      e.amount === null ? "" : String(e.amount), e.actorName ?? "",
    ])
    const csv = [header, ...rows].map(row => row.map(cell => csvEscape(String(cell))).join(",")).join("\n")
    const blob = new Blob([csv], { type: "text/csv;charset=utf-8;" })
    const url = URL.createObjectURL(blob)
    const a = document.createElement("a")
    a.href = url
    a.download = `history-${new Date().toISOString().slice(0, 10)}.csv`
    document.body.appendChild(a)
    a.click()
    a.remove()
    URL.revokeObjectURL(url)
  }

  return (
    <div className="animate-fade-in">
      {error && <CenterAlert key={error} message={error} />}
      <SectionHeader title={t("page.history")} subtitle={t("history.subtitle")} />

      <div className="no-print" style={{ display: "flex", flexWrap: "wrap", alignItems: "flex-end", gap: 10, marginBottom: 12 }}>
        <input
          value={query} onChange={e => setQuery(e.target.value)}
          placeholder={t("history.searchPlaceholder")}
          style={{ maxWidth: 320, flex: "1 1 240px", padding: "8px 12px", border: "1px solid var(--border)", borderRadius: 8, fontFamily: "inherit", fontSize: 12 }}
        />
        <div>
          <label style={{ display: "block", fontSize: 10, fontWeight: 600, color: "var(--ink-muted)", textTransform: "uppercase", letterSpacing: "0.05em", marginBottom: 4 }}>{t("history.dateFromLabel")}</label>
          <input type="date" value={dateFrom} onChange={e => setDateFrom(e.target.value)} style={{ padding: "7px 10px", border: "1px solid var(--border)", borderRadius: 8, fontFamily: "inherit", fontSize: 12 }} />
        </div>
        <div>
          <label style={{ display: "block", fontSize: 10, fontWeight: 600, color: "var(--ink-muted)", textTransform: "uppercase", letterSpacing: "0.05em", marginBottom: 4 }}>{t("history.dateToLabel")}</label>
          <input type="date" value={dateTo} onChange={e => setDateTo(e.target.value)} style={{ padding: "7px 10px", border: "1px solid var(--border)", borderRadius: 8, fontFamily: "inherit", fontSize: 12 }} />
        </div>
        {(dateFrom || dateTo) && (
          <button onClick={() => { setDateFrom(""); setDateTo("") }} style={{ padding: "7px 12px", border: "1px solid var(--border)", borderRadius: 8, background: "#fff", fontFamily: "inherit", fontSize: 12, color: "var(--ink-muted)", cursor: "pointer" }}>
            {t("history.clearDates")}
          </button>
        )}
        <div style={{ flex: 1 }} />
        <Btn variant="ghost" onClick={downloadCsv}>⬇ {t("history.downloadCsv")}</Btn>
        <Btn variant="ghost" onClick={() => window.print()}>🖨 {t("history.print")}</Btn>
      </div>

      <div className="no-print" style={{ display: "flex", flexWrap: "wrap", gap: 6, marginBottom: 14 }}>
        <span style={{ fontSize: 11, fontWeight: 600, color: "var(--ink-muted)", marginRight: 2, alignSelf: "center" }}>{t("history.categoriesLabel")}:</span>
        {HISTORY_CATEGORIES.map(cat => {
          const active = activeCategories.has(cat)
          const color = CATEGORY_COLOR[cat]
          return (
            <button key={cat} onClick={() => toggleCategory(cat)} style={{
              fontSize: 11, fontWeight: 600, padding: "4px 10px", borderRadius: 20, cursor: "pointer", fontFamily: "inherit",
              border: `1px solid ${active ? color : "var(--border)"}`, background: active ? `${color}1A` : "#fff", color: active ? color : "var(--ink-faint)",
              transition: "all 0.13s",
            }}>
              {t(`history.category.${cat}` as any)}
            </button>
          )
        })}
      </div>

      <div style={{ background: "#fff", border: "1px solid var(--border)", borderRadius: 12, overflow: "hidden" }}>
        {loading ? (
          <div style={{ padding: 40, textAlign: "center", color: "var(--ink-muted)", fontSize: 13 }}>{t("history.loading")}</div>
        ) : filtered.length === 0 ? (
          <div style={{ padding: 40, textAlign: "center", color: "var(--ink-muted)", fontSize: 13 }}>{events.length === 0 ? t("history.empty") : t("history.emptyFiltered")}</div>
        ) : (
          <div style={{ overflowX: "auto" }}>
            <table style={{ width: "100%", borderCollapse: "collapse", fontSize: 12 }}>
              <thead>
                <tr style={{ borderBottom: "1px solid var(--border)" }}>
                  {[t("history.colDate"), t("history.colCategory"), t("history.colEvent"), t("history.colAmount"), t("history.colBy")].map(h => (
                    <th key={h} style={{ textAlign: "left", padding: "8px 12px", fontWeight: 500, fontSize: 10, color: "var(--ink-muted)", letterSpacing: "0.04em", textTransform: "uppercase" }}>{h}</th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {filtered.map((e, i) => (
                  <tr key={i} style={{ borderBottom: "1px solid var(--bg-alt)" }}>
                    <td style={{ padding: "9px 12px", color: "var(--ink-muted)", whiteSpace: "nowrap" }}>{new Date(e.eventAt).toLocaleString()}</td>
                    <td style={{ padding: "9px 12px" }}><CategoryBadge category={e.category} label={t(`history.category.${e.category}` as any)} /></td>
                    <td style={{ padding: "9px 12px", maxWidth: 420 }}>
                      <div style={{ fontWeight: 600, color: "var(--ink)" }}>{e.title}</div>
                      <div style={{ fontSize: 11, color: "var(--ink-muted)" }}>{e.description}</div>
                    </td>
                    <td style={{ padding: "9px 12px", fontWeight: 700, color: "var(--ink)", whiteSpace: "nowrap" }}>{e.amount === null ? "—" : fmtRWFExact(e.amount)}</td>
                    <td style={{ padding: "9px 12px", color: "var(--ink-muted)" }}>{e.actorName ?? "—"}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </div>
      <div style={{ marginTop: 10, fontSize: 11, color: "var(--ink-faint)" }}>{t("history.rowCount", { count: filtered.length })}</div>
    </div>
  )
}
