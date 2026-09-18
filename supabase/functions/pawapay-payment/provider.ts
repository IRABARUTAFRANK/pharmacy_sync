// PROVIDER-AGNOSTIC. Same interface as supabase/functions/pesapal-payment/
// provider.ts -- duplicated here rather than imported across functions,
// since each Supabase Edge Function is bundled and deployed independently.
// Keep the two in sync if this interface ever changes.
//
// redirectUrl is optional here (Pesapal's twin file has it required): a
// pawaPay deposit is a direct push to the customer's phone -- there is no
// hosted page to redirect to. The frontend shows a QR/link when redirectUrl
// is present (Pesapal) and a plain "check your phone" message when it's
// absent (pawaPay) -- see SalesPage.tsx's gateway waiting modal.

export interface ChargeOrder {
  merchantReference: string
  amount: number
  currency: string
  description: string
  paymentMethod: "mtn_momo" | "airtel_money" | "card"
  customerPhone?: string
  callbackUrl: string
}

export interface ChargeResult {
  providerReference: string
  redirectUrl?: string
}

export type ProviderStatus = "success" | "failed" | "pending"

export interface StatusResult {
  status: ProviderStatus
  raw: unknown
}

export interface PaymentProvider {
  ensureCallbackRegistered(callbackUrl: string): Promise<void>
  initiateCharge(order: ChargeOrder): Promise<ChargeResult>
  verifyStatus(providerReference: string): Promise<StatusResult>
}
