import { useEffect, useState } from "react"
import QRCode from "qrcode"
import { Loader2, AlertCircle } from "lucide-react"
import { Logo } from "../components"
import { useTranslation } from "../lib/i18n"
import { buildReceiptPdfBlob } from "../lib/receiptPdf"
import { getPublicSaleReceipt } from "../lib/sales"
import { errorMessage } from "../lib/supabase"
import { buildVerificationQrPayload } from "../lib/vsdc"

// Parses the sale id out of a "#receipt?id=<uuid>" hash. Splitting on the
// first "?" ourselves rather than handing the whole hash to URLSearchParams:
// "receipt?id=xxx" has no "&", so URLSearchParams would parse the entire
// string as one key ("receipt?id") with no value instead of what we want.
function saleIdFromHash(hash: string): string | null {
  const qIndex = hash.indexOf("?")
  if (qIndex === -1) return null
  return new URLSearchParams(hash.slice(qIndex + 1)).get("id")
}

// Standalone, unauthenticated destination reached by scanning the "scan to
// view online" QR printed on every receipt (see ReceiptView in
// SalesPage.tsx). App.tsx's hash router renders this in place of the entire
// app the moment the hash matches "#receipt...", before the auth check or
// intro splash ever run -- the same pattern already used for
// #admin/#branch/#reset.
//
// This page never shows the receipt as an interactive webpage. It fetches
// the data, builds the same PDF the in-app "Download PDF" button produces,
// and navigates THIS TAB straight to the resulting file (window.location.replace,
// not a clicked <a download>) so the phone's browser opens its native PDF
// viewer directly -- the person lands on their receipt, not on our UI, and
// the viewer's own share/save controls are what let them keep the file.
// A click-triggered download here would be unreliable: many mobile browsers
// silently block or ignore a file save that isn't the direct result of a
// tap, and a useEffect-driven download (what this page used to do) isn't
// one. A full navigation to a blob: URL doesn't hit that restriction.
export default function PublicReceiptPage() {
  const { t } = useTranslation()
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    const saleId = saleIdFromHash(window.location.hash)
    if (!saleId) { setError(t("publicReceipt.invalidLink")); return }
    let cancelled = false

    async function run() {
      try {
        const data = await getPublicSaleReceipt(saleId!)
        const isEbmRegistered = !!(data.ebmSdcId && data.ebmMrcNo && data.ebmReceiptSignature && data.ebmInvoiceNumber)
        let qrDataUrl: string | null = null
        if (isEbmRegistered) {
          const payload = buildVerificationQrPayload({
            sdcId: data.ebmSdcId!, mrcNo: data.ebmMrcNo!, invcNo: data.ebmInvoiceNumber!,
            rcptSign: data.ebmReceiptSignature!, issuedAt: data.issuedAt,
          })
          qrDataUrl = await QRCode.toDataURL(payload, { width: 96, margin: 0 }).catch(() => null)
        }
        if (cancelled) return
        const blob = await buildReceiptPdfBlob(data, { qrDataUrl, isEbmRegistered, t })
        if (cancelled) return
        window.location.replace(URL.createObjectURL(blob))
      } catch (reason) {
        if (!cancelled) setError(errorMessage(reason, t("publicReceipt.notFound")))
      }
    }
    void run()
    return () => { cancelled = true }
  }, [t])

  return (
    <main style={{ minHeight: "100vh", background: "var(--bg)", padding: "32px 16px" }}>
      <div style={{ display: "flex", justifyContent: "center", marginBottom: 24 }}>
        <Logo size={36} />
      </div>
      {!error && (
        <div style={{ display: "flex", flexDirection: "column", alignItems: "center", gap: 10, color: "var(--ink-muted)", marginTop: 60, fontFamily: "var(--font-body)" }}>
          <Loader2 className="w-7 h-7 animate-spin" />
          <div>{t("publicReceipt.loading")}</div>
        </div>
      )}
      {error && (
        <div style={{ display: "flex", flexDirection: "column", alignItems: "center", gap: 10, color: "var(--ink-muted)", marginTop: 60, textAlign: "center", maxWidth: 360, marginInline: "auto", fontFamily: "var(--font-body)" }}>
          <AlertCircle className="w-7 h-7" color="#dc2626" />
          <div>{error}</div>
        </div>
      )}
    </main>
  )
}
