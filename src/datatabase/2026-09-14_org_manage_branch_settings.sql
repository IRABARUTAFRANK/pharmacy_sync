-- ============================================================================
-- org_owner/org_manager can fully manage a branch's Settings while viewing it
-- ============================================================================
-- Run once, after 2026-09-14_branch_manager_settings_access.sql and
-- 2026-09-11_view_branch_as_org_owner(_writes).sql. Idempotent.
--
-- The "view branch as org owner" work let an org_owner/org_manager view and
-- operate a specific branch's sales, receiving, discounts, categories,
-- patients -- but never that branch's own Settings page (Profile, POS,
-- Inventory, Alerts, Users & Roles). Every one of those either resolved
-- "which branch" from the caller's OWN users.branch_id directly (no
-- effective_branch_id() involved at all), or wasn't a real RPC yet
-- (list_branch_staff was a plain client-side select). This file closes that
-- gap, so org_owner and org_manager finally have the same branch-settings
-- reach the ask calls for ("org_manager must manage branch settings same as
-- org_owner").
--
-- Shared pattern for every write function below: resolve your OWN home
-- branch + role first (same query as before, unchanged), then resolve the
-- TARGET branch via effective_branch_id(p_branch_id). If the target is your
-- own branch, nothing changes -- your real role still governs (an org_owner
-- who also happens to run their own branch as its 'owner' keeps full access
-- there; a plain branch 'manager' keeps the billing/legal restriction from
-- 2026-09-14_branch_manager_settings_access.sql). If the target is a
-- DIFFERENT branch, effective_branch_id() has already proven you're an
-- org_owner/org_manager of that branch's organization (it calls
-- assert_org_member() internally) -- that authority is full settings access
-- there, same as the branch's own real owner, so the effective role for
-- every gate below becomes 'owner'.
-- ============================================================================


-- ============================================================================
-- SECTION 1 — Branch Settings itself (Profile/POS/Inventory/Alerts + billing/
-- legal gate)
-- ============================================================================

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


drop function if exists public.update_branch_details(
  text, text, text, text, text, text, text, integer, text, text, text, text, date, text, text, text,
  boolean, boolean, boolean, boolean, boolean, text, boolean, boolean, boolean, integer, integer
);
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

revoke all on function public.update_branch_details(
  text, text, text, text, text, text, text, integer, text, text, text, text, date, text, text, text,
  boolean, boolean, boolean, boolean, boolean, text, boolean, boolean, boolean, integer, integer, uuid
) from public, anon;
grant execute on function public.update_branch_details(
  text, text, text, text, text, text, text, integer, text, text, text, text, date, text, text, text,
  boolean, boolean, boolean, boolean, boolean, text, boolean, boolean, boolean, integer, integer, uuid
) to authenticated;


-- ============================================================================
-- SECTION 2 — Categories & discounts lists (create/update already had
-- p_branch_id from 2026-09-11_view_branch_as_org_owner_writes.sql -- only the
-- two LIST reads were missed)
-- ============================================================================

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


-- ============================================================================
-- SECTION 3 — Users & Roles tab: list, deactivate/reactivate, change role
-- ============================================================================
-- list_branch_staff was never an RPC -- BranchSettingsPage read
-- public.users directly, relying on the "users read own branch" RLS policy,
-- which has no org-member clause and so only ever covered your own branch.
-- Promoted to a real RPC here, same effective_branch_id() pattern as
-- everything else in this file. Creating a staff login (invite) already
-- supports staffing a different org branch end-to-end via
-- create-branch-seller's existing isOrgStaffingPath -- only the client was
-- never passing a branchId to it; that's a frontend-only fix.

create or replace function public.list_branch_staff(p_branch_id uuid default null)
returns table(id uuid, full_name text, email text, role text, is_active boolean, created_at timestamptz)
language sql
stable
security definer
set search_path = ''
as $$
  select u.id, u.full_name::text, u.email::text, u.role::text, u.is_active, u.created_at
  from public.users u
  where u.branch_id = public.effective_branch_id(p_branch_id)
  order by u.role, u.full_name
$$;

revoke all on function public.list_branch_staff(uuid) from public, anon;
grant execute on function public.list_branch_staff(uuid) to authenticated;


drop function if exists public.admin_set_seller_active(uuid, boolean);
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

revoke all on function public.admin_set_seller_active(uuid, boolean, uuid) from public, anon;
grant execute on function public.admin_set_seller_active(uuid, boolean, uuid) to authenticated;


-- Own-branch behavior is unchanged (owner-only, exactly as before); the new
-- capability is only for a DIFFERENT branch, where effective_branch_id()
-- already proved org_owner/org_manager standing.
drop function if exists public.admin_update_staff_role(uuid, text);
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

revoke all on function public.admin_update_staff_role(uuid, text, uuid) from public, anon;
grant execute on function public.admin_update_staff_role(uuid, text, uuid) to authenticated;
