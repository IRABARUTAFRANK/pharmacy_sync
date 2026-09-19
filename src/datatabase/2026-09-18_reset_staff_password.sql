-- ============================================================================
-- RESET STAFF PASSWORD -- authorization check backing a "reset password"
-- action, in place of ever showing a real password
-- ============================================================================
-- Run once, after every prior file in this directory. Idempotent.
--
-- Requested directly: an org_owner/org_manager should be able to see the
-- "credentials" of people below them in the hierarchy. Supabase Auth never
-- stores or exposes a real, reversible password to anyone (including
-- service-role) -- only a one-way hash -- so "see the password" is replaced
-- with "set a new one for them", gated by the exact same role-hierarchy
-- rule list_branch_staff() and list_organization_people() already use to
-- decide whose EMAIL is visible to whom (2026-09-14_role_hierarchy_
-- visibility.sql, 2026-09-15_branch_staff_email_hierarchy.sql): a role may
-- act on who's below it, never on who's above it, and never on itself here
-- (that's the ordinary account settings/change-password flow instead).
--
-- This function only AUTHORIZES -- it raises if the caller may not reset
-- p_target_user_id's password, and returns silently if they may. The actual
-- password change still needs Supabase's service-role Admin API (no SQL
-- function can do that), so the reset-staff-password Edge Function calls
-- this first (as the caller, via their own JWT) before touching anything
-- with its service-role client.
-- ============================================================================

create or replace function public.assert_can_reset_staff_password(p_target_user_id uuid)
returns void
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_caller uuid := (select auth.uid());
  v_caller_org_role text;
  v_caller_org_id uuid;
  v_caller_branch_role text;
  v_caller_branch_id uuid;
  v_target_org_role text;
  v_target_org_id uuid;
  v_target_branch_role text;
  v_target_branch_id uuid;
begin
  if v_caller is null then raise exception 'Not signed in'; end if;
  if v_caller = p_target_user_id then
    raise exception 'Use your own account settings to change your own password';
  end if;

  select om.role, om.organization_id into v_caller_org_role, v_caller_org_id
  from public.organization_members om where om.user_id = v_caller;
  select u.role, u.branch_id into v_caller_branch_role, v_caller_branch_id
  from public.users u where u.id = v_caller and u.is_active;

  select om.role, om.organization_id into v_target_org_role, v_target_org_id
  from public.organization_members om where om.user_id = p_target_user_id;
  select u.role, u.branch_id into v_target_branch_role, v_target_branch_id
  from public.users u where u.id = p_target_user_id;

  if v_target_branch_id is null then raise exception 'Person not found'; end if;

  -- Target is an org-level person (org_owner/org_manager). Only that same
  -- organization's org_owner may reset an org_manager's password; nobody
  -- may reset an org_owner's password through this action (no one above
  -- them in this app's own hierarchy).
  if v_target_org_role is not null then
    if v_target_org_role = 'org_owner' then
      raise exception 'The organization owner''s password cannot be reset from here';
    end if;
    if v_caller_org_role = 'org_owner' and v_caller_org_id = v_target_org_id then
      return;
    end if;
    raise exception 'Only the organization owner may reset this person''s password';
  end if;

  -- Target is a branch-scoped person (owner/manager/seller).
  -- (a) Caller is an org_owner/org_manager of the target branch's own
  -- organization -- same authority assert_can_manage_org_branch grants
  -- everywhere else in this schema.
  if v_caller_org_role in ('org_owner', 'org_manager') and exists (
    select 1 from public.branches b where b.id = v_target_branch_id and b.organization_id = v_caller_org_id
  ) then
    return;
  end if;

  -- (b) Caller is that SAME branch's owner, target is its manager/seller.
  if v_caller_branch_id = v_target_branch_id and v_caller_branch_role = 'owner' and v_target_branch_role in ('manager', 'seller') then
    return;
  end if;

  -- (c) Caller is that same branch's manager, target is a seller.
  if v_caller_branch_id = v_target_branch_id and v_caller_branch_role = 'manager' and v_target_branch_role = 'seller' then
    return;
  end if;

  raise exception 'You do not have permission to reset this person''s password';
end;
$$;

revoke all on function public.assert_can_reset_staff_password(uuid) from public, anon;
grant execute on function public.assert_can_reset_staff_password(uuid) to authenticated;
