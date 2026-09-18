-- ============================================================================
-- GENERAL PRODUCT CATALOG IMPORT — admin console upload (CSV/Excel), not
-- tied to any one insurer
-- ============================================================================
-- Three ways a medicine can enter the catalog now:
--   1. admin_import_insurance_price_list() -- one insurer's price list;
--      identity is `[INS:<provider_id>:<drug_code>]` in products.description,
--      also sets that insurer's fixed price on each variant.
--   2. admin_create_product() -- one medicine, typed in by hand.
--   3. admin_import_product_catalog() (this file) -- a file that ISN'T tied
--      to any insurer, for medicines every branch should have regardless of
--      insurance coverage. Same idempotent upsert shape as (1) -- re-
--      uploading a refreshed catalog file updates existing rows in place
--      instead of duplicating them -- just with its own identity marker,
--      `[CATALOG:<drug_code>]`, and no price/insurance_variant_prices step
--      at all (nothing here is insurer-specific).
--
-- Whatever gets created here is a completely ordinary products/
-- product_variants row -- same table, same RLS ("using (true)", every
-- branch can already read it), same everything else downstream (stock
-- receiving, sales, reorder points). A branch that receives stock of one of
-- these picks it from the catalogue exactly like anything else; nothing
-- about how it flows through the rest of the app changes. The client-side
-- parsing (header detection, column-mapping guess, dosage extraction) is
-- the SAME code as the insurance importer (src/lib/insuranceImport.ts),
-- just with buildImportPreview()'s price column made optional.
-- ============================================================================

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

    v_description := '[CATALOG:' || r.drug_code || '] ' || coalesce(r.generic_name, r.product_name);

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
  end loop;

  return query select v_created_products, v_updated_products, v_created_variants, v_reused_variants;
end;
$$;

revoke all on function public.admin_import_product_catalog(uuid, jsonb) from public, anon;
grant execute on function public.admin_import_product_catalog(uuid, jsonb) to authenticated;
