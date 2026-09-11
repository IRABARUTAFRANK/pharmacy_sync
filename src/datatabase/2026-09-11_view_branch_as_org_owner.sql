-- ============================================================================
-- VIEW BRANCH AS ORG OWNER — read-path (batch 1) + single-owner safeguard
-- ============================================================================
-- Lets an org_owner/org_manager drill into one specific branch's own
-- operational dashboard (Overview, Inventory, Analytics, Alerts, Patients,
-- Insurance, Compliance, Transactions/History, forecasting) from
-- Organization > Branches, instead of only ever seeing their own branch.
-- Every function below already resolved "which branch" via
-- public.current_branch_id() (the caller's own users.branch_id) with no way
-- to override it -- this migration appends an optional trailing p_branch_id
-- parameter to each and swaps that resolution for public.effective_branch_id
-- (p_branch_id), defined in SECTION 1. Passing no p_branch_id (or explicit
-- null) reproduces today's exact behavior.
--
-- This file only covers READ paths. Write paths (complete_sale,
-- receive_stock_delivery, create_branch_discount, create_branch_category,
-- update_branch_category, etc.) are a separate migration.
--
-- Every function's body below is copied verbatim from its live definition
-- (checked against pharmacy_schema_consolidated.sql and every dated file
-- layered on top of it through 2026-09-10) except for: (a) the added
-- p_branch_id parameter, (b) the current_branch_id() -> effective_branch_id
-- (p_branch_id) swap, and (c) forwarding p_branch_id into any nested call to
-- another function this file also converts (only ai_branch_snapshot's three
-- calls into ai_stock_status() need this -- see SECTION 3).
--
-- Run this once in the Supabase SQL editor (or via the CLI), after every
-- prior migration in this directory. Idempotent -- safe to re-run.
-- ============================================================================


-- ============================================================================
-- SECTION 1 — effective_branch_id() helper
-- ============================================================================
-- p_branch_id NULL preserves today's exact behavior (your own branch, via
-- current_branch_id()); a non-null value is only honored if the caller is an
-- active member of the organization that branch belongs to (assert_org_member
-- also checks the caller's own users.is_active, so a deactivated org member
-- is refused here exactly like everywhere else in the org schema).
create or replace function public.effective_branch_id(p_branch_id uuid)
returns uuid
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  v_org_id uuid;
begin
  if p_branch_id is null then
    return public.current_branch_id();
  end if;

  select organization_id into v_org_id from public.branches where id = p_branch_id;
  if v_org_id is null then
    raise exception 'Unknown branch';
  end if;

  perform public.assert_org_member(v_org_id);
  return p_branch_id;
end;
$$;

revoke all on function public.effective_branch_id(uuid) from public, anon;
grant execute on function public.effective_branch_id(uuid) to authenticated;


-- ============================================================================
-- SECTION 2 — single-owner-per-organization safeguard
-- ============================================================================
-- Defense-in-depth mirroring the existing users_one_owner_per_branch index.
-- No code path currently grants a second org_owner for the same organization:
-- register_first_branch() is the only inserter of an org_owner row, and
-- transfer_organization_ownership() does an atomic demote-then-promote (never
-- an insert) and was already revoked from `authenticated` after a real
-- incident (2026-09-10_remove_ownership_transfer.sql). This index makes it
-- impossible at the data layer too, regardless of any future code path.
create unique index if not exists organization_members_one_owner_per_org
  on public.organization_members (organization_id)
  where role = 'org_owner';


-- ============================================================================
-- SECTION 3 — read-path branch functions (view-as-org-owner)
-- ============================================================================

-- source: pharmacy_schema_consolidated.sql (support_tickets is branch-owned)
drop function if exists public.list_my_support_tickets();
create or replace function public.list_my_support_tickets(p_branch_id uuid default null)
returns table(id uuid, subject text, description text, status text, priority text, created_at timestamptz)
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  v_branch uuid := public.effective_branch_id(p_branch_id);
begin
  if v_branch is null then raise exception 'Only an active branch user may view tickets'; end if;
  return query
    select t.id, t.subject::text, t.description, t.status::text, t.priority::text, t.created_at
    from public.support_tickets t
    where t.branch_id = v_branch
    order by t.created_at desc;
end;
$$;

revoke all on function public.list_my_support_tickets(uuid) from public;
grant execute on function public.list_my_support_tickets(uuid) to authenticated;


-- source: pharmacy_schema_consolidated.sql (final redeclaration)
drop function if exists public.check_out_of_stock_alerts();
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
      insert into public.notifications (branch_id, source_type, source_id, message)
      values (v_branch, 'out_of_stock', rec.variant_id, format('%s is out of stock.', concat_ws(' ', rec.product_name, rec.dosage)));
      v_created := v_created + 1;
    elsif v_last.is_read and v_last.created_at < now() - v_interval then
      insert into public.notifications (branch_id, source_type, source_id, message)
      values (v_branch, 'out_of_stock', rec.variant_id, format('%s is still out of stock.', concat_ws(' ', rec.product_name, rec.dosage)));
      v_created := v_created + 1;
    end if;
  end loop;

  return v_created;
end;
$$;

revoke all on function public.check_out_of_stock_alerts(uuid) from public;
grant execute on function public.check_out_of_stock_alerts(uuid) to authenticated;


-- source: pharmacy_schema_consolidated.sql
drop function if exists public.list_stock_adjustments();
create or replace function public.list_stock_adjustments(p_branch_id uuid default null)
returns table(
  id uuid, adjustment_type text, quantity integer, reason text, adjusted_at timestamptz,
  product_name text, dosage text, batch_number text, performed_by_name text
)
language sql
stable
security definer
set search_path = ''
as $$
  select
    sa.id, sa.adjustment_type, sa.quantity, sa.reason, sa.adjusted_at,
    p.name, pv.dosage, sb.batch_number, u.full_name
  from public.stock_adjustments sa
  join public.stock_batches sb on sb.id = sa.stock_batch_id
  join public.product_variants pv on pv.id = sb.product_variant_id
  join public.products p on p.id = pv.product_id
  left join public.users u on u.id = sa.performed_by
  where sb.branch_id = public.effective_branch_id(p_branch_id)
  order by sa.adjusted_at desc
  limit 200
$$;

revoke all on function public.list_stock_adjustments(uuid) from public, anon;
grant execute on function public.list_stock_adjustments(uuid) to authenticated;


-- source: pharmacy_schema_consolidated.sql (final redeclaration -- includes phone/tin)
drop function if exists public.find_patient_by_identifier(text);
create or replace function public.find_patient_by_identifier(p_identifier text, p_branch_id uuid default null)
returns table(id uuid, full_name text, gender text, age integer, tin_or_phone text, phone text, tin text)
language sql
stable
security definer
set search_path = ''
as $$
  select p.id, p.full_name::text, p.gender::text, p.age,
         p.tin_or_phone::text, p.phone::text, p.tin::text
  from public.patients p
  where p.branch_id = public.effective_branch_id(p_branch_id)
    and (p.tin_or_phone = btrim(p_identifier)
      or p.phone        = btrim(p_identifier)
      or p.tin          = btrim(p_identifier))
  limit 1
$$;

revoke all on function public.find_patient_by_identifier(text, uuid) from public, anon;
grant execute on function public.find_patient_by_identifier(text, uuid) to authenticated;


-- source: pharmacy_schema_consolidated.sql (final redeclaration -- includes phone/tin)
drop function if exists public.list_branch_patients();
create or replace function public.list_branch_patients(p_branch_id uuid default null)
returns table(
  id uuid, full_name text, gender text, age integer, tin_or_phone text,
  phone text, tin text, visit_count integer, last_visit_at timestamptz, lifetime_spend numeric
)
language sql
stable
security definer
set search_path = ''
as $$
  select
    p.id, p.full_name::text, p.gender::text, p.age, p.tin_or_phone::text,
    p.phone::text, p.tin::text,
    count(s.id)::integer, max(s.sold_at), coalesce(sum(s.total_amount), 0)
  from public.patients p
  left join public.sales s on s.patient_id = p.id
  where p.branch_id = public.effective_branch_id(p_branch_id)
  group by p.id, p.full_name, p.gender, p.age, p.tin_or_phone, p.phone, p.tin
  order by max(s.sold_at) desc nulls last, p.full_name
$$;

revoke all on function public.list_branch_patients(uuid) from public, anon;
grant execute on function public.list_branch_patients(uuid) to authenticated;


-- source: pharmacy_schema_consolidated.sql (final redeclaration, full column list)
drop function if exists public.get_my_branch_details();
create or replace function public.get_my_branch_details(p_branch_id uuid default null)
returns table(
  name text, address text, phone text, tin text, logo_path text, bank_account_number text, bank_account_name text, momo_pay_number text,
  out_of_stock_reminder_hours integer, branch_code text, status text, created_at timestamptz,
  email text, website text, license_number text, license_expiry_date date, ebm_device_serial text, default_language text,
  receipt_number_prefix text, pos_cash_enabled boolean, pos_mtn_momo_enabled boolean, pos_airtel_money_enabled boolean,
  pos_card_enabled boolean, pos_insurance_enabled boolean, pos_default_payment_method text,
  pos_require_patient_name boolean, pos_allow_discounts boolean, pos_show_patient_history boolean,
  expiry_alert_threshold_days integer, default_reorder_min integer
)
language sql
stable
security definer
set search_path = ''
as $$
  select b.name::text, b.address, b.phone, b.tin, b.logo_path, b.bank_account_number, b.bank_account_name, b.momo_pay_number,
         b.out_of_stock_reminder_hours, b.branch_code::text, b.status::text, b.created_at,
         b.email, b.website, b.license_number, b.license_expiry_date, b.ebm_device_serial, b.default_language::text,
         b.receipt_number_prefix::text, b.pos_cash_enabled, b.pos_mtn_momo_enabled, b.pos_airtel_money_enabled,
         b.pos_card_enabled, b.pos_insurance_enabled, b.pos_default_payment_method::text,
         b.pos_require_patient_name, b.pos_allow_discounts, b.pos_show_patient_history,
         b.expiry_alert_threshold_days, b.default_reorder_min
  from public.branches b
  where b.id = public.effective_branch_id(p_branch_id)
$$;

revoke all on function public.get_my_branch_details(uuid) from public, anon;
grant execute on function public.get_my_branch_details(uuid) to authenticated;


-- source: pharmacy_schema_consolidated.sql
drop function if exists public.check_expired_stock();
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

    insert into public.notifications (branch_id, source_type, source_id, message)
    values (
      v_branch, 'stock_adjustment', v_adjustment,
      format('Expired Writeoff: %s (%s) expired on %s and was automatically written off.',
        concat_ws(' ', rec.product_name, rec.dosage), rec.code, rec.expiry_date)
    );

    v_flagged := v_flagged + 1;
  end loop;

  return v_flagged;
end;
$$;

revoke all on function public.check_expired_stock(uuid) from public;
grant execute on function public.check_expired_stock(uuid) to authenticated;


-- source: pharmacy_schema_consolidated.sql
drop function if exists public.check_license_expiry();
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
    insert into public.notifications (branch_id, source_type, source_id, message)
    values (
      v_branch, 'license_expiring', v_branch,
      case when v_days_left < 0
        then format('Pharmacy license expired %s day(s) ago (on %s). Renew as soon as possible.', abs(v_days_left), v_expiry)
        else format('Pharmacy license expires in %s day(s) (on %s).', v_days_left, v_expiry)
      end
    );
    return 1;
  end if;

  return 0;
end;
$$;

revoke all on function public.check_license_expiry(uuid) from public, anon;
grant execute on function public.check_license_expiry(uuid) to authenticated;


-- source: pharmacy_schema_consolidated.sql
drop function if exists public.list_branch_discounts();
create or replace function public.list_branch_discounts(p_branch_id uuid default null)
returns table(id uuid, name text, discount_type text, value numeric, valid_from date, valid_to date, is_current boolean)
language sql
stable
security definer
set search_path = ''
as $$
  select d.id, d.name::text, d.discount_type::text, d.value, d.valid_from, d.valid_to,
    (d.valid_from is null or d.valid_from <= current_date) and (d.valid_to is null or d.valid_to >= current_date)
  from public.discounts d
  where d.branch_id is null or d.branch_id = public.effective_branch_id(p_branch_id) or public.is_super_admin()
  order by d.name
$$;

revoke all on function public.list_branch_discounts(uuid) from public, anon;
grant execute on function public.list_branch_discounts(uuid) to authenticated;


-- source: pharmacy_schema_consolidated.sql
-- Owner-only, same as before -- effective_branch_id() only widens WHICH
-- branch's history an org_owner/org_manager can ask for, not who else can.
drop function if exists public.list_branch_history(timestamptz, timestamptz);
create or replace function public.list_branch_history(p_from timestamptz default null, p_to timestamptz default null, p_branch_id uuid default null)
returns table(
  event_at timestamptz, category text, amount numeric, actor_name text, status text, meta jsonb
)
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_branch uuid;
begin
  if p_branch_id is null then
    select u.branch_id into v_branch
    from public.users u
    where u.id = (select auth.uid()) and u.is_active and u.role = 'owner';
  else
    v_branch := public.effective_branch_id(p_branch_id);
  end if;
  if v_branch is null then
    raise exception 'Only the branch owner may view the full history';
  end if;

  -- title/description text is NOT built here -- it's built client-side from
  -- this raw meta data, so the History page can render it in the viewer's
  -- chosen language (see src/pages/HistoryPage.tsx eventText()).
  return query
  select s.sold_at, 'sale'::text, s.total_amount, u1.full_name::text, null::text,
    jsonb_build_object('receiptNumber', r.receipt_number, 'itemCount', si.cnt, 'patientName', p.full_name)
  from public.sales s
  join public.receipts r on r.sale_id = s.id
  left join public.patients p on p.id = s.patient_id
  left join public.users u1 on u1.id = s.cashier_id
  join lateral (select count(*) cnt from public.sale_items si2 where si2.sale_id = s.id) si on true
  where s.branch_id = v_branch and (p_from is null or s.sold_at >= p_from) and (p_to is null or s.sold_at <= p_to)

  union all

  select sa.adjusted_at, 'stock_adjustment'::text, null::numeric, u2.full_name::text, sa.adjustment_type::text,
    jsonb_build_object('quantity', sa.quantity, 'productName', concat_ws(' ', pr1.name, pv1.dosage), 'reason', sa.reason)
  from public.stock_adjustments sa
  join public.stock_batches sb1 on sb1.id = sa.stock_batch_id
  join public.product_variants pv1 on pv1.id = sb1.product_variant_id
  join public.products pr1 on pr1.id = pv1.product_id
  left join public.users u2 on u2.id = sa.performed_by
  where sb1.branch_id = v_branch and (p_from is null or sa.adjusted_at >= p_from) and (p_to is null or sa.adjusted_at <= p_to)

  union all

  select sb3.received_at, 'stock_batch'::text, (sb3.quantity_received * sb3.cost_price), u7.full_name::text, null::text,
    jsonb_build_object('productName', concat_ws(' ', pr3.name, pv3.dosage), 'batchNumber', sb3.batch_number, 'quantityReceived', sb3.quantity_received)
  from public.stock_batches sb3
  join public.product_variants pv3 on pv3.id = sb3.product_variant_id
  join public.products pr3 on pr3.id = pv3.product_id
  left join public.users u7 on u7.id = sb3.logged_by
  where sb3.branch_id = v_branch and (p_from is null or sb3.received_at >= p_from) and (p_to is null or sb3.received_at <= p_to)

  union all

  select ic.submitted_at, 'insurance_claim'::text, ic.claim_amount, null::text, ic.status::text,
    jsonb_build_object('providerName', ip.name, 'coveragePercentage', ic.coverage_percentage_applied)
  from public.insurance_claims ic
  join public.sales s2 on s2.id = ic.sale_id
  join public.insurance_providers ip on ip.id = ic.insurance_provider_id
  where s2.branch_id = v_branch and (p_from is null or ic.submitted_at >= p_from) and (p_to is null or ic.submitted_at <= p_to)

  union all

  select pt.created_at, 'patient'::text, null::numeric, u4.full_name::text, null::text,
    jsonb_build_object('patientName', pt.full_name, 'tinOrPhone', pt.tin_or_phone)
  from public.patients pt
  left join public.users u4 on u4.id = pt.created_by
  where pt.branch_id = v_branch and (p_from is null or pt.created_at >= p_from) and (p_to is null or pt.created_at <= p_to)

  union all

  select pq.created_at, 'product_request'::text, null::numeric, u5.full_name::text, pq.status::text,
    jsonb_build_object('message', left(pq.message, 140))
  from public.product_requests pq
  left join public.users u5 on u5.id = pq.requested_by
  where pq.branch_id = v_branch and (p_from is null or pq.created_at >= p_from) and (p_to is null or pq.created_at <= p_to)

  union all

  select us.created_at, 'staff'::text, null::numeric, null::text, null::text,
    jsonb_build_object('staffName', us.full_name, 'email', us.email)
  from public.users us
  where us.branch_id = v_branch and us.role = 'seller' and (p_from is null or us.created_at >= p_from) and (p_to is null or us.created_at <= p_to)

  union all

  select br.recalled_at, 'batch_recall'::text, null::numeric, u6.full_name::text, 'recalled'::text,
    jsonb_build_object('productName', concat_ws(' ', pr2.name, pv2.dosage), 'batchNumber', br.batch_number, 'manufacturerName', br.manufacturer_name, 'reason', br.reason)
  from public.batch_recalls br
  join public.product_variants pv2 on pv2.id = br.product_variant_id
  join public.products pr2 on pr2.id = pv2.product_id
  left join public.users u6 on u6.id = br.recalled_by
  where exists (
    select 1 from public.stock_batches sb2
    where sb2.product_variant_id = br.product_variant_id and sb2.batch_number = br.batch_number and sb2.branch_id = v_branch
  ) and (p_from is null or br.recalled_at >= p_from) and (p_to is null or br.recalled_at <= p_to)

  union all

  select b.created_at, 'barcode_created'::text, null::numeric, null::text, b.status::text,
    jsonb_build_object('barcodeType', b.barcode_type, 'code', b.code, 'codeSource', b.code_source)
  from public.barcodes b
  join public.stock_batches sb4 on sb4.id = b.stock_batch_id
  where sb4.branch_id = v_branch and (p_from is null or b.created_at >= p_from) and (p_to is null or b.created_at <= p_to)

  union all

  select n.created_at, 'notification'::text, null::numeric, null::text, (case when n.is_read then 'read' else 'unread' end)::text,
    jsonb_build_object('sourceType', n.source_type, 'message', n.message)
  from public.notifications n
  where n.branch_id = v_branch and (p_from is null or n.created_at >= p_from) and (p_to is null or n.created_at <= p_to)

  union all

  select st.created_at, 'support_ticket'::text, null::numeric, u8.full_name::text, st.status::text,
    jsonb_build_object('subject', st.subject)
  from public.support_tickets st
  left join public.users u8 on u8.id = st.raised_by
  where st.branch_id = v_branch and (p_from is null or st.created_at >= p_from) and (p_to is null or st.created_at <= p_to)

  order by 1 desc
  limit 2000;
end;
$$;

revoke all on function public.list_branch_history(timestamptz, timestamptz, uuid) from public, anon;
grant execute on function public.list_branch_history(timestamptz, timestamptz, uuid) to authenticated;


-- ── AI analyst tools ─────────────────────────────────────────────────────────
-- NOTE: ai_branch_snapshot() calls ai_stock_status() three times internally
-- (out/low/expiring counts) -- those calls now forward p_branch_id too, so
-- the counts reflect the SAME branch ai_branch_snapshot itself resolved, not
-- whatever ai_stock_status's own default (the caller's own branch) would be.

-- source: pharmacy_schema_consolidated.sql
drop function if exists public.ai_branch_snapshot();
create or replace function public.ai_branch_snapshot(p_branch_id uuid default null)
returns table(
  branch_name text, today_revenue numeric, week_to_date_revenue numeric, month_to_date_revenue numeric,
  active_product_count integer, out_of_stock_count integer, low_stock_count integer, expiring_soon_count integer,
  pending_product_requests integer, unread_alerts integer
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

  return query
  select
    b.name::text,
    coalesce((select round(sum(si.unit_price * si.quantity), 2) from public.sale_items si join public.sales s on s.id = si.sale_id where s.branch_id = v_branch and s.sold_at >= date_trunc('day', now())), 0),
    coalesce((select round(sum(si.unit_price * si.quantity), 2) from public.sale_items si join public.sales s on s.id = si.sale_id where s.branch_id = v_branch and s.sold_at >= date_trunc('week', now())), 0),
    coalesce((select round(sum(si.unit_price * si.quantity), 2) from public.sale_items si join public.sales s on s.id = si.sale_id where s.branch_id = v_branch and s.sold_at >= date_trunc('month', now())), 0),
    (select count(distinct pv.product_id) from public.stock_batches sb join public.product_variants pv on pv.id = sb.product_variant_id where sb.branch_id = v_branch)::integer,
    (select count(*) from public.ai_stock_status('out', p_branch_id))::integer,
    (select count(*) from public.ai_stock_status('low', p_branch_id))::integer,
    (select count(*) from public.ai_stock_status('expiring', p_branch_id))::integer,
    (select count(*) from public.product_requests pr where pr.branch_id = v_branch and pr.status = 'pending')::integer,
    (select count(*) from public.notifications n where n.branch_id = v_branch and not n.is_read)::integer
  from public.branches b where b.id = v_branch;
end;
$$;

revoke all on function public.ai_branch_snapshot(uuid) from public, anon;
grant execute on function public.ai_branch_snapshot(uuid) to authenticated;


-- source: pharmacy_schema_consolidated.sql
drop function if exists public.ai_sales_trend(date, date, text);
create or replace function public.ai_sales_trend(p_from date, p_to date, p_bucket text default 'day', p_branch_id uuid default null)
returns table(period_start date, revenue numeric, tax numeric, insurance_covered numeric, patient_owed numeric, transaction_count integer)
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_branch uuid := public.effective_branch_id(p_branch_id);
begin
  perform public.assert_owner_or_manager();
  if v_branch is null then raise exception 'No active branch for this session'; end if;
  if p_bucket not in ('day','week','month') then raise exception 'bucket must be day, week or month'; end if;

  return query
  select
    date_trunc(p_bucket, s.sold_at)::date,
    round(sum(si.unit_price * si.quantity), 2),
    round(sum((si.unit_price * si.quantity) - si.subtotal), 2),
    round(sum(si.insurance_covered_amount), 2),
    round(sum((si.unit_price * si.quantity) - si.insurance_covered_amount), 2),
    count(distinct s.id)::integer
  from public.sales s
  join public.sale_items si on si.sale_id = s.id
  where s.branch_id = v_branch and s.sold_at >= p_from::timestamptz and s.sold_at < (p_to + 1)::timestamptz
  group by 1
  order by 1;
end;
$$;

revoke all on function public.ai_sales_trend(date, date, text, uuid) from public, anon;
grant execute on function public.ai_sales_trend(date, date, text, uuid) to authenticated;


-- source: pharmacy_schema_consolidated.sql
drop function if exists public.ai_top_products(date, date, text, text, integer);
create or replace function public.ai_top_products(
  p_from date, p_to date, p_metric text default 'revenue', p_direction text default 'desc', p_limit integer default 10, p_branch_id uuid default null
)
returns table(product_id uuid, product_name text, dosage text, quantity_sold numeric, revenue numeric)
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_branch uuid := public.effective_branch_id(p_branch_id);
begin
  perform public.assert_owner_or_manager();
  if v_branch is null then raise exception 'No active branch for this session'; end if;
  if p_metric not in ('revenue','quantity') then raise exception 'metric must be revenue or quantity'; end if;
  if p_direction not in ('asc','desc') then raise exception 'direction must be asc or desc'; end if;
  if p_limit < 1 or p_limit > 50 then raise exception 'limit must be between 1 and 50'; end if;

  return query
  select
    p.id, p.name::text, pv.dosage::text, sum(si.quantity)::numeric, round(sum(si.unit_price * si.quantity), 2)
  from public.sale_items si
  join public.sales s on s.id = si.sale_id
  join public.barcodes bc on bc.id = si.barcode_id
  join public.stock_batches sb on sb.id = bc.stock_batch_id
  join public.product_variants pv on pv.id = sb.product_variant_id
  join public.products p on p.id = pv.product_id
  where s.branch_id = v_branch and s.sold_at >= p_from::timestamptz and s.sold_at < (p_to + 1)::timestamptz
  group by p.id, p.name, pv.id, pv.dosage
  order by (case when p_metric = 'revenue' then sum(si.unit_price * si.quantity) else sum(si.quantity) end) * (case when p_direction = 'asc' then 1 else -1 end)
  limit p_limit;
end;
$$;

revoke all on function public.ai_top_products(date, date, text, text, integer, uuid) from public, anon;
grant execute on function public.ai_top_products(date, date, text, text, integer, uuid) to authenticated;


-- source: pharmacy_schema_consolidated.sql
drop function if exists public.ai_category_breakdown(date, date);
create or replace function public.ai_category_breakdown(p_from date, p_to date, p_branch_id uuid default null)
returns table(category_name text, revenue numeric, quantity_sold numeric)
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_branch uuid := public.effective_branch_id(p_branch_id);
begin
  perform public.assert_owner_or_manager();
  if v_branch is null then raise exception 'No active branch for this session'; end if;

  return query
  select
    coalesce(c.name::text, 'Uncategorized'), round(sum(si.unit_price * si.quantity), 2), sum(si.quantity)::numeric
  from public.sale_items si
  join public.sales s on s.id = si.sale_id
  join public.barcodes bc on bc.id = si.barcode_id
  join public.stock_batches sb on sb.id = bc.stock_batch_id
  join public.product_variants pv on pv.id = sb.product_variant_id
  left join public.branch_product_categorization cat on cat.product_id = pv.product_id and cat.branch_id = v_branch
  left join public.product_categories c on c.id = cat.category_id
  where s.branch_id = v_branch and s.sold_at >= p_from::timestamptz and s.sold_at < (p_to + 1)::timestamptz
  group by c.name
  order by 2 desc;
end;
$$;

revoke all on function public.ai_category_breakdown(date, date, uuid) from public, anon;
grant execute on function public.ai_category_breakdown(date, date, uuid) to authenticated;


-- source: pharmacy_schema_consolidated.sql (final redeclaration -- branch's own threshold/default)
drop function if exists public.ai_stock_status(text);
create or replace function public.ai_stock_status(p_filter text default 'all', p_branch_id uuid default null)
returns table(product_name text, dosage text, quantity_available integer, min_quantity integer, expiry_date date, days_to_expiry integer, status text)
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_branch uuid := public.effective_branch_id(p_branch_id);
  v_expiry_threshold integer;
  v_default_reorder_min integer;
begin
  perform public.assert_owner_or_manager();
  if v_branch is null then raise exception 'No active branch for this session'; end if;
  if p_filter not in ('low','out','expiring','expired','all') then raise exception 'filter must be low, out, expiring, expired or all'; end if;

  select b.expiry_alert_threshold_days, b.default_reorder_min
    into v_expiry_threshold, v_default_reorder_min
    from public.branches b where b.id = v_branch;

  return query
  with stock as (
    select
      p.name::text as product_name, pv.dosage::text as dosage,
      coalesce(sum(bc.quantity_available * bc.pieces_per_pack) filter (where bc.barcode_type = 'pack'), 0)::integer as qty_available,
      coalesce(rp.min_quantity, v_default_reorder_min) as min_quantity,
      min(sb.expiry_date) filter (where bc.status = 'active') as nearest_expiry
    from public.stock_batches sb
    join public.product_variants pv on pv.id = sb.product_variant_id
    join public.products p on p.id = pv.product_id
    left join public.barcodes bc on bc.stock_batch_id = sb.id
    left join public.reorder_points rp on rp.product_id = pv.product_id and rp.branch_id = v_branch
    where sb.branch_id = v_branch
    group by p.name, pv.id, pv.dosage, rp.min_quantity
  )
  select
    stock.product_name, stock.dosage, stock.qty_available, stock.min_quantity, stock.nearest_expiry,
    (stock.nearest_expiry - current_date)::integer,
    case
      when stock.qty_available = 0 then 'out'
      when stock.nearest_expiry is not null and stock.nearest_expiry < current_date then 'expired'
      when stock.nearest_expiry is not null and stock.nearest_expiry <= current_date + v_expiry_threshold then 'expiring'
      when stock.qty_available < stock.min_quantity then 'low'
      else 'ok'
    end
  from stock
  where p_filter = 'all'
    or (p_filter = 'out' and stock.qty_available = 0)
    or (p_filter = 'low' and stock.qty_available > 0 and stock.qty_available < stock.min_quantity)
    or (p_filter = 'expiring' and stock.nearest_expiry is not null and stock.nearest_expiry between current_date and current_date + v_expiry_threshold)
    or (p_filter = 'expired' and stock.nearest_expiry is not null and stock.nearest_expiry < current_date)
  order by stock.qty_available asc
  limit 200;
end;
$$;

revoke all on function public.ai_stock_status(text, uuid) from public, anon;
grant execute on function public.ai_stock_status(text, uuid) to authenticated;


-- source: pharmacy_schema_consolidated.sql
drop function if exists public.ai_sales_forecast(uuid, uuid, integer, integer);
create or replace function public.ai_sales_forecast(
  p_product_id uuid default null,
  p_category_id uuid default null,
  p_days_history integer default 90,
  p_horizon_days integer default 30,
  p_branch_id uuid default null
)
returns table(
  scope text, days_of_history integer, avg_daily_quantity numeric, trend_per_day numeric,
  projected_quantity_next_period numeric, projected_revenue_next_period numeric
)
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_branch uuid := public.effective_branch_id(p_branch_id);
  v_scope text;
begin
  perform public.assert_owner_or_manager();
  if v_branch is null then raise exception 'No active branch for this session'; end if;
  if p_product_id is not null and p_category_id is not null then
    raise exception 'Pass product_id or category_id, not both';
  end if;
  if p_days_history < 7 or p_days_history > 730 then raise exception 'days_history must be between 7 and 730'; end if;
  if p_horizon_days < 1 or p_horizon_days > 365 then raise exception 'horizon_days must be between 1 and 365'; end if;

  if p_product_id is not null then
    select p.name into v_scope from public.products p where p.id = p_product_id;
    if v_scope is null then raise exception 'Unknown product'; end if;
  elsif p_category_id is not null then
    select c.name into v_scope from public.product_categories c where c.id = p_category_id and c.branch_id = v_branch;
    if v_scope is null then raise exception 'Unknown category for this branch'; end if;
  else
    v_scope := 'All products';
  end if;

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
  numbered as (
    select
      (sale_day - (select min(sale_day) from daily))::numeric as x,
      qty::numeric as y,
      revenue
    from daily
  ),
  stats as (
    select
      coalesce(avg(y), 0) as avg_qty,
      coalesce(regr_slope(y, x), 0)::numeric as slope,
      coalesce(regr_intercept(y, x), avg(y), 0)::numeric as intercept,
      coalesce(sum(revenue) / nullif(sum(y), 0), 0) as avg_unit_revenue,
      coalesce(max(x), 0) as max_x
    from numbered
  )
  select
    v_scope,
    p_days_history,
    round(stats.avg_qty, 2),
    round(stats.slope, 4),
    round(sum_projected.total_qty, 2),
    round(sum_projected.total_qty * stats.avg_unit_revenue, 2)
  from stats
  cross join lateral (
    select coalesce(sum(greatest(0, stats.intercept + stats.slope * (stats.max_x + d))), 0) as total_qty
    from generate_series(1, p_horizon_days) as d
  ) sum_projected;
end;
$$;

revoke all on function public.ai_sales_forecast(uuid, uuid, integer, integer, uuid) from public, anon;
grant execute on function public.ai_sales_forecast(uuid, uuid, integer, integer, uuid) to authenticated;


-- source: pharmacy_schema_consolidated.sql
drop function if exists public.ai_insurance_summary(date, date);
create or replace function public.ai_insurance_summary(p_from date, p_to date, p_branch_id uuid default null)
returns table(provider_name text, claim_count integer, total_claimed numeric, paid_out numeric, pending numeric)
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_branch uuid := public.effective_branch_id(p_branch_id);
begin
  perform public.assert_owner_or_manager();
  if v_branch is null then raise exception 'No active branch for this session'; end if;

  return query
  select
    ip.name::text,
    count(*)::integer,
    round(sum(ic.claim_amount), 2),
    round(coalesce(sum(ic.claim_amount) filter (where ic.status = 'paid'), 0), 2),
    round(coalesce(sum(ic.claim_amount) filter (where ic.status in ('submitted','approved')), 0), 2)
  from public.insurance_claims ic
  join public.sales s on s.id = ic.sale_id
  join public.insurance_providers ip on ip.id = ic.insurance_provider_id
  where s.branch_id = v_branch and ic.submitted_at >= p_from::timestamptz and ic.submitted_at < (p_to + 1)::timestamptz
  group by ip.name
  order by 3 desc;
end;
$$;

revoke all on function public.ai_insurance_summary(date, date, uuid) from public, anon;
grant execute on function public.ai_insurance_summary(date, date, uuid) to authenticated;


-- source: pharmacy_schema_consolidated.sql
drop function if exists public.ai_seller_performance(date, date);
create or replace function public.ai_seller_performance(p_from date, p_to date, p_branch_id uuid default null)
returns table(seller_name text, seller_role text, transaction_count integer, revenue numeric)
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_branch uuid := public.effective_branch_id(p_branch_id);
begin
  perform public.assert_owner_or_manager();
  if v_branch is null then raise exception 'No active branch for this session'; end if;

  return query
  select u.full_name::text, u.role::text, count(distinct s.id)::integer, round(sum(si.unit_price * si.quantity), 2)
  from public.sale_items si
  join public.sales s on s.id = si.sale_id
  join public.users u on u.id = s.cashier_id
  where s.branch_id = v_branch and s.sold_at >= p_from::timestamptz and s.sold_at < (p_to + 1)::timestamptz
  group by u.id, u.full_name, u.role
  order by 4 desc;
end;
$$;

revoke all on function public.ai_seller_performance(date, date, uuid) from public, anon;
grant execute on function public.ai_seller_performance(date, date, uuid) to authenticated;


-- source: pharmacy_schema_consolidated.sql
drop function if exists public.ai_patient_summary(date, date);
create or replace function public.ai_patient_summary(p_from date, p_to date, p_branch_id uuid default null)
returns table(total_patients_served integer, new_patients integer, repeat_patients integer, top_patient_name text, top_patient_spend numeric)
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_branch uuid := public.effective_branch_id(p_branch_id);
begin
  perform public.assert_owner_or_manager();
  if v_branch is null then raise exception 'No active branch for this session'; end if;

  return query
  with visits as (
    select s.patient_id, count(*) as visit_count, sum(si.unit_price * si.quantity) as spend
    from public.sales s
    join public.sale_items si on si.sale_id = s.id
    where s.branch_id = v_branch and s.patient_id is not null
      and s.sold_at >= p_from::timestamptz and s.sold_at < (p_to + 1)::timestamptz
    group by s.patient_id
  ),
  top as (
    select pt.full_name::text as full_name, v.spend from visits v
    join public.patients pt on pt.id = v.patient_id
    order by v.spend desc limit 1
  )
  select
    (select count(*) from visits)::integer,
    (select count(*) from public.patients pt where pt.branch_id = v_branch and pt.created_at >= p_from::timestamptz and pt.created_at < (p_to + 1)::timestamptz)::integer,
    (select count(*) from visits where visit_count > 1)::integer,
    (select top.full_name from top),
    (select round(top.spend, 2) from top);
end;
$$;

revoke all on function public.ai_patient_summary(date, date, uuid) from public, anon;
grant execute on function public.ai_patient_summary(date, date, uuid) to authenticated;


-- ── Analytics page ───────────────────────────────────────────────────────────

-- source: pharmacy_schema_consolidated.sql
drop function if exists public.analytics_stock_adjustments(date, date);
create or replace function public.analytics_stock_adjustments(p_from date, p_to date, p_branch_id uuid default null)
returns table(adjustment_type text, staff_name text, quantity numeric, adjustment_count integer, estimated_value numeric)
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_branch uuid := public.effective_branch_id(p_branch_id);
begin
  perform public.assert_owner_or_manager();
  if v_branch is null then raise exception 'No active branch for this session'; end if;

  return query
  select
    sa.adjustment_type::text,
    coalesce(u.full_name::text, 'System'),
    sum(sa.quantity)::numeric,
    count(*)::integer,
    round(sum(sa.quantity * coalesce(sb.cost_price, 0)), 2)
  from public.stock_adjustments sa
  join public.stock_batches sb on sb.id = sa.stock_batch_id
  left join public.users u on u.id = sa.performed_by
  where sb.branch_id = v_branch and sa.adjusted_at >= p_from::timestamptz and sa.adjusted_at < (p_to + 1)::timestamptz
  group by sa.adjustment_type, u.full_name
  order by 5 desc;
end;
$$;

revoke all on function public.analytics_stock_adjustments(date, date, uuid) from public, anon;
grant execute on function public.analytics_stock_adjustments(date, date, uuid) to authenticated;


-- source: pharmacy_schema_consolidated.sql
drop function if exists public.analytics_dead_stock(integer, integer);
create or replace function public.analytics_dead_stock(p_days integer default 60, p_limit integer default 50, p_branch_id uuid default null)
returns table(product_name text, dosage text, quantity_on_hand integer, stock_value numeric, days_since_last_sale integer)
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_branch uuid := public.effective_branch_id(p_branch_id);
begin
  perform public.assert_owner_or_manager();
  if v_branch is null then raise exception 'No active branch for this session'; end if;
  if p_days < 1 or p_days > 730 then raise exception 'days must be between 1 and 730'; end if;

  return query
  with onhand as (
    select
      pv.id as variant_id, p.name as product_name, pv.dosage as dosage,
      sum(bc.quantity_available * bc.pieces_per_pack) filter (where bc.barcode_type = 'pack') as qty,
      sum(bc.quantity_available * bc.pieces_per_pack * coalesce(sb.cost_price, 0)) filter (where bc.barcode_type = 'pack') as value
    from public.stock_batches sb
    join public.product_variants pv on pv.id = sb.product_variant_id
    join public.products p on p.id = pv.product_id
    left join public.barcodes bc on bc.stock_batch_id = sb.id
    where sb.branch_id = v_branch
    group by pv.id, p.name, pv.dosage
  ),
  last_sale as (
    select pv.id as variant_id, max(s.sold_at) as last_sold_at
    from public.sale_items si
    join public.sales s on s.id = si.sale_id
    join public.barcodes bc on bc.id = si.barcode_id
    join public.stock_batches sb on sb.id = bc.stock_batch_id
    join public.product_variants pv on pv.id = sb.product_variant_id
    where s.branch_id = v_branch
    group by pv.id
  )
  select
    onhand.product_name::text, onhand.dosage::text,
    coalesce(onhand.qty, 0)::integer, round(coalesce(onhand.value, 0), 2),
    case when last_sale.last_sold_at is null then null else (current_date - last_sale.last_sold_at::date)::integer end
  from onhand
  left join last_sale on last_sale.variant_id = onhand.variant_id
  where coalesce(onhand.qty, 0) > 0
    and (last_sale.last_sold_at is null or last_sale.last_sold_at < now() - (p_days || ' days')::interval)
  order by round(coalesce(onhand.value, 0), 2) desc
  limit p_limit;
end;
$$;

revoke all on function public.analytics_dead_stock(integer, integer, uuid) from public, anon;
grant execute on function public.analytics_dead_stock(integer, integer, uuid) to authenticated;


-- source: pharmacy_schema_consolidated.sql
drop function if exists public.analytics_inventory_turnover(date, date);
create or replace function public.analytics_inventory_turnover(p_from date, p_to date, p_branch_id uuid default null)
returns table(category_name text, cogs numeric, current_inventory_value numeric, turnover_ratio numeric)
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_branch uuid := public.effective_branch_id(p_branch_id);
begin
  perform public.assert_owner_or_manager();
  if v_branch is null then raise exception 'No active branch for this session'; end if;

  return query
  with cogs_by_cat as (
    select
      coalesce(c.name, 'Uncategorized') as category_name,
      sum(si.quantity * coalesce(sb.cost_price, 0)) as cogs
    from public.sale_items si
    join public.sales s on s.id = si.sale_id
    join public.barcodes bc on bc.id = si.barcode_id
    join public.stock_batches sb on sb.id = bc.stock_batch_id
    join public.product_variants pv on pv.id = sb.product_variant_id
    left join public.branch_product_categorization cat on cat.product_id = pv.product_id and cat.branch_id = v_branch
    left join public.product_categories c on c.id = cat.category_id
    where s.branch_id = v_branch and s.sold_at >= p_from::timestamptz and s.sold_at < (p_to + 1)::timestamptz
    group by c.name
  ),
  value_by_cat as (
    select
      coalesce(c.name, 'Uncategorized') as category_name,
      sum(bc.quantity_available * bc.pieces_per_pack * coalesce(sb.cost_price, 0)) filter (where bc.barcode_type = 'pack') as value
    from public.stock_batches sb
    join public.product_variants pv on pv.id = sb.product_variant_id
    left join public.branch_product_categorization cat on cat.product_id = pv.product_id and cat.branch_id = v_branch
    left join public.product_categories c on c.id = cat.category_id
    left join public.barcodes bc on bc.stock_batch_id = sb.id
    where sb.branch_id = v_branch
    group by c.name
  )
  select
    coalesce(cogs_by_cat.category_name, value_by_cat.category_name)::text,
    round(coalesce(cogs_by_cat.cogs, 0), 2),
    round(coalesce(value_by_cat.value, 0), 2),
    round(coalesce(cogs_by_cat.cogs, 0) / nullif(coalesce(value_by_cat.value, 0), 0), 2)
  from cogs_by_cat
  full outer join value_by_cat on value_by_cat.category_name = cogs_by_cat.category_name
  order by 2 desc nulls last;
end;
$$;

revoke all on function public.analytics_inventory_turnover(date, date, uuid) from public, anon;
grant execute on function public.analytics_inventory_turnover(date, date, uuid) to authenticated;


-- source: pharmacy_schema_consolidated.sql
drop function if exists public.analytics_supplier_performance(date, date);
create or replace function public.analytics_supplier_performance(p_from date, p_to date, p_branch_id uuid default null)
returns table(supplier_name text, delivery_count integer, units_received numeric, total_cost numeric, avg_unit_cost numeric)
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_branch uuid := public.effective_branch_id(p_branch_id);
begin
  perform public.assert_owner_or_manager();
  if v_branch is null then raise exception 'No active branch for this session'; end if;

  return query
  select
    coalesce(sup.supplier_name, 'Unknown supplier')::text,
    count(*)::integer,
    sum(sb.quantity_received)::numeric,
    round(sum(sb.quantity_received * coalesce(sb.cost_price, 0)), 2),
    round(sum(sb.quantity_received * coalesce(sb.cost_price, 0)) / nullif(sum(sb.quantity_received), 0), 2)
  from public.stock_batches sb
  left join public.suppliers sup on sup.id = sb.supplier_id
  where sb.branch_id = v_branch and sb.received_at >= p_from::timestamptz and sb.received_at < (p_to + 1)::timestamptz
  group by sup.supplier_name
  order by 4 desc;
end;
$$;

revoke all on function public.analytics_supplier_performance(date, date, uuid) from public, anon;
grant execute on function public.analytics_supplier_performance(date, date, uuid) to authenticated;


-- source: pharmacy_schema_consolidated.sql
drop function if exists public.analytics_sales_heatmap(date, date);
create or replace function public.analytics_sales_heatmap(p_from date, p_to date, p_branch_id uuid default null)
returns table(day_of_week integer, hour_of_day integer, revenue numeric, transaction_count integer)
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_branch uuid := public.effective_branch_id(p_branch_id);
begin
  perform public.assert_owner_or_manager();
  if v_branch is null then raise exception 'No active branch for this session'; end if;

  return query
  with per_sale as (
    select s.id, s.sold_at, sum(si.unit_price * si.quantity) as sale_revenue
    from public.sales s
    join public.sale_items si on si.sale_id = s.id
    where s.branch_id = v_branch and s.sold_at >= p_from::timestamptz and s.sold_at < (p_to + 1)::timestamptz
    group by s.id, s.sold_at
  )
  select
    extract(dow from sold_at)::integer, extract(hour from sold_at)::integer,
    round(sum(sale_revenue), 2), count(*)::integer
  from per_sale
  group by 1, 2
  order by 1, 2;
end;
$$;

revoke all on function public.analytics_sales_heatmap(date, date, uuid) from public, anon;
grant execute on function public.analytics_sales_heatmap(date, date, uuid) to authenticated;


-- source: pharmacy_schema_consolidated.sql
drop function if exists public.analytics_basket_size(date, date, text);
create or replace function public.analytics_basket_size(p_from date, p_to date, p_bucket text default 'day', p_branch_id uuid default null)
returns table(period_start date, avg_items_per_sale numeric, avg_revenue_per_sale numeric, transaction_count integer)
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_branch uuid := public.effective_branch_id(p_branch_id);
begin
  perform public.assert_owner_or_manager();
  if v_branch is null then raise exception 'No active branch for this session'; end if;
  if p_bucket not in ('day','week','month') then raise exception 'bucket must be day, week or month'; end if;

  return query
  with per_sale as (
    select s.id, date_trunc(p_bucket, s.sold_at)::date as period, sum(si.quantity) as items, sum(si.unit_price * si.quantity) as revenue
    from public.sales s
    join public.sale_items si on si.sale_id = s.id
    where s.branch_id = v_branch and s.sold_at >= p_from::timestamptz and s.sold_at < (p_to + 1)::timestamptz
    group by s.id, period
  )
  select period, round(avg(items), 2), round(avg(revenue), 2), count(*)::integer
  from per_sale
  group by period
  order by period;
end;
$$;

revoke all on function public.analytics_basket_size(date, date, text, uuid) from public, anon;
grant execute on function public.analytics_basket_size(date, date, text, uuid) to authenticated;


-- source: pharmacy_schema_consolidated.sql
drop function if exists public.analytics_discount_usage(date, date);
create or replace function public.analytics_discount_usage(p_from date, p_to date, p_branch_id uuid default null)
returns table(discount_name text, discount_type text, usage_count integer, revenue_with_discount numeric, estimated_discount_value numeric)
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_branch uuid := public.effective_branch_id(p_branch_id);
begin
  perform public.assert_owner_or_manager();
  if v_branch is null then raise exception 'No active branch for this session'; end if;

  return query
  with per_sale as (
    select s.id as sale_id, s.discount_id, sum(si.unit_price * si.quantity) as sale_revenue
    from public.sales s
    join public.sale_items si on si.sale_id = s.id
    where s.branch_id = v_branch and s.discount_id is not null
      and s.sold_at >= p_from::timestamptz and s.sold_at < (p_to + 1)::timestamptz
    group by s.id, s.discount_id
  )
  select
    d.name::text, d.discount_type::text, count(*)::integer, round(sum(ps.sale_revenue), 2),
    round(sum(case when d.discount_type = 'percentage' then ps.sale_revenue * (d.value / 100.0) else least(d.value, ps.sale_revenue) end), 2)
  from per_sale ps
  join public.discounts d on d.id = ps.discount_id
  group by d.id, d.name, d.discount_type
  order by 4 desc;
end;
$$;

revoke all on function public.analytics_discount_usage(date, date, uuid) from public, anon;
grant execute on function public.analytics_discount_usage(date, date, uuid) to authenticated;


-- source: pharmacy_schema_consolidated.sql
drop function if exists public.analytics_insurance_claim_aging();
create or replace function public.analytics_insurance_claim_aging(p_branch_id uuid default null)
returns table(age_bucket text, claim_count integer, total_amount numeric)
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_branch uuid := public.effective_branch_id(p_branch_id);
begin
  perform public.assert_owner_or_manager();
  if v_branch is null then raise exception 'No active branch for this session'; end if;

  return query
  select
    case
      when (current_date - ic.submitted_at::date) <= 7 then '0-7 days'
      when (current_date - ic.submitted_at::date) <= 14 then '8-14 days'
      when (current_date - ic.submitted_at::date) <= 30 then '15-30 days'
      else '31+ days'
    end,
    count(*)::integer,
    round(sum(ic.claim_amount), 2)
  from public.insurance_claims ic
  join public.sales s on s.id = ic.sale_id
  where s.branch_id = v_branch and ic.status in ('submitted','approved')
  group by 1
  order by min(case
    when (current_date - ic.submitted_at::date) <= 7 then 0
    when (current_date - ic.submitted_at::date) <= 14 then 1
    when (current_date - ic.submitted_at::date) <= 30 then 2
    else 3
  end);
end;
$$;

revoke all on function public.analytics_insurance_claim_aging(uuid) from public, anon;
grant execute on function public.analytics_insurance_claim_aging(uuid) to authenticated;


-- source: pharmacy_schema_consolidated.sql
drop function if exists public.analytics_insurance_provider_comparison(date, date);
create or replace function public.analytics_insurance_provider_comparison(p_from date, p_to date, p_branch_id uuid default null)
returns table(provider_name text, claim_count integer, approved_count integer, approval_rate numeric, avg_claim_amount numeric, avg_coverage_percentage numeric)
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_branch uuid := public.effective_branch_id(p_branch_id);
begin
  perform public.assert_owner_or_manager();
  if v_branch is null then raise exception 'No active branch for this session'; end if;

  return query
  select
    ip.name::text,
    count(*)::integer,
    count(*) filter (where ic.status in ('approved','paid'))::integer,
    round(100.0 * count(*) filter (where ic.status in ('approved','paid')) / nullif(count(*), 0), 1),
    round(avg(ic.claim_amount), 2),
    round(avg(ic.coverage_percentage_applied), 1)
  from public.insurance_claims ic
  join public.sales s on s.id = ic.sale_id
  join public.insurance_providers ip on ip.id = ic.insurance_provider_id
  where s.branch_id = v_branch and ic.submitted_at >= p_from::timestamptz and ic.submitted_at < (p_to + 1)::timestamptz
  group by ip.name
  order by 2 desc;
end;
$$;

revoke all on function public.analytics_insurance_provider_comparison(date, date, uuid) from public, anon;
grant execute on function public.analytics_insurance_provider_comparison(date, date, uuid) to authenticated;


-- source: pharmacy_schema_consolidated.sql
drop function if exists public.analytics_seller_productivity(date, date);
create or replace function public.analytics_seller_productivity(p_from date, p_to date, p_branch_id uuid default null)
returns table(seller_name text, seller_role text, transaction_count integer, revenue numeric, active_hours numeric, revenue_per_hour numeric, transactions_per_hour numeric)
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_branch uuid := public.effective_branch_id(p_branch_id);
begin
  perform public.assert_owner_or_manager();
  if v_branch is null then raise exception 'No active branch for this session'; end if;

  return query
  with daily as (
    select s.cashier_id, date_trunc('day', s.sold_at) as sale_day,
      extract(epoch from (max(s.sold_at) - min(s.sold_at))) / 3600.0 as hours,
      count(*) as txns
    from public.sales s
    where s.branch_id = v_branch and s.sold_at >= p_from::timestamptz and s.sold_at < (p_to + 1)::timestamptz
    group by s.cashier_id, date_trunc('day', s.sold_at)
  ),
  per_seller as (
    select cashier_id, sum(hours) as active_hours, sum(txns) as txn_count
    from daily
    group by cashier_id
  ),
  seller_revenue as (
    select s.cashier_id, sum(si.unit_price * si.quantity) as rev
    from public.sales s
    join public.sale_items si on si.sale_id = s.id
    where s.branch_id = v_branch and s.sold_at >= p_from::timestamptz and s.sold_at < (p_to + 1)::timestamptz
    group by s.cashier_id
  )
  select
    u.full_name::text, u.role::text, ps.txn_count::integer, round(coalesce(r.rev, 0), 2),
    round(ps.active_hours, 2),
    round(coalesce(r.rev, 0) / nullif(ps.active_hours, 0), 2),
    round(ps.txn_count / nullif(ps.active_hours, 0), 2)
  from per_seller ps
  join public.users u on u.id = ps.cashier_id
  left join seller_revenue r on r.cashier_id = ps.cashier_id
  order by ps.txn_count desc;
end;
$$;

revoke all on function public.analytics_seller_productivity(date, date, uuid) from public, anon;
grant execute on function public.analytics_seller_productivity(date, date, uuid) to authenticated;


-- source: pharmacy_schema_consolidated.sql
drop function if exists public.analytics_patient_retention(integer, integer, integer);
create or replace function public.analytics_patient_retention(p_lookback_days integer default 180, p_inactive_days integer default 60, p_limit integer default 20, p_branch_id uuid default null)
returns table(patient_name text, last_visit date, days_since_last_visit integer, past_visit_count integer, lifetime_spend numeric)
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_branch uuid := public.effective_branch_id(p_branch_id);
begin
  perform public.assert_owner_or_manager();
  if v_branch is null then raise exception 'No active branch for this session'; end if;
  if p_lookback_days < 1 or p_lookback_days > 1825 then raise exception 'lookback_days must be between 1 and 1825'; end if;
  if p_inactive_days < 1 or p_inactive_days > 730 then raise exception 'inactive_days must be between 1 and 730'; end if;

  return query
  with visits as (
    select s.id as sale_id, s.patient_id, s.sold_at, si.unit_price * si.quantity as line_revenue
    from public.sales s
    join public.sale_items si on si.sale_id = s.id
    where s.branch_id = v_branch and s.patient_id is not null
      and s.sold_at >= now() - (p_lookback_days || ' days')::interval
  ),
  per_patient as (
    select patient_id, max(sold_at) as last_visit, count(distinct sale_id) as visit_count, sum(line_revenue) as spend
    from visits
    group by patient_id
  )
  select
    pt.full_name::text,
    per_patient.last_visit::date,
    (current_date - per_patient.last_visit::date)::integer,
    per_patient.visit_count::integer,
    round(per_patient.spend, 2)
  from per_patient
  join public.patients pt on pt.id = per_patient.patient_id
  where per_patient.last_visit < now() - (p_inactive_days || ' days')::interval
  order by per_patient.spend desc
  limit p_limit;
end;
$$;

revoke all on function public.analytics_patient_retention(integer, integer, integer, uuid) from public, anon;
grant execute on function public.analytics_patient_retention(integer, integer, integer, uuid) to authenticated;


-- source: pharmacy_schema_consolidated.sql
drop function if exists public.list_branch_categories();
create or replace function public.list_branch_categories(p_branch_id uuid default null)
returns table(id uuid, name text, description text, product_count integer, code text)
language sql
stable
security definer
set search_path = ''
as $$
  select
    pc.id, pc.name::text, pc.description,
    (select count(*)::integer from public.branch_product_categorization bpc where bpc.category_id = pc.id and bpc.branch_id = pc.branch_id),
    'CAT-' || lpad(row_number() over (order by pc.created_at)::text, 3, '0')
  from public.product_categories pc
  where pc.branch_id = public.effective_branch_id(p_branch_id)
  order by pc.created_at;
$$;

revoke all on function public.list_branch_categories(uuid) from public, anon;
grant execute on function public.list_branch_categories(uuid) to authenticated;


-- ── RRA Compliance page ──────────────────────────────────────────────────────

-- source: pharmacy_schema_consolidated.sql
drop function if exists public.analytics_vat_by_month(integer);
create or replace function public.analytics_vat_by_month(p_months integer default 8, p_branch_id uuid default null)
returns table(month_label text, month_start date, revenue numeric, vat_total numeric)
language plpgsql
security definer
set search_path = ''
as $$
#variable_conflict use_column
declare
  v_branch uuid := public.effective_branch_id(p_branch_id);
begin
  perform public.assert_owner_or_manager();
  if v_branch is null then raise exception 'No active branch for this session'; end if;
  if p_months < 1 or p_months > 24 then raise exception 'months must be between 1 and 24'; end if;

  return query
  with months as (
    select date_trunc('month', current_date - (n || ' months')::interval)::date as month_start
    from generate_series(0, p_months - 1) as n
  ),
  line_tax as (
    select s.id as sale_id, date_trunc('month', s.sold_at)::date as month_start,
           si.subtotal, round(si.subtotal * t.rate_percentage / 100, 2) as tax_amount
    from public.sales s
    join public.sale_items si on si.sale_id = s.id
    join public.tax_rates t on t.id = si.tax_rate_id
    where s.branch_id = v_branch
      and s.sold_at >= (select min(month_start) from months)
  )
  select
    to_char(m.month_start, 'Mon')::text,
    m.month_start,
    coalesce(round(sum(lt.subtotal + lt.tax_amount), 2), 0),
    coalesce(round(sum(lt.tax_amount), 2), 0)
  from months m
  left join line_tax lt on lt.month_start = m.month_start
  group by m.month_start
  order by m.month_start;
end;
$$;

revoke all on function public.analytics_vat_by_month(integer, uuid) from public, anon;
grant execute on function public.analytics_vat_by_month(integer, uuid) to authenticated;


-- source: pharmacy_schema_consolidated.sql
drop function if exists public.list_compliance_transactions(date, date, integer);
create or replace function public.list_compliance_transactions(p_from date, p_to date, p_limit integer default 200, p_branch_id uuid default null)
returns table(
  sale_id uuid, receipt_number text, sold_at timestamptz, patient_name text, item_count integer,
  subtotal numeric, tax_total numeric, total_amount numeric, payment_method text, has_insurance boolean
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
  if p_limit < 1 or p_limit > 2000 then raise exception 'limit must be between 1 and 2000'; end if;

  return query
  with line_agg as (
    select si.sale_id, sum(si.subtotal) as subtotal, sum(round(si.subtotal * t.rate_percentage / 100, 2)) as tax_total, count(*) as item_count
    from public.sale_items si
    join public.tax_rates t on t.id = si.tax_rate_id
    group by si.sale_id
  )
  select
    s.id, coalesce(r.receipt_number, '—')::text, s.sold_at, p.full_name::text, coalesce(la.item_count, 0)::integer,
    coalesce(la.subtotal, 0), coalesce(la.tax_total, 0), s.total_amount, s.payment_method::text,
    exists(select 1 from public.insurance_claims ic where ic.sale_id = s.id)
  from public.sales s
  left join line_agg la on la.sale_id = s.id
  left join public.receipts r on r.sale_id = s.id
  left join public.patients p on p.id = s.patient_id
  where s.branch_id = v_branch
    and s.sold_at >= p_from::timestamptz and s.sold_at < (p_to + 1)::timestamptz
  order by s.sold_at desc
  limit p_limit;
end;
$$;

revoke all on function public.list_compliance_transactions(date, date, integer, uuid) from public, anon;
grant execute on function public.list_compliance_transactions(date, date, integer, uuid) to authenticated;


-- ── Restock recommendations ──────────────────────────────────────────────────

-- source: 2026-09-05_restock_recommendations.sql (identical in pharmacy_schema_consolidated.sql)
drop function if exists public.check_restock_recommendations();
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

revoke all on function public.check_restock_recommendations(uuid) from public;
grant execute on function public.check_restock_recommendations(uuid) to authenticated;


-- source: pharmacy_schema_consolidated.sql
drop function if exists public.ai_restock_recommendations(integer, integer, integer);
create or replace function public.ai_restock_recommendations(
  p_days_history integer default 30,
  p_horizon_days integer default 14,
  p_limit integer default 10,
  p_branch_id uuid default null
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
  v_branch uuid := public.effective_branch_id(p_branch_id);
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

revoke all on function public.ai_restock_recommendations(integer, integer, integer, uuid) from public, anon;
grant execute on function public.ai_restock_recommendations(integer, integer, integer, uuid) to authenticated;


-- ── Sales forecast (accuracy tracking + chartable series) ───────────────────

-- source: pharmacy_schema_consolidated.sql (originally 2026-09-07_sales_forecast_accuracy.sql)
drop function if exists public.save_sales_forecast_snapshot(uuid, uuid, text, jsonb);
create or replace function public.save_sales_forecast_snapshot(
  p_product_id uuid default null,
  p_category_id uuid default null,
  p_bucket text default 'month',
  p_points jsonb default '[]'::jsonb,
  p_branch_id uuid default null
)
returns void
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_branch uuid := public.effective_branch_id(p_branch_id);
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

revoke all on function public.save_sales_forecast_snapshot(uuid, uuid, text, jsonb, uuid) from public, anon;
grant execute on function public.save_sales_forecast_snapshot(uuid, uuid, text, jsonb, uuid) to authenticated;


-- source: pharmacy_schema_consolidated.sql (originally 2026-09-07_sales_forecast_accuracy.sql)
drop function if exists public.ai_sales_forecast_accuracy(uuid, uuid, date, date);
create or replace function public.ai_sales_forecast_accuracy(
  p_product_id uuid default null,
  p_category_id uuid default null,
  p_from date default null,
  p_to date default null,
  p_branch_id uuid default null
)
returns table(period_start date, predicted_revenue numeric, predicted_quantity numeric, predicted_at timestamptz)
language plpgsql
security definer
set search_path = ''
as $$
#variable_conflict use_column
declare
  v_branch uuid := public.effective_branch_id(p_branch_id);
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

revoke all on function public.ai_sales_forecast_accuracy(uuid, uuid, date, date, uuid) from public, anon;
grant execute on function public.ai_sales_forecast_accuracy(uuid, uuid, date, date, uuid) to authenticated;


-- source: pharmacy_schema_consolidated.sql (originally 2026-09-07_sales_forecast_series.sql)
drop function if exists public.ai_sales_forecast_series(uuid, uuid, integer, integer, text);
create or replace function public.ai_sales_forecast_series(
  p_product_id uuid default null,
  p_category_id uuid default null,
  p_days_history integer default 90,
  p_horizon_days integer default 30,
  p_bucket text default null,
  p_branch_id uuid default null
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
  v_branch uuid := public.effective_branch_id(p_branch_id);
  v_bucket text := p_bucket;
begin
  perform public.assert_owner_or_manager();
  if v_branch is null then raise exception 'No active branch for this session'; end if;
  if p_product_id is not null and p_category_id is not null then
    raise exception 'Pass product_id or category_id, not both';
  end if;
  if p_days_history < 7 or p_days_history > 730 then raise exception 'days_history must be between 7 and 730'; end if;
  if p_horizon_days < 1 or p_horizon_days > 365 then raise exception 'horizon_days must be between 1 and 365'; end if;

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
    select
      ab.period_start, false as is_forecast,
      round(ab.revenue, 2) as actual_revenue, round(ab.quantity, 2) as actual_quantity,
      case when ab.period_start = la.period_start then round(ab.revenue, 2) end as forecast_revenue,
      case when ab.period_start = la.period_start then round(ab.quantity, 2) end as forecast_quantity,
      null::numeric as lower_bound, null::numeric as upper_bound
    from actual_buckets ab cross join last_actual la
    union all
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

revoke all on function public.ai_sales_forecast_series(uuid, uuid, integer, integer, text, uuid) from public, anon;
grant execute on function public.ai_sales_forecast_series(uuid, uuid, integer, integer, text, uuid) to authenticated;


-- source: pharmacy_schema_consolidated.sql (originally 2026-09-07_forecast_completed_notifications.sql)
drop function if exists public.check_forecast_accuracy_notifications();
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

revoke all on function public.check_forecast_accuracy_notifications(uuid) from public, anon;
grant execute on function public.check_forecast_accuracy_notifications(uuid) to authenticated;
