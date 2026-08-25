import { useEffect, useRef, useState } from "react"
import { Btn, CenterAlert, SectionHeader } from "../components"
import { fmtRWFExact } from "../data"
import { listTaxRates, type TaxRate } from "../lib/products"
import {
  completeSale, effectiveCoveragePercentage, getSaleReceipt, loadCoverageOverrides, loadInsuranceProviders, scanBarcode,
  type InsuranceProvider, type ReceiptData, type ScannedBarcode,
} from "../lib/sales"

// One physical pack, scanned once. Its own barcode code is the cart identity —
// scanning the same code twice is rejected (both here and, authoritatively,
// by complete_sale()) rather than treated as "quantity 2", since each pack
// is a distinct physical unit with its own quantity_available flag.
interface CartLine extends ScannedBarcode {
  taxAmount: number
  lineTotal: number
  coveragePercentage: number
  insuranceCovered: number
  patientOwed: number
}

function priceLine(item: ScannedBarcode, coveragePercentage: number): CartLine {
  const subtotal = item.sellingPrice * (item.piecesPerPack ?? 1)
  const taxAmount = Math.round(subtotal * item.taxRatePercentage) / 100
  const lineTotal = subtotal + taxAmount
  const insuranceCovered = Math.round(lineTotal * coveragePercentage) / 100
  return { ...item, taxAmount, lineTotal, coveragePercentage, insuranceCovered, patientOwed: lineTotal - insuranceCovered }
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
                <span>{item.code} · tax {item.taxRatePercentage}%</span>
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

export default function SalesPage() {
  const [taxRates, setTaxRates] = useState<TaxRate[]>([])
  const [providers, setProviders] = useState<InsuranceProvider[]>([])
  const [providerId, setProviderId] = useState<string>("") // "" = self-pay
  const [overrides, setOverrides] = useState<Map<string, number>>(new Map())
  const [cart, setCart] = useState<ScannedBarcode[]>([])
  const [scanInput, setScanInput] = useState("")
  const [scanning, setScanning] = useState(false)
  const [completing, setCompleting] = useState(false)
  const [error, setError] = useState("")
  const [notice, setNotice] = useState("")
  const [receipt, setReceipt] = useState<ReceiptData | null>(null)
  const scanRef = useRef<HTMLInputElement>(null)

  useEffect(() => {
    void Promise.all([listTaxRates(), loadInsuranceProviders()]).then(([rates, provs]) => { setTaxRates(rates); setProviders(provs) })
  }, [])

  useEffect(() => { if (!receipt) scanRef.current?.focus() }, [receipt, cart.length])

  useEffect(() => {
    if (!providerId) { setOverrides(new Map()); return }
    void loadCoverageOverrides(providerId).then(setOverrides).catch(reason => setError(reason instanceof Error ? reason.message : "Could not load coverage for this provider."))
  }, [providerId])

  const selectedProvider = providers.find(p => p.id === providerId) ?? null

  async function handleScan() {
    const code = scanInput.trim()
    if (!code || scanning) return
    if (cart.some(item => item.code.toUpperCase() === code.toUpperCase())) {
      setError(`Barcode "${code}" is already in the cart.`)
      setScanInput("")
      return
    }
    setScanning(true)
    setError("")
    try {
      const item = await scanBarcode(code, taxRates)
      setCart(current => [...current, item])
      setScanInput("")
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : "Could not scan this barcode.")
    } finally {
      setScanning(false)
    }
  }

  function removeLine(barcodeId: string) {
    setCart(current => current.filter(item => item.barcodeId !== barcodeId))
  }

  const lines = cart.map(item => priceLine(item, selectedProvider ? effectiveCoveragePercentage(selectedProvider, overrides, item.productId) : 0))
  const subtotal = lines.reduce((sum, l) => sum + l.sellingPrice * (l.piecesPerPack ?? 1), 0)
  const taxTotal = lines.reduce((sum, l) => sum + l.taxAmount, 0)
  const insuranceCoveredTotal = lines.reduce((sum, l) => sum + l.insuranceCovered, 0)
  const grandTotal = subtotal + taxTotal
  const patientOwedTotal = grandTotal - insuranceCoveredTotal

  async function handleCompleteSale() {
    if (cart.length === 0 || completing) return
    setCompleting(true)
    setError("")
    try {
      const result = await completeSale(cart.map(item => item.code), providerId || null)
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
                placeholder="Scan or type a barcode, then press Enter"
                disabled={scanning}
                autoFocus
                style={{ flex: 1, padding: "10px 12px", borderRadius: 8, border: "1px solid var(--border)", fontSize: 14, fontFamily: "inherit", outline: "none" }}
              />
              <Btn variant="primary" onClick={() => void handleScan()}>{scanning ? "Looking up…" : "Add"}</Btn>
            </div>
          </div>

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
                      <div style={{ fontSize: 11, color: "var(--ink-muted)", fontFamily: 'var(--font-mono)' }}>{line.code} · {line.piecesPerPack ?? 1} pcs · tax {line.taxRatePercentage}%</div>
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
