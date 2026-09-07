-- ============================================================================
-- SALES FORECAST ACCURACY (predicted-vs-actual tracking)
-- ============================================================================
-- ai_sales_forecast_series() (2026-09-07_sales_forecast_series.sql) always
-- computes a forecast fresh, relative to "now" -- once a forecasted period is
-- in the past, the next run just folds it into real "actual" data. That's
-- correct for the forecast itself, but it throws away what was PREDICTED at
-- the time, so there's no way to later see "how close was this?".
--
-- This migration adds a small backing store (sales_forecast_snapshots) that
-- remembers each forecast run's future points, and a read function
-- (ai_sales_forecast_accuracy) that -- for a given historical date range --
-- looks up the most recent prediction that was made *before* each period
-- actually happened, so the Analytics chart can draw a third line: what we
-- predicted, next to what the real "Actual Revenue" line turned out to be.
--
-- The table has RLS enabled with NO policies -- like every other reporting
-- table in this app, it is never read or written directly by the client;
-- both operations go through the two SECURITY DEFINER functions below,
-- which enforce assert_owner_or_manager() + branch scoping themselves.
--
-- Snapshot cadence: an auto-running forecast (see AnalyticsPage.tsx, which
-- re-runs on every product/category/history/horizon change) would otherwise
-- write a near-identical row every few seconds while someone is just
-- tweaking inputs. save_sales_forecast_snapshot() instead keeps at most one
-- row per (branch, scope) per calendar day, updating it in place if one
-- already exists for today -- so history accumulates one genuine snapshot
-- per day, kept forever, without that noise.
--
-- Run this once in the Supabase SQL editor (or via the CLI) against the
-- project's database. Safe to re-run: CREATE TABLE IF NOT EXISTS / CREATE OR
-- REPLACE FUNCTION.
-- ============================================================================

create table if not exists public.sales_forecast_snapshots (
  id uuid primary key default gen_random_uuid(),
  branch_id uuid not null references public.branches(id) on delete cascade,
  product_id uuid references public.products(id) on delete cascade,
  category_id uuid references public.product_categories(id) on delete cascade,
  generated_at timestamptz not null default now(),
  bucket text not null check (bucket in ('day','week','month')),
  -- One element per future period this run predicted:
  -- {"period_start": "2026-09-01", "predicted_revenue": 123, "predicted_quantity": 45, "lower_bound": 100, "upper_bound": 150}
  points jsonb not null
);

create index if not exists idx_forecast_snapshots_scope on public.sales_forecast_snapshots (branch_id, product_id, category_id, generated_at desc);

alter table public.sales_forecast_snapshots enable row level security;

create or replace function public.save_sales_forecast_snapshot(
  p_product_id uuid default null,
  p_category_id uuid default null,
  p_bucket text default 'month',
  p_points jsonb default '[]'::jsonb
)
returns void
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_branch uuid := public.current_branch_id();
  v_nil uuid := '00000000-0000-0000-0000-000000000000';
begin
  perform public.assert_owner_or_manager();
  if v_branch is null then raise exception 'No active branch for this session'; end if;
  if p_product_id is not null and p_category_id is not null then
    raise exception 'Pass product_id or category_id, not both';
  end if;
  if p_bucket not in ('day','week','month') then raise exception 'bucket must be day, week or month'; end if;

  update public.sales_forecast_snapshots
  set generated_at = now(), bucket = p_bucket, points = p_points
  where branch_id = v_branch
    and coalesce(product_id, v_nil) = coalesce(p_product_id, v_nil)
    and coalesce(category_id, v_nil) = coalesce(p_category_id, v_nil)
    and generated_at::date = current_date;

  if not found then
    insert into public.sales_forecast_snapshots (branch_id, product_id, category_id, bucket, points)
    values (v_branch, p_product_id, p_category_id, p_bucket, p_points);
  end if;
end;
$$;

create or replace function public.ai_sales_forecast_accuracy(
  p_product_id uuid default null,
  p_category_id uuid default null,
  p_from date default null,
  p_to date default null
)
returns table(period_start date, predicted_revenue numeric, predicted_quantity numeric, predicted_at timestamptz)
language plpgsql
security definer
set search_path = ''
as $$
#variable_conflict use_column
declare
  v_branch uuid := public.current_branch_id();
begin
  perform public.assert_owner_or_manager();
  if v_branch is null then raise exception 'No active branch for this session'; end if;
  if p_product_id is not null and p_category_id is not null then
    raise exception 'Pass product_id or category_id, not both';
  end if;

  return query
  with expanded as (
    select
      s.generated_at,
      (pt->>'period_start')::date as period_start,
      (pt->>'predicted_revenue')::numeric as predicted_revenue,
      (pt->>'predicted_quantity')::numeric as predicted_quantity
    from public.sales_forecast_snapshots s
    cross join lateral jsonb_array_elements(s.points) as pt
    where s.branch_id = v_branch
      and ((p_product_id is null and s.product_id is null) or s.product_id = p_product_id)
      and ((p_category_id is null and s.category_id is null) or s.category_id = p_category_id)
      and (p_from is null or (pt->>'period_start')::date >= p_from)
      and (p_to is null or (pt->>'period_start')::date <= p_to)
  ),
  -- Only predictions made before the period they predicted actually started
  -- count as a real forecast of it; among those, the most recent one is the
  -- most-informed guess available at the time, so that's what gets compared
  -- against the real outcome.
  ranked as (
    select *, row_number() over (partition by period_start order by generated_at desc) as rn
    from expanded
    where generated_at::date < period_start
  )
  select period_start, predicted_revenue, predicted_quantity, generated_at as predicted_at
  from ranked
  where rn = 1
  order by period_start;
end;
$$;

revoke all on function public.save_sales_forecast_snapshot(uuid, uuid, text, jsonb) from public, anon;
grant execute on function public.save_sales_forecast_snapshot(uuid, uuid, text, jsonb) to authenticated;
revoke all on function public.ai_sales_forecast_accuracy(uuid, uuid, date, date) from public, anon;
grant execute on function public.ai_sales_forecast_accuracy(uuid, uuid, date, date) to authenticated;
