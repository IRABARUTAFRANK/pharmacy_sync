-- ============================================================================
-- ONE MANAGER PER BRANCH -- same rule as the existing one-owner-per-branch,
-- extended to 'manager'
-- ============================================================================
-- Run once, after every prior file in this directory. Idempotent.
--
-- users_one_owner_per_branch (a unique partial index on branch_id where
-- role = 'owner') is the real, database-level guarantee behind "a branch can
-- only ever have one owner". No equivalent ever existed for 'manager', so a
-- branch could silently end up with two (or more) real managers -- reported
-- directly, and confirmed live: this project's own "haraka pharmacy" branch
-- already had two genuinely active managers before this fix.
--
-- A plain unique index (the owner's own approach) does NOT work for
-- 'manager', though: an org_manager's technical anchor row also has
-- role = 'manager' on public.users (see create-branch-seller's own comment --
-- it's a required-NOT-NULL placeholder, never a real branch assignment, and
-- list_branch_staff() already excludes it from every branch's roster). An
-- index predicate can't see across to organization_members to exclude that
-- case, so every check below does instead: "this branch already has a
-- manager" means a role='manager' row that is NOT also an org_manager
-- anchor. Sellers are unaffected -- an organization can have as many as it
-- wants.
-- ============================================================================

-- ── org_assign_branch_role(): the org_owner/org_manager "assign a role to
-- an existing person" path (2026-09-09_organization_roles_v2.sql). Only ever
-- checked for a second owner; now checks for a second real manager too.
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
  perform public.assert_can_manage_org_branch(p_organization_id);
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
  if p_role = 'manager' and v_old_role <> 'manager' and exists (
    select 1 from public.users u
    where u.branch_id = p_branch_id and u.role = 'manager'
      and not exists (select 1 from public.organization_members om where om.user_id = u.id and om.role = 'org_manager')
  ) then
    raise exception 'This branch already has a manager -- change their role first, or assign seller instead';
  end if;

  update public.users set role = p_role where id = v_target;
  perform public.log_role_change('branch', null, p_branch_id, v_target, v_old_role, p_role, 'role_change');

  return 'granted';
end;
$$;

-- ── admin_update_staff_role(): the branch owner's own "promote a seller to
-- manager" path (2026-09-15_org_manager_precedence_over_owner.sql). Had no
-- check against a second manager at all.
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

  if p_role = 'manager' and exists (
    select 1 from public.users u
    where u.branch_id = v_branch and u.role = 'manager' and u.id <> p_user_id
      and not exists (select 1 from public.organization_members om where om.user_id = u.id and om.role = 'org_manager')
  ) then
    raise exception 'This branch already has a manager -- change their role first, or assign this person as seller instead';
  end if;

  update public.users
  set role = p_role
  where id = p_user_id and branch_id = v_branch and role in ('manager', 'seller');
  if not found then raise exception 'Staff member not found for this branch'; end if;
end;
$$;
