-- ============================================================================
-- PESAPAL / MOBILE MONEY & CARD PAYMENTS
-- ============================================================================
-- Adds a real payment-gateway path (Mobile Money via MTN/Airtel, and Card)
-- alongside the existing cash flow. Cash is untouched: complete_sale() still
-- does exactly what it always did, synchronously, no gateway involved.
--
-- The gateway path needs something cash never needed: a place to hold a
-- payment attempt BEFORE a sale exists, since Pesapal confirms mobile money/
-- card payments asynchronously (the customer approves on their own phone or
-- Pesapal's hosted page, which can take anywhere from seconds to a couple of
-- minutes) -- pending_payments below is that holding table. A row here is a
-- real, persisted attempt (not in-memory state), so it survives a seller's
-- browser refresh while waiting.
--
-- PROVIDER-AGNOSTIC BY DESIGN: nothing in this table, or in complete_sale()/
-- _execute_sale()/_price_sale_lines()/resolve_pending_payment() below,
-- mentions Pesapal or pawaPay by name. All the provider-specific HTTP/API
-- work (Pesapal's auth tokens/SubmitOrderRequest/GetTransactionStatus/IPN
-- registration; pawaPay's deposits/check-status/callback) lives entirely in
-- each provider's own Edge Function (supabase/functions/pesapal-payment/,
-- supabase/functions/pawapay-payment/), never in SQL. create_pending_
-- payment() takes which provider to use as a plain parameter (p_provider),
-- stored in the `provider` column below -- that column, and the caller
-- choosing what to pass it, is the ONLY place a provider is selected;
-- resolve_pending_payment() and every RPC after it never care which one a
-- given row used.
--
-- THE CORE CORRECTNESS RULE THIS FILE ENFORCES: stock and the real sales/
-- sale_items/receipts rows are only ever written on CONFIRMED payment
-- success -- never optimistically, never "probably fine." That's why the
-- pricing that decides what to charge (create_pending_payment, via
-- _price_sale_lines) and the pricing that actually runs at confirmation time
-- (resolve_pending_payment, via _execute_sale) are two separate, server-
-- authoritative computations that are then cross-checked against each other
-- before a sale is ever written -- see resolve_pending_payment()'s own
-- comment for what happens if they disagree.
-- ============================================================================

create table if not exists public.pending_payments (
  id uuid primary key default gen_random_uuid(),
  branch_id uuid not null references public.branches(id),
  cashier_id uuid not null references public.users(id),

  -- Exactly what _execute_sale() needs (p_lines/p_insurance_provider_id/
  -- p_patient_id/p_discount_id), frozen at the moment payment was initiated
  -- -- so resolving payment later never re-reads a cart that may have
  -- changed or vanished from the seller's screen.
  cart_snapshot jsonb not null,

  patient_phone varchar(30),
  payment_method varchar(20) not null check (payment_method in ('mtn_momo','airtel_money','card')),
  amount numeric(12,2) not null check (amount >= 0),
  currency varchar(3) not null default 'RWF',

  -- PROVIDER-AGNOSTIC: reserved from day one. Only 'pesapal' is used today;
  -- adding 'pawapay' later never requires a migration.
  provider varchar(20) not null default 'pesapal' check (provider in ('pesapal','pawapay')),

  -- Our own reference, generated here, handed to the provider as ITS
  -- "merchant reference" field (Pesapal's `id` on SubmitOrderRequest). A
  -- retry after failure always gets a brand-new row/reference -- never
  -- reused, matching Pesapal's own uniqueness requirement for that field.
  merchant_reference text not null unique,

  -- The provider's own tracking id for this attempt (Pesapal's
  -- order_tracking_id). Null until the provider's order-submission call
  -- returns it.
  provider_reference text,

  status varchar(20) not null default 'pending' check (status in ('pending','success','failed','expired')),

  -- Set only once status flips to 'success' -- the real sales.id
  -- _execute_sale() produced. Lets the frontend poll one row and know
  -- exactly which receipt to show, and gives reconciliation a direct link
  -- from payment attempt to sale.
  sale_id uuid references public.sales(id),

  -- Last raw status payload from the provider, kept for debugging/
  -- reconciliation only -- resolve_pending_payment() below is always the
  -- one place status itself is decided, never a client reading this column.
  provider_status_payload jsonb,

  failure_reason text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create index if not exists pending_payments_branch_status_idx
  on public.pending_payments (branch_id, status, created_at);
create unique index if not exists pending_payments_provider_reference_idx
  on public.pending_payments (provider, provider_reference) where provider_reference is not null;

alter table public.pending_payments enable row level security;

drop policy if exists pending_payments_select on public.pending_payments;
create policy pending_payments_select on public.pending_payments for select
  using (
    branch_id = public.current_branch_id()
    or public.is_org_member_or_own_branch_in_org((select organization_id from public.branches where id = pending_payments.branch_id))
    or public.is_super_admin()
  );

-- No insert/update/delete policy for authenticated at all -- every write
-- happens inside a security-definer RPC below (create_pending_payment for
-- the initial row, resolve_pending_payment for every status transition),
-- never a direct client write. A plain authenticated client literally
-- cannot mark its own payment "success".

revoke all on public.pending_payments from anon, authenticated;
grant select on public.pending_payments to authenticated;


-- ============================================================================
-- _execute_sale() -- the real sale-writing logic, extracted verbatim from
-- complete_sale() (2026-09-15_org_manager_precedence_over_owner.sql) so cash
-- and gateway payments share EXACTLY one code path for pricing, stock
-- deduction, and writing sales/sale_items/receipts/insurance_claims. Zero
-- duplication here is deliberate: this is the money-writing part, and two
-- copies of it would be two chances to drift apart.
--
-- Takes an already-resolved branch/cashier (unlike complete_sale(), which
-- resolves them from the CURRENT session) because resolve_pending_payment()
-- below calls this long after the original session -- there is no "current
-- user" when Pesapal's IPN arrives, only whichever cashier/branch was
-- recorded on the pending_payments row back when payment was initiated. All
-- authorization for THAT already happened correctly, at create_pending_
-- payment() time, driven by the real logged-in seller. This function still
-- re-checks branch/cashier are active on its own (not just trusting the
-- caller), since minutes can pass between initiating a mobile money payment
-- and Pesapal confirming it.
-- ============================================================================

create or replace function public._execute_sale(
  p_branch uuid, p_cashier uuid, p_lines jsonb,
  p_insurance_provider_id uuid, p_patient_id uuid,
  p_payment_method text, p_discount_id uuid
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
  if not exists (select 1 from public.branches where id = p_branch and status = 'active') then
    raise exception 'This pharmacy is not active';
  end if;
  if not exists (select 1 from public.users where id = p_cashier and branch_id = p_branch and is_active) then
    raise exception 'This cashier is no longer active for this branch';
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
    select 1 from public.patients where id = p_patient_id and branch_id = p_branch
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

  select coalesce(receipt_number_prefix, 'RCT') into v_receipt_prefix from public.branches where id = p_branch;
  v_receipt_number := format('%s-%s-%s', v_receipt_prefix, to_char(now(), 'YYYYMMDD'), upper(substr(replace(gen_random_uuid()::text,'-',''),1,6)));

  insert into public.sales (id, branch_id, cashier_id, patient_id, total_amount)
  values (v_sale, p_branch, p_cashier, p_patient_id, 0);

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
      where upper(bc.code) = v_code and sb.branch_id = p_branch
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

revoke all on function public._execute_sale(uuid, uuid, jsonb, uuid, uuid, text, uuid) from public, anon, authenticated;


-- ============================================================================
-- complete_sale() -- now a thin wrapper: resolve+authorize the CURRENT
-- session's branch/role exactly as before, then hand off to _execute_sale().
-- Behavior for cash is byte-for-byte unchanged from the caller's point of
-- view; same signature, same return shape.
-- ============================================================================

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
declare
  v_branch uuid;
begin
  v_branch := public.effective_branch_id(p_branch_id);
  if v_branch is null then
    raise exception 'Only an active branch user may complete a sale';
  end if;
  perform public.assert_can_manage_org_branch_or_own(v_branch, public.current_branch_id());
  if exists (select 1 from public.branches b where b.id = v_branch and b.status <> 'active') then
    raise exception 'This pharmacy is not active';
  end if;

  return query
    select * from public._execute_sale(v_branch, (select auth.uid()), p_lines, p_insurance_provider_id, p_patient_id, p_payment_method, p_discount_id);
end;
$$;

revoke all on function public.complete_sale(jsonb, uuid, uuid, text, uuid, uuid) from public, anon;
grant execute on function public.complete_sale(jsonb, uuid, uuid, text, uuid, uuid) to authenticated;


-- ============================================================================
-- _price_sale_lines() -- READ-ONLY pricing preview. Same tax/insurance/
-- discount math as _execute_sale() above, deliberately duplicated rather
-- than shared, because this one must never take a `for update` lock or
-- write anything -- it exists purely to answer "what would the patient owe"
-- before any money moves. See _execute_sale() -- if the per-line pricing
-- rules ever change there, mirror the change here too.
-- ============================================================================

create or replace function public._price_sale_lines(
  p_branch uuid, p_lines jsonb, p_insurance_provider_id uuid, p_discount_id uuid
)
returns table(total_amount numeric, insurance_covered_total numeric, patient_owed_total numeric)
language plpgsql
security definer
set search_path = ''
as $$
#variable_conflict use_column
declare
  line jsonb;
  v_code text;
  v_mode text;
  v_quantity integer;
  v_barcode record;
  v_child_quantity integer;
  v_packs_remaining integer;
  v_pieces_remaining integer;
  v_top_packs_pieces integer;
  v_smallest_pack_pieces integer;
  v_product_id uuid;
  v_coverage_pct numeric;
  v_line_total numeric;
  v_line_covered numeric;
  v_total numeric := 0;
  v_covered_total numeric := 0;
  v_seen_codes text[] := array[]::text[];
  v_discount record;
  v_discount_amount numeric := 0;
begin
  if jsonb_typeof(p_lines) <> 'array' or jsonb_array_length(p_lines) = 0 then
    raise exception 'At least one item is required to price a sale';
  end if;
  if p_insurance_provider_id is not null and not exists (
    select 1 from public.insurance_providers where id = p_insurance_provider_id
  ) then
    raise exception 'Unknown insurance provider';
  end if;
  if p_discount_id is not null then
    select * into v_discount from public.discounts where id = p_discount_id;
    if v_discount.id is null then raise exception 'Unknown discount'; end if;
    if (v_discount.valid_from is not null and v_discount.valid_from > current_date)
       or (v_discount.valid_to is not null and v_discount.valid_to < current_date) then
      raise exception 'This discount is not currently valid';
    end if;
  end if;

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
      where upper(bc.code) = v_code and sb.branch_id = p_branch;

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

    -- No tax lookup here, deliberately: v_line_total below is the tax-
    -- INCLUSIVE selling price (same as _execute_sale()'s v_line_total) --
    -- tax_rate only matters for splitting that figure into subtotal/tax for
    -- sale_items reporting, which this read-only preview never writes.
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
      if v_mode = 'whole' then v_child_quantity := v_barcode.pieces_per_pack; end if;
      if v_child_quantity < 1 then
        raise exception 'Barcode % needs a quantity of at least 1 piece', v_code;
      end if;
      if v_child_quantity > v_barcode.pieces_per_pack then
        raise exception 'Barcode % only has % piece(s) left', v_code, v_barcode.pieces_per_pack;
      end if;

      v_line_total := v_barcode.selling_price * v_child_quantity;
      v_line_covered := round(v_line_total * coalesce(v_coverage_pct, 0) / 100, 2);
      v_total := v_total + v_line_total;
      v_covered_total := v_covered_total + v_line_covered;

    elsif v_barcode.barcode_type = 'box' then
      if v_mode not in ('whole', 'packs', 'pieces') then
        raise exception 'Barcode % is a carton; sell_mode must be whole, packs or pieces', v_code;
      end if;

      select count(*), coalesce(sum(pieces_per_pack), 0)
        into v_packs_remaining, v_pieces_remaining
        from public.barcodes
        where parent_barcode_id = v_barcode.id and barcode_type = 'pack' and status = 'active' and quantity_available > 0;

      if v_packs_remaining = 0 then
        raise exception 'Carton % has no packs left to sell', v_code;
      end if;

      if v_mode = 'whole' then
        v_line_total := v_barcode.selling_price * v_pieces_remaining;

      elsif v_mode = 'packs' then
        if v_quantity is null or v_quantity < 1 then
          raise exception 'Carton % needs a pack quantity of at least 1', v_code;
        end if;
        if v_quantity > v_packs_remaining then
          raise exception 'Carton % only has % pack(s) left', v_code, v_packs_remaining;
        end if;

        select coalesce(sum(pieces_per_pack), 0) into v_top_packs_pieces
          from (
            select pieces_per_pack from public.barcodes
            where parent_barcode_id = v_barcode.id and barcode_type = 'pack' and status = 'active' and quantity_available > 0
            order by pieces_per_pack desc, created_at
            limit v_quantity
          ) top_packs;
        v_line_total := v_barcode.selling_price * v_top_packs_pieces;

      else -- pieces from carton
        if v_quantity is null or v_quantity < 1 then
          raise exception 'Carton % needs a piece quantity of at least 1', v_code;
        end if;

        select pieces_per_pack into v_smallest_pack_pieces
          from public.barcodes
          where parent_barcode_id = v_barcode.id and barcode_type = 'pack' and status = 'active' and quantity_available > 0
          order by pieces_per_pack asc, created_at
          limit 1;

        if v_smallest_pack_pieces is null then
          raise exception 'Carton % has no packs left to sell', v_code;
        end if;
        if v_quantity > v_smallest_pack_pieces then
          raise exception 'Carton %: the openable pack only has % piece(s) left -- sell fewer pieces or use packs mode', v_code, v_smallest_pack_pieces;
        end if;

        v_line_total := v_barcode.selling_price * v_quantity;
      end if;

      v_line_covered := round(v_line_total * coalesce(v_coverage_pct, 0) / 100, 2);
      v_total := v_total + v_line_total;
      v_covered_total := v_covered_total + v_line_covered;

    else
      raise exception 'Barcode % has unknown type %', v_code, v_barcode.barcode_type;
    end if;
  end loop;

  if p_discount_id is not null then
    v_discount_amount := case
      when v_discount.discount_type = 'percentage' then round((v_total - v_covered_total) * v_discount.value / 100, 2)
      else least(v_discount.value, greatest(v_total - v_covered_total, 0))
    end;
  end if;

  return query select v_total - v_discount_amount, v_covered_total, (v_total - v_discount_amount) - v_covered_total;
end;
$$;

revoke all on function public._price_sale_lines(uuid, jsonb, uuid, uuid) from public, anon, authenticated;


-- Thin, public, read-only wrapper around _price_sale_lines() -- lets the
-- frontend show an authoritative "you'll be charged X" figure before the
-- seller even picks a payment method, if ever useful; create_pending_
-- payment() below is what actually enforces this number.
create or replace function public.preview_sale_total(
  p_lines jsonb, p_insurance_provider_id uuid default null,
  p_discount_id uuid default null, p_branch_id uuid default null
)
returns table(total_amount numeric, insurance_covered_total numeric, patient_owed_total numeric)
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_branch uuid;
begin
  v_branch := public.effective_branch_id(p_branch_id);
  if v_branch is null then raise exception 'Only an active branch user may price a sale'; end if;
  perform public.assert_can_manage_org_branch_or_own(v_branch, public.current_branch_id());
  return query select * from public._price_sale_lines(v_branch, p_lines, p_insurance_provider_id, p_discount_id);
end;
$$;

revoke all on function public.preview_sale_total(jsonb, uuid, uuid, uuid) from public, anon;
grant execute on function public.preview_sale_total(jsonb, uuid, uuid, uuid) to authenticated;


-- ============================================================================
-- create_pending_payment() -- the ONLY entry point for starting a gateway
-- payment. Deliberately takes no amount from the caller: it prices the cart
-- itself via _price_sale_lines() and stores THAT as pending_payments.amount
-- -- the frontend's own on-screen total is never trusted for what actually
-- gets charged.
-- ============================================================================

-- p_provider trails at the end -- callers always pass it by name, never
-- positionally, so this placement changes nothing about how it's actually
-- called. merchant_reference is now just the row's own id as text:
-- originally a "PSY-..." string (fine for Pesapal, which only requires
-- "alphanumeric plus dashes"), changed to a plain UUID once pawaPay
-- entered the picture -- its deposits API requires depositId to be a real
-- UUID v4, so a provider-agnostic reference has to satisfy the strictest
-- provider's format, not the most lenient one.
--
-- Adding p_provider changes this function's argument COUNT, which
-- create-or-replace treats as a distinct overload rather than a true
-- replacement (unlike a return-shape change, this doesn't error -- it just
-- silently leaves the old 7-argument version sitting alongside the new
-- one). Dropped explicitly so there is only ever one create_pending_
-- payment in this schema, regardless of whether the version below was
-- ever actually run before this edit.
drop function if exists public.create_pending_payment(jsonb, text, uuid, uuid, text, uuid, uuid);

create or replace function public.create_pending_payment(
  p_lines jsonb, p_payment_method text,
  p_insurance_provider_id uuid default null, p_patient_id uuid default null,
  p_patient_phone text default null, p_discount_id uuid default null,
  p_branch_id uuid default null, p_provider text default 'pesapal'
)
returns table(pending_payment_id uuid, merchant_reference text, amount numeric)
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_branch uuid;
  v_user uuid := (select auth.uid());
  v_id uuid := gen_random_uuid();
  v_pricing record;
begin
  v_branch := public.effective_branch_id(p_branch_id);
  if v_branch is null then raise exception 'Only an active branch user may take a payment'; end if;
  perform public.assert_can_manage_org_branch_or_own(v_branch, public.current_branch_id());
  if exists (select 1 from public.branches b where b.id = v_branch and b.status <> 'active') then
    raise exception 'This pharmacy is not active';
  end if;
  if p_payment_method not in ('mtn_momo','airtel_money','card') then
    raise exception 'Unsupported gateway payment method %', p_payment_method;
  end if;
  if p_provider not in ('pesapal','pawapay') then
    raise exception 'Unsupported payment provider %', p_provider;
  end if;
  if p_provider = 'pawapay' and p_payment_method = 'card' then
    raise exception 'pawaPay does not support card payments -- use Pesapal or cash';
  end if;
  if p_patient_id is not null and not exists (
    select 1 from public.patients where id = p_patient_id and branch_id = v_branch
  ) then
    raise exception 'Unknown patient for this branch';
  end if;

  select * into v_pricing from public._price_sale_lines(v_branch, p_lines, p_insurance_provider_id, p_discount_id);
  if v_pricing.patient_owed_total <= 0 then
    raise exception 'Nothing is owed by the patient for this sale -- use cash or insurance-only checkout instead';
  end if;

  insert into public.pending_payments (
    id, branch_id, cashier_id, cart_snapshot, patient_phone, payment_method, amount, provider, merchant_reference
  ) values (
    v_id, v_branch, v_user,
    jsonb_build_object(
      'lines', p_lines,
      'insurance_provider_id', p_insurance_provider_id,
      'patient_id', p_patient_id,
      'discount_id', p_discount_id
    ),
    nullif(btrim(coalesce(p_patient_phone, '')), ''), p_payment_method, v_pricing.patient_owed_total, p_provider, v_id::text
  );

  return query select v_id, v_id::text, v_pricing.patient_owed_total;
end;
$$;

revoke all on function public.create_pending_payment(jsonb, text, uuid, uuid, text, uuid, uuid, text) from public, anon;
grant execute on function public.create_pending_payment(jsonb, text, uuid, uuid, text, uuid, uuid, text) to authenticated;


-- ============================================================================
-- resolve_pending_payment() -- the ONLY place a pending payment's status is
-- ever decided, called exclusively by the pesapal-payment Edge Function's
-- service-role client (never directly by a logged-in seller: there is no
-- auth.uid() check here at all, by design -- there is no "current user" when
-- Pesapal's IPN arrives). Two callers converge here: the IPN handler, and
-- the manual/polling "check status" action -- both call this exact same
-- function, which is what makes them safe to race each other.
--
-- IDEMPOTENCY: `for update` locks the row, and the very next check is
-- `status <> 'pending' -> return the already-settled result, touch nothing`.
-- A retried IPN, or a poll landing at the same instant as the real IPN,
-- always finds the row already resolved the second time and no-ops.
--
-- AMOUNT INTEGRITY: on a reported success, this re-prices the FROZEN cart
-- right now with _price_sale_lines() and compares it to pending_payments.
-- amount (what was actually charged via the provider). If they no longer
-- match -- stock, price, or a discount changed in the window between
-- initiating payment and the provider confirming it -- this refuses to
-- silently complete the sale. It marks the payment 'failed' with
-- failure_reason = 'amount_mismatch_needs_manual_review' instead: money was
-- captured for a specific figure, and it either matches a real sale exactly
-- or a human looks at it -- never a best-effort reconciliation.
-- ============================================================================

create or replace function public.resolve_pending_payment(
  p_merchant_reference text, p_provider_status text, p_provider_payload jsonb default null
)
returns table(status text, sale_id uuid, failure_reason text)
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_row public.pending_payments%rowtype;
  v_lines jsonb;
  v_insurance_provider_id uuid;
  v_patient_id uuid;
  v_discount_id uuid;
  v_priced record;
  v_executed record;
begin
  if p_provider_status not in ('success', 'failed') then
    raise exception 'Unsupported resolution status %', p_provider_status;
  end if;

  select * into v_row from public.pending_payments where merchant_reference = p_merchant_reference for update;
  if not found then
    raise exception 'Unknown payment reference %', p_merchant_reference;
  end if;

  if v_row.status <> 'pending' then
    return query select v_row.status, v_row.sale_id, v_row.failure_reason;
    return;
  end if;

  if p_provider_status = 'failed' then
    update public.pending_payments
    set status = 'failed',
        failure_reason = coalesce(p_provider_payload->>'message', 'Payment failed'),
        provider_status_payload = coalesce(p_provider_payload, provider_status_payload),
        updated_at = now()
    where id = v_row.id;
    return query select 'failed'::text, null::uuid, coalesce(p_provider_payload->>'message', 'Payment failed');
    return;
  end if;

  v_lines := v_row.cart_snapshot->'lines';
  v_insurance_provider_id := nullif(v_row.cart_snapshot->>'insurance_provider_id', '')::uuid;
  v_patient_id := nullif(v_row.cart_snapshot->>'patient_id', '')::uuid;
  v_discount_id := nullif(v_row.cart_snapshot->>'discount_id', '')::uuid;

  select * into v_priced from public._price_sale_lines(v_row.branch_id, v_lines, v_insurance_provider_id, v_discount_id);

  if abs(v_priced.patient_owed_total - v_row.amount) > 0.5 then
    update public.pending_payments
    set status = 'failed',
        failure_reason = 'amount_mismatch_needs_manual_review',
        provider_status_payload = coalesce(p_provider_payload, provider_status_payload),
        updated_at = now()
    where id = v_row.id;
    return query select 'failed'::text, null::uuid, 'amount_mismatch_needs_manual_review'::text;
    return;
  end if;

  select * into v_executed from public._execute_sale(
    v_row.branch_id, v_row.cashier_id, v_lines, v_insurance_provider_id, v_patient_id, v_row.payment_method, v_discount_id
  );

  update public.pending_payments
  set status = 'success',
      sale_id = v_executed.sale_id,
      provider_status_payload = coalesce(p_provider_payload, provider_status_payload),
      updated_at = now()
  where id = v_row.id;

  return query select 'success'::text, v_executed.sale_id, null::text;
end;
$$;

revoke all on function public.resolve_pending_payment(text, text, jsonb) from public, anon, authenticated;
grant execute on function public.resolve_pending_payment(text, text, jsonb) to service_role;


-- ============================================================================
-- mark_payment_provider_submitted() -- called by the Edge Function right
-- after Pesapal's SubmitOrderRequest returns, to record the order_tracking_
-- id against the row. Split out from resolve_pending_payment() since this
-- happens before any outcome is known -- it never touches `status`.
-- ============================================================================

create or replace function public.mark_payment_provider_submitted(
  p_pending_payment_id uuid, p_provider_reference text
)
returns void
language sql
security definer
set search_path = ''
as $$
  update public.pending_payments
  set provider_reference = p_provider_reference, updated_at = now()
  where id = p_pending_payment_id and status = 'pending';
$$;

revoke all on function public.mark_payment_provider_submitted(uuid, text) from public, anon, authenticated;
grant execute on function public.mark_payment_provider_submitted(uuid, text) to service_role;


-- ============================================================================
-- expire_stale_pending_payments() -- the "expired" state in practice: any
-- payment still 'pending' a long time after creation (default 15 minutes --
-- generous for a mobile money PIN prompt, well past a card checkout) flips
-- to 'expired' rather than sitting as 'pending' forever if a seller simply
-- walks away. Safe to call as often as you like (a plain UPDATE ... WHERE,
-- not a loop) -- called from the Edge Function's check-status action before
-- it re-checks a row, and can also be wired to a scheduled Edge Function
-- later if you want automatic sweeping with nobody polling.
-- ============================================================================

create or replace function public.expire_stale_pending_payments(p_older_than_minutes integer default 15)
returns integer
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_count integer;
begin
  update public.pending_payments
  set status = 'expired', failure_reason = 'No confirmation received in time', updated_at = now()
  where status = 'pending' and created_at < now() - make_interval(mins => p_older_than_minutes);
  get diagnostics v_count = row_count;
  return v_count;
end;
$$;

revoke all on function public.expire_stale_pending_payments(integer) from public, anon, authenticated;
grant execute on function public.expire_stale_pending_payments(integer) to service_role;
