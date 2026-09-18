-- ============================================================================
-- ONE MANAGER PER BRANCH -- a real database-level guarantee, not just RPC
-- checks
-- ============================================================================
-- Run once, after every prior file in this directory. Idempotent.
--
-- 2026-09-17_one_manager_per_branch.sql added the check to every RPC that
-- can assign 'manager' (org_assign_branch_role, admin_update_staff_role) and
-- to create-branch-seller's Edge Function. That closes every path this app's
-- OWN client code goes through today, but it is still just application-level
-- discipline: a future RPC, a seed script, a direct admin query, or a bug in
-- any of those functions could still write a second real manager into the
-- same branch, and nothing would stop it. Requested directly: this needs to
-- be true for the whole system, including every organization created from
-- now on, not just enforced by the specific functions that happen to check
-- for it today.
--
-- This adds that guarantee as a trigger on public.users itself -- it fires
-- on every insert or role/branch change, from ANY caller, and is the one
-- thing every path (RPC, Edge Function, future code, manual fix-up SQL)
-- cannot get around.
--
-- Why a trigger and not a plain unique index (like users_one_owner_per_
-- branch already does for 'owner'): an org_manager's own technical-anchor
-- row also has role = 'manager' on public.users (a required-NOT-NULL
-- placeholder, never a real branch assignment -- see create-branch-seller's
-- own header comment). A unique index's WHERE clause can only look at the
-- row itself, it cannot exclude "rows that also happen to have an
-- organization_members entry" -- only a trigger, which can query other
-- tables, can express that.
--
-- Why DEFERRABLE INITIALLY DEFERRED (checked at COMMIT, not immediately
-- after each row): creating a brand-new org_manager writes TWO rows in one
-- transaction -- the public.users anchor row (role='manager') THEN the
-- organization_members row (role='org_manager') that marks it as an anchor
-- (see activate_organization_invite() and the new create_org_manager_login()
-- below). An immediate trigger would run after the FIRST insert, before the
-- second one exists yet, and could never see the anchor as exempt -- worse,
-- it could wrongly block the anchor from ever being created, since its
-- placeholder branch commonly already has its own real manager. Deferring
-- to commit means both rows already exist by the time the check runs,
-- regardless of which order they were written in.
-- ============================================================================

create or replace function public.enforce_one_manager_per_branch()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  if new.role <> 'manager' then
    return null;
  end if;

  -- An org_manager's own technical anchor is exempt -- it is never a real
  -- branch assignment (list_branch_staff() already excludes it from every
  -- branch's own roster the same way).
  if exists (select 1 from public.organization_members om where om.user_id = new.id and om.role = 'org_manager') then
    return null;
  end if;

  if exists (
    select 1 from public.users u
    where u.branch_id = new.branch_id
      and u.role = 'manager'
      and u.id <> new.id
      and not exists (select 1 from public.organization_members om where om.user_id = u.id and om.role = 'org_manager')
  ) then
    raise exception 'This branch already has a manager -- change their role first, or assign this person as seller instead';
  end if;

  return null;
end;
$$;

drop trigger if exists trg_one_manager_per_branch on public.users;
create constraint trigger trg_one_manager_per_branch
  after insert or update of role, branch_id on public.users
  deferrable initially deferred
  for each row
  execute function public.enforce_one_manager_per_branch();

-- ── create_org_manager_login(): the atomic replacement for the two separate
-- inserts create-branch-seller's Edge Function used to make (public.users,
-- then organization_members, as two independent REST calls -- two separate
-- transactions). Wrapping both in one plpgsql function makes them one
-- transaction, which is exactly what the deferred trigger above needs to
-- correctly recognize the anchor. The Edge Function's own manual rollback
-- (deleting the auth user and the users row if the organization_members
-- insert failed) is no longer needed for this path either -- a failure
-- anywhere in this function now rolls back both inserts automatically.
create or replace function public.create_org_manager_login(
  p_user_id uuid, p_branch_id uuid, p_full_name text, p_email text, p_organization_id uuid
)
returns void
language plpgsql
security definer
set search_path = ''
as $$
begin
  insert into public.users (id, branch_id, full_name, email, role, is_active)
  values (p_user_id, p_branch_id, p_full_name, p_email, 'manager', true);

  insert into public.organization_members (organization_id, user_id, role)
  values (p_organization_id, p_user_id, 'org_manager');
end;
$$;

revoke all on function public.create_org_manager_login(uuid, uuid, text, text, uuid) from public, anon, authenticated;
