import { useCallback, useEffect, useMemo, useRef, useState, type CSSProperties, type ReactNode } from "react"
import Barcode from "react-barcode"
import { Btn, Card, CenterAlert, SearchSelect, type ComboOption } from "../components"
import { fmtRWF } from "../data"
import {
  loadProductDefaults,
  loadReceivingReference,
  receiveStockDelivery,
  type DeliveryLine,
  type DeliveryReceipt,
  type ProductType,
  type ReceivingReference,
} from "../lib/receiving"
import { loadDeliveryBarcodes, type DeliveryBarcodeLabel } from "../lib/barcodes"
import { errorMessage } from "../lib/supabase"

type Packaging = "simple" | "cartons"
type ProductMode = "known" | "new"

interface LineForm {
  key: string
  mode: ProductMode
  productId: string
  variantId: string
  productName: string
  productType: ProductType
  genericName: string
  dosage: string
  form: string
  unit: string
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
  mode: "known", productId: "", variantId: "",
  productName: "", productType: "medicine", genericName: "", dosage: "", form: "", unit: "",
  categoryName: "", manufacturer: "", batchNumber: "", expiryDate: "",
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

const variantLabel = (variant: { dosage: string | null; form: string | null; unit: string | null }) =>
  [variant.dosage, variant.form, variant.unit].filter(Boolean).join(" · ") || "Standard (no dosage or form recorded)"

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

// Fixed 4-per-row layout, not CSS Grid's auto-fill: percentage widths on a
// flex-wrap container lay out the same way in every browser's print engine,
// where Grid's page-break handling is inconsistent. The horizontal + bottom
// margin on every cell (not a parent `gap`) is what actually keeps adjacent
// barcodes from touching once a row breaks across a printed page boundary --
// gap alone can collapse right at that boundary in some engines.
const COLUMNS = 4
const CELL_MARGIN_PCT = 1
const CELL_WIDTH_PCT = 100 / COLUMNS - CELL_MARGIN_PCT * 2

// One printable label per barcode: box (carton) labels are visually distinct
// from pack labels since they represent different physical things (an outer
// carton vs. the individual small box you actually stick a code onto).
function BarcodeLabel({ label }: { label: DeliveryBarcodeLabel }) {
  const isBox = label.barcode_type === "box"
  return <div style={{
    width: `${CELL_WIDTH_PCT}%`, margin: `0 ${CELL_MARGIN_PCT}% 20px ${CELL_MARGIN_PCT}%`,
    boxSizing: "border-box", display: "flex", flexDirection: "column", alignItems: "center", gap: 3,
    breakInside: "avoid", pageBreakInside: "avoid",
  }}>
    <div style={{ fontSize: 9, fontWeight: 700, color: "var(--ink)", textAlign: "center", lineHeight: 1.25, maxWidth: "100%", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{label.product_name}</div>
    {label.variant_label && <div style={{ fontSize: 8, color: "var(--ink-muted)" }}>{label.variant_label}</div>}
    <Barcode value={label.code} width={1.2} height={36} fontSize={9} margin={2} background="transparent" lineColor="#0c1e12" displayValue />
    <div style={{ fontSize: 7, color: isBox ? "var(--primary)" : "var(--ink-muted)", textAlign: "center", fontWeight: isBox ? 700 : 400 }}>
      {isBox ? `Carton · ${label.child_count ?? 0} packs` : `Pack · ${label.pieces_per_pack ?? 0} pcs`}
    </div>
  </div>
}

function BarcodeSheet({ deliveryCode, labels, loading, error }: { deliveryCode: string; labels: DeliveryBarcodeLabel[]; loading: boolean; error: string | null }) {
  if (loading) return <p style={{ fontSize: 12, color: "var(--ink-muted)", textAlign: "center", marginTop: 16 }}>Loading barcode labels…</p>
  if (error) return <p style={{ fontSize: 12, color: "#b91c1c", textAlign: "center", marginTop: 16 }}>Could not load the barcode labels: {error}</p>
  if (labels.length === 0) return null

  return <div style={{ marginTop: 20 }}>
    <div className="no-print" style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 10 }}>
      <p style={{ fontSize: 11, color: "var(--ink-muted)", margin: 0 }}>
        {labels.length} barcode{labels.length === 1 ? "" : "s"} on one sheet, ready to print and cut apart.
      </p>
      <Btn variant="primary" small onClick={() => window.print()}>🖨 Print / Save as PDF</Btn>
    </div>
    <div className="no-print" style={{ fontSize: 10, color: "var(--ink-faint, #9ab8a0)", marginBottom: 10 }}>
      "Print" opens your browser's print dialog — choose "Save as PDF" there to download the sheet instead of printing it.
    </div>
    <div style={{ background: "#fff", border: "1px solid var(--border)", borderRadius: 10, padding: "14px 14px 0" }}>
      <div style={{ fontSize: 11, fontWeight: 700, color: "var(--ink)", marginBottom: 14 }}>Delivery {deliveryCode}</div>
      <div style={{ display: "flex", flexWrap: "wrap", justifyContent: "flex-start" }}>
        {labels.map(label => <BarcodeLabel key={label.id} label={label} />)}
      </div>
    </div>
  </div>
}

export default function StockReceivingPage() {
  const [reference, setReference] = useState<ReceivingReference>({ products: [], variants: [], categories: [], suppliers: [] })
  const [loading, setLoading] = useState(true)
  const [loadError, setLoadError] = useState<string | null>(null)
  const [submitError, setSubmitError] = useState<string | null>(null)
  const [submitting, setSubmitting] = useState(false)
  const [receipt, setReceipt] = useState<DeliveryReceipt | null>(null)
  const [barcodeLabels, setBarcodeLabels] = useState<DeliveryBarcodeLabel[]>([])
  const [labelsLoading, setLabelsLoading] = useState(false)
  const [labelsError, setLabelsError] = useState<string | null>(null)

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
      setLoadError(errorMessage(reason, "Unable to load the product catalogue from the database."))
    } finally {
      setLoading(false)
    }
  }, [])

  useEffect(() => { void refresh() }, [refresh])
  useEffect(() => () => { if (timer.current) window.clearTimeout(timer.current) }, [])

  const safeIndex = Math.min(index, lines.length - 1)
  const line = lines[safeIndex]

  const variantsFor = useCallback(
    (productId: string) => reference.variants.filter(variant => variant.product_id === productId),
    [reference.variants],
  )

  const problemsFor = useCallback((candidate: LineForm) => {
    const problems: string[] = []
    if (candidate.mode === "known") {
      if (!candidate.productId) problems.push("a product")
      else if (variantsFor(candidate.productId).length > 0 && !candidate.variantId) problems.push("a variant")
    } else if (!candidate.productName.trim()) {
      problems.push("a new product name")
    }
    if (!candidate.categoryName.trim()) problems.push("a product category")
    if (!candidate.batchNumber.trim()) problems.push("a batch number")
    if (!candidate.expiryDate) problems.push("an expiry date")
    if (!(toMoney(candidate.costPrice) >= 0)) problems.push("a cost price")
    if (!(toMoney(candidate.sellingPrice) >= 0)) problems.push("a selling price")
    if (toInt(candidate.packs) < 1) problems.push("at least 1 pack")
    if (toInt(candidate.piecesPerPack) < 1) problems.push("at least 1 piece per pack")
    if (candidate.packaging === "cartons" && toInt(candidate.cartons) < 1) problems.push("at least 1 carton")
    return problems
  }, [variantsFor])

  const buildLine = useCallback((candidate: LineForm): DeliveryLine => {
    const packs = Math.max(toInt(candidate.packs, 1), 1)
    const payload: DeliveryLine = {
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

    const product = reference.products.find(item => item.id === candidate.productId)
    if (candidate.mode === "known" && candidate.variantId) {
      payload.product_variant_id = candidate.variantId
    } else if (candidate.mode === "known" && product) {
      // The catalogue product exists but has no variant rows yet. Sending it down the
      // product_name path lets the RPC match the existing product by name and create
      // its first variant — it never creates a duplicate product row.
      payload.product_name = product.name
      payload.product_type = product.product_type
      payload.generic_name = product.generic_name ?? undefined
    } else {
      payload.product_name = candidate.productName.trim()
      payload.product_type = candidate.productType
      payload.generic_name = candidate.genericName.trim() || undefined
      payload.dosage = candidate.dosage.trim() || undefined
      payload.form = candidate.form.trim() || undefined
      payload.unit = candidate.unit.trim() || undefined
    }
    return payload
  }, [reference.products])

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

  const totals = useMemo(() => lines.reduce((sum, item) => ({
    pieces: sum.pieces + piecesFor(item),
    boxes: sum.boxes + boxBarcodesFor(item),
    packs: sum.packs + packBarcodesFor(item),
    cost: sum.cost + (Number.isFinite(toMoney(item.costPrice)) ? toMoney(item.costPrice) * piecesFor(item) : 0),
  }), { pieces: 0, boxes: 0, packs: 0, cost: 0 }), [lines])

  const lineProblems = lines.map(problemsFor)
  const firstIncomplete = lineProblems.findIndex(problems => problems.length > 0)
  const disabledReason = submitting
    ? "Saving the delivery…"
    : !supplier.trim()
      ? "Enter the supplier for this delivery"
      : firstIncomplete >= 0
        ? `Product ${firstIncomplete + 1} still needs ${lineProblems[firstIncomplete].join(", ")}`
        : null

  async function submit() {
    setSubmitting(true)
    setSubmitError(null)
    try {
      const saved = await receiveStockDelivery(supplier.trim(), notes.trim(), lines.map(buildLine))
      setReceipt(saved)
      // Newly created products, variants, categories and the supplier should show up
      // in the selectors straight away for the next delivery.
      void loadReceivingReference().then(setReference).catch(() => undefined)
      setLabelsLoading(true)
      setLabelsError(null)
      loadDeliveryBarcodes(saved.delivery_id)
        .then(setBarcodeLabels)
        .catch(reason => setLabelsError(errorMessage(reason)))
        .finally(() => setLabelsLoading(false))
    } catch (reason) {
      // receive_stock_delivery() raises human-readable exceptions (role, branch status,
      // missing fields). Surface them verbatim instead of a generic message.
      setSubmitError(errorMessage(reason))
    } finally {
      setSubmitting(false)
    }
  }

  if (receipt) {
    return <div style={{ maxWidth: 900, margin: "40px auto" }}>
      <Card style={{ textAlign: "center", padding: "34px 30px" }}>
        <div className="no-print" style={{ width: 52, height: 52, borderRadius: "50%", background: "#dcfce7", color: "#16a34a", display: "flex", alignItems: "center", justifyContent: "center", fontSize: 26, margin: "0 auto 14px" }}>✓</div>
        <h1 style={{ margin: 0, fontSize: 19, color: "var(--ink)" }}>Delivery received and barcodes generated</h1>
        <p style={{ color: "var(--ink-muted)", fontSize: 12, margin: "8px 0 18px" }}>
          The server created the delivery code below, one stock batch per product line, and the carton/pack barcode tree for each batch.
        </p>
        <div style={{ background: "var(--bg)", border: "1px solid var(--border)", borderRadius: 10, padding: "14px 16px" }}>
          <div style={{ fontSize: 10, textTransform: "uppercase", letterSpacing: "0.07em", color: "var(--ink-muted)", fontWeight: 700 }}>Delivery code</div>
          <div style={{ fontFamily: "JetBrains Mono, monospace", fontSize: 18, fontWeight: 700, color: "var(--primary)", marginTop: 4 }}>{receipt.delivery_code}</div>
        </div>
        <div className="no-print" style={{ display: "flex", justifyContent: "center", gap: 10, marginTop: 20 }}>
          <Btn onClick={startNewDelivery}>Start a new delivery</Btn>
        </div>
        <BarcodeSheet deliveryCode={receipt.delivery_code} labels={barcodeLabels} loading={labelsLoading} error={labelsError} />
      </Card>
    </div>
  }

  return <div style={{ maxWidth: 1000, margin: "0 auto", display: "flex", flexDirection: "column", gap: 14 }}>
    {loadError && <div style={{ background: "#fef2f2", color: "#b91c1c", border: "1px solid #fecaca", borderRadius: 10, padding: "12px 14px", fontSize: 12 }}>
      Could not load the product catalogue: {loadError}. Sign in with a provisioned pharmacy account and confirm its branch permissions, then try again.
    </div>}
    {submitError && <div style={{ background: "#fef2f2", color: "#b91c1c", border: "1px solid #fecaca", borderRadius: 10, padding: "12px 14px", fontSize: 12 }}>
      <strong>The delivery was not saved.</strong> {submitError}
    </div>}
    {submitError && <CenterAlert key={submitError} message={submitError} />}

    <Card>
      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "flex-start", gap: 10, marginBottom: 14 }}>
        <div>
          <h1 style={{ margin: 0, fontSize: 17 }}>Receive delivery</h1>
          <p style={{ color: "var(--ink-muted)", margin: "4px 0 0", fontSize: 11 }}>
            One supplier per delivery. Each product below becomes its own stock batch with its own barcode tree. Live data from Supabase — no demo records.
          </p>
        </div>
        <Btn variant="secondary" small onClick={() => void refresh()}>{loading ? "Loading…" : "Refresh catalogue"}</Btn>
      </div>
      <div style={{ display: "grid", gridTemplateColumns: "minmax(0, 1fr) minmax(0, 1.4fr)", gap: 12 }}>
        <Field label="Supplier" hint="Type a new name to register it for this branch — the server creates it on save.">
          <SearchSelect
            options={supplierOptions}
            value={supplier}
            onSelect={setSupplier}
            allowFreeText
            createLabel="New supplier"
            placeholder="Search or type a supplier name…"
            invalid={!supplier.trim()}
            emptyMessage="No suppliers saved yet — type the name to create one."
          />
        </Field>
        <Field label="Delivery notes (optional)">
          <input value={notes} onChange={event => setNotes(event.target.value)} placeholder="Waybill reference, condition on arrival…" style={inputStyle} />
        </Field>
      </div>
    </Card>

    {/* Live summary — visible for the whole wizard, not just at the end. */}
    <div style={{ background: "#fff", border: "1px solid var(--border)", borderRadius: 12, padding: "12px 16px", display: "flex", alignItems: "center", gap: 18, flexWrap: "wrap" }}>
      {[
        { label: "Product lines", value: lines.length.toLocaleString() },
        { label: "Total pieces", value: totals.pieces.toLocaleString() },
        { label: "Carton barcodes", value: totals.boxes.toLocaleString() },
        { label: "Pack barcodes", value: totals.packs.toLocaleString() },
        { label: "Cost value", value: fmtRWF(totals.cost) },
      ].map(stat => <div key={stat.label}>
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
            title={complete ? "Complete" : `Needs ${lineProblems[position].join(", ")}`}
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
          <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", gap: 10, marginBottom: 14, flexWrap: "wrap" }}>
            <div>
              <h2 style={{ margin: 0, fontSize: 14 }}>Product {safeIndex + 1} of {lines.length}</h2>
              <p style={{ margin: "3px 0 0", fontSize: 11, color: "var(--ink-muted)" }}>
                {piecesFor(line).toLocaleString()} pieces · {boxBarcodesFor(line)} carton barcode{boxBarcodesFor(line) === 1 ? "" : "s"} · {packBarcodesFor(line)} pack barcode{packBarcodesFor(line) === 1 ? "" : "s"}. Individual pieces never get a barcode.
              </p>
            </div>
            <Toggle
              value={line.mode}
              onChange={mode => updateLine({ mode })}
              options={[{ id: "known" as ProductMode, label: "Known product" }, { id: "new" as ProductMode, label: "New product" }]}
            />
          </div>

          {line.mode === "known" ? <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 12 }}>
            <Field label="Product" hint={loading ? "Loading the catalogue…" : `${reference.products.length} products in the shared catalogue`}>
              <SearchSelect
                options={productOptions}
                value={line.productId}
                onSelect={productId => { updateLine({ productId, variantId: "" }); void applyProductDefaults(productId, "") }}
                placeholder="Search by product or generic name…"
                invalid={!line.productId}
                emptyMessage="No product matches — switch to “New product” to add it."
              />
            </Field>
            <Field
              label="Variant"
              hint={!line.productId
                ? "Choose a product first."
                : lineVariants.length === 0
                  ? "None recorded — the server creates this product's first variant on save."
                  : `${lineVariants.length} variant${lineVariants.length === 1 ? "" : "s"} for this product`}
            >
              <SearchSelect
                options={variantOptions}
                value={line.variantId}
                onSelect={variantId => { updateLine({ variantId }); void applyProductDefaults(line.productId, variantId) }}
                disabled={!line.productId || lineVariants.length === 0}
                placeholder={!line.productId ? "Select a product first" : lineVariants.length === 0 ? "None" : "Search dosage, form or unit…"}
                invalid={!!line.productId && lineVariants.length > 0 && !line.variantId}
                emptyMessage="No variant matches that search."
              />
            </Field>
          </div> : <div style={{ display: "grid", gridTemplateColumns: "repeat(3, 1fr)", gap: 12 }}>
            <Field label="Product name">
              <input value={line.productName} onChange={event => updateLine({ productName: event.target.value })} placeholder="e.g. Amoxicillin" style={{ ...inputStyle, borderColor: line.productName.trim() ? "var(--border)" : "#fca5a5" }} />
            </Field>
            <Field label="Product type">
              <select value={line.productType} onChange={event => updateLine({ productType: event.target.value as ProductType })} style={inputStyle}>
                <option value="medicine">Medicine</option>
                <option value="supply">Supply</option>
                <option value="other">Other</option>
              </select>
            </Field>
            <Field label="Generic name (optional)">
              <input value={line.genericName} onChange={event => updateLine({ genericName: event.target.value })} style={inputStyle} />
            </Field>
            <Field label="Dosage (optional)">
              <input value={line.dosage} onChange={event => updateLine({ dosage: event.target.value })} placeholder="e.g. 500mg" style={inputStyle} />
            </Field>
            <Field label="Form (optional)">
              <input value={line.form} onChange={event => updateLine({ form: event.target.value })} placeholder="e.g. Tablet" style={inputStyle} />
            </Field>
            <Field label="Unit (optional)">
              <input value={line.unit} onChange={event => updateLine({ unit: event.target.value })} placeholder="e.g. Blister" style={inputStyle} />
            </Field>
          </div>}

          <div style={{ display: "grid", gridTemplateColumns: "repeat(3, 1fr)", gap: 12, marginTop: 12 }}>
            <Field label="Product category" hint="Private to this branch — never visible to any other branch.">
              <SearchSelect
                options={categoryOptions}
                value={line.categoryName}
                onSelect={categoryName => updateLine({ categoryName })}
                allowFreeText
                createLabel="New category"
                placeholder="Search or type a category…"
                emptyMessage="No categories yet — type a name to create the first one."
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
                    placeholder="New category name"
                    style={{ ...inputStyle, flex: 1 }}
                  />
                  <Btn small onClick={confirmNewCategory}>Add</Btn>
                  <Btn small variant="ghost" onClick={() => { setAddingCategory(false); setNewCategoryDraft("") }}>Cancel</Btn>
                </div>
              ) : (
                <button
                  type="button"
                  onClick={() => setAddingCategory(true)}
                  style={{ marginTop: 6, background: "none", border: "none", padding: 0, color: "var(--primary)", fontSize: 11, fontWeight: 600, cursor: "pointer", fontFamily: "inherit" }}
                >+ New category (only for this branch)</button>
              )}
            </Field>
            <Field label="Manufacturer (optional)" hint="Used to trace batch recalls.">
              <input value={line.manufacturer} onChange={event => updateLine({ manufacturer: event.target.value })} style={inputStyle} />
            </Field>
            <Field label="Manufacturer batch number">
              <input value={line.batchNumber} onChange={event => updateLine({ batchNumber: event.target.value })} placeholder="e.g. PARA-24K" style={{ ...inputStyle, borderColor: line.batchNumber.trim() ? "var(--border)" : "#fca5a5" }} />
            </Field>
            <Field label="Expiry date">
              <input type="date" value={line.expiryDate} onChange={event => updateLine({ expiryDate: event.target.value })} style={{ ...inputStyle, borderColor: line.expiryDate ? "var(--border)" : "#fca5a5" }} />
            </Field>
            <Field label="Cost price / piece">
              <input type="number" min="0" step="0.01" value={line.costPrice} onChange={event => updateLine({ costPrice: event.target.value })} style={{ ...inputStyle, borderColor: toMoney(line.costPrice) >= 0 ? "var(--border)" : "#fca5a5" }} />
            </Field>
            <Field label="Selling price / piece">
              <input type="number" min="0" step="0.01" value={line.sellingPrice} onChange={event => updateLine({ sellingPrice: event.target.value })} style={{ ...inputStyle, borderColor: toMoney(line.sellingPrice) >= 0 ? "var(--border)" : "#fca5a5" }} />
            </Field>
          </div>

          <div style={{ marginTop: 14, padding: 14, borderRadius: 10, background: "var(--bg)", border: "1px solid var(--border)" }}>
            <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", gap: 10, marginBottom: 12, flexWrap: "wrap" }}>
              <div>
                <div style={{ fontSize: 12, fontWeight: 700 }}>Packaging</div>
                <div style={{ fontSize: 10, color: "var(--ink-muted)" }}>Quantity received is calculated by the server from these numbers.</div>
              </div>
              <Toggle
                value={line.packaging}
                onChange={packaging => updateLine({ packaging })}
                options={[{ id: "simple" as Packaging, label: "Simple packs" }, { id: "cartons" as Packaging, label: "Cartons with inner packs" }]}
              />
            </div>
            <div style={{ display: "grid", gridTemplateColumns: line.packaging === "cartons" ? "repeat(3, 1fr)" : "repeat(2, 1fr)", gap: 12 }}>
              {line.packaging === "cartons" && <Field label="Cartons received">
                <input type="number" min="1" value={line.cartons} onChange={event => updateLine({ cartons: event.target.value })} style={inputStyle} />
              </Field>}
              <Field label={line.packaging === "cartons" ? "Packs per carton" : "Packs received"}>
                <input type="number" min="1" value={line.packs} onChange={event => updateLine({ packs: event.target.value })} style={inputStyle} />
              </Field>
              <Field label="Pieces per pack">
                <input type="number" min="1" value={line.piecesPerPack} onChange={event => updateLine({ piecesPerPack: event.target.value })} style={inputStyle} />
              </Field>
            </div>
            <div style={{ marginTop: 10, fontSize: 11, color: "var(--ink-mid)" }}>
              This line totals <strong style={{ color: "var(--primary)" }}>{piecesFor(line).toLocaleString()} pieces</strong>
              {line.packaging === "cartons"
                ? ` — one box barcode per carton, each holding ${Math.max(toInt(line.packs), 0)} child pack barcodes.`
                : " — pack barcodes only, no parent carton level."}
            </div>
          </div>

          <div style={{ display: "flex", gap: 8, marginTop: 16, flexWrap: "wrap", alignItems: "center" }}>
            <Btn variant="ghost" small onClick={() => goTo(safeIndex - 1)} style={{ opacity: safeIndex === 0 ? 0.45 : 1 }}>← Previous</Btn>
            <Btn variant="ghost" small onClick={() => goTo(safeIndex + 1)} style={{ opacity: safeIndex >= lines.length - 1 ? 0.45 : 1 }}>Next →</Btn>
            <Btn variant="secondary" small onClick={addLine}>+ Add another product</Btn>
            <div style={{ flex: 1 }} />
            <Btn variant="danger" small onClick={removeLine}>{lines.length === 1 ? "Clear this product" : "Remove this product"}</Btn>
          </div>
        </Card>
      </div>
    </div>

    <div style={{ background: "#fff", border: "1px solid var(--border)", borderRadius: 12, padding: "14px 16px", display: "flex", alignItems: "center", gap: 14, flexWrap: "wrap" }}>
      <div style={{ flex: 1, minWidth: 220, fontSize: 11, color: disabledReason ? "#b45309" : "var(--ink-muted)" }}>
        {disabledReason ?? `Ready to submit ${lines.length} product line${lines.length === 1 ? "" : "s"} for ${supplier.trim()} as one delivery. The server generates the delivery code and every carton/pack barcode.`}
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
      >{submitting ? "Generating…" : "▮▯▮ Generate Barcodes"}</button>
    </div>
  </div>
}
