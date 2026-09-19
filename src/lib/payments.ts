import { FunctionsHttpError } from "@supabase/supabase-js"
import { supabase, branchArg } from "./supabase"
import type { PaymentMethod } from "./branch"

// Mobile money / card checkout on top of the existing cash flow (complete_
// sale() itself is untouched for cash -- see 2026-09-18_pesapal_payments.sql
// for the full server-side design). This file is deliberately thin: it only
// ever calls RPCs and one of the two payment Edge Functions, exactly like
// every other lib file in this app -- no payment logic of its own lives
// here.
//
// GATEWAY_PROVIDER is the one line that decides which gateway is live right
// now, and therefore which Edge Function name gets called -- Pesapal
// (hosted checkout, supports card) or pawaPay (mobile money only, direct
// push to the customer's phone, no card). Everything else in this file, and
// in SalesPage.tsx, is written against the two providers' shared shape
// (PendingPaymentStatus, a possibly-absent redirectUrl) rather than special-
// casing either one, so switching this constant back is the entire cutover.
export type GatewayProvider = "pesapal" | "pawapay"
export const GATEWAY_PROVIDER = "pawapay" as GatewayProvider
const EDGE_FUNCTION_NAME: Record<GatewayProvider, string> = { pesapal: "pesapal-payment", pawapay: "pawapay-payment" }

// pawaPay has no card product at all -- Cash/MTN MoMo/Airtel Money only.
export const SUPPORTS_CARD = GATEWAY_PROVIDER === "pesapal"

export type GatewayPaymentMethod = Extract<PaymentMethod, "mtn_momo" | "airtel_money" | "card">
export type PendingPaymentStatus = "pending" | "success" | "failed" | "expired"

export interface PendingPaymentLine {
  code: string
  sellMode: "whole" | "packs" | "pieces"
  quantity: number | null
}

export interface CreatePendingPaymentInput {
  lines: PendingPaymentLine[]
  paymentMethod: GatewayPaymentMethod
  insuranceProviderId?: string | null
  patientId?: string | null
  patientPhone?: string | null
  discountId?: string | null
  branchId?: string
}

export interface CreatePendingPaymentResult {
  pendingPaymentId: string
  merchantReference: string
  amount: number
}

async function unwrapFunctionError(error: unknown, fallback: string): Promise<never> {
  if (error instanceof FunctionsHttpError) {
    try {
      const body = await error.context.json()
      if (body?.error) throw new Error(body.error)
    } catch {
      // body wasn't JSON, or already consumed -- fall through to the generic message
    }
  }
  throw error instanceof Error ? error : new Error(fallback)
}

// create_pending_payment() prices the cart itself, server-side (see
// _price_sale_lines() in the migration) -- the returned `amount` is what's
// actually charged, never something this function invents or trusts from
// the caller.
export async function createPendingPayment(input: CreatePendingPaymentInput): Promise<CreatePendingPaymentResult> {
  const { data, error } = await supabase.rpc("create_pending_payment", {
    p_lines: input.lines.map(line => ({ code: line.code, sell_mode: line.sellMode, quantity: line.quantity })),
    p_payment_method: input.paymentMethod,
    p_insurance_provider_id: input.insuranceProviderId ?? null,
    p_patient_id: input.patientId ?? null,
    p_patient_phone: input.patientPhone ?? null,
    p_discount_id: input.discountId ?? null,
    p_provider: GATEWAY_PROVIDER,
    ...branchArg(input.branchId),
  })
  if (error) throw error
  const row = Array.isArray(data) ? data[0] : data
  return { pendingPaymentId: row.pending_payment_id, merchantReference: row.merchant_reference, amount: Number(row.amount) }
}

export interface InitiatePaymentResult {
  status: PendingPaymentStatus
  redirectUrl?: string
}

// returnUrl is where the CUSTOMER's own browser lands after they finish on
// a hosted checkout page -- purely cosmetic (the till never relies on it,
// it only polls checkPaymentStatus), so this always passes the app's own
// current origin. pawaPay ignores it entirely (there's no hosted page to
// redirect from), and initiatePayment's result has no redirectUrl there.
export async function initiatePayment(pendingPaymentId: string): Promise<InitiatePaymentResult> {
  const { data, error } = await supabase.functions.invoke<InitiatePaymentResult & { error?: string }>(EDGE_FUNCTION_NAME[GATEWAY_PROVIDER], {
    body: { action: "initiate", pendingPaymentId, returnUrl: `${window.location.origin}/#payment-return` },
  })
  if (error) await unwrapFunctionError(error, "Could not start this payment.")
  if (!data) throw new Error("Could not start this payment.")
  return data
}

export interface PaymentStatusResult {
  status: PendingPaymentStatus
  saleId?: string
  failureReason?: string
}

export async function checkPaymentStatus(pendingPaymentId: string): Promise<PaymentStatusResult> {
  const { data, error } = await supabase.functions.invoke<PaymentStatusResult & { error?: string }>(EDGE_FUNCTION_NAME[GATEWAY_PROVIDER], {
    body: { action: "check-status", pendingPaymentId },
  })
  if (error) await unwrapFunctionError(error, "Could not check this payment's status.")
  if (!data) throw new Error("Could not check this payment's status.")
  return data
}

// A branch's own still-open payment attempts (e.g. after a browser refresh
// mid-wait) -- plain RLS-scoped read, same as any other table in this app.
export interface OpenPendingPayment {
  id: string
  amount: number
  paymentMethod: GatewayPaymentMethod
  createdAt: string
}

export async function listOpenPendingPayments(): Promise<OpenPendingPayment[]> {
  // Scoped to the CURRENTLY active provider -- a row created under a
  // provider that's since been switched away from can never resolve
  // through today's Edge Function anyway (its provider_reference means
  // nothing to the other gateway), so resuming it would just poll forever.
  // expire_stale_pending_payments() times those out on its own regardless.
  const { data, error } = await supabase
    .from("pending_payments")
    .select("id, amount, payment_method, created_at")
    .eq("status", "pending")
    .eq("provider", GATEWAY_PROVIDER)
    .order("created_at", { ascending: false })
  if (error) throw error
  return (data ?? []).map(row => ({
    id: row.id, amount: Number(row.amount), paymentMethod: row.payment_method as GatewayPaymentMethod, createdAt: row.created_at,
  }))
}
