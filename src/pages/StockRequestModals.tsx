import { useEffect, useMemo, useRef, useState } from "react"
import { Btn, Modal } from "../components"
import { useTranslation } from "../lib/i18n"
import type { TranslationKey } from "../lib/i18n/en"
import { errorMessage } from "../lib/supabase"
import { loadInventoryDataset, type InventoryRow, type InventoryDataset } from "../lib/inventory"
import { countActiveBatchUnits, requestStockTransfer, scanBranchBatch, splitStockBatch } from "../lib/stockTransfers"
import { requestStockFromBranch } from "../lib/stockNeeds"
import type { OrganizationBranch } from "../lib/organization"

// Shared by OrganizationPage.tsx (org-wide oversight dashboard) AND
// OverviewPage.tsx (a specific branch's own dashboard, for an org_owner/
// org_manager who's drilled into it or narrowed the org-wide picker to it)
// -- pulled into their own module, not defined inside either page, so
// neither page's lazy-loaded chunk has to pull in the other's just for
// these two modals. Each caller supplies its own destinationBranches list
// and (when requesting FROM a branch other than the caller's own, i.e. from
// OverviewPage) a fromBranchId -- both request_stock_transfer() and
// request_stock_from_branch() already accept that on the server, this just
// exposes it here too.

const inputStyle = { width: "100%", padding: "9px 10px", border: "1px solid var(--border)", borderRadius: 7, fontFamily: "inherit", fontSize: 13, boxSizing: "border-box" as const }
const labelStyle = { fontSize: 10, fontWeight: 600, color: "var(--ink-muted)", textTransform: "uppercase" as const, letterSpacing: "0.05em", display: "block", marginBottom: 4 }

// An OrganizationBranch with its straight-line distance from the source
// branch folded in -- null when either branch has no location pin set.
export type BranchWithDistance = OrganizationBranch & { distanceKm: number | null }

export function formatDistance(km: number | null, t: (key: TranslationKey) => string): string {
  return km == null ? t("organization.distanceUnknown") : `${km < 10 ? km.toFixed(1) : Math.round(km)} km`
}

// A batch resolved to more than one active pack (count_active_batch_units()
// > 1) needs the user to say how many of them they actually mean, instead of
// silently committing every pack currently sitting under it -- see
// split_stock_batch() in 2026-09-19_stock_batch_split_for_partial_transfer.sql.
// productName/batchNumber/dosage are only for display; qty is the input's
// live (string) value while the user is typing it.
interface PendingPackPrompt {
  batchId: string
  productName: string
  batchNumber: string
  dosage: string | null
  max: number
  qty: string
}

// Shared by both modals below: renders nothing when prompt is null. Confirm
// re-validates qty is a whole number in [1, max] before calling onConfirm --
// the caller still owns the actual split_stock_batch()/request call and its
// own busy/error state, this just guards the input.
function PackQuantityCard({ prompt, hint, busy, error, onChange, onCancel, onConfirm }: {
  prompt: PendingPackPrompt
  hint: string
  busy: boolean
  error: string | null
  onChange: (qty: string) => void
  onCancel: () => void
  onConfirm: () => void
}) {
  const { t } = useTranslation()
  return (
    <div style={{ border: "1.5px solid var(--primary)", borderRadius: 8, padding: 12, display: "flex", flexDirection: "column", gap: 8, background: "var(--bg-alt)" }}>
      <div style={{ fontSize: 12, fontWeight: 700, color: "var(--ink)" }}>{t("organization.packQuantityTitle")}</div>
      <p style={{ margin: 0, fontSize: 11, color: "var(--ink-muted)" }}>{hint}</p>
      {error && <p style={{ margin: 0, fontSize: 11, color: "#dc2626" }}>{error}</p>}
      <input
        type="number" min={1} max={prompt.max} value={prompt.qty} autoFocus
        onChange={e => onChange(e.target.value)}
        onKeyDown={e => { if (e.key === "Enter") { e.preventDefault(); onConfirm() } }}
        style={inputStyle}
      />
      <div style={{ display: "flex", justifyContent: "flex-end", gap: 8 }}>
        <Btn variant="ghost" small onClick={onCancel}>{t("organization.cancel")}</Btn>
        <Btn variant="primary" small onClick={onConfirm}>{busy ? t("organization.creating") : t("organization.packQuantityConfirm")}</Btn>
      </div>
    </div>
  )
}

// The push side: "I have spare X, send it to branch Y." fromBranchId is the
// branch actually sending -- the caller's own branch when omitted (a plain
// branch owner/manager, or an org_owner/org_manager on their own home
// branch), or whichever branch's dashboard is open (an org_owner/org_manager
// viewing a different branch).
export function RequestTransferModal({ destinationBranches, fromBranchId, onClose, onRequested }: {
  destinationBranches: BranchWithDistance[]; fromBranchId?: string; onClose: () => void; onRequested: () => void
}) {
  const { t } = useTranslation()
  const [toBranchId, setToBranchId] = useState(destinationBranches[0]?.branchId ?? "")
  const [notes, setNotes] = useState("")
  const [search, setSearch] = useState("")
  const [scanCode, setScanCode] = useState("")
  const [scanError, setScanError] = useState<string | null>(null)
  const [selected, setSelected] = useState<Set<string>>(new Set())
  const [rows, setRows] = useState<InventoryRow[]>([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)
  const [packPrompt, setPackPrompt] = useState<PendingPackPrompt | null>(null)
  const [packBusy, setPackBusy] = useState(false)
  const [packError, setPackError] = useState<string | null>(null)
  const scanInputRef = useRef<HTMLInputElement>(null)

  // destinationBranches starts empty on this modal's very first render
  // whenever the org's own branch list hasn't finished loading yet -- the
  // useState initializer above only ever runs once, so without this it
  // would stay stuck on "" (an unselectable, blank-looking dropdown) even
  // after the real branch list arrives a moment later. Also re-syncs if
  // the previously-picked branch ever stops being a valid destination.
  useEffect(() => {
    if (!toBranchId || !destinationBranches.some(b => b.branchId === toBranchId)) {
      setToBranchId(destinationBranches[0]?.branchId ?? "")
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [destinationBranches])

  useEffect(() => {
    loadInventoryDataset(fromBranchId)
      .then(dataset => setRows(dataset.rows.filter(r => r.quantity_available > 0)))
      .catch(reason => setError(errorMessage(reason, t("organization.transferLoadStockError"))))
      .finally(() => setLoading(false))
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [t, fromBranchId])

  useEffect(() => { scanInputRef.current?.focus() }, [])

  const filtered = useMemo(() => {
    const needle = search.trim().toLowerCase()
    if (!needle) return rows
    return rows.filter(r => r.name.toLowerCase().includes(needle) || r.batch_number.toLowerCase().includes(needle))
  }, [rows, search])

  // Adds a batch id straight to the cart -- used once a batch is known to
  // have only one active pack (nothing to ask about) or once the pack-
  // quantity prompt below has already been answered.
  function addToCart(batchId: string, productName: string, batchNumber: string, dosage: string | null, quantityAvailable: number) {
    setSelected(prev => new Set(prev).add(batchId))
    setRows(prev => prev.some(r => r.batch_id === batchId)
      ? prev
      : [...prev, {
          product_id: "", branch_id: "", product_type: "medicine", name: productName, tax_rate: "",
          variant_id: "", dosage: dosage ?? undefined, category: "", batch_id: batchId,
          batch_number: batchNumber, expiry_date: "", cost_price: 0, selling_price: 0, quantity_received: 0,
          received_at: "", supplier_name: "", quantity_available: quantityAvailable, barcode_status: "active", min_quantity: 0,
          stock_status: "ok",
        } as InventoryRow])
  }

  // The common "a batch was just scanned/picked, decide what happens next"
  // step for both the scanner and the checkbox list below: a batch with only
  // one active pack (the overwhelming majority of stock -- most medicines
  // were never split into individually-scannable packs to begin with) goes
  // straight into the cart exactly as before this feature existed; one with
  // several opens the "how many packs?" card instead of assuming "all of
  // them". count_active_batch_units() failing (network hiccup, or a batch id
  // scanned seconds after being fully consumed elsewhere) falls back to
  // "just add it" rather than blocking the whole scan on a side lookup.
  async function presentBatch(batchId: string, productName: string, batchNumber: string, dosage: string | null) {
    let max = 1
    try {
      max = await countActiveBatchUnits(batchId)
    } catch {
      max = 1
    }
    if (max > 1) {
      setPackError(null)
      setPackPrompt({ batchId, productName, batchNumber, dosage, max, qty: String(max) })
      return
    }
    addToCart(batchId, productName, batchNumber, dosage, max)
  }

  async function confirmPackPrompt() {
    if (!packPrompt) return
    const qty = Math.trunc(Number(packPrompt.qty))
    if (!Number.isFinite(qty) || qty < 1 || qty > packPrompt.max) {
      setPackError(t("organization.packQuantityInvalid", { max: packPrompt.max }))
      return
    }
    setPackBusy(true)
    setPackError(null)
    try {
      const resultId = await splitStockBatch(packPrompt.batchId, qty)
      addToCart(resultId, packPrompt.productName, packPrompt.batchNumber, packPrompt.dosage, qty)
      setPackPrompt(null)
    } catch (reason) {
      setPackError(errorMessage(reason, t("organization.packQuantityError")))
    } finally {
      setPackBusy(false)
      scanInputRef.current?.focus()
    }
  }

  async function toggleOn(row: InventoryRow) {
    await presentBatch(row.batch_id, row.name, row.batch_number, row.dosage ?? null)
  }

  function toggleOff(batchId: string) {
    setSelected(prev => {
      const next = new Set(prev)
      next.delete(batchId)
      return next
    })
  }

  // Scanning adds straight to the cart, the same as ticking a checkbox --
  // requested directly: as each item is scanned it should put itself in
  // the package immediately, with no extra click (unless it turns out to
  // need a pack quantity, see presentBatch above). Looks the scanned code
  // up against fromBranchId (scanBranchBatch, same read-only lookup_
  // barcode() the POS/receiving screens use) rather than the already-loaded
  // `rows`, so a batch received seconds ago -- not yet in this modal's own
  // snapshot -- still scans in correctly.
  async function submitScan() {
    const trimmed = scanCode.trim()
    setScanCode("")
    if (!trimmed) return
    try {
      const found = await scanBranchBatch(trimmed, fromBranchId)
      setScanError(null)
      await presentBatch(found.stockBatchId, found.productName, found.batchNumber, found.dosage)
    } catch (reason) {
      setScanError(reason instanceof Error ? reason.message : t("organization.transferScanError"))
    } finally {
      // Re-focus after every scan, not just once on mount -- a physical
      // barcode scanner types like a keyboard, straight into whatever
      // currently has focus. The newly-added row above changes this list's
      // height, and without this a second, third, ...scan's keystrokes can
      // land nowhere the instant focus drifts off this field, looking
      // exactly like "only the first product ever scans in".
      scanInputRef.current?.focus()
    }
  }

  async function submit() {
    if (!toBranchId) { setError(t("organization.transferDestinationRequired")); return }
    if (selected.size === 0) { setError(t("organization.transferNoBatchesSelected")); return }
    setBusy(true)
    setError(null)
    try {
      await requestStockTransfer(toBranchId, Array.from(selected), notes.trim() || undefined, fromBranchId)
      onRequested()
    } catch (reason) {
      setError(errorMessage(reason, t("organization.transferRequestError")))
      setBusy(false)
    }
  }

  if (!loading && destinationBranches.length === 0) {
    return (
      <Modal title={t("organization.requestTransferTitle")} onClose={onClose} width={480}>
        <div style={{ display: "flex", flexDirection: "column", gap: 12 }}>
          <p style={{ margin: 0, fontSize: 12, color: "var(--ink-muted)" }}>{t("organization.transferNoOtherBranches")}</p>
          <div style={{ display: "flex", justifyContent: "flex-end" }}>
            <Btn variant="secondary" onClick={onClose}>{t("organization.cancel")}</Btn>
          </div>
        </div>
      </Modal>
    )
  }

  return (
    <Modal title={t("organization.requestTransferTitle")} onClose={onClose} width={560}>
      <div style={{ display: "flex", flexDirection: "column", gap: 12 }}>
        <p style={{ margin: 0, fontSize: 11, color: "var(--ink-muted)" }}>{t("organization.requestTransferIntro")}</p>
        {error && <p style={{ margin: 0, fontSize: 11, color: "#dc2626" }}>{error}</p>}
        {packPrompt && (
          <PackQuantityCard
            prompt={packPrompt}
            hint={t("organization.packQuantityHint", { product: packPrompt.productName, max: packPrompt.max })}
            busy={packBusy}
            error={packError}
            onChange={qty => setPackPrompt(p => p && { ...p, qty })}
            onCancel={() => setPackPrompt(null)}
            onConfirm={() => void confirmPackPrompt()}
          />
        )}
        <div>
          <label style={labelStyle}>{t("organization.destinationBranchLabel")}</label>
          <select value={toBranchId} onChange={e => setToBranchId(e.target.value)} style={inputStyle}>
            {destinationBranches.map(b => <option key={b.branchId} value={b.branchId}>{b.name} -- {formatDistance(b.distanceKm, t)}</option>)}
          </select>
        </div>
        <div>
          <label style={labelStyle}>{t("organization.scanToAddLabel")}</label>
          <input
            ref={scanInputRef}
            value={scanCode}
            onChange={e => setScanCode(e.target.value)}
            onKeyDown={e => { if (e.key === "Enter") { e.preventDefault(); void submitScan() } }}
            placeholder={t("organization.scanToAddPlaceholder")}
            style={{ ...inputStyle, border: "1.5px solid var(--primary)" }}
          />
          {scanError && <p style={{ margin: "6px 0 0", fontSize: 11, color: "#dc2626" }}>{scanError}</p>}
        </div>
        <div>
          <label style={labelStyle}>{t("organization.pickBatchesLabel")}</label>
          <input value={search} onChange={e => setSearch(e.target.value)} placeholder={t("organization.pickBatchesSearchPlaceholder")} style={{ ...inputStyle, marginBottom: 8 }} />
          <div style={{ maxHeight: 220, overflowY: "auto", border: "1px solid var(--border)", borderRadius: 7 }}>
            {loading ? <p style={{ padding: 12, fontSize: 12, color: "var(--ink-muted)" }}>{t("organization.loading")}</p> : filtered.length === 0 ? (
              <p style={{ padding: 12, fontSize: 12, color: "var(--ink-muted)" }}>{t("organization.transferNoStock")}</p>
            ) : filtered.map(row => (
              <label key={row.batch_id} style={{ display: "flex", alignItems: "center", gap: 10, padding: "8px 10px", borderBottom: "1px solid var(--bg-alt)", cursor: "pointer", fontSize: 12 }}>
                <input type="checkbox" checked={selected.has(row.batch_id)} onChange={() => { if (selected.has(row.batch_id)) toggleOff(row.batch_id); else void toggleOn(row) }} />
                <div style={{ flex: 1 }}>
                  <div style={{ fontWeight: 600, color: "var(--ink)" }}>{row.name}</div>
                  <div style={{ color: "var(--ink-muted)", fontSize: 11 }}>{row.batch_number} · {row.quantity_available} {t("organization.transferUnitsAvailable")}</div>
                </div>
              </label>
            ))}
          </div>
        </div>
        <div>
          <label style={labelStyle}>{t("organization.transferNotesLabel")}</label>
          <input value={notes} onChange={e => setNotes(e.target.value)} style={inputStyle} />
        </div>
        <div style={{ display: "flex", justifyContent: "flex-end", gap: 8 }}>
          <Btn variant="ghost" onClick={onClose}>{t("organization.cancel")}</Btn>
          <Btn variant="primary" onClick={() => void submit()}>{busy ? t("organization.creating") : t("organization.requestTransferSubmit")}</Btn>
        </div>
      </div>
    </Modal>
  )
}

// One line of a stock request before it's actually submitted -- see
// RequestStockModal's own comment for why several of these can queue up
// before one submit.
interface StockNeedItem {
  productVariantId: string
  productName: string
  quantity: number
  isPack: boolean
}

// The pull side, opposite of RequestTransferModal above: "I'm short on X",
// not "I have spare X to send". No availability filter on the product
// picker -- the whole point is this branch may already be at zero of it.
// The requester picks ONE specific branch to ask -- this is a targeted
// request, not a broadcast. fromBranchId is the branch asking (same
// meaning as in RequestTransferModal).
//
// request_stock_from_branch() itself only ever takes one product at a time
// (one stock_need row per product, matching how the accept/deny/approve
// negotiation in lib/stockNeeds.ts already tracks each product's own trail
// independently) -- there is no bulk version of it server-side. So "request
// several products at once" is built here as a small cart: pick a product +
// quantity, "+ Add to list" queues it, and Submit fires one request_stock_
// from_branch() call per queued item in turn. A failure partway through
// still leaves everything before it truly submitted (each is its own real
// request already), so the error names how many went through rather than
// implying the whole thing needs retrying.
export function RequestStockModal({ destinationBranches, fromBranchId, onClose, onRequested }: {
  destinationBranches: BranchWithDistance[]; fromBranchId?: string; onClose: () => void; onRequested: () => void
}) {
  const { t } = useTranslation()
  const [targetBranchId, setTargetBranchId] = useState(destinationBranches[0]?.branchId ?? "")
  const [productVariantId, setProductVariantId] = useState("")
  const [dataset, setDataset] = useState<InventoryDataset>({ rows: [], barcodes: [], supplierUnits: [] })
  const [quantity, setQuantity] = useState("")
  const [items, setItems] = useState<StockNeedItem[]>([])
  const [notes, setNotes] = useState("")
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)

  useEffect(() => {
    if (!targetBranchId || !destinationBranches.some(b => b.branchId === targetBranchId)) {
      setTargetBranchId(destinationBranches[0]?.branchId ?? "")
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [destinationBranches])

  useEffect(() => {
    loadInventoryDataset(fromBranchId)
      .then(setDataset)
      .catch(reason => setError(errorMessage(reason, t("organization.transferLoadStockError"))))
      .finally(() => setLoading(false))
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [t, fromBranchId])

  const productOptions = useMemo(() => {
    const seen = new Set<string>()
    const options: Array<{ value: string; label: string }> = []
    for (const row of dataset.rows) {
      if (seen.has(row.variant_id)) continue
      seen.add(row.variant_id)
      options.push({ value: row.variant_id, label: [row.name, row.dosage].filter(Boolean).join(" ") })
    }
    return options
  }, [dataset.rows])

  // "This medicine is normally handled in packs" -- true when any batch this
  // branch has ever received for the picked variant was split into more than
  // one individually-scannable pack barcode, regardless of whether that
  // particular batch is still in stock right now. Same definition of
  // "packs" as RequestTransferModal's count_active_batch_units() (a count of
  // pack barcode ROWS, not each one's own pieces_per_pack -- "10 packs" in
  // the disposable SCANTEST10PACK test batch means 10 separate pack
  // barcodes each with pieces_per_pack 1, not one barcode holding 10) --
  // just computed from the already-loaded dataset instead of a per-batch
  // RPC call, since there is no specific batch here to ask about (the
  // target branch's stock isn't this branch's to look at), only "does this
  // product usually come in packs".
  const selectedProduct = useMemo(() => dataset.rows.find(r => r.variant_id === productVariantId) ?? null, [dataset.rows, productVariantId])
  const isPackProduct = useMemo(() => {
    if (!productVariantId) return false
    const batchIds = new Set(dataset.rows.filter(r => r.variant_id === productVariantId).map(r => r.batch_id))
    const packCounts = new Map<string, number>()
    for (const bc of dataset.barcodes) {
      if (!batchIds.has(bc.stock_batch_id) || bc.barcode_type !== "pack") continue
      packCounts.set(bc.stock_batch_id, (packCounts.get(bc.stock_batch_id) ?? 0) + 1)
    }
    return Array.from(packCounts.values()).some(count => count > 1)
  }, [dataset, productVariantId])

  function addItem() {
    if (!productVariantId) { setError(t("organization.stockNeedProductRequired")); return }
    if (items.some(i => i.productVariantId === productVariantId)) { setError(t("organization.stockNeedDuplicateItem")); return }
    const qty = Number(quantity)
    if (!Number.isFinite(qty) || qty < 1) { setError(t("organization.stockNeedQuantityInvalid")); return }
    setError(null)
    setItems(prev => [...prev, {
      productVariantId,
      productName: [selectedProduct?.name, selectedProduct?.dosage].filter(Boolean).join(" ") || productVariantId,
      quantity: qty, isPack: isPackProduct,
    }])
    setProductVariantId("")
    setQuantity("")
  }

  function removeItem(variantId: string) {
    setItems(prev => prev.filter(i => i.productVariantId !== variantId))
  }

  async function submit() {
    if (!targetBranchId) { setError(t("organization.stockNeedBranchRequired")); return }
    if (items.length === 0) { setError(t("organization.stockNeedNoItems")); return }
    setBusy(true)
    setError(null)
    let done = 0
    try {
      for (const item of items) {
        await requestStockFromBranch(targetBranchId, item.productVariantId, item.quantity, notes.trim() || undefined, fromBranchId)
        done += 1
      }
      onRequested()
    } catch (reason) {
      setError(done === 0
        ? errorMessage(reason, t("organization.stockNeedRequestError"))
        : t("organization.stockNeedPartialError", { done, total: items.length, error: errorMessage(reason, t("organization.stockNeedRequestError")) }))
      setBusy(false)
    }
  }

  return (
    <Modal title={t("organization.requestStockTitle")} onClose={onClose} width={480}>
      <div style={{ display: "flex", flexDirection: "column", gap: 12 }}>
        <p style={{ margin: 0, fontSize: 11, color: "var(--ink-muted)" }}>{t("organization.requestStockIntro")}</p>
        {error && <p style={{ margin: 0, fontSize: 11, color: "#dc2626" }}>{error}</p>}
        <div>
          <label style={labelStyle}>{t("organization.stockNeedBranchLabel")}</label>
          {/* Nearest first -- see destinationBranches' own comment at each
              caller for how distance is computed and why an unknown one
              still sorts last rather than being hidden. */}
          <select value={targetBranchId} onChange={e => setTargetBranchId(e.target.value)} style={inputStyle}>
            {destinationBranches.map(b => <option key={b.branchId} value={b.branchId}>{b.name} -- {formatDistance(b.distanceKm, t)}</option>)}
          </select>
        </div>
        {items.length > 0 && (
          <div>
            <label style={labelStyle}>{t("organization.stockNeedItemsLabel")}</label>
            <div style={{ display: "flex", flexDirection: "column", gap: 6, border: "1px solid var(--border)", borderRadius: 7, padding: 8 }}>
              {items.map(item => (
                <div key={item.productVariantId} style={{ display: "flex", alignItems: "center", justifyContent: "space-between", gap: 8, fontSize: 12 }}>
                  <span style={{ color: "var(--ink)" }}>{item.productName}</span>
                  <span style={{ display: "flex", alignItems: "center", gap: 8 }}>
                    <span style={{ color: "var(--ink-muted)" }}>{item.quantity} {item.isPack ? t("organization.stockNeedPacksLabel").toLowerCase() : ""}</span>
                    <Btn variant="ghost" small onClick={() => removeItem(item.productVariantId)}>{t("organization.remove")}</Btn>
                  </span>
                </div>
              ))}
            </div>
          </div>
        )}
        <div>
          <label style={labelStyle}>{t("organization.stockNeedProductLabel")}</label>
          <select value={productVariantId} onChange={e => setProductVariantId(e.target.value)} style={inputStyle} disabled={loading}>
            <option value="">{loading ? t("organization.loading") : t("organization.stockNeedProductPlaceholder")}</option>
            {productOptions.map(o => <option key={o.value} value={o.value}>{o.label}</option>)}
          </select>
        </div>
        <div>
          <label style={labelStyle}>{isPackProduct ? t("organization.stockNeedPacksLabel") : t("organization.stockNeedQuantityLabel")}</label>
          {isPackProduct && (
            <p style={{ margin: "0 0 6px", fontSize: 11, color: "var(--ink-muted)" }}>
              {t("organization.packQuantityHintRequest", { product: selectedProduct?.name ?? "" })}
            </p>
          )}
          <input type="number" min={1} value={quantity} onChange={e => setQuantity(e.target.value)} style={inputStyle} />
        </div>
        <div style={{ display: "flex", justifyContent: "flex-end" }}>
          <Btn variant="secondary" small onClick={addItem}>{t("organization.stockNeedAddItem")}</Btn>
        </div>
        <div>
          <label style={labelStyle}>{t("organization.transferNotesLabel")}</label>
          <input value={notes} onChange={e => setNotes(e.target.value)} style={inputStyle} />
        </div>
        <div style={{ display: "flex", justifyContent: "flex-end", gap: 8 }}>
          <Btn variant="ghost" onClick={onClose}>{t("organization.cancel")}</Btn>
          <Btn variant="primary" onClick={() => void submit()}>{busy ? t("organization.creating") : t("organization.requestStockSubmit")}</Btn>
        </div>
      </div>
    </Modal>
  )
}
