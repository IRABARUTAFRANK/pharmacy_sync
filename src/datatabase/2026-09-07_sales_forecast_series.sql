-- ============================================================================
-- SALES FORECAST SERIES (for the Analytics page's forecast chart)
-- ============================================================================
-- ai_sales_forecast() (see pharmacy_schema_consolidated.sql) already returns
-- a real linear-regression forecast, but only as a single lump-sum number
-- for the whole horizon -- fine for the AI analyst's text answers, but not
-- something you can plot. This function reuses the exact same regression
-- (same daily x/y points, same regr_slope/regr_intercept) and instead
-- returns one row per bucketed period (day/week/month), so the Analytics
-- page can draw a real line chart: a solid "actual" line over history, a
-- dashed "forecast" line over the horizon, and a shaded confidence band
-- around the forecast.
--
-- ai_sales_forecast() itself is untouched -- it's also used by the AI
-- analyst as a tool (see that function's own comment), and this migration
-- must not change its existing contract.
--
-- Confidence band: the residual standard deviation of daily quantity around
-- the fitted regression line (stddev_pop of actual - predicted, over the
-- history window), scaled by sqrt(days in that future bucket) since daily
-- residuals are treated as independent, times a z-score of ~1.28 for an
-- (approximate, normal-theory) 80% two-sided interval -- matching the
-- "Shaded area shows 80% confidence interval" caption on the chart.
--
-- Run this once in the Supabase SQL editor (or via the CLI) against the
-- project's database. Safe to re-run: CREATE OR REPLACE.
-- ============================================================================

create or replace function public.ai_sales_forecast_series(
  p_product_id uuid default null,
  p_category_id uuid default null,
  p_days_history integer default 90,
  p_horizon_days integer default 30,
  p_bucket text default null -- null = auto-pick from the total span (see below)
)
returns table(
  period_start date, is_forecast boolean,
  actual_revenue numeric, actual_quantity numeric,
  forecast_revenue numeric, forecast_quantity numeric,
  lower_bound numeric, upper_bound numeric
)
language plpgsql
security definer
set search_path = ''
as $$
#variable_conflict use_column
declare
  v_branch uuid := public.current_branch_id();
  v_bucket text := p_bucket;
begin
  perform public.assert_owner_or_manager();
  if v_branch is null then raise exception 'No active branch for this session'; end if;
  if p_product_id is not null and p_category_id is not null then
    raise exception 'Pass product_id or category_id, not both';
  end if;
  if p_days_history < 7 or p_days_history > 730 then raise exception 'days_history must be between 7 and 730'; end if;
  if p_horizon_days < 1 or p_horizon_days > 365 then raise exception 'horizon_days must be between 1 and 365'; end if;

  -- Auto-pick a bucket size that keeps the chart readable regardless of how
  -- wide a window was requested, unless the caller pinned one explicitly.
  if v_bucket is null then
    v_bucket := case
      when p_days_history + p_horizon_days <= 45 then 'day'
      when p_days_history + p_horizon_days <= 180 then 'week'
      else 'month'
    end;
  end if;
  if v_bucket not in ('day','week','month') then raise exception 'bucket must be day, week or month'; end if;

  return query
  with daily as (
    select
      date_trunc('day', s.sold_at)::date as sale_day,
      sum(si.quantity) as qty,
      sum(si.unit_price * si.quantity) as revenue
    from public.sale_items si
    join public.sales s on s.id = si.sale_id
    join public.barcodes bc on bc.id = si.barcode_id
    join public.stock_batches sb on sb.id = bc.stock_batch_id
    join public.product_variants pv on pv.id = sb.product_variant_id
    left join public.branch_product_categorization cat on cat.product_id = pv.product_id and cat.branch_id = v_branch
    where s.branch_id = v_branch
      and s.sold_at >= now() - (p_days_history || ' days')::interval
      and (p_product_id is null or pv.product_id = p_product_id)
      and (p_category_id is null or cat.category_id = p_category_id)
    group by 1
  ),
  history_bounds as (
    select min(sale_day) as start_day, max(sale_day) as end_day from daily
  ),
  numbered as (
    select (d.sale_day - hb.start_day)::numeric as x, d.qty::numeric as y, d.revenue
    from daily d cross join history_bounds hb
  ),
  stats as (
    select
      coalesce(regr_slope(y, x), 0)::numeric as slope,
      coalesce(regr_intercept(y, x), avg(y), 0)::numeric as intercept,
      coalesce(sum(revenue) / nullif(sum(y), 0), 0) as avg_unit_revenue,
      coalesce(max(x), 0) as max_x
    from numbered
  ),
  model as (
    select stats.*, coalesce(stddev_pop(n.y - (stats.intercept + stats.slope * n.x)), 0) as resid_stddev
    from numbered n cross join stats
    group by stats.slope, stats.intercept, stats.avg_unit_revenue, stats.max_x
  ),
  actual_buckets as (
    select date_trunc(v_bucket, sale_day)::date as period_start, sum(qty)::numeric as quantity, sum(revenue)::numeric as revenue
    from daily
    group by 1
  ),
  last_actual as (select max(period_start) as period_start from actual_buckets),
  future_daily as (
    select
      (hb.end_day + gs.d) as future_day,
      greatest(0, m.intercept + m.slope * (m.max_x + gs.d)) as proj_qty
    from generate_series(1, p_horizon_days) as gs(d)
    cross join history_bounds hb
    cross join model m
  ),
  future_buckets as (
    select date_trunc(v_bucket, future_day)::date as period_start, sum(proj_qty)::numeric as quantity, count(*)::numeric as n_days
    from future_daily
    group by 1
  )
  select * from (
    -- Past/actual periods. The last actual period also carries a forecast
    -- value equal to its own actual value -- a "bridge" point so the dashed
    -- forecast line visually connects to the solid actual line with no gap,
    -- the same way the reference chart's Aug point does.
    select
      ab.period_start, false as is_forecast,
      round(ab.revenue, 2) as actual_revenue, round(ab.quantity, 2) as actual_quantity,
      case when ab.period_start = la.period_start then round(ab.revenue, 2) end as forecast_revenue,
      case when ab.period_start = la.period_start then round(ab.quantity, 2) end as forecast_quantity,
      null::numeric as lower_bound, null::numeric as upper_bound
    from actual_buckets ab cross join last_actual la
    union all
    -- Future/forecast periods, with an 80%-ish confidence band around each.
    select
      fb.period_start, true as is_forecast,
      null::numeric, null::numeric,
      round(fb.quantity * m.avg_unit_revenue, 2), round(fb.quantity, 2),
      round(greatest(0, fb.quantity - 1.28 * m.resid_stddev * sqrt(fb.n_days)) * m.avg_unit_revenue, 2),
      round((fb.quantity + 1.28 * m.resid_stddev * sqrt(fb.n_days)) * m.avg_unit_revenue, 2)
    from future_buckets fb cross join model m
  ) t
  order by period_start;
end;
$$;

revoke all on function public.ai_sales_forecast_series(uuid, uuid, integer, integer, text) from public, anon;
grant execute on function public.ai_sales_forecast_series(uuid, uuid, integer, integer, text) to authenticated;
