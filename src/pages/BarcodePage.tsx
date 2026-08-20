import { useState, useRef, useEffect, useCallback } from 'react'
import Barcode from 'react-barcode'
import {
  barcodeSessions, scanHistory, inventoryItems, categoryCode,
  generatePieceBarcode, generateBulkBarcode,
  type BarcodeSession, type ScanEvent,
} from '../data'
import { Card, SectionHeader, StatusBadge, Btn, Modal } from '../components'

// ─── Constants ────────────────────────────────────────────────────────────────

const CATEGORIES = [
  'Antibiotics', 'Analgesics', 'Vitamins', 'Antidiabetics',
  'Cardiovascular', 'Respiratory', 'Dermatology', 'Gastrointestinal', 'Other',
]

// ─── Tiny helpers ─────────────────────────────────────────────────────────────

function Field({
  label, children, required,
}: { label: string; children: React.ReactNode; required?: boolean }) {
  return (
    <div>
      <label style={{ fontSize: 11, fontWeight: 600, color: 'var(--ink-muted)', textTransform: 'uppercase', letterSpacing: '0.05em', display: 'block', marginBottom: 5 }}>
        {label}{required && <span style={{ color: '#dc2626', marginLeft: 3 }}>*</span>}
      </label>
      {children}
    </div>
  )
}

function Input({ value, onChange, placeholder, type = 'text', ...rest }: any) {
  return (
    <input
      type={type} value={value} onChange={onChange} placeholder={placeholder}
      {...rest}
      style={{
        width: '100%', padding: '9px 11px', border: '1px solid var(--border)',
        borderRadius: 8, fontSize: 13, fontFamily: 'inherit', outline: 'none',
        background: '#fff', color: 'var(--ink)', transition: 'border 0.15s',
        ...(rest.style || {}),
      }}
      onFocus={e => { e.target.style.borderColor = 'var(--primary)'; e.target.style.boxShadow = '0 0 0 3px var(--primary-light)' }}
      onBlur={e => { e.target.style.borderColor = 'var(--border)'; e.target.style.boxShadow = 'none' }}
    />
  )
}

function Select({ value, onChange, children }: any) {
  return (
    <select value={value} onChange={onChange} style={{
      width: '100%', padding: '9px 11px', border: '1px solid var(--border)',
      borderRadius: 8, fontSize: 13, fontFamily: 'inherit', outline: 'none',
      background: '#fff', color: 'var(--ink', cursor: 'pointer',
    }}>
      {children}
    </select>
  )
}

// ─── Step indicator ───────────────────────────────────────────────────────────

function StepBar({ step, steps }: { step: number; steps: string[] }) {
  return (
    <div style={{ display: 'flex', alignItems: 'center', marginBottom: 28, gap: 0 }}>
      {steps.map((label, i) => {
        const done    = i < step
        const current = i === step
        return (
          <div key={i} style={{ display: 'flex', alignItems: 'center', flex: i < steps.length - 1 ? 1 : 0 }}>
            <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', gap: 4 }}>
              <div style={{
                width: 32, height: 32, borderRadius: '50%', display: 'flex', alignItems: 'center', justifyContent: 'center',
                fontWeight: 700, fontSize: 13,
                background: done ? 'var(--primary)' : current ? 'var(--primary)' : 'var(--bg-alt)',
                color: done || current ? '#fff' : 'var(--ink-muted)',
                border: current ? '2px solid var(--primary)' : done ? 'none' : '1.5px solid var(--border)',
                transition: 'all 0.2s',
              }}>
                {done ? '✓' : i + 1}
              </div>
              <div style={{ fontSize: 10, fontWeight: current ? 700 : 400, color: current ? 'var(--primary)' : done ? 'var(--ink-mid)' : 'var(--ink-faint)', whiteSpace: 'nowrap' }}>
                {label}
              </div>
            </div>
            {i < steps.length - 1 && (
              <div style={{ flex: 1, height: 2, background: done ? 'var(--primary)' : 'var(--border)', margin: '0 6px', marginBottom: 18, transition: 'background 0.3s' }} />
            )}
          </div>
        )
      })}
    </div>
  )
}

// ─── Single Barcode Label Preview ─────────────────────────────────────────────

function BarcodeLabel({ code, name, expiry, pieceNum, total, small = false }: {
  code: string; name: string; expiry: string; pieceNum?: number; total?: number; small?: boolean
}) {
  return (
    <div style={{
      border: '1px solid var(--border)', borderRadius: 8, padding: small ? '8px 10px' : '12px 14px',
      background: '#fff', display: 'flex', flexDirection: 'column', alignItems: 'center', gap: 4,
      width: small ? 160 : 200, flexShrink: 0,
    }}>
      <div style={{ fontSize: small ? 9 : 10, fontWeight: 700, color: 'var(--ink)', textAlign: 'center', lineHeight: 1.2, maxWidth: '100%', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
        {name}
      </div>
      <Barcode
        value={code}
        width={small ? 1.0 : 1.4}
        height={small ? 38 : 52}
        fontSize={small ? 7 : 9}
        margin={2}
        background="transparent"
        lineColor="#0c1e12"
        displayValue
      />
      <div style={{ fontSize: small ? 8 : 9, color: 'var(--ink-muted)', textAlign: 'center' }}>
        Exp: {expiry}
        {pieceNum !== undefined && total !== undefined && ` · Piece ${pieceNum}/${total}`}
      </div>
    </div>
  )
}

// ─── Bulk Barcode Label ───────────────────────────────────────────────────────

function BulkBarcodeLabel({ code, name, qty, expiry }: { code: string; name: string; qty: number; expiry: string }) {
  return (
    <div style={{
      border: '2px solid var(--primary)', borderRadius: 12, padding: '18px 24px',
      background: 'linear-gradient(135deg, #f0fdf4 0%, #ecfdf5 100%)',
      display: 'flex', flexDirection: 'column', alignItems: 'center', gap: 8,
      maxWidth: 340, margin: '0 auto',
    }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 4 }}>
        <span style={{ fontSize: 20 }}>▦</span>
        <span style={{ fontSize: 13, fontWeight: 700, color: 'var(--primary)' }}>BULK BARCODE — {qty} PIECES</span>
      </div>
      <div style={{ fontSize: 14, fontWeight: 700, color: 'var(--ink)', textAlign: 'center' }}>{name}</div>
      <Barcode
        value={code}
        width={2.2}
        height={72}
        fontSize={11}
        margin={4}
        background="transparent"
        lineColor="#1e8a4a"
        displayValue
      />
      <div style={{ fontSize: 11, color: 'var(--ink-muted)' }}>
        Scan this once → {qty} units enter stock automatically
      </div>
      <div style={{ fontSize: 10, color: 'var(--ink-faint)' }}>Exp: {expiry}</div>
    </div>
  )
}

// ─── STEP 1: Medicine Details ─────────────────────────────────────────────────

interface FormData {
  name: string; category: string; expiry: string; unitPrice: string
  batch: string; supplier: string; reorderPoint: string; quantity: string
  prescription: boolean; notes: string
}

const EMPTY_FORM: FormData = {
  name: '', category: 'Antibiotics', expiry: '', unitPrice: '',
  batch: '', supplier: '', reorderPoint: '', quantity: '',
  prescription: false, notes: '',
}

function Step1({ form, setForm }: { form: FormData; setForm: React.Dispatch<React.SetStateAction<FormData>> }) {
  const set = (k: keyof FormData) => (e: any) => setForm(f => ({ ...f, [k]: e.target.value }))
  const setBool = (k: keyof FormData) => (e: any) => setForm(f => ({ ...f, [k]: e.target.checked }))

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 14 }}>
      <div style={{ background: 'var(--primary-light)', borderRadius: 8, padding: '10px 14px', fontSize: 12, color: 'var(--ink-mid)', border: '1px solid var(--border-strong)' }}>
        <strong>How it works:</strong> Fill in the medicine details below. The system will generate a unique barcode for each piece, plus one master bulk barcode for the entire box. Print the labels, stick them on each piece, then scan the bulk barcode to add all pieces to stock at once.
      </div>

      <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 12 }}>
        <Field label="Medicine Name" required>
          <Input value={form.name} onChange={set('name')} placeholder="e.g. Amoxicillin 500mg" />
        </Field>
        <Field label="Category" required>
          <Select value={form.category} onChange={set('category')}>
            {CATEGORIES.map(c => <option key={c}>{c}</option>)}
          </Select>
        </Field>
        <Field label="Expiry Date" required>
          <Input type="month" value={form.expiry} onChange={set('expiry')} />
        </Field>
        <Field label="Unit Price (RWF)" required>
          <Input type="number" value={form.unitPrice} onChange={set('unitPrice')} placeholder="e.g. 1500" />
        </Field>
        <Field label="Batch Number" required>
          <Input value={form.batch} onChange={set('batch')} placeholder="e.g. BT-2026-001" />
        </Field>
        <Field label="Supplier">
          <Input value={form.supplier} onChange={set('supplier')} placeholder="e.g. MedPharm Supplies" />
        </Field>
        <Field label="Number of Pieces (this box)" required>
          <Input type="number" value={form.quantity} onChange={set('quantity')} placeholder="e.g. 40" min="1" max="999" />
        </Field>
        <Field label="Reorder Point (units)">
          <Input type="number" value={form.reorderPoint} onChange={set('reorderPoint')} placeholder="e.g. 100" />
        </Field>
      </div>

      <Field label="Notes / Storage Instructions">
        <textarea value={form.notes} onChange={set('notes')} placeholder="e.g. Store below 25°C. Keep away from direct sunlight."
          rows={2} style={{ width: '100%', padding: '9px 11px', border: '1px solid var(--border)', borderRadius: 8, fontSize: 13, fontFamily: 'inherit', outline: 'none', resize: 'vertical' }}
          onFocus={e => { e.target.style.borderColor = 'var(--primary)' }}
          onBlur={e => { e.target.style.borderColor = 'var(--border)' }}
        />
      </Field>

      <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
        <input type="checkbox" id="rx" checked={form.prescription} onChange={setBool('prescription')} style={{ width: 16, height: 16, accentColor: 'var(--primary)', cursor: 'pointer' }} />
        <label htmlFor="rx" style={{ fontSize: 13, color: 'var(--ink)', cursor: 'pointer', fontWeight: 500 }}>
          Prescription Required (Rx) — patient must present a prescription for this medicine
        </label>
      </div>
    </div>
  )
}

// ─── STEP 2: Individual Barcodes ──────────────────────────────────────────────

function Step2({ session }: { session: BarcodeSession }) {
  const [showAll, setShowAll] = useState(false)
  const visible = showAll ? session.piecesBarcodes : session.piecesBarcodes.slice(0, 8)

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 16 }}>
      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(3, 1fr)', gap: 10 }}>
        <div style={{ background: 'var(--bg)', borderRadius: 10, padding: '14px 16px', textAlign: 'center' }}>
          <div style={{ fontSize: 28, fontWeight: 800, color: 'var(--primary)', fontFamily: 'DM Sans' }}>{session.quantity}</div>
          <div style={{ fontSize: 11, color: 'var(--ink-muted)', fontWeight: 500 }}>Total Pieces</div>
        </div>
        <div style={{ background: 'var(--bg)', borderRadius: 10, padding: '14px 16px', textAlign: 'center' }}>
          <div style={{ fontSize: 28, fontWeight: 800, color: '#059669', fontFamily: 'DM Sans' }}>{session.quantity}</div>
          <div style={{ fontSize: 11, color: 'var(--ink-muted)', fontWeight: 500 }}>Barcodes Generated</div>
        </div>
        <div style={{ background: 'var(--bg)', borderRadius: 10, padding: '14px 16px', textAlign: 'center' }}>
          <div style={{ fontSize: 28, fontWeight: 800, color: '#0284c7', fontFamily: 'DM Sans' }}>1</div>
          <div style={{ fontSize: 11, color: 'var(--ink-muted)', fontWeight: 500 }}>Bulk Barcode</div>
        </div>
      </div>

      <div style={{ background: '#fffbeb', border: '1px solid #fcd34d', borderRadius: 8, padding: '10px 14px', fontSize: 12, color: '#92400e' }}>
        <strong>⚠️ Print & Label:</strong> Print the barcodes below and stick one label on each piece of medicine. Every piece has a unique barcode number. The bulk barcode (Step 3) can be used instead of scanning all {session.quantity} individual pieces.
      </div>

      {/* Individual barcode grid */}
      <div>
        <div style={{ fontSize: 13, fontWeight: 600, color: 'var(--ink)', marginBottom: 10 }}>
          Individual Piece Barcodes — {session.product.name}
          <span style={{ fontSize: 11, color: 'var(--ink-muted)', fontWeight: 400, marginLeft: 8 }}>
            ({visible.length} of {session.quantity} shown)
          </span>
        </div>
        <div style={{ display: 'flex', flexWrap: 'wrap', gap: 10, padding: '12px', background: 'var(--bg)', borderRadius: 10, border: '1px solid var(--border)' }}>
          {visible.map(pb => (
            <BarcodeLabel
              key={pb.code}
              code={pb.code}
              name={session.product.name}
              expiry={session.product.expiry}
              pieceNum={pb.pieceNumber}
              total={session.quantity}
              small
            />
          ))}
        </div>
        {!showAll && session.quantity > 8 && (
          <button onClick={() => setShowAll(true)} style={{
            marginTop: 8, width: '100%', padding: '9px', border: '1px dashed var(--border)', borderRadius: 8,
            background: 'none', color: 'var(--ink-muted)', fontSize: 12, cursor: 'pointer', fontFamily: 'inherit',
          }}>
            Show all {session.quantity} barcodes ↓
          </button>
        )}
      </div>

      <div style={{ display: 'flex', gap: 8 }}>
        <Btn variant="primary" onClick={() => window.print()}>🖨 Print All Labels</Btn>
        <Btn variant="secondary">⬇ Download PDF</Btn>
        <Btn variant="ghost">⬇ Download PNG</Btn>
      </div>
    </div>
  )
}

// ─── STEP 3: Bulk Barcode ─────────────────────────────────────────────────────

function Step3({ session }: { session: BarcodeSession }) {
  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 20 }}>
      <div style={{ background: 'var(--primary-light)', border: '1px solid var(--border-strong)', borderRadius: 8, padding: '12px 16px', fontSize: 13, color: 'var(--ink-mid)' }}>
        <strong style={{ color: 'var(--ink)' }}>🚀 Bulk Barcode — One Scan, {session.quantity} Pieces</strong>
        <p style={{ margin: '6px 0 0', lineHeight: 1.6 }}>
          Instead of scanning all {session.quantity} individual barcodes one by one, print this <strong>single bulk barcode</strong> and stick it on the <em>box</em> or delivery note.
          When you scan it in the Scanner tab, the system will instantly add all {session.quantity} units of <strong>{session.product.name}</strong> to stock.
        </p>
      </div>

      <BulkBarcodeLabel
        code={session.bulkBarcode}
        name={session.product.name}
        qty={session.quantity}
        expiry={session.product.expiry}
      />

      <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 10 }}>
        {[
          ['Product', session.product.name],
          ['Category', session.product.category],
          ['Total Pieces', `${session.quantity} units`],
          ['Unit Price', `RWF ${Number(session.product.unitPrice).toLocaleString()}`],
          ['Batch', session.product.batch],
          ['Expiry', session.product.expiry],
          ['Supplier', session.product.supplier || '—'],
          ['Prescription', session.product.prescription ? 'Required (Rx)' : 'Not Required'],
        ].map(([l, v]) => (
          <div key={l} style={{ background: 'var(--bg)', borderRadius: 8, padding: '10px 12px', display: 'flex', justifyContent: 'space-between', gap: 8 }}>
            <span style={{ fontSize: 11, color: 'var(--ink-muted)', fontWeight: 500 }}>{l}</span>
            <span style={{ fontSize: 12, fontWeight: 600, color: 'var(--ink)', textAlign: 'right' }}>{v}</span>
          </div>
        ))}
      </div>

      <div style={{ display: 'flex', gap: 8 }}>
        <Btn variant="primary">🖨 Print Bulk Label</Btn>
        <Btn variant="secondary">⬇ Download PNG</Btn>
      </div>
    </div>
  )
}

// ─── STEP 4: Add to Stock ─────────────────────────────────────────────────────

function Step4({ session, onComplete }: { session: BarcodeSession; onComplete: () => void }) {
  const [added, setAdded] = useState(false)

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 20, alignItems: 'center', textAlign: 'center', padding: '10px 0' }}>
      {!added ? (
        <>
          <div style={{ fontSize: 48 }}>📦</div>
          <div style={{ fontSize: 18, fontWeight: 700, color: 'var(--ink)', fontFamily: 'DM Sans' }}>
            Ready to Add to Stock
          </div>
          <div style={{ fontSize: 13, color: 'var(--ink-muted)', maxWidth: 420, lineHeight: 1.7 }}>
            All {session.quantity} barcodes for <strong>{session.product.name}</strong> have been generated and are ready to print.
            <br /><br />
            <strong>Option A:</strong> Scan the <em>bulk barcode</em> in the Scanner tab to auto-add all {session.quantity} pieces.<br />
            <strong>Option B:</strong> Click below to add them to stock immediately without scanning.
          </div>
          <div style={{ display: 'flex', gap: 10 }}>
            <Btn variant="ghost" onClick={onComplete}>Go to Scanner ▦</Btn>
            <Btn variant="primary" onClick={() => setAdded(true)} style={{ fontSize: 14, padding: '10px 24px' }}>
              ✓ Add {session.quantity} Units to Stock Now
            </Btn>
          </div>
        </>
      ) : (
        <>
          <div style={{ fontSize: 56 }}>✅</div>
          <div style={{ fontSize: 20, fontWeight: 700, color: 'var(--positive)', fontFamily: 'DM Sans' }}>
            {session.quantity} Units Added to Stock!
          </div>
          <div style={{ background: '#f0fdf4', border: '1px solid #86efac', borderRadius: 10, padding: '16px 24px', fontSize: 13, color: 'var(--ink-mid)' }}>
            <strong>{session.product.name}</strong> — {session.quantity} pieces<br />
            Batch: {session.product.batch} · Expiry: {session.product.expiry}<br />
            Category: {session.product.category}
          </div>
          <Btn variant="primary" onClick={onComplete} style={{ fontSize: 14, padding: '10px 24px' }}>
            ✓ Done — Back to Barcode Manager
          </Btn>
        </>
      )}
    </div>
  )
}

// ─── Generate Wizard ──────────────────────────────────────────────────────────

function GenerateWizard({ onClose }: { onClose: () => void }) {
  const [step, setStep] = useState(0)
  const [form, setForm]   = useState<FormData>(EMPTY_FORM)
  const [session, setSession] = useState<BarcodeSession | null>(null)

  const STEPS = ['Medicine Details', 'Individual Barcodes', 'Bulk Barcode', 'Add to Stock']

  const isStep1Valid = form.name && form.expiry && form.unitPrice && form.batch && form.quantity && Number(form.quantity) > 0

  function generate() {
    const qty     = parseInt(form.quantity, 10)
    const catCode = categoryCode(form.category)
    const yyyymm  = form.expiry.replace('-', '').slice(0, 6)
    const sid     = `BS-2026-${String(Math.floor(Math.random() * 900) + 100)}`

    const pieces = Array.from({ length: qty }, (_, i) => ({
      code: generatePieceBarcode(sid, catCode, form.expiry, i + 1),
      pieceNumber: i + 1,
      status: 'generated' as const,
    }))

    const bulk = generateBulkBarcode(sid, qty)

    const newSession: BarcodeSession = {
      id: sid,
      createdAt: new Date().toLocaleString(),
      product: {
        name: form.name, category: form.category,
        expiry: form.expiry, unitPrice: Number(form.unitPrice),
        batch: form.batch, supplier: form.supplier,
        reorderPoint: Number(form.reorderPoint) || 100,
        prescription: form.prescription, notes: form.notes,
      },
      quantity: qty,
      piecesBarcodes: pieces,
      bulkBarcode: bulk,
      addedToStock: false,
    }
    setSession(newSession)
    setStep(1)
  }

  return (
    <Modal title="Generate Barcodes — New Medicine" onClose={onClose} width={780}>
      <StepBar step={step} steps={STEPS} />

      {step === 0 && <Step1 form={form} setForm={setForm} />}
      {step === 1 && session && <Step2 session={session} />}
      {step === 2 && session && <Step3 session={session} />}
      {step === 3 && session && <Step4 session={session} onComplete={onClose} />}

      {step < 3 && (
        <div style={{ display: 'flex', gap: 8, justifyContent: 'flex-end', marginTop: 20, paddingTop: 14, borderTop: '1px solid var(--border)' }}>
          {step > 0 && <Btn variant="ghost" onClick={() => setStep(s => s - 1)}>← Back</Btn>}
          <div style={{ flex: 1 }} />
          <Btn variant="ghost" onClick={onClose}>Cancel</Btn>
          {step === 0 && (
            <Btn variant="primary" onClick={generate}
              style={{ opacity: isStep1Valid ? 1 : 0.45, cursor: isStep1Valid ? 'pointer' : 'not-allowed' }}>
              Generate Barcodes →
            </Btn>
          )}
          {step === 1 && <Btn variant="primary" onClick={() => setStep(2)}>View Bulk Barcode →</Btn>}
          {step === 2 && <Btn variant="primary" onClick={() => setStep(3)}>Add to Stock →</Btn>}
        </div>
      )}
    </Modal>
  )
}

// ─── Scan-to-Sale Prompt Modal ────────────────────────────────────────────────

interface ScanSalePromptProps {
  productName: string
  price: number
  onAdd: (qty: number, payment: string) => void
  onClose: () => void
}

function ScanSalePrompt({ productName, price, onAdd, onClose }: ScanSalePromptProps) {
  const [qty, setQty]         = useState(1)
  const [payment, setPayment] = useState('Cash')

  return (
    <div
      style={{ position: 'fixed', inset: 0, zIndex: 400, background: 'rgba(13,31,18,0.5)', display: 'flex', alignItems: 'center', justifyContent: 'center', padding: 20 }}
      onClick={onClose}
    >
      <div
        style={{ background: '#fff', borderRadius: 16, width: '100%', maxWidth: 420, boxShadow: '0 32px 80px rgba(0,0,0,0.18)', overflow: 'hidden' }}
        onClick={e => e.stopPropagation()}
      >
        {/* Header */}
        <div style={{ background: 'linear-gradient(135deg, #ecfdf5, #f0fdf4)', padding: '18px 20px', borderBottom: '1px solid var(--border)', display: 'flex', gap: 12, alignItems: 'center' }}>
          <div style={{ fontSize: 28 }}>🧾</div>
          <div>
            <div style={{ fontSize: 15, fontWeight: 800, color: 'var(--ink)', fontFamily: 'DM Sans' }}>{productName}</div>
            <div style={{ fontSize: 12, color: 'var(--ink-muted)', marginTop: 2 }}>RWF {price.toLocaleString()} per unit</div>
          </div>
          <button onClick={onClose} style={{ marginLeft: 'auto', background: 'none', border: 'none', cursor: 'pointer', fontSize: 20, color: 'var(--ink-muted)', lineHeight: 1 }}>×</button>
        </div>

        {/* Body */}
        <div style={{ padding: '18px 20px', display: 'flex', flexDirection: 'column', gap: 14 }}>
          {/* Qty */}
          <div>
            <div style={{ fontSize: 11, fontWeight: 600, color: 'var(--ink-muted)', textTransform: 'uppercase', letterSpacing: '0.05em', marginBottom: 8 }}>Quantity</div>
            <div style={{ display: 'flex', alignItems: 'center', gap: 12 }}>
              <button onClick={() => setQty(q => Math.max(1, q - 1))}
                style={{ width: 36, height: 36, borderRadius: 9, border: '1.5px solid var(--border)', background: '#fff', cursor: 'pointer', fontSize: 18, fontWeight: 700, color: 'var(--ink)', lineHeight: 1 }}>−</button>
              <span style={{ fontSize: 26, fontWeight: 800, color: 'var(--ink)', fontFamily: 'DM Sans', minWidth: 32, textAlign: 'center' }}>{qty}</span>
              <button onClick={() => setQty(q => q + 1)}
                style={{ width: 36, height: 36, borderRadius: 9, border: '1.5px solid var(--primary)', background: 'var(--primary-light)', cursor: 'pointer', fontSize: 18, fontWeight: 700, color: 'var(--primary)', lineHeight: 1 }}>+</button>
            </div>
          </div>

          {/* Payment */}
          <div>
            <div style={{ fontSize: 11, fontWeight: 600, color: 'var(--ink-muted)', textTransform: 'uppercase', letterSpacing: '0.05em', marginBottom: 8 }}>Payment Method</div>
            <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap' }}>
              {['Cash', 'MTN MoMo', 'Airtel Money', 'Insurance', 'Card'].map(m => (
                <button key={m} onClick={() => setPayment(m)} style={{
                  padding: '7px 12px', borderRadius: 8, border: `1.5px solid ${payment === m ? 'var(--primary)' : 'var(--border)'}`,
                  background: payment === m ? 'var(--primary-light)' : '#fff',
                  color: payment === m ? 'var(--primary)' : 'var(--ink-muted)',
                  fontWeight: payment === m ? 700 : 400, fontSize: 12, cursor: 'pointer', fontFamily: 'inherit',
                }}>{m}</button>
              ))}
            </div>
          </div>

          {/* Total */}
          <div style={{ background: 'var(--bg)', borderRadius: 10, padding: '12px 16px', display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
            <span style={{ fontSize: 13, color: 'var(--ink-muted)', fontWeight: 500 }}>Total ({qty} × RWF {price.toLocaleString()})</span>
            <span style={{ fontSize: 20, fontWeight: 800, color: 'var(--primary)', fontFamily: 'DM Sans' }}>RWF {(price * qty).toLocaleString()}</span>
          </div>

          {/* Actions */}
          <div style={{ display: 'flex', gap: 8 }}>
            <Btn variant="ghost" onClick={onClose} style={{ flex: 1 }}>Add to Cart Instead</Btn>
            <Btn variant="primary" onClick={() => onAdd(qty, payment)} style={{ flex: 1 }}>✓ Sell Now</Btn>
          </div>
        </div>
      </div>
    </div>
  )
}

// ─── Scanner Tab ──────────────────────────────────────────────────────────────

function ScannerTab() {
  const [mode, setMode] = useState<'stock' | 'sale'>('stock')
  const [inputVal, setInputVal] = useState('')
  const [events, setEvents] = useState<ScanEvent[]>(scanHistory)
  const [lastResult, setLastResult] = useState<ScanEvent | null>(null)
  const inputRef = useRef<HTMLInputElement>(null)
  const [cartItems, setCartItems] = useState<Array<{ code: string; name: string; price: number; qty: number }>>([])
  const [salePrompt, setSalePrompt] = useState<{ name: string; price: number } | null>(null)
  const [lastSaleMsg, setLastSaleMsg] = useState<string | null>(null)

  useEffect(() => { inputRef.current?.focus() }, [])

  const resolveScan = useCallback((code: string): ScanEvent => {
    const trimmed = code.trim().toUpperCase()

    // Check bulk barcode
    const bulkSession = barcodeSessions.find(s => s.bulkBarcode.toUpperCase() === trimmed)
    if (bulkSession) {
      return {
        id: `SC-${Date.now()}`,
        timestamp: new Date().toLocaleString(),
        barcode: trimmed,
        resolvedType: 'bulk_stock',
        productName: bulkSession.product.name,
        quantity: bulkSession.quantity,
        message: `✅ Bulk barcode: ${bulkSession.quantity} × ${bulkSession.product.name} ready to add to stock`,
        success: true,
      }
    }

    // Check individual piece barcode in sessions
    for (const session of barcodeSessions) {
      const piece = session.piecesBarcodes.find(p => p.code.toUpperCase() === trimmed)
      if (piece) {
        if (mode === 'stock') {
          return {
            id: `SC-${Date.now()}`,
            timestamp: new Date().toLocaleString(),
            barcode: trimmed,
            resolvedType: 'piece_stock',
            productName: session.product.name,
            quantity: 1,
            message: `📦 Stock update: 1 × ${session.product.name} (Piece ${piece.pieceNumber}/${session.quantity}) added to stock`,
            success: true,
          }
        } else {
          return {
            id: `SC-${Date.now()}`,
            timestamp: new Date().toLocaleString(),
            barcode: trimmed,
            resolvedType: 'sale',
            productName: session.product.name,
            quantity: 1,
            message: `🧾 Sale: 1 × ${session.product.name} @ RWF ${session.product.unitPrice.toLocaleString()}`,
            success: true,
          }
        }
      }
    }

    // Check inventory by ID prefix
    const inv = inventoryItems.find(i => trimmed.includes(i.id) || trimmed.startsWith(i.id))
    if (inv) {
      return {
        id: `SC-${Date.now()}`,
        timestamp: new Date().toLocaleString(),
        barcode: trimmed,
        resolvedType: mode === 'stock' ? 'piece_stock' : 'sale',
        productName: inv.name,
        quantity: 1,
        message: mode === 'stock'
          ? `📦 Known product: 1 × ${inv.name} — added to stock`
          : `🧾 Sale: 1 × ${inv.name} @ RWF ${inv.unitPrice.toLocaleString()}`,
        success: true,
      }
    }

    return {
      id: `SC-${Date.now()}`,
      timestamp: new Date().toLocaleString(),
      barcode: trimmed,
      resolvedType: 'unknown',
      message: `❓ Unknown barcode — "${trimmed}" not in system. Register new product?`,
      success: false,
    }
  }, [mode])

  const addToCartDirectly = (name: string, code: string, price: number, qty: number) => {
    setCartItems(prev => {
      const ex = prev.find(c => c.name === name)
      if (ex) return prev.map(c => c.name === name ? { ...c, qty: c.qty + qty } : c)
      return [...prev, { code, name, price, qty }]
    })
  }

  const handleScan = () => {
    if (!inputVal.trim()) return
    const event = resolveScan(inputVal)
    setLastResult(event)
    setEvents(prev => [event, ...prev])

    // In sale mode, show popup prompt instead of silently adding to cart
    if (event.resolvedType === 'sale' && event.productName) {
      const price = barcodeSessions.find(s => s.product.name === event.productName)?.product.unitPrice
        ?? inventoryItems.find(i => i.name === event.productName)?.unitPrice ?? 0
      setSalePrompt({ name: event.productName, price })
    }

    setInputVal('')
    inputRef.current?.focus()
  }

  const handleKey = (e: React.KeyboardEvent) => {
    if (e.key === 'Enter') handleScan()
  }

  // Demo scan simulation
  const DEMO_CODES = [
    'PSBULK003840040',
    'PSANT20260838012',
    'PSADB20260839004',
    'UNKNOWN99123456',
  ]

  return (
    <>
      {salePrompt && (
        <ScanSalePrompt
          productName={salePrompt.name}
          price={salePrompt.price}
          onAdd={(qty, payment) => {
            addToCartDirectly(salePrompt.name, salePrompt.name, salePrompt.price, qty)
            setLastSaleMsg(`✅ Sold ${qty} × ${salePrompt.name} via ${payment} — RWF ${(salePrompt.price * qty).toLocaleString()}`)
            setSalePrompt(null)
          }}
          onClose={() => setSalePrompt(null)}
        />
      )}
    <div style={{ display: 'grid', gridTemplateColumns: '1fr 0.75fr', gap: 16, alignItems: 'start' }}>
      {/* Left: scanner */}
      <div style={{ display: 'flex', flexDirection: 'column', gap: 14 }}>
        {/* Mode toggle */}
        <div style={{ display: 'flex', gap: 0, background: 'var(--bg-alt)', borderRadius: 10, padding: 3, border: '1px solid var(--border)' }}>
          {([['stock', '📦 Stock Entry Mode'], ['sale', '🧾 Sale Mode']] as const).map(([m, l]) => (
            <button key={m} onClick={() => setMode(m)} style={{
              flex: 1, padding: '9px 16px', borderRadius: 8, border: 'none', cursor: 'pointer',
              background: mode === m ? '#fff' : 'transparent',
              color: mode === m ? 'var(--primary)' : 'var(--ink-muted)',
              fontWeight: mode === m ? 700 : 400, fontSize: 13, fontFamily: 'inherit',
              boxShadow: mode === m ? '0 1px 4px rgba(0,0,0,0.08)' : 'none',
              transition: 'all 0.18s',
            }}>{l}</button>
          ))}
        </div>

        {/* Mode info */}
        <div style={{
          background: mode === 'stock' ? '#f0fdf4' : '#eff6ff',
          border: `1px solid ${mode === 'stock' ? '#86efac' : '#bfdbfe'}`,
          borderRadius: 8, padding: '10px 14px', fontSize: 12,
          color: mode === 'stock' ? '#166534' : '#1e40af',
        }}>
          {mode === 'stock'
            ? '📦 Stock Mode: Scan any barcode to add it to inventory. Bulk barcode adds all pieces instantly. Individual barcode adds 1 piece.'
            : '🧾 Sale Mode: Scan medicine barcodes to build a sale. Each scan adds 1 unit to the cart. Complete the sale when done.'}
        </div>

        {/* Scan input */}
        <div style={{
          border: `2px solid ${mode === 'stock' ? 'var(--primary)' : '#0284c7'}`,
          borderRadius: 14, padding: '20px', background: '#fff',
          boxShadow: `0 0 0 6px ${mode === 'stock' ? 'var(--primary-light)' : '#e0f2fe'}`,
        }}>
          <div style={{ fontSize: 12, fontWeight: 600, color: 'var(--ink-muted)', textTransform: 'uppercase', letterSpacing: '0.06em', marginBottom: 10 }}>
            ▦ Scan Barcode or Type Code
          </div>
          <div style={{ display: 'flex', gap: 8 }}>
            <input
              ref={inputRef}
              value={inputVal}
              onChange={e => setInputVal(e.target.value)}
              onKeyDown={handleKey}
              placeholder="Point scanner here or type barcode code…"
              style={{
                flex: 1, padding: '12px 14px', border: '1px solid var(--border)', borderRadius: 9,
                fontSize: 14, fontFamily: 'JetBrains Mono, monospace', outline: 'none',
                background: 'var(--bg)', letterSpacing: '0.04em',
              }}
              onFocus={e => e.target.style.borderColor = 'var(--primary)'}
              onBlur={e => e.target.style.borderColor = 'var(--border)'}
              autoComplete="off"
            />
            <Btn variant="primary" onClick={handleScan} style={{ padding: '12px 20px', fontSize: 14 }}>Scan</Btn>
          </div>

          {/* Demo quick-scan buttons */}
          <div style={{ marginTop: 12 }}>
            <div style={{ fontSize: 10, color: 'var(--ink-faint)', marginBottom: 6, textTransform: 'uppercase', letterSpacing: '0.05em' }}>Demo — click to simulate scan:</div>
            <div style={{ display: 'flex', flexWrap: 'wrap', gap: 5 }}>
              {DEMO_CODES.map(c => (
                <button key={c} onClick={() => { setInputVal(c); setTimeout(handleScan, 50) }}
                  style={{
                    padding: '4px 8px', borderRadius: 5, border: '1px solid var(--border)',
                    background: '#fff', fontSize: 10, fontFamily: 'JetBrains Mono, monospace',
                    cursor: 'pointer', color: 'var(--ink-mid)', transition: 'background 0.12s',
                  }}
                  onMouseEnter={e => { (e.currentTarget as HTMLButtonElement).style.background = 'var(--primary-light)' }}
                  onMouseLeave={e => { (e.currentTarget as HTMLButtonElement).style.background = '#fff' }}
                >{c}</button>
              ))}
            </div>
          </div>
        </div>

        {/* Quick-sale success banner */}
        {lastSaleMsg && (
          <div style={{ padding: '12px 16px', borderRadius: 10, background: '#f0fdf4', border: '1.5px solid #86efac' }}>
            <div style={{ fontSize: 13, fontWeight: 600, color: '#16a34a' }}>{lastSaleMsg}</div>
            <button onClick={() => setLastSaleMsg(null)} style={{ fontSize: 11, color: 'var(--ink-faint)', background: 'none', border: 'none', cursor: 'pointer', marginTop: 4, fontFamily: 'inherit' }}>Dismiss</button>
          </div>
        )}

        {/* Last result banner */}
        {lastResult && !(lastResult.resolvedType === 'sale') && (
          <div style={{
            padding: '14px 16px', borderRadius: 10,
            background: lastResult.success ? '#f0fdf4' : '#fef2f2',
            border: `1.5px solid ${lastResult.success ? '#86efac' : '#fca5a5'}`,
            animation: 'fadeIn 0.3s',
          }}>
            <div style={{ fontSize: 13, fontWeight: 600, color: lastResult.success ? '#16a34a' : '#dc2626' }}>
              {lastResult.message}
            </div>
            {lastResult.resolvedType === 'unknown' && (
              <div style={{ marginTop: 8 }}>
                <Btn variant="primary" small>+ Register as New Product</Btn>
              </div>
            )}
            {lastResult.resolvedType === 'bulk_stock' && (
              <div style={{ marginTop: 8, fontSize: 12, color: 'var(--ink-mid)' }}>
                {lastResult.quantity} × {lastResult.productName} will be added to inventory. <button style={{ color: 'var(--primary)', background: 'none', border: 'none', cursor: 'pointer', fontWeight: 600, fontFamily: 'inherit', fontSize: 12 }}>Confirm →</button>
              </div>
            )}
          </div>
        )}

        {/* Scan history */}
        <Card style={{ padding: '14px 16px' }}>
          <SectionHeader title="Scan History" subtitle="Most recent scans" />
          <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
            {events.slice(0, 10).map(ev => {
              const icons: Record<string, string> = { bulk_stock: '▦', piece_stock: '📦', sale: '🧾', unknown: '❓' }
              const colors: Record<string, string> = { bulk_stock: '#1e8a4a', piece_stock: '#059669', sale: '#0284c7', unknown: '#dc2626' }
              return (
                <div key={ev.id} style={{
                  display: 'flex', gap: 10, alignItems: 'flex-start', padding: '7px 0',
                  borderBottom: '1px solid var(--bg-alt)',
                }}>
                  <span style={{ fontSize: 14, flexShrink: 0, marginTop: 1 }}>{icons[ev.resolvedType]}</span>
                  <div style={{ flex: 1, minWidth: 0 }}>
                    <div style={{ fontSize: 12, color: 'var(--ink)', fontWeight: 500, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{ev.message}</div>
                    <div style={{ fontSize: 10, color: 'var(--ink-faint)', marginTop: 1, fontFamily: 'JetBrains Mono, monospace' }}>{ev.barcode} · {ev.timestamp}</div>
                  </div>
                  <span style={{ fontSize: 10, fontWeight: 700, color: colors[ev.resolvedType], flexShrink: 0 }}>
                    {ev.resolvedType.replace('_', ' ').toUpperCase()}
                  </span>
                </div>
              )
            })}
          </div>
        </Card>
      </div>

      {/* Right: Sale cart / Stock confirm */}
      <div style={{ display: 'flex', flexDirection: 'column', gap: 12, position: 'sticky', top: 0 }}>
        {mode === 'sale' ? (
          <Card>
            <SectionHeader title={`Sale Cart (${cartItems.reduce((s, c) => s + c.qty, 0)} items)`} />
            {cartItems.length === 0 ? (
              <div style={{ textAlign: 'center', padding: '24px 0', color: 'var(--ink-faint)', fontSize: 13 }}>
                <div style={{ fontSize: 28, marginBottom: 6 }}>🧾</div>
                Scan medicines to build a sale
              </div>
            ) : (
              <>
                <div style={{ display: 'flex', flexDirection: 'column', gap: 6, marginBottom: 12 }}>
                  {cartItems.map(c => (
                    <div key={c.name} style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', padding: '8px 0', borderBottom: '1px solid var(--bg-alt)' }}>
                      <div style={{ flex: 1, minWidth: 0 }}>
                        <div style={{ fontSize: 12, fontWeight: 500, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{c.name}</div>
                        <div style={{ fontSize: 10, color: 'var(--ink-muted)' }}>RWF {c.price.toLocaleString()} × {c.qty}</div>
                      </div>
                      <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
                        <button onClick={() => setCartItems(p => p.map(x => x.name === c.name ? { ...x, qty: Math.max(1, x.qty - 1) } : x))}
                          style={{ width: 20, height: 20, borderRadius: 4, border: '1px solid var(--border)', background: '#fff', cursor: 'pointer', fontSize: 12 }}>−</button>
                        <span style={{ fontSize: 11, fontWeight: 700, minWidth: 16, textAlign: 'center' }}>{c.qty}</span>
                        <button onClick={() => setCartItems(p => p.map(x => x.name === c.name ? { ...x, qty: x.qty + 1 } : x))}
                          style={{ width: 20, height: 20, borderRadius: 4, border: '1px solid var(--border)', background: '#fff', cursor: 'pointer', fontSize: 12 }}>+</button>
                        <button onClick={() => setCartItems(p => p.filter(x => x.name !== c.name))}
                          style={{ marginLeft: 4, background: 'none', border: 'none', cursor: 'pointer', color: 'var(--ink-faint)', fontSize: 14 }}>×</button>
                      </div>
                      <div style={{ fontSize: 12, fontWeight: 700, minWidth: 80, textAlign: 'right' }}>
                        RWF {(c.price * c.qty).toLocaleString()}
                      </div>
                    </div>
                  ))}
                </div>
                <div style={{ display: 'flex', justifyContent: 'space-between', fontWeight: 700, fontSize: 14, padding: '8px 0', borderTop: '1.5px solid var(--border)' }}>
                  <span>Total</span>
                  <span style={{ color: 'var(--primary)' }}>RWF {cartItems.reduce((s, c) => s + c.price * c.qty, 0).toLocaleString()}</span>
                </div>
                <div style={{ display: 'flex', flexDirection: 'column', gap: 6, marginTop: 8 }}>
                  <Btn variant="primary" style={{ width: '100%', justifyContent: 'center' }} onClick={() => setCartItems([])}>
                    ✓ Complete Sale
                  </Btn>
                  <Btn variant="ghost" style={{ width: '100%', justifyContent: 'center' }} onClick={() => setCartItems([])}>
                    Clear Cart
                  </Btn>
                </div>
              </>
            )}
          </Card>
        ) : (
          <Card>
            <SectionHeader title="Stock Entry Queue" />
            <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
              {events.filter(e => e.resolvedType === 'bulk_stock' || e.resolvedType === 'piece_stock').slice(0, 5).map(ev => (
                <div key={ev.id} style={{ padding: '9px 10px', background: '#f0fdf4', border: '1px solid #86efac', borderRadius: 7, display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
                  <div>
                    <div style={{ fontSize: 12, fontWeight: 600, color: 'var(--ink)' }}>{ev.productName}</div>
                    <div style={{ fontSize: 10, color: 'var(--ink-muted)' }}>{ev.quantity} unit{(ev.quantity ?? 1) > 1 ? 's' : ''}</div>
                  </div>
                  <StatusBadge label="Confirm" color="#16a34a" bg="#d1fae5" />
                </div>
              ))}
              {events.filter(e => e.resolvedType === 'bulk_stock' || e.resolvedType === 'piece_stock').length === 0 && (
                <div style={{ textAlign: 'center', padding: '20px 0', color: 'var(--ink-faint)', fontSize: 12 }}>
                  Scan barcodes to populate the stock queue
                </div>
              )}
            </div>
          </Card>
        )}

        {/* Legend */}
        <Card style={{ padding: '12px 14px' }}>
          <div style={{ fontSize: 11, fontWeight: 600, color: 'var(--ink-muted)', marginBottom: 8, textTransform: 'uppercase', letterSpacing: '0.05em' }}>Scan Result Types</div>
          {[
            { icon: '▦', label: 'Bulk Barcode', desc: 'Adds all N pieces at once', color: '#1e8a4a' },
            { icon: '📦', label: 'Piece Barcode (Stock)', desc: 'Adds 1 unit to stock', color: '#059669' },
            { icon: '🧾', label: 'Piece Barcode (Sale)', desc: 'Adds 1 unit to cart', color: '#0284c7' },
            { icon: '❓', label: 'Unknown', desc: 'Prompts to register', color: '#dc2626' },
          ].map(l => (
            <div key={l.label} style={{ display: 'flex', gap: 8, alignItems: 'flex-start', marginBottom: 7 }}>
              <span style={{ fontSize: 14, flexShrink: 0 }}>{l.icon}</span>
              <div>
                <div style={{ fontSize: 11, fontWeight: 600, color: l.color }}>{l.label}</div>
                <div style={{ fontSize: 10, color: 'var(--ink-faint)' }}>{l.desc}</div>
              </div>
            </div>
          ))}
        </Card>
      </div>
    </div>
    </>
  )
}

// ─── Registry Tab ─────────────────────────────────────────────────────────────

function RegistryTab({ onViewSession }: { onViewSession: (s: BarcodeSession) => void }) {
  const [search, setSearch] = useState('')

  const filtered = barcodeSessions.filter(s =>
    s.product.name.toLowerCase().includes(search.toLowerCase()) ||
    s.product.category.toLowerCase().includes(search.toLowerCase()) ||
    s.id.toLowerCase().includes(search.toLowerCase())
  )

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 14 }}>
      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(3, 1fr)', gap: 10 }}>
        {[
          { label: 'Total Sessions',     value: barcodeSessions.length,                          color: '#1e8a4a' },
          { label: 'Total Pieces Tagged', value: barcodeSessions.reduce((s, b) => s + b.quantity, 0), color: '#059669' },
          { label: 'Added to Stock',     value: barcodeSessions.filter(b => b.addedToStock).length, color: '#0284c7' },
        ].map(k => (
          <div key={k.label} style={{ background: '#fff', borderRadius: 10, padding: '14px 16px', border: '1px solid var(--border)', textAlign: 'center' }}>
            <div style={{ fontSize: 26, fontWeight: 800, color: k.color, fontFamily: 'DM Sans' }}>{k.value}</div>
            <div style={{ fontSize: 11, color: 'var(--ink-muted)', fontWeight: 500 }}>{k.label}</div>
          </div>
        ))}
      </div>

      <div style={{ display: 'flex', gap: 8 }}>
        <div style={{ position: 'relative', flex: 1 }}>
          <span style={{ position: 'absolute', left: 9, top: '50%', transform: 'translateY(-50%)', fontSize: 12, color: 'var(--ink-faint)' }}>🔍</span>
          <input value={search} onChange={e => setSearch(e.target.value)}
            placeholder="Search sessions by name, category, session ID…"
            style={{ width: '100%', padding: '8px 10px 8px 28px', border: '1px solid var(--border)', borderRadius: 8, fontSize: 12, fontFamily: 'inherit', outline: 'none', background: 'var(--bg)' }}
            onFocus={e => e.target.style.borderColor = 'var(--primary)'}
            onBlur={e => e.target.style.borderColor = 'var(--border)'}
          />
        </div>
        <Btn variant="ghost" small>⬇ Export Registry</Btn>
      </div>

      <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
        {filtered.map(session => {
          const sold    = session.piecesBarcodes.filter(p => p.status === 'sold').length
          const inStock = session.piecesBarcodes.filter(p => p.status === 'in_stock').length
          const pctSold = Math.round((sold / session.quantity) * 100)

          return (
            <div key={session.id}
              onClick={() => onViewSession(session)}
              style={{
                background: '#fff', border: '1px solid var(--border)', borderRadius: 12,
                padding: '16px 18px', cursor: 'pointer', transition: 'all 0.15s',
                display: 'grid', gridTemplateColumns: '1fr auto auto', gap: 16, alignItems: 'center',
              }}
              onMouseEnter={e => { (e.currentTarget as HTMLDivElement).style.borderColor = 'var(--border-strong)'; (e.currentTarget as HTMLDivElement).style.background = 'var(--bg)' }}
              onMouseLeave={e => { (e.currentTarget as HTMLDivElement).style.borderColor = 'var(--border)'; (e.currentTarget as HTMLDivElement).style.background = '#fff' }}
            >
              <div>
                <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 4 }}>
                  <span style={{ fontSize: 12, fontFamily: 'JetBrains Mono, monospace', color: 'var(--ink-faint)' }}>{session.id}</span>
                  {session.product.prescription && <StatusBadge label="Rx" color="#7c3aed" bg="#ede9fe" />}
                  {session.addedToStock && <StatusBadge label="✓ In Stock" color="#16a34a" bg="#d1fae5" />}
                </div>
                <div style={{ fontSize: 15, fontWeight: 700, color: 'var(--ink)' }}>{session.product.name}</div>
                <div style={{ fontSize: 11, color: 'var(--ink-muted)', marginTop: 2 }}>
                  {session.product.category} · Batch {session.product.batch} · Exp {session.product.expiry} · {session.product.supplier}
                </div>
                <div style={{ fontSize: 10, color: 'var(--ink-faint)', marginTop: 2 }}>Generated {session.createdAt}</div>
              </div>

              <div style={{ textAlign: 'center', minWidth: 80 }}>
                <div style={{ fontSize: 22, fontWeight: 800, color: 'var(--primary)', fontFamily: 'DM Sans' }}>{session.quantity}</div>
                <div style={{ fontSize: 10, color: 'var(--ink-muted)' }}>pieces</div>
                <div style={{ marginTop: 4, fontSize: 10 }}>
                  <span style={{ color: '#16a34a', fontWeight: 600 }}>{inStock} stock</span>
                  {sold > 0 && <span style={{ color: '#0284c7', fontWeight: 600 }}> · {sold} sold</span>}
                </div>
              </div>

              <div style={{ minWidth: 100 }}>
                <div style={{ fontSize: 10, color: 'var(--ink-muted)', marginBottom: 4 }}>Sold {pctSold}%</div>
                <div style={{ height: 6, background: 'var(--border)', borderRadius: 3, overflow: 'hidden' }}>
                  <div style={{ width: `${pctSold}%`, height: '100%', background: '#0284c7', borderRadius: 3 }} />
                </div>
                <div style={{ marginTop: 6, display: 'flex', gap: 6, justifyContent: 'flex-end' }}>
                  <button style={{ fontSize: 10, color: 'var(--primary)', background: 'none', border: 'none', cursor: 'pointer', fontWeight: 600, fontFamily: 'inherit' }}>View →</button>
                </div>
              </div>
            </div>
          )
        })}
      </div>
    </div>
  )
}

// ─── Session Detail Modal ─────────────────────────────────────────────────────

function SessionModal({ session, onClose }: { session: BarcodeSession; onClose: () => void }) {
  const [showPieces, setShowPieces] = useState(false)
  return (
    <Modal title={`${session.id} — ${session.product.name}`} onClose={onClose} width={700}>
      <div style={{ display: 'flex', flexDirection: 'column', gap: 16 }}>
        <div style={{ display: 'grid', gridTemplateColumns: 'repeat(4, 1fr)', gap: 8 }}>
          {[
            ['Total Pieces', session.quantity],
            ['In Stock',    session.piecesBarcodes.filter(p => p.status === 'in_stock').length],
            ['Sold',        session.piecesBarcodes.filter(p => p.status === 'sold').length],
            ['Unit Price',  `RWF ${session.product.unitPrice.toLocaleString()}`],
          ].map(([l, v]) => (
            <div key={l as string} style={{ background: 'var(--bg)', borderRadius: 8, padding: '10px 12px', textAlign: 'center' }}>
              <div style={{ fontSize: 18, fontWeight: 800, color: 'var(--primary)', fontFamily: 'DM Sans' }}>{v}</div>
              <div style={{ fontSize: 10, color: 'var(--ink-muted)', fontWeight: 500 }}>{l}</div>
            </div>
          ))}
        </div>

        <BulkBarcodeLabel code={session.bulkBarcode} name={session.product.name} qty={session.quantity} expiry={session.product.expiry} />

        <div>
          <button onClick={() => setShowPieces(s => !s)} style={{
            fontSize: 12, fontWeight: 600, color: 'var(--primary)', background: 'none', border: '1px solid var(--border)',
            borderRadius: 7, padding: '7px 12px', cursor: 'pointer', fontFamily: 'inherit',
          }}>
            {showPieces ? '▲ Hide' : '▼ Show'} Individual Barcodes ({session.quantity})
          </button>
          {showPieces && (
            <div style={{ marginTop: 10, display: 'flex', flexWrap: 'wrap', gap: 8, padding: '12px', background: 'var(--bg)', borderRadius: 10, border: '1px solid var(--border)', maxHeight: 320, overflowY: 'auto' }}>
              {session.piecesBarcodes.map(pb => (
                <BarcodeLabel key={pb.code} code={pb.code} name={session.product.name} expiry={session.product.expiry} pieceNum={pb.pieceNumber} total={session.quantity} small />
              ))}
            </div>
          )}
        </div>

        <div style={{ display: 'flex', gap: 8, justifyContent: 'flex-end' }}>
          <Btn variant="ghost" small onClick={onClose}>⬇ Export All</Btn>
          <Btn variant="secondary" small onClick={onClose}>🖨 Print Labels</Btn>
          <Btn variant="primary" small onClick={onClose}>🖨 Print Bulk Label</Btn>
        </div>
      </div>
    </Modal>
  )
}

// ─── Main Barcode Page ────────────────────────────────────────────────────────

export default function BarcodePage() {
  const [tab, setTab] = useState<'generate' | 'scanner' | 'registry'>('scanner')
  const [showWizard, setShowWizard] = useState(false)
  const [viewSession, setViewSession] = useState<BarcodeSession | null>(null)

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 16 }}>
      {/* Tab bar */}
      <div style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
        <div style={{ display: 'flex', gap: 0, background: 'var(--bg-alt)', borderRadius: 10, padding: 3, border: '1px solid var(--border)', flex: 1 }}>
          {([
            ['scanner',  '▦ Scanner',           'Scan barcodes to add stock or sell'],
            ['generate', '✦ Generate Barcodes',  'New medicine → generate & print labels'],
            ['registry', '☰ Barcode Registry',   'All barcode sessions & pieces'],
          ] as const).map(([t, l, hint]) => (
            <button key={t} onClick={() => setTab(t)} title={hint} style={{
              flex: 1, padding: '9px 14px', borderRadius: 8, border: 'none', cursor: 'pointer',
              background: tab === t ? '#fff' : 'transparent',
              color: tab === t ? 'var(--primary)' : 'var(--ink-muted)',
              fontWeight: tab === t ? 700 : 400, fontSize: 13, fontFamily: 'inherit',
              boxShadow: tab === t ? '0 1px 4px rgba(0,0,0,0.08)' : 'none', transition: 'all 0.18s',
            }}>{l}</button>
          ))}
        </div>
        {tab === 'registry' && (
          <Btn variant="primary" onClick={() => setShowWizard(true)}>+ New Barcode Session</Btn>
        )}
        {tab === 'generate' && (
          <Btn variant="primary" onClick={() => setShowWizard(true)}>+ Start New Medicine</Btn>
        )}
      </div>

      {/* Quick-start banner for generate tab */}
      {tab === 'generate' && (
        <div style={{
          background: 'linear-gradient(135deg, #ecfdf5, #f0fdf4)', border: '1.5px solid var(--border-strong)',
          borderRadius: 14, padding: '20px 24px', display: 'flex', gap: 20, alignItems: 'center',
        }}>
          <div style={{ fontSize: 48 }}>▦</div>
          <div style={{ flex: 1 }}>
            <div style={{ fontSize: 17, fontWeight: 800, color: 'var(--ink)', fontFamily: 'DM Sans' }}>Barcode Generation Wizard</div>
            <div style={{ fontSize: 13, color: 'var(--ink-mid)', marginTop: 6, lineHeight: 1.7 }}>
              Purchased a new box of medicine? Follow the 4-step wizard:<br />
              <strong>1</strong> Enter medicine details →
              <strong> 2</strong> Generate individual piece barcodes →
              <strong> 3</strong> Get bulk barcode for the box →
              <strong> 4</strong> Add all pieces to stock in one scan.
            </div>
          </div>
          <Btn variant="primary" onClick={() => setShowWizard(true)} style={{ fontSize: 14, padding: '12px 24px', flexShrink: 0 }}>
            Start Wizard →
          </Btn>
        </div>
      )}

      {/* Flow diagram */}
      {tab === 'generate' && (
        <Card>
          <SectionHeader title="How the Barcode System Works" />
          <div style={{ display: 'grid', gridTemplateColumns: 'repeat(5, 1fr)', gap: 0, alignItems: 'center' }}>
            {[
              { icon: '📋', step: '1', label: 'Enter Details', desc: 'Medicine name, expiry, price, quantity per box' },
              null,
              { icon: '▦', step: '2', label: 'Generate Barcodes', desc: 'System creates 1 unique barcode per piece + 1 bulk barcode for the box' },
              null,
              { icon: '🖨', step: '3', label: 'Print & Label', desc: 'Print barcode labels, stick one on each piece of medicine' },
            ].map((item, i) =>
              item === null ? (
                <div key={i} style={{ height: 2, background: 'var(--border)', margin: '0 6px', marginBottom: 24 }} />
              ) : (
                <div key={i} style={{ textAlign: 'center', padding: '0 8px' }}>
                  <div style={{ width: 48, height: 48, borderRadius: 12, background: 'var(--primary-light)', display: 'flex', alignItems: 'center', justifyContent: 'center', fontSize: 22, margin: '0 auto 8px' }}>{item.icon}</div>
                  <div style={{ fontSize: 10, fontWeight: 700, color: 'var(--primary)', textTransform: 'uppercase', letterSpacing: '0.06em', marginBottom: 3 }}>Step {item.step}</div>
                  <div style={{ fontSize: 12, fontWeight: 700, color: 'var(--ink)', marginBottom: 3 }}>{item.label}</div>
                  <div style={{ fontSize: 11, color: 'var(--ink-muted)', lineHeight: 1.4 }}>{item.desc}</div>
                </div>
              )
            )}
          </div>
          <div style={{ height: 1, background: 'var(--border)', margin: '16px 0' }} />
          <div style={{ display: 'grid', gridTemplateColumns: 'repeat(5, 1fr)', gap: 0, alignItems: 'center' }}>
            {[
              { icon: '▦', step: '4', label: 'Scan Bulk Barcode', desc: 'Scan the box barcode once — all N pieces enter stock automatically' },
              null,
              { icon: '🧾', step: '5', label: 'Sell by Scan', desc: 'Scan individual piece barcode at POS — system registers the sale' },
              null,
              { icon: '📊', step: '6', label: 'Live Tracking', desc: 'Every piece tracked: generated → in stock → sold' },
            ].map((item, i) =>
              item === null ? (
                <div key={i} style={{ height: 2, background: 'var(--border)', margin: '0 6px', marginBottom: 24 }} />
              ) : (
                <div key={i} style={{ textAlign: 'center', padding: '0 8px' }}>
                  <div style={{ width: 48, height: 48, borderRadius: 12, background: 'var(--primary-light)', display: 'flex', alignItems: 'center', justifyContent: 'center', fontSize: 22, margin: '0 auto 8px' }}>{item.icon}</div>
                  <div style={{ fontSize: 10, fontWeight: 700, color: 'var(--primary)', textTransform: 'uppercase', letterSpacing: '0.06em', marginBottom: 3 }}>Step {item.step}</div>
                  <div style={{ fontSize: 12, fontWeight: 700, color: 'var(--ink)', marginBottom: 3 }}>{item.label}</div>
                  <div style={{ fontSize: 11, color: 'var(--ink-muted)', lineHeight: 1.4 }}>{item.desc}</div>
                </div>
              )
            )}
          </div>
        </Card>
      )}

      {/* Tab content */}
      {tab === 'scanner'  && <ScannerTab />}
      {tab === 'registry' && <RegistryTab onViewSession={setViewSession} />}

      {/* Recent sessions on generate tab */}
      {tab === 'generate' && (
        <Card>
          <SectionHeader title="Recent Barcode Sessions" action="View All" onAction={() => setTab('registry')} />
          <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
            {barcodeSessions.slice(0, 3).map(session => (
              <div key={session.id}
                onClick={() => setViewSession(session)}
                style={{
                  display: 'flex', alignItems: 'center', gap: 14, padding: '12px 14px',
                  border: '1px solid var(--border)', borderRadius: 10, cursor: 'pointer', transition: 'all 0.15s',
                }}
                onMouseEnter={e => { (e.currentTarget as HTMLDivElement).style.background = 'var(--bg)' }}
                onMouseLeave={e => { (e.currentTarget as HTMLDivElement).style.background = '' }}
              >
                <div style={{ width: 40, height: 40, borderRadius: 10, background: 'var(--primary-light)', display: 'flex', alignItems: 'center', justifyContent: 'center', fontSize: 18, flexShrink: 0 }}>▦</div>
                <div style={{ flex: 1 }}>
                  <div style={{ fontSize: 13, fontWeight: 700, color: 'var(--ink)' }}>{session.product.name}</div>
                  <div style={{ fontSize: 11, color: 'var(--ink-muted)' }}>{session.quantity} pieces · Batch {session.product.batch} · {session.createdAt}</div>
                </div>
                {session.addedToStock ? <StatusBadge label="✓ In Stock" color="#16a34a" bg="#d1fae5" /> : <StatusBadge label="Pending" color="#d97706" bg="#fef3c7" />}
                <span style={{ fontSize: 12, color: 'var(--primary)', fontWeight: 600 }}>View →</span>
              </div>
            ))}
          </div>
        </Card>
      )}

      {showWizard && <GenerateWizard onClose={() => setShowWizard(false)} />}
      {viewSession && <SessionModal session={viewSession} onClose={() => setViewSession(null)} />}

    </div>
  )
}
