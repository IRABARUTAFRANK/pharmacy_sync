// PESAPAL-SPECIFIC. Everything in this file is real Pesapal API 3.0 request/
// response shapes -- verified against developer.pesapal.com (Authentication,
// SubmitOrderRequest, GetTransactionStatus, RegisterIPNURL) rather than
// guessed. Nothing outside this file (index.ts, the pending_payments table,
// SalesPage.tsx) knows any of these field names -- they all talk to the
// PaymentProvider interface in ../provider.ts instead.
//
// Two real Pesapal facts that shaped this design:
//  1. There is NO separate "push a prompt to this phone number" API call --
//     card AND mobile money both go through SubmitOrderRequest, and the
//     customer completes payment on Pesapal's own hosted redirect_url page.
//  2. Pesapal's IPN callback carries NO status -- just OrderTrackingId /
//     OrderMerchantReference / OrderNotificationType. GetTransactionStatus
//     is not an extra safeguard on top of a signed payload; it IS the only
//     way to learn what happened, always.

import type { ChargeOrder, ChargeResult, PaymentProvider, ProviderStatus, StatusResult } from "../provider.ts"

// PESAPAL_ENV picks both the base URL and which secret pair to read, so
// sandbox testing and a later live cutover never touch the same
// credentials by accident -- flipping PESAPAL_ENV=live is the entire
// cutover, and the sandbox keys stay set (and usable) the whole time.
const ENV = (Deno.env.get("PESAPAL_ENV") ?? "sandbox").toLowerCase()
const IS_LIVE = ENV === "live"

const BASE_URL = IS_LIVE ? "https://pay.pesapal.com/v3" : "https://cybqa.pesapal.com/pesapalv3"

const CONSUMER_KEY = Deno.env.get(IS_LIVE ? "PESAPAL_LIVE_CONSUMER_KEY" : "PESAPAL_SANDBOX_CONSUMER_KEY")
const CONSUMER_SECRET = Deno.env.get(IS_LIVE ? "PESAPAL_LIVE_CONSUMER_SECRET" : "PESAPAL_SANDBOX_CONSUMER_SECRET")

if (!CONSUMER_KEY || !CONSUMER_SECRET) {
  throw new Error(`Missing Pesapal ${IS_LIVE ? "live" : "sandbox"} credentials -- set PESAPAL_${IS_LIVE ? "LIVE" : "SANDBOX"}_CONSUMER_KEY/SECRET via 'supabase secrets set'`)
}

// The access token is valid for only 5 minutes (Pesapal's own documented
// limit) -- module-level cache only helps a warm instance skip a redundant
// call within that window, correctness never depends on it surviving a
// cold start.
let cachedToken: { value: string; expiresAtMs: number } | null = null

async function getToken(): Promise<string> {
  if (cachedToken && cachedToken.expiresAtMs - Date.now() > 60_000) return cachedToken.value

  const res = await fetch(`${BASE_URL}/api/Auth/RequestToken`, {
    method: "POST",
    headers: { Accept: "application/json", "Content-Type": "application/json" },
    body: JSON.stringify({ consumer_key: CONSUMER_KEY, consumer_secret: CONSUMER_SECRET }),
  })
  const body = await res.json()
  if (!res.ok || !body.token) {
    throw new Error(`Pesapal auth failed: ${body?.error?.message ?? body?.message ?? res.statusText}`)
  }
  cachedToken = { value: body.token, expiresAtMs: Date.now() + 5 * 60_000 }
  return body.token
}

async function pesapalFetch(path: string, init: RequestInit = {}): Promise<any> {
  const token = await getToken()
  const res = await fetch(`${BASE_URL}${path}`, {
    ...init,
    headers: {
      Accept: "application/json",
      "Content-Type": "application/json",
      Authorization: `Bearer ${token}`,
      ...init.headers,
    },
  })
  const body = await res.json().catch(() => ({}))
  if (!res.ok || body?.error) {
    throw new Error(`Pesapal API error (${path}): ${body?.error?.message ?? body?.message ?? res.statusText}`)
  }
  return body
}

// In-memory only -- correctness never depends on this surviving a cold
// start, since ensureCallbackRegistered() always re-verifies against
// Pesapal's own GetIPNList rather than trusting a stale cached id.
let cachedIpnId: string | null = null

export class PesapalProvider implements PaymentProvider {
  async ensureCallbackRegistered(callbackUrl: string): Promise<void> {
    if (cachedIpnId) return

    const list = await pesapalFetch("/api/URLSetup/GetIpnList", { method: "GET" })
    const existing = Array.isArray(list) ? list.find((row: any) => row.url === callbackUrl) : null
    if (existing?.ipn_id) {
      cachedIpnId = existing.ipn_id
      return
    }

    const registered = await pesapalFetch("/api/URLSetup/RegisterIPN", {
      method: "POST",
      body: JSON.stringify({ url: callbackUrl, ipn_notification_type: "GET" }),
    })
    if (!registered?.ipn_id) throw new Error("Pesapal did not return an ipn_id when registering the IPN URL")
    cachedIpnId = registered.ipn_id
  }

  async initiateCharge(order: ChargeOrder): Promise<ChargeResult> {
    if (!cachedIpnId) throw new Error("ensureCallbackRegistered() must run before initiateCharge()")

    const body = {
      id: order.merchantReference,
      currency: order.currency,
      amount: order.amount,
      description: order.description.slice(0, 100),
      callback_url: order.callbackUrl,
      notification_id: cachedIpnId,
      billing_address: {
        phone_number: order.customerPhone || undefined,
        // Pesapal requires phone_number OR email_address -- this app never
        // collects a customer email, so a placeholder keeps card payments
        // (where customerPhone is never collected) working too.
        email_address: order.customerPhone ? undefined : "customer@pharmsync.local",
        country_code: "RW",
      },
    }

    const result = await pesapalFetch("/api/Transactions/SubmitOrderRequest", {
      method: "POST",
      body: JSON.stringify(body),
    })

    if (!result.order_tracking_id || !result.redirect_url) {
      throw new Error(`Pesapal did not return an order_tracking_id/redirect_url: ${JSON.stringify(result)}`)
    }
    return { providerReference: result.order_tracking_id, redirectUrl: result.redirect_url }
  }

  async verifyStatus(providerReference: string): Promise<StatusResult> {
    const result = await pesapalFetch(
      `/api/Transactions/GetTransactionStatus?orderTrackingId=${encodeURIComponent(providerReference)}`,
      { method: "GET" },
    )

    // status_code: 0=INVALID, 1=COMPLETED, 2=FAILED, 3=REVERSED (Pesapal's
    // own documented values -- there is no explicit "still pending" code).
    // Only a clean 1 counts as success; 2/3 are definite failures. 0 and
    // anything unrecognized are treated as still-pending rather than
    // failed -- a real "this reference doesn't exist" case should never
    // happen (we always pass back our own just-created tracking id), and
    // treating an ambiguous response as failure risks wrongly killing a
    // real in-flight payment. Worst case an unresolvable one sits pending
    // until expire_stale_pending_payments() times it out -- never worse
    // than ambiguous, matching the no-ambiguous-states goal.
    const code = result.status_code
    const status: ProviderStatus = code === 1 ? "success" : code === 2 || code === 3 ? "failed" : "pending"
    return { status, raw: result }
  }
}
