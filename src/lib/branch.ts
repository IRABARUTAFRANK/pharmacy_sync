import { supabase, branchArg } from "./supabase"

const LOGO_BUCKET = "branch-logos"

export type BranchLanguage = "en" | "fr" | "rw"
export type PaymentMethod = "cash" | "mtn_momo" | "airtel_money" | "card"

export interface BranchDetails {
  name: string
  address: string | null
  phone: string | null
  tin: string | null
  logoPath: string | null
  bankAccountNumber: string | null
  bankAccountName: string | null
  momoPayNumber: string | null
  outOfStockReminderHours: number
  branchCode: string | null
  status: string
  createdAt: string
  email: string | null
  website: string | null
  licenseNumber: string | null
  licenseExpiryDate: string | null
  ebmDeviceSerial: string | null
  defaultLanguage: BranchLanguage
  receiptNumberPrefix: string
  posCashEnabled: boolean
  posMtnMomoEnabled: boolean
  posAirtelMoneyEnabled: boolean
  posCardEnabled: boolean
  posInsuranceEnabled: boolean
  posDefaultPaymentMethod: PaymentMethod
  posRequirePatientName: boolean
  posAllowDiscounts: boolean
  posShowPatientHistory: boolean
  expiryAlertThresholdDays: number
  defaultReorderMin: number
  latitude: number | null
  longitude: number | null
}

export async function getMyBranchDetails(branchId?: string): Promise<BranchDetails> {
  const { data, error } = await supabase.rpc("get_my_branch_details", { ...branchArg(branchId) })
  if (error) throw error
  const row = (data ?? [])[0]
  return {
    name: row?.name ?? "", address: row?.address ?? null, phone: row?.phone ?? null, tin: row?.tin ?? null,
    logoPath: row?.logo_path ?? null, bankAccountNumber: row?.bank_account_number ?? null,
    bankAccountName: row?.bank_account_name ?? null, momoPayNumber: row?.momo_pay_number ?? null,
    outOfStockReminderHours: row?.out_of_stock_reminder_hours ?? 6, branchCode: row?.branch_code ?? null,
    status: row?.status ?? "active", createdAt: row?.created_at ?? "",
    email: row?.email ?? null, website: row?.website ?? null, licenseNumber: row?.license_number ?? null,
    licenseExpiryDate: row?.license_expiry_date ?? null, ebmDeviceSerial: row?.ebm_device_serial ?? null,
    defaultLanguage: (row?.default_language as BranchLanguage) ?? "en",
    receiptNumberPrefix: row?.receipt_number_prefix ?? "RCT",
    posCashEnabled: row?.pos_cash_enabled ?? true, posMtnMomoEnabled: row?.pos_mtn_momo_enabled ?? true,
    posAirtelMoneyEnabled: row?.pos_airtel_money_enabled ?? true, posCardEnabled: row?.pos_card_enabled ?? false,
    posInsuranceEnabled: row?.pos_insurance_enabled ?? true,
    posDefaultPaymentMethod: (row?.pos_default_payment_method as PaymentMethod) ?? "cash",
    posRequirePatientName: row?.pos_require_patient_name ?? false, posAllowDiscounts: row?.pos_allow_discounts ?? true,
    posShowPatientHistory: row?.pos_show_patient_history ?? true,
    expiryAlertThresholdDays: row?.expiry_alert_threshold_days ?? 60,
    defaultReorderMin: row?.default_reorder_min ?? 0,
    latitude: row?.latitude ?? null,
    longitude: row?.longitude ?? null,
  }
}

export interface UpdateBranchDetailsInput {
  address: string
  phone: string
  tin: string
  logoPath: string | null
  bankAccountNumber: string
  bankAccountName: string
  momoPayNumber: string
  outOfStockReminderHours?: number
  name: string
  email: string
  website: string
  licenseNumber: string
  licenseExpiryDate: string | null
  ebmDeviceSerial: string
  defaultLanguage: BranchLanguage
  receiptNumberPrefix: string
  posCashEnabled: boolean
  posMtnMomoEnabled: boolean
  posAirtelMoneyEnabled: boolean
  posCardEnabled: boolean
  posInsuranceEnabled: boolean
  posDefaultPaymentMethod: PaymentMethod
  posRequirePatientName: boolean
  posAllowDiscounts: boolean
  posShowPatientHistory: boolean
  expiryAlertThresholdDays: number
  defaultReorderMin: number
  latitude: number | null
  longitude: number | null
}

// The whole Branch Settings form saves together, one RPC call -- every field
// here is always sent with its current value (not just the ones the owner
// actually touched), which is what lets an empty string mean "clear this"
// server-side without also needing a separate "was this field even sent"
// signal. license_expiry_date is the one exception worth knowing: the RPC
// always overwrites it with whatever's passed (including null to clear a
// date), it does NOT preserve the old value when omitted the way the other
// optional fields do -- there's no "empty string" equivalent for a date, so
// this function must always pass the caller's real current value.
export async function updateBranchDetails(input: UpdateBranchDetailsInput, branchId?: string): Promise<void> {
  const { error } = await supabase.rpc("update_branch_details", {
    p_address: input.address, p_phone: input.phone, p_tin: input.tin, p_logo_path: input.logoPath,
    p_bank_account_number: input.bankAccountNumber, p_bank_account_name: input.bankAccountName, p_momo_pay_number: input.momoPayNumber,
    p_out_of_stock_reminder_hours: input.outOfStockReminderHours ?? null,
    p_name: input.name, p_email: input.email, p_website: input.website,
    p_license_number: input.licenseNumber, p_license_expiry_date: input.licenseExpiryDate, p_ebm_device_serial: input.ebmDeviceSerial,
    p_default_language: input.defaultLanguage,
    p_receipt_number_prefix: input.receiptNumberPrefix,
    p_pos_cash_enabled: input.posCashEnabled, p_pos_mtn_momo_enabled: input.posMtnMomoEnabled,
    p_pos_airtel_money_enabled: input.posAirtelMoneyEnabled, p_pos_card_enabled: input.posCardEnabled,
    p_pos_insurance_enabled: input.posInsuranceEnabled, p_pos_default_payment_method: input.posDefaultPaymentMethod,
    p_pos_require_patient_name: input.posRequirePatientName, p_pos_allow_discounts: input.posAllowDiscounts,
    p_pos_show_patient_history: input.posShowPatientHistory,
    p_expiry_alert_threshold_days: input.expiryAlertThresholdDays,
    p_default_reorder_min: input.defaultReorderMin,
    p_latitude: input.latitude,
    p_longitude: input.longitude,
    ...branchArg(branchId),
  })
  if (error) throw error
}

export async function uploadBranchLogo(file: File): Promise<string> {
  const ext = file.name.includes(".") ? file.name.split(".").pop() : "png"
  const path = `${crypto.randomUUID()}.${ext}`
  const { error } = await supabase.storage.from(LOGO_BUCKET).upload(path, file)
  if (error) throw new Error(error.message)
  return path
}

export function branchLogoUrl(path: string): string {
  return supabase.storage.from(LOGO_BUCKET).getPublicUrl(path).data.publicUrl
}
