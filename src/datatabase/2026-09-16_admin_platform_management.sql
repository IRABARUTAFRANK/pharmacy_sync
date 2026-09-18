-- ============================================================================
-- ADMIN PLATFORM MANAGEMENT -- organization editing + platform usage stats
-- for the super-admin console.
-- ============================================================================
-- Three new functions, all super-admin only (assert_super_admin(), same
-- guard every other admin_* function in this schema already uses). No name
-- collisions with anything in 2026-09-16_catch_up_full_state.sql, so run
-- order between these two same-dated files does not matter.
--
--   1. admin_update_organization_details() -- the super admin can correct an
--      organization's legal name / trade name / TIN after registration,
--      mirroring admin_update_branch_details()'s existing pattern for
--      branches. Status (active/suspended) is intentionally NOT here -- that
--      stays on admin_set_organization_status(), its own dedicated action,
--      not folded into a generic "edit" form.
--
--   2. admin_platform_stats() -- one row of platform-wide counts for the
--      super-admin Dashboard overview: organizations, branches (total +
--      active), staff members (total + active), and patients registered
--      platform-wide. "Active members" is this app's closest available
--      proxy for "software usage" -- there is no login/session log table to
--      draw a real active-user metric from, so is_active staff headcount is
--      what's offered instead, honestly labeled as headcount, not sessions.
--
--   3. admin_patients_time_series() -- patients registered per day/week/
--      month over the requested number of periods, platform-wide, for the
--      Dashboard's "patients received over time" chart. Uses range
--      comparisons (bucket_start <= created_at < bucket_start + 1 period)
--      rather than equality on a truncated timestamp, which sidesteps any
--      timezone-boundary edge case that equality-on-date_trunc can hit.
-- ============================================================================

create or replace function public.admin_update_organization_details(
  p_organization_id uuid, p_legal_name text, p_trade_name text, p_tin text
)
returns void
language plpgsql
security definer
set search_path = ''
as $$
begin
  perform public.assert_super_admin();
  if p_legal_name is null or trim(p_legal_name) = '' then
    raise exception 'Legal name is required';
  end if;
  if not exists (select 1 from public.pharmacy_organizations where id = p_organization_id) then
    raise exception 'Unknown organization';
  end if;
  update public.pharmacy_organizations
  set legal_name = trim(p_legal_name),
      trade_name = nullif(trim(coalesce(p_trade_name, '')), ''),
      tin = nullif(trim(coalesce(p_tin, '')), '')
  where id = p_organization_id;
end;
$$;

revoke all on function public.admin_update_organization_details(uuid, text, text, text) from public, anon;
grant execute on function public.admin_update_organization_details(uuid, text, text, text) to authenticated;


create or replace function public.admin_platform_stats()
returns table(
  total_organizations integer,
  total_branches integer,
  active_branches integer,
  total_members integer,
  active_members integer,
  total_patients integer
)
language plpgsql
stable
security definer
set search_path = ''
as $$
begin
  perform public.assert_super_admin();
  return query
    select
      (select count(*)::integer from public.pharmacy_organizations),
      (select count(*)::integer from public.branches),
      (select count(*)::integer from public.branches where status = 'active'),
      (select count(*)::integer from public.users),
      (select count(*)::integer from public.users where is_active),
      (select count(*)::integer from public.patients);
end;
$$;

revoke all on function public.admin_platform_stats() from public, anon;
grant execute on function public.admin_platform_stats() to authenticated;


create or replace function public.admin_patients_time_series(p_interval text default 'day', p_periods integer default 30)
returns table(period_start date, patient_count integer)
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  v_step interval;
begin
  perform public.assert_super_admin();
  if p_interval not in ('day', 'week', 'month') then
    raise exception 'p_interval must be day, week, or month';
  end if;
  if p_periods < 1 or p_periods > 366 then
    raise exception 'p_periods must be between 1 and 366';
  end if;
  v_step := ('1 ' || p_interval)::interval;

  return query
    with buckets as (
      select date_trunc(p_interval, now()) - (v_step * n) as bucket_start
      from generate_series(0, p_periods - 1) as n
    )
    select
      b.bucket_start::date,
      (
        select count(*)::integer from public.patients p
        where p.created_at >= b.bucket_start and p.created_at < b.bucket_start + v_step
      )
    from buckets b
    order by b.bucket_start;
end;
$$;

revoke all on function public.admin_patients_time_series(text, integer) from public, anon;
grant execute on function public.admin_patients_time_series(text, integer) to authenticated;
