import { useCallback, useEffect, useMemo, useState } from "react"
import { Btn, CenterAlert, Modal, SectionHeader, StatusBadge } from "../components"
import { fmtRWFExact } from "../data"
import { useTranslation } from "../lib/i18n"
import { useGlobalSearch } from "../lib/search"
import { adjustStock, listStockAdjustments, type StockAdjustmentRecord, type StockAdjustmentType } from "../lib/adjustments"
import { BARCODE_STATUS_TITLE_KEYS, packagingSummary } from "../lib/barcodes"
import { loadInventoryDataset, upsertReorderPoint, type InventoryDataset, type InventoryRow } from "../lib/inventory"
import { errorMessage } from "../lib/supabase"

const REMOVE_TYPES: StockAdjustmentType[] = ["damage", "loss", "return", "expired_writeoff", "recalled"]

const BARCODE_STATUS_META: Record<string, { color: string; bg: string }> = {
  active: { color: "#16a34a", bg: "#d1fae5" },
  sold_out: { color: "var(--ink-muted)", bg: "var(--bg)" },
  expired: { color: "#9333ea", bg: "#f5f3ff" },
  recalled: { color: "#dc2626", bg: "#fef2f2" },
  damaged: { color: "#d97706", bg: "#fef3c7" },
}

interface ProductGroup {
  productId: string
  branchId: string
  name: string
  category: string
  totalAvailable: number
  minQuantity: number
  maxQuantity?: number
  batches: InventoryRow[]
}

function groupByCategoryThenProduct(rows: InventoryRow[]): Map<string, ProductGroup[]> {
  const byProduct = new Map<string, ProductGroup>()
  for (const row of rows) {
    const key = `${row.category}::${row.product_id}`
    const existing = byProduct.get(key)
    if (existing) {
      existing.totalAvailable += row.quantity_available
      existing.batches.push(row)
    } else {
      byProduct.set(key, {
        productId: row.product_id, branchId: row.branch_id, name: row.name, category: row.category,
        totalAvailable: row.quantity_available, minQuantity: row.min_quantity, maxQuantity: row.max_quantity,
        batches: [row],
      })
    }
  }
  const byCategory = new Map<string, ProductGroup[]>()
  for (const group of byProduct.values()) {
    const list = byCategory.get(group.category)
    if (list) list.push(group)
    else byCategory.set(group.category, [group])
  }
  for (const list of byCategory.values()) list.sort((a, b) => a.name.localeCompare(b.name))
  return byCategory
}

// ── Packaging explainer — the same carton → pack → piece hierarchy every
// batch/barcode row already carries, spelled out once at the top of the page
// so "adjust 3 pieces" vs "adjust 1 pack" is unambiguous before anyone opens
// a modal. Shown here and on the Barcode Manager, the two screens where a
// mismatch between "pack" and "piece" would actually cost stock accuracy.
function PackagingExplainer() {
  const { t } = useTranslation()
  return (
    <div style={{ background: "var(--primary-light)", border: "1px solid var(--border)", borderRadius: 10, padding: "12px 16px", display: "flex", gap: 12, alignItems: "flex-start" }}>
      <span style={{ fontSize: 18, flexShrink: 0 }}>📦</span>
      <div>
        <div style={{ fontSize: 12, fontWeight: 700, color: "var(--ink)" }}>{t("reports.packagingExplainerTitle")}</div>
        <div style={{ fontSize: 11, color: "var(--ink-mid)", marginTop: 3, lineHeight: 1.5 }}>{t("reports.packagingExplainerBody")}</div>
      </div>
    </div>
  )
}

export function AdjustModal({ batch, onClose, onSaved }: { batch: InventoryRow; onClose: () => void; onSaved: () => void }) {
  const { t } = useTranslation()
  const [type, setType] = useState<StockAdjustmentType>("damage")
  const [direction, setDirection] = useState<"remove" | "add">("remove")
  const [quantity, setQuantity] = useState("")
  const [reason, setReason] = useState("")
  const [error, setError] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)

  const TYPE_LABELS: Record<StockAdjustmentType, string> = {
    damage: t("stockAdjustment.typeDamage"),
    loss: t("stockAdjustment.typeLoss"),
    correction: t("stockAdjustment.typeCorrection"),
    return: t("stockAdjustment.typeReturn"),
    expired_writeoff: t("stockAdjustment.typeExpiredWriteoff"),
    recalled: t("stockAdjustment.typeRecalled"),
  }

  function selectType(next: StockAdjustmentType) {
    setType(next)
    if (next !== "correction") setDirection("remove")
  }

  async function submit() {
    const qty = Number.parseInt(quantity, 10)
    if (!Number.isFinite(qty) || qty < 1) { setError(t("stockAdjustment.quantityInvalid")); return }
    if (!reason.trim()) { setError(t("stockAdjustment.reasonRequired")); return }
    setBusy(true)
    setError(null)
    try {
      const delta = direction === "add" ? qty : -qty
      await adjustStock(batch.batch_id, type, delta, reason.trim())
      onSaved()
    } catch (reason_) {
      setError(errorMessage(reason_, t("stockAdjustment.submitError")))
    } finally {
      setBusy(false)
    }
  }

  return <Modal title={t("stockAdjustment.modalTitle", { product: [batch.name, batch.dosage].filter(Boolean).join(" ") })} onClose={onClose} width={460}>
    <div style={{ display: "flex", flexDirection: "column", gap: 12 }}>
      {error && <p style={{ margin: 0, fontSize: 11, color: "#dc2626" }}>{error}</p>}
      <div>
        <label style={{ fontSize: 10, fontWeight: 600, color: "var(--ink-muted)", textTransform: "uppercase", letterSpacing: "0.05em", display: "block", marginBottom: 4 }}>{t("stockAdjustment.typeLabel")}</label>
        <select value={type} onChange={e => selectType(e.target.value as StockAdjustmentType)}
          style={{ width: "100%", padding: "8px 10px", border: "1px solid var(--border)", borderRadius: 7, fontFamily: "inherit", fontSize: 12, boxSizing: "border-box", background: "#fff" }}>
          {([...REMOVE_TYPES, "correction"] as StockAdjustmentType[]).map(opt => <option key={opt} value={opt}>{TYPE_LABELS[opt]}</option>)}
        </select>
      </div>
      {type === "correction" && (
        <div>
          <label style={{ fontSize: 10, fontWeight: 600, color: "var(--ink-muted)", textTransform: "uppercase", letterSpacing: "0.05em", display: "block", marginBottom: 4 }}>{t("stockAdjustment.directionLabel")}</label>
          <div style={{ display: "flex", gap: 8 }}>
            <button onClick={() => setDirection("remove")} style={{ flex: 1, padding: "8px 10px", borderRadius: 7, fontSize: 11, fontWeight: 600, cursor: "pointer", fontFamily: "inherit", border: `1.5px solid ${direction === "remove" ? "var(--primary)" : "var(--border)"}`, background: direction === "remove" ? "var(--primary-light)" : "#fff", color: direction === "remove" ? "var(--primary)" : "var(--ink-mid)" }}>{t("stockAdjustment.directionRemove")}</button>
            <button onClick={() => setDirection("add")} style={{ flex: 1, padding: "8px 10px", borderRadius: 7, fontSize: 11, fontWeight: 600, cursor: "pointer", fontFamily: "inherit", border: `1.5px solid ${direction === "add" ? "var(--primary)" : "var(--border)"}`, background: direction === "add" ? "var(--primary-light)" : "#fff", color: direction === "add" ? "var(--primary)" : "var(--ink-mid)" }}>{t("stockAdjustment.directionAdd")}</button>
          </div>
        </div>
      )}
      <div>
        <label style={{ fontSize: 10, fontWeight: 600, color: "var(--ink-muted)", textTransform: "uppercase", letterSpacing: "0.05em", display: "block", marginBottom: 4 }}>{t("stockAdjustment.quantityLabel")}</label>
        <input type="number" min="1" value={quantity} onChange={e => setQuantity(e.target.value)}
          style={{ width: "100%", padding: "8px 10px", border: "1px solid var(--border)", borderRadius: 7, fontFamily: "inherit", fontSize: 12, boxSizing: "border-box" }} />
        <p style={{ margin: "4px 0 0", fontSize: 10, color: "var(--ink-faint)" }}>{t("stockAdjustment.quantityHint")}</p>
      </div>
      <div>
        <label style={{ fontSize: 10, fontWeight: 600, color: "var(--ink-muted)", textTransform: "uppercase", letterSpacing: "0.05em", display: "block", marginBottom: 4 }}>{t("stockAdjustment.reasonLabel")}</label>
        <textarea value={reason} onChange={e => setReason(e.target.value)} placeholder={t("stockAdjustment.reasonPlaceholder")} rows={3}
          style={{ width: "100%", padding: "8px 10px", border: "1px solid var(--border)", borderRadius: 7, fontFamily: "inherit", fontSize: 12, boxSizing: "border-box", resize: "vertical" }} />
      </div>
      <div style={{ display: "flex", justifyContent: "flex-end", gap: 8 }}>
        <Btn variant="ghost" onClick={onClose}>{t("stockAdjustment.cancel")}</Btn>
        <Btn variant="primary" onClick={() => void submit()}>{busy ? t("stockAdjustment.submitting") : t("stockAdjustment.submit")}</Btn>
      </div>
    </div>
  </Modal>
}

function BatchRow({ batch, barcodes, onAdjust }: {
  batch: InventoryRow
  barcodes: InventoryDataset["barcodes"]
  onAdjust: () => void
}) {
  const { t } = useTranslation()
  const [showBarcodes, setShowBarcodes] = useState(false)
  const packBarcodes = useMemo(() => barcodes.filter(b => b.stock_batch_id === batch.batch_id && b.barcode_type === "pack"), [barcodes, batch.batch_id])
  const boxBarcodes = useMemo(() => barcodes.filter(b => b.stock_batch_id === batch.batch_id && b.barcode_type === "box"), [barcodes, batch.batch_id])
  const piecesPerPack = packBarcodes.find(b => b.pieces_per_pack)?.pieces_per_pack ?? 0

  return <div style={{ borderTop: "1px solid var(--bg-alt)", padding: "10px 0" }}>
    <div style={{ display: "flex", alignItems: "center", gap: 12, flexWrap: "wrap" }}>
      <div style={{ flex: "1 1 160px", minWidth: 140 }}>
        <div style={{ fontFamily: "monospace", fontSize: 11, fontWeight: 600 }}>{batch.batch_number}</div>
        <div style={{ fontSize: 10, color: "var(--ink-muted)" }}>{t("stockAdjustment.expiry")}: {batch.expiry_date}</div>
      </div>
      <div style={{ flex: "1 1 200px", minWidth: 160 }}>
        <div style={{ fontSize: 12, fontWeight: 700 }}>{batch.quantity_available} <span style={{ fontSize: 10, fontWeight: 400, color: "var(--ink-muted)" }}>{t("stockAdjustment.available")}</span></div>
        <div style={{ fontSize: 10, color: "var(--ink-muted)" }}>{packagingSummary(batch.unit, boxBarcodes.length, packBarcodes.length, piecesPerPack, t)}</div>
      </div>
      <div style={{ fontSize: 11, color: "var(--ink-muted)", minWidth: 110 }}>{t("stockAdjustment.costPrice")}: {fmtRWFExact(batch.cost_price)}</div>
      <div style={{ fontSize: 11, fontWeight: 600, minWidth: 110 }}>{t("stockAdjustment.sellPrice")}: {fmtRWFExact(batch.selling_price)}</div>
      <button onClick={() => setShowBarcodes(v => !v)} style={{ fontSize: 10, color: "var(--primary)", background: "none", border: "none", cursor: "pointer", fontFamily: "inherit", padding: 0 }}>
        {showBarcodes ? t("stockAdjustment.hideBarcodes") : t("stockAdjustment.viewBarcodes", { count: packBarcodes.length })}
      </button>
      <Btn variant="secondary" small onClick={onAdjust}>{t("stockAdjustment.adjustAction")}</Btn>
    </div>
    {showBarcodes && (
      <div style={{ marginTop: 8, background: "var(--bg)", borderRadius: 8, padding: "8px 10px", overflowX: "auto" }}>
        <table style={{ width: "100%", borderCollapse: "collapse", fontSize: 11 }}>
          <thead><tr>{[t("stockAdjustment.barcodeCode"), t("stockAdjustment.barcodePieces"), t("stockAdjustment.barcodeStatus")].map(l => <th key={l} style={{ textAlign: "left", padding: "4px 8px", color: "var(--ink-muted)", fontSize: 10 }}>{l}</th>)}</tr></thead>
          <tbody>
            {packBarcodes.map(bc => {
              const meta = BARCODE_STATUS_META[bc.status] ?? BARCODE_STATUS_META.active
              return <tr key={bc.id}>
                <td style={{ padding: "4px 8px", fontFamily: "monospace" }}>{bc.code}</td>
                <td style={{ padding: "4px 8px" }}>{bc.quantity_available > 0 ? bc.pieces_per_pack : 0}</td>
                <td style={{ padding: "4px 8px" }}><StatusBadge label={t(BARCODE_STATUS_TITLE_KEYS[bc.status as keyof typeof BARCODE_STATUS_TITLE_KEYS])} color={meta.color} bg={meta.bg} /></td>
              </tr>
            })}
          </tbody>
        </table>
      </div>
    )}
  </div>
}

function ProductCard({ group, barcodes, onAdjustBatch, onSetReorder }: {
  group: ProductGroup
  barcodes: InventoryDataset["barcodes"]
  onAdjustBatch: (batch: InventoryRow) => void
  onSetReorder: (group: ProductGroup) => void
}) {
  const { t } = useTranslation()
  const [open, setOpen] = useState(false)
  const below = group.minQuantity > 0 && group.totalAvailable < group.minQuantity
  return <div className="animate-fade-in" style={{ background: "#fff", border: `1px solid ${below ? "#fca5a5" : "var(--border)"}`, borderRadius: 10, padding: "12px 16px" }}>
    <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", gap: 10 }}>
      <button onClick={() => setOpen(v => !v)} style={{ flex: 1, minWidth: 0, display: "flex", justifyContent: "space-between", alignItems: "center", background: "none", border: "none", cursor: "pointer", fontFamily: "inherit", padding: 0, textAlign: "left" }}>
        <div>
          <div style={{ fontWeight: 700, fontSize: 13, color: "var(--ink)", display: "flex", alignItems: "center", gap: 6 }}>
            {group.name}
            {below && <StatusBadge label={t("reports.statusBelow")} color="#dc2626" bg="#fef2f2" />}
          </div>
          <div style={{ fontSize: 10, color: "var(--ink-muted)" }}>
            {t("stockAdjustment.batchesCount", { count: group.batches.length })}
            {group.minQuantity > 0 && ` · ${t("reports.reorderMinShort", { min: group.minQuantity })}`}
          </div>
        </div>
        <div style={{ display: "flex", alignItems: "center", gap: 10 }}>
          <span style={{ fontSize: 13, fontWeight: 800, color: "var(--primary)" }}>{group.totalAvailable}</span>
          <span style={{ color: "var(--ink-faint)", transform: open ? "rotate(90deg)" : "none", transition: "transform 0.15s" }}>›</span>
        </div>
      </button>
      <button onClick={() => onSetReorder(group)}
        style={{ fontSize: 10, fontWeight: 700, color: "var(--primary)", background: "none", border: "1px solid var(--border)", borderRadius: 6, padding: "4px 8px", cursor: "pointer", fontFamily: "inherit", whiteSpace: "nowrap", flexShrink: 0 }}>
        {t("reports.setReorderPoint")}
      </button>
    </div>
    {open && group.batches.map(batch => <BatchRow key={batch.batch_id} batch={batch} barcodes={barcodes} onAdjust={() => onAdjustBatch(batch)} />)}
  </div>
}

function AdjustmentHistoryRow({ row }: { row: StockAdjustmentRecord }) {
  const { t } = useTranslation()
  const TYPE_LABELS: Record<StockAdjustmentType, string> = {
    damage: t("stockAdjustment.typeDamage"), loss: t("stockAdjustment.typeLoss"), correction: t("stockAdjustment.typeCorrection"),
    return: t("stockAdjustment.typeReturn"), expired_writeoff: t("stockAdjustment.typeExpiredWriteoff"), recalled: t("stockAdjustment.typeRecalled"),
  }
  return <tr style={{ borderBottom: "1px solid var(--bg-alt)" }}>
    <td style={{ padding: "8px 10px", fontWeight: 600 }}>{row.productName}{row.dosage ? ` ${row.dosage}` : ""}<div style={{ fontFamily: "monospace", fontSize: 10, color: "var(--ink-muted)", fontWeight: 400 }}>{row.batchNumber}</div></td>
    <td style={{ padding: "8px 10px" }}>{TYPE_LABELS[row.adjustmentType]}</td>
    <td style={{ padding: "8px 10px", fontWeight: 700 }}>{row.quantity}</td>
    <td style={{ padding: "8px 10px", color: "var(--ink-mid)" }}>{row.reason}</td>
    <td style={{ padding: "8px 10px", color: "var(--ink-muted)", fontSize: 11 }}>{new Date(row.adjustedAt).toLocaleString()}</td>
    <td style={{ padding: "8px 10px", color: "var(--ink-muted)", fontSize: 11 }}>{row.performedByName ?? "—"}</td>
  </tr>
}

// ── Reorder point modal — inlined here (rather than imported from
// LiveInventoryPage) so this page owns its own product-level reorder target
// shape (a ProductGroup, not a single InventoryRow). ──────────────────────
function ReorderPointModal({ group, onClose, onSaved }: { group: ProductGroup; onClose: () => void; onSaved: () => void }) {
  const { t } = useTranslation()
  const [minQuantity, setMinQuantity] = useState(String(group.minQuantity))
  const [maxQuantity, setMaxQuantity] = useState(group.maxQuantity != null ? String(group.maxQuantity) : "")
  const [error, setError] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)

  async function save() {
    const min = Number.parseInt(minQuantity, 10)
    if (!Number.isFinite(min) || min < 0) { setError(t("inventoryPage.reorderMinInvalid")); return }
    const max = maxQuantity.trim() ? Number.parseInt(maxQuantity, 10) : null
    if (max != null && (!Number.isFinite(max) || max < min)) { setError(t("inventoryPage.reorderMaxInvalid")); return }
    setBusy(true)
    setError(null)
    try {
      await upsertReorderPoint(group.productId, group.branchId, min, max)
      onSaved()
    } catch (reason) {
      setError(errorMessage(reason, t("inventoryPage.reorderSaveError")))
    } finally {
      setBusy(false)
    }
  }

  return <Modal title={t("inventoryPage.reorderModalTitle", { product: group.name })} onClose={onClose} width={420}>
    <div style={{ display: "flex", flexDirection: "column", gap: 12 }}>
      <p style={{ margin: 0, fontSize: 11, color: "var(--ink-muted)" }}>
        {t("inventoryPage.reorderExplainer")}
      </p>
      {error && <p style={{ margin: 0, fontSize: 11, color: "#dc2626" }}>{error}</p>}
      <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 10 }}>
        <div>
          <label style={{ fontSize: 10, fontWeight: 600, color: "var(--ink-muted)", textTransform: "uppercase", letterSpacing: "0.05em", display: "block", marginBottom: 4 }}>{t("inventoryPage.reorderMin")}</label>
          <input type="number" min="0" value={minQuantity} onChange={e => setMinQuantity(e.target.value)}
            style={{ width: "100%", padding: "8px 10px", border: "1px solid var(--border)", borderRadius: 7, fontFamily: "inherit", fontSize: 12, boxSizing: "border-box" }} />
        </div>
        <div>
          <label style={{ fontSize: 10, fontWeight: 600, color: "var(--ink-muted)", textTransform: "uppercase", letterSpacing: "0.05em", display: "block", marginBottom: 4 }}>{t("inventoryPage.reorderMax")}</label>
          <input type="number" min="0" value={maxQuantity} onChange={e => setMaxQuantity(e.target.value)}
            style={{ width: "100%", padding: "8px 10px", border: "1px solid var(--border)", borderRadius: 7, fontFamily: "inherit", fontSize: 12, boxSizing: "border-box" }} />
        </div>
      </div>
      <div style={{ display: "flex", justifyContent: "flex-end", gap: 8 }}>
        <Btn variant="ghost" onClick={onClose}>{t("inventoryPage.cancel")}</Btn>
        <Btn variant="primary" onClick={() => void save()}>{busy ? t("inventoryPage.saving") : t("inventoryPage.saveReorderPoint")}</Btn>
      </div>
    </div>
  </Modal>
}

export default function ReportsPage() {
  const { t } = useTranslation()
  const [dataset, setDataset] = useState<InventoryDataset>({ rows: [], barcodes: [], supplierUnits: [] })
  const [history, setHistory] = useState<StockAdjustmentRecord[]>([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const { term: globalTerm, setTerm: setGlobalTerm } = useGlobalSearch()
  const [query, setQuery] = useState(globalTerm)
  useEffect(() => setQuery(globalTerm), [globalTerm])
  const [adjustTarget, setAdjustTarget] = useState<InventoryRow | null>(null)
  const [reorderTarget, setReorderTarget] = useState<ProductGroup | null>(null)
  const [successMsg, setSuccessMsg] = useState<string | null>(null)

  const refresh = useCallback(async () => {
    setLoading(true)
    setError(null)
    try {
      const [inv, adj] = await Promise.all([loadInventoryDataset(), listStockAdjustments()])
      setDataset(inv)
      setHistory(adj)
    } catch (reason) {
      setError(errorMessage(reason, t("stockAdjustment.loadError")))
    } finally {
      setLoading(false)
    }
  }, [t])

  useEffect(() => { void refresh() }, [refresh])

  const grouped = useMemo(() => {
    const needle = query.trim().toLowerCase()
    const rows = needle ? dataset.rows.filter(row => `${row.name} ${row.category}`.toLowerCase().includes(needle)) : dataset.rows
    return groupByCategoryThenProduct(rows)
  }, [dataset.rows, query])

  const totalProducts = useMemo(() => [...grouped.values()].reduce((sum, list) => sum + list.length, 0), [grouped])
  const belowCount = useMemo(
    () => [...grouped.values()].flat().filter(g => g.minQuantity > 0 && g.totalAvailable < g.minQuantity).length,
    [grouped],
  )

  return <div className="animate-fade-in" style={{ display: "flex", flexDirection: "column", gap: 16 }}>
    {error && <div style={{ background: "#fef2f2", color: "#b91c1c", border: "1px solid #fecaca", borderRadius: 10, padding: "12px 14px", fontSize: 12 }}>{error}</div>}
    {successMsg && <CenterAlert key={successMsg} message={successMsg} tone="success" />}
    <SectionHeader title={t("page.reports")} subtitle={t("reports.subtitle")} action={t("stockAdjustment.refresh")} onAction={() => void refresh()} />

    <PackagingExplainer />

    <div style={{ display: "grid", gridTemplateColumns: "repeat(2, 1fr)", gap: 10 }}>
      <div className="animate-fade-up" style={{ background: "#fff", border: "1px solid var(--border)", borderRadius: 10, padding: "14px 16px" }}>
        <div style={{ fontSize: 22, fontWeight: 800, color: "var(--primary)" }}>{loading ? "—" : totalProducts}</div>
        <div style={{ fontSize: 11, fontWeight: 600, color: "var(--ink)" }}>{t("reports.tileTotalProducts")}</div>
      </div>
      <div className="animate-fade-up" style={{ animationDelay: "60ms", background: belowCount > 0 ? "#fef2f2" : "#fff", border: `1px solid ${belowCount > 0 ? "#fca5a5" : "var(--border)"}`, borderRadius: 10, padding: "14px 16px" }}>
        <div style={{ fontSize: 22, fontWeight: 800, color: belowCount > 0 ? "#dc2626" : "var(--ink)" }}>{loading ? "—" : belowCount}</div>
        <div style={{ fontSize: 11, fontWeight: 600, color: "var(--ink)" }}>{t("reports.tileBelowReorder")}</div>
      </div>
    </div>

    <div style={{ display: "flex", gap: 8 }}>
      <input value={query} onChange={e => { setQuery(e.target.value); setGlobalTerm(e.target.value) }} placeholder={t("stockAdjustment.searchPlaceholder")}
        style={{ flex: 1, maxWidth: 360, padding: "8px 12px", border: "1px solid var(--border)", borderRadius: 8, fontFamily: "inherit", fontSize: 12 }} />
    </div>

    <div style={{ display: "flex", flexDirection: "column", gap: 18 }}>
      {loading && <p style={{ fontSize: 12, color: "var(--ink-muted)" }}>{t("shell.loadingWorkspace")}</p>}
      {!loading && grouped.size === 0 && <p style={{ fontSize: 12, color: "var(--ink-muted)" }}>{t("stockAdjustment.noProducts")}</p>}
      {[...grouped.entries()].map(([category, groups]) => (
        <div key={category}>
          <div style={{ display: "flex", alignItems: "baseline", gap: 8, marginBottom: 8 }}>
            <h3 style={{ margin: 0, fontSize: 13, fontWeight: 700, color: "var(--ink)" }}>{category}</h3>
            <span style={{ fontSize: 11, color: "var(--ink-muted)" }}>{t("stockAdjustment.productsInCategory", { count: groups.length })}</span>
          </div>
          <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
            {groups.map(group => (
              <ProductCard key={group.productId} group={group} barcodes={dataset.barcodes} onAdjustBatch={setAdjustTarget} onSetReorder={setReorderTarget} />
            ))}
          </div>
        </div>
      ))}
    </div>

    <div style={{ background: "#fff", border: "1px solid var(--border)", borderRadius: 12, padding: "16px 18px" }}>
      <SectionHeader title={t("stockAdjustment.recentTitle")} subtitle={t("stockAdjustment.recentSubtitle")} />
      <div style={{ overflowX: "auto" }}>
        <table style={{ width: "100%", borderCollapse: "collapse", fontSize: 12 }}>
          <thead><tr style={{ borderBottom: "1px solid var(--border)" }}>
            {[t("stockAdjustment.colProduct"), t("stockAdjustment.colType"), t("stockAdjustment.colQuantity"), t("stockAdjustment.colReason"), t("stockAdjustment.colWhen"), t("stockAdjustment.colBy")].map(l => <th key={l} style={{ textAlign: "left", padding: "8px 10px", color: "var(--ink-muted)", fontSize: 10 }}>{l}</th>)}
          </tr></thead>
          <tbody>
            {history.map(row => <AdjustmentHistoryRow key={row.id} row={row} />)}
            {!loading && history.length === 0 && <tr><td colSpan={6} style={{ padding: 24, textAlign: "center", color: "var(--ink-muted)" }}>{t("stockAdjustment.noAdjustments")}</td></tr>}
          </tbody>
        </table>
      </div>
    </div>

    {adjustTarget && (
      <AdjustModal batch={adjustTarget} onClose={() => setAdjustTarget(null)} onSaved={() => { setAdjustTarget(null); setSuccessMsg(t("stockAdjustment.submit")); void refresh() }} />
    )}

    {reorderTarget && (
      <ReorderPointModal group={reorderTarget} onClose={() => setReorderTarget(null)} onSaved={() => { setReorderTarget(null); void refresh() }} />
    )}
  </div>
}
