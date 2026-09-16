-- ============================================================================
-- Branch Manager gets Branch Settings + History (minus billing/legal)
-- ============================================================================
-- Run once, any time after 2026-09-11_view_branch_as_org_owner.sql. Idempotent.
--
-- The frontend now shows a branch `manager` the Branch Settings and History
-- nav items (previously owner-only), so they can invite/deactivate sellers
-- and see their own branch's activity -- closing the gap between what
-- branchSettings.roleDescManager has always promised ("staff oversight")
-- and what the UI actually let a manager reach. This file is the server-side
-- half: the two RPCs those pages call still need widening, and -- since this
-- schema never relies on frontend hiding alone -- update_branch_details()
-- itself now enforces that a manager's billing/legal fields never change,
-- no matter what a client sends.
-- ============================================================================

-- Same signature as the version in pharmacy_schema_consolidated.sql -- plain
-- create or replace, no drop needed. Widens 'owner' to 'owner'/'manager', and
-- makes every billing/legal column ignore the incoming parameter entirely
-- when the caller is a manager, keeping the column's current value instead.
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
  p_default_reorder_min integer default null
)
returns void
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_branch uuid;
  v_caller_role text;
begin
  select u.branch_id, u.role into v_branch, v_caller_role
  from public.users u
  where u.id = (select auth.uid()) and u.is_active and u.role in ('owner', 'manager');
  if v_branch is null then raise exception 'Only the branch owner or manager may update branch settings'; end if;

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
      -- Billing/legal columns: a manager's own current value always wins,
      -- regardless of what was sent -- this is the actual enforcement of
      -- "cannot change billing or legal settings", not just a hidden field.
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

revoke all on function public.update_branch_details(text, text, text, text, text, text, text, integer, text, text, text, text, date, text, text, text, boolean, boolean, boolean, boolean, boolean, text, boolean, boolean, boolean, integer, integer) from public, anon;
grant execute on function public.update_branch_details(text, text, text, text, text, text, text, integer, text, text, text, text, date, text, text, text, boolean, boolean, boolean, boolean, boolean, text, boolean, boolean, boolean, integer, integer) to authenticated;


-- Same signature as 2026-09-11_view_branch_as_org_owner.sql's version -- plain
-- create or replace. Only the own-branch path (p_branch_id is null) changes:
-- 'owner' widens to 'owner'/'manager'. The effective_branch_id() org
-- view-as-branch path (p_branch_id supplied) is untouched.
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
    where u.id = (select auth.uid()) and u.is_active and u.role in ('owner', 'manager');
  else
    v_branch := public.effective_branch_id(p_branch_id);
  end if;
  if v_branch is null then
    raise exception 'Only the branch owner or manager may view the full history';
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
