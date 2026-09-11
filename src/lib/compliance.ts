import { supabase, branchArg } from "./supabase"

function raise(error: unknown, fallback: string): never {
  throw error instanceof Error ? error : new Error((error as any)?.message ?? fallback)
}

export interface MonthlyVatPoint {
  monthLabel: string
  monthStart: string
  revenue: number
  vatTotal: number
}

export async function loadVatByMonth(months = 8, branchId?: string): Promise<MonthlyVatPoint[]> {
  const { data, error } = await supabase.rpc("analytics_vat_by_month", { p_months: months, ...branchArg(branchId) })
  if (error) raise(error, "Could not load monthly VAT totals.")
  return ((data ?? []) as any[]).map(row => ({
    monthLabel: row.month_label, monthStart: row.month_start,
    revenue: Number(row.revenue), vatTotal: Number(row.vat_total),
  }))
}

export interface ComplianceTransaction {
  saleId: string
  receiptNumber: string
  soldAt: string
  patientName: string | null
  itemCount: number
  subtotal: number
  taxTotal: number
  totalAmount: number
  paymentMethod: string | null
  hasInsurance: boolean
}

export async function listComplianceTransactions(from: string, to: string, limit = 200, branchId?: string): Promise<ComplianceTransaction[]> {
  const { data, error } = await supabase.rpc("list_compliance_transactions", { p_from: from, p_to: to, p_limit: limit, ...branchArg(branchId) })
  if (error) raise(error, "Could not load transaction records.")
  return ((data ?? []) as any[]).map(row => ({
    saleId: row.sale_id, receiptNumber: row.receipt_number, soldAt: row.sold_at,
    patientName: row.patient_name, itemCount: Number(row.item_count),
    subtotal: Number(row.subtotal), taxTotal: Number(row.tax_total), totalAmount: Number(row.total_amount),
    paymentMethod: row.payment_method, hasInsurance: row.has_insurance,
  }))
}

const PAYMENT_METHOD_LABEL: Record<string, string> = {
  cash: "Cash", mtn_momo: "MTN MoMo", airtel_money: "Airtel Money", card: "Card",
}

export function paymentMethodLabel(method: string | null, hasInsurance: boolean): string {
  if (method && PAYMENT_METHOD_LABEL[method]) return PAYMENT_METHOD_LABEL[method]
  if (hasInsurance) return "Insurance"
  return "Not recorded"
}
