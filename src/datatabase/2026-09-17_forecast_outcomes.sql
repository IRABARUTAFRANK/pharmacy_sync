-- ============================================================================
-- FORECAST OUTCOMES -- what a past forecast predicted vs what actually
-- happened, plus a data-grounded reason for the gap
-- ============================================================================
-- Run once, after every prior file in this directory. Idempotent.
--
-- check_forecast_accuracy_notifications() (2026-09-07_forecast_completed_
-- notifications.sql, extended in 2026-09-11_view_branch_as_org_owner.sql)
-- already does half of this: once a saved forecast snapshot's own predicted
-- horizon has fully elapsed, it fires a one-time "forecast_completed"
-- notification with predicted vs actual revenue. What was missing is a way
-- to SEE that track record as a list (not one notification at a time) and a
-- REASON for the gap, not just the two numbers -- both requested directly:
-- "as the user runs the forecast... after those specific days end, show the
-- prediction it made and how it actually went... and the reason why".
--
-- list_forecast_outcomes() below reuses that exact same period/actual-revenue
-- query (copied, not reinvented) and adds:
--   1. Every past forecast run for the branch, not just ones still pending
--      their one-time notification (notified_at is irrelevant here).
--   2. A `reason` -- correlates the gap against two signals already logged
--      for this branch during the forecast's own window: out_of_stock
--      notifications (a real, already-tracked demand-vs-supply signal) and
--      batch_recall/stock_adjustment notifications (real supply
--      disruptions). This is branch-wide, not narrowed to the forecast's own
--      product/category scope -- a stock-out or recall anywhere in the
--      branch is usually the actual cause of a deviation regardless of which
--      product was being forecast, and narrowing further would need a much
--      heavier per-product join for little real gain. No AI, no guessing --
--      every reason is traceable to a real logged event or an explicit
--      absence of one.
-- ============================================================================

create or replace function public.list_forecast_outcomes(p_branch_id uuid default null, p_limit integer default 20)
returns table(
  snapshot_id uuid, scope text, generated_at timestamptz, period_from date, period_to date,
  predicted_revenue numeric, actual_revenue numeric, accuracy_pct numeric, reason text
)
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_branch uuid := public.effective_branch_id(p_branch_id);
begin
  perform public.assert_owner_or_manager();
  if v_branch is null then raise exception 'No active branch for this session'; end if;
  if p_limit < 1 or p_limit > 100 then raise exception 'limit must be between 1 and 100'; end if;

  return query
  with snaps as (
    select
      s.id, s.product_id, s.category_id, s.generated_at, s.bucket,
      (select min((pt->>'period_start')::date) from jsonb_array_elements(s.points) pt) as period_from,
      (select max(
         case s.bucket
           when 'day' then (pt->>'period_start')::date + 1
           when 'week' then (pt->>'period_start')::date + 7
           else ((pt->>'period_start')::date + interval '1 month')::date
         end
       ) from jsonb_array_elements(s.points) pt) as period_to,
      (select coalesce(sum((pt->>'predicted_revenue')::numeric), 0) from jsonb_array_elements(s.points) pt) as predicted_total
    from public.sales_forecast_snapshots s
    where s.branch_id = v_branch
  )
  select
    snaps.id,
    coalesce(
      (select p.name::text from public.products p where p.id = snaps.product_id),
      (select c.name::text from public.product_categories c where c.id = snaps.category_id and c.branch_id = v_branch),
      'All products'
    ),
    snaps.generated_at, snaps.period_from, snaps.period_to,
    snaps.predicted_total, actual.total,
    case when snaps.predicted_total > 0 then round(100 * actual.total / snaps.predicted_total, 1) else null end,
    case
      when snaps.predicted_total <= 0 then null
      when actual.total >= snaps.predicted_total * 0.85 and actual.total <= snaps.predicted_total * 1.15
        then 'On target -- actual sales tracked closely with the trend-based forecast.'
      when actual.total < snaps.predicted_total * 0.85 and events.out_of_stock > 0 and events.disruption > 0
        then format('Came in below forecast -- %s out-of-stock alert(s) and %s stock adjustment/recall event(s) were logged for this branch during the period.', events.out_of_stock, events.disruption)
      when actual.total < snaps.predicted_total * 0.85 and events.out_of_stock > 0
        then format('Came in below forecast -- %s out-of-stock alert(s) were logged for this branch during the period, likely limiting sales.', events.out_of_stock)
      when actual.total < snaps.predicted_total * 0.85 and events.disruption > 0
        then format('Came in below forecast -- %s stock adjustment/recall event(s) were logged for this branch during the period.', events.disruption)
      when actual.total < snaps.predicted_total * 0.85
        then 'Came in below forecast -- no stock-outs or recalls were logged for this branch, so this likely reflects genuinely lower demand than the trend anticipated.'
      when actual.total > snaps.predicted_total * 1.15
        then 'Came in above forecast -- demand outpaced the trend-based projection for this period.'
      else 'Close to the forecast, with only a modest difference.'
    end
  from snaps
  cross join lateral (
    select coalesce(sum(si.unit_price * si.quantity), 0) as total
    from public.sale_items si
    join public.sales s2 on s2.id = si.sale_id
    join public.barcodes bc on bc.id = si.barcode_id
    join public.stock_batches sb on sb.id = bc.stock_batch_id
    join public.product_variants pv on pv.id = sb.product_variant_id
    left join public.branch_product_categorization cat on cat.product_id = pv.product_id and cat.branch_id = v_branch
    where s2.branch_id = v_branch
      and s2.sold_at >= snaps.period_from::timestamptz
      and s2.sold_at < snaps.period_to::timestamptz
      and (snaps.product_id is null or pv.product_id = snaps.product_id)
      and (snaps.category_id is null or cat.category_id = snaps.category_id)
  ) actual
  cross join lateral (
    select
      count(*) filter (where n.source_type = 'out_of_stock') as out_of_stock,
      count(*) filter (where n.source_type in ('batch_recall', 'stock_adjustment')) as disruption
    from public.notifications n
    where n.branch_id = v_branch
      and n.created_at >= snaps.period_from::timestamptz
      and n.created_at < snaps.period_to::timestamptz
  ) events
  where snaps.period_to is not null and snaps.period_to <= current_date
  order by snaps.generated_at desc
  limit p_limit;
end;
$$;

revoke all on function public.list_forecast_outcomes(uuid, integer) from public, anon;
grant execute on function public.list_forecast_outcomes(uuid, integer) to authenticated;
