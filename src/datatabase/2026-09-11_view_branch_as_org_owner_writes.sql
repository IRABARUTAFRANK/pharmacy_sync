-- ============================================================================
-- Write-path branch functions (view-as-org-owner) -- part 2 of 2
-- ============================================================================
-- Companion to 2026-09-11_view_branch_as_org_owner.sql (must run first --
-- this file uses public.effective_branch_id(), defined there). Lets an
-- org_owner/org_manager actually operate a branch they're viewing (manage
-- discounts/categories for it) rather than only read its dashboards.
-- p_branch_id NULL preserves today's exact behavior.
--
-- NOT included here: complete_sale() and receive_stock_delivery(). Both
-- resolve "which branch" by inlining the exact query current_branch_id()
-- itself runs (`select u.branch_id from public.users u where u.id = auth.uid()
-- and u.is_active`) rather than calling the named current_branch_id()
-- helper -- so the mechanical "replace the current_branch_id() call" pattern
-- this file otherwise follows does not literally apply to them. Converting
-- them would mean an org_owner/org_manager could ring up a sale, or receive
-- a stock delivery, attributed to a branch that isn't their own -- a real
-- authorization-surface change for the two highest-stakes write paths in the
-- schema, not a mechanical one. That deserves its own explicit review and a
-- dedicated migration, not a silent side effect of this batch. See the
-- REVIEW notes further down for exactly what each would need.
-- ============================================================================


-- ============================================================================
-- create_branch_discount() -- add p_branch_id
-- ============================================================================
-- Authorization (assert_owner_or_manager()) checks the caller's own base
-- role (owner/manager), not which branch they're acting on, so it needs no
-- change -- an org_owner's home-branch role is already 'owner'. Only the
-- current_branch_id() call that stamps discounts.branch_id needs to become
-- overridable.
drop function if exists public.create_branch_discount(text, text, numeric, date, date);
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
  v_id uuid;
begin
  perform public.assert_owner_or_manager();
  if p_discount_type not in ('percentage','fixed') then
    raise exception 'Discount type must be percentage or fixed';
  end if;
  if p_value < 0 or (p_discount_type = 'percentage' and p_value > 100) then
    raise exception 'Invalid discount value';
  end if;

  insert into public.discounts (name, discount_type, value, valid_from, valid_to, branch_id)
  values (btrim(p_name), p_discount_type, p_value, p_valid_from, p_valid_to, public.effective_branch_id(p_branch_id))
  returning id into v_id;

  return v_id;
end;
$$;

revoke all on function public.create_branch_discount(text, text, numeric, date, date, uuid) from public, anon;
grant execute on function public.create_branch_discount(text, text, numeric, date, date, uuid) to authenticated;


-- ============================================================================
-- create_branch_category() -- add p_branch_id
-- ============================================================================
drop function if exists public.create_branch_category(text, text);
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

revoke all on function public.create_branch_category(text, text, uuid) from public, anon;
grant execute on function public.create_branch_category(text, text, uuid) to authenticated;


-- ============================================================================
-- update_branch_category() -- add p_branch_id
-- ============================================================================
drop function if exists public.update_branch_category(uuid, text, text);
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

revoke all on function public.update_branch_category(uuid, text, text, uuid) from public, anon;
grant execute on function public.update_branch_category(uuid, text, text, uuid) to authenticated;


-- ============================================================================
-- complete_sale() -- add p_branch_id (decision made: org_owner/org_manager
-- MAY complete a sale attributed to a branch they're viewing, same as any
-- other write in this file -- gated by effective_branch_id()'s own
-- assert_org_member() check, so a non-member is still rejected exactly like
-- before)
-- ============================================================================
-- Source: pharmacy_schema_consolidated.sql, last declaration (~line 4832).
-- Only the branch-resolution lines change; everything else -- barcode/pack/
-- carton handling, discount, insurance claim -- is copied verbatim.
drop function if exists public.complete_sale(jsonb, uuid, uuid, text, uuid);
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

revoke all on function public.complete_sale(jsonb, uuid, uuid, text, uuid, uuid) from public, anon;
grant execute on function public.complete_sale(jsonb, uuid, uuid, text, uuid, uuid) to authenticated;


-- ============================================================================
-- receive_stock_delivery() -- add p_branch_id
-- ============================================================================
-- Source: pharmacy_schema_consolidated.sql (~line 1904). The owner/manager
-- check stays based on the CALLER's own role (auth.uid()'s row), not the
-- viewed branch's roster -- it answers "is this person allowed to receive
-- stock at all", which is a fact about them, not about whichever branch
-- they're currently viewing. The null-branch check now runs after resolving
-- effective_branch_id() so an invalid/unauthorized p_branch_id surfaces that
-- function's own more specific exception first.
drop function if exists public.receive_stock_delivery(text, text, jsonb);
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

revoke all on function public.receive_stock_delivery(text, text, jsonb, uuid) from public, anon;
grant execute on function public.receive_stock_delivery(text, text, jsonb, uuid) to authenticated;


-- ============================================================================
-- upsert_patient() -- add p_branch_id
-- ============================================================================
-- Found separately from the original current_branch_id()-based scan: this
-- one resolves its branch the same inlined way complete_sale/
-- receive_stock_delivery did, not via the named helper. Matters here because
-- SalesPage and PatientsPage both call it -- without this, an org_owner
-- adding/updating a patient while viewing another branch would silently
-- stamp the patient to their OWN home branch instead.
-- Source: 2026-09-07_patient_and_insurer_tin.sql (current signature).
drop function if exists public.upsert_patient(text, text, integer, text, text);
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

revoke all on function public.upsert_patient(text, text, integer, text, text, uuid) from public, anon;
grant execute on function public.upsert_patient(text, text, integer, text, text, uuid) to authenticated;


-- ============================================================================
-- NOT converted (out of scope for this pass) -- documented for follow-up
-- ============================================================================
-- The same inlined "select u.branch_id into v_branch from public.users u
-- where u.id = v_user and u.is_active" pattern also appears in
-- finish_pending_delivery_item(), submit_product_request(), and
-- submit_support_ticket() (all in pharmacy_schema_consolidated.sql). None of
-- these back one of the 12 branch-dashboard pages this feature targets
-- (product requests and support tickets go to the platform admin, not
-- another branch's own dashboard) -- left as-is deliberately, not missed.
