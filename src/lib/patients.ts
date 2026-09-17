import { supabase, branchArg } from "./supabase"

export type PatientGender = "male" | "female" | "other"

export interface Patient {
  id: string
  fullName: string
  gender: PatientGender | null
  age: number | null
  /** The per-branch identity key. Equals `phone` for anything recorded since
   *  phone and TIN were split apart; older rows may hold whichever single
   *  value was captured at the time. */
  tinOrPhone: string
  phone: string
  /** Businesses and insured patients have one; most walk-ins do not. */
  tin: string | null
  /** The patient's own insurance membership/policy number -- distinct from
   *  `tin` (their own tax ID) and from the insurance provider's own TIN.
   *  Null for a cash/walk-in patient with no insurance on file. */
  insuranceNumber: string | null
}

export interface PatientListRow extends Patient {
  visitCount: number
  lastVisitAt: string | null
  lifetimeSpend: number
}

export async function findPatientByIdentifier(identifier: string, branchId?: string): Promise<Patient | null> {
  const trimmed = identifier.trim()
  if (!trimmed) return null
  const { data, error } = await supabase.rpc("find_patient_by_identifier", { p_identifier: trimmed, ...branchArg(branchId) })
  if (error) throw error
  const row = (data ?? [])[0]
  if (!row) return null
  return {
    id: row.id, fullName: row.full_name, gender: row.gender, age: row.age,
    tinOrPhone: row.tin_or_phone, phone: row.phone ?? row.tin_or_phone, tin: row.tin ?? null,
    insuranceNumber: row.insurance_number ?? null,
  }
}

// Insert-or-update keyed on the phone number within the branch -- this is
// both "register a new patient" and "found them, just change what's
// different," the same RPC either way. A blank TIN never wipes one already on
// file (the RPC coalesces), so a visit that doesn't retype it is harmless.
export async function upsertPatient(
  fullName: string,
  gender: PatientGender | null,
  age: number | null,
  phone: string,
  tin?: string | null,
  branchId?: string,
  insuranceNumber?: string | null
): Promise<string> {
  const { data, error } = await supabase.rpc("upsert_patient", {
    p_full_name: fullName, p_gender: gender, p_age: age,
    p_phone: phone, p_tin: tin?.trim() || null, p_insurance_number: insuranceNumber?.trim() || null,
    ...branchArg(branchId),
  })
  if (error) throw error
  return data as string
}

export async function listBranchPatients(branchId?: string): Promise<PatientListRow[]> {
  const { data, error } = await supabase.rpc("list_branch_patients", { ...branchArg(branchId) })
  if (error) throw error
  return ((data ?? []) as any[]).map(row => ({
    id: row.id, fullName: row.full_name, gender: row.gender, age: row.age,
    tinOrPhone: row.tin_or_phone, phone: row.phone ?? row.tin_or_phone, tin: row.tin ?? null,
    insuranceNumber: row.insurance_number ?? null,
    visitCount: Number(row.visit_count), lastVisitAt: row.last_visit_at, lifetimeSpend: Number(row.lifetime_spend),
  }))
}
