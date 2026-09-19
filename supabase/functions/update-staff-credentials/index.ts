// Changes another person's EMAIL and/or PASSWORD. Same reasoning as
// reset-staff-password (a real password can never be shown, only replaced)
// extended to email: an org_owner/org_manager (or branch owner/manager)
// editing "credentials" for someone below them means both fields together,
// not password alone. Authorization is delegated entirely to
// assert_can_manage_staff_account() (2026-09-18_staff_removal_and_
// credentials.sql), called here as the CALLER's own JWT so it only ever
// grants what their own role hierarchy actually permits -- this function
// touches the service-role Admin API only after that check has passed.
//
// Deploy with (from the project root, after `supabase login` and
// `supabase link --project-ref <ref>`):
//   supabase functions deploy update-staff-credentials

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

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response(null, { headers: CORS_HEADERS })
  if (req.method !== "POST") return json({ error: "Method not allowed" }, 405)

  const authHeader = req.headers.get("Authorization")
  if (!authHeader) return json({ error: "Missing Authorization header" }, 401)

  let body: { userId?: string; newEmail?: string; newPassword?: string }
  try {
    body = await req.json()
  } catch {
    return json({ error: "Invalid request body" }, 400)
  }

  const userId = (body.userId ?? "").trim()
  const newEmail = (body.newEmail ?? "").trim().toLowerCase() || undefined
  const newPassword = body.newPassword || undefined
  if (!userId) return json({ error: "A target user id is required" }, 400)
  if (!newEmail && !newPassword) return json({ error: "Provide a new email and/or a new password" }, 400)
  if (newEmail && !EMAIL_RE.test(newEmail)) return json({ error: "Enter a valid email address" }, 400)
  if (newPassword && newPassword.length < 6) return json({ error: "Password must be at least 6 characters" }, 400)

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
  const { error: authError } = await callerClient.rpc("assert_can_manage_staff_account", { p_target_user_id: userId })
  if (authError) return json({ error: authError.message }, 403)

  const adminClient = createClient(supabaseUrl, serviceRoleKey)

  if (newEmail) {
    const { error: authEmailError } = await adminClient.auth.admin.updateUserById(userId, { email: newEmail, email_confirm: true })
    if (authEmailError) return json({ error: authEmailError.message }, 400)
    // Keeps public.users.email (what list_branch_staff()/list_organization_
    // people() actually display) in sync with the real login email.
    const { error: dbEmailError } = await adminClient.from("users").update({ email: newEmail }).eq("id", userId)
    if (dbEmailError) return json({ error: dbEmailError.message }, 400)
  }
  if (newPassword) {
    const { error: passwordError } = await adminClient.auth.admin.updateUserById(userId, { password: newPassword })
    if (passwordError) return json({ error: passwordError.message }, 400)
  }

  return json({ ok: true })
})
