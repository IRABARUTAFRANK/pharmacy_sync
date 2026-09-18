-- ============================================================================
-- CATEGORIES: A "SYNC TO ALL BRANCHES" THE SUPER ADMIN CAN RE-RUN ANY TIME
-- ============================================================================
-- admin_create_category(p_branch_id = null) ("push this to every branch")
-- only ever loops over public.branches AS THEY EXIST AT THAT MOMENT -- it has
-- no way to reach a branch created afterward. Confirmed live: a category
-- added "for all branches" before a given branch existed never appeared for
-- it, while one added after that branch existed (or targeted at it
-- specifically) showed up immediately -- exactly the "I can only see
-- Antibiotics and Test, not the rest of the category table" symptom.
--
-- product_categories has no "this was meant to be global" flag -- it can't,
-- since admin_create_category never recorded that intent anywhere, only the
-- copies it made at the time. This function's best (and, absent adding that
-- tracking retroactively, only sound) fix is to treat every DISTINCT
-- category name that exists for ANY branch today as something every branch
-- should have, and top up whichever branches are missing it -- on conflict
-- do nothing, so a branch that already has its own row for that name (its
-- own description, its own history) is left completely untouched.
--
-- Unlike a one-off backfill script, this is a real, callable RPC -- the
-- super admin can press "Sync to all branches" again after onboarding a new
-- branch, instead of every future branch needing another migration like
-- this one just to catch up.
-- ============================================================================

create or replace function public.admin_backfill_categories_to_all_branches()
returns integer
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_count integer;
begin
  perform public.assert_super_admin();

  with canonical as (
    select btrim(name) as name, min(description) as description
    from public.product_categories
    group by btrim(name)
  )
  insert into public.product_categories (branch_id, name, description)
  select b.id, c.name, c.description
  from public.branches b
  cross join canonical c
  on conflict (branch_id, name) do nothing;

  get diagnostics v_count = row_count;
  return v_count;
end;
$$;

revoke all on function public.admin_backfill_categories_to_all_branches() from public;
grant execute on function public.admin_backfill_categories_to_all_branches() to authenticated;
