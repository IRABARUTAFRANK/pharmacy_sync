// PROVIDER-AGNOSTIC. Nothing here knows Pesapal exists -- this is the
// contract any gateway (Pesapal today, pawaPay for mobile money only)
// implements. index.ts and the pending_payments table only ever talk to
// this interface; only providers/pesapal.ts talks to a real HTTP API.
// Duplicated verbatim in supabase/functions/pawapay-payment/provider.ts --
// each Edge Function is bundled independently, so this can't be a shared
// import; keep the two files in sync if this interface ever changes.
//
// Card is not a separate method here on purpose: initiateCharge() always
// returns whatever's needed to complete payment (Pesapal's own hosted page
// collects card number/CVV/expiry there; this app never receives them). If
// a future provider ever needs a genuinely different call for card vs
// mobile money, that split happens inside that provider's own
// implementation of this same method, not in this interface.

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
  /** The provider's own tracking id for this attempt (Pesapal: order_tracking_id). */
  providerReference: string
  /** Where the customer completes payment -- shown as a QR code / link. Always present for Pesapal (a hosted-page provider); optional in the interface because a direct-push provider like pawaPay has none. */
  redirectUrl?: string
}

export type ProviderStatus = "success" | "failed" | "pending"

export interface StatusResult {
  status: ProviderStatus
  /** The provider's raw response, stored as-is for debugging/reconciliation. */
  raw: unknown
}

export interface PaymentProvider {
  /** Ensures this provider is ready to receive status callbacks (Pesapal: IPN registration). Safe to call every time -- must no-op if already set up. */
  ensureCallbackRegistered(callbackUrl: string): Promise<void>
  initiateCharge(order: ChargeOrder): Promise<ChargeResult>
  verifyStatus(providerReference: string): Promise<StatusResult>
}
