import { supabase } from "./supabase"

const LOGO_BUCKET = "branch-logos"

export interface BranchDetails {
  name: string
  address: string | null
  phone: string | null
  tin: string | null
  logoPath: string | null
  bankAccountNumber: string | null
  bankAccountName: string | null
  momoPayNumber: string | null
}

export async function getMyBranchDetails(): Promise<BranchDetails> {
  const { data, error } = await supabase.rpc("get_my_branch_details")
  if (error) throw error
  const row = (data ?? [])[0]
  return {
    name: row?.name ?? "", address: row?.address ?? null, phone: row?.phone ?? null, tin: row?.tin ?? null,
    logoPath: row?.logo_path ?? null, bankAccountNumber: row?.bank_account_number ?? null,
    bankAccountName: row?.bank_account_name ?? null, momoPayNumber: row?.momo_pay_number ?? null,
  }
}

export async function updateBranchDetails(
  address: string, phone: string, tin: string, logoPath: string | null,
  bankAccountNumber: string, bankAccountName: string, momoPayNumber: string,
): Promise<void> {
  const { error } = await supabase.rpc("update_branch_details", {
    p_address: address, p_phone: phone, p_tin: tin, p_logo_path: logoPath,
    p_bank_account_number: bankAccountNumber, p_bank_account_name: bankAccountName, p_momo_pay_number: momoPayNumber,
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
