-- Extended development seed: sales/patients/insurance/adjustments activity
--
-- development_seed.sql only ever populated the catalogue and opening stock
-- for the dev branch (Kigali HQ, 10000000-0000-4000-8000-000000000001) --
-- sales, sale_items, receipts, insurance_claims, patients, stock_adjustments,
-- support_tickets and product_requests were all still empty on the live
-- project, which meant Sales/Transactions/History/Insurance/Analytics had
-- nothing real to render. This file adds 14 days of realistic POS activity
-- on top of that existing catalogue so those pages can actually be exercised.
--
-- Written as plain inserts (not calls through complete_sale()/adjust_stock())
-- because those RPCs resolve the acting branch from auth.uid(), which has no
-- meaning when run as this migration's own role -- the numbers below are
-- computed by hand using the exact same formulas complete_sale() uses
-- (tax extracted from a VAT-inclusive line total, coverage_percentage_applied
-- = covered/total*100, discount taken off the patient-owed portion only), so
-- every row here is exactly what that RPC would have produced.
--
-- Idempotent: re-running deletes and rebuilds every row this file owns
-- (keyed off the fixed dev UUIDs below) rather than duplicating it. Depends
-- on development_seed.sql having been run first (same branch/products/
-- stock_batches/barcodes). Must not be used in production.

begin;

do $$
begin
  if not exists (
    select 1 from public.users
    where email = 'dev.owner@pharmsync.local' and is_active
  ) then
    raise exception 'Run development_seed.sql (and its one-time dev-owner setup) before this file.';
  end if;
end $$;

-- ── Clean slate for the rows this file owns, so it can be re-run ───────────
delete from public.insurance_claims where sale_id in (
  select id from public.sales where id::text like 'e1000000-0000-4000-8000-0000000000%'
);
delete from public.receipts where sale_id in (
  select id from public.sales where id::text like 'e1000000-0000-4000-8000-0000000000%'
);
delete from public.sale_items where sale_id in (
  select id from public.sales where id::text like 'e1000000-0000-4000-8000-0000000000%'
);
delete from public.sales where id::text like 'e1000000-0000-4000-8000-0000000000%';
delete from public.stock_adjustments where id = 'f1000000-0000-4000-8000-000000000001';
delete from public.notifications where id = 'c0000000-0000-4000-8000-000000000003';
delete from public.support_tickets where id = 'f2000000-0000-4000-8000-000000000001';
delete from public.product_requests where id = 'f3000000-0000-4000-8000-000000000001';
delete from public.patients where id::text like 'd1000000-0000-4000-8000-0000000000%';

-- Restore every barcode this file touches to development_seed.sql's original
-- state before recomputing consumption below, so re-running this file is
-- exactly repeatable regardless of how many times it's been run before.
update public.barcodes set status = 'active', quantity_available = 1, pieces_per_pack = 10
  where code in ('DEV-AMX-001-P01','DEV-AMX-001-P02','DEV-AMX-001-P03','DEV-AMX-001-P04','DEV-AMX-001-P05','DEV-AMX-001-P06');
update public.barcodes set status = 'active', quantity_available = 1, pieces_per_pack = 7
  where code in ('DEV-MET-003-P01','DEV-MET-003-P02','DEV-MET-003-P03');
update public.barcodes set status = 'active', quantity_available = 1, pieces_per_pack = 10
  where code in ('DEV-PAR-002-P01','DEV-PAR-002-P02','DEV-PAR-002-P04','DEV-PAR-002-P05','DEV-PAR-002-P06');
update public.barcodes set status = 'active', quantity_available = 1, pieces_per_pack = 10
  where code in ('DEV-PAR-002-P03','DEV-PAR-002-P07');
update public.barcodes set status = 'active', quantity_available = 1, pieces_per_pack = 50
  where code in ('DEV-MSK-005-P01','DEV-MSK-005-P02','DEV-MSK-005-P03');
update public.barcodes set status = 'active', quantity_available = 1, pieces_per_pack = 10
  where code = 'DEV-PAR-002-P08';

-- ── Patients ─────────────────────────────────────────────────────────────
insert into public.patients (id, branch_id, full_name, gender, age, tin_or_phone, phone, created_by) values
  ('d1000000-0000-4000-8000-000000000001', '10000000-0000-4000-8000-000000000001', 'Jean Mucyo', 'male', 34, '0788111222', '0788111222', (select id from public.users where email = 'dev.owner@pharmsync.local')),
  ('d1000000-0000-4000-8000-000000000002', '10000000-0000-4000-8000-000000000001', 'Alice Uwase', 'female', 29, '0788222333', '0788222333', (select id from public.users where email = 'dev.owner@pharmsync.local')),
  ('d1000000-0000-4000-8000-000000000003', '10000000-0000-4000-8000-000000000001', 'Eric Niyonzima', 'male', 51, '0788333444', '0788333444', (select id from public.users where email = 'dev.owner@pharmsync.local')),
  ('d1000000-0000-4000-8000-000000000004', '10000000-0000-4000-8000-000000000001', 'Grace Ingabire', 'female', 8, '0788444555', '0788444555', (select id from public.users where email = 'dev.owner@pharmsync.local'));

-- ── Sales, sale_items, receipts, insurance_claims ───────────────────────────
-- One row per sale below: id, sold_at, patient, payment method, discount.
-- total_amount is the post-discount gross (tax-inclusive) total, matching
-- what complete_sale() stores.
insert into public.sales (id, branch_id, cashier_id, discount_id, patient_id, total_amount, sold_at, payment_method) values
  ('e1000000-0000-4000-8000-000000000001', '10000000-0000-4000-8000-000000000001', (select id from public.users where email = 'dev.owner@pharmsync.local'), null, 'd1000000-0000-4000-8000-000000000002', 9000.00, (current_date - 9 + time '09:15')::timestamptz, 'cash'),
  ('e1000000-0000-4000-8000-000000000002', '10000000-0000-4000-8000-000000000001', (select id from public.users where email = 'dev.owner@pharmsync.local'), null, null, 9000.00, (current_date - 9 + time '14:40')::timestamptz, 'cash'),
  ('e1000000-0000-4000-8000-000000000003', '10000000-0000-4000-8000-000000000001', (select id from public.users where email = 'dev.owner@pharmsync.local'), null, 'd1000000-0000-4000-8000-000000000001', 7700.00, (current_date - 8 + time '10:05')::timestamptz, 'cash'),
  ('e1000000-0000-4000-8000-000000000004', '10000000-0000-4000-8000-000000000001', (select id from public.users where email = 'dev.owner@pharmsync.local'), null, 'd1000000-0000-4000-8000-000000000003', 9500.00, (current_date - 8 + time '16:20')::timestamptz, 'cash'),
  ('e1000000-0000-4000-8000-000000000005', '10000000-0000-4000-8000-000000000001', (select id from public.users where email = 'dev.owner@pharmsync.local'), null, null, 1800.00, (current_date - 7 + time '11:00')::timestamptz, 'cash'),
  ('e1000000-0000-4000-8000-000000000006', '10000000-0000-4000-8000-000000000001', (select id from public.users where email = 'dev.owner@pharmsync.local'), 'a0000000-0000-4000-8000-000000000001', 'd1000000-0000-4000-8000-000000000002', 18050.00, (current_date - 7 + time '15:30')::timestamptz, 'mtn_momo'),
  ('e1000000-0000-4000-8000-000000000007', '10000000-0000-4000-8000-000000000001', (select id from public.users where email = 'dev.owner@pharmsync.local'), null, null, 9000.00, (current_date - 6 + time '09:50')::timestamptz, 'airtel_money'),
  ('e1000000-0000-4000-8000-000000000008', '10000000-0000-4000-8000-000000000001', (select id from public.users where email = 'dev.owner@pharmsync.local'), null, 'd1000000-0000-4000-8000-000000000001', 7700.00, (current_date - 5 + time '13:10')::timestamptz, 'cash'),
  ('e1000000-0000-4000-8000-000000000009', '10000000-0000-4000-8000-000000000001', (select id from public.users where email = 'dev.owner@pharmsync.local'), null, null, 13500.00, (current_date - 4 + time '10:30')::timestamptz, 'cash'),
  ('e1000000-0000-4000-8000-000000000010', '10000000-0000-4000-8000-000000000001', (select id from public.users where email = 'dev.owner@pharmsync.local'), null, 'd1000000-0000-4000-8000-000000000004', 900.00, (current_date - 3 + time '17:45')::timestamptz, 'cash'),
  ('e1000000-0000-4000-8000-000000000011', '10000000-0000-4000-8000-000000000001', (select id from public.users where email = 'dev.owner@pharmsync.local'), null, null, 9500.00, (current_date - 2 + time '09:20')::timestamptz, 'cash'),
  ('e1000000-0000-4000-8000-000000000012', '10000000-0000-4000-8000-000000000001', (select id from public.users where email = 'dev.owner@pharmsync.local'), null, 'd1000000-0000-4000-8000-000000000003', 9000.00, (current_date - 1 + time '14:00')::timestamptz, 'mtn_momo'),
  ('e1000000-0000-4000-8000-000000000013', '10000000-0000-4000-8000-000000000001', (select id from public.users where email = 'dev.owner@pharmsync.local'), null, null, 19000.00, (current_date + time '08:45')::timestamptz, 'cash'),
  ('e1000000-0000-4000-8000-000000000014', '10000000-0000-4000-8000-000000000001', (select id from public.users where email = 'dev.owner@pharmsync.local'), null, 'd1000000-0000-4000-8000-000000000002', 7700.00, (current_date + time '12:15')::timestamptz, 'cash');

-- tax_rate_id is looked up live (not hardcoded) since these ids are
-- environment-generated, not the fixed dev UUIDs the rest of this file uses.
do $$
declare
  v_exempt uuid := (select id from public.tax_rates where rate_percentage = 0);
  v_vat18 uuid := (select id from public.tax_rates where rate_percentage = 18);
begin
  insert into public.sale_items (sale_id, barcode_id, tax_rate_id, quantity, unit_price, subtotal, insurance_covered_amount) values
    -- Sale 1: 2x Paracetamol whole packs, cash, no insurance
    ('e1000000-0000-4000-8000-000000000001', (select id from public.barcodes where code = 'DEV-PAR-002-P01'), v_exempt, 10, 450.00, 4500.00, 0),
    ('e1000000-0000-4000-8000-000000000001', (select id from public.barcodes where code = 'DEV-PAR-002-P02'), v_exempt, 10, 450.00, 4500.00, 0),
    -- Sale 2: 1x Surgical Masks whole pack (18% VAT-inclusive), walk-in
    ('e1000000-0000-4000-8000-000000000002', (select id from public.barcodes where code = 'DEV-MSK-005-P01'), v_vat18, 50, 180.00, 7627.12, 0),
    -- Sale 3: 1x Metformin whole pack, RSSB insurance (90% override)
    ('e1000000-0000-4000-8000-000000000003', (select id from public.barcodes where code = 'DEV-MET-003-P01'), v_exempt, 7, 1100.00, 7700.00, 6930.00),
    -- Sale 4: 1x Amoxicillin whole pack, Medical Insurance Rwanda (70% default)
    ('e1000000-0000-4000-8000-000000000004', (select id from public.barcodes where code = 'DEV-AMX-001-P01'), v_exempt, 10, 950.00, 9500.00, 6650.00),
    -- Sale 5: 4 loose Paracetamol pieces from a pack, no insurance
    ('e1000000-0000-4000-8000-000000000005', (select id from public.barcodes where code = 'DEV-PAR-002-P03'), v_exempt, 4, 450.00, 1800.00, 0),
    -- Sale 6: 2x Amoxicillin whole packs, mtn_momo, 5% welcome discount
    ('e1000000-0000-4000-8000-000000000006', (select id from public.barcodes where code = 'DEV-AMX-001-P02'), v_exempt, 10, 950.00, 9500.00, 0),
    ('e1000000-0000-4000-8000-000000000006', (select id from public.barcodes where code = 'DEV-AMX-001-P03'), v_exempt, 10, 950.00, 9500.00, 0),
    -- Sale 7: 1x Surgical Masks whole pack, airtel_money
    ('e1000000-0000-4000-8000-000000000007', (select id from public.barcodes where code = 'DEV-MSK-005-P02'), v_vat18, 50, 180.00, 7627.12, 0),
    -- Sale 8: 1x Metformin whole pack, RSSB insurance again
    ('e1000000-0000-4000-8000-000000000008', (select id from public.barcodes where code = 'DEV-MET-003-P02'), v_exempt, 7, 1100.00, 7700.00, 6930.00),
    -- Sale 9: 3x Paracetamol whole packs, cash
    ('e1000000-0000-4000-8000-000000000009', (select id from public.barcodes where code = 'DEV-PAR-002-P04'), v_exempt, 10, 450.00, 4500.00, 0),
    ('e1000000-0000-4000-8000-000000000009', (select id from public.barcodes where code = 'DEV-PAR-002-P05'), v_exempt, 10, 450.00, 4500.00, 0),
    ('e1000000-0000-4000-8000-000000000009', (select id from public.barcodes where code = 'DEV-PAR-002-P06'), v_exempt, 10, 450.00, 4500.00, 0),
    -- Sale 10: 2 loose Paracetamol pieces for a child patient, cash
    ('e1000000-0000-4000-8000-000000000010', (select id from public.barcodes where code = 'DEV-PAR-002-P07'), v_exempt, 2, 450.00, 900.00, 0),
    -- Sale 11: 1x Amoxicillin whole pack, cash
    ('e1000000-0000-4000-8000-000000000011', (select id from public.barcodes where code = 'DEV-AMX-001-P04'), v_exempt, 10, 950.00, 9500.00, 0),
    -- Sale 12: 1x Surgical Masks whole pack, Medical Insurance Rwanda (70% default)
    ('e1000000-0000-4000-8000-000000000012', (select id from public.barcodes where code = 'DEV-MSK-005-P03'), v_vat18, 50, 180.00, 7627.12, 6300.00),
    -- Sale 13: 2x Amoxicillin whole packs, cash
    ('e1000000-0000-4000-8000-000000000013', (select id from public.barcodes where code = 'DEV-AMX-001-P05'), v_exempt, 10, 950.00, 9500.00, 0),
    ('e1000000-0000-4000-8000-000000000013', (select id from public.barcodes where code = 'DEV-AMX-001-P06'), v_exempt, 10, 950.00, 9500.00, 0),
    -- Sale 14: 1x Metformin whole pack, cash, no insurance this visit
    ('e1000000-0000-4000-8000-000000000014', (select id from public.barcodes where code = 'DEV-MET-003-P03'), v_exempt, 7, 1100.00, 7700.00, 0);
end $$;

insert into public.receipts (sale_id, receipt_number, issued_at)
select id, format('RCT-%s-DEV%s', to_char(sold_at, 'YYYYMMDD'), lpad((row_number() over (order by sold_at))::text, 3, '0')), sold_at
from public.sales
where id::text like 'e1000000-0000-4000-8000-0000000000%';

insert into public.insurance_claims (sale_id, insurance_provider_id, coverage_percentage_applied, claim_amount, status) values
  ('e1000000-0000-4000-8000-000000000003', 'b0000000-0000-4000-8000-000000000001', 90.00, 6930.00, 'paid'),
  ('e1000000-0000-4000-8000-000000000004', 'b0000000-0000-4000-8000-000000000002', 70.00, 6650.00, 'approved'),
  ('e1000000-0000-4000-8000-000000000008', 'b0000000-0000-4000-8000-000000000001', 90.00, 6930.00, 'submitted'),
  ('e1000000-0000-4000-8000-000000000012', 'b0000000-0000-4000-8000-000000000002', 70.00, 6300.00, 'rejected');

-- ── Consume the barcodes those sales actually sold ──────────────────────────
update public.barcodes set status = 'sold_out', quantity_available = 0
  where code in (
    'DEV-PAR-002-P01','DEV-PAR-002-P02','DEV-MSK-005-P01','DEV-MET-003-P01','DEV-AMX-001-P01',
    'DEV-AMX-001-P02','DEV-AMX-001-P03','DEV-MSK-005-P02','DEV-MET-003-P02','DEV-PAR-002-P04',
    'DEV-PAR-002-P05','DEV-PAR-002-P06','DEV-AMX-001-P04','DEV-MSK-005-P03','DEV-AMX-001-P05',
    'DEV-AMX-001-P06','DEV-MET-003-P03'
  );
update public.barcodes set pieces_per_pack = 6 where code = 'DEV-PAR-002-P03';
update public.barcodes set pieces_per_pack = 8 where code = 'DEV-PAR-002-P07';

-- ── One damaged-stock adjustment + notification, for History/Alerts ────────
update public.barcodes set status = 'damaged', quantity_available = 0 where code = 'DEV-PAR-002-P08';

insert into public.stock_adjustments (id, stock_batch_id, barcode_id, adjustment_type, quantity, reason, performed_by, adjusted_at) values
  ('f1000000-0000-4000-8000-000000000001', '80000000-0000-4000-8000-000000000002', (select id from public.barcodes where code = 'DEV-PAR-002-P08'), 'damage', -10, 'Pack found water-damaged during shelf audit', (select id from public.users where email = 'dev.owner@pharmsync.local'), (current_date - 2 + time '16:00')::timestamptz);

insert into public.notifications (id, branch_id, source_type, source_id, message, is_read) values
  ('c0000000-0000-4000-8000-000000000003', '10000000-0000-4000-8000-000000000001', 'stock_adjustment', 'f1000000-0000-4000-8000-000000000001', 'Paracetamol 500 mg pack DEV-PAR-002-P08 was marked damaged.', false);

-- ── One support ticket and one product request, for HelpPage/AdminPortal ───
insert into public.support_tickets (id, branch_id, raised_by, subject, description, status, priority, created_at) values
  ('f2000000-0000-4000-8000-000000000001', '10000000-0000-4000-8000-000000000001', (select id from public.users where email = 'dev.owner@pharmsync.local'), 'Receipt printer not connecting', 'The thermal receipt printer at the POS counter stopped responding after today''s software update.', 'open', 'medium', (current_date - 1 + time '08:30')::timestamptz);

insert into public.product_requests (id, branch_id, requested_by, message, status, created_at) values
  ('f3000000-0000-4000-8000-000000000001', '10000000-0000-4000-8000-000000000001', (select id from public.users where email = 'dev.owner@pharmsync.local'), 'Please add Ibuprofen 400mg tablets to the catalogue -- we get regular requests for it and currently have no equivalent product to stock.', 'pending', (current_date - 3 + time '11:00')::timestamptz);

commit;
