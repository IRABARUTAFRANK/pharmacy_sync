-- ============================================================================
-- STAFF REMOVAL + COMBINED EMAIL/PASSWORD CHANGE
-- ============================================================================
-- Run once, after every prior file in this directory. Idempotent.
--
-- Two things requested together: (1) a real "Remove" action for staff, on
-- top of the existing reversible Deactivate/Reactivate toggle -- Remove
-- permanently revokes login (via Supabase Auth's ban_duration, from the
-- Edge Function that calls mark_staff_removed() below) while leaving every
-- row of the person's history untouched, since most activity tables
-- (sales.cashier_id, stock_batches.logged_by, ...) reference public.users.id
-- with NO ACTION and would fail a hard delete for anyone with real history.
-- (2) an org_owner/org_manager (or branch owner/manager, same ranks as
-- everywhere else) being able to change a subordinate's EMAIL as well as
-- their password, not just the password reset already shipped.
--
-- is_removed is the one new bit of state: a removed account is always also
-- is_active = false, but the reverse isn't true, and the distinction matters
-- -- admin_set_seller_active/org_set_user_active must refuse to ever flip a
-- removed account back to active, closing the exact same kind of
-- "reactivate -> bypass the real rule" gap 2026-09-18_manager_reactivation_
-- gap.sql fixed for the one-manager-per-branch invariant.
-- ============================================================================

alter table public.users add column if not exists is_removed boolean not null default false;

-- Generic alias for assert_can_reset_staff_password() (2026-09-18_reset_
-- staff_password.sql) -- that function's authorization rule ("act on who's
-- below you, never who's above, never yourself") is exactly right for
-- removal and email changes too, not just password resets. Delegates rather
-- than duplicating the ~70 lines of rank logic, and leaves the existing,
-- already-deployed reset-staff-password Edge Function completely untouched.
create or replace function public.assert_can_manage_staff_account(p_target_user_id uuid)
returns void
language plpgsql
security definer
set search_path = ''
as $$
begin
  perform public.assert_can_reset_staff_password(p_target_user_id);
end;
$$;

revoke all on function public.assert_can_manage_staff_account(uuid) from public, anon;
grant execute on function public.assert_can_manage_staff_account(uuid) to authenticated;

-- Authorizes AND performs the one DB-side-effect of removal. The actual
-- login ban still needs Supabase's service-role Admin API (no SQL function
-- can do that) -- the remove-staff-account Edge Function calls this first
-- (as the caller, via their own JWT), then bans, same order reset-staff-
-- password already established for its own Admin API call.
create or replace function public.mark_staff_removed(p_target_user_id uuid)
returns void
language plpgsql
security definer
set search_path = ''
as $$
begin
  perform public.assert_can_manage_staff_account(p_target_user_id);
  update public.users set is_active = false, is_removed = true where id = p_target_user_id;
end;
$$;

revoke all on function public.mark_staff_removed(uuid) from public, anon;
grant execute on function public.mark_staff_removed(uuid) to authenticated;

-- Same body as the live admin_set_seller_active(), plus one new guard: a
-- removed account can never be reactivated through this RPC (the only path
-- BranchSettingsPage's Activate/Deactivate button uses).
create or replace function public.admin_set_seller_active(p_user_id uuid, p_is_active boolean)
returns void
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_caller uuid := (select auth.uid());
  v_branch uuid;
  v_caller_role text;
  v_target_role text;
  v_target_removed boolean;
begin
  select u.branch_id, u.role into v_branch, v_caller_role
  from public.users u
  where u.id = v_caller and u.is_active and u.role in ('owner', 'manager');
  if v_branch is null then raise exception 'Only an active branch manager or owner may manage staff'; end if;

  select role, is_removed into v_target_role, v_target_removed from public.users where id = p_user_id and branch_id = v_branch;
  if v_target_role is null or v_target_role not in ('manager', 'seller') then
    raise exception 'Staff member not found for this branch';
  end if;
  if v_target_role = 'manager' and v_caller_role <> 'owner' then
    raise exception 'Only the branch owner may deactivate a manager';
  end if;
  if p_is_active and v_target_removed then
    raise exception 'This account has been permanently removed and cannot be reactivated';
  end if;

  update public.users
  set is_active = p_is_active
  where id = p_user_id and branch_id = v_branch and role in ('manager', 'seller');
end;
$$;

-- Same body as the live org_set_user_active(), plus the same is_removed guard.
create or replace function public.org_set_user_active(p_organization_id uuid, p_target_user_id uuid, p_is_active boolean)
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
  v_target_removed boolean;
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

  select is_removed into v_target_removed from public.users where id = p_target_user_id;
  if p_is_active and v_target_removed then
    raise exception 'This account has been permanently removed and cannot be reactivated';
  end if;

  update public.users set is_active = p_is_active where id = p_target_user_id;
end;
$$;

-- Both listings need is_removed too, so the Users & Roles / Members UI can
-- hide Deactivate/Reactivate and show a "Removed" badge instead, once a
-- person's is_removed flips true. Return type changed (a new OUT column),
-- so these need DROP + CREATE rather than CREATE OR REPLACE.
drop function if exists public.list_branch_staff(uuid);
drop function if exists public.list_organization_people(uuid);

create function public.list_branch_staff(p_branch_id uuid default null::uuid)
returns table(id uuid, full_name text, email text, role text, is_active boolean, is_removed boolean, created_at timestamptz)
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  v_branch uuid := public.effective_branch_id(p_branch_id);
  v_caller_role text;
  v_caller_rank integer;
begin
  select u.role into v_caller_role from public.users u where u.id = (select auth.uid());
  v_caller_rank := case v_caller_role when 'owner' then 3 when 'manager' then 2 else 1 end;

  return query
    select
      u.id, u.full_name::text,
      case
        when (case u.role when 'owner' then 3 when 'manager' then 2 else 1 end) > v_caller_rank then null
        else u.email::text
      end,
      u.role::text, u.is_active, u.is_removed, u.created_at
    from public.users u
    where u.branch_id = v_branch
      and not exists (select 1 from public.organization_members m where m.user_id = u.id and m.role = 'org_manager')
    order by u.role, u.full_name;
end;
$$;

revoke all on function public.list_branch_staff(uuid) from public, anon;
grant execute on function public.list_branch_staff(uuid) to authenticated;

create function public.list_organization_people(p_organization_id uuid)
returns table(user_id uuid, full_name text, email text, scope text, role text, branch_id uuid, branch_name text, is_active boolean, is_removed boolean)
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  v_caller_role text;
begin
  perform public.assert_org_member(p_organization_id);

  select m_self.role into v_caller_role
  from public.organization_members m_self
  where m_self.organization_id = p_organization_id and m_self.user_id = (select auth.uid());

  return query
    select u.id, u.full_name::text,
      case when v_caller_role = 'org_manager' and m.role = 'org_owner' and not public.is_super_admin()
        then null else u.email::text end,
      'organization'::text, m.role::text,
      null::uuid, null::text, u.is_active, u.is_removed
    from public.organization_members m
    join public.users u on u.id = m.user_id
    where m.organization_id = p_organization_id
    union all
    select u.id, u.full_name::text, u.email::text, 'branch'::text, u.role::text,
      b.id, b.name::text, u.is_active, u.is_removed
    from public.users u
    join public.branches b on b.id = u.branch_id
    where b.organization_id = p_organization_id
      and u.id not in (select om.user_id from public.organization_members om where om.organization_id = p_organization_id)
    order by 4, 5, 2;
end;
$$;

revoke all on function public.list_organization_people(uuid) from public, anon;
grant execute on function public.list_organization_people(uuid) to authenticated;

-- admin_set_seller_active is overloaded -- a second, 3-arg version exists
-- for an org_owner/org_manager acting on a branch OTHER than their own
-- (branchArg() in the client adds p_branch_id only in that case, which
-- PostgREST resolves to this overload instead of the 2-arg one above).
-- Same is_removed guard needs to land here too, or "viewing another
-- branch" would stay a bypass for the exact rule just closed above.
create or replace function public.admin_set_seller_active(p_user_id uuid, p_is_active boolean, p_branch_id uuid default null::uuid)
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
  v_target_removed boolean;
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

  select role, is_removed into v_target_role, v_target_removed from public.users where id = p_user_id and branch_id = v_branch;
  if v_target_role is null or v_target_role not in ('manager', 'seller') then
    raise exception 'Staff member not found for this branch';
  end if;
  if v_target_role = 'manager' and v_caller_role <> 'owner' then
    raise exception 'Only the branch owner may deactivate a manager';
  end if;
  if p_is_active and v_target_removed then
    raise exception 'This account has been permanently removed and cannot be reactivated';
  end if;

  update public.users
  set is_active = p_is_active
  where id = p_user_id and branch_id = v_branch and role in ('manager', 'seller');
end;
$$;
