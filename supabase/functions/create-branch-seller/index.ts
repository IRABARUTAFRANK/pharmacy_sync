// Creates a real, password-based login for a manager or seller ("Staff" in
// the UI) under the calling owner/manager's branch. This is the one place in
// the whole app that needs Supabase's service-role Admin API: every other
// account (branch owners) is created client-side through passwordless
// email-OTP verification, but setting a password *someone else chose* for
// *someone else's* login can only be done server-side with the service-role
// key -- never something a browser-side RPC running as the calling user
// could do safely. Creating a manager is owner-only (granting peer-level
// access is an owner decision); creating a seller stays open to owner or
// manager, unchanged from before.
//
// Second, additive path: an org_owner/org_manager staffing ANY branch in
// their organization, any time -- not just the caller's own branch, and not
// just a brand-new one. `branchId` must be supplied explicitly for this
// path, and the authority check is organization membership, not same-branch
// ownership. The only rule this path still enforces: a branch can only ever
// have one owner (users_one_owner_per_branch), so 'owner' is only a valid
// choice when the target branch currently has zero staff -- 'manager'/
// 'seller' are always allowed regardless of existing staff. Everything else
// (owner/manager staffing their OWN branch) is unchanged from before.
//
// Third, additive path: role 'org_manager' -- an org-level grant, not a
// branch role, so it is handled entirely separately from the two paths
// above rather than folded into isOrgStaffingPath. An org_manager does NOT
// need to come from an existing branch (or be tied to one at all) -- the
// org_owner never picks a branch for them; organizationId is resolved from
// the CALLER's own org_owner membership, and branchId is only an escape
// hatch for a caller who owns more than one organization. Requires the
// caller to already be org_owner of that organization, and enforces the
// same one-org_manager-per-org cap invite_organization_member() enforces on
// the OTP-invite path in 2026-09-09_organization_roles_v2.sql. On success
// this calls create_org_manager_login(), which atomically inserts into BOTH
// public.users (role stored as 'manager' at an auto-picked, purely technical
// anchor branch -- public.users.branch_id is NOT NULL by schema, but
// list_branch_staff() excludes anyone holding an active org_manager
// membership from every branch's roster, so this never surfaces as "their
// branch" anywhere) and public.organization_members (role 'org_manager') in
// one transaction, and logs the grant via log_org_manager_grant() so the
// audit trail matches every other role change in this schema.
//
// Deploy with (from the project root, after `supabase login` and
// `supabase link --project-ref <ref>`):
//   supabase functions deploy create-branch-seller
//
// SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY are provided automatically by
// the Edge Function runtime -- nothing to configure by hand.

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

// A branch may only ever have one real manager -- mirrors the DB's own
// users_one_owner_per_branch guarantee for 'owner', extended to 'manager'.
// Not a plain count, though: an org_manager's own technical-anchor row also
// has role='manager' on public.users (a required-NOT-NULL placeholder, never
// a real branch assignment -- see this file's own header comment and
// list_branch_staff()'s matching exclusion), so that row must never count
// as "this branch already has a manager".
async function branchHasRealManager(adminClient: ReturnType<typeof createClient>, branchId: string): Promise<boolean> {
  const { data: managers } = await adminClient.from("users").select("id").eq("branch_id", branchId).eq("role", "manager")
  if (!managers || managers.length === 0) return false
  const { data: orgManagerAnchors } = await adminClient
    .from("organization_members")
    .select("user_id")
    .eq("role", "org_manager")
    .in("user_id", managers.map(m => m.id))
  const anchorIds = new Set((orgManagerAnchors ?? []).map(a => a.user_id))
  return managers.some(m => !anchorIds.has(m.id))
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response(null, { headers: CORS_HEADERS })
  if (req.method !== "POST") return json({ error: "Method not allowed" }, 405)

  const authHeader = req.headers.get("Authorization")
  if (!authHeader) return json({ error: "Missing Authorization header" }, 401)

  let body: { fullName?: string; email?: string; password?: string; role?: string; branchId?: string }
  try {
    body = await req.json()
  } catch {
    return json({ error: "Invalid request body" }, 400)
  }

  const fullName = (body.fullName ?? "").trim()
  const email = (body.email ?? "").trim().toLowerCase()
  const password = body.password ?? ""
  const role = body.role === "manager" ? "manager" : body.role === "owner" ? "owner" : body.role === "org_manager" ? "org_manager" : "seller"
  const requestedBranchId = (body.branchId ?? "").trim() || null

  if (!fullName) return json({ error: "A full name is required" }, 400)
  if (!email || !/^[^@]+@[^@]+\.[^@]+$/.test(email)) return json({ error: "A valid email is required" }, 400)
  if (password.length < 6) return json({ error: "Password must be at least 6 characters" }, 400)

  const supabaseUrl = Deno.env.get("SUPABASE_URL")!
  const serviceRoleKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!

  // Identifies the caller from their own JWT -- this client only ever reads
  // who is calling, it never bypasses RLS. Reused below (org-staffing path
  // only) to call log_first_branch_login as the caller, so the audit row is
  // attributed to the real acting person, not the service-role client.
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
    return json({ error: "Only an active branch manager or owner may create a staff login" }, 403)
  }

  // org_manager is an org-level grant, not a branch role -- handled entirely
  // separately from the two branch-staffing paths below (their home branch
  // may legitimately be the caller's own branch, which the isOrgStaffingPath
  // check further down would otherwise misclassify). See the header comment.
  if (role === "org_manager") {
    // org_manager is never tied to a branch -- the org_owner picks no
    // branch for them at all. requestedBranchId is left as an escape hatch
    // (unused by the current UI) only for a caller who owns more than one
    // organization, to say which one; everyone else omits it entirely and
    // organizationId is found from the caller's own org_owner membership.
    let organizationId: string
    if (requestedBranchId) {
      const { data: targetBranch } = await adminClient
        .from("branches")
        .select("id, organization_id, status")
        .eq("id", requestedBranchId)
        .maybeSingle()
      if (!targetBranch || !targetBranch.organization_id) {
        return json({ error: "That branch was not found or does not belong to an organization" }, 404)
      }
      if (targetBranch.status !== "active") return json({ error: "This branch is not active" }, 403)
      organizationId = targetBranch.organization_id
    } else {
      const { data: ownedOrgs } = await adminClient
        .from("organization_members")
        .select("organization_id")
        .eq("user_id", callerAuth.user.id)
        .eq("role", "org_owner")
      if (!ownedOrgs || ownedOrgs.length === 0) {
        return json({ error: "Only the organization owner may assign an organization manager" }, 403)
      }
      if (ownedOrgs.length > 1) {
        return json({ error: "You own more than one organization -- try again from that organization's own page" }, 400)
      }
      organizationId = ownedOrgs[0].organization_id
    }

    const { data: membership } = await adminClient
      .from("organization_members")
      .select("role")
      .eq("organization_id", organizationId)
      .eq("user_id", callerAuth.user.id)
      .maybeSingle()
    if (!membership || membership.role !== "org_owner") {
      return json({ error: "Only the organization owner may assign an organization manager" }, 403)
    }

    const { count: existingManagerCount } = await adminClient
      .from("organization_members")
      .select("user_id", { count: "exact", head: true })
      .eq("organization_id", organizationId)
      .eq("role", "org_manager")
    if ((existingManagerCount ?? 0) > 0) {
      return json({ error: "This organization already has an organization manager -- remove them first" }, 409)
    }

    const { data: existingUser } = await adminClient.from("users").select("id").eq("email", email).maybeSingle()
    if (existingUser) return json({ error: "This email is already in use" }, 409)

    // public.users.branch_id is NOT NULL by schema, but an org_manager isn't
    // really "of" any branch -- this is a technical anchor only, picked
    // automatically (any branch in the organization works equally, so the
    // org_owner is never asked to choose one). list_branch_staff() excludes
    // anyone holding an active org_manager membership from every branch's
    // roster, so this placeholder never surfaces as "their branch" anywhere.
    const anchorBranchId = requestedBranchId ?? (await (async () => {
      const { data: anyBranch } = await adminClient
        .from("branches")
        .select("id")
        .eq("organization_id", organizationId)
        .order("created_at", { ascending: true })
        .limit(1)
        .maybeSingle()
      return anyBranch?.id ?? null
    })())
    if (!anchorBranchId) return json({ error: "This organization has no branches yet" }, 400)

    const { data: created, error: createError } = await adminClient.auth.admin.createUser({
      email,
      password,
      email_confirm: true,
      user_metadata: { full_name: fullName },
    })
    if (createError || !created.user) {
      return json({ error: createError?.message ?? "Could not create the login" }, 400)
    }

    // role stored as 'manager' on public.users, mirroring how
    // activate_organization_invite() already maps an org_owner/org_manager
    // invite down to a branch role -- inert here since branch_id is just
    // the technical anchor above, never a real staffing assignment.
    //
    // Both rows (the anchor + its organization_members grant) are written
    // by ONE RPC call, not two separate inserts -- see create_org_manager_
    // login()'s own comment (2026-09-18_one_manager_per_branch_db_trigger.
    // sql): the deferred one-manager-per-branch trigger on public.users
    // needs both rows to exist in the SAME transaction to correctly
    // recognize this row as an anchor rather than a real branch manager. A
    // failure here rolls back both inserts automatically -- no manual
    // rollback of the users row needed, only the auth user itself.
    const { error: memberError } = await adminClient.rpc("create_org_manager_login", {
      p_user_id: created.user.id, p_branch_id: anchorBranchId, p_full_name: fullName, p_email: email, p_organization_id: organizationId,
    })
    if (memberError) {
      await adminClient.auth.admin.deleteUser(created.user.id)
      return json({ error: memberError.message }, 400)
    }

    // Best-effort audit row, attributed to the caller's own JWT -- same
    // pattern as log_first_branch_login below for the branch-staffing path.
    await callerClient.rpc("log_org_manager_grant", {
      p_organization_id: organizationId,
      p_target_user_id: created.user.id,
    })

    return json({ userId: created.user.id })
  }

  // Staffing an organization branch that isn't the caller's own requires
  // organization membership, not same-branch ownership -- see the header
  // comment above for exactly what this path allows.
  const isOrgStaffingPath = requestedBranchId !== null && requestedBranchId !== caller.branch_id
  let targetBranchId = caller.branch_id

  if (isOrgStaffingPath) {
    const { data: targetBranch } = await adminClient
      .from("branches")
      .select("id, organization_id, status")
      .eq("id", requestedBranchId)
      .maybeSingle()
    if (!targetBranch || !targetBranch.organization_id) {
      return json({ error: "That branch was not found or does not belong to an organization" }, 404)
    }
    if (targetBranch.status !== "active") return json({ error: "This branch is not active" }, 403)

    const { data: membership } = await adminClient
      .from("organization_members")
      .select("role")
      .eq("organization_id", targetBranch.organization_id)
      .eq("user_id", callerAuth.user.id)
      .maybeSingle()
    if (!membership || !["org_owner", "org_manager"].includes(membership.role)) {
      return json({ error: "Only an owner or manager of this organization may staff this branch" }, 403)
    }

    // An org_owner/org_manager may add a manager or seller to ANY branch in
    // the organization, any time -- not just a freshly created, unstaffed
    // one. Two real constraints still have to hold: a branch can only ever
    // have one owner (users_one_owner_per_branch) and only ever one real
    // manager -- 'owner' is only ever a valid choice for a branch's very
    // first hire; 'manager' is rejected once the branch already has one.
    const { count: existingStaffCount } = await adminClient
      .from("users")
      .select("id", { count: "exact", head: true })
      .eq("branch_id", requestedBranchId)
    if (role === "owner" && (existingStaffCount ?? 0) > 0) {
      return json({ error: "This branch already has an owner -- add a manager or seller instead" }, 409)
    }
    if (role === "manager" && (await branchHasRealManager(adminClient, requestedBranchId))) {
      return json({ error: "This branch already has a manager -- change their role first, or add a seller instead" }, 409)
    }

    targetBranchId = requestedBranchId
  } else {
    if (role === "owner") return json({ error: "Only an organization owner/manager may create an owner login for a different branch" }, 403)
    if (role === "manager" && caller.role !== "owner") {
      return json({ error: "Only the branch owner may create a manager login" }, 403)
    }
    if (role === "manager" && (await branchHasRealManager(adminClient, caller.branch_id))) {
      return json({ error: "This branch already has a manager -- change their role first, or add a seller instead" }, 409)
    }
    const branchStatus = (caller as unknown as { branches: { status: string } | null }).branches?.status
    if (branchStatus !== "active") return json({ error: "This pharmacy is not active" }, 403)
  }

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
    branch_id: targetBranchId,
    full_name: fullName,
    email,
    role,
    is_active: true,
  })
  if (insertError) {
    // Roll back the auth user so a failed insert never leaves an orphaned
    // login with no matching branch/role record.
    await adminClient.auth.admin.deleteUser(created.user.id)
    return json({ error: insertError.message }, 400)
  }

  if (isOrgStaffingPath) {
    // Best-effort audit row, attributed to the caller's own JWT so
    // auth.uid() inside the RPC reflects the acting org person. A failure
    // here does not roll back the login that was just created -- the login
    // is real and correct either way, this is only the audit trail.
    await callerClient.rpc("log_first_branch_login", {
      p_branch_id: targetBranchId,
      p_target_user_id: created.user.id,
      p_role: role,
    })
  }

  return json({ userId: created.user.id })
})
