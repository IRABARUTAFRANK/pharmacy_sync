import { useEffect, useMemo, useState } from "react"
import { Btn, CenterAlert, SectionHeader } from "../components"
import { fmtRWFExact } from "../data"
import { useTranslation } from "../lib/i18n"
import { HISTORY_CATEGORIES, loadBranchHistory, type HistoryCategory, type HistoryEvent } from "../lib/history"
import { resolveRange, toDateInputValue, type OverviewPeriod } from "../lib/overview"

// One icon + one color per real event source -- every category here maps to
// an actual table this branch writes to (see list_branch_history() in the
// schema): sales, stock_batches, stock_adjustments, batch_recalls,
// insurance_claims, barcodes, notifications, support_tickets, patients,
// product_requests, and seller accounts. Nothing here is decorative filler
// for a category that doesn't exist in the database.
const CATEGORY_META: Record<HistoryCategory, { icon: string; color: string }> = {
  stock_batch: { icon: "📦", color: "#16a34a" },
  stock_adjustment: { icon: "⚖️", color: "#d97706" },
  batch_recall: { icon: "🚨", color: "#dc2626" },
  sale: { icon: "🧾", color: "#2a78d6" },
  insurance_claim: { icon: "🏥", color: "#7c3aed" },
  barcode_created: { icon: "▦", color: "#0d9488" },
  notification: { icon: "🔔", color: "#eab308" },
  support_ticket: { icon: "💬", color: "#0ea5e9" },
  patient: { icon: "🧑", color: "#e87ba4" },
  product_request: { icon: "🛒", color: "#4a3aa7" },
  staff: { icon: "🧑‍💼", color: "#64748b" },
}

// Every real status value this app's tables can actually hold, grouped by
// what it means rather than which table it came from -- "approved" (a claim)
// and "read" (a notification) both mean "this is settled/good", so they get
// the same green. Anything not listed here (there shouldn't be any) falls
// back to a neutral gray rather than guessing.
const STATUS_STYLE: Record<string, { color: string; bg: string }> = {
  paid: { color: "#16a34a", bg: "#f0fdf4" },
  approved: { color: "#16a34a", bg: "#f0fdf4" },
  resolved: { color: "#16a34a", bg: "#f0fdf4" },
  read: { color: "#16a34a", bg: "#f0fdf4" },
  active: { color: "#16a34a", bg: "#f0fdf4" },
  correction: { color: "#2563eb", bg: "#eff6ff" },
  submitted: { color: "#2563eb", bg: "#eff6ff" },
  return: { color: "#2563eb", bg: "#eff6ff" },
  pending: { color: "#d97706", bg: "#fffbeb" },
  in_progress: { color: "#d97706", bg: "#fffbeb" },
  unread: { color: "#d97706", bg: "#fffbeb" },
  open: { color: "#dc2626", bg: "#fef2f2" },
  damage: { color: "#dc2626", bg: "#fef2f2" },
  loss: { color: "#dc2626", bg: "#fef2f2" },
  rejected: { color: "#dc2626", bg: "#fef2f2" },
  recalled: { color: "#dc2626", bg: "#fef2f2" },
  sold_out: { color: "#dc2626", bg: "#fef2f2" },
  damaged: { color: "#dc2626", bg: "#fef2f2" },
  expired_writeoff: { color: "#7c3aed", bg: "#f5f3ff" },
  expired: { color: "#7c3aed", bg: "#f5f3ff" },
  closed: { color: "#64748b", bg: "#f1f5f9" },
}
const DEFAULT_STATUS_STYLE = { color: "#64748b", bg: "#f1f5f9" }

function Tag({ label, color, bg }: { label: string; color: string; bg: string }) {
  return (
    <span style={{ display: "inline-block", fontSize: 11, fontWeight: 700, color, background: bg, borderRadius: 6, padding: "3px 8px", whiteSpace: "nowrap" }}>
      {label}
    </span>
  )
}

function csvEscape(value: string): string {
  return /[",\n]/.test(value) ? `"${value.replace(/"/g, '""')}"` : value
}

function EventCard({ event }: { event: HistoryEvent }) {
  const { t } = useTranslation()
  const meta = CATEGORY_META[event.category]
  const statusLabel = event.status ? event.status.replace(/_/g, " ") : null
  const statusStyle = event.status ? (STATUS_STYLE[event.status] ?? DEFAULT_STATUS_STYLE) : null

  return (
    <div style={{ background: "#fff", border: "1px solid var(--border)", borderRadius: 12, padding: "14px 16px", display: "flex", gap: 12, alignItems: "flex-start" }}>
      <div style={{ width: 34, height: 34, borderRadius: 9, background: `${meta.color}1A`, display: "flex", alignItems: "center", justifyContent: "center", fontSize: 16, flexShrink: 0 }}>
        {meta.icon}
      </div>
      <div style={{ flex: 1, minWidth: 0 }}>
        <div style={{ fontWeight: 700, fontSize: 14, color: "var(--ink)" }}>{event.title}</div>
        <div style={{ fontSize: 12, color: "var(--ink-muted)", marginTop: 2 }}>{event.description}</div>
        <div style={{ display: "flex", flexWrap: "wrap", alignItems: "center", gap: 6, marginTop: 8 }}>
          <Tag label={t(`history.category.${event.category}` as any)} color={meta.color} bg={`${meta.color}1A`} />
          {statusLabel && statusStyle && <Tag label={statusLabel} color={statusStyle.color} bg={statusStyle.bg} />}
          {event.actorName && <span style={{ fontSize: 11, color: "var(--ink-faint)" }}>by {event.actorName}</span>}
        </div>
      </div>
      <div style={{ textAlign: "right", flexShrink: 0 }}>
        {event.amount !== null && <div style={{ fontWeight: 700, fontSize: 13, color: meta.color }}>{fmtRWFExact(event.amount)}</div>}
        <div style={{ fontSize: 11, color: "var(--ink-faint)", marginTop: event.amount !== null ? 4 : 0 }}>
          {new Date(event.eventAt).toLocaleTimeString(undefined, { hour: "2-digit", minute: "2-digit" })}
        </div>
      </div>
    </div>
  )
}

function TimelineView({ groups }: { groups: { dateKey: string; dateLabel: string; events: HistoryEvent[] }[] }) {
  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 22 }}>
      {groups.map(group => (
        <div key={group.dateKey}>
          <div style={{ display: "flex", alignItems: "center", gap: 10, marginBottom: 10 }}>
            <span style={{ fontSize: 11, fontWeight: 700, color: "var(--ink-muted)", letterSpacing: "0.04em", whiteSpace: "nowrap" }}>{group.dateLabel}</span>
            <div style={{ flex: 1, height: 1, background: "var(--border)" }} />
            <span style={{ fontSize: 11, color: "var(--ink-faint)", whiteSpace: "nowrap" }}>{group.events.length} events</span>
          </div>
          <div style={{ position: "relative", paddingLeft: 22 }}>
            <div style={{ position: "absolute", left: 4, top: 8, bottom: 8, width: 2, background: "var(--border)" }} />
            <div style={{ display: "flex", flexDirection: "column", gap: 10 }}>
              {group.events.map((event, i) => (
                <div key={i} style={{ position: "relative" }}>
                  <div style={{
                    position: "absolute", left: -22 + 4 - 3, top: 21, width: 8, height: 8, borderRadius: "50%",
                    background: CATEGORY_META[event.category].color, border: "2px solid #fff",
                    boxShadow: `0 0 0 1px ${CATEGORY_META[event.category].color}`,
                  }} />
                  <EventCard event={event} />
                </div>
              ))}
            </div>
          </div>
        </div>
      ))}
    </div>
  )
}

function TableView({ events }: { events: HistoryEvent[] }) {
  const { t } = useTranslation()
  return (
    <div style={{ background: "#fff", border: "1px solid var(--border)", borderRadius: 12, overflow: "hidden" }}>
      <div style={{ overflowX: "auto" }}>
        <table style={{ width: "100%", borderCollapse: "collapse", fontSize: 12 }}>
          <thead>
            <tr style={{ borderBottom: "1px solid var(--border)" }}>
              {[t("history.colDate"), t("history.colCategory"), t("history.colEvent"), t("history.colStatus"), t("history.colAmount"), t("history.colBy")].map(h => (
                <th key={h} style={{ textAlign: "left", padding: "8px 12px", fontWeight: 500, fontSize: 10, color: "var(--ink-muted)", letterSpacing: "0.04em", textTransform: "uppercase" }}>{h}</th>
              ))}
            </tr>
          </thead>
          <tbody>
            {events.map((e, i) => {
              const meta = CATEGORY_META[e.category]
              const statusStyle = e.status ? (STATUS_STYLE[e.status] ?? DEFAULT_STATUS_STYLE) : null
              return (
                <tr key={i} style={{ borderBottom: "1px solid var(--bg-alt)" }}>
                  <td style={{ padding: "9px 12px", color: "var(--ink-muted)", whiteSpace: "nowrap" }}>{new Date(e.eventAt).toLocaleString()}</td>
                  <td style={{ padding: "9px 12px" }}><Tag label={t(`history.category.${e.category}` as any)} color={meta.color} bg={`${meta.color}1A`} /></td>
                  <td style={{ padding: "9px 12px", maxWidth: 420 }}>
                    <div style={{ fontWeight: 600, color: "var(--ink)" }}>{e.title}</div>
                    <div style={{ fontSize: 11, color: "var(--ink-muted)" }}>{e.description}</div>
                  </td>
                  <td style={{ padding: "9px 12px" }}>
                    {e.status && statusStyle ? <Tag label={e.status.replace(/_/g, " ")} color={statusStyle.color} bg={statusStyle.bg} /> : <span style={{ color: "var(--ink-faint)" }}>—</span>}
                  </td>
                  <td style={{ padding: "9px 12px", fontWeight: 700, color: "var(--ink)", whiteSpace: "nowrap" }}>{e.amount === null ? "—" : fmtRWFExact(e.amount)}</td>
                  <td style={{ padding: "9px 12px", color: "var(--ink-muted)" }}>{e.actorName ?? "—"}</td>
                </tr>
              )
            })}
          </tbody>
        </table>
      </div>
    </div>
  )
}

// Owner-only, enforced by list_branch_history() itself (raises if the caller
// isn't the branch owner) — App.tsx's nav also hides this page from anyone
// else, but that's convenience, not the actual gate.
export default function HistoryPage({ period }: { period?: OverviewPeriod }) {
  const { t } = useTranslation()
  const [events, setEvents] = useState<HistoryEvent[]>([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState("")
  const [query, setQuery] = useState("")
  const [dateFrom, setDateFrom] = useState("")
  const [dateTo, setDateTo] = useState("")
  const [activeCategory, setActiveCategory] = useState<HistoryCategory | "all">("all")
  const [view, setView] = useState<"timeline" | "table">("timeline")

  // Same top-bar-drives-the-fields behavior as TransactionsPage -- "Custom
  // Range" leaves the user's own dateFrom/dateTo untouched.
  useEffect(() => {
    if (!period || period === "custom") return
    const range = resolveRange(period)
    setDateFrom(toDateInputValue(range.start))
    setDateTo(toDateInputValue(range.end))
  }, [period])

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

  const categoryCounts = useMemo(() => {
    const counts = new Map<HistoryCategory, number>()
    for (const e of events) counts.set(e.category, (counts.get(e.category) ?? 0) + 1)
    return counts
  }, [events])

  const filtered = useMemo(() => {
    const needle = query.trim().toLowerCase()
    return events.filter(e =>
      (activeCategory === "all" || e.category === activeCategory) &&
      (!needle || `${e.title} ${e.description} ${e.actorName ?? ""}`.toLowerCase().includes(needle)),
    )
  }, [events, activeCategory, query])

  const groups = useMemo(() => {
    const map = new Map<string, { dateKey: string; dateLabel: string; events: HistoryEvent[] }>()
    for (const e of filtered) {
      const d = new Date(e.eventAt)
      const dateKey = d.toDateString()
      if (!map.has(dateKey)) {
        map.set(dateKey, {
          dateKey,
          dateLabel: d.toLocaleDateString(undefined, { weekday: "short", day: "numeric", month: "short", year: "numeric" }).toUpperCase(),
          events: [],
        })
      }
      map.get(dateKey)!.events.push(e)
    }
    return Array.from(map.values())
  }, [filtered])

  function downloadCsv() {
    const header = ["Date & Time", "Category", "Event", "Description", "Status", "Amount", "By"]
    const rows = filtered.map(e => [
      new Date(e.eventAt).toLocaleString(), t(`history.category.${e.category}` as any), e.title, e.description,
      e.status ?? "", e.amount === null ? "" : String(e.amount), e.actorName ?? "",
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

      <div className="no-print" style={{ display: "flex", flexWrap: "wrap", gap: 8, marginBottom: 14 }}>
        <button
          onClick={() => setActiveCategory("all")}
          style={{
            display: "flex", alignItems: "center", gap: 8, fontSize: 13, fontWeight: 700, padding: "8px 16px", borderRadius: 20, cursor: "pointer", fontFamily: "inherit",
            border: `1.5px solid ${activeCategory === "all" ? "var(--primary)" : "var(--border)"}`,
            background: activeCategory === "all" ? "var(--primary-light)" : "#fff",
            color: activeCategory === "all" ? "var(--primary)" : "var(--ink-mid)",
          }}
        >
          {t("history.allEvents")}
          <span style={{ fontSize: 11, fontWeight: 700, background: activeCategory === "all" ? "var(--primary)" : "var(--bg-alt)", color: activeCategory === "all" ? "#fff" : "var(--ink-muted)", borderRadius: 10, padding: "1px 7px" }}>
            {events.length}
          </span>
        </button>
        {HISTORY_CATEGORIES.map(cat => {
          const meta = CATEGORY_META[cat]
          const active = activeCategory === cat
          const count = categoryCounts.get(cat) ?? 0
          if (count === 0) return null
          return (
            <button
              key={cat}
              onClick={() => setActiveCategory(cat)}
              style={{
                display: "flex", alignItems: "center", gap: 6, fontSize: 12, fontWeight: 600, padding: "7px 14px", borderRadius: 20, cursor: "pointer", fontFamily: "inherit",
                border: `1.5px solid ${active ? meta.color : "var(--border)"}`, background: active ? `${meta.color}1A` : "#fff",
                color: active ? meta.color : "var(--ink-mid)", transition: "all 0.13s",
              }}
            >
              <span>{meta.icon}</span>
              {t(`history.category.${cat}` as any)}
              <span style={{ fontSize: 10, fontWeight: 700, background: active ? meta.color : "var(--bg-alt)", color: active ? "#fff" : "var(--ink-muted)", borderRadius: 10, padding: "1px 6px" }}>
                {count}
              </span>
            </button>
          )
        })}
      </div>

      <div className="no-print" style={{ display: "flex", flexWrap: "wrap", alignItems: "center", gap: 10, marginBottom: 14 }}>
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
        <div style={{ display: "inline-flex", border: "1px solid var(--border)", borderRadius: 8, padding: 2, gap: 2 }}>
          <button
            onClick={() => setView("timeline")}
            style={{
              display: "flex", alignItems: "center", gap: 5, padding: "6px 12px", borderRadius: 6, border: "none", cursor: "pointer", fontFamily: "inherit", fontSize: 12, fontWeight: 600,
              background: view === "timeline" ? "var(--primary-light)" : "transparent", color: view === "timeline" ? "var(--primary)" : "var(--ink-mid)",
            }}
          >
            ☰ {t("history.viewTimeline")}
          </button>
          <button
            onClick={() => setView("table")}
            style={{
              display: "flex", alignItems: "center", gap: 5, padding: "6px 12px", borderRadius: 6, border: "none", cursor: "pointer", fontFamily: "inherit", fontSize: 12, fontWeight: 600,
              background: view === "table" ? "var(--primary-light)" : "transparent", color: view === "table" ? "var(--primary)" : "var(--ink-mid)",
            }}
          >
            ⊞ {t("history.viewTable")}
          </button>
        </div>
        <span style={{ fontSize: 12, color: "var(--ink-faint)", whiteSpace: "nowrap" }}>{t("history.eventsCount", { count: filtered.length })}</span>
        <div style={{ flex: 1 }} />
        <Btn variant="ghost" onClick={downloadCsv}>↓ {t("history.export")}</Btn>
      </div>

      {loading ? (
        <div style={{ background: "#fff", border: "1px solid var(--border)", borderRadius: 12, padding: 40, textAlign: "center", color: "var(--ink-muted)", fontSize: 13 }}>{t("history.loading")}</div>
      ) : filtered.length === 0 ? (
        <div style={{ background: "#fff", border: "1px solid var(--border)", borderRadius: 12, padding: 40, textAlign: "center", color: "var(--ink-muted)", fontSize: 13 }}>{events.length === 0 ? t("history.empty") : t("history.emptyFiltered")}</div>
      ) : view === "timeline" ? (
        <TimelineView groups={groups} />
      ) : (
        <TableView events={filtered} />
      )}
    </div>
  )
}
