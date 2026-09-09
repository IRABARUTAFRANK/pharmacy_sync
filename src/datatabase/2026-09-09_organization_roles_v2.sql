-- ============================================================================
-- Unified org role management: assign, offboard, one-manager rule
-- ============================================================================
-- Run once, AFTER every prior organization-related file this session
-- (PROPOSAL_multi_branch_organizations.sql, 2026-09-09_organization_rbac.sql,
-- 2026-09-09_organization_first_registration.sql,
-- 2026-09-09_organization_dashboard.sql). Idempotent -- safe to re-run.
--
-- Closes a real security gap found while testing: is_org_member()/
-- assert_org_owner()/assert_org_member() never checked the underlying
-- public.users.is_active at all -- deactivating someone's login left their
-- organization-level access completely untouched, breaking the "live
-- revocation" guarantee the rest of this schema already relies on for
-- everything else (removing a role, changing a branch role, etc. all take
-- effect on the very next call with no re-login needed -- deactivation alone
-- did not, until now).
--
-- Also adds the three things this pass was actually asked for:
--   1. A real offboarding action (org_set_user_active) -- deactivate someone
--      immediately blocks sign-in everywhere (branch AND org level, thanks
--      to the fix above), reactivating restores it, matching the toggle
--      pattern admin_set_seller_active already uses at the branch level.
--   2. A hard cap of one org_manager per organization (the original design
--      deliberately allowed several, for larger chains; this product wants
--      exactly one owner and one manager).
--   3. org_assign_branch_role() -- the branch_manager/sales_person half of a
--      single, unified "assign a role" action, going through the same
--      OTP-invite path invite_organization_member() already uses for
--      org_manager, instead of the separate immediate-password Edge
--      Function path -- one consistent, secure way to bring someone in,
--      whatever role they're being given.
-- ============================================================================


-- ============================================================================
-- SECTION 1 — Live revocation: org-auth helpers now check is_active
-- ============================================================================

create or replace function public.is_org_member(p_organization_id uuid)
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  select exists (
    select 1 from public.organization_members m
    join public.users u on u.id = m.user_id
    where m.organization_id = p_organization_id and m.user_id = (select auth.uid()) and u.is_active
  )
$$;

create or replace function public.assert_org_owner(p_organization_id uuid)
returns void
language plpgsql
stable
security definer
set search_path = ''
as $$
begin
  if not exists (
    select 1 from public.organization_members m
    join public.users u on u.id = m.user_id
    where m.organization_id = p_organization_id and m.user_id = (select auth.uid())
      and m.role = 'org_owner' and u.is_active
  ) then
    raise exception 'Only an active owner of this organization may do that';
  end if;
end;
$$;

create or replace function public.assert_org_member(p_organization_id uuid)
returns void
language plpgsql
stable
security definer
set search_path = ''
as $$
begin
  if not public.is_org_member(p_organization_id) then
    raise exception 'You are not an active member of this organization';
  end if;
end;
$$;

-- Signatures unchanged from PROPOSAL_multi_branch_organizations.sql -- plain
-- create or replace, no drop function or grant changes needed.


-- ============================================================================
-- SECTION 2 — Offboarding: org_set_user_active
-- ============================================================================

-- Authorization mirrors the original permission matrix exactly: deactivating
-- an org_manager is owner-only; deactivating branch_manager/sales_person is
-- allowed for org_owner OR org_manager. Never targets an org_owner (ownership
-- changes go through transfer_organization_ownership, not this) and never
-- targets yourself (no self-service lockout, matching the rest of this
-- schema's own "no self-escalation/self-lockout" rule).
create or replace function public.org_set_user_active(
  p_organization_id uuid, p_target_user_id uuid, p_is_active boolean
)
returns void
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_caller uuid := (select auth.uid());
  v_caller_role text;
  v_target_org_role text;
  v_target_branch_org uuid;
begin
  if p_target_user_id = v_caller then
    raise exception 'You cannot change your own active status';
  end if;

  select role into v_caller_role from public.organization_members
  where organization_id = p_organization_id and user_id = v_caller;
  if v_caller_role is null then
    raise exception 'You are not a member of this organization';
  end if;

  select role into v_target_org_role from public.organization_members
  where organization_id = p_organization_id and user_id = p_target_user_id;

  if v_target_org_role = 'org_owner' then
    raise exception 'Cannot deactivate an organization owner -- transfer ownership instead';
  end if;
  if v_target_org_role = 'org_manager' and v_caller_role <> 'org_owner' then
    raise exception 'Only the organization owner may deactivate an organization manager';
  end if;

  if v_target_org_role is null then
    -- Not an org-level member -- must be branch-level staff of a branch that
    -- belongs to this organization, or this caller has no business touching them.
    select b.organization_id into v_target_branch_org
    from public.users u
    join public.branches b on b.id = u.branch_id
    where u.id = p_target_user_id;
    if v_target_branch_org is null or v_target_branch_org <> p_organization_id then
      raise exception 'That person is not part of this organization';
    end if;
  end if;

  update public.users set is_active = p_is_active where id = p_target_user_id;
end;
$$;

revoke all on function public.org_set_user_active(uuid, uuid, boolean) from public, anon;
grant execute on function public.org_set_user_active(uuid, uuid, boolean) to authenticated;


-- ============================================================================
-- SECTION 3 — One-org_manager cap, and org_owner is no longer assignable here
-- ============================================================================

-- Same signature as 2026-09-09_organization_rbac.sql's version -- plain
-- create or replace, no drop function needed. Ownership is granted only via
-- transfer_organization_ownership(); this function now only ever grants
-- org_manager, and only while the organization doesn't already have one.
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
  if p_role <> 'org_manager' then
    raise exception 'Only org_manager can be assigned here -- ownership transfers use a separate action';
  end if;

  select id into v_target from public.users where lower(email) = lower(btrim(p_user_email));

  if exists (
    select 1 from public.organization_members
    where organization_id = p_organization_id and role = 'org_manager'
      and (v_target is null or user_id <> v_target)
  ) then
    raise exception 'This organization already has an organization manager -- remove them first';
  end if;

  -- Also block a second *pending* org_manager invite for a different email --
  -- otherwise two brand-new people could both be invited before either
  -- activates, and the cap would only bite the second one at activation time
  -- (a confusing, avoidable failure well after they've already entered their OTP).
  if exists (
    select 1 from public.organization_invites
    where organization_id = p_organization_id and role = 'org_manager' and status = 'otp_sent'
      and lower(email) <> lower(btrim(p_user_email))
  ) then
    raise exception 'This organization already has a pending organization manager invite -- cancel it first';
  end if;

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

-- Widen the role this can create an invite for -- 'seller' is new, for
-- org_assign_branch_role() below. Same signature, plain create or replace.
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
  if p_role not in ('org_owner', 'org_manager', 'owner', 'manager', 'seller') then
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

revoke all on function public.create_organization_invite(uuid, uuid, text, text, text) from public, anon, authenticated;

-- Additive: 'seller' joins the allowed invite roles on the table itself.
alter table public.organization_invites drop constraint if exists organization_invites_role_check;
alter table public.organization_invites add constraint organization_invites_role_check
  check (role in ('org_owner', 'org_manager', 'owner', 'manager', 'seller'));

-- Same signature as 2026-09-09_organization_rbac.sql's version -- adds the
-- one-org_manager re-check right before granting it (closes the race where
-- someone else was granted org_manager after this invite was created but
-- before it was activated).
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

  if v_invite.role = 'org_manager' and exists (
    select 1 from public.organization_members
    where organization_id = v_invite.organization_id and role = 'org_manager' and user_id <> v_user
  ) then
    raise exception 'This organization already has an organization manager. Contact the organization owner.';
  end if;

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

revoke all on function public.activate_organization_invite() from public;
grant execute on function public.activate_organization_invite() to authenticated;


-- ============================================================================
-- SECTION 4 — org_assign_branch_role: the branch_manager/sales_person half
-- of "Assign a role"
-- ============================================================================

-- Callable by org_owner OR org_manager (matches the permission matrix: both
-- may create/manage branch_manager and sales_person). Three cases: a
-- brand-new person gets an OTP invite; an existing person already AT that
-- exact branch gets a plain role change; an existing person at a DIFFERENT
-- branch is rejected -- moving someone's home branch isn't something this
-- (or anything else in this schema) supports.
create or replace function public.org_assign_branch_role(
  p_organization_id uuid, p_branch_id uuid, p_user_email text, p_full_name text, p_role text
)
returns text  -- 'granted' | 'invited'
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_target uuid;
  v_target_branch uuid;
  v_old_role text;
begin
  perform public.assert_org_member(p_organization_id);
  if p_role not in ('owner', 'manager', 'seller') then
    raise exception 'role must be owner, manager, or seller';
  end if;
  if not exists (select 1 from public.branches where id = p_branch_id and organization_id = p_organization_id) then
    raise exception 'That branch does not belong to this organization';
  end if;

  select id, branch_id, role into v_target, v_target_branch, v_old_role
  from public.users where lower(email) = lower(btrim(p_user_email));

  if v_target is null then
    perform public.create_organization_invite(p_organization_id, p_branch_id, p_user_email, p_full_name, p_role);
    return 'invited';
  end if;

  if v_target_branch <> p_branch_id then
    raise exception 'This person already has a login at a different branch';
  end if;

  if p_role = 'owner' and v_old_role <> 'owner' then
    raise exception 'This branch already has an owner -- assign manager or seller instead';
  end if;

  update public.users set role = p_role where id = v_target;
  perform public.log_role_change('branch', null, p_branch_id, v_target, v_old_role, p_role, 'role_change');

  return 'granted';
end;
$$;

revoke all on function public.org_assign_branch_role(uuid, uuid, text, text, text) from public, anon;
grant execute on function public.org_assign_branch_role(uuid, uuid, text, text, text) to authenticated;


-- ============================================================================
-- SECTION 5 — list_organization_people: the unified Members list
-- ============================================================================

-- Every person tied to the organization, org-level and branch-level
-- together, so assign/deactivate can all happen from one screen. An
-- org_owner/org_manager who also happens to staff a branch appears once,
-- under their org role -- their branch-level role at their own home branch
-- isn't separately surfaced here.
create or replace function public.list_organization_people(p_organization_id uuid)
returns table(
  user_id uuid, full_name text, email text, scope text, role text,
  branch_id uuid, branch_name text, is_active boolean
)
language plpgsql
stable
security definer
set search_path = ''
as $$
begin
  perform public.assert_org_member(p_organization_id);
  return query
    select u.id, u.full_name::text, u.email::text, 'organization'::text, m.role::text,
      null::uuid, null::text, u.is_active
    from public.organization_members m
    join public.users u on u.id = m.user_id
    where m.organization_id = p_organization_id
    union all
    select u.id, u.full_name::text, u.email::text, 'branch'::text, u.role::text,
      b.id, b.name::text, u.is_active
    from public.users u
    join public.branches b on b.id = u.branch_id
    where b.organization_id = p_organization_id
      and u.id not in (select om.user_id from public.organization_members om where om.organization_id = p_organization_id)
    order by 4, 5, 2;
end;
$$;

revoke all on function public.list_organization_people(uuid) from public, anon;
grant execute on function public.list_organization_people(uuid) to authenticated;
