// Sets a new password for someone else's login. This exists because a real
// password can never be shown to anyone -- Supabase Auth only ever stores a
// one-way hash, even service-role can't read it back -- so "an org_owner/
// org_manager can see the credentials of people below them" is implemented
// as "...can set a new one for them" instead. Authorization is delegated
// entirely to assert_can_reset_staff_password() (2026-09-18_reset_staff_
// password.sql), called here as the CALLER's own JWT so it sees exactly what
// they're allowed to see -- this function only touches the service-role
// Admin API once that check has already passed.
//
// Deploy with (from the project root, after `supabase login` and
// `supabase link --project-ref <ref>`):
//   supabase functions deploy reset-staff-password

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

  let body: { userId?: string; newPassword?: string }
  try {
    body = await req.json()
  } catch {
    return json({ error: "Invalid request body" }, 400)
  }

  const userId = (body.userId ?? "").trim()
  const newPassword = body.newPassword ?? ""
  if (!userId) return json({ error: "A target user id is required" }, 400)
  if (newPassword.length < 6) return json({ error: "Password must be at least 6 characters" }, 400)

  const supabaseUrl = Deno.env.get("SUPABASE_URL")!
  const serviceRoleKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!

  const callerClient = createClient(supabaseUrl, Deno.env.get("SUPABASE_ANON_KEY")!, {
    global: { headers: { Authorization: authHeader } },
  })
  const { data: callerAuth, error: callerAuthError } = await callerClient.auth.getUser()
  if (callerAuthError || !callerAuth.user) return json({ error: "Not signed in" }, 401)

  // The real authorization check -- runs as the caller (RLS/auth.uid()
  // intact), not the service-role client below, so it can only ever grant
  // what the caller's own role hierarchy actually permits.
  const { error: authError } = await callerClient.rpc("assert_can_reset_staff_password", { p_target_user_id: userId })
  if (authError) return json({ error: authError.message }, 403)

  const adminClient = createClient(supabaseUrl, serviceRoleKey)
  const { error: updateError } = await adminClient.auth.admin.updateUserById(userId, { password: newPassword })
  if (updateError) return json({ error: updateError.message }, 400)

  return json({ ok: true })
})
