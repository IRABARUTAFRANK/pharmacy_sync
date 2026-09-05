// Shared export primitives used by every "Export"/"Download" button in the
// app (Overview dashboard + its drill-downs, Transactions ledger, Branch
// History) so a click always offers a real choice of file format instead of
// silently writing one fixed type. Every format here produces a genuine,
// openable file -- there is no fake "Download" button anywhere that quietly
// does nothing (see the removed App.tsx ExportModal this replaced: a
// hardcoded share link, a dead Copy button, and a Download button wired to
// nothing but closing the modal).

export interface ReportSection {
  title: string
  headers: string[]
  rows: (string | number)[][]
}

export type ExportFormat = "csv" | "excel" | "pdf"

function csvCell(value: string | number): string {
  const s = String(value)
  return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s
}

export function reportToCsv(sections: ReportSection[]): string {
  const lines: string[] = []
  for (const section of sections) {
    lines.push(section.title)
    lines.push(section.headers.join(","))
    for (const row of section.rows) lines.push(row.map(csvCell).join(","))
    lines.push("")
  }
  return lines.join("\n")
}

function escapeHtml(v: string | number): string {
  return String(v).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;")
}

function sectionsToHtmlTables(sections: ReportSection[]): string {
  return sections.map(section => `
    <h3>${escapeHtml(section.title)}</h3>
    <table border="1" cellspacing="0" cellpadding="4">
      <tr>${section.headers.map(h => `<th>${escapeHtml(h)}</th>`).join("")}</tr>
      ${section.rows.map(row => `<tr>${row.map(c => `<td>${escapeHtml(c)}</td>`).join("")}</tr>`).join("")}
    </table>`).join("<br/>")
}

// Excel opens an .xls file containing an HTML table directly -- a
// long-standing, genuinely working technique for a real spreadsheet export
// with no library and no server round-trip.
export function reportToExcelHtml(sections: ReportSection[], docTitle: string): string {
  return `<html><head><meta charset="utf-8"></head><body><h2>${escapeHtml(docTitle)}</h2>${sectionsToHtmlTables(sections)}</body></html>`
}

export function downloadBlob(content: string, mime: string, filename: string) {
  const blob = new Blob([content], { type: mime })
  const url = URL.createObjectURL(blob)
  const a = document.createElement("a")
  a.href = url
  a.download = filename
  document.body.appendChild(a)
  a.click()
  document.body.removeChild(a)
  URL.revokeObjectURL(url)
}

export function filenameSafe(text: string): string {
  return text.toLowerCase().trim().replace(/\s+/g, "-")
}

// Reads the current --primary CSS var (see lib/theme.ts) so a generated PDF's
// header row matches whichever accent color the viewer picked, instead of a
// hardcoded brand blue that would look wrong once theming shipped.
function primaryColorRgb(): [number, number, number] {
  const hex = getComputedStyle(document.documentElement).getPropertyValue("--primary").trim()
  const m = /^#?([a-f\d]{2})([a-f\d]{2})([a-f\d]{2})$/i.exec(hex)
  if (!m) return [30, 95, 168]
  return [parseInt(m[1], 16), parseInt(m[2], 16), parseInt(m[3], 16)]
}

// A real PDF file, built and downloaded entirely client-side with jsPDF +
// jspdf-autotable -- doc.save() triggers an ordinary browser file download
// (it builds the same Blob + throwaway <a download> that downloadBlob() does
// above), so this needs no print dialog, no "Save as PDF" step, and no popup
// window at all. Dynamically imported so the ~250KB of PDF-generation code
// only loads the first time someone actually picks the PDF format.
export async function downloadPdf(sections: ReportSection[], docTitle: string, filenameBase: string) {
  const [{ jsPDF }, { default: autoTable }] = await Promise.all([
    import("jspdf"),
    import("jspdf-autotable"),
  ])

  const doc = new jsPDF({ orientation: "portrait", unit: "mm", format: "a4" })
  const marginX = 14
  const pageHeight = doc.internal.pageSize.getHeight()
  const accent = primaryColorRgb()
  let cursorY = 18

  doc.setFontSize(14)
  doc.setFont("helvetica", "bold")
  doc.text(docTitle, marginX, cursorY)
  cursorY += 9

  for (const section of sections) {
    if (cursorY > pageHeight - 30) {
      doc.addPage()
      cursorY = 18
    }
    doc.setFontSize(11)
    doc.setFont("helvetica", "bold")
    doc.text(section.title, marginX, cursorY)
    cursorY += 4

    autoTable(doc, {
      head: [section.headers],
      body: section.rows.map(row => row.map(cell => String(cell))),
      startY: cursorY,
      margin: { left: marginX, right: marginX },
      styles: { fontSize: 9, cellPadding: 2 },
      headStyles: { fillColor: accent, textColor: 255 },
      theme: "grid",
    })

    cursorY = (doc as unknown as { lastAutoTable: { finalY: number } }).lastAutoTable.finalY + 10
  }

  doc.save(`${filenameBase}.pdf`)
}

export function downloadReport(sections: ReportSection[], format: ExportFormat, docTitle: string, filenameBase: string) {
  if (format === "csv") {
    downloadBlob(reportToCsv(sections), "text/csv;charset=utf-8;", `${filenameBase}.csv`)
  } else if (format === "excel") {
    downloadBlob(reportToExcelHtml(sections, docTitle), "application/vnd.ms-excel;charset=utf-8;", `${filenameBase}.xls`)
  } else {
    void downloadPdf(sections, docTitle, filenameBase)
  }
}
