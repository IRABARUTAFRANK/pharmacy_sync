// ── RRA EBM 2.1 / VSDC integration scaffold ─────────────────────────────────
// This module is NOT a live connection yet. It exists so the receipt UI and
// the sale-completion flow can be wired up in one place once the pharmacy has
// gone through RRA's VSDC onboarding. Until then, submitSaleToVsdc() always
// throws and every ReceiptData.ebm* field stays null.
//
// What this needs before it can go live (from RRA's own VSDC Specification
// Document v1.0.4, 2022):
//   1. Apply for VSDC service and get RRA's approval (via myrra.rra.gov.rw,
//      or myrratest.rra.gov.rw for the test environment).
//   2. RRA/your integrator deploys a VSDC ".war" service on a server you
//      control -- it is NOT something this web app calls directly over the
//      public internet. The CIS (this app) talks to that local VSDC service
//      (typically http://localhost:8080/...), and the VSDC service is what
//      actually talks to RRA's EBM 2.1 API server.
//   3. Because that VSDC service normally lives on a machine on the
//      pharmacy's own network, submitSaleToVsdc() below should be called from
//      a small server-side proxy (e.g. a Supabase Edge Function) that has
//      network access to it -- never directly from the browser.
//
// EBM 2.1 API server addresses (for the proxy's own reference -- the browser
// never calls these directly):
//   Production: https://api-ebm.rra.gov.rw
//   Test/sandbox: https://sdcsandbox.rra.gov.rw
//
// Field names below (tin, bhfId, invcNo, taxblAmtA..D, rcptSign, sdcId, ...)
// are taken directly from that spec's "Sales Transaction Save" section
// (TrnsSalesSaveReq / TrnsSalesSaveWrRes) so the shapes are ready to use once
// real credentials exist -- confirm against the current spec/Postman
// collection from RRA before going live, in case of a newer revision.

export type VsdcTaxTypeCode = "A" | "B" | "C" | "D"

// Per the spec's Tax Type code table: A = exempt, B = 18% (Rwanda's standard
// VAT rate), C and D are reserved for other rates RRA may define. Anything
// that isn't 18% is mapped to C here as a safe placeholder -- confirm the
// exact A/C/D split for zero-rated vs. exempt goods with RRA before relying
// on it for filing.
export function mapTaxRateToVsdcCode(ratePercentage: number): VsdcTaxTypeCode {
  if (ratePercentage === 18) return "B"
  if (ratePercentage === 0) return "A"
  return "C"
}

export interface VsdcConfig {
  /** Base URL of the locally-deployed VSDC web service, e.g. "http://localhost:8080". */
  vsdcBaseUrl: string
  /** Branch's registered Taxpayer Identification Number. */
  tin: string
  /** RRA branch office code (e.g. "00" for the head office). */
  bhfId: string
}

export interface VsdcSaleItem {
  itemSeq: number
  itemCd: string
  itemClsCd: string
  itemNm: string
  bcd: string | null
  pkgUnitCd: string
  pkg: number
  qtyUnitCd: string
  qty: number
  prc: number
  splyAmt: number
  dcRt: number
  dcAmt: number
  taxTyCd: VsdcTaxTypeCode
  taxblAmt: number
  taxAmt: number
  totAmt: number
}

// Mirrors TrnsSalesSaveReq from the VSDC spec (section 3.3.6.1).
export interface VsdcSaleRequest {
  tin: string
  bhfId: string
  invcNo: number
  orgInvcNo: number
  custTin: string | null
  custNm: string | null
  salesTyCd: "N"
  rcptTyCd: "S"
  pmtTyCd: string
  salesSttsCd: "02"
  cfmDt: string
  salesDt: string
  totItemCnt: number
  taxblAmtA: number
  taxblAmtB: number
  taxblAmtC: number
  taxblAmtD: number
  taxAmtA: number
  taxAmtB: number
  taxAmtC: number
  taxAmtD: number
  totTaxblAmt: number
  totTaxAmt: number
  totAmt: number
  remark: string | null
  regrId: string
  regrNm: string
  modrId: string
  modrNm: string
  receipt: {
    custTin: string | null
    custMblNo: string | null
    rptNo: number
    trdeNm: string
    adrs: string
    topMsg: string | null
    btmMsg: string | null
  }
  itemList: VsdcSaleItem[]
}

// Mirrors TrnsSalesSaveWrRes's `data` object (section 3.3.6.1 response sample).
export interface VsdcSaleResponseData {
  rcptNo: number
  intrlData: string
  rcptSign: string
  totRcptNo: number
  vsdcRcptPbctDate: string
  sdcId: string
  mrcNo: string
}

export interface VsdcSaleResponse {
  resultCd: string
  resultMsg: string
  resultDt: string
  data: VsdcSaleResponseData | null
}

function formatVsdcDateTime(iso: string): string {
  // Spec sample uses "YYYYMMDDHHmmss".
  return iso.replace(/[-:T]/g, "").slice(0, 14)
}

// Builds the request body VSDC expects for /trnsSales/saveSales, from data
// this app already has. `invcNo` must be the branch's own gapless sequential
// invoice counter (tracked by the pharmacy, not by this function) -- reusing
// or skipping a number will be rejected by RRA.
export function buildVsdcSaleRequest(args: {
  config: VsdcConfig
  invcNo: number
  cashierId: string
  cashierName: string
  issuedAt: string
  customerTin: string | null
  customerName: string | null
  customerPhone: string | null
  branchTradeName: string
  branchAddress: string
  items: Array<{
    itemCd: string
    itemClsCd: string
    itemNm: string
    barcode: string | null
    quantity: number
    unitPrice: number
    subtotal: number
    taxAmount: number
    taxRatePercentage: number
  }>
}): VsdcSaleRequest {
  const { config, items } = args
  const dt = formatVsdcDateTime(args.issuedAt)
  const byCode: Record<VsdcTaxTypeCode, { taxbl: number; tax: number }> = {
    A: { taxbl: 0, tax: 0 }, B: { taxbl: 0, tax: 0 }, C: { taxbl: 0, tax: 0 }, D: { taxbl: 0, tax: 0 },
  }

  const itemList: VsdcSaleItem[] = items.map((item, i) => {
    const taxTyCd = mapTaxRateToVsdcCode(item.taxRatePercentage)
    byCode[taxTyCd].taxbl += item.subtotal
    byCode[taxTyCd].tax += item.taxAmount
    return {
      itemSeq: i + 1, itemCd: item.itemCd, itemClsCd: item.itemClsCd, itemNm: item.itemNm,
      bcd: item.barcode, pkgUnitCd: "NT", pkg: 1, qtyUnitCd: "U", qty: item.quantity,
      prc: item.unitPrice, splyAmt: item.subtotal, dcRt: 0, dcAmt: 0,
      taxTyCd, taxblAmt: item.subtotal, taxAmt: item.taxAmount, totAmt: item.subtotal + item.taxAmount,
    }
  })

  const totTaxblAmt = itemList.reduce((s, i) => s + i.taxblAmt, 0)
  const totTaxAmt = itemList.reduce((s, i) => s + i.taxAmt, 0)

  return {
    tin: config.tin, bhfId: config.bhfId, invcNo: args.invcNo, orgInvcNo: 0,
    custTin: args.customerTin, custNm: args.customerName,
    salesTyCd: "N", rcptTyCd: "S", pmtTyCd: "01", salesSttsCd: "02",
    cfmDt: dt, salesDt: dt.slice(0, 8), totItemCnt: itemList.length,
    taxblAmtA: byCode.A.taxbl, taxblAmtB: byCode.B.taxbl, taxblAmtC: byCode.C.taxbl, taxblAmtD: byCode.D.taxbl,
    taxAmtA: byCode.A.tax, taxAmtB: byCode.B.tax, taxAmtC: byCode.C.tax, taxAmtD: byCode.D.tax,
    totTaxblAmt, totTaxAmt, totAmt: totTaxblAmt + totTaxAmt,
    remark: null, regrId: args.cashierId, regrNm: args.cashierName, modrId: args.cashierId, modrNm: args.cashierName,
    receipt: {
      custTin: args.customerTin, custMblNo: args.customerPhone, rptNo: 1,
      trdeNm: args.branchTradeName, adrs: args.branchAddress, topMsg: null, btmMsg: null,
    },
    itemList,
  }
}

// Not wired up yet -- there is no VSDC service or device registered for this
// pharmacy to call. Throws until a real `config.vsdcBaseUrl` is supplied by a
// server-side proxy that can reach it.
export async function submitSaleToVsdc(_request: VsdcSaleRequest, config: VsdcConfig): Promise<VsdcSaleResponse> {
  throw new Error(
    `VSDC is not configured for this branch yet. Apply for VSDC access at myrra.rra.gov.rw, deploy the ` +
    `VSDC service RRA provides, then call this from a server-side proxy pointed at it ` +
    `(got vsdcBaseUrl="${config.vsdcBaseUrl}").`
  )
}

// What the printed receipt's QR code should encode so a customer or auditor
// can look the sale up. RRA's own verification-portal URL scheme isn't in
// the VSDC integration spec (that spec covers the CIS<->VSDC data API, not
// the printed-receipt format) -- confirm the exact URL/format RRA expects
// once VSDC is live, and swap it in here. Until then this stays a plain data
// payload rather than a guessed URL.
export function buildVerificationQrPayload(data: {
  sdcId: string
  mrcNo: string
  invcNo: number
  rcptSign: string
  issuedAt: string
}): string {
  return [
    `SDC:${data.sdcId}`, `MRC:${data.mrcNo}`, `INV:${data.invcNo}`,
    `SIG:${data.rcptSign}`, `DT:${formatVsdcDateTime(data.issuedAt)}`,
  ].join("|")
}
