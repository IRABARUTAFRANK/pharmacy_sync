import { useEffect, useMemo, useRef, useState } from "react"
import { Btn, Modal } from "../components"
import { useTranslation } from "../lib/i18n"
import type { TranslationKey } from "../lib/i18n/en"
import { errorMessage } from "../lib/supabase"
import { loadInventoryDataset, type InventoryRow } from "../lib/inventory"
import { requestStockTransfer, scanBranchBatch } from "../lib/stockTransfers"
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

  function toggle(batchId: string) {
    setSelected(prev => {
      const next = new Set(prev)
      if (next.has(batchId)) next.delete(batchId); else next.add(batchId)
      return next
    })
  }

  // Scanning adds straight to the cart, the same as ticking a checkbox --
  // requested directly: as each item is scanned it should put itself in
  // the package immediately, with no extra click. Looks the scanned code
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
      setSelected(prev => new Set(prev).add(found.stockBatchId))
      setRows(prev => prev.some(r => r.batch_id === found.stockBatchId)
        ? prev
        : [...prev, {
            product_id: "", branch_id: "", product_type: "medicine", name: found.productName, tax_rate: "",
            variant_id: "", dosage: found.dosage ?? undefined, category: "", batch_id: found.stockBatchId,
            batch_number: found.batchNumber, expiry_date: "", cost_price: 0, selling_price: 0, quantity_received: 0,
            received_at: "", supplier_name: "", quantity_available: 1, barcode_status: "active", min_quantity: 0,
            stock_status: "ok",
          } as InventoryRow])
    } catch (reason) {
      setScanError(reason instanceof Error ? reason.message : t("organization.transferScanError"))
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
                <input type="checkbox" checked={selected.has(row.batch_id)} onChange={() => toggle(row.batch_id)} />
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

// The pull side, opposite of RequestTransferModal above: "I'm short on X",
// not "I have spare X to send". No availability filter on the product
// picker -- the whole point is this branch may already be at zero of it.
// The requester picks ONE specific branch to ask -- this is a targeted
// request, not a broadcast. fromBranchId is the branch asking (same
// meaning as in RequestTransferModal).
export function RequestStockModal({ destinationBranches, fromBranchId, onClose, onRequested }: {
  destinationBranches: BranchWithDistance[]; fromBranchId?: string; onClose: () => void; onRequested: () => void
}) {
  const { t } = useTranslation()
  const [targetBranchId, setTargetBranchId] = useState(destinationBranches[0]?.branchId ?? "")
  const [productVariantId, setProductVariantId] = useState("")
  const [rows, setRows] = useState<InventoryRow[]>([])
  const [quantity, setQuantity] = useState("")
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
      .then(dataset => setRows(dataset.rows))
      .catch(reason => setError(errorMessage(reason, t("organization.transferLoadStockError"))))
      .finally(() => setLoading(false))
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [t, fromBranchId])

  const productOptions = useMemo(() => {
    const seen = new Set<string>()
    const options: Array<{ value: string; label: string }> = []
    for (const row of rows) {
      if (seen.has(row.variant_id)) continue
      seen.add(row.variant_id)
      options.push({ value: row.variant_id, label: [row.name, row.dosage].filter(Boolean).join(" ") })
    }
    return options
  }, [rows])

  async function submit() {
    if (!targetBranchId) { setError(t("organization.stockNeedBranchRequired")); return }
    if (!productVariantId) { setError(t("organization.stockNeedProductRequired")); return }
    const qty = Number(quantity)
    if (!Number.isFinite(qty) || qty < 1) { setError(t("organization.stockNeedQuantityInvalid")); return }
    setBusy(true)
    setError(null)
    try {
      await requestStockFromBranch(targetBranchId, productVariantId, qty, notes.trim() || undefined, fromBranchId)
      onRequested()
    } catch (reason) {
      setError(errorMessage(reason, t("organization.stockNeedRequestError")))
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
        <div>
          <label style={labelStyle}>{t("organization.stockNeedProductLabel")}</label>
          <select value={productVariantId} onChange={e => setProductVariantId(e.target.value)} style={inputStyle} disabled={loading}>
            <option value="">{loading ? t("organization.loading") : t("organization.stockNeedProductPlaceholder")}</option>
            {productOptions.map(o => <option key={o.value} value={o.value}>{o.label}</option>)}
          </select>
        </div>
        <div>
          <label style={labelStyle}>{t("organization.stockNeedQuantityLabel")}</label>
          <input type="number" min={1} value={quantity} onChange={e => setQuantity(e.target.value)} style={inputStyle} />
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
