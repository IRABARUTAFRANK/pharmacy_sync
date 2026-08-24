import { useCallback, useEffect, useState } from "react"
import { Card, Btn, StatusBadge } from "../components"
import { errorMessage } from "../lib/supabase"
import {
  listMyProductRequests,
  productRequestImageUrl,
  submitProductRequest,
  uploadProductRequestImage,
  type ProductRequestRow,
} from "../lib/products"

const statusMeta: Record<ProductRequestRow["status"], { label: string; color: string; bg: string }> = {
  pending: { label: "Awaiting admin review", color: "#b45309", bg: "#fef3c7" },
  approved: { label: "Approved — now in the catalogue", color: "#16a34a", bg: "#dcfce7" },
  rejected: { label: "Declined", color: "#b91c1c", bg: "#fef2f2" },
}

export default function RequestProductPage() {
  const [requests, setRequests] = useState<ProductRequestRow[]>([])
  const [loading, setLoading] = useState(true)
  const [loadError, setLoadError] = useState<string | null>(null)

  const [message, setMessage] = useState("")
  const [file, setFile] = useState<File | null>(null)
  const [preview, setPreview] = useState<string | null>(null)
  const [submitError, setSubmitError] = useState<string | null>(null)
  const [submitted, setSubmitted] = useState(false)
  const [busy, setBusy] = useState(false)

  const refresh = useCallback(async () => {
    setLoading(true)
    setLoadError(null)
    try {
      setRequests(await listMyProductRequests())
    } catch (reason) {
      setLoadError(errorMessage(reason, "Unable to load your requests from the database."))
    } finally {
      setLoading(false)
    }
  }, [])

  useEffect(() => { void refresh() }, [refresh])

  function pickFile(f: File | null) {
    setFile(f)
    setPreview(f ? URL.createObjectURL(f) : null)
  }

  async function submit() {
    if (!message.trim()) { setSubmitError("Describe the product you need."); return }
    setBusy(true)
    setSubmitError(null)
    try {
      const imagePath = file ? await uploadProductRequestImage(file) : undefined
      await submitProductRequest(message.trim(), imagePath)
      setMessage("")
      pickFile(null)
      setSubmitted(true)
      window.setTimeout(() => setSubmitted(false), 4000)
      void refresh()
    } catch (reason) {
      setSubmitError(errorMessage(reason, "Could not send this request."))
    } finally {
      setBusy(false)
    }
  }

  return <div style={{ maxWidth: 760, margin: "0 auto", display: "flex", flexDirection: "column", gap: 16 }}>
    <Card>
      <h1 style={{ margin: 0, fontSize: 17 }}>Request a product from the admin</h1>
      <p style={{ color: "var(--ink-muted)", margin: "4px 0 16px", fontSize: 12 }}>
        Can't find a product in the catalogue while receiving stock? Describe what you need here (and add a photo if you have one) — the super admin reviews it and adds it to the shared catalogue.
      </p>

      {submitError && <div style={{ background: "#fef2f2", color: "#b91c1c", border: "1px solid #fecaca", borderRadius: 10, padding: "10px 14px", fontSize: 12, marginBottom: 12 }}>{submitError}</div>}
      {submitted && <div style={{ background: "#dcfce7", color: "#16a34a", border: "1px solid #bbf7d0", borderRadius: 10, padding: "10px 14px", fontSize: 12, marginBottom: 12 }}>Request sent — you'll see its status below once the admin reviews it.</div>}

      <div style={{ display: "flex", flexDirection: "column", gap: 12 }}>
        <div>
          <label style={{ fontSize: 11, fontWeight: 600, color: "var(--ink-mid)", display: "block", marginBottom: 4 }}>What do you need?</label>
          <textarea
            value={message} onChange={event => setMessage(event.target.value)} rows={5}
            placeholder="e.g. Amoxicillin 500mg capsules — our usual supplier delivered these but they're not in the system yet."
            style={{ width: "100%", padding: "9px 10px", border: "1px solid var(--border)", borderRadius: 7, font: "inherit", boxSizing: "border-box", resize: "vertical" }}
          />
        </div>
        <div>
          <label style={{ fontSize: 11, fontWeight: 600, color: "var(--ink-mid)", display: "block", marginBottom: 4 }}>Photo (optional)</label>
          <input type="file" accept="image/*" onChange={event => pickFile(event.target.files?.[0] ?? null)} style={{ fontSize: 12 }} />
          {preview && <img src={preview} alt="Preview" style={{ marginTop: 8, maxWidth: "100%", maxHeight: 200, borderRadius: 8, border: "1px solid var(--border)" }} />}
        </div>
        <div>
          <Btn variant="primary" onClick={() => void submit()} style={busy ? { opacity: 0.6, pointerEvents: "none" } : undefined}>{busy ? "Sending…" : "Send request"}</Btn>
        </div>
      </div>
    </Card>

    <Card>
      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 10 }}>
        <h2 style={{ margin: 0, fontSize: 14 }}>Your requests</h2>
        <Btn variant="secondary" small onClick={() => void refresh()}>Refresh</Btn>
      </div>
      {loadError && <div style={{ background: "#fef2f2", color: "#b91c1c", border: "1px solid #fecaca", borderRadius: 10, padding: "10px 14px", fontSize: 12, marginBottom: 10 }}>{loadError}</div>}
      {loading ? <p style={{ fontSize: 11, color: "var(--ink-muted)" }}>Loading…</p> : (
        <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
          {requests.map(request => {
            const meta = statusMeta[request.status]
            return <div key={request.id} style={{ display: "flex", alignItems: "center", gap: 10, border: "1px solid var(--border)", borderRadius: 9, padding: "10px 12px", flexWrap: "wrap" }}>
              {request.image_path && (
                <img src={productRequestImageUrl(request.image_path)} alt="" style={{ width: 44, height: 44, objectFit: "cover", borderRadius: 6, flexShrink: 0 }} />
              )}
              <div style={{ flex: 1, minWidth: 200 }}>
                <div style={{ fontSize: 12, color: "var(--ink)", lineHeight: 1.4 }}>{request.message}</div>
                {request.status === "rejected" && request.rejection_reason && (
                  <div style={{ fontSize: 10, color: "#b91c1c", marginTop: 2 }}>Reason: {request.rejection_reason}</div>
                )}
              </div>
              <StatusBadge label={meta.label} color={meta.color} bg={meta.bg} />
            </div>
          })}
          {!loading && requests.length === 0 && (
            <p style={{ fontSize: 12, color: "var(--ink-muted)", textAlign: "center", padding: "20px 0" }}>You haven't requested any products yet.</p>
          )}
        </div>
      )}
    </Card>
  </div>
}
