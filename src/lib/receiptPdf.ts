// A real, downloadable PDF of one receipt -- built with vector text/tables
// (jsPDF + jspdf-autotable, the same libraries lib/export.ts already uses for
// report downloads) rather than rasterizing the on-screen HTML, so the file
// stays crisp at any zoom and needs no image-loading/CORS handling for the
// branch's remote logo. This is what the "scan to view online" QR now
// triggers automatically (see PublicReceiptPage.tsx) -- scanning the code
// hands the customer an actual receipt file, not just a webpage to read.
import { fmtRWFExact } from "../data"
import type { TranslationKey } from "./i18n/en"
import type { ReceiptData } from "./sales"
import { mapTaxRateToVsdcCode } from "./vsdc"

export type ReceiptPrintSize = "thermal80" | "thermal58" | "a5" | "a4"

type T = (key: TranslationKey, vars?: Record<string, string | number>) => string

// Thermal formats have no fixed page length -- a continuous roll -- so the
// PDF page height is estimated from how much content there actually is
// (generous per-row/per-line estimates, plus fixed header/footer space),
// clamped to a sane range. A5/A4 use their real standard sizes and simply
// paginate if content overflows (matches downloadPdf()'s own pagination in
// lib/export.ts).
function pdfFormatFor(size: ReceiptPrintSize, itemCount: number): { width: number; height: number | "a5" | "a4" } {
  if (size === "a5") return { width: 148, height: "a5" }
  if (size === "a4") return { width: 210, height: "a4" }
  const width = size === "thermal80" ? 80 : 58
  const estimated = 95 + itemCount * 9
  return { width, height: Math.min(Math.max(estimated, 120), 500) }
}

// The actual PDF builder -- returns the jsPDF document instance so callers
// can either .save() it (a real user-gesture click, e.g. the in-app
// "Download PDF" button -- browsers never block that) or .output("blob") it
// (the QR-scan flow in PublicReceiptPage.tsx, which navigates the browser
// straight to that blob so the PDF opens directly, not a click-triggered
// download from inside a page -- mobile browsers routinely block/ignore the
// latter when it isn't a direct result of a tap).
async function buildReceiptPdfDoc(data: ReceiptData, opts: {
  printSize: ReceiptPrintSize
  qrDataUrl: string | null
  isEbmRegistered: boolean
  t: T
}) {
  const { t } = opts
  const [{ jsPDF }, { default: autoTable }] = await Promise.all([
    import("jspdf"),
    import("jspdf-autotable"),
  ])

  const { width, height } = pdfFormatFor(opts.printSize, data.items.length)
  const isThermal = opts.printSize === "thermal80" || opts.printSize === "thermal58"
  const doc = new jsPDF({
    orientation: "portrait", unit: "mm",
    format: height === "a5" || height === "a4" ? height : [width, height],
  })

  const marginX = isThermal ? 4 : 16
  let y = isThermal ? 8 : 16

  const center = (text: string, size: number, bold = false) => {
    doc.setFontSize(size)
    doc.setFont("helvetica", bold ? "bold" : "normal")
    doc.text(text, width / 2, y, { align: "center" })
  }

  center(data.branchName, isThermal ? 12 : 15, true)
  y += isThermal ? 5 : 7
  center(t("salesPage.receiptHeading"), isThermal ? 8 : 10, true)
  y += isThermal ? 6 : 8

  doc.setFontSize(isThermal ? 8 : 9)
  doc.setFont("helvetica", "normal")
  const infoLines: string[] = [`${t("salesPage.receiptLabelReceipt")} ${data.receiptNumber}`]
  if (data.patientName) infoLines.push(`${t("salesPage.receiptPatientLabel")}: ${data.patientName}`)
  if (data.branchTin) infoLines.push(`${t("salesPage.receiptTin")}: ${data.branchTin}`)
  if (data.branchPhone) infoLines.push(`${t("salesPage.receiptTel")}: ${data.branchPhone}`)
  if (data.branchAddress) infoLines.push(`${t("salesPage.receiptLocation")}: ${data.branchAddress}`)
  infoLines.push(`${t("salesPage.receiptDate")}: ${new Date(data.issuedAt).toLocaleString()}`)
  infoLines.push(`${t("salesPage.receiptLabelCashier")}: ${data.cashierName}`)
  if (data.insuranceProviderName) infoLines.push(`${t("salesPage.receiptLabelInsurance")}: ${data.insuranceProviderName}`)
  for (const text of infoLines) { doc.text(text, marginX, y); y += isThermal ? 4 : 5 }
  y += 2

  autoTable(doc, {
    startY: y,
    margin: { left: marginX, right: marginX },
    head: [[
      t("salesPage.receiptColNo"), t("salesPage.receiptColDescription"), t("salesPage.receiptColQty"),
      t("salesPage.receiptColUnitPrice"), t("salesPage.receiptColTotal"), t("salesPage.receiptColVat"),
    ]],
    body: data.items.map((item, i) => [
      String(i + 1),
      item.productName + (item.dosage ? ` (${item.dosage})` : ""),
      String(item.quantity),
      fmtRWFExact(item.unitPrice),
      fmtRWFExact(item.subtotal),
      `${item.taxRatePercentage}% (${mapTaxRateToVsdcCode(item.taxRatePercentage)})`,
    ]),
    styles: { fontSize: isThermal ? 6.5 : 8, cellPadding: isThermal ? 1 : 2 },
    headStyles: { fillColor: [30, 95, 168], textColor: 255 },
    theme: "grid",
  })
  y = (doc as unknown as { lastAutoTable: { finalY: number } }).lastAutoTable.finalY + (isThermal ? 4 : 6)

  const totals: [string, string][] = [
    [t("salesPage.receiptSubtotalBeforeVat"), fmtRWFExact(data.subtotal)],
    [t("salesPage.receiptVatSummary"), fmtRWFExact(data.taxTotal)],
  ]
  if (data.insuranceCoveredTotal > 0) totals.push([t("salesPage.receiptInsurancePaid"), `-${fmtRWFExact(data.insuranceCoveredTotal)}`])
  doc.setFontSize(isThermal ? 8 : 10)
  doc.setFont("helvetica", "normal")
  for (const [label, value] of totals) {
    doc.text(label, marginX, y)
    doc.text(value, width - marginX, y, { align: "right" })
    y += isThermal ? 4.5 : 6
  }
  doc.setFont("helvetica", "bold")
  doc.setFontSize(isThermal ? 10 : 12)
  doc.text(t("salesPage.receiptGrandTotal"), marginX, y)
  doc.text(fmtRWFExact(data.patientOwedTotal), width - marginX, y, { align: "right" })
  y += isThermal ? 7 : 10

  doc.setFontSize(isThermal ? 6.5 : 8)
  doc.setFont("helvetica", "bold")
  doc.text(t("salesPage.receiptComplianceTitle"), marginX, y)
  y += isThermal ? 4 : 5
  doc.setFont("helvetica", "normal")
  if (opts.isEbmRegistered && opts.qrDataUrl) {
    const qrSize = isThermal ? 20 : 26
    doc.addImage(opts.qrDataUrl, "PNG", marginX, y, qrSize, qrSize)
    doc.text(`${t("salesPage.receiptVerificationCode")}: ${data.ebmReceiptSignature}`, marginX + qrSize + 4, y + qrSize / 2 - 3)
    doc.text(`${t("salesPage.receiptSdiId")}: ${data.ebmSdcId}`, marginX + qrSize + 4, y + qrSize / 2 + 3)
    y += qrSize + (isThermal ? 4 : 6)
  } else {
    doc.text(t("salesPage.receiptEbmPending"), marginX, y)
    y += isThermal ? 5 : 6
  }

  center(t("salesPage.receiptThankYou"), isThermal ? 8 : 9)
  y += isThermal ? 5 : 6
  if (opts.isEbmRegistered) { center(t("salesPage.receiptEbmCertifiedFooter"), isThermal ? 6.5 : 8, true); y += isThermal ? 4 : 5 }
  center(t("salesPage.receiptPoweredBy"), isThermal ? 6.5 : 8)

  return doc
}

// In-app "Download PDF" button (SalesPage/TransactionsPage receipts) -- a
// real click handler, so a plain .save() download is never blocked.
export async function downloadReceiptPdf(data: ReceiptData, opts: {
  printSize: ReceiptPrintSize
  qrDataUrl: string | null
  isEbmRegistered: boolean
  t: T
}) {
  const doc = await buildReceiptPdfDoc(data, opts)
  doc.save(`receipt-${data.receiptNumber}.pdf`)
}

// Powers the QR-scan flow: builds the same PDF and hands back a Blob so
// PublicReceiptPage.tsx can navigate the whole tab to it (see that file for
// why a redirect, not a triggered download, is what actually works on
// phones). Always renders at A4 -- the pharmacy's own printer width (80mm/
// 58mm/A5) is irrelevant to a customer viewing this on their own phone.
export async function buildReceiptPdfBlob(data: ReceiptData, opts: {
  qrDataUrl: string | null
  isEbmRegistered: boolean
  t: T
}): Promise<Blob> {
  const doc = await buildReceiptPdfDoc(data, { ...opts, printSize: "a4" })
  return doc.output("blob")
}
