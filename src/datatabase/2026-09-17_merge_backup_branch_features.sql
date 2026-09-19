-- ============================================================================
-- MERGE: personal "backup" branch work × origin/main's multi-branch/org work
-- ============================================================================
-- Two lines of work touched the SAME functions independently since they last
-- shared a common ancestor (2026-09-08):
--
--   origin/main (this repo, colleague's work, 2026-09-09 .. 2026-09-16):
--     multi-branch organizations/RBAC -- complete_sale(), upsert_patient(),
--     find_patient_by_identifier(), list_branch_patients() all gained a
--     trailing `p_branch_id uuid default null` resolved via
--     public.effective_branch_id(p_branch_id) + a
--     public.assert_can_manage_org_branch_or_own() permission check, so an
--     org_owner/org_manager can act on a branch they don't belong to.
--     (Sources: 2026-09-11_view_branch_as_org_owner.sql,
--     2026-09-11_view_branch_as_org_owner_writes.sql,
--     2026-09-15_org_manager_precedence_over_owner.sql.)
--
--   personal backup branch (pharmacy_sync-backup, same window): insurance
--     bulk import + mandatory patient recording + just-in-time onboarding --
--     complete_sale() gained p_bargain_final_price/p_patient_coverage_
--     percentage and a fixed per-provider/variant price lookup
--     (insurance_variant_prices), and a patient is now required whenever
--     insurance is used. upsert_patient()/find_patient_by_identifier()/
--     list_branch_patients() all gained insurance_number. get_public_receipt()
--     was fixed to report the real discount-aware total instead of the
--     pre-discount line-item sum, and gained receipt_note.
--
-- Neither side knew about the other's change, so CREATE OR REPLACE alone
-- would silently drop whichever side's parameters aren't in the version that
-- happens to run last. This file is the reconciliation: every function below
-- carries BOTH sides' parameters and logic. Apply this AFTER both
-- pharmacy_schema_consolidated.sql and every dated migration file already in
-- this folder -- it is intentionally the last word on these five functions.
--
-- Safe to re-run: every statement is CREATE OR REPLACE (functions) or DROP
-- FUNCTION IF EXISTS + CREATE (where the parameter list changed in a way
-- PostgreSQL can't reconcile in place -- inserting p_branch_id before an
-- already-trailing parameter, not just appending one).
-- ============================================================================

-- ── find_patient_by_identifier: branch-scoped (org) + insurance_number ──────
-- Drops both prior signatures -- whichever one is actually live (the plain
-- 1-arg version if only the backup branch's work ever ran here, or origin's
-- already-branch-scoped 2-arg version if that ran first), since either one
-- blocks CREATE OR REPLACE from adding insurance_number to the return type.

drop function if exists public.find_patient_by_identifier(text);
drop function if exists public.find_patient_by_identifier(text, uuid);

create or replace function public.find_patient_by_identifier(p_identifier text, p_branch_id uuid default null)
returns table(id uuid, full_name text, gender text, age integer, tin_or_phone text, phone text, tin text, insurance_number text)
language sql
stable
security definer
set search_path = ''
as $$
  select p.id, p.full_name::text, p.gender::text, p.age,
         p.tin_or_phone::text, p.phone::text, p.tin::text, p.insurance_number::text
  from public.patients p
  where p.branch_id = public.effective_branch_id(p_branch_id)
    and (p.tin_or_phone = btrim(p_identifier)
      or p.phone        = btrim(p_identifier)
      or p.tin          = btrim(p_identifier))
  limit 1
$$;

revoke all on function public.find_patient_by_identifier(text, uuid) from public, anon;
grant execute on function public.find_patient_by_identifier(text, uuid) to authenticated;

-- ── list_branch_patients: branch-scoped (org) + insurance_number ────────────
-- Same reasoning as find_patient_by_identifier above: drop both possible
-- prior signatures before redefining the return type.

drop function if exists public.list_branch_patients();
drop function if exists public.list_branch_patients(uuid);

create or replace function public.list_branch_patients(p_branch_id uuid default null)
returns table(
  id uuid, full_name text, gender text, age integer, tin_or_phone text,
  phone text, tin text, insurance_number text, visit_count integer, last_visit_at timestamptz, lifetime_spend numeric
)
language sql
stable
security definer
set search_path = ''
as $$
  select
    p.id, p.full_name::text, p.gender::text, p.age, p.tin_or_phone::text,
    p.phone::text, p.tin::text, p.insurance_number::text,
    count(s.id)::integer, max(s.sold_at), coalesce(sum(s.total_amount), 0)
  from public.patients p
  left join public.sales s on s.patient_id = p.id
  where p.branch_id = public.effective_branch_id(p_branch_id)
  group by p.id, p.full_name, p.gender, p.age, p.tin_or_phone, p.phone, p.tin, p.insurance_number
  order by max(s.sold_at) desc nulls last, p.full_name
$$;

revoke all on function public.list_branch_patients(uuid) from public, anon;
grant execute on function public.list_branch_patients(uuid) to authenticated;

-- ── upsert_patient: branch-scoped (org) + insurance_number ──────────────────

drop function if exists public.upsert_patient(text, text, integer, text, text);
drop function if exists public.upsert_patient(text, text, integer, text, text, text);
drop function if exists public.upsert_patient(text, text, integer, text, text, uuid);

create or replace function public.upsert_patient(
  p_full_name text, p_gender text, p_age integer, p_phone text, p_tin text default null,
  p_branch_id uuid default null, p_insurance_number text default null
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
  v_ins    text := nullif(btrim(coalesce(p_insurance_number, '')), '');
  v_id     uuid;
begin
  v_branch := public.effective_branch_id(p_branch_id);
  if v_branch is null then raise exception 'Only an active branch user may record a patient'; end if;
  perform public.assert_can_manage_org_branch_or_own(v_branch, public.current_branch_id());
  if nullif(btrim(coalesce(p_full_name, '')), '') is null then raise exception 'A patient name is required'; end if;
  if v_phone is null then raise exception 'A phone number is required'; end if;
  if p_gender is not null and p_gender not in ('male','female','other') then raise exception 'Unknown gender'; end if;

  insert into public.patients (branch_id, full_name, gender, age, tin_or_phone, phone, tin, insurance_number, created_by)
  values (v_branch, btrim(p_full_name), p_gender, p_age, v_phone, v_phone, v_tin, v_ins, v_user)
  on conflict (branch_id, tin_or_phone)
  do update set
    full_name  = excluded.full_name,
    gender     = excluded.gender,
    age        = excluded.age,
    phone      = excluded.phone,
    -- Never blank an existing value just because this visit did not retype it.
    tin              = coalesce(excluded.tin, public.patients.tin),
    insurance_number = coalesce(excluded.insurance_number, public.patients.insurance_number),
    updated_at = now()
  returning id into v_id;

  return v_id;
end;
$$;

revoke all on function public.upsert_patient(text, text, integer, text, text, uuid, text) from public, anon;
grant execute on function public.upsert_patient(text, text, integer, text, text, uuid, text) to authenticated;

-- ── get_public_receipt: no branch-scoping needed (deliberately unauthenticated,
-- filtered only by p_sale_id on both sides) -- just needs backup's discount-
-- aware total + receipt_note fix to be the final word. Signature unchanged
-- from either side, so plain CREATE OR REPLACE is enough.

create or replace function public.get_public_receipt(p_sale_id uuid)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_branch_id uuid;
  v_cashier_id uuid;
  v_patient_id uuid;
  v_receipt_note text;
  v_total_amount numeric;

  v_receipt_number text;
  v_issued_at timestamptz;

  v_branch_name text;
  v_branch_tin text;
  v_branch_address text;
  v_branch_phone text;
  v_branch_logo_path text;
  v_branch_bank_account_number text;
  v_branch_bank_account_name text;
  v_branch_momo_pay_number text;

  v_cashier_name text;

  v_patient_name text;
  v_patient_gender text;
  v_patient_age integer;
  v_patient_contact text;

  v_provider_id uuid;
  v_provider_name text;

  v_items jsonb;
  v_subtotal numeric;
  v_tax_total numeric;
  v_insurance_total numeric;
  v_discount_amount numeric;
  v_final_owed numeric;
begin
  -- No auth.uid()/branch check here on purpose -- p_sale_id is the only
  -- filter, by design.
  select s.branch_id, s.cashier_id, s.patient_id, s.receipt_note, s.total_amount
    into v_branch_id, v_cashier_id, v_patient_id, v_receipt_note, v_total_amount
    from public.sales s
    where s.id = p_sale_id;

  if not found then
    return null; -- unknown sale id -- caller shows a "not found" state
  end if;

  select r.receipt_number, r.issued_at
    into v_receipt_number, v_issued_at
    from public.receipts r
    where r.sale_id = p_sale_id;

  if not found then
    return null; -- sale exists but has no receipt row (shouldn't happen once complete_sale() has run) -- fail closed
  end if;

  select b.name, b.tin, b.address, b.phone, b.logo_path,
         b.bank_account_number, b.bank_account_name, b.momo_pay_number
    into v_branch_name, v_branch_tin, v_branch_address, v_branch_phone, v_branch_logo_path,
         v_branch_bank_account_number, v_branch_bank_account_name, v_branch_momo_pay_number
    from public.branches b
    where b.id = v_branch_id;

  select u.full_name into v_cashier_name
    from public.users u
    where u.id = v_cashier_id;

  if v_patient_id is not null then
    select p.full_name, p.gender, p.age, p.tin_or_phone
      into v_patient_name, v_patient_gender, v_patient_age, v_patient_contact
      from public.patients p
      where p.id = v_patient_id;
  end if;

  select ic.insurance_provider_id into v_provider_id
    from public.insurance_claims ic
    where ic.sale_id = p_sale_id;

  if v_provider_id is not null then
    select ip.name into v_provider_name
      from public.insurance_providers ip
      where ip.id = v_provider_id;
  end if;

  -- Mirrors getSaleReceipt()'s per-item tax math exactly:
  -- taxAmount = round(subtotal * rate_percentage) / 100 (subtotal is the
  -- already-extracted pre-tax base -- see 2026-08-28_vat_inclusive_tax.sql).
  select
    coalesce(jsonb_agg(
      jsonb_build_object(
        'code', bc.code,
        'productName', coalesce(pr.name, 'Unknown product'),
        'dosage', pv.dosage,
        'form', pv.form,
        'quantity', si.quantity,
        'unitPrice', si.unit_price,
        'subtotal', si.subtotal,
        'taxRatePercentage', tr.rate_percentage,
        'taxAmount', round(si.subtotal * tr.rate_percentage) / 100,
        'insuranceCovered', si.insurance_covered_amount,
        'patientOwed', si.subtotal + round(si.subtotal * tr.rate_percentage) / 100 - si.insurance_covered_amount
      )
      order by si.id
    ), '[]'::jsonb),
    coalesce(sum(si.subtotal), 0),
    coalesce(sum(round(si.subtotal * tr.rate_percentage) / 100), 0),
    coalesce(sum(si.insurance_covered_amount), 0)
    into v_items, v_subtotal, v_tax_total, v_insurance_total
    from public.sale_items si
    join public.barcodes bc on bc.id = si.barcode_id
    join public.tax_rates tr on tr.id = si.tax_rate_id
    join public.stock_batches sb on sb.id = bc.stock_batch_id
    join public.product_variants pv on pv.id = sb.product_variant_id
    join public.products pr on pr.id = pv.product_id
    where si.sale_id = p_sale_id;

  -- The real charged total (post-discount/bargain) beats the pre-discount
  -- line-item sum whenever sales.total_amount is actually set.
  v_final_owed := coalesce(v_total_amount, v_subtotal + v_tax_total - v_insurance_total);
  v_discount_amount := greatest(0, (v_subtotal + v_tax_total - v_insurance_total) - v_final_owed);

  return jsonb_build_object(
    'saleId', p_sale_id,
    'receiptNumber', v_receipt_number,
    'issuedAt', v_issued_at,
    'branchName', coalesce(v_branch_name, '—'),
    'branchTin', v_branch_tin,
    'branchAddress', v_branch_address,
    'branchPhone', v_branch_phone,
    'branchLogoPath', v_branch_logo_path,
    'branchBankAccountNumber', v_branch_bank_account_number,
    'branchBankAccountName', v_branch_bank_account_name,
    'branchMomoPayNumber', v_branch_momo_pay_number,
    'cashierName', coalesce(v_cashier_name, '—'),
    'patientName', v_patient_name,
    'patientGender', v_patient_gender,
    'patientAge', v_patient_age,
    'patientContact', v_patient_contact,
    'insuranceProviderName', v_provider_name,
    'items', v_items,
    'subtotal', v_subtotal,
    'taxTotal', v_tax_total,
    'insuranceCoveredTotal', v_insurance_total,
    'discountAmount', v_discount_amount,
    'patientOwedTotal', v_final_owed - v_insurance_total,
    'grandTotal', v_final_owed,
    'receiptNote', v_receipt_note,
    -- TODO: once complete_sale()/VSDC submission stores EBM fields on
    -- public.receipts, select and return those columns here instead of
    -- nulls, mirroring the same TODO in getSaleReceipt() (src/lib/sales.ts).
    'ebmSdcId', null,
    'ebmMrcNo', null,
    'ebmReceiptSignature', null,
    'ebmInvoiceNumber', null
  );
end;
$$;

revoke all on function public.get_public_receipt(uuid) from public;
grant execute on function public.get_public_receipt(uuid) to anon, authenticated;

-- ── complete_sale: branch-scoped (org) + bargain/coverage/mandatory-patient/
-- fixed insurance pricing, all together ─────────────────────────────────────

drop function if exists public.complete_sale(jsonb, uuid, uuid, text, uuid);
drop function if exists public.complete_sale(jsonb, uuid, uuid, text, uuid, uuid);
drop function if exists public.complete_sale(jsonb, uuid, uuid, text, uuid, numeric, numeric);

create or replace function public.complete_sale(
  p_lines jsonb, p_insurance_provider_id uuid default null, p_patient_id uuid default null,
  p_payment_method text default null, p_discount_id uuid default null, p_branch_id uuid default null,
  p_bargain_final_price numeric default null, p_patient_coverage_percentage numeric default null
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
  v_effective_price numeric;
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

  if p_bargain_final_price is not null then
    if p_insurance_provider_id is not null then
      raise exception 'A bargained price only applies to walk-in sales, not insurance sales';
    end if;
    if p_discount_id is not null then
      raise exception 'Use either a bargained price or a discount code, not both';
    end if;
    if p_bargain_final_price < 0 then
      raise exception 'Bargained price cannot be negative';
    end if;
  end if;

  if p_patient_coverage_percentage is not null then
    if p_insurance_provider_id is null then
      raise exception 'A patient coverage percentage only applies to an insurance sale';
    end if;
    if p_patient_coverage_percentage < 0 or p_patient_coverage_percentage > 100 then
      raise exception 'Patient coverage percentage must be between 0 and 100';
    end if;
  end if;

  if p_insurance_provider_id is not null then
    select name into v_provider_name from public.insurance_providers where id = p_insurance_provider_id;
    if v_provider_name is null then raise exception 'Unknown insurance provider'; end if;
    if p_patient_id is null then
      raise exception 'A patient must be recorded for an insurance sale';
    end if;
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
    elsif p_patient_coverage_percentage is not null then
      -- Pharmacist-entered override for this specific sale/patient visit --
      -- real coverage varies by the PATIENT'S own plan, not by product, so
      -- this takes priority over any per-product/provider default below.
      v_coverage_pct := 100 - p_patient_coverage_percentage;
    else
      select coverage_percentage into v_coverage_pct
        from public.insurance_product_coverage
        where insurance_provider_id = p_insurance_provider_id and product_id = v_product_id;
      if v_coverage_pct is null then
        select default_coverage_percentage into v_coverage_pct
          from public.insurance_providers where id = p_insurance_provider_id;
      end if;
    end if;

    -- Fixed insurance price, if one is on file for this exact provider +
    -- variant; otherwise the normal walk-in price, unchanged.
    if p_insurance_provider_id is null then
      v_effective_price := v_barcode.selling_price;
    else
      select fixed_price into v_effective_price
        from public.insurance_variant_prices
        where insurance_provider_id = p_insurance_provider_id and product_variant_id = v_barcode.product_variant_id;
      if v_effective_price is null then
        v_effective_price := v_barcode.selling_price;
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

      v_line_total := v_effective_price * v_child_quantity;
      v_tax_amount := round(v_line_total * coalesce(v_tax_pct, 0) / (100 + coalesce(v_tax_pct, 0)), 2);
      v_subtotal := v_line_total - v_tax_amount;
      v_line_covered := round(v_line_total * coalesce(v_coverage_pct, 0) / 100, 2);

      insert into public.sale_items (sale_id, barcode_id, tax_rate_id, quantity, unit_price, subtotal, insurance_covered_amount)
      values (v_sale, v_barcode.id, v_tax_rate_id, v_child_quantity, v_effective_price, v_subtotal, v_line_covered);

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
          v_line_total := v_effective_price * v_child.pieces_per_pack;
          v_tax_amount := round(v_line_total * coalesce(v_tax_pct, 0) / (100 + coalesce(v_tax_pct, 0)), 2);
          v_subtotal := v_line_total - v_tax_amount;
          v_line_covered := round(v_line_total * coalesce(v_coverage_pct, 0) / 100, 2);

          insert into public.sale_items (sale_id, barcode_id, tax_rate_id, quantity, unit_price, subtotal, insurance_covered_amount)
          values (v_sale, v_child.id, v_tax_rate_id, v_child.pieces_per_pack, v_effective_price, v_subtotal, v_line_covered);

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
          v_line_total := v_effective_price * v_child.pieces_per_pack;
          v_tax_amount := round(v_line_total * coalesce(v_tax_pct, 0) / (100 + coalesce(v_tax_pct, 0)), 2);
          v_subtotal := v_line_total - v_tax_amount;
          v_line_covered := round(v_line_total * coalesce(v_coverage_pct, 0) / 100, 2);

          insert into public.sale_items (sale_id, barcode_id, tax_rate_id, quantity, unit_price, subtotal, insurance_covered_amount)
          values (v_sale, v_child.id, v_tax_rate_id, v_child.pieces_per_pack, v_effective_price, v_subtotal, v_line_covered);

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

        v_line_total := v_effective_price * v_quantity;
        v_tax_amount := round(v_line_total * coalesce(v_tax_pct, 0) / (100 + coalesce(v_tax_pct, 0)), 2);
        v_subtotal := v_line_total - v_tax_amount;
        v_line_covered := round(v_line_total * coalesce(v_coverage_pct, 0) / 100, 2);

        insert into public.sale_items (sale_id, barcode_id, tax_rate_id, quantity, unit_price, subtotal, insurance_covered_amount)
        values (v_sale, v_child.id, v_tax_rate_id, v_quantity, v_effective_price, v_subtotal, v_line_covered);

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
  elsif p_bargain_final_price is not null then
    -- v_covered_total is always 0 here (insurance + bargain are mutually
    -- exclusive, enforced above), so this is just v_total - the agreed price.
    v_discount_amount := greatest(v_total - p_bargain_final_price, 0);
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

revoke all on function public.complete_sale(jsonb, uuid, uuid, text, uuid, uuid, numeric, numeric) from public, anon;
grant execute on function public.complete_sale(jsonb, uuid, uuid, text, uuid, uuid, numeric, numeric) to authenticated;
