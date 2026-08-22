-- PharmSync development seed data
--
-- Run the canonical schema first: supabase_pharmacy_schema.sql
-- Before running this file, create an Auth user in Supabase Dashboard with
-- email dev.owner@pharmsync.local, then create its matching public.users
-- profile with role = 'owner'. This script deliberately never creates Auth
-- users or passwords.

begin;

do $$
begin
  if not exists (
    select 1 from public.users
    where email = 'dev.owner@pharmsync.local' and is_active
  ) then
    raise exception 'Create the active public.users profile for dev.owner@pharmsync.local before running this development seed.';
  end if;
end $$;

insert into public.branches (id, name, address, phone) values
  ('10000000-0000-4000-8000-000000000001', 'Kigali HQ', 'KN 4 Ave, Kigali', '+250 788 000 101'),
  ('10000000-0000-4000-8000-000000000002', 'Huye Branch', 'Huye Town Centre', '+250 788 000 102')
on conflict (id) do update set name = excluded.name, address = excluded.address, phone = excluded.phone;

insert into public.tax_rates (id, name, rate_percentage) values
  ('20000000-0000-4000-8000-000000000001', 'Exempt', 0),
  ('20000000-0000-4000-8000-000000000002', 'Standard VAT', 18)
on conflict (id) do update set name = excluded.name, rate_percentage = excluded.rate_percentage;

insert into public.product_categories (id, branch_id, name, description) values
  ('30000000-0000-4000-8000-000000000001', '10000000-0000-4000-8000-000000000001', 'Antibiotics', 'Prescription and over-the-counter antibiotics'),
  ('30000000-0000-4000-8000-000000000002', '10000000-0000-4000-8000-000000000001', 'Pain Relief', 'Analgesics and anti-inflammatory medicines'),
  ('30000000-0000-4000-8000-000000000003', '10000000-0000-4000-8000-000000000001', 'Vitamins', 'Vitamin and nutritional supplements'),
  ('30000000-0000-4000-8000-000000000004', '10000000-0000-4000-8000-000000000001', 'Diabetes Care', 'Diabetes treatments and supplies'),
  ('30000000-0000-4000-8000-000000000005', '10000000-0000-4000-8000-000000000001', 'First Aid', 'Wound care and consumables')
on conflict (id) do update set name = excluded.name, description = excluded.description;

insert into public.products (id, tax_rate_id, product_type, name, generic_name, description) values
  ('40000000-0000-4000-8000-000000000001', '20000000-0000-4000-8000-000000000001', 'medicine', 'Amoxicillin', 'Amoxicillin', 'Broad-spectrum antibiotic'),
  ('40000000-0000-4000-8000-000000000002', '20000000-0000-4000-8000-000000000001', 'medicine', 'Paracetamol', 'Acetaminophen', 'Pain and fever relief'),
  ('40000000-0000-4000-8000-000000000003', '20000000-0000-4000-8000-000000000001', 'medicine', 'Metformin', 'Metformin Hydrochloride', 'Type 2 diabetes treatment'),
  ('40000000-0000-4000-8000-000000000004', '20000000-0000-4000-8000-000000000001', 'medicine', 'Vitamin C', 'Ascorbic Acid', 'Vitamin supplement'),
  ('40000000-0000-4000-8000-000000000005', '20000000-0000-4000-8000-000000000002', 'supply', 'Surgical Masks', null, 'Disposable 3-ply face masks')
on conflict (id) do update set tax_rate_id = excluded.tax_rate_id, product_type = excluded.product_type, name = excluded.name, generic_name = excluded.generic_name, description = excluded.description;

insert into public.product_variants (id, product_id, dosage, form, unit) values
  ('50000000-0000-4000-8000-000000000001', '40000000-0000-4000-8000-000000000001', '500 mg', 'Capsule', 'capsule'),
  ('50000000-0000-4000-8000-000000000002', '40000000-0000-4000-8000-000000000002', '500 mg', 'Tablet', 'tablet'),
  ('50000000-0000-4000-8000-000000000003', '40000000-0000-4000-8000-000000000003', '500 mg', 'Tablet', 'tablet'),
  ('50000000-0000-4000-8000-000000000004', '40000000-0000-4000-8000-000000000004', '1000 mg', 'Tablet', 'tablet'),
  ('50000000-0000-4000-8000-000000000005', '40000000-0000-4000-8000-000000000005', null, 'Box', 'mask')
on conflict (id) do update set product_id = excluded.product_id, dosage = excluded.dosage, form = excluded.form, unit = excluded.unit;

insert into public.branch_product_categorization (branch_id, product_id, category_id) values
  ('10000000-0000-4000-8000-000000000001', '40000000-0000-4000-8000-000000000001', '30000000-0000-4000-8000-000000000001'),
  ('10000000-0000-4000-8000-000000000001', '40000000-0000-4000-8000-000000000002', '30000000-0000-4000-8000-000000000002'),
  ('10000000-0000-4000-8000-000000000001', '40000000-0000-4000-8000-000000000003', '30000000-0000-4000-8000-000000000004'),
  ('10000000-0000-4000-8000-000000000001', '40000000-0000-4000-8000-000000000004', '30000000-0000-4000-8000-000000000003'),
  ('10000000-0000-4000-8000-000000000001', '40000000-0000-4000-8000-000000000005', '30000000-0000-4000-8000-000000000005')
on conflict (branch_id, product_id) do update set category_id = excluded.category_id;

insert into public.reorder_points (id, product_id, branch_id, min_quantity, max_quantity) values
  ('60000000-0000-4000-8000-000000000001', '40000000-0000-4000-8000-000000000001', '10000000-0000-4000-8000-000000000001', 50, 300),
  ('60000000-0000-4000-8000-000000000002', '40000000-0000-4000-8000-000000000002', '10000000-0000-4000-8000-000000000001', 80, 500),
  ('60000000-0000-4000-8000-000000000003', '40000000-0000-4000-8000-000000000003', '10000000-0000-4000-8000-000000000001', 40, 250),
  ('60000000-0000-4000-8000-000000000004', '40000000-0000-4000-8000-000000000004', '10000000-0000-4000-8000-000000000001', 30, 200),
  ('60000000-0000-4000-8000-000000000005', '40000000-0000-4000-8000-000000000005', '10000000-0000-4000-8000-000000000001', 100, 1000)
on conflict (product_id, branch_id) do update set min_quantity = excluded.min_quantity, max_quantity = excluded.max_quantity;

insert into public.suppliers (id, supplier_name, contact, location) values
  ('70000000-0000-4000-8000-000000000001', 'MedPharm Rwanda', '+250 788 101 001', 'Kigali Special Economic Zone'),
  ('70000000-0000-4000-8000-000000000002', 'HealthLine Distributors', '+250 788 101 002', 'Kigali'),
  ('70000000-0000-4000-8000-000000000003', 'Care Supplies Ltd', '+250 788 101 003', 'Musanze')
on conflict (id) do update set supplier_name = excluded.supplier_name, contact = excluded.contact, location = excluded.location;

insert into public.stock_batches (id, product_variant_id, branch_id, supplier_id, manufacturer_name, delivery_code, logged_by, batch_number, expiry_date, cost_price, selling_price, quantity_received, received_at) values
  ('80000000-0000-4000-8000-000000000001', '50000000-0000-4000-8000-000000000001', '10000000-0000-4000-8000-000000000001', '70000000-0000-4000-8000-000000000001', 'Rwanda Pharma', 'DEV-DEL-001', (select id from public.users where email = 'dev.owner@pharmsync.local'), 'AMX-DEV-001', current_date + 420, 580, 950, 120, now() - interval '4 days'),
  ('80000000-0000-4000-8000-000000000002', '50000000-0000-4000-8000-000000000002', '10000000-0000-4000-8000-000000000001', '70000000-0000-4000-8000-000000000002', 'HealthPlus', 'DEV-DEL-001', (select id from public.users where email = 'dev.owner@pharmsync.local'), 'PAR-DEV-002', current_date + 180, 220, 450, 200, now() - interval '4 days'),
  ('80000000-0000-4000-8000-000000000003', '50000000-0000-4000-8000-000000000003', '10000000-0000-4000-8000-000000000001', '70000000-0000-4000-8000-000000000001', 'Rwanda Pharma', 'DEV-DEL-002', (select id from public.users where email = 'dev.owner@pharmsync.local'), 'MET-DEV-003', current_date + 55, 680, 1100, 35, now() - interval '2 days'),
  ('80000000-0000-4000-8000-000000000004', '50000000-0000-4000-8000-000000000004', '10000000-0000-4000-8000-000000000001', '70000000-0000-4000-8000-000000000002', 'NutriCare', 'DEV-DEL-002', (select id from public.users where email = 'dev.owner@pharmsync.local'), 'VIT-DEV-004', current_date + 730, 390, 700, 60, now() - interval '2 days'),
  ('80000000-0000-4000-8000-000000000005', '50000000-0000-4000-8000-000000000005', '10000000-0000-4000-8000-000000000001', '70000000-0000-4000-8000-000000000003', 'SafeGuard', 'DEV-DEL-003', (select id from public.users where email = 'dev.owner@pharmsync.local'), 'MSK-DEV-005', current_date + 365, 120, 180, 500, now() - interval '1 day')
on conflict (id) do update set expiry_date = excluded.expiry_date, cost_price = excluded.cost_price, selling_price = excluded.selling_price, quantity_received = excluded.quantity_received, received_at = excluded.received_at;

-- Box (parent carton) rows. quantity_available on a box is always 1 -- it
-- means "this carton exists", not a stock count; the real stock count comes
-- from the pack (child) rows below. Metformin's child_count was corrected
-- from 4 to 5 so quantity_received (35) divides evenly into whole packs.
insert into public.barcodes (id, stock_batch_id, parent_barcode_id, barcode_type, code, code_source, child_count, pieces_per_pack, quantity_available, status) values
  ('90000000-0000-4000-8000-000000000001', '80000000-0000-4000-8000-000000000001', null, 'box', 'DEV-AMX-001-BOX', 'generated', 12, null, 1, 'active'),
  ('90000000-0000-4000-8000-000000000002', '80000000-0000-4000-8000-000000000002', null, 'box', 'DEV-PAR-002-BOX', 'generated', 20, null, 1, 'active'),
  ('90000000-0000-4000-8000-000000000003', '80000000-0000-4000-8000-000000000003', null, 'box', 'DEV-MET-003-BOX', 'generated', 5, null, 1, 'active'),
  ('90000000-0000-4000-8000-000000000004', '80000000-0000-4000-8000-000000000004', null, 'box', 'DEV-VIT-004-BOX', 'generated', 6, null, 1, 'sold_out'),
  ('90000000-0000-4000-8000-000000000005', '80000000-0000-4000-8000-000000000005', null, 'box', 'DEV-MSK-005-BOX', 'generated', 10, null, 1, 'active')
on conflict (id) do update set child_count = excluded.child_count, quantity_available = excluded.quantity_available, status = excluded.status;

-- Pack (child) rows: one barcode per physical pack, each linked back to its
-- box, matching what receive_stock_delivery() actually generates. Rebuilt on
-- every run (delete-then-insert) since these seed pack IDs aren't referenced
-- anywhere else -- a fresh gen_random_uuid() each run is fine.
delete from public.barcodes where parent_barcode_id in (
  '90000000-0000-4000-8000-000000000001',
  '90000000-0000-4000-8000-000000000002',
  '90000000-0000-4000-8000-000000000003',
  '90000000-0000-4000-8000-000000000004',
  '90000000-0000-4000-8000-000000000005'
);

do $$
declare
  box record;
  n integer;
begin
  for box in
    select * from (values
      ('90000000-0000-4000-8000-000000000001'::uuid, '80000000-0000-4000-8000-000000000001'::uuid, 'DEV-AMX-001', 12, 10, 10),
      ('90000000-0000-4000-8000-000000000002'::uuid, '80000000-0000-4000-8000-000000000002'::uuid, 'DEV-PAR-002', 20, 10, 20),
      ('90000000-0000-4000-8000-000000000003'::uuid, '80000000-0000-4000-8000-000000000003'::uuid, 'DEV-MET-003',  5,  7,  5),
      ('90000000-0000-4000-8000-000000000004'::uuid, '80000000-0000-4000-8000-000000000004'::uuid, 'DEV-VIT-004',  6, 10,  0),
      ('90000000-0000-4000-8000-000000000005'::uuid, '80000000-0000-4000-8000-000000000005'::uuid, 'DEV-MSK-005', 10, 50, 10)
    ) as t(box_id, batch_id, code_prefix, pack_count, pieces_each, packs_remaining)
  loop
    for n in 1..box.pack_count loop
      insert into public.barcodes
        (id, stock_batch_id, parent_barcode_id, barcode_type, code, code_source, pieces_per_pack, quantity_available, status)
      values (
        gen_random_uuid(), box.batch_id, box.box_id, 'pack',
        format('%s-P%s', box.code_prefix, lpad(n::text, 2, '0')), 'generated',
        box.pieces_each,
        case when n <= box.packs_remaining then 1 else 0 end,
        case when n <= box.packs_remaining then 'active' else 'sold_out' end
      );
    end loop;
  end loop;
end $$;

insert into public.discounts (id, name, discount_type, value, valid_from, valid_to) values
  ('a0000000-0000-4000-8000-000000000001', 'Development welcome discount', 'percentage', 5, current_date - 30, current_date + 180)
on conflict (id) do update set value = excluded.value, valid_from = excluded.valid_from, valid_to = excluded.valid_to;

insert into public.insurance_providers (id, name, contact_info, default_coverage_percentage) values
  ('b0000000-0000-4000-8000-000000000001', 'Rwanda Social Security Board', 'Development provider record', 80),
  ('b0000000-0000-4000-8000-000000000002', 'Medical Insurance Rwanda', 'Development provider record', 70)
on conflict (id) do update set contact_info = excluded.contact_info, default_coverage_percentage = excluded.default_coverage_percentage;

insert into public.insurance_product_coverage (insurance_provider_id, product_id, coverage_percentage) values
  ('b0000000-0000-4000-8000-000000000001', '40000000-0000-4000-8000-000000000003', 90)
on conflict (insurance_provider_id, product_id) do update set coverage_percentage = excluded.coverage_percentage;

insert into public.notifications (id, branch_id, source_type, source_id, message, is_read) values
  ('c0000000-0000-4000-8000-000000000001', '10000000-0000-4000-8000-000000000001', 'stock_adjustment', '90000000-0000-4000-8000-000000000004', 'Vitamin C 1000 mg is out of stock.', false),
  ('c0000000-0000-4000-8000-000000000002', '10000000-0000-4000-8000-000000000001', 'stock_adjustment', '90000000-0000-4000-8000-000000000003', 'Metformin 500 mg is approaching its expiry date.', false)
on conflict (id) do update set message = excluded.message, is_read = excluded.is_read;

commit;
