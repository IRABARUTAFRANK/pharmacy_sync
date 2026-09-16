-- ============================================================================
-- org_manager doesn't have to come from an existing branch, and isn't tied
-- to one either
-- ============================================================================
-- Run once, after 2026-09-14_org_manage_branch_settings.sql and
-- 2026-09-09_organization_roles_v2.sql. Idempotent.
--
-- The ask: when an org_owner appoints an org_manager, it shouldn't be an
-- obligation that the person comes from one of the existing branch
-- managers -- they may be a brand-new hire from outside with no branch
-- association at all. And the reverse case: if an EXISTING branch_manager
-- is the one promoted, their old branch's own "manager dashboard" should
-- go dormant (they stop showing up as that branch's staff) even though
-- they keep full access to it -- and every other branch -- through their
-- new org_manager authority. Later, when the org_owner assigns someone new
-- as that branch's manager, the branch is staffed again with a real,
-- dedicated manager, seeing fully up-to-date data (nothing about the
-- branch's own data was ever touched by any of this).
--
-- The schema constraint this runs into: public.users.branch_id is NOT NULL
-- (a deliberate, pre-existing design decision -- see
-- 2026-09-09_organization_rbac.sql's own header: "every org-level person
-- still needs exactly one home branch"). Making it nullable would mean
-- reworking the database schema, ~10 SQL functions, AND the frontend
-- login/session model (src/lib/auth.ts's BranchAccess, App.tsx's routing) --
-- confirmed with the user this is more risk than the ask needs. Instead:
-- an org_manager still gets a technical branch_id under the hood (required
-- by the column), but it is auto-picked (never chosen by the org_owner) and
-- never surfaced anywhere as "their branch":
--   1. list_branch_staff() now excludes anyone holding an active
--      org_manager membership from EVERY branch's roster -- this alone
--      covers both cases: a brand-new org_manager's auto-picked anchor
--      branch never shows them as its staff, and an existing
--      branch_manager who gets promoted disappears from their old
--      branch's roster the instant the promotion happens (no data
--      mutation needed -- their branch_id/role columns are untouched,
--      simply no longer surfaced).
--   2. admin_set_seller_active()/admin_update_staff_role() now refuse to
--      act on a target who holds an active org_manager membership --
--      closes the one gap the hidden-from-roster approach alone doesn't:
--      a branch owner constructing the API call directly (not through the
--      now-filtered UI list) could otherwise still deactivate or
--      role-change the organization's own manager through a branch-level
--      action.
--   3. invite_organization_member()'s p_branch_id becomes optional -- when
--      omitted for a brand-new org_manager invite (no existing login),
--      the organization's own branches are searched and any one of them
--      is silently used as the technical anchor. For an EXISTING person
--      being promoted, p_branch_id was already unused by this function
--      (their branch_id/role are never touched) -- unaffected.
--   4. Frontend + Edge Function (create-branch-seller, the primary
--      immediate-password path AssignRoleModal actually uses): the branch
--      picker is no longer shown for the org_manager role at all, and the
--      Edge Function resolves the organization from the CALLER's own
--      org_owner membership instead of from a chosen branch, auto-picking
--      an anchor branch the same way. See that file's own updated header.
-- ============================================================================


-- ============================================================================
-- SECTION 1 — list_branch_staff(): hide anyone whose real authority is
-- org-level, not this branch
-- ============================================================================
-- Same signature as 2026-09-14_org_manage_branch_settings.sql's version --
-- plain create or replace, no drop needed. org_owner is deliberately NOT
-- excluded here -- the founding owner genuinely runs their own branch (the
-- established "owner acts as org_manager until one exists" dual-role model)
-- and should keep showing up as its real owner. Only a dedicated
-- 'org_manager' row means "this person's authority lives at the
-- organization level, not this branch."
create or replace function public.list_branch_staff(p_branch_id uuid default null)
returns table(id uuid, full_name text, email text, role text, is_active boolean, created_at timestamptz)
language sql
stable
security definer
set search_path = ''
as $$
  select u.id, u.full_name::text, u.email::text, u.role::text, u.is_active, u.created_at
  from public.users u
  where u.branch_id = public.effective_branch_id(p_branch_id)
    and not exists (
      select 1 from public.organization_members m
      where m.user_id = u.id and m.role = 'org_manager'
    )
  order by u.role, u.full_name
$$;

-- Signature unchanged -- plain create or replace.


-- ============================================================================
-- SECTION 2 — admin_set_seller_active() / admin_update_staff_role(): refuse
-- to touch the organization's own manager through a branch-level action
-- ============================================================================

create or replace function public.admin_set_seller_active(p_user_id uuid, p_is_active boolean, p_branch_id uuid default null)
returns void
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_caller uuid := (select auth.uid());
  v_own_branch uuid;
  v_own_role text;
  v_branch uuid;
  v_caller_role text;
  v_target_role text;
begin
  select u.branch_id, u.role into v_own_branch, v_own_role
  from public.users u
  where u.id = v_caller and u.is_active and u.role in ('owner', 'manager');
  if v_own_branch is null then raise exception 'Only an active branch manager or owner may manage staff'; end if;

  v_branch := public.effective_branch_id(p_branch_id);
  if v_branch is null then raise exception 'No active branch for this session'; end if;
  perform public.assert_can_manage_org_branch_or_own(v_branch, v_own_branch);
  v_caller_role := case when v_branch = v_own_branch then v_own_role else 'owner' end;

  if exists (select 1 from public.organization_members m where m.user_id = p_user_id and m.role = 'org_manager') then
    raise exception 'This person is the organization manager -- manage their access from Organization members, not this branch''s staff list';
  end if;

  select role into v_target_role from public.users where id = p_user_id and branch_id = v_branch;
  if v_target_role is null or v_target_role not in ('manager', 'seller') then
    raise exception 'Staff member not found for this branch';
  end if;
  if v_target_role = 'manager' and v_caller_role <> 'owner' then
    raise exception 'Only the branch owner may deactivate a manager';
  end if;

  update public.users
  set is_active = p_is_active
  where id = p_user_id and branch_id = v_branch and role in ('manager', 'seller');
end;
$$;

-- Signature unchanged -- plain create or replace.


create or replace function public.admin_update_staff_role(p_user_id uuid, p_role text, p_branch_id uuid default null)
returns void
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_caller uuid := (select auth.uid());
  v_own_branch uuid;
  v_own_role text;
  v_branch uuid;
  v_caller_role text;
begin
  if p_role not in ('manager', 'seller') then
    raise exception 'role must be manager or seller';
  end if;

  select u.branch_id, u.role into v_own_branch, v_own_role
  from public.users u
  where u.id = v_caller and u.is_active and u.role in ('owner', 'manager');
  if v_own_branch is null then raise exception 'Only the branch owner may change a staff member''s role'; end if;

  v_branch := public.effective_branch_id(p_branch_id);
  if v_branch is null then raise exception 'No active branch for this session'; end if;
  perform public.assert_can_manage_org_branch_or_own(v_branch, v_own_branch);
  v_caller_role := case when v_branch = v_own_branch then v_own_role else 'owner' end;

  if v_caller_role <> 'owner' then
    raise exception 'Only the branch owner may change a staff member''s role';
  end if;

  if exists (select 1 from public.organization_members m where m.user_id = p_user_id and m.role = 'org_manager') then
    raise exception 'This person is the organization manager -- manage their access from Organization members, not this branch''s staff list';
  end if;

  update public.users
  set role = p_role
  where id = p_user_id and branch_id = v_branch and role in ('manager', 'seller');
  if not found then raise exception 'Staff member not found for this branch'; end if;
end;
$$;

-- Signature unchanged -- plain create or replace.


-- ============================================================================
-- SECTION 3 — invite_organization_member(): p_branch_id becomes optional,
-- auto-picked for a brand-new org_manager invite
-- ============================================================================
-- Parameter order changes (p_branch_id moves to the end with a default) --
-- a real signature change, so the old positional signature must be dropped
-- first. Every caller (src/lib/organization.ts's inviteOrganizationMember)
-- already calls this with named parameters, so the reorder is safe.
drop function if exists public.invite_organization_member(uuid, uuid, text, text, text);
create or replace function public.invite_organization_member(
  p_organization_id uuid, p_user_email text, p_full_name text, p_role text default 'org_manager', p_branch_id uuid default null
)
returns text  -- 'granted' (existing user, immediate) or 'invited' (new person, pending OTP)
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_target uuid;
  v_old_role text;
  v_anchor_branch uuid;
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
    -- Brand-new person: org_manager is never tied to a branch, so the
    -- org_owner is never asked to pick one -- any branch belonging to this
    -- organization works equally well as the technical anchor
    -- organization_invites.branch_id (and later users.branch_id) requires.
    -- See this file's own header for why it can't simply be null.
    v_anchor_branch := coalesce(
      p_branch_id,
      (select id from public.branches where organization_id = p_organization_id order by created_at asc limit 1)
    );
    if v_anchor_branch is null then
      raise exception 'This organization has no branches yet';
    end if;
    perform public.create_organization_invite(p_organization_id, v_anchor_branch, p_user_email, p_full_name, p_role);
    return 'invited';
  end if;

  -- Existing person (e.g. a current branch_manager being promoted): their
  -- own users.branch_id/role are deliberately left untouched -- no data
  -- mutation needed. list_branch_staff() already stops surfacing them at
  -- their old branch the moment the organization_members row below exists.
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

revoke all on function public.invite_organization_member(uuid, text, text, text, uuid) from public, anon;
grant execute on function public.invite_organization_member(uuid, text, text, text, uuid) to authenticated;
