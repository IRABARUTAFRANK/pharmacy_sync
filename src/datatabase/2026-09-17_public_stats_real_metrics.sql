-- ============================================================================
-- PUBLIC MARKETING STATS -- widened with real, live platform metrics
-- ============================================================================
-- public_platform_stats() already existed (pharmacy_schema_consolidated.sql)
-- for the home page's "Pharmacies / SKUs / Cities" trust strip. The rest of
-- the home page's numbers -- the hero's floating "1,284 SKUs / RWF 842k
-- revenue today / 3 expiring" bubbles, and each feature's "Key metric"
-- badge ("99.8% scan accuracy", "34% overstock reduction", "48 hrs transfer
-- time") -- were plain hardcoded literals with no real number behind them
-- at all. This widens the SAME function (same name, same anon-callable,
-- aggregate-only security posture already established for it) with real
-- platform-wide aggregates to back every one of those honestly:
--
--   revenue_today        sum of today's sales, platform-wide
--   expiring_soon        active pack/box units expiring within 30 days
--   sales_processed      total sales ever recorded (replaces the fabricated
--                         "99.8% scan accuracy" -- accuracy was never a
--                         tracked metric; a real transaction count is)
--   forecasts_generated  total AI forecast snapshots ever generated
--                         (replaces the fabricated "34% overstock reduction"
--                         -- that specific before/after isn't something this
--                         schema tracks in aggregate; forecast volume is)
--   avg_transfer_hours   average dispatched_at -> received_at gap across
--                         every completed inter-branch transfer; null until
--                         at least one exists (the frontend shows a plain
--                         placeholder rather than a fabricated number then)
--   branches_mapped_pct  % of active branches with a location pin set --
--                         genuinely real given this session's own branch
--                         geolocation feature, backs the new "Multi-Branch
--                         Organizations" feature's key metric
--
-- All aggregate-only, all identical in kind to the counts already exposed
-- here -- no row-level data, no per-branch or per-pharmacy breakdown.
-- ============================================================================

-- Postgres refuses to "create or replace" a function whose OUT-parameter
-- row shape changed (the original only returned 3 columns) -- it has to be
-- dropped first, same reasoning as every other "returns table(...) widened"
-- function elsewhere in this schema (see get_my_branch_details() below).
drop function if exists public.public_platform_stats();

create function public.public_platform_stats()
returns table(
  active_branches integer,
  tracked_skus integer,
  cities integer,
  revenue_today numeric,
  expiring_soon integer,
  sales_processed integer,
  forecasts_generated integer,
  avg_transfer_hours numeric,
  branches_mapped_pct numeric
)
language sql
stable
security definer
set search_path = ''
as $$
  select
    (select count(*)::integer from public.branches where status = 'active'),
    (select count(distinct pv.id)::integer
       from public.product_variants pv
       join public.stock_batches sb on sb.product_variant_id = pv.id),
    (select count(distinct upper(btrim(split_part(b.address, ',', 1))))::integer
       from public.branches b
       where b.status = 'active' and nullif(btrim(b.address), '') is not null),
    (select coalesce(sum(s.total_amount), 0)
       from public.sales s
       where s.sold_at >= date_trunc('day', now()) and s.sold_at < date_trunc('day', now()) + interval '1 day'),
    (select count(*)::integer
       from public.barcodes bc
       join public.stock_batches sb on sb.id = bc.stock_batch_id
       where bc.status = 'active' and bc.quantity_available > 0
         and sb.expiry_date between current_date and current_date + 30),
    (select count(*)::integer from public.sales),
    (select count(*)::integer from public.sales_forecast_snapshots),
    (select round((avg(extract(epoch from (t.received_at - t.dispatched_at))) / 3600.0)::numeric, 1)
       from public.stock_transfers t
       where t.dispatched_at is not null and t.received_at is not null),
    (select case when count(*) = 0 then null
       else round(100.0 * count(*) filter (where b.latitude is not null and b.longitude is not null) / count(*), 0)
       end
       from public.branches b where b.status = 'active')
$$;

revoke all on function public.public_platform_stats() from public;
grant execute on function public.public_platform_stats() to anon, authenticated;
