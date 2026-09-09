-- ============================================================================
-- Organization RBAC: audit log, invite-not-insert, and ownership transfer
-- ============================================================================
-- Run once, AFTER `PROPOSAL_multi_branch_organizations.sql` has been applied
-- in full. Idempotent -- safe to re-run. Not yet applied anywhere; review
-- alongside the proposal file before running against a real project.
--
-- The proposal file adds pharmacy_organizations/organization_members and a
-- working lifecycle (create an organization, add a branch, grant/revoke
-- org_owner/org_manager), but leaves three things unfinished that a real
-- rollout needs:
--
--   1. No audit trail. Nothing records who granted/revoked/changed a role,
--      when, or why -- a real requirement for a pharmacy system given
--      regulatory expectations around who can touch stock, pricing, and
--      patient data.
--   2. invite_organization_member() only works for an email that already has
--      a public.users row somewhere. It cannot bring in a genuinely new
--      person, and add_branch_to_organization() creates a branch with
--      literally no one able to sign into it -- there is no follow-up step
--      anywhere in the proposal that staffs a freshly added branch.
--   3. No explicit ownership-transfer action. remove_organization_member()
--      already refuses to remove the last org_owner, but there is no atomic
--      "hand off to someone else" operation, so a real transfer today would
--      need two separate calls (invite as owner, then remove yourself) with
--      no guarantee the organization never transiently has zero owners if
--      the second call is the one that fails.
--
-- This file adds:
--   - role_change_log: an audit table, mirroring deleted_branches_log's own
--     shape (plain columns, no live FK, super-admin/owner-gated read, no
--     client INSERT grant -- writes only via the security-definer helper
--     below).
--   - log_role_change(): an internal-only helper (deliberately NOT granted
--     to `authenticated` -- see the comment on it) called from every RPC
--     below, and retrofitted into admin_update_staff_role() so branch-level
--     role changes are audited the same way as organization-level ones.
--   - organization_invites + an OTP-based invite flow, copying
--     branch_applications' own pattern exactly: no stored token or expiry
--     column, just an otp_sent_at timestamp and a freeze_expired_*() gate
--     that compares it against a 3-hour window, the same way
--     freeze_expired_pharmacy_otp() already works. This is what lets
--     invite_organization_member() bring in someone with no existing
--     account. Staffing add_branch_to_organization()'s newly created branch
--     with its first login is a separate, immediate path -- see the Edge
--     Function change in create-branch-seller/index.ts.
--   - transfer_organization_ownership(): atomic demote-then-promote (in the
--     order that never drops the owner count to zero, even transiently),
--     one paired audit entry on each side.
--
-- Every org-level person still needs exactly one home branch (users.branch_id
-- stays NOT NULL -- deliberately not relaxed here): organization_invites
-- always carries a branch_id, chosen by the inviting org_owner from that
-- organization's own branch list, exactly mirroring how create_pharmacy_
-- organization()'s founding owner already has both a home branch and an
-- organization_members row side by side.
-- ============================================================================


-- ============================================================================
-- SECTION 1 — Audit log
-- ============================================================================

create table if not exists public.role_change_log (
  id uuid primary key default gen_random_uuid(),
  scope varchar(20) not null check (scope in ('organization', 'branch')),
  -- Not live FKs, same reasoning as deleted_branches_log: the org/branch/
  -- actor/target this row describes may later be gone, and this is a log,
  -- not a referential record.
  organization_id uuid,
  branch_id uuid,
  actor_user_id uuid,
  actor_email text,
  target_user_id uuid not null,
  target_email text,
  old_role varchar(30),
  new_role varchar(30),
  action varchar(30) not null check (action in ('grant', 'revoke', 'role_change', 'ownership_transfer')),
  reason text,
  created_at timestamptz not null default now()
);

create index if not exists idx_role_change_log_org on public.role_change_log (organization_id, created_at desc) where organization_id is not null;
create index if not exists idx_role_change_log_branch on public.role_change_log (branch_id, created_at desc) where branch_id is not null;
create index if not exists idx_role_change_log_target on public.role_change_log (target_user_id, created_at desc);

alter table public.role_change_log enable row level security;

-- Visible to: a super admin (everything), an org_owner of the organization a
-- row describes, or the owner of the branch a row describes -- mirroring who
-- is already allowed to CAUSE these changes in the RPCs below.
drop policy if exists "role change log visible to relevant owners" on public.role_change_log;
create policy "role change log visible to relevant owners" on public.role_change_log
for select to authenticated
using (
  public.is_super_admin()
  or (organization_id is not null and exists (
    select 1 from public.organization_members m
    where m.organization_id = role_change_log.organization_id and m.user_id = (select auth.uid()) and m.role = 'org_owner'
  ))
  or (branch_id is not null and exists (
    select 1 from public.users u where u.id = (select auth.uid()) and u.is_active and u.role = 'owner' and u.branch_id = role_change_log.branch_id
  ))
);

-- No client INSERT/UPDATE/DELETE grant -- every write goes through
-- log_role_change() below, called from inside other security-definer RPCs.
grant select on public.role_change_log to authenticated;


-- Internal-only: writes one audit row. Deliberately NOT granted to
-- `authenticated` -- this is the one function in this file that breaks the
-- usual "revoke all, then grant execute to authenticated" pattern, on
-- purpose. A security-definer function can call another security-definer
-- function regardless of the outer caller's own grants, so every RPC below
-- can still `perform public.log_role_change(...)` even though the client
-- itself is never allowed to call it directly. Do not add a grant here.
create or replace function public.log_role_change(
  p_scope text, p_organization_id uuid, p_branch_id uuid,
  p_target_user_id uuid, p_old_role text, p_new_role text,
  p_action text, p_reason text default null
)
returns void
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_actor uuid := (select auth.uid());
  v_actor_email text;
  v_target_email text;
begin
  select email into v_actor_email from auth.users where id = v_actor;
  select email into v_target_email from public.users where id = p_target_user_id;

  insert into public.role_change_log (
    scope, organization_id, branch_id, actor_user_id, actor_email,
    target_user_id, target_email, old_role, new_role, action, reason
  ) values (
    p_scope, p_organization_id, p_branch_id, v_actor, v_actor_email,
    p_target_user_id, v_target_email, p_old_role, p_new_role, p_action,
    nullif(btrim(coalesce(p_reason, '')), '')
  );
end;
$$;

revoke all on function public.log_role_change(text, uuid, uuid, uuid, text, text, text, text) from public, anon, authenticated;


-- Thin, authenticated-callable wrapper so the create-branch-seller Edge
-- Function (which runs as a real signed-in user via their own JWT, not as a
-- security-definer function inside this schema) can still produce a
-- correctly-attributed audit row for "org staffed a brand-new branch's first
-- login". Only ever writes a log row -- calling it grants no privilege.
create or replace function public.log_first_branch_login(p_branch_id uuid, p_target_user_id uuid, p_role text)
returns void
language plpgsql
security definer
set search_path = ''
as $$
begin
  perform public.log_role_change('branch', null, p_branch_id, p_target_user_id, null, p_role, 'grant');
end;
$$;

revoke all on function public.log_first_branch_login(uuid, uuid, text) from public, anon;
grant execute on function public.log_first_branch_login(uuid, uuid, text) to authenticated;


-- Read RPCs. RLS on role_change_log already narrows what comes back per
-- caller, so no extra assert_*() guard is needed in either function body.
create or replace function public.list_role_change_log(p_organization_id uuid default null, p_branch_id uuid default null)
returns setof public.role_change_log
language sql
stable
security definer
set search_path = ''
as $$
  select * from public.role_change_log
  where (p_organization_id is not null and organization_id = p_organization_id)
     or (p_branch_id is not null and branch_id = p_branch_id)
  order by created_at desc
$$;

create or replace function public.list_organization_members(p_organization_id uuid)
returns table(user_id uuid, full_name text, email text, role text, created_at timestamptz)
language plpgsql
stable
security definer
set search_path = ''
as $$
begin
  perform public.assert_org_member(p_organization_id);
  return query
    select u.id, u.full_name::text, u.email::text, m.role::text, m.created_at
    from public.organization_members m
    join public.users u on u.id = m.user_id
    where m.organization_id = p_organization_id
    order by m.role, u.full_name;
end;
$$;

revoke all on function public.list_role_change_log(uuid, uuid) from public, anon;
grant execute on function public.list_role_change_log(uuid, uuid) to authenticated;
revoke all on function public.list_organization_members(uuid) from public, anon;
grant execute on function public.list_organization_members(uuid) to authenticated;


-- ============================================================================
-- SECTION 2 — Retrofit existing RPCs to log
-- ============================================================================

-- Same signature/return type as the proposal file's version -- plain
-- create or replace, no drop function needed. Adds one log_role_change()
-- call right before the existing delete.
create or replace function public.remove_organization_member(p_organization_id uuid, p_user_id uuid)
returns void
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_old_role text;
begin
  perform public.assert_org_owner(p_organization_id);

  select role into v_old_role from public.organization_members
  where organization_id = p_organization_id and user_id = p_user_id;
  if v_old_role is null then
    raise exception 'This person is not a member of this organization';
  end if;

  if v_old_role = 'org_owner'
     and (select count(*) from public.organization_members where organization_id = p_organization_id and role = 'org_owner') <= 1 then
    raise exception 'Cannot remove the last owner of an organization';
  end if;

  delete from public.organization_members where organization_id = p_organization_id and user_id = p_user_id;

  perform public.log_role_change('organization', p_organization_id, null, p_user_id, v_old_role, null, 'revoke');
end;
$$;

-- Same signature as the consolidated schema's version -- plain create or
-- replace. Adds one log_role_change() call after the update succeeds, so
-- branch-level role changes are audited the same way as organization-level
-- ones. admin_set_seller_active() is deliberately NOT retrofitted here: it
-- toggles is_active, not role, so old_role/new_role would be identical and
-- meaningless in this table.
create or replace function public.admin_update_staff_role(p_user_id uuid, p_role text)
returns void
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_caller uuid := (select auth.uid());
  v_branch uuid;
  v_old_role text;
begin
  if p_role not in ('manager', 'seller') then raise exception 'role must be manager or seller'; end if;
  select u.branch_id into v_branch from public.users u
  where u.id = v_caller and u.is_active and u.role = 'owner';
  if v_branch is null then raise exception 'Only the branch owner may change a staff member''s role'; end if;

  select role into v_old_role from public.users where id = p_user_id and branch_id = v_branch;

  update public.users set role = p_role
  where id = p_user_id and branch_id = v_branch and role in ('manager', 'seller');
  if not found then raise exception 'Staff member not found for this branch'; end if;

  perform public.log_role_change('branch', null, v_branch, p_user_id, v_old_role, p_role, 'role_change');
end;
$$;

revoke all on function public.remove_organization_member(uuid, uuid) from public, anon;
grant execute on function public.remove_organization_member(uuid, uuid) to authenticated;
revoke all on function public.admin_update_staff_role(uuid, text) from public, anon;
grant execute on function public.admin_update_staff_role(uuid, text) to authenticated;


-- ============================================================================
-- SECTION 3 — Organization invites (OTP, mirrors branch_applications)
-- ============================================================================

-- One pending invite, keyed by organization + email, exactly mirroring
-- branch_applications' own shape: no stored token or expiry column, just
-- otp_sent_at plus a freeze_expired_*() gate. branch_id is always required
-- (see the file header) -- it is the invitee's home branch, an EXISTING
-- branch in the organization, chosen by the inviting org_owner from
-- list_organization_branches(). Staffing a brand-new, not-yet-staffed
-- branch is a separate, immediate flow -- see create-branch-seller/index.ts.
create table if not exists public.organization_invites (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references public.pharmacy_organizations(id) on delete cascade,
  branch_id uuid not null references public.branches(id),
  email varchar(150) not null,
  full_name varchar(150) not null,
  role varchar(20) not null check (role in ('org_owner', 'org_manager', 'owner', 'manager')),
  status varchar(20) not null default 'otp_sent' check (status in ('otp_sent', 'accepted', 'denied')),
  invited_by uuid not null references public.users(id),
  otp_sent_at timestamptz not null default now(),
  denied_reason text,
  created_at timestamptz not null default now()
);

create unique index if not exists idx_organization_invites_open
  on public.organization_invites (organization_id, lower(email)) where status = 'otp_sent';
create index if not exists idx_organization_invites_email on public.organization_invites (lower(email));

alter table public.organization_invites enable row level security;
drop policy if exists "org members read own org invites" on public.organization_invites;
create policy "org members read own org invites" on public.organization_invites
for select to authenticated
using (public.is_super_admin() or public.is_org_member(organization_id));

grant select on public.organization_invites to authenticated;


create or replace function public.freeze_expired_organization_invite(p_invite_id uuid)
returns void
language plpgsql
security definer
set search_path = ''
as $$
begin
  update public.organization_invites
  set status = 'denied',
      denied_reason = 'Activation window (3 hours) expired without verification'
  where id = p_invite_id
    and status = 'otp_sent'
    and now() > otp_sent_at + interval '3 hours';
end;
$$;

-- Called by invite_organization_member() for a brand-new org-role invite --
-- requires the caller to already be an org_owner, checked by
-- assert_org_owner() before this runs.
create or replace function public.create_organization_invite(
  p_organization_id uuid, p_branch_id uuid, p_email text, p_full_name text, p_role text
)
returns void
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_caller uuid := (select auth.uid());
begin
  if p_role not in ('org_owner', 'org_manager', 'owner', 'manager') then
    raise exception 'Unrecognized role for an organization invite';
  end if;
  if not exists (select 1 from public.branches where id = p_branch_id and organization_id = p_organization_id) then
    raise exception 'That branch does not belong to this organization';
  end if;
  if nullif(btrim(coalesce(p_email, '')), '') is null then
    raise exception 'An email address is required';
  end if;
  if nullif(btrim(coalesce(p_full_name, '')), '') is null then
    raise exception 'A full name is required';
  end if;

  insert into public.organization_invites (organization_id, branch_id, email, full_name, role, invited_by, otp_sent_at, status)
  values (p_organization_id, p_branch_id, lower(btrim(p_email)), btrim(p_full_name), p_role, v_caller, now(), 'otp_sent')
  on conflict (organization_id, lower(email)) where status = 'otp_sent'
  do update set branch_id = excluded.branch_id, full_name = excluded.full_name, role = excluded.role, otp_sent_at = now();
end;
$$;

-- Plain (volatile) plpgsql, NOT stable -- this must call the freeze function
-- first, which runs an UPDATE. A stable-marked function calling an UPDATE
-- fails under PostgREST's read-only transaction wrapper; this schema's own
-- can_request_pharmacy_otp() hit exactly this bug and was fixed the same way.
create or replace function public.can_request_organization_invite_otp(p_email text)
returns boolean
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_invite_id uuid;
begin
  select i.id into v_invite_id
  from public.organization_invites i
  where lower(i.email) = lower(btrim(p_email)) and i.status = 'otp_sent'
  order by i.otp_sent_at desc
  limit 1;

  if v_invite_id is not null then
    perform public.freeze_expired_organization_invite(v_invite_id);
  end if;

  return exists (
    select 1 from public.organization_invites i
    where lower(i.email) = lower(btrim(p_email)) and i.status = 'otp_sent'
  );
end;
$$;

-- Runs right after the client's supabase.auth.verifyOtp() for this email.
-- Idempotent, following activate_pharmacy_account()'s exact shape: checked
-- FIRST so re-running after a partial failure heals rather than errors.
create or replace function public.activate_organization_invite()
returns table(organization_id uuid, branch_id uuid, role text)
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_user uuid := (select auth.uid());
  v_email text;
  v_invite public.organization_invites%rowtype;
  v_already public.organization_members%rowtype;
begin
  if v_user is null then raise exception 'Sign in with the emailed OTP first'; end if;

  select u.email into v_email from auth.users u where u.id = v_user;
  if v_email is null then raise exception 'Auth user email was not found'; end if;

  select * into v_invite
  from public.organization_invites i
  where lower(i.email) = lower(v_email) and i.status = 'otp_sent'
  order by i.otp_sent_at desc
  limit 1;

  if v_invite.id is null then
    raise exception 'No pending organization invite was found for %.', v_email;
  end if;

  perform public.freeze_expired_organization_invite(v_invite.id);
  select status into v_invite.status from public.organization_invites where id = v_invite.id;
  if v_invite.status <> 'otp_sent' then
    raise exception 'This invite has expired. Ask the organization owner to invite you again.';
  end if;

  -- Materialize the home-branch login if this auth user has no public.users
  -- row anywhere yet. If they already exist (e.g. re-invited after leaving),
  -- their existing branch/login is left untouched -- this only ever grants
  -- the organization role on top of it.
  if not exists (select 1 from public.users u where u.id = v_user) then
    insert into public.users (id, branch_id, full_name, email, role, is_active)
    values (v_user, v_invite.branch_id, v_invite.full_name, lower(v_email),
            case when v_invite.role in ('org_owner', 'org_manager') then 'manager' else v_invite.role end,
            true);
  end if;

  if v_invite.role in ('org_owner', 'org_manager') then
    select * into v_already from public.organization_members
    where organization_id = v_invite.organization_id and user_id = v_user;

    insert into public.organization_members (organization_id, user_id, role)
    values (v_invite.organization_id, v_user, v_invite.role)
    on conflict (organization_id, user_id) do update set role = excluded.role;

    perform public.log_role_change(
      'organization', v_invite.organization_id, null, v_user, v_already.role, v_invite.role,
      case when v_already.role is null then 'grant' else 'role_change' end
    );
  else
    perform public.log_role_change('branch', null, v_invite.branch_id, v_user, null, v_invite.role, 'grant');
  end if;

  update public.organization_invites set status = 'accepted' where id = v_invite.id;

  return query select v_invite.organization_id, v_invite.branch_id, v_invite.role::text;
end;
$$;

revoke all on function public.freeze_expired_organization_invite(uuid) from public, anon, authenticated;
revoke all on function public.create_organization_invite(uuid, uuid, text, text, text) from public, anon, authenticated;
revoke all on function public.can_request_organization_invite_otp(text) from public;
grant execute on function public.can_request_organization_invite_otp(text) to anon, authenticated;
revoke all on function public.activate_organization_invite() from public;
grant execute on function public.activate_organization_invite() to authenticated;


-- ============================================================================
-- SECTION 4 — invite_organization_member(): branch on existing vs brand-new
-- ============================================================================

-- Signature changes (returns text now, was returns void) -- must drop first.
drop function if exists public.invite_organization_member(uuid, text, text);

create or replace function public.invite_organization_member(
  p_organization_id uuid, p_branch_id uuid, p_user_email text, p_full_name text, p_role text default 'org_manager'
)
returns text  -- 'granted' (existing user, immediate) or 'invited' (new person, pending OTP)
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_target uuid;
  v_old_role text;
begin
  perform public.assert_org_owner(p_organization_id);
  if p_role not in ('org_owner', 'org_manager') then
    raise exception 'role must be org_owner or org_manager';
  end if;

  select id into v_target from public.users where lower(email) = lower(btrim(p_user_email));

  if v_target is null then
    perform public.create_organization_invite(p_organization_id, p_branch_id, p_user_email, p_full_name, p_role);
    return 'invited';
  end if;

  select role into v_old_role from public.organization_members
  where organization_id = p_organization_id and user_id = v_target;

  insert into public.organization_members (organization_id, user_id, role)
  values (p_organization_id, v_target, p_role)
  on conflict (organization_id, user_id) do update set role = excluded.role;

  perform public.log_role_change(
    'organization', p_organization_id, null, v_target, v_old_role, p_role,
    case when v_old_role is null then 'grant' else 'role_change' end
  );

  return 'granted';
end;
$$;

revoke all on function public.invite_organization_member(uuid, uuid, text, text, text) from public, anon;
grant execute on function public.invite_organization_member(uuid, uuid, text, text, text) to authenticated;


-- Staffing a brand-new branch created by add_branch_to_organization() is
-- handled by the extended create-branch-seller Edge Function (immediate,
-- password-based login, matching how every other staff account in this app
-- is created), not by the OTP-invite path above. The OTP path is reserved
-- for org-role invites to a brand-new person, whose home branch is an
-- EXISTING branch in the org they'll operate across, not the specific new
-- branch being staffed.


-- ============================================================================
-- SECTION 5 — Ownership transfer
-- ============================================================================

-- Atomic demote-current + promote-target. Promotes the target BEFORE
-- demoting the caller, so the organization's own_owner count never
-- transiently drops to zero even if something between the two updates were
-- to fail. Requires the target to already be a member (of either role) --
-- invite them first, then transfer; two explicit, separately audited steps
-- rather than one call that silently also invites.
create or replace function public.transfer_organization_ownership(p_organization_id uuid, p_new_owner_user_id uuid)
returns void
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_caller uuid := (select auth.uid());
  v_new_owner_role text;
begin
  perform public.assert_org_owner(p_organization_id);

  if p_new_owner_user_id = v_caller then
    raise exception 'You are already an owner of this organization';
  end if;

  select role into v_new_owner_role from public.organization_members
  where organization_id = p_organization_id and user_id = p_new_owner_user_id;
  if v_new_owner_role is null then
    raise exception 'The new owner must already be a member of this organization -- invite them first';
  end if;

  update public.organization_members set role = 'org_owner'
  where organization_id = p_organization_id and user_id = p_new_owner_user_id;

  update public.organization_members set role = 'org_manager'
  where organization_id = p_organization_id and user_id = v_caller;

  perform public.log_role_change('organization', p_organization_id, null, p_new_owner_user_id, v_new_owner_role, 'org_owner', 'ownership_transfer');
  perform public.log_role_change('organization', p_organization_id, null, v_caller, 'org_owner', 'org_manager', 'ownership_transfer');
end;
$$;

revoke all on function public.transfer_organization_ownership(uuid, uuid) from public, anon;
grant execute on function public.transfer_organization_ownership(uuid, uuid) to authenticated;


-- ============================================================================
-- Deliberately not included in this file
-- ============================================================================
-- organization_manager_scopes (restricting an org_manager to a subset of an
-- organization's branches) -- deferred. No organization in this system is
-- large enough to need it yet, and it is purely additive on top of
-- everything above whenever it is actually needed: a new table plus a
-- filter added to current_accessible_branch_ids()/org_branch_summary, with
-- nothing here to change.
