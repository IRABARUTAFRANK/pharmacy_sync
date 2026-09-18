-- ============================================================================
-- BRANCH MANAGER FIELD RESTRICTIONS -- when the branch belongs to an
-- organization, a branch manager only owns their branch's PROFILE identity
-- fields narrowly (phone, address/location, logo) -- name, email, and
-- website are owned by whoever set the branch up (org_owner/org_manager)
-- instead. Every other setting -- default language, the whole POS tab
-- (receipt prefix, payment-method toggles, sale rules), Inventory (expiry
-- threshold, default recorder minimum), the out-of-stock reminder
-- interval, Categories, Users and roles, Storage Locations, and Alerts --
-- is deliberately NOT restricted: those are day-to-day operational
-- settings, not "branch configuration" in the sense this restriction is
-- about, so a manager keeps full control of them regardless of
-- organization.
-- ============================================================================
-- update_branch_details() already had a NARROWER owner-only carve-out (see
-- 2026-09-16_catch_up_full_state.sql -- Finance fields (bank/momo) and the
-- Legal card (TIN/license/EBM) were already locked to the branch's own
-- 'owner' role, for every branch regardless of organization). This widens
-- that carve-out specifically for a branch that belongs to an organization:
-- a 'manager' at such a branch (acting on THEIR OWN branch -- an org_owner/
-- org_manager editing a DIFFERENT branch via effective_branch_id() still
-- gets full authority, unchanged, via the same v_caller_role computation
-- the function already does) can still change everything except name,
-- email, and website, which are silently kept at their existing value,
-- exactly like the Finance/Legal fields already were, rather than raising
-- an error (the frontend simply won't render those three fields as
-- editable for this caller, so this is defense in depth, not the primary
-- UX).
--
-- A manager at a STANDALONE branch (organization_id is null -- hired
-- directly by that branch's own owner, not by an org role) is unaffected:
-- they keep exactly the access they already had, since there is no org
-- owner/manager "above" them to own that configuration instead.
-- ============================================================================

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
  v_target_org uuid;
  v_org_restricted boolean;
begin
  select u.branch_id, u.role into v_own_branch, v_own_role
  from public.users u
  where u.id = (select auth.uid()) and u.is_active and u.role in ('owner', 'manager');
  if v_own_branch is null then raise exception 'Only the branch owner or manager may update branch settings'; end if;

  v_branch := public.effective_branch_id(p_branch_id);
  if v_branch is null then raise exception 'No active branch for this session'; end if;
  perform public.assert_can_manage_org_branch_or_own(v_branch, v_own_branch);
  v_caller_role := case when v_branch = v_own_branch then v_own_role else 'owner' end;

  select organization_id into v_target_org from public.branches where id = v_branch;
  -- A manager acting on their OWN organization-affiliated branch: everything
  -- except address/phone/latitude/longitude stays fixed at its current
  -- value below. An org_owner/org_manager editing another branch was
  -- already normalized to v_caller_role = 'owner' above, so this never
  -- applies to them regardless of that branch's organization.
  v_org_restricted := v_caller_role <> 'owner' and v_target_org is not null;

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
      name = case when v_org_restricted then name
        else coalesce(nullif(btrim(coalesce(p_name, '')), ''), name) end,
      email = case when v_org_restricted then email
        when p_email is null then email else nullif(btrim(p_email), '') end,
      website = case when v_org_restricted then website
        when p_website is null then website else nullif(btrim(p_website), '') end,
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
-- get_my_branch_details() -- widened with organization_id so the frontend
-- (BranchSettingsPage.tsx) can tell whether ITS OWN branch is org-affiliated
-- and render the restricted fields above as read-only for a manager there.
-- Same body as 2026-09-16_catch_up_full_state.sql otherwise.
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
  latitude double precision, longitude double precision,
  organization_id uuid
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
         b.latitude, b.longitude,
         b.organization_id
  from public.branches b
  where b.id = public.effective_branch_id(p_branch_id)
$$;

revoke all on function public.get_my_branch_details(uuid) from public, anon;
grant execute on function public.get_my_branch_details(uuid) to authenticated;
