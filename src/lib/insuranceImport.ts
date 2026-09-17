// Turns an insurer's reimbursable-medicines price list -- CSV or Excel, in
// whatever layout that insurer happens to use -- into rows ready for
// admin_import_insurance_price_list(). Three stages, mirroring how this was
// done by hand the first time (see scripts/import_insurance_price_list.js):
//   1. detectHeaderRow()  -- skip the title/blank rows every one of these
//      sheets seems to have above the real header.
//   2. autoMapColumns()   -- guess which column is the drug code, name,
//      generic name, unit and price from the header text.
//   3. buildImportPreview() -- turn the guessed mapping into actual rows,
//      dropping section-header/blank/unparseable rows the same way the
//      original RHIA import did, and reporting what got dropped so an admin
//      can sanity-check nothing real was skipped.
// The UI shows the guess from steps 1-2 and lets the admin correct it before
// anything is imported -- this file never has to be perfectly right on its
// own, only a good enough starting guess.

// xlsx is a ~400kB library that only this one screen needs -- dynamically
// imported here so it's fetched when an admin actually opens the upload
// wizard, not bundled into every visit to the admin console.
export async function parseSpreadsheetFile(file: File): Promise<string[][]> {
  const XLSX = await import("xlsx")
  const buffer = await file.arrayBuffer()
  const workbook = XLSX.read(buffer, { type: "array" })
  const firstSheetName = workbook.SheetNames[0]
  if (!firstSheetName) return []
  const sheet = workbook.Sheets[firstSheetName]
  const rows = XLSX.utils.sheet_to_json<string[]>(sheet, { header: 1, raw: false, defval: "" })
  return rows.map((row) => row.map((cell) => (cell ?? "").toString()))
}

export type ImportField = "code" | "name" | "genericName" | "unit" | "price"

export const IMPORT_FIELDS: ImportField[] = ["code", "name", "genericName", "unit", "price"]

// Order matters: checked in this priority so an ambiguous header like "Unit
// Price" (matches both "price" and "unit") lands on the more specific field.
const FIELD_KEYWORDS: Record<ImportField, string[]> = {
  price: ["price", "tariff", "amount", "cost", "rate"],
  code: ["drug code", "item code", "product code", "code", "sku", "reference"],
  name: ["designation", "brand", "trade name", "product name", "item name", "product"],
  genericName: ["generic description", "generic name", "generic", "description", "molecule", "composition", "active ingredient"],
  unit: ["selling unit", "unit", "pack", "packaging", "form"],
}

const HEADER_SCAN_WINDOW = 30
const MIN_HEADER_MATCHES = 2

function matchField(header: string): ImportField | null {
  const h = header.trim().toLowerCase()
  if (!h) return null
  for (const field of IMPORT_FIELDS) {
    if (FIELD_KEYWORDS[field].some((kw) => h.includes(kw))) return field
  }
  return null
}

// Scores each of the first HEADER_SCAN_WINDOW rows by how many cells look
// like a known column header, picks the best one. Falls back to row 0 if
// nothing scores well enough (a file whose headers use unrecognized words --
// the admin's manual column mapping in the UI takes over from there).
export function detectHeaderRow(rows: string[][]): number {
  let best = 0
  let bestScore = 0
  const window = Math.min(rows.length, HEADER_SCAN_WINDOW)
  for (let i = 0; i < window; i++) {
    const row = rows[i]
    const matchedFields = new Set<ImportField>()
    for (const cell of row) {
      const field = matchField(cell)
      if (field) matchedFields.add(field)
    }
    if (matchedFields.size > bestScore) {
      bestScore = matchedFields.size
      best = i
    }
  }
  return bestScore >= MIN_HEADER_MATCHES ? best : 0
}

export type ColumnMapping = Record<ImportField, number | null>

export function autoMapColumns(headerRow: string[]): ColumnMapping {
  const mapping: ColumnMapping = { code: null, name: null, genericName: null, unit: null, price: null }
  const takenColumns = new Set<number>()
  for (const field of IMPORT_FIELDS) {
    for (let col = 0; col < headerRow.length; col++) {
      if (takenColumns.has(col)) continue
      if (matchField(headerRow[col]) === field) {
        mapping[field] = col
        takenColumns.add(col)
        break
      }
    }
  }
  return mapping
}

const SUPPLY_KEYWORDS = [
  "bandage", "gauze", "glove", "syringe", "condom", "catheter", "suture", "cotton wool",
  "mask", "test strip", "strips", "thermometer", "plaster", "swab", "needle", "cannula",
  "tourniquet", "dressing", "diaper", "sanitary", "adhesive tape", "crepe bandage",
  "infusion set", "giving set", "urine bag", "colostomy", "nebulizer kit",
]

function classifyProductType(genericDesc: string, name: string): "medicine" | "supply" {
  const hay = `${genericDesc} ${name}`.toLowerCase()
  return SUPPLY_KEYWORDS.some((kw) => hay.includes(kw)) ? "supply" : "medicine"
}

const DOSAGE_RE = /\d[\d.,]*\s*(?:mg|g|mcg|µg|ml|IU|UI|MIU|mIU|%)(?:\s*(?:\/|\+)\s*\d[\d.,]*\s*(?:mg|g|mcg|µg|ml|IU|UI|MIU|mIU|%))*/i

function extractDosage(genericDesc: string): string | null {
  const m = genericDesc.match(DOSAGE_RE)
  return m ? m[0].replace(/\s+/g, " ").trim() : null
}

function titleCaseUnit(unit: string): string {
  const u = unit.trim()
  if (!u) return "Unit"
  return u.toLowerCase().replace(/\b\w/g, (c) => c.toUpperCase())
}

function parsePrice(raw: string): number | null {
  const cleaned = raw.replace(/[,\s]/g, "").replace(/[^0-9.]/g, "")
  if (!cleaned) return null
  const n = Number(cleaned)
  return Number.isFinite(n) && n >= 0 ? n : null
}

export interface ImportRow {
  drugCode: string
  productType: "medicine" | "supply"
  productName: string
  genericName: string | null
  dosage: string | null
  form: string
  unit: string
  price: number
}

export interface SkippedRow {
  rowNumber: number // 1-based, relative to the raw sheet, for the admin to find it in Excel
  reason: string
  raw: string[]
}

export interface ImportPreview {
  rows: ImportRow[]
  skipped: SkippedRow[]
}

export function buildImportPreview(rows: string[][], headerRowIndex: number, mapping: ColumnMapping): ImportPreview {
  const out: ImportRow[] = []
  const skipped: SkippedRow[] = []
  const cell = (row: string[], col: number | null) => (col === null ? "" : (row[col] ?? "").toString().trim())

  for (let i = headerRowIndex + 1; i < rows.length; i++) {
    const row = rows[i]
    const rowNumber = i + 1
    if (!row || row.every((c) => !c || !c.toString().trim())) continue // blank row, not worth reporting

    const drugCode = cell(row, mapping.code)
    const priceRaw = cell(row, mapping.price)
    const price = parsePrice(priceRaw)

    if (!drugCode) { skipped.push({ rowNumber, reason: "No drug code in the mapped column", raw: row }); continue }
    if (price === null) { skipped.push({ rowNumber, reason: `Price column didn't parse as a number ("${priceRaw}")`, raw: row }); continue }

    const genericName = cell(row, mapping.genericName)
    const name = cell(row, mapping.name) || genericName
    if (!name) { skipped.push({ rowNumber, reason: "No product name in the mapped column", raw: row }); continue }

    const unitRaw = cell(row, mapping.unit)
    const form = titleCaseUnit(unitRaw)

    out.push({
      drugCode,
      productType: classifyProductType(genericName, name),
      productName: name.slice(0, 150),
      genericName: genericName ? genericName.slice(0, 150) : null,
      dosage: extractDosage(genericName || name),
      form,
      unit: form,
      price,
    })
  }

  return { rows: out, skipped }
}
