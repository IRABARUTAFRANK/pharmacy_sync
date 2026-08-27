import { useCallback, useEffect, useMemo, useRef, useState, type CSSProperties, type ReactNode } from "react"
import { Btn, Card, CenterAlert, Modal, SearchSelect, StatusBadge, BarcodeLabelSheet, type ComboOption, type PrintableBarcode } from "../components"
import { fmtRWFExact } from "../data"
import { useTranslation } from "../lib/i18n"
import {
  loadProductDefaults,
  loadReceivingReference,
  receiveStockDelivery,
  type DeliveryLine,
  type DeliveryReceipt,
  type ReceivingReference,
} from "../lib/receiving"
import { loadDeliveryBarcodes, type DeliveryBarcodeLabel } from "../lib/barcodes"
import { errorMessage } from "../lib/supabase"
import {
  listMyProductRequests,
  productRequestImageUrl,
  submitProductRequest,
  uploadProductRequestImage,
  type ProductRequestRow,
} from "../lib/products"

type Packaging = "simple" | "cartons"

interface LineForm {
  key: string
  productId: string
  variantId: string
  categoryName: string
  manufacturer: string
  batchNumber: string
  expiryDate: string
  costPrice: string
  sellingPrice: string
  packaging: Packaging
  cartons: string
  packs: string
  piecesPerPack: string
}

let lineSequence = 0
const blankLine = (): LineForm => ({
  key: `line-${(lineSequence += 1)}`,
  productId: "", variantId: "", categoryName: "", manufacturer: "", batchNumber: "", expiryDate: "",
  costPrice: "", sellingPrice: "", packaging: "simple", cartons: "1", packs: "1", piecesPerPack: "1",
})

const toInt = (value: string, fallback = 0) => {
  const parsed = Number.parseInt(value, 10)
  return Number.isFinite(parsed) ? parsed : fallback
}
const toMoney = (value: string) => {
  const parsed = Number.parseFloat(value)
  return Number.isFinite(parsed) ? parsed : Number.NaN
}

// Mirrors the RPC's own arithmetic: cartons × packs × pieces, or packs × pieces.
// quantity_received is never sent from the client — the server derives it.
const piecesFor = (line: LineForm) => {
  const packs = Math.max(toInt(line.packs), 0)
  const pieces = Math.max(toInt(line.piecesPerPack), 0)
  const cartons = Math.max(toInt(line.cartons), 0)
  return line.packaging === "cartons" ? cartons * packs * pieces : packs * pieces
}
const boxBarcodesFor = (line: LineForm) => (line.packaging === "cartons" ? Math.max(toInt(line.cartons), 0) : 0)
const packBarcodesFor = (line: LineForm) => {
  const packs = Math.max(toInt(line.packs), 0)
  return line.packaging === "cartons" ? Math.max(toInt(line.cartons), 0) * packs : packs
}

const inputStyle: CSSProperties = {
  width: "100%", padding: "9px 10px", border: "1px solid var(--border)", borderRadius: 7,
  font: "inherit", boxSizing: "border-box", background: "#fff", color: "var(--ink)",
}

function Field({ label, hint, children }: { label: string; hint?: string; children: ReactNode }) {
  return <div>
    <div style={{ fontSize: 11, fontWeight: 600, color: "var(--ink-mid)", marginBottom: 4 }}>{label}</div>
    {children}
    {hint && <div style={{ marginTop: 3, fontSize: 10, color: "var(--ink-muted)" }}>{hint}</div>}
  </div>
}

function Toggle<T extends string>({ value, options, onChange }: { value: T; options: Array<{ id: T; label: string }>; onChange: (next: T) => void }) {
  return <div style={{ display: "inline-flex", background: "var(--bg)", border: "1px solid var(--border)", borderRadius: 8, padding: 3, gap: 3 }}>
    {options.map(option => <button
      key={option.id}
      type="button"
      onClick={() => onChange(option.id)}
      style={{
        padding: "6px 13px", borderRadius: 6, border: "none", cursor: "pointer", fontFamily: "inherit",
        fontSize: 12, fontWeight: value === option.id ? 700 : 500,
        background: value === option.id ? "#fff" : "transparent",
        color: value === option.id ? "var(--primary)" : "var(--ink-muted)",
        boxShadow: value === option.id ? "0 1px 3px rgba(0,0,0,0.08)" : "none",
        transition: "all 0.15s",
      }}
    >{option.label}</button>)}
  </div>
}

// react-barcode/print layout lives in src/components.tsx (BarcodeLabel /
// BarcodeLabelSheet), shared with BarcodeManagerPage's individual/bulk
// reprints. deliveryLabelsToPrintable() below just adapts this page's own
// DeliveryBarcodeLabel shape (from loadDeliveryBarcodes()) to that shared
// PrintableBarcode shape, adding price.
function deliveryLabelsToPrintable(labels: DeliveryBarcodeLabel[]): PrintableBarcode[] {
  return labels.map(label => ({
    id: label.id, code: label.code, barcode_type: label.barcode_type,
    product_name: label.product_name, variant_label: label.variant_label,
    child_count: label.child_count, pieces_per_pack: label.pieces_per_pack,
    price: label.selling_price,
  }))
}

// Deliberately just a message + an optional photo -- not a structured form.
// The branch describes what's missing in their own words; the super admin
// turns it into a real catalogue entry (name, variants, tax) when approving.
function RequestProductModal({ onClose, onSubmitted }: { onClose: () => void; onSubmitted: () => void }) {
  const { t } = useTranslation()
  const [message, setMessage] = useState("")
  const [file, setFile] = useState<File | null>(null)
  const [preview, setPreview] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)

  function pickFile(f: File | null) {
    setFile(f)
    setPreview(f ? URL.createObjectURL(f) : null)
  }

  async function submit() {
    if (!message.trim()) { setError(t("requestProduct.describeRequired")); return }
    setBusy(true)
    setError(null)
    try {
      const imagePath = file ? await uploadProductRequestImage(file) : undefined
      await submitProductRequest(message.trim(), imagePath)
      onSubmitted()
    } catch (reason) {
      setError(errorMessage(reason, t("requestProduct.submitError")))
    } finally {
      setBusy(false)
    }
  }

  return <Modal title={t("receiving.requestModalTitle")} onClose={onClose} width={480}>
    <div style={{ display: "flex", flexDirection: "column", gap: 12 }}>
      <p style={{ margin: 0, fontSize: 11, color: "var(--ink-muted)" }}>
        {t("receiving.requestModalIntro")}
      </p>
      {error && <p style={{ margin: 0, fontSize: 12, color: "#dc2626" }}>{error}</p>}
      <div>
        <label style={{ fontSize: 11, fontWeight: 600, color: "var(--ink-mid)", display: "block", marginBottom: 4 }}>{t("requestProduct.describeLabel")}</label>
        <textarea
          value={message} onChange={event => setMessage(event.target.value)} rows={5}
          placeholder={t("requestProduct.describePlaceholder")}
          style={{ ...inputStyle, resize: "vertical" }}
        />
      </div>
      <div>
        <label style={{ fontSize: 11, fontWeight: 600, color: "var(--ink-mid)", display: "block", marginBottom: 4 }}>{t("requestProduct.photoLabel")}</label>
        <input type="file" accept="image/*" onChange={event => pickFile(event.target.files?.[0] ?? null)} style={{ fontSize: 12 }} />
        {preview && <img src={preview} alt={t("requestProduct.photoPreviewAlt")} style={{ marginTop: 8, maxWidth: "100%", maxHeight: 160, borderRadius: 8, border: "1px solid var(--border)" }} />}
      </div>
      <div style={{ display: "flex", justifyContent: "flex-end", gap: 8, marginTop: 4 }}>
        <Btn variant="ghost" onClick={onClose}>{t("receiving.cancelAction")}</Btn>
        <Btn variant="primary" onClick={() => void submit()} style={busy ? { opacity: 0.6, pointerEvents: "none" } : undefined}>{busy ? t("requestProduct.sending") : t("requestProduct.sendButton")}</Btn>
      </div>
    </div>
  </Modal>
}

// Every product request this branch has filed. Once approved, the product
// is simply selectable under "Product" below on the next delivery -- there
// is no separate "finish" step.
function MyRequestsPanel({ requests, loading }: { requests: ProductRequestRow[]; loading: boolean }) {
  const { t } = useTranslation()
  const requestStatusMeta: Record<ProductRequestRow["status"], { label: string; color: string; bg: string }> = {
    pending: { label: t("requestProduct.statusPending"), color: "#b45309", bg: "#fef3c7" },
    approved: { label: t("requestProduct.statusApproved"), color: "#16a34a", bg: "#dcfce7" },
    rejected: { label: t("requestProduct.statusRejected"), color: "#b91c1c", bg: "#fef2f2" },
  }
  if (!loading && requests.length === 0) return null
  return <Card>
    <div style={{ marginBottom: 10 }}>
      <h2 style={{ margin: 0, fontSize: 14 }}>{t("receiving.myRequestsTitle")}</h2>
      <p style={{ margin: "3px 0 0", fontSize: 11, color: "var(--ink-muted)" }}>{t("receiving.myRequestsSubtitle")}</p>
    </div>
    {loading ? <p style={{ fontSize: 11, color: "var(--ink-muted)" }}>{t("receiving.loading")}</p> : (
      <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
        {requests.map(request => {
          const meta = requestStatusMeta[request.status]
          return <div key={request.id} style={{ display: "flex", alignItems: "center", gap: 10, border: "1px solid var(--border)", borderRadius: 9, padding: "8px 12px", flexWrap: "wrap" }}>
            {request.image_path && (
              <img src={productRequestImageUrl(request.image_path)} alt="" style={{ width: 40, height: 40, objectFit: "cover", borderRadius: 6, flexShrink: 0 }} />
            )}
            <div style={{ flex: 1, minWidth: 160 }}>
              <div style={{ fontSize: 12, color: "var(--ink)", lineHeight: 1.4 }}>{request.message}</div>
              {request.status === "rejected" && request.rejection_reason && (
                <div style={{ fontSize: 10, color: "#b91c1c", marginTop: 2 }}>{t("requestProduct.reasonPrefix")}: {request.rejection_reason}</div>
              )}
            </div>
            <StatusBadge label={meta.label} color={meta.color} bg={meta.bg} />
          </div>
        })}
      </div>
    )}
  </Card>
}

export default function StockReceivingPage() {
  const { t } = useTranslation()
  const variantLabel = (variant: { dosage: string | null; form: string | null; unit: string | null }) =>
    [variant.dosage, variant.form, variant.unit].filter(Boolean).join(" · ") || t("receiving.variantStandardFallback")

  const [reference, setReference] = useState<ReceivingReference>({ products: [], variants: [], categories: [], suppliers: [] })
  const [loading, setLoading] = useState(true)
  const [loadError, setLoadError] = useState<string | null>(null)
  const [submitError, setSubmitError] = useState<string | null>(null)
  const [submitting, setSubmitting] = useState(false)
  const [receipt, setReceipt] = useState<DeliveryReceipt | null>(null)
  const [barcodeLabels, setBarcodeLabels] = useState<DeliveryBarcodeLabel[]>([])
  const [labelsLoading, setLabelsLoading] = useState(false)
  const [labelsError, setLabelsError] = useState<string | null>(null)

  const [myRequests, setMyRequests] = useState<ProductRequestRow[]>([])
  const [requestsLoading, setRequestsLoading] = useState(true)
  const [showRequestModal, setShowRequestModal] = useState(false)

  const [supplier, setSupplier] = useState("")
  const [notes, setNotes] = useState("")
  const [lines, setLines] = useState<LineForm[]>([blankLine()])
  const [index, setIndex] = useState(0)
  const [motion, setMotion] = useState("slide-in-right")
  const timer = useRef<number | null>(null)
  const [addingCategory, setAddingCategory] = useState(false)
  const [newCategoryDraft, setNewCategoryDraft] = useState("")

  // Closing this mini-form when the visible line changes avoids it lingering
  // open (mid-draft, for a different product) after switching slides.
  useEffect(() => { setAddingCategory(false); setNewCategoryDraft("") }, [index])

  const refresh = useCallback(async () => {
    setLoading(true)
    setLoadError(null)
    try {
      setReference(await loadReceivingReference())
    } catch (reason) {
      setLoadError(errorMessage(reason, t("receiving.loadError")))
    } finally {
      setLoading(false)
    }
  }, [t])

  const refreshRequests = useCallback(async () => {
    setRequestsLoading(true)
    try {
      setMyRequests(await listMyProductRequests())
    } catch {
      // Best-effort panel -- the receiving wizard itself still works without it.
    } finally {
      setRequestsLoading(false)
    }
  }, [])

  useEffect(() => { void refresh() }, [refresh])
  useEffect(() => { void refreshRequests() }, [refreshRequests])
  useEffect(() => () => { if (timer.current) window.clearTimeout(timer.current) }, [])

  const safeIndex = Math.min(index, lines.length - 1)
  const line = lines[safeIndex]

  const variantsFor = useCallback(
    (productId: string) => reference.variants.filter(variant => variant.product_id === productId),
    [reference.variants],
  )

  const problemsFor = useCallback((candidate: LineForm) => {
    const problems: string[] = []
    if (!candidate.productId) problems.push(t("receiving.problemProduct"))
    // A product with zero variants can no longer be received here -- the
    // server no longer creates variants inline. The admin adds a variant
    // when approving a product request.
    else if (!candidate.variantId) problems.push(t("receiving.problemVariant"))
    if (!candidate.categoryName.trim()) problems.push(t("receiving.problemCategory"))
    if (!candidate.batchNumber.trim()) problems.push(t("receiving.problemBatchNumber"))
    if (!candidate.expiryDate) problems.push(t("receiving.problemExpiryDate"))
    if (!(toMoney(candidate.costPrice) >= 0)) problems.push(t("receiving.problemCostPrice"))
    if (!(toMoney(candidate.sellingPrice) >= 0)) problems.push(t("receiving.problemSellingPrice"))
    if (toInt(candidate.packs) < 1) problems.push(t("receiving.problemMinPacks"))
    if (toInt(candidate.piecesPerPack) < 1) problems.push(t("receiving.problemMinPieces"))
    if (candidate.packaging === "cartons" && toInt(candidate.cartons) < 1) problems.push(t("receiving.problemMinCartons"))
    return problems
  }, [t])

  const buildLine = useCallback((candidate: LineForm): DeliveryLine => {
    const packs = Math.max(toInt(candidate.packs, 1), 1)
    const payload: DeliveryLine = {
      product_variant_id: candidate.variantId,
      batch_number: candidate.batchNumber.trim(),
      expiry_date: candidate.expiryDate,
      cost_price: toMoney(candidate.costPrice),
      selling_price: toMoney(candidate.sellingPrice),
      pieces_per_pack: Math.max(toInt(candidate.piecesPerPack, 1), 1),
      manufacturer_name: candidate.manufacturer.trim() || undefined,
      category_name: candidate.categoryName.trim() || undefined,
    }
    if (candidate.packaging === "cartons") {
      payload.cartons = Math.max(toInt(candidate.cartons, 1), 1)
      payload.packs_per_carton = packs
    } else {
      payload.packs = packs
    }
    return payload
  }, [])

  const updateLine = (patch: Partial<LineForm>) =>
    setLines(current => current.map((item, position) => (position === safeIndex ? { ...item, ...patch } : item)))

  // A category made here goes through the exact same category_name field the
  // search box's own "+ New category" option already uses -- receive_stock_delivery()
  // only ever creates it scoped to this branch, so there is nothing else to wire
  // for it to stay private; this is purely a more discoverable entry point to the
  // same mechanism, not a second one.
  function confirmNewCategory() {
    const name = newCategoryDraft.trim()
    if (!name) return
    updateLine({ categoryName: name })
    setAddingCategory(false)
    setNewCategoryDraft("")
  }

  // Convenience prefill once a known product (and, if it has one, its variant)
  // is picked — manufacturer, prices, packaging, and the product's one locked
  // category, all from how this product was last received. Never touches
  // supplier: a product isn't tied to one supplier, so that stays whatever the
  // pharmacist already has for this delivery. Best-effort: a failed lookup just
  // leaves the fields blank for manual entry, same as before this existed.
  async function applyProductDefaults(productId: string, variantId: string) {
    if (!productId) return
    try {
      const defaults = await loadProductDefaults(productId, variantId)
      updateLine({
        ...(defaults.categoryName ? { categoryName: defaults.categoryName } : {}),
        ...(defaults.manufacturer ? { manufacturer: defaults.manufacturer } : {}),
        ...(defaults.costPrice != null ? { costPrice: String(defaults.costPrice) } : {}),
        ...(defaults.sellingPrice != null ? { sellingPrice: String(defaults.sellingPrice) } : {}),
        ...(defaults.piecesPerPack != null ? { packaging: defaults.packaging, piecesPerPack: String(defaults.piecesPerPack) } : {}),
        ...(defaults.cartons != null ? { cartons: String(defaults.cartons) } : {}),
        ...(defaults.packsPerCarton != null ? { packs: String(defaults.packsPerCarton) } : {}),
      })
    } catch (reason) {
      // Convenience only -- the pharmacist can still fill everything by hand.
      // But silently swallowing this made a real failure indistinguishable
      // from "nothing to prefill", so at minimum this must be visible.
      console.error("Could not prefill from this product's history:", errorMessage(reason))
    }
  }

  function transition(direction: "next" | "prev", apply: () => void) {
    if (timer.current) window.clearTimeout(timer.current)
    setMotion(direction === "next" ? "slide-out-left" : "slide-out-right")
    timer.current = window.setTimeout(() => {
      apply()
      setMotion(direction === "next" ? "slide-in-right" : "slide-in-left")
    }, 150)
  }

  function goTo(target: number) {
    if (target === safeIndex || target < 0 || target >= lines.length) return
    transition(target > safeIndex ? "next" : "prev", () => setIndex(target))
  }

  function addLine() {
    const nextIndex = lines.length
    transition("next", () => { setLines(current => [...current, blankLine()]); setIndex(nextIndex) })
  }

  function removeLine() {
    if (lines.length === 1) {
      setLines([blankLine()])
      setIndex(0)
      return
    }
    const removed = safeIndex
    const nextIndex = Math.max(0, Math.min(removed, lines.length - 2))
    transition("prev", () => { setLines(current => current.filter((_, position) => position !== removed)); setIndex(nextIndex) })
  }

  function startNewDelivery() {
    setReceipt(null)
    setSubmitError(null)
    setSupplier("")
    setNotes("")
    setLines([blankLine()])
    setIndex(0)
    setMotion("slide-in-right")
    setBarcodeLabels([])
    setLabelsError(null)
  }

  const productOptions = useMemo<ComboOption[]>(() => reference.products.map(product => ({
    value: product.id,
    label: product.name,
    hint: [product.generic_name, product.product_type].filter(Boolean).join(" · "),
  })), [reference.products])
  const categoryOptions = useMemo<ComboOption[]>(
    () => reference.categories.map(category => ({ value: category.name, label: category.name })),
    [reference.categories],
  )
  const supplierOptions = useMemo<ComboOption[]>(
    () => reference.suppliers.map(item => ({ value: item.supplier_name, label: item.supplier_name })),
    [reference.suppliers],
  )
  const lineVariants = variantsFor(line.productId)
  const variantOptions = useMemo<ComboOption[]>(
    () => lineVariants.map(variant => ({ value: variant.id, label: variantLabel(variant) })),
    [lineVariants],
  )
  const selectedProduct = reference.products.find(product => product.id === line.productId)
  const selectedProductTax = selectedProduct ? { name: selectedProduct.tax_rate_name, rate: selectedProduct.tax_rate_percentage } : null

  const totals = useMemo(() => lines.reduce((sum, item) => ({
    pieces: sum.pieces + piecesFor(item),
    boxes: sum.boxes + boxBarcodesFor(item),
    packs: sum.packs + packBarcodesFor(item),
    cost: sum.cost + (Number.isFinite(toMoney(item.costPrice)) ? toMoney(item.costPrice) * piecesFor(item) : 0),
  }), { pieces: 0, boxes: 0, packs: 0, cost: 0 }), [lines])

  const lineProblems = lines.map(problemsFor)
  const firstIncomplete = lineProblems.findIndex(problems => problems.length > 0)
  const disabledReason = submitting
    ? t("receiving.disabledSaving")
    : !supplier.trim()
      ? t("receiving.disabledSupplier")
      : firstIncomplete >= 0
        ? t("receiving.disabledLineIncomplete", { n: firstIncomplete + 1, list: lineProblems[firstIncomplete].join(", ") })
        : null

  async function submit() {
    setSubmitting(true)
    setSubmitError(null)
    try {
      const saved = await receiveStockDelivery(supplier.trim(), notes.trim(), lines.map(buildLine))
      setReceipt(saved)
      // Newly-received quantities and the supplier should show up in the
      // selectors straight away for the next delivery.
      void loadReceivingReference().then(setReference).catch(() => undefined)
      setLabelsLoading(true)
      setLabelsError(null)
      loadDeliveryBarcodes(saved.delivery_id)
        .then(setBarcodeLabels)
        .catch(reason => setLabelsError(errorMessage(reason)))
        .finally(() => setLabelsLoading(false))
    } catch (reason) {
      // receive_stock_delivery() raises human-readable exceptions (role, branch
      // status, missing fields). Surface them verbatim instead of a generic message.
      setSubmitError(errorMessage(reason))
    } finally {
      setSubmitting(false)
    }
  }

  if (receipt) {
    return <div className="animate-fade-in" style={{ maxWidth: 900, margin: "40px auto" }}>
      <Card style={{ textAlign: "center", padding: "34px 30px" }}>
        <div className="no-print" style={{ width: 52, height: 52, borderRadius: "50%", background: "#dcfce7", color: "#16a34a", display: "flex", alignItems: "center", justifyContent: "center", fontSize: 26, margin: "0 auto 14px" }}>✓</div>
        <h1 style={{ margin: 0, fontSize: 19, color: "var(--ink)" }}>{t("receiving.receiptTitle")}</h1>
        <p style={{ color: "var(--ink-muted)", fontSize: 12, margin: "8px 0 18px" }}>
          {t("receiving.receiptBody")}
        </p>
        <div style={{ background: "var(--bg)", border: "1px solid var(--border)", borderRadius: 10, padding: "14px 16px" }}>
          <div style={{ fontSize: 10, textTransform: "uppercase", letterSpacing: "0.07em", color: "var(--ink-muted)", fontWeight: 700 }}>{t("receiving.deliveryCodeLabel")}</div>
          <div style={{ fontFamily: "var(--font-mono)", fontSize: 18, fontWeight: 700, color: "var(--primary)", marginTop: 4 }}>{receipt.delivery_code}</div>
        </div>
        <div className="no-print" style={{ display: "flex", justifyContent: "center", gap: 10, marginTop: 20 }}>
          <Btn onClick={startNewDelivery}>{t("receiving.startNewDelivery")}</Btn>
        </div>
        <BarcodeLabelSheet title={t("barcodeManager.printDeliveryTitle", { code: receipt.delivery_code })} labels={deliveryLabelsToPrintable(barcodeLabels)} loading={labelsLoading} error={labelsError} />
      </Card>
    </div>
  }

  return <div className="animate-fade-in" style={{ maxWidth: 1000, margin: "0 auto", display: "flex", flexDirection: "column", gap: 14 }}>
    {loadError && <div style={{ background: "#fef2f2", color: "#b91c1c", border: "1px solid #fecaca", borderRadius: 10, padding: "12px 14px", fontSize: 12 }}>
      {t("receiving.catalogueLoadErrorPrefix")}: {loadError}. {t("receiving.catalogueLoadErrorHint")}
    </div>}
    {submitError && <div style={{ background: "#fef2f2", color: "#b91c1c", border: "1px solid #fecaca", borderRadius: 10, padding: "12px 14px", fontSize: 12 }}>
      <strong>{t("receiving.deliveryNotSaved")}</strong> {submitError}
    </div>}
    {submitError && <CenterAlert key={submitError} message={submitError} />}

    <MyRequestsPanel requests={myRequests} loading={requestsLoading} />

    <Card>
      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "flex-start", gap: 10, marginBottom: 14 }}>
        <div>
          <h1 style={{ margin: 0, fontSize: 17 }}>{t("receiving.heading")}</h1>
          <p style={{ color: "var(--ink-muted)", margin: "4px 0 0", fontSize: 11 }}>
            {t("receiving.headingSubtitle")}
          </p>
        </div>
        <Btn variant="secondary" small onClick={() => void refresh()}>{loading ? t("receiving.loading") : t("receiving.refreshCatalogue")}</Btn>
      </div>
      <div style={{ display: "grid", gridTemplateColumns: "minmax(0, 1fr) minmax(0, 1.4fr)", gap: 12 }}>
        <Field label={t("receiving.supplierLabel")} hint={t("receiving.supplierHint")}>
          <SearchSelect
            options={supplierOptions}
            value={supplier}
            onSelect={setSupplier}
            allowFreeText
            createLabel={t("receiving.newSupplierLabel")}
            placeholder={t("receiving.supplierPlaceholder")}
            invalid={!supplier.trim()}
            emptyMessage={t("receiving.noSuppliersYet")}
          />
        </Field>
        <Field label={t("receiving.notesLabel")}>
          <input value={notes} onChange={event => setNotes(event.target.value)} placeholder={t("receiving.notesPlaceholder")} style={inputStyle} />
        </Field>
      </div>
    </Card>

    {/* Live summary — visible for the whole wizard, not just at the end. */}
    <div style={{ background: "#fff", border: "1px solid var(--border)", borderRadius: 12, padding: "12px 16px", display: "flex", alignItems: "center", gap: 18, flexWrap: "wrap" }}>
      {[
        { label: t("receiving.statProductLines"), value: lines.length.toLocaleString() },
        { label: t("receiving.statTotalPieces"), value: totals.pieces.toLocaleString() },
        { label: t("receiving.statCartonBarcodes"), value: totals.boxes.toLocaleString() },
        { label: t("receiving.statPackBarcodes"), value: totals.packs.toLocaleString() },
        { label: t("receiving.statCostValue"), value: fmtRWFExact(totals.cost) },
      ].map((stat, i) => <div key={stat.label} className="animate-fade-up" style={{ animationDelay: `${i * 50}ms` }}>
        <div style={{ fontSize: 17, fontWeight: 800, color: "var(--primary)" }}>{stat.value}</div>
        <div style={{ fontSize: 10, color: "var(--ink-muted)", fontWeight: 600 }}>{stat.label}</div>
      </div>)}
      <div style={{ flex: 1, minWidth: 12 }} />
      <div style={{ display: "flex", gap: 5, flexWrap: "wrap", justifyContent: "flex-end" }}>
        {lines.map((item, position) => {
          const complete = lineProblems[position].length === 0
          const active = position === safeIndex
          return <button
            key={item.key}
            type="button"
            onClick={() => goTo(position)}
            title={complete ? t("receiving.lineDotComplete") : t("receiving.lineDotNeeds", { list: lineProblems[position].join(", ") })}
            style={{
              width: 28, height: 28, borderRadius: 8, cursor: "pointer", fontFamily: "inherit",
              fontSize: 11, fontWeight: 700, transition: "all 0.15s",
              border: `1.5px solid ${active ? "var(--primary)" : complete ? "#86efac" : "#fcd34d"}`,
              background: active ? "var(--primary)" : complete ? "#f0fdf4" : "#fffbeb",
              color: active ? "#fff" : complete ? "#16a34a" : "#d97706",
            }}
          >{position + 1}</button>
        })}
      </div>
    </div>

    {/* Slides — one product line at a time. overflow-x clip (not hidden) keeps the
        translateX animation from causing a horizontal scrollbar while still letting
        the combobox dropdowns overflow the card vertically. */}
    <div style={{ overflowX: "clip" }}>
      <div style={{ animation: `${motion} ${motion.startsWith("slide-out") ? 150 : 220}ms ease both` }}>
        <Card>
          <div style={{ marginBottom: 14 }}>
            <h2 style={{ margin: 0, fontSize: 14 }}>{t("receiving.productOfTotal", { current: safeIndex + 1, total: lines.length })}</h2>
            <p style={{ margin: "3px 0 0", fontSize: 11, color: "var(--ink-muted)" }}>
              {t("receiving.lineSummary", { pieces: piecesFor(line).toLocaleString(), boxes: boxBarcodesFor(line), packs: packBarcodesFor(line) })}
            </p>
          </div>

          <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 12 }}>
            <Field label={t("receiving.productFieldLabel")} hint={loading ? t("receiving.catalogueLoadingHint") : t("receiving.catalogueCountHint", { count: reference.products.length })}>
              <SearchSelect
                options={productOptions}
                value={line.productId}
                onSelect={productId => { updateLine({ productId, variantId: "" }); void applyProductDefaults(productId, "") }}
                placeholder={t("receiving.productSearchPlaceholder")}
                invalid={!line.productId}
                emptyMessage={t("receiving.noProductMatch")}
              />
              <button
                type="button"
                onClick={() => setShowRequestModal(true)}
                style={{ marginTop: 6, background: "none", border: "none", padding: 0, color: "var(--primary)", fontSize: 11, fontWeight: 600, cursor: "pointer", fontFamily: "inherit" }}
              >{t("receiving.requestLink")}</button>
            </Field>
            <Field
              label={t("receiving.variantFieldLabel")}
              hint={!line.productId
                ? t("receiving.variantHintNoProduct")
                : lineVariants.length === 0
                  ? t("receiving.variantHintNone")
                  : t("receiving.variantHintCount", { count: lineVariants.length })}
            >
              <SearchSelect
                options={variantOptions}
                value={line.variantId}
                onSelect={variantId => { updateLine({ variantId }); void applyProductDefaults(line.productId, variantId) }}
                disabled={!line.productId || lineVariants.length === 0}
                placeholder={!line.productId ? t("receiving.variantSearchPlaceholderNoProduct") : lineVariants.length === 0 ? t("receiving.variantSearchPlaceholderNone") : t("receiving.variantSearchPlaceholder")}
                invalid={!!line.productId && lineVariants.length > 0 && !line.variantId}
                emptyMessage={t("receiving.noVariantMatch")}
              />
            </Field>
            {selectedProductTax && (
              <div style={{ gridColumn: "1 / -1", fontSize: 11, color: "var(--ink-muted)", display: "flex", alignItems: "center", gap: 6 }}>
                <span style={{ fontWeight: 700, color: "var(--ink-mid)" }}>{t("receiving.taxLabel")}</span>
                <span style={{
                  padding: "2px 8px", borderRadius: 999, fontWeight: 700, fontSize: 10,
                  background: selectedProductTax.rate === 0 ? "#dcfce7" : "#fef3c7",
                  color: selectedProductTax.rate === 0 ? "#16a34a" : "#b45309",
                }}>
                  {selectedProductTax.name} {selectedProductTax.rate > 0 ? `(${selectedProductTax.rate}%)` : ""}
                </span>
                <span>{t("receiving.taxNotEditable")}</span>
              </div>
            )}
          </div>

          <div style={{ display: "grid", gridTemplateColumns: "repeat(3, 1fr)", gap: 12, marginTop: 12 }}>
            <Field label={t("receiving.categoryFieldLabel")} hint={t("receiving.categoryHint")}>
              <SearchSelect
                options={categoryOptions}
                value={line.categoryName}
                onSelect={categoryName => updateLine({ categoryName })}
                allowFreeText
                createLabel={t("receiving.newCategoryLabel")}
                placeholder={t("receiving.categorySearchPlaceholder")}
                emptyMessage={t("receiving.noCategoriesYet")}
                invalid={!line.categoryName.trim()}
              />
              {addingCategory ? (
                <div style={{ display: "flex", gap: 6, marginTop: 6 }}>
                  <input
                    autoFocus
                    value={newCategoryDraft}
                    onChange={event => setNewCategoryDraft(event.target.value)}
                    onKeyDown={event => {
                      if (event.key === "Enter") { event.preventDefault(); confirmNewCategory() }
                      if (event.key === "Escape") { setAddingCategory(false); setNewCategoryDraft("") }
                    }}
                    placeholder={t("receiving.newCategoryPlaceholder")}
                    style={{ ...inputStyle, flex: 1 }}
                  />
                  <Btn small onClick={confirmNewCategory}>{t("receiving.addAction")}</Btn>
                  <Btn small variant="ghost" onClick={() => { setAddingCategory(false); setNewCategoryDraft("") }}>{t("receiving.cancelAction")}</Btn>
                </div>
              ) : (
                <button
                  type="button"
                  onClick={() => setAddingCategory(true)}
                  style={{ marginTop: 6, background: "none", border: "none", padding: 0, color: "var(--primary)", fontSize: 11, fontWeight: 600, cursor: "pointer", fontFamily: "inherit" }}
                >{t("receiving.addNewCategoryLink")}</button>
              )}
            </Field>
            <Field label={t("receiving.manufacturerLabel")} hint={t("receiving.manufacturerHint")}>
              <input value={line.manufacturer} onChange={event => updateLine({ manufacturer: event.target.value })} style={inputStyle} />
            </Field>
            <Field label={t("receiving.batchNumberLabel")}>
              <input value={line.batchNumber} onChange={event => updateLine({ batchNumber: event.target.value })} placeholder={t("receiving.batchNumberPlaceholder")} style={{ ...inputStyle, borderColor: line.batchNumber.trim() ? "var(--border)" : "#fca5a5" }} />
            </Field>
            <Field label={t("receiving.expiryDateLabel")}>
              <input type="date" value={line.expiryDate} onChange={event => updateLine({ expiryDate: event.target.value })} style={{ ...inputStyle, borderColor: line.expiryDate ? "var(--border)" : "#fca5a5" }} />
            </Field>
            <Field label={t("receiving.costPriceLabel")}>
              <input type="number" min="0" step="0.01" value={line.costPrice} onChange={event => updateLine({ costPrice: event.target.value })} style={{ ...inputStyle, borderColor: toMoney(line.costPrice) >= 0 ? "var(--border)" : "#fca5a5" }} />
            </Field>
            <Field label={t("receiving.sellingPriceLabel")}>
              <input type="number" min="0" step="0.01" value={line.sellingPrice} onChange={event => updateLine({ sellingPrice: event.target.value })} style={{ ...inputStyle, borderColor: toMoney(line.sellingPrice) >= 0 ? "var(--border)" : "#fca5a5" }} />
            </Field>
          </div>

          <div style={{ marginTop: 14, padding: 14, borderRadius: 10, background: "var(--bg)", border: "1px solid var(--border)" }}>
            <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", gap: 10, marginBottom: 12, flexWrap: "wrap" }}>
              <div>
                <div style={{ fontSize: 12, fontWeight: 700 }}>{t("receiving.packagingTitle")}</div>
                <div style={{ fontSize: 10, color: "var(--ink-muted)" }}>{t("receiving.packagingSubtitle")}</div>
              </div>
              <Toggle
                value={line.packaging}
                onChange={packaging => updateLine({ packaging })}
                options={[{ id: "simple" as Packaging, label: t("receiving.packagingSimple") }, { id: "cartons" as Packaging, label: t("receiving.packagingCartons") }]}
              />
            </div>
            <div style={{ display: "grid", gridTemplateColumns: line.packaging === "cartons" ? "repeat(3, 1fr)" : "repeat(2, 1fr)", gap: 12 }}>
              {line.packaging === "cartons" && <Field label={t("receiving.cartonsReceivedLabel")}>
                <input type="number" min="1" value={line.cartons} onChange={event => updateLine({ cartons: event.target.value })} style={inputStyle} />
              </Field>}
              <Field label={line.packaging === "cartons" ? t("receiving.packsPerCartonLabel") : t("receiving.packsReceivedLabel")}>
                <input type="number" min="1" value={line.packs} onChange={event => updateLine({ packs: event.target.value })} style={inputStyle} />
              </Field>
              <Field label={t("receiving.piecesPerPackLabel")}>
                <input type="number" min="1" value={line.piecesPerPack} onChange={event => updateLine({ piecesPerPack: event.target.value })} style={inputStyle} />
              </Field>
            </div>
            <div style={{ marginTop: 10, fontSize: 11, color: "var(--ink-mid)" }}>
              {line.packaging === "cartons"
                ? t("receiving.lineTotalsCartons", { pieces: piecesFor(line).toLocaleString(), packs: Math.max(toInt(line.packs), 0) })
                : t("receiving.lineTotalsSimple", { pieces: piecesFor(line).toLocaleString() })}
            </div>
          </div>

          <div style={{ display: "flex", gap: 8, marginTop: 16, flexWrap: "wrap", alignItems: "center" }}>
            <Btn variant="ghost" small onClick={() => goTo(safeIndex - 1)} style={{ opacity: safeIndex === 0 ? 0.45 : 1 }}>{t("receiving.navPrevious")}</Btn>
            <Btn variant="ghost" small onClick={() => goTo(safeIndex + 1)} style={{ opacity: safeIndex >= lines.length - 1 ? 0.45 : 1 }}>{t("receiving.navNext")}</Btn>
            <Btn variant="secondary" small onClick={addLine}>{t("receiving.addAnotherProduct")}</Btn>
            <div style={{ flex: 1 }} />
            <Btn variant="danger" small onClick={removeLine}>{lines.length === 1 ? t("receiving.clearThisProduct") : t("receiving.removeThisProduct")}</Btn>
          </div>
        </Card>
      </div>
    </div>

    <div style={{ background: "#fff", border: "1px solid var(--border)", borderRadius: 12, padding: "14px 16px", display: "flex", alignItems: "center", gap: 14, flexWrap: "wrap" }}>
      <div style={{ flex: 1, minWidth: 220, fontSize: 11, color: disabledReason ? "#b45309" : "var(--ink-muted)" }}>
        {disabledReason ?? t("receiving.readyToSubmit", { count: lines.length, supplier: supplier.trim() })}
      </div>
      <button
        type="button"
        onClick={() => void submit()}
        disabled={!!disabledReason}
        style={{
          padding: "13px 26px", borderRadius: 10, border: "none", fontFamily: "inherit",
          fontSize: 14, fontWeight: 800, letterSpacing: "0.01em",
          color: "#fff", background: disabledReason ? "#9ca3af" : "#16a34a",
          cursor: disabledReason ? "not-allowed" : "pointer",
          boxShadow: disabledReason ? "none" : "0 6px 18px rgba(22,163,74,0.32)",
          transition: "all 0.15s",
        }}
      >{submitting ? t("receiving.generating") : t("receiving.generateBarcodes")}</button>
    </div>

    {showRequestModal && (
      <RequestProductModal
        onClose={() => setShowRequestModal(false)}
        onSubmitted={() => { setShowRequestModal(false); void refreshRequests() }}
      />
    )}
  </div>
}
