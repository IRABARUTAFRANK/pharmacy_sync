// Mostly PROVIDER-AGNOSTIC plumbing -- structurally the twin of supabase/
// functions/pesapal-payment/index.ts (same three actions, same auth/
// ownership pattern), adapted for pawaPay's own callback shape. The only
// pawaPay-specific bits are marked below (the callback body's depositId
// field, and which concrete provider class gets constructed).
//
// Deploy with (from the project root, after `supabase login` and
// `supabase link --project-ref <ref>`):
//   supabase functions deploy pawapay-payment
//   supabase secrets set PAWAPAY_ENV=sandbox
//   supabase secrets set PAWAPAY_SANDBOX_API_TOKEN=...
//   (later, going live: supabase secrets set PAWAPAY_LIVE_API_TOKEN=...,
//    then supabase secrets set PAWAPAY_ENV=live)
//
// Also register this function's own URL as the callback URL in the pawaPay
// dashboard (Developers -> Callback URLs) for Checkouts/Deposits/Payouts/
// Refunds -- same URL for all four is fine:
//   https://<project-ref>.supabase.co/functions/v1/pawapay-payment?action=callback
//
// SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY are provided automatically by
// the Edge Function runtime.

import { createClient } from "jsr:@supabase/supabase-js@2"
import type { PaymentProvider } from "./provider.ts"
import { PawapayProvider } from "./providers/pawapay.ts"

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

// PAWAPAY-SPECIFIC: the one line that picks the concrete gateway.
function getProvider(): PaymentProvider {
  return new PawapayProvider()
}

const CALLBACK_URL = `${SUPABASE_URL}/functions/v1/pawapay-payment?action=callback`

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response(null, { headers: CORS_HEADERS })

  const url = new URL(req.url)
  const action = url.searchParams.get("action") ?? (await req.clone().json().catch(() => ({})))?.action

  const adminClient = createClient(SUPABASE_URL, SERVICE_ROLE_KEY)

  // ── callback: PUBLIC, called directly by pawaPay, no user session. ──
  // PAWAPAY-SPECIFIC: depositId is pawaPay's own field name for the
  // reference we generated and submitted as `merchant_reference`. Even
  // though pawaPay's callback body includes a status directly (unlike
  // Pesapal's IPN), it is deliberately never read here -- verifyStatus()
  // always re-confirms with pawaPay's own GET /v2/deposits/{id} first. See
  // providers/pawapay.ts's header comment for why that's safe even against
  // a forged callback.
  if (action === "callback") {
    let body: { depositId?: string }
    try {
      body = await req.json()
    } catch {
      return json({ error: "Invalid callback body" }, 400)
    }
    const depositId = body.depositId
    if (!depositId) return json({ error: "Missing depositId" }, 400)

    try {
      const provider = getProvider()
      const verified = await provider.verifyStatus(depositId)
      if (verified.status === "pending") return json({ ok: true, status: "pending" })

      const { data, error } = await adminClient.rpc("resolve_pending_payment", {
        p_merchant_reference: depositId,
        p_provider_status: verified.status,
        p_provider_payload: verified.raw,
      })
      if (error) return json({ error: error.message }, 500)
      return json({ ok: true, ...(Array.isArray(data) ? data[0] : data) })
    } catch (reason) {
      console.error("pawaPay callback handling failed:", reason)
      // 200, not 5xx -- an error on our side shouldn't make pawaPay treat
      // the callback delivery itself as failed and retry it forever; the
      // till's own polling gets another chance to resolve this regardless.
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

  let body: { pendingPaymentId?: string }
  try {
    body = await req.json()
  } catch {
    return json({ error: "Invalid request body" }, 400)
  }
  const pendingPaymentId = (body.pendingPaymentId ?? "").trim()
  if (!pendingPaymentId) return json({ error: "pendingPaymentId is required" }, 400)

  const { data: row, error: rowError } = await callerClient
    .from("pending_payments")
    .select("id, status, provider, provider_reference, amount, currency, payment_method, patient_phone, merchant_reference")
    .eq("id", pendingPaymentId)
    .maybeSingle()
  if (rowError) return json({ error: rowError.message }, 500)
  if (!row) return json({ error: "Payment not found" }, 404)
  if (row.provider !== "pawapay") return json({ error: `Unsupported provider ${row.provider}` }, 400)

  if (action === "initiate") {
    if (row.status !== "pending") return json({ status: row.status })
    if (row.provider_reference) return json({ status: "pending" })

    try {
      const provider = getProvider()
      await provider.ensureCallbackRegistered(CALLBACK_URL)
      const charge = await provider.initiateCharge({
        merchantReference: row.merchant_reference,
        amount: Number(row.amount),
        currency: row.currency,
        description: "PharmSync pharmacy sale",
        paymentMethod: row.payment_method,
        customerPhone: row.patient_phone ?? undefined,
        callbackUrl: CALLBACK_URL,
      })
      await adminClient.rpc("mark_payment_provider_submitted", {
        p_pending_payment_id: pendingPaymentId,
        p_provider_reference: charge.providerReference,
      })
      return json({ status: "pending" })
    } catch (reason) {
      console.error("pawaPay initiateCharge failed:", reason)
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
      return json({ status: "pending" })
    }
  }

  return json({ error: `Unknown action ${action}` }, 400)
})
