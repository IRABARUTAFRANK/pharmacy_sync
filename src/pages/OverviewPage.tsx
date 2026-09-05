import { useCallback, useEffect, useState } from 'react'
import {
  AreaChart, Area, BarChart, Bar, PieChart, Pie, Cell,
  XAxis, YAxis, CartesianGrid, Tooltip, Legend, ResponsiveContainer,
} from 'recharts'
import { fmtRWFExact, pct, type Role } from '../data'
import { Card, SectionHeader, ChartTooltip, Sparkline, AlertRow, Btn, Modal } from '../components'
import { useTranslation } from '../lib/i18n'
import { useGlobalSearch } from '../lib/search'
import { loadOverview, type OverviewData, type OverviewPeriod, type TopProduct, type TrendPoint } from '../lib/overview'
import type { LiveAlert } from '../lib/alerts'
import type { TranslationKey } from '../lib/i18n/en'

// A real client-side download (Blob + a throwaway <a download>), not a
// decorative button -- unlike App.tsx's ExportModal, whose "Download CSV"
// button is wired to nothing but onClose. The trend rows are already in
// memory (data.revenueTrend), so no extra fetch is needed to produce it.
function downloadTrendCsv(rows: TrendPoint[], periodLabel: string, metric: DrillDownMetric) {
  const header = 'Period,Revenue (RWF),VAT (RWF),Transactions,Items Dispensed'
  const lines = rows.map(r => `${r.label},${Math.round(r.revenue)},${Math.round(r.vat)},${r.transactions},${r.items}`)
  const blob = new Blob([[header, ...lines].join('\n')], { type: 'text/csv;charset=utf-8;' })
  const url = URL.createObjectURL(blob)
  const a = document.createElement('a')
  a.href = url
  a.download = `${metric}-trend-${periodLabel.toLowerCase().replace(/\s+/g, '-')}.csv`
  document.body.appendChild(a)
  a.click()
  document.body.removeChild(a)
  URL.revokeObjectURL(url)
}

type DrillDownMetric = 'revenue' | 'transactions' | 'items'

const DRILL_DOWN_CONFIG: Record<DrillDownMetric, {
  color: string
  gradientId: string
  titleKey: TranslationKey
  labelKey: TranslationKey
  isCurrency: boolean
}> = {
  revenue: { color: '#1e5fa8', gradientId: 'gRevDrill', titleKey: 'overviewPage.drillDownTitleRevenue', labelKey: 'overviewPage.drillDownRevenueLabel', isCurrency: true },
  transactions: { color: '#0284c7', gradientId: 'gTxnDrill', titleKey: 'overviewPage.drillDownTitleTransactions', labelKey: 'overviewPage.drillDownTransactionsLabel', isCurrency: false },
  items: { color: '#7c3aed', gradientId: 'gItemsDrill', titleKey: 'overviewPage.drillDownTitleItems', labelKey: 'overviewPage.drillDownItemsLabel', isCurrency: false },
}

// ─── Dashboard widget visibility ("Customize") ─────────────────────────────
// A per-viewer layout preference, not business data -- stored in
// localStorage (survives reloads on this browser, never leaves it) rather
// than the database, the same rationale App.tsx uses for the intro splash.

type WidgetKey =
  | 'kpiCards' | 'revenueTrend' | 'categorySales'
  | 'dailyTransactions' | 'paymentMethods' | 'alertsFeed' | 'topProducts'

const DEFAULT_WIDGETS: Record<WidgetKey, boolean> = {
  kpiCards: true, revenueTrend: true, categorySales: true,
  dailyTransactions: true, paymentMethods: true, alertsFeed: true, topProducts: true,
}

const WIDGETS_STORAGE_KEY = 'pharmsync.overview.widgets'

function loadWidgetPrefs(): Record<WidgetKey, boolean> {
  try {
    const raw = localStorage.getItem(WIDGETS_STORAGE_KEY)
    if (!raw) return DEFAULT_WIDGETS
    return { ...DEFAULT_WIDGETS, ...JSON.parse(raw) }
  } catch {
    return DEFAULT_WIDGETS
  }
}

function WidgetSwitch({ checked, onChange }: { checked: boolean; onChange: () => void }) {
  return (
    <button
      type="button" role="switch" aria-checked={checked} onClick={onChange}
      style={{
        width: 38, height: 21, borderRadius: 11, border: 'none', cursor: 'pointer', padding: 0, flexShrink: 0,
        background: checked ? 'var(--positive)' : 'var(--border-strong)', position: 'relative', transition: 'background 0.15s',
      }}
    >
      <span style={{
        position: 'absolute', top: 2, left: checked ? 19 : 2, width: 17, height: 17, borderRadius: '50%',
        background: '#fff', transition: 'left 0.15s', boxShadow: '0 1px 3px rgba(0,0,0,0.25)',
      }} />
    </button>
  )
}

const WIDGET_ROWS: { key: WidgetKey; labelKey: TranslationKey }[] = [
  { key: 'kpiCards', labelKey: 'overviewPage.widgetKpiCards' },
  { key: 'revenueTrend', labelKey: 'overviewPage.widgetRevenueTrend' },
  { key: 'categorySales', labelKey: 'overviewPage.widgetCategorySales' },
  { key: 'dailyTransactions', labelKey: 'overviewPage.widgetDailyTransactions' },
  { key: 'paymentMethods', labelKey: 'overviewPage.widgetPaymentMethods' },
  { key: 'alertsFeed', labelKey: 'overviewPage.widgetAlertsFeed' },
  { key: 'topProducts', labelKey: 'overviewPage.widgetTopProducts' },
]

function DashboardBuilderModal({ visible, onToggle, onClose }: { visible: Record<WidgetKey, boolean>; onToggle: (key: WidgetKey) => void; onClose: () => void }) {
  const { t } = useTranslation()
  return (
    <Modal title={t('overviewPage.builderTitle')} onClose={onClose} width={400}>
      <div style={{ fontSize: 12, color: 'var(--ink-muted)', marginBottom: 12 }}>{t('overviewPage.builderSubtitle')}</div>
      <div style={{ display: 'flex', flexDirection: 'column' }}>
        {WIDGET_ROWS.map((row, i) => (
          <div key={row.key} style={{
            display: 'flex', justifyContent: 'space-between', alignItems: 'center',
            padding: '11px 0', borderTop: i === 0 ? 'none' : '1px solid var(--bg-alt)',
          }}>
            <span style={{ fontSize: 13, color: 'var(--ink)' }}>{t(row.labelKey)}</span>
            <WidgetSwitch checked={visible[row.key]} onChange={() => onToggle(row.key)} />
          </div>
        ))}
      </div>
    </Modal>
  )
}

// ─── Dashboard export ───────────────────────────────────────────────────────
// Every section below reads straight from the same OverviewData the page
// itself renders -- there is no separate mock payload, and nothing here is a
// stand-in for a feature that isn't built (see App.tsx's old ExportModal,
// removed in favor of this: hardcoded share link, dead Copy button, a
// Download button that only closed the modal without producing a file).

interface ReportSection {
  title: string
  headers: string[]
  rows: (string | number)[][]
}

function buildDashboardReport(data: OverviewData, branchName: string, isPharmacist: boolean): ReportSection[] {
  const pctText = (n: number | null) => (n == null ? '—' : `${n > 0 ? '+' : ''}${n.toFixed(1)}%`)

  const summaryRows: (string | number)[][] = []
  if (!isPharmacist) summaryRows.push(['Total Revenue', fmtRWFExact(data.revenue.value), pctText(data.revenue.changePct)])
  summaryRows.push(['Transactions', data.transactions.value.toLocaleString(), pctText(data.transactions.changePct)])
  summaryRows.push(['Items Dispensed', data.itemsDispensed.value.toLocaleString(), pctText(data.itemsDispensed.changePct)])
  if (!isPharmacist) summaryRows.push(['Inventory Value', fmtRWFExact(data.inventoryValue), '—'])
  summaryRows.push(['Expiring ≤ 90 Days', `${data.expiring.count} (${fmtRWFExact(data.expiring.value)})`, '—'])

  return [
    { title: `Summary — ${branchName} — ${data.periodLabel}`, headers: ['Metric', 'Value', 'Change vs previous period'], rows: summaryRows },
    {
      title: 'Revenue Trend',
      headers: ['Period', 'Revenue (RWF)', 'VAT (RWF)', 'Transactions', 'Items Dispensed'],
      rows: data.revenueTrend.map(p => [p.label, Math.round(p.revenue), Math.round(p.vat), p.transactions, p.items]),
    },
    {
      title: 'Sales by Category',
      headers: ['Category', 'Revenue (RWF)'],
      rows: data.categoryMix.map(c => [c.name, Math.round(c.sales)]),
    },
    {
      title: 'Daily Transactions (this week)',
      headers: ['Day', 'Transactions', 'Amount (RWF)'],
      rows: data.dailyTransactions.map(d => [d.day, d.txn, Math.round(d.amount)]),
    },
    {
      title: 'Payment Split',
      headers: ['Method', 'Share (%)', 'Amount (RWF)'],
      rows: data.paymentSplit.map(s => [s.name, s.value, Math.round(s.amount)]),
    },
    {
      title: 'Top Products by Revenue',
      headers: ['#', 'Product', 'Category', 'Units Sold', 'Revenue (RWF)', 'Stock', 'Trend'],
      rows: data.topProducts.map(p => [
        p.rank, p.name, p.category, p.units, Math.round(p.revenue), p.stock,
        p.trendPct == null ? 'new' : `${p.trendPct >= 0 ? '+' : ''}${p.trendPct.toFixed(1)}%`,
      ]),
    },
  ]
}

function csvCell(value: string | number): string {
  const s = String(value)
  return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s
}

function reportToCsv(sections: ReportSection[]): string {
  const lines: string[] = []
  for (const section of sections) {
    lines.push(section.title)
    lines.push(section.headers.join(','))
    for (const row of section.rows) lines.push(row.map(csvCell).join(','))
    lines.push('')
  }
  return lines.join('\n')
}

// Excel opens an .xls file containing an HTML table directly -- a
// long-standing, genuinely working technique for a real spreadsheet export
// with no library and no server round-trip.
function reportToExcelHtml(sections: ReportSection[], branchName: string, periodLabel: string): string {
  const esc = (v: string | number) => String(v).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
  const tables = sections.map(section => `
    <h3>${esc(section.title)}</h3>
    <table border="1" cellspacing="0" cellpadding="4">
      <tr>${section.headers.map(h => `<th>${esc(h)}</th>`).join('')}</tr>
      ${section.rows.map(row => `<tr>${row.map(c => `<td>${esc(c)}</td>`).join('')}</tr>`).join('')}
    </table>`).join('<br/>')
  return `<html><head><meta charset="utf-8"></head><body><h2>${esc(`PharmSync Dashboard — ${branchName} — ${periodLabel}`)}</h2>${tables}</body></html>`
}

function downloadBlob(content: string, mime: string, filename: string) {
  const blob = new Blob([content], { type: mime })
  const url = URL.createObjectURL(blob)
  const a = document.createElement('a')
  a.href = url
  a.download = filename
  document.body.appendChild(a)
  a.click()
  document.body.removeChild(a)
  URL.revokeObjectURL(url)
}

function filenameSafe(text: string): string {
  return text.toLowerCase().replace(/\s+/g, '-')
}

function ExportDashboardModal({ data, branchName, isPharmacist, onClose, onPrintPdf }: {
  data: OverviewData; branchName: string; isPharmacist: boolean; onClose: () => void; onPrintPdf: () => void
}) {
  const { t } = useTranslation()
  const [fmt, setFmt] = useState<'csv' | 'pdf' | 'excel'>('pdf')

  const handleDownload = () => {
    const base = `dashboard-export-${filenameSafe(branchName)}-${filenameSafe(data.periodLabel)}`
    if (fmt === 'csv') {
      downloadBlob(reportToCsv(buildDashboardReport(data, branchName, isPharmacist)), 'text/csv;charset=utf-8;', `${base}.csv`)
      onClose()
    } else if (fmt === 'excel') {
      downloadBlob(reportToExcelHtml(buildDashboardReport(data, branchName, isPharmacist), branchName, data.periodLabel), 'application/vnd.ms-excel;charset=utf-8;', `${base}.xls`)
      onClose()
    } else {
      onPrintPdf()
    }
  }

  return (
    <Modal title={t('overviewPage.exportModalTitle')} onClose={onClose} width={440}>
      <div style={{ display: 'flex', flexDirection: 'column', gap: 14 }}>
        <div>
          <div style={{ fontSize: 11, fontWeight: 600, color: 'var(--ink-muted)', textTransform: 'uppercase', letterSpacing: '0.05em', marginBottom: 8 }}>{t('overviewPage.exportFormatLabel')}</div>
          <div style={{ display: 'flex', gap: 8 }}>
            {(['csv', 'pdf', 'excel'] as const).map(f => (
              <button key={f} onClick={() => setFmt(f)} style={{
                flex: 1, padding: '10px', borderRadius: 8, fontFamily: 'inherit', cursor: 'pointer',
                border: `1.5px solid ${fmt === f ? 'var(--primary)' : 'var(--border)'}`,
                background: fmt === f ? 'var(--primary-light)' : '#fff',
                color: fmt === f ? 'var(--primary)' : 'var(--ink-mid)',
                fontWeight: fmt === f ? 700 : 400, fontSize: 13,
              }}>{f.toUpperCase()}</button>
            ))}
          </div>
        </div>
        <div style={{ display: 'flex', gap: 8, justifyContent: 'flex-end' }}>
          <Btn variant="secondary" onClick={onClose}>{t('overviewPage.exportCancel')}</Btn>
          <Btn variant="primary" onClick={handleDownload}>↓ {t('overviewPage.exportDownload', { format: fmt.toUpperCase() })}</Btn>
        </div>
      </div>
    </Modal>
  )
}

// One modal shape shared by every KPI tile that gets a drill-down: same three
// summary tiles, same trend chart styling as the page's own "Revenue Trend"
// chart, same export/full-report actions. Only the metric-specific bits
// (title, current value, color, which TrendPoint field to plot) vary.
function TrendDrillDownModal({ metric, data, onClose, onViewFullReport }: { metric: DrillDownMetric; data: OverviewData; onClose: () => void; onViewFullReport?: () => void }) {
  const { t } = useTranslation()
  const config = DRILL_DOWN_CONFIG[metric]
  const delta = metric === 'revenue' ? data.revenue : metric === 'transactions' ? data.transactions : data.itemsDispensed
  const change = delta.changePct
  const positive = (change ?? 0) >= 0
  const currentDisplay = config.isCurrency ? fmtRWFExact(delta.value) : delta.value.toLocaleString()
  const { color, gradientId } = config
  const title = t(config.titleKey)
  const valueLabel = t(config.labelKey)

  return (
    <Modal title={title} onClose={onClose} width={640}>
      <div style={{ display: 'flex', flexDirection: 'column', gap: 16 }}>
        <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr 1fr', gap: 10 }}>
          <div style={{ background: 'var(--bg)', borderRadius: 8, padding: '12px 14px' }}>
            <div style={{ fontSize: 10, fontWeight: 600, color: 'var(--ink-muted)', textTransform: 'uppercase', letterSpacing: '0.05em', marginBottom: 4 }}>{t('overviewPage.drillDownCurrent')}</div>
            <div style={{ fontSize: 17, fontWeight: 800, color: 'var(--ink)' }}>{currentDisplay}</div>
          </div>
          <div style={{ background: 'var(--bg)', borderRadius: 8, padding: '12px 14px' }}>
            <div style={{ fontSize: 10, fontWeight: 600, color: 'var(--ink-muted)', textTransform: 'uppercase', letterSpacing: '0.05em', marginBottom: 4 }}>{t('overviewPage.drillDownChange')}</div>
            <div style={{ fontSize: 17, fontWeight: 800, color: change == null ? 'var(--ink-muted)' : positive ? 'var(--positive)' : 'var(--negative)' }}>
              {change == null ? '—' : pct(change)}
            </div>
          </div>
          <div style={{ background: 'var(--bg)', borderRadius: 8, padding: '12px 14px' }}>
            <div style={{ fontSize: 10, fontWeight: 600, color: 'var(--ink-muted)', textTransform: 'uppercase', letterSpacing: '0.05em', marginBottom: 4 }}>{t('overviewPage.drillDownPeriod')}</div>
            <div style={{ fontSize: 13, fontWeight: 700, color: 'var(--ink)' }}>{data.periodLabel}</div>
          </div>
        </div>

        <div>
          <div style={{ fontSize: 13, fontWeight: 700, color: 'var(--ink)', marginBottom: 8 }}>{t('overviewPage.drillDownTrendTitle')}</div>
          <ResponsiveContainer width="100%" height={220}>
            <AreaChart data={data.revenueTrend} margin={{ top: 4, right: 8, bottom: 0, left: 0 }}>
              <defs>
                <linearGradient id={gradientId} x1="0" y1="0" x2="0" y2="1">
                  <stop offset="5%" stopColor={color} stopOpacity={0.2} />
                  <stop offset="95%" stopColor={color} stopOpacity={0} />
                </linearGradient>
              </defs>
              <CartesianGrid stroke="#f0f0f0" strokeDasharray="4 4" />
              <XAxis dataKey="label" tick={{ fontSize: 11 }} axisLine={false} tickLine={false} minTickGap={16} />
              <YAxis tick={{ fontSize: 11 }} axisLine={false} tickLine={false} tickFormatter={v => Math.round(v).toLocaleString()} />
              <Tooltip content={<ChartTooltip />} />
              <Area type="monotone" dataKey={metric} name={valueLabel} stroke={color} fill={`url(#${gradientId})`} strokeWidth={2.5} dot={false} activeDot={{ r: 5 }} />
            </AreaChart>
          </ResponsiveContainer>
        </div>

        <div style={{ display: 'flex', justifyContent: 'flex-end', gap: 8 }}>
          <Btn variant="secondary" onClick={() => downloadTrendCsv(data.revenueTrend, data.periodLabel, metric)}>{t('overviewPage.drillDownExportCsv')}</Btn>
          {onViewFullReport && <Btn variant="primary" onClick={onViewFullReport}>{t('overviewPage.drillDownViewFullReport')}</Btn>}
        </div>
      </div>
    </Modal>
  )
}

// Inventory Value has no period-over-period change or history in this data
// model -- lib/overview.ts computes it live from current stock, there's no
// snapshot table to diff against "last month". Rather than invent a fake
// trend line, this drills into a real composition instead: how much of the
// current value is healthy vs already at expiry risk, both numbers the page
// already computes (data.inventoryValue, data.expiring).
function InventoryDrillDownModal({ data, onClose, onViewFullReport }: { data: OverviewData; onClose: () => void; onViewFullReport?: () => void }) {
  const { t } = useTranslation()
  const expiringValue = data.expiring.value
  const healthyValue = Math.max(data.inventoryValue - expiringValue, 0)
  const hasValue = data.inventoryValue > 0
  const breakdown = hasValue
    ? [
        { name: t('overviewPage.drillDownHealthyStock'), value: healthyValue, color: '#1e5fa8' },
        { name: t('overviewPage.drillDownExpiringStock'), value: expiringValue, color: '#dc2626' },
      ]
    : []

  const handleExport = () => {
    const section: ReportSection = {
      title: `Inventory Value — ${data.periodLabel}`,
      headers: ['Metric', 'Value'],
      rows: [
        ['Total Inventory Value (RWF)', Math.round(data.inventoryValue)],
        ['Expiring ≤ 90 Days (RWF)', Math.round(expiringValue)],
        ['Healthy Stock Value (RWF)', Math.round(healthyValue)],
        ['Below Reorder Point (products)', data.belowReorder],
      ],
    }
    downloadBlob(reportToCsv([section]), 'text/csv;charset=utf-8;', `inventory-value-${filenameSafe(data.periodLabel)}.csv`)
  }

  return (
    <Modal title={t('overviewPage.drillDownTitleInventory')} onClose={onClose} width={640}>
      <div style={{ display: 'flex', flexDirection: 'column', gap: 16 }}>
        <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr 1fr', gap: 10 }}>
          <div style={{ background: 'var(--bg)', borderRadius: 8, padding: '12px 14px' }}>
            <div style={{ fontSize: 10, fontWeight: 600, color: 'var(--ink-muted)', textTransform: 'uppercase', letterSpacing: '0.05em', marginBottom: 4 }}>{t('overviewPage.drillDownCurrent')}</div>
            <div style={{ fontSize: 17, fontWeight: 800, color: 'var(--ink)' }}>{fmtRWFExact(data.inventoryValue)}</div>
          </div>
          <div style={{ background: 'var(--bg)', borderRadius: 8, padding: '12px 14px' }}>
            <div style={{ fontSize: 10, fontWeight: 600, color: 'var(--ink-muted)', textTransform: 'uppercase', letterSpacing: '0.05em', marginBottom: 4 }}>{t('overviewPage.drillDownExpiringLabel')}</div>
            <div style={{ fontSize: 17, fontWeight: 800, color: expiringValue > 0 ? '#dc2626' : 'var(--ink-muted)' }}>{fmtRWFExact(expiringValue)}</div>
          </div>
          <div style={{ background: 'var(--bg)', borderRadius: 8, padding: '12px 14px' }}>
            <div style={{ fontSize: 10, fontWeight: 600, color: 'var(--ink-muted)', textTransform: 'uppercase', letterSpacing: '0.05em', marginBottom: 4 }}>{t('overviewPage.drillDownBelowReorderLabel')}</div>
            <div style={{ fontSize: 17, fontWeight: 800, color: data.belowReorder > 0 ? '#d97706' : 'var(--ink-muted)' }}>{data.belowReorder.toLocaleString()}</div>
          </div>
        </div>

        <div>
          <div style={{ fontSize: 13, fontWeight: 700, color: 'var(--ink)', marginBottom: 8 }}>{t('overviewPage.drillDownStockBreakdownTitle')}</div>
          {hasValue ? (
            <div style={{ display: 'flex', alignItems: 'center', gap: 20, flexWrap: 'wrap' }}>
              <div style={{ flex: '1 1 200px', minWidth: 160 }}>
                <ResponsiveContainer width="100%" height={180}>
                  <PieChart>
                    <Pie data={breakdown} cx="50%" cy="50%" innerRadius={48} outerRadius={72} paddingAngle={3} dataKey="value">
                      {breakdown.map((slice, i) => <Cell key={i} fill={slice.color} />)}
                    </Pie>
                    <Tooltip formatter={(v: any) => fmtRWFExact(Number(v))} />
                  </PieChart>
                </ResponsiveContainer>
              </div>
              <div style={{ display: 'flex', flexDirection: 'column', gap: 8, flexShrink: 0, minWidth: 160 }}>
                {breakdown.map(slice => (
                  <div key={slice.name} style={{ display: 'flex', alignItems: 'center', gap: 6, fontSize: 12 }}>
                    <div style={{ width: 9, height: 9, borderRadius: 2, background: slice.color, flexShrink: 0 }} />
                    <span style={{ color: 'var(--ink-muted)', flex: 1 }}>{slice.name}</span>
                    <span style={{ fontWeight: 700, color: 'var(--ink)' }}>{fmtRWFExact(slice.value)}</span>
                  </div>
                ))}
              </div>
            </div>
          ) : (
            <div style={{ fontSize: 12, color: 'var(--ink-muted)', padding: '20px 0', textAlign: 'center' }}>{t('overviewPage.drillDownNoStock')}</div>
          )}
        </div>

        <div style={{ display: 'flex', justifyContent: 'flex-end', gap: 8 }}>
          <Btn variant="secondary" onClick={handleExport}>{t('overviewPage.drillDownExportCsv')}</Btn>
          {onViewFullReport && <Btn variant="primary" onClick={onViewFullReport}>{t('overviewPage.drillDownViewFullReport')}</Btn>}
        </div>
      </div>
    </Modal>
  )
}

const EXPIRY_BUCKET_COLOR: Record<string, string> = {
  'Already Expired': '#dc2626',
  '≤ 30 Days': '#f97316',
  '31–60 Days': '#d97706',
  '61–90 Days': '#ca8a04',
}

// Same "no fake history" constraint as InventoryDrillDownModal -- expiry risk
// is a live snapshot of current batches, not a period flow, so there's no
// honest "vs last month" to show. The real, useful thing to drill into is
// urgency: how much of the at-risk value is already gone vs. still weeks out,
// straight from lib/overview.ts's expiringBreakdown.
function ExpiringDrillDownModal({ data, onClose, onViewFullReport }: { data: OverviewData; onClose: () => void; onViewFullReport?: () => void }) {
  const { t } = useTranslation()
  const hasRisk = data.expiring.count > 0

  const handleExport = () => {
    const section: ReportSection = {
      title: `Expiring Stock — ${data.periodLabel}`,
      headers: ['Window', 'Batches', 'Value (RWF)'],
      rows: data.expiringBreakdown.map(b => [b.bucket, b.count, Math.round(b.value)]),
    }
    downloadBlob(reportToCsv([section]), 'text/csv;charset=utf-8;', `expiring-stock-${filenameSafe(data.periodLabel)}.csv`)
  }

  return (
    <Modal title={t('overviewPage.drillDownTitleExpiring')} onClose={onClose} width={640}>
      <div style={{ display: 'flex', flexDirection: 'column', gap: 16 }}>
        <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr 1fr', gap: 10 }}>
          <div style={{ background: 'var(--bg)', borderRadius: 8, padding: '12px 14px' }}>
            <div style={{ fontSize: 10, fontWeight: 600, color: 'var(--ink-muted)', textTransform: 'uppercase', letterSpacing: '0.05em', marginBottom: 4 }}>{t('overviewPage.drillDownBatchesLabel')}</div>
            <div style={{ fontSize: 17, fontWeight: 800, color: hasRisk ? '#dc2626' : 'var(--ink)' }}>{data.expiring.count.toLocaleString()}</div>
          </div>
          <div style={{ background: 'var(--bg)', borderRadius: 8, padding: '12px 14px' }}>
            <div style={{ fontSize: 10, fontWeight: 600, color: 'var(--ink-muted)', textTransform: 'uppercase', letterSpacing: '0.05em', marginBottom: 4 }}>{t('overviewPage.drillDownValueAtRiskLabel')}</div>
            <div style={{ fontSize: 17, fontWeight: 800, color: hasRisk ? '#dc2626' : 'var(--ink)' }}>{fmtRWFExact(data.expiring.value)}</div>
          </div>
          <div style={{ background: 'var(--bg)', borderRadius: 8, padding: '12px 14px' }}>
            <div style={{ fontSize: 10, fontWeight: 600, color: 'var(--ink-muted)', textTransform: 'uppercase', letterSpacing: '0.05em', marginBottom: 4 }}>{t('overviewPage.drillDownHorizonLabel')}</div>
            <div style={{ fontSize: 13, fontWeight: 700, color: 'var(--ink)' }}>{t('overviewPage.drillDownHorizonValue')}</div>
          </div>
        </div>

        <div>
          <div style={{ fontSize: 13, fontWeight: 700, color: 'var(--ink)', marginBottom: 8 }}>{t('overviewPage.drillDownExpiryTimelineTitle')}</div>
          {hasRisk ? (
            <ResponsiveContainer width="100%" height={220}>
              <BarChart data={data.expiringBreakdown} margin={{ top: 4, right: 8, bottom: 0, left: 0 }}>
                <CartesianGrid stroke="#f0f0f0" strokeDasharray="4 4" />
                <XAxis dataKey="bucket" tick={{ fontSize: 10 }} axisLine={false} tickLine={false} />
                <YAxis tick={{ fontSize: 11 }} axisLine={false} tickLine={false} tickFormatter={v => Math.round(v).toLocaleString()} />
                <Tooltip content={<ChartTooltip />} />
                <Bar dataKey="value" name={t('overviewPage.drillDownValueAtRiskLabel')} radius={[5, 5, 0, 0]} barSize={36}>
                  {data.expiringBreakdown.map((b, i) => <Cell key={i} fill={EXPIRY_BUCKET_COLOR[b.bucket] ?? '#dc2626'} />)}
                </Bar>
              </BarChart>
            </ResponsiveContainer>
          ) : (
            <div style={{ fontSize: 12, color: 'var(--ink-muted)', padding: '20px 0', textAlign: 'center' }}>{t('overviewPage.drillDownNoExpiry')}</div>
          )}
        </div>

        <div style={{ display: 'flex', justifyContent: 'flex-end', gap: 8 }}>
          <Btn variant="secondary" onClick={handleExport}>{t('overviewPage.drillDownExportCsv')}</Btn>
          {onViewFullReport && <Btn variant="primary" onClick={onViewFullReport}>{t('overviewPage.drillDownViewFullReport')}</Btn>}
        </div>
      </div>
    </Modal>
  )
}

// Dashboard Overview for a pharmacy branch. Everything on this page is read
// from the branch's own rows through lib/overview.ts -- there is no fixture
// data left here. Three tiles the earlier mock version showed were removed
// rather than reproduced, because the schema cannot produce them honestly:
//
//   Net Profit / Break-Even -- there is no expenses or fixed-cost table.
//   Active Patients         -- there is no patients or customers table.
//   Cash/MoMo/Card mix      -- public.sales has no payment_method column.
//
// The first two are gone. The third is replaced by the split that IS
// recorded (insurance-covered vs patient-paid) and becomes a true payment
// mix once payment_method lands with the RRA VSDC invoice work.

// ─── KPI Card ────────────────────────────────────────────────────────────────

interface Tile {
  id: string
  label: string
  value: string
  sub: string
  icon: string
  color: string
  change?: number | null
  spark?: number[]
  muted?: boolean
}

function KPICard({ tile, active, onClick }: { tile: Tile; active: boolean; onClick?: () => void }) {
  const positive = (tile.change ?? 0) >= 0
  return (
    <div
      onClick={onClick}
      style={{
        background: active ? tile.color + '08' : '#fff',
        borderRadius: 12, padding: '18px 20px',
        border: `1.5px solid ${active ? tile.color + '60' : 'var(--border)'}`,
        display: 'flex', flexDirection: 'column', gap: 10,
        cursor: onClick ? 'pointer' : 'default', transition: 'all 0.18s',
        boxShadow: active ? `0 0 0 3px ${tile.color}18` : 'none',
        opacity: tile.muted ? 0.72 : 1,
      }}
      onMouseEnter={e => { if (!active && onClick) (e.currentTarget as HTMLDivElement).style.boxShadow = '0 4px 18px rgba(30,95,168,0.09)' }}
      onMouseLeave={e => { if (!active && onClick) (e.currentTarget as HTMLDivElement).style.boxShadow = 'none' }}
    >
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start', gap: 8 }}>
        <div style={{ flex: 1, minWidth: 0 }}>
          <div style={{ fontSize: 11, fontWeight: 500, color: 'var(--ink-muted)', textTransform: 'uppercase', letterSpacing: '0.07em' }}>
            {tile.label}
          </div>
          <div style={{ fontSize: 24, fontWeight: 700, color: 'var(--ink)', marginTop: 4, fontFamily: 'var(--font-display)', letterSpacing: '-0.02em', lineHeight: 1.1 }}>
            {tile.value}
          </div>
        </div>
        <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'flex-end', gap: 6 }}>
          <div style={{ width: 36, height: 36, borderRadius: 9, background: tile.color + '16', display: 'flex', alignItems: 'center', justifyContent: 'center', fontSize: 17, flexShrink: 0 }}>
            {tile.icon}
          </div>
          {tile.spark && tile.spark.length > 1 && (
            <Sparkline data={tile.spark} color={positive ? tile.color : '#dc2626'} />
          )}
        </div>
      </div>
      <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
        {/* A null change means there was no previous activity to compare with.
            Showing "+100%" against a zero baseline would look impressive and
            mean nothing, so the badge is simply omitted. */}
        {tile.change != null && (
          <span style={{
            fontSize: 11, fontWeight: 700, color: positive ? 'var(--positive)' : 'var(--negative)',
            background: positive ? '#d1fae5' : '#fee2e2', borderRadius: 4, padding: '2px 7px',
          }}>{pct(tile.change)}</span>
        )}
        <span style={{ fontSize: 11, color: 'var(--ink-muted)' }}>{tile.sub}</span>
      </div>
    </div>
  )
}

// ─── States ──────────────────────────────────────────────────────────────────

function Panel({ icon, title, msg }: { icon: string; title: string; msg: string }) {
  return (
    <div style={{ maxWidth: 620, margin: '56px auto', background: '#fff', border: '1px solid var(--border)', borderRadius: 14, padding: 32, textAlign: 'center' }}>
      <div style={{ fontSize: 30, marginBottom: 12 }}>{icon}</div>
      <h1 style={{ margin: 0, fontSize: 18, color: 'var(--ink)' }}>{title}</h1>
      <p style={{ color: 'var(--ink-muted)', lineHeight: 1.6, margin: '10px auto 0', maxWidth: 460, fontSize: 13 }}>{msg}</p>
    </div>
  )
}

function EmptyChart({ msg }: { msg: string }) {
  return (
    <div style={{ height: 180, display: 'grid', placeItems: 'center', color: 'var(--ink-faint)', fontSize: 12, textAlign: 'center', padding: '0 20px' }}>
      {msg}
    </div>
  )
}

const INSIGHT_STYLE = {
  good: { icon: '📈', color: 'var(--positive)' },
  warn: { icon: '⚠️', color: 'var(--warning)' },
  bad: { icon: '⛔', color: 'var(--negative)' },
  info: { icon: '💡', color: 'var(--info)' },
} as const

// ─── Page ────────────────────────────────────────────────────────────────────

export default function OverviewPage({
  role, period, branchName, alerts, onViewAlerts, onViewFullReport,
}: {
  role: Role
  period: OverviewPeriod
  branchName: string
  alerts: LiveAlert[]
  onViewAlerts: () => void
  onViewFullReport?: () => void
}) {
  const { t } = useTranslation()
  const { term: searchTerm } = useGlobalSearch()
  const [data, setData] = useState<OverviewData | null>(null)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const [activeCategory, setActiveCategory] = useState<string | null>(null)
  const [drillDownMetric, setDrillDownMetric] = useState<DrillDownMetric | null>(null)
  const [showInventoryDrillDown, setShowInventoryDrillDown] = useState(false)
  const [showExpiringDrillDown, setShowExpiringDrillDown] = useState(false)
  const [showExportModal, setShowExportModal] = useState(false)
  const [showBuilder, setShowBuilder] = useState(false)
  const [visibleWidgets, setVisibleWidgets] = useState<Record<WidgetKey, boolean>>(loadWidgetPrefs)

  const toggleWidget = (key: WidgetKey) => {
    setVisibleWidgets(prev => {
      const next = { ...prev, [key]: !prev[key] }
      try { localStorage.setItem(WIDGETS_STORAGE_KEY, JSON.stringify(next)) } catch { /* per-viewer convenience only */ }
      return next
    })
  }

  // The export modal closes before printing so it (and its backdrop) never
  // shows up as blank pages in the printed/"Save as PDF" output -- the
  // .print-only report node further down is the only thing print media reveals.
  const handlePrintPdf = () => {
    setShowExportModal(false)
    setTimeout(() => window.print(), 60)
  }

  const refresh = useCallback(async () => {
    setLoading(true)
    setError(null)
    try {
      setData(await loadOverview(period))
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Could not load the dashboard.')
    } finally {
      setLoading(false)
    }
  }, [period])

  useEffect(() => { void refresh() }, [refresh])

  // Changing the period must not leave a stale category filter applied to a
  // category that no longer appears in the new window.
  useEffect(() => { setActiveCategory(null) }, [period])

  if (loading && !data) return <Panel icon="◴" title="Loading dashboard" msg={`Reading ${branchName} sales, stock and alerts from the pharmacy database.`} />
  if (error) return <Panel icon="⚠" title="Could not load the dashboard" msg={error} />
  if (!data) return null

  const isPharmacist = role === 'pharmacist'
  const openAlerts = alerts.filter(a => !a.isRead)

  const revenueSpark = data.revenueTrend.map(p => p.revenue)
  const periodSub = `vs previous ${data.periodLabel.toLowerCase()}`

  const hasSplit = data.paymentSplit.length > 0
  const splitRows = hasSplit ? data.paymentSplit : [
    { name: 'Patient paid', value: 0, amount: 0, color: '#1e5fa8' },
    { name: 'Insurance', value: 0, amount: 0, color: '#60a5fa' },
  ]

  // Money tiles are owner/manager only; a pharmacist on shift gets the
  // operational half of the row. Matches how NAV_ITEMS already gates Analytics.
  const tiles: Tile[] = [
    ...(isPharmacist ? [] : [{
      id: 'revenue', label: 'Total Revenue', value: fmtRWFExact(data.revenue.value),
      sub: periodSub, icon: '💰', color: '#1e5fa8', change: data.revenue.changePct, spark: revenueSpark,
    }]),
    {
      id: 'transactions', label: 'Transactions', value: data.transactions.value.toLocaleString(),
      sub: periodSub, icon: '🧾', color: '#0284c7', change: data.transactions.changePct,
    },
    {
      id: 'items', label: 'Items Dispensed', value: data.itemsDispensed.value.toLocaleString(),
      sub: periodSub, icon: '💊', color: '#7c3aed', change: data.itemsDispensed.changePct,
    },
    ...(isPharmacist ? [] : [{
      id: 'inventory', label: 'Inventory Value', value: fmtRWFExact(data.inventoryValue),
      sub: 'stock on hand, at selling price', icon: '📦', color: '#d97706',
    }]),
    {
      id: 'expiring', label: 'Expiring ≤ 90 Days', value: data.expiring.count.toLocaleString(),
      sub: `${fmtRWFExact(data.expiring.value)} at risk`, icon: '⏳', color: '#dc2626',
    },
    {
      // Deliberately honest rather than absent: the RRA VSDC integration is not
      // built yet, and §10 of the certification checklist requires sync state to
      // be visible to the person on shift. Claiming "compliant" here before the
      // integration exists is exactly what an RRA technical review would catch.
      id: 'vsdc', label: 'RRA / VSDC', value: 'Not configured',
      sub: 'invoice sync pending', icon: '🏛️', color: '#587867', muted: true,
    },
  ]

  const visibleCategories = activeCategory
    ? data.categoryMix.filter(c => c.name === activeCategory)
    : data.categoryMix

  const searchNeedle = searchTerm.trim().toLowerCase()
  const visibleProducts: TopProduct[] = (activeCategory
    ? data.topProducts.filter(p => p.category === activeCategory)
    : data.topProducts
  ).filter(p => !searchNeedle || `${p.name} ${p.category}`.toLowerCase().includes(searchNeedle))

  const row1Widgets = ([
    { key: 'revenueTrend', weight: 1.65 },
    { key: 'categorySales', weight: 1 },
  ] as { key: WidgetKey; weight: number }[]).filter(w => visibleWidgets[w.key])

  const row2Widgets = ([
    { key: 'dailyTransactions', weight: 1 },
    { key: 'paymentMethods', weight: 0.52 },
    { key: 'alertsFeed', weight: 0.75 },
  ] as { key: WidgetKey; weight: number }[]).filter(w => visibleWidgets[w.key])

  return (
    <>
      <div className="no-print">
      {/* Toolbar */}
      <div style={{ display: 'flex', gap: 8, marginBottom: 18, alignItems: 'center' }}>
        <span style={{ fontSize: 12, color: 'var(--ink-muted)', flex: 1 }}>
          {activeCategory ? (
            <span>
              Filtered by: <strong style={{ color: 'var(--primary)' }}>{activeCategory}</strong>&nbsp;
              <button onClick={() => setActiveCategory(null)} style={{ fontSize: 11, color: 'var(--negative)', background: 'none', border: 'none', cursor: 'pointer', fontFamily: 'inherit' }}>✕ Clear</button>
            </span>
          ) : (
            <>{branchName} · {data.periodLabel} · click any chart bar or KPI to filter and drill down</>
          )}
        </span>
        <Btn variant="ghost" small onClick={() => void refresh()}>{loading ? '◴ Refreshing' : '↻ Refresh'}</Btn>
        <Btn variant="ghost" small onClick={() => setShowExportModal(true)}>↗ {t('overviewPage.exportButton')}</Btn>
        <Btn variant="secondary" small onClick={() => setShowBuilder(true)}>⊞ {t('overviewPage.customizeButton')}</Btn>
      </div>

      {/* KPI Grid */}
      {visibleWidgets.kpiCards && (
        <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(200px, 1fr))', gap: 12, marginBottom: 16 }}>
          {tiles.map(tile => (
            <KPICard
              key={tile.id}
              tile={tile}
              active={false}
              onClick={
                tile.id === 'revenue' || tile.id === 'transactions' || tile.id === 'items'
                  ? () => setDrillDownMetric(tile.id as DrillDownMetric)
                  : tile.id === 'inventory'
                    ? () => setShowInventoryDrillDown(true)
                    : tile.id === 'expiring'
                      ? () => setShowExpiringDrillDown(true)
                      : undefined
              }
            />
          ))}
        </div>
      )}

      {/* Revenue Trend + Sales by Category */}
      {row1Widgets.length > 0 && (
        <div style={{ display: 'grid', gridTemplateColumns: row1Widgets.map(w => `${w.weight}fr`).join(' '), gap: 14, marginBottom: 14 }}>
          {visibleWidgets.revenueTrend && (
            <Card>
              <SectionHeader
                title="Revenue Trend"
                subtitle={`${data.periodLabel} · ${data.bucket === 'month' ? 'by month' : 'by day'} · VAT shown separately`}
              />
              {/* Never gated on "are there sales": lib/overview.ts seeds every
                  bucket in the window, so a quiet period draws a real flat line at
                  zero instead of hiding the chart. */}
              <ResponsiveContainer width="100%" height={230}>
                  <AreaChart data={data.revenueTrend} margin={{ top: 4, right: 8, bottom: 0, left: 0 }}>
                    <defs>
                      <linearGradient id="gRev" x1="0" y1="0" x2="0" y2="1">
                        <stop offset="5%" stopColor="#1e5fa8" stopOpacity={0.16} />
                        <stop offset="95%" stopColor="#1e5fa8" stopOpacity={0} />
                      </linearGradient>
                      <linearGradient id="gVat" x1="0" y1="0" x2="0" y2="1">
                        <stop offset="5%" stopColor="#60a5fa" stopOpacity={0.2} />
                        <stop offset="95%" stopColor="#60a5fa" stopOpacity={0} />
                      </linearGradient>
                    </defs>
                    <CartesianGrid stroke="#f0f0f0" strokeDasharray="4 4" />
                    <XAxis dataKey="label" tick={{ fontSize: 11 }} axisLine={false} tickLine={false} minTickGap={16} />
                    <YAxis tick={{ fontSize: 11 }} axisLine={false} tickLine={false}
                      tickFormatter={v => Math.round(v).toLocaleString()} />
                    <Tooltip content={<ChartTooltip />} />
                    <Legend iconType="circle" iconSize={8} wrapperStyle={{ fontSize: 11 }} />
                    <Area type="monotone" dataKey="revenue" name="Revenue" stroke="#1e5fa8" fill="url(#gRev)" strokeWidth={2.5} dot={false} activeDot={{ r: 5 }} />
                    <Area type="monotone" dataKey="vat" name="VAT collected" stroke="#60a5fa" fill="url(#gVat)" strokeWidth={2} dot={false} activeDot={{ r: 4 }} />
                  </AreaChart>
              </ResponsiveContainer>
            </Card>
          )}

          {visibleWidgets.categorySales && (
            <Card>
              <SectionHeader
                title="Sales by Category"
                subtitle={activeCategory ? `Showing: ${activeCategory}` : 'Click a bar to cross-filter'}
              />
              {visibleCategories.length > 0 ? (
                <ResponsiveContainer width="100%" height={230}>
                  <BarChart data={visibleCategories} layout="vertical" margin={{ left: 0, right: 8 }}>
                    <CartesianGrid strokeDasharray="4 4" stroke="#f0f0f0" horizontal={false} />
                    <XAxis type="number" tick={{ fontSize: 10 }} axisLine={false} tickLine={false}
                      tickFormatter={v => Math.round(v).toLocaleString()} />
                    <YAxis type="category" dataKey="name" tick={{ fontSize: 10 }} axisLine={false} tickLine={false} width={88} />
                    <Tooltip content={<ChartTooltip />} />
                    <Bar dataKey="sales" name="Revenue" radius={[0, 5, 5, 0]} barSize={13} cursor="pointer"
                      onClick={(bar: any) => setActiveCategory(activeCategory === bar.name ? null : bar.name)}>
                      {visibleCategories.map((c, i) => (
                        <Cell key={i} fill={activeCategory === c.name ? '#1e5fa8' : '#a7f3d0'} />
                      ))}
                    </Bar>
                  </BarChart>
                </ResponsiveContainer>
              ) : <EmptyChart msg="No categorised sales in this period. Products are grouped using each branch's own categories." />}
            </Card>
          )}
        </div>
      )}

      {/* Daily Transactions + Payment Split + Active Alerts */}
      {row2Widgets.length > 0 && (
        <div style={{ display: 'grid', gridTemplateColumns: row2Widgets.map(w => `${w.weight}fr`).join(' '), gap: 14, marginBottom: 14 }}>
          {visibleWidgets.dailyTransactions && (
            <Card>
              <SectionHeader title="Daily Transactions" subtitle="Volume — this week, Monday to Sunday" />
              <ResponsiveContainer width="100%" height={185}>
                <BarChart data={data.dailyTransactions} margin={{ top: 4, right: 4, bottom: 0, left: 0 }}>
                  <CartesianGrid stroke="#f0f0f0" strokeDasharray="4 4" />
                  <XAxis dataKey="day" tick={{ fontSize: 11 }} axisLine={false} tickLine={false} />
                  <YAxis tick={{ fontSize: 11 }} axisLine={false} tickLine={false} allowDecimals={false} />
                  <Tooltip content={<ChartTooltip />} />
                  <Legend iconType="circle" iconSize={8} wrapperStyle={{ fontSize: 11 }} />
                  <Bar dataKey="txn" name="Transactions" fill="#1e5fa8" radius={[4, 4, 0, 0]} barSize={22} />
                </BarChart>
              </ResponsiveContainer>
            </Card>
          )}

          {visibleWidgets.paymentMethods && (
            <Card>
              {/* Not a cash/mobile-money/card mix: public.sales has no payment_method
                  column yet. This shows the split the database really records. */}
              <SectionHeader title="Payment Split" subtitle="Insurance vs patient" />
              {/* With no sales the ring renders as an empty track and both rows read
                  0% — the split is reported as zero, not hidden. */}
              <ResponsiveContainer width="100%" height={130}>
                <PieChart>
                  <Pie
                    data={hasSplit ? data.paymentSplit : [{ name: 'No sales', value: 1, color: 'var(--bg-alt)' }]}
                    cx="50%" cy="50%" innerRadius={38} outerRadius={58} paddingAngle={hasSplit ? 3 : 0} dataKey="value"
                    isAnimationActive={hasSplit}
                  >
                    {(hasSplit ? data.paymentSplit : [{ color: '#eaf5eb' }]).map((slice: any, i: number) => <Cell key={i} fill={slice.color} />)}
                  </Pie>
                  {hasSplit && <Tooltip formatter={(v: any) => `${v}%`} />}
                </PieChart>
              </ResponsiveContainer>
              <div style={{ display: 'flex', flexDirection: 'column', gap: 4, marginTop: 6 }}>
                {splitRows.map(slice => (
                  <div key={slice.name} style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', fontSize: 11 }}>
                    <div style={{ display: 'flex', alignItems: 'center', gap: 5 }}>
                      <div style={{ width: 8, height: 8, borderRadius: 2, background: slice.color, flexShrink: 0 }} />
                      <span style={{ color: 'var(--ink-muted)' }}>{slice.name}</span>
                    </div>
                    <span style={{ fontWeight: 600, color: 'var(--ink)' }}>{slice.value}%</span>
                  </div>
                ))}
                <div style={{ fontSize: 10, color: 'var(--ink-faint)', marginTop: 4, lineHeight: 1.4 }}>
                  Cash / mobile money / card breakdown needs a payment method on each sale — added with the RRA invoice work.
                </div>
              </div>
            </Card>
          )}

          {visibleWidgets.alertsFeed && (
            <Card style={{ padding: '16px 14px' }}>
              <SectionHeader title="Active Alerts" action={`View all (${openAlerts.length})`} onAction={onViewAlerts} />
              <div style={{ display: 'flex', flexDirection: 'column', gap: 7, overflowY: 'auto', maxHeight: 220 }}>
                {openAlerts.length === 0 ? (
                  <div style={{ padding: '22px 8px', textAlign: 'center', color: 'var(--ink-faint)', fontSize: 12, lineHeight: 1.5 }}>
                    ✓ Nothing needs attention right now.
                  </div>
                ) : openAlerts.slice(0, 4).map(alert => (
                  <AlertRow
                    key={alert.id} title={t(alert.titleKey)} msg={alert.msg} type={alert.type}
                    time={new Date(alert.createdAt).toLocaleDateString(undefined, { day: 'numeric', month: 'short' })}
                  />
                ))}
              </div>
            </Card>
          )}
        </div>
      )}

      {/* Insights */}
      <div style={{ background: 'linear-gradient(135deg, #ecfdf5, #f0fdf4)', border: '1.5px solid var(--border-strong)', borderRadius: 12, padding: '14px 18px', marginBottom: 14 }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 10 }}>
          <span style={{ fontSize: 18 }}>💡</span>
          <span style={{ fontSize: 14, fontWeight: 700, color: 'var(--ink)', fontFamily: 'var(--font-display)' }}>Insights</span>
          <span style={{ fontSize: 11, color: 'var(--ink-muted)', marginLeft: 4 }}>Calculated from this branch's own sales and stock</span>
        </div>
        <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(260px, 1fr))', gap: 8 }}>
          {data.insights.map((insight, i) => (
            <div key={i} style={{ background: '#fff', borderRadius: 8, padding: '10px 12px', display: 'flex', gap: 8, alignItems: 'flex-start', border: '1px solid var(--border)' }}>
              <span style={{ fontSize: 14, flexShrink: 0, marginTop: 1 }}>{INSIGHT_STYLE[insight.tone].icon}</span>
              <span style={{ fontSize: 12, color: 'var(--ink-mid)', lineHeight: 1.5 }}>{insight.text}</span>
            </div>
          ))}
        </div>
      </div>

      {/* Top Products */}
      {visibleWidgets.topProducts && (
        <Card>
          <SectionHeader
            title={activeCategory ? `Top Products — ${activeCategory}` : 'Top Products by Revenue'}
            subtitle={`${data.periodLabel} · stock column is live, not period-bound`}
            action="Export"
            onAction={() => setShowExportModal(true)}
          />
          {visibleProducts.length === 0 ? (
            <EmptyChart msg={searchNeedle ? `No products matching "${searchTerm}" in this period.` : 'No products sold in this period.'} />
          ) : (
            <div style={{ overflowX: 'auto' }}>
              <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 12 }}>
                <thead>
                  <tr style={{ borderBottom: '1px solid var(--border)' }}>
                    {['#', 'Product', 'Category', 'Units Sold', 'Revenue', 'Stock', 'Trend'].map(h => (
                      <th key={h} style={{ textAlign: 'left', padding: '7px 10px', color: 'var(--ink-muted)', fontWeight: 500, fontSize: 11, letterSpacing: '0.04em', whiteSpace: 'nowrap' }}>{h}</th>
                    ))}
                  </tr>
                </thead>
                <tbody>
                  {visibleProducts.map(product => (
                    <tr key={product.variantId}
                      style={{ borderBottom: '1px solid var(--bg-alt)', transition: 'background 0.13s' }}
                      onMouseEnter={e => (e.currentTarget.style.background = 'var(--bg)')}
                      onMouseLeave={e => (e.currentTarget.style.background = 'transparent')}
                    >
                      <td style={{ padding: '9px 10px', color: 'var(--ink-faint)', fontWeight: 600 }}>{product.rank}</td>
                      <td style={{ padding: '9px 10px', color: 'var(--ink)', fontWeight: 500, whiteSpace: 'nowrap' }}>{product.name}</td>
                      <td style={{ padding: '9px 10px' }}>
                        <span style={{ fontSize: 11, fontWeight: 600, borderRadius: 5, padding: '3px 8px', background: 'var(--primary-light)', color: 'var(--primary)', whiteSpace: 'nowrap' }}>
                          {product.category}
                        </span>
                      </td>
                      <td style={{ padding: '9px 10px', color: 'var(--ink-mid)' }}>{product.units.toLocaleString()}</td>
                      <td style={{ padding: '9px 10px', color: 'var(--ink)', fontWeight: 600, whiteSpace: 'nowrap' }}>{fmtRWFExact(product.revenue)}</td>
                      <td style={{ padding: '9px 10px', color: product.stock === 0 ? 'var(--negative)' : 'var(--ink-mid)', fontWeight: product.stock === 0 ? 600 : 400 }}>
                        {product.stock === 0 ? 'Out of stock' : product.stock.toLocaleString()}
                      </td>
                      <td style={{ padding: '9px 10px', whiteSpace: 'nowrap' }}>
                        {product.trendPct == null ? (
                          <span style={{ color: 'var(--ink-faint)' }}>new</span>
                        ) : (
                          <span style={{ color: product.trendPct >= 0 ? 'var(--positive)' : 'var(--negative)', fontWeight: 600 }}>
                            {product.trendPct >= 0 ? '↑' : '↓'} {Math.abs(product.trendPct).toFixed(1)}%
                          </span>
                        )}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </Card>
      )}
      </div>

      {/* Printable report -- screen-hidden (.print-only, see index.css), the
          only content @media print reveals once the export modal calls
          window.print() for the "PDF" format. Mirrors the on-screen sections
          above with real OverviewData, not a separate/fake payload. */}
      <div className="print-only" style={{ padding: 24 }}>
        <h2 style={{ fontFamily: 'var(--font-display)', marginBottom: 4 }}>PharmSync Dashboard</h2>
        <p style={{ fontSize: 13, color: '#555', marginTop: 0, marginBottom: 20 }}>{branchName} · {data.periodLabel}</p>
        {buildDashboardReport(data, branchName, isPharmacist).map(section => (
          <div key={section.title} style={{ marginBottom: 22, breakInside: 'avoid' }}>
            <h3 style={{ fontSize: 14, marginBottom: 6 }}>{section.title}</h3>
            <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 11 }}>
              <thead>
                <tr>
                  {section.headers.map(h => (
                    <th key={h} style={{ textAlign: 'left', border: '1px solid #ccc', padding: '4px 6px' }}>{h}</th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {section.rows.map((row, i) => (
                  <tr key={i}>
                    {row.map((cell, j) => (
                      <td key={j} style={{ border: '1px solid #ccc', padding: '4px 6px' }}>{cell}</td>
                    ))}
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        ))}
      </div>

      {drillDownMetric && (
        <TrendDrillDownModal
          metric={drillDownMetric}
          data={data}
          onClose={() => setDrillDownMetric(null)}
          onViewFullReport={onViewFullReport ? () => { setDrillDownMetric(null); onViewFullReport() } : undefined}
        />
      )}

      {showInventoryDrillDown && (
        <InventoryDrillDownModal
          data={data}
          onClose={() => setShowInventoryDrillDown(false)}
          onViewFullReport={onViewFullReport ? () => { setShowInventoryDrillDown(false); onViewFullReport() } : undefined}
        />
      )}

      {showExpiringDrillDown && (
        <ExpiringDrillDownModal
          data={data}
          onClose={() => setShowExpiringDrillDown(false)}
          onViewFullReport={onViewFullReport ? () => { setShowExpiringDrillDown(false); onViewFullReport() } : undefined}
        />
      )}

      {showExportModal && (
        <ExportDashboardModal
          data={data}
          branchName={branchName}
          isPharmacist={isPharmacist}
          onClose={() => setShowExportModal(false)}
          onPrintPdf={handlePrintPdf}
        />
      )}

      {showBuilder && (
        <DashboardBuilderModal
          visible={visibleWidgets}
          onToggle={toggleWidget}
          onClose={() => setShowBuilder(false)}
        />
      )}
    </>
  )
}
