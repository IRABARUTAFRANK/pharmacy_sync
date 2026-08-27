import { useEffect, useRef, useState } from "react"
import { Btn, CenterAlert, SectionHeader } from "../components"
import { fmtRWFExact } from "../data"
import { useTranslation } from "../lib/i18n"
import { findPatientByIdentifier, upsertPatient, type PatientGender } from "../lib/patients"
import { listTaxRates, type TaxRate } from "../lib/products"
import {
  completeSale, effectiveCoveragePercentage, getSaleReceipt, loadCoverageOverrides, loadInsuranceProviders, scanBarcode,
  type InsuranceProvider, type ReceiptData, type ScannedBarcode,
} from "../lib/sales"

// One physical pack, scanned once. Its own barcode code is the cart identity —
// scanning the same code twice is rejected (both here and, authoritatively,
// by complete_sale()) rather than treated as "quantity 2", since each pack
// is a distinct physical unit with its own quantity_available flag. How many
// of its pieces actually get sold is a separate, editable choice (sellQty) —
// selling fewer than the whole pack leaves the remainder as that same,
// still-scannable barcode with fewer pieces, same as adjust_stock()'s
// partial-removal behaviour.
interface CartLine extends ScannedBarcode {
  sellQty: number
  taxAmount: number
  lineTotal: number
  coveragePercentage: number
  insuranceCovered: number
  patientOwed: number
}

function priceLine(item: ScannedBarcode, sellQty: number, coveragePercentage: number): CartLine {
  const subtotal = item.sellingPrice * sellQty
  const taxAmount = Math.round(subtotal * item.taxRatePercentage) / 100
  const lineTotal = subtotal + taxAmount
  const insuranceCovered = Math.round(lineTotal * coveragePercentage) / 100
  return { ...item, sellQty, taxAmount, lineTotal, coveragePercentage, insuranceCovered, patientOwed: lineTotal - insuranceCovered }
}

// ── Printable receipt — shared between "just completed" and Transactions history reprints ──

export function ReceiptView({ data, onClose, closeLabel }: { data: ReceiptData; onClose?: () => void; closeLabel?: string }) {
  const { t } = useTranslation()
  const genderLabel = (g: string | null) =>
    g === "male" ? t("patients.genderMale") : g === "female" ? t("patients.genderFemale") : g === "other" ? t("patients.genderOther") : null

  return (
    <div>
      <div className="no-print" style={{ display: "flex", justifyContent: "flex-end", gap: 8, marginBottom: 14 }}>
        <Btn variant="primary" onClick={() => window.print()}>🖨 {t("salesPage.receiptPrintButton")}</Btn>
        {onClose && <Btn variant="ghost" onClick={onClose}>{closeLabel ?? t("salesPage.receiptNewSale")}</Btn>}
      </div>
      <div style={{ maxWidth: 480, margin: "0 auto", background: "#fff", border: "1px solid var(--border)", borderRadius: 12, padding: "26px 24px", fontFamily: "var(--font-body)" }}>
        {/* Letterhead */}
        <div style={{ textAlign: "center", marginBottom: 16 }}>
          {data.branchLogoUrl && (
            <img src={data.branchLogoUrl} alt={data.branchName} style={{ width: 64, height: 64, objectFit: "contain", margin: "0 auto 8px" }} />
          )}
          <div style={{ fontWeight: 800, fontSize: 19, letterSpacing: "0.01em", color: "var(--primary)", textTransform: "uppercase" }}>{data.branchName}</div>
          <div style={{ fontWeight: 700, fontSize: 12, letterSpacing: "0.15em", color: "var(--ink-muted)", marginTop: 2 }}>{t("salesPage.receiptHeading")}</div>
          <div style={{ borderTop: "2px solid var(--primary)", width: 64, margin: "8px auto 0" }} />
        </div>

        {/* No / Client / contact block, left; Date, right */}
        <div style={{ display: "flex", justifyContent: "space-between", gap: 12, fontSize: 11, color: "var(--ink-mid)", marginBottom: 14 }}>
          <div style={{ display: "flex", flexDirection: "column", gap: 2 }}>
            <div><b>{t("salesPage.receiptLabelReceipt")}</b> {data.receiptNumber}</div>
            {data.patientName && <div><b>{t("salesPage.receiptPatientLabel")}:</b> {data.patientName}</div>}
            {(data.patientGender || data.patientAge != null) && (
              <div>{[genderLabel(data.patientGender), data.patientAge != null ? `${data.patientAge}${t("salesPage.receiptPatientAgeSuffix")}` : null].filter(Boolean).join(" · ")}</div>
            )}
            {data.patientContact && <div>{data.patientContact}</div>}
            <div style={{ height: 4 }} />
            {data.branchTin && <div><b>{t("salesPage.receiptTin")}:</b> {data.branchTin}</div>}
            {data.branchPhone && <div><b>{t("salesPage.receiptTel")}:</b> {data.branchPhone}</div>}
            {data.branchAddress && <div><b>{t("salesPage.receiptLocation")}:</b> {data.branchAddress}</div>}
            {data.branchBankAccountNumber && <div><b>{t("salesPage.receiptAcc")}:</b> {data.branchBankAccountNumber}</div>}
            {data.branchBankAccountName && <div><b>{t("salesPage.receiptAccName")}:</b> {data.branchBankAccountName}</div>}
            {data.branchMomoPayNumber && <div><b>{t("salesPage.receiptMomoPay")}:</b> {data.branchMomoPayNumber}</div>}
          </div>
          <div style={{ textAlign: "right", flexShrink: 0 }}>
            <div><b>{t("salesPage.receiptDate")}:</b></div>
            <div>{new Date(data.issuedAt).toLocaleString()}</div>
            <div style={{ marginTop: 8 }}><b>{t("salesPage.receiptLabelCashier")}:</b></div>
            <div>{data.cashierName}</div>
            {data.insuranceProviderName && <>
              <div style={{ marginTop: 8 }}><b>{t("salesPage.receiptLabelInsurance")}:</b></div>
              <div>{data.insuranceProviderName}</div>
            </>}
          </div>
        </div>

        {/* Itemized table */}
        <table style={{ width: "100%", borderCollapse: "collapse", fontSize: 11 }}>
          <thead>
            <tr style={{ borderTop: "1.5px solid var(--ink)", borderBottom: "1.5px solid var(--ink)" }}>
              <th style={{ textAlign: "left", padding: "6px 4px", fontSize: 9, letterSpacing: "0.04em" }}>{t("salesPage.receiptColNo")}</th>
              <th style={{ textAlign: "left", padding: "6px 4px", fontSize: 9, letterSpacing: "0.04em" }}>{t("salesPage.receiptColDescription")}</th>
              <th style={{ textAlign: "right", padding: "6px 4px", fontSize: 9, letterSpacing: "0.04em" }}>{t("salesPage.receiptColQty")}</th>
              <th style={{ textAlign: "right", padding: "6px 4px", fontSize: 9, letterSpacing: "0.04em" }}>{t("salesPage.receiptColUnitPrice")}</th>
              <th style={{ textAlign: "right", padding: "6px 4px", fontSize: 9, letterSpacing: "0.04em" }}>{t("salesPage.receiptColTotal")}</th>
            </tr>
          </thead>
          <tbody>
            {data.items.map((item, i) => (
              <tr key={i} style={{ borderBottom: "1px solid var(--bg-alt)" }}>
                <td style={{ padding: "6px 4px", verticalAlign: "top" }}>{i + 1}</td>
                <td style={{ padding: "6px 4px", verticalAlign: "top" }}>
                  {item.productName}{item.dosage ? ` (${item.dosage})` : ""}
                  {item.insuranceCovered > 0 && (
                    <div style={{ fontSize: 9, color: "#16a34a" }}>{t("salesPage.receiptInsuranceCoversPct", { pct: Math.round((item.insuranceCovered / (item.subtotal + item.taxAmount)) * 100) })}</div>
                  )}
                </td>
                <td style={{ padding: "6px 4px", textAlign: "right", verticalAlign: "top" }}>{item.quantity}</td>
                <td style={{ padding: "6px 4px", textAlign: "right", verticalAlign: "top" }}>{fmtRWFExact(item.unitPrice)}</td>
                <td style={{ padding: "6px 4px", textAlign: "right", verticalAlign: "top", fontWeight: 600 }}>{fmtRWFExact(item.subtotal)}</td>
              </tr>
            ))}
          </tbody>
        </table>

        <div style={{ borderTop: "1px dashed var(--border)", paddingTop: 8, marginTop: 10, fontSize: 12, display: "flex", flexDirection: "column", gap: 3 }}>
          <div style={{ display: "flex", justifyContent: "space-between" }}><span>{t("salesPage.subtotal")}</span><span>{fmtRWFExact(data.subtotal)}</span></div>
          <div style={{ display: "flex", justifyContent: "space-between" }}><span>{t("salesPage.tax")}</span><span>{fmtRWFExact(data.taxTotal)}</span></div>
          {data.insuranceCoveredTotal > 0 && (
            <div style={{ display: "flex", justifyContent: "space-between", color: "#16a34a" }}><span>{t("salesPage.receiptInsurancePaid")}</span><span>-{fmtRWFExact(data.insuranceCoveredTotal)}</span></div>
          )}
          <div style={{ display: "flex", justifyContent: "space-between", fontWeight: 800, fontSize: 14, borderTop: "1px solid var(--border)", paddingTop: 6, marginTop: 3 }}>
            <span>{t("salesPage.receiptPatientPaid")}</span><span>{fmtRWFExact(data.patientOwedTotal)}</span>
          </div>
        </div>
        <div style={{ textAlign: "center", fontSize: 10, color: "var(--ink-faint)", marginTop: 18 }}>{t("salesPage.receiptThankYou")}</div>
        <div style={{ textAlign: "center", fontSize: 9, color: "var(--ink-faint)", marginTop: 10, paddingTop: 8, borderTop: "1px solid var(--bg-alt)" }}>{t("salesPage.receiptPoweredBy")}</div>
      </div>
    </div>
  )
}

// ── Patient step — optional. Search by phone/TIN pre-fills what's on file so
// the cashier only edits what's different; leaving it blank keeps the sale
// self-pay/anonymous. ────────────────────────────────────────────────────────

interface PatientDraft {
  fullName: string
  gender: PatientGender | ""
  age: string
  identifier: string
}

const BLANK_PATIENT: PatientDraft = { fullName: "", gender: "", age: "", identifier: "" }

function PatientStep({ draft, onChange, onClear, resolvedId }: {
  draft: PatientDraft
  onChange: (next: PatientDraft) => void
  onClear: () => void
  resolvedId: string | null
}) {
  const { t } = useTranslation()
  const [searching, setSearching] = useState(false)
  const [notFound, setNotFound] = useState(false)
  // Explicit choice instead of an implicit "type something to reveal the
  // fields" flow -- a cashier who wants to record a patient gets the name/
  // gender/age fields immediately, not after guessing they need to type in
  // the search box first.
  const [mode, setMode] = useState<"walkin" | "record">(draft.identifier || draft.fullName ? "record" : "walkin")

  async function search() {
    const identifier = draft.identifier.trim()
    if (!identifier) return
    setSearching(true)
    setNotFound(false)
    try {
      const found = await findPatientByIdentifier(identifier)
      if (found) {
        onChange({ fullName: found.fullName, gender: found.gender ?? "", age: found.age != null ? String(found.age) : "", identifier: found.tinOrPhone })
      } else {
        setNotFound(true)
      }
    } finally {
      setSearching(false)
    }
  }

  function chooseWalkin() {
    setMode("walkin")
    onClear()
    setNotFound(false)
  }

  const inputStyle = { width: "100%", padding: "8px 10px", border: "1px solid var(--border)", borderRadius: 7, fontFamily: "inherit", fontSize: 12, boxSizing: "border-box" as const }
  const modeBtn = (active: boolean) => ({
    flex: 1, padding: "8px 10px", borderRadius: 7, fontSize: 12, fontWeight: 600, cursor: "pointer", fontFamily: "inherit",
    border: `1.5px solid ${active ? "var(--primary)" : "var(--border)"}`,
    background: active ? "var(--primary-light)" : "#fff", color: active ? "var(--primary)" : "var(--ink-mid)",
  })

  return <div style={{ background: "#fff", border: "1px solid var(--border)", borderRadius: 12, padding: 16, marginBottom: 14 }}>
    <div style={{ fontSize: 11, fontWeight: 700, color: "var(--ink-muted)", textTransform: "uppercase", letterSpacing: "0.05em", marginBottom: 8 }}>
      {t("salesPage.patientSectionTitle")}
    </div>
    <div style={{ display: "flex", gap: 8, marginBottom: mode === "record" ? 10 : 0 }}>
      <button onClick={chooseWalkin} style={modeBtn(mode === "walkin")}>{t("salesPage.patientWalkinOption")}</button>
      <button onClick={() => setMode("record")} style={modeBtn(mode === "record")}>{t("salesPage.patientRecordOption")}</button>
    </div>
    {mode === "record" && (
      <>
        <div style={{ display: "flex", gap: 8, marginBottom: 10 }}>
          <input
            value={draft.identifier}
            onChange={e => onChange({ ...draft, identifier: e.target.value })}
            onKeyDown={e => { if (e.key === "Enter") { e.preventDefault(); void search() } }}
            placeholder={t("salesPage.patientSearchPlaceholder")}
            style={inputStyle}
          />
          <Btn variant="secondary" small onClick={() => void search()}>{searching ? t("salesPage.patientSearching") : t("salesPage.patientFind")}</Btn>
        </div>
        {notFound && <p style={{ margin: "0 0 10px", fontSize: 11, color: "var(--ink-muted)" }}>{t("salesPage.patientNotFoundHint")}</p>}
        {resolvedId && <p style={{ margin: "0 0 10px", fontSize: 11, color: "#16a34a" }}>{t("salesPage.patientFoundHint")}</p>}
        <div style={{ display: "grid", gridTemplateColumns: "2fr 1fr 1fr", gap: 8 }}>
          <input value={draft.fullName} onChange={e => onChange({ ...draft, fullName: e.target.value })} placeholder={t("salesPage.patientFullName")} style={inputStyle} />
          <select value={draft.gender} onChange={e => onChange({ ...draft, gender: e.target.value as PatientGender | "" })} style={{ ...inputStyle, background: "#fff" }}>
            <option value="">{t("salesPage.patientGenderUnspecified")}</option>
            <option value="male">{t("patients.genderMale")}</option>
            <option value="female">{t("patients.genderFemale")}</option>
            <option value="other">{t("patients.genderOther")}</option>
          </select>
          <input type="number" min="0" value={draft.age} onChange={e => onChange({ ...draft, age: e.target.value })} placeholder={t("salesPage.patientAge")} style={inputStyle} />
        </div>
      </>
    )}
  </div>
}

export default function SalesPage() {
  const { t } = useTranslation()
  const [taxRates, setTaxRates] = useState<TaxRate[]>([])
  const [providers, setProviders] = useState<InsuranceProvider[]>([])
  const [providerId, setProviderId] = useState<string>("") // "" = self-pay
  const [overrides, setOverrides] = useState<Map<string, number>>(new Map())
  const [cart, setCart] = useState<ScannedBarcode[]>([])
  const [quantities, setQuantities] = useState<Map<string, number>>(new Map())
  const [scanInput, setScanInput] = useState("")
  const [scanning, setScanning] = useState(false)
  const [completing, setCompleting] = useState(false)
  const [error, setError] = useState("")
  const [notice, setNotice] = useState("")
  const [receipt, setReceipt] = useState<ReceiptData | null>(null)
  const [patientDraft, setPatientDraft] = useState<PatientDraft>(BLANK_PATIENT)
  const scanRef = useRef<HTMLInputElement>(null)

  useEffect(() => {
    void Promise.all([listTaxRates(), loadInsuranceProviders()]).then(([rates, provs]) => { setTaxRates(rates); setProviders(provs) })
  }, [])

  useEffect(() => { if (!receipt) scanRef.current?.focus() }, [receipt, cart.length])

  useEffect(() => {
    if (!providerId) { setOverrides(new Map()); return }
    void loadCoverageOverrides(providerId).then(setOverrides).catch(reason => setError(reason instanceof Error ? reason.message : t("salesPage.coverageLoadError")))
  }, [providerId, t])

  const selectedProvider = providers.find(p => p.id === providerId) ?? null

  async function handleScan() {
    const code = scanInput.trim()
    if (!code || scanning) return
    if (cart.some(item => item.code.toUpperCase() === code.toUpperCase())) {
      setError(t("salesPage.cartDuplicateError", { code }))
      setScanInput("")
      return
    }
    setScanning(true)
    setError("")
    try {
      const item = await scanBarcode(code, taxRates)
      setCart(current => [...current, item])
      setQuantities(current => new Map(current).set(item.barcodeId, item.piecesPerPack ?? 1))
      setScanInput("")
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : t("salesPage.scanError"))
    } finally {
      setScanning(false)
    }
  }

  function removeLine(barcodeId: string) {
    setCart(current => current.filter(item => item.barcodeId !== barcodeId))
    setQuantities(current => { const next = new Map(current); next.delete(barcodeId); return next })
  }

  // Clamped to [1, piecesPerPack]: selling more than the pack physically
  // holds, or zero/negative, is never a valid edit.
  function setLineQuantity(item: ScannedBarcode, raw: string) {
    const max = item.piecesPerPack ?? 1
    const parsed = Number.parseInt(raw, 10)
    const clamped = Number.isFinite(parsed) ? Math.min(Math.max(parsed, 1), max) : 1
    setQuantities(current => new Map(current).set(item.barcodeId, clamped))
  }

  const lines = cart.map(item => priceLine(item, quantities.get(item.barcodeId) ?? item.piecesPerPack ?? 1, selectedProvider ? effectiveCoveragePercentage(selectedProvider, overrides, item.productId) : 0))
  const subtotal = lines.reduce((sum, l) => sum + l.sellingPrice * l.sellQty, 0)
  const taxTotal = lines.reduce((sum, l) => sum + l.taxAmount, 0)
  const insuranceCoveredTotal = lines.reduce((sum, l) => sum + l.insuranceCovered, 0)
  const grandTotal = subtotal + taxTotal
  const patientOwedTotal = grandTotal - insuranceCoveredTotal

  async function handleCompleteSale() {
    if (cart.length === 0 || completing) return
    setCompleting(true)
    setError("")
    try {
      // Optional: only actually recorded if the cashier gave both a name and
      // a phone/TIN. A sale is never blocked on this -- self-pay/anonymous
      // stays a one-click checkout.
      let patientId: string | null = null
      if (patientDraft.fullName.trim() && patientDraft.identifier.trim()) {
        patientId = await upsertPatient(
          patientDraft.fullName.trim(),
          patientDraft.gender || null,
          patientDraft.age.trim() ? Number.parseInt(patientDraft.age, 10) : null,
          patientDraft.identifier.trim(),
        )
      }
      const result = await completeSale(
        cart.map(item => ({ code: item.code, quantity: quantities.get(item.barcodeId) ?? item.piecesPerPack ?? 1 })),
        providerId || null, patientId,
      )
      const fullReceipt = await getSaleReceipt(result.saleId)
      setReceipt(fullReceipt)
      setCart([])
      setQuantities(new Map())
      setProviderId("")
      setPatientDraft(BLANK_PATIENT)
      setNotice(t("salesPage.saleCompletedNotice"))
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : t("salesPage.completeSaleError"))
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
    <div className="animate-fade-in">
      {error && <CenterAlert key={error} message={error} />}
      <SectionHeader title={t("page.sales")} subtitle={t("salesPage.subtitle")} />

      <div style={{ display: "flex", gap: 16, alignItems: "flex-start", flexWrap: "wrap" }}>
        {/* Left: patient + scan + cart */}
        <div style={{ flex: "2 1 460px", minWidth: 340 }}>
          <PatientStep draft={patientDraft} onChange={setPatientDraft} onClear={() => setPatientDraft(BLANK_PATIENT)} resolvedId={null} />

          <div style={{ background: "#fff", border: "1px solid var(--border)", borderRadius: 12, padding: 16, marginBottom: 14 }}>
            <div style={{ display: "flex", gap: 8 }}>
              <input
                ref={scanRef}
                value={scanInput}
                onChange={e => setScanInput(e.target.value)}
                onKeyDown={e => { if (e.key === "Enter") void handleScan() }}
                placeholder={t("salesPage.scanPlaceholder")}
                disabled={scanning}
                autoFocus
                style={{ flex: 1, padding: "10px 12px", borderRadius: 8, border: "1px solid var(--border)", fontSize: 14, fontFamily: "inherit", outline: "none" }}
              />
              <Btn variant="primary" onClick={() => void handleScan()}>{scanning ? t("salesPage.scanLookingUp") : t("salesPage.scanAdd")}</Btn>
            </div>
          </div>

          <div style={{ background: "#fff", border: "1px solid var(--border)", borderRadius: 12, overflow: "hidden" }}>
            {lines.length === 0 ? (
              <div style={{ padding: 40, textAlign: "center", color: "var(--ink-muted)", fontSize: 13 }}>{t("salesPage.cartEmpty")}</div>
            ) : (
              <div>
                {lines.map(line => (
                  <div key={line.barcodeId} style={{ display: "flex", justifyContent: "space-between", alignItems: "center", padding: "12px 16px", borderBottom: "1px solid var(--bg-alt)", gap: 10 }}>
                    <div style={{ minWidth: 0 }}>
                      <div style={{ fontWeight: 600, fontSize: 13, color: "var(--ink)", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
                        {line.productName}{line.dosage ? ` · ${line.dosage}` : ""}{line.form ? ` · ${line.form}` : ""}
                      </div>
                      <div style={{ fontSize: 11, color: "var(--ink-muted)", fontFamily: "var(--font-mono)" }}>{line.code} · {t("salesPage.lineTaxPrefix")} {line.taxRatePercentage}%</div>
                      {(line.piecesPerPack ?? 1) > 1 ? (
                        <div style={{ display: "flex", alignItems: "center", gap: 6, marginTop: 4 }}>
                          <span style={{ fontSize: 10, color: "var(--ink-muted)" }}>{t("salesPage.sellQtyLabel")}</span>
                          <input
                            type="number" min={1} max={line.piecesPerPack ?? 1} value={line.sellQty}
                            onChange={e => setLineQuantity(line, e.target.value)}
                            style={{ width: 50, padding: "3px 6px", border: "1px solid var(--border)", borderRadius: 5, fontSize: 11, fontFamily: "inherit" }}
                          />
                          <span style={{ fontSize: 10, color: "var(--ink-faint)" }}>{t("salesPage.sellQtyOfTotal", { total: line.piecesPerPack ?? 1 })}</span>
                          {line.sellQty < (line.piecesPerPack ?? 1) && (
                            <span style={{ fontSize: 10, color: "#16a34a" }}>{t("salesPage.sellQtyRemainderHint", { remaining: (line.piecesPerPack ?? 1) - line.sellQty })}</span>
                          )}
                        </div>
                      ) : (
                        <div style={{ fontSize: 10, color: "var(--ink-faint)", marginTop: 2 }}>{t("salesPage.piecesUnit", { count: 1 })}</div>
                      )}
                    </div>
                    <div style={{ textAlign: "right", flexShrink: 0 }}>
                      <div style={{ fontWeight: 700, fontSize: 13, color: "var(--ink)" }}>{fmtRWFExact(line.lineTotal)}</div>
                      {line.insuranceCovered > 0 && <div style={{ fontSize: 11, color: "#16a34a" }}>-{fmtRWFExact(line.insuranceCovered)} {t("salesPage.insuranceSuffix")}</div>}
                    </div>
                    <button onClick={() => removeLine(line.barcodeId)} title={t("salesPage.removeLineTitle")} style={{ background: "none", border: "none", cursor: "pointer", color: "var(--ink-faint)", fontSize: 16, padding: "0 4px" }}>×</button>
                  </div>
                ))}
              </div>
            )}
          </div>
        </div>

        {/* Right: insurance + totals + complete */}
        <div style={{ flex: "1 1 300px", minWidth: 280, background: "#fff", border: "1px solid var(--border)", borderRadius: 12, padding: 16, position: "sticky", top: 0 }}>
          <div style={{ fontSize: 11, fontWeight: 700, color: "var(--ink-muted)", textTransform: "uppercase", letterSpacing: "0.05em", marginBottom: 8 }}>{t("salesPage.paymentLabel")}</div>
          <select
            value={providerId}
            onChange={e => setProviderId(e.target.value)}
            style={{ width: "100%", padding: "9px 10px", borderRadius: 8, border: "1px solid var(--border)", fontSize: 13, fontFamily: "inherit", marginBottom: 16, background: "#fff" }}
          >
            <option value="">{t("salesPage.selfPayOption")}</option>
            {providers.map(p => <option key={p.id} value={p.id}>{t("salesPage.providerOption", { name: p.name, pct: p.defaultCoveragePercentage })}</option>)}
          </select>

          <div style={{ display: "flex", flexDirection: "column", gap: 6, fontSize: 13, paddingBottom: 12, borderBottom: "1px solid var(--bg-alt)", marginBottom: 12 }}>
            <div style={{ display: "flex", justifyContent: "space-between", color: "var(--ink-mid)" }}><span>{t("salesPage.subtotal")}</span><span>{fmtRWFExact(subtotal)}</span></div>
            <div style={{ display: "flex", justifyContent: "space-between", color: "var(--ink-mid)" }}><span>{t("salesPage.tax")}</span><span>{fmtRWFExact(taxTotal)}</span></div>
            {selectedProvider && (
              <div style={{ display: "flex", justifyContent: "space-between", color: "#16a34a" }}><span>{t("salesPage.insuranceCovers")}</span><span>-{fmtRWFExact(insuranceCoveredTotal)}</span></div>
            )}
          </div>
          <div style={{ display: "flex", justifyContent: "space-between", fontWeight: 800, fontSize: 17, color: "var(--ink)", marginBottom: 16 }}>
            <span>{t("salesPage.patientOwes")}</span><span>{fmtRWFExact(patientOwedTotal)}</span>
          </div>

          <Btn
            variant="primary"
            style={{ width: "100%", justifyContent: "center", padding: "12px 16px", fontSize: 14, opacity: cart.length === 0 || completing ? 0.55 : 1, cursor: cart.length === 0 || completing ? "not-allowed" : "pointer" }}
            onClick={() => void handleCompleteSale()}
          >
            {completing ? t("salesPage.completingButton") : t("salesPage.completeSaleButton", { count: cart.length })}
          </Btn>
        </div>
      </div>
    </div>
  )
}
