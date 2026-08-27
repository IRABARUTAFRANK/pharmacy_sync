import { supabase } from "./supabase"

export type PatientGender = "male" | "female" | "other"

export interface Patient {
  id: string
  fullName: string
  gender: PatientGender | null
  age: number | null
  tinOrPhone: string
}

export interface PatientListRow extends Patient {
  visitCount: number
  lastVisitAt: string | null
  lifetimeSpend: number
}

export async function findPatientByIdentifier(identifier: string): Promise<Patient | null> {
  const trimmed = identifier.trim()
  if (!trimmed) return null
  const { data, error } = await supabase.rpc("find_patient_by_identifier", { p_identifier: trimmed })
  if (error) throw error
  const row = (data ?? [])[0]
  if (!row) return null
  return { id: row.id, fullName: row.full_name, gender: row.gender, age: row.age, tinOrPhone: row.tin_or_phone }
}

// Insert-or-update on (branch, tin_or_phone) -- this is both "register a new
// patient" and "found them, just change what's different," the same RPC
// either way.
export async function upsertPatient(fullName: string, gender: PatientGender | null, age: number | null, tinOrPhone: string): Promise<string> {
  const { data, error } = await supabase.rpc("upsert_patient", {
    p_full_name: fullName, p_gender: gender, p_age: age, p_tin_or_phone: tinOrPhone,
  })
  if (error) throw error
  return data as string
}

export async function listBranchPatients(): Promise<PatientListRow[]> {
  const { data, error } = await supabase.rpc("list_branch_patients")
  if (error) throw error
  return ((data ?? []) as any[]).map(row => ({
    id: row.id, fullName: row.full_name, gender: row.gender, age: row.age, tinOrPhone: row.tin_or_phone,
    visitCount: Number(row.visit_count), lastVisitAt: row.last_visit_at, lifetimeSpend: Number(row.lifetime_spend),
  }))
}
