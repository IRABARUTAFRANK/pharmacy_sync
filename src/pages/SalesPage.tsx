import { useEffect, useRef, useState } from "react"
import { Btn, CenterAlert, SectionHeader } from "../components"
import { fmtRWFExact } from "../data"
import { listTaxRates, type TaxRate } from "../lib/products"
import {
  completeSale, effectiveCoveragePercentage, getSaleReceipt, loadCoverageOverrides, loadInsuranceProviders, scanBarcode,
  type InsuranceProvider, type ReceiptData, type ScannedBarcode, type SellMode,
} from "../lib/sales"

// One physical scan (pack or carton) becomes one cart line. Its own barcode
// code is the cart identity — scanning the same code twice within one sale is
// rejected (both here and, authoritatively, by complete_sale()). Each entry
// carries the sell mode and a quantity whose meaning follows the mode:
//   * pack   + whole   → the whole pack (quantity = pack's current pieces_per_pack)
//   * pack   + pieces  → `quantity` loose pieces from the pack
//   * carton + whole   → every remaining child pack (quantity = pieces across all children)
//   * carton + packs   → `quantity` child packs (each full size)
//   * carton + pieces  → `quantity` pieces from one child pack
// `piecesSold` collapses all of that back into "how many actual pieces move
// out of the shelf" so the summary math stays a plain multiplication.
interface CartItem extends ScannedBarcode {
  sellMode: SellMode
  quantity: number
  piecesSold: number
}

interface CartLine extends CartItem {
  taxAmount: number
  lineTotal: number
  coveragePercentage: number
  insuranceCovered: number
  patientOwed: number
}

function priceLine(item: CartItem, coveragePercentage: number): CartLine {
  const subtotal = item.sellingPrice * item.piecesSold
  const taxAmount = Math.round(subtotal * item.taxRatePercentage) / 100
  const lineTotal = subtotal + taxAmount
  const insuranceCovered = Math.round(lineTotal * coveragePercentage) / 100
  return { ...item, taxAmount, lineTotal, coveragePercentage, insuranceCovered, patientOwed: lineTotal - insuranceCovered }
}

// Turns the (mode, quantity) choice into the actual number of pieces leaving
// the shelf, which is the only thing the price cares about. For cartons in
// "whole" mode the piece count equals every active child pack's current
// pieces_per_pack summed up -- we approximate that with
// activeChildCount * childPiecesPerPack (full packs), which is exact whenever
// no child has been partially opened. Backend recomputes the exact total, so
// the client value is only a preview.
function describeSale(item: CartItem): string {
  const pcs = `${item.piecesSold} pc${item.piecesSold === 1 ? "" : "s"}`
  if (item.barcodeType === "pack") {
    return item.sellMode === "whole" ? `whole pack · ${pcs}` : `${pcs} of ${item.piecesPerPack ?? "?"}`
  }
  if (item.sellMode === "whole") return `whole carton · ${item.activeChildCount ?? 0} packs · ${pcs}`
  if (item.sellMode === "packs") return `${item.quantity} pack${item.quantity === 1 ? "" : "s"} from carton · ${pcs}`
  return `${pcs} from carton (loose)`
}

function piecesFromMode(item: ScannedBarcode, mode: SellMode, quantity: number): number {
  if (item.barcodeType === "pack") {
    return mode === "whole" ? (item.piecesPerPack ?? 1) : quantity
  }
  const childPieces = item.childPiecesPerPack ?? 1
  const activePacks = item.activeChildCount ?? 0
  if (mode === "whole") return activePacks * childPieces
  if (mode === "packs") return quantity * childPieces
  return quantity
}

// ── Printable receipt — shared between "just completed" and Transactions history reprints ──

export function ReceiptView({ data, onClose, closeLabel = "New Sale" }: { data: ReceiptData; onClose?: () => void; closeLabel?: string }) {
  return (
    <div>
      <div className="no-print" style={{ display: "flex", justifyContent: "flex-end", gap: 8, marginBottom: 14 }}>
        <Btn variant="primary" onClick={() => window.print()}>🖨 Print Receipt</Btn>
        {onClose && <Btn variant="ghost" onClick={onClose}>{closeLabel}</Btn>}
      </div>
      <div style={{ maxWidth: 420, margin: "0 auto", background: "#fff", border: "1px solid var(--border)", borderRadius: 12, padding: "24px 22px", fontFamily: 'var(--font-mono)' }}>
        <div style={{ textAlign: "center", marginBottom: 14 }}>
          <div style={{ fontWeight: 800, fontSize: 15, letterSpacing: "0.02em" }}>PharmSync</div>
          <div style={{ fontSize: 11, color: "var(--ink-muted)" }}>{data.branchName}</div>
        </div>
        <div style={{ fontSize: 11, color: "var(--ink-mid)", borderTop: "1px dashed var(--border)", borderBottom: "1px dashed var(--border)", padding: "8px 0", marginBottom: 10 }}>
          <div>Receipt: {data.receiptNumber}</div>
          <div>{new Date(data.issuedAt).toLocaleString()}</div>
          <div>Cashier: {data.cashierName}</div>
          {data.insuranceProviderName && <div>Insurance: {data.insuranceProviderName}</div>}
        </div>
        <div style={{ display: "flex", flexDirection: "column", gap: 8, marginBottom: 10 }}>
          {data.items.map((item, i) => (
            <div key={i} style={{ fontSize: 11 }}>
              <div style={{ display: "flex", justifyContent: "space-between", fontWeight: 700 }}>
                <span>{item.productName}{item.dosage ? ` (${item.dosage})` : ""}</span>
                <span>{fmtRWFExact(item.subtotal)}</span>
              </div>
              <div style={{ color: "var(--ink-muted)", display: "flex", justifyContent: "space-between" }}>
                <span>{item.code} · {item.quantity} pc{item.quantity === 1 ? "" : "s"} · tax {item.taxRatePercentage}%</span>
                <span>+{fmtRWFExact(item.taxAmount)}</span>
              </div>
              {item.insuranceCovered > 0 && (
                <div style={{ color: "#16a34a", display: "flex", justifyContent: "space-between" }}>
                  <span>Insurance covers ({Math.round((item.insuranceCovered / (item.subtotal + item.taxAmount)) * 100)}%)</span>
                  <span>-{fmtRWFExact(item.insuranceCovered)}</span>
                </div>
              )}
            </div>
          ))}
        </div>
        <div style={{ borderTop: "1px dashed var(--border)", paddingTop: 8, fontSize: 12, display: "flex", flexDirection: "column", gap: 3 }}>
          <div style={{ display: "flex", justifyContent: "space-between" }}><span>Subtotal</span><span>{fmtRWFExact(data.subtotal)}</span></div>
          <div style={{ display: "flex", justifyContent: "space-between" }}><span>Tax</span><span>{fmtRWFExact(data.taxTotal)}</span></div>
          {data.insuranceCoveredTotal > 0 && (
            <div style={{ display: "flex", justifyContent: "space-between", color: "#16a34a" }}><span>Insurance paid</span><span>-{fmtRWFExact(data.insuranceCoveredTotal)}</span></div>
          )}
          <div style={{ display: "flex", justifyContent: "space-between", fontWeight: 800, fontSize: 14, borderTop: "1px solid var(--border)", paddingTop: 6, marginTop: 3 }}>
            <span>Patient Paid</span><span>{fmtRWFExact(data.patientOwedTotal)}</span>
          </div>
        </div>
        <div style={{ textAlign: "center", fontSize: 10, color: "var(--ink-faint)", marginTop: 16 }}>Thank you</div>
      </div>
    </div>
  )
}

// The "pending scan" mode holds a freshly-looked-up barcode while the cashier
// picks how much of it to sell. `mode` drives which radio is active; `amount`
// is the free-text quantity input tied to the current mode (pieces or packs).
// Kept as a string so the input can be cleared without collapsing to 0.
interface PendingScan {
  item: ScannedBarcode
  mode: SellMode
  amount: string
}

export default function SalesPage() {
  const [taxRates, setTaxRates] = useState<TaxRate[]>([])
  const [providers, setProviders] = useState<InsuranceProvider[]>([])
  const [providerId, setProviderId] = useState<string>("") // "" = self-pay
  const [overrides, setOverrides] = useState<Map<string, number>>(new Map())
  const [cart, setCart] = useState<CartItem[]>([])
  const [pending, setPending] = useState<PendingScan | null>(null)
  const [scanInput, setScanInput] = useState("")
  const [scanning, setScanning] = useState(false)
  const [completing, setCompleting] = useState(false)
  const [error, setError] = useState("")
  const [notice, setNotice] = useState("")
  const [receipt, setReceipt] = useState<ReceiptData | null>(null)
  const scanRef = useRef<HTMLInputElement>(null)
  const amountRef = useRef<HTMLInputElement>(null)

  useEffect(() => {
    void Promise.all([listTaxRates(), loadInsuranceProviders()]).then(([rates, provs]) => { setTaxRates(rates); setProviders(provs) })
  }, [])

  useEffect(() => { if (!receipt && !pending) scanRef.current?.focus() }, [receipt, cart.length, pending])
  useEffect(() => { if (pending && pending.mode !== "whole") amountRef.current?.focus() }, [pending?.mode])

  useEffect(() => {
    if (!providerId) { setOverrides(new Map()); return }
    void loadCoverageOverrides(providerId).then(setOverrides).catch(reason => setError(reason instanceof Error ? reason.message : "Could not load coverage for this provider."))
  }, [providerId])

  const selectedProvider = providers.find(p => p.id === providerId) ?? null

  async function handleScan() {
    const code = scanInput.trim()
    if (!code || scanning || pending) return
    if (cart.some(item => item.code.toUpperCase() === code.toUpperCase())) {
      setError(`Barcode "${code}" is already in the cart.`)
      setScanInput("")
      return
    }
    setScanning(true)
    setError("")
    try {
      const item = await scanBarcode(code, taxRates)
      setPending({ item, mode: "whole", amount: "1" })
      setScanInput("")
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : "Could not scan this barcode.")
    } finally {
      setScanning(false)
    }
  }

  function confirmPending() {
    if (!pending) return
    const { item, mode } = pending
    const isCarton = item.barcodeType === "box"
    const typed = Number.parseInt(pending.amount, 10)
    let quantity = 0

    if (mode === "whole") {
      quantity = isCarton ? (item.activeChildCount ?? 0) : (item.piecesPerPack ?? 0)
    } else if (mode === "packs") {
      const maxPacks = item.activeChildCount ?? 0
      if (!Number.isFinite(typed) || typed < 1) { setError("Enter how many packs to sell."); return }
      if (typed > maxPacks) { setError(`This carton only has ${maxPacks} pack${maxPacks === 1 ? "" : "s"} left.`); return }
      quantity = typed
    } else { // pieces
      const maxPieces = isCarton ? (item.childPiecesPerPack ?? 0) : (item.piecesPerPack ?? 0)
      if (!Number.isFinite(typed) || typed < 1) { setError("Enter how many pieces to sell."); return }
      if (typed > maxPieces) {
        setError(isCarton
          ? `The next openable pack only holds ${maxPieces} piece${maxPieces === 1 ? "" : "s"}.`
          : `This pack only has ${maxPieces} piece${maxPieces === 1 ? "" : "s"}.`)
        return
      }
      quantity = typed
    }

    const piecesSold = piecesFromMode(item, mode, quantity)
    setCart(current => [...current, { ...item, sellMode: mode, quantity, piecesSold }])
    setPending(null)
    setError("")
  }

  function cancelPending() {
    setPending(null)
    setError("")
  }

  function removeLine(barcodeId: string) {
    setCart(current => current.filter(item => item.barcodeId !== barcodeId))
  }

  const lines = cart.map(item => priceLine(item, selectedProvider ? effectiveCoveragePercentage(selectedProvider, overrides, item.productId) : 0))
  const subtotal = lines.reduce((sum, l) => sum + l.sellingPrice * l.piecesSold, 0)
  const taxTotal = lines.reduce((sum, l) => sum + l.taxAmount, 0)
  const insuranceCoveredTotal = lines.reduce((sum, l) => sum + l.insuranceCovered, 0)
  const grandTotal = subtotal + taxTotal
  const patientOwedTotal = grandTotal - insuranceCoveredTotal

  async function handleCompleteSale() {
    if (cart.length === 0 || completing) return
    setCompleting(true)
    setError("")
    try {
      const result = await completeSale(
        cart.map(item => ({
          code: item.code,
          sellMode: item.sellMode,
          quantity: item.sellMode === "whole" ? null : item.quantity,
        })),
        providerId || null,
      )
      const fullReceipt = await getSaleReceipt(result.saleId)
      setReceipt(fullReceipt)
      setCart([])
      setProviderId("")
      setNotice("Sale completed and receipt saved.")
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : "Could not complete this sale.")
    } finally {
      setCompleting(false)
    }
  }

  if (receipt) {
    return (
      <div>
        {notice && <CenterAlert key={notice} tone="success" message={notice} />}
        <ReceiptView data={receipt} onClose={() => { setReceipt(null); setNotice("") }} />
      </div>
    )
  }

  return (
    <div>
      {error && <CenterAlert key={error} message={error} />}
      <SectionHeader title="Sales / POS" subtitle="Scan a pack's barcode to add it to the sale — its full product info is pulled straight from the database." />

      <div style={{ display: "flex", gap: 16, alignItems: "flex-start", flexWrap: "wrap" }}>
        {/* Left: scan + cart */}
        <div style={{ flex: "2 1 460px", minWidth: 340 }}>
          <div style={{ background: "#fff", border: "1px solid var(--border)", borderRadius: 12, padding: 16, marginBottom: 14 }}>
            <div style={{ display: "flex", gap: 8 }}>
              <input
                ref={scanRef}
                value={scanInput}
                onChange={e => setScanInput(e.target.value)}
                onKeyDown={e => { if (e.key === "Enter") void handleScan() }}
                placeholder={pending ? "Finish the scan below first" : "Scan or type a barcode, then press Enter"}
                disabled={scanning || pending !== null}
                autoFocus
                style={{ flex: 1, padding: "10px 12px", borderRadius: 8, border: "1px solid var(--border)", fontSize: 14, fontFamily: "inherit", outline: "none", opacity: pending ? 0.55 : 1 }}
              />
              <Btn variant="primary" onClick={() => void handleScan()}>{scanning ? "Looking up…" : "Add"}</Btn>
            </div>
          </div>

          {pending && (() => {
            const isCarton = pending.item.barcodeType === "box"
            const typed = Math.max(0, Number.parseInt(pending.amount, 10) || 0)
            const maxPacks = pending.item.activeChildCount ?? 0
            const maxPiecesPerPack = isCarton ? (pending.item.childPiecesPerPack ?? 0) : (pending.item.piecesPerPack ?? 0)
            const boundedTyped = pending.mode === "packs"
              ? Math.min(typed, maxPacks)
              : Math.min(typed, maxPiecesPerPack)
            const pieces = piecesFromMode(pending.item, pending.mode, boundedTyped)
            const subtotalPreview = pending.item.sellingPrice * pieces
            const taxPreview = Math.round(subtotalPreview * pending.item.taxRatePercentage) / 100
            const totalPreview = subtotalPreview + taxPreview
            const wholeLabel = isCarton
              ? `Sell the whole carton — ${maxPacks} pack${maxPacks === 1 ? "" : "s"} · ${maxPacks * maxPiecesPerPack} piece${maxPacks * maxPiecesPerPack === 1 ? "" : "s"}`
              : `Sell the whole pack — ${maxPiecesPerPack} piece${maxPiecesPerPack === 1 ? "" : "s"}`
            const summaryLine = isCarton
              ? `${pending.item.code} · Carton · ${maxPacks} pack${maxPacks === 1 ? "" : "s"} left · ${maxPiecesPerPack} piece${maxPiecesPerPack === 1 ? "" : "s"} per pack · ${fmtRWFExact(pending.item.sellingPrice)} per piece`
              : `${pending.item.code} · Pack · ${maxPiecesPerPack} piece${maxPiecesPerPack === 1 ? "" : "s"} · ${fmtRWFExact(pending.item.sellingPrice)} per piece`

            return (
              <div style={{ background: "#fff", border: "1px solid var(--accent)", borderRadius: 12, padding: 16, marginBottom: 14, boxShadow: "0 1px 4px rgba(0,0,0,0.06)" }}>
                <div style={{ fontSize: 11, fontWeight: 700, color: "var(--accent)", textTransform: "uppercase", letterSpacing: "0.05em", marginBottom: 8 }}>
                  Confirm sale — how much of this {isCarton ? "carton" : "pack"}?
                </div>
                <div style={{ fontWeight: 700, fontSize: 14, color: "var(--ink)", marginBottom: 2 }}>
                  {pending.item.productName}{pending.item.dosage ? ` · ${pending.item.dosage}` : ""}{pending.item.form ? ` · ${pending.item.form}` : ""}
                </div>
                <div style={{ fontSize: 12, color: "var(--ink-muted)", fontFamily: 'var(--font-mono)', marginBottom: 12 }}>{summaryLine}</div>

                <div style={{ display: "flex", flexDirection: "column", gap: 8, marginBottom: 12 }}>
                  <label style={{ display: "flex", alignItems: "center", gap: 8, fontSize: 13, cursor: "pointer" }}>
                    <input
                      type="radio"
                      name="sale-mode"
                      checked={pending.mode === "whole"}
                      onChange={() => setPending({ ...pending, mode: "whole" })}
                    />
                    <span>{wholeLabel}</span>
                  </label>

                  {isCarton && (
                    <label style={{ display: "flex", alignItems: "center", gap: 8, fontSize: 13, cursor: "pointer" }}>
                      <input
                        type="radio"
                        name="sale-mode"
                        checked={pending.mode === "packs"}
                        onChange={() => setPending({ ...pending, mode: "packs", amount: pending.mode === "packs" ? pending.amount : "" })}
                      />
                      <span>Sell packs:</span>
                      <input
                        ref={pending.mode === "packs" ? amountRef : undefined}
                        type="number"
                        min={1}
                        max={maxPacks}
                        value={pending.mode === "packs" ? pending.amount : ""}
                        onFocus={() => { if (pending.mode !== "packs") setPending({ ...pending, mode: "packs", amount: "" }) }}
                        onChange={e => setPending({ ...pending, mode: "packs", amount: e.target.value })}
                        onKeyDown={e => { if (e.key === "Enter") confirmPending() }}
                        style={{ width: 70, padding: "6px 8px", borderRadius: 6, border: "1px solid var(--border)", fontSize: 13, fontFamily: "inherit" }}
                      />
                      <span style={{ fontSize: 12, color: "var(--ink-muted)" }}>of {maxPacks}</span>
                    </label>
                  )}

                  <label style={{ display: "flex", alignItems: "center", gap: 8, fontSize: 13, cursor: "pointer" }}>
                    <input
                      type="radio"
                      name="sale-mode"
                      checked={pending.mode === "pieces"}
                      onChange={() => setPending({ ...pending, mode: "pieces", amount: pending.mode === "pieces" ? pending.amount : "" })}
                    />
                    <span>Sell loose pieces:</span>
                    <input
                      ref={pending.mode === "pieces" ? amountRef : undefined}
                      type="number"
                      min={1}
                      max={maxPiecesPerPack}
                      value={pending.mode === "pieces" ? pending.amount : ""}
                      onFocus={() => { if (pending.mode !== "pieces") setPending({ ...pending, mode: "pieces", amount: "" }) }}
                      onChange={e => setPending({ ...pending, mode: "pieces", amount: e.target.value })}
                      onKeyDown={e => { if (e.key === "Enter") confirmPending() }}
                      style={{ width: 70, padding: "6px 8px", borderRadius: 6, border: "1px solid var(--border)", fontSize: 13, fontFamily: "inherit" }}
                    />
                    <span style={{ fontSize: 12, color: "var(--ink-muted)" }}>
                      {isCarton ? `of ${maxPiecesPerPack} (opens one pack)` : `of ${maxPiecesPerPack}`}
                    </span>
                  </label>
                </div>

                <div style={{ display: "flex", flexDirection: "column", gap: 4, fontSize: 12, padding: "10px 12px", background: "var(--bg-alt)", borderRadius: 8, marginBottom: 12 }}>
                  <div style={{ display: "flex", justifyContent: "space-between" }}><span>Subtotal ({pieces} pc{pieces === 1 ? "" : "s"} × {fmtRWFExact(pending.item.sellingPrice)})</span><span>{fmtRWFExact(subtotalPreview)}</span></div>
                  <div style={{ display: "flex", justifyContent: "space-between", color: "var(--ink-muted)" }}><span>Tax ({pending.item.taxRatePercentage}%)</span><span>+{fmtRWFExact(taxPreview)}</span></div>
                  <div style={{ display: "flex", justifyContent: "space-between", fontWeight: 700, color: "var(--ink)", borderTop: "1px solid var(--border)", paddingTop: 4, marginTop: 4 }}><span>Line total</span><span>{fmtRWFExact(totalPreview)}</span></div>
                </div>

                <div style={{ display: "flex", gap: 8, justifyContent: "flex-end" }}>
                  <Btn variant="ghost" onClick={cancelPending}>Cancel</Btn>
                  <Btn variant="primary" onClick={confirmPending}>Add to cart</Btn>
                </div>
              </div>
            )
          })()}

          <div style={{ background: "#fff", border: "1px solid var(--border)", borderRadius: 12, overflow: "hidden" }}>
            {lines.length === 0 ? (
              <div style={{ padding: 40, textAlign: "center", color: "var(--ink-muted)", fontSize: 13 }}>Cart is empty — scan a product to begin.</div>
            ) : (
              <div>
                {lines.map(line => (
                  <div key={line.barcodeId} style={{ display: "flex", justifyContent: "space-between", alignItems: "center", padding: "12px 16px", borderBottom: "1px solid var(--bg-alt)", gap: 10 }}>
                    <div style={{ minWidth: 0 }}>
                      <div style={{ fontWeight: 600, fontSize: 13, color: "var(--ink)", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
                        {line.productName}{line.dosage ? ` · ${line.dosage}` : ""}{line.form ? ` · ${line.form}` : ""}
                      </div>
                      <div style={{ fontSize: 11, color: "var(--ink-muted)", fontFamily: 'var(--font-mono)' }}>
                        {line.code} · {describeSale(line)} · tax {line.taxRatePercentage}%
                      </div>
                    </div>
                    <div style={{ textAlign: "right", flexShrink: 0 }}>
                      <div style={{ fontWeight: 700, fontSize: 13, color: "var(--ink)" }}>{fmtRWFExact(line.lineTotal)}</div>
                      {line.insuranceCovered > 0 && <div style={{ fontSize: 11, color: "#16a34a" }}>-{fmtRWFExact(line.insuranceCovered)} insurance</div>}
                    </div>
                    <button onClick={() => removeLine(line.barcodeId)} title="Remove" style={{ background: "none", border: "none", cursor: "pointer", color: "var(--ink-faint)", fontSize: 16, padding: "0 4px" }}>×</button>
                  </div>
                ))}
              </div>
            )}
          </div>
        </div>

        {/* Right: insurance + totals + complete */}
        <div style={{ flex: "1 1 300px", minWidth: 280, background: "#fff", border: "1px solid var(--border)", borderRadius: 12, padding: 16, position: "sticky", top: 0 }}>
          <div style={{ fontSize: 11, fontWeight: 700, color: "var(--ink-muted)", textTransform: "uppercase", letterSpacing: "0.05em", marginBottom: 8 }}>Payment</div>
          <select
            value={providerId}
            onChange={e => setProviderId(e.target.value)}
            style={{ width: "100%", padding: "9px 10px", borderRadius: 8, border: "1px solid var(--border)", fontSize: 13, fontFamily: "inherit", marginBottom: 16, background: "#fff" }}
          >
            <option value="">Self-pay (full cost, no insurance)</option>
            {providers.map(p => <option key={p.id} value={p.id}>{p.name} (default {p.defaultCoveragePercentage}% covered)</option>)}
          </select>

          <div style={{ display: "flex", flexDirection: "column", gap: 6, fontSize: 13, paddingBottom: 12, borderBottom: "1px solid var(--bg-alt)", marginBottom: 12 }}>
            <div style={{ display: "flex", justifyContent: "space-between", color: "var(--ink-mid)" }}><span>Subtotal</span><span>{fmtRWFExact(subtotal)}</span></div>
            <div style={{ display: "flex", justifyContent: "space-between", color: "var(--ink-mid)" }}><span>Tax</span><span>{fmtRWFExact(taxTotal)}</span></div>
            {selectedProvider && (
              <div style={{ display: "flex", justifyContent: "space-between", color: "#16a34a" }}><span>Insurance covers</span><span>-{fmtRWFExact(insuranceCoveredTotal)}</span></div>
            )}
          </div>
          <div style={{ display: "flex", justifyContent: "space-between", fontWeight: 800, fontSize: 17, color: "var(--ink)", marginBottom: 16 }}>
            <span>Patient owes</span><span>{fmtRWFExact(patientOwedTotal)}</span>
          </div>

          <Btn
            variant="primary"
            style={{ width: "100%", justifyContent: "center", padding: "12px 16px", fontSize: 14, opacity: cart.length === 0 || completing ? 0.55 : 1, cursor: cart.length === 0 || completing ? "not-allowed" : "pointer" }}
            onClick={() => void handleCompleteSale()}
          >
            {completing ? "Completing…" : `Complete Sale · ${cart.length} item${cart.length === 1 ? "" : "s"}`}
          </Btn>
        </div>
      </div>
    </div>
  )
}
