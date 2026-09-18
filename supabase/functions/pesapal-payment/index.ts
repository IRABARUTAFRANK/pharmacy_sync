// Mostly PROVIDER-AGNOSTIC plumbing: three actions (initiate / check-status /
// ipn), all working purely in terms of the PaymentProvider interface
// (./provider.ts) and the pending_payments table. The only Pesapal-specific
// bits are clearly marked below (the IPN query-param names, and which
// concrete provider class gets constructed) -- swapping in a pawaPay
// implementation later means adding providers/pawapay.ts and changing the
// one `new PesapalProvider()` line, nothing else here.
//
// Deploy with (from the project root, after `supabase login` and
// `supabase link --project-ref <ref>`):
//   supabase functions deploy pesapal-payment
//   supabase secrets set PESAPAL_ENV=sandbox
//   supabase secrets set PESAPAL_SANDBOX_CONSUMER_KEY=... PESAPAL_SANDBOX_CONSUMER_SECRET=...
//   (later, going live: supabase secrets set PESAPAL_LIVE_CONSUMER_KEY=... PESAPAL_LIVE_CONSUMER_SECRET=...
//    then supabase secrets set PESAPAL_ENV=live -- sandbox keys stay set and usable throughout)
//
// SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY are provided automatically by
// the Edge Function runtime.

import { createClient } from "jsr:@supabase/supabase-js@2"
import type { PaymentProvider } from "./provider.ts"
import { PesapalProvider } from "./providers/pesapal.ts"

const CORS_HEADERS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
}

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { ...CORS_HEADERS, "Content-Type": "application/json" } })
}

const SUPABASE_URL = Deno.env.get("SUPABASE_URL")!
const SERVICE_ROLE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!
const ANON_KEY = Deno.env.get("SUPABASE_ANON_KEY")!

// PESAPAL-SPECIFIC: the one line that picks the concrete gateway. A future
// pawaPay implementation (mobile money only -- see providers/pawapay.ts,
// not built yet) would be chosen here based on a pending_payments row's own
// `provider` column instead of being hardcoded, once it exists.
function getProvider(): PaymentProvider {
  return new PesapalProvider()
}

// This function's own public URL -- what Pesapal's IPN calls, and what
// ensureCallbackRegistered() registers. Includes the project ref, so
// sandbox and any other Supabase project never collide on the same
// registered IPN URL.
const IPN_CALLBACK_URL = `${SUPABASE_URL}/functions/v1/pesapal-payment?action=ipn`

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response(null, { headers: CORS_HEADERS })

  const url = new URL(req.url)
  const action = url.searchParams.get("action") ?? (await req.clone().json().catch(() => ({})))?.action

  const adminClient = createClient(SUPABASE_URL, SERVICE_ROLE_KEY)

  // ── ipn: PUBLIC, called directly by Pesapal, no user session at all. ──
  // PESAPAL-SPECIFIC: OrderTrackingId/OrderMerchantReference/
  // OrderNotificationType are Pesapal's own query-param names, and the IPN
  // deliberately carries no status -- GetTransactionStatus (inside
  // provider.verifyStatus()) is the only source of truth, never this
  // request's own payload.
  if (action === "ipn") {
    const orderTrackingId = url.searchParams.get("OrderTrackingId")
    const merchantReference = url.searchParams.get("OrderMerchantReference")
    if (!orderTrackingId || !merchantReference) return json({ error: "Missing OrderTrackingId/OrderMerchantReference" }, 400)

    try {
      const provider = getProvider()
      const verified = await provider.verifyStatus(orderTrackingId)
      if (verified.status === "pending") {
        // Nothing to resolve yet -- Pesapal itself will call again once the
        // customer actually finishes. Acknowledge so it doesn't retry.
        return json({ ok: true, status: "pending" })
      }
      const { data, error } = await adminClient.rpc("resolve_pending_payment", {
        p_merchant_reference: merchantReference,
        p_provider_status: verified.status,
        p_provider_payload: verified.raw,
      })
      if (error) return json({ error: error.message }, 500)
      return json({ ok: true, ...(Array.isArray(data) ? data[0] : data) })
    } catch (reason) {
      console.error("IPN handling failed:", reason)
      // 200, not 5xx: an error on our side should not make Pesapal think
      // the IPN itself was malformed and stop retrying it -- the next
      // retry (or the till's own polling) gets another chance to resolve.
      return json({ ok: false, error: reason instanceof Error ? reason.message : String(reason) })
    }
  }

  if (req.method !== "POST") return json({ error: "Method not allowed" }, 405)

  // ── initiate / check-status: authenticated, called by the till itself. ──
  const authHeader = req.headers.get("Authorization")
  if (!authHeader) return json({ error: "Missing Authorization header" }, 401)

  const callerClient = createClient(SUPABASE_URL, ANON_KEY, { global: { headers: { Authorization: authHeader } } })
  const { data: callerAuth, error: callerAuthError } = await callerClient.auth.getUser()
  if (callerAuthError || !callerAuth.user) return json({ error: "Not signed in" }, 401)

  let body: { pendingPaymentId?: string; returnUrl?: string }
  try {
    body = await req.json()
  } catch {
    return json({ error: "Invalid request body" }, 400)
  }
  const pendingPaymentId = (body.pendingPaymentId ?? "").trim()
  if (!pendingPaymentId) return json({ error: "pendingPaymentId is required" }, 400)

  // RLS-scoped read via the CALLER's own client -- this is the ownership
  // check. If this row isn't visible to them (wrong branch, no org
  // relationship), it simply won't be found, exactly like any other
  // branch-scoped table in this app.
  const { data: row, error: rowError } = await callerClient
    .from("pending_payments")
    .select("id, status, provider, provider_reference, amount, currency, payment_method, patient_phone, merchant_reference")
    .eq("id", pendingPaymentId)
    .maybeSingle()
  if (rowError) return json({ error: rowError.message }, 500)
  if (!row) return json({ error: "Payment not found" }, 404)
  if (row.provider !== "pesapal") return json({ error: `Unsupported provider ${row.provider}` }, 400)

  if (action === "initiate") {
    if (row.status !== "pending") return json({ status: row.status })
    // Already submitted to Pesapal (e.g. a refreshed browser retried this
    // call) -- nothing to redo, Pesapal's own `id` uniqueness would reject
    // a second SubmitOrderRequest for the same merchant_reference anyway.
    if (row.provider_reference) return json({ status: "pending", providerReference: row.provider_reference })

    try {
      const provider = getProvider()
      await provider.ensureCallbackRegistered(IPN_CALLBACK_URL)
      const charge = await provider.initiateCharge({
        merchantReference: row.merchant_reference,
        amount: Number(row.amount),
        currency: row.currency,
        description: "PharmSync pharmacy sale",
        paymentMethod: row.payment_method,
        customerPhone: row.patient_phone ?? undefined,
        callbackUrl: body.returnUrl || SUPABASE_URL,
      })
      // Service-role write: recording the provider's own reference is not
      // a status transition (that only ever happens in resolve_pending_
      // payment()), so it doesn't need that function's compare-and-swap --
      // just a plain, idempotent field update.
      await adminClient.rpc("mark_payment_provider_submitted", {
        p_pending_payment_id: pendingPaymentId,
        p_provider_reference: charge.providerReference,
      })
      return json({ status: "pending", redirectUrl: charge.redirectUrl, providerReference: charge.providerReference })
    } catch (reason) {
      console.error("Pesapal initiateCharge failed:", reason)
      return json({ error: reason instanceof Error ? reason.message : "Could not start this payment" }, 502)
    }
  }

  if (action === "check-status") {
    await adminClient.rpc("expire_stale_pending_payments")

    const { data: fresh } = await callerClient.from("pending_payments").select("status, sale_id, failure_reason, provider_reference").eq("id", pendingPaymentId).maybeSingle()
    if (!fresh) return json({ error: "Payment not found" }, 404)
    if (fresh.status !== "pending" || !fresh.provider_reference) {
      return json({ status: fresh.status, saleId: fresh.sale_id, failureReason: fresh.failure_reason })
    }

    try {
      const provider = getProvider()
      const verified = await provider.verifyStatus(fresh.provider_reference)
      if (verified.status === "pending") return json({ status: "pending" })

      const { data, error } = await adminClient.rpc("resolve_pending_payment", {
        p_merchant_reference: row.merchant_reference,
        p_provider_status: verified.status,
        p_provider_payload: verified.raw,
      })
      if (error) return json({ error: error.message }, 500)
      const resolved = Array.isArray(data) ? data[0] : data
      return json({ status: resolved.status, saleId: resolved.sale_id, failureReason: resolved.failure_reason })
    } catch (reason) {
      console.error("check-status verification failed:", reason)
      // Transient failure talking to Pesapal -- report "still pending" so
      // the till's poll loop just tries again shortly, rather than
      // surfacing a scary error for what's likely a momentary blip.
      return json({ status: "pending" })
    }
  }

  return json({ error: `Unknown action ${action}` }, 400)
})
