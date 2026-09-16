-- ============================================================================
-- Branch staff roster: mask a higher role's email from a lower one
-- ============================================================================
-- Run once, after 2026-09-15_org_manager_not_tied_to_branch.sql (the
-- current latest declaration of list_branch_staff()). Idempotent.
--
-- Real gap found: the org-level roster (list_organization_people(),
-- 2026-09-14_role_hierarchy_visibility.sql) already masks a higher role's
-- email from a lower one ("a role sees who's below it, never the
-- credentials of who's above"), but the BRANCH-level roster
-- (list_branch_staff(), Branch Settings -> Users & Roles) never got the
-- same treatment -- it always returned every row's real email, so a plain
-- branch 'manager' could see the branch 'owner's email (and anyone else's)
-- with no masking at all. This closes that gap the same way: name, role,
-- and active status stay visible either way -- only the email of a
-- strictly-higher role is hidden. Peers (manager viewing another manager)
-- still see each other fully, matching the org-level precedent exactly.
-- ============================================================================

create or replace function public.list_branch_staff(p_branch_id uuid default null)
returns table(id uuid, full_name text, email text, role text, is_active boolean, created_at timestamptz)
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
      u.role::text, u.is_active, u.created_at
    from public.users u
    where u.branch_id = v_branch
      and not exists (select 1 from public.organization_members m where m.user_id = u.id and m.role = 'org_manager')
    order by u.role, u.full_name;
end;
$$;

-- Signature unchanged -- plain create or replace.
