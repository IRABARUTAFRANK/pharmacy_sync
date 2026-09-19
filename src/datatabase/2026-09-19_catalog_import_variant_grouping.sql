-- ============================================================================
-- CATALOG IMPORT: GROUP PACK-SIZE ROWS INTO ONE PRODUCT WITH MANY VARIANTS
-- ============================================================================
-- admin_import_product_catalog() keyed a PRODUCT by '[CATALOG:<drug_code>] ...'
-- -- since a source list like the RHIA formulary gives every pack size/
-- strength of the same medicine its own drug_code (ELMEX SENSITIVE TUBE
-- 50ml, 75ml child, and 75ml adult are three different codes for the same
-- toothpaste), that made every single row its own product instead of one
-- product with three variants. Confirmed live against the real file.
--
-- Fix: the product is now keyed by its extracted BASE NAME (see
-- splitNameAndVariant() in src/lib/insuranceImport.ts, the client-side
-- logic that turns "ELMEX SENSITIVE TUBE 50ml 2 AT 6YRS" into base name
-- "ELMEX SENSITIVE TUBE" + variant descriptor "50ml 2 AT 6YRS"), and the
-- per-row drug_code moves to a NEW column on product_variants
-- (catalog_code) so re-importing a revised list still matches the exact
-- same variant row by its stable source code, rather than by re-matching
-- dosage/form text that can drift slightly between revisions.
-- ============================================================================

alter table public.product_variants add column if not exists catalog_code varchar(40);

create unique index if not exists idx_product_variants_catalog_code
  on public.product_variants (catalog_code)
  where catalog_code is not null;

-- Return shape is unchanged, but the argument list gains no new parameters
-- either -- p_rows' existing drugCode field just gets used differently
-- (variant-level key instead of product-level key), and productName/dosage
-- are now expected to already be the split base-name/variant-descriptor
-- pair (the client computes that split, not this function -- see
-- splitNameAndVariant()'s own comment for why: iterating on a text-parsing
-- heuristic is far easier in JS than in plpgsql).
create or replace function public.admin_import_product_catalog(
  p_tax_rate_id uuid, p_rows jsonb
)
returns table(
  created_products integer, updated_products integer,
  created_variants integer, reused_variants integer
)
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_product_id uuid;
  v_variant_id uuid;
  v_description text;
  r record;
  v_created_products int := 0;
  v_updated_products int := 0;
  v_created_variants int := 0;
  v_reused_variants int := 0;
begin
  perform public.assert_super_admin();

  if not exists (select 1 from public.tax_rates where id = p_tax_rate_id) then
    raise exception 'Unknown tax rate';
  end if;
  if jsonb_typeof(p_rows) <> 'array' or jsonb_array_length(p_rows) = 0 then
    raise exception 'At least one row is required';
  end if;

  for r in
    select
      nullif(btrim(coalesce(row_data->>'drugCode', '')), '') as drug_code,
      coalesce(nullif(row_data->>'productType', ''), 'medicine') as product_type,
      nullif(btrim(coalesce(row_data->>'productName', '')), '') as product_name,
      nullif(btrim(coalesce(row_data->>'genericName', '')), '') as generic_name,
      nullif(btrim(coalesce(row_data->>'dosage', '')), '') as dosage,
      nullif(btrim(coalesce(row_data->>'form', '')), '') as form,
      nullif(btrim(coalesce(row_data->>'unit', '')), '') as unit
    from jsonb_array_elements(p_rows) as row_data
  loop
    -- Defensive only -- the client (buildImportPreview()) has already
    -- filtered out rows missing these, this just guards a hand-built payload.
    if r.drug_code is null or r.product_name is null then
      continue;
    end if;

    -- Keyed by the BASE NAME now (a "[CATALOG] <name>" marker, isolated
    -- from anything organically created elsewhere the same way the old
    -- per-drug-code marker was), not the per-row drug_code -- this is what
    -- lets multiple pack-size rows collapse onto the SAME product.
    v_description := '[CATALOG] ' || r.product_name;

    select id into v_product_id from public.products where description = v_description limit 1;

    if v_product_id is null then
      insert into public.products (tax_rate_id, product_type, name, generic_name, description)
      values (
        p_tax_rate_id, case when r.product_type in ('medicine','supply','other') then r.product_type else 'medicine' end,
        r.product_name, r.generic_name, v_description
      )
      returning id into v_product_id;
      v_created_products := v_created_products + 1;
    else
      update public.products
        set tax_rate_id = p_tax_rate_id,
            product_type = case when r.product_type in ('medicine','supply','other') then r.product_type else 'medicine' end,
            name = r.product_name, generic_name = r.generic_name
        where id = v_product_id;
      v_updated_products := v_updated_products + 1;
    end if;

    -- Variant identity is the source drug_code now (stable across a
    -- revised list re-import), falling back to a dosage/form match only
    -- for a variant that has no catalog_code at all (created some other
    -- way -- manual entry, an older import predating this column).
    select id into v_variant_id from public.product_variants
      where product_id = v_product_id and catalog_code = r.drug_code
      limit 1;

    if v_variant_id is null then
      select id into v_variant_id from public.product_variants
        where product_id = v_product_id
          and catalog_code is null
          and coalesce(dosage, '') = coalesce(r.dosage, '')
          and coalesce(form, '') = coalesce(r.form, '')
        limit 1;
    end if;

    if v_variant_id is null then
      insert into public.product_variants (product_id, dosage, form, unit, catalog_code)
      values (v_product_id, r.dosage, r.form, r.unit, r.drug_code)
      returning id into v_variant_id;
      v_created_variants := v_created_variants + 1;
    else
      update public.product_variants
        set dosage = r.dosage, form = r.form, unit = r.unit, catalog_code = r.drug_code
        where id = v_variant_id;
      v_reused_variants := v_reused_variants + 1;
    end if;
  end loop;

  return query select v_created_products, v_updated_products, v_created_variants, v_reused_variants;
end;
$$;

-- admin_import_insurance_price_list() had the identical flaw (product keyed
-- by '[INS:<provider>:<drug_code>] ...'), plus a second problem this fix
-- also addresses: keying by provider meant the SAME real medicine imported
-- from two different insurers' price lists (each with its own drug_code
-- scheme) landed as two separate products instead of one shared product
-- with two providers' prices attached to the same variant -- defeating the
-- whole point of insurance_variant_prices being keyed by (provider, variant)
-- so several providers can price the same variant.
--
-- Fix: the product marker is now the SAME '[CATALOG] <base name>' used by
-- admin_import_product_catalog() above, so an insurance price-list import
-- converges onto whatever product a general catalog upload (or another
-- provider's own earlier price-list import) already created for that
-- medicine, instead of forking off a provider-private copy. The variant is
-- matched purely by (dosage, form) -- NOT by catalog_code -- since two
-- insurers' drug_code schemes have no reason to agree on a value for what
-- is physically the same pack size; catalog_code (when a variant already
-- has one, from a prior general-catalog import) is left untouched here.
create or replace function public.admin_import_insurance_price_list(
  p_provider_id uuid, p_tax_rate_id uuid, p_rows jsonb
)
returns table(
  created_products integer, updated_products integer,
  created_variants integer, reused_variants integer, prices_set integer
)
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_product_id uuid;
  v_variant_id uuid;
  v_description text;
  r record;
  v_created_products int := 0;
  v_updated_products int := 0;
  v_created_variants int := 0;
  v_reused_variants int := 0;
  v_prices_set int := 0;
begin
  perform public.assert_super_admin();

  if not exists (select 1 from public.tax_rates where id = p_tax_rate_id) then
    raise exception 'Unknown tax rate';
  end if;
  if not exists (select 1 from public.insurance_providers where id = p_provider_id) then
    raise exception 'Unknown insurance provider';
  end if;
  if jsonb_typeof(p_rows) <> 'array' or jsonb_array_length(p_rows) = 0 then
    raise exception 'At least one row is required';
  end if;

  for r in
    select
      nullif(btrim(coalesce(row_data->>'drugCode', '')), '') as drug_code,
      coalesce(nullif(row_data->>'productType', ''), 'medicine') as product_type,
      nullif(btrim(coalesce(row_data->>'productName', '')), '') as product_name,
      nullif(btrim(coalesce(row_data->>'genericName', '')), '') as generic_name,
      nullif(btrim(coalesce(row_data->>'dosage', '')), '') as dosage,
      nullif(btrim(coalesce(row_data->>'form', '')), '') as form,
      nullif(btrim(coalesce(row_data->>'unit', '')), '') as unit,
      (row_data->>'price')::numeric as price
    from jsonb_array_elements(p_rows) as row_data
  loop
    if r.drug_code is null or r.product_name is null or r.price is null then
      continue;
    end if;

    v_description := '[CATALOG] ' || r.product_name;

    select id into v_product_id from public.products where description = v_description limit 1;

    if v_product_id is null then
      insert into public.products (tax_rate_id, product_type, name, generic_name, description)
      values (
        p_tax_rate_id, case when r.product_type in ('medicine','supply','other') then r.product_type else 'medicine' end,
        r.product_name, r.generic_name, v_description
      )
      returning id into v_product_id;
      v_created_products := v_created_products + 1;
    else
      update public.products
        set tax_rate_id = p_tax_rate_id,
            product_type = case when r.product_type in ('medicine','supply','other') then r.product_type else 'medicine' end,
            name = r.product_name, generic_name = r.generic_name
        where id = v_product_id;
      v_updated_products := v_updated_products + 1;
    end if;

    select id into v_variant_id from public.product_variants
      where product_id = v_product_id
        and coalesce(dosage, '') = coalesce(r.dosage, '')
        and coalesce(form, '') = coalesce(r.form, '')
      limit 1;

    if v_variant_id is null then
      insert into public.product_variants (product_id, dosage, form, unit)
      values (v_product_id, r.dosage, r.form, r.unit)
      returning id into v_variant_id;
      v_created_variants := v_created_variants + 1;
    else
      v_reused_variants := v_reused_variants + 1;
    end if;

    insert into public.insurance_variant_prices (insurance_provider_id, product_variant_id, fixed_price)
    values (p_provider_id, v_variant_id, r.price)
    on conflict (insurance_provider_id, product_variant_id)
      do update set fixed_price = excluded.fixed_price;
    v_prices_set := v_prices_set + 1;
  end loop;

  return query select v_created_products, v_updated_products, v_created_variants, v_reused_variants, v_prices_set;
end;
$$;
