import { useEffect, useMemo, useState } from "react"
import { Bar, BarChart, CartesianGrid, ResponsiveContainer, Tooltip, XAxis, YAxis } from "recharts"
import { CenterAlert, ChartTooltip, ExportModal, SectionHeader } from "../components"
import { fmtRWFExact } from "../data"
import {
  listComplianceTransactions, loadVatByMonth, paymentMethodLabel,
  type ComplianceTransaction, type MonthlyVatPoint,
} from "../lib/compliance"
import { useTranslation } from "../lib/i18n"
import type { ReportSection } from "../lib/export"

function KpiTile({ icon, value, valueColor, label, sub }: { icon: string; value: string; valueColor: string; label: string; sub: string }) {
  return (
    <div style={{ flex: "1 1 220px", background: "var(--surface)", border: "1px solid var(--border)", borderRadius: 12, padding: "16px 18px", display: "flex", flexDirection: "column", gap: 6 }}>
      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "flex-start" }}>
        <span style={{ fontSize: 22, fontWeight: 800, color: valueColor, fontFamily: "var(--font-display)", letterSpacing: "-0.02em" }}>{value}</span>
        <span style={{ fontSize: 18 }}>{icon}</span>
      </div>
      <div style={{ fontSize: 13, fontWeight: 600, color: "var(--ink)" }}>{label}</div>
      <div style={{ fontSize: 11, color: "var(--ink-muted)" }}>{sub}</div>
    </div>
  )
}

function buildSummarySection(rows: ComplianceTransaction[], title: string): ReportSection {
  const subtotal = rows.reduce((s, r) => s + r.subtotal, 0)
  const tax = rows.reduce((s, r) => s + r.taxTotal, 0)
  const total = rows.reduce((s, r) => s + r.totalAmount, 0)
  return {
    title,
    headers: ["Metric", "Value"],
    rows: [
      ["Transactions", rows.length],
      ["Subtotal (RWF)", Math.round(subtotal)],
      ["VAT (RWF)", Math.round(tax)],
      ["Total (RWF)", Math.round(total)],
    ],
  }
}

function buildTransactionsSection(rows: ComplianceTransaction[], title: string): ReportSection {
  return {
    title,
    headers: ["Receipt #", "Date", "Patient", "Items", "Subtotal (RWF)", "VAT (RWF)", "Total (RWF)", "Payment"],
    rows: rows.map(r => [
      r.receiptNumber, new Date(r.soldAt).toLocaleString(), r.patientName ?? "Walk-in", r.itemCount,
      Math.round(r.subtotal), Math.round(r.taxTotal), Math.round(r.totalAmount), paymentMethodLabel(r.paymentMethod, r.hasInsurance),
    ]),
  }
}

type DownloadKind = "daily" | "weekly" | "monthly" | "annual" | "table"

export default function CompliancePage() {
  const { t } = useTranslation()
  const [monthlyVat, setMonthlyVat] = useState<MonthlyVatPoint[]>([])
  const [transactions, setTransactions] = useState<ComplianceTransaction[]>([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState("")
  const [download, setDownload] = useState<DownloadKind | null>(null)

  useEffect(() => {
    const now = new Date()
    const startOfYear = new Date(now.getFullYear(), 0, 1).toISOString().slice(0, 10)
    const today = now.toISOString().slice(0, 10)
    void Promise.all([loadVatByMonth(8), listComplianceTransactions(startOfYear, today, 2000)])
      .then(([vat, txns]) => { setMonthlyVat(vat); setTransactions(txns) })
      .catch(reason => setError(reason instanceof Error ? reason.message : t("compliancePage.loadError")))
      .finally(() => setLoading(false))
  }, [t])

  const now = new Date()
  const startOfToday = new Date(now.getFullYear(), now.getMonth(), now.getDate())
  const startOfWeek = new Date(startOfToday.getTime() - 6 * 86_400_000)
  const startOfMonth = new Date(now.getFullYear(), now.getMonth(), 1)
  const nextFilingDate = new Date(now.getFullYear(), now.getMonth() + 1, 15)

  const dailyRows = useMemo(() => transactions.filter(r => new Date(r.soldAt) >= startOfToday), [transactions, startOfToday])
  const weeklyRows = useMemo(() => transactions.filter(r => new Date(r.soldAt) >= startOfWeek), [transactions, startOfWeek])
  const monthlyRows = useMemo(() => transactions.filter(r => new Date(r.soldAt) >= startOfMonth), [transactions, startOfMonth])

  const currentMonthVat = monthlyVat.length > 0 ? monthlyVat[monthlyVat.length - 1] : null
  const ytdVatTotal = monthlyVat.filter(m => new Date(m.monthStart).getFullYear() === now.getFullYear()).reduce((s, m) => s + m.vatTotal, 0)

  const recentTransactions = transactions.slice(0, 50)

  const downloadSections: Record<DownloadKind, { title: string; filename: string; rows: ComplianceTransaction[] }> = {
    daily: { title: t("compliancePage.dailyReceiptSummary"), filename: "daily-receipt-summary", rows: dailyRows },
    weekly: { title: t("compliancePage.weeklySalesReport"), filename: "weekly-sales-report", rows: weeklyRows },
    monthly: { title: t("compliancePage.monthlyVatStatement"), filename: "monthly-vat-statement", rows: monthlyRows },
    annual: { title: t("compliancePage.annualTaxSummary"), filename: "annual-tax-summary", rows: transactions },
    table: { title: t("compliancePage.transactionRecords"), filename: "transaction-tax-records", rows: recentTransactions },
  }

  if (loading) return <div style={{ padding: 40, textAlign: "center", color: "var(--ink-muted)" }}>{t("compliancePage.loading")}</div>

  return (
    <div className="animate-fade-in" style={{ display: "flex", flexDirection: "column", gap: 16 }}>
      {error && <CenterAlert key={error} message={error} />}
      <SectionHeader title={t("compliancePage.title")} subtitle={t("compliancePage.subtitle")} />

      <div style={{ display: "flex", gap: 14, flexWrap: "wrap" }}>
        <KpiTile
          icon="🏛️" valueColor="#16a34a"
          value={fmtRWFExact(currentMonthVat?.vatTotal ?? 0)}
          label={t("compliancePage.tileTaxDeducted", { month: currentMonthVat?.monthLabel ?? "" })}
          sub={t("compliancePage.tileTaxDeductedSub")}
        />
        <KpiTile
          icon="📊" valueColor="#16a34a"
          value={fmtRWFExact(ytdVatTotal)}
          label={t("compliancePage.tileYtdTax", { months: now.getMonth() + 1 })}
          sub={t("compliancePage.tileYtdTaxSub")}
        />
        <KpiTile
          icon="🧾" valueColor="var(--primary)"
          value={String(monthlyRows.length)}
          label={t("compliancePage.tileReceiptsIssued")}
          sub={t("compliancePage.tileReceiptsIssuedSub")}
        />
        <KpiTile
          icon="📅" valueColor="#d97706"
          value={nextFilingDate.toLocaleDateString(undefined, { month: "short", day: "numeric", year: "numeric" })}
          label={t("compliancePage.tileNextFiling")}
          sub={t("compliancePage.tileNextFilingSub")}
        />
      </div>

      <div style={{ display: "flex", gap: 16, alignItems: "flex-start", flexWrap: "wrap" }}>
        <div style={{ flex: "2 1 480px", minWidth: 380, background: "var(--surface)", border: "1px solid var(--border)", borderRadius: 12, padding: 16 }}>
          <div style={{ display: "flex", justifyContent: "space-between", alignItems: "flex-start", marginBottom: 4 }}>
            <div>
              <div style={{ fontSize: 14, fontWeight: 700, color: "var(--ink)" }}>{t("compliancePage.chartTitle")}</div>
              <div style={{ fontSize: 11, color: "var(--ink-muted)" }}>{t("compliancePage.chartSubtitle")}</div>
            </div>
            <button
              onClick={() => setDownload("monthly")}
              style={{ background: "none", border: "none", color: "var(--primary)", fontWeight: 600, fontSize: 12, cursor: "pointer", fontFamily: "inherit" }}
            >
              ↓ {t("compliancePage.export")}
            </button>
          </div>
          <ResponsiveContainer width="100%" height={280}>
            <BarChart data={monthlyVat.map(m => ({ name: m.monthLabel, vat: m.vatTotal }))} margin={{ top: 10, right: 8, bottom: 0, left: 0 }}>
              <CartesianGrid stroke="var(--border)" strokeDasharray="4 4" vertical={false} />
              <XAxis dataKey="name" tick={{ fontSize: 11, fill: "var(--ink-muted)" }} axisLine={false} tickLine={false} />
              <YAxis tick={{ fontSize: 11, fill: "var(--ink-muted)" }} axisLine={false} tickLine={false} tickFormatter={v => `${Math.round(v / 1000)}K`} />
              <Tooltip content={<ChartTooltip />} />
              <Bar dataKey="vat" name={t("compliancePage.chartBarLabel")} fill="#16a34a" radius={[5, 5, 0, 0]} />
            </BarChart>
          </ResponsiveContainer>
        </div>

        <div style={{ flex: "1 1 300px", minWidth: 280, display: "flex", flexDirection: "column", gap: 16 }}>
          <div style={{ background: "var(--surface)", border: "1px solid var(--border)", borderRadius: 12, padding: 16 }}>
            <div style={{ fontSize: 14, fontWeight: 700, color: "var(--ink)", marginBottom: 6 }}>{t("compliancePage.filingHelpTitle")}</div>
            <p style={{ fontSize: 12, color: "var(--ink-muted)", lineHeight: 1.6, margin: "0 0 14px" }}>
              {t("compliancePage.filingHelpBody")}
            </p>
            <button
              onClick={() => setDownload("monthly")}
              style={{ width: "100%", padding: "11px 16px", borderRadius: 8, border: "none", background: "var(--primary)", color: "#fff", fontSize: 13, fontWeight: 700, cursor: "pointer", fontFamily: "inherit" }}
            >
              {t("compliancePage.exportMonthVat")}
            </button>
          </div>

          <div style={{ background: "var(--surface)", border: "1px solid var(--border)", borderRadius: 12, padding: 16 }}>
            <div style={{ fontSize: 14, fontWeight: 700, color: "var(--ink)", marginBottom: 10 }}>{t("compliancePage.reportDownloadsTitle")}</div>
            {([
              { key: "daily" as const, label: t("compliancePage.dailyReceiptSummary"), sub: t("compliancePage.dailyReceiptSummarySub") },
              { key: "weekly" as const, label: t("compliancePage.weeklySalesReport"), sub: t("compliancePage.weeklySalesReportSub") },
              { key: "monthly" as const, label: t("compliancePage.monthlyVatStatement"), sub: t("compliancePage.monthlyVatStatementSub", { month: currentMonthVat?.monthLabel ?? "", year: now.getFullYear() }) },
              { key: "annual" as const, label: t("compliancePage.annualTaxSummary"), sub: t("compliancePage.annualTaxSummarySub", { year: now.getFullYear() }) },
            ]).map((report, i, arr) => (
              <div key={report.key} style={{ display: "flex", justifyContent: "space-between", alignItems: "center", padding: "10px 0", borderBottom: i === arr.length - 1 ? "none" : "1px solid var(--bg-alt)" }}>
                <div>
                  <div style={{ fontSize: 13, fontWeight: 600, color: "var(--ink)" }}>{report.label}</div>
                  <div style={{ fontSize: 11, color: "var(--ink-muted)" }}>{report.sub}</div>
                </div>
                <button
                  onClick={() => setDownload(report.key)}
                  style={{ padding: "5px 12px", borderRadius: 999, border: "1px solid var(--positive)", background: "transparent", color: "var(--positive)", fontSize: 11, fontWeight: 700, cursor: "pointer", fontFamily: "inherit", whiteSpace: "nowrap" }}
                >
                  ↓ PDF
                </button>
              </div>
            ))}
          </div>
        </div>
      </div>

      <div style={{ background: "var(--surface)", border: "1px solid var(--border)", borderRadius: 12, overflow: "hidden" }}>
        <div style={{ padding: "14px 16px", borderBottom: "1px solid var(--border)", display: "flex", justifyContent: "space-between", alignItems: "flex-start", gap: 10 }}>
          <div>
            <div style={{ fontSize: 14, fontWeight: 700, color: "var(--ink)" }}>{t("compliancePage.transactionRecords")}</div>
            <div style={{ fontSize: 11, color: "var(--ink-muted)", marginTop: 2 }}>{t("compliancePage.transactionRecordsSub")}</div>
          </div>
          <button
            onClick={() => setDownload("table")}
            style={{ background: "none", border: "none", color: "var(--primary)", fontWeight: 600, fontSize: 12, cursor: "pointer", fontFamily: "inherit", whiteSpace: "nowrap" }}
          >
            ↓ {t("compliancePage.exportCsv")}
          </button>
        </div>
        {recentTransactions.length === 0 ? (
          <div style={{ padding: 30, textAlign: "center", color: "var(--ink-muted)", fontSize: 12 }}>{t("compliancePage.noTransactions")}</div>
        ) : (
          <div style={{ overflowX: "auto" }}>
            <table style={{ width: "100%", borderCollapse: "collapse", fontSize: 12 }}>
              <thead>
                <tr style={{ borderBottom: "1px solid var(--border)" }}>
                  {[
                    t("compliancePage.colReceipt"), t("compliancePage.colDate"), t("compliancePage.colPatient"), t("compliancePage.colItems"),
                    t("compliancePage.colSubtotal"), t("compliancePage.colVat"), t("compliancePage.colTotal"), t("compliancePage.colPayment"),
                  ].map(h => <th key={h} style={{ textAlign: "left", padding: "8px 12px", color: "var(--ink-muted)", fontWeight: 500, fontSize: 11, whiteSpace: "nowrap" }}>{h}</th>)}
                </tr>
              </thead>
              <tbody>
                {recentTransactions.map(r => (
                  <tr key={r.saleId} style={{ borderBottom: "1px solid var(--bg-alt)" }}>
                    <td style={{ padding: "9px 12px", fontFamily: "var(--font-mono)", fontWeight: 600, color: "var(--primary)", whiteSpace: "nowrap" }}>{r.receiptNumber}</td>
                    <td style={{ padding: "9px 12px", color: "var(--ink-mid)", whiteSpace: "nowrap" }}>{new Date(r.soldAt).toLocaleString()}</td>
                    <td style={{ padding: "9px 12px" }}>{r.patientName ?? <span style={{ color: "var(--ink-faint)" }}>{t("compliancePage.walkIn")}</span>}</td>
                    <td style={{ padding: "9px 12px" }}>{r.itemCount}</td>
                    <td style={{ padding: "9px 12px", color: "var(--ink-mid)" }}>{fmtRWFExact(r.subtotal)}</td>
                    <td style={{ padding: "9px 12px", color: "var(--ink-mid)" }}>{fmtRWFExact(r.taxTotal)}</td>
                    <td style={{ padding: "9px 12px", fontWeight: 700 }}>{fmtRWFExact(r.totalAmount)}</td>
                    <td style={{ padding: "9px 12px" }}>{paymentMethodLabel(r.paymentMethod, r.hasInsurance)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </div>

      {download && (
        <ExportModal
          title={downloadSections[download].title}
          sections={[
            buildSummarySection(downloadSections[download].rows, t("compliancePage.summarySectionTitle")),
            buildTransactionsSection(downloadSections[download].rows, downloadSections[download].title),
          ]}
          filenameBase={`${downloadSections[download].filename}-${new Date().toISOString().slice(0, 10)}`}
          onClose={() => setDownload(null)}
          formatLabel={t("compliancePage.exportFormatLabel")}
          cancelLabel={t("compliancePage.exportCancel")}
          downloadLabel={format => t("compliancePage.exportDownload", { format })}
        />
      )}
    </div>
  )
}
