-- ============================================================================
-- org_manager takes over branch MANAGEMENT once appointed; owner keeps
-- oversight only
-- ============================================================================
-- Run once, after 2026-09-14_org_manage_branch_settings.sql,
-- 2026-09-11_view_branch_as_org_owner_writes.sql, and
-- 2026-09-09_organization_roles_v2.sql. Idempotent.
--
-- The model, confirmed with the user: an org_owner acts AS the org_manager
-- (full day-to-day authority over every branch) only until a dedicated
-- org_manager is actually appointed. Once that happens, the owner drops to
-- oversight ONLY for branches they don't personally run as their own branch
-- role -- overlooking what's being done and being notified, never actually
-- performing an operation there themselves. They still see every branch's
-- performance, analytics and recommendations, and still keep whatever the
-- owner-specific configuration ask covers, but the org_manager becomes the
-- one who actually acts on other branches from here on -- both managing
-- them (settings, staff, categories, discounts, who's assigned as branch
-- owner/manager/seller) AND operating them day to day (sales, stock
-- receiving, patient records).
--
-- This exact precedence rule (org_manager exclusive once one exists, owner
-- as fallback only while the seat is empty) was already built and confirmed
-- correct for stock-transfer approval -- see
-- assert_can_approve_stock_transfer() in
-- 2026-09-15_stock_transfer_negotiation.sql. This file generalizes that same
-- rule into a reusable pair of helpers and applies them everywhere a
-- cross-branch action on another branch was instead granting blanket
-- "any org_owner or org_manager" access:
--   - update_branch_details, admin_set_seller_active, admin_update_staff_role
--     (2026-09-14_org_manage_branch_settings.sql)
--   - org_assign_branch_role (2026-09-09_organization_roles_v2.sql)
--   - create_branch_discount, create_branch_category, update_branch_category,
--     complete_sale, receive_stock_delivery, upsert_patient
--     (2026-09-11_view_branch_as_org_owner_writes.sql)
--
-- None of this affects a caller acting on their OWN home branch: the
-- wrapper below is a no-op whenever the target branch equals the caller's
-- own branch, so a branch's real owner/manager keeps exactly the access
-- they always had. It also doesn't affect READS (branch dashboards,
-- analytics, lists) -- the owner's oversight of every branch stays exactly
-- as it was; only WRITES on a branch that isn't the owner's own are gated.
-- ============================================================================


-- ============================================================================
-- SECTION 1 — shared helpers
-- ============================================================================

-- Same rule as assert_can_approve_stock_transfer(): if the organization has
-- an active org_manager, only that org_manager may act; otherwise the
-- org_owner may act as a fallback (there is always someone who can manage,
-- even before a manager is appointed).
create or replace function public.assert_can_manage_org_branch(p_organization_id uuid)
returns void
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  v_caller uuid := (select auth.uid());
  v_caller_role text;
  v_has_manager boolean;
begin
  select m.role into v_caller_role
  from public.organization_members m
  join public.users u on u.id = m.user_id
  where m.organization_id = p_organization_id and m.user_id = v_caller and u.is_active;

  v_has_manager := exists (
    select 1 from public.organization_members om
    join public.users u2 on u2.id = om.user_id
    where om.organization_id = p_organization_id and om.role = 'org_manager' and u2.is_active
  );

  if v_has_manager then
    if v_caller_role <> 'org_manager' then
      raise exception 'Only the organization manager may act on another branch -- the owner can still view its performance and analytics';
    end if;
  else
    if v_caller_role not in ('org_owner', 'org_manager') then
      raise exception 'Only the organization owner or manager may act on another branch';
    end if;
  end if;
end;
$$;

revoke all on function public.assert_can_manage_org_branch(uuid) from public, anon;
grant execute on function public.assert_can_manage_org_branch(uuid) to authenticated;


-- Convenience wrapper for the effective_branch_id() pattern: no-op for your
-- own branch (real owner/manager access there is untouched), otherwise
-- resolves the target branch's organization and applies the rule above.
-- p_effective_branch_id is trusted to already be org-membership-checked
-- (effective_branch_id() itself does that before ever returning a foreign
-- branch id), so the organization_id lookup here is just for the precedence
-- check, not a re-check of membership.
create or replace function public.assert_can_manage_org_branch_or_own(p_effective_branch_id uuid, p_own_branch_id uuid)
returns void
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  v_org_id uuid;
begin
  if p_effective_branch_id is null or p_effective_branch_id = p_own_branch_id then
    return;
  end if;

  select organization_id into v_org_id from public.branches where id = p_effective_branch_id;
  perform public.assert_can_manage_org_branch(v_org_id);
end;
$$;

revoke all on function public.assert_can_manage_org_branch_or_own(uuid, uuid) from public, anon;
grant execute on function public.assert_can_manage_org_branch_or_own(uuid, uuid) to authenticated;


-- ============================================================================
-- SECTION 2 — 2026-09-14_org_manage_branch_settings.sql functions
-- ============================================================================
-- Each of these already resolves v_own_branch/v_own_role (caller's own home
-- branch/role) and v_branch (the effective/target branch) before deciding
-- v_caller_role. The only change: gate the cross-branch case on the new
-- precedence rule before granting the 'owner'-equivalent effective role.

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
  p_branch_id uuid default null
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
      default_reorder_min = coalesce(p_default_reorder_min, default_reorder_min)
  where id = v_branch;
end;
$$;

-- Signature unchanged from 2026-09-14_org_manage_branch_settings.sql -- plain
-- create or replace, no drop or grant changes needed.


create or replace function public.admin_set_seller_active(p_user_id uuid, p_is_active boolean, p_branch_id uuid default null)
returns void
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_caller uuid := (select auth.uid());
  v_own_branch uuid;
  v_own_role text;
  v_branch uuid;
  v_caller_role text;
  v_target_role text;
begin
  select u.branch_id, u.role into v_own_branch, v_own_role
  from public.users u
  where u.id = v_caller and u.is_active and u.role in ('owner', 'manager');
  if v_own_branch is null then raise exception 'Only an active branch manager or owner may manage staff'; end if;

  v_branch := public.effective_branch_id(p_branch_id);
  if v_branch is null then raise exception 'No active branch for this session'; end if;
  perform public.assert_can_manage_org_branch_or_own(v_branch, v_own_branch);
  v_caller_role := case when v_branch = v_own_branch then v_own_role else 'owner' end;

  select role into v_target_role from public.users where id = p_user_id and branch_id = v_branch;
  if v_target_role is null or v_target_role not in ('manager', 'seller') then
    raise exception 'Staff member not found for this branch';
  end if;
  if v_target_role = 'manager' and v_caller_role <> 'owner' then
    raise exception 'Only the branch owner may deactivate a manager';
  end if;

  update public.users
  set is_active = p_is_active
  where id = p_user_id and branch_id = v_branch and role in ('manager', 'seller');
end;
$$;

-- Signature unchanged -- plain create or replace.


create or replace function public.admin_update_staff_role(p_user_id uuid, p_role text, p_branch_id uuid default null)
returns void
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_caller uuid := (select auth.uid());
  v_own_branch uuid;
  v_own_role text;
  v_branch uuid;
  v_caller_role text;
begin
  if p_role not in ('manager', 'seller') then
    raise exception 'role must be manager or seller';
  end if;

  select u.branch_id, u.role into v_own_branch, v_own_role
  from public.users u
  where u.id = v_caller and u.is_active and u.role in ('owner', 'manager');
  if v_own_branch is null then raise exception 'Only the branch owner may change a staff member''s role'; end if;

  v_branch := public.effective_branch_id(p_branch_id);
  if v_branch is null then raise exception 'No active branch for this session'; end if;
  perform public.assert_can_manage_org_branch_or_own(v_branch, v_own_branch);
  v_caller_role := case when v_branch = v_own_branch then v_own_role else 'owner' end;

  if v_caller_role <> 'owner' then
    raise exception 'Only the branch owner may change a staff member''s role';
  end if;

  update public.users
  set role = p_role
  where id = p_user_id and branch_id = v_branch and role in ('manager', 'seller');
  if not found then raise exception 'Staff member not found for this branch'; end if;
end;
$$;

-- Signature unchanged -- plain create or replace.


-- ============================================================================
-- SECTION 3 — 2026-09-09_organization_roles_v2.sql: org_assign_branch_role
-- ============================================================================
-- This assigns/reassigns who is owner/manager/seller at an org branch --
-- squarely branch MANAGEMENT (staffing), not branch creation itself
-- (creating a branch stays assert_org_owner()-only elsewhere and is
-- untouched). Same precedence rule applies: once a dedicated org_manager
-- exists, staffing decisions for branches the owner doesn't personally run
-- are the manager's call.
create or replace function public.org_assign_branch_role(
  p_organization_id uuid, p_branch_id uuid, p_user_email text, p_full_name text, p_role text
)
returns text  -- 'granted' | 'invited'
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_target uuid;
  v_target_branch uuid;
  v_old_role text;
begin
  perform public.assert_can_manage_org_branch(p_organization_id);
  if p_role not in ('owner', 'manager', 'seller') then
    raise exception 'role must be owner, manager, or seller';
  end if;
  if not exists (select 1 from public.branches where id = p_branch_id and organization_id = p_organization_id) then
    raise exception 'That branch does not belong to this organization';
  end if;

  select id, branch_id, role into v_target, v_target_branch, v_old_role
  from public.users where lower(email) = lower(btrim(p_user_email));

  if v_target is null then
    perform public.create_organization_invite(p_organization_id, p_branch_id, p_user_email, p_full_name, p_role);
    return 'invited';
  end if;

  if v_target_branch <> p_branch_id then
    raise exception 'This person already has a login at a different branch';
  end if;

  if p_role = 'owner' and v_old_role <> 'owner' then
    raise exception 'This branch already has an owner -- assign manager or seller instead';
  end if;

  update public.users set role = p_role where id = v_target;
  perform public.log_role_change('branch', null, p_branch_id, v_target, v_old_role, p_role, 'role_change');

  return 'granted';
end;
$$;

-- Signature unchanged -- plain create or replace.


-- ============================================================================
-- SECTION 4 — 2026-09-11_view_branch_as_org_owner_writes.sql: discounts &
-- categories
-- ============================================================================
-- These three only ever checked the CALLER's own base role
-- (assert_owner_or_manager(), which is unrelated to which branch is being
-- targeted) before writing to whichever branch effective_branch_id()
-- resolved to. Add the same precedence gate for the cross-branch case,
-- using current_branch_id() (the caller's own branch) as the "own branch"
-- reference point, matching the pattern from Section 2 above.

create or replace function public.create_branch_discount(
  p_name text, p_discount_type text, p_value numeric, p_valid_from date default null, p_valid_to date default null,
  p_branch_id uuid default null
)
returns uuid
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_branch uuid;
  v_id uuid;
begin
  perform public.assert_owner_or_manager();
  v_branch := public.effective_branch_id(p_branch_id);
  perform public.assert_can_manage_org_branch_or_own(v_branch, public.current_branch_id());
  if p_discount_type not in ('percentage','fixed') then
    raise exception 'Discount type must be percentage or fixed';
  end if;
  if p_value < 0 or (p_discount_type = 'percentage' and p_value > 100) then
    raise exception 'Invalid discount value';
  end if;

  insert into public.discounts (name, discount_type, value, valid_from, valid_to, branch_id)
  values (btrim(p_name), p_discount_type, p_value, p_valid_from, p_valid_to, v_branch)
  returning id into v_id;

  return v_id;
end;
$$;

-- Signature unchanged -- plain create or replace.


create or replace function public.create_branch_category(p_name text, p_description text default null, p_branch_id uuid default null)
returns uuid
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_branch uuid := public.effective_branch_id(p_branch_id);
  v_id uuid;
begin
  perform public.assert_owner_or_manager();
  perform public.assert_can_manage_org_branch_or_own(v_branch, public.current_branch_id());
  if v_branch is null then raise exception 'No active branch for this session'; end if;
  if nullif(btrim(coalesce(p_name, '')), '') is null then raise exception 'A category name is required'; end if;

  insert into public.product_categories (branch_id, name, description)
  values (v_branch, btrim(p_name), nullif(btrim(coalesce(p_description, '')), ''))
  returning id into v_id;
  return v_id;
exception
  when unique_violation then
    raise exception 'A category named "%" already exists for this branch.', btrim(p_name);
end;
$$;

-- Signature unchanged -- plain create or replace.


create or replace function public.update_branch_category(p_category_id uuid, p_name text, p_description text default null, p_branch_id uuid default null)
returns void
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_branch uuid := public.effective_branch_id(p_branch_id);
begin
  perform public.assert_owner_or_manager();
  perform public.assert_can_manage_org_branch_or_own(v_branch, public.current_branch_id());
  if v_branch is null then raise exception 'No active branch for this session'; end if;
  if nullif(btrim(coalesce(p_name, '')), '') is null then raise exception 'A category name is required'; end if;

  update public.product_categories
  set name = btrim(p_name), description = nullif(btrim(coalesce(p_description, '')), '')
  where id = p_category_id and branch_id = v_branch;
  if not found then raise exception 'Category not found for this branch'; end if;
exception
  when unique_violation then
    raise exception 'A category named "%" already exists for this branch.', btrim(p_name);
end;
$$;

-- Signature unchanged -- plain create or replace.


-- ============================================================================
-- SECTION 5 — 2026-09-11_view_branch_as_org_owner_writes.sql: day-to-day
-- operational writes (complete_sale, receive_stock_delivery, upsert_patient)
-- ============================================================================
-- Confirmed with the user: the owner's role on another branch is oversight
-- ONLY once a dedicated org_manager exists -- overlooking and being
-- notified, never performing the operation themselves. So these three get
-- exactly the same gate as Sections 2-4, even though they're operational
-- writes rather than settings/staffing. Bodies are otherwise byte-for-byte
-- identical to 2026-09-11_view_branch_as_org_owner_writes.sql; only the
-- branch-resolution lines gain the new guard.

create or replace function public.complete_sale(
  p_lines jsonb, p_insurance_provider_id uuid default null, p_patient_id uuid default null,
  p_payment_method text default null, p_discount_id uuid default null, p_branch_id uuid default null
)
returns table(
  sale_id uuid, receipt_number text, total_amount numeric,
  insurance_covered_total numeric, patient_owed_total numeric
)
language plpgsql
security definer
set search_path = ''
as $$
#variable_conflict use_column
declare
  v_branch uuid;
  v_user uuid := (select auth.uid());
  v_sale uuid := gen_random_uuid();
  v_receipt_number text;
  v_receipt_prefix text;
  line jsonb;
  v_code text;
  v_mode text;
  v_quantity integer;
  v_barcode record;
  v_child record;
  v_child_quantity integer;
  v_packs_remaining integer;
  v_pieces_remaining integer;
  v_product_id uuid;
  v_tax_rate_id uuid;
  v_tax_pct numeric;
  v_coverage_pct numeric;
  v_subtotal numeric;
  v_tax_amount numeric;
  v_line_total numeric;
  v_line_covered numeric;
  v_total numeric := 0;
  v_covered_total numeric := 0;
  v_seen_codes text[] := array[]::text[];
  v_provider_name text;
  v_discount record;
  v_discount_amount numeric := 0;
begin
  v_branch := public.effective_branch_id(p_branch_id);
  if v_branch is null then
    raise exception 'Only an active branch user may complete a sale';
  end if;
  perform public.assert_can_manage_org_branch_or_own(v_branch, public.current_branch_id());
  if exists (select 1 from public.branches b where b.id = v_branch and b.status <> 'active') then
    raise exception 'This pharmacy is not active';
  end if;
  if jsonb_typeof(p_lines) <> 'array' or jsonb_array_length(p_lines) = 0 then
    raise exception 'At least one item is required to complete a sale';
  end if;

  if p_payment_method is not null and p_payment_method not in ('cash','mtn_momo','airtel_money','card') then
    raise exception 'Unsupported payment method %', p_payment_method;
  end if;

  if p_insurance_provider_id is not null then
    select name into v_provider_name from public.insurance_providers where id = p_insurance_provider_id;
    if v_provider_name is null then raise exception 'Unknown insurance provider'; end if;
  end if;

  if p_patient_id is not null and not exists (
    select 1 from public.patients where id = p_patient_id and branch_id = v_branch
  ) then
    raise exception 'Unknown patient for this branch';
  end if;

  if p_discount_id is not null then
    select * into v_discount from public.discounts where id = p_discount_id;
    if v_discount.id is null then raise exception 'Unknown discount'; end if;
    if (v_discount.valid_from is not null and v_discount.valid_from > current_date)
       or (v_discount.valid_to is not null and v_discount.valid_to < current_date) then
      raise exception 'This discount is not currently valid';
    end if;
  end if;

  select coalesce(receipt_number_prefix, 'RCT') into v_receipt_prefix from public.branches where id = v_branch;
  v_receipt_number := format('%s-%s-%s', v_receipt_prefix, to_char(now(), 'YYYYMMDD'), upper(substr(replace(gen_random_uuid()::text,'-',''),1,6)));

  insert into public.sales (id, branch_id, cashier_id, patient_id, total_amount)
  values (v_sale, v_branch, v_user, p_patient_id, 0);

  for line in select * from jsonb_array_elements(p_lines) loop
    v_code := upper(btrim(coalesce(line->>'code', '')));
    if v_code = '' then raise exception 'Each line needs a barcode code'; end if;
    if v_code = any(v_seen_codes) then
      raise exception 'Barcode % was scanned twice in the same sale', v_code;
    end if;
    v_seen_codes := array_append(v_seen_codes, v_code);

    select bc.*, sb.selling_price, sb.product_variant_id, sb.expiry_date
      into v_barcode
      from public.barcodes bc
      join public.stock_batches sb on sb.id = bc.stock_batch_id
      where upper(bc.code) = v_code and sb.branch_id = v_branch
      for update of bc;

    if not found then
      raise exception 'Barcode % was not found for this branch', v_code;
    end if;
    if v_barcode.expiry_date < current_date then
      raise exception 'Barcode %: this batch expired on % and cannot be sold', v_code, v_barcode.expiry_date;
    end if;
    if v_barcode.status <> 'active' then
      raise exception 'Barcode % is % and cannot be sold', v_code, v_barcode.status;
    end if;

    v_mode := lower(coalesce(nullif(line->>'sell_mode', ''), 'whole'));
    v_quantity := nullif(line->>'quantity', '')::integer;

    select pv.product_id into v_product_id from public.product_variants pv where pv.id = v_barcode.product_variant_id;
    select p.tax_rate_id into v_tax_rate_id from public.products p where p.id = v_product_id;
    select t.rate_percentage into v_tax_pct from public.tax_rates t where t.id = v_tax_rate_id;

    if p_insurance_provider_id is null then
      v_coverage_pct := 0;
    else
      select coverage_percentage into v_coverage_pct
        from public.insurance_product_coverage
        where insurance_provider_id = p_insurance_provider_id and product_id = v_product_id;
      if v_coverage_pct is null then
        select default_coverage_percentage into v_coverage_pct
          from public.insurance_providers where id = p_insurance_provider_id;
      end if;
    end if;

    if v_barcode.barcode_type = 'pack' then
      if coalesce(v_barcode.quantity_available, 0) < 1 then
        raise exception 'Barcode % has already been sold', v_code;
      end if;
      if v_mode not in ('whole', 'pieces') then
        raise exception 'Barcode % is a pack; sell_mode must be whole or pieces', v_code;
      end if;

      v_child_quantity := coalesce(v_quantity, v_barcode.pieces_per_pack);
      if v_mode = 'whole' then
        v_child_quantity := v_barcode.pieces_per_pack;
      end if;
      if v_child_quantity < 1 then
        raise exception 'Barcode % needs a quantity of at least 1 piece', v_code;
      end if;
      if v_child_quantity > v_barcode.pieces_per_pack then
        raise exception 'Barcode % only has % piece(s) left', v_code, v_barcode.pieces_per_pack;
      end if;

      v_line_total := v_barcode.selling_price * v_child_quantity;
      v_tax_amount := round(v_line_total * coalesce(v_tax_pct, 0) / (100 + coalesce(v_tax_pct, 0)), 2);
      v_subtotal := v_line_total - v_tax_amount;
      v_line_covered := round(v_line_total * coalesce(v_coverage_pct, 0) / 100, 2);

      insert into public.sale_items (sale_id, barcode_id, tax_rate_id, quantity, unit_price, subtotal, insurance_covered_amount)
      values (v_sale, v_barcode.id, v_tax_rate_id, v_child_quantity, v_barcode.selling_price, v_subtotal, v_line_covered);

      if v_child_quantity = v_barcode.pieces_per_pack then
        update public.barcodes set quantity_available = 0, status = 'sold_out' where id = v_barcode.id;
      else
        update public.barcodes set pieces_per_pack = pieces_per_pack - v_child_quantity where id = v_barcode.id;
      end if;

      v_total := v_total + v_line_total;
      v_covered_total := v_covered_total + v_line_covered;

    elsif v_barcode.barcode_type = 'box' then
      if v_mode not in ('whole', 'packs', 'pieces') then
        raise exception 'Barcode % is a carton; sell_mode must be whole, packs or pieces', v_code;
      end if;

      select count(*), coalesce(sum(pieces_per_pack), 0)
        into v_packs_remaining, v_pieces_remaining
        from public.barcodes
        where parent_barcode_id = v_barcode.id
          and barcode_type = 'pack'
          and status = 'active'
          and quantity_available > 0;

      if v_packs_remaining = 0 then
        raise exception 'Carton % has no packs left to sell', v_code;
      end if;

      if v_mode = 'whole' then
        for v_child in
          select bc.id, bc.pieces_per_pack
          from public.barcodes bc
          where bc.parent_barcode_id = v_barcode.id
            and bc.barcode_type = 'pack'
            and bc.status = 'active'
            and bc.quantity_available > 0
          order by bc.created_at
          for update
        loop
          v_line_total := v_barcode.selling_price * v_child.pieces_per_pack;
          v_tax_amount := round(v_line_total * coalesce(v_tax_pct, 0) / (100 + coalesce(v_tax_pct, 0)), 2);
          v_subtotal := v_line_total - v_tax_amount;
          v_line_covered := round(v_line_total * coalesce(v_coverage_pct, 0) / 100, 2);

          insert into public.sale_items (sale_id, barcode_id, tax_rate_id, quantity, unit_price, subtotal, insurance_covered_amount)
          values (v_sale, v_child.id, v_tax_rate_id, v_child.pieces_per_pack, v_barcode.selling_price, v_subtotal, v_line_covered);

          update public.barcodes set quantity_available = 0, status = 'sold_out' where id = v_child.id;

          v_total := v_total + v_line_total;
          v_covered_total := v_covered_total + v_line_covered;
        end loop;

        update public.barcodes set quantity_available = 0, status = 'sold_out' where id = v_barcode.id;

      elsif v_mode = 'packs' then
        if v_quantity is null or v_quantity < 1 then
          raise exception 'Carton % needs a pack quantity of at least 1', v_code;
        end if;
        if v_quantity > v_packs_remaining then
          raise exception 'Carton % only has % pack(s) left', v_code, v_packs_remaining;
        end if;

        for v_child in
          select id, pieces_per_pack from public.barcodes
          where parent_barcode_id = v_barcode.id
            and barcode_type = 'pack'
            and status = 'active'
            and quantity_available > 0
          order by pieces_per_pack desc, created_at
          limit v_quantity
          for update
        loop
          v_line_total := v_barcode.selling_price * v_child.pieces_per_pack;
          v_tax_amount := round(v_line_total * coalesce(v_tax_pct, 0) / (100 + coalesce(v_tax_pct, 0)), 2);
          v_subtotal := v_line_total - v_tax_amount;
          v_line_covered := round(v_line_total * coalesce(v_coverage_pct, 0) / 100, 2);

          insert into public.sale_items (sale_id, barcode_id, tax_rate_id, quantity, unit_price, subtotal, insurance_covered_amount)
          values (v_sale, v_child.id, v_tax_rate_id, v_child.pieces_per_pack, v_barcode.selling_price, v_subtotal, v_line_covered);

          update public.barcodes set quantity_available = 0, status = 'sold_out' where id = v_child.id;

          v_total := v_total + v_line_total;
          v_covered_total := v_covered_total + v_line_covered;
        end loop;

        if v_quantity = v_packs_remaining then
          update public.barcodes set quantity_available = 0, status = 'sold_out' where id = v_barcode.id;
        end if;

      else -- pieces from carton
        if v_quantity is null or v_quantity < 1 then
          raise exception 'Carton % needs a piece quantity of at least 1', v_code;
        end if;

        select id, pieces_per_pack into v_child
          from public.barcodes
          where parent_barcode_id = v_barcode.id
            and barcode_type = 'pack'
            and status = 'active'
            and quantity_available > 0
          order by pieces_per_pack asc, created_at
          limit 1
          for update;

        if v_child.pieces_per_pack is null then
          raise exception 'Carton % has no packs left to sell', v_code;
        end if;
        if v_quantity > v_child.pieces_per_pack then
          raise exception 'Carton %: the openable pack only has % piece(s) left -- sell fewer pieces or use packs mode', v_code, v_child.pieces_per_pack;
        end if;

        v_line_total := v_barcode.selling_price * v_quantity;
        v_tax_amount := round(v_line_total * coalesce(v_tax_pct, 0) / (100 + coalesce(v_tax_pct, 0)), 2);
        v_subtotal := v_line_total - v_tax_amount;
        v_line_covered := round(v_line_total * coalesce(v_coverage_pct, 0) / 100, 2);

        insert into public.sale_items (sale_id, barcode_id, tax_rate_id, quantity, unit_price, subtotal, insurance_covered_amount)
        values (v_sale, v_child.id, v_tax_rate_id, v_quantity, v_barcode.selling_price, v_subtotal, v_line_covered);

        if v_quantity = v_child.pieces_per_pack then
          update public.barcodes set quantity_available = 0, status = 'sold_out' where id = v_child.id;
          if v_packs_remaining = 1 then
            update public.barcodes set quantity_available = 0, status = 'sold_out' where id = v_barcode.id;
          end if;
        else
          update public.barcodes set pieces_per_pack = pieces_per_pack - v_quantity where id = v_child.id;
        end if;

        v_total := v_total + v_line_total;
        v_covered_total := v_covered_total + v_line_covered;
      end if;

    else
      raise exception 'Barcode % has unknown type %', v_code, v_barcode.barcode_type;
    end if;
  end loop;

  -- Discount comes off the patient's own portion only (post-insurance),
  -- capped so it can never push what the patient owes below zero. What
  -- insurance is billed (v_covered_total, and the claim's own
  -- coverage_percentage_applied below) is computed from the real gross
  -- v_total and never touched by a pharmacy-side discount.
  if p_discount_id is not null then
    v_discount_amount := case
      when v_discount.discount_type = 'percentage' then round((v_total - v_covered_total) * v_discount.value / 100, 2)
      else least(v_discount.value, greatest(v_total - v_covered_total, 0))
    end;
  end if;

  update public.sales
  set total_amount = v_total - v_discount_amount, discount_id = p_discount_id, payment_method = p_payment_method
  where id = v_sale;

  insert into public.receipts (sale_id, receipt_number) values (v_sale, v_receipt_number);

  if p_insurance_provider_id is not null and v_covered_total > 0 then
    insert into public.insurance_claims (sale_id, insurance_provider_id, coverage_percentage_applied, claim_amount)
    values (
      v_sale, p_insurance_provider_id,
      round(v_covered_total / nullif(v_total, 0) * 100, 2),
      v_covered_total
    );
  end if;

  return query select v_sale, v_receipt_number, v_total - v_discount_amount, v_covered_total, (v_total - v_discount_amount) - v_covered_total;
end;
$$;

-- Signature unchanged -- plain create or replace.


create or replace function public.receive_stock_delivery(p_supplier_name text, p_notes text, p_lines jsonb, p_branch_id uuid default null)
returns table(delivery_id uuid, delivery_code text)
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_branch uuid;
  v_user uuid := (select auth.uid());
  v_delivery uuid := gen_random_uuid();
  v_supplier uuid;
  v_code text;
  line jsonb;
  v_batch uuid;
  v_category uuid;
  v_existing_category uuid;
  v_existing_category_name text;
  v_product uuid;
  v_variant uuid;
  v_cartons integer;
  v_packs integer;
  v_pieces integer;
begin
  v_branch := public.effective_branch_id(p_branch_id);

  if v_branch is null or not exists (
    select 1 from public.users u
    where u.id = v_user and u.role in ('owner','manager')
  ) then
    raise exception 'Only an active branch manager or owner may receive stock';
  end if;
  perform public.assert_can_manage_org_branch_or_own(v_branch, public.current_branch_id());

  if exists (select 1 from public.branches b where b.id = v_branch and b.status <> 'active') then
    raise exception 'This pharmacy is not active';
  end if;

  if jsonb_typeof(p_lines) <> 'array' or jsonb_array_length(p_lines) = 0 then
    raise exception 'At least one delivery line is required';
  end if;
  if nullif(btrim(p_supplier_name), '') is null then
    raise exception 'Supplier name is required';
  end if;

  select s.id into v_supplier
  from public.suppliers s
  where s.branch_id = v_branch
    and lower(s.supplier_name) = lower(btrim(p_supplier_name));
  if v_supplier is null then
    insert into public.suppliers (supplier_name, branch_id)
    values (btrim(p_supplier_name), v_branch)
    returning id into v_supplier;
  end if;

  v_code := format('DEL-%s-%s', to_char(now(), 'YYYYMMDD'), upper(substr(replace(v_delivery::text, '-', ''), 1, 6)));

  insert into public.stock_deliveries (id, branch_id, supplier_id, delivery_code, received_by, notes)
  values (v_delivery, v_branch, v_supplier, v_code, v_user, p_notes);

  for line in select * from jsonb_array_elements(p_lines) loop
    v_cartons := coalesce((line->>'cartons')::integer, 0);
    v_packs := greatest(coalesce((line->>'packs_per_carton')::integer, (line->>'packs')::integer, 1), 1);
    v_pieces := greatest(coalesce((line->>'pieces_per_pack')::integer, 1), 1);

    if nullif(line->>'product_variant_id', '') is null then
      raise exception 'This line has no product selected. Use "Request new product" for a product that is not yet in the catalogue -- branches can no longer add products directly.';
    end if;

    v_variant := (line->>'product_variant_id')::uuid;
    select pv.product_id into v_product from public.product_variants pv where pv.id = v_variant;
    if v_product is null then raise exception 'Unknown product variant'; end if;

    if nullif(btrim(coalesce(line->>'category_name','')), '') is not null then
      insert into public.product_categories (branch_id, name)
      values (v_branch, btrim(line->>'category_name'))
      on conflict (branch_id, name) do update set name = excluded.name
      returning id into v_category;

      -- A product's category is a fact about the product at this branch, not
      -- about this one delivery -- it is set once and locked, not silently
      -- moved every time it happens to be received under a different name.
      select bpc.category_id into v_existing_category
      from public.branch_product_categorization bpc
      where bpc.branch_id = v_branch and bpc.product_id = v_product;

      if v_existing_category is null then
        insert into public.branch_product_categorization (branch_id, product_id, category_id)
        values (v_branch, v_product, v_category);
      elsif v_existing_category <> v_category then
        select pc.name into v_existing_category_name
        from public.product_categories pc
        where pc.id = v_existing_category;
        raise exception 'This product does not belong to the category you chose. It belongs to "%" for this branch -- choose "%", or ask an admin to recategorize it first.',
          v_existing_category_name, v_existing_category_name;
      end if;
      -- else: already filed under this same category, nothing to change.
    end if;

    v_batch := public.create_stock_batch_with_barcodes(
      v_variant, v_branch, v_supplier, nullif(btrim(coalesce(line->>'manufacturer_name','')), ''),
      v_delivery, v_code, v_user, btrim(line->>'batch_number'), (line->>'expiry_date')::date,
      (line->>'cost_price')::numeric, (line->>'selling_price')::numeric, v_cartons, v_packs, v_pieces
    );
  end loop;

  return query select v_delivery, v_code;
end;
$$;

-- Signature unchanged -- plain create or replace.


create or replace function public.upsert_patient(
  p_full_name text, p_gender text, p_age integer, p_phone text, p_tin text default null, p_branch_id uuid default null
)
returns uuid
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_user   uuid := (select auth.uid());
  v_branch uuid;
  v_phone  text := nullif(btrim(coalesce(p_phone, '')), '');
  v_tin    text := nullif(btrim(coalesce(p_tin, '')), '');
  v_id     uuid;
begin
  v_branch := public.effective_branch_id(p_branch_id);
  if v_branch is null then raise exception 'Only an active branch user may record a patient'; end if;
  perform public.assert_can_manage_org_branch_or_own(v_branch, public.current_branch_id());
  if nullif(btrim(coalesce(p_full_name, '')), '') is null then raise exception 'A patient name is required'; end if;
  if v_phone is null then raise exception 'A phone number is required'; end if;
  if p_gender is not null and p_gender not in ('male','female','other') then raise exception 'Unknown gender'; end if;

  insert into public.patients (branch_id, full_name, gender, age, tin_or_phone, phone, tin, created_by)
  values (v_branch, btrim(p_full_name), p_gender, p_age, v_phone, v_phone, v_tin, v_user)
  on conflict (branch_id, tin_or_phone)
  do update set
    full_name  = excluded.full_name,
    gender     = excluded.gender,
    age        = excluded.age,
    phone      = excluded.phone,
    -- Never blank an existing TIN just because this visit did not retype it.
    tin        = coalesce(excluded.tin, public.patients.tin),
    updated_at = now()
  returning id into v_id;

  return v_id;
end;
$$;

-- Signature unchanged -- plain create or replace.
