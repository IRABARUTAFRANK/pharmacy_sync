-- ============================================================================
-- ONE MANAGER PER BRANCH -- closing the reactivation gap, plus a matching
-- hard guarantee for one org_manager per organization
-- ============================================================================
-- Run once, after every prior file in this directory. Idempotent.
--
-- Reported directly, and reproduced: 2026-09-18_one_manager_per_branch_db_
-- trigger.sql's trigger only fired on `insert or update of role, branch_id`
-- -- reactivating a deactivated manager (is_active false -> true) touches
-- neither column, so it never ran the check at all. A branch could end up
-- with Manager A deactivated and Manager B hired as their active
-- replacement (correctly allowed -- A isn't really operating as manager
-- anymore), then A gets reactivated later with NO check at all, landing two
-- ACTIVE managers on the same branch. Verified live (rolled back, no real
-- data changed): reactivating a deactivated manager where an active one
-- already existed succeeded silently before this fix.
--
-- Fix: the trigger now also fires on `is_active` changes, and the conflict
-- check only ever counts an ACTIVE manager row as a conflict -- a
-- deactivated one sitting on file is not a live guarantee violation, it's
-- just history. This is what makes "deactivate the old one, hire an active
-- replacement" keep working exactly as before, while "reactivate someone
-- while a replacement is already active" now correctly fails.
-- ============================================================================

create or replace function public.enforce_one_manager_per_branch()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  -- A manager row that isn't active can never conflict with anything --
  -- it isn't really operating as this branch's manager right now.
  if new.role <> 'manager' or new.is_active = false then
    return null;
  end if;

  if exists (select 1 from public.organization_members om where om.user_id = new.id and om.role = 'org_manager') then
    return null;
  end if;

  if exists (
    select 1 from public.users u
    where u.branch_id = new.branch_id
      and u.role = 'manager'
      and u.is_active = true
      and u.id <> new.id
      and not exists (select 1 from public.organization_members om where om.user_id = u.id and om.role = 'org_manager')
  ) then
    raise exception 'This branch already has an active manager -- deactivate them first, or assign this person as seller instead';
  end if;

  return null;
end;
$$;

drop trigger if exists trg_one_manager_per_branch on public.users;
create constraint trigger trg_one_manager_per_branch
  after insert or update of role, branch_id, is_active on public.users
  deferrable initially deferred
  for each row
  execute function public.enforce_one_manager_per_branch();

-- ── One org_manager per organization -- a real hard guarantee, not just
-- the application-level checks in invite_organization_member(),
-- org_change_member_role(), and create-branch-seller's own org_manager
-- path. Unlike the branch-manager case above, deactivation was never a
-- gap here -- an org_manager's grant lives in organization_members,
-- untouched by org_set_user_active()/is_active toggles either way -- but
-- the cap itself was still only ever application-enforced. Same reasoning
-- as the branch-manager trigger: whatever prevents a bug today shouldn't
-- be the only thing preventing it tomorrow.
create or replace function public.enforce_one_org_manager_per_org()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  if new.role <> 'org_manager' then
    return null;
  end if;

  if exists (
    select 1 from public.organization_members om
    where om.organization_id = new.organization_id
      and om.role = 'org_manager'
      and om.user_id <> new.user_id
  ) then
    raise exception 'This organization already has an organization manager -- remove them first';
  end if;

  return null;
end;
$$;

drop trigger if exists trg_one_org_manager_per_org on public.organization_members;
create constraint trigger trg_one_org_manager_per_org
  after insert or update of role, organization_id on public.organization_members
  deferrable initially deferred
  for each row
  execute function public.enforce_one_org_manager_per_org();
