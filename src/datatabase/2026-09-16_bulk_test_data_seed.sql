-- ============================================================================
-- BULK TEST DATA SEED -- fill real branches with realistic-scale data to
-- actually see how the system behaves (pagination, dashboards, alerts,
-- search, distance sorting) instead of guessing from a handful of rows.
-- ============================================================================
-- This is NOT the old development_seed.sql (which hand-writes ~5 fixed-UUID
-- products for a throwaway dev branch that has to be created first). This
-- one runs against your REAL existing branch(es) and generates volume:
-- hundreds of products, thousands of stock batches and barcodes, thousands
-- of historical sales, hundreds of patients.
--
-- SAFE AND REVERSIBLE:
--   - The whole thing runs in one transaction (begin/commit at the bottom)
--     -- if anything fails partway, nothing is left half-applied.
--   - Every row it creates is tagged so it can be found again: one
--     supplier per branch named "PharmSync Bulk Seed", one product
--     category per branch named "zzz Bulk Seed Data", and generated
--     patients get a phone number starting with "999" (not a real Rwandan
--     prefix). See 2026-09-16_bulk_test_data_cleanup.sql to remove
--     everything this creates without touching your real data.
--   - It never touches auth.users -- it only writes catalog/stock/sales
--     rows, attributed to a real staff login that already exists at each
--     branch. It does not create fake logins.
--
-- HOW TO USE:
--   1. Find your branch UUID(s) if you want to target specific ones:
--        select id, name, status from public.branches;
--      Leaving v_branch_ids empty (the default) targets every ACTIVE
--      branch automatically.
--   2. Adjust the volume knobs just below if you want more/less data.
--      Defaults: ~250 products, 2-4 stock batches per product per branch
--      (tens of thousands of barcodes -- enough to exceed PostgREST's
--      1000-row page cap many times over, so pagination is genuinely
--      exercised), 3000 historical sales per branch over the last 180
--      days, 250 patients per branch. On a normal Supabase free tier
--      project this finishes in well under a minute.
--   3. Paste this whole file into the Supabase SQL editor and run it once.
--   4. Open the app -- Inventory, Sales, Analytics, Organization dashboards
--      will all have real volume to show. The 30-second background poll
--      (out-of-stock/expiry/reorder checks) picks up the new data the next
--      time someone with an active session is viewing that branch -- this
--      script does not (and safely cannot) trigger those checks itself,
--      since they resolve "which branch" from the calling app session.
-- ============================================================================

begin;

do $$
declare
  -- CONFIG -- edit these before running
  v_branch_ids uuid[] := array[]::uuid[];   -- empty = every active branch
  v_products integer := 250;                -- distinct catalog products
  v_second_variant_chance numeric := 0.3;   -- fraction of products with 2 variants
  v_batches_min integer := 2;               -- stock batches per variant per branch
  v_batches_max integer := 4;
  v_branch_coverage numeric := 0.85;        -- fraction of variants stocked at each branch
  v_reorder_point_coverage numeric := 0.7;  -- fraction that get a reorder point set
  v_sales_per_branch integer := 3000;
  v_sale_days_back integer := 180;
  v_patients_per_branch integer := 250;
  -- END CONFIG

  v_drug_names text[] := array[
    'Amoxicillin','Paracetamol','Ibuprofen','Metformin','Amlodipine','Omeprazole','Azithromycin',
    'Ciprofloxacin','Losartan','Atorvastatin','Ascorbic Acid','Cholecalciferol','Zinc Sulfate',
    'Folic Acid','Ferrous Sulfate','Dextromethorphan','Oral Rehydration Salts','Diclofenac',
    'Metronidazole','Doxycycline','Artemether-Lumefantrine','Chlorpheniramine','Loratadine',
    'Cetirizine','Ranitidine','Simvastatin','Hydrochlorothiazide','Salbutamol','Prednisolone',
    'Hydrocortisone','Clotrimazole','Mebendazole','Albendazole','Multivitamin','Calcium Carbonate',
    'Magnesium Hydroxide','Aspirin','Codeine Phosphate','Tramadol','Diazepam','Amitriptyline',
    'Fluconazole','Nystatin','Erythromycin','Cefixime','Cefuroxime','Insulin Glargine',
    'Glibenclamide','Captopril','Furosemide','Spironolactone','Warfarin','Levothyroxine',
    'Tetracycline Eye Ointment','Povidone Iodine','Hydrogen Peroxide','Sodium Chloride Solution',
    'Activated Charcoal','Loperamide','Domperidone','Ondansetron'
  ];
  v_forms text[] := array['Tablet','Capsule','Syrup','Suspension','Injection','Cream','Ointment','Drops','Inhaler','Sachet'];
  v_dosages text[] := array['5mg','10mg','20mg','25mg','50mg','100mg','125mg','200mg','250mg','400mg','500mg','1000mg'];
  v_units text[] := array['tablet','capsule','ml','sachet','vial','tube'];
  v_manufacturers text[] := array[
    'Rwanda Pharma','HealthPlus Labs','MedPharm Rwanda','East Africa Pharmaceuticals','Cipla',
    'GlaxoWellness','Pharmatex','Novo Generics','Continental Meds','Kigali Chem'
  ];
  v_first_names text[] := array[
    'Jean','Marie','Eric','Alice','Emmanuel','Grace','Patrick','Diane','Vincent','Claudine',
    'Innocent','Solange','Olivier','Aline','Fabrice','Josiane','Aimable','Yvonne','Theogene','Chantal'
  ];
  v_last_names text[] := array[
    'Uwase','Niyonzima','Mukamana','Habimana','Ingabire','Nkurunziza','Mugisha','Uwimana',
    'Nsengimana','Bizimana','Twagirayezu','Uwizeye','Hakizimana','Mutesi','Rukundo'
  ];

  v_branch record;
  v_staff_ids uuid[];
  v_supplier_id uuid;
  v_category_id uuid;
  v_product_id uuid;
  v_variant_id uuid;
  v_variant_ids uuid[];
  v_tax_exempt uuid;
  v_tax_vat uuid;
  v_i integer;
  v_j integer;
  v_k integer;
  v_batches integer;
  v_cartons integer;
  v_packs integer;
  v_pieces integer;
  v_cost numeric;
  v_sell numeric;
  v_expiry date;
  v_roll numeric;
  v_batch_id uuid;
  v_barcode record;
  v_sale_id uuid;
  v_receipt_no text;
  v_patient_id uuid;
  v_sold_at timestamptz;
  v_qty integer;
  v_line_total numeric;
  v_tax_rate_id uuid;
  v_tax_pct numeric;
  v_products_created integer := 0;
  v_batches_created integer := 0;
  v_sales_created integer := 0;
  v_branch_sales_created integer;
  v_patients_created integer := 0;
begin
  if array_length(v_branch_ids, 1) is null then
    select array_agg(id) into v_branch_ids from public.branches where status = 'active';
  end if;
  if v_branch_ids is null or array_length(v_branch_ids, 1) is null then
    raise exception 'No active branches found -- create at least one branch first, or set v_branch_ids explicitly.';
  end if;

  -- Tax rates: reuse if they already exist (name is unique), create if not.
  select id into v_tax_exempt from public.tax_rates where name = 'Exempt';
  if v_tax_exempt is null then
    insert into public.tax_rates (name, rate_percentage) values ('Exempt', 0) returning id into v_tax_exempt;
  end if;
  select id into v_tax_vat from public.tax_rates where name = 'Standard VAT';
  if v_tax_vat is null then
    insert into public.tax_rates (name, rate_percentage) values ('Standard VAT', 18) returning id into v_tax_vat;
  end if;

  -- Global catalog: products + variants (shared across every branch)
  for v_i in 1..v_products loop
    v_tax_rate_id := case when random() < 0.2 then v_tax_exempt else v_tax_vat end;
    insert into public.products (tax_rate_id, product_type, name, generic_name, description)
    values (
      v_tax_rate_id, 'medicine',
      v_drug_names[1 + floor(random() * array_length(v_drug_names, 1))::int],
      v_drug_names[1 + floor(random() * array_length(v_drug_names, 1))::int],
      'Bulk seed catalog item #' || v_i
    )
    returning id into v_product_id;
    v_products_created := v_products_created + 1;

    insert into public.product_variants (product_id, dosage, form, unit)
    values (
      v_product_id,
      v_dosages[1 + floor(random() * array_length(v_dosages, 1))::int],
      v_forms[1 + floor(random() * array_length(v_forms, 1))::int],
      v_units[1 + floor(random() * array_length(v_units, 1))::int]
    )
    returning id into v_variant_id;
    v_variant_ids := array_append(v_variant_ids, v_variant_id);

    if random() < v_second_variant_chance then
      insert into public.product_variants (product_id, dosage, form, unit)
      values (
        v_product_id,
        v_dosages[1 + floor(random() * array_length(v_dosages, 1))::int],
        v_forms[1 + floor(random() * array_length(v_forms, 1))::int],
        v_units[1 + floor(random() * array_length(v_units, 1))::int]
      )
      returning id into v_variant_id;
      v_variant_ids := array_append(v_variant_ids, v_variant_id);
    end if;
  end loop;

  raise notice 'Catalog: % products, % variants created.', v_products_created, array_length(v_variant_ids, 1);

  -- Reused per branch below to drive historical sales without repeating an
  -- "ORDER BY random() LIMIT 1" query per sale (which would re-scan the
  -- branch's whole active-barcode set on every single one of thousands of
  -- iterations). Filled once per branch, already shuffled, then consumed
  -- top to bottom -- O(1) per sale instead of O(n) per sale.
  create temporary table tmp_seed_sale_barcodes (
    seq integer, barcode_id uuid, pieces_per_pack integer, selling_price numeric, product_variant_id uuid
  ) on commit drop;

  -- Per branch: seed supplier, seed category, stock, patients, sales
  for v_branch in select id, name from public.branches where id = any(v_branch_ids) loop

    select array_agg(id) into v_staff_ids
    from public.users where branch_id = v_branch.id and is_active and role in ('owner', 'manager');
    if v_staff_ids is null or array_length(v_staff_ids, 1) is null then
      raise notice 'Skipping branch % (%): no active owner/manager login found to attribute data to.', v_branch.name, v_branch.id;
      continue;
    end if;

    select id into v_supplier_id from public.suppliers
    where branch_id = v_branch.id and supplier_name = 'PharmSync Bulk Seed';
    if v_supplier_id is null then
      insert into public.suppliers (supplier_name, contact, location, branch_id)
      values ('PharmSync Bulk Seed', '+250 700 000 000', 'Generated test data', v_branch.id)
      returning id into v_supplier_id;
    end if;

    select id into v_category_id from public.product_categories
    where branch_id = v_branch.id and name = 'zzz Bulk Seed Data';
    if v_category_id is null then
      insert into public.product_categories (branch_id, name, description)
      values (v_branch.id, 'zzz Bulk Seed Data', 'Generated by 2026-09-16_bulk_test_data_seed.sql -- safe to bulk-delete via the matching cleanup script')
      returning id into v_category_id;
    end if;

    -- Stock: most variants get 2-4 batches here; a random subset is skipped
    -- entirely so not every product is carried at every branch (realistic,
    -- and gives the out-of-stock / missing-reorder-point states something
    -- real to report on).
    for v_j in 1..array_length(v_variant_ids, 1) loop
      if random() > v_branch_coverage then continue; end if;
      v_variant_id := v_variant_ids[v_j];

      insert into public.branch_product_categorization (branch_id, product_id, category_id)
      select v_branch.id, pv.product_id, v_category_id
      from public.product_variants pv where pv.id = v_variant_id
      on conflict (branch_id, product_id) do nothing;

      if random() < v_reorder_point_coverage then
        insert into public.reorder_points (product_id, branch_id, min_quantity, max_quantity)
        select pv.product_id, v_branch.id, 20 + floor(random() * 80)::int, 200 + floor(random() * 800)::int
        from public.product_variants pv where pv.id = v_variant_id
        on conflict (product_id, branch_id) do nothing;
      end if;

      v_batches := v_batches_min + floor(random() * (v_batches_max - v_batches_min + 1))::int;
      for v_k in 1..v_batches loop
        v_roll := random();
        v_expiry := case
          when v_roll < 0.05 then current_date - (1 + floor(random() * 60))::int  -- already expired
          when v_roll < 0.20 then current_date + (1 + floor(random() * 45))::int  -- expiring soon
          else current_date + (90 + floor(random() * 700))::int                  -- healthy
        end;
        v_cost := round((150 + random() * 3000)::numeric, 0);
        v_sell := round(v_cost * (1.25 + random() * 0.6), 0);
        v_cartons := case when random() < 0.6 then (1 + floor(random() * 3))::int else 0 end;
        v_packs := (2 + floor(random() * 12))::int;
        v_pieces := (5 + floor(random() * 20))::int;

        v_batch_id := public.create_stock_batch_with_barcodes(
          v_variant_id, v_branch.id, v_supplier_id,
          v_manufacturers[1 + floor(random() * array_length(v_manufacturers, 1))::int],
          null, null, v_staff_ids[1 + floor(random() * array_length(v_staff_ids, 1))::int],
          'SEED-' || upper(substr(md5(random()::text), 1, 10)),
          v_expiry, v_cost, v_sell, v_cartons, v_packs, v_pieces
        );
        v_batches_created := v_batches_created + 1;
      end loop;
    end loop;

    raise notice 'Branch % (%): stock generated.', v_branch.name, v_branch.id;

    -- Patients
    for v_i in 1..v_patients_per_branch loop
      insert into public.patients (branch_id, full_name, gender, age, tin_or_phone, phone, created_by)
      values (
        v_branch.id,
        v_first_names[1 + floor(random() * array_length(v_first_names, 1))::int] || ' ' ||
          v_last_names[1 + floor(random() * array_length(v_last_names, 1))::int],
        (array['male', 'female'])[1 + floor(random() * 2)::int],
        1 + floor(random() * 89)::int,
        '999' || lpad((floor(random() * 1000000))::text, 6, '0') || '-' || v_i,
        '999' || lpad((floor(random() * 1000000))::text, 6, '0'),
        v_staff_ids[1 + floor(random() * array_length(v_staff_ids, 1))::int]
      )
      on conflict (branch_id, tin_or_phone) do nothing;
      v_patients_created := v_patients_created + 1;
    end loop;

    -- Historical sales. Each sale is one whole pack, sold from a
    -- currently-active pack barcode at this branch -- mirrors
    -- complete_sale()'s own "whole pack" path closely enough to leave
    -- believable stock levels behind, without reimplementing its full
    -- carton/piece-splitting logic for throwaway test data.
    --
    -- Shuffled and capped ONCE here (a single scan+sort), then consumed
    -- row by row below -- if this were instead "ORDER BY random() LIMIT 1"
    -- run fresh for every one of thousands of sales, each call would
    -- re-scan and re-sort the branch's whole active-barcode set, which
    -- stops scaling well once the sales-per-branch knob is turned up.
    v_branch_sales_created := 0;
    truncate tmp_seed_sale_barcodes;
    insert into tmp_seed_sale_barcodes (seq, barcode_id, pieces_per_pack, selling_price, product_variant_id)
    select row_number() over (), bc.id, bc.pieces_per_pack, sb.selling_price, sb.product_variant_id
    from public.barcodes bc
    join public.stock_batches sb on sb.id = bc.stock_batch_id
    where sb.branch_id = v_branch.id and bc.barcode_type = 'pack' and bc.status = 'active'
      and bc.quantity_available > 0 and sb.expiry_date >= current_date
    order by random()
    limit v_sales_per_branch;

    if (select count(*) from tmp_seed_sale_barcodes) < v_sales_per_branch then
      raise notice 'Branch %: only % sellable packs available -- generating that many sales instead of the requested %.',
        v_branch.name, (select count(*) from tmp_seed_sale_barcodes), v_sales_per_branch;
    end if;

    for v_barcode in select * from tmp_seed_sale_barcodes order by seq loop
      select p.tax_rate_id, t.rate_percentage into v_tax_rate_id, v_tax_pct
        from public.product_variants pv
        join public.products p on p.id = pv.product_id
        join public.tax_rates t on t.id = p.tax_rate_id
        where pv.id = v_barcode.product_variant_id;

      v_sold_at := now() - (random() * v_sale_days_back || ' days')::interval
        - (floor(random() * 24) || ' hours')::interval;
      v_qty := v_barcode.pieces_per_pack;
      v_line_total := v_barcode.selling_price * v_qty;

      v_patient_id := null;
      if random() < 0.4 then
        select id into v_patient_id from public.patients
        where branch_id = v_branch.id order by random() limit 1;
      end if;

      insert into public.sales (id, branch_id, cashier_id, patient_id, total_amount, sold_at)
      values (
        gen_random_uuid(), v_branch.id,
        v_staff_ids[1 + floor(random() * array_length(v_staff_ids, 1))::int],
        v_patient_id, v_line_total, v_sold_at
      )
      returning id into v_sale_id;

      insert into public.sale_items (sale_id, barcode_id, tax_rate_id, quantity, unit_price, subtotal)
      values (v_sale_id, v_barcode.barcode_id, v_tax_rate_id, v_qty, v_barcode.selling_price,
        round(v_line_total / (1 + coalesce(v_tax_pct, 0) / 100), 2));

      v_receipt_no := 'SEED-' || to_char(v_sold_at, 'YYYYMMDD') || '-' || upper(substr(md5(random()::text), 1, 6));
      insert into public.receipts (sale_id, receipt_number, issued_at) values (v_sale_id, v_receipt_no, v_sold_at);

      update public.barcodes set quantity_available = 0, status = 'sold_out' where id = v_barcode.barcode_id;

      v_sales_created := v_sales_created + 1;
      v_branch_sales_created := v_branch_sales_created + 1;
    end loop;

    raise notice 'Branch % (%): % sales generated.', v_branch.name, v_branch.id, v_branch_sales_created;
  end loop;

  raise notice '=== DONE === products: % | variants: % | stock batches: % | patients (this run): % | sales (this run): %',
    v_products_created, array_length(v_variant_ids, 1), v_batches_created, v_patients_created, v_sales_created;
end $$;

commit;
