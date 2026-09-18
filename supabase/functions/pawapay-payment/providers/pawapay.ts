// PAWAPAY-SPECIFIC. Verified against docs.pawapay.io (Initiate deposit,
// Check deposit status, Deposits/providers) rather than guessed. Nothing
// outside this file knows any of these field names -- everything talks to
// the PaymentProvider interface in ../provider.ts instead.
//
// Mobile money only -- there is no card method here at all (pawaPay simply
// doesn't offer one). create_pending_payment() already rejects provider=
// 'pawapay' + payment_method='card' server-side; this file additionally
// throws if it's ever asked, as a second line of defense.
//
// Architecturally different from Pesapal in two real ways:
//  1. No hosted checkout page -- initiateCharge() pushes a payment request
//     straight to the customer's phone (a USSD/PIN prompt from their own
//     MoMo provider), so ChargeResult has no redirectUrl here at all.
//  2. pawaPay's callback DOES carry the final status directly, and can be
//     cryptographically signed (RFC-9421 HTTP Message Signatures). This
//     file still doesn't trust it: verifying an RFC-9421 signature
//     correctly is real, easy-to-get-subtly-wrong work, and this design
//     already never needs to trust a callback's own claims -- it always
//     re-confirms with GET /v2/deposits/{depositId} before resolving
//     anything, exactly like the Pesapal side. A forged callback with a
//     real depositId only ever triggers an authenticated read of pawaPay's
//     own truth, never a fabricated success.

import type { ChargeOrder, ChargeResult, PaymentProvider, StatusResult } from "../provider.ts"

const ENV = (Deno.env.get("PAWAPAY_ENV") ?? "sandbox").toLowerCase()
const IS_LIVE = ENV === "live"
const BASE_URL = IS_LIVE ? "https://api.pawapay.io" : "https://api.sandbox.pawapay.io"

const API_TOKEN = Deno.env.get(IS_LIVE ? "PAWAPAY_LIVE_API_TOKEN" : "PAWAPAY_SANDBOX_API_TOKEN")
if (!API_TOKEN) {
  throw new Error(`Missing pawaPay ${IS_LIVE ? "live" : "sandbox"} API token -- set PAWAPAY_${IS_LIVE ? "LIVE" : "SANDBOX"}_API_TOKEN via 'supabase secrets set'`)
}

// Rwanda-only mapping, matching this app's own scope (see CORRESPONDENTS
// below) -- MTN_MOMO_RWA / AIRTEL_RWA are pawaPay's exact provider codes
// for Rwanda, confirmed against their providers list.
const CORRESPONDENTS: Record<"mtn_momo" | "airtel_money", string> = {
  mtn_momo: "MTN_MOMO_RWA",
  airtel_money: "AIRTEL_RWA",
}

// pawaPay wants digits only, country code mandatory, no leading zero (e.g.
// "250788123456"). Rwandan numbers are typically entered locally as
// "07XXXXXXXX" or "7XXXXXXXX" -- this normalizes either of those, or an
// already-international "250..." number, to that exact shape.
export function normalizeRwandaPhone(raw: string): string {
  const digits = raw.replace(/\D/g, "")
  if (digits.startsWith("250")) return digits
  if (digits.startsWith("0")) return `250${digits.slice(1)}`
  return `250${digits}`
}

async function pawapayFetch(path: string, init: RequestInit = {}): Promise<any> {
  const res = await fetch(`${BASE_URL}${path}`, {
    ...init,
    headers: {
      Accept: "application/json",
      "Content-Type": "application/json",
      Authorization: `Bearer ${API_TOKEN}`,
      ...init.headers,
    },
  })
  const body = await res.json().catch(() => ({}))
  if (!res.ok) {
    throw new Error(`pawaPay API error (${path}): ${body?.errorMessage ?? body?.message ?? res.statusText}`)
  }
  return body
}

export class PawapayProvider implements PaymentProvider {
  // Callback URLs are configured once, statically, in the pawaPay
  // dashboard -- there is no runtime "register this URL" API call the way
  // Pesapal needs one per notification_id. Nothing to do here; kept only
  // to satisfy the shared interface.
  async ensureCallbackRegistered(_callbackUrl: string): Promise<void> {
    return
  }

  async initiateCharge(order: ChargeOrder): Promise<ChargeResult> {
    if (order.paymentMethod === "card") {
      throw new Error("pawaPay does not support card payments")
    }
    if (!order.customerPhone) {
      throw new Error("A customer phone number is required for a mobile money payment")
    }

    const result = await pawapayFetch("/v2/deposits", {
      method: "POST",
      body: JSON.stringify({
        depositId: order.merchantReference,
        amount: String(Math.round(order.amount)), // RWA correspondents don't support decimals
        currency: order.currency,
        payer: {
          type: "MMO",
          accountDetails: {
            phoneNumber: normalizeRwandaPhone(order.customerPhone),
            provider: CORRESPONDENTS[order.paymentMethod],
          },
        },
      }),
    })

    // ACCEPTED = now processing (the customer's phone gets the prompt next).
    // DUPLICATE_IGNORED = we've already submitted this exact depositId
    // before (a retried request) -- functionally the same as ACCEPTED from
    // our side, since a deposit is already genuinely in flight for it.
    if (result.status !== "ACCEPTED" && result.status !== "DUPLICATE_IGNORED") {
      throw new Error(`pawaPay rejected this payment: ${result.failureReason?.failureMessage ?? result.status}`)
    }

    // No redirectUrl -- this is a direct push, not a hosted page. The
    // depositId we generated IS pawaPay's own tracking reference too.
    return { providerReference: order.merchantReference }
  }

  async verifyStatus(providerReference: string): Promise<StatusResult> {
    const result = await pawapayFetch(`/v2/deposits/${encodeURIComponent(providerReference)}`, { method: "GET" })

    // NOT_FOUND should never really happen (we always look up our own
    // just-created depositId), but if it does, treat it as still-pending
    // rather than failed -- same reasoning as Pesapal's ambiguous status_
    // code handling: never conclude "failed" from an inconclusive answer.
    if (result.status !== "FOUND") return { status: "pending", raw: result }

    const depositStatus = result.data?.status
    const status = depositStatus === "COMPLETED" ? "success" : depositStatus === "FAILED" ? "failed" : "pending"
    return { status, raw: result }
  }
}
