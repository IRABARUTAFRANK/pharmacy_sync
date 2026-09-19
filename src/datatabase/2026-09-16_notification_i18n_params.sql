-- ============================================================================
-- NOTIFICATION TRANSLATIONS -- every notification message this app
-- generates server-side (out-of-stock, expired writeoff, reorder point
-- missing, license expiring, restock recommendation, forecast completed,
-- product request approved/rejected, branch location missing) was always
-- written to public.notifications.message as a plain, pre-rendered ENGLISH
-- sentence via plpgsql's format() -- there is no way for plpgsql to call
-- this app's t(), so the notification bell/toast/Alerts page showed English
-- text no matter what language the viewer had selected. Unlike alert
-- TITLES (already translated -- see ALERT_SOURCE_TITLE_KEYS in
-- src/lib/alerts.ts, rendered from source_type via t() at display time),
-- the message BODY had no equivalent.
--
-- Fix: every function below still writes `message` (an English fallback,
-- kept for any code path that doesn't yet know about the new column, and so
-- a notification row is never NOT NULL-broken), but now ALSO writes a new
-- `params` jsonb column -- structured values (a product name, a barcode
-- code, a date, a quantity) instead of a pre-rendered sentence. The
-- frontend (src/lib/alerts.ts's resolveAlertMessage()) picks a translation
-- key from source_type (+ a `variant` field inside params, for source types
-- with more than one phrasing) and interpolates params into it via t(),
-- exactly like titleKey already does. A row with params = null (anything
-- created before this migration ran) simply falls back to its own frozen
-- `message` -- old notifications aren't retroactively translated, but every
-- new one going forward is.
--
-- Only redeclares the LATEST version of each function (confirmed by
-- grepping every dated file for later `create or replace` of the same
-- name) -- see this file's own comment on each function for where that
-- latest version actually lives, so this migration can be run any time
-- after all of those.
-- ============================================================================

alter table public.notifications add column if not exists params jsonb;


-- ============================================================================
-- out_of_stock -- latest version: 2026-09-11_view_branch_as_org_owner.sql
-- ============================================================================
create or replace function public.check_out_of_stock_alerts(p_branch_id uuid default null)
returns integer
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_branch uuid := public.effective_branch_id(p_branch_id);
  v_interval interval;
  v_created integer := 0;
  rec record;
  v_last record;
begin
  if v_branch is null then
    return 0;
  end if;

  select (out_of_stock_reminder_hours || ' hours')::interval into v_interval
    from public.branches where id = v_branch;

  for rec in
    select pv.id as variant_id, p.name as product_name, pv.dosage
    from public.stock_batches sb
    join public.product_variants pv on pv.id = sb.product_variant_id
    join public.products p on p.id = pv.product_id
    left join public.barcodes bc on bc.stock_batch_id = sb.id and bc.barcode_type = 'pack'
    where sb.branch_id = v_branch
    group by pv.id, p.name, pv.dosage
    having coalesce(sum(bc.quantity_available * bc.pieces_per_pack), 0) = 0
  loop
    select id, is_read, created_at into v_last
      from public.notifications
      where branch_id = v_branch and source_type = 'out_of_stock' and source_id = rec.variant_id
      order by created_at desc
      limit 1;

    if not found then
      insert into public.notifications (branch_id, source_type, source_id, message, params)
      values (
        v_branch, 'out_of_stock', rec.variant_id, format('%s is out of stock.', concat_ws(' ', rec.product_name, rec.dosage)),
        jsonb_build_object('variant', 'first', 'product', concat_ws(' ', rec.product_name, rec.dosage))
      );
      v_created := v_created + 1;
    elsif v_last.is_read and v_last.created_at < now() - v_interval then
      insert into public.notifications (branch_id, source_type, source_id, message, params)
      values (
        v_branch, 'out_of_stock', rec.variant_id, format('%s is still out of stock.', concat_ws(' ', rec.product_name, rec.dosage)),
        jsonb_build_object('variant', 'still', 'product', concat_ws(' ', rec.product_name, rec.dosage))
      );
      v_created := v_created + 1;
    end if;
  end loop;

  return v_created;
end;
$$;

revoke all on function public.check_out_of_stock_alerts(uuid) from public;
grant execute on function public.check_out_of_stock_alerts(uuid) to authenticated;


-- ============================================================================
-- stock_adjustment (expired writeoff) -- latest: 2026-09-11_view_branch_as_org_owner.sql
-- ============================================================================
create or replace function public.check_expired_stock(p_branch_id uuid default null)
returns integer
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_branch uuid := public.effective_branch_id(p_branch_id);
  v_user uuid := (select auth.uid());
  v_flagged integer := 0;
  rec record;
  v_adjustment uuid;
begin
  if v_branch is null then
    return 0;
  end if;

  for rec in
    select bc.id as barcode_id, bc.code, bc.quantity_available, bc.pieces_per_pack,
           sb.id as stock_batch_id, sb.expiry_date, p.name as product_name, pv.dosage
    from public.barcodes bc
    join public.stock_batches sb on sb.id = bc.stock_batch_id
    join public.product_variants pv on pv.id = sb.product_variant_id
    join public.products p on p.id = pv.product_id
    where sb.branch_id = v_branch
      and bc.status = 'active'
      and sb.expiry_date < current_date
    for update of bc
  loop
    update public.barcodes set status = 'expired' where id = rec.barcode_id;

    insert into public.stock_adjustments (stock_batch_id, barcode_id, adjustment_type, quantity, reason, performed_by)
    values (
      rec.stock_batch_id, rec.barcode_id, 'expired_writeoff',
      greatest(coalesce(rec.quantity_available, 0) * coalesce(rec.pieces_per_pack, 1), 1),
      format('Automatically written off -- batch expired on %s', rec.expiry_date),
      v_user
    )
    returning id into v_adjustment;

    insert into public.notifications (branch_id, source_type, source_id, message, params)
    values (
      v_branch, 'stock_adjustment', v_adjustment,
      format('Expired Writeoff: %s (%s) expired on %s and was automatically written off.',
        concat_ws(' ', rec.product_name, rec.dosage), rec.code, rec.expiry_date),
      jsonb_build_object(
        'variant', 'expired_writeoff', 'product', concat_ws(' ', rec.product_name, rec.dosage),
        'code', rec.code, 'date', rec.expiry_date::text
      )
    );

    v_flagged := v_flagged + 1;
  end loop;

  return v_flagged;
end;
$$;

revoke all on function public.check_expired_stock(uuid) from public;
grant execute on function public.check_expired_stock(uuid) to authenticated;


-- ============================================================================
-- stock_adjustment (manual, from the Stock Adjustment page) --
-- only ever declared once: pharmacy_schema_consolidated.sql
-- ============================================================================
create or replace function public.adjust_stock(p_stock_batch_id uuid, p_adjustment_type text, p_delta integer, p_reason text)
returns uuid
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_branch uuid := public.current_branch_id();
  v_user uuid := (select auth.uid());
  v_batch record;
  v_remaining integer;
  v_adjustment uuid;
begin
  if not exists (
    select 1 from public.users where id = v_user and is_active and role in ('owner', 'manager')
  ) then
    raise exception 'Only an active branch manager or owner may adjust stock';
  end if;
  if p_adjustment_type not in ('damage', 'loss', 'correction', 'return') then
    raise exception '% must reduce stock, not add it', p_adjustment_type;
  end if;
  if nullif(btrim(coalesce(p_reason, '')), '') is null then
    raise exception 'A reason is required for every stock adjustment';
  end if;

  select sb.id, p.name as product_name, pv.dosage,
         coalesce(sum(bc.quantity_available * bc.pieces_per_pack) filter (where bc.barcode_type = 'pack'), 0)::integer as pieces_available
    into v_batch
    from public.stock_batches sb
    join public.product_variants pv on pv.id = sb.product_variant_id
    join public.products p on p.id = pv.product_id
    left join public.barcodes bc on bc.stock_batch_id = sb.id
    where sb.id = p_stock_batch_id and sb.branch_id = v_branch
    group by sb.id, p.name, pv.dosage;

  if v_batch.id is null then
    raise exception 'Stock batch not found for this branch';
  end if;

  v_remaining := v_batch.pieces_available + p_delta;
  if v_remaining < 0 then
    raise exception 'Only % piece(s) available in this batch -- cannot remove %', v_batch.pieces_available, abs(p_delta);
  end if;

  insert into public.stock_adjustments (stock_batch_id, adjustment_type, quantity, reason, performed_by)
  values (p_stock_batch_id, p_adjustment_type, p_delta, btrim(p_reason), v_user)
  returning id into v_adjustment;

  insert into public.notifications (branch_id, source_type, source_id, message, params)
  values (
    v_branch, 'stock_adjustment', v_adjustment,
    format('%s: %s %s piece(s) of %s (%s)',
      initcap(p_adjustment_type), case when p_delta < 0 then 'removed' else 'added' end,
      abs(p_delta), concat_ws(' ', v_batch.product_name, v_batch.dosage), btrim(p_reason)),
    jsonb_build_object(
      'variant', 'manual', 'adjustmentType', p_adjustment_type,
      'delta', case when p_delta < 0 then 'removed' else 'added' end,
      'qty', abs(p_delta)::text, 'product', concat_ws(' ', v_batch.product_name, v_batch.dosage),
      'reason', btrim(p_reason)
    )
  );

  return v_adjustment;
end;
$$;

revoke all on function public.adjust_stock(uuid, text, integer, text) from public, anon;
grant execute on function public.adjust_stock(uuid, text, integer, text) to authenticated;


-- ============================================================================
-- license_expiring -- latest: 2026-09-11_view_branch_as_org_owner.sql
-- ============================================================================
create or replace function public.check_license_expiry(p_branch_id uuid default null)
returns integer
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_branch uuid := public.effective_branch_id(p_branch_id);
  v_expiry date;
  v_days_left integer;
  v_last record;
begin
  if v_branch is null then
    return 0;
  end if;

  select license_expiry_date into v_expiry from public.branches where id = v_branch;
  if v_expiry is null then
    return 0;
  end if;

  v_days_left := v_expiry - current_date;
  if v_days_left > 90 then
    return 0;
  end if;

  select id, is_read, created_at into v_last
    from public.notifications
    where branch_id = v_branch and source_type = 'license_expiring'
    order by created_at desc
    limit 1;

  if not found or (v_last.is_read and v_last.created_at < now() - interval '1 day') then
    insert into public.notifications (branch_id, source_type, source_id, message, params)
    values (
      v_branch, 'license_expiring', v_branch,
      case when v_days_left < 0
        then format('Pharmacy license expired %s day(s) ago (on %s). Renew as soon as possible.', abs(v_days_left), v_expiry)
        else format('Pharmacy license expires in %s day(s) (on %s).', v_days_left, v_expiry)
      end,
      jsonb_build_object(
        'variant', case when v_days_left < 0 then 'expired' else 'expiring' end,
        'days', abs(v_days_left)::text, 'date', v_expiry::text
      )
    );
    return 1;
  end if;

  return 0;
end;
$$;

revoke all on function public.check_license_expiry(uuid) from public, anon;
grant execute on function public.check_license_expiry(uuid) to authenticated;


-- ============================================================================
-- reorder_point_missing -- only ever declared once:
-- 2026-09-14_reorder_notifications_org_visibility.sql
-- ============================================================================
create or replace function public.check_missing_reorder_points()
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
    select distinct p.id as product_id, p.name as product_name
    from public.stock_batches sb
    join public.product_variants pv on pv.id = sb.product_variant_id
    join public.products p on p.id = pv.product_id
    where sb.branch_id = v_branch
      and not exists (
        select 1 from public.reorder_points rp
        where rp.product_id = p.id and rp.branch_id = v_branch
      )
  loop
    select id, is_read, created_at into v_last
      from public.notifications
      where branch_id = v_branch and source_type = 'reorder_point_missing' and source_id = rec.product_id
      order by created_at desc
      limit 1;

    if not found or (v_last.is_read and v_last.created_at < now() - interval '7 days') then
      insert into public.notifications (branch_id, source_type, source_id, message, params)
      values (
        v_branch, 'reorder_point_missing', rec.product_id,
        format('%s has no reorder point set for this branch -- set one so low-stock alerts work for it.', rec.product_name),
        jsonb_build_object('product', rec.product_name)
      );
      v_created := v_created + 1;
    end if;
  end loop;

  return v_created;
end;
$$;

revoke all on function public.check_missing_reorder_points() from public, anon;
grant execute on function public.check_missing_reorder_points() to authenticated;


-- ============================================================================
-- branch_location_missing -- latest: 2026-09-16_catch_up_full_state.sql --
-- no dynamic values, so no params object is even needed; the frontend
-- recognizes this source_type and translates its one fixed sentence
-- directly, same as it already does for titleKey.
-- ============================================================================
create or replace function public.check_missing_branch_location()
returns integer
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_branch uuid := public.current_branch_id();
  v_has_location boolean;
  v_is_active boolean;
  v_last record;
begin
  if v_branch is null then
    return 0;
  end if;

  select (b.latitude is not null and b.longitude is not null), b.status = 'active'
    into v_has_location, v_is_active
    from public.branches b where b.id = v_branch;

  if v_has_location or not v_is_active then
    return 0;
  end if;

  select id, is_read, created_at into v_last
    from public.notifications
    where branch_id = v_branch and source_type = 'branch_location_missing' and source_id = v_branch
    order by created_at desc
    limit 1;

  if not found or (v_last.is_read and v_last.created_at < now() - interval '7 days') then
    insert into public.notifications (branch_id, source_type, source_id, message, params)
    values (
      v_branch, 'branch_location_missing', v_branch,
      'Set this branch''s location in Branch Settings so nearby sibling branches can be found for stock transfer requests.',
      '{}'::jsonb
    );
    return 1;
  end if;

  return 0;
end;
$$;

revoke all on function public.check_missing_branch_location() from public, anon;
grant execute on function public.check_missing_branch_location() to authenticated;


-- ============================================================================
-- restock_recommendation -- latest: 2026-09-11_view_branch_as_org_owner.sql
-- ============================================================================
create or replace function public.check_restock_recommendations(p_branch_id uuid default null)
returns integer
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_branch uuid := public.effective_branch_id(p_branch_id);
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
      insert into public.notifications (branch_id, source_type, source_id, message, params)
      values (
        v_branch, 'restock_recommendation', rec.variant_id,
        format('%s is one of your best sellers (~%s/day) and will run out in about %s days at this pace -- restock soon.',
          concat_ws(' ', rec.product_name, rec.dosage), round(rec.avg_daily_qty, 1), round(rec.days_to_stockout)),
        jsonb_build_object(
          'product', concat_ws(' ', rec.product_name, rec.dosage),
          'avgDaily', round(rec.avg_daily_qty, 1)::text, 'days', round(rec.days_to_stockout)::text
        )
      );
      v_created := v_created + 1;
    end if;
  end loop;

  return v_created;
end;
$$;

revoke all on function public.check_restock_recommendations(uuid) from public;
grant execute on function public.check_restock_recommendations(uuid) to authenticated;


-- ============================================================================
-- forecast_completed -- latest: 2026-09-11_view_branch_as_org_owner.sql
-- ============================================================================
create or replace function public.check_forecast_accuracy_notifications(p_branch_id uuid default null)
returns integer
language plpgsql
security definer
set search_path = ''
as $$
#variable_conflict use_column
declare
  v_branch uuid := public.effective_branch_id(p_branch_id);
  v_count integer := 0;
  v_snap record;
  v_scope text;
  v_is_all boolean;
  v_actual numeric;
  v_pct text;
begin
  if v_branch is null then return 0; end if;

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
      continue;
    end if;

    v_is_all := v_snap.product_id is null and v_snap.category_id is null;
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

    insert into public.notifications (branch_id, source_type, source_id, message, params)
    values (
      v_branch, 'forecast_completed', v_snap.id,
      format(
        'Forecast for %s (made %s) has completed: predicted RWF %s, actual RWF %s (%s of predicted).',
        v_scope, to_char(v_snap.generated_at, 'YYYY-MM-DD'),
        to_char(v_snap.predicted_total, 'FM999,999,999'), to_char(v_actual, 'FM999,999,999'), v_pct
      ),
      jsonb_build_object(
        'variant', case when v_is_all then 'all' else 'scoped' end, 'scope', v_scope,
        'date', to_char(v_snap.generated_at, 'YYYY-MM-DD'),
        'predicted', to_char(v_snap.predicted_total, 'FM999,999,999'),
        'actual', to_char(v_actual, 'FM999,999,999'), 'pct', v_pct
      )
    );

    update public.sales_forecast_snapshots set notified_at = now() where id = v_snap.id;
    v_count := v_count + 1;
  end loop;

  return v_count;
end;
$$;

revoke all on function public.check_forecast_accuracy_notifications(uuid) from public;
grant execute on function public.check_forecast_accuracy_notifications(uuid) to authenticated;


-- ============================================================================
-- product_request_approved / product_request_rejected -- latest (final
-- redeclaration within pharmacy_schema_consolidated.sql, super-admin-only)
-- ============================================================================
create or replace function public.admin_approve_product_request(
  p_request_id uuid, p_product_name text, p_generic_name text, p_product_type text,
  p_tax_rate_id uuid, p_variants jsonb
)
returns table(product_id uuid, first_variant_id uuid)
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_req public.product_requests%rowtype;
  v_type text;
  v_product uuid;
  v_first_variant uuid;
  v_variant uuid;
  v_variant_json jsonb;
  v_is_first boolean := true;
begin
  perform public.assert_super_admin();

  select * into v_req from public.product_requests where id = p_request_id;
  if v_req.id is null then raise exception 'Product request not found'; end if;
  if v_req.status <> 'pending' then raise exception 'Only a pending request can be approved'; end if;
  if nullif(btrim(coalesce(p_product_name, '')), '') is null then raise exception 'A product name is required'; end if;
  if not exists (select 1 from public.tax_rates t where t.id = p_tax_rate_id) then
    raise exception 'Unknown tax rate';
  end if;
  if jsonb_typeof(p_variants) <> 'array' or jsonb_array_length(p_variants) = 0 then
    raise exception 'At least one variant (dosage/form/unit) is required';
  end if;

  v_type := coalesce(nullif(p_product_type, ''), 'medicine');
  if v_type not in ('medicine','supply','other') then v_type := 'other'; end if;

  select p.id into v_product from public.products p where lower(p.name) = lower(btrim(p_product_name));
  if v_product is null then
    insert into public.products (tax_rate_id, product_type, name, generic_name)
    values (p_tax_rate_id, v_type, btrim(p_product_name), nullif(btrim(coalesce(p_generic_name, '')), ''))
    returning id into v_product;
  else
    update public.products set tax_rate_id = p_tax_rate_id where id = v_product;
  end if;

  for v_variant_json in select * from jsonb_array_elements(p_variants) loop
    select pv.id into v_variant
    from public.product_variants pv
    where pv.product_id = v_product
      and coalesce(pv.dosage, '') = coalesce(nullif(btrim(coalesce(v_variant_json->>'dosage', '')), ''), '')
      and coalesce(pv.form, '') = coalesce(nullif(btrim(coalesce(v_variant_json->>'form', '')), ''), '')
    limit 1;

    if v_variant is null then
      insert into public.product_variants (product_id, dosage, form, unit)
      values (
        v_product,
        nullif(btrim(coalesce(v_variant_json->>'dosage', '')), ''),
        nullif(btrim(coalesce(v_variant_json->>'form', '')), ''),
        nullif(btrim(coalesce(v_variant_json->>'unit', '')), '')
      )
      returning id into v_variant;
    end if;

    if v_is_first then v_first_variant := v_variant; v_is_first := false; end if;
  end loop;

  update public.product_requests
  set status = 'approved', resolved_product_id = v_product, resolved_variant_id = v_first_variant,
      resolved_by = (select auth.uid()), resolved_at = now()
  where id = p_request_id;

  insert into public.notifications (branch_id, source_type, source_id, message, params)
  values (
    v_req.branch_id, 'product_request_approved', p_request_id,
    format('Your product request was approved: "%s" is now in the catalogue.', btrim(p_product_name)),
    jsonb_build_object('product', btrim(p_product_name))
  );

  return query select v_product, v_first_variant;
end;
$$;

revoke all on function public.admin_approve_product_request(uuid, text, text, text, uuid, jsonb) from public, anon;
grant execute on function public.admin_approve_product_request(uuid, text, text, text, uuid, jsonb) to authenticated;


create or replace function public.admin_reject_product_request(p_request_id uuid, p_reason text)
returns void
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_req public.product_requests%rowtype;
  v_reason text := nullif(btrim(coalesce(p_reason, '')), '');
begin
  perform public.assert_super_admin();
  select * into v_req from public.product_requests where id = p_request_id;
  if v_req.id is null then raise exception 'Product request not found'; end if;
  if v_req.status <> 'pending' then raise exception 'Only a pending request can be rejected'; end if;

  update public.product_requests
  set status = 'rejected', rejection_reason = v_reason,
      resolved_by = (select auth.uid()), resolved_at = now()
  where id = p_request_id;

  insert into public.notifications (branch_id, source_type, source_id, message, params)
  values (
    v_req.branch_id, 'product_request_rejected', p_request_id,
    format('Your product request was declined.%s', case when v_reason is not null then ' Reason: ' || v_reason else '' end),
    jsonb_build_object('reason', coalesce(v_reason, ''))
  );
end;
$$;

revoke all on function public.admin_reject_product_request(uuid, text) from public, anon;
grant execute on function public.admin_reject_product_request(uuid, text) to authenticated;
