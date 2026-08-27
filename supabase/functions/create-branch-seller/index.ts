// Creates a real, password-based login for a "seller" under the calling
// manager/owner's branch. This is the one place in the whole app that needs
// Supabase's service-role Admin API: every other account (branch owners) is
// created client-side through passwordless email-OTP verification, but
// setting a password *someone else chose* for *someone else's* login can
// only be done server-side with the service-role key -- never something a
// browser-side RPC running as the calling user could do safely.
//
// Deploy with (from the project root, after `supabase login` and
// `supabase link --project-ref <ref>`):
//   supabase functions deploy create-branch-seller
//
// SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY are provided automatically by
// the Edge Function runtime -- nothing to configure by hand.

import { createClient } from "jsr:@supabase/supabase-js@2"

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

  let body: { fullName?: string; email?: string; password?: string }
  try {
    body = await req.json()
  } catch {
    return json({ error: "Invalid request body" }, 400)
  }

  const fullName = (body.fullName ?? "").trim()
  const email = (body.email ?? "").trim().toLowerCase()
  const password = body.password ?? ""

  if (!fullName) return json({ error: "A full name is required" }, 400)
  if (!email || !/^[^@]+@[^@]+\.[^@]+$/.test(email)) return json({ error: "A valid email is required" }, 400)
  if (password.length < 6) return json({ error: "Password must be at least 6 characters" }, 400)

  const supabaseUrl = Deno.env.get("SUPABASE_URL")!
  const serviceRoleKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!

  // Identifies the caller from their own JWT -- this client only ever reads
  // who is calling, it never bypasses RLS.
  const callerClient = createClient(supabaseUrl, Deno.env.get("SUPABASE_ANON_KEY")!, {
    global: { headers: { Authorization: authHeader } },
  })
  const { data: callerAuth, error: callerAuthError } = await callerClient.auth.getUser()
  if (callerAuthError || !callerAuth.user) return json({ error: "Not signed in" }, 401)

  // Every privileged step from here on uses the service-role client, which
  // bypasses RLS entirely -- this function is the trust boundary, so every
  // check below is load-bearing.
  const adminClient = createClient(supabaseUrl, serviceRoleKey)

  const { data: caller, error: callerRowError } = await adminClient
    .from("users")
    .select("branch_id, role, is_active, branches(status)")
    .eq("id", callerAuth.user.id)
    .single()

  if (callerRowError || !caller || !caller.is_active || !["owner", "manager"].includes(caller.role)) {
    return json({ error: "Only an active branch manager or owner may create a seller login" }, 403)
  }
  const branchStatus = (caller as unknown as { branches: { status: string } | null }).branches?.status
  if (branchStatus !== "active") return json({ error: "This pharmacy is not active" }, 403)

  const { data: existingUser } = await adminClient.from("users").select("id").eq("email", email).maybeSingle()
  if (existingUser) return json({ error: "This email is already in use" }, 409)

  const { data: created, error: createError } = await adminClient.auth.admin.createUser({
    email,
    password,
    email_confirm: true,
    user_metadata: { full_name: fullName },
  })
  if (createError || !created.user) {
    return json({ error: createError?.message ?? "Could not create the login" }, 400)
  }

  const { error: insertError } = await adminClient.from("users").insert({
    id: created.user.id,
    branch_id: caller.branch_id,
    full_name: fullName,
    email,
    role: "seller",
    is_active: true,
  })
  if (insertError) {
    // Roll back the auth user so a failed insert never leaves an orphaned
    // login with no matching branch/role record.
    await adminClient.auth.admin.deleteUser(created.user.id)
    return json({ error: insertError.message }, 400)
  }

  return json({ userId: created.user.id })
})
