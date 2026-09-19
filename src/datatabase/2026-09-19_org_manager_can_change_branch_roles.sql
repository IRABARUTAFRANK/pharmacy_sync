-- ============================================================================
-- Lets an org_manager (not just org_owner) change a branch person's role
-- between seller and manager -- promoting/demoting people under them was
-- previously owner-only for every case, even the purely branch-level one.
-- ============================================================================
-- Run once, after every prior file in this directory.
--
-- Assigning/removing the ORGANIZATION manager itself stays owner-only,
-- exactly as before (that's a delegation of the owner's own authority, not
-- something an org_manager can do to a peer or to themselves). The only
-- change is who may move someone between branch manager and seller.
--
-- The one-manager-per-branch guarantee this already relies on is enforced
-- at the trigger level (trg_one_manager_per_branch on public.users, added in
-- 2026-09-18_one_manager_per_branch_db_trigger.sql) -- promoting a seller to
-- 'manager' here still only succeeds while that branch's own manager seat is
-- genuinely free (the previous holder removed or deactivated), regardless of
-- which of org_owner/org_manager does the promoting.
-- ============================================================================

create or replace function public.org_change_member_role(p_organization_id uuid, p_user_id uuid, p_new_role text)
returns void
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_caller uuid := (select auth.uid());
  v_caller_org_role text;
  v_old_org_role text;
  v_old_branch_role text;
  v_target_branch_org uuid;
begin
  select m.role into v_caller_org_role
  from public.organization_members m
  join public.users u on u.id = m.user_id
  where m.organization_id = p_organization_id and m.user_id = v_caller and u.is_active;

  if v_caller_org_role not in ('org_owner', 'org_manager') then
    raise exception 'Only an active owner or manager of this organization may change a member''s role';
  end if;

  if p_new_role not in ('org_manager', 'manager', 'seller') then
    raise exception 'role must be org_manager, manager, or seller';
  end if;
  if p_user_id = v_caller then
    raise exception 'You cannot change your own role';
  end if;

  select role into v_old_org_role from public.organization_members
  where organization_id = p_organization_id and user_id = p_user_id;

  if v_old_org_role = 'org_owner' then
    raise exception 'Ownership is transferred with a separate action, not changed here';
  end if;

  -- Touching the organization manager seat, in either direction, is
  -- owner-only -- an org_manager may move people between branch roles, but
  -- never hand out or take away their own kind of seat.
  if p_new_role = 'org_manager' or v_old_org_role = 'org_manager' then
    if v_caller_org_role <> 'org_owner' then
      raise exception 'Only the organization owner may assign or remove the organization manager';
    end if;
  end if;

  -- The target must actually belong to this organization: either an
  -- org-level member of it, or branch staff at one of its branches.
  select b.organization_id, u.role into v_target_branch_org, v_old_branch_role
  from public.users u
  left join public.branches b on b.id = u.branch_id
  where u.id = p_user_id;

  if v_old_org_role is null and (v_target_branch_org is null or v_target_branch_org <> p_organization_id) then
    raise exception 'That person is not part of this organization';
  end if;

  if p_new_role = 'org_manager' then
    if exists (
      select 1 from public.organization_members
      where organization_id = p_organization_id and role = 'org_manager' and user_id <> p_user_id
    ) then
      raise exception 'This organization already has an organization manager -- change their role first';
    end if;

    insert into public.organization_members (organization_id, user_id, role)
    values (p_organization_id, p_user_id, 'org_manager')
    on conflict (organization_id, user_id) do update set role = excluded.role;

    perform public.log_role_change(
      'organization', p_organization_id, null, p_user_id, v_old_org_role, 'org_manager',
      case when v_old_org_role is null then 'grant' else 'role_change' end
    );
  else
    -- Moving back down to (or between) branch roles: the org-level grant,
    -- if any, goes away and their branch role becomes the requested one.
    -- trg_one_manager_per_branch already refuses this outright if
    -- p_new_role = 'manager' and the target branch has a different active
    -- manager -- see this file's own header comment.
    delete from public.organization_members
    where organization_id = p_organization_id and user_id = p_user_id;

    update public.users set role = p_new_role where id = p_user_id;

    perform public.log_role_change(
      'organization', p_organization_id, null, p_user_id, v_old_org_role, p_new_role, 'role_change'
    );
  end if;
end;
$$;
