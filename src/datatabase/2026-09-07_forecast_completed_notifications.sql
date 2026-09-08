-- ============================================================================
-- FORECAST-COMPLETED NOTIFICATIONS
-- ============================================================================
-- Once every period a saved forecast (sales_forecast_snapshots, see
-- 2026-09-07_sales_forecast_accuracy.sql) predicted has actually elapsed,
-- surface it as a real notification -- same public.notifications table and
-- check-then-insert idempotent pattern already used by
-- check_out_of_stock_alerts()/check_expired_stock()/check_license_expiry()
-- in lib/alerts.ts, not a separate notification system.
--
-- notified_at on the snapshot itself is the de-dup guard (mirroring how
-- out-of-stock reuses "is_read + a cooldown" for ITS de-dup) -- once a
-- snapshot has been notified about, it's never picked up again by this
-- function, even though its points stay in the table forever for the
-- accuracy chart (ai_sales_forecast_accuracy) to keep reading.
--
-- Run this once in the Supabase SQL editor (or via the CLI) against the
-- project's database. Safe to re-run: ALTER ... ADD COLUMN IF NOT EXISTS /
-- CREATE OR REPLACE FUNCTION.
-- ============================================================================

alter table public.sales_forecast_snapshots add column if not exists notified_at timestamptz;

-- Widen the notifications source_type list once more (same incremental-ALTER
-- pattern already used for out_of_stock, license_expiring, etc.).
alter table public.notifications drop constraint if exists notifications_source_type_check;
alter table public.notifications add constraint notifications_source_type_check
  check (source_type in ('batch_recall','stock_adjustment','product_request_approved','product_request_rejected','out_of_stock','license_expiring','forecast_completed'));

create or replace function public.check_forecast_accuracy_notifications()
returns integer
language plpgsql
security definer
set search_path = ''
as $$
#variable_conflict use_column
declare
  v_branch uuid := public.current_branch_id();
  v_count integer := 0;
  v_snap record;
  v_scope text;
  v_actual numeric;
  v_pct text;
begin
  if v_branch is null then return 0; end if;

  -- One pass per not-yet-notified snapshot whose entire predicted horizon
  -- has fully elapsed (period_to <= today) -- period_to is the end of the
  -- LAST bucket it predicted, computed from its own bucket size so a
  -- monthly point starting Sept 1 isn't considered "finished" until Oct 1.
  for v_snap in
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
    where s.branch_id = v_branch and s.notified_at is null
  loop
    if v_snap.period_to is null or v_snap.period_to > current_date then
      continue; -- horizon hasn't fully elapsed yet -- leave it for a later poll
    end if;

    v_scope := case
      when v_snap.product_id is not null then (select p.name from public.products p where p.id = v_snap.product_id)
      when v_snap.category_id is not null then (select c.name from public.product_categories c where c.id = v_snap.category_id and c.branch_id = v_branch)
      else 'All products'
    end;
    v_scope := coalesce(v_scope, 'All products');

    select coalesce(sum(si.unit_price * si.quantity), 0)
      into v_actual
      from public.sale_items si
      join public.sales s2 on s2.id = si.sale_id
      join public.barcodes bc on bc.id = si.barcode_id
      join public.stock_batches sb on sb.id = bc.stock_batch_id
      join public.product_variants pv on pv.id = sb.product_variant_id
      left join public.branch_product_categorization cat on cat.product_id = pv.product_id and cat.branch_id = v_branch
      where s2.branch_id = v_branch
        and s2.sold_at >= v_snap.period_from::timestamptz
        and s2.sold_at < v_snap.period_to::timestamptz
        and (v_snap.product_id is null or pv.product_id = v_snap.product_id)
        and (v_snap.category_id is null or cat.category_id = v_snap.category_id);

    v_pct := case when v_snap.predicted_total > 0
      then round(100 * v_actual / v_snap.predicted_total)::text || '%'
      else 'n/a'
    end;

    insert into public.notifications (branch_id, source_type, source_id, message)
    values (
      v_branch, 'forecast_completed', v_snap.id,
      format(
        'Forecast for %s (made %s) has completed: predicted RWF %s, actual RWF %s (%s of predicted).',
        v_scope, to_char(v_snap.generated_at, 'YYYY-MM-DD'),
        to_char(v_snap.predicted_total, 'FM999,999,999'), to_char(v_actual, 'FM999,999,999'), v_pct
      )
    );

    update public.sales_forecast_snapshots set notified_at = now() where id = v_snap.id;
    v_count := v_count + 1;
  end loop;

  return v_count;
end;
$$;

revoke all on function public.check_forecast_accuracy_notifications() from public, anon;
grant execute on function public.check_forecast_accuracy_notifications() to authenticated;
