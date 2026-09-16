-- ============================================================================
-- Branch geolocation: store a pin per branch, nudge admins to set it, and
-- let nearby-branch distance be computed for stock transfer requests
-- ============================================================================
-- Run once, after every prior 2026-09-15_*.sql file (this re-declares
-- functions those files most recently touched: get_my_branch_details() and
-- update_branch_details() from 2026-09-14_org_manage_branch_settings.sql /
-- 2026-09-15_org_manager_precedence_over_owner.sql, and
-- list_organization_branches() from 2026-09-15_stock_transfer_negotiation.sql).
-- Idempotent.
--
-- Why: the org's stock-transfer negotiation workflow (request_stock_from_
-- branch(), 2026-09-15_stock_transfer_negotiation.sql) lets a branch ask ONE
-- specific sibling branch for stock, but the picker had nothing to sort
-- candidates by -- a branch manager had to guess or already know which
-- sibling branch is close by. Adding a lat/lng pin per branch lets the
-- frontend compute straight-line (Haversine) distance client-side and show
-- "nearest first" -- no PostGIS extension, no server-side geospatial
-- function needed, just two plain columns surfaced through the existing
-- list_organization_branches() RPC.
--
-- The "notify the admin once setup is done" ask is handled the same
-- idempotent way every other recurring nudge in this schema already is
-- (see check_missing_reorder_points()): once a branch is active and still
-- has no location, fire one notification, then re-fire at most weekly while
-- it's ignored. There's no existing "setup checklist" concept to hook a
-- more precise trigger into -- "the branch is active" stands in for
-- "initial setup is done" here.
-- ============================================================================


-- ============================================================================
-- SECTION 1 — columns
-- ============================================================================

alter table public.branches add column if not exists latitude double precision;
alter table public.branches add column if not exists longitude double precision;


-- ============================================================================
-- SECTION 2 — get_my_branch_details() / update_branch_details(): surface and
-- accept the pin
-- ============================================================================

drop function if exists public.get_my_branch_details(uuid);
create or replace function public.get_my_branch_details(p_branch_id uuid default null)
returns table(
  name text, address text, phone text, tin text, logo_path text, bank_account_number text, bank_account_name text, momo_pay_number text,
  out_of_stock_reminder_hours integer, branch_code text, status text, created_at timestamptz,
  email text, website text, license_number text, license_expiry_date date, ebm_device_serial text, default_language text,
  receipt_number_prefix text, pos_cash_enabled boolean, pos_mtn_momo_enabled boolean, pos_airtel_money_enabled boolean,
  pos_card_enabled boolean, pos_insurance_enabled boolean, pos_default_payment_method text,
  pos_require_patient_name boolean, pos_allow_discounts boolean, pos_show_patient_history boolean,
  expiry_alert_threshold_days integer, default_reorder_min integer,
  latitude double precision, longitude double precision
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
         b.expiry_alert_threshold_days, b.default_reorder_min,
         b.latitude, b.longitude
  from public.branches b
  where b.id = public.effective_branch_id(p_branch_id)
$$;

revoke all on function public.get_my_branch_details(uuid) from public, anon;
grant execute on function public.get_my_branch_details(uuid) to authenticated;


-- Body copied verbatim from 2026-09-15_org_manager_precedence_over_owner.sql
-- (the latest version) plus two new trailing params -- same signature
-- otherwise, so this is a plain create or replace, no drop needed.
create or replace function public.update_branch_details(
  p_address text, p_phone text, p_tin text, p_logo_path text default null,
  p_bank_account_number text default null, p_bank_account_name text default null, p_momo_pay_number text default null,
  p_out_of_stock_reminder_hours integer default null,
  p_name text default null, p_email text default null, p_website text default null,
  p_license_number text default null, p_license_expiry_date date default null, p_ebm_device_serial text default null,
  p_default_language text default null,
  p_receipt_number_prefix text default null,
  p_pos_cash_enabled boolean default null, p_pos_mtn_momo_enabled boolean default null,
  p_pos_airtel_money_enabled boolean default null, p_pos_card_enabled boolean default null, p_pos_insurance_enabled boolean default null,
  p_pos_default_payment_method text default null,
  p_pos_require_patient_name boolean default null, p_pos_allow_discounts boolean default null, p_pos_show_patient_history boolean default null,
  p_expiry_alert_threshold_days integer default null,
  p_default_reorder_min integer default null,
  p_branch_id uuid default null,
  p_latitude double precision default null,
  p_longitude double precision default null
)
returns void
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_own_branch uuid;
  v_own_role text;
  v_branch uuid;
  v_caller_role text;
begin
  select u.branch_id, u.role into v_own_branch, v_own_role
  from public.users u
  where u.id = (select auth.uid()) and u.is_active and u.role in ('owner', 'manager');
  if v_own_branch is null then raise exception 'Only the branch owner or manager may update branch settings'; end if;

  v_branch := public.effective_branch_id(p_branch_id);
  if v_branch is null then raise exception 'No active branch for this session'; end if;
  perform public.assert_can_manage_org_branch_or_own(v_branch, v_own_branch);
  v_caller_role := case when v_branch = v_own_branch then v_own_role else 'owner' end;

  if p_out_of_stock_reminder_hours is not null and (p_out_of_stock_reminder_hours < 1 or p_out_of_stock_reminder_hours > 168) then
    raise exception 'Reminder interval must be between 1 and 168 hours';
  end if;
  if p_default_language is not null and p_default_language not in ('en','fr','rw') then
    raise exception 'Unsupported language %', p_default_language;
  end if;
  if p_pos_default_payment_method is not null and p_pos_default_payment_method not in ('cash','mtn_momo','airtel_money','card') then
    raise exception 'Unsupported default payment method %', p_pos_default_payment_method;
  end if;
  if p_expiry_alert_threshold_days is not null and p_expiry_alert_threshold_days < 1 then
    raise exception 'Expiry alert threshold must be at least 1 day';
  end if;
  if p_default_reorder_min is not null and p_default_reorder_min < 0 then
    raise exception 'Default reorder minimum cannot be negative';
  end if;
  if p_latitude is not null and (p_latitude < -90 or p_latitude > 90) then
    raise exception 'Latitude must be between -90 and 90';
  end if;
  if p_longitude is not null and (p_longitude < -180 or p_longitude > 180) then
    raise exception 'Longitude must be between -180 and 180';
  end if;

  update public.branches
  set address = nullif(btrim(coalesce(p_address, '')), ''),
      phone = nullif(btrim(coalesce(p_phone, '')), ''),
      tin = case when v_caller_role <> 'owner' then tin else nullif(btrim(coalesce(p_tin, '')), '') end,
      logo_path = case when p_logo_path is null then logo_path else nullif(btrim(p_logo_path), '') end,
      bank_account_number = case when v_caller_role <> 'owner' then bank_account_number
        when p_bank_account_number is null then bank_account_number else nullif(btrim(p_bank_account_number), '') end,
      bank_account_name = case when v_caller_role <> 'owner' then bank_account_name
        when p_bank_account_name is null then bank_account_name else nullif(btrim(p_bank_account_name), '') end,
      momo_pay_number = case when v_caller_role <> 'owner' then momo_pay_number
        when p_momo_pay_number is null then momo_pay_number else nullif(btrim(p_momo_pay_number), '') end,
      out_of_stock_reminder_hours = coalesce(p_out_of_stock_reminder_hours, out_of_stock_reminder_hours),
      name = coalesce(nullif(btrim(coalesce(p_name, '')), ''), name),
      email = case when p_email is null then email else nullif(btrim(p_email), '') end,
      website = case when p_website is null then website else nullif(btrim(p_website), '') end,
      license_number = case when v_caller_role <> 'owner' then license_number
        when p_license_number is null then license_number else nullif(btrim(p_license_number), '') end,
      license_expiry_date = case when v_caller_role <> 'owner' then license_expiry_date else p_license_expiry_date end,
      ebm_device_serial = case when v_caller_role <> 'owner' then ebm_device_serial
        when p_ebm_device_serial is null then ebm_device_serial else nullif(btrim(p_ebm_device_serial), '') end,
      default_language = coalesce(p_default_language, default_language),
      receipt_number_prefix = coalesce(nullif(btrim(coalesce(p_receipt_number_prefix, '')), ''), receipt_number_prefix),
      pos_cash_enabled = coalesce(p_pos_cash_enabled, pos_cash_enabled),
      pos_mtn_momo_enabled = coalesce(p_pos_mtn_momo_enabled, pos_mtn_momo_enabled),
      pos_airtel_money_enabled = coalesce(p_pos_airtel_money_enabled, pos_airtel_money_enabled),
      pos_card_enabled = coalesce(p_pos_card_enabled, pos_card_enabled),
      pos_insurance_enabled = coalesce(p_pos_insurance_enabled, pos_insurance_enabled),
      pos_default_payment_method = coalesce(p_pos_default_payment_method, pos_default_payment_method),
      pos_require_patient_name = coalesce(p_pos_require_patient_name, pos_require_patient_name),
      pos_allow_discounts = coalesce(p_pos_allow_discounts, pos_allow_discounts),
      pos_show_patient_history = coalesce(p_pos_show_patient_history, pos_show_patient_history),
      expiry_alert_threshold_days = coalesce(p_expiry_alert_threshold_days, expiry_alert_threshold_days),
      default_reorder_min = coalesce(p_default_reorder_min, default_reorder_min),
      latitude = p_latitude,
      longitude = p_longitude
  where id = v_branch;
end;
$$;

revoke all on function public.update_branch_details(
  text, text, text, text, text, text, text, integer, text, text, text, text, date, text, text, text,
  boolean, boolean, boolean, boolean, boolean, text, boolean, boolean, boolean, integer, integer, uuid,
  double precision, double precision
) from public, anon;
grant execute on function public.update_branch_details(
  text, text, text, text, text, text, text, integer, text, text, text, text, date, text, text, text,
  boolean, boolean, boolean, boolean, boolean, text, boolean, boolean, boolean, integer, integer, uuid,
  double precision, double precision
) to authenticated;


-- ============================================================================
-- SECTION 3 — list_organization_branches(): surface each sibling's pin so
-- distance can be computed client-side
-- ============================================================================
-- Body copied verbatim from 2026-09-15_stock_transfer_negotiation.sql (the
-- latest version, org_manager-exclusion in staff_count included) plus
-- latitude/longitude on the returned rows -- a real return-shape change, so
-- this needs its own drop first.

drop function if exists public.list_organization_branches(uuid);
create or replace function public.list_organization_branches(p_organization_id uuid)
returns table(
  branch_id uuid, name text, address text, phone text, branch_code text, status text,
  staff_count integer, created_at timestamptz, latitude double precision, longitude double precision
)
language plpgsql
stable
security definer
set search_path = ''
as $$
begin
  if not public.is_org_member_or_own_branch_in_org(p_organization_id) then
    raise exception 'You are not part of this organization';
  end if;
  return query
    select
      b.id, b.name::text, b.address, b.phone::text, b.branch_code::text, b.status::text,
      (select count(*)::integer from public.users u
        where u.branch_id = b.id
          and not exists (select 1 from public.organization_members m where m.user_id = u.id and m.role = 'org_manager')),
      b.created_at, b.latitude, b.longitude
    from public.branches b
    where b.organization_id = p_organization_id
    order by b.name;
end;
$$;

revoke all on function public.list_organization_branches(uuid) from public, anon;
grant execute on function public.list_organization_branches(uuid) to authenticated;


-- ============================================================================
-- SECTION 4 — check_missing_branch_location(): the "set up your pin" nudge
-- ============================================================================
-- Same idempotent recurring-check shape as check_missing_reorder_points()
-- (2026-09-14_reorder_notifications_org_visibility.sql): fires once a
-- branch is active with no pin set, and re-fires at most weekly while the
-- notification sits read and ignored. source_id is the branch's own id --
-- there's only ever one "thing" to be missing per branch, unlike reorder
-- points (one per product).
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
    insert into public.notifications (branch_id, source_type, source_id, message)
    values (
      v_branch, 'branch_location_missing', v_branch,
      'Set this branch''s location in Branch Settings so nearby sibling branches can be found for stock transfer requests.'
    );
    return 1;
  end if;

  return 0;
end;
$$;

revoke all on function public.check_missing_branch_location() from public, anon;
grant execute on function public.check_missing_branch_location() to authenticated;


-- ============================================================================
-- SECTION 5 — new notification source_type
-- ============================================================================

alter table public.notifications drop constraint if exists notifications_source_type_check;
alter table public.notifications add constraint notifications_source_type_check
  check (source_type in (
    'batch_recall','stock_adjustment','product_request_approved','product_request_rejected',
    'out_of_stock','license_expiring','forecast_completed','restock_recommendation','reorder_point_missing',
    'stock_offer_requested','stock_offer_accepted','stock_offer_denied',
    'stock_need_awaiting_approval','stock_need_approved','stock_need_rejected','stock_need_fulfilled',
    'branch_location_missing'
  ));
