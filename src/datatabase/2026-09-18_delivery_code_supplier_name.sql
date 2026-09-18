-- ============================================================================
-- DELIVERY CODE: DEL-<date>-<supplier> INSTEAD OF A RANDOM SUFFIX
-- ============================================================================
-- receive_stock_delivery() previously generated delivery_code as
-- DEL-<YYYYMMDD>-<6 random hex chars from the delivery's own uuid>, e.g.
-- DEL-20260918-A1B2C3 -- unique, but meaningless to a human scanning a list
-- of deliveries. This makes it DEL-<YYYY/MM/DD>-<SUPPLIER NAME>, e.g.
-- DEL-2026/09/18-MEDPLUS_LTD, so a delivery is identifiable at a glance
-- without opening it.
--
-- The supplier name is uppercased and every run of characters that isn't a
-- letter or digit collapses to a single underscore (so "MedPlus Ltd.", "MED
-- PLUS  LTD", and "Med-Plus Ltd" all produce the same clean token), then
-- capped at 24 characters so one very long or punctuation-heavy supplier
-- name can't produce an unreadable code.
--
-- stock_deliveries has a real unique(branch_id, delivery_code) constraint
-- (see pharmacy_schema_consolidated.sql), and a second delivery from the
-- same supplier on the same day at the same branch is now a realistic case
-- this format alone doesn't disambiguate -- the random suffix used to make
-- that automatic. The loop below checks for that exact collision and only
-- then appends -2, -3, ... so the common case (one delivery per supplier
-- per day) stays exactly DEL-<date>-<supplier>, and repeats stay unique
-- without ever failing the insert.
--
-- Everything else in this function (validation, category handling, batch
-- creation) is unchanged from the prior declaration in
-- 2026-09-15_org_manager_precedence_over_owner.sql.
-- ============================================================================

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
  v_supplier_slug text;
  v_base_code text;
  v_seq integer;
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

  v_supplier_slug := upper(regexp_replace(btrim(p_supplier_name), '[^a-zA-Z0-9]+', '_', 'g'));
  v_supplier_slug := btrim(v_supplier_slug, '_');
  if v_supplier_slug is null or v_supplier_slug = '' then v_supplier_slug := 'SUPPLIER'; end if;
  v_supplier_slug := left(v_supplier_slug, 24);
  v_base_code := format('DEL-%s-%s', to_char(now(), 'YYYY/MM/DD'), v_supplier_slug);
  v_code := v_base_code;
  v_seq := 1;
  while exists (select 1 from public.stock_deliveries sd where sd.branch_id = v_branch and sd.delivery_code = v_code) loop
    v_seq := v_seq + 1;
    v_code := format('%s-%s', v_base_code, v_seq);
  end loop;

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
