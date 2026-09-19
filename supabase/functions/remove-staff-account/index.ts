// Permanently removes someone's ability to sign in, without deleting any
// row -- most activity tables (sales.cashier_id, stock_batches.logged_by,
// ...) reference public.users.id with NO ACTION, so a hard delete would
// fail for anyone with real history, and even for someone with none it
// would throw away who did what. mark_staff_removed() (2026-09-18_staff_
// removal_and_credentials.sql) does the authorization check AND the one
// DB-side effect (is_active=false, is_removed=true) as the CALLER's own
// JWT; only the actual login ban needs the service-role Admin API, so
// that's this function's one remaining job, done last and only once the
// RPC above has already succeeded.
//
// ban_duration has no literal "forever" value -- Supabase's own convention
// for a permanent ban is a duration far longer than any real session, so
// 876000h (100 years) is used here. There is deliberately no "un-remove"
// path in the UI; is_removed is the one flag a developer would need to
// clear by hand to undo this.
//
// Deploy with (from the project root, after `supabase login` and
// `supabase link --project-ref <ref>`):
//   supabase functions deploy remove-staff-account

import { createClient } from "https://esm.sh/@supabase/supabase-js@2"

const CORS_HEADERS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
}

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...CORS_HEADERS, "Content-Type": "application/json" },
  })
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response(null, { headers: CORS_HEADERS })
  if (req.method !== "POST") return json({ error: "Method not allowed" }, 405)

  const authHeader = req.headers.get("Authorization")
  if (!authHeader) return json({ error: "Missing Authorization header" }, 401)

  let body: { userId?: string }
  try {
    body = await req.json()
  } catch {
    return json({ error: "Invalid request body" }, 400)
  }

  const userId = (body.userId ?? "").trim()
  if (!userId) return json({ error: "A target user id is required" }, 400)

  const supabaseUrl = Deno.env.get("SUPABASE_URL")!
  const serviceRoleKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!

  const callerClient = createClient(supabaseUrl, Deno.env.get("SUPABASE_ANON_KEY")!, {
    global: { headers: { Authorization: authHeader } },
  })
  const { data: callerAuth, error: callerAuthError } = await callerClient.auth.getUser()
  if (callerAuthError || !callerAuth.user) return json({ error: "Not signed in" }, 401)

  const { error: rpcError } = await callerClient.rpc("mark_staff_removed", { p_target_user_id: userId })
  if (rpcError) return json({ error: rpcError.message }, 403)

  const adminClient = createClient(supabaseUrl, serviceRoleKey)
  const { error: banError } = await adminClient.auth.admin.updateUserById(userId, { ban_duration: "876000h" })
  if (banError) return json({ error: banError.message }, 400)

  return json({ ok: true })
})
