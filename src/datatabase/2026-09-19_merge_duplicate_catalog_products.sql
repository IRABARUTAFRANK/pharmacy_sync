-- ============================================================================
-- ONE-TIME CLEANUP: merge every pre-fix catalog product into properly
-- grouped products, now that admin_import_product_catalog() /
-- admin_import_insurance_price_list() key products by base name (see
-- 2026-09-19_catalog_import_variant_grouping.sql, already applied).
-- ============================================================================
-- Checked live: 2,889 of 2,897 products in the catalog are still one-row-
-- per-drug-code leftovers from BEFORE that fix -- 1,446 came from running
-- the RHIA list through the (then-flawed) insurance price-list import
-- ('[INS:<provider>:<code>] ...' markers), the rest from an even earlier,
-- differently-formatted import ('RHIA code <code> · Tariff price ...').
-- Neither the schema/RPC fix nor a fresh re-import touches these existing
-- rows on its own -- they were created under a different description
-- marker, so they just sit there as duplicates unless explicitly merged.
--
-- This matters because real operational data already exists on TOP of some
-- of these old rows: 22 barcodes and 1 stock batch were already recorded
-- against them. This script does NOT delete that data -- it repoints it
-- (stock_batches.product_variant_id, insurance_variant_prices, reorder_
-- points) onto the correctly-grouped survivor variant/product before
-- deleting the now-redundant duplicate product/variant rows underneath it.
--
-- Algorithm, per old row (one row = one product with exactly one variant,
-- confirmed to be the shape of every affected row):
--   1. Extract the drug_code the row's OLD description encoded (either
--      marker format), and split the product name into a base name +
--      variant descriptor using the identical rule as splitNameAndVariant()
--      (src/lib/insuranceImport.ts) -- first number immediately followed by
--      a strength/size unit.
--   2. Look for an existing product already renamed to '[CATALOG] <base
--      name>'. If none exists yet, THIS row's own product becomes the
--      survivor: renamed in place (its id doesn't change, so nothing needs
--      repointing for this row).
--   3. If a survivor already exists (an earlier row already claimed this
--      base name), find-or-create the matching variant on it (by
--      catalog_code, falling back to dosage/form), repoint every downstream
--      reference from this row's old variant/product onto the survivor's,
--      then delete the duplicate.
-- Wrapped in one transaction: if anything fails partway, nothing changes.
-- ============================================================================

begin;

do $$
declare
  r record;
  v_match text;
  v_pos int;
  v_base_name text;
  v_variant_label text;
  v_new_desc text;
  v_drug_code text;
  v_survivor_product_id uuid;
  v_survivor_variant_id uuid;
  v_old_variant_id uuid;
  v_became_survivor int := 0;
  v_merged_duplicates int := 0;
begin
  for r in
    select p.id as product_id, p.name, p.generic_name, p.description,
           v.id as variant_id, v.dosage, v.form, v.unit
    from public.products p
    join public.product_variants v on v.product_id = p.id
    where p.description like '[INS:%' or p.description like 'RHIA code %'
    order by p.id
  loop
    v_drug_code := left(coalesce(
      substring(r.description from '^\[INS:[^:]+:([^\]]+)\]'),
      substring(r.description from '^RHIA code (\S+)')
    ), 40);

    -- Same split rule as splitNameAndVariant(): first number immediately
    -- followed by a recognized strength/size unit is where the base name
    -- ends and the variant descriptor begins.
    v_match := substring(r.name from '(?i)\d[\d.,]*\s*(mg|g|mcg|µg|ml|IU|UI|MIU|mIU|%|GR)\M');
    if v_match is not null then v_pos := position(v_match in r.name); else v_pos := null; end if;
    if v_pos is null or v_pos <= 1 then
      v_base_name := r.name;
      v_variant_label := null;
    else
      v_base_name := btrim(substring(r.name from 1 for v_pos - 1));
      v_variant_label := btrim(substring(r.name from v_pos));
      if v_base_name = '' then v_base_name := r.name; v_variant_label := null; end if;
    end if;

    -- products.name/description and product_variants.dosage/form/unit are
    -- all bounded varchar columns -- a variant descriptor pulled straight
    -- out of a long designation (e.g. one with trailing packaging notes)
    -- can exceed dosage's 50 chars, same as every import script's own
    -- .slice()/left() truncation.
    v_base_name := left(v_base_name, 150);
    if v_variant_label is not null then v_variant_label := left(v_variant_label, 50); end if;
    r.dosage := left(r.dosage, 50);
    r.form := left(r.form, 50);
    r.unit := left(r.unit, 30);

    v_new_desc := '[CATALOG] ' || v_base_name;

    -- catalog_code is a stronger identity signal than the heuristic name
    -- split: the SAME drug_code sometimes reached the catalogue through two
    -- differently-formatted legacy imports whose product names don't
    -- textually match (one used the designation, the other the generic
    -- description), which would otherwise try to claim the same
    -- catalog_code for two different "survivor" products and violate
    -- idx_product_variants_catalog_code. Check for an existing variant with
    -- this drug_code FIRST, before falling back to the name-based lookup.
    if v_drug_code is not null then
      select product_id into v_survivor_product_id
        from public.product_variants where catalog_code = v_drug_code limit 1;
    end if;

    if v_survivor_product_id is null then
      select id into v_survivor_product_id from public.products where description = v_new_desc limit 1;
    end if;

    if v_survivor_product_id is null then
      -- No survivor yet -- this row's own product/variant becomes it.
      update public.products set name = v_base_name, description = v_new_desc where id = r.product_id;
      update public.product_variants
        set dosage = coalesce(v_variant_label, r.dosage), catalog_code = v_drug_code
        where id = r.variant_id;
      v_became_survivor := v_became_survivor + 1;
      continue;
    end if;

    if v_survivor_product_id = r.product_id then
      continue; -- this row's product already IS the survivor (renamed earlier this run)
    end if;

    select id into v_survivor_variant_id from public.product_variants
      where product_id = v_survivor_product_id and catalog_code = v_drug_code
      limit 1;

    if v_survivor_variant_id is null then
      select id into v_survivor_variant_id from public.product_variants
        where product_id = v_survivor_product_id
          and coalesce(dosage, '') = coalesce(v_variant_label, r.dosage, '')
          and coalesce(form, '') = coalesce(r.form, '')
        limit 1;
    end if;

    if v_survivor_variant_id is null then
      insert into public.product_variants (product_id, dosage, form, unit, catalog_code)
      values (v_survivor_product_id, coalesce(v_variant_label, r.dosage), r.form, r.unit, v_drug_code)
      returning id into v_survivor_variant_id;
    end if;

    v_old_variant_id := r.variant_id;

    -- Repoint real operational data before deleting the duplicate. Drop a
    -- price row outright only if the survivor already has one from the
    -- same provider (would otherwise violate that table's own unique
    -- constraint); every other price/stock-batch/reorder-point reference
    -- is moved, never dropped.
    delete from public.insurance_variant_prices ivp
      using public.insurance_variant_prices existing
      where ivp.product_variant_id = v_old_variant_id
        and existing.product_variant_id = v_survivor_variant_id
        and existing.insurance_provider_id = ivp.insurance_provider_id;
    update public.insurance_variant_prices
      set product_variant_id = v_survivor_variant_id
      where product_variant_id = v_old_variant_id;

    update public.stock_batches
      set product_variant_id = v_survivor_variant_id
      where product_variant_id = v_old_variant_id;

    delete from public.reorder_points rp
      using public.reorder_points existing
      where rp.product_id = r.product_id
        and existing.product_id = v_survivor_product_id
        and existing.branch_id = rp.branch_id;
    update public.reorder_points
      set product_id = v_survivor_product_id
      where product_id = r.product_id;

    delete from public.product_variants where id = v_old_variant_id;
    delete from public.products where id = r.product_id;
    v_merged_duplicates := v_merged_duplicates + 1;
  end loop;

  raise notice '% products became survivors, % duplicate products merged and removed', v_became_survivor, v_merged_duplicates;
end $$;

commit;
