-- ============================================================================
-- VELOCITY-AWARE RESTOCK RECOMMENDATIONS
-- ============================================================================
-- The existing low-stock check (check_out_of_stock_alerts / ai_stock_status)
-- only compares current stock against a manually-set reorder point
-- (reorder_points.min_quantity) -- it has no idea which products are
-- actually best-sellers or how fast they're moving. A product with a
-- generous min_quantity that suddenly starts flying off the shelf gets no
-- warning until it's already at zero.
--
-- This adds a second, independent signal: for each product, how many units
-- per day it has actually been selling recently (last 30 days, requiring
-- sales on at least 3 distinct days so a single one-off sale can't trigger
-- it), divided into how many units are on hand right now. If that's 14 days
-- or fewer, it's about to run out at the current pace -- regardless of
-- whether anyone ever configured a reorder point for it.
--
-- Two functions, following the exact pattern of check_out_of_stock_alerts()
-- and ai_top_products()/ai_sales_forecast() already in this schema:
--
--   1. check_restock_recommendations() -- security definer, callable by any
--      authenticated branch user (same as check_out_of_stock_alerts /
--      check_expired_stock), writes public.notifications rows. Meant to be
--      polled every 30s from the client alongside those two, so it's the
--      "repetitive" piece -- it runs on its own, no cron needed. Same
--      anti-spam rule as check_out_of_stock_alerts: only re-fire once the
--      previous notification for that product was read and is >24h old.
--
--   2. ai_restock_recommendations(...) -- read-only, owner/manager gated
--      (assert_owner_or_manager, same as ai_top_products), parameterized,
--      for the Analytics & Forecasting page's "Best Sellers at Risk" chart.
--      No notifications written here.
--
-- Run this once in the Supabase SQL editor (or via the CLI) against the
-- project's database. Safe to re-run: CREATE OR REPLACE.
-- ============================================================================

create or replace function public.check_restock_recommendations()
returns integer
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_branch uuid := public.current_branch_id();
  v_created integer := 0;
  rec record;
  v_last record;
begin
  if v_branch is null then
    return 0;
  end if;

  for rec in
    with recent_sales as (
      select
        pv.id as variant_id,
        sum(si.quantity)::numeric / 30 as avg_daily_qty,
        count(distinct date_trunc('day', s.sold_at)) as active_days
      from public.sale_items si
      join public.sales s on s.id = si.sale_id
      join public.barcodes bc on bc.id = si.barcode_id
      join public.stock_batches sb on sb.id = bc.stock_batch_id
      join public.product_variants pv on pv.id = sb.product_variant_id
      where s.branch_id = v_branch and s.sold_at >= now() - interval '30 days'
      group by pv.id
      having count(distinct date_trunc('day', s.sold_at)) >= 3
    ),
    stock as (
      select
        pv.id as variant_id, p.name as product_name, pv.dosage,
        coalesce(sum(bc.quantity_available * bc.pieces_per_pack) filter (where bc.barcode_type = 'pack'), 0)::integer as qty_available
      from public.stock_batches sb
      join public.product_variants pv on pv.id = sb.product_variant_id
      join public.products p on p.id = pv.product_id
      left join public.barcodes bc on bc.stock_batch_id = sb.id
      where sb.branch_id = v_branch
      group by pv.id, p.name, pv.dosage
    )
    select
      rs.variant_id, st.product_name, st.dosage, rs.avg_daily_qty, st.qty_available,
      (st.qty_available / rs.avg_daily_qty) as days_to_stockout
    from recent_sales rs
    join stock st on st.variant_id = rs.variant_id
    where rs.avg_daily_qty > 0 and st.qty_available > 0
      and st.qty_available / rs.avg_daily_qty <= 14
  loop
    select id, is_read, created_at into v_last
      from public.notifications
      where branch_id = v_branch and source_type = 'restock_recommendation' and source_id = rec.variant_id
      order by created_at desc
      limit 1;

    if not found or (v_last.is_read and v_last.created_at < now() - interval '24 hours') then
      insert into public.notifications (branch_id, source_type, source_id, message)
      values (
        v_branch, 'restock_recommendation', rec.variant_id,
        format('%s is one of your best sellers (~%s/day) and will run out in about %s days at this pace -- restock soon.',
          concat_ws(' ', rec.product_name, rec.dosage), round(rec.avg_daily_qty, 1), round(rec.days_to_stockout))
      );
      v_created := v_created + 1;
    end if;
  end loop;

  return v_created;
end;
$$;

revoke all on function public.check_restock_recommendations() from public;
grant execute on function public.check_restock_recommendations() to authenticated;

create or replace function public.ai_restock_recommendations(
  p_days_history integer default 30,
  p_horizon_days integer default 14,
  p_limit integer default 10
)
returns table(
  product_id uuid, product_name text, dosage text,
  avg_daily_quantity numeric, quantity_available integer, days_to_stockout numeric
)
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_branch uuid := public.current_branch_id();
begin
  perform public.assert_owner_or_manager();
  if v_branch is null then raise exception 'No active branch for this session'; end if;
  if p_days_history < 7 or p_days_history > 365 then raise exception 'days_history must be between 7 and 365'; end if;
  if p_horizon_days < 1 or p_horizon_days > 90 then raise exception 'horizon_days must be between 1 and 90'; end if;
  if p_limit < 1 or p_limit > 50 then raise exception 'limit must be between 1 and 50'; end if;

  return query
  with recent_sales as (
    select
      pv.product_id as product_id,
      pv.id as variant_id,
      sum(si.quantity)::numeric / p_days_history as avg_daily_qty,
      sum(si.quantity) as total_qty,
      count(distinct date_trunc('day', s.sold_at)) as active_days
    from public.sale_items si
    join public.sales s on s.id = si.sale_id
    join public.barcodes bc on bc.id = si.barcode_id
    join public.stock_batches sb on sb.id = bc.stock_batch_id
    join public.product_variants pv on pv.id = sb.product_variant_id
    where s.branch_id = v_branch and s.sold_at >= now() - (p_days_history || ' days')::interval
    group by pv.product_id, pv.id
    having count(distinct date_trunc('day', s.sold_at)) >= 3
  ),
  stock as (
    select
      pv.id as variant_id, p.id as product_id, p.name as product_name, pv.dosage,
      coalesce(sum(bc.quantity_available * bc.pieces_per_pack) filter (where bc.barcode_type = 'pack'), 0)::integer as qty_available
    from public.stock_batches sb
    join public.product_variants pv on pv.id = sb.product_variant_id
    join public.products p on p.id = pv.product_id
    left join public.barcodes bc on bc.stock_batch_id = sb.id
    where sb.branch_id = v_branch
    group by pv.id, p.id, p.name, pv.dosage
  )
  select
    st.product_id, st.product_name::text, st.dosage::text,
    round(rs.avg_daily_qty, 2), st.qty_available, round(st.qty_available / rs.avg_daily_qty, 1)
  from recent_sales rs
  join stock st on st.variant_id = rs.variant_id
  where rs.avg_daily_qty > 0 and st.qty_available > 0
    and st.qty_available / rs.avg_daily_qty <= p_horizon_days
  order by rs.total_qty desc, (st.qty_available / rs.avg_daily_qty) asc
  limit p_limit;
end;
$$;

revoke all on function public.ai_restock_recommendations(integer, integer, integer) from public, anon;
grant execute on function public.ai_restock_recommendations(integer, integer, integer) to authenticated;
