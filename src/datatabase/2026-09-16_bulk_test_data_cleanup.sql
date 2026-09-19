-- ============================================================================
-- BULK TEST DATA CLEANUP -- removes everything created by
-- 2026-09-16_bulk_test_data_seed.sql, and nothing else.
-- ============================================================================
-- DESTRUCTIVE. Deletes real rows. It only ever targets rows tagged by the
-- seed script (see the WHERE clauses in every section below -- each one
-- keys off a marker the seed script itself created: the "PharmSync Bulk
-- Seed" supplier per branch, the "zzz Bulk Seed Data" category per branch,
-- products whose description starts with "Bulk seed catalog item #", and
-- patients whose phone starts with "999"). Real data you entered by hand
-- through the app is never touched, because none of it matches these tags.
--
-- It does NOT delete the "Exempt"/"Standard VAT" tax rates the seed script
-- created or reused -- those are ordinary rates a real pharmacy needs too,
-- not seed-specific, so removing them could break real products/sales that
-- also reference them.
--
-- Runs in one transaction: if anything fails partway, nothing is deleted.
-- Order matters here (children before parents, to respect foreign keys) --
-- do not reorder the sections.
-- ============================================================================

begin;

do $$
declare
  v_seed_supplier_ids uuid[];
  v_seed_category_ids uuid[];
  v_seed_product_ids uuid[];
  v_seed_variant_ids uuid[];
  v_seed_batch_ids uuid[];
  v_seed_barcode_ids uuid[];
  v_seed_sale_ids uuid[];
  v_seed_patient_ids uuid[];
  v_count integer;
begin
  select array_agg(id) into v_seed_supplier_ids
  from public.suppliers where supplier_name = 'PharmSync Bulk Seed';

  select array_agg(id) into v_seed_category_ids
  from public.product_categories where name = 'zzz Bulk Seed Data';

  select array_agg(id) into v_seed_product_ids
  from public.products where description like 'Bulk seed catalog item #%';

  select array_agg(id) into v_seed_variant_ids
  from public.product_variants where product_id = any(coalesce(v_seed_product_ids, array[]::uuid[]));

  select array_agg(id) into v_seed_batch_ids
  from public.stock_batches where supplier_id = any(coalesce(v_seed_supplier_ids, array[]::uuid[]));

  select array_agg(id) into v_seed_barcode_ids
  from public.barcodes where stock_batch_id = any(coalesce(v_seed_batch_ids, array[]::uuid[]));

  select array_agg(distinct sale_id) into v_seed_sale_ids
  from public.sale_items where barcode_id = any(coalesce(v_seed_barcode_ids, array[]::uuid[]));

  select array_agg(id) into v_seed_patient_ids
  from public.patients where tin_or_phone like '999%';

  raise notice 'About to remove: % suppliers, % categories, % products (% variants), % stock batches (% barcodes), % sales, % patients.',
    coalesce(array_length(v_seed_supplier_ids, 1), 0), coalesce(array_length(v_seed_category_ids, 1), 0),
    coalesce(array_length(v_seed_product_ids, 1), 0), coalesce(array_length(v_seed_variant_ids, 1), 0),
    coalesce(array_length(v_seed_batch_ids, 1), 0), coalesce(array_length(v_seed_barcode_ids, 1), 0),
    coalesce(array_length(v_seed_sale_ids, 1), 0), coalesce(array_length(v_seed_patient_ids, 1), 0);

  -- 1. Sales (cascades to their own sale_items and receipts automatically --
  --    both are declared "on delete cascade" against sales.id).
  if v_seed_sale_ids is not null then
    delete from public.sales where id = any(v_seed_sale_ids);
    get diagnostics v_count = row_count;
    raise notice 'Deleted % sales (sale_items/receipts cascaded).', v_count;
  end if;

  -- 2. Anything that still points at the seed barcodes/batches directly
  --    (manual stock adjustments made against seed data while testing).
  if v_seed_barcode_ids is not null then
    delete from public.stock_adjustments where barcode_id = any(v_seed_barcode_ids);
  end if;
  if v_seed_batch_ids is not null then
    delete from public.stock_adjustments where stock_batch_id = any(v_seed_batch_ids);
  end if;

  -- 3. Barcodes, then the stock batches they belonged to.
  if v_seed_batch_ids is not null then
    delete from public.barcodes where stock_batch_id = any(v_seed_batch_ids);
    delete from public.stock_batches where id = any(v_seed_batch_ids);
    get diagnostics v_count = row_count;
    raise notice 'Deleted % stock batches (and their barcodes).', v_count;
  end if;

  -- 4. The per-branch seed suppliers.
  if v_seed_supplier_ids is not null then
    delete from public.suppliers where id = any(v_seed_supplier_ids);
  end if;

  -- 5. Category links and reorder points for seed products, then the
  --    per-branch seed category itself, then the products/variants.
  if v_seed_product_ids is not null then
    delete from public.reorder_points where product_id = any(v_seed_product_ids);
    delete from public.branch_product_categorization where product_id = any(v_seed_product_ids);
  end if;
  if v_seed_category_ids is not null then
    delete from public.branch_product_categorization where category_id = any(v_seed_category_ids);
    delete from public.product_categories where id = any(v_seed_category_ids);
  end if;
  if v_seed_variant_ids is not null then
    -- Defensive: if a recall or a saved sales forecast was ever run against
    -- seed data while testing those features, they'd otherwise block the
    -- variant delete below with a foreign-key violation. The seed script
    -- itself never creates these, so this is a no-op for a typical run.
    delete from public.batch_recalls where product_variant_id = any(v_seed_variant_ids);
    delete from public.sales_forecasts where product_variant_id = any(v_seed_variant_ids);
    delete from public.product_variants where id = any(v_seed_variant_ids);
  end if;
  if v_seed_product_ids is not null then
    delete from public.products where id = any(v_seed_product_ids);
    get diagnostics v_count = row_count;
    raise notice 'Deleted % catalog products (and their variants/reorder points/category links).', v_count;
  end if;

  -- 6. Seed patients (safe now that any sales referencing them are gone).
  if v_seed_patient_ids is not null then
    delete from public.patients where id = any(v_seed_patient_ids);
    get diagnostics v_count = row_count;
    raise notice 'Deleted % patients.', v_count;
  end if;

  raise notice '=== CLEANUP DONE ===';
end $$;

commit;
