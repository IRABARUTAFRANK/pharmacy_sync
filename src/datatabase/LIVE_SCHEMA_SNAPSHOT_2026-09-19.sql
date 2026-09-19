-- ============================================================================
-- PharmSync -- LIVE SCHEMA SNAPSHOT, taken 2026-09-19
-- ============================================================================
-- WHAT THIS IS: every table/column/constraint/index, RLS policy, trigger,
-- function, and authenticated/anon grant that actually exists right now on
-- the live linked project (yqjrjzgsixwrbyvyliyz), captured by directly
-- introspecting the running database (pg_get_functiondef(), pg_policies,
-- pg_get_triggerdef(), information_schema/pg_catalog for tables) -- NOT
-- reconstructed by hand from the ~75 dated migration files in this
-- directory.
--
-- WHY THIS EXISTS INSTEAD OF JUST POINTING AT pharmacy_schema_consolidated.sql:
-- That file stopped being folded up to date somewhere around
-- 2026-09-07/2026-09-08 (its own "-- originally X" section headers jump
-- straight from 2026-09-07 files to 2026-09-18_admin_product_catalog_import.sql,
-- skipping an entire month of real schema work: organization/RBAC, branch
-- geolocation, stock transfer negotiation, storage locations, Pesapal
-- payments, staff removal/credentials, the one-manager-per-branch trigger,
-- etc.). It is now a MISLEADING bootstrap file, not a comprehensive one --
-- do not treat it as current. 2026-09-16_catch_up_full_state.sql documents
-- this exact same failure mode happening once already, mid-history, for
-- exactly the reason a hand-reconciled trail of ~75 files invites: same-day
-- files that redeclare the same function, some files that were written but
-- never actually run, order-dependent replays. Direct introspection sidesteps
-- all of that -- this is not "what the files say the database should look
-- like", it is what the database actually is, right now.
--
-- HOW TO USE THIS ON A DIFFERENT / OLDER DATABASE (e.g. the backup project):
--   1. This file is close to idempotent (create table if not exists, create
--      or replace function, drop-then-create for policies/triggers), but it
--      is NOT a safe blind first move against a database with real data:
--        - The CONSTRAINTS block below will error on "already exists" if the
--          target already has some of these constraints under the same
--          auto-generated name but a different definition -- read the error,
--          it names the one clashing constraint, drop or reconcile just that
--          one and re-run.
--        - Table/column DDL only ADDS what is missing; it never drops or
--          renames a column the older database no longer has, so it will
--          not by itself remove anything genuinely obsolete on the older
--          side. Diff by hand if the old DB needs to end up byte-for-byte
--          identical, not just "has everything current".
--   2. Run the sections in the order they appear in this file: EXTENSIONS,
--      TABLES, CONSTRAINTS, INDEXES, ROW LEVEL SECURITY, FUNCTIONS,
--      POLICIES, TRIGGERS, GRANTS. Policies and triggers call functions
--      (is_super_admin(), current_branch_id(), enforce_one_manager_per_branch(),
--      ...) that must already exist, which is why FUNCTIONS comes before them.
--   3. Practically, via the Supabase CLI against the OLD/backup project once
--      it is linked: npx supabase db query --linked --file src/datatabase/LIVE_SCHEMA_SNAPSHOT_2026-09-19.sql
--      (or paste this whole file into that project SQL Editor).
--   4. On a genuinely EMPTY brand-new project, this one file is a complete
--      bootstrap by itself -- no need to additionally run
--      pharmacy_schema_consolidated.sql or any dated file, since every one
--      of them is already represented in the live state this was captured
--      from.
--
-- DELIBERATELY NOT INCLUDED -- these files in this directory are NOT schema
-- migrations and must never be run against a database anyone cares about
-- (destructive, or dev-only fake data):
--   - RESET_wipe_all_organizations_branches_users.sql  (wipes the entire platform)
--   - 2026-08-22_reset_all_branches.sql                (wipes every branch)
--   - development_seed.sql                             (fake demo data, dev sandbox only)
--   - 2026-09-11_extended_dev_seed_activity.sql         (fake sales/patients/etc, dev sandbox only)
--   - 2026-09-16_bulk_test_data_seed.sql / _cleanup.sql (bulk fake load-test data + its own cleanup)
--
-- Two platform-managed extensions the introspection query found
-- (pg_stat_statements, supabase_vault) are provisioned by Supabase itself on
-- every project and are deliberately left out below -- there is nothing to
-- run for them.
-- ============================================================================


-- ============================================================================
-- EXTENSIONS
-- ============================================================================

create extension if not exists pgcrypto;
create extension if not exists "uuid-ossp";


-- ============================================================================
-- TABLES
-- ============================================================================

create table if not exists public.barcodes (
  id uuid default gen_random_uuid() not null,
  stock_batch_id uuid not null,
  parent_barcode_id uuid,
  barcode_type character varying(10) default 'pack'::character varying not null,
  code character varying(64) not null,
  code_source character varying(20) default 'generated'::character varying not null,
  child_count integer,
  pieces_per_pack integer,
  quantity_available integer not null,
  status character varying(20) default 'active'::character varying not null,
  created_at timestamp with time zone default now() not null
);

create table if not exists public.batch_recalls (
  id uuid default gen_random_uuid() not null,
  product_variant_id uuid not null,
  batch_number character varying(80) not null,
  manufacturer_name character varying(150),
  reason text not null,
  recalled_by uuid not null,
  recalled_at timestamp with time zone default now() not null
);

create table if not exists public.branch_applications (
  id uuid default gen_random_uuid() not null,
  application_code character varying(32) not null,
  pharmacy_name character varying(150) not null,
  phone character varying(30) not null,
  email character varying(150) not null,
  location text not null,
  status character varying(20) default 'pending'::character varying not null,
  called_at timestamp with time zone,
  denied_reason text,
  branch_id uuid,
  submitted_at timestamp with time zone default now() not null,
  otp_sent_at timestamp with time zone
);

create table if not exists public.branch_directory (
  branch_id uuid not null,
  display_name character varying(150) not null
);

create table if not exists public.branch_distance_measurements (
  id uuid default gen_random_uuid() not null,
  organization_id uuid not null,
  branch_a_id uuid not null,
  branch_b_id uuid not null,
  distance_km numeric(10,2) not null,
  measured_by uuid,
  created_at timestamp with time zone default now() not null
);

create table if not exists public.branch_product_categorization (
  branch_id uuid not null,
  product_id uuid not null,
  category_id uuid not null
);

create table if not exists public.branch_settings (
  id uuid default gen_random_uuid() not null,
  branch_id uuid not null,
  setting_key character varying(100) not null,
  setting_value text,
  updated_by uuid,
  updated_at timestamp with time zone default now() not null
);

create table if not exists public.branches (
  id uuid default gen_random_uuid() not null,
  name character varying(150) not null,
  address text,
  phone character varying(30),
  created_at timestamp with time zone default now() not null,
  email character varying(150),
  branch_code character varying(32),
  activation_code character varying(24),
  status character varying(20) default 'active'::character varying not null,
  called_at timestamp with time zone,
  locked_at timestamp with time zone,
  failed_logins integer default 0 not null,
  denied_reason text,
  tin character varying(20),
  logo_path text,
  bank_account_number character varying(50),
  bank_account_name character varying(150),
  momo_pay_number character varying(50),
  out_of_stock_reminder_hours integer default 6 not null,
  website character varying(150),
  license_number character varying(50),
  license_expiry_date date,
  ebm_device_serial character varying(50),
  default_language character varying(5) default 'en'::character varying not null,
  receipt_number_prefix character varying(10) default 'RCT'::character varying not null,
  pos_cash_enabled boolean default true not null,
  pos_mtn_momo_enabled boolean default true not null,
  pos_airtel_money_enabled boolean default true not null,
  pos_card_enabled boolean default false not null,
  pos_insurance_enabled boolean default true not null,
  pos_default_payment_method character varying(20) default 'cash'::character varying not null,
  pos_require_patient_name boolean default false not null,
  pos_allow_discounts boolean default true not null,
  pos_show_patient_history boolean default true not null,
  expiry_alert_threshold_days integer default 60 not null,
  default_reorder_min integer default 0 not null,
  organization_id uuid,
  latitude double precision,
  longitude double precision
);

create table if not exists public.dashboard_reports (
  id uuid default gen_random_uuid() not null,
  branch_id uuid not null,
  report_type character varying(50) not null,
  data jsonb default '{}'::jsonb not null,
  generated_at timestamp with time zone default now() not null
);

create table if not exists public.deleted_branches_log (
  id uuid default gen_random_uuid() not null,
  branch_id uuid not null,
  pharmacy_name character varying(150) not null,
  phone character varying(30),
  email character varying(150),
  branch_code character varying(32),
  location text,
  reason text,
  deleted_by_email text,
  deleted_at timestamp with time zone default now() not null
);

create table if not exists public.discounts (
  id uuid default gen_random_uuid() not null,
  name character varying(100) not null,
  discount_type character varying(20) not null,
  value numeric(12,2) not null,
  valid_from date,
  valid_to date,
  branch_id uuid
);

create table if not exists public.insurance_claims (
  id uuid default gen_random_uuid() not null,
  sale_id uuid not null,
  insurance_provider_id uuid not null,
  coverage_percentage_applied numeric(5,2) not null,
  claim_amount numeric(12,2) not null,
  status character varying(20) default 'submitted'::character varying not null,
  submitted_at timestamp with time zone default now() not null
);

create table if not exists public.insurance_product_coverage (
  insurance_provider_id uuid not null,
  product_id uuid not null,
  coverage_percentage numeric(5,2) not null
);

create table if not exists public.insurance_providers (
  id uuid default gen_random_uuid() not null,
  name character varying(150) not null,
  contact_info text,
  default_coverage_percentage numeric(5,2) default 0 not null,
  tin character varying(50)
);

create table if not exists public.insurance_variant_prices (
  insurance_provider_id uuid not null,
  product_variant_id uuid not null,
  fixed_price numeric(12,2) not null
);

create table if not exists public.notifications (
  id uuid default gen_random_uuid() not null,
  branch_id uuid not null,
  source_type character varying(30) not null,
  source_id uuid not null,
  message text not null,
  is_read boolean default false not null,
  created_at timestamp with time zone default now() not null
);

create table if not exists public.organization_applications (
  id uuid default gen_random_uuid() not null,
  application_code character varying(32) not null,
  legal_name character varying(200) not null,
  tin character varying(20),
  phone character varying(30) not null,
  email character varying(150) not null,
  location text not null,
  status character varying(20) default 'pending'::character varying not null,
  called_at timestamp with time zone,
  denied_reason text,
  otp_sent_at timestamp with time zone,
  organization_id uuid,
  first_branch_id uuid,
  submitted_at timestamp with time zone default now() not null
);

create table if not exists public.organization_invites (
  id uuid default gen_random_uuid() not null,
  organization_id uuid not null,
  branch_id uuid not null,
  email character varying(150) not null,
  full_name character varying(150) not null,
  role character varying(20) not null,
  status character varying(20) default 'otp_sent'::character varying not null,
  invited_by uuid not null,
  otp_sent_at timestamp with time zone default now() not null,
  denied_reason text,
  created_at timestamp with time zone default now() not null
);

create table if not exists public.organization_members (
  id uuid default gen_random_uuid() not null,
  organization_id uuid not null,
  user_id uuid not null,
  role character varying(20) not null,
  created_at timestamp with time zone default now() not null
);

create table if not exists public.patients (
  id uuid default gen_random_uuid() not null,
  branch_id uuid not null,
  full_name character varying(150) not null,
  gender character varying(10),
  age integer,
  tin_or_phone character varying(50) not null,
  created_by uuid,
  created_at timestamp with time zone default now() not null,
  updated_at timestamp with time zone default now() not null,
  phone character varying(50),
  tin character varying(50),
  insurance_number character varying(50)
);

create table if not exists public.pending_payments (
  id uuid default gen_random_uuid() not null,
  branch_id uuid not null,
  cashier_id uuid not null,
  cart_snapshot jsonb not null,
  patient_phone character varying(30),
  payment_method character varying(20) not null,
  amount numeric(12,2) not null,
  currency character varying(3) default 'RWF'::character varying not null,
  provider character varying(20) default 'pesapal'::character varying not null,
  merchant_reference text not null,
  provider_reference text,
  status character varying(20) default 'pending'::character varying not null,
  sale_id uuid,
  provider_status_payload jsonb,
  failure_reason text,
  created_at timestamp with time zone default now() not null,
  updated_at timestamp with time zone default now() not null
);

create table if not exists public.pharmacy_organizations (
  id uuid default gen_random_uuid() not null,
  legal_name character varying(200) not null,
  trade_name character varying(200),
  tin character varying(20),
  status character varying(20) default 'active'::character varying not null,
  created_at timestamp with time zone default now() not null
);

create table if not exists public.product_categories (
  id uuid default gen_random_uuid() not null,
  branch_id uuid not null,
  name character varying(100) not null,
  description text,
  created_at timestamp with time zone default now() not null
);

create table if not exists public.product_requests (
  id uuid default gen_random_uuid() not null,
  branch_id uuid not null,
  requested_by uuid not null,
  message text not null,
  image_path text,
  status character varying(20) default 'pending'::character varying not null,
  resolved_product_id uuid,
  resolved_variant_id uuid,
  resolved_by uuid,
  resolved_at timestamp with time zone,
  rejection_reason text,
  created_at timestamp with time zone default now() not null
);

create table if not exists public.product_storage_locations (
  branch_id uuid not null,
  product_id uuid not null,
  storage_location_id uuid not null,
  updated_at timestamp with time zone default now() not null,
  updated_by uuid
);

create table if not exists public.product_variants (
  id uuid default gen_random_uuid() not null,
  product_id uuid not null,
  dosage character varying(50),
  form character varying(50),
  unit character varying(30),
  created_at timestamp with time zone default now() not null,
  catalog_code character varying(40)
);

create table if not exists public.products (
  id uuid default gen_random_uuid() not null,
  tax_rate_id uuid not null,
  product_type character varying(20) default 'medicine'::character varying not null,
  name character varying(150) not null,
  generic_name character varying(150),
  description text
);

create table if not exists public.receipts (
  id uuid default gen_random_uuid() not null,
  sale_id uuid not null,
  receipt_number character varying(50) not null,
  issued_at timestamp with time zone default now() not null
);

create table if not exists public.reorder_points (
  id uuid default gen_random_uuid() not null,
  product_id uuid not null,
  branch_id uuid not null,
  min_quantity integer default 0 not null,
  max_quantity integer
);

create table if not exists public.role_change_log (
  id uuid default gen_random_uuid() not null,
  scope character varying(20) not null,
  organization_id uuid,
  branch_id uuid,
  actor_user_id uuid,
  actor_email text,
  target_user_id uuid not null,
  target_email text,
  old_role character varying(30),
  new_role character varying(30),
  action character varying(30) not null,
  reason text,
  created_at timestamp with time zone default now() not null
);

create table if not exists public.sale_items (
  id uuid default gen_random_uuid() not null,
  sale_id uuid not null,
  barcode_id uuid not null,
  tax_rate_id uuid not null,
  quantity integer default 1 not null,
  unit_price numeric(12,2) not null,
  subtotal numeric(12,2) not null,
  insurance_covered_amount numeric(12,2) default 0 not null
);

create table if not exists public.sales (
  id uuid default gen_random_uuid() not null,
  branch_id uuid not null,
  cashier_id uuid not null,
  discount_id uuid,
  total_amount numeric(12,2) not null,
  sold_at timestamp with time zone default now() not null,
  patient_id uuid,
  payment_method character varying(20),
  patient_phone character varying(50),
  patient_tin character varying(50),
  insurer_tin character varying(50),
  receipt_note character varying(500)
);

create table if not exists public.sales_forecast_snapshots (
  id uuid default gen_random_uuid() not null,
  branch_id uuid not null,
  product_id uuid,
  category_id uuid,
  generated_at timestamp with time zone default now() not null,
  bucket text not null,
  points jsonb not null,
  notified_at timestamp with time zone
);

create table if not exists public.sales_forecasts (
  id uuid default gen_random_uuid() not null,
  branch_id uuid not null,
  product_variant_id uuid not null,
  forecast_period character varying(20) not null,
  predicted_quantity integer not null,
  generated_at timestamp with time zone default now() not null
);

create table if not exists public.stock_adjustments (
  id uuid default gen_random_uuid() not null,
  stock_batch_id uuid,
  barcode_id uuid,
  adjustment_type character varying(30) not null,
  quantity integer not null,
  reason text,
  performed_by uuid not null,
  adjusted_at timestamp with time zone default now() not null
);

create table if not exists public.stock_batches (
  id uuid default gen_random_uuid() not null,
  product_variant_id uuid not null,
  branch_id uuid not null,
  supplier_id uuid,
  manufacturer_name character varying(150),
  delivery_code character varying(80),
  logged_by uuid not null,
  batch_number character varying(80) not null,
  expiry_date date not null,
  cost_price numeric(12,2) not null,
  selling_price numeric(12,2) not null,
  quantity_received integer not null,
  received_at timestamp with time zone default now() not null,
  delivery_id uuid,
  expiry_warned_at timestamp with time zone
);

create table if not exists public.stock_deliveries (
  id uuid default gen_random_uuid() not null,
  branch_id uuid not null,
  supplier_id uuid not null,
  delivery_code character varying(80) not null,
  received_by uuid not null,
  received_at timestamp with time zone default now() not null,
  notes text,
  created_at timestamp with time zone default now() not null
);

create table if not exists public.stock_transfer_items (
  id uuid default gen_random_uuid() not null,
  transfer_id uuid not null,
  stock_batch_id uuid not null
);

create table if not exists public.stock_transfer_needs (
  id uuid default gen_random_uuid() not null,
  organization_id uuid not null,
  requesting_branch_id uuid not null,
  product_variant_id uuid not null,
  requested_quantity integer not null,
  notes text,
  status character varying(20) default 'open'::character varying not null,
  transfer_id uuid,
  requested_by uuid not null,
  created_at timestamp with time zone default now() not null
);

create table if not exists public.stock_transfer_offers (
  id uuid default gen_random_uuid() not null,
  need_id uuid not null,
  target_branch_id uuid not null,
  status character varying(20) default 'pending'::character varying not null,
  accepted_batch_ids uuid[],
  denial_reason text,
  responded_by uuid,
  responded_at timestamp with time zone,
  created_at timestamp with time zone default now() not null
);

create table if not exists public.stock_transfers (
  id uuid default gen_random_uuid() not null,
  organization_id uuid not null,
  from_branch_id uuid not null,
  to_branch_id uuid not null,
  status character varying(20) default 'pending'::character varying not null,
  requested_by uuid not null,
  approved_by uuid,
  requested_at timestamp with time zone default now() not null,
  approved_at timestamp with time zone,
  dispatched_at timestamp with time zone,
  received_at timestamp with time zone,
  notes text,
  rejection_reason text
);

create table if not exists public.storage_locations (
  id uuid default gen_random_uuid() not null,
  branch_id uuid not null,
  name character varying(100) not null,
  created_at timestamp with time zone default now() not null
);

create table if not exists public.suppliers (
  id uuid default gen_random_uuid() not null,
  supplier_name character varying(150) not null,
  contact character varying(150),
  location character varying(150),
  created_at timestamp with time zone default now() not null,
  branch_id uuid
);

create table if not exists public.support_tickets (
  id uuid default gen_random_uuid() not null,
  branch_id uuid not null,
  raised_by uuid not null,
  subject character varying(150) not null,
  description text,
  status character varying(20) default 'open'::character varying not null,
  created_at timestamp with time zone default now() not null,
  priority character varying(10) default 'medium'::character varying not null
);

create table if not exists public.tax_rates (
  id uuid default gen_random_uuid() not null,
  name character varying(80) not null,
  rate_percentage numeric(5,2) default 0 not null
);

create table if not exists public.users (
  id uuid not null,
  branch_id uuid not null,
  full_name character varying(150) not null,
  email character varying(150) not null,
  role character varying(30) default 'staff'::character varying not null,
  is_active boolean default true not null,
  created_at timestamp with time zone default now() not null,
  is_removed boolean default false not null
);


-- ============================================================================
-- CONSTRAINTS (each guarded -- skips with a notice if it already exists,
-- rather than aborting the whole run)
-- ============================================================================

do $guard$ begin
  alter table barcodes add constraint barcodes_pkey PRIMARY KEY (id);
exception when others then raise notice 'skipping %: %', 'barcodes_pkey', sqlerrm;
end $guard$;

do $guard$ begin
  alter table batch_recalls add constraint batch_recalls_pkey PRIMARY KEY (id);
exception when others then raise notice 'skipping %: %', 'batch_recalls_pkey', sqlerrm;
end $guard$;

do $guard$ begin
  alter table branch_applications add constraint branch_applications_pkey PRIMARY KEY (id);
exception when others then raise notice 'skipping %: %', 'branch_applications_pkey', sqlerrm;
end $guard$;

do $guard$ begin
  alter table branch_directory add constraint branch_directory_pkey PRIMARY KEY (branch_id);
exception when others then raise notice 'skipping %: %', 'branch_directory_pkey', sqlerrm;
end $guard$;

do $guard$ begin
  alter table branch_distance_measurements add constraint branch_distance_measurements_pkey PRIMARY KEY (id);
exception when others then raise notice 'skipping %: %', 'branch_distance_measurements_pkey', sqlerrm;
end $guard$;

do $guard$ begin
  alter table branch_product_categorization add constraint branch_product_categorization_pkey PRIMARY KEY (branch_id, product_id);
exception when others then raise notice 'skipping %: %', 'branch_product_categorization_pkey', sqlerrm;
end $guard$;

do $guard$ begin
  alter table branch_settings add constraint branch_settings_pkey PRIMARY KEY (id);
exception when others then raise notice 'skipping %: %', 'branch_settings_pkey', sqlerrm;
end $guard$;

do $guard$ begin
  alter table branches add constraint branches_pkey PRIMARY KEY (id);
exception when others then raise notice 'skipping %: %', 'branches_pkey', sqlerrm;
end $guard$;

do $guard$ begin
  alter table dashboard_reports add constraint dashboard_reports_pkey PRIMARY KEY (id);
exception when others then raise notice 'skipping %: %', 'dashboard_reports_pkey', sqlerrm;
end $guard$;

do $guard$ begin
  alter table deleted_branches_log add constraint deleted_branches_log_pkey PRIMARY KEY (id);
exception when others then raise notice 'skipping %: %', 'deleted_branches_log_pkey', sqlerrm;
end $guard$;

do $guard$ begin
  alter table discounts add constraint discounts_pkey PRIMARY KEY (id);
exception when others then raise notice 'skipping %: %', 'discounts_pkey', sqlerrm;
end $guard$;

do $guard$ begin
  alter table insurance_claims add constraint insurance_claims_pkey PRIMARY KEY (id);
exception when others then raise notice 'skipping %: %', 'insurance_claims_pkey', sqlerrm;
end $guard$;

do $guard$ begin
  alter table insurance_product_coverage add constraint insurance_product_coverage_pkey PRIMARY KEY (insurance_provider_id, product_id);
exception when others then raise notice 'skipping %: %', 'insurance_product_coverage_pkey', sqlerrm;
end $guard$;

do $guard$ begin
  alter table insurance_providers add constraint insurance_providers_pkey PRIMARY KEY (id);
exception when others then raise notice 'skipping %: %', 'insurance_providers_pkey', sqlerrm;
end $guard$;

do $guard$ begin
  alter table insurance_variant_prices add constraint insurance_variant_prices_pkey PRIMARY KEY (insurance_provider_id, product_variant_id);
exception when others then raise notice 'skipping %: %', 'insurance_variant_prices_pkey', sqlerrm;
end $guard$;

do $guard$ begin
  alter table notifications add constraint notifications_pkey PRIMARY KEY (id);
exception when others then raise notice 'skipping %: %', 'notifications_pkey', sqlerrm;
end $guard$;

do $guard$ begin
  alter table organization_applications add constraint organization_applications_pkey PRIMARY KEY (id);
exception when others then raise notice 'skipping %: %', 'organization_applications_pkey', sqlerrm;
end $guard$;

do $guard$ begin
  alter table organization_invites add constraint organization_invites_pkey PRIMARY KEY (id);
exception when others then raise notice 'skipping %: %', 'organization_invites_pkey', sqlerrm;
end $guard$;

do $guard$ begin
  alter table organization_members add constraint organization_members_pkey PRIMARY KEY (id);
exception when others then raise notice 'skipping %: %', 'organization_members_pkey', sqlerrm;
end $guard$;

do $guard$ begin
  alter table patients add constraint patients_pkey PRIMARY KEY (id);
exception when others then raise notice 'skipping %: %', 'patients_pkey', sqlerrm;
end $guard$;

do $guard$ begin
  alter table pending_payments add constraint pending_payments_pkey PRIMARY KEY (id);
exception when others then raise notice 'skipping %: %', 'pending_payments_pkey', sqlerrm;
end $guard$;

do $guard$ begin
  alter table pharmacy_organizations add constraint pharmacy_organizations_pkey PRIMARY KEY (id);
exception when others then raise notice 'skipping %: %', 'pharmacy_organizations_pkey', sqlerrm;
end $guard$;

do $guard$ begin
  alter table product_categories add constraint product_categories_pkey PRIMARY KEY (id);
exception when others then raise notice 'skipping %: %', 'product_categories_pkey', sqlerrm;
end $guard$;

do $guard$ begin
  alter table product_requests add constraint product_requests_pkey PRIMARY KEY (id);
exception when others then raise notice 'skipping %: %', 'product_requests_pkey', sqlerrm;
end $guard$;

do $guard$ begin
  alter table product_storage_locations add constraint product_storage_locations_pkey PRIMARY KEY (branch_id, product_id);
exception when others then raise notice 'skipping %: %', 'product_storage_locations_pkey', sqlerrm;
end $guard$;

do $guard$ begin
  alter table product_variants add constraint product_variants_pkey PRIMARY KEY (id);
exception when others then raise notice 'skipping %: %', 'product_variants_pkey', sqlerrm;
end $guard$;

do $guard$ begin
  alter table products add constraint products_pkey PRIMARY KEY (id);
exception when others then raise notice 'skipping %: %', 'products_pkey', sqlerrm;
end $guard$;

do $guard$ begin
  alter table receipts add constraint receipts_pkey PRIMARY KEY (id);
exception when others then raise notice 'skipping %: %', 'receipts_pkey', sqlerrm;
end $guard$;

do $guard$ begin
  alter table reorder_points add constraint reorder_points_pkey PRIMARY KEY (id);
exception when others then raise notice 'skipping %: %', 'reorder_points_pkey', sqlerrm;
end $guard$;

do $guard$ begin
  alter table role_change_log add constraint role_change_log_pkey PRIMARY KEY (id);
exception when others then raise notice 'skipping %: %', 'role_change_log_pkey', sqlerrm;
end $guard$;

do $guard$ begin
  alter table sale_items add constraint sale_items_pkey PRIMARY KEY (id);
exception when others then raise notice 'skipping %: %', 'sale_items_pkey', sqlerrm;
end $guard$;

do $guard$ begin
  alter table sales add constraint sales_pkey PRIMARY KEY (id);
exception when others then raise notice 'skipping %: %', 'sales_pkey', sqlerrm;
end $guard$;

do $guard$ begin
  alter table sales_forecast_snapshots add constraint sales_forecast_snapshots_pkey PRIMARY KEY (id);
exception when others then raise notice 'skipping %: %', 'sales_forecast_snapshots_pkey', sqlerrm;
end $guard$;

do $guard$ begin
  alter table sales_forecasts add constraint sales_forecasts_pkey PRIMARY KEY (id);
exception when others then raise notice 'skipping %: %', 'sales_forecasts_pkey', sqlerrm;
end $guard$;

do $guard$ begin
  alter table stock_adjustments add constraint stock_adjustments_pkey PRIMARY KEY (id);
exception when others then raise notice 'skipping %: %', 'stock_adjustments_pkey', sqlerrm;
end $guard$;

do $guard$ begin
  alter table stock_batches add constraint stock_batches_pkey PRIMARY KEY (id);
exception when others then raise notice 'skipping %: %', 'stock_batches_pkey', sqlerrm;
end $guard$;

do $guard$ begin
  alter table stock_deliveries add constraint stock_deliveries_pkey PRIMARY KEY (id);
exception when others then raise notice 'skipping %: %', 'stock_deliveries_pkey', sqlerrm;
end $guard$;

do $guard$ begin
  alter table stock_transfer_items add constraint stock_transfer_items_pkey PRIMARY KEY (id);
exception when others then raise notice 'skipping %: %', 'stock_transfer_items_pkey', sqlerrm;
end $guard$;

do $guard$ begin
  alter table stock_transfer_needs add constraint stock_transfer_needs_pkey PRIMARY KEY (id);
exception when others then raise notice 'skipping %: %', 'stock_transfer_needs_pkey', sqlerrm;
end $guard$;

do $guard$ begin
  alter table stock_transfer_offers add constraint stock_transfer_offers_pkey PRIMARY KEY (id);
exception when others then raise notice 'skipping %: %', 'stock_transfer_offers_pkey', sqlerrm;
end $guard$;

do $guard$ begin
  alter table stock_transfers add constraint stock_transfers_pkey PRIMARY KEY (id);
exception when others then raise notice 'skipping %: %', 'stock_transfers_pkey', sqlerrm;
end $guard$;

do $guard$ begin
  alter table storage_locations add constraint storage_locations_pkey PRIMARY KEY (id);
exception when others then raise notice 'skipping %: %', 'storage_locations_pkey', sqlerrm;
end $guard$;

do $guard$ begin
  alter table suppliers add constraint suppliers_pkey PRIMARY KEY (id);
exception when others then raise notice 'skipping %: %', 'suppliers_pkey', sqlerrm;
end $guard$;

do $guard$ begin
  alter table support_tickets add constraint support_tickets_pkey PRIMARY KEY (id);
exception when others then raise notice 'skipping %: %', 'support_tickets_pkey', sqlerrm;
end $guard$;

do $guard$ begin
  alter table tax_rates add constraint tax_rates_pkey PRIMARY KEY (id);
exception when others then raise notice 'skipping %: %', 'tax_rates_pkey', sqlerrm;
end $guard$;

do $guard$ begin
  alter table users add constraint users_pkey PRIMARY KEY (id);
exception when others then raise notice 'skipping %: %', 'users_pkey', sqlerrm;
end $guard$;

do $guard$ begin
  alter table barcodes add constraint barcodes_code_key UNIQUE (code);
exception when others then raise notice 'skipping %: %', 'barcodes_code_key', sqlerrm;
end $guard$;

do $guard$ begin
  alter table branch_applications add constraint branch_applications_application_code_key UNIQUE (application_code);
exception when others then raise notice 'skipping %: %', 'branch_applications_application_code_key', sqlerrm;
end $guard$;

do $guard$ begin
  alter table branch_settings add constraint branch_settings_branch_id_setting_key_key UNIQUE (branch_id, setting_key);
exception when others then raise notice 'skipping %: %', 'branch_settings_branch_id_setting_key_key', sqlerrm;
end $guard$;

do $guard$ begin
  alter table insurance_claims add constraint insurance_claims_sale_id_key UNIQUE (sale_id);
exception when others then raise notice 'skipping %: %', 'insurance_claims_sale_id_key', sqlerrm;
end $guard$;

do $guard$ begin
  alter table insurance_providers add constraint insurance_providers_name_key UNIQUE (name);
exception when others then raise notice 'skipping %: %', 'insurance_providers_name_key', sqlerrm;
end $guard$;

do $guard$ begin
  alter table organization_applications add constraint organization_applications_application_code_key UNIQUE (application_code);
exception when others then raise notice 'skipping %: %', 'organization_applications_application_code_key', sqlerrm;
end $guard$;

do $guard$ begin
  alter table organization_members add constraint organization_members_organization_id_user_id_key UNIQUE (organization_id, user_id);
exception when others then raise notice 'skipping %: %', 'organization_members_organization_id_user_id_key', sqlerrm;
end $guard$;

do $guard$ begin
  alter table patients add constraint patients_branch_id_tin_or_phone_key UNIQUE (branch_id, tin_or_phone);
exception when others then raise notice 'skipping %: %', 'patients_branch_id_tin_or_phone_key', sqlerrm;
end $guard$;

do $guard$ begin
  alter table pending_payments add constraint pending_payments_merchant_reference_key UNIQUE (merchant_reference);
exception when others then raise notice 'skipping %: %', 'pending_payments_merchant_reference_key', sqlerrm;
end $guard$;

do $guard$ begin
  alter table product_categories add constraint product_categories_branch_id_name_key UNIQUE (branch_id, name);
exception when others then raise notice 'skipping %: %', 'product_categories_branch_id_name_key', sqlerrm;
end $guard$;

do $guard$ begin
  alter table product_categories add constraint product_categories_id_branch_id_key UNIQUE (id, branch_id);
exception when others then raise notice 'skipping %: %', 'product_categories_id_branch_id_key', sqlerrm;
end $guard$;

do $guard$ begin
  alter table receipts add constraint receipts_receipt_number_key UNIQUE (receipt_number);
exception when others then raise notice 'skipping %: %', 'receipts_receipt_number_key', sqlerrm;
end $guard$;

do $guard$ begin
  alter table receipts add constraint receipts_sale_id_key UNIQUE (sale_id);
exception when others then raise notice 'skipping %: %', 'receipts_sale_id_key', sqlerrm;
end $guard$;

do $guard$ begin
  alter table reorder_points add constraint reorder_points_product_id_branch_id_key UNIQUE (product_id, branch_id);
exception when others then raise notice 'skipping %: %', 'reorder_points_product_id_branch_id_key', sqlerrm;
end $guard$;

do $guard$ begin
  alter table stock_batches add constraint stock_batches_product_variant_id_batch_number_branch_id_key UNIQUE (product_variant_id, batch_number, branch_id);
exception when others then raise notice 'skipping %: %', 'stock_batches_product_variant_id_batch_number_branch_id_key', sqlerrm;
end $guard$;

do $guard$ begin
  alter table stock_deliveries add constraint stock_deliveries_branch_id_delivery_code_key UNIQUE (branch_id, delivery_code);
exception when others then raise notice 'skipping %: %', 'stock_deliveries_branch_id_delivery_code_key', sqlerrm;
end $guard$;

do $guard$ begin
  alter table stock_transfer_items add constraint stock_transfer_items_transfer_id_stock_batch_id_key UNIQUE (transfer_id, stock_batch_id);
exception when others then raise notice 'skipping %: %', 'stock_transfer_items_transfer_id_stock_batch_id_key', sqlerrm;
end $guard$;

do $guard$ begin
  alter table storage_locations add constraint storage_locations_branch_id_name_key UNIQUE (branch_id, name);
exception when others then raise notice 'skipping %: %', 'storage_locations_branch_id_name_key', sqlerrm;
end $guard$;

do $guard$ begin
  alter table tax_rates add constraint tax_rates_name_key UNIQUE (name);
exception when others then raise notice 'skipping %: %', 'tax_rates_name_key', sqlerrm;
end $guard$;

do $guard$ begin
  alter table users add constraint users_email_key UNIQUE (email);
exception when others then raise notice 'skipping %: %', 'users_email_key', sqlerrm;
end $guard$;

do $guard$ begin
  alter table barcodes add constraint barcodes_barcode_type_check CHECK (((barcode_type)::text = ANY ((ARRAY['box'::character varying, 'pack'::character varying])::text[])));
exception when others then raise notice 'skipping %: %', 'barcodes_barcode_type_check', sqlerrm;
end $guard$;

do $guard$ begin
  alter table barcodes add constraint barcodes_check CHECK (((((barcode_type)::text = 'box'::text) AND (pieces_per_pack IS NULL)) OR (((barcode_type)::text = 'pack'::text) AND (child_count IS NULL))));
exception when others then raise notice 'skipping %: %', 'barcodes_check', sqlerrm;
end $guard$;

do $guard$ begin
  alter table barcodes add constraint barcodes_child_count_check CHECK (((child_count IS NULL) OR (child_count >= 0)));
exception when others then raise notice 'skipping %: %', 'barcodes_child_count_check', sqlerrm;
end $guard$;

do $guard$ begin
  alter table barcodes add constraint barcodes_code_source_check CHECK (((code_source)::text = ANY ((ARRAY['manufacturer'::character varying, 'generated'::character varying])::text[])));
exception when others then raise notice 'skipping %: %', 'barcodes_code_source_check', sqlerrm;
end $guard$;

do $guard$ begin
  alter table barcodes add constraint barcodes_packing_shape CHECK (((((barcode_type)::text = 'box'::text) AND (parent_barcode_id IS NULL) AND (child_count IS NOT NULL) AND (child_count > 0) AND (pieces_per_pack IS NULL)) OR (((barcode_type)::text = 'pack'::text) AND (child_count IS NULL) AND (pieces_per_pack IS NOT NULL) AND (pieces_per_pack > 0))));
exception when others then raise notice 'skipping %: %', 'barcodes_packing_shape', sqlerrm;
end $guard$;

do $guard$ begin
  alter table barcodes add constraint barcodes_pieces_per_pack_check CHECK (((pieces_per_pack IS NULL) OR (pieces_per_pack > 0)));
exception when others then raise notice 'skipping %: %', 'barcodes_pieces_per_pack_check', sqlerrm;
end $guard$;

do $guard$ begin
  alter table barcodes add constraint barcodes_quantity_available_check CHECK ((quantity_available >= 0));
exception when others then raise notice 'skipping %: %', 'barcodes_quantity_available_check', sqlerrm;
end $guard$;

do $guard$ begin
  alter table barcodes add constraint barcodes_status_check CHECK (((status)::text = ANY ((ARRAY['active'::character varying, 'sold_out'::character varying, 'expired'::character varying, 'recalled'::character varying, 'damaged'::character varying, 'in_transit'::character varying])::text[])));
exception when others then raise notice 'skipping %: %', 'barcodes_status_check', sqlerrm;
end $guard$;

do $guard$ begin
  alter table branch_applications add constraint branch_applications_status_check CHECK (((status)::text = ANY ((ARRAY['pending'::character varying, 'otp_sent'::character varying, 'active'::character varying, 'denied'::character varying])::text[])));
exception when others then raise notice 'skipping %: %', 'branch_applications_status_check', sqlerrm;
end $guard$;

do $guard$ begin
  alter table branch_distance_measurements add constraint branch_distance_measurements_check CHECK ((branch_a_id <> branch_b_id));
exception when others then raise notice 'skipping %: %', 'branch_distance_measurements_check', sqlerrm;
end $guard$;

do $guard$ begin
  alter table branch_distance_measurements add constraint branch_distance_measurements_distance_km_check CHECK ((distance_km >= (0)::numeric));
exception when others then raise notice 'skipping %: %', 'branch_distance_measurements_distance_km_check', sqlerrm;
end $guard$;

do $guard$ begin
  alter table branches add constraint branches_default_language_check CHECK (((default_language)::text = ANY ((ARRAY['en'::character varying, 'fr'::character varying, 'rw'::character varying])::text[])));
exception when others then raise notice 'skipping %: %', 'branches_default_language_check', sqlerrm;
end $guard$;

do $guard$ begin
  alter table branches add constraint branches_default_reorder_min_check CHECK ((default_reorder_min >= 0));
exception when others then raise notice 'skipping %: %', 'branches_default_reorder_min_check', sqlerrm;
end $guard$;

do $guard$ begin
  alter table branches add constraint branches_expiry_alert_threshold_days_check CHECK ((expiry_alert_threshold_days > 0));
exception when others then raise notice 'skipping %: %', 'branches_expiry_alert_threshold_days_check', sqlerrm;
end $guard$;

do $guard$ begin
  alter table branches add constraint branches_out_of_stock_reminder_hours_check CHECK (((out_of_stock_reminder_hours >= 1) AND (out_of_stock_reminder_hours <= 168)));
exception when others then raise notice 'skipping %: %', 'branches_out_of_stock_reminder_hours_check', sqlerrm;
end $guard$;

do $guard$ begin
  alter table branches add constraint branches_pos_default_payment_method_check CHECK (((pos_default_payment_method)::text = ANY ((ARRAY['cash'::character varying, 'mtn_momo'::character varying, 'airtel_money'::character varying, 'card'::character varying])::text[])));
exception when others then raise notice 'skipping %: %', 'branches_pos_default_payment_method_check', sqlerrm;
end $guard$;

do $guard$ begin
  alter table branches add constraint branches_status_check CHECK (((status)::text = ANY ((ARRAY['pending'::character varying, 'otp_sent'::character varying, 'active'::character varying, 'locked'::character varying, 'denied'::character varying])::text[])));
exception when others then raise notice 'skipping %: %', 'branches_status_check', sqlerrm;
end $guard$;

do $guard$ begin
  alter table discounts add constraint discounts_check CHECK (((valid_to IS NULL) OR (valid_from IS NULL) OR (valid_to >= valid_from)));
exception when others then raise notice 'skipping %: %', 'discounts_check', sqlerrm;
end $guard$;

do $guard$ begin
  alter table discounts add constraint discounts_discount_type_check CHECK (((discount_type)::text = ANY ((ARRAY['percentage'::character varying, 'fixed'::character varying])::text[])));
exception when others then raise notice 'skipping %: %', 'discounts_discount_type_check', sqlerrm;
end $guard$;

do $guard$ begin
  alter table discounts add constraint discounts_value_check CHECK ((value >= (0)::numeric));
exception when others then raise notice 'skipping %: %', 'discounts_value_check', sqlerrm;
end $guard$;

do $guard$ begin
  alter table insurance_claims add constraint insurance_claims_claim_amount_check CHECK ((claim_amount >= (0)::numeric));
exception when others then raise notice 'skipping %: %', 'insurance_claims_claim_amount_check', sqlerrm;
end $guard$;

do $guard$ begin
  alter table insurance_claims add constraint insurance_claims_coverage_percentage_applied_check CHECK (((coverage_percentage_applied >= (0)::numeric) AND (coverage_percentage_applied <= (100)::numeric)));
exception when others then raise notice 'skipping %: %', 'insurance_claims_coverage_percentage_applied_check', sqlerrm;
end $guard$;

do $guard$ begin
  alter table insurance_claims add constraint insurance_claims_status_check CHECK (((status)::text = ANY ((ARRAY['submitted'::character varying, 'approved'::character varying, 'rejected'::character varying, 'paid'::character varying])::text[])));
exception when others then raise notice 'skipping %: %', 'insurance_claims_status_check', sqlerrm;
end $guard$;

do $guard$ begin
  alter table insurance_product_coverage add constraint insurance_product_coverage_coverage_percentage_check CHECK (((coverage_percentage >= (0)::numeric) AND (coverage_percentage <= (100)::numeric)));
exception when others then raise notice 'skipping %: %', 'insurance_product_coverage_coverage_percentage_check', sqlerrm;
end $guard$;

do $guard$ begin
  alter table insurance_providers add constraint insurance_providers_default_coverage_percentage_check CHECK (((default_coverage_percentage >= (0)::numeric) AND (default_coverage_percentage <= (100)::numeric)));
exception when others then raise notice 'skipping %: %', 'insurance_providers_default_coverage_percentage_check', sqlerrm;
end $guard$;

do $guard$ begin
  alter table insurance_variant_prices add constraint insurance_variant_prices_fixed_price_check CHECK ((fixed_price >= (0)::numeric));
exception when others then raise notice 'skipping %: %', 'insurance_variant_prices_fixed_price_check', sqlerrm;
end $guard$;

do $guard$ begin
  alter table notifications add constraint notifications_source_type_check CHECK (((source_type)::text = ANY ((ARRAY['batch_recall'::character varying, 'stock_adjustment'::character varying, 'product_request_approved'::character varying, 'product_request_rejected'::character varying, 'out_of_stock'::character varying, 'license_expiring'::character varying, 'forecast_completed'::character varying, 'restock_recommendation'::character varying, 'reorder_point_missing'::character varying, 'stock_offer_requested'::character varying, 'stock_offer_accepted'::character varying, 'stock_offer_denied'::character varying, 'stock_need_awaiting_approval'::character varying, 'stock_need_approved'::character varying, 'stock_need_rejected'::character varying, 'stock_need_fulfilled'::character varying, 'branch_location_missing'::character varying])::text[])));
exception when others then raise notice 'skipping %: %', 'notifications_source_type_check', sqlerrm;
end $guard$;

do $guard$ begin
  alter table organization_applications add constraint organization_applications_status_check CHECK (((status)::text = ANY ((ARRAY['pending'::character varying, 'otp_sent'::character varying, 'active'::character varying, 'denied'::character varying])::text[])));
exception when others then raise notice 'skipping %: %', 'organization_applications_status_check', sqlerrm;
end $guard$;

do $guard$ begin
  alter table organization_invites add constraint organization_invites_role_check CHECK (((role)::text = ANY ((ARRAY['org_owner'::character varying, 'org_manager'::character varying, 'owner'::character varying, 'manager'::character varying, 'seller'::character varying])::text[])));
exception when others then raise notice 'skipping %: %', 'organization_invites_role_check', sqlerrm;
end $guard$;

do $guard$ begin
  alter table organization_invites add constraint organization_invites_status_check CHECK (((status)::text = ANY ((ARRAY['otp_sent'::character varying, 'accepted'::character varying, 'denied'::character varying])::text[])));
exception when others then raise notice 'skipping %: %', 'organization_invites_status_check', sqlerrm;
end $guard$;

do $guard$ begin
  alter table organization_members add constraint organization_members_role_check CHECK (((role)::text = ANY ((ARRAY['org_owner'::character varying, 'org_manager'::character varying])::text[])));
exception when others then raise notice 'skipping %: %', 'organization_members_role_check', sqlerrm;
end $guard$;

do $guard$ begin
  alter table patients add constraint patients_age_check CHECK (((age IS NULL) OR ((age >= 0) AND (age <= 130))));
exception when others then raise notice 'skipping %: %', 'patients_age_check', sqlerrm;
end $guard$;

do $guard$ begin
  alter table patients add constraint patients_gender_check CHECK (((gender IS NULL) OR ((gender)::text = ANY ((ARRAY['male'::character varying, 'female'::character varying, 'other'::character varying])::text[]))));
exception when others then raise notice 'skipping %: %', 'patients_gender_check', sqlerrm;
end $guard$;

do $guard$ begin
  alter table pending_payments add constraint pending_payments_amount_check CHECK ((amount >= (0)::numeric));
exception when others then raise notice 'skipping %: %', 'pending_payments_amount_check', sqlerrm;
end $guard$;

do $guard$ begin
  alter table pending_payments add constraint pending_payments_payment_method_check CHECK (((payment_method)::text = ANY ((ARRAY['mtn_momo'::character varying, 'airtel_money'::character varying, 'card'::character varying])::text[])));
exception when others then raise notice 'skipping %: %', 'pending_payments_payment_method_check', sqlerrm;
end $guard$;

do $guard$ begin
  alter table pending_payments add constraint pending_payments_provider_check CHECK (((provider)::text = ANY ((ARRAY['pesapal'::character varying, 'pawapay'::character varying])::text[])));
exception when others then raise notice 'skipping %: %', 'pending_payments_provider_check', sqlerrm;
end $guard$;

do $guard$ begin
  alter table pending_payments add constraint pending_payments_status_check CHECK (((status)::text = ANY ((ARRAY['pending'::character varying, 'success'::character varying, 'failed'::character varying, 'expired'::character varying])::text[])));
exception when others then raise notice 'skipping %: %', 'pending_payments_status_check', sqlerrm;
end $guard$;

do $guard$ begin
  alter table pharmacy_organizations add constraint pharmacy_organizations_status_check CHECK (((status)::text = ANY ((ARRAY['active'::character varying, 'suspended'::character varying])::text[])));
exception when others then raise notice 'skipping %: %', 'pharmacy_organizations_status_check', sqlerrm;
end $guard$;

do $guard$ begin
  alter table product_requests add constraint product_requests_status_check CHECK (((status)::text = ANY ((ARRAY['pending'::character varying, 'approved'::character varying, 'rejected'::character varying])::text[])));
exception when others then raise notice 'skipping %: %', 'product_requests_status_check', sqlerrm;
end $guard$;

do $guard$ begin
  alter table products add constraint products_product_type_check CHECK (((product_type)::text = ANY ((ARRAY['medicine'::character varying, 'supply'::character varying, 'other'::character varying])::text[])));
exception when others then raise notice 'skipping %: %', 'products_product_type_check', sqlerrm;
end $guard$;

do $guard$ begin
  alter table reorder_points add constraint reorder_points_check CHECK (((max_quantity IS NULL) OR (max_quantity >= min_quantity)));
exception when others then raise notice 'skipping %: %', 'reorder_points_check', sqlerrm;
end $guard$;

do $guard$ begin
  alter table reorder_points add constraint reorder_points_min_quantity_check CHECK ((min_quantity >= 0));
exception when others then raise notice 'skipping %: %', 'reorder_points_min_quantity_check', sqlerrm;
end $guard$;

do $guard$ begin
  alter table role_change_log add constraint role_change_log_action_check CHECK (((action)::text = ANY ((ARRAY['grant'::character varying, 'revoke'::character varying, 'role_change'::character varying, 'ownership_transfer'::character varying])::text[])));
exception when others then raise notice 'skipping %: %', 'role_change_log_action_check', sqlerrm;
end $guard$;

do $guard$ begin
  alter table role_change_log add constraint role_change_log_scope_check CHECK (((scope)::text = ANY ((ARRAY['organization'::character varying, 'branch'::character varying])::text[])));
exception when others then raise notice 'skipping %: %', 'role_change_log_scope_check', sqlerrm;
end $guard$;

do $guard$ begin
  alter table sale_items add constraint sale_items_insurance_covered_amount_check CHECK ((insurance_covered_amount >= (0)::numeric));
exception when others then raise notice 'skipping %: %', 'sale_items_insurance_covered_amount_check', sqlerrm;
end $guard$;

do $guard$ begin
  alter table sale_items add constraint sale_items_quantity_check CHECK ((quantity > 0));
exception when others then raise notice 'skipping %: %', 'sale_items_quantity_check', sqlerrm;
end $guard$;

do $guard$ begin
  alter table sale_items add constraint sale_items_subtotal_check CHECK ((subtotal >= (0)::numeric));
exception when others then raise notice 'skipping %: %', 'sale_items_subtotal_check', sqlerrm;
end $guard$;

do $guard$ begin
  alter table sale_items add constraint sale_items_unit_price_check CHECK ((unit_price >= (0)::numeric));
exception when others then raise notice 'skipping %: %', 'sale_items_unit_price_check', sqlerrm;
end $guard$;

do $guard$ begin
  alter table sales add constraint sales_payment_method_check CHECK (((payment_method IS NULL) OR ((payment_method)::text = ANY ((ARRAY['cash'::character varying, 'mtn_momo'::character varying, 'airtel_money'::character varying, 'card'::character varying])::text[]))));
exception when others then raise notice 'skipping %: %', 'sales_payment_method_check', sqlerrm;
end $guard$;

do $guard$ begin
  alter table sales add constraint sales_total_amount_check CHECK ((total_amount >= (0)::numeric));
exception when others then raise notice 'skipping %: %', 'sales_total_amount_check', sqlerrm;
end $guard$;

do $guard$ begin
  alter table sales_forecast_snapshots add constraint sales_forecast_snapshots_bucket_check CHECK ((bucket = ANY (ARRAY['day'::text, 'week'::text, 'month'::text])));
exception when others then raise notice 'skipping %: %', 'sales_forecast_snapshots_bucket_check', sqlerrm;
end $guard$;

do $guard$ begin
  alter table sales_forecasts add constraint sales_forecasts_predicted_quantity_check CHECK ((predicted_quantity >= 0));
exception when others then raise notice 'skipping %: %', 'sales_forecasts_predicted_quantity_check', sqlerrm;
end $guard$;

do $guard$ begin
  alter table stock_adjustments add constraint stock_adjustments_adjustment_type_check CHECK (((adjustment_type)::text = ANY ((ARRAY['damage'::character varying, 'loss'::character varying, 'correction'::character varying, 'return'::character varying, 'expired_writeoff'::character varying, 'recalled'::character varying])::text[])));
exception when others then raise notice 'skipping %: %', 'stock_adjustments_adjustment_type_check', sqlerrm;
end $guard$;

do $guard$ begin
  alter table stock_adjustments add constraint stock_adjustments_check CHECK (((stock_batch_id IS NOT NULL) OR (barcode_id IS NOT NULL)));
exception when others then raise notice 'skipping %: %', 'stock_adjustments_check', sqlerrm;
end $guard$;

do $guard$ begin
  alter table stock_batches add constraint stock_batches_cost_price_check CHECK ((cost_price >= (0)::numeric));
exception when others then raise notice 'skipping %: %', 'stock_batches_cost_price_check', sqlerrm;
end $guard$;

do $guard$ begin
  alter table stock_batches add constraint stock_batches_quantity_received_check CHECK ((quantity_received >= 0));
exception when others then raise notice 'skipping %: %', 'stock_batches_quantity_received_check', sqlerrm;
end $guard$;

do $guard$ begin
  alter table stock_batches add constraint stock_batches_selling_price_check CHECK ((selling_price >= (0)::numeric));
exception when others then raise notice 'skipping %: %', 'stock_batches_selling_price_check', sqlerrm;
end $guard$;

do $guard$ begin
  alter table stock_transfer_needs add constraint stock_transfer_needs_requested_quantity_check CHECK ((requested_quantity > 0));
exception when others then raise notice 'skipping %: %', 'stock_transfer_needs_requested_quantity_check', sqlerrm;
end $guard$;

do $guard$ begin
  alter table stock_transfer_needs add constraint stock_transfer_needs_status_check CHECK (((status)::text = ANY ((ARRAY['open'::character varying, 'org_review'::character varying, 'fulfilling'::character varying, 'fulfilled'::character varying])::text[])));
exception when others then raise notice 'skipping %: %', 'stock_transfer_needs_status_check', sqlerrm;
end $guard$;

do $guard$ begin
  alter table stock_transfer_offers add constraint stock_transfer_offers_status_check CHECK (((status)::text = ANY ((ARRAY['pending'::character varying, 'accepted'::character varying, 'denied'::character varying])::text[])));
exception when others then raise notice 'skipping %: %', 'stock_transfer_offers_status_check', sqlerrm;
end $guard$;

do $guard$ begin
  alter table stock_transfers add constraint stock_transfers_check CHECK ((from_branch_id <> to_branch_id));
exception when others then raise notice 'skipping %: %', 'stock_transfers_check', sqlerrm;
end $guard$;

do $guard$ begin
  alter table stock_transfers add constraint stock_transfers_status_check CHECK (((status)::text = ANY ((ARRAY['pending'::character varying, 'approved'::character varying, 'in_transit'::character varying, 'received'::character varying, 'rejected'::character varying, 'cancelled'::character varying])::text[])));
exception when others then raise notice 'skipping %: %', 'stock_transfers_status_check', sqlerrm;
end $guard$;

do $guard$ begin
  alter table support_tickets add constraint support_tickets_priority_check CHECK (((priority)::text = ANY ((ARRAY['low'::character varying, 'medium'::character varying, 'high'::character varying])::text[])));
exception when others then raise notice 'skipping %: %', 'support_tickets_priority_check', sqlerrm;
end $guard$;

do $guard$ begin
  alter table support_tickets add constraint support_tickets_status_check CHECK (((status)::text = ANY ((ARRAY['open'::character varying, 'in_progress'::character varying, 'resolved'::character varying, 'closed'::character varying])::text[])));
exception when others then raise notice 'skipping %: %', 'support_tickets_status_check', sqlerrm;
end $guard$;

do $guard$ begin
  alter table tax_rates add constraint tax_rates_rate_percentage_check CHECK (((rate_percentage >= (0)::numeric) AND (rate_percentage <= (100)::numeric)));
exception when others then raise notice 'skipping %: %', 'tax_rates_rate_percentage_check', sqlerrm;
end $guard$;

do $guard$ begin
  alter table users add constraint users_role_check CHECK (((role)::text = ANY ((ARRAY['owner'::character varying, 'manager'::character varying, 'pharmacist'::character varying, 'staff'::character varying, 'seller'::character varying])::text[])));
exception when others then raise notice 'skipping %: %', 'users_role_check', sqlerrm;
end $guard$;

do $guard$ begin
  alter table barcodes add constraint barcodes_parent_barcode_id_fkey FOREIGN KEY (parent_barcode_id) REFERENCES barcodes(id);
exception when others then raise notice 'skipping %: %', 'barcodes_parent_barcode_id_fkey', sqlerrm;
end $guard$;

do $guard$ begin
  alter table barcodes add constraint barcodes_stock_batch_id_fkey FOREIGN KEY (stock_batch_id) REFERENCES stock_batches(id);
exception when others then raise notice 'skipping %: %', 'barcodes_stock_batch_id_fkey', sqlerrm;
end $guard$;

do $guard$ begin
  alter table batch_recalls add constraint batch_recalls_product_variant_id_fkey FOREIGN KEY (product_variant_id) REFERENCES product_variants(id);
exception when others then raise notice 'skipping %: %', 'batch_recalls_product_variant_id_fkey', sqlerrm;
end $guard$;

do $guard$ begin
  alter table batch_recalls add constraint batch_recalls_recalled_by_fkey FOREIGN KEY (recalled_by) REFERENCES users(id);
exception when others then raise notice 'skipping %: %', 'batch_recalls_recalled_by_fkey', sqlerrm;
end $guard$;

do $guard$ begin
  alter table branch_applications add constraint branch_applications_branch_id_fkey FOREIGN KEY (branch_id) REFERENCES branches(id);
exception when others then raise notice 'skipping %: %', 'branch_applications_branch_id_fkey', sqlerrm;
end $guard$;

do $guard$ begin
  alter table branch_directory add constraint branch_directory_branch_id_fkey FOREIGN KEY (branch_id) REFERENCES branches(id) ON DELETE CASCADE;
exception when others then raise notice 'skipping %: %', 'branch_directory_branch_id_fkey', sqlerrm;
end $guard$;

do $guard$ begin
  alter table branch_distance_measurements add constraint branch_distance_measurements_branch_a_id_fkey FOREIGN KEY (branch_a_id) REFERENCES branches(id) ON DELETE CASCADE;
exception when others then raise notice 'skipping %: %', 'branch_distance_measurements_branch_a_id_fkey', sqlerrm;
end $guard$;

do $guard$ begin
  alter table branch_distance_measurements add constraint branch_distance_measurements_branch_b_id_fkey FOREIGN KEY (branch_b_id) REFERENCES branches(id) ON DELETE CASCADE;
exception when others then raise notice 'skipping %: %', 'branch_distance_measurements_branch_b_id_fkey', sqlerrm;
end $guard$;

do $guard$ begin
  alter table branch_distance_measurements add constraint branch_distance_measurements_measured_by_fkey FOREIGN KEY (measured_by) REFERENCES users(id);
exception when others then raise notice 'skipping %: %', 'branch_distance_measurements_measured_by_fkey', sqlerrm;
end $guard$;

do $guard$ begin
  alter table branch_distance_measurements add constraint branch_distance_measurements_organization_id_fkey FOREIGN KEY (organization_id) REFERENCES pharmacy_organizations(id) ON DELETE CASCADE;
exception when others then raise notice 'skipping %: %', 'branch_distance_measurements_organization_id_fkey', sqlerrm;
end $guard$;

do $guard$ begin
  alter table branch_product_categorization add constraint branch_product_categorization_branch_id_fkey FOREIGN KEY (branch_id) REFERENCES branches(id);
exception when others then raise notice 'skipping %: %', 'branch_product_categorization_branch_id_fkey', sqlerrm;
end $guard$;

do $guard$ begin
  alter table branch_product_categorization add constraint branch_product_categorization_category_id_branch_id_fkey FOREIGN KEY (category_id, branch_id) REFERENCES product_categories(id, branch_id);
exception when others then raise notice 'skipping %: %', 'branch_product_categorization_category_id_branch_id_fkey', sqlerrm;
end $guard$;

do $guard$ begin
  alter table branch_product_categorization add constraint branch_product_categorization_product_id_fkey FOREIGN KEY (product_id) REFERENCES products(id);
exception when others then raise notice 'skipping %: %', 'branch_product_categorization_product_id_fkey', sqlerrm;
end $guard$;

do $guard$ begin
  alter table branch_settings add constraint branch_settings_branch_id_fkey FOREIGN KEY (branch_id) REFERENCES branches(id);
exception when others then raise notice 'skipping %: %', 'branch_settings_branch_id_fkey', sqlerrm;
end $guard$;

do $guard$ begin
  alter table branch_settings add constraint branch_settings_updated_by_fkey FOREIGN KEY (updated_by) REFERENCES users(id);
exception when others then raise notice 'skipping %: %', 'branch_settings_updated_by_fkey', sqlerrm;
end $guard$;

do $guard$ begin
  alter table branches add constraint branches_organization_id_fkey FOREIGN KEY (organization_id) REFERENCES pharmacy_organizations(id);
exception when others then raise notice 'skipping %: %', 'branches_organization_id_fkey', sqlerrm;
end $guard$;

do $guard$ begin
  alter table dashboard_reports add constraint dashboard_reports_branch_id_fkey FOREIGN KEY (branch_id) REFERENCES branches(id);
exception when others then raise notice 'skipping %: %', 'dashboard_reports_branch_id_fkey', sqlerrm;
end $guard$;

do $guard$ begin
  alter table discounts add constraint discounts_branch_id_fkey FOREIGN KEY (branch_id) REFERENCES branches(id);
exception when others then raise notice 'skipping %: %', 'discounts_branch_id_fkey', sqlerrm;
end $guard$;

do $guard$ begin
  alter table insurance_claims add constraint insurance_claims_insurance_provider_id_fkey FOREIGN KEY (insurance_provider_id) REFERENCES insurance_providers(id);
exception when others then raise notice 'skipping %: %', 'insurance_claims_insurance_provider_id_fkey', sqlerrm;
end $guard$;

do $guard$ begin
  alter table insurance_claims add constraint insurance_claims_sale_id_fkey FOREIGN KEY (sale_id) REFERENCES sales(id);
exception when others then raise notice 'skipping %: %', 'insurance_claims_sale_id_fkey', sqlerrm;
end $guard$;

do $guard$ begin
  alter table insurance_product_coverage add constraint insurance_product_coverage_insurance_provider_id_fkey FOREIGN KEY (insurance_provider_id) REFERENCES insurance_providers(id);
exception when others then raise notice 'skipping %: %', 'insurance_product_coverage_insurance_provider_id_fkey', sqlerrm;
end $guard$;

do $guard$ begin
  alter table insurance_product_coverage add constraint insurance_product_coverage_product_id_fkey FOREIGN KEY (product_id) REFERENCES products(id);
exception when others then raise notice 'skipping %: %', 'insurance_product_coverage_product_id_fkey', sqlerrm;
end $guard$;

do $guard$ begin
  alter table insurance_variant_prices add constraint insurance_variant_prices_insurance_provider_id_fkey FOREIGN KEY (insurance_provider_id) REFERENCES insurance_providers(id);
exception when others then raise notice 'skipping %: %', 'insurance_variant_prices_insurance_provider_id_fkey', sqlerrm;
end $guard$;

do $guard$ begin
  alter table insurance_variant_prices add constraint insurance_variant_prices_product_variant_id_fkey FOREIGN KEY (product_variant_id) REFERENCES product_variants(id);
exception when others then raise notice 'skipping %: %', 'insurance_variant_prices_product_variant_id_fkey', sqlerrm;
end $guard$;

do $guard$ begin
  alter table notifications add constraint notifications_branch_id_fkey FOREIGN KEY (branch_id) REFERENCES branches(id);
exception when others then raise notice 'skipping %: %', 'notifications_branch_id_fkey', sqlerrm;
end $guard$;

do $guard$ begin
  alter table organization_applications add constraint organization_applications_first_branch_id_fkey FOREIGN KEY (first_branch_id) REFERENCES branches(id);
exception when others then raise notice 'skipping %: %', 'organization_applications_first_branch_id_fkey', sqlerrm;
end $guard$;

do $guard$ begin
  alter table organization_applications add constraint organization_applications_organization_id_fkey FOREIGN KEY (organization_id) REFERENCES pharmacy_organizations(id);
exception when others then raise notice 'skipping %: %', 'organization_applications_organization_id_fkey', sqlerrm;
end $guard$;

do $guard$ begin
  alter table organization_invites add constraint organization_invites_branch_id_fkey FOREIGN KEY (branch_id) REFERENCES branches(id);
exception when others then raise notice 'skipping %: %', 'organization_invites_branch_id_fkey', sqlerrm;
end $guard$;

do $guard$ begin
  alter table organization_invites add constraint organization_invites_invited_by_fkey FOREIGN KEY (invited_by) REFERENCES users(id);
exception when others then raise notice 'skipping %: %', 'organization_invites_invited_by_fkey', sqlerrm;
end $guard$;

do $guard$ begin
  alter table organization_invites add constraint organization_invites_organization_id_fkey FOREIGN KEY (organization_id) REFERENCES pharmacy_organizations(id) ON DELETE CASCADE;
exception when others then raise notice 'skipping %: %', 'organization_invites_organization_id_fkey', sqlerrm;
end $guard$;

do $guard$ begin
  alter table organization_members add constraint organization_members_organization_id_fkey FOREIGN KEY (organization_id) REFERENCES pharmacy_organizations(id) ON DELETE CASCADE;
exception when others then raise notice 'skipping %: %', 'organization_members_organization_id_fkey', sqlerrm;
end $guard$;

do $guard$ begin
  alter table organization_members add constraint organization_members_user_id_fkey FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE;
exception when others then raise notice 'skipping %: %', 'organization_members_user_id_fkey', sqlerrm;
end $guard$;

do $guard$ begin
  alter table patients add constraint patients_branch_id_fkey FOREIGN KEY (branch_id) REFERENCES branches(id);
exception when others then raise notice 'skipping %: %', 'patients_branch_id_fkey', sqlerrm;
end $guard$;

do $guard$ begin
  alter table patients add constraint patients_created_by_fkey FOREIGN KEY (created_by) REFERENCES users(id);
exception when others then raise notice 'skipping %: %', 'patients_created_by_fkey', sqlerrm;
end $guard$;

do $guard$ begin
  alter table pending_payments add constraint pending_payments_branch_id_fkey FOREIGN KEY (branch_id) REFERENCES branches(id);
exception when others then raise notice 'skipping %: %', 'pending_payments_branch_id_fkey', sqlerrm;
end $guard$;

do $guard$ begin
  alter table pending_payments add constraint pending_payments_cashier_id_fkey FOREIGN KEY (cashier_id) REFERENCES users(id);
exception when others then raise notice 'skipping %: %', 'pending_payments_cashier_id_fkey', sqlerrm;
end $guard$;

do $guard$ begin
  alter table pending_payments add constraint pending_payments_sale_id_fkey FOREIGN KEY (sale_id) REFERENCES sales(id);
exception when others then raise notice 'skipping %: %', 'pending_payments_sale_id_fkey', sqlerrm;
end $guard$;

do $guard$ begin
  alter table product_categories add constraint product_categories_branch_id_fkey FOREIGN KEY (branch_id) REFERENCES branches(id);
exception when others then raise notice 'skipping %: %', 'product_categories_branch_id_fkey', sqlerrm;
end $guard$;

do $guard$ begin
  alter table product_requests add constraint product_requests_branch_id_fkey FOREIGN KEY (branch_id) REFERENCES branches(id);
exception when others then raise notice 'skipping %: %', 'product_requests_branch_id_fkey', sqlerrm;
end $guard$;

do $guard$ begin
  alter table product_requests add constraint product_requests_requested_by_fkey FOREIGN KEY (requested_by) REFERENCES users(id);
exception when others then raise notice 'skipping %: %', 'product_requests_requested_by_fkey', sqlerrm;
end $guard$;

do $guard$ begin
  alter table product_requests add constraint product_requests_resolved_by_fkey FOREIGN KEY (resolved_by) REFERENCES users(id);
exception when others then raise notice 'skipping %: %', 'product_requests_resolved_by_fkey', sqlerrm;
end $guard$;

do $guard$ begin
  alter table product_requests add constraint product_requests_resolved_product_id_fkey FOREIGN KEY (resolved_product_id) REFERENCES products(id);
exception when others then raise notice 'skipping %: %', 'product_requests_resolved_product_id_fkey', sqlerrm;
end $guard$;

do $guard$ begin
  alter table product_requests add constraint product_requests_resolved_variant_id_fkey FOREIGN KEY (resolved_variant_id) REFERENCES product_variants(id);
exception when others then raise notice 'skipping %: %', 'product_requests_resolved_variant_id_fkey', sqlerrm;
end $guard$;

do $guard$ begin
  alter table product_storage_locations add constraint product_storage_locations_branch_id_fkey FOREIGN KEY (branch_id) REFERENCES branches(id) ON DELETE CASCADE;
exception when others then raise notice 'skipping %: %', 'product_storage_locations_branch_id_fkey', sqlerrm;
end $guard$;

do $guard$ begin
  alter table product_storage_locations add constraint product_storage_locations_product_id_fkey FOREIGN KEY (product_id) REFERENCES products(id) ON DELETE CASCADE;
exception when others then raise notice 'skipping %: %', 'product_storage_locations_product_id_fkey', sqlerrm;
end $guard$;

do $guard$ begin
  alter table product_storage_locations add constraint product_storage_locations_storage_location_id_fkey FOREIGN KEY (storage_location_id) REFERENCES storage_locations(id) ON DELETE CASCADE;
exception when others then raise notice 'skipping %: %', 'product_storage_locations_storage_location_id_fkey', sqlerrm;
end $guard$;

do $guard$ begin
  alter table product_storage_locations add constraint product_storage_locations_updated_by_fkey FOREIGN KEY (updated_by) REFERENCES users(id);
exception when others then raise notice 'skipping %: %', 'product_storage_locations_updated_by_fkey', sqlerrm;
end $guard$;

do $guard$ begin
  alter table product_variants add constraint product_variants_product_id_fkey FOREIGN KEY (product_id) REFERENCES products(id);
exception when others then raise notice 'skipping %: %', 'product_variants_product_id_fkey', sqlerrm;
end $guard$;

do $guard$ begin
  alter table products add constraint products_tax_rate_id_fkey FOREIGN KEY (tax_rate_id) REFERENCES tax_rates(id);
exception when others then raise notice 'skipping %: %', 'products_tax_rate_id_fkey', sqlerrm;
end $guard$;

do $guard$ begin
  alter table receipts add constraint receipts_sale_id_fkey FOREIGN KEY (sale_id) REFERENCES sales(id) ON DELETE CASCADE;
exception when others then raise notice 'skipping %: %', 'receipts_sale_id_fkey', sqlerrm;
end $guard$;

do $guard$ begin
  alter table reorder_points add constraint reorder_points_branch_id_fkey FOREIGN KEY (branch_id) REFERENCES branches(id);
exception when others then raise notice 'skipping %: %', 'reorder_points_branch_id_fkey', sqlerrm;
end $guard$;

do $guard$ begin
  alter table reorder_points add constraint reorder_points_product_id_fkey FOREIGN KEY (product_id) REFERENCES products(id);
exception when others then raise notice 'skipping %: %', 'reorder_points_product_id_fkey', sqlerrm;
end $guard$;

do $guard$ begin
  alter table sale_items add constraint sale_items_barcode_id_fkey FOREIGN KEY (barcode_id) REFERENCES barcodes(id);
exception when others then raise notice 'skipping %: %', 'sale_items_barcode_id_fkey', sqlerrm;
end $guard$;

do $guard$ begin
  alter table sale_items add constraint sale_items_sale_id_fkey FOREIGN KEY (sale_id) REFERENCES sales(id) ON DELETE CASCADE;
exception when others then raise notice 'skipping %: %', 'sale_items_sale_id_fkey', sqlerrm;
end $guard$;

do $guard$ begin
  alter table sale_items add constraint sale_items_tax_rate_id_fkey FOREIGN KEY (tax_rate_id) REFERENCES tax_rates(id);
exception when others then raise notice 'skipping %: %', 'sale_items_tax_rate_id_fkey', sqlerrm;
end $guard$;

do $guard$ begin
  alter table sales add constraint sales_branch_id_fkey FOREIGN KEY (branch_id) REFERENCES branches(id);
exception when others then raise notice 'skipping %: %', 'sales_branch_id_fkey', sqlerrm;
end $guard$;

do $guard$ begin
  alter table sales add constraint sales_cashier_id_fkey FOREIGN KEY (cashier_id) REFERENCES users(id);
exception when others then raise notice 'skipping %: %', 'sales_cashier_id_fkey', sqlerrm;
end $guard$;

do $guard$ begin
  alter table sales add constraint sales_discount_id_fkey FOREIGN KEY (discount_id) REFERENCES discounts(id);
exception when others then raise notice 'skipping %: %', 'sales_discount_id_fkey', sqlerrm;
end $guard$;

do $guard$ begin
  alter table sales add constraint sales_patient_id_fkey FOREIGN KEY (patient_id) REFERENCES patients(id);
exception when others then raise notice 'skipping %: %', 'sales_patient_id_fkey', sqlerrm;
end $guard$;

do $guard$ begin
  alter table sales_forecast_snapshots add constraint sales_forecast_snapshots_branch_id_fkey FOREIGN KEY (branch_id) REFERENCES branches(id) ON DELETE CASCADE;
exception when others then raise notice 'skipping %: %', 'sales_forecast_snapshots_branch_id_fkey', sqlerrm;
end $guard$;

do $guard$ begin
  alter table sales_forecast_snapshots add constraint sales_forecast_snapshots_category_id_fkey FOREIGN KEY (category_id) REFERENCES product_categories(id) ON DELETE CASCADE;
exception when others then raise notice 'skipping %: %', 'sales_forecast_snapshots_category_id_fkey', sqlerrm;
end $guard$;

do $guard$ begin
  alter table sales_forecast_snapshots add constraint sales_forecast_snapshots_product_id_fkey FOREIGN KEY (product_id) REFERENCES products(id) ON DELETE CASCADE;
exception when others then raise notice 'skipping %: %', 'sales_forecast_snapshots_product_id_fkey', sqlerrm;
end $guard$;

do $guard$ begin
  alter table sales_forecasts add constraint sales_forecasts_branch_id_fkey FOREIGN KEY (branch_id) REFERENCES branches(id);
exception when others then raise notice 'skipping %: %', 'sales_forecasts_branch_id_fkey', sqlerrm;
end $guard$;

do $guard$ begin
  alter table sales_forecasts add constraint sales_forecasts_product_variant_id_fkey FOREIGN KEY (product_variant_id) REFERENCES product_variants(id);
exception when others then raise notice 'skipping %: %', 'sales_forecasts_product_variant_id_fkey', sqlerrm;
end $guard$;

do $guard$ begin
  alter table stock_adjustments add constraint stock_adjustments_barcode_id_fkey FOREIGN KEY (barcode_id) REFERENCES barcodes(id);
exception when others then raise notice 'skipping %: %', 'stock_adjustments_barcode_id_fkey', sqlerrm;
end $guard$;

do $guard$ begin
  alter table stock_adjustments add constraint stock_adjustments_performed_by_fkey FOREIGN KEY (performed_by) REFERENCES users(id);
exception when others then raise notice 'skipping %: %', 'stock_adjustments_performed_by_fkey', sqlerrm;
end $guard$;

do $guard$ begin
  alter table stock_adjustments add constraint stock_adjustments_stock_batch_id_fkey FOREIGN KEY (stock_batch_id) REFERENCES stock_batches(id);
exception when others then raise notice 'skipping %: %', 'stock_adjustments_stock_batch_id_fkey', sqlerrm;
end $guard$;

do $guard$ begin
  alter table stock_batches add constraint stock_batches_branch_id_fkey FOREIGN KEY (branch_id) REFERENCES branches(id);
exception when others then raise notice 'skipping %: %', 'stock_batches_branch_id_fkey', sqlerrm;
end $guard$;

do $guard$ begin
  alter table stock_batches add constraint stock_batches_delivery_id_fkey FOREIGN KEY (delivery_id) REFERENCES stock_deliveries(id);
exception when others then raise notice 'skipping %: %', 'stock_batches_delivery_id_fkey', sqlerrm;
end $guard$;

do $guard$ begin
  alter table stock_batches add constraint stock_batches_logged_by_fkey FOREIGN KEY (logged_by) REFERENCES users(id);
exception when others then raise notice 'skipping %: %', 'stock_batches_logged_by_fkey', sqlerrm;
end $guard$;

do $guard$ begin
  alter table stock_batches add constraint stock_batches_product_variant_id_fkey FOREIGN KEY (product_variant_id) REFERENCES product_variants(id);
exception when others then raise notice 'skipping %: %', 'stock_batches_product_variant_id_fkey', sqlerrm;
end $guard$;

do $guard$ begin
  alter table stock_batches add constraint stock_batches_supplier_id_fkey FOREIGN KEY (supplier_id) REFERENCES suppliers(id);
exception when others then raise notice 'skipping %: %', 'stock_batches_supplier_id_fkey', sqlerrm;
end $guard$;

do $guard$ begin
  alter table stock_deliveries add constraint stock_deliveries_branch_id_fkey FOREIGN KEY (branch_id) REFERENCES branches(id);
exception when others then raise notice 'skipping %: %', 'stock_deliveries_branch_id_fkey', sqlerrm;
end $guard$;

do $guard$ begin
  alter table stock_deliveries add constraint stock_deliveries_received_by_fkey FOREIGN KEY (received_by) REFERENCES users(id);
exception when others then raise notice 'skipping %: %', 'stock_deliveries_received_by_fkey', sqlerrm;
end $guard$;

do $guard$ begin
  alter table stock_deliveries add constraint stock_deliveries_supplier_id_fkey FOREIGN KEY (supplier_id) REFERENCES suppliers(id);
exception when others then raise notice 'skipping %: %', 'stock_deliveries_supplier_id_fkey', sqlerrm;
end $guard$;

do $guard$ begin
  alter table stock_transfer_items add constraint stock_transfer_items_stock_batch_id_fkey FOREIGN KEY (stock_batch_id) REFERENCES stock_batches(id);
exception when others then raise notice 'skipping %: %', 'stock_transfer_items_stock_batch_id_fkey', sqlerrm;
end $guard$;

do $guard$ begin
  alter table stock_transfer_items add constraint stock_transfer_items_transfer_id_fkey FOREIGN KEY (transfer_id) REFERENCES stock_transfers(id) ON DELETE CASCADE;
exception when others then raise notice 'skipping %: %', 'stock_transfer_items_transfer_id_fkey', sqlerrm;
end $guard$;

do $guard$ begin
  alter table stock_transfer_needs add constraint stock_transfer_needs_organization_id_fkey FOREIGN KEY (organization_id) REFERENCES pharmacy_organizations(id) ON DELETE CASCADE;
exception when others then raise notice 'skipping %: %', 'stock_transfer_needs_organization_id_fkey', sqlerrm;
end $guard$;

do $guard$ begin
  alter table stock_transfer_needs add constraint stock_transfer_needs_product_variant_id_fkey FOREIGN KEY (product_variant_id) REFERENCES product_variants(id);
exception when others then raise notice 'skipping %: %', 'stock_transfer_needs_product_variant_id_fkey', sqlerrm;
end $guard$;

do $guard$ begin
  alter table stock_transfer_needs add constraint stock_transfer_needs_requested_by_fkey FOREIGN KEY (requested_by) REFERENCES users(id);
exception when others then raise notice 'skipping %: %', 'stock_transfer_needs_requested_by_fkey', sqlerrm;
end $guard$;

do $guard$ begin
  alter table stock_transfer_needs add constraint stock_transfer_needs_requesting_branch_id_fkey FOREIGN KEY (requesting_branch_id) REFERENCES branches(id);
exception when others then raise notice 'skipping %: %', 'stock_transfer_needs_requesting_branch_id_fkey', sqlerrm;
end $guard$;

do $guard$ begin
  alter table stock_transfer_needs add constraint stock_transfer_needs_transfer_id_fkey FOREIGN KEY (transfer_id) REFERENCES stock_transfers(id);
exception when others then raise notice 'skipping %: %', 'stock_transfer_needs_transfer_id_fkey', sqlerrm;
end $guard$;

do $guard$ begin
  alter table stock_transfer_offers add constraint stock_transfer_offers_need_id_fkey FOREIGN KEY (need_id) REFERENCES stock_transfer_needs(id) ON DELETE CASCADE;
exception when others then raise notice 'skipping %: %', 'stock_transfer_offers_need_id_fkey', sqlerrm;
end $guard$;

do $guard$ begin
  alter table stock_transfer_offers add constraint stock_transfer_offers_responded_by_fkey FOREIGN KEY (responded_by) REFERENCES users(id);
exception when others then raise notice 'skipping %: %', 'stock_transfer_offers_responded_by_fkey', sqlerrm;
end $guard$;

do $guard$ begin
  alter table stock_transfer_offers add constraint stock_transfer_offers_target_branch_id_fkey FOREIGN KEY (target_branch_id) REFERENCES branches(id);
exception when others then raise notice 'skipping %: %', 'stock_transfer_offers_target_branch_id_fkey', sqlerrm;
end $guard$;

do $guard$ begin
  alter table stock_transfers add constraint stock_transfers_approved_by_fkey FOREIGN KEY (approved_by) REFERENCES users(id);
exception when others then raise notice 'skipping %: %', 'stock_transfers_approved_by_fkey', sqlerrm;
end $guard$;

do $guard$ begin
  alter table stock_transfers add constraint stock_transfers_from_branch_id_fkey FOREIGN KEY (from_branch_id) REFERENCES branches(id);
exception when others then raise notice 'skipping %: %', 'stock_transfers_from_branch_id_fkey', sqlerrm;
end $guard$;

do $guard$ begin
  alter table stock_transfers add constraint stock_transfers_organization_id_fkey FOREIGN KEY (organization_id) REFERENCES pharmacy_organizations(id);
exception when others then raise notice 'skipping %: %', 'stock_transfers_organization_id_fkey', sqlerrm;
end $guard$;

do $guard$ begin
  alter table stock_transfers add constraint stock_transfers_requested_by_fkey FOREIGN KEY (requested_by) REFERENCES users(id);
exception when others then raise notice 'skipping %: %', 'stock_transfers_requested_by_fkey', sqlerrm;
end $guard$;

do $guard$ begin
  alter table stock_transfers add constraint stock_transfers_to_branch_id_fkey FOREIGN KEY (to_branch_id) REFERENCES branches(id);
exception when others then raise notice 'skipping %: %', 'stock_transfers_to_branch_id_fkey', sqlerrm;
end $guard$;

do $guard$ begin
  alter table storage_locations add constraint storage_locations_branch_id_fkey FOREIGN KEY (branch_id) REFERENCES branches(id) ON DELETE CASCADE;
exception when others then raise notice 'skipping %: %', 'storage_locations_branch_id_fkey', sqlerrm;
end $guard$;

do $guard$ begin
  alter table suppliers add constraint suppliers_branch_id_fkey FOREIGN KEY (branch_id) REFERENCES branches(id);
exception when others then raise notice 'skipping %: %', 'suppliers_branch_id_fkey', sqlerrm;
end $guard$;

do $guard$ begin
  alter table support_tickets add constraint support_tickets_branch_id_fkey FOREIGN KEY (branch_id) REFERENCES branches(id);
exception when others then raise notice 'skipping %: %', 'support_tickets_branch_id_fkey', sqlerrm;
end $guard$;

do $guard$ begin
  alter table support_tickets add constraint support_tickets_raised_by_fkey FOREIGN KEY (raised_by) REFERENCES users(id);
exception when others then raise notice 'skipping %: %', 'support_tickets_raised_by_fkey', sqlerrm;
end $guard$;

do $guard$ begin
  alter table users add constraint users_branch_id_fkey FOREIGN KEY (branch_id) REFERENCES branches(id);
exception when others then raise notice 'skipping %: %', 'users_branch_id_fkey', sqlerrm;
end $guard$;

do $guard$ begin
  alter table users add constraint users_id_fkey FOREIGN KEY (id) REFERENCES auth.users(id) ON DELETE CASCADE;
exception when others then raise notice 'skipping %: %', 'users_id_fkey', sqlerrm;
end $guard$;


-- ============================================================================
-- INDEXES (excluding those already created implicitly by a constraint above)
-- ============================================================================

CREATE INDEX IF NOT EXISTS idx_barcodes_batch ON public.barcodes USING btree (stock_batch_id);
CREATE INDEX IF NOT EXISTS idx_barcodes_parent ON public.barcodes USING btree (parent_barcode_id);
CREATE UNIQUE INDEX IF NOT EXISTS branch_applications_open_email ON public.branch_applications USING btree (lower((email)::text)) WHERE ((status)::text = ANY ((ARRAY['pending'::character varying, 'otp_sent'::character varying])::text[]));
CREATE INDEX IF NOT EXISTS branch_applications_status_submitted ON public.branch_applications USING btree (status, submitted_at DESC);
CREATE INDEX IF NOT EXISTS idx_branch_distance_measurements_org ON public.branch_distance_measurements USING btree (organization_id, created_at DESC);
CREATE UNIQUE INDEX IF NOT EXISTS branches_branch_code_unique ON public.branches USING btree (branch_code) WHERE (branch_code IS NOT NULL);
CREATE INDEX IF NOT EXISTS idx_branches_organization ON public.branches USING btree (organization_id) WHERE (organization_id IS NOT NULL);
CREATE INDEX IF NOT EXISTS idx_deleted_branches_log_deleted_at ON public.deleted_branches_log USING btree (deleted_at DESC);
CREATE INDEX IF NOT EXISTS idx_notifications_branch_unread ON public.notifications USING btree (branch_id, is_read);
CREATE UNIQUE INDEX IF NOT EXISTS organization_applications_open_email ON public.organization_applications USING btree (lower((email)::text)) WHERE ((status)::text = ANY ((ARRAY['pending'::character varying, 'otp_sent'::character varying])::text[]));
CREATE INDEX IF NOT EXISTS organization_applications_status_submitted ON public.organization_applications USING btree (status, submitted_at DESC);
CREATE INDEX IF NOT EXISTS idx_organization_invites_email ON public.organization_invites USING btree (lower((email)::text));
CREATE UNIQUE INDEX IF NOT EXISTS idx_organization_invites_open ON public.organization_invites USING btree (organization_id, lower((email)::text)) WHERE ((status)::text = 'otp_sent'::text);
CREATE INDEX IF NOT EXISTS idx_organization_members_user ON public.organization_members USING btree (user_id);
CREATE UNIQUE INDEX IF NOT EXISTS organization_members_one_owner_per_org ON public.organization_members USING btree (organization_id) WHERE ((role)::text = 'org_owner'::text);
CREATE INDEX IF NOT EXISTS patients_branch_name_idx ON public.patients USING btree (branch_id, lower((full_name)::text));
CREATE INDEX IF NOT EXISTS patients_branch_phone_idx ON public.patients USING btree (branch_id, phone);
CREATE INDEX IF NOT EXISTS patients_branch_tin_idx ON public.patients USING btree (branch_id, tin);
CREATE INDEX IF NOT EXISTS pending_payments_branch_status_idx ON public.pending_payments USING btree (branch_id, status, created_at);
CREATE UNIQUE INDEX IF NOT EXISTS pending_payments_provider_reference_idx ON public.pending_payments USING btree (provider, provider_reference) WHERE (provider_reference IS NOT NULL);
CREATE INDEX IF NOT EXISTS idx_product_requests_branch_status ON public.product_requests USING btree (branch_id, status);
CREATE UNIQUE INDEX IF NOT EXISTS idx_product_variants_catalog_code ON public.product_variants USING btree (catalog_code) WHERE (catalog_code IS NOT NULL);
CREATE INDEX IF NOT EXISTS idx_role_change_log_branch ON public.role_change_log USING btree (branch_id, created_at DESC) WHERE (branch_id IS NOT NULL);
CREATE INDEX IF NOT EXISTS idx_role_change_log_org ON public.role_change_log USING btree (organization_id, created_at DESC) WHERE (organization_id IS NOT NULL);
CREATE INDEX IF NOT EXISTS idx_role_change_log_target ON public.role_change_log USING btree (target_user_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_sale_items_barcode ON public.sale_items USING btree (barcode_id);
CREATE INDEX IF NOT EXISTS idx_sale_items_sale ON public.sale_items USING btree (sale_id);
CREATE INDEX IF NOT EXISTS idx_sales_branch_date ON public.sales USING btree (branch_id, sold_at DESC);
CREATE INDEX IF NOT EXISTS idx_sales_patient ON public.sales USING btree (patient_id);
CREATE INDEX IF NOT EXISTS idx_forecast_snapshots_scope ON public.sales_forecast_snapshots USING btree (branch_id, product_id, category_id, generated_at DESC);
CREATE INDEX IF NOT EXISTS idx_stock_batches_delivery ON public.stock_batches USING btree (delivery_code);
CREATE INDEX IF NOT EXISTS idx_stock_batches_delivery_id ON public.stock_batches USING btree (delivery_id);
CREATE INDEX IF NOT EXISTS idx_stock_batches_variant_branch ON public.stock_batches USING btree (product_variant_id, branch_id);
CREATE INDEX IF NOT EXISTS idx_stock_deliveries_branch_received ON public.stock_deliveries USING btree (branch_id, received_at DESC);
CREATE INDEX IF NOT EXISTS idx_stock_deliveries_supplier ON public.stock_deliveries USING btree (supplier_id);
CREATE INDEX IF NOT EXISTS idx_stock_transfer_items_batch ON public.stock_transfer_items USING btree (stock_batch_id);
CREATE INDEX IF NOT EXISTS idx_stock_transfer_needs_branch ON public.stock_transfer_needs USING btree (requesting_branch_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_stock_transfer_needs_org_status ON public.stock_transfer_needs USING btree (organization_id, status, created_at DESC);
CREATE UNIQUE INDEX IF NOT EXISTS idx_one_pending_offer_per_need ON public.stock_transfer_offers USING btree (need_id) WHERE ((status)::text = 'pending'::text);
CREATE INDEX IF NOT EXISTS idx_stock_transfer_offers_need ON public.stock_transfer_offers USING btree (need_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_stock_transfer_offers_target ON public.stock_transfer_offers USING btree (target_branch_id, status);
CREATE INDEX IF NOT EXISTS idx_stock_transfers_from ON public.stock_transfers USING btree (from_branch_id, status);
CREATE INDEX IF NOT EXISTS idx_stock_transfers_org ON public.stock_transfers USING btree (organization_id, requested_at DESC);
CREATE INDEX IF NOT EXISTS idx_stock_transfers_to ON public.stock_transfers USING btree (to_branch_id, status);
CREATE UNIQUE INDEX IF NOT EXISTS suppliers_branch_name_ci_unique ON public.suppliers USING btree (branch_id, lower((supplier_name)::text)) WHERE (branch_id IS NOT NULL);
CREATE UNIQUE INDEX IF NOT EXISTS suppliers_global_name_ci_unique ON public.suppliers USING btree (lower((supplier_name)::text)) WHERE (branch_id IS NULL);
CREATE UNIQUE INDEX IF NOT EXISTS users_one_owner_per_branch ON public.users USING btree (branch_id) WHERE ((role)::text = 'owner'::text);


-- ============================================================================
-- ROW LEVEL SECURITY
-- ============================================================================

alter table public.barcodes enable row level security;
alter table public.batch_recalls enable row level security;
alter table public.branch_applications enable row level security;
alter table public.branch_directory enable row level security;
alter table public.branch_distance_measurements enable row level security;
alter table public.branch_product_categorization enable row level security;
alter table public.branch_settings enable row level security;
alter table public.branches enable row level security;
alter table public.dashboard_reports enable row level security;
alter table public.deleted_branches_log enable row level security;
alter table public.discounts enable row level security;
alter table public.insurance_claims enable row level security;
alter table public.insurance_product_coverage enable row level security;
alter table public.insurance_providers enable row level security;
alter table public.insurance_variant_prices enable row level security;
alter table public.notifications enable row level security;
alter table public.organization_applications enable row level security;
alter table public.organization_invites enable row level security;
alter table public.organization_members enable row level security;
alter table public.patients enable row level security;
alter table public.pending_payments enable row level security;
alter table public.pharmacy_organizations enable row level security;
alter table public.product_categories enable row level security;
alter table public.product_requests enable row level security;
alter table public.product_storage_locations enable row level security;
alter table public.product_variants enable row level security;
alter table public.products enable row level security;
alter table public.receipts enable row level security;
alter table public.reorder_points enable row level security;
alter table public.role_change_log enable row level security;
alter table public.sale_items enable row level security;
alter table public.sales enable row level security;
alter table public.sales_forecast_snapshots enable row level security;
alter table public.sales_forecasts enable row level security;
alter table public.stock_adjustments enable row level security;
alter table public.stock_batches enable row level security;
alter table public.stock_deliveries enable row level security;
alter table public.stock_transfer_items enable row level security;
alter table public.stock_transfer_needs enable row level security;
alter table public.stock_transfer_offers enable row level security;
alter table public.stock_transfers enable row level security;
alter table public.storage_locations enable row level security;
alter table public.suppliers enable row level security;
alter table public.support_tickets enable row level security;
alter table public.tax_rates enable row level security;
alter table public.users enable row level security;


-- ============================================================================
-- FUNCTIONS
-- ============================================================================

CREATE OR REPLACE FUNCTION public._execute_sale(p_branch uuid, p_cashier uuid, p_lines jsonb, p_insurance_provider_id uuid, p_patient_id uuid, p_payment_method text, p_discount_id uuid)
 RETURNS TABLE(sale_id uuid, receipt_number text, total_amount numeric, insurance_covered_total numeric, patient_owed_total numeric)
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''
AS $function$
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
$function$
;

revoke all on function public._execute_sale(p_branch uuid, p_cashier uuid, p_lines jsonb, p_insurance_provider_id uuid, p_patient_id uuid, p_payment_method text, p_discount_id uuid) from public, anon;
grant execute on function public._execute_sale(p_branch uuid, p_cashier uuid, p_lines jsonb, p_insurance_provider_id uuid, p_patient_id uuid, p_payment_method text, p_discount_id uuid) to authenticated;

-- ----------------------------------------------------------------------------

CREATE OR REPLACE FUNCTION public._price_sale_lines(p_branch uuid, p_lines jsonb, p_insurance_provider_id uuid, p_discount_id uuid)
 RETURNS TABLE(total_amount numeric, insurance_covered_total numeric, patient_owed_total numeric)
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''
AS $function$
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
$function$
;

revoke all on function public._price_sale_lines(p_branch uuid, p_lines jsonb, p_insurance_provider_id uuid, p_discount_id uuid) from public, anon;
grant execute on function public._price_sale_lines(p_branch uuid, p_lines jsonb, p_insurance_provider_id uuid, p_discount_id uuid) to authenticated;

-- ----------------------------------------------------------------------------

CREATE OR REPLACE FUNCTION public.activate_organization_invite()
 RETURNS TABLE(organization_id uuid, branch_id uuid, role text)
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''
AS $function$
declare
  v_user uuid := (select auth.uid());
  v_email text;
  v_invite public.organization_invites%rowtype;
  v_already public.organization_members%rowtype;
begin
  if v_user is null then raise exception 'Sign in with the emailed OTP first'; end if;

  select u.email into v_email from auth.users u where u.id = v_user;
  if v_email is null then raise exception 'Auth user email was not found'; end if;

  select * into v_invite
  from public.organization_invites i
  where lower(i.email) = lower(v_email) and i.status = 'otp_sent'
  order by i.otp_sent_at desc
  limit 1;

  if v_invite.id is null then
    raise exception 'No pending organization invite was found for %.', v_email;
  end if;

  perform public.freeze_expired_organization_invite(v_invite.id);
  select status into v_invite.status from public.organization_invites where id = v_invite.id;
  if v_invite.status <> 'otp_sent' then
    raise exception 'This invite has expired. Ask the organization owner to invite you again.';
  end if;

  if v_invite.role = 'org_manager' and exists (
    select 1 from public.organization_members
    where organization_id = v_invite.organization_id and role = 'org_manager' and user_id <> v_user
  ) then
    raise exception 'This organization already has an organization manager. Contact the organization owner.';
  end if;

  if not exists (select 1 from public.users u where u.id = v_user) then
    insert into public.users (id, branch_id, full_name, email, role, is_active)
    values (v_user, v_invite.branch_id, v_invite.full_name, lower(v_email),
            case when v_invite.role in ('org_owner', 'org_manager') then 'manager' else v_invite.role end,
            true);
  end if;

  if v_invite.role in ('org_owner', 'org_manager') then
    select * into v_already from public.organization_members
    where organization_id = v_invite.organization_id and user_id = v_user;

    insert into public.organization_members (organization_id, user_id, role)
    values (v_invite.organization_id, v_user, v_invite.role)
    on conflict (organization_id, user_id) do update set role = excluded.role;

    perform public.log_role_change(
      'organization', v_invite.organization_id, null, v_user, v_already.role, v_invite.role,
      case when v_already.role is null then 'grant' else 'role_change' end
    );
  else
    perform public.log_role_change('branch', null, v_invite.branch_id, v_user, null, v_invite.role, 'grant');
  end if;

  update public.organization_invites set status = 'accepted' where id = v_invite.id;

  return query select v_invite.organization_id, v_invite.branch_id, v_invite.role::text;
end;
$function$
;

revoke all on function public.activate_organization_invite() from public, anon;
grant execute on function public.activate_organization_invite() to authenticated;

-- ----------------------------------------------------------------------------

CREATE OR REPLACE FUNCTION public.activate_organization_registration()
 RETURNS TABLE(organization_id uuid, legal_name text, tin text, phone text, email text, location text, first_branch_id uuid)
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''
AS $function$
declare
  v_user uuid := (select auth.uid());
  v_email text;
  v_app public.organization_applications%rowtype;
begin
  if v_user is null then raise exception 'Sign in with the emailed OTP first'; end if;

  select u.email into v_email from auth.users u where u.id = v_user;
  if v_email is null then raise exception 'Auth user email was not found'; end if;

  if exists (select 1 from public.users u where u.id = v_user) then
    return query
      select o.id, o.legal_name::text, o.tin::text, a.phone::text, a.email::text,
        a.location::text, u.branch_id
      from public.users u
      join public.organization_members m on m.user_id = u.id and m.role = 'org_owner'
      join public.pharmacy_organizations o on o.id = m.organization_id
      left join public.organization_applications a on a.organization_id = o.id
      where u.id = v_user
      limit 1;
    return;
  end if;

  select * into v_app
  from public.organization_applications a
  where lower(a.email) = lower(v_email) and a.status = 'otp_sent'
  order by a.submitted_at desc
  limit 1;

  if v_app.id is null then
    raise exception 'No approved organization application is awaiting activation for %. Ask the super admin to approve it first.', v_email;
  end if;
  if v_app.organization_id is null then
    raise exception 'This application has no organization record yet. Ask the super admin to approve it again.';
  end if;

  update public.organization_applications set status = 'active' where id = v_app.id;

  return query
    select v_app.organization_id, v_app.legal_name::text, v_app.tin::text,
      v_app.phone::text, v_app.email::text, v_app.location::text, v_app.first_branch_id;
end;
$function$
;

revoke all on function public.activate_organization_registration() from public, anon;
grant execute on function public.activate_organization_registration() to authenticated;

-- ----------------------------------------------------------------------------

CREATE OR REPLACE FUNCTION public.activate_pharmacy_account()
 RETURNS TABLE(branch_id uuid, branch_code text, activation_code text, pharmacy_name text)
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''
AS $function$
  #variable_conflict use_column
  declare
    v_user uuid := (select auth.uid());
    v_email text;
    v_app public.branch_applications%rowtype;
    v_loc text;
    v_seq integer;
    v_code text;
    v_act text;
    v_chars text := 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
    i integer;
  begin
    if v_user is null then raise exception 'Sign in with the emailed OTP first'; end if;

    select u.email into v_email from auth.users u where u.id = v_user;
    if v_email is null then raise exception 'Auth user email was not found'; end if;

    -- Checked FIRST so this function is idempotent. verifyOtp() runs before this
    -- RPC on the client, so any failure here leaves a live auth session with no
    -- public.users row; re-running must heal that state rather than fail again.
    if exists (select 1 from public.users u where u.id = v_user) then
      return query
        select b.id, b.branch_code::text, b.activation_code::text, b.name::text
        from public.users u
        join public.branches b on b.id = u.branch_id
        where u.id = v_user;
      return;
    end if;

    select * into v_app
    from public.branch_applications a
    where lower(a.email) = lower(v_email)
      and a.status = 'otp_sent'
    order by a.submitted_at desc
    limit 1;

    if v_app.id is null then
      raise exception 'No approved application is awaiting activation for %. Ask the super admin to approve the pharmacy first.', v_email;
    end if;

    if v_app.branch_id is null then
      raise exception 'This application has no branch record yet. Ask the super admin to approve it again.';
    end if;

    if exists (select 1 from public.users u where u.branch_id = v_app.branch_id) then
      raise exception 'This pharmacy already has an operator account';
    end if;

    -- Reuse identifiers from an earlier partial run instead of burning a new
    -- sequence number and silently changing a code the branch may already hold.
    select b.branch_code, b.activation_code
    into v_code, v_act
    from public.branches b
    where b.id = v_app.branch_id;

    if v_code is null then
      v_loc := upper(regexp_replace(split_part(v_app.location, ',', 1), '[^A-Za-z]', '', 'g'));
      if length(coalesce(v_loc, '')) < 3 then v_loc := rpad(coalesce(v_loc, ''), 3, 'X'); else v_loc := left(v_loc, 3); end if;

      select coalesce(max(substring(b.branch_code from '[0-9]+$')::integer), 0) + 1
      into v_seq
      from public.branches b
      where b.branch_code ~ '^PSYNC-[A-Z]{3}-[0-9]{4}$';

      v_code := format('PSYNC-%s-%s', v_loc, lpad(v_seq::text, 4, '0'));
    end if;

    if v_act is null then
      v_act := 'ACT-';
      for i in 1..6 loop
        v_act := v_act || substr(v_chars, 1 + floor(random() * length(v_chars))::integer, 1);
      end loop;
    end if;

    update public.branches
    set status = 'active', branch_code = v_code, activation_code = v_act
    where id = v_app.branch_id;

    insert into public.users (id, branch_id, full_name, email, role, is_active)
    values (v_user, v_app.branch_id, v_app.pharmacy_name, lower(v_email), 'owner', true);

    -- Starter category set, seeded once at true first activation only (never
    -- on the early-return path above for an already-active account) -- a
    -- branch that later deletes one of these deliberately should not have it
    -- silently reappear on a later sign-in. Same reasoning as branch_directory
    -- just below: targeted by constraint name, not by column list, since
    -- `branch_id` is this function's own RETURNS TABLE output parameter too.
    insert into public.product_categories (branch_id, name, description) values
      (v_app.branch_id, 'Allergy & Antihistamines', 'Allergy relief medicines'),
      (v_app.branch_id, 'Antibiotics', 'Prescription antibacterial medicines'),
      (v_app.branch_id, 'Antimalarials', 'Malaria prevention and treatment'),
      (v_app.branch_id, 'Cardiovascular', 'Heart and blood pressure medicines'),
      (v_app.branch_id, 'Contraceptives & Family Planning', 'Reproductive health products'),
      (v_app.branch_id, 'Cough, Cold & Flu', 'Respiratory and cold symptom relief'),
      (v_app.branch_id, 'Diabetes Care', 'Blood sugar management'),
      (v_app.branch_id, 'Digestive Health', 'Antacids and gastrointestinal medicines'),
      (v_app.branch_id, 'Eye & Ear Care', 'Ophthalmic and ENT products'),
      (v_app.branch_id, 'First Aid & Wound Care', 'Bandages, antiseptics, and wound supplies'),
      (v_app.branch_id, 'Herbal & Traditional Medicine', 'Non-conventional remedies'),
      (v_app.branch_id, 'Maternal & Child Health', 'Products for mothers and infants'),
      (v_app.branch_id, 'Medical Supplies', 'PPE, gloves, syringes, and general supplies'),
      (v_app.branch_id, 'Pain Relief & Fever', 'Analgesics and antipyretics'),
      (v_app.branch_id, 'Personal Care & Hygiene', 'General hygiene and personal care items'),
      (v_app.branch_id, 'Skin Care & Dermatology', 'Topical and skin treatment products'),
      (v_app.branch_id, 'Vitamins & Supplements', 'Nutritional support products')
    on conflict on constraint product_categories_branch_id_name_key do nothing;

    -- Targeted by constraint name, NOT by column list. `on conflict (branch_id)`
    -- cannot be resolved here: the inference clause only accepts bare column
    -- names, and `branch_id` is also this function's RETURNS TABLE output
    -- parameter, so Postgres raises "column reference branch_id is ambiguous"
    -- at runtime. Naming the constraint removes the inference step entirely.
    insert into public.branch_directory (branch_id, display_name)
    values (v_app.branch_id, v_app.pharmacy_name)
    on conflict on constraint branch_directory_pkey
    do update set display_name = excluded.display_name;

    update public.branch_applications set status = 'active' where id = v_app.id;

    return query select v_app.branch_id, v_code, v_act, v_app.pharmacy_name::text;
  end;
  $function$
;

revoke all on function public.activate_pharmacy_account() from public, anon;
grant execute on function public.activate_pharmacy_account() to authenticated;

-- ----------------------------------------------------------------------------

CREATE OR REPLACE FUNCTION public.add_branch_to_organization(p_organization_id uuid, p_pharmacy_name text, p_phone text, p_email text, p_location text)
 RETURNS uuid
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''
AS $function$
declare
  v_branch uuid := gen_random_uuid();
  v_loc text;
  v_seq int;
  v_code text;
begin
  perform public.assert_org_owner(p_organization_id);

  if nullif(btrim(coalesce(p_pharmacy_name, '')), '') is null then
    raise exception 'A branch name is required';
  end if;
  if exists (select 1 from public.pharmacy_organizations where id = p_organization_id and status <> 'active') then
    raise exception 'This organization is not active';
  end if;

  v_loc := upper(regexp_replace(split_part(coalesce(p_location, ''), ',', 1), '[^A-Za-z]', '', 'g'));
  if length(coalesce(v_loc, '')) < 3 then v_loc := rpad(coalesce(v_loc, ''), 3, 'X'); else v_loc := left(v_loc, 3); end if;

  select coalesce(max(substring(b.branch_code from '[0-9]+$')::integer), 0) + 1
  into v_seq
  from public.branches b
  where b.branch_code ~ '^PSYNC-[A-Z]{3}-[0-9]{4}$';

  v_code := format('PSYNC-%s-%s', v_loc, lpad(v_seq::text, 4, '0'));

  insert into public.branches (id, organization_id, name, phone, email, address, status, branch_code)
  values (
    v_branch, p_organization_id, btrim(p_pharmacy_name),
    nullif(btrim(coalesce(p_phone, '')), ''), nullif(btrim(coalesce(p_email, '')), ''),
    nullif(btrim(coalesce(p_location, '')), ''), 'active', v_code
  );

  -- Same reasoning as activate_pharmacy_account()'s own branch_directory
  -- insert: every branch, including one created this way, has to appear in
  -- the public sign-in directory the moment it can be signed into.
  insert into public.branch_directory (branch_id, display_name)
  values (v_branch, btrim(p_pharmacy_name));

  return v_branch;
end;
$function$
;

revoke all on function public.add_branch_to_organization(p_organization_id uuid, p_pharmacy_name text, p_phone text, p_email text, p_location text) from public, anon;
grant execute on function public.add_branch_to_organization(p_organization_id uuid, p_pharmacy_name text, p_phone text, p_email text, p_location text) to authenticated;

-- ----------------------------------------------------------------------------

CREATE OR REPLACE FUNCTION public.adjust_stock(p_stock_batch_id uuid, p_adjustment_type text, p_delta integer, p_reason text)
 RETURNS uuid
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''
AS $function$
declare
  v_branch uuid;
  v_user uuid := (select auth.uid());
  v_batch record;
  v_remaining integer;
  v_take integer;
  v_new_status text;
  v_pack record;
  v_adjustment uuid;
begin
  select u.branch_id into v_branch
  from public.users u
  where u.id = v_user and u.is_active;

  if v_branch is null or not exists (
    select 1 from public.users u where u.id = v_user and u.role in ('owner','manager')
  ) then
    raise exception 'Only an active branch manager or owner may adjust stock';
  end if;

  if p_adjustment_type not in ('damage','loss','correction','return','expired_writeoff','recalled') then
    raise exception 'Unknown adjustment type: %', p_adjustment_type;
  end if;
  if p_delta = 0 then
    raise exception 'Adjustment quantity cannot be zero';
  end if;
  if p_adjustment_type <> 'correction' and p_delta > 0 then
    raise exception '% must reduce stock, not add it', p_adjustment_type;
  end if;
  if nullif(btrim(coalesce(p_reason, '')), '') is null then
    raise exception 'A reason is required for every stock adjustment';
  end if;

  select sb.*, p.name as product_name, pv.dosage
    into v_batch
    from public.stock_batches sb
    join public.product_variants pv on pv.id = sb.product_variant_id
    join public.products p on p.id = pv.product_id
    where sb.id = p_stock_batch_id and sb.branch_id = v_branch;
  if not found then
    raise exception 'Stock batch not found for this branch';
  end if;

  v_new_status := case p_adjustment_type
    when 'damage' then 'damaged'
    when 'recalled' then 'recalled'
    when 'expired_writeoff' then 'expired'
    else 'sold_out'
  end;

  if p_delta < 0 then
    v_remaining := abs(p_delta);
    for v_pack in
      select * from public.barcodes
      where stock_batch_id = p_stock_batch_id and barcode_type = 'pack'
        and status = 'active' and quantity_available > 0
      order by created_at asc
      for update
    loop
      exit when v_remaining <= 0;
      v_take := least(v_remaining, coalesce(v_pack.pieces_per_pack, 0));
      if v_take >= v_pack.pieces_per_pack then
        update public.barcodes set quantity_available = 0, status = v_new_status where id = v_pack.id;
      else
        update public.barcodes set pieces_per_pack = v_pack.pieces_per_pack - v_take where id = v_pack.id;
      end if;
      v_remaining := v_remaining - v_take;
    end loop;

    if v_remaining > 0 then
      raise exception 'Only % piece(s) available in this batch -- cannot remove %', abs(p_delta) - v_remaining, abs(p_delta);
    end if;
  else
    insert into public.barcodes (stock_batch_id, barcode_type, code, code_source, pieces_per_pack, quantity_available, status)
    values (p_stock_batch_id, 'pack', public.generate_short_barcode_code(), 'generated', p_delta, 1, 'active');
  end if;

  insert into public.stock_adjustments (stock_batch_id, adjustment_type, quantity, reason, performed_by)
  values (p_stock_batch_id, p_adjustment_type, abs(p_delta), btrim(p_reason), v_user)
  returning id into v_adjustment;

  insert into public.notifications (branch_id, source_type, source_id, message)
  values (
    v_branch, 'stock_adjustment', v_adjustment,
    format('%s: %s %s piece(s) of %s (%s)',
      initcap(p_adjustment_type), case when p_delta < 0 then 'removed' else 'added' end,
      abs(p_delta), concat_ws(' ', v_batch.product_name, v_batch.dosage), btrim(p_reason))
  );

  return v_adjustment;
end;
$function$
;

revoke all on function public.adjust_stock(p_stock_batch_id uuid, p_adjustment_type text, p_delta integer, p_reason text) from public, anon;
grant execute on function public.adjust_stock(p_stock_batch_id uuid, p_adjustment_type text, p_delta integer, p_reason text) to authenticated;

-- ----------------------------------------------------------------------------

CREATE OR REPLACE FUNCTION public.admin_approve_organization_application(p_application_id uuid)
 RETURNS TABLE(organization_id uuid, email text)
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''
AS $function$
declare
  v_app public.organization_applications%rowtype;
  v_org uuid := gen_random_uuid();
begin
  perform public.assert_super_admin();
  select * into v_app from public.organization_applications where id = p_application_id;
  if v_app.id is null then raise exception 'Application not found'; end if;
  if v_app.status <> 'pending' then raise exception 'Only pending applications can be approved'; end if;
  if v_app.called_at is null then raise exception 'Call the applicant before approving'; end if;

  insert into public.pharmacy_organizations (id, legal_name, tin, status)
  values (v_org, v_app.legal_name, v_app.tin, 'active');

  update public.organization_applications
  set status = 'otp_sent', organization_id = v_org, otp_sent_at = now()
  where id = p_application_id;

  return query select v_org, v_app.email::text;
end;
$function$
;

revoke all on function public.admin_approve_organization_application(p_application_id uuid) from public, anon;
grant execute on function public.admin_approve_organization_application(p_application_id uuid) to authenticated;

-- ----------------------------------------------------------------------------

CREATE OR REPLACE FUNCTION public.admin_approve_pharmacy_application(p_application_id uuid)
 RETURNS TABLE(branch_id uuid, email text)
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''
AS $function$
  declare
    v_app public.branch_applications%rowtype;
    v_branch uuid := gen_random_uuid();
  begin
    perform public.assert_super_admin();
    select * into v_app from public.branch_applications where id = p_application_id;
    if v_app.id is null then raise exception 'Application not found'; end if;
    if v_app.status <> 'pending' then raise exception 'Only pending applications can be approved'; end if;
    if v_app.called_at is null then raise exception 'Call the pharmacy before approving'; end if;

    insert into public.branches (id, name, address, phone, email, status)
    values (v_branch, v_app.pharmacy_name, v_app.location, v_app.phone, v_app.email, 'otp_sent');

    update public.branch_applications
    set status = 'otp_sent', branch_id = v_branch, otp_sent_at = now()
    where id = p_application_id;

    return query select v_branch, v_app.email::text;
  end;
  $function$
;

revoke all on function public.admin_approve_pharmacy_application(p_application_id uuid) from public, anon;
grant execute on function public.admin_approve_pharmacy_application(p_application_id uuid) to authenticated;

-- ----------------------------------------------------------------------------

CREATE OR REPLACE FUNCTION public.admin_approve_product_request(p_request_id uuid, p_product_name text, p_generic_name text, p_product_type text, p_tax_rate_id uuid, p_variants jsonb)
 RETURNS TABLE(product_id uuid, variant_id uuid)
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''
AS $function$
declare
  v_req public.product_requests%rowtype;
  v_type text;
  v_product uuid;
  v_first_variant uuid;
  v_variant uuid;
  v_variant_json jsonb;
  v_is_first boolean := true;
begin
  perform public.assert_super_admin();

  select * into v_req from public.product_requests where id = p_request_id;
  if v_req.id is null then raise exception 'Product request not found'; end if;
  if v_req.status <> 'pending' then raise exception 'Only a pending request can be approved'; end if;
  if nullif(btrim(coalesce(p_product_name, '')), '') is null then raise exception 'A product name is required'; end if;
  if not exists (select 1 from public.tax_rates t where t.id = p_tax_rate_id) then
    raise exception 'Unknown tax rate';
  end if;
  if jsonb_typeof(p_variants) <> 'array' or jsonb_array_length(p_variants) = 0 then
    raise exception 'At least one variant (dosage/form/unit) is required';
  end if;

  v_type := coalesce(nullif(p_product_type, ''), 'medicine');
  if v_type not in ('medicine','supply','other') then v_type := 'other'; end if;

  select p.id into v_product from public.products p where lower(p.name) = lower(btrim(p_product_name));
  if v_product is null then
    insert into public.products (tax_rate_id, product_type, name, generic_name)
    values (p_tax_rate_id, v_type, btrim(p_product_name), nullif(btrim(coalesce(p_generic_name, '')), ''))
    returning id into v_product;
  else
    update public.products set tax_rate_id = p_tax_rate_id where id = v_product;
  end if;

  for v_variant_json in select * from jsonb_array_elements(p_variants) loop
    select pv.id into v_variant
    from public.product_variants pv
    where pv.product_id = v_product
      and coalesce(pv.dosage, '') = coalesce(nullif(btrim(coalesce(v_variant_json->>'dosage', '')), ''), '')
      and coalesce(pv.form, '') = coalesce(nullif(btrim(coalesce(v_variant_json->>'form', '')), ''), '')
    limit 1;

    if v_variant is null then
      insert into public.product_variants (product_id, dosage, form, unit)
      values (
        v_product,
        nullif(btrim(coalesce(v_variant_json->>'dosage', '')), ''),
        nullif(btrim(coalesce(v_variant_json->>'form', '')), ''),
        nullif(btrim(coalesce(v_variant_json->>'unit', '')), '')
      )
      returning id into v_variant;
    end if;

    if v_is_first then v_first_variant := v_variant; v_is_first := false; end if;
  end loop;

  update public.product_requests
  set status = 'approved', resolved_product_id = v_product, resolved_variant_id = v_first_variant,
      resolved_by = (select auth.uid()), resolved_at = now()
  where id = p_request_id;

  insert into public.notifications (branch_id, source_type, source_id, message)
  values (v_req.branch_id, 'product_request_approved', p_request_id,
    format('Your product request was approved: "%s" is now in the catalogue.', btrim(p_product_name)));

  return query select v_product, v_first_variant;
end;
$function$
;

revoke all on function public.admin_approve_product_request(p_request_id uuid, p_product_name text, p_generic_name text, p_product_type text, p_tax_rate_id uuid, p_variants jsonb) from public, anon;
grant execute on function public.admin_approve_product_request(p_request_id uuid, p_product_name text, p_generic_name text, p_product_type text, p_tax_rate_id uuid, p_variants jsonb) to authenticated;

-- ----------------------------------------------------------------------------

CREATE OR REPLACE FUNCTION public.admin_backfill_categories_to_all_branches()
 RETURNS integer
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''
AS $function$
declare
  v_count integer := 0;
  v_step integer;
begin
  perform public.assert_super_admin();

  with org_categories as (
    select distinct on (b1.organization_id, pc.name)
      b1.organization_id, pc.name, pc.description
    from public.product_categories pc
    join public.branches b1 on b1.id = pc.branch_id
    where b1.organization_id is not null
    order by b1.organization_id, pc.name
  )
  insert into public.product_categories (branch_id, name, description)
  select b2.id, oc.name, oc.description
  from public.branches b2
  join org_categories oc on oc.organization_id = b2.organization_id
  on conflict (branch_id, name) do nothing;
  get diagnostics v_step = row_count;
  v_count := v_count + v_step;

  with canonical as (
    select btrim(name) as name, min(description) as description
    from public.product_categories
    group by btrim(name)
  )
  insert into public.product_categories (branch_id, name, description)
  select b.id, c.name, c.description
  from public.branches b
  cross join canonical c
  on conflict (branch_id, name) do nothing;
  get diagnostics v_step = row_count;
  v_count := v_count + v_step;

  return v_count;
end;
$function$
;

revoke all on function public.admin_backfill_categories_to_all_branches() from public, anon;
grant execute on function public.admin_backfill_categories_to_all_branches() to authenticated;

-- ----------------------------------------------------------------------------

CREATE OR REPLACE FUNCTION public.admin_clear_insurance_coverage(p_provider_id uuid, p_product_id uuid)
 RETURNS void
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''
AS $function$
begin
  perform public.assert_super_admin();
  delete from public.insurance_product_coverage
  where insurance_provider_id = p_provider_id and product_id = p_product_id;
end;
$function$
;

revoke all on function public.admin_clear_insurance_coverage(p_provider_id uuid, p_product_id uuid) from public, anon;
grant execute on function public.admin_clear_insurance_coverage(p_provider_id uuid, p_product_id uuid) to authenticated;

-- ----------------------------------------------------------------------------

CREATE OR REPLACE FUNCTION public.admin_clear_insurance_variant_price(p_provider_id uuid, p_product_variant_id uuid)
 RETURNS void
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''
AS $function$
begin
  perform public.assert_super_admin();
  delete from public.insurance_variant_prices
  where insurance_provider_id = p_provider_id and product_variant_id = p_product_variant_id;
end;
$function$
;

revoke all on function public.admin_clear_insurance_variant_price(p_provider_id uuid, p_product_variant_id uuid) from public, anon;
grant execute on function public.admin_clear_insurance_variant_price(p_provider_id uuid, p_product_variant_id uuid) to authenticated;

-- ----------------------------------------------------------------------------

CREATE OR REPLACE FUNCTION public.admin_create_category(p_name text, p_description text, p_branch_id uuid DEFAULT NULL::uuid)
 RETURNS integer
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''
AS $function$
declare
  v_count integer := 0;
begin
  perform public.assert_super_admin();
  if nullif(btrim(coalesce(p_name, '')), '') is null then raise exception 'A category name is required'; end if;

  if p_branch_id is not null then
    insert into public.product_categories (branch_id, name, description)
    values (p_branch_id, btrim(p_name), nullif(btrim(coalesce(p_description, '')), ''))
    on conflict (branch_id, name) do nothing;
    get diagnostics v_count = row_count;
  else
    insert into public.product_categories (branch_id, name, description)
    select b.id, btrim(p_name), nullif(btrim(coalesce(p_description, '')), '')
    from public.branches b
    on conflict (branch_id, name) do nothing;
    get diagnostics v_count = row_count;
  end if;

  return v_count;
end;
$function$
;

revoke all on function public.admin_create_category(p_name text, p_description text, p_branch_id uuid) from public, anon;
grant execute on function public.admin_create_category(p_name text, p_description text, p_branch_id uuid) to authenticated;

-- ----------------------------------------------------------------------------

CREATE OR REPLACE FUNCTION public.admin_create_insurance_provider(p_name text, p_default_coverage_percentage numeric, p_contact_info text DEFAULT NULL::text, p_tin text DEFAULT NULL::text)
 RETURNS uuid
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''
AS $function$
declare
  v_id uuid;
begin
  perform public.assert_super_admin();
  if nullif(btrim(p_name), '') is null then
    raise exception 'Insurance provider name is required';
  end if;
  if p_default_coverage_percentage is null or p_default_coverage_percentage < 0 or p_default_coverage_percentage > 100 then
    raise exception 'Default coverage percentage must be between 0 and 100';
  end if;
  insert into public.insurance_providers (name, default_coverage_percentage, contact_info, tin)
  values (
    btrim(p_name), p_default_coverage_percentage,
    nullif(btrim(coalesce(p_contact_info, '')), ''),
    nullif(btrim(coalesce(p_tin, '')), '')
  )
  returning id into v_id;
  return v_id;
end;
$function$
;

revoke all on function public.admin_create_insurance_provider(p_name text, p_default_coverage_percentage numeric, p_contact_info text, p_tin text) from public, anon;
grant execute on function public.admin_create_insurance_provider(p_name text, p_default_coverage_percentage numeric, p_contact_info text, p_tin text) to authenticated;

-- ----------------------------------------------------------------------------

CREATE OR REPLACE FUNCTION public.admin_create_product(p_name text, p_generic_name text, p_product_type text, p_tax_rate_id uuid, p_variants jsonb)
 RETURNS uuid
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''
AS $function$
declare
  v_type text;
  v_product uuid;
  v_variant jsonb;
begin
  perform public.assert_super_admin();
  if nullif(btrim(coalesce(p_name, '')), '') is null then raise exception 'A product name is required'; end if;
  if not exists (select 1 from public.tax_rates t where t.id = p_tax_rate_id) then
    raise exception 'Unknown tax rate';
  end if;
  if jsonb_typeof(p_variants) <> 'array' or jsonb_array_length(p_variants) = 0 then
    raise exception 'At least one variant (dosage/form/unit) is required';
  end if;

  v_type := coalesce(nullif(p_product_type, ''), 'medicine');
  if v_type not in ('medicine','supply','other') then v_type := 'other'; end if;

  insert into public.products (tax_rate_id, product_type, name, generic_name)
  values (p_tax_rate_id, v_type, btrim(p_name), nullif(btrim(coalesce(p_generic_name, '')), ''))
  returning id into v_product;

  for v_variant in select * from jsonb_array_elements(p_variants) loop
    insert into public.product_variants (product_id, dosage, form, unit)
    values (
      v_product,
      nullif(btrim(coalesce(v_variant->>'dosage', '')), ''),
      nullif(btrim(coalesce(v_variant->>'form', '')), ''),
      nullif(btrim(coalesce(v_variant->>'unit', '')), '')
    );
  end loop;

  return v_product;
end;
$function$
;

revoke all on function public.admin_create_product(p_name text, p_generic_name text, p_product_type text, p_tax_rate_id uuid, p_variants jsonb) from public, anon;
grant execute on function public.admin_create_product(p_name text, p_generic_name text, p_product_type text, p_tax_rate_id uuid, p_variants jsonb) to authenticated;

-- ----------------------------------------------------------------------------

CREATE OR REPLACE FUNCTION public.admin_create_tax_rate(p_name text, p_rate_percentage numeric)
 RETURNS uuid
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''
AS $function$
declare
  v_id uuid;
begin
  perform public.assert_super_admin();
  if nullif(btrim(coalesce(p_name, '')), '') is null then raise exception 'A tax rate name is required'; end if;
  if p_rate_percentage is null or p_rate_percentage < 0 or p_rate_percentage > 100 then
    raise exception 'Tax rate must be between 0 and 100';
  end if;
  if exists (select 1 from public.tax_rates where lower(name) = lower(btrim(p_name))) then
    raise exception 'A tax rate named "%" already exists', btrim(p_name);
  end if;
  insert into public.tax_rates (name, rate_percentage) values (btrim(p_name), p_rate_percentage) returning id into v_id;
  return v_id;
end;
$function$
;

revoke all on function public.admin_create_tax_rate(p_name text, p_rate_percentage numeric) from public, anon;
grant execute on function public.admin_create_tax_rate(p_name text, p_rate_percentage numeric) to authenticated;

-- ----------------------------------------------------------------------------

CREATE OR REPLACE FUNCTION public.admin_delete_branch(p_branch_id uuid, p_reason text DEFAULT NULL::text)
 RETURNS void
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''
AS $function$
declare
  v_branch public.branches%rowtype;
  v_deleted_by_email text;
begin
  perform public.assert_super_admin();

  select * into v_branch from public.branches where id = p_branch_id;
  if v_branch.id is null then
    raise exception 'Branch not found';
  end if;

  if exists (
    select 1 from public.batch_recalls r
    join public.users u on u.id = r.recalled_by
    where u.branch_id = p_branch_id
  ) then
    raise exception 'This branch cannot be deleted: a user from this branch is recorded as having issued a system-wide batch recall, and that recall record must be kept. Contact support to reassign it first.';
  end if;

  select email into v_deleted_by_email from auth.users where id = (select auth.uid());

  insert into public.deleted_branches_log (
    branch_id, pharmacy_name, phone, email, branch_code, location, reason, deleted_by_email
  ) values (
    v_branch.id, v_branch.name, v_branch.phone, v_branch.email, v_branch.branch_code, v_branch.address,
    nullif(btrim(coalesce(p_reason, '')), ''), v_deleted_by_email
  );

  delete from public.sale_items where sale_id in (select id from public.sales where branch_id = p_branch_id);
  delete from public.receipts where sale_id in (select id from public.sales where branch_id = p_branch_id);
  delete from public.insurance_claims where sale_id in (select id from public.sales where branch_id = p_branch_id);
  delete from public.sales where branch_id = p_branch_id;

  delete from public.stock_adjustments
  where stock_batch_id in (select id from public.stock_batches where branch_id = p_branch_id)
     or barcode_id in (
       select bc.id from public.barcodes bc
       join public.stock_batches sb on sb.id = bc.stock_batch_id
       where sb.branch_id = p_branch_id
     );

  delete from public.barcodes
  where stock_batch_id in (select id from public.stock_batches where branch_id = p_branch_id);

  delete from public.stock_batches where branch_id = p_branch_id;
  delete from public.stock_deliveries where branch_id = p_branch_id;

  delete from public.reorder_points where branch_id = p_branch_id;
  delete from public.branch_product_categorization where branch_id = p_branch_id;
  delete from public.product_categories where branch_id = p_branch_id;

  -- Previously missing: all three reference branches(id) with no ON DELETE
  -- CASCADE, so any branch that had ever registered a patient, created a
  -- discount, or filed a product request made the delete below fail with a
  -- raw foreign-key-violation error instead of actually deleting the branch.
  delete from public.patients where branch_id = p_branch_id;
  delete from public.discounts where branch_id = p_branch_id;
  delete from public.product_requests where branch_id = p_branch_id;

  delete from public.notifications where branch_id = p_branch_id;
  delete from public.sales_forecasts where branch_id = p_branch_id;
  delete from public.dashboard_reports where branch_id = p_branch_id;
  delete from public.support_tickets where branch_id = p_branch_id;
  delete from public.branch_settings where branch_id = p_branch_id;
  delete from public.suppliers where branch_id = p_branch_id;

  -- Denied (not just unlinked): submit_pharmacy_registration() blocks a new
  -- application from an email that already has one with status in
  -- ('pending','otp_sent','active'). Leaving this row 'active' with no
  -- branch behind it permanently locked that email out of ever registering
  -- again, which is the opposite of what deleting the branch should do.
  update public.branch_applications
  set branch_id = null,
      status = 'denied',
      denied_reason = coalesce(nullif(btrim(coalesce(p_reason, '')), ''), 'Branch deleted by admin')
  where branch_id = p_branch_id;

  delete from public.branch_directory where branch_id = p_branch_id;
  delete from public.users where branch_id = p_branch_id;
  delete from public.branches where id = p_branch_id;
end;
$function$
;

revoke all on function public.admin_delete_branch(p_branch_id uuid, p_reason text) from public, anon;
grant execute on function public.admin_delete_branch(p_branch_id uuid, p_reason text) to authenticated;

-- ----------------------------------------------------------------------------

CREATE OR REPLACE FUNCTION public.admin_deny_organization_application(p_application_id uuid, p_reason text)
 RETURNS void
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''
AS $function$
begin
  perform public.assert_super_admin();
  update public.organization_applications
  set status = 'denied', denied_reason = nullif(btrim(p_reason), '')
  where id = p_application_id and status in ('pending', 'otp_sent');
  if not found then
    raise exception 'This application cannot be denied';
  end if;
end;
$function$
;

revoke all on function public.admin_deny_organization_application(p_application_id uuid, p_reason text) from public, anon;
grant execute on function public.admin_deny_organization_application(p_application_id uuid, p_reason text) to authenticated;

-- ----------------------------------------------------------------------------

CREATE OR REPLACE FUNCTION public.admin_deny_pharmacy_application(p_application_id uuid, p_reason text)
 RETURNS void
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''
AS $function$
  begin
    perform public.assert_super_admin();
    update public.branch_applications
    set status = 'denied', denied_reason = nullif(btrim(p_reason), '')
    where id = p_application_id and status in ('pending','otp_sent');
    if not found then
      raise exception 'This application cannot be denied';
    end if;
  end;
  $function$
;

revoke all on function public.admin_deny_pharmacy_application(p_application_id uuid, p_reason text) from public, anon;
grant execute on function public.admin_deny_pharmacy_application(p_application_id uuid, p_reason text) to authenticated;

-- ----------------------------------------------------------------------------

CREATE OR REPLACE FUNCTION public.admin_expire_stale_applications()
 RETURNS integer
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''
AS $function$
declare
  v_deleted integer := 0;
begin
  perform public.assert_super_admin();

  delete from public.branch_applications
  where status = 'pending'
    and branch_id is null
    and submitted_at < now() - interval '7 days';

  get diagnostics v_deleted = row_count;
  return v_deleted;
end;
$function$
;

revoke all on function public.admin_expire_stale_applications() from public, anon;
grant execute on function public.admin_expire_stale_applications() to authenticated;

-- ----------------------------------------------------------------------------

CREATE OR REPLACE FUNCTION public.admin_expire_stale_organization_applications()
 RETURNS integer
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''
AS $function$
declare
  v_deleted integer := 0;
begin
  perform public.assert_super_admin();

  delete from public.organization_applications
  where status = 'pending'
    and organization_id is null
    and submitted_at < now() - interval '7 days';

  get diagnostics v_deleted = row_count;
  return v_deleted;
end;
$function$
;

revoke all on function public.admin_expire_stale_organization_applications() from public, anon;
grant execute on function public.admin_expire_stale_organization_applications() to authenticated;

-- ----------------------------------------------------------------------------

CREATE OR REPLACE FUNCTION public.admin_import_insurance_price_list(p_provider_id uuid, p_tax_rate_id uuid, p_rows jsonb)
 RETURNS TABLE(created_products integer, updated_products integer, created_variants integer, reused_variants integer, prices_set integer)
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''
AS $function$
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
$function$
;

revoke all on function public.admin_import_insurance_price_list(p_provider_id uuid, p_tax_rate_id uuid, p_rows jsonb) from public, anon;
grant execute on function public.admin_import_insurance_price_list(p_provider_id uuid, p_tax_rate_id uuid, p_rows jsonb) to authenticated;

-- ----------------------------------------------------------------------------

CREATE OR REPLACE FUNCTION public.admin_import_product_catalog(p_tax_rate_id uuid, p_rows jsonb)
 RETURNS TABLE(created_products integer, updated_products integer, created_variants integer, reused_variants integer)
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''
AS $function$
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
$function$
;

revoke all on function public.admin_import_product_catalog(p_tax_rate_id uuid, p_rows jsonb) from public, anon;
grant execute on function public.admin_import_product_catalog(p_tax_rate_id uuid, p_rows jsonb) to authenticated;

-- ----------------------------------------------------------------------------

CREATE OR REPLACE FUNCTION public.admin_list_all_branches()
 RETURNS TABLE(id uuid, name text, phone text, email text, address text, status text, branch_code text, activation_code text, failed_logins integer, locked_at timestamp with time zone, organization_id uuid, organization_legal_name text, created_at timestamp with time zone)
 LANGUAGE plpgsql
 STABLE SECURITY DEFINER
 SET search_path TO ''
AS $function$
begin
  perform public.assert_super_admin();
  return query
    select
      b.id, b.name::text, b.phone::text, b.email::text, b.address, b.status::text,
      b.branch_code::text, b.activation_code::text, coalesce(b.failed_logins, 0), b.locked_at,
      b.organization_id, o.legal_name::text, b.created_at
    from public.branches b
    left join public.pharmacy_organizations o on o.id = b.organization_id
    order by b.created_at desc;
end;
$function$
;

revoke all on function public.admin_list_all_branches() from public, anon;
grant execute on function public.admin_list_all_branches() to authenticated;

-- ----------------------------------------------------------------------------

CREATE OR REPLACE FUNCTION public.admin_list_categories()
 RETURNS TABLE(id uuid, branch_id uuid, branch_name text, name text, description text)
 LANGUAGE plpgsql
 STABLE SECURITY DEFINER
 SET search_path TO ''
AS $function$
begin
  perform public.assert_super_admin();
  return query
    select pc.id, pc.branch_id, b.name::text, pc.name::text, pc.description
    from public.product_categories pc
    join public.branches b on b.id = pc.branch_id
    order by b.name, pc.name;
end;
$function$
;

revoke all on function public.admin_list_categories() from public, anon;
grant execute on function public.admin_list_categories() to authenticated;

-- ----------------------------------------------------------------------------

CREATE OR REPLACE FUNCTION public.admin_list_deleted_branches()
 RETURNS TABLE(id uuid, branch_id uuid, pharmacy_name text, phone text, email text, branch_code text, location text, reason text, deleted_by_email text, deleted_at timestamp with time zone)
 LANGUAGE plpgsql
 STABLE SECURITY DEFINER
 SET search_path TO ''
AS $function$
begin
  perform public.assert_super_admin();
  return query
    select
      l.id, l.branch_id, l.pharmacy_name::text, l.phone::text, l.email::text,
      l.branch_code::text, l.location, l.reason, l.deleted_by_email::text, l.deleted_at
    from public.deleted_branches_log l
    order by l.deleted_at desc;
end;
$function$
;

revoke all on function public.admin_list_deleted_branches() from public, anon;
grant execute on function public.admin_list_deleted_branches() to authenticated;

-- ----------------------------------------------------------------------------

CREATE OR REPLACE FUNCTION public.admin_list_organization_applications()
 RETURNS TABLE(id uuid, application_code text, legal_name text, tin text, phone text, email text, location text, status text, called_at timestamp with time zone, denied_reason text, organization_id uuid, first_branch_id uuid, branch_code text, activation_code text, submitted_at timestamp with time zone)
 LANGUAGE plpgsql
 STABLE SECURITY DEFINER
 SET search_path TO ''
AS $function$
begin
  perform public.assert_super_admin();
  return query
    select
      a.id, a.application_code::text, a.legal_name::text, a.tin::text, a.phone::text,
      a.email::text, a.location::text, a.status::text, a.called_at, a.denied_reason,
      a.organization_id, a.first_branch_id, b.branch_code::text, b.activation_code::text,
      a.submitted_at
    from public.organization_applications a
    left join public.branches b on b.id = a.first_branch_id
    order by a.submitted_at desc;
end;
$function$
;

revoke all on function public.admin_list_organization_applications() from public, anon;
grant execute on function public.admin_list_organization_applications() to authenticated;

-- ----------------------------------------------------------------------------

CREATE OR REPLACE FUNCTION public.admin_list_organizations()
 RETURNS TABLE(id uuid, legal_name text, trade_name text, tin text, status text, branch_count integer, created_at timestamp with time zone)
 LANGUAGE plpgsql
 STABLE SECURITY DEFINER
 SET search_path TO ''
AS $function$
begin
  perform public.assert_super_admin();
  return query
    select
      o.id, o.legal_name::text, o.trade_name::text, o.tin::text, o.status::text,
      (select count(*)::integer from public.branches b where b.organization_id = o.id),
      o.created_at
    from public.pharmacy_organizations o
    order by o.created_at desc;
end;
$function$
;

revoke all on function public.admin_list_organizations() from public, anon;
grant execute on function public.admin_list_organizations() to authenticated;

-- ----------------------------------------------------------------------------

CREATE OR REPLACE FUNCTION public.admin_list_pharmacy_applications()
 RETURNS TABLE(id uuid, application_code text, pharmacy_name text, phone text, email text, location text, status text, called_at timestamp with time zone, denied_reason text, branch_id uuid, branch_code text, activation_code text, failed_logins integer, locked_at timestamp with time zone, submitted_at timestamp with time zone)
 LANGUAGE plpgsql
 STABLE SECURITY DEFINER
 SET search_path TO ''
AS $function$
  begin
    perform public.assert_super_admin();
    return query
      select
        a.id,
        a.application_code::text,
        a.pharmacy_name::text,
        a.phone::text,
        a.email::text,
        a.location::text,
        case
          when b.status = 'locked' then 'locked'
          else a.status
        end::text,
        a.called_at,
        a.denied_reason,
        a.branch_id,
        b.branch_code::text,
        b.activation_code::text,
        coalesce(b.failed_logins, 0),
        b.locked_at,
        a.submitted_at
      from public.branch_applications a
      left join public.branches b on b.id = a.branch_id
      order by a.submitted_at desc;
  end;
  $function$
;

revoke all on function public.admin_list_pharmacy_applications() from public, anon;
grant execute on function public.admin_list_pharmacy_applications() to authenticated;

-- ----------------------------------------------------------------------------

CREATE OR REPLACE FUNCTION public.admin_list_product_requests()
 RETURNS TABLE(id uuid, branch_id uuid, branch_name text, requested_by_name text, message text, image_path text, status text, resolved_product_id uuid, resolved_variant_id uuid, rejection_reason text, created_at timestamp with time zone)
 LANGUAGE plpgsql
 STABLE SECURITY DEFINER
 SET search_path TO ''
AS $function$
begin
  perform public.assert_super_admin();
  return query
    select
      r.id, r.branch_id, b.name::text, u.full_name::text,
      r.message, r.image_path, r.status::text,
      r.resolved_product_id, r.resolved_variant_id,
      r.rejection_reason, r.created_at
    from public.product_requests r
    join public.branches b on b.id = r.branch_id
    join public.users u on u.id = r.requested_by
    order by (r.status = 'pending') desc, r.created_at desc;
end;
$function$
;

revoke all on function public.admin_list_product_requests() from public, anon;
grant execute on function public.admin_list_product_requests() to authenticated;

-- ----------------------------------------------------------------------------

CREATE OR REPLACE FUNCTION public.admin_list_products()
 RETURNS TABLE(product_id uuid, product_name text, generic_name text, product_type text, tax_rate_id uuid, tax_rate_name text, tax_rate_percentage numeric, variant_id uuid, dosage text, form text, unit text)
 LANGUAGE plpgsql
 STABLE SECURITY DEFINER
 SET search_path TO ''
AS $function$
begin
  perform public.assert_super_admin();
  return query
    select
      p.id, p.name::text, p.generic_name::text, p.product_type::text,
      t.id, t.name::text, t.rate_percentage,
      pv.id, pv.dosage::text, pv.form::text, pv.unit::text
    from public.products p
    join public.tax_rates t on t.id = p.tax_rate_id
    left join public.product_variants pv on pv.product_id = p.id
    order by p.name, pv.dosage nulls first;
end;
$function$
;

revoke all on function public.admin_list_products() from public, anon;
grant execute on function public.admin_list_products() to authenticated;

-- ----------------------------------------------------------------------------

CREATE OR REPLACE FUNCTION public.admin_list_support_tickets()
 RETURNS TABLE(id uuid, branch_id uuid, branch_name text, raised_by_name text, subject text, description text, status text, priority text, created_at timestamp with time zone)
 LANGUAGE plpgsql
 STABLE SECURITY DEFINER
 SET search_path TO ''
AS $function$
begin
  perform public.assert_super_admin();
  return query
    select t.id, t.branch_id, b.name::text, u.full_name::text, t.subject::text, t.description, t.status::text, t.priority::text, t.created_at
    from public.support_tickets t
    join public.branches b on b.id = t.branch_id
    join public.users u on u.id = t.raised_by
    order by (t.status = 'open') desc, t.created_at desc;
end;
$function$
;

revoke all on function public.admin_list_support_tickets() from public, anon;
grant execute on function public.admin_list_support_tickets() to authenticated;

-- ----------------------------------------------------------------------------

CREATE OR REPLACE FUNCTION public.admin_mark_organization_called(p_application_id uuid)
 RETURNS void
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''
AS $function$
begin
  perform public.assert_super_admin();
  update public.organization_applications
  set called_at = now()
  where id = p_application_id and status = 'pending';
  if not found then
    raise exception 'Call can only be recorded on a pending application';
  end if;
end;
$function$
;

revoke all on function public.admin_mark_organization_called(p_application_id uuid) from public, anon;
grant execute on function public.admin_mark_organization_called(p_application_id uuid) to authenticated;

-- ----------------------------------------------------------------------------

CREATE OR REPLACE FUNCTION public.admin_mark_pharmacy_called(p_application_id uuid)
 RETURNS void
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''
AS $function$
  begin
    perform public.assert_super_admin();
    update public.branch_applications
    set called_at = now()
    where id = p_application_id and status = 'pending';
    if not found then
      raise exception 'Call can only be recorded on a pending application';
    end if;
  end;
  $function$
;

revoke all on function public.admin_mark_pharmacy_called(p_application_id uuid) from public, anon;
grant execute on function public.admin_mark_pharmacy_called(p_application_id uuid) to authenticated;

-- ----------------------------------------------------------------------------

CREATE OR REPLACE FUNCTION public.admin_patients_time_series(p_interval text DEFAULT 'day'::text, p_periods integer DEFAULT 30)
 RETURNS TABLE(period_start date, patient_count integer)
 LANGUAGE plpgsql
 STABLE SECURITY DEFINER
 SET search_path TO ''
AS $function$
declare
  v_step interval;
begin
  perform public.assert_super_admin();
  if p_interval not in ('day', 'week', 'month') then
    raise exception 'p_interval must be day, week, or month';
  end if;
  if p_periods < 1 or p_periods > 366 then
    raise exception 'p_periods must be between 1 and 366';
  end if;
  v_step := ('1 ' || p_interval)::interval;

  return query
    with buckets as (
      select date_trunc(p_interval, now()) - (v_step * n) as bucket_start
      from generate_series(0, p_periods - 1) as n
    )
    select
      b.bucket_start::date,
      (
        select count(*)::integer from public.patients p
        where p.created_at >= b.bucket_start and p.created_at < b.bucket_start + v_step
      )
    from buckets b
    order by b.bucket_start;
end;
$function$
;

revoke all on function public.admin_patients_time_series(p_interval text, p_periods integer) from public, anon;
grant execute on function public.admin_patients_time_series(p_interval text, p_periods integer) to authenticated;

-- ----------------------------------------------------------------------------

CREATE OR REPLACE FUNCTION public.admin_platform_stats()
 RETURNS TABLE(total_organizations integer, total_branches integer, active_branches integer, total_members integer, active_members integer, total_patients integer)
 LANGUAGE plpgsql
 STABLE SECURITY DEFINER
 SET search_path TO ''
AS $function$
begin
  perform public.assert_super_admin();
  return query
    select
      (select count(*)::integer from public.pharmacy_organizations),
      (select count(*)::integer from public.branches),
      (select count(*)::integer from public.branches where status = 'active'),
      (select count(*)::integer from public.users),
      (select count(*)::integer from public.users where is_active),
      (select count(*)::integer from public.patients);
end;
$function$
;

revoke all on function public.admin_platform_stats() from public, anon;
grant execute on function public.admin_platform_stats() to authenticated;

-- ----------------------------------------------------------------------------

CREATE OR REPLACE FUNCTION public.admin_reject_product_request(p_request_id uuid, p_reason text)
 RETURNS void
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''
AS $function$
declare
  v_req public.product_requests%rowtype;
begin
  perform public.assert_super_admin();
  select * into v_req from public.product_requests where id = p_request_id;
  if v_req.id is null then raise exception 'Product request not found'; end if;
  if v_req.status <> 'pending' then raise exception 'Only a pending request can be rejected'; end if;

  update public.product_requests
  set status = 'rejected', rejection_reason = nullif(btrim(coalesce(p_reason, '')), ''),
      resolved_by = (select auth.uid()), resolved_at = now()
  where id = p_request_id;

  insert into public.notifications (branch_id, source_type, source_id, message)
  values (v_req.branch_id, 'product_request_rejected', p_request_id,
    format('Your product request was declined.%s',
      case when nullif(btrim(coalesce(p_reason, '')), '') is not null then ' Reason: ' || btrim(p_reason) else '' end));
end;
$function$
;

revoke all on function public.admin_reject_product_request(p_request_id uuid, p_reason text) from public, anon;
grant execute on function public.admin_reject_product_request(p_request_id uuid, p_reason text) to authenticated;

-- ----------------------------------------------------------------------------

CREATE OR REPLACE FUNCTION public.admin_set_branch_lock(p_branch_id uuid, p_locked boolean)
 RETURNS void
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''
AS $function$
  begin
    perform public.assert_super_admin();
    if p_locked then
      update public.branches
      set status = 'locked', locked_at = now()
      where id = p_branch_id;
      update public.users set is_active = false where branch_id = p_branch_id;
    else
      update public.branches
      set status = 'active', locked_at = null, failed_logins = 0
      where id = p_branch_id;
      update public.users set is_active = true where branch_id = p_branch_id;
    end if;
  end;
  $function$
;

revoke all on function public.admin_set_branch_lock(p_branch_id uuid, p_locked boolean) from public, anon;
grant execute on function public.admin_set_branch_lock(p_branch_id uuid, p_locked boolean) to authenticated;

-- ----------------------------------------------------------------------------

CREATE OR REPLACE FUNCTION public.admin_set_insurance_coverage(p_provider_id uuid, p_product_id uuid, p_coverage_percentage numeric)
 RETURNS void
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''
AS $function$
begin
  perform public.assert_super_admin();
  if p_coverage_percentage is null or p_coverage_percentage < 0 or p_coverage_percentage > 100 then
    raise exception 'Coverage percentage must be between 0 and 100';
  end if;
  insert into public.insurance_product_coverage (insurance_provider_id, product_id, coverage_percentage)
  values (p_provider_id, p_product_id, p_coverage_percentage)
  on conflict (insurance_provider_id, product_id) do update set coverage_percentage = excluded.coverage_percentage;
end;
$function$
;

revoke all on function public.admin_set_insurance_coverage(p_provider_id uuid, p_product_id uuid, p_coverage_percentage numeric) from public, anon;
grant execute on function public.admin_set_insurance_coverage(p_provider_id uuid, p_product_id uuid, p_coverage_percentage numeric) to authenticated;

-- ----------------------------------------------------------------------------

CREATE OR REPLACE FUNCTION public.admin_set_insurance_variant_price(p_provider_id uuid, p_product_variant_id uuid, p_fixed_price numeric)
 RETURNS void
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''
AS $function$
begin
  perform public.assert_super_admin();
  if p_fixed_price is null or p_fixed_price < 0 then
    raise exception 'Fixed price must be zero or greater';
  end if;
  insert into public.insurance_variant_prices (insurance_provider_id, product_variant_id, fixed_price)
  values (p_provider_id, p_product_variant_id, p_fixed_price)
  on conflict (insurance_provider_id, product_variant_id) do update set fixed_price = excluded.fixed_price;
end;
$function$
;

revoke all on function public.admin_set_insurance_variant_price(p_provider_id uuid, p_product_variant_id uuid, p_fixed_price numeric) from public, anon;
grant execute on function public.admin_set_insurance_variant_price(p_provider_id uuid, p_product_variant_id uuid, p_fixed_price numeric) to authenticated;

-- ----------------------------------------------------------------------------

CREATE OR REPLACE FUNCTION public.admin_set_organization_status(p_organization_id uuid, p_status text)
 RETURNS void
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''
AS $function$
begin
  perform public.assert_super_admin();
  if p_status not in ('active', 'suspended') then
    raise exception 'status must be active or suspended';
  end if;
  if not exists (select 1 from public.pharmacy_organizations where id = p_organization_id) then
    raise exception 'Unknown organization';
  end if;
  update public.pharmacy_organizations set status = p_status where id = p_organization_id;
end;
$function$
;

revoke all on function public.admin_set_organization_status(p_organization_id uuid, p_status text) from public, anon;
grant execute on function public.admin_set_organization_status(p_organization_id uuid, p_status text) to authenticated;

-- ----------------------------------------------------------------------------

CREATE OR REPLACE FUNCTION public.admin_set_product_tax(p_product_id uuid, p_tax_rate_id uuid)
 RETURNS void
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''
AS $function$
begin
  perform public.assert_super_admin();
  if not exists (select 1 from public.tax_rates t where t.id = p_tax_rate_id) then
    raise exception 'Unknown tax rate';
  end if;
  update public.products set tax_rate_id = p_tax_rate_id where id = p_product_id;
  if not found then raise exception 'Product not found'; end if;
end;
$function$
;

revoke all on function public.admin_set_product_tax(p_product_id uuid, p_tax_rate_id uuid) from public, anon;
grant execute on function public.admin_set_product_tax(p_product_id uuid, p_tax_rate_id uuid) to authenticated;

-- ----------------------------------------------------------------------------

CREATE OR REPLACE FUNCTION public.admin_set_seller_active(p_user_id uuid, p_is_active boolean)
 RETURNS void
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''
AS $function$
declare
  v_caller uuid := (select auth.uid());
  v_branch uuid;
  v_caller_role text;
  v_target_role text;
  v_target_removed boolean;
begin
  select u.branch_id, u.role into v_branch, v_caller_role
  from public.users u
  where u.id = v_caller and u.is_active and u.role in ('owner', 'manager');
  if v_branch is null then raise exception 'Only an active branch manager or owner may manage staff'; end if;

  select role, is_removed into v_target_role, v_target_removed from public.users where id = p_user_id and branch_id = v_branch;
  if v_target_role is null or v_target_role not in ('manager', 'seller') then
    raise exception 'Staff member not found for this branch';
  end if;
  if v_target_role = 'manager' and v_caller_role <> 'owner' then
    raise exception 'Only the branch owner may deactivate a manager';
  end if;
  if p_is_active and v_target_removed then
    raise exception 'This account has been permanently removed and cannot be reactivated';
  end if;

  update public.users
  set is_active = p_is_active
  where id = p_user_id and branch_id = v_branch and role in ('manager', 'seller');
end;
$function$
;

revoke all on function public.admin_set_seller_active(p_user_id uuid, p_is_active boolean) from public, anon;
grant execute on function public.admin_set_seller_active(p_user_id uuid, p_is_active boolean) to authenticated;

-- ----------------------------------------------------------------------------

CREATE OR REPLACE FUNCTION public.admin_set_seller_active(p_user_id uuid, p_is_active boolean, p_branch_id uuid DEFAULT NULL::uuid)
 RETURNS void
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''
AS $function$
declare
  v_caller uuid := (select auth.uid());
  v_own_branch uuid;
  v_own_role text;
  v_branch uuid;
  v_caller_role text;
  v_target_role text;
  v_target_removed boolean;
begin
  select u.branch_id, u.role into v_own_branch, v_own_role
  from public.users u
  where u.id = v_caller and u.is_active and u.role in ('owner', 'manager');
  if v_own_branch is null then raise exception 'Only an active branch manager or owner may manage staff'; end if;

  v_branch := public.effective_branch_id(p_branch_id);
  if v_branch is null then raise exception 'No active branch for this session'; end if;
  perform public.assert_can_manage_org_branch_or_own(v_branch, v_own_branch);
  v_caller_role := case when v_branch = v_own_branch then v_own_role else 'owner' end;

  if exists (select 1 from public.organization_members m where m.user_id = p_user_id and m.role = 'org_manager') then
    raise exception 'This person is the organization manager -- manage their access from Organization members, not this branch''s staff list';
  end if;

  select role, is_removed into v_target_role, v_target_removed from public.users where id = p_user_id and branch_id = v_branch;
  if v_target_role is null or v_target_role not in ('manager', 'seller') then
    raise exception 'Staff member not found for this branch';
  end if;
  if v_target_role = 'manager' and v_caller_role <> 'owner' then
    raise exception 'Only the branch owner may deactivate a manager';
  end if;
  if p_is_active and v_target_removed then
    raise exception 'This account has been permanently removed and cannot be reactivated';
  end if;

  update public.users
  set is_active = p_is_active
  where id = p_user_id and branch_id = v_branch and role in ('manager', 'seller');
end;
$function$
;

revoke all on function public.admin_set_seller_active(p_user_id uuid, p_is_active boolean, p_branch_id uuid) from public, anon;
grant execute on function public.admin_set_seller_active(p_user_id uuid, p_is_active boolean, p_branch_id uuid) to authenticated;

-- ----------------------------------------------------------------------------

CREATE OR REPLACE FUNCTION public.admin_update_branch_details(p_branch_id uuid, p_name text DEFAULT NULL::text, p_phone text DEFAULT NULL::text, p_email text DEFAULT NULL::text, p_address text DEFAULT NULL::text, p_tin text DEFAULT NULL::text, p_website text DEFAULT NULL::text, p_license_number text DEFAULT NULL::text, p_license_expiry_date date DEFAULT NULL::date)
 RETURNS void
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''
AS $function$
begin
  perform public.assert_super_admin();

  if not exists (select 1 from public.branches where id = p_branch_id) then
    raise exception 'Branch not found';
  end if;

  update public.branches
  set
    -- name is not nullable, so a blank leaves it alone rather than nulling it.
    name = coalesce(nullif(btrim(coalesce(p_name, '')), ''), name),
    phone = coalesce(nullif(btrim(coalesce(p_phone, '')), ''), phone),
    email = coalesce(nullif(btrim(coalesce(p_email, '')), ''), email),
    address = coalesce(nullif(btrim(coalesce(p_address, '')), ''), address),
    tin = coalesce(nullif(btrim(coalesce(p_tin, '')), ''), tin),
    website = coalesce(nullif(btrim(coalesce(p_website, '')), ''), website),
    license_number = coalesce(nullif(btrim(coalesce(p_license_number, '')), ''), license_number),
    license_expiry_date = coalesce(p_license_expiry_date, license_expiry_date)
  where id = p_branch_id;

  -- The sign-in directory shows the branch name, so it has to follow a rename.
  update public.branch_directory
  set display_name = (select b.name from public.branches b where b.id = p_branch_id)
  where branch_id = p_branch_id;
end;
$function$
;

revoke all on function public.admin_update_branch_details(p_branch_id uuid, p_name text, p_phone text, p_email text, p_address text, p_tin text, p_website text, p_license_number text, p_license_expiry_date date) from public, anon;
grant execute on function public.admin_update_branch_details(p_branch_id uuid, p_name text, p_phone text, p_email text, p_address text, p_tin text, p_website text, p_license_number text, p_license_expiry_date date) to authenticated;

-- ----------------------------------------------------------------------------

CREATE OR REPLACE FUNCTION public.admin_update_insurance_provider(p_provider_id uuid, p_name text, p_default_coverage_percentage numeric, p_contact_info text DEFAULT NULL::text, p_tin text DEFAULT NULL::text)
 RETURNS void
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''
AS $function$
begin
  perform public.assert_super_admin();
  if p_default_coverage_percentage is null or p_default_coverage_percentage < 0 or p_default_coverage_percentage > 100 then
    raise exception 'Default coverage percentage must be between 0 and 100';
  end if;
  update public.insurance_providers
  set name = btrim(p_name),
      default_coverage_percentage = p_default_coverage_percentage,
      contact_info = nullif(btrim(coalesce(p_contact_info, '')), ''),
      tin = nullif(btrim(coalesce(p_tin, '')), '')
  where id = p_provider_id;
  if not found then raise exception 'Insurance provider not found'; end if;
end;
$function$
;

revoke all on function public.admin_update_insurance_provider(p_provider_id uuid, p_name text, p_default_coverage_percentage numeric, p_contact_info text, p_tin text) from public, anon;
grant execute on function public.admin_update_insurance_provider(p_provider_id uuid, p_name text, p_default_coverage_percentage numeric, p_contact_info text, p_tin text) to authenticated;

-- ----------------------------------------------------------------------------

CREATE OR REPLACE FUNCTION public.admin_update_organization_details(p_organization_id uuid, p_legal_name text, p_trade_name text, p_tin text)
 RETURNS void
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''
AS $function$
begin
  perform public.assert_super_admin();
  if p_legal_name is null or trim(p_legal_name) = '' then
    raise exception 'Legal name is required';
  end if;
  if not exists (select 1 from public.pharmacy_organizations where id = p_organization_id) then
    raise exception 'Unknown organization';
  end if;
  update public.pharmacy_organizations
  set legal_name = trim(p_legal_name),
      trade_name = nullif(trim(coalesce(p_trade_name, '')), ''),
      tin = nullif(trim(coalesce(p_tin, '')), '')
  where id = p_organization_id;
end;
$function$
;

revoke all on function public.admin_update_organization_details(p_organization_id uuid, p_legal_name text, p_trade_name text, p_tin text) from public, anon;
grant execute on function public.admin_update_organization_details(p_organization_id uuid, p_legal_name text, p_trade_name text, p_tin text) to authenticated;

-- ----------------------------------------------------------------------------

CREATE OR REPLACE FUNCTION public.admin_update_staff_role(p_user_id uuid, p_role text, p_branch_id uuid DEFAULT NULL::uuid)
 RETURNS void
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''
AS $function$
declare
  v_caller uuid := (select auth.uid());
  v_own_branch uuid;
  v_own_role text;
  v_branch uuid;
  v_caller_role text;
begin
  if p_role not in ('manager', 'seller') then
    raise exception 'role must be manager or seller';
  end if;

  select u.branch_id, u.role into v_own_branch, v_own_role
  from public.users u
  where u.id = v_caller and u.is_active and u.role in ('owner', 'manager');
  if v_own_branch is null then raise exception 'Only the branch owner may change a staff member''s role'; end if;

  v_branch := public.effective_branch_id(p_branch_id);
  if v_branch is null then raise exception 'No active branch for this session'; end if;
  perform public.assert_can_manage_org_branch_or_own(v_branch, v_own_branch);
  v_caller_role := case when v_branch = v_own_branch then v_own_role else 'owner' end;

  if v_caller_role <> 'owner' then
    raise exception 'Only the branch owner may change a staff member''s role';
  end if;

  if exists (select 1 from public.organization_members m where m.user_id = p_user_id and m.role = 'org_manager') then
    raise exception 'This person is the organization manager -- manage their access from Organization members, not this branch''s staff list';
  end if;

  if p_role = 'manager' and exists (
    select 1 from public.users u
    where u.branch_id = v_branch and u.role = 'manager' and u.id <> p_user_id
      and not exists (select 1 from public.organization_members om where om.user_id = u.id and om.role = 'org_manager')
  ) then
    raise exception 'This branch already has a manager -- change their role first, or assign this person as seller instead';
  end if;

  update public.users
  set role = p_role
  where id = p_user_id and branch_id = v_branch and role in ('manager', 'seller');
  if not found then raise exception 'Staff member not found for this branch'; end if;
end;
$function$
;

revoke all on function public.admin_update_staff_role(p_user_id uuid, p_role text, p_branch_id uuid) from public, anon;
grant execute on function public.admin_update_staff_role(p_user_id uuid, p_role text, p_branch_id uuid) to authenticated;

-- ----------------------------------------------------------------------------

CREATE OR REPLACE FUNCTION public.admin_update_ticket_status(p_ticket_id uuid, p_status text)
 RETURNS void
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''
AS $function$
begin
  perform public.assert_super_admin();
  if p_status not in ('open','in_progress','resolved','closed') then raise exception 'Unknown status'; end if;
  update public.support_tickets set status = p_status where id = p_ticket_id;
  if not found then raise exception 'Ticket not found'; end if;
end;
$function$
;

revoke all on function public.admin_update_ticket_status(p_ticket_id uuid, p_status text) from public, anon;
grant execute on function public.admin_update_ticket_status(p_ticket_id uuid, p_status text) to authenticated;

-- ----------------------------------------------------------------------------

CREATE OR REPLACE FUNCTION public.ai_branch_snapshot(p_branch_id uuid DEFAULT NULL::uuid)
 RETURNS TABLE(branch_name text, today_revenue numeric, week_to_date_revenue numeric, month_to_date_revenue numeric, active_product_count integer, out_of_stock_count integer, low_stock_count integer, expiring_soon_count integer, pending_product_requests integer, unread_alerts integer)
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''
AS $function$
declare
  v_branch uuid := public.effective_branch_id(p_branch_id);
begin
  perform public.assert_owner_or_manager();
  if v_branch is null then raise exception 'No active branch for this session'; end if;

  return query
  select
    b.name::text,
    coalesce((select round(sum(si.unit_price * si.quantity), 2) from public.sale_items si join public.sales s on s.id = si.sale_id where s.branch_id = v_branch and s.sold_at >= date_trunc('day', now())), 0),
    coalesce((select round(sum(si.unit_price * si.quantity), 2) from public.sale_items si join public.sales s on s.id = si.sale_id where s.branch_id = v_branch and s.sold_at >= date_trunc('week', now())), 0),
    coalesce((select round(sum(si.unit_price * si.quantity), 2) from public.sale_items si join public.sales s on s.id = si.sale_id where s.branch_id = v_branch and s.sold_at >= date_trunc('month', now())), 0),
    (select count(distinct pv.product_id) from public.stock_batches sb join public.product_variants pv on pv.id = sb.product_variant_id where sb.branch_id = v_branch)::integer,
    (select count(*) from public.ai_stock_status('out', p_branch_id))::integer,
    (select count(*) from public.ai_stock_status('low', p_branch_id))::integer,
    (select count(*) from public.ai_stock_status('expiring', p_branch_id))::integer,
    (select count(*) from public.product_requests pr where pr.branch_id = v_branch and pr.status = 'pending')::integer,
    (select count(*) from public.notifications n where n.branch_id = v_branch and not n.is_read)::integer
  from public.branches b where b.id = v_branch;
end;
$function$
;

revoke all on function public.ai_branch_snapshot(p_branch_id uuid) from public, anon;
grant execute on function public.ai_branch_snapshot(p_branch_id uuid) to authenticated;

-- ----------------------------------------------------------------------------

CREATE OR REPLACE FUNCTION public.ai_category_breakdown(p_from date, p_to date, p_branch_id uuid DEFAULT NULL::uuid)
 RETURNS TABLE(category_name text, revenue numeric, quantity_sold numeric)
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''
AS $function$
declare
  v_branch uuid := public.effective_branch_id(p_branch_id);
begin
  perform public.assert_owner_or_manager();
  if v_branch is null then raise exception 'No active branch for this session'; end if;

  return query
  select
    coalesce(c.name::text, 'Uncategorized'), round(sum(si.unit_price * si.quantity), 2), sum(si.quantity)::numeric
  from public.sale_items si
  join public.sales s on s.id = si.sale_id
  join public.barcodes bc on bc.id = si.barcode_id
  join public.stock_batches sb on sb.id = bc.stock_batch_id
  join public.product_variants pv on pv.id = sb.product_variant_id
  left join public.branch_product_categorization cat on cat.product_id = pv.product_id and cat.branch_id = v_branch
  left join public.product_categories c on c.id = cat.category_id
  where s.branch_id = v_branch and s.sold_at >= p_from::timestamptz and s.sold_at < (p_to + 1)::timestamptz
  group by c.name
  order by 2 desc;
end;
$function$
;

revoke all on function public.ai_category_breakdown(p_from date, p_to date, p_branch_id uuid) from public, anon;
grant execute on function public.ai_category_breakdown(p_from date, p_to date, p_branch_id uuid) to authenticated;

-- ----------------------------------------------------------------------------

CREATE OR REPLACE FUNCTION public.ai_insurance_summary(p_from date, p_to date, p_branch_id uuid DEFAULT NULL::uuid)
 RETURNS TABLE(provider_name text, claim_count integer, total_claimed numeric, paid_out numeric, pending numeric)
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''
AS $function$
declare
  v_branch uuid := public.effective_branch_id(p_branch_id);
begin
  perform public.assert_owner_or_manager();
  if v_branch is null then raise exception 'No active branch for this session'; end if;

  return query
  select
    ip.name::text,
    count(*)::integer,
    round(sum(ic.claim_amount), 2),
    round(coalesce(sum(ic.claim_amount) filter (where ic.status = 'paid'), 0), 2),
    round(coalesce(sum(ic.claim_amount) filter (where ic.status in ('submitted','approved')), 0), 2)
  from public.insurance_claims ic
  join public.sales s on s.id = ic.sale_id
  join public.insurance_providers ip on ip.id = ic.insurance_provider_id
  where s.branch_id = v_branch and ic.submitted_at >= p_from::timestamptz and ic.submitted_at < (p_to + 1)::timestamptz
  group by ip.name
  order by 3 desc;
end;
$function$
;

revoke all on function public.ai_insurance_summary(p_from date, p_to date, p_branch_id uuid) from public, anon;
grant execute on function public.ai_insurance_summary(p_from date, p_to date, p_branch_id uuid) to authenticated;

-- ----------------------------------------------------------------------------

CREATE OR REPLACE FUNCTION public.ai_patient_summary(p_from date, p_to date, p_branch_id uuid DEFAULT NULL::uuid)
 RETURNS TABLE(total_patients_served integer, new_patients integer, repeat_patients integer, top_patient_name text, top_patient_spend numeric)
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''
AS $function$
declare
  v_branch uuid := public.effective_branch_id(p_branch_id);
begin
  perform public.assert_owner_or_manager();
  if v_branch is null then raise exception 'No active branch for this session'; end if;

  return query
  with visits as (
    select s.patient_id, count(*) as visit_count, sum(si.unit_price * si.quantity) as spend
    from public.sales s
    join public.sale_items si on si.sale_id = s.id
    where s.branch_id = v_branch and s.patient_id is not null
      and s.sold_at >= p_from::timestamptz and s.sold_at < (p_to + 1)::timestamptz
    group by s.patient_id
  ),
  top as (
    select pt.full_name::text as full_name, v.spend from visits v
    join public.patients pt on pt.id = v.patient_id
    order by v.spend desc limit 1
  )
  select
    (select count(*) from visits)::integer,
    (select count(*) from public.patients pt where pt.branch_id = v_branch and pt.created_at >= p_from::timestamptz and pt.created_at < (p_to + 1)::timestamptz)::integer,
    (select count(*) from visits where visit_count > 1)::integer,
    (select top.full_name from top),
    (select round(top.spend, 2) from top);
end;
$function$
;

revoke all on function public.ai_patient_summary(p_from date, p_to date, p_branch_id uuid) from public, anon;
grant execute on function public.ai_patient_summary(p_from date, p_to date, p_branch_id uuid) to authenticated;

-- ----------------------------------------------------------------------------

CREATE OR REPLACE FUNCTION public.ai_restock_recommendations(p_days_history integer DEFAULT 30, p_horizon_days integer DEFAULT 14, p_limit integer DEFAULT 10, p_branch_id uuid DEFAULT NULL::uuid)
 RETURNS TABLE(product_id uuid, product_name text, dosage text, avg_daily_quantity numeric, quantity_available integer, days_to_stockout numeric)
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''
AS $function$
declare
  v_branch uuid := public.effective_branch_id(p_branch_id);
begin
  perform public.assert_owner_or_manager();
  if v_branch is null then raise exception 'No active branch for this session'; end if;
  if p_days_history < 7 or p_days_history > 365 then raise exception 'days_history must be between 7 and 365'; end if;
  if p_horizon_days < 1 or p_horizon_days > 90 then raise exception 'horizon_days must be between 1 and 90'; end if;
  if p_limit < 1 or p_limit > 50 then raise exception 'limit must be between 1 and 50'; end if;

  return query
  with recent_sales as (
    select
      pv.product_id as product_id,
      pv.id as variant_id,
      sum(si.quantity)::numeric / p_days_history as avg_daily_qty,
      sum(si.quantity) as total_qty,
      count(distinct date_trunc('day', s.sold_at)) as active_days
    from public.sale_items si
    join public.sales s on s.id = si.sale_id
    join public.barcodes bc on bc.id = si.barcode_id
    join public.stock_batches sb on sb.id = bc.stock_batch_id
    join public.product_variants pv on pv.id = sb.product_variant_id
    where s.branch_id = v_branch and s.sold_at >= now() - (p_days_history || ' days')::interval
    group by pv.product_id, pv.id
    having count(distinct date_trunc('day', s.sold_at)) >= 3
  ),
  stock as (
    select
      pv.id as variant_id, p.id as product_id, p.name as product_name, pv.dosage,
      coalesce(sum(bc.quantity_available * bc.pieces_per_pack) filter (where bc.barcode_type = 'pack'), 0)::integer as qty_available
    from public.stock_batches sb
    join public.product_variants pv on pv.id = sb.product_variant_id
    join public.products p on p.id = pv.product_id
    left join public.barcodes bc on bc.stock_batch_id = sb.id
    where sb.branch_id = v_branch
    group by pv.id, p.id, p.name, pv.dosage
  )
  select
    st.product_id, st.product_name::text, st.dosage::text,
    round(rs.avg_daily_qty, 2), st.qty_available, round(st.qty_available / rs.avg_daily_qty, 1)
  from recent_sales rs
  join stock st on st.variant_id = rs.variant_id
  where rs.avg_daily_qty > 0 and st.qty_available > 0
    and st.qty_available / rs.avg_daily_qty <= p_horizon_days
  order by rs.total_qty desc, (st.qty_available / rs.avg_daily_qty) asc
  limit p_limit;
end;
$function$
;

revoke all on function public.ai_restock_recommendations(p_days_history integer, p_horizon_days integer, p_limit integer, p_branch_id uuid) from public, anon;
grant execute on function public.ai_restock_recommendations(p_days_history integer, p_horizon_days integer, p_limit integer, p_branch_id uuid) to authenticated;

-- ----------------------------------------------------------------------------

CREATE OR REPLACE FUNCTION public.ai_sales_forecast(p_product_id uuid DEFAULT NULL::uuid, p_category_id uuid DEFAULT NULL::uuid, p_days_history integer DEFAULT 90, p_horizon_days integer DEFAULT 30, p_branch_id uuid DEFAULT NULL::uuid)
 RETURNS TABLE(scope text, days_of_history integer, avg_daily_quantity numeric, trend_per_day numeric, projected_quantity_next_period numeric, projected_revenue_next_period numeric)
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''
AS $function$
declare
  v_branch uuid := public.effective_branch_id(p_branch_id);
  v_scope text;
begin
  perform public.assert_owner_or_manager();
  if v_branch is null then raise exception 'No active branch for this session'; end if;
  if p_product_id is not null and p_category_id is not null then
    raise exception 'Pass product_id or category_id, not both';
  end if;
  if p_days_history < 7 or p_days_history > 730 then raise exception 'days_history must be between 7 and 730'; end if;
  if p_horizon_days < 1 or p_horizon_days > 365 then raise exception 'horizon_days must be between 1 and 365'; end if;

  if p_product_id is not null then
    select p.name into v_scope from public.products p where p.id = p_product_id;
    if v_scope is null then raise exception 'Unknown product'; end if;
  elsif p_category_id is not null then
    select c.name into v_scope from public.product_categories c where c.id = p_category_id and c.branch_id = v_branch;
    if v_scope is null then raise exception 'Unknown category for this branch'; end if;
  else
    v_scope := 'All products';
  end if;

  return query
  with daily as (
    select
      date_trunc('day', s.sold_at)::date as sale_day,
      sum(si.quantity) as qty,
      sum(si.unit_price * si.quantity) as revenue
    from public.sale_items si
    join public.sales s on s.id = si.sale_id
    join public.barcodes bc on bc.id = si.barcode_id
    join public.stock_batches sb on sb.id = bc.stock_batch_id
    join public.product_variants pv on pv.id = sb.product_variant_id
    left join public.branch_product_categorization cat on cat.product_id = pv.product_id and cat.branch_id = v_branch
    where s.branch_id = v_branch
      and s.sold_at >= now() - (p_days_history || ' days')::interval
      and (p_product_id is null or pv.product_id = p_product_id)
      and (p_category_id is null or cat.category_id = p_category_id)
    group by 1
  ),
  numbered as (
    select
      (sale_day - (select min(sale_day) from daily))::numeric as x,
      qty::numeric as y,
      revenue
    from daily
  ),
  stats as (
    select
      coalesce(avg(y), 0) as avg_qty,
      coalesce(regr_slope(y, x), 0)::numeric as slope,
      coalesce(regr_intercept(y, x), avg(y), 0)::numeric as intercept,
      coalesce(sum(revenue) / nullif(sum(y), 0), 0) as avg_unit_revenue,
      coalesce(max(x), 0) as max_x
    from numbered
  )
  select
    v_scope,
    p_days_history,
    round(stats.avg_qty, 2),
    round(stats.slope, 4),
    round(sum_projected.total_qty, 2),
    round(sum_projected.total_qty * stats.avg_unit_revenue, 2)
  from stats
  cross join lateral (
    select coalesce(sum(greatest(0, stats.intercept + stats.slope * (stats.max_x + d))), 0) as total_qty
    from generate_series(1, p_horizon_days) as d
  ) sum_projected;
end;
$function$
;

revoke all on function public.ai_sales_forecast(p_product_id uuid, p_category_id uuid, p_days_history integer, p_horizon_days integer, p_branch_id uuid) from public, anon;
grant execute on function public.ai_sales_forecast(p_product_id uuid, p_category_id uuid, p_days_history integer, p_horizon_days integer, p_branch_id uuid) to authenticated;

-- ----------------------------------------------------------------------------

CREATE OR REPLACE FUNCTION public.ai_sales_forecast_accuracy(p_product_id uuid DEFAULT NULL::uuid, p_category_id uuid DEFAULT NULL::uuid, p_from date DEFAULT NULL::date, p_to date DEFAULT NULL::date, p_branch_id uuid DEFAULT NULL::uuid)
 RETURNS TABLE(period_start date, predicted_revenue numeric, predicted_quantity numeric, predicted_at timestamp with time zone)
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''
AS $function$
#variable_conflict use_column
declare
  v_branch uuid := public.effective_branch_id(p_branch_id);
begin
  perform public.assert_owner_or_manager();
  if v_branch is null then raise exception 'No active branch for this session'; end if;
  if p_product_id is not null and p_category_id is not null then
    raise exception 'Pass product_id or category_id, not both';
  end if;

  return query
  with expanded as (
    select
      s.generated_at,
      (pt->>'period_start')::date as period_start,
      (pt->>'predicted_revenue')::numeric as predicted_revenue,
      (pt->>'predicted_quantity')::numeric as predicted_quantity
    from public.sales_forecast_snapshots s
    cross join lateral jsonb_array_elements(s.points) as pt
    where s.branch_id = v_branch
      and ((p_product_id is null and s.product_id is null) or s.product_id = p_product_id)
      and ((p_category_id is null and s.category_id is null) or s.category_id = p_category_id)
      and (p_from is null or (pt->>'period_start')::date >= p_from)
      and (p_to is null or (pt->>'period_start')::date <= p_to)
  ),
  ranked as (
    select *, row_number() over (partition by period_start order by generated_at desc) as rn
    from expanded
    where generated_at::date < period_start
  )
  select period_start, predicted_revenue, predicted_quantity, generated_at as predicted_at
  from ranked
  where rn = 1
  order by period_start;
end;
$function$
;

revoke all on function public.ai_sales_forecast_accuracy(p_product_id uuid, p_category_id uuid, p_from date, p_to date, p_branch_id uuid) from public, anon;
grant execute on function public.ai_sales_forecast_accuracy(p_product_id uuid, p_category_id uuid, p_from date, p_to date, p_branch_id uuid) to authenticated;

-- ----------------------------------------------------------------------------

CREATE OR REPLACE FUNCTION public.ai_sales_forecast_series(p_product_id uuid DEFAULT NULL::uuid, p_category_id uuid DEFAULT NULL::uuid, p_days_history integer DEFAULT 90, p_horizon_days integer DEFAULT 30, p_bucket text DEFAULT NULL::text, p_branch_id uuid DEFAULT NULL::uuid)
 RETURNS TABLE(period_start date, is_forecast boolean, actual_revenue numeric, actual_quantity numeric, forecast_revenue numeric, forecast_quantity numeric, lower_bound numeric, upper_bound numeric)
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''
AS $function$
#variable_conflict use_column
declare
  v_branch uuid := public.effective_branch_id(p_branch_id);
  v_bucket text := p_bucket;
begin
  perform public.assert_owner_or_manager();
  if v_branch is null then raise exception 'No active branch for this session'; end if;
  if p_product_id is not null and p_category_id is not null then
    raise exception 'Pass product_id or category_id, not both';
  end if;
  if p_days_history < 7 or p_days_history > 730 then raise exception 'days_history must be between 7 and 730'; end if;
  if p_horizon_days < 1 or p_horizon_days > 365 then raise exception 'horizon_days must be between 1 and 365'; end if;

  if v_bucket is null then
    v_bucket := case
      when p_days_history + p_horizon_days <= 45 then 'day'
      when p_days_history + p_horizon_days <= 180 then 'week'
      else 'month'
    end;
  end if;
  if v_bucket not in ('day','week','month') then raise exception 'bucket must be day, week or month'; end if;

  return query
  with daily as (
    select
      date_trunc('day', s.sold_at)::date as sale_day,
      sum(si.quantity) as qty,
      sum(si.unit_price * si.quantity) as revenue
    from public.sale_items si
    join public.sales s on s.id = si.sale_id
    join public.barcodes bc on bc.id = si.barcode_id
    join public.stock_batches sb on sb.id = bc.stock_batch_id
    join public.product_variants pv on pv.id = sb.product_variant_id
    left join public.branch_product_categorization cat on cat.product_id = pv.product_id and cat.branch_id = v_branch
    where s.branch_id = v_branch
      and s.sold_at >= now() - (p_days_history || ' days')::interval
      and (p_product_id is null or pv.product_id = p_product_id)
      and (p_category_id is null or cat.category_id = p_category_id)
    group by 1
  ),
  history_bounds as (
    select min(sale_day) as start_day, max(sale_day) as end_day from daily
  ),
  numbered as (
    select (d.sale_day - hb.start_day)::numeric as x, d.qty::numeric as y, d.revenue
    from daily d cross join history_bounds hb
  ),
  stats as (
    select
      coalesce(regr_slope(y, x), 0)::numeric as slope,
      coalesce(regr_intercept(y, x), avg(y), 0)::numeric as intercept,
      coalesce(sum(revenue) / nullif(sum(y), 0), 0) as avg_unit_revenue,
      coalesce(max(x), 0) as max_x
    from numbered
  ),
  model as (
    select stats.*, coalesce(stddev_pop(n.y - (stats.intercept + stats.slope * n.x)), 0) as resid_stddev
    from numbered n cross join stats
    group by stats.slope, stats.intercept, stats.avg_unit_revenue, stats.max_x
  ),
  actual_buckets as (
    select date_trunc(v_bucket, sale_day)::date as period_start, sum(qty)::numeric as quantity, sum(revenue)::numeric as revenue
    from daily
    group by 1
  ),
  last_actual as (select max(period_start) as period_start from actual_buckets),
  future_daily as (
    select
      (hb.end_day + gs.d) as future_day,
      greatest(0, m.intercept + m.slope * (m.max_x + gs.d)) as proj_qty
    from generate_series(1, p_horizon_days) as gs(d)
    cross join history_bounds hb
    cross join model m
  ),
  future_buckets as (
    select date_trunc(v_bucket, future_day)::date as period_start, sum(proj_qty)::numeric as quantity, count(*)::numeric as n_days
    from future_daily
    group by 1
  )
  select * from (
    select
      ab.period_start, false as is_forecast,
      round(ab.revenue, 2) as actual_revenue, round(ab.quantity, 2) as actual_quantity,
      case when ab.period_start = la.period_start then round(ab.revenue, 2) end as forecast_revenue,
      case when ab.period_start = la.period_start then round(ab.quantity, 2) end as forecast_quantity,
      null::numeric as lower_bound, null::numeric as upper_bound
    from actual_buckets ab cross join last_actual la
    union all
    select
      fb.period_start, true as is_forecast,
      null::numeric, null::numeric,
      round(fb.quantity * m.avg_unit_revenue, 2), round(fb.quantity, 2),
      round(greatest(0, fb.quantity - 1.28 * m.resid_stddev * sqrt(fb.n_days)) * m.avg_unit_revenue, 2),
      round((fb.quantity + 1.28 * m.resid_stddev * sqrt(fb.n_days)) * m.avg_unit_revenue, 2)
    from future_buckets fb cross join model m
  ) t
  order by period_start;
end;
$function$
;

revoke all on function public.ai_sales_forecast_series(p_product_id uuid, p_category_id uuid, p_days_history integer, p_horizon_days integer, p_bucket text, p_branch_id uuid) from public, anon;
grant execute on function public.ai_sales_forecast_series(p_product_id uuid, p_category_id uuid, p_days_history integer, p_horizon_days integer, p_bucket text, p_branch_id uuid) to authenticated;

-- ----------------------------------------------------------------------------

CREATE OR REPLACE FUNCTION public.ai_sales_trend(p_from date, p_to date, p_bucket text DEFAULT 'day'::text, p_branch_id uuid DEFAULT NULL::uuid)
 RETURNS TABLE(period_start date, revenue numeric, tax numeric, insurance_covered numeric, patient_owed numeric, transaction_count integer)
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''
AS $function$
declare
  v_branch uuid := public.effective_branch_id(p_branch_id);
begin
  perform public.assert_owner_or_manager();
  if v_branch is null then raise exception 'No active branch for this session'; end if;
  if p_bucket not in ('day','week','month') then raise exception 'bucket must be day, week or month'; end if;

  return query
  select
    date_trunc(p_bucket, s.sold_at)::date,
    round(sum(si.unit_price * si.quantity), 2),
    round(sum((si.unit_price * si.quantity) - si.subtotal), 2),
    round(sum(si.insurance_covered_amount), 2),
    round(sum((si.unit_price * si.quantity) - si.insurance_covered_amount), 2),
    count(distinct s.id)::integer
  from public.sales s
  join public.sale_items si on si.sale_id = s.id
  where s.branch_id = v_branch and s.sold_at >= p_from::timestamptz and s.sold_at < (p_to + 1)::timestamptz
  group by 1
  order by 1;
end;
$function$
;

revoke all on function public.ai_sales_trend(p_from date, p_to date, p_bucket text, p_branch_id uuid) from public, anon;
grant execute on function public.ai_sales_trend(p_from date, p_to date, p_bucket text, p_branch_id uuid) to authenticated;

-- ----------------------------------------------------------------------------

CREATE OR REPLACE FUNCTION public.ai_seller_performance(p_from date, p_to date, p_branch_id uuid DEFAULT NULL::uuid)
 RETURNS TABLE(seller_name text, seller_role text, transaction_count integer, revenue numeric)
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''
AS $function$
declare
  v_branch uuid := public.effective_branch_id(p_branch_id);
begin
  perform public.assert_owner_or_manager();
  if v_branch is null then raise exception 'No active branch for this session'; end if;

  return query
  select u.full_name::text, u.role::text, count(distinct s.id)::integer, round(sum(si.unit_price * si.quantity), 2)
  from public.sale_items si
  join public.sales s on s.id = si.sale_id
  join public.users u on u.id = s.cashier_id
  where s.branch_id = v_branch and s.sold_at >= p_from::timestamptz and s.sold_at < (p_to + 1)::timestamptz
  group by u.id, u.full_name, u.role
  order by 4 desc;
end;
$function$
;

revoke all on function public.ai_seller_performance(p_from date, p_to date, p_branch_id uuid) from public, anon;
grant execute on function public.ai_seller_performance(p_from date, p_to date, p_branch_id uuid) to authenticated;

-- ----------------------------------------------------------------------------

CREATE OR REPLACE FUNCTION public.ai_stock_status(p_filter text DEFAULT 'all'::text, p_branch_id uuid DEFAULT NULL::uuid)
 RETURNS TABLE(product_name text, dosage text, quantity_available integer, min_quantity integer, expiry_date date, days_to_expiry integer, status text)
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''
AS $function$
declare
  v_branch uuid := public.effective_branch_id(p_branch_id);
  v_expiry_threshold integer;
  v_default_reorder_min integer;
begin
  perform public.assert_owner_or_manager();
  if v_branch is null then raise exception 'No active branch for this session'; end if;
  if p_filter not in ('low','out','expiring','expired','all') then raise exception 'filter must be low, out, expiring, expired or all'; end if;

  select b.expiry_alert_threshold_days, b.default_reorder_min
    into v_expiry_threshold, v_default_reorder_min
    from public.branches b where b.id = v_branch;

  return query
  with stock as (
    select
      p.name::text as product_name, pv.dosage::text as dosage,
      coalesce(sum(bc.quantity_available * bc.pieces_per_pack) filter (where bc.barcode_type = 'pack'), 0)::integer as qty_available,
      coalesce(rp.min_quantity, v_default_reorder_min) as min_quantity,
      min(sb.expiry_date) filter (where bc.status = 'active') as nearest_expiry
    from public.stock_batches sb
    join public.product_variants pv on pv.id = sb.product_variant_id
    join public.products p on p.id = pv.product_id
    left join public.barcodes bc on bc.stock_batch_id = sb.id
    left join public.reorder_points rp on rp.product_id = pv.product_id and rp.branch_id = v_branch
    where sb.branch_id = v_branch
    group by p.name, pv.id, pv.dosage, rp.min_quantity
  )
  select
    stock.product_name, stock.dosage, stock.qty_available, stock.min_quantity, stock.nearest_expiry,
    (stock.nearest_expiry - current_date)::integer,
    case
      when stock.qty_available = 0 then 'out'
      when stock.nearest_expiry is not null and stock.nearest_expiry < current_date then 'expired'
      when stock.nearest_expiry is not null and stock.nearest_expiry <= current_date + v_expiry_threshold then 'expiring'
      when stock.qty_available < stock.min_quantity then 'low'
      else 'ok'
    end
  from stock
  where p_filter = 'all'
    or (p_filter = 'out' and stock.qty_available = 0)
    or (p_filter = 'low' and stock.qty_available > 0 and stock.qty_available < stock.min_quantity)
    or (p_filter = 'expiring' and stock.nearest_expiry is not null and stock.nearest_expiry between current_date and current_date + v_expiry_threshold)
    or (p_filter = 'expired' and stock.nearest_expiry is not null and stock.nearest_expiry < current_date)
  order by stock.qty_available asc
  limit 200;
end;
$function$
;

revoke all on function public.ai_stock_status(p_filter text, p_branch_id uuid) from public, anon;
grant execute on function public.ai_stock_status(p_filter text, p_branch_id uuid) to authenticated;

-- ----------------------------------------------------------------------------

CREATE OR REPLACE FUNCTION public.ai_top_products(p_from date, p_to date, p_metric text DEFAULT 'revenue'::text, p_direction text DEFAULT 'desc'::text, p_limit integer DEFAULT 10, p_branch_id uuid DEFAULT NULL::uuid)
 RETURNS TABLE(product_id uuid, product_name text, dosage text, quantity_sold numeric, revenue numeric)
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''
AS $function$
declare
  v_branch uuid := public.effective_branch_id(p_branch_id);
begin
  perform public.assert_owner_or_manager();
  if v_branch is null then raise exception 'No active branch for this session'; end if;
  if p_metric not in ('revenue','quantity') then raise exception 'metric must be revenue or quantity'; end if;
  if p_direction not in ('asc','desc') then raise exception 'direction must be asc or desc'; end if;
  if p_limit < 1 or p_limit > 50 then raise exception 'limit must be between 1 and 50'; end if;

  return query
  select
    p.id, p.name::text, pv.dosage::text, sum(si.quantity)::numeric, round(sum(si.unit_price * si.quantity), 2)
  from public.sale_items si
  join public.sales s on s.id = si.sale_id
  join public.barcodes bc on bc.id = si.barcode_id
  join public.stock_batches sb on sb.id = bc.stock_batch_id
  join public.product_variants pv on pv.id = sb.product_variant_id
  join public.products p on p.id = pv.product_id
  where s.branch_id = v_branch and s.sold_at >= p_from::timestamptz and s.sold_at < (p_to + 1)::timestamptz
  group by p.id, p.name, pv.id, pv.dosage
  order by (case when p_metric = 'revenue' then sum(si.unit_price * si.quantity) else sum(si.quantity) end) * (case when p_direction = 'asc' then 1 else -1 end)
  limit p_limit;
end;
$function$
;

revoke all on function public.ai_top_products(p_from date, p_to date, p_metric text, p_direction text, p_limit integer, p_branch_id uuid) from public, anon;
grant execute on function public.ai_top_products(p_from date, p_to date, p_metric text, p_direction text, p_limit integer, p_branch_id uuid) to authenticated;

-- ----------------------------------------------------------------------------

CREATE OR REPLACE FUNCTION public.analytics_basket_size(p_from date, p_to date, p_bucket text DEFAULT 'day'::text, p_branch_id uuid DEFAULT NULL::uuid)
 RETURNS TABLE(period_start date, avg_items_per_sale numeric, avg_revenue_per_sale numeric, transaction_count integer)
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''
AS $function$
declare
  v_branch uuid := public.effective_branch_id(p_branch_id);
begin
  perform public.assert_owner_or_manager();
  if v_branch is null then raise exception 'No active branch for this session'; end if;
  if p_bucket not in ('day','week','month') then raise exception 'bucket must be day, week or month'; end if;

  return query
  with per_sale as (
    select s.id, date_trunc(p_bucket, s.sold_at)::date as period, sum(si.quantity) as items, sum(si.unit_price * si.quantity) as revenue
    from public.sales s
    join public.sale_items si on si.sale_id = s.id
    where s.branch_id = v_branch and s.sold_at >= p_from::timestamptz and s.sold_at < (p_to + 1)::timestamptz
    group by s.id, period
  )
  select period, round(avg(items), 2), round(avg(revenue), 2), count(*)::integer
  from per_sale
  group by period
  order by period;
end;
$function$
;

revoke all on function public.analytics_basket_size(p_from date, p_to date, p_bucket text, p_branch_id uuid) from public, anon;
grant execute on function public.analytics_basket_size(p_from date, p_to date, p_bucket text, p_branch_id uuid) to authenticated;

-- ----------------------------------------------------------------------------

CREATE OR REPLACE FUNCTION public.analytics_dead_stock(p_days integer DEFAULT 60, p_limit integer DEFAULT 50, p_branch_id uuid DEFAULT NULL::uuid)
 RETURNS TABLE(product_name text, dosage text, quantity_on_hand integer, stock_value numeric, days_since_last_sale integer)
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''
AS $function$
declare
  v_branch uuid := public.effective_branch_id(p_branch_id);
begin
  perform public.assert_owner_or_manager();
  if v_branch is null then raise exception 'No active branch for this session'; end if;
  if p_days < 1 or p_days > 730 then raise exception 'days must be between 1 and 730'; end if;

  return query
  with onhand as (
    select
      pv.id as variant_id, p.name as product_name, pv.dosage as dosage,
      sum(bc.quantity_available * bc.pieces_per_pack) filter (where bc.barcode_type = 'pack') as qty,
      sum(bc.quantity_available * bc.pieces_per_pack * coalesce(sb.cost_price, 0)) filter (where bc.barcode_type = 'pack') as value
    from public.stock_batches sb
    join public.product_variants pv on pv.id = sb.product_variant_id
    join public.products p on p.id = pv.product_id
    left join public.barcodes bc on bc.stock_batch_id = sb.id
    where sb.branch_id = v_branch
    group by pv.id, p.name, pv.dosage
  ),
  last_sale as (
    select pv.id as variant_id, max(s.sold_at) as last_sold_at
    from public.sale_items si
    join public.sales s on s.id = si.sale_id
    join public.barcodes bc on bc.id = si.barcode_id
    join public.stock_batches sb on sb.id = bc.stock_batch_id
    join public.product_variants pv on pv.id = sb.product_variant_id
    where s.branch_id = v_branch
    group by pv.id
  )
  select
    onhand.product_name::text, onhand.dosage::text,
    coalesce(onhand.qty, 0)::integer, round(coalesce(onhand.value, 0), 2),
    case when last_sale.last_sold_at is null then null else (current_date - last_sale.last_sold_at::date)::integer end
  from onhand
  left join last_sale on last_sale.variant_id = onhand.variant_id
  where coalesce(onhand.qty, 0) > 0
    and (last_sale.last_sold_at is null or last_sale.last_sold_at < now() - (p_days || ' days')::interval)
  order by round(coalesce(onhand.value, 0), 2) desc
  limit p_limit;
end;
$function$
;

revoke all on function public.analytics_dead_stock(p_days integer, p_limit integer, p_branch_id uuid) from public, anon;
grant execute on function public.analytics_dead_stock(p_days integer, p_limit integer, p_branch_id uuid) to authenticated;

-- ----------------------------------------------------------------------------

CREATE OR REPLACE FUNCTION public.analytics_discount_usage(p_from date, p_to date, p_branch_id uuid DEFAULT NULL::uuid)
 RETURNS TABLE(discount_name text, discount_type text, usage_count integer, revenue_with_discount numeric, estimated_discount_value numeric)
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''
AS $function$
declare
  v_branch uuid := public.effective_branch_id(p_branch_id);
begin
  perform public.assert_owner_or_manager();
  if v_branch is null then raise exception 'No active branch for this session'; end if;

  return query
  with per_sale as (
    select s.id as sale_id, s.discount_id, sum(si.unit_price * si.quantity) as sale_revenue
    from public.sales s
    join public.sale_items si on si.sale_id = s.id
    where s.branch_id = v_branch and s.discount_id is not null
      and s.sold_at >= p_from::timestamptz and s.sold_at < (p_to + 1)::timestamptz
    group by s.id, s.discount_id
  )
  select
    d.name::text, d.discount_type::text, count(*)::integer, round(sum(ps.sale_revenue), 2),
    round(sum(case when d.discount_type = 'percentage' then ps.sale_revenue * (d.value / 100.0) else least(d.value, ps.sale_revenue) end), 2)
  from per_sale ps
  join public.discounts d on d.id = ps.discount_id
  group by d.id, d.name, d.discount_type
  order by 4 desc;
end;
$function$
;

revoke all on function public.analytics_discount_usage(p_from date, p_to date, p_branch_id uuid) from public, anon;
grant execute on function public.analytics_discount_usage(p_from date, p_to date, p_branch_id uuid) to authenticated;

-- ----------------------------------------------------------------------------

CREATE OR REPLACE FUNCTION public.analytics_insurance_claim_aging(p_branch_id uuid DEFAULT NULL::uuid)
 RETURNS TABLE(age_bucket text, claim_count integer, total_amount numeric)
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''
AS $function$
declare
  v_branch uuid := public.effective_branch_id(p_branch_id);
begin
  perform public.assert_owner_or_manager();
  if v_branch is null then raise exception 'No active branch for this session'; end if;

  return query
  select
    case
      when (current_date - ic.submitted_at::date) <= 7 then '0-7 days'
      when (current_date - ic.submitted_at::date) <= 14 then '8-14 days'
      when (current_date - ic.submitted_at::date) <= 30 then '15-30 days'
      else '31+ days'
    end,
    count(*)::integer,
    round(sum(ic.claim_amount), 2)
  from public.insurance_claims ic
  join public.sales s on s.id = ic.sale_id
  where s.branch_id = v_branch and ic.status in ('submitted','approved')
  group by 1
  order by min(case
    when (current_date - ic.submitted_at::date) <= 7 then 0
    when (current_date - ic.submitted_at::date) <= 14 then 1
    when (current_date - ic.submitted_at::date) <= 30 then 2
    else 3
  end);
end;
$function$
;

revoke all on function public.analytics_insurance_claim_aging(p_branch_id uuid) from public, anon;
grant execute on function public.analytics_insurance_claim_aging(p_branch_id uuid) to authenticated;

-- ----------------------------------------------------------------------------

CREATE OR REPLACE FUNCTION public.analytics_insurance_provider_comparison(p_from date, p_to date, p_branch_id uuid DEFAULT NULL::uuid)
 RETURNS TABLE(provider_name text, claim_count integer, approved_count integer, approval_rate numeric, avg_claim_amount numeric, avg_coverage_percentage numeric)
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''
AS $function$
declare
  v_branch uuid := public.effective_branch_id(p_branch_id);
begin
  perform public.assert_owner_or_manager();
  if v_branch is null then raise exception 'No active branch for this session'; end if;

  return query
  select
    ip.name::text,
    count(*)::integer,
    count(*) filter (where ic.status in ('approved','paid'))::integer,
    round(100.0 * count(*) filter (where ic.status in ('approved','paid')) / nullif(count(*), 0), 1),
    round(avg(ic.claim_amount), 2),
    round(avg(ic.coverage_percentage_applied), 1)
  from public.insurance_claims ic
  join public.sales s on s.id = ic.sale_id
  join public.insurance_providers ip on ip.id = ic.insurance_provider_id
  where s.branch_id = v_branch and ic.submitted_at >= p_from::timestamptz and ic.submitted_at < (p_to + 1)::timestamptz
  group by ip.name
  order by 2 desc;
end;
$function$
;

revoke all on function public.analytics_insurance_provider_comparison(p_from date, p_to date, p_branch_id uuid) from public, anon;
grant execute on function public.analytics_insurance_provider_comparison(p_from date, p_to date, p_branch_id uuid) to authenticated;

-- ----------------------------------------------------------------------------

CREATE OR REPLACE FUNCTION public.analytics_inventory_turnover(p_from date, p_to date, p_branch_id uuid DEFAULT NULL::uuid)
 RETURNS TABLE(category_name text, cogs numeric, current_inventory_value numeric, turnover_ratio numeric)
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''
AS $function$
declare
  v_branch uuid := public.effective_branch_id(p_branch_id);
begin
  perform public.assert_owner_or_manager();
  if v_branch is null then raise exception 'No active branch for this session'; end if;

  return query
  with cogs_by_cat as (
    select
      coalesce(c.name, 'Uncategorized') as category_name,
      sum(si.quantity * coalesce(sb.cost_price, 0)) as cogs
    from public.sale_items si
    join public.sales s on s.id = si.sale_id
    join public.barcodes bc on bc.id = si.barcode_id
    join public.stock_batches sb on sb.id = bc.stock_batch_id
    join public.product_variants pv on pv.id = sb.product_variant_id
    left join public.branch_product_categorization cat on cat.product_id = pv.product_id and cat.branch_id = v_branch
    left join public.product_categories c on c.id = cat.category_id
    where s.branch_id = v_branch and s.sold_at >= p_from::timestamptz and s.sold_at < (p_to + 1)::timestamptz
    group by c.name
  ),
  value_by_cat as (
    select
      coalesce(c.name, 'Uncategorized') as category_name,
      sum(bc.quantity_available * bc.pieces_per_pack * coalesce(sb.cost_price, 0)) filter (where bc.barcode_type = 'pack') as value
    from public.stock_batches sb
    join public.product_variants pv on pv.id = sb.product_variant_id
    left join public.branch_product_categorization cat on cat.product_id = pv.product_id and cat.branch_id = v_branch
    left join public.product_categories c on c.id = cat.category_id
    left join public.barcodes bc on bc.stock_batch_id = sb.id
    where sb.branch_id = v_branch
    group by c.name
  )
  select
    coalesce(cogs_by_cat.category_name, value_by_cat.category_name)::text,
    round(coalesce(cogs_by_cat.cogs, 0), 2),
    round(coalesce(value_by_cat.value, 0), 2),
    round(coalesce(cogs_by_cat.cogs, 0) / nullif(coalesce(value_by_cat.value, 0), 0), 2)
  from cogs_by_cat
  full outer join value_by_cat on value_by_cat.category_name = cogs_by_cat.category_name
  order by 2 desc nulls last;
end;
$function$
;

revoke all on function public.analytics_inventory_turnover(p_from date, p_to date, p_branch_id uuid) from public, anon;
grant execute on function public.analytics_inventory_turnover(p_from date, p_to date, p_branch_id uuid) to authenticated;

-- ----------------------------------------------------------------------------

CREATE OR REPLACE FUNCTION public.analytics_patient_retention(p_lookback_days integer DEFAULT 180, p_inactive_days integer DEFAULT 60, p_limit integer DEFAULT 20, p_branch_id uuid DEFAULT NULL::uuid)
 RETURNS TABLE(patient_name text, last_visit date, days_since_last_visit integer, past_visit_count integer, lifetime_spend numeric)
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''
AS $function$
declare
  v_branch uuid := public.effective_branch_id(p_branch_id);
begin
  perform public.assert_owner_or_manager();
  if v_branch is null then raise exception 'No active branch for this session'; end if;
  if p_lookback_days < 1 or p_lookback_days > 1825 then raise exception 'lookback_days must be between 1 and 1825'; end if;
  if p_inactive_days < 1 or p_inactive_days > 730 then raise exception 'inactive_days must be between 1 and 730'; end if;

  return query
  with visits as (
    select s.id as sale_id, s.patient_id, s.sold_at, si.unit_price * si.quantity as line_revenue
    from public.sales s
    join public.sale_items si on si.sale_id = s.id
    where s.branch_id = v_branch and s.patient_id is not null
      and s.sold_at >= now() - (p_lookback_days || ' days')::interval
  ),
  per_patient as (
    select patient_id, max(sold_at) as last_visit, count(distinct sale_id) as visit_count, sum(line_revenue) as spend
    from visits
    group by patient_id
  )
  select
    pt.full_name::text,
    per_patient.last_visit::date,
    (current_date - per_patient.last_visit::date)::integer,
    per_patient.visit_count::integer,
    round(per_patient.spend, 2)
  from per_patient
  join public.patients pt on pt.id = per_patient.patient_id
  where per_patient.last_visit < now() - (p_inactive_days || ' days')::interval
  order by per_patient.spend desc
  limit p_limit;
end;
$function$
;

revoke all on function public.analytics_patient_retention(p_lookback_days integer, p_inactive_days integer, p_limit integer, p_branch_id uuid) from public, anon;
grant execute on function public.analytics_patient_retention(p_lookback_days integer, p_inactive_days integer, p_limit integer, p_branch_id uuid) to authenticated;

-- ----------------------------------------------------------------------------

CREATE OR REPLACE FUNCTION public.analytics_recall_log(p_limit integer DEFAULT 50)
 RETURNS TABLE(product_name text, dosage text, batch_number text, manufacturer_name text, reason text, recalled_by_name text, recalled_at timestamp with time zone)
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''
AS $function$
begin
  perform public.assert_owner_or_manager();
  if p_limit < 1 or p_limit > 200 then raise exception 'limit must be between 1 and 200'; end if;

  return query
  select
    p.name::text, pv.dosage::text, br.batch_number::text, br.manufacturer_name::text, br.reason,
    u.full_name::text, br.recalled_at
  from public.batch_recalls br
  join public.product_variants pv on pv.id = br.product_variant_id
  join public.products p on p.id = pv.product_id
  left join public.users u on u.id = br.recalled_by
  order by br.recalled_at desc
  limit p_limit;
end;
$function$
;

revoke all on function public.analytics_recall_log(p_limit integer) from public, anon;
grant execute on function public.analytics_recall_log(p_limit integer) to authenticated;

-- ----------------------------------------------------------------------------

CREATE OR REPLACE FUNCTION public.analytics_sales_heatmap(p_from date, p_to date, p_branch_id uuid DEFAULT NULL::uuid)
 RETURNS TABLE(day_of_week integer, hour_of_day integer, revenue numeric, transaction_count integer)
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''
AS $function$
declare
  v_branch uuid := public.effective_branch_id(p_branch_id);
begin
  perform public.assert_owner_or_manager();
  if v_branch is null then raise exception 'No active branch for this session'; end if;

  return query
  with per_sale as (
    select s.id, s.sold_at, sum(si.unit_price * si.quantity) as sale_revenue
    from public.sales s
    join public.sale_items si on si.sale_id = s.id
    where s.branch_id = v_branch and s.sold_at >= p_from::timestamptz and s.sold_at < (p_to + 1)::timestamptz
    group by s.id, s.sold_at
  )
  select
    extract(dow from sold_at)::integer, extract(hour from sold_at)::integer,
    round(sum(sale_revenue), 2), count(*)::integer
  from per_sale
  group by 1, 2
  order by 1, 2;
end;
$function$
;

revoke all on function public.analytics_sales_heatmap(p_from date, p_to date, p_branch_id uuid) from public, anon;
grant execute on function public.analytics_sales_heatmap(p_from date, p_to date, p_branch_id uuid) to authenticated;

-- ----------------------------------------------------------------------------

CREATE OR REPLACE FUNCTION public.analytics_seller_productivity(p_from date, p_to date, p_branch_id uuid DEFAULT NULL::uuid)
 RETURNS TABLE(seller_name text, seller_role text, transaction_count integer, revenue numeric, active_hours numeric, revenue_per_hour numeric, transactions_per_hour numeric)
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''
AS $function$
declare
  v_branch uuid := public.effective_branch_id(p_branch_id);
begin
  perform public.assert_owner_or_manager();
  if v_branch is null then raise exception 'No active branch for this session'; end if;

  return query
  with daily as (
    select s.cashier_id, date_trunc('day', s.sold_at) as sale_day,
      extract(epoch from (max(s.sold_at) - min(s.sold_at))) / 3600.0 as hours,
      count(*) as txns
    from public.sales s
    where s.branch_id = v_branch and s.sold_at >= p_from::timestamptz and s.sold_at < (p_to + 1)::timestamptz
    group by s.cashier_id, date_trunc('day', s.sold_at)
  ),
  per_seller as (
    select cashier_id, sum(hours) as active_hours, sum(txns) as txn_count
    from daily
    group by cashier_id
  ),
  seller_revenue as (
    select s.cashier_id, sum(si.unit_price * si.quantity) as rev
    from public.sales s
    join public.sale_items si on si.sale_id = s.id
    where s.branch_id = v_branch and s.sold_at >= p_from::timestamptz and s.sold_at < (p_to + 1)::timestamptz
    group by s.cashier_id
  )
  select
    u.full_name::text, u.role::text, ps.txn_count::integer, round(coalesce(r.rev, 0), 2),
    round(ps.active_hours, 2),
    round(coalesce(r.rev, 0) / nullif(ps.active_hours, 0), 2),
    round(ps.txn_count / nullif(ps.active_hours, 0), 2)
  from per_seller ps
  join public.users u on u.id = ps.cashier_id
  left join seller_revenue r on r.cashier_id = ps.cashier_id
  order by ps.txn_count desc;
end;
$function$
;

revoke all on function public.analytics_seller_productivity(p_from date, p_to date, p_branch_id uuid) from public, anon;
grant execute on function public.analytics_seller_productivity(p_from date, p_to date, p_branch_id uuid) to authenticated;

-- ----------------------------------------------------------------------------

CREATE OR REPLACE FUNCTION public.analytics_stock_adjustments(p_from date, p_to date, p_branch_id uuid DEFAULT NULL::uuid)
 RETURNS TABLE(adjustment_type text, staff_name text, quantity numeric, adjustment_count integer, estimated_value numeric)
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''
AS $function$
declare
  v_branch uuid := public.effective_branch_id(p_branch_id);
begin
  perform public.assert_owner_or_manager();
  if v_branch is null then raise exception 'No active branch for this session'; end if;

  return query
  select
    sa.adjustment_type::text,
    coalesce(u.full_name::text, 'System'),
    sum(sa.quantity)::numeric,
    count(*)::integer,
    round(sum(sa.quantity * coalesce(sb.cost_price, 0)), 2)
  from public.stock_adjustments sa
  join public.stock_batches sb on sb.id = sa.stock_batch_id
  left join public.users u on u.id = sa.performed_by
  where sb.branch_id = v_branch and sa.adjusted_at >= p_from::timestamptz and sa.adjusted_at < (p_to + 1)::timestamptz
  group by sa.adjustment_type, u.full_name
  order by 5 desc;
end;
$function$
;

revoke all on function public.analytics_stock_adjustments(p_from date, p_to date, p_branch_id uuid) from public, anon;
grant execute on function public.analytics_stock_adjustments(p_from date, p_to date, p_branch_id uuid) to authenticated;

-- ----------------------------------------------------------------------------

CREATE OR REPLACE FUNCTION public.analytics_supplier_performance(p_from date, p_to date, p_branch_id uuid DEFAULT NULL::uuid)
 RETURNS TABLE(supplier_name text, delivery_count integer, units_received numeric, total_cost numeric, avg_unit_cost numeric)
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''
AS $function$
declare
  v_branch uuid := public.effective_branch_id(p_branch_id);
begin
  perform public.assert_owner_or_manager();
  if v_branch is null then raise exception 'No active branch for this session'; end if;

  return query
  select
    coalesce(sup.supplier_name, 'Unknown supplier')::text,
    count(*)::integer,
    sum(sb.quantity_received)::numeric,
    round(sum(sb.quantity_received * coalesce(sb.cost_price, 0)), 2),
    round(sum(sb.quantity_received * coalesce(sb.cost_price, 0)) / nullif(sum(sb.quantity_received), 0), 2)
  from public.stock_batches sb
  left join public.suppliers sup on sup.id = sb.supplier_id
  where sb.branch_id = v_branch and sb.received_at >= p_from::timestamptz and sb.received_at < (p_to + 1)::timestamptz
  group by sup.supplier_name
  order by 4 desc;
end;
$function$
;

revoke all on function public.analytics_supplier_performance(p_from date, p_to date, p_branch_id uuid) from public, anon;
grant execute on function public.analytics_supplier_performance(p_from date, p_to date, p_branch_id uuid) to authenticated;

-- ----------------------------------------------------------------------------

CREATE OR REPLACE FUNCTION public.analytics_vat_by_month(p_months integer DEFAULT 8, p_branch_id uuid DEFAULT NULL::uuid)
 RETURNS TABLE(month_label text, month_start date, revenue numeric, vat_total numeric)
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''
AS $function$
#variable_conflict use_column
declare
  v_branch uuid := public.effective_branch_id(p_branch_id);
begin
  perform public.assert_owner_or_manager();
  if v_branch is null then raise exception 'No active branch for this session'; end if;
  if p_months < 1 or p_months > 24 then raise exception 'months must be between 1 and 24'; end if;

  return query
  with months as (
    select date_trunc('month', current_date - (n || ' months')::interval)::date as month_start
    from generate_series(0, p_months - 1) as n
  ),
  line_tax as (
    select s.id as sale_id, date_trunc('month', s.sold_at)::date as month_start,
           si.subtotal, round(si.subtotal * t.rate_percentage / 100, 2) as tax_amount
    from public.sales s
    join public.sale_items si on si.sale_id = s.id
    join public.tax_rates t on t.id = si.tax_rate_id
    where s.branch_id = v_branch
      and s.sold_at >= (select min(month_start) from months)
  )
  select
    to_char(m.month_start, 'Mon')::text,
    m.month_start,
    coalesce(round(sum(lt.subtotal + lt.tax_amount), 2), 0),
    coalesce(round(sum(lt.tax_amount), 2), 0)
  from months m
  left join line_tax lt on lt.month_start = m.month_start
  group by m.month_start
  order by m.month_start;
end;
$function$
;

revoke all on function public.analytics_vat_by_month(p_months integer, p_branch_id uuid) from public, anon;
grant execute on function public.analytics_vat_by_month(p_months integer, p_branch_id uuid) to authenticated;

-- ----------------------------------------------------------------------------

CREATE OR REPLACE FUNCTION public.approve_stock_need(p_need_id uuid)
 RETURNS uuid
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''
AS $function$
declare
  v_need public.stock_transfer_needs%rowtype;
  v_offer public.stock_transfer_offers%rowtype;
  v_transfer uuid;
begin
  select * into v_need from public.stock_transfer_needs where id = p_need_id for update;
  if v_need.id is null then raise exception 'Stock request not found'; end if;
  if v_need.status <> 'org_review' then raise exception 'This request is not awaiting approval'; end if;

  perform public.assert_can_approve_stock_transfer(v_need.organization_id);

  select * into v_offer from public.stock_transfer_offers
  where need_id = p_need_id and status = 'accepted'
  order by responded_at desc
  limit 1;
  if v_offer.id is null then raise exception 'No accepted offer found for this request'; end if;

  v_transfer := public.request_stock_transfer(
    v_need.requesting_branch_id, v_offer.accepted_batch_ids,
    format('Approved stock request %s', v_need.id), v_offer.target_branch_id
  );

  perform public.approve_stock_transfer(v_transfer);

  update public.stock_transfer_needs set status = 'fulfilling', transfer_id = v_transfer where id = p_need_id;

  insert into public.notifications (branch_id, source_type, source_id, message)
  select v_need.requesting_branch_id, 'stock_need_approved', p_need_id,
    format('Approved: %s will send %s. Waiting for dispatch.', b.name, concat_ws(' ', p.name, pv.dosage))
  from public.branches b
  join public.product_variants pv on pv.id = v_need.product_variant_id
  join public.products p on p.id = pv.product_id
  where b.id = v_offer.target_branch_id;

  insert into public.notifications (branch_id, source_type, source_id, message)
  select v_offer.target_branch_id, 'stock_need_approved', p_need_id,
    format('Your offer to send %s to %s was approved -- dispatch it when ready.', concat_ws(' ', p.name, pv.dosage), b.name)
  from public.branches b
  join public.product_variants pv on pv.id = v_need.product_variant_id
  join public.products p on p.id = pv.product_id
  where b.id = v_need.requesting_branch_id;

  return v_transfer;
end;
$function$
;

revoke all on function public.approve_stock_need(p_need_id uuid) from public, anon;
grant execute on function public.approve_stock_need(p_need_id uuid) to authenticated;

-- ----------------------------------------------------------------------------

CREATE OR REPLACE FUNCTION public.approve_stock_transfer(p_transfer_id uuid)
 RETURNS void
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''
AS $function$
declare
  v_transfer public.stock_transfers%rowtype;
  v_user uuid := (select auth.uid());
begin
  select * into v_transfer from public.stock_transfers where id = p_transfer_id;
  if v_transfer.id is null then raise exception 'Transfer not found'; end if;
  if v_transfer.status <> 'pending' then raise exception 'Only a pending transfer can be approved'; end if;

  if not (
    public.is_org_member(v_transfer.organization_id)
    or exists (
      select 1 from public.users u
      where u.id = v_user and u.is_active and u.role in ('owner', 'manager') and u.branch_id = v_transfer.to_branch_id
    )
  ) then
    raise exception 'Only the receiving branch or an organization member may approve this transfer';
  end if;

  update public.stock_transfers
  set status = 'approved', approved_by = v_user, approved_at = now()
  where id = p_transfer_id;
end;
$function$
;

revoke all on function public.approve_stock_transfer(p_transfer_id uuid) from public, anon;
grant execute on function public.approve_stock_transfer(p_transfer_id uuid) to authenticated;

-- ----------------------------------------------------------------------------

CREATE OR REPLACE FUNCTION public.assert_can_approve_stock_transfer(p_organization_id uuid)
 RETURNS void
 LANGUAGE plpgsql
 STABLE SECURITY DEFINER
 SET search_path TO ''
AS $function$
declare
  v_caller uuid := (select auth.uid());
  v_caller_role text;
  v_has_manager boolean;
begin
  select m.role into v_caller_role
  from public.organization_members m
  join public.users u on u.id = m.user_id
  where m.organization_id = p_organization_id and m.user_id = v_caller and u.is_active;

  v_has_manager := exists (
    select 1 from public.organization_members om
    join public.users u2 on u2.id = om.user_id
    where om.organization_id = p_organization_id and om.role = 'org_manager' and u2.is_active
  );

  if v_has_manager then
    if v_caller_role <> 'org_manager' then
      raise exception 'Only the organization manager may approve or reject a stock transfer request';
    end if;
  else
    if v_caller_role not in ('org_owner', 'org_manager') then
      raise exception 'Only the organization owner or manager may approve or reject a stock transfer request';
    end if;
  end if;
end;
$function$
;

revoke all on function public.assert_can_approve_stock_transfer(p_organization_id uuid) from public, anon;
grant execute on function public.assert_can_approve_stock_transfer(p_organization_id uuid) to authenticated;

-- ----------------------------------------------------------------------------

CREATE OR REPLACE FUNCTION public.assert_can_manage_org_branch(p_organization_id uuid)
 RETURNS void
 LANGUAGE plpgsql
 STABLE SECURITY DEFINER
 SET search_path TO ''
AS $function$
declare
  v_caller uuid := (select auth.uid());
  v_caller_role text;
  v_has_manager boolean;
begin
  select m.role into v_caller_role
  from public.organization_members m
  join public.users u on u.id = m.user_id
  where m.organization_id = p_organization_id and m.user_id = v_caller and u.is_active;

  v_has_manager := exists (
    select 1 from public.organization_members om
    join public.users u2 on u2.id = om.user_id
    where om.organization_id = p_organization_id and om.role = 'org_manager' and u2.is_active
  );

  if v_has_manager then
    if v_caller_role <> 'org_manager' then
      raise exception 'Only the organization manager may act on another branch -- the owner can still view its performance and analytics';
    end if;
  else
    if v_caller_role not in ('org_owner', 'org_manager') then
      raise exception 'Only the organization owner or manager may act on another branch';
    end if;
  end if;
end;
$function$
;

revoke all on function public.assert_can_manage_org_branch(p_organization_id uuid) from public, anon;
grant execute on function public.assert_can_manage_org_branch(p_organization_id uuid) to authenticated;

-- ----------------------------------------------------------------------------

CREATE OR REPLACE FUNCTION public.assert_can_manage_org_branch_or_own(p_effective_branch_id uuid, p_own_branch_id uuid)
 RETURNS void
 LANGUAGE plpgsql
 STABLE SECURITY DEFINER
 SET search_path TO ''
AS $function$
declare
  v_org_id uuid;
begin
  if p_effective_branch_id is null or p_effective_branch_id = p_own_branch_id then
    return;
  end if;

  select organization_id into v_org_id from public.branches where id = p_effective_branch_id;
  perform public.assert_can_manage_org_branch(v_org_id);
end;
$function$
;

revoke all on function public.assert_can_manage_org_branch_or_own(p_effective_branch_id uuid, p_own_branch_id uuid) from public, anon;
grant execute on function public.assert_can_manage_org_branch_or_own(p_effective_branch_id uuid, p_own_branch_id uuid) to authenticated;

-- ----------------------------------------------------------------------------

CREATE OR REPLACE FUNCTION public.assert_can_manage_staff_account(p_target_user_id uuid)
 RETURNS void
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''
AS $function$
begin
  perform public.assert_can_reset_staff_password(p_target_user_id);
end;
$function$
;

revoke all on function public.assert_can_manage_staff_account(p_target_user_id uuid) from public, anon;
grant execute on function public.assert_can_manage_staff_account(p_target_user_id uuid) to authenticated;

-- ----------------------------------------------------------------------------

CREATE OR REPLACE FUNCTION public.assert_can_reset_staff_password(p_target_user_id uuid)
 RETURNS void
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''
AS $function$
declare
  v_caller uuid := (select auth.uid());
  v_caller_org_role text;
  v_caller_org_id uuid;
  v_caller_branch_role text;
  v_caller_branch_id uuid;
  v_target_org_role text;
  v_target_org_id uuid;
  v_target_branch_role text;
  v_target_branch_id uuid;
begin
  if v_caller is null then raise exception 'Not signed in'; end if;
  if v_caller = p_target_user_id then
    raise exception 'Use your own account settings to change your own password';
  end if;

  select om.role, om.organization_id into v_caller_org_role, v_caller_org_id
  from public.organization_members om where om.user_id = v_caller;
  select u.role, u.branch_id into v_caller_branch_role, v_caller_branch_id
  from public.users u where u.id = v_caller and u.is_active;

  select om.role, om.organization_id into v_target_org_role, v_target_org_id
  from public.organization_members om where om.user_id = p_target_user_id;
  select u.role, u.branch_id into v_target_branch_role, v_target_branch_id
  from public.users u where u.id = p_target_user_id;

  if v_target_branch_id is null then raise exception 'Person not found'; end if;

  if v_target_org_role is not null then
    if v_target_org_role = 'org_owner' then
      raise exception 'The organization owner''s password cannot be reset from here';
    end if;
    if v_caller_org_role = 'org_owner' and v_caller_org_id = v_target_org_id then
      return;
    end if;
    raise exception 'Only the organization owner may reset this person''s password';
  end if;

  if v_caller_org_role in ('org_owner', 'org_manager') and exists (
    select 1 from public.branches b where b.id = v_target_branch_id and b.organization_id = v_caller_org_id
  ) then
    return;
  end if;

  if v_caller_branch_id = v_target_branch_id and v_caller_branch_role = 'owner' and v_target_branch_role in ('manager', 'seller') then
    return;
  end if;

  if v_caller_branch_id = v_target_branch_id and v_caller_branch_role = 'manager' and v_target_branch_role = 'seller' then
    return;
  end if;

  raise exception 'You do not have permission to reset this person''s password';
end;
$function$
;

revoke all on function public.assert_can_reset_staff_password(p_target_user_id uuid) from public, anon;
grant execute on function public.assert_can_reset_staff_password(p_target_user_id uuid) to authenticated;

-- ----------------------------------------------------------------------------

CREATE OR REPLACE FUNCTION public.assert_org_member(p_organization_id uuid)
 RETURNS void
 LANGUAGE plpgsql
 STABLE SECURITY DEFINER
 SET search_path TO ''
AS $function$
begin
  if not public.is_org_member(p_organization_id) then
    raise exception 'You are not an active member of this organization';
  end if;
end;
$function$
;

revoke all on function public.assert_org_member(p_organization_id uuid) from public, anon;
grant execute on function public.assert_org_member(p_organization_id uuid) to authenticated;

-- ----------------------------------------------------------------------------

CREATE OR REPLACE FUNCTION public.assert_org_owner(p_organization_id uuid)
 RETURNS void
 LANGUAGE plpgsql
 STABLE SECURITY DEFINER
 SET search_path TO ''
AS $function$
begin
  if not exists (
    select 1 from public.organization_members m
    join public.users u on u.id = m.user_id
    where m.organization_id = p_organization_id and m.user_id = (select auth.uid())
      and m.role = 'org_owner' and u.is_active
  ) then
    raise exception 'Only an active owner of this organization may do that';
  end if;
end;
$function$
;

revoke all on function public.assert_org_owner(p_organization_id uuid) from public, anon;
grant execute on function public.assert_org_owner(p_organization_id uuid) to authenticated;

-- ----------------------------------------------------------------------------

CREATE OR REPLACE FUNCTION public.assert_owner_or_manager()
 RETURNS void
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''
AS $function$
begin
  if not exists (
    select 1 from public.users u
    where u.id = (select auth.uid()) and u.is_active and u.role in ('owner','manager')
  ) then
    raise exception 'Only the branch owner or manager may use the AI analyst';
  end if;
end;
$function$
;

revoke all on function public.assert_owner_or_manager() from public, anon;
grant execute on function public.assert_owner_or_manager() to authenticated;

-- ----------------------------------------------------------------------------

CREATE OR REPLACE FUNCTION public.assert_super_admin()
 RETURNS void
 LANGUAGE plpgsql
 STABLE SECURITY DEFINER
 SET search_path TO ''
AS $function$
  begin
    if not public.is_super_admin() then
      raise exception 'Super admin access is required';
    end if;
  end;
  $function$
;

revoke all on function public.assert_super_admin() from public, anon;
grant execute on function public.assert_super_admin() to authenticated;

-- ----------------------------------------------------------------------------

CREATE OR REPLACE FUNCTION public.can_request_organization_invite_otp(p_email text)
 RETURNS boolean
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''
AS $function$
declare
  v_invite_id uuid;
begin
  select i.id into v_invite_id
  from public.organization_invites i
  where lower(i.email) = lower(btrim(p_email)) and i.status = 'otp_sent'
  order by i.otp_sent_at desc
  limit 1;

  if v_invite_id is not null then
    perform public.freeze_expired_organization_invite(v_invite_id);
  end if;

  return exists (
    select 1 from public.organization_invites i
    where lower(i.email) = lower(btrim(p_email)) and i.status = 'otp_sent'
  );
end;
$function$
;

revoke all on function public.can_request_organization_invite_otp(p_email text) from public, anon;
grant execute on function public.can_request_organization_invite_otp(p_email text) to authenticated;

-- ----------------------------------------------------------------------------

CREATE OR REPLACE FUNCTION public.can_request_organization_registration_otp(p_email text)
 RETURNS boolean
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''
AS $function$
declare
  v_app_id uuid;
begin
  select a.id into v_app_id
  from public.organization_applications a
  where lower(a.email) = lower(btrim(p_email)) and a.status = 'otp_sent';

  if v_app_id is not null then
    perform public.freeze_expired_organization_application(v_app_id);
  end if;

  return exists (
    select 1 from public.organization_applications a
    where lower(a.email) = lower(btrim(p_email)) and a.status = 'otp_sent'
  );
end;
$function$
;

revoke all on function public.can_request_organization_registration_otp(p_email text) from public, anon;
grant execute on function public.can_request_organization_registration_otp(p_email text) to authenticated;

-- ----------------------------------------------------------------------------

CREATE OR REPLACE FUNCTION public.can_request_pharmacy_otp(p_email text)
 RETURNS boolean
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''
AS $function$
declare
  v_app_id uuid;
begin
  select a.id into v_app_id
  from public.branch_applications a
  where lower(a.email) = lower(btrim(p_email)) and a.status = 'otp_sent';

  if v_app_id is not null then
    perform public.freeze_expired_pharmacy_otp(v_app_id);
  end if;

  return exists (
    select 1
    from public.branch_applications a
    left join public.branches b on b.id = a.branch_id
    where lower(a.email) = lower(btrim(p_email))
      and a.status = 'otp_sent'
      and coalesce(b.status, 'otp_sent') <> 'locked'
  ) or exists (
    select 1
    from public.users u
    join public.branches b on b.id = u.branch_id
    where lower(u.email) = lower(btrim(p_email))
      and u.is_active
      and b.status = 'active'
  );
end;
$function$
;

revoke all on function public.can_request_pharmacy_otp(p_email text) from public, anon;
grant execute on function public.can_request_pharmacy_otp(p_email text) to authenticated;

-- ----------------------------------------------------------------------------

CREATE OR REPLACE FUNCTION public.cancel_stock_transfer(p_transfer_id uuid)
 RETURNS void
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''
AS $function$
declare
  v_transfer public.stock_transfers%rowtype;
  v_from_branch uuid;
begin
  select * into v_transfer from public.stock_transfers where id = p_transfer_id;
  if v_transfer.id is null then raise exception 'Transfer not found'; end if;
  if v_transfer.status not in ('pending', 'approved') then
    raise exception 'Only a pending or approved transfer can be cancelled';
  end if;

  select u.branch_id into v_from_branch
  from public.users u
  where u.id = (select auth.uid()) and u.is_active and u.role in ('owner', 'manager');
  if v_from_branch is null or v_from_branch <> v_transfer.from_branch_id then
    raise exception 'Only the sending branch may cancel this transfer';
  end if;

  update public.stock_transfers set status = 'cancelled' where id = p_transfer_id;

  update public.stock_transfer_offers o
  set status = 'denied', denial_reason = 'The sending branch cancelled the arranged transfer'
  from public.stock_transfer_needs n
  where n.transfer_id = p_transfer_id and o.need_id = n.id and o.status = 'accepted';

  update public.stock_transfer_needs set status = 'open', transfer_id = null where transfer_id = p_transfer_id;
end;
$function$
;

revoke all on function public.cancel_stock_transfer(p_transfer_id uuid) from public, anon;
grant execute on function public.cancel_stock_transfer(p_transfer_id uuid) to authenticated;

-- ----------------------------------------------------------------------------

CREATE OR REPLACE FUNCTION public.check_expired_stock(p_branch_id uuid DEFAULT NULL::uuid)
 RETURNS integer
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''
AS $function$
declare
  v_branch uuid := public.effective_branch_id(p_branch_id);
  v_user uuid := (select auth.uid());
  v_flagged integer := 0;
  rec record;
  v_adjustment uuid;
begin
  if v_branch is null then
    return 0;
  end if;

  for rec in
    select bc.id as barcode_id, bc.code, bc.quantity_available, bc.pieces_per_pack,
           sb.id as stock_batch_id, sb.expiry_date, p.name as product_name, pv.dosage
    from public.barcodes bc
    join public.stock_batches sb on sb.id = bc.stock_batch_id
    join public.product_variants pv on pv.id = sb.product_variant_id
    join public.products p on p.id = pv.product_id
    where sb.branch_id = v_branch
      and bc.status = 'active'
      and sb.expiry_date < current_date
    for update of bc
  loop
    update public.barcodes set status = 'expired' where id = rec.barcode_id;

    insert into public.stock_adjustments (stock_batch_id, barcode_id, adjustment_type, quantity, reason, performed_by)
    values (
      rec.stock_batch_id, rec.barcode_id, 'expired_writeoff',
      greatest(coalesce(rec.quantity_available, 0) * coalesce(rec.pieces_per_pack, 1), 1),
      format('Automatically written off -- batch expired on %s', rec.expiry_date),
      v_user
    )
    returning id into v_adjustment;

    insert into public.notifications (branch_id, source_type, source_id, message)
    values (
      v_branch, 'stock_adjustment', v_adjustment,
      format('Expired Writeoff: %s (%s) expired on %s and was automatically written off.',
        concat_ws(' ', rec.product_name, rec.dosage), rec.code, rec.expiry_date)
    );

    v_flagged := v_flagged + 1;
  end loop;

  return v_flagged;
end;
$function$
;

revoke all on function public.check_expired_stock(p_branch_id uuid) from public, anon;
grant execute on function public.check_expired_stock(p_branch_id uuid) to authenticated;

-- ----------------------------------------------------------------------------

CREATE OR REPLACE FUNCTION public.check_expiring_soon_stock()
 RETURNS integer
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''
AS $function$
declare
  v_branch uuid := public.current_branch_id();
  v_threshold integer;
  v_flagged integer := 0;
  rec record;
begin
  if v_branch is null then
    return 0;
  end if;

  select coalesce(expiry_alert_threshold_days, 60) into v_threshold
    from public.branches where id = v_branch;

  for rec in
    select sb.id as stock_batch_id, sb.expiry_date, p.name as product_name, pv.dosage
    from public.stock_batches sb
    join public.product_variants pv on pv.id = sb.product_variant_id
    join public.products p on p.id = pv.product_id
    where sb.branch_id = v_branch
      and sb.expiry_warned_at is null
      and sb.expiry_date >= current_date
      and sb.expiry_date <= current_date + v_threshold
      and exists (
        select 1 from public.barcodes bc
        where bc.stock_batch_id = sb.id and bc.status = 'active' and bc.quantity_available > 0
      )
  loop
    update public.stock_batches set expiry_warned_at = now() where id = rec.stock_batch_id;

    insert into public.notifications (branch_id, source_type, source_id, message)
    values (
      v_branch, 'expiring_soon', rec.stock_batch_id,
      format('%s expires on %s -- consider prioritizing it for sale or requesting a return.',
        concat_ws(' ', rec.product_name, rec.dosage), rec.expiry_date)
    );

    v_flagged := v_flagged + 1;
  end loop;

  return v_flagged;
end;
$function$
;

revoke all on function public.check_expiring_soon_stock() from public, anon;
grant execute on function public.check_expiring_soon_stock() to authenticated;

-- ----------------------------------------------------------------------------

CREATE OR REPLACE FUNCTION public.check_forecast_accuracy_notifications(p_branch_id uuid DEFAULT NULL::uuid)
 RETURNS integer
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''
AS $function$
#variable_conflict use_column
declare
  v_branch uuid := public.effective_branch_id(p_branch_id);
  v_count integer := 0;
  v_snap record;
  v_scope text;
  v_actual numeric;
  v_pct text;
begin
  if v_branch is null then return 0; end if;

  for v_snap in
    select
      s.id, s.product_id, s.category_id, s.generated_at, s.bucket,
      (select min((pt->>'period_start')::date) from jsonb_array_elements(s.points) pt) as period_from,
      (select max(
         case s.bucket
           when 'day' then (pt->>'period_start')::date + 1
           when 'week' then (pt->>'period_start')::date + 7
           else ((pt->>'period_start')::date + interval '1 month')::date
         end
       ) from jsonb_array_elements(s.points) pt) as period_to,
      (select coalesce(sum((pt->>'predicted_revenue')::numeric), 0) from jsonb_array_elements(s.points) pt) as predicted_total
    from public.sales_forecast_snapshots s
    where s.branch_id = v_branch and s.notified_at is null
  loop
    if v_snap.period_to is null or v_snap.period_to > current_date then
      continue;
    end if;

    v_scope := case
      when v_snap.product_id is not null then (select p.name from public.products p where p.id = v_snap.product_id)
      when v_snap.category_id is not null then (select c.name from public.product_categories c where c.id = v_snap.category_id and c.branch_id = v_branch)
      else 'All products'
    end;
    v_scope := coalesce(v_scope, 'All products');

    select coalesce(sum(si.unit_price * si.quantity), 0)
      into v_actual
      from public.sale_items si
      join public.sales s2 on s2.id = si.sale_id
      join public.barcodes bc on bc.id = si.barcode_id
      join public.stock_batches sb on sb.id = bc.stock_batch_id
      join public.product_variants pv on pv.id = sb.product_variant_id
      left join public.branch_product_categorization cat on cat.product_id = pv.product_id and cat.branch_id = v_branch
      where s2.branch_id = v_branch
        and s2.sold_at >= v_snap.period_from::timestamptz
        and s2.sold_at < v_snap.period_to::timestamptz
        and (v_snap.product_id is null or pv.product_id = v_snap.product_id)
        and (v_snap.category_id is null or cat.category_id = v_snap.category_id);

    v_pct := case when v_snap.predicted_total > 0
      then round(100 * v_actual / v_snap.predicted_total)::text || '%'
      else 'n/a'
    end;

    insert into public.notifications (branch_id, source_type, source_id, message)
    values (
      v_branch, 'forecast_completed', v_snap.id,
      format(
        'Forecast for %s (made %s) has completed: predicted RWF %s, actual RWF %s (%s of predicted).',
        v_scope, to_char(v_snap.generated_at, 'YYYY-MM-DD'),
        to_char(v_snap.predicted_total, 'FM999,999,999'), to_char(v_actual, 'FM999,999,999'), v_pct
      )
    );

    update public.sales_forecast_snapshots set notified_at = now() where id = v_snap.id;
    v_count := v_count + 1;
  end loop;

  return v_count;
end;
$function$
;

revoke all on function public.check_forecast_accuracy_notifications(p_branch_id uuid) from public, anon;
grant execute on function public.check_forecast_accuracy_notifications(p_branch_id uuid) to authenticated;

-- ----------------------------------------------------------------------------

CREATE OR REPLACE FUNCTION public.check_license_expiry(p_branch_id uuid DEFAULT NULL::uuid)
 RETURNS integer
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''
AS $function$
declare
  v_branch uuid := public.effective_branch_id(p_branch_id);
  v_expiry date;
  v_days_left integer;
  v_last record;
begin
  if v_branch is null then
    return 0;
  end if;

  select license_expiry_date into v_expiry from public.branches where id = v_branch;
  if v_expiry is null then
    return 0;
  end if;

  v_days_left := v_expiry - current_date;
  if v_days_left > 90 then
    return 0;
  end if;

  select id, is_read, created_at into v_last
    from public.notifications
    where branch_id = v_branch and source_type = 'license_expiring'
    order by created_at desc
    limit 1;

  if not found or (v_last.is_read and v_last.created_at < now() - interval '1 day') then
    insert into public.notifications (branch_id, source_type, source_id, message)
    values (
      v_branch, 'license_expiring', v_branch,
      case when v_days_left < 0
        then format('Pharmacy license expired %s day(s) ago (on %s). Renew as soon as possible.', abs(v_days_left), v_expiry)
        else format('Pharmacy license expires in %s day(s) (on %s).', v_days_left, v_expiry)
      end
    );
    return 1;
  end if;

  return 0;
end;
$function$
;

revoke all on function public.check_license_expiry(p_branch_id uuid) from public, anon;
grant execute on function public.check_license_expiry(p_branch_id uuid) to authenticated;

-- ----------------------------------------------------------------------------

CREATE OR REPLACE FUNCTION public.check_low_stock_alerts()
 RETURNS integer
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''
AS $function$
declare
  v_branch uuid := public.current_branch_id();
  v_interval interval;
  v_default_reorder_min integer;
  v_created integer := 0;
  rec record;
  v_last record;
begin
  if v_branch is null then
    return 0;
  end if;

  select (out_of_stock_reminder_hours || ' hours')::interval, default_reorder_min
    into v_interval, v_default_reorder_min
    from public.branches where id = v_branch;

  for rec in
    with stock as (
      select
        pv.id as variant_id, p.name as product_name, pv.dosage,
        coalesce(sum(bc.quantity_available * bc.pieces_per_pack) filter (where bc.barcode_type = 'pack'), 0) as qty_available,
        coalesce(rp.min_quantity, v_default_reorder_min) as min_quantity
      from public.stock_batches sb
      join public.product_variants pv on pv.id = sb.product_variant_id
      join public.products p on p.id = pv.product_id
      left join public.barcodes bc on bc.stock_batch_id = sb.id
      left join public.reorder_points rp on rp.product_id = pv.product_id and rp.branch_id = v_branch
      where sb.branch_id = v_branch
      group by pv.id, p.name, pv.dosage, rp.min_quantity
    )
    select variant_id, product_name, dosage, qty_available, min_quantity
    from stock
    where qty_available > 0 and qty_available < min_quantity
  loop
    select id, is_read, created_at into v_last
      from public.notifications
      where branch_id = v_branch and source_type = 'low_stock' and source_id = rec.variant_id
      order by created_at desc
      limit 1;

    if not found then
      insert into public.notifications (branch_id, source_type, source_id, message)
      values (
        v_branch, 'low_stock', rec.variant_id,
        format('%s is below its reorder point (%s left, minimum %s).', concat_ws(' ', rec.product_name, rec.dosage), rec.qty_available, rec.min_quantity)
      );
      v_created := v_created + 1;
    elsif v_last.is_read and v_last.created_at < now() - v_interval then
      insert into public.notifications (branch_id, source_type, source_id, message)
      values (
        v_branch, 'low_stock', rec.variant_id,
        format('%s is still below its reorder point (%s left, minimum %s).', concat_ws(' ', rec.product_name, rec.dosage), rec.qty_available, rec.min_quantity)
      );
      v_created := v_created + 1;
    end if;
  end loop;

  return v_created;
end;
$function$
;

revoke all on function public.check_low_stock_alerts() from public, anon;
grant execute on function public.check_low_stock_alerts() to authenticated;

-- ----------------------------------------------------------------------------

CREATE OR REPLACE FUNCTION public.check_missing_branch_location()
 RETURNS integer
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''
AS $function$
declare
  v_branch uuid := public.current_branch_id();
  v_has_location boolean;
  v_is_active boolean;
  v_last record;
begin
  if v_branch is null then
    return 0;
  end if;

  select (b.latitude is not null and b.longitude is not null), b.status = 'active'
    into v_has_location, v_is_active
    from public.branches b where b.id = v_branch;

  if v_has_location or not v_is_active then
    return 0;
  end if;

  select id, is_read, created_at into v_last
    from public.notifications
    where branch_id = v_branch and source_type = 'branch_location_missing' and source_id = v_branch
    order by created_at desc
    limit 1;

  if not found or (v_last.is_read and v_last.created_at < now() - interval '7 days') then
    insert into public.notifications (branch_id, source_type, source_id, message)
    values (
      v_branch, 'branch_location_missing', v_branch,
      'Set this branch''s location in Branch Settings so nearby sibling branches can be found for stock transfer requests.'
    );
    return 1;
  end if;

  return 0;
end;
$function$
;

revoke all on function public.check_missing_branch_location() from public, anon;
grant execute on function public.check_missing_branch_location() to authenticated;

-- ----------------------------------------------------------------------------

CREATE OR REPLACE FUNCTION public.check_missing_reorder_points()
 RETURNS integer
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''
AS $function$
declare
  v_branch uuid := public.current_branch_id();
  v_created integer := 0;
  rec record;
  v_last record;
begin
  if v_branch is null then
    return 0;
  end if;

  for rec in
    select distinct p.id as product_id, p.name as product_name
    from public.stock_batches sb
    join public.product_variants pv on pv.id = sb.product_variant_id
    join public.products p on p.id = pv.product_id
    where sb.branch_id = v_branch
      and not exists (
        select 1 from public.reorder_points rp
        where rp.product_id = p.id and rp.branch_id = v_branch
      )
  loop
    select id, is_read, created_at into v_last
      from public.notifications
      where branch_id = v_branch and source_type = 'reorder_point_missing' and source_id = rec.product_id
      order by created_at desc
      limit 1;

    if not found or (v_last.is_read and v_last.created_at < now() - interval '7 days') then
      insert into public.notifications (branch_id, source_type, source_id, message)
      values (
        v_branch, 'reorder_point_missing', rec.product_id,
        format('%s has no reorder point set for this branch -- set one so low-stock alerts work for it.', rec.product_name)
      );
      v_created := v_created + 1;
    end if;
  end loop;

  return v_created;
end;
$function$
;

revoke all on function public.check_missing_reorder_points() from public, anon;
grant execute on function public.check_missing_reorder_points() to authenticated;

-- ----------------------------------------------------------------------------

CREATE OR REPLACE FUNCTION public.check_out_of_stock_alerts(p_branch_id uuid DEFAULT NULL::uuid)
 RETURNS integer
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''
AS $function$
declare
  v_branch uuid := public.effective_branch_id(p_branch_id);
  v_interval interval;
  v_created integer := 0;
  rec record;
  v_last record;
begin
  if v_branch is null then
    return 0;
  end if;

  select (out_of_stock_reminder_hours || ' hours')::interval into v_interval
    from public.branches where id = v_branch;

  for rec in
    select pv.id as variant_id, p.name as product_name, pv.dosage
    from public.stock_batches sb
    join public.product_variants pv on pv.id = sb.product_variant_id
    join public.products p on p.id = pv.product_id
    left join public.barcodes bc on bc.stock_batch_id = sb.id and bc.barcode_type = 'pack'
    where sb.branch_id = v_branch
    group by pv.id, p.name, pv.dosage
    having coalesce(sum(bc.quantity_available * bc.pieces_per_pack), 0) = 0
  loop
    select id, is_read, created_at into v_last
      from public.notifications
      where branch_id = v_branch and source_type = 'out_of_stock' and source_id = rec.variant_id
      order by created_at desc
      limit 1;

    if not found then
      insert into public.notifications (branch_id, source_type, source_id, message)
      values (v_branch, 'out_of_stock', rec.variant_id, format('%s is out of stock.', concat_ws(' ', rec.product_name, rec.dosage)));
      v_created := v_created + 1;
    elsif v_last.is_read and v_last.created_at < now() - v_interval then
      insert into public.notifications (branch_id, source_type, source_id, message)
      values (v_branch, 'out_of_stock', rec.variant_id, format('%s is still out of stock.', concat_ws(' ', rec.product_name, rec.dosage)));
      v_created := v_created + 1;
    end if;
  end loop;

  return v_created;
end;
$function$
;

revoke all on function public.check_out_of_stock_alerts(p_branch_id uuid) from public, anon;
grant execute on function public.check_out_of_stock_alerts(p_branch_id uuid) to authenticated;

-- ----------------------------------------------------------------------------

CREATE OR REPLACE FUNCTION public.check_restock_recommendations(p_branch_id uuid DEFAULT NULL::uuid)
 RETURNS integer
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''
AS $function$
declare
  v_branch uuid := public.effective_branch_id(p_branch_id);
  v_created integer := 0;
  rec record;
  v_last record;
begin
  if v_branch is null then
    return 0;
  end if;

  for rec in
    with recent_sales as (
      select
        pv.id as variant_id,
        sum(si.quantity)::numeric / 30 as avg_daily_qty,
        count(distinct date_trunc('day', s.sold_at)) as active_days
      from public.sale_items si
      join public.sales s on s.id = si.sale_id
      join public.barcodes bc on bc.id = si.barcode_id
      join public.stock_batches sb on sb.id = bc.stock_batch_id
      join public.product_variants pv on pv.id = sb.product_variant_id
      where s.branch_id = v_branch and s.sold_at >= now() - interval '30 days'
      group by pv.id
      having count(distinct date_trunc('day', s.sold_at)) >= 3
    ),
    stock as (
      select
        pv.id as variant_id, p.name as product_name, pv.dosage,
        coalesce(sum(bc.quantity_available * bc.pieces_per_pack) filter (where bc.barcode_type = 'pack'), 0)::integer as qty_available
      from public.stock_batches sb
      join public.product_variants pv on pv.id = sb.product_variant_id
      join public.products p on p.id = pv.product_id
      left join public.barcodes bc on bc.stock_batch_id = sb.id
      where sb.branch_id = v_branch
      group by pv.id, p.name, pv.dosage
    )
    select
      rs.variant_id, st.product_name, st.dosage, rs.avg_daily_qty, st.qty_available,
      (st.qty_available / rs.avg_daily_qty) as days_to_stockout
    from recent_sales rs
    join stock st on st.variant_id = rs.variant_id
    where rs.avg_daily_qty > 0 and st.qty_available > 0
      and st.qty_available / rs.avg_daily_qty <= 14
  loop
    select id, is_read, created_at into v_last
      from public.notifications
      where branch_id = v_branch and source_type = 'restock_recommendation' and source_id = rec.variant_id
      order by created_at desc
      limit 1;

    if not found or (v_last.is_read and v_last.created_at < now() - interval '24 hours') then
      insert into public.notifications (branch_id, source_type, source_id, message)
      values (
        v_branch, 'restock_recommendation', rec.variant_id,
        format('%s is one of your best sellers (~%s/day) and will run out in about %s days at this pace -- restock soon.',
          concat_ws(' ', rec.product_name, rec.dosage), round(rec.avg_daily_qty, 1), round(rec.days_to_stockout))
      );
      v_created := v_created + 1;
    end if;
  end loop;

  return v_created;
end;
$function$
;

revoke all on function public.check_restock_recommendations(p_branch_id uuid) from public, anon;
grant execute on function public.check_restock_recommendations(p_branch_id uuid) to authenticated;

-- ----------------------------------------------------------------------------

CREATE OR REPLACE FUNCTION public.complete_sale(p_lines jsonb, p_insurance_provider_id uuid DEFAULT NULL::uuid, p_patient_id uuid DEFAULT NULL::uuid, p_payment_method text DEFAULT NULL::text, p_discount_id uuid DEFAULT NULL::uuid, p_branch_id uuid DEFAULT NULL::uuid, p_bargain_final_price numeric DEFAULT NULL::numeric, p_patient_coverage_percentage numeric DEFAULT NULL::numeric)
 RETURNS TABLE(sale_id uuid, receipt_number text, total_amount numeric, insurance_covered_total numeric, patient_owed_total numeric)
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''
AS $function$
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
  v_effective_price numeric;
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
  perform public.assert_can_manage_org_branch_or_own(v_branch, public.current_branch_id());
  if exists (select 1 from public.branches b where b.id = v_branch and b.status <> 'active') then
    raise exception 'This pharmacy is not active';
  end if;
  if jsonb_typeof(p_lines) <> 'array' or jsonb_array_length(p_lines) = 0 then
    raise exception 'At least one item is required to complete a sale';
  end if;

  if p_payment_method is not null and p_payment_method not in ('cash','mtn_momo','airtel_money','card') then
    raise exception 'Unsupported payment method %', p_payment_method;
  end if;

  if p_bargain_final_price is not null then
    if p_insurance_provider_id is not null then
      raise exception 'A bargained price only applies to walk-in sales, not insurance sales';
    end if;
    if p_discount_id is not null then
      raise exception 'Use either a bargained price or a discount code, not both';
    end if;
    if p_bargain_final_price < 0 then
      raise exception 'Bargained price cannot be negative';
    end if;
  end if;

  if p_patient_coverage_percentage is not null then
    if p_insurance_provider_id is null then
      raise exception 'A patient coverage percentage only applies to an insurance sale';
    end if;
    if p_patient_coverage_percentage < 0 or p_patient_coverage_percentage > 100 then
      raise exception 'Patient coverage percentage must be between 0 and 100';
    end if;
  end if;

  if p_insurance_provider_id is not null then
    select name into v_provider_name from public.insurance_providers where id = p_insurance_provider_id;
    if v_provider_name is null then raise exception 'Unknown insurance provider'; end if;
    if p_patient_id is null then
      raise exception 'A patient must be recorded for an insurance sale';
    end if;
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
    elsif p_patient_coverage_percentage is not null then
      -- Pharmacist-entered override for this specific sale/patient visit --
      -- real coverage varies by the PATIENT'S own plan, not by product, so
      -- this takes priority over any per-product/provider default below.
      v_coverage_pct := 100 - p_patient_coverage_percentage;
    else
      select coverage_percentage into v_coverage_pct
        from public.insurance_product_coverage
        where insurance_provider_id = p_insurance_provider_id and product_id = v_product_id;
      if v_coverage_pct is null then
        select default_coverage_percentage into v_coverage_pct
          from public.insurance_providers where id = p_insurance_provider_id;
      end if;
    end if;

    -- Fixed insurance price, if one is on file for this exact provider +
    -- variant; otherwise the normal walk-in price, unchanged.
    if p_insurance_provider_id is null then
      v_effective_price := v_barcode.selling_price;
    else
      select fixed_price into v_effective_price
        from public.insurance_variant_prices
        where insurance_provider_id = p_insurance_provider_id and product_variant_id = v_barcode.product_variant_id;
      if v_effective_price is null then
        v_effective_price := v_barcode.selling_price;
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

      v_line_total := v_effective_price * v_child_quantity;
      v_tax_amount := round(v_line_total * coalesce(v_tax_pct, 0) / (100 + coalesce(v_tax_pct, 0)), 2);
      v_subtotal := v_line_total - v_tax_amount;
      v_line_covered := round(v_line_total * coalesce(v_coverage_pct, 0) / 100, 2);

      insert into public.sale_items (sale_id, barcode_id, tax_rate_id, quantity, unit_price, subtotal, insurance_covered_amount)
      values (v_sale, v_barcode.id, v_tax_rate_id, v_child_quantity, v_effective_price, v_subtotal, v_line_covered);

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
          v_line_total := v_effective_price * v_child.pieces_per_pack;
          v_tax_amount := round(v_line_total * coalesce(v_tax_pct, 0) / (100 + coalesce(v_tax_pct, 0)), 2);
          v_subtotal := v_line_total - v_tax_amount;
          v_line_covered := round(v_line_total * coalesce(v_coverage_pct, 0) / 100, 2);

          insert into public.sale_items (sale_id, barcode_id, tax_rate_id, quantity, unit_price, subtotal, insurance_covered_amount)
          values (v_sale, v_child.id, v_tax_rate_id, v_child.pieces_per_pack, v_effective_price, v_subtotal, v_line_covered);

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
          v_line_total := v_effective_price * v_child.pieces_per_pack;
          v_tax_amount := round(v_line_total * coalesce(v_tax_pct, 0) / (100 + coalesce(v_tax_pct, 0)), 2);
          v_subtotal := v_line_total - v_tax_amount;
          v_line_covered := round(v_line_total * coalesce(v_coverage_pct, 0) / 100, 2);

          insert into public.sale_items (sale_id, barcode_id, tax_rate_id, quantity, unit_price, subtotal, insurance_covered_amount)
          values (v_sale, v_child.id, v_tax_rate_id, v_child.pieces_per_pack, v_effective_price, v_subtotal, v_line_covered);

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

        v_line_total := v_effective_price * v_quantity;
        v_tax_amount := round(v_line_total * coalesce(v_tax_pct, 0) / (100 + coalesce(v_tax_pct, 0)), 2);
        v_subtotal := v_line_total - v_tax_amount;
        v_line_covered := round(v_line_total * coalesce(v_coverage_pct, 0) / 100, 2);

        insert into public.sale_items (sale_id, barcode_id, tax_rate_id, quantity, unit_price, subtotal, insurance_covered_amount)
        values (v_sale, v_child.id, v_tax_rate_id, v_quantity, v_effective_price, v_subtotal, v_line_covered);

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
  elsif p_bargain_final_price is not null then
    -- v_covered_total is always 0 here (insurance + bargain are mutually
    -- exclusive, enforced above), so this is just v_total - the agreed price.
    v_discount_amount := greatest(v_total - p_bargain_final_price, 0);
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
$function$
;

revoke all on function public.complete_sale(p_lines jsonb, p_insurance_provider_id uuid, p_patient_id uuid, p_payment_method text, p_discount_id uuid, p_branch_id uuid, p_bargain_final_price numeric, p_patient_coverage_percentage numeric) from public, anon;
grant execute on function public.complete_sale(p_lines jsonb, p_insurance_provider_id uuid, p_patient_id uuid, p_payment_method text, p_discount_id uuid, p_branch_id uuid, p_bargain_final_price numeric, p_patient_coverage_percentage numeric) to authenticated;

-- ----------------------------------------------------------------------------

CREATE OR REPLACE FUNCTION public.count_active_batch_units(p_stock_batch_id uuid)
 RETURNS integer
 LANGUAGE sql
 STABLE SECURITY DEFINER
 SET search_path TO ''
AS $function$
  select count(*)::integer
  from public.barcodes bc
  join public.stock_batches sb on sb.id = bc.stock_batch_id
  where bc.stock_batch_id = p_stock_batch_id
    and bc.status = 'active'
    and bc.parent_barcode_id is null
    and (
      public.is_super_admin()
      or sb.branch_id = public.current_branch_id()
      or exists (
        select 1 from public.organization_members om
        join public.branches b on b.organization_id = om.organization_id
        where om.user_id = (select auth.uid()) and b.id = sb.branch_id
      )
    )
$function$
;

revoke all on function public.count_active_batch_units(p_stock_batch_id uuid) from public, anon;
grant execute on function public.count_active_batch_units(p_stock_batch_id uuid) to authenticated;

-- ----------------------------------------------------------------------------

CREATE OR REPLACE FUNCTION public.create_branch_category(p_name text, p_description text DEFAULT NULL::text, p_branch_id uuid DEFAULT NULL::uuid)
 RETURNS uuid
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''
AS $function$
declare
  v_branch uuid := public.effective_branch_id(p_branch_id);
  v_id uuid;
  v_name text := btrim(p_name);
  v_description text := nullif(btrim(coalesce(p_description, '')), '');
begin
  perform public.assert_owner_or_manager();
  perform public.assert_can_manage_org_branch_or_own(v_branch, public.current_branch_id());
  if v_branch is null then raise exception 'No active branch for this session'; end if;
  if nullif(v_name, '') is null then raise exception 'A category name is required'; end if;

  insert into public.product_categories (branch_id, name, description)
  values (v_branch, v_name, v_description)
  returning id into v_id;

  insert into public.product_categories (branch_id, name, description)
  select b.id, v_name, v_description
  from public.branches b
  where b.organization_id is not null
    and b.organization_id = (select organization_id from public.branches where id = v_branch)
    and b.id <> v_branch
  on conflict (branch_id, name) do nothing;

  return v_id;
exception
  when unique_violation then
    raise exception 'A category named "%" already exists for this branch.', v_name;
end;
$function$
;

revoke all on function public.create_branch_category(p_name text, p_description text, p_branch_id uuid) from public, anon;
grant execute on function public.create_branch_category(p_name text, p_description text, p_branch_id uuid) to authenticated;

-- ----------------------------------------------------------------------------

CREATE OR REPLACE FUNCTION public.create_branch_discount(p_name text, p_discount_type text, p_value numeric, p_valid_from date DEFAULT NULL::date, p_valid_to date DEFAULT NULL::date, p_branch_id uuid DEFAULT NULL::uuid)
 RETURNS uuid
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''
AS $function$
declare
  v_branch uuid;
  v_id uuid;
begin
  perform public.assert_owner_or_manager();
  v_branch := public.effective_branch_id(p_branch_id);
  perform public.assert_can_manage_org_branch_or_own(v_branch, public.current_branch_id());
  if p_discount_type not in ('percentage','fixed') then
    raise exception 'Discount type must be percentage or fixed';
  end if;
  if p_value < 0 or (p_discount_type = 'percentage' and p_value > 100) then
    raise exception 'Invalid discount value';
  end if;

  insert into public.discounts (name, discount_type, value, valid_from, valid_to, branch_id)
  values (btrim(p_name), p_discount_type, p_value, p_valid_from, p_valid_to, v_branch)
  returning id into v_id;

  return v_id;
end;
$function$
;

revoke all on function public.create_branch_discount(p_name text, p_discount_type text, p_value numeric, p_valid_from date, p_valid_to date, p_branch_id uuid) from public, anon;
grant execute on function public.create_branch_discount(p_name text, p_discount_type text, p_value numeric, p_valid_from date, p_valid_to date, p_branch_id uuid) to authenticated;

-- ----------------------------------------------------------------------------

CREATE OR REPLACE FUNCTION public.create_org_manager_login(p_user_id uuid, p_branch_id uuid, p_full_name text, p_email text, p_organization_id uuid)
 RETURNS void
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''
AS $function$
begin
  insert into public.users (id, branch_id, full_name, email, role, is_active)
  values (p_user_id, p_branch_id, p_full_name, p_email, 'manager', true);

  insert into public.organization_members (organization_id, user_id, role)
  values (p_organization_id, p_user_id, 'org_manager');
end;
$function$
;

revoke all on function public.create_org_manager_login(p_user_id uuid, p_branch_id uuid, p_full_name text, p_email text, p_organization_id uuid) from public, anon;
grant execute on function public.create_org_manager_login(p_user_id uuid, p_branch_id uuid, p_full_name text, p_email text, p_organization_id uuid) to authenticated;

-- ----------------------------------------------------------------------------

CREATE OR REPLACE FUNCTION public.create_organization_invite(p_organization_id uuid, p_branch_id uuid, p_email text, p_full_name text, p_role text)
 RETURNS void
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''
AS $function$
declare
  v_caller uuid := (select auth.uid());
begin
  if p_role not in ('org_owner', 'org_manager', 'owner', 'manager', 'seller') then
    raise exception 'Unrecognized role for an organization invite';
  end if;
  if not exists (select 1 from public.branches where id = p_branch_id and organization_id = p_organization_id) then
    raise exception 'That branch does not belong to this organization';
  end if;
  if nullif(btrim(coalesce(p_email, '')), '') is null then
    raise exception 'An email address is required';
  end if;
  if nullif(btrim(coalesce(p_full_name, '')), '') is null then
    raise exception 'A full name is required';
  end if;

  insert into public.organization_invites (organization_id, branch_id, email, full_name, role, invited_by, otp_sent_at, status)
  values (p_organization_id, p_branch_id, lower(btrim(p_email)), btrim(p_full_name), p_role, v_caller, now(), 'otp_sent')
  on conflict (organization_id, lower(email)) where status = 'otp_sent'
  do update set branch_id = excluded.branch_id, full_name = excluded.full_name, role = excluded.role, otp_sent_at = now();
end;
$function$
;

revoke all on function public.create_organization_invite(p_organization_id uuid, p_branch_id uuid, p_email text, p_full_name text, p_role text) from public, anon;
grant execute on function public.create_organization_invite(p_organization_id uuid, p_branch_id uuid, p_email text, p_full_name text, p_role text) to authenticated;

-- ----------------------------------------------------------------------------

CREATE OR REPLACE FUNCTION public.create_pending_payment(p_lines jsonb, p_payment_method text, p_insurance_provider_id uuid DEFAULT NULL::uuid, p_patient_id uuid DEFAULT NULL::uuid, p_patient_phone text DEFAULT NULL::text, p_discount_id uuid DEFAULT NULL::uuid, p_branch_id uuid DEFAULT NULL::uuid, p_provider text DEFAULT 'pesapal'::text)
 RETURNS TABLE(pending_payment_id uuid, merchant_reference text, amount numeric)
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''
AS $function$
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
$function$
;

revoke all on function public.create_pending_payment(p_lines jsonb, p_payment_method text, p_insurance_provider_id uuid, p_patient_id uuid, p_patient_phone text, p_discount_id uuid, p_branch_id uuid, p_provider text) from public, anon;
grant execute on function public.create_pending_payment(p_lines jsonb, p_payment_method text, p_insurance_provider_id uuid, p_patient_id uuid, p_patient_phone text, p_discount_id uuid, p_branch_id uuid, p_provider text) to authenticated;

-- ----------------------------------------------------------------------------

CREATE OR REPLACE FUNCTION public.create_pharmacy_organization(p_legal_name text, p_tin text DEFAULT NULL::text)
 RETURNS uuid
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''
AS $function$
declare
  v_user uuid := (select auth.uid());
  v_branch uuid;
  v_org uuid;
begin
  select u.branch_id into v_branch
  from public.users u
  where u.id = v_user and u.is_active and u.role = 'owner';
  if v_branch is null then
    raise exception 'Only an active branch owner may create a pharmacy organization';
  end if;

  if exists (select 1 from public.branches where id = v_branch and organization_id is not null) then
    raise exception 'This branch already belongs to an organization';
  end if;
  if nullif(btrim(coalesce(p_legal_name, '')), '') is null then
    raise exception 'A company/legal name is required';
  end if;

  insert into public.pharmacy_organizations (legal_name, tin)
  values (btrim(p_legal_name), nullif(btrim(coalesce(p_tin, '')), ''))
  returning id into v_org;

  update public.branches set organization_id = v_org where id = v_branch;

  insert into public.organization_members (organization_id, user_id, role)
  values (v_org, v_user, 'org_owner');

  return v_org;
end;
$function$
;

revoke all on function public.create_pharmacy_organization(p_legal_name text, p_tin text) from public, anon;
grant execute on function public.create_pharmacy_organization(p_legal_name text, p_tin text) to authenticated;

-- ----------------------------------------------------------------------------

CREATE OR REPLACE FUNCTION public.create_stock_batch_with_barcodes(p_variant uuid, p_branch uuid, p_supplier uuid, p_manufacturer text, p_delivery uuid, p_delivery_code text, p_user uuid, p_batch_number text, p_expiry date, p_cost numeric, p_sell numeric, p_cartons integer, p_packs integer, p_pieces integer)
 RETURNS uuid
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''
AS $function$
declare
  v_batch uuid;
  v_parent uuid;
  i integer;
  j integer;
begin
  insert into public.stock_batches (
    product_variant_id, branch_id, supplier_id, manufacturer_name, delivery_id, delivery_code,
    logged_by, batch_number, expiry_date, cost_price, selling_price, quantity_received
  ) values (
    p_variant, p_branch, p_supplier, p_manufacturer, p_delivery, p_delivery_code, p_user,
    p_batch_number, p_expiry, p_cost, p_sell,
    case when p_cartons > 0 then p_cartons * p_packs * p_pieces else p_packs * p_pieces end
  )
  returning id into v_batch;

  if p_cartons > 0 then
    for i in 1..p_cartons loop
      insert into public.barcodes (stock_batch_id, barcode_type, code, code_source, child_count, quantity_available)
      values (v_batch, 'box', public.generate_short_barcode_code(), 'generated', p_packs, 1)
      returning id into v_parent;
      for j in 1..p_packs loop
        insert into public.barcodes (stock_batch_id, parent_barcode_id, barcode_type, code, code_source, pieces_per_pack, quantity_available)
        values (v_batch, v_parent, 'pack', public.generate_short_barcode_code(), 'generated', p_pieces, 1);
      end loop;
    end loop;
  else
    for j in 1..p_packs loop
      insert into public.barcodes (stock_batch_id, barcode_type, code, code_source, pieces_per_pack, quantity_available)
      values (v_batch, 'pack', public.generate_short_barcode_code(), 'generated', p_pieces, 1);
    end loop;
  end if;

  return v_batch;
end;
$function$
;

revoke all on function public.create_stock_batch_with_barcodes(p_variant uuid, p_branch uuid, p_supplier uuid, p_manufacturer text, p_delivery uuid, p_delivery_code text, p_user uuid, p_batch_number text, p_expiry date, p_cost numeric, p_sell numeric, p_cartons integer, p_packs integer, p_pieces integer) from public, anon;
grant execute on function public.create_stock_batch_with_barcodes(p_variant uuid, p_branch uuid, p_supplier uuid, p_manufacturer text, p_delivery uuid, p_delivery_code text, p_user uuid, p_batch_number text, p_expiry date, p_cost numeric, p_sell numeric, p_cartons integer, p_packs integer, p_pieces integer) to authenticated;

-- ----------------------------------------------------------------------------

CREATE OR REPLACE FUNCTION public.create_storage_location(p_name text)
 RETURNS uuid
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''
AS $function$
                                              declare
                                                v_branch uuid := public.current_branch_id();
                                                  v_id uuid;
                                                  begin
                                                    perform public.assert_owner_or_manager();
                                                      if v_branch is null then raise exception 'No active branch for this session'; end if;
                                                        if nullif(btrim(coalesce(p_name, '')), '') is null then raise exception 'A location name is required'; end if;

                                                          select id into v_id from public.storage_locations
                                                              where branch_id = v_branch and lower(name) = lower(btrim(p_name));
                                                                if v_id is not null then return v_id; end if;

                                                                  insert into public.storage_locations (branch_id, name) values (v_branch, btrim(p_name))
                                                                    returning id into v_id;
                                                                      return v_id;
                                                                      end;
                                                                      $function$
;

revoke all on function public.create_storage_location(p_name text) from public, anon;
grant execute on function public.create_storage_location(p_name text) to authenticated;

-- ----------------------------------------------------------------------------

CREATE OR REPLACE FUNCTION public.current_accessible_branch_ids()
 RETURNS SETOF uuid
 LANGUAGE sql
 STABLE SECURITY DEFINER
 SET search_path TO ''
AS $function$
  select b.id
  from public.branches b
  where b.id = public.current_branch_id()
  union
  select b2.id
  from public.branches b2
  where b2.organization_id in (
    select m.organization_id
    from public.organization_members m
    where m.user_id = (select auth.uid())
  )
$function$
;

revoke all on function public.current_accessible_branch_ids() from public, anon;
grant execute on function public.current_accessible_branch_ids() to authenticated;

-- ----------------------------------------------------------------------------

CREATE OR REPLACE FUNCTION public.current_branch_id()
 RETURNS uuid
 LANGUAGE sql
 STABLE SECURITY DEFINER
 SET search_path TO ''
AS $function$
    select u.branch_id
    from public.users u
    where u.id = (select auth.uid())
      and u.is_active
  $function$
;

revoke all on function public.current_branch_id() from public, anon;
grant execute on function public.current_branch_id() to authenticated;

-- ----------------------------------------------------------------------------

CREATE OR REPLACE FUNCTION public.delete_branch_distance_measurement(p_id uuid)
 RETURNS void
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''
AS $function$
declare
  v_org_id uuid;
begin
  select organization_id into v_org_id from public.branch_distance_measurements where id = p_id;
  if v_org_id is null then
    return;
  end if;
  if not public.is_org_member(v_org_id) then
    raise exception 'Not authorized for this organization';
  end if;
  delete from public.branch_distance_measurements where id = p_id;
end;
$function$
;

revoke all on function public.delete_branch_distance_measurement(p_id uuid) from public, anon;
grant execute on function public.delete_branch_distance_measurement(p_id uuid) to authenticated;

-- ----------------------------------------------------------------------------

CREATE OR REPLACE FUNCTION public.delete_storage_location(p_id uuid)
 RETURNS void
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''
AS $function$
                                                                                  declare
                                                                                    v_branch uuid := public.current_branch_id();
                                                                                    begin
                                                                                      perform public.assert_owner_or_manager();
                                                                                        delete from public.storage_locations where id = p_id and branch_id = v_branch;
                                                                                        end;
                                                                                        $function$
;

revoke all on function public.delete_storage_location(p_id uuid) from public, anon;
grant execute on function public.delete_storage_location(p_id uuid) to authenticated;

-- ----------------------------------------------------------------------------

CREATE OR REPLACE FUNCTION public.dispatch_stock_transfer(p_transfer_id uuid)
 RETURNS void
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''
AS $function$
declare
  v_transfer public.stock_transfers%rowtype;
  v_from_branch uuid;
begin
  select * into v_transfer from public.stock_transfers where id = p_transfer_id;
  if v_transfer.id is null then raise exception 'Transfer not found'; end if;
  if v_transfer.status <> 'approved' then raise exception 'Only an approved transfer can be dispatched'; end if;

  select u.branch_id into v_from_branch
  from public.users u
  where u.id = (select auth.uid()) and u.is_active and u.role in ('owner', 'manager');
  if v_from_branch is null or v_from_branch <> v_transfer.from_branch_id then
    raise exception 'Only the sending branch may dispatch this transfer';
  end if;

  update public.barcodes
  set status = 'in_transit'
  where status = 'active'
    and stock_batch_id in (select stock_batch_id from public.stock_transfer_items where transfer_id = p_transfer_id);

  update public.stock_transfers set status = 'in_transit', dispatched_at = now() where id = p_transfer_id;
end;
$function$
;

revoke all on function public.dispatch_stock_transfer(p_transfer_id uuid) from public, anon;
grant execute on function public.dispatch_stock_transfer(p_transfer_id uuid) to authenticated;

-- ----------------------------------------------------------------------------

CREATE OR REPLACE FUNCTION public.effective_branch_id(p_branch_id uuid)
 RETURNS uuid
 LANGUAGE plpgsql
 STABLE SECURITY DEFINER
 SET search_path TO ''
AS $function$
declare
  v_org_id uuid;
begin
  if p_branch_id is null then
    return public.current_branch_id();
  end if;

  select organization_id into v_org_id from public.branches where id = p_branch_id;
  if v_org_id is null then
    raise exception 'Unknown branch';
  end if;

  perform public.assert_org_member(v_org_id);
  return p_branch_id;
end;
$function$
;

revoke all on function public.effective_branch_id(p_branch_id uuid) from public, anon;
grant execute on function public.effective_branch_id(p_branch_id uuid) to authenticated;

-- ----------------------------------------------------------------------------

CREATE OR REPLACE FUNCTION public.enforce_one_manager_per_branch()
 RETURNS trigger
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''
AS $function$
begin
  if new.role <> 'manager' or new.is_active = false then
    return null;
  end if;

  if exists (select 1 from public.organization_members om where om.user_id = new.id and om.role = 'org_manager') then
    return null;
  end if;

  if exists (
    select 1 from public.users u
    where u.branch_id = new.branch_id
      and u.role = 'manager'
      and u.is_active = true
      and u.id <> new.id
      and not exists (select 1 from public.organization_members om where om.user_id = u.id and om.role = 'org_manager')
  ) then
    raise exception 'This branch already has an active manager -- deactivate them first, or assign this person as seller instead';
  end if;

  return null;
end;
$function$
;

revoke all on function public.enforce_one_manager_per_branch() from public, anon;
grant execute on function public.enforce_one_manager_per_branch() to authenticated;

-- ----------------------------------------------------------------------------

CREATE OR REPLACE FUNCTION public.enforce_one_org_manager_per_org()
 RETURNS trigger
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''
AS $function$
begin
  if new.role <> 'org_manager' then
    return null;
  end if;

  if exists (
    select 1 from public.organization_members om
    where om.organization_id = new.organization_id
      and om.role = 'org_manager'
      and om.user_id <> new.user_id
  ) then
    raise exception 'This organization already has an organization manager -- remove them first';
  end if;

  return null;
end;
$function$
;

revoke all on function public.enforce_one_org_manager_per_org() from public, anon;
grant execute on function public.enforce_one_org_manager_per_org() to authenticated;

-- ----------------------------------------------------------------------------

CREATE OR REPLACE FUNCTION public.ensure_default_product_variant(p_product_id uuid)
 RETURNS uuid
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''
AS $function$
declare
  v_variant uuid;
begin
  perform public.assert_owner_or_manager();

  if not exists (select 1 from public.products where id = p_product_id) then
    raise exception 'Unknown product';
  end if;

  select id into v_variant from public.product_variants
  where product_id = p_product_id
  order by created_at
  limit 1;

  if v_variant is not null then
    return v_variant;
  end if;

  insert into public.product_variants (product_id, dosage, form, unit)
  values (p_product_id, null, null, null)
  returning id into v_variant;

  return v_variant;
end;
$function$
;

revoke all on function public.ensure_default_product_variant(p_product_id uuid) from public, anon;
grant execute on function public.ensure_default_product_variant(p_product_id uuid) to authenticated;

-- ----------------------------------------------------------------------------

CREATE OR REPLACE FUNCTION public.expire_stale_pending_payments(p_older_than_minutes integer DEFAULT 15)
 RETURNS integer
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''
AS $function$
declare
  v_count integer;
begin
  update public.pending_payments
  set status = 'expired', failure_reason = 'No confirmation received in time', updated_at = now()
  where status = 'pending' and created_at < now() - make_interval(mins => p_older_than_minutes);
  get diagnostics v_count = row_count;
  return v_count;
end;
$function$
;

revoke all on function public.expire_stale_pending_payments(p_older_than_minutes integer) from public, anon;
grant execute on function public.expire_stale_pending_payments(p_older_than_minutes integer) to authenticated;

-- ----------------------------------------------------------------------------

CREATE OR REPLACE FUNCTION public.find_patient_by_identifier(p_identifier text, p_branch_id uuid DEFAULT NULL::uuid)
 RETURNS TABLE(id uuid, full_name text, gender text, age integer, tin_or_phone text, phone text, tin text, insurance_number text)
 LANGUAGE sql
 STABLE SECURITY DEFINER
 SET search_path TO ''
AS $function$
  select p.id, p.full_name::text, p.gender::text, p.age,
         p.tin_or_phone::text, p.phone::text, p.tin::text, p.insurance_number::text
  from public.patients p
  where p.branch_id = public.effective_branch_id(p_branch_id)
    and (p.tin_or_phone = btrim(p_identifier)
      or p.phone        = btrim(p_identifier)
      or p.tin          = btrim(p_identifier))
  limit 1
$function$
;

revoke all on function public.find_patient_by_identifier(p_identifier text, p_branch_id uuid) from public, anon;
grant execute on function public.find_patient_by_identifier(p_identifier text, p_branch_id uuid) to authenticated;

-- ----------------------------------------------------------------------------

CREATE OR REPLACE FUNCTION public.freeze_expired_organization_application(p_application_id uuid)
 RETURNS void
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''
AS $function$
begin
  update public.organization_applications
  set status = 'denied',
      denied_reason = 'Activation window (3 hours) expired without verification'
  where id = p_application_id
    and status = 'otp_sent'
    and otp_sent_at is not null
    and now() > otp_sent_at + interval '3 hours';
end;
$function$
;

revoke all on function public.freeze_expired_organization_application(p_application_id uuid) from public, anon;
grant execute on function public.freeze_expired_organization_application(p_application_id uuid) to authenticated;

-- ----------------------------------------------------------------------------

CREATE OR REPLACE FUNCTION public.freeze_expired_organization_invite(p_invite_id uuid)
 RETURNS void
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''
AS $function$
begin
  update public.organization_invites
  set status = 'denied',
      denied_reason = 'Activation window (3 hours) expired without verification'
  where id = p_invite_id
    and status = 'otp_sent'
    and now() > otp_sent_at + interval '3 hours';
end;
$function$
;

revoke all on function public.freeze_expired_organization_invite(p_invite_id uuid) from public, anon;
grant execute on function public.freeze_expired_organization_invite(p_invite_id uuid) to authenticated;

-- ----------------------------------------------------------------------------

CREATE OR REPLACE FUNCTION public.freeze_expired_pharmacy_otp(p_application_id uuid)
 RETURNS void
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''
AS $function$
  begin
    update public.branch_applications
    set status = 'denied',
        denied_reason = 'Activation window (3 hours) expired without verification'
    where id = p_application_id
      and status = 'otp_sent'
      and otp_sent_at is not null
      and now() > otp_sent_at + interval '3 hours';
  end;
  $function$
;

revoke all on function public.freeze_expired_pharmacy_otp(p_application_id uuid) from public, anon;
grant execute on function public.freeze_expired_pharmacy_otp(p_application_id uuid) to authenticated;

-- ----------------------------------------------------------------------------

CREATE OR REPLACE FUNCTION public.generate_short_barcode_code()
 RETURNS text
 LANGUAGE plpgsql
AS $function$
  declare
    v_chars text := 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
    v_result text := '';
    i integer;
  begin
    for i in 1..8 loop
      v_result := v_result || substr(v_chars, 1 + floor(random() * length(v_chars))::integer, 1);
    end loop;
    return v_result;
  end;
  $function$
;

revoke all on function public.generate_short_barcode_code() from public, anon;
grant execute on function public.generate_short_barcode_code() to authenticated;

-- ----------------------------------------------------------------------------

CREATE OR REPLACE FUNCTION public.get_my_branch_details(p_branch_id uuid DEFAULT NULL::uuid)
 RETURNS TABLE(name text, address text, phone text, tin text, logo_path text, bank_account_number text, bank_account_name text, momo_pay_number text, out_of_stock_reminder_hours integer, branch_code text, status text, created_at timestamp with time zone, email text, website text, license_number text, license_expiry_date date, ebm_device_serial text, default_language text, receipt_number_prefix text, pos_cash_enabled boolean, pos_mtn_momo_enabled boolean, pos_airtel_money_enabled boolean, pos_card_enabled boolean, pos_insurance_enabled boolean, pos_default_payment_method text, pos_require_patient_name boolean, pos_allow_discounts boolean, pos_show_patient_history boolean, expiry_alert_threshold_days integer, default_reorder_min integer, latitude double precision, longitude double precision, organization_id uuid)
 LANGUAGE sql
 STABLE SECURITY DEFINER
 SET search_path TO ''
AS $function$
  select b.name::text, b.address, b.phone, b.tin, b.logo_path, b.bank_account_number, b.bank_account_name, b.momo_pay_number,
         b.out_of_stock_reminder_hours, b.branch_code::text, b.status::text, b.created_at,
         b.email, b.website, b.license_number, b.license_expiry_date, b.ebm_device_serial, b.default_language::text,
         b.receipt_number_prefix::text, b.pos_cash_enabled, b.pos_mtn_momo_enabled, b.pos_airtel_money_enabled,
         b.pos_card_enabled, b.pos_insurance_enabled, b.pos_default_payment_method::text,
         b.pos_require_patient_name, b.pos_allow_discounts, b.pos_show_patient_history,
         b.expiry_alert_threshold_days, b.default_reorder_min,
         b.latitude, b.longitude,
         b.organization_id
  from public.branches b
  where b.id = public.effective_branch_id(p_branch_id)
$function$
;

revoke all on function public.get_my_branch_details(p_branch_id uuid) from public, anon;
grant execute on function public.get_my_branch_details(p_branch_id uuid) to authenticated;

-- ----------------------------------------------------------------------------

CREATE OR REPLACE FUNCTION public.get_my_organization()
 RETURNS TABLE(organization_id uuid, legal_name text, trade_name text, tin text, status text, my_role text, branch_count integer, has_org_manager boolean)
 LANGUAGE sql
 STABLE SECURITY DEFINER
 SET search_path TO ''
AS $function$
  select
    o.id, o.legal_name::text, o.trade_name::text, o.tin::text, o.status::text,
    m.role::text,
    (select count(*)::integer from public.branches b where b.organization_id = o.id),
    exists (select 1 from public.organization_members om where om.organization_id = o.id and om.role = 'org_manager')
  from public.organization_members m
  join public.pharmacy_organizations o on o.id = m.organization_id
  where m.user_id = (select auth.uid())
$function$
;

revoke all on function public.get_my_organization() from public, anon;
grant execute on function public.get_my_organization() to authenticated;

-- ----------------------------------------------------------------------------

CREATE OR REPLACE FUNCTION public.get_onboarding_progress()
 RETURNS TABLE(received_stock boolean, completed_sale boolean, set_reorder_point boolean, added_patient boolean, invited_staff boolean, used_discount boolean, created_category boolean, used_insurance boolean)
 LANGUAGE sql
 STABLE SECURITY DEFINER
 SET search_path TO ''
AS $function$
  select
    exists(select 1 from public.stock_batches sb where sb.branch_id = public.current_branch_id()),
    exists(select 1 from public.sales s where s.branch_id = public.current_branch_id()),
    exists(select 1 from public.reorder_points rp where rp.branch_id = public.current_branch_id()),
    exists(select 1 from public.patients p where p.branch_id = public.current_branch_id()),
    (select count(*) from public.users u where u.branch_id = public.current_branch_id() and u.is_active) > 1,
    exists(select 1 from public.sales s where s.branch_id = public.current_branch_id() and s.discount_id is not null),
    exists(select 1 from public.product_categories pc where pc.branch_id = public.current_branch_id()),
    exists(
      select 1 from public.insurance_claims ic
      join public.sales s on s.id = ic.sale_id
      where s.branch_id = public.current_branch_id()
    )
$function$
;

revoke all on function public.get_onboarding_progress() from public, anon;
grant execute on function public.get_onboarding_progress() to authenticated;

-- ----------------------------------------------------------------------------

CREATE OR REPLACE FUNCTION public.get_organization_application(p_application_id uuid)
 RETURNS TABLE(id uuid, application_code text, legal_name text, tin text, phone text, email text, location text, status text, called_at timestamp with time zone, denied_reason text, organization_id uuid, first_branch_id uuid, branch_code text, activation_code text, submitted_at timestamp with time zone)
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''
AS $function$
begin
  perform public.freeze_expired_organization_application(p_application_id);
  return query
    select
      a.id, a.application_code::text, a.legal_name::text, a.tin::text, a.phone::text,
      a.email::text, a.location::text, a.status::text, a.called_at, a.denied_reason,
      a.organization_id, a.first_branch_id, b.branch_code::text, b.activation_code::text,
      a.submitted_at
    from public.organization_applications a
    left join public.branches b on b.id = a.first_branch_id
    where a.id = p_application_id;
end;
$function$
;

revoke all on function public.get_organization_application(p_application_id uuid) from public, anon;
grant execute on function public.get_organization_application(p_application_id uuid) to authenticated;

-- ----------------------------------------------------------------------------

CREATE OR REPLACE FUNCTION public.get_organization_application_by_email(p_email text)
 RETURNS TABLE(id uuid, application_code text, legal_name text, tin text, phone text, email text, location text, status text, called_at timestamp with time zone, denied_reason text, organization_id uuid, first_branch_id uuid, branch_code text, activation_code text, submitted_at timestamp with time zone)
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''
AS $function$
declare
  v_app_id uuid;
begin
  select a.id into v_app_id
  from public.organization_applications a
  where lower(a.email) = lower(btrim(p_email))
  order by a.submitted_at desc
  limit 1;

  if v_app_id is not null then
    perform public.freeze_expired_organization_application(v_app_id);
  end if;

  return query
    select
      a.id, a.application_code::text, a.legal_name::text, a.tin::text, a.phone::text,
      a.email::text, a.location::text, a.status::text, a.called_at, a.denied_reason,
      a.organization_id, a.first_branch_id, b.branch_code::text, b.activation_code::text,
      a.submitted_at
    from public.organization_applications a
    left join public.branches b on b.id = a.first_branch_id
    where a.id = v_app_id;
end;
$function$
;

revoke all on function public.get_organization_application_by_email(p_email text) from public, anon;
grant execute on function public.get_organization_application_by_email(p_email text) to authenticated;

-- ----------------------------------------------------------------------------

CREATE OR REPLACE FUNCTION public.get_pharmacy_application(p_application_id uuid)
 RETURNS TABLE(id uuid, application_code text, pharmacy_name text, phone text, email text, location text, status text, called_at timestamp with time zone, denied_reason text, branch_id uuid, branch_code text, activation_code text, submitted_at timestamp with time zone)
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''
AS $function$
begin
  perform public.freeze_expired_pharmacy_otp(p_application_id);
  return query
    select
      a.id, a.application_code::text, a.pharmacy_name::text, a.phone::text,
      a.email::text, a.location::text, a.status::text, a.called_at,
      a.denied_reason, a.branch_id, b.branch_code::text, b.activation_code::text,
      a.submitted_at
    from public.branch_applications a
    left join public.branches b on b.id = a.branch_id
    where a.id = p_application_id;
end;
$function$
;

revoke all on function public.get_pharmacy_application(p_application_id uuid) from public, anon;
grant execute on function public.get_pharmacy_application(p_application_id uuid) to authenticated;

-- ----------------------------------------------------------------------------

CREATE OR REPLACE FUNCTION public.get_pharmacy_application_by_email(p_email text)
 RETURNS TABLE(id uuid, application_code text, pharmacy_name text, phone text, email text, location text, status text, called_at timestamp with time zone, denied_reason text, branch_id uuid, branch_code text, activation_code text, submitted_at timestamp with time zone)
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''
AS $function$
declare
  v_app_id uuid;
begin
  select a.id into v_app_id
  from public.branch_applications a
  where lower(a.email) = lower(btrim(p_email))
  order by a.submitted_at desc
  limit 1;

  if v_app_id is not null then
    perform public.freeze_expired_pharmacy_otp(v_app_id);
  end if;

  return query
    select
      a.id, a.application_code::text, a.pharmacy_name::text, a.phone::text,
      a.email::text, a.location::text, a.status::text, a.called_at,
      a.denied_reason, a.branch_id, b.branch_code::text, b.activation_code::text,
      a.submitted_at
    from public.branch_applications a
    left join public.branches b on b.id = a.branch_id
    where a.id = v_app_id;
end;
$function$
;

revoke all on function public.get_pharmacy_application_by_email(p_email text) from public, anon;
grant execute on function public.get_pharmacy_application_by_email(p_email text) to authenticated;

-- ----------------------------------------------------------------------------

CREATE OR REPLACE FUNCTION public.get_public_receipt(p_sale_id uuid)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''
AS $function$
declare
  v_branch_id uuid;
  v_cashier_id uuid;
  v_patient_id uuid;
  v_receipt_note text;
  v_total_amount numeric;

  v_receipt_number text;
  v_issued_at timestamptz;

  v_branch_name text;
  v_branch_tin text;
  v_branch_address text;
  v_branch_phone text;
  v_branch_logo_path text;
  v_branch_bank_account_number text;
  v_branch_bank_account_name text;
  v_branch_momo_pay_number text;

  v_cashier_name text;

  v_patient_name text;
  v_patient_gender text;
  v_patient_age integer;
  v_patient_contact text;

  v_provider_id uuid;
  v_provider_name text;

  v_items jsonb;
  v_subtotal numeric;
  v_tax_total numeric;
  v_insurance_total numeric;
  v_discount_amount numeric;
  v_final_owed numeric;
begin
  -- No auth.uid()/branch check here on purpose -- p_sale_id is the only
  -- filter, by design.
  select s.branch_id, s.cashier_id, s.patient_id, s.receipt_note, s.total_amount
    into v_branch_id, v_cashier_id, v_patient_id, v_receipt_note, v_total_amount
    from public.sales s
    where s.id = p_sale_id;

  if not found then
    return null; -- unknown sale id -- caller shows a "not found" state
  end if;

  select r.receipt_number, r.issued_at
    into v_receipt_number, v_issued_at
    from public.receipts r
    where r.sale_id = p_sale_id;

  if not found then
    return null; -- sale exists but has no receipt row (shouldn't happen once complete_sale() has run) -- fail closed
  end if;

  select b.name, b.tin, b.address, b.phone, b.logo_path,
         b.bank_account_number, b.bank_account_name, b.momo_pay_number
    into v_branch_name, v_branch_tin, v_branch_address, v_branch_phone, v_branch_logo_path,
         v_branch_bank_account_number, v_branch_bank_account_name, v_branch_momo_pay_number
    from public.branches b
    where b.id = v_branch_id;

  select u.full_name into v_cashier_name
    from public.users u
    where u.id = v_cashier_id;

  if v_patient_id is not null then
    select p.full_name, p.gender, p.age, p.tin_or_phone
      into v_patient_name, v_patient_gender, v_patient_age, v_patient_contact
      from public.patients p
      where p.id = v_patient_id;
  end if;

  select ic.insurance_provider_id into v_provider_id
    from public.insurance_claims ic
    where ic.sale_id = p_sale_id;

  if v_provider_id is not null then
    select ip.name into v_provider_name
      from public.insurance_providers ip
      where ip.id = v_provider_id;
  end if;

  -- Mirrors getSaleReceipt()'s per-item tax math exactly:
  -- taxAmount = round(subtotal * rate_percentage) / 100 (subtotal is the
  -- already-extracted pre-tax base -- see 2026-08-28_vat_inclusive_tax.sql).
  select
    coalesce(jsonb_agg(
      jsonb_build_object(
        'code', bc.code,
        'productName', coalesce(pr.name, 'Unknown product'),
        'dosage', pv.dosage,
        'form', pv.form,
        'quantity', si.quantity,
        'unitPrice', si.unit_price,
        'subtotal', si.subtotal,
        'taxRatePercentage', tr.rate_percentage,
        'taxAmount', round(si.subtotal * tr.rate_percentage) / 100,
        'insuranceCovered', si.insurance_covered_amount,
        'patientOwed', si.subtotal + round(si.subtotal * tr.rate_percentage) / 100 - si.insurance_covered_amount
      )
      order by si.id
    ), '[]'::jsonb),
    coalesce(sum(si.subtotal), 0),
    coalesce(sum(round(si.subtotal * tr.rate_percentage) / 100), 0),
    coalesce(sum(si.insurance_covered_amount), 0)
    into v_items, v_subtotal, v_tax_total, v_insurance_total
    from public.sale_items si
    join public.barcodes bc on bc.id = si.barcode_id
    join public.tax_rates tr on tr.id = si.tax_rate_id
    join public.stock_batches sb on sb.id = bc.stock_batch_id
    join public.product_variants pv on pv.id = sb.product_variant_id
    join public.products pr on pr.id = pv.product_id
    where si.sale_id = p_sale_id;

  -- The real charged total (post-discount/bargain) beats the pre-discount
  -- line-item sum whenever sales.total_amount is actually set.
  v_final_owed := coalesce(v_total_amount, v_subtotal + v_tax_total - v_insurance_total);
  v_discount_amount := greatest(0, (v_subtotal + v_tax_total - v_insurance_total) - v_final_owed);

  return jsonb_build_object(
    'saleId', p_sale_id,
    'receiptNumber', v_receipt_number,
    'issuedAt', v_issued_at,
    'branchName', coalesce(v_branch_name, '—'),
    'branchTin', v_branch_tin,
    'branchAddress', v_branch_address,
    'branchPhone', v_branch_phone,
    'branchLogoPath', v_branch_logo_path,
    'branchBankAccountNumber', v_branch_bank_account_number,
    'branchBankAccountName', v_branch_bank_account_name,
    'branchMomoPayNumber', v_branch_momo_pay_number,
    'cashierName', coalesce(v_cashier_name, '—'),
    'patientName', v_patient_name,
    'patientGender', v_patient_gender,
    'patientAge', v_patient_age,
    'patientContact', v_patient_contact,
    'insuranceProviderName', v_provider_name,
    'items', v_items,
    'subtotal', v_subtotal,
    'taxTotal', v_tax_total,
    'insuranceCoveredTotal', v_insurance_total,
    'discountAmount', v_discount_amount,
    'patientOwedTotal', v_final_owed - v_insurance_total,
    'grandTotal', v_final_owed,
    'receiptNote', v_receipt_note,
    -- TODO: once complete_sale()/VSDC submission stores EBM fields on
    -- public.receipts, select and return those columns here instead of
    -- nulls, mirroring the same TODO in getSaleReceipt() (src/lib/sales.ts).
    'ebmSdcId', null,
    'ebmMrcNo', null,
    'ebmReceiptSignature', null,
    'ebmInvoiceNumber', null
  );
end;
$function$
;

revoke all on function public.get_public_receipt(p_sale_id uuid) from public, anon;
grant execute on function public.get_public_receipt(p_sale_id uuid) to authenticated;

-- ----------------------------------------------------------------------------

CREATE OR REPLACE FUNCTION public.invite_organization_member(p_organization_id uuid, p_user_email text, p_full_name text, p_role text DEFAULT 'org_manager'::text, p_branch_id uuid DEFAULT NULL::uuid)
 RETURNS text
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''
AS $function$
declare
  v_target uuid;
  v_old_role text;
  v_anchor_branch uuid;
begin
  perform public.assert_org_owner(p_organization_id);
  if p_role <> 'org_manager' then
    raise exception 'Only org_manager can be assigned here -- ownership transfers use a separate action';
  end if;

  select id into v_target from public.users where lower(email) = lower(btrim(p_user_email));

  if exists (
    select 1 from public.organization_members
    where organization_id = p_organization_id and role = 'org_manager'
      and (v_target is null or user_id <> v_target)
  ) then
    raise exception 'This organization already has an organization manager -- remove them first';
  end if;

  -- Also block a second *pending* org_manager invite for a different email --
  -- otherwise two brand-new people could both be invited before either
  -- activates, and the cap would only bite the second one at activation time
  -- (a confusing, avoidable failure well after they've already entered their OTP).
  if exists (
    select 1 from public.organization_invites
    where organization_id = p_organization_id and role = 'org_manager' and status = 'otp_sent'
      and lower(email) <> lower(btrim(p_user_email))
  ) then
    raise exception 'This organization already has a pending organization manager invite -- cancel it first';
  end if;

  if v_target is null then
    -- Brand-new person: org_manager is never tied to a branch, so the
    -- org_owner is never asked to pick one -- any branch belonging to this
    -- organization works equally well as the technical anchor
    -- organization_invites.branch_id (and later users.branch_id) requires.
    -- See this file's own header for why it can't simply be null.
    v_anchor_branch := coalesce(
      p_branch_id,
      (select id from public.branches where organization_id = p_organization_id order by created_at asc limit 1)
    );
    if v_anchor_branch is null then
      raise exception 'This organization has no branches yet';
    end if;
    perform public.create_organization_invite(p_organization_id, v_anchor_branch, p_user_email, p_full_name, p_role);
    return 'invited';
  end if;

  -- Existing person (e.g. a current branch_manager being promoted): their
  -- own users.branch_id/role are deliberately left untouched -- no data
  -- mutation needed. list_branch_staff() already stops surfacing them at
  -- their old branch the moment the organization_members row below exists.
  select role into v_old_role from public.organization_members
  where organization_id = p_organization_id and user_id = v_target;

  insert into public.organization_members (organization_id, user_id, role)
  values (p_organization_id, v_target, p_role)
  on conflict (organization_id, user_id) do update set role = excluded.role;

  perform public.log_role_change(
    'organization', p_organization_id, null, v_target, v_old_role, p_role,
    case when v_old_role is null then 'grant' else 'role_change' end
  );

  return 'granted';
end;
$function$
;

revoke all on function public.invite_organization_member(p_organization_id uuid, p_user_email text, p_full_name text, p_role text, p_branch_id uuid) from public, anon;
grant execute on function public.invite_organization_member(p_organization_id uuid, p_user_email text, p_full_name text, p_role text, p_branch_id uuid) to authenticated;

-- ----------------------------------------------------------------------------

CREATE OR REPLACE FUNCTION public.is_org_member(p_organization_id uuid)
 RETURNS boolean
 LANGUAGE sql
 STABLE SECURITY DEFINER
 SET search_path TO ''
AS $function$
  select exists (
    select 1 from public.organization_members m
    join public.users u on u.id = m.user_id
    where m.organization_id = p_organization_id and m.user_id = (select auth.uid()) and u.is_active
  )
$function$
;

revoke all on function public.is_org_member(p_organization_id uuid) from public, anon;
grant execute on function public.is_org_member(p_organization_id uuid) to authenticated;

-- ----------------------------------------------------------------------------

CREATE OR REPLACE FUNCTION public.is_org_member_or_own_branch_in_org(p_organization_id uuid)
 RETURNS boolean
 LANGUAGE sql
 STABLE SECURITY DEFINER
 SET search_path TO ''
AS $function$
  select public.is_org_member(p_organization_id) or public.my_branch_organization_id() = p_organization_id
$function$
;

revoke all on function public.is_org_member_or_own_branch_in_org(p_organization_id uuid) from public, anon;
grant execute on function public.is_org_member_or_own_branch_in_org(p_organization_id uuid) to authenticated;

-- ----------------------------------------------------------------------------

CREATE OR REPLACE FUNCTION public.is_owner()
 RETURNS boolean
 LANGUAGE sql
 STABLE SECURITY DEFINER
 SET search_path TO ''
AS $function$
    select exists (
      select 1
      from public.users u
      where u.id = (select auth.uid())
        and u.role = 'owner'
        and u.is_active
    )
  $function$
;

revoke all on function public.is_owner() from public, anon;
grant execute on function public.is_owner() to authenticated;

-- ----------------------------------------------------------------------------

CREATE OR REPLACE FUNCTION public.is_super_admin()
 RETURNS boolean
 LANGUAGE sql
 STABLE SECURITY DEFINER
 SET search_path TO ''
AS $function$
    select coalesce(((select auth.jwt()) -> 'app_metadata' ->> 'role') = 'super_admin', false)
  $function$
;

revoke all on function public.is_super_admin() from public, anon;
grant execute on function public.is_super_admin() to authenticated;

-- ----------------------------------------------------------------------------

CREATE OR REPLACE FUNCTION public.list_branch_batches_for_variant(p_branch_id uuid, p_product_variant_id uuid)
 RETURNS TABLE(stock_batch_id uuid, batch_number text, expiry_date date, quantity_available integer)
 LANGUAGE plpgsql
 STABLE SECURITY DEFINER
 SET search_path TO ''
AS $function$
declare
  v_org uuid;
begin
  select organization_id into v_org from public.branches where id = p_branch_id;
  if v_org is null then raise exception 'Unknown branch'; end if;
  if p_branch_id <> public.current_branch_id() then
    perform public.assert_org_member(v_org);
  end if;

  return query
    select
      sb.id, sb.batch_number::text, sb.expiry_date,
      coalesce(sum(bc.quantity_available * bc.pieces_per_pack) filter (where bc.barcode_type = 'pack' and bc.status = 'active'), 0)::integer
    from public.stock_batches sb
    left join public.barcodes bc on bc.stock_batch_id = sb.id
    where sb.branch_id = p_branch_id and sb.product_variant_id = p_product_variant_id
    group by sb.id, sb.batch_number, sb.expiry_date
    having coalesce(sum(bc.quantity_available * bc.pieces_per_pack) filter (where bc.barcode_type = 'pack' and bc.status = 'active'), 0) > 0
    order by sb.expiry_date asc;
end;
$function$
;

revoke all on function public.list_branch_batches_for_variant(p_branch_id uuid, p_product_variant_id uuid) from public, anon;
grant execute on function public.list_branch_batches_for_variant(p_branch_id uuid, p_product_variant_id uuid) to authenticated;

-- ----------------------------------------------------------------------------

CREATE OR REPLACE FUNCTION public.list_branch_categories(p_branch_id uuid DEFAULT NULL::uuid)
 RETURNS TABLE(id uuid, name text, description text, product_count integer, code text)
 LANGUAGE sql
 STABLE SECURITY DEFINER
 SET search_path TO ''
AS $function$
  select
    pc.id, pc.name::text, pc.description,
    (select count(*)::integer from public.branch_product_categorization bpc where bpc.category_id = pc.id and bpc.branch_id = pc.branch_id),
    'CAT-' || lpad(row_number() over (order by pc.created_at)::text, 3, '0')
  from public.product_categories pc
  where pc.branch_id = public.effective_branch_id(p_branch_id)
  order by pc.created_at;
$function$
;

revoke all on function public.list_branch_categories(p_branch_id uuid) from public, anon;
grant execute on function public.list_branch_categories(p_branch_id uuid) to authenticated;

-- ----------------------------------------------------------------------------

CREATE OR REPLACE FUNCTION public.list_branch_discounts(p_branch_id uuid DEFAULT NULL::uuid)
 RETURNS TABLE(id uuid, name text, discount_type text, value numeric, valid_from date, valid_to date, is_current boolean)
 LANGUAGE sql
 STABLE SECURITY DEFINER
 SET search_path TO ''
AS $function$
  select d.id, d.name::text, d.discount_type::text, d.value, d.valid_from, d.valid_to,
    (d.valid_from is null or d.valid_from <= current_date) and (d.valid_to is null or d.valid_to >= current_date)
  from public.discounts d
  where d.branch_id is null or d.branch_id = public.effective_branch_id(p_branch_id) or public.is_super_admin()
  order by d.name
$function$
;

revoke all on function public.list_branch_discounts(p_branch_id uuid) from public, anon;
grant execute on function public.list_branch_discounts(p_branch_id uuid) to authenticated;

-- ----------------------------------------------------------------------------

CREATE OR REPLACE FUNCTION public.list_branch_distance_measurements(p_organization_id uuid)
 RETURNS TABLE(id uuid, branch_a_id uuid, branch_a_name text, branch_b_id uuid, branch_b_name text, distance_km numeric, measured_by_name text, created_at timestamp with time zone)
 LANGUAGE plpgsql
 STABLE SECURITY DEFINER
 SET search_path TO ''
AS $function$
begin
  if not public.is_org_member(p_organization_id) then
    raise exception 'Not authorized for this organization';
  end if;

  return query
    select
      m.id, m.branch_a_id, ba.name::text, m.branch_b_id, bb.name::text,
      m.distance_km, u.full_name::text, m.created_at
    from public.branch_distance_measurements m
    join public.branches ba on ba.id = m.branch_a_id
    join public.branches bb on bb.id = m.branch_b_id
    left join public.users u on u.id = m.measured_by
    where m.organization_id = p_organization_id
    order by m.created_at desc;
end;
$function$
;

revoke all on function public.list_branch_distance_measurements(p_organization_id uuid) from public, anon;
grant execute on function public.list_branch_distance_measurements(p_organization_id uuid) to authenticated;

-- ----------------------------------------------------------------------------

CREATE OR REPLACE FUNCTION public.list_branch_history(p_from timestamp with time zone DEFAULT NULL::timestamp with time zone, p_to timestamp with time zone DEFAULT NULL::timestamp with time zone, p_branch_id uuid DEFAULT NULL::uuid)
 RETURNS TABLE(event_at timestamp with time zone, category text, amount numeric, actor_name text, status text, meta jsonb)
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''
AS $function$
declare
  v_branch uuid;
begin
  if p_branch_id is null then
    select u.branch_id into v_branch
    from public.users u
    where u.id = (select auth.uid()) and u.is_active and u.role in ('owner', 'manager');
  else
    v_branch := public.effective_branch_id(p_branch_id);
  end if;
  if v_branch is null then
    raise exception 'Only the branch owner or manager may view the full history';
  end if;

  -- title/description text is NOT built here -- it's built client-side from
  -- this raw meta data, so the History page can render it in the viewer's
  -- chosen language (see src/pages/HistoryPage.tsx eventText()).
  return query
  select s.sold_at, 'sale'::text, s.total_amount, u1.full_name::text, null::text,
    jsonb_build_object('receiptNumber', r.receipt_number, 'itemCount', si.cnt, 'patientName', p.full_name)
  from public.sales s
  join public.receipts r on r.sale_id = s.id
  left join public.patients p on p.id = s.patient_id
  left join public.users u1 on u1.id = s.cashier_id
  join lateral (select count(*) cnt from public.sale_items si2 where si2.sale_id = s.id) si on true
  where s.branch_id = v_branch and (p_from is null or s.sold_at >= p_from) and (p_to is null or s.sold_at <= p_to)

  union all

  select sa.adjusted_at, 'stock_adjustment'::text, null::numeric, u2.full_name::text, sa.adjustment_type::text,
    jsonb_build_object('quantity', sa.quantity, 'productName', concat_ws(' ', pr1.name, pv1.dosage), 'reason', sa.reason)
  from public.stock_adjustments sa
  join public.stock_batches sb1 on sb1.id = sa.stock_batch_id
  join public.product_variants pv1 on pv1.id = sb1.product_variant_id
  join public.products pr1 on pr1.id = pv1.product_id
  left join public.users u2 on u2.id = sa.performed_by
  where sb1.branch_id = v_branch and (p_from is null or sa.adjusted_at >= p_from) and (p_to is null or sa.adjusted_at <= p_to)

  union all

  select sb3.received_at, 'stock_batch'::text, (sb3.quantity_received * sb3.cost_price), u7.full_name::text, null::text,
    jsonb_build_object('productName', concat_ws(' ', pr3.name, pv3.dosage), 'batchNumber', sb3.batch_number, 'quantityReceived', sb3.quantity_received)
  from public.stock_batches sb3
  join public.product_variants pv3 on pv3.id = sb3.product_variant_id
  join public.products pr3 on pr3.id = pv3.product_id
  left join public.users u7 on u7.id = sb3.logged_by
  where sb3.branch_id = v_branch and (p_from is null or sb3.received_at >= p_from) and (p_to is null or sb3.received_at <= p_to)

  union all

  select ic.submitted_at, 'insurance_claim'::text, ic.claim_amount, null::text, ic.status::text,
    jsonb_build_object('providerName', ip.name, 'coveragePercentage', ic.coverage_percentage_applied)
  from public.insurance_claims ic
  join public.sales s2 on s2.id = ic.sale_id
  join public.insurance_providers ip on ip.id = ic.insurance_provider_id
  where s2.branch_id = v_branch and (p_from is null or ic.submitted_at >= p_from) and (p_to is null or ic.submitted_at <= p_to)

  union all

  select pt.created_at, 'patient'::text, null::numeric, u4.full_name::text, null::text,
    jsonb_build_object('patientName', pt.full_name, 'tinOrPhone', pt.tin_or_phone)
  from public.patients pt
  left join public.users u4 on u4.id = pt.created_by
  where pt.branch_id = v_branch and (p_from is null or pt.created_at >= p_from) and (p_to is null or pt.created_at <= p_to)

  union all

  select pq.created_at, 'product_request'::text, null::numeric, u5.full_name::text, pq.status::text,
    jsonb_build_object('message', left(pq.message, 140))
  from public.product_requests pq
  left join public.users u5 on u5.id = pq.requested_by
  where pq.branch_id = v_branch and (p_from is null or pq.created_at >= p_from) and (p_to is null or pq.created_at <= p_to)

  union all

  select us.created_at, 'staff'::text, null::numeric, null::text, null::text,
    jsonb_build_object('staffName', us.full_name, 'email', us.email)
  from public.users us
  where us.branch_id = v_branch and us.role = 'seller' and (p_from is null or us.created_at >= p_from) and (p_to is null or us.created_at <= p_to)

  union all

  select br.recalled_at, 'batch_recall'::text, null::numeric, u6.full_name::text, 'recalled'::text,
    jsonb_build_object('productName', concat_ws(' ', pr2.name, pv2.dosage), 'batchNumber', br.batch_number, 'manufacturerName', br.manufacturer_name, 'reason', br.reason)
  from public.batch_recalls br
  join public.product_variants pv2 on pv2.id = br.product_variant_id
  join public.products pr2 on pr2.id = pv2.product_id
  left join public.users u6 on u6.id = br.recalled_by
  where exists (
    select 1 from public.stock_batches sb2
    where sb2.product_variant_id = br.product_variant_id and sb2.batch_number = br.batch_number and sb2.branch_id = v_branch
  ) and (p_from is null or br.recalled_at >= p_from) and (p_to is null or br.recalled_at <= p_to)

  union all

  select b.created_at, 'barcode_created'::text, null::numeric, null::text, b.status::text,
    jsonb_build_object('barcodeType', b.barcode_type, 'code', b.code, 'codeSource', b.code_source)
  from public.barcodes b
  join public.stock_batches sb4 on sb4.id = b.stock_batch_id
  where sb4.branch_id = v_branch and (p_from is null or b.created_at >= p_from) and (p_to is null or b.created_at <= p_to)

  union all

  select n.created_at, 'notification'::text, null::numeric, null::text, (case when n.is_read then 'read' else 'unread' end)::text,
    jsonb_build_object('sourceType', n.source_type, 'message', n.message)
  from public.notifications n
  where n.branch_id = v_branch and (p_from is null or n.created_at >= p_from) and (p_to is null or n.created_at <= p_to)

  union all

  select st.created_at, 'support_ticket'::text, null::numeric, u8.full_name::text, st.status::text,
    jsonb_build_object('subject', st.subject)
  from public.support_tickets st
  left join public.users u8 on u8.id = st.raised_by
  where st.branch_id = v_branch and (p_from is null or st.created_at >= p_from) and (p_to is null or st.created_at <= p_to)

  order by 1 desc
  limit 2000;
end;
$function$
;

revoke all on function public.list_branch_history(p_from timestamp with time zone, p_to timestamp with time zone, p_branch_id uuid) from public, anon;
grant execute on function public.list_branch_history(p_from timestamp with time zone, p_to timestamp with time zone, p_branch_id uuid) to authenticated;

-- ----------------------------------------------------------------------------

CREATE OR REPLACE FUNCTION public.list_branch_patients(p_branch_id uuid DEFAULT NULL::uuid)
 RETURNS TABLE(id uuid, full_name text, gender text, age integer, tin_or_phone text, phone text, tin text, insurance_number text, visit_count integer, last_visit_at timestamp with time zone, lifetime_spend numeric)
 LANGUAGE sql
 STABLE SECURITY DEFINER
 SET search_path TO ''
AS $function$
  select
    p.id, p.full_name::text, p.gender::text, p.age, p.tin_or_phone::text,
    p.phone::text, p.tin::text, p.insurance_number::text,
    count(s.id)::integer, max(s.sold_at), coalesce(sum(s.total_amount), 0)
  from public.patients p
  left join public.sales s on s.patient_id = p.id
  where p.branch_id = public.effective_branch_id(p_branch_id)
  group by p.id, p.full_name, p.gender, p.age, p.tin_or_phone, p.phone, p.tin, p.insurance_number
  order by max(s.sold_at) desc nulls last, p.full_name
$function$
;

revoke all on function public.list_branch_patients(p_branch_id uuid) from public, anon;
grant execute on function public.list_branch_patients(p_branch_id uuid) to authenticated;

-- ----------------------------------------------------------------------------

CREATE OR REPLACE FUNCTION public.list_branch_products_for_location_picker()
 RETURNS TABLE(product_id uuid, product_name text, generic_name text, storage_location_id uuid, storage_location_name text)
 LANGUAGE sql
 STABLE SECURITY DEFINER
 SET search_path TO ''
AS $function$
                                                                                                                                select distinct on (p.id)
                                                                                                                                    p.id, p.name::text, p.generic_name::text, psl.storage_location_id, sl.name::text
                                                                                                                                      from public.stock_batches sb
                                                                                                                                        join public.product_variants pv on pv.id = sb.product_variant_id
                                                                                                                                          join public.products p on p.id = pv.product_id
                                                                                                                                            left join public.product_storage_locations psl on psl.branch_id = sb.branch_id and psl.product_id = p.id
                                                                                                                                              left join public.storage_locations sl on sl.id = psl.storage_location_id
                                                                                                                                                where sb.branch_id = public.current_branch_id()
                                                                                                                                                  order by p.id, p.name;
                                                                                                                                                  $function$
;

revoke all on function public.list_branch_products_for_location_picker() from public, anon;
grant execute on function public.list_branch_products_for_location_picker() to authenticated;

-- ----------------------------------------------------------------------------

CREATE OR REPLACE FUNCTION public.list_branch_staff(p_branch_id uuid DEFAULT NULL::uuid)
 RETURNS TABLE(id uuid, full_name text, email text, role text, is_active boolean, is_removed boolean, created_at timestamp with time zone)
 LANGUAGE plpgsql
 STABLE SECURITY DEFINER
 SET search_path TO ''
AS $function$
declare
  v_branch uuid := public.effective_branch_id(p_branch_id);
  v_caller_role text;
  v_caller_rank integer;
begin
  select u.role into v_caller_role from public.users u where u.id = (select auth.uid());
  v_caller_rank := case v_caller_role when 'owner' then 3 when 'manager' then 2 else 1 end;

  return query
    select
      u.id, u.full_name::text,
      case
        when (case u.role when 'owner' then 3 when 'manager' then 2 else 1 end) > v_caller_rank then null
        else u.email::text
      end,
      u.role::text, u.is_active, u.is_removed, u.created_at
    from public.users u
    where u.branch_id = v_branch
      and not exists (select 1 from public.organization_members m where m.user_id = u.id and m.role = 'org_manager')
    order by u.role, u.full_name;
end;
$function$
;

revoke all on function public.list_branch_staff(p_branch_id uuid) from public, anon;
grant execute on function public.list_branch_staff(p_branch_id uuid) to authenticated;

-- ----------------------------------------------------------------------------

CREATE OR REPLACE FUNCTION public.list_branch_stock_transfers()
 RETURNS TABLE(id uuid, from_branch_id uuid, from_branch_name text, to_branch_id uuid, to_branch_name text, status text, batch_count integer, requested_by_name text, notes text, rejection_reason text, requested_at timestamp with time zone, received_at timestamp with time zone)
 LANGUAGE sql
 STABLE SECURITY DEFINER
 SET search_path TO ''
AS $function$
  select
    t.id, t.from_branch_id, fb.name::text, t.to_branch_id, tb.name::text, t.status::text,
    (select count(*)::integer from public.stock_transfer_items i where i.transfer_id = t.id),
    u.full_name::text, t.notes, t.rejection_reason, t.requested_at, t.received_at
  from public.stock_transfers t
  join public.branches fb on fb.id = t.from_branch_id
  join public.branches tb on tb.id = t.to_branch_id
  left join public.users u on u.id = t.requested_by
  where t.from_branch_id = public.current_branch_id() or t.to_branch_id = public.current_branch_id()
  order by t.requested_at desc
$function$
;

revoke all on function public.list_branch_stock_transfers() from public, anon;
grant execute on function public.list_branch_stock_transfers() to authenticated;

-- ----------------------------------------------------------------------------

CREATE OR REPLACE FUNCTION public.list_branch_suppliers(p_branch_id uuid DEFAULT NULL::uuid)
 RETURNS TABLE(id uuid, supplier_name text)
 LANGUAGE sql
 STABLE SECURITY DEFINER
 SET search_path TO ''
AS $function$
  select s.id, s.supplier_name::text
  from public.suppliers s
  where s.branch_id is null or s.branch_id = public.effective_branch_id(p_branch_id)
  order by s.supplier_name;
$function$
;

revoke all on function public.list_branch_suppliers(p_branch_id uuid) from public, anon;
grant execute on function public.list_branch_suppliers(p_branch_id uuid) to authenticated;

-- ----------------------------------------------------------------------------

CREATE OR REPLACE FUNCTION public.list_branches_with_stock(p_need_id uuid)
 RETURNS TABLE(branch_id uuid, branch_name text, available_quantity integer)
 LANGUAGE plpgsql
 STABLE SECURITY DEFINER
 SET search_path TO ''
AS $function$
declare
  v_need public.stock_transfer_needs%rowtype;
begin
  select * into v_need from public.stock_transfer_needs where id = p_need_id;
  if v_need.id is null then raise exception 'Stock request not found'; end if;
  perform public.assert_org_member(v_need.organization_id);

  return query
    select
      b.id, b.name::text,
      coalesce(sum(bc.quantity_available * bc.pieces_per_pack) filter (where bc.barcode_type = 'pack' and bc.status = 'active'), 0)::integer
    from public.branches b
    join public.stock_batches sb on sb.branch_id = b.id and sb.product_variant_id = v_need.product_variant_id
    left join public.barcodes bc on bc.stock_batch_id = sb.id
    where b.organization_id = v_need.organization_id and b.id <> v_need.requesting_branch_id
    group by b.id, b.name
    having coalesce(sum(bc.quantity_available * bc.pieces_per_pack) filter (where bc.barcode_type = 'pack' and bc.status = 'active'), 0) > 0
    order by 3 desc;
end;
$function$
;

revoke all on function public.list_branches_with_stock(p_need_id uuid) from public, anon;
grant execute on function public.list_branches_with_stock(p_need_id uuid) to authenticated;

-- ----------------------------------------------------------------------------

CREATE OR REPLACE FUNCTION public.list_compliance_transactions(p_from date, p_to date, p_limit integer DEFAULT 200, p_branch_id uuid DEFAULT NULL::uuid)
 RETURNS TABLE(sale_id uuid, receipt_number text, sold_at timestamp with time zone, patient_name text, item_count integer, subtotal numeric, tax_total numeric, total_amount numeric, payment_method text, has_insurance boolean)
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''
AS $function$
declare
  v_branch uuid := public.effective_branch_id(p_branch_id);
begin
  perform public.assert_owner_or_manager();
  if v_branch is null then raise exception 'No active branch for this session'; end if;
  if p_limit < 1 or p_limit > 2000 then raise exception 'limit must be between 1 and 2000'; end if;

  return query
  with line_agg as (
    select si.sale_id, sum(si.subtotal) as subtotal, sum(round(si.subtotal * t.rate_percentage / 100, 2)) as tax_total, count(*) as item_count
    from public.sale_items si
    join public.tax_rates t on t.id = si.tax_rate_id
    group by si.sale_id
  )
  select
    s.id, coalesce(r.receipt_number, '—')::text, s.sold_at, p.full_name::text, coalesce(la.item_count, 0)::integer,
    coalesce(la.subtotal, 0), coalesce(la.tax_total, 0), s.total_amount, s.payment_method::text,
    exists(select 1 from public.insurance_claims ic where ic.sale_id = s.id)
  from public.sales s
  left join line_agg la on la.sale_id = s.id
  left join public.receipts r on r.sale_id = s.id
  left join public.patients p on p.id = s.patient_id
  where s.branch_id = v_branch
    and s.sold_at >= p_from::timestamptz and s.sold_at < (p_to + 1)::timestamptz
  order by s.sold_at desc
  limit p_limit;
end;
$function$
;

revoke all on function public.list_compliance_transactions(p_from date, p_to date, p_limit integer, p_branch_id uuid) from public, anon;
grant execute on function public.list_compliance_transactions(p_from date, p_to date, p_limit integer, p_branch_id uuid) to authenticated;

-- ----------------------------------------------------------------------------

CREATE OR REPLACE FUNCTION public.list_forecast_outcomes(p_branch_id uuid DEFAULT NULL::uuid, p_limit integer DEFAULT 20)
 RETURNS TABLE(snapshot_id uuid, scope text, generated_at timestamp with time zone, period_from date, period_to date, predicted_revenue numeric, actual_revenue numeric, accuracy_pct numeric, reason text)
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''
AS $function$
declare
  v_branch uuid := public.effective_branch_id(p_branch_id);
begin
  perform public.assert_owner_or_manager();
  if v_branch is null then raise exception 'No active branch for this session'; end if;
  if p_limit < 1 or p_limit > 100 then raise exception 'limit must be between 1 and 100'; end if;

  return query
  with snaps as (
    select
      s.id, s.product_id, s.category_id, s.generated_at, s.bucket,
      (select min((pt->>'period_start')::date) from jsonb_array_elements(s.points) pt) as period_from,
      (select max(
         case s.bucket
           when 'day' then (pt->>'period_start')::date + 1
           when 'week' then (pt->>'period_start')::date + 7
           else ((pt->>'period_start')::date + interval '1 month')::date
         end
       ) from jsonb_array_elements(s.points) pt) as period_to,
      (select coalesce(sum((pt->>'predicted_revenue')::numeric), 0) from jsonb_array_elements(s.points) pt) as predicted_total
    from public.sales_forecast_snapshots s
    where s.branch_id = v_branch
  )
  select
    snaps.id,
    coalesce(
      (select p.name::text from public.products p where p.id = snaps.product_id),
      (select c.name::text from public.product_categories c where c.id = snaps.category_id and c.branch_id = v_branch),
      'All products'
    ),
    snaps.generated_at, snaps.period_from, snaps.period_to,
    snaps.predicted_total, actual.total,
    case when snaps.predicted_total > 0 then round(100 * actual.total / snaps.predicted_total, 1) else null end,
    case
      when snaps.predicted_total <= 0 then null
      when actual.total >= snaps.predicted_total * 0.85 and actual.total <= snaps.predicted_total * 1.15
        then 'On target -- actual sales tracked closely with the trend-based forecast.'
      when actual.total < snaps.predicted_total * 0.85 and events.out_of_stock > 0 and events.disruption > 0
        then format('Came in below forecast -- %s out-of-stock alert(s) and %s stock adjustment/recall event(s) were logged for this branch during the period.', events.out_of_stock, events.disruption)
      when actual.total < snaps.predicted_total * 0.85 and events.out_of_stock > 0
        then format('Came in below forecast -- %s out-of-stock alert(s) were logged for this branch during the period, likely limiting sales.', events.out_of_stock)
      when actual.total < snaps.predicted_total * 0.85 and events.disruption > 0
        then format('Came in below forecast -- %s stock adjustment/recall event(s) were logged for this branch during the period.', events.disruption)
      when actual.total < snaps.predicted_total * 0.85
        then 'Came in below forecast -- no stock-outs or recalls were logged for this branch, so this likely reflects genuinely lower demand than the trend anticipated.'
      when actual.total > snaps.predicted_total * 1.15
        then 'Came in above forecast -- demand outpaced the trend-based projection for this period.'
      else 'Close to the forecast, with only a modest difference.'
    end
  from snaps
  cross join lateral (
    select coalesce(sum(si.unit_price * si.quantity), 0) as total
    from public.sale_items si
    join public.sales s2 on s2.id = si.sale_id
    join public.barcodes bc on bc.id = si.barcode_id
    join public.stock_batches sb on sb.id = bc.stock_batch_id
    join public.product_variants pv on pv.id = sb.product_variant_id
    left join public.branch_product_categorization cat on cat.product_id = pv.product_id and cat.branch_id = v_branch
    where s2.branch_id = v_branch
      and s2.sold_at >= snaps.period_from::timestamptz
      and s2.sold_at < snaps.period_to::timestamptz
      and (snaps.product_id is null or pv.product_id = snaps.product_id)
      and (snaps.category_id is null or cat.category_id = snaps.category_id)
  ) actual
  cross join lateral (
    select
      count(*) filter (where n.source_type = 'out_of_stock') as out_of_stock,
      count(*) filter (where n.source_type in ('batch_recall', 'stock_adjustment')) as disruption
    from public.notifications n
    where n.branch_id = v_branch
      and n.created_at >= snaps.period_from::timestamptz
      and n.created_at < snaps.period_to::timestamptz
  ) events
  where snaps.period_to is not null and snaps.period_to <= current_date
  order by snaps.generated_at desc
  limit p_limit;
end;
$function$
;

revoke all on function public.list_forecast_outcomes(p_branch_id uuid, p_limit integer) from public, anon;
grant execute on function public.list_forecast_outcomes(p_branch_id uuid, p_limit integer) to authenticated;

-- ----------------------------------------------------------------------------

CREATE OR REPLACE FUNCTION public.list_incoming_stock_offers(p_branch_id uuid DEFAULT NULL::uuid)
 RETURNS TABLE(id uuid, need_id uuid, requesting_branch_id uuid, requesting_branch_name text, product_variant_id uuid, product_name text, dosage text, requested_quantity integer, notes text, created_at timestamp with time zone)
 LANGUAGE plpgsql
 STABLE SECURITY DEFINER
 SET search_path TO ''
AS $function$
declare
  v_branch uuid;
begin
  v_branch := public.effective_branch_id(p_branch_id);
  if v_branch is null then raise exception 'No active branch for this session'; end if;

  return query
    select
      o.id, n.id, n.requesting_branch_id, rb.name::text,
      n.product_variant_id, p.name::text, pv.dosage::text,
      n.requested_quantity, n.notes, o.created_at
    from public.stock_transfer_offers o
    join public.stock_transfer_needs n on n.id = o.need_id
    join public.branches rb on rb.id = n.requesting_branch_id
    join public.product_variants pv on pv.id = n.product_variant_id
    join public.products p on p.id = pv.product_id
    where o.target_branch_id = v_branch and o.status = 'pending'
    order by o.created_at asc;
end;
$function$
;

revoke all on function public.list_incoming_stock_offers(p_branch_id uuid) from public, anon;
grant execute on function public.list_incoming_stock_offers(p_branch_id uuid) to authenticated;

-- ----------------------------------------------------------------------------

CREATE OR REPLACE FUNCTION public.list_my_support_tickets(p_branch_id uuid DEFAULT NULL::uuid)
 RETURNS TABLE(id uuid, subject text, description text, status text, priority text, created_at timestamp with time zone)
 LANGUAGE plpgsql
 STABLE SECURITY DEFINER
 SET search_path TO ''
AS $function$
declare
  v_branch uuid := public.effective_branch_id(p_branch_id);
begin
  if v_branch is null then raise exception 'Only an active branch user may view tickets'; end if;
  return query
    select t.id, t.subject::text, t.description, t.status::text, t.priority::text, t.created_at
    from public.support_tickets t
    where t.branch_id = v_branch
    order by t.created_at desc;
end;
$function$
;

revoke all on function public.list_my_support_tickets(p_branch_id uuid) from public, anon;
grant execute on function public.list_my_support_tickets(p_branch_id uuid) to authenticated;

-- ----------------------------------------------------------------------------

CREATE OR REPLACE FUNCTION public.list_organization_branches(p_organization_id uuid)
 RETURNS TABLE(branch_id uuid, name text, address text, phone text, branch_code text, status text, staff_count integer, created_at timestamp with time zone, latitude double precision, longitude double precision)
 LANGUAGE plpgsql
 STABLE SECURITY DEFINER
 SET search_path TO ''
AS $function$
begin
  if not public.is_org_member_or_own_branch_in_org(p_organization_id) then
    raise exception 'You are not part of this organization';
  end if;
  return query
    select
      b.id, b.name::text, b.address, b.phone::text, b.branch_code::text, b.status::text,
      (select count(*)::integer from public.users u
        where u.branch_id = b.id
          and not exists (select 1 from public.organization_members m where m.user_id = u.id and m.role = 'org_manager')),
      b.created_at, b.latitude, b.longitude
    from public.branches b
    where b.organization_id = p_organization_id
    order by b.name;
end;
$function$
;

revoke all on function public.list_organization_branches(p_organization_id uuid) from public, anon;
grant execute on function public.list_organization_branches(p_organization_id uuid) to authenticated;

-- ----------------------------------------------------------------------------

CREATE OR REPLACE FUNCTION public.list_organization_members(p_organization_id uuid)
 RETURNS TABLE(user_id uuid, full_name text, email text, role text, created_at timestamp with time zone)
 LANGUAGE plpgsql
 STABLE SECURITY DEFINER
 SET search_path TO ''
AS $function$
declare
  v_caller_role text;
begin
  perform public.assert_org_member(p_organization_id);

  -- Aliased on purpose: this function's RETURNS TABLE declares OUT columns
  -- named role/user_id, so inside plpgsql a bare "role" or "user_id" here is
  -- ambiguous between that OUT column and organization_members' own column
  -- ("column reference role is ambiguous"), which made the whole
  -- function fail at runtime rather than just mis-resolve.
  select m_self.role into v_caller_role
  from public.organization_members m_self
  where m_self.organization_id = p_organization_id and m_self.user_id = (select auth.uid());

  return query
    select u.id, u.full_name::text,
      case when v_caller_role = 'org_manager' and m.role = 'org_owner' and not public.is_super_admin()
        then null else u.email::text end,
      m.role::text, m.created_at
    from public.organization_members m
    join public.users u on u.id = m.user_id
    where m.organization_id = p_organization_id
    order by m.role, u.full_name;
end;
$function$
;

revoke all on function public.list_organization_members(p_organization_id uuid) from public, anon;
grant execute on function public.list_organization_members(p_organization_id uuid) to authenticated;

-- ----------------------------------------------------------------------------

CREATE OR REPLACE FUNCTION public.list_organization_people(p_organization_id uuid)
 RETURNS TABLE(user_id uuid, full_name text, email text, scope text, role text, branch_id uuid, branch_name text, is_active boolean, is_removed boolean)
 LANGUAGE plpgsql
 STABLE SECURITY DEFINER
 SET search_path TO ''
AS $function$
declare
  v_caller_role text;
begin
  perform public.assert_org_member(p_organization_id);

  select m_self.role into v_caller_role
  from public.organization_members m_self
  where m_self.organization_id = p_organization_id and m_self.user_id = (select auth.uid());

  return query
    select u.id, u.full_name::text,
      case when v_caller_role = 'org_manager' and m.role = 'org_owner' and not public.is_super_admin()
        then null else u.email::text end,
      'organization'::text, m.role::text,
      null::uuid, null::text, u.is_active, u.is_removed
    from public.organization_members m
    join public.users u on u.id = m.user_id
    where m.organization_id = p_organization_id
    union all
    select u.id, u.full_name::text, u.email::text, 'branch'::text, u.role::text,
      b.id, b.name::text, u.is_active, u.is_removed
    from public.users u
    join public.branches b on b.id = u.branch_id
    where b.organization_id = p_organization_id
      and u.id not in (select om.user_id from public.organization_members om where om.organization_id = p_organization_id)
    order by 4, 5, 2;
end;
$function$
;

revoke all on function public.list_organization_people(p_organization_id uuid) from public, anon;
grant execute on function public.list_organization_people(p_organization_id uuid) to authenticated;

-- ----------------------------------------------------------------------------

CREATE OR REPLACE FUNCTION public.list_organization_stock_transfers(p_organization_id uuid)
 RETURNS TABLE(id uuid, from_branch_id uuid, from_branch_name text, to_branch_id uuid, to_branch_name text, status text, batch_count integer, requested_by_name text, notes text, rejection_reason text, requested_at timestamp with time zone, received_at timestamp with time zone)
 LANGUAGE plpgsql
 STABLE SECURITY DEFINER
 SET search_path TO ''
AS $function$
begin
  perform public.assert_org_member(p_organization_id);
  return query
    select
      t.id, t.from_branch_id, fb.name::text, t.to_branch_id, tb.name::text, t.status::text,
      (select count(*)::integer from public.stock_transfer_items i where i.transfer_id = t.id),
      u.full_name::text, t.notes, t.rejection_reason, t.requested_at, t.received_at
    from public.stock_transfers t
    join public.branches fb on fb.id = t.from_branch_id
    join public.branches tb on tb.id = t.to_branch_id
    left join public.users u on u.id = t.requested_by
    where t.organization_id = p_organization_id
    order by t.requested_at desc;
end;
$function$
;

revoke all on function public.list_organization_stock_transfers(p_organization_id uuid) from public, anon;
grant execute on function public.list_organization_stock_transfers(p_organization_id uuid) to authenticated;

-- ----------------------------------------------------------------------------

CREATE OR REPLACE FUNCTION public.list_role_change_log(p_organization_id uuid DEFAULT NULL::uuid, p_branch_id uuid DEFAULT NULL::uuid)
 RETURNS SETOF role_change_log
 LANGUAGE sql
 STABLE SECURITY DEFINER
 SET search_path TO ''
AS $function$
  select * from public.role_change_log
  where (p_organization_id is not null and organization_id = p_organization_id)
     or (p_branch_id is not null and branch_id = p_branch_id)
  order by created_at desc
$function$
;

revoke all on function public.list_role_change_log(p_organization_id uuid, p_branch_id uuid) from public, anon;
grant execute on function public.list_role_change_log(p_organization_id uuid, p_branch_id uuid) to authenticated;

-- ----------------------------------------------------------------------------

CREATE OR REPLACE FUNCTION public.list_seller_activity_today()
 RETURNS TABLE(user_id uuid, full_name text, sales_count integer, revenue_today numeric, patients_registered_today integer)
 LANGUAGE plpgsql
 STABLE SECURITY DEFINER
 SET search_path TO ''
AS $function$
declare
  v_caller uuid := (select auth.uid());
  v_branch uuid;
begin
  select u.branch_id into v_branch
  from public.users u
  where u.id = v_caller and u.is_active and u.role in ('owner','manager');
  if v_branch is null then raise exception 'Only an active branch manager or owner may view staff activity'; end if;

  return query
    select
      u.id, u.full_name::text,
      count(distinct s.id) filter (where s.sold_at >= date_trunc('day', now()))::integer,
      coalesce(sum(s.total_amount) filter (where s.sold_at >= date_trunc('day', now())), 0),
      count(distinct p.id) filter (where p.created_at >= date_trunc('day', now()))::integer
    from public.users u
    left join public.sales s on s.cashier_id = u.id and s.branch_id = v_branch
    left join public.patients p on p.created_by = u.id and p.branch_id = v_branch
    where u.branch_id = v_branch and u.role = 'seller'
    group by u.id, u.full_name
    order by u.full_name;
end;
$function$
;

revoke all on function public.list_seller_activity_today() from public, anon;
grant execute on function public.list_seller_activity_today() to authenticated;

-- ----------------------------------------------------------------------------

CREATE OR REPLACE FUNCTION public.list_stock_adjustments(p_branch_id uuid DEFAULT NULL::uuid)
 RETURNS TABLE(id uuid, adjustment_type text, quantity integer, reason text, adjusted_at timestamp with time zone, product_name text, dosage text, batch_number text, performed_by_name text)
 LANGUAGE sql
 STABLE SECURITY DEFINER
 SET search_path TO ''
AS $function$
  select
    sa.id, sa.adjustment_type, sa.quantity, sa.reason, sa.adjusted_at,
    p.name, pv.dosage, sb.batch_number, u.full_name
  from public.stock_adjustments sa
  join public.stock_batches sb on sb.id = sa.stock_batch_id
  join public.product_variants pv on pv.id = sb.product_variant_id
  join public.products p on p.id = pv.product_id
  left join public.users u on u.id = sa.performed_by
  where sb.branch_id = public.effective_branch_id(p_branch_id)
  order by sa.adjusted_at desc
  limit 200
$function$
;

revoke all on function public.list_stock_adjustments(p_branch_id uuid) from public, anon;
grant execute on function public.list_stock_adjustments(p_branch_id uuid) to authenticated;

-- ----------------------------------------------------------------------------

CREATE OR REPLACE FUNCTION public.list_stock_need_offers(p_need_id uuid)
 RETURNS TABLE(id uuid, target_branch_id uuid, target_branch_name text, status text, denial_reason text, responded_by_name text, responded_at timestamp with time zone, created_at timestamp with time zone)
 LANGUAGE plpgsql
 STABLE SECURITY DEFINER
 SET search_path TO ''
AS $function$
declare
  v_need public.stock_transfer_needs%rowtype;
  v_branch uuid := public.current_branch_id();
begin
  select * into v_need from public.stock_transfer_needs where id = p_need_id;
  if v_need.id is null then raise exception 'Stock request not found'; end if;
  if not (
    public.is_super_admin() or public.is_org_member(v_need.organization_id)
    or v_need.requesting_branch_id = v_branch
    or exists (select 1 from public.stock_transfer_offers o where o.need_id = p_need_id and o.target_branch_id = v_branch)
  ) then
    raise exception 'You do not have access to this request';
  end if;

  return query
    select o.id, o.target_branch_id, b.name::text, o.status::text,
      o.denial_reason, u.full_name::text, o.responded_at, o.created_at
    from public.stock_transfer_offers o
    join public.branches b on b.id = o.target_branch_id
    left join public.users u on u.id = o.responded_by
    where o.need_id = p_need_id
    order by o.created_at asc;
end;
$function$
;

revoke all on function public.list_stock_need_offers(p_need_id uuid) from public, anon;
grant execute on function public.list_stock_need_offers(p_need_id uuid) to authenticated;

-- ----------------------------------------------------------------------------

CREATE OR REPLACE FUNCTION public.list_stock_needs(p_organization_id uuid DEFAULT NULL::uuid, p_status text DEFAULT NULL::text)
 RETURNS TABLE(id uuid, requesting_branch_id uuid, requesting_branch_name text, product_variant_id uuid, product_name text, dosage text, requested_quantity integer, status text, notes text, transfer_id uuid, transfer_status text, latest_offer_id uuid, latest_offer_branch_id uuid, latest_offer_branch_name text, latest_offer_status text, latest_offer_denial_reason text, requested_by_name text, created_at timestamp with time zone)
 LANGUAGE plpgsql
 STABLE SECURITY DEFINER
 SET search_path TO ''
AS $function$
declare
  v_branch uuid := public.current_branch_id();
begin
  if p_organization_id is not null then
    perform public.assert_org_member(p_organization_id);
  end if;

  return query
    select
      n.id, n.requesting_branch_id, rb.name::text,
      n.product_variant_id, p.name::text, pv.dosage::text,
      n.requested_quantity, n.status::text, n.notes,
      n.transfer_id, t.status::text,
      lo.id, lo.target_branch_id, ob.name::text, lo.status::text, lo.denial_reason,
      u.full_name::text, n.created_at
    from public.stock_transfer_needs n
    join public.branches rb on rb.id = n.requesting_branch_id
    join public.product_variants pv on pv.id = n.product_variant_id
    join public.products p on p.id = pv.product_id
    left join public.stock_transfers t on t.id = n.transfer_id
    left join public.users u on u.id = n.requested_by
    left join lateral (
      select o.* from public.stock_transfer_offers o where o.need_id = n.id order by o.created_at desc limit 1
    ) lo on true
    left join public.branches ob on ob.id = lo.target_branch_id
    where (p_organization_id is not null and n.organization_id = p_organization_id and (p_status is null or n.status = p_status))
       or (p_organization_id is null and n.requesting_branch_id = v_branch and (p_status is null or n.status = p_status))
    order by n.created_at desc;
end;
$function$
;

revoke all on function public.list_stock_needs(p_organization_id uuid, p_status text) from public, anon;
grant execute on function public.list_stock_needs(p_organization_id uuid, p_status text) to authenticated;

-- ----------------------------------------------------------------------------

CREATE OR REPLACE FUNCTION public.list_stock_transfer_items(p_transfer_id uuid)
 RETURNS TABLE(stock_batch_id uuid, product_name text, batch_number text, quantity_available integer)
 LANGUAGE plpgsql
 STABLE SECURITY DEFINER
 SET search_path TO ''
AS $function$
begin
  if not exists (
    select 1 from public.stock_transfers t
    where t.id = p_transfer_id
      and (
        public.is_super_admin()
        or t.from_branch_id = public.current_branch_id()
        or t.to_branch_id = public.current_branch_id()
        or public.is_org_member(t.organization_id)
      )
  ) then
    raise exception 'Transfer not found';
  end if;

  return query
    select
      sti.stock_batch_id, p.name::text, sb.batch_number::text,
      coalesce((
        select sum(bc.quantity_available * bc.pieces_per_pack)
        from public.barcodes bc
        where bc.stock_batch_id = sb.id and bc.barcode_type = 'pack'
      ), 0)::integer
    from public.stock_transfer_items sti
    join public.stock_batches sb on sb.id = sti.stock_batch_id
    join public.product_variants pv on pv.id = sb.product_variant_id
    join public.products p on p.id = pv.product_id
    where sti.transfer_id = p_transfer_id;
end;
$function$
;

revoke all on function public.list_stock_transfer_items(p_transfer_id uuid) from public, anon;
grant execute on function public.list_stock_transfer_items(p_transfer_id uuid) to authenticated;

-- ----------------------------------------------------------------------------

CREATE OR REPLACE FUNCTION public.list_stock_transfer_manifest(p_transfer_id uuid, p_status text)
 RETURNS TABLE(barcode_id uuid, code text, barcode_type text, stock_batch_id uuid, product_name text, dosage text, batch_number text)
 LANGUAGE plpgsql
 STABLE SECURITY DEFINER
 SET search_path TO ''
AS $function$
begin
  if p_status not in ('active', 'in_transit') then
    raise exception 'status must be active or in_transit';
  end if;

  if not exists (
    select 1 from public.stock_transfers t
    where t.id = p_transfer_id
      and (
        public.is_super_admin()
        or t.from_branch_id = public.current_branch_id()
        or t.to_branch_id = public.current_branch_id()
        or public.is_org_member(t.organization_id)
      )
  ) then
    raise exception 'Transfer not found';
  end if;

  return query
    select
      b.id, b.code::text, b.barcode_type::text,
      sb.id, p.name::text, pv.dosage::text, sb.batch_number::text
    from public.stock_transfer_items sti
    join public.stock_batches sb on sb.id = sti.stock_batch_id
    join public.product_variants pv on pv.id = sb.product_variant_id
    join public.products p on p.id = pv.product_id
    join public.barcodes b on b.stock_batch_id = sb.id
    where sti.transfer_id = p_transfer_id
      and b.status = p_status
      and (b.barcode_type = 'box' or b.parent_barcode_id is null)
    order by p.name, b.code;
end;
$function$
;

revoke all on function public.list_stock_transfer_manifest(p_transfer_id uuid, p_status text) from public, anon;
grant execute on function public.list_stock_transfer_manifest(p_transfer_id uuid, p_status text) to authenticated;

-- ----------------------------------------------------------------------------

CREATE OR REPLACE FUNCTION public.list_storage_locations()
 RETURNS TABLE(id uuid, name text, product_count integer)
 LANGUAGE sql
 STABLE SECURITY DEFINER
 SET search_path TO ''
AS $function$
                                    select sl.id, sl.name::text,
                                        (select count(*)::integer from public.product_storage_locations psl where psl.storage_location_id = sl.id)
                                          from public.storage_locations sl
                                            where sl.branch_id = public.current_branch_id()
                                              order by sl.name;
                                              $function$
;

revoke all on function public.list_storage_locations() from public, anon;
grant execute on function public.list_storage_locations() to authenticated;

-- ----------------------------------------------------------------------------

CREATE OR REPLACE FUNCTION public.log_first_branch_login(p_branch_id uuid, p_target_user_id uuid, p_role text)
 RETURNS void
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''
AS $function$
begin
  perform public.log_role_change('branch', null, p_branch_id, p_target_user_id, null, p_role, 'grant');
end;
$function$
;

revoke all on function public.log_first_branch_login(p_branch_id uuid, p_target_user_id uuid, p_role text) from public, anon;
grant execute on function public.log_first_branch_login(p_branch_id uuid, p_target_user_id uuid, p_role text) to authenticated;

-- ----------------------------------------------------------------------------

CREATE OR REPLACE FUNCTION public.log_org_manager_grant(p_organization_id uuid, p_target_user_id uuid)
 RETURNS void
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''
AS $function$
begin
  perform public.log_role_change('organization', p_organization_id, null, p_target_user_id, null, 'org_manager', 'grant');
end;
$function$
;

revoke all on function public.log_org_manager_grant(p_organization_id uuid, p_target_user_id uuid) from public, anon;
grant execute on function public.log_org_manager_grant(p_organization_id uuid, p_target_user_id uuid) to authenticated;

-- ----------------------------------------------------------------------------

CREATE OR REPLACE FUNCTION public.log_role_change(p_scope text, p_organization_id uuid, p_branch_id uuid, p_target_user_id uuid, p_old_role text, p_new_role text, p_action text, p_reason text DEFAULT NULL::text)
 RETURNS void
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''
AS $function$
declare
  v_actor uuid := (select auth.uid());
  v_actor_email text;
  v_target_email text;
begin
  select email into v_actor_email from auth.users where id = v_actor;
  select email into v_target_email from public.users where id = p_target_user_id;

  insert into public.role_change_log (
    scope, organization_id, branch_id, actor_user_id, actor_email,
    target_user_id, target_email, old_role, new_role, action, reason
  ) values (
    p_scope, p_organization_id, p_branch_id, v_actor, v_actor_email,
    p_target_user_id, v_target_email, p_old_role, p_new_role, p_action,
    nullif(btrim(coalesce(p_reason, '')), '')
  );
end;
$function$
;

revoke all on function public.log_role_change(p_scope text, p_organization_id uuid, p_branch_id uuid, p_target_user_id uuid, p_old_role text, p_new_role text, p_action text, p_reason text) from public, anon;
grant execute on function public.log_role_change(p_scope text, p_organization_id uuid, p_branch_id uuid, p_target_user_id uuid, p_old_role text, p_new_role text, p_action text, p_reason text) to authenticated;

-- ----------------------------------------------------------------------------

CREATE OR REPLACE FUNCTION public.lookup_barcode(p_code text, p_branch_id uuid DEFAULT NULL::uuid)
 RETURNS TABLE(barcode_id uuid, code text, barcode_type text, status text, quantity_available integer, pieces_per_pack integer, child_count integer, child_pieces_per_pack integer, active_child_count integer, parent_code text, stock_batch_id uuid, batch_number text, expiry_date date, delivery_code text, selling_price numeric, cost_price numeric, product_id uuid, product_name text, tax_rate_id uuid, dosage text, form text, manufacturer_name text, supplier_name text, storage_location_name text)
 LANGUAGE sql
 STABLE SECURITY DEFINER
 SET search_path TO ''
AS $function$
  select
    bc.id,
    bc.code::text,
    bc.barcode_type::text,
    bc.status::text,
    bc.quantity_available,
    bc.pieces_per_pack,
    bc.child_count,
    case when bc.barcode_type = 'box' then (
      select max(cpp.pieces_per_pack)::integer
      from public.barcodes cpp
      where cpp.parent_barcode_id = bc.id
        and cpp.barcode_type = 'pack'
        and cpp.status = 'active'
        and cpp.quantity_available > 0
    ) end as child_pieces_per_pack,
    case when bc.barcode_type = 'box' then (
      select count(*)::integer
      from public.barcodes cpp
      where cpp.parent_barcode_id = bc.id
        and cpp.barcode_type = 'pack'
        and cpp.status = 'active'
        and cpp.quantity_available > 0
    ) end as active_child_count,
    parent.code::text,
    sb.id,
    sb.batch_number::text,
    sb.expiry_date,
    sb.delivery_code::text,
    sb.selling_price,
    sb.cost_price,
    p.id,
    p.name::text,
    p.tax_rate_id,
    pv.dosage::text,
    pv.form::text,
    sb.manufacturer_name::text,
    s.supplier_name::text,
    sl.name::text
  from public.barcodes bc
  join public.stock_batches sb on sb.id = bc.stock_batch_id
  join public.product_variants pv on pv.id = sb.product_variant_id
  join public.products p on p.id = pv.product_id
  left join public.barcodes parent on parent.id = bc.parent_barcode_id
  left join public.suppliers s on s.id = sb.supplier_id
  left join public.product_storage_locations psl on psl.branch_id = sb.branch_id and psl.product_id = p.id
  left join public.storage_locations sl on sl.id = psl.storage_location_id
  where upper(bc.code) = upper(btrim(p_code))
    and (
      public.is_super_admin()
      or sb.branch_id = public.effective_branch_id(p_branch_id)
    )
  limit 1
$function$
;

revoke all on function public.lookup_barcode(p_code text, p_branch_id uuid) from public, anon;
grant execute on function public.lookup_barcode(p_code text, p_branch_id uuid) to authenticated;

-- ----------------------------------------------------------------------------

CREATE OR REPLACE FUNCTION public.mark_payment_provider_submitted(p_pending_payment_id uuid, p_provider_reference text)
 RETURNS void
 LANGUAGE sql
 SECURITY DEFINER
 SET search_path TO ''
AS $function$
  update public.pending_payments
  set provider_reference = p_provider_reference, updated_at = now()
  where id = p_pending_payment_id and status = 'pending';
$function$
;

revoke all on function public.mark_payment_provider_submitted(p_pending_payment_id uuid, p_provider_reference text) from public, anon;
grant execute on function public.mark_payment_provider_submitted(p_pending_payment_id uuid, p_provider_reference text) to authenticated;

-- ----------------------------------------------------------------------------

CREATE OR REPLACE FUNCTION public.mark_staff_removed(p_target_user_id uuid)
 RETURNS void
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''
AS $function$
begin
  perform public.assert_can_manage_staff_account(p_target_user_id);
  update public.users set is_active = false, is_removed = true where id = p_target_user_id;
end;
$function$
;

revoke all on function public.mark_staff_removed(p_target_user_id uuid) from public, anon;
grant execute on function public.mark_staff_removed(p_target_user_id uuid) to authenticated;

-- ----------------------------------------------------------------------------

CREATE OR REPLACE FUNCTION public.match_stock_need(p_need_id uuid, p_from_branch_id uuid, p_stock_batch_ids uuid[])
 RETURNS uuid
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''
AS $function$
declare
  v_need public.stock_transfer_needs%rowtype;
  v_transfer uuid;
  v_branch_name text;
begin
  select * into v_need from public.stock_transfer_needs where id = p_need_id for update;
  if v_need.id is null then raise exception 'Stock request not found'; end if;
  if v_need.status <> 'open' then raise exception 'This request is already %', v_need.status; end if;

  perform public.assert_org_member(v_need.organization_id);

  select name into v_branch_name from public.branches where id = v_need.requesting_branch_id;

  v_transfer := public.request_stock_transfer(
    v_need.requesting_branch_id, p_stock_batch_ids,
    format('Fulfilling stock request from %s', v_branch_name), p_from_branch_id
  );

  update public.stock_transfer_needs set status = 'matched', transfer_id = v_transfer where id = p_need_id;

  insert into public.notifications (branch_id, source_type, source_id, message)
  select v_need.requesting_branch_id, 'stock_need_matched', p_need_id,
    format('Your request for %s unit(s) of %s is being fulfilled from %s.', v_need.requested_quantity, concat_ws(' ', p.name, pv.dosage), fb.name)
  from public.product_variants pv
  join public.products p on p.id = pv.product_id
  join public.branches fb on fb.id = p_from_branch_id
  where pv.id = v_need.product_variant_id;

  return v_transfer;
end;
$function$
;

revoke all on function public.match_stock_need(p_need_id uuid, p_from_branch_id uuid, p_stock_batch_ids uuid[]) from public, anon;
grant execute on function public.match_stock_need(p_need_id uuid, p_from_branch_id uuid, p_stock_batch_ids uuid[]) to authenticated;

-- ----------------------------------------------------------------------------

CREATE OR REPLACE FUNCTION public.my_branch_organization_id()
 RETURNS uuid
 LANGUAGE sql
 STABLE SECURITY DEFINER
 SET search_path TO ''
AS $function$
  select b.organization_id
  from public.users u
  join public.branches b on b.id = u.branch_id
  where u.id = (select auth.uid()) and u.is_active
$function$
;

revoke all on function public.my_branch_organization_id() from public, anon;
grant execute on function public.my_branch_organization_id() to authenticated;

-- ----------------------------------------------------------------------------

CREATE OR REPLACE FUNCTION public.org_assign_branch_role(p_organization_id uuid, p_branch_id uuid, p_user_email text, p_full_name text, p_role text)
 RETURNS text
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''
AS $function$
declare
  v_target uuid;
  v_target_branch uuid;
  v_old_role text;
begin
  perform public.assert_can_manage_org_branch(p_organization_id);
  if p_role not in ('owner', 'manager', 'seller') then
    raise exception 'role must be owner, manager, or seller';
  end if;
  if not exists (select 1 from public.branches where id = p_branch_id and organization_id = p_organization_id) then
    raise exception 'That branch does not belong to this organization';
  end if;

  select id, branch_id, role into v_target, v_target_branch, v_old_role
  from public.users where lower(email) = lower(btrim(p_user_email));

  if v_target is null then
    perform public.create_organization_invite(p_organization_id, p_branch_id, p_user_email, p_full_name, p_role);
    return 'invited';
  end if;

  if v_target_branch <> p_branch_id then
    raise exception 'This person already has a login at a different branch';
  end if;

  if p_role = 'owner' and v_old_role <> 'owner' then
    raise exception 'This branch already has an owner -- assign manager or seller instead';
  end if;
  if p_role = 'manager' and v_old_role <> 'manager' and exists (
    select 1 from public.users u
    where u.branch_id = p_branch_id and u.role = 'manager'
      and not exists (select 1 from public.organization_members om where om.user_id = u.id and om.role = 'org_manager')
  ) then
    raise exception 'This branch already has a manager -- change their role first, or assign seller instead';
  end if;

  update public.users set role = p_role where id = v_target;
  perform public.log_role_change('branch', null, p_branch_id, v_target, v_old_role, p_role, 'role_change');

  return 'granted';
end;
$function$
;

revoke all on function public.org_assign_branch_role(p_organization_id uuid, p_branch_id uuid, p_user_email text, p_full_name text, p_role text) from public, anon;
grant execute on function public.org_assign_branch_role(p_organization_id uuid, p_branch_id uuid, p_user_email text, p_full_name text, p_role text) to authenticated;

-- ----------------------------------------------------------------------------

CREATE OR REPLACE FUNCTION public.org_branch_summary(p_organization_id uuid)
 RETURNS TABLE(branch_id uuid, branch_name text, today_revenue numeric, month_to_date_revenue numeric, out_of_stock_count integer, low_stock_count integer, pending_transfers_in integer)
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''
AS $function$
begin
  perform public.assert_org_member(p_organization_id);

  return query
  select
    b.id, b.name::text,
    coalesce((
      select round(sum(si.unit_price * si.quantity), 2)
      from public.sale_items si join public.sales s on s.id = si.sale_id
      where s.branch_id = b.id and s.sold_at >= date_trunc('day', now())
    ), 0),
    coalesce((
      select round(sum(si.unit_price * si.quantity), 2)
      from public.sale_items si join public.sales s on s.id = si.sale_id
      where s.branch_id = b.id and s.sold_at >= date_trunc('month', now())
    ), 0),
    (
      select count(distinct pv.id)::integer
      from public.stock_batches sb
      join public.product_variants pv on pv.id = sb.product_variant_id
      left join public.barcodes bc on bc.stock_batch_id = sb.id and bc.barcode_type = 'pack'
      where sb.branch_id = b.id
      group by sb.branch_id
      having coalesce(sum(bc.quantity_available * bc.pieces_per_pack), 0) = 0
    ),
    (
      select count(*)::integer from public.reorder_points rp
      join public.stock_batches sb2 on sb2.product_variant_id = rp.product_id and sb2.branch_id = rp.branch_id
      where rp.branch_id = b.id
    ),
    (select count(*)::integer from public.stock_transfers t where t.to_branch_id = b.id and t.status in ('pending', 'approved', 'in_transit'))
  from public.branches b
  where b.organization_id = p_organization_id
  order by b.name;
end;
$function$
;

revoke all on function public.org_branch_summary(p_organization_id uuid) from public, anon;
grant execute on function public.org_branch_summary(p_organization_id uuid) to authenticated;

-- ----------------------------------------------------------------------------

CREATE OR REPLACE FUNCTION public.org_change_member_role(p_organization_id uuid, p_user_id uuid, p_new_role text)
 RETURNS void
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''
AS $function$
declare
  v_caller uuid := (select auth.uid());
  v_old_org_role text;
  v_old_branch_role text;
  v_target_branch_org uuid;
begin
  perform public.assert_org_owner(p_organization_id);

  if p_new_role not in ('org_manager', 'manager', 'seller') then
    raise exception 'role must be org_manager, manager, or seller';
  end if;
  if p_user_id = v_caller then
    raise exception 'You cannot change your own role';
  end if;

  select role into v_old_org_role from public.organization_members
  where organization_id = p_organization_id and user_id = p_user_id;

  if v_old_org_role = 'org_owner' then
    raise exception 'Ownership is transferred with a separate action, not changed here';
  end if;

  -- The target must actually belong to this organization: either an
  -- org-level member of it, or branch staff at one of its branches.
  select b.organization_id, u.role into v_target_branch_org, v_old_branch_role
  from public.users u
  left join public.branches b on b.id = u.branch_id
  where u.id = p_user_id;

  if v_old_org_role is null and (v_target_branch_org is null or v_target_branch_org <> p_organization_id) then
    raise exception 'That person is not part of this organization';
  end if;

  if p_new_role = 'org_manager' then
    if exists (
      select 1 from public.organization_members
      where organization_id = p_organization_id and role = 'org_manager' and user_id <> p_user_id
    ) then
      raise exception 'This organization already has an organization manager -- change their role first';
    end if;

    insert into public.organization_members (organization_id, user_id, role)
    values (p_organization_id, p_user_id, 'org_manager')
    on conflict (organization_id, user_id) do update set role = excluded.role;

    perform public.log_role_change(
      'organization', p_organization_id, null, p_user_id, v_old_org_role, 'org_manager',
      case when v_old_org_role is null then 'grant' else 'role_change' end
    );
  else
    -- Moving back down to a branch role: the org-level grant goes away
    -- entirely, and their branch role becomes the requested one.
    delete from public.organization_members
    where organization_id = p_organization_id and user_id = p_user_id;

    update public.users set role = p_new_role where id = p_user_id;

    perform public.log_role_change(
      'organization', p_organization_id, null, p_user_id, v_old_org_role, p_new_role, 'role_change'
    );
  end if;
end;
$function$
;

revoke all on function public.org_change_member_role(p_organization_id uuid, p_user_id uuid, p_new_role text) from public, anon;
grant execute on function public.org_change_member_role(p_organization_id uuid, p_user_id uuid, p_new_role text) to authenticated;

-- ----------------------------------------------------------------------------

CREATE OR REPLACE FUNCTION public.org_overview_raw(p_organization_id uuid, p_branch_ids uuid[], p_from timestamp with time zone, p_to timestamp with time zone)
 RETURNS jsonb
 LANGUAGE plpgsql
 STABLE SECURITY DEFINER
 SET search_path TO ''
AS $function$
declare
  v_branch_ids uuid[];
  v_result jsonb;
begin
  perform public.assert_org_member(p_organization_id);

  if p_branch_ids is null then
    select coalesce(array_agg(id), array[]::uuid[]) into v_branch_ids
    from public.branches where organization_id = p_organization_id;
  else
    if exists (
      select 1 from unnest(p_branch_ids) as bid
      where not exists (select 1 from public.branches b where b.id = bid and b.organization_id = p_organization_id)
    ) then
      raise exception 'One or more branches do not belong to this organization';
    end if;
    v_branch_ids := p_branch_ids;
  end if;

  select jsonb_build_object(
    'sales', (
      select coalesce(jsonb_agg(jsonb_build_object('id', s.id, 'total_amount', s.total_amount, 'sold_at', s.sold_at)), '[]'::jsonb)
      from public.sales s
      where s.branch_id = any(v_branch_ids) and s.sold_at >= p_from and s.sold_at < p_to
    ),
    'sale_items', (
      select coalesce(jsonb_agg(jsonb_build_object(
        'sale_id', si.sale_id, 'barcode_id', si.barcode_id, 'tax_rate_id', si.tax_rate_id,
        'quantity', si.quantity, 'unit_price', si.unit_price, 'subtotal', si.subtotal,
        'insurance_covered_amount', si.insurance_covered_amount
      )), '[]'::jsonb)
      from public.sale_items si
      join public.sales s on s.id = si.sale_id
      where s.branch_id = any(v_branch_ids) and s.sold_at >= p_from and s.sold_at < p_to
    ),
    'barcodes', (
      select coalesce(jsonb_agg(jsonb_build_object(
        'id', bc.id, 'stock_batch_id', bc.stock_batch_id, 'barcode_type', bc.barcode_type,
        'pieces_per_pack', bc.pieces_per_pack, 'quantity_available', bc.quantity_available, 'status', bc.status
      )), '[]'::jsonb)
      from public.barcodes bc
      join public.stock_batches sb on sb.id = bc.stock_batch_id
      where sb.branch_id = any(v_branch_ids)
    ),
    'stock_batches', (
      select coalesce(jsonb_agg(jsonb_build_object(
        'id', sb.id, 'product_variant_id', sb.product_variant_id,
        'expiry_date', sb.expiry_date, 'selling_price', sb.selling_price
      )), '[]'::jsonb)
      from public.stock_batches sb
      where sb.branch_id = any(v_branch_ids)
    ),
    'reorder_points', (
      select coalesce(jsonb_agg(jsonb_build_object('product_id', rp.product_id, 'min_quantity', rp.min_quantity)), '[]'::jsonb)
      from public.reorder_points rp
      where rp.branch_id = any(v_branch_ids)
    ),
    'product_categories', (
      select coalesce(jsonb_agg(jsonb_build_object('id', pc.id, 'name', pc.name)), '[]'::jsonb)
      from public.product_categories pc
      where pc.branch_id = any(v_branch_ids)
    ),
    'branch_product_categorization', (
      select coalesce(jsonb_agg(jsonb_build_object('product_id', bpc.product_id, 'category_id', bpc.category_id)), '[]'::jsonb)
      from public.branch_product_categorization bpc
      where bpc.branch_id = any(v_branch_ids)
    )
  ) into v_result;

  return v_result;
end;
$function$
;

revoke all on function public.org_overview_raw(p_organization_id uuid, p_branch_ids uuid[], p_from timestamp with time zone, p_to timestamp with time zone) from public, anon;
grant execute on function public.org_overview_raw(p_organization_id uuid, p_branch_ids uuid[], p_from timestamp with time zone, p_to timestamp with time zone) to authenticated;

-- ----------------------------------------------------------------------------

CREATE OR REPLACE FUNCTION public.org_set_user_active(p_organization_id uuid, p_target_user_id uuid, p_is_active boolean)
 RETURNS void
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''
AS $function$
declare
  v_caller uuid := (select auth.uid());
  v_caller_role text;
  v_target_org_role text;
  v_target_branch_org uuid;
  v_target_removed boolean;
begin
  if p_target_user_id = v_caller then
    raise exception 'You cannot change your own active status';
  end if;

  select role into v_caller_role from public.organization_members
  where organization_id = p_organization_id and user_id = v_caller;
  if v_caller_role is null then
    raise exception 'You are not a member of this organization';
  end if;

  select role into v_target_org_role from public.organization_members
  where organization_id = p_organization_id and user_id = p_target_user_id;

  if v_target_org_role = 'org_owner' then
    raise exception 'Cannot deactivate an organization owner -- transfer ownership instead';
  end if;
  if v_target_org_role = 'org_manager' and v_caller_role <> 'org_owner' then
    raise exception 'Only the organization owner may deactivate an organization manager';
  end if;

  if v_target_org_role is null then
    select b.organization_id into v_target_branch_org
    from public.users u
    join public.branches b on b.id = u.branch_id
    where u.id = p_target_user_id;
    if v_target_branch_org is null or v_target_branch_org <> p_organization_id then
      raise exception 'That person is not part of this organization';
    end if;
  end if;

  select is_removed into v_target_removed from public.users where id = p_target_user_id;
  if p_is_active and v_target_removed then
    raise exception 'This account has been permanently removed and cannot be reactivated';
  end if;

  update public.users set is_active = p_is_active where id = p_target_user_id;
end;
$function$
;

revoke all on function public.org_set_user_active(p_organization_id uuid, p_target_user_id uuid, p_is_active boolean) from public, anon;
grant execute on function public.org_set_user_active(p_organization_id uuid, p_target_user_id uuid, p_is_active boolean) to authenticated;

-- ----------------------------------------------------------------------------

CREATE OR REPLACE FUNCTION public.preview_sale_total(p_lines jsonb, p_insurance_provider_id uuid DEFAULT NULL::uuid, p_discount_id uuid DEFAULT NULL::uuid, p_branch_id uuid DEFAULT NULL::uuid)
 RETURNS TABLE(total_amount numeric, insurance_covered_total numeric, patient_owed_total numeric)
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''
AS $function$
declare
  v_branch uuid;
begin
  v_branch := public.effective_branch_id(p_branch_id);
  if v_branch is null then raise exception 'Only an active branch user may price a sale'; end if;
  perform public.assert_can_manage_org_branch_or_own(v_branch, public.current_branch_id());
  return query select * from public._price_sale_lines(v_branch, p_lines, p_insurance_provider_id, p_discount_id);
end;
$function$
;

revoke all on function public.preview_sale_total(p_lines jsonb, p_insurance_provider_id uuid, p_discount_id uuid, p_branch_id uuid) from public, anon;
grant execute on function public.preview_sale_total(p_lines jsonb, p_insurance_provider_id uuid, p_discount_id uuid, p_branch_id uuid) to authenticated;

-- ----------------------------------------------------------------------------

CREATE OR REPLACE FUNCTION public.public_platform_stats()
 RETURNS TABLE(active_branches integer, tracked_skus integer, cities integer, revenue_today numeric, expiring_soon integer, sales_processed integer, forecasts_generated integer, avg_transfer_hours numeric, branches_mapped_pct numeric)
 LANGUAGE sql
 STABLE SECURITY DEFINER
 SET search_path TO ''
AS $function$
  select
    (select count(*)::integer from public.branches where status = 'active'),
    (select count(distinct pv.id)::integer
       from public.product_variants pv
       join public.stock_batches sb on sb.product_variant_id = pv.id),
    (select count(distinct upper(btrim(split_part(b.address, ',', 1))))::integer
       from public.branches b
       where b.status = 'active' and nullif(btrim(b.address), '') is not null),
    (select coalesce(sum(s.total_amount), 0)
       from public.sales s
       where s.sold_at >= date_trunc('day', now()) and s.sold_at < date_trunc('day', now()) + interval '1 day'),
    (select count(*)::integer
       from public.barcodes bc
       join public.stock_batches sb on sb.id = bc.stock_batch_id
       where bc.status = 'active' and bc.quantity_available > 0
         and sb.expiry_date between current_date and current_date + 30),
    (select count(*)::integer from public.sales),
    (select count(*)::integer from public.sales_forecast_snapshots),
    (select round((avg(extract(epoch from (t.received_at - t.dispatched_at))) / 3600.0)::numeric, 1)
       from public.stock_transfers t
       where t.dispatched_at is not null and t.received_at is not null),
    (select case when count(*) = 0 then null
       else round(100.0 * count(*) filter (where b.latitude is not null and b.longitude is not null) / count(*), 0)
       end
       from public.branches b where b.status = 'active')
$function$
;

revoke all on function public.public_platform_stats() from public, anon;
grant execute on function public.public_platform_stats() to authenticated;

-- ----------------------------------------------------------------------------

CREATE OR REPLACE FUNCTION public.receive_stock_delivery(p_supplier_name text, p_notes text, p_lines jsonb, p_branch_id uuid DEFAULT NULL::uuid)
 RETURNS TABLE(delivery_id uuid, delivery_code text)
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''
AS $function$
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
$function$
;

revoke all on function public.receive_stock_delivery(p_supplier_name text, p_notes text, p_lines jsonb, p_branch_id uuid) from public, anon;
grant execute on function public.receive_stock_delivery(p_supplier_name text, p_notes text, p_lines jsonb, p_branch_id uuid) to authenticated;

-- ----------------------------------------------------------------------------

CREATE OR REPLACE FUNCTION public.receive_stock_transfer(p_transfer_id uuid)
 RETURNS void
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''
AS $function$
declare
  v_transfer public.stock_transfers%rowtype;
  v_to_branch uuid;
  v_item record;
begin
  select * into v_transfer from public.stock_transfers where id = p_transfer_id;
  if v_transfer.id is null then raise exception 'Transfer not found'; end if;
  if v_transfer.status <> 'in_transit' then raise exception 'Only a transfer that is in transit can be received'; end if;

  select u.branch_id into v_to_branch
  from public.users u
  where u.id = (select auth.uid()) and u.is_active and u.role in ('owner', 'manager');
  if v_to_branch is null or v_to_branch <> v_transfer.to_branch_id then
    raise exception 'Only the receiving branch may confirm this transfer';
  end if;

  for v_item in
    select sti.stock_batch_id, sb.product_variant_id, sb.batch_number
    from public.stock_transfer_items sti
    join public.stock_batches sb on sb.id = sti.stock_batch_id
    where sti.transfer_id = p_transfer_id
  loop
    if exists (
      select 1 from public.stock_batches sb2
      where sb2.branch_id = v_to_branch
        and sb2.product_variant_id = v_item.product_variant_id
        and sb2.batch_number = v_item.batch_number
        and sb2.id <> v_item.stock_batch_id
    ) then
      raise exception 'Batch number % for this product already exists at the receiving branch -- resolve the clash before receiving this transfer', v_item.batch_number;
    end if;

    update public.stock_batches set branch_id = v_to_branch where id = v_item.stock_batch_id;

    update public.barcodes
    set status = 'active'
    where status = 'in_transit' and stock_batch_id = v_item.stock_batch_id;
  end loop;

  update public.stock_transfers set status = 'received', received_at = now() where id = p_transfer_id;

  if exists (select 1 from public.stock_transfer_needs where transfer_id = p_transfer_id) then
    update public.stock_transfer_needs set status = 'fulfilled' where transfer_id = p_transfer_id;

    insert into public.notifications (branch_id, source_type, source_id, message)
    select n.requesting_branch_id, 'stock_need_fulfilled', n.id,
      format('%s unit(s) of %s arrived from %s.', n.requested_quantity, concat_ws(' ', p.name, pv.dosage), fb.name)
    from public.stock_transfer_needs n
    join public.product_variants pv on pv.id = n.product_variant_id
    join public.products p on p.id = pv.product_id
    join public.branches fb on fb.id = v_transfer.from_branch_id
    where n.transfer_id = p_transfer_id;
  end if;
end;
$function$
;

revoke all on function public.receive_stock_transfer(p_transfer_id uuid) from public, anon;
grant execute on function public.receive_stock_transfer(p_transfer_id uuid) to authenticated;

-- ----------------------------------------------------------------------------

CREATE OR REPLACE FUNCTION public.register_first_branch(p_full_name text, p_pharmacy_name text, p_phone text, p_email text, p_location text)
 RETURNS TABLE(branch_id uuid, branch_code text, activation_code text, organization_id uuid, pharmacy_name text)
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''
AS $function$
#variable_conflict use_column
declare
  v_user uuid := (select auth.uid());
  v_email text;
  v_app public.organization_applications%rowtype;
  v_loc text;
  v_seq integer;
  v_code text;
  v_act text;
  v_chars text := 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
  v_branch uuid := gen_random_uuid();
  v_phone text;
  v_email_final text;
  v_location text;
  i integer;
begin
  if v_user is null then raise exception 'Sign in first'; end if;
  select u.email into v_email from auth.users u where u.id = v_user;
  if v_email is null then raise exception 'Auth user email was not found'; end if;

  -- Idempotent, same reasoning as activate_pharmacy_account(): heals a
  -- partial failure (e.g. the client never saw the response) instead of
  -- erroring on a safe re-run.
  if exists (select 1 from public.users u where u.id = v_user) then
    return query
      select b.id, b.branch_code::text, b.activation_code::text, b.organization_id, b.name::text
      from public.users u
      join public.branches b on b.id = u.branch_id
      where u.id = v_user;
    return;
  end if;

  select * into v_app
  from public.organization_applications a
  where lower(a.email) = lower(v_email) and a.status = 'active' and a.first_branch_id is null
  order by a.submitted_at desc
  limit 1;

  if v_app.id is null then
    raise exception 'No verified organization is awaiting its first branch for %. Verify your email first.', v_email;
  end if;
  if v_app.organization_id is null then
    raise exception 'This application has no organization record. Contact support.';
  end if;
  if nullif(btrim(p_pharmacy_name), '') is null then
    raise exception 'A branch name is required';
  end if;
  if nullif(btrim(p_full_name), '') is null then
    raise exception 'Your full name is required';
  end if;

  v_phone := coalesce(nullif(btrim(coalesce(p_phone, '')), ''), v_app.phone);
  v_email_final := coalesce(nullif(btrim(coalesce(p_email, '')), ''), v_app.email);
  v_location := coalesce(nullif(btrim(coalesce(p_location, '')), ''), v_app.location);

  v_loc := upper(regexp_replace(split_part(v_location, ',', 1), '[^A-Za-z]', '', 'g'));
  if length(coalesce(v_loc, '')) < 3 then v_loc := rpad(coalesce(v_loc, ''), 3, 'X'); else v_loc := left(v_loc, 3); end if;

  select coalesce(max(substring(b.branch_code from '[0-9]+$')::integer), 0) + 1
  into v_seq
  from public.branches b
  where b.branch_code ~ '^PSYNC-[A-Z]{3}-[0-9]{4}$';

  v_code := format('PSYNC-%s-%s', v_loc, lpad(v_seq::text, 4, '0'));

  v_act := 'ACT-';
  for i in 1..6 loop
    v_act := v_act || substr(v_chars, 1 + floor(random() * length(v_chars))::integer, 1);
  end loop;

  insert into public.branches (id, organization_id, name, address, phone, email, status, branch_code, activation_code)
  values (v_branch, v_app.organization_id, btrim(p_pharmacy_name), v_location, v_phone, v_email_final, 'active', v_code, v_act);

  insert into public.users (id, branch_id, full_name, email, role, is_active)
  values (v_user, v_branch, btrim(p_full_name), lower(v_email), 'owner', true);

  insert into public.organization_members (organization_id, user_id, role)
  values (v_app.organization_id, v_user, 'org_owner');

  insert into public.product_categories (branch_id, name, description) values
    (v_branch, 'Allergy & Antihistamines', 'Allergy relief medicines'),
    (v_branch, 'Antibiotics', 'Prescription antibacterial medicines'),
    (v_branch, 'Antimalarials', 'Malaria prevention and treatment'),
    (v_branch, 'Cardiovascular', 'Heart and blood pressure medicines'),
    (v_branch, 'Contraceptives & Family Planning', 'Reproductive health products'),
    (v_branch, 'Cough, Cold & Flu', 'Respiratory and cold symptom relief'),
    (v_branch, 'Diabetes Care', 'Blood sugar management'),
    (v_branch, 'Digestive Health', 'Antacids and gastrointestinal medicines'),
    (v_branch, 'Eye & Ear Care', 'Ophthalmic and ENT products'),
    (v_branch, 'First Aid & Wound Care', 'Bandages, antiseptics, and wound supplies'),
    (v_branch, 'Herbal & Traditional Medicine', 'Non-conventional remedies'),
    (v_branch, 'Maternal & Child Health', 'Products for mothers and infants'),
    (v_branch, 'Medical Supplies', 'PPE, gloves, syringes, and general supplies'),
    (v_branch, 'Pain Relief & Fever', 'Analgesics and antipyretics'),
    (v_branch, 'Personal Care & Hygiene', 'General hygiene and personal care items'),
    (v_branch, 'Skin Care & Dermatology', 'Topical and skin treatment products'),
    (v_branch, 'Vitamins & Supplements', 'Nutritional support products')
  on conflict on constraint product_categories_branch_id_name_key do nothing;

  insert into public.branch_directory (branch_id, display_name)
  values (v_branch, btrim(p_pharmacy_name))
  on conflict on constraint branch_directory_pkey
  do update set display_name = excluded.display_name;

  update public.organization_applications set first_branch_id = v_branch where id = v_app.id;

  return query select v_branch, v_code, v_act, v_app.organization_id, btrim(p_pharmacy_name);
end;
$function$
;

revoke all on function public.register_first_branch(p_full_name text, p_pharmacy_name text, p_phone text, p_email text, p_location text) from public, anon;
grant execute on function public.register_first_branch(p_full_name text, p_pharmacy_name text, p_phone text, p_email text, p_location text) to authenticated;

-- ----------------------------------------------------------------------------

CREATE OR REPLACE FUNCTION public.reject_stock_need(p_need_id uuid, p_reason text DEFAULT NULL::text)
 RETURNS void
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''
AS $function$
declare
  v_need public.stock_transfer_needs%rowtype;
  v_offer public.stock_transfer_offers%rowtype;
begin
  select * into v_need from public.stock_transfer_needs where id = p_need_id for update;
  if v_need.id is null then raise exception 'Stock request not found'; end if;
  if v_need.status <> 'org_review' then raise exception 'This request is not awaiting approval'; end if;

  perform public.assert_can_approve_stock_transfer(v_need.organization_id);

  select * into v_offer from public.stock_transfer_offers
  where need_id = p_need_id and status = 'accepted'
  order by responded_at desc
  limit 1;

  if v_offer.id is not null then
    update public.stock_transfer_offers
    set status = 'denied', denial_reason = coalesce(nullif(btrim(coalesce(p_reason, '')), ''), 'Not approved by the organization')
    where id = v_offer.id;
  end if;

  update public.stock_transfer_needs set status = 'open' where id = p_need_id;

  insert into public.notifications (branch_id, source_type, source_id, message)
  select v_need.requesting_branch_id, 'stock_need_rejected', p_need_id,
    format('Your request for %s unit(s) of %s was not approved.%s', v_need.requested_quantity, concat_ws(' ', p.name, pv.dosage),
      case when nullif(btrim(coalesce(p_reason, '')), '') is not null then ' ' || btrim(p_reason) else '' end)
  from public.product_variants pv
  join public.products p on p.id = pv.product_id
  where pv.id = v_need.product_variant_id;
end;
$function$
;

revoke all on function public.reject_stock_need(p_need_id uuid, p_reason text) from public, anon;
grant execute on function public.reject_stock_need(p_need_id uuid, p_reason text) to authenticated;

-- ----------------------------------------------------------------------------

CREATE OR REPLACE FUNCTION public.reject_stock_transfer(p_transfer_id uuid, p_reason text DEFAULT NULL::text)
 RETURNS void
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''
AS $function$
declare
  v_transfer public.stock_transfers%rowtype;
begin
  select * into v_transfer from public.stock_transfers where id = p_transfer_id;
  if v_transfer.id is null then raise exception 'Transfer not found'; end if;
  if v_transfer.status not in ('pending', 'approved') then
    raise exception 'Only a pending or approved transfer can be rejected';
  end if;
  if not (
    public.is_org_member(v_transfer.organization_id)
    or exists (
      select 1 from public.users u
      where u.id = (select auth.uid()) and u.is_active and u.role in ('owner', 'manager') and u.branch_id = v_transfer.to_branch_id
    )
  ) then
    raise exception 'Only the receiving branch or an organization member may reject this transfer';
  end if;

  update public.stock_transfers
  set status = 'rejected', rejection_reason = nullif(btrim(coalesce(p_reason, '')), '')
  where id = p_transfer_id;

  update public.stock_transfer_offers o
  set status = 'denied', denial_reason = coalesce(nullif(btrim(coalesce(p_reason, '')), ''), 'The arranged transfer was rejected')
  from public.stock_transfer_needs n
  where n.transfer_id = p_transfer_id and o.need_id = n.id and o.status = 'accepted';

  update public.stock_transfer_needs set status = 'open', transfer_id = null where transfer_id = p_transfer_id;
end;
$function$
;

revoke all on function public.reject_stock_transfer(p_transfer_id uuid, p_reason text) from public, anon;
grant execute on function public.reject_stock_transfer(p_transfer_id uuid, p_reason text) to authenticated;

-- ----------------------------------------------------------------------------

CREATE OR REPLACE FUNCTION public.remove_organization_member(p_organization_id uuid, p_user_id uuid)
 RETURNS void
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''
AS $function$
declare
  v_old_role text;
begin
  perform public.assert_org_owner(p_organization_id);

  select role into v_old_role from public.organization_members
  where organization_id = p_organization_id and user_id = p_user_id;
  if v_old_role is null then
    raise exception 'This person is not a member of this organization';
  end if;

  if v_old_role = 'org_owner'
     and (select count(*) from public.organization_members where organization_id = p_organization_id and role = 'org_owner') <= 1 then
    raise exception 'Cannot remove the last owner of an organization';
  end if;

  delete from public.organization_members where organization_id = p_organization_id and user_id = p_user_id;

  perform public.log_role_change('organization', p_organization_id, null, p_user_id, v_old_role, null, 'revoke');
end;
$function$
;

revoke all on function public.remove_organization_member(p_organization_id uuid, p_user_id uuid) from public, anon;
grant execute on function public.remove_organization_member(p_organization_id uuid, p_user_id uuid) to authenticated;

-- ----------------------------------------------------------------------------

CREATE OR REPLACE FUNCTION public.rename_storage_location(p_id uuid, p_name text)
 RETURNS void
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''
AS $function$
                                                                      declare
                                                                        v_branch uuid := public.current_branch_id();
                                                                        begin
                                                                          perform public.assert_owner_or_manager();
                                                                            if nullif(btrim(coalesce(p_name, '')), '') is null then raise exception 'A location name is required'; end if;

                                                                              update public.storage_locations set name = btrim(p_name)
                                                                                where id = p_id and branch_id = v_branch;
                                                                                  if not found then raise exception 'Storage location not found for this branch'; end if;
                                                                                  end;
                                                                                  $function$
;

revoke all on function public.rename_storage_location(p_id uuid, p_name text) from public, anon;
grant execute on function public.rename_storage_location(p_id uuid, p_name text) to authenticated;

-- ----------------------------------------------------------------------------

CREATE OR REPLACE FUNCTION public.request_stock(p_product_variant_id uuid, p_requested_quantity integer, p_notes text DEFAULT NULL::text, p_branch_id uuid DEFAULT NULL::uuid)
 RETURNS uuid
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''
AS $function$
declare
  v_user uuid := (select auth.uid());
  v_branch uuid;
  v_org uuid;
  v_id uuid;
begin
  perform public.assert_owner_or_manager();
  v_branch := public.effective_branch_id(p_branch_id);
  if v_branch is null then raise exception 'No active branch for this session'; end if;
  if p_requested_quantity is null or p_requested_quantity < 1 then
    raise exception 'Requested quantity must be at least 1';
  end if;
  if not exists (select 1 from public.product_variants where id = p_product_variant_id) then
    raise exception 'Unknown product variant';
  end if;

  select organization_id into v_org from public.branches where id = v_branch;
  if v_org is null then
    raise exception 'This branch does not belong to an organization -- stock requests require an organization';
  end if;

  insert into public.stock_transfer_needs (organization_id, requesting_branch_id, product_variant_id, requested_quantity, notes, requested_by)
  values (v_org, v_branch, p_product_variant_id, p_requested_quantity, nullif(btrim(coalesce(p_notes, '')), ''), v_user)
  returning id into v_id;

  -- Reaches every org_owner/org_manager in the organization (not just this
  -- branch) via the org-wide notifications visibility already set up in
  -- 2026-09-14_reorder_notifications_org_visibility.sql.
  insert into public.notifications (branch_id, source_type, source_id, message)
  select v_branch, 'stock_need_requested', v_id,
    format('%s requested %s unit(s) of %s.', b.name, p_requested_quantity, concat_ws(' ', p.name, pv.dosage))
  from public.branches b
  join public.product_variants pv on pv.id = p_product_variant_id
  join public.products p on p.id = pv.product_id
  where b.id = v_branch;

  return v_id;
end;
$function$
;

revoke all on function public.request_stock(p_product_variant_id uuid, p_requested_quantity integer, p_notes text, p_branch_id uuid) from public, anon;
grant execute on function public.request_stock(p_product_variant_id uuid, p_requested_quantity integer, p_notes text, p_branch_id uuid) to authenticated;

-- ----------------------------------------------------------------------------

CREATE OR REPLACE FUNCTION public.request_stock_from_branch(p_target_branch_id uuid, p_product_variant_id uuid, p_requested_quantity integer, p_notes text DEFAULT NULL::text, p_branch_id uuid DEFAULT NULL::uuid)
 RETURNS uuid
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''
AS $function$
declare
  v_user uuid := (select auth.uid());
  v_branch uuid;
  v_org uuid;
  v_target_org uuid;
  v_need uuid;
begin
  perform public.assert_owner_or_manager();
  v_branch := public.effective_branch_id(p_branch_id);
  if v_branch is null then raise exception 'No active branch for this session'; end if;
  if p_requested_quantity is null or p_requested_quantity < 1 then
    raise exception 'Requested quantity must be at least 1';
  end if;
  if not exists (select 1 from public.product_variants where id = p_product_variant_id) then
    raise exception 'Unknown product variant';
  end if;
  if p_target_branch_id = v_branch then
    raise exception 'Cannot request stock from your own branch';
  end if;

  select organization_id into v_org from public.branches where id = v_branch;
  if v_org is null then
    raise exception 'This branch does not belong to an organization -- stock requests require an organization';
  end if;
  select organization_id into v_target_org from public.branches where id = p_target_branch_id;
  if v_target_org is null or v_target_org <> v_org then
    raise exception 'That branch is not part of your organization';
  end if;

  insert into public.stock_transfer_needs (organization_id, requesting_branch_id, product_variant_id, requested_quantity, notes, requested_by)
  values (v_org, v_branch, p_product_variant_id, p_requested_quantity, nullif(btrim(coalesce(p_notes, '')), ''), v_user)
  returning id into v_need;

  insert into public.stock_transfer_offers (need_id, target_branch_id) values (v_need, p_target_branch_id);

  insert into public.notifications (branch_id, source_type, source_id, message)
  select p_target_branch_id, 'stock_offer_requested', v_need,
    format('%s is asking if you can send %s unit(s) of %s.', b.name, p_requested_quantity, concat_ws(' ', p.name, pv.dosage))
  from public.branches b
  join public.product_variants pv on pv.id = p_product_variant_id
  join public.products p on p.id = pv.product_id
  where b.id = v_branch;

  return v_need;
end;
$function$
;

revoke all on function public.request_stock_from_branch(p_target_branch_id uuid, p_product_variant_id uuid, p_requested_quantity integer, p_notes text, p_branch_id uuid) from public, anon;
grant execute on function public.request_stock_from_branch(p_target_branch_id uuid, p_product_variant_id uuid, p_requested_quantity integer, p_notes text, p_branch_id uuid) to authenticated;

-- ----------------------------------------------------------------------------

CREATE OR REPLACE FUNCTION public.request_stock_transfer(p_to_branch_id uuid, p_stock_batch_ids uuid[], p_notes text DEFAULT NULL::text, p_from_branch_id uuid DEFAULT NULL::uuid)
 RETURNS uuid
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''
AS $function$
declare
  v_user uuid := (select auth.uid());
  v_own_branch uuid;
  v_from_branch uuid;
  v_target_org uuid;
  v_organization uuid;
  v_transfer uuid;
  v_batch_id uuid;
begin
  select u.branch_id into v_own_branch
  from public.users u
  where u.id = v_user and u.is_active and u.role in ('owner', 'manager');
  if v_own_branch is null then
    raise exception 'Only an active branch manager or owner may request a stock transfer';
  end if;

  if p_from_branch_id is null or p_from_branch_id = v_own_branch then
    v_from_branch := v_own_branch;
  else
    select organization_id into v_target_org from public.branches where id = p_from_branch_id;
    if v_target_org is null then raise exception 'Unknown source branch'; end if;
    perform public.assert_org_member(v_target_org);
    v_from_branch := p_from_branch_id;
  end if;

  if v_from_branch = p_to_branch_id then
    raise exception 'Cannot transfer stock to the same branch';
  end if;

  select organization_id into v_organization from public.branches where id = v_from_branch;
  if v_organization is null or v_organization <> (select organization_id from public.branches where id = p_to_branch_id) then
    raise exception 'The destination branch is not part of the same organization';
  end if;

  if p_stock_batch_ids is null or array_length(p_stock_batch_ids, 1) is null then
    raise exception 'At least one stock batch is required';
  end if;

  insert into public.stock_transfers (organization_id, from_branch_id, to_branch_id, requested_by, notes)
  values (v_organization, v_from_branch, p_to_branch_id, v_user, nullif(btrim(coalesce(p_notes, '')), ''))
  returning id into v_transfer;

  foreach v_batch_id in array p_stock_batch_ids loop
    if not exists (select 1 from public.stock_batches where id = v_batch_id and branch_id = v_from_branch) then
      raise exception 'Batch % does not belong to this branch', v_batch_id;
    end if;
    insert into public.stock_transfer_items (transfer_id, stock_batch_id) values (v_transfer, v_batch_id);
  end loop;

  return v_transfer;
end;
$function$
;

revoke all on function public.request_stock_transfer(p_to_branch_id uuid, p_stock_batch_ids uuid[], p_notes text, p_from_branch_id uuid) from public, anon;
grant execute on function public.request_stock_transfer(p_to_branch_id uuid, p_stock_batch_ids uuid[], p_notes text, p_from_branch_id uuid) to authenticated;

-- ----------------------------------------------------------------------------

CREATE OR REPLACE FUNCTION public.resolve_pending_payment(p_merchant_reference text, p_provider_status text, p_provider_payload jsonb DEFAULT NULL::jsonb)
 RETURNS TABLE(status text, sale_id uuid, failure_reason text)
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''
AS $function$
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
$function$
;

revoke all on function public.resolve_pending_payment(p_merchant_reference text, p_provider_status text, p_provider_payload jsonb) from public, anon;
grant execute on function public.resolve_pending_payment(p_merchant_reference text, p_provider_status text, p_provider_payload jsonb) to authenticated;

-- ----------------------------------------------------------------------------

CREATE OR REPLACE FUNCTION public.respond_to_stock_offer(p_offer_id uuid, p_accept boolean, p_reason text DEFAULT NULL::text, p_batch_ids uuid[] DEFAULT NULL::uuid[])
 RETURNS void
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''
AS $function$
declare
  v_user uuid := (select auth.uid());
  v_offer public.stock_transfer_offers%rowtype;
  v_need public.stock_transfer_needs%rowtype;
  v_own_branch uuid;
  v_batch_id uuid;
begin
  select * into v_offer from public.stock_transfer_offers where id = p_offer_id for update;
  if v_offer.id is null then raise exception 'Request not found'; end if;
  if v_offer.status <> 'pending' then raise exception 'This request has already been answered'; end if;

  select * into v_need from public.stock_transfer_needs where id = v_offer.need_id;
  if v_need.id is null then raise exception 'Stock request not found'; end if;

  select u.branch_id into v_own_branch
  from public.users u
  where u.id = v_user and u.is_active and u.role in ('owner', 'manager');
  if v_own_branch is null or v_own_branch <> v_offer.target_branch_id then
    raise exception 'Only the branch being asked may respond to this request';
  end if;

  if p_accept then
    if p_batch_ids is null or array_length(p_batch_ids, 1) is null then
      raise exception 'Choose at least one batch to offer';
    end if;
    foreach v_batch_id in array p_batch_ids loop
      if not exists (
        select 1 from public.stock_batches
        where id = v_batch_id and branch_id = v_own_branch and product_variant_id = v_need.product_variant_id
      ) then
        raise exception 'Batch % does not belong to this branch or does not match the requested product', v_batch_id;
      end if;
    end loop;

    update public.stock_transfer_offers
    set status = 'accepted', accepted_batch_ids = p_batch_ids, responded_by = v_user, responded_at = now()
    where id = p_offer_id;

    update public.stock_transfer_needs set status = 'org_review' where id = v_need.id;

    insert into public.notifications (branch_id, source_type, source_id, message)
    select v_need.requesting_branch_id, 'stock_offer_accepted', v_need.id,
      format('%s agreed to send %s. Waiting for organization approval.', b.name, concat_ws(' ', p.name, pv.dosage))
    from public.branches b
    join public.product_variants pv on pv.id = v_need.product_variant_id
    join public.products p on p.id = pv.product_id
    where b.id = v_own_branch;

    -- Reaches every org_owner/org_manager in the organization (not just one
    -- branch) via the org-wide notifications visibility already set up in
    -- 2026-09-14_reorder_notifications_org_visibility.sql -- branch_id here
    -- is "which branch this concerns", not who caused it. Worded neutrally
    -- ("needs approval", not "needs YOUR approval") since the org_owner sees
    -- this too but can only act on it while no org_manager exists yet (see
    -- assert_can_approve_stock_transfer()).
    insert into public.notifications (branch_id, source_type, source_id, message)
    select v_need.requesting_branch_id, 'stock_need_awaiting_approval', v_need.id,
      format('%s agreed to send %s unit(s) of %s to %s -- needs organization approval.',
        b_from.name, v_need.requested_quantity, concat_ws(' ', p.name, pv.dosage), b_to.name)
    from public.branches b_from
    join public.branches b_to on b_to.id = v_need.requesting_branch_id
    join public.product_variants pv on pv.id = v_need.product_variant_id
    join public.products p on p.id = pv.product_id
    where b_from.id = v_own_branch;
  else
    if nullif(btrim(coalesce(p_reason, '')), '') is null then
      raise exception 'A reason is required to decline';
    end if;

    update public.stock_transfer_offers
    set status = 'denied', denial_reason = btrim(p_reason), responded_by = v_user, responded_at = now()
    where id = p_offer_id;

    insert into public.notifications (branch_id, source_type, source_id, message)
    select v_need.requesting_branch_id, 'stock_offer_denied', v_need.id,
      format('%s declined your request for %s: %s', b.name, concat_ws(' ', p.name, pv.dosage), btrim(p_reason))
    from public.branches b
    join public.product_variants pv on pv.id = v_need.product_variant_id
    join public.products p on p.id = pv.product_id
    where b.id = v_own_branch;
  end if;
end;
$function$
;

revoke all on function public.respond_to_stock_offer(p_offer_id uuid, p_accept boolean, p_reason text, p_batch_ids uuid[]) from public, anon;
grant execute on function public.respond_to_stock_offer(p_offer_id uuid, p_accept boolean, p_reason text, p_batch_ids uuid[]) to authenticated;

-- ----------------------------------------------------------------------------

CREATE OR REPLACE FUNCTION public.retry_stock_need(p_need_id uuid, p_target_branch_id uuid)
 RETURNS uuid
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''
AS $function$
declare
  v_user uuid := (select auth.uid());
  v_need public.stock_transfer_needs%rowtype;
  v_own_branch uuid;
  v_target_org uuid;
  v_offer uuid;
begin
  select * into v_need from public.stock_transfer_needs where id = p_need_id for update;
  if v_need.id is null then raise exception 'Stock request not found'; end if;
  if v_need.status <> 'open' then raise exception 'This request is not open for a new offer'; end if;

  select u.branch_id into v_own_branch
  from public.users u
  where u.id = v_user and u.is_active and u.role in ('owner', 'manager');
  if v_own_branch is null or v_own_branch <> v_need.requesting_branch_id then
    raise exception 'Only the requesting branch may pick another branch to ask';
  end if;

  if p_target_branch_id = v_need.requesting_branch_id then
    raise exception 'Cannot request stock from your own branch';
  end if;
  if exists (select 1 from public.stock_transfer_offers where need_id = p_need_id and status = 'pending') then
    raise exception 'There is already a pending request out for this -- wait for a response first';
  end if;

  select organization_id into v_target_org from public.branches where id = p_target_branch_id;
  if v_target_org is null or v_target_org <> v_need.organization_id then
    raise exception 'That branch is not part of your organization';
  end if;

  insert into public.stock_transfer_offers (need_id, target_branch_id) values (p_need_id, p_target_branch_id)
  returning id into v_offer;

  insert into public.notifications (branch_id, source_type, source_id, message)
  select p_target_branch_id, 'stock_offer_requested', v_need.id,
    format('%s is asking if you can send %s unit(s) of %s.', b.name, v_need.requested_quantity, concat_ws(' ', p.name, pv.dosage))
  from public.branches b
  join public.product_variants pv on pv.id = v_need.product_variant_id
  join public.products p on p.id = pv.product_id
  where b.id = v_need.requesting_branch_id;

  return v_offer;
end;
$function$
;

revoke all on function public.retry_stock_need(p_need_id uuid, p_target_branch_id uuid) from public, anon;
grant execute on function public.retry_stock_need(p_need_id uuid, p_target_branch_id uuid) to authenticated;

-- ----------------------------------------------------------------------------

CREATE OR REPLACE FUNCTION public.save_branch_distance_measurement(p_organization_id uuid, p_branch_a_id uuid, p_branch_b_id uuid, p_distance_km numeric)
 RETURNS uuid
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''
AS $function$
declare
  v_id uuid;
begin
  if not public.is_org_member(p_organization_id) then
    raise exception 'Not authorized for this organization';
  end if;
  if p_branch_a_id = p_branch_b_id then
    raise exception 'Cannot measure a branch against itself';
  end if;
  if p_distance_km is null or p_distance_km < 0 then
    raise exception 'Invalid distance';
  end if;
  if not exists (select 1 from public.branches where id = p_branch_a_id and organization_id = p_organization_id)
     or not exists (select 1 from public.branches where id = p_branch_b_id and organization_id = p_organization_id) then
    raise exception 'Both branches must belong to this organization';
  end if;

  insert into public.branch_distance_measurements (organization_id, branch_a_id, branch_b_id, distance_km, measured_by)
  values (p_organization_id, p_branch_a_id, p_branch_b_id, p_distance_km, (select auth.uid()))
  returning id into v_id;

  return v_id;
end;
$function$
;

revoke all on function public.save_branch_distance_measurement(p_organization_id uuid, p_branch_a_id uuid, p_branch_b_id uuid, p_distance_km numeric) from public, anon;
grant execute on function public.save_branch_distance_measurement(p_organization_id uuid, p_branch_a_id uuid, p_branch_b_id uuid, p_distance_km numeric) to authenticated;

-- ----------------------------------------------------------------------------

CREATE OR REPLACE FUNCTION public.save_sales_forecast_snapshot(p_product_id uuid DEFAULT NULL::uuid, p_category_id uuid DEFAULT NULL::uuid, p_bucket text DEFAULT 'month'::text, p_points jsonb DEFAULT '[]'::jsonb, p_branch_id uuid DEFAULT NULL::uuid)
 RETURNS void
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''
AS $function$
declare
  v_branch uuid := public.effective_branch_id(p_branch_id);
  v_nil uuid := '00000000-0000-0000-0000-000000000000';
begin
  perform public.assert_owner_or_manager();
  if v_branch is null then raise exception 'No active branch for this session'; end if;
  if p_product_id is not null and p_category_id is not null then
    raise exception 'Pass product_id or category_id, not both';
  end if;
  if p_bucket not in ('day','week','month') then raise exception 'bucket must be day, week or month'; end if;

  update public.sales_forecast_snapshots
  set generated_at = now(), bucket = p_bucket, points = p_points
  where branch_id = v_branch
    and coalesce(product_id, v_nil) = coalesce(p_product_id, v_nil)
    and coalesce(category_id, v_nil) = coalesce(p_category_id, v_nil)
    and generated_at::date = current_date;

  if not found then
    insert into public.sales_forecast_snapshots (branch_id, product_id, category_id, bucket, points)
    values (v_branch, p_product_id, p_category_id, p_bucket, p_points);
  end if;
end;
$function$
;

revoke all on function public.save_sales_forecast_snapshot(p_product_id uuid, p_category_id uuid, p_bucket text, p_points jsonb, p_branch_id uuid) from public, anon;
grant execute on function public.save_sales_forecast_snapshot(p_product_id uuid, p_category_id uuid, p_bucket text, p_points jsonb, p_branch_id uuid) to authenticated;

-- ----------------------------------------------------------------------------

CREATE OR REPLACE FUNCTION public.set_product_storage_location(p_product_id uuid, p_storage_location_id uuid)
 RETURNS void
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''
AS $function$
                                                                                        declare
                                                                                          v_branch uuid := public.current_branch_id();
                                                                                            v_user uuid := (select auth.uid());
                                                                                            begin
                                                                                              perform public.assert_owner_or_manager();
                                                                                                if v_branch is null then raise exception 'No active branch for this session'; end if;

                                                                                                  if p_storage_location_id is null then
                                                                                                      delete from public.product_storage_locations where branch_id = v_branch and product_id = p_product_id;
                                                                                                          return;
                                                                                                            end if;

                                                                                                              if not exists (select 1 from public.storage_locations where id = p_storage_location_id and branch_id = v_branch) then
                                                                                                                  raise exception 'Storage location not found for this branch';
                                                                                                                    end if;

                                                                                                                      insert into public.product_storage_locations (branch_id, product_id, storage_location_id, updated_by)
                                                                                                                        values (v_branch, p_product_id, p_storage_location_id, v_user)
                                                                                                                          on conflict (branch_id, product_id) do update
                                                                                                                              set storage_location_id = excluded.storage_location_id, updated_at = now(), updated_by = excluded.updated_by;
                                                                                                                              end;
                                                                                                                              $function$
;

revoke all on function public.set_product_storage_location(p_product_id uuid, p_storage_location_id uuid) from public, anon;
grant execute on function public.set_product_storage_location(p_product_id uuid, p_storage_location_id uuid) to authenticated;

-- ----------------------------------------------------------------------------

CREATE OR REPLACE FUNCTION public.set_sale_receipt_note(p_sale_id uuid, p_note text)
 RETURNS void
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''
AS $function$
declare
  v_branch uuid;
begin
  select u.branch_id into v_branch from public.users u where u.id = (select auth.uid()) and u.is_active;
  if v_branch is null then
    raise exception 'Only an active branch user may edit a receipt';
  end if;

  update public.sales
  set receipt_note = nullif(btrim(coalesce(p_note, '')), '')
  where id = p_sale_id and branch_id = v_branch;

  if not found then
    raise exception 'Sale not found for this branch';
  end if;
end;
$function$
;

revoke all on function public.set_sale_receipt_note(p_sale_id uuid, p_note text) from public, anon;
grant execute on function public.set_sale_receipt_note(p_sale_id uuid, p_note text) to authenticated;

-- ----------------------------------------------------------------------------

CREATE OR REPLACE FUNCTION public.split_stock_batch(p_stock_batch_id uuid, p_quantity integer)
 RETURNS uuid
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''
AS $function$
declare
  v_caller uuid := (select auth.uid());
  v_own_branch uuid;
  v_batch public.stock_batches%rowtype;
  v_active_count integer;
  v_new_batch_id uuid;
  v_moved integer;
begin
  if p_quantity is null or p_quantity < 1 then
    raise exception 'quantity must be at least 1';
  end if;

  select * into v_batch from public.stock_batches where id = p_stock_batch_id;
  if v_batch.id is null then raise exception 'Stock batch not found'; end if;

  select u.branch_id into v_own_branch from public.users u where u.id = v_caller and u.is_active and u.role in ('owner', 'manager');
  if v_own_branch is null then raise exception 'Only an active branch manager or owner may split a stock batch'; end if;

  if v_batch.branch_id <> v_own_branch then
    if not exists (
      select 1 from public.organization_members om
      join public.branches b on b.organization_id = om.organization_id
      where om.user_id = v_caller and b.id = v_batch.branch_id
    ) then
      raise exception 'You do not have permission to split this stock batch';
    end if;
  end if;

  select count(*) into v_active_count
  from public.barcodes
  where stock_batch_id = p_stock_batch_id and status = 'active' and parent_barcode_id is null;

  if p_quantity >= v_active_count then
    return p_stock_batch_id;
  end if;

  insert into public.stock_batches (
    product_variant_id, branch_id, supplier_id, manufacturer_name, delivery_code, delivery_id, logged_by,
    batch_number, expiry_date, cost_price, selling_price, quantity_received
  ) values (
    v_batch.product_variant_id, v_batch.branch_id, v_batch.supplier_id, v_batch.manufacturer_name, v_batch.delivery_code, v_batch.delivery_id, v_caller,
    v_batch.batch_number || '-SPLIT-' || substr(gen_random_uuid()::text, 1, 6), v_batch.expiry_date, v_batch.cost_price, v_batch.selling_price, p_quantity
  ) returning id into v_new_batch_id;

  with moved as (
    select id from public.barcodes
    where stock_batch_id = p_stock_batch_id and status = 'active' and parent_barcode_id is null
    order by id
    limit p_quantity
  )
  update public.barcodes set stock_batch_id = v_new_batch_id where id in (select id from moved);
  get diagnostics v_moved = row_count;

  if v_moved < p_quantity then
    raise exception 'Only % pack(s) are available to split off', v_moved;
  end if;

  -- A moved box's own still-active child packs must travel with it: every
  -- other place that touches a batch's barcodes (dispatch_stock_transfer,
  -- receive_stock_transfer, loadInventoryDataset's quantity_available) reads
  -- them purely by stock_batch_id, with no awareness that a box and its
  -- children could ever disagree about which batch they belong to. Without
  -- this, a split-off box arrives with 0 sellable units (its packs are still
  -- silently sitting under the OLD batch) while the original batch keeps
  -- counting stock it no longer physically has. Sold-out children are left
  -- alone -- they're already-consumed history that belongs to wherever they
  -- were actually sold, not to a batch they were never part of in reality.
  update public.barcodes set stock_batch_id = v_new_batch_id
  where status = 'active'
    and parent_barcode_id in (select id from public.barcodes where stock_batch_id = v_new_batch_id and parent_barcode_id is null);

  return v_new_batch_id;
end;
$function$
;

revoke all on function public.split_stock_batch(p_stock_batch_id uuid, p_quantity integer) from public, anon;
grant execute on function public.split_stock_batch(p_stock_batch_id uuid, p_quantity integer) to authenticated;

-- ----------------------------------------------------------------------------

CREATE OR REPLACE FUNCTION public.stamp_sale_insurer_tin()
 RETURNS trigger
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''
AS $function$
begin
  update public.sales s
  set insurer_tin = ip.tin
  from public.insurance_providers ip
  where s.id = new.sale_id
    and ip.id = new.insurance_provider_id;
  return new;
end;
$function$
;

revoke all on function public.stamp_sale_insurer_tin() from public, anon;
grant execute on function public.stamp_sale_insurer_tin() to authenticated;

-- ----------------------------------------------------------------------------

CREATE OR REPLACE FUNCTION public.stamp_sale_patient_identifiers()
 RETURNS trigger
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''
AS $function$
begin
  if new.patient_id is not null then
    select p.phone, p.tin into new.patient_phone, new.patient_tin
    from public.patients p
    where p.id = new.patient_id;
  end if;
  return new;
end;
$function$
;

revoke all on function public.stamp_sale_patient_identifiers() from public, anon;
grant execute on function public.stamp_sale_patient_identifiers() to authenticated;

-- ----------------------------------------------------------------------------

CREATE OR REPLACE FUNCTION public.submit_organization_registration(p_legal_name text, p_tin text, p_phone text, p_email text, p_location text)
 RETURNS TABLE(application_id uuid, application_code text)
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''
AS $function$
declare
  v_id uuid := gen_random_uuid();
  v_code text;
  v_email text := lower(btrim(p_email));
begin
  if nullif(btrim(p_legal_name), '') is null
    or nullif(btrim(p_phone), '') is null
    or v_email is null
    or v_email !~ '^[^@]+@[^@]+\.[^@]+$'
    or nullif(btrim(p_location), '') is null then
    raise exception 'Legal name, phone, email and location are required';
  end if;

  if exists (
    select 1 from public.users u where lower(u.email) = v_email
  ) or exists (
    select 1 from public.organization_applications a
    where lower(a.email) = v_email and a.status in ('pending', 'otp_sent', 'active')
  ) then
    raise exception 'This email is already registered or awaiting approval';
  end if;

  v_code := format(
    'ORG-%s-%s',
    to_char(now(), 'YYYYMMDD'),
    upper(substr(replace(v_id::text, '-', ''), 1, 6))
  );

  insert into public.organization_applications (
    id, application_code, legal_name, tin, phone, email, location, status
  ) values (
    v_id, v_code, btrim(p_legal_name), nullif(btrim(coalesce(p_tin, '')), ''),
    btrim(p_phone), v_email, btrim(p_location), 'pending'
  );

  return query select v_id, v_code;
end;
$function$
;

revoke all on function public.submit_organization_registration(p_legal_name text, p_tin text, p_phone text, p_email text, p_location text) from public, anon;
grant execute on function public.submit_organization_registration(p_legal_name text, p_tin text, p_phone text, p_email text, p_location text) to authenticated;

-- ----------------------------------------------------------------------------

CREATE OR REPLACE FUNCTION public.submit_pharmacy_registration(p_pharmacy_name text, p_phone text, p_email text, p_location text)
 RETURNS TABLE(application_id uuid, application_code text)
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''
AS $function$
  declare
    v_id uuid := gen_random_uuid();
    v_code text;
    v_email text := lower(btrim(p_email));
  begin
    if nullif(btrim(p_pharmacy_name), '') is null
      or nullif(btrim(p_phone), '') is null
      or v_email is null
      or v_email !~ '^[^@]+@[^@]+\.[^@]+$'
      or nullif(btrim(p_location), '') is null then
      raise exception 'Pharmacy name, phone, email and location are required';
    end if;

    if exists (
      select 1 from public.users u where lower(u.email) = v_email
    ) or exists (
      select 1 from public.branch_applications a
      where lower(a.email) = v_email and a.status in ('pending','otp_sent','active')
    ) then
      raise exception 'This email is already registered or awaiting approval';
    end if;

    v_code := format(
      'APP-%s-%s',
      to_char(now(), 'YYYYMMDD'),
      upper(substr(replace(v_id::text, '-', ''), 1, 6))
    );

    insert into public.branch_applications (
      id, application_code, pharmacy_name, phone, email, location, status
    ) values (
      v_id, v_code, btrim(p_pharmacy_name), btrim(p_phone), v_email, btrim(p_location), 'pending'
    );

    return query select v_id, v_code;
  end;
  $function$
;

revoke all on function public.submit_pharmacy_registration(p_pharmacy_name text, p_phone text, p_email text, p_location text) from public, anon;
grant execute on function public.submit_pharmacy_registration(p_pharmacy_name text, p_phone text, p_email text, p_location text) to authenticated;

-- ----------------------------------------------------------------------------

CREATE OR REPLACE FUNCTION public.submit_product_request(p_message text, p_image_path text DEFAULT NULL::text)
 RETURNS uuid
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''
AS $function$
declare
  v_user uuid := (select auth.uid());
  v_branch uuid;
  v_id uuid;
begin
  select u.branch_id into v_branch from public.users u where u.id = v_user and u.is_active;
  if v_branch is null then raise exception 'Only an active branch user may request a product'; end if;
  if nullif(btrim(coalesce(p_message, '')), '') is null then
    raise exception 'Describe the product you need';
  end if;

  insert into public.product_requests (branch_id, requested_by, message, image_path)
  values (v_branch, v_user, btrim(p_message), nullif(btrim(coalesce(p_image_path, '')), ''))
  returning id into v_id;

  return v_id;
end;
$function$
;

revoke all on function public.submit_product_request(p_message text, p_image_path text) from public, anon;
grant execute on function public.submit_product_request(p_message text, p_image_path text) to authenticated;

-- ----------------------------------------------------------------------------

CREATE OR REPLACE FUNCTION public.submit_support_ticket(p_subject text, p_description text, p_priority text DEFAULT 'medium'::text)
 RETURNS uuid
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''
AS $function$
declare
  v_user uuid := (select auth.uid());
  v_branch uuid;
  v_priority text;
  v_id uuid;
begin
  select u.branch_id into v_branch from public.users u where u.id = v_user and u.is_active;
  if v_branch is null then raise exception 'Only an active branch user may submit a ticket'; end if;
  if nullif(btrim(coalesce(p_subject, '')), '') is null then raise exception 'A subject is required'; end if;

  v_priority := coalesce(nullif(p_priority, ''), 'medium');
  if v_priority not in ('low','medium','high') then v_priority := 'medium'; end if;

  insert into public.support_tickets (branch_id, raised_by, subject, description, priority)
  values (v_branch, v_user, btrim(p_subject), nullif(btrim(coalesce(p_description, '')), ''), v_priority)
  returning id into v_id;

  return v_id;
end;
$function$
;

revoke all on function public.submit_support_ticket(p_subject text, p_description text, p_priority text) from public, anon;
grant execute on function public.submit_support_ticket(p_subject text, p_description text, p_priority text) to authenticated;

-- ----------------------------------------------------------------------------

CREATE OR REPLACE FUNCTION public.transfer_organization_ownership(p_organization_id uuid, p_new_owner_user_id uuid)
 RETURNS void
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''
AS $function$
declare
  v_caller uuid := (select auth.uid());
  v_new_owner_role text;
begin
  perform public.assert_org_owner(p_organization_id);

  if p_new_owner_user_id = v_caller then
    raise exception 'You are already an owner of this organization';
  end if;

  select role into v_new_owner_role from public.organization_members
  where organization_id = p_organization_id and user_id = p_new_owner_user_id;
  if v_new_owner_role is null then
    raise exception 'The new owner must already be a member of this organization -- invite them first';
  end if;

  update public.organization_members set role = 'org_owner'
  where organization_id = p_organization_id and user_id = p_new_owner_user_id;

  update public.organization_members set role = 'org_manager'
  where organization_id = p_organization_id and user_id = v_caller;

  perform public.log_role_change('organization', p_organization_id, null, p_new_owner_user_id, v_new_owner_role, 'org_owner', 'ownership_transfer');
  perform public.log_role_change('organization', p_organization_id, null, v_caller, 'org_owner', 'org_manager', 'ownership_transfer');
end;
$function$
;

revoke all on function public.transfer_organization_ownership(p_organization_id uuid, p_new_owner_user_id uuid) from public, anon;
grant execute on function public.transfer_organization_ownership(p_organization_id uuid, p_new_owner_user_id uuid) to authenticated;

-- ----------------------------------------------------------------------------

CREATE OR REPLACE FUNCTION public.update_branch_category(p_category_id uuid, p_name text, p_description text DEFAULT NULL::text, p_branch_id uuid DEFAULT NULL::uuid)
 RETURNS void
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''
AS $function$
declare
  v_branch uuid := public.effective_branch_id(p_branch_id);
begin
  perform public.assert_owner_or_manager();
  perform public.assert_can_manage_org_branch_or_own(v_branch, public.current_branch_id());
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
$function$
;

revoke all on function public.update_branch_category(p_category_id uuid, p_name text, p_description text, p_branch_id uuid) from public, anon;
grant execute on function public.update_branch_category(p_category_id uuid, p_name text, p_description text, p_branch_id uuid) to authenticated;

-- ----------------------------------------------------------------------------

CREATE OR REPLACE FUNCTION public.update_branch_details(p_address text, p_phone text, p_tin text, p_logo_path text DEFAULT NULL::text, p_bank_account_number text DEFAULT NULL::text, p_bank_account_name text DEFAULT NULL::text, p_momo_pay_number text DEFAULT NULL::text)
 RETURNS void
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''
AS $function$
declare
  v_branch uuid;
begin
  select u.branch_id into v_branch
  from public.users u
  where u.id = (select auth.uid()) and u.is_active and u.role = 'owner';
  if v_branch is null then raise exception 'Only the branch owner may update branch settings'; end if;

  update public.branches
  set address = nullif(btrim(coalesce(p_address, '')), ''),
      phone = nullif(btrim(coalesce(p_phone, '')), ''),
      tin = nullif(btrim(coalesce(p_tin, '')), ''),
      logo_path = nullif(btrim(coalesce(p_logo_path, '')), ''),
      bank_account_number = nullif(btrim(coalesce(p_bank_account_number, '')), ''),
      bank_account_name = nullif(btrim(coalesce(p_bank_account_name, '')), ''),
      momo_pay_number = nullif(btrim(coalesce(p_momo_pay_number, '')), '')
  where id = v_branch;
end;
$function$
;

revoke all on function public.update_branch_details(p_address text, p_phone text, p_tin text, p_logo_path text, p_bank_account_number text, p_bank_account_name text, p_momo_pay_number text) from public, anon;
grant execute on function public.update_branch_details(p_address text, p_phone text, p_tin text, p_logo_path text, p_bank_account_number text, p_bank_account_name text, p_momo_pay_number text) to authenticated;

-- ----------------------------------------------------------------------------

CREATE OR REPLACE FUNCTION public.update_branch_details(p_address text, p_phone text, p_tin text, p_logo_path text DEFAULT NULL::text, p_bank_account_number text DEFAULT NULL::text, p_bank_account_name text DEFAULT NULL::text, p_momo_pay_number text DEFAULT NULL::text, p_out_of_stock_reminder_hours integer DEFAULT NULL::integer, p_name text DEFAULT NULL::text, p_email text DEFAULT NULL::text, p_website text DEFAULT NULL::text, p_license_number text DEFAULT NULL::text, p_license_expiry_date date DEFAULT NULL::date, p_ebm_device_serial text DEFAULT NULL::text, p_default_language text DEFAULT NULL::text, p_receipt_number_prefix text DEFAULT NULL::text, p_pos_cash_enabled boolean DEFAULT NULL::boolean, p_pos_mtn_momo_enabled boolean DEFAULT NULL::boolean, p_pos_airtel_money_enabled boolean DEFAULT NULL::boolean, p_pos_card_enabled boolean DEFAULT NULL::boolean, p_pos_insurance_enabled boolean DEFAULT NULL::boolean, p_pos_default_payment_method text DEFAULT NULL::text, p_pos_require_patient_name boolean DEFAULT NULL::boolean, p_pos_allow_discounts boolean DEFAULT NULL::boolean, p_pos_show_patient_history boolean DEFAULT NULL::boolean, p_expiry_alert_threshold_days integer DEFAULT NULL::integer, p_default_reorder_min integer DEFAULT NULL::integer)
 RETURNS void
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''
AS $function$
declare
  v_branch uuid;
  v_caller_role text;
begin
  select u.branch_id, u.role into v_branch, v_caller_role
  from public.users u
  where u.id = (select auth.uid()) and u.is_active and u.role in ('owner', 'manager');
  if v_branch is null then raise exception 'Only the branch owner or manager may update branch settings'; end if;

  if p_out_of_stock_reminder_hours is not null and (p_out_of_stock_reminder_hours < 1 or p_out_of_stock_reminder_hours > 168) then
    raise exception 'Reminder interval must be between 1 and 168 hours';
  end if;
  if p_default_language is not null and p_default_language not in ('en','fr','rw') then
    raise exception 'Unsupported language %', p_default_language;
  end if;
  if p_pos_default_payment_method is not null and p_pos_default_payment_method not in ('cash','mtn_momo','airtel_money','card') then
    raise exception 'Unsupported default payment method %', p_pos_default_payment_method;
  end if;
  if p_expiry_alert_threshold_days is not null and p_expiry_alert_threshold_days < 1 then
    raise exception 'Expiry alert threshold must be at least 1 day';
  end if;
  if p_default_reorder_min is not null and p_default_reorder_min < 0 then
    raise exception 'Default reorder minimum cannot be negative';
  end if;

  update public.branches
  set address = nullif(btrim(coalesce(p_address, '')), ''),
      phone = nullif(btrim(coalesce(p_phone, '')), ''),
      -- Billing/legal columns: a manager's own current value always wins,
      -- regardless of what was sent -- this is the actual enforcement of
      -- "cannot change billing or legal settings", not just a hidden field.
      tin = case when v_caller_role <> 'owner' then tin else nullif(btrim(coalesce(p_tin, '')), '') end,
      logo_path = case when p_logo_path is null then logo_path else nullif(btrim(p_logo_path), '') end,
      bank_account_number = case when v_caller_role <> 'owner' then bank_account_number
        when p_bank_account_number is null then bank_account_number else nullif(btrim(p_bank_account_number), '') end,
      bank_account_name = case when v_caller_role <> 'owner' then bank_account_name
        when p_bank_account_name is null then bank_account_name else nullif(btrim(p_bank_account_name), '') end,
      momo_pay_number = case when v_caller_role <> 'owner' then momo_pay_number
        when p_momo_pay_number is null then momo_pay_number else nullif(btrim(p_momo_pay_number), '') end,
      out_of_stock_reminder_hours = coalesce(p_out_of_stock_reminder_hours, out_of_stock_reminder_hours),
      name = coalesce(nullif(btrim(coalesce(p_name, '')), ''), name),
      email = case when p_email is null then email else nullif(btrim(p_email), '') end,
      website = case when p_website is null then website else nullif(btrim(p_website), '') end,
      license_number = case when v_caller_role <> 'owner' then license_number
        when p_license_number is null then license_number else nullif(btrim(p_license_number), '') end,
      license_expiry_date = case when v_caller_role <> 'owner' then license_expiry_date else p_license_expiry_date end,
      ebm_device_serial = case when v_caller_role <> 'owner' then ebm_device_serial
        when p_ebm_device_serial is null then ebm_device_serial else nullif(btrim(p_ebm_device_serial), '') end,
      default_language = coalesce(p_default_language, default_language),
      receipt_number_prefix = coalesce(nullif(btrim(coalesce(p_receipt_number_prefix, '')), ''), receipt_number_prefix),
      pos_cash_enabled = coalesce(p_pos_cash_enabled, pos_cash_enabled),
      pos_mtn_momo_enabled = coalesce(p_pos_mtn_momo_enabled, pos_mtn_momo_enabled),
      pos_airtel_money_enabled = coalesce(p_pos_airtel_money_enabled, pos_airtel_money_enabled),
      pos_card_enabled = coalesce(p_pos_card_enabled, pos_card_enabled),
      pos_insurance_enabled = coalesce(p_pos_insurance_enabled, pos_insurance_enabled),
      pos_default_payment_method = coalesce(p_pos_default_payment_method, pos_default_payment_method),
      pos_require_patient_name = coalesce(p_pos_require_patient_name, pos_require_patient_name),
      pos_allow_discounts = coalesce(p_pos_allow_discounts, pos_allow_discounts),
      pos_show_patient_history = coalesce(p_pos_show_patient_history, pos_show_patient_history),
      expiry_alert_threshold_days = coalesce(p_expiry_alert_threshold_days, expiry_alert_threshold_days),
      default_reorder_min = coalesce(p_default_reorder_min, default_reorder_min)
  where id = v_branch;
end;
$function$
;

revoke all on function public.update_branch_details(p_address text, p_phone text, p_tin text, p_logo_path text, p_bank_account_number text, p_bank_account_name text, p_momo_pay_number text, p_out_of_stock_reminder_hours integer, p_name text, p_email text, p_website text, p_license_number text, p_license_expiry_date date, p_ebm_device_serial text, p_default_language text, p_receipt_number_prefix text, p_pos_cash_enabled boolean, p_pos_mtn_momo_enabled boolean, p_pos_airtel_money_enabled boolean, p_pos_card_enabled boolean, p_pos_insurance_enabled boolean, p_pos_default_payment_method text, p_pos_require_patient_name boolean, p_pos_allow_discounts boolean, p_pos_show_patient_history boolean, p_expiry_alert_threshold_days integer, p_default_reorder_min integer) from public, anon;
grant execute on function public.update_branch_details(p_address text, p_phone text, p_tin text, p_logo_path text, p_bank_account_number text, p_bank_account_name text, p_momo_pay_number text, p_out_of_stock_reminder_hours integer, p_name text, p_email text, p_website text, p_license_number text, p_license_expiry_date date, p_ebm_device_serial text, p_default_language text, p_receipt_number_prefix text, p_pos_cash_enabled boolean, p_pos_mtn_momo_enabled boolean, p_pos_airtel_money_enabled boolean, p_pos_card_enabled boolean, p_pos_insurance_enabled boolean, p_pos_default_payment_method text, p_pos_require_patient_name boolean, p_pos_allow_discounts boolean, p_pos_show_patient_history boolean, p_expiry_alert_threshold_days integer, p_default_reorder_min integer) to authenticated;

-- ----------------------------------------------------------------------------

CREATE OR REPLACE FUNCTION public.update_branch_details(p_address text, p_phone text, p_tin text, p_logo_path text DEFAULT NULL::text, p_bank_account_number text DEFAULT NULL::text, p_bank_account_name text DEFAULT NULL::text, p_momo_pay_number text DEFAULT NULL::text, p_out_of_stock_reminder_hours integer DEFAULT NULL::integer, p_name text DEFAULT NULL::text, p_email text DEFAULT NULL::text, p_website text DEFAULT NULL::text, p_license_number text DEFAULT NULL::text, p_license_expiry_date date DEFAULT NULL::date, p_ebm_device_serial text DEFAULT NULL::text, p_default_language text DEFAULT NULL::text, p_receipt_number_prefix text DEFAULT NULL::text, p_pos_cash_enabled boolean DEFAULT NULL::boolean, p_pos_mtn_momo_enabled boolean DEFAULT NULL::boolean, p_pos_airtel_money_enabled boolean DEFAULT NULL::boolean, p_pos_card_enabled boolean DEFAULT NULL::boolean, p_pos_insurance_enabled boolean DEFAULT NULL::boolean, p_pos_default_payment_method text DEFAULT NULL::text, p_pos_require_patient_name boolean DEFAULT NULL::boolean, p_pos_allow_discounts boolean DEFAULT NULL::boolean, p_pos_show_patient_history boolean DEFAULT NULL::boolean, p_expiry_alert_threshold_days integer DEFAULT NULL::integer, p_default_reorder_min integer DEFAULT NULL::integer, p_branch_id uuid DEFAULT NULL::uuid)
 RETURNS void
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''
AS $function$
declare
  v_own_branch uuid;
  v_own_role text;
  v_branch uuid;
  v_caller_role text;
begin
  select u.branch_id, u.role into v_own_branch, v_own_role
  from public.users u
  where u.id = (select auth.uid()) and u.is_active and u.role in ('owner', 'manager');
  if v_own_branch is null then raise exception 'Only the branch owner or manager may update branch settings'; end if;

  v_branch := public.effective_branch_id(p_branch_id);
  if v_branch is null then raise exception 'No active branch for this session'; end if;
  perform public.assert_can_manage_org_branch_or_own(v_branch, v_own_branch);
  v_caller_role := case when v_branch = v_own_branch then v_own_role else 'owner' end;

  if p_out_of_stock_reminder_hours is not null and (p_out_of_stock_reminder_hours < 1 or p_out_of_stock_reminder_hours > 168) then
    raise exception 'Reminder interval must be between 1 and 168 hours';
  end if;
  if p_default_language is not null and p_default_language not in ('en','fr','rw') then
    raise exception 'Unsupported language %', p_default_language;
  end if;
  if p_pos_default_payment_method is not null and p_pos_default_payment_method not in ('cash','mtn_momo','airtel_money','card') then
    raise exception 'Unsupported default payment method %', p_pos_default_payment_method;
  end if;
  if p_expiry_alert_threshold_days is not null and p_expiry_alert_threshold_days < 1 then
    raise exception 'Expiry alert threshold must be at least 1 day';
  end if;
  if p_default_reorder_min is not null and p_default_reorder_min < 0 then
    raise exception 'Default reorder minimum cannot be negative';
  end if;

  update public.branches
  set address = nullif(btrim(coalesce(p_address, '')), ''),
      phone = nullif(btrim(coalesce(p_phone, '')), ''),
      tin = case when v_caller_role <> 'owner' then tin else nullif(btrim(coalesce(p_tin, '')), '') end,
      logo_path = case when p_logo_path is null then logo_path else nullif(btrim(p_logo_path), '') end,
      bank_account_number = case when v_caller_role <> 'owner' then bank_account_number
        when p_bank_account_number is null then bank_account_number else nullif(btrim(p_bank_account_number), '') end,
      bank_account_name = case when v_caller_role <> 'owner' then bank_account_name
        when p_bank_account_name is null then bank_account_name else nullif(btrim(p_bank_account_name), '') end,
      momo_pay_number = case when v_caller_role <> 'owner' then momo_pay_number
        when p_momo_pay_number is null then momo_pay_number else nullif(btrim(p_momo_pay_number), '') end,
      out_of_stock_reminder_hours = coalesce(p_out_of_stock_reminder_hours, out_of_stock_reminder_hours),
      name = coalesce(nullif(btrim(coalesce(p_name, '')), ''), name),
      email = case when p_email is null then email else nullif(btrim(p_email), '') end,
      website = case when p_website is null then website else nullif(btrim(p_website), '') end,
      license_number = case when v_caller_role <> 'owner' then license_number
        when p_license_number is null then license_number else nullif(btrim(p_license_number), '') end,
      license_expiry_date = case when v_caller_role <> 'owner' then license_expiry_date else p_license_expiry_date end,
      ebm_device_serial = case when v_caller_role <> 'owner' then ebm_device_serial
        when p_ebm_device_serial is null then ebm_device_serial else nullif(btrim(p_ebm_device_serial), '') end,
      default_language = coalesce(p_default_language, default_language),
      receipt_number_prefix = coalesce(nullif(btrim(coalesce(p_receipt_number_prefix, '')), ''), receipt_number_prefix),
      pos_cash_enabled = coalesce(p_pos_cash_enabled, pos_cash_enabled),
      pos_mtn_momo_enabled = coalesce(p_pos_mtn_momo_enabled, pos_mtn_momo_enabled),
      pos_airtel_money_enabled = coalesce(p_pos_airtel_money_enabled, pos_airtel_money_enabled),
      pos_card_enabled = coalesce(p_pos_card_enabled, pos_card_enabled),
      pos_insurance_enabled = coalesce(p_pos_insurance_enabled, pos_insurance_enabled),
      pos_default_payment_method = coalesce(p_pos_default_payment_method, pos_default_payment_method),
      pos_require_patient_name = coalesce(p_pos_require_patient_name, pos_require_patient_name),
      pos_allow_discounts = coalesce(p_pos_allow_discounts, pos_allow_discounts),
      pos_show_patient_history = coalesce(p_pos_show_patient_history, pos_show_patient_history),
      expiry_alert_threshold_days = coalesce(p_expiry_alert_threshold_days, expiry_alert_threshold_days),
      default_reorder_min = coalesce(p_default_reorder_min, default_reorder_min)
  where id = v_branch;
end;
$function$
;

revoke all on function public.update_branch_details(p_address text, p_phone text, p_tin text, p_logo_path text, p_bank_account_number text, p_bank_account_name text, p_momo_pay_number text, p_out_of_stock_reminder_hours integer, p_name text, p_email text, p_website text, p_license_number text, p_license_expiry_date date, p_ebm_device_serial text, p_default_language text, p_receipt_number_prefix text, p_pos_cash_enabled boolean, p_pos_mtn_momo_enabled boolean, p_pos_airtel_money_enabled boolean, p_pos_card_enabled boolean, p_pos_insurance_enabled boolean, p_pos_default_payment_method text, p_pos_require_patient_name boolean, p_pos_allow_discounts boolean, p_pos_show_patient_history boolean, p_expiry_alert_threshold_days integer, p_default_reorder_min integer, p_branch_id uuid) from public, anon;
grant execute on function public.update_branch_details(p_address text, p_phone text, p_tin text, p_logo_path text, p_bank_account_number text, p_bank_account_name text, p_momo_pay_number text, p_out_of_stock_reminder_hours integer, p_name text, p_email text, p_website text, p_license_number text, p_license_expiry_date date, p_ebm_device_serial text, p_default_language text, p_receipt_number_prefix text, p_pos_cash_enabled boolean, p_pos_mtn_momo_enabled boolean, p_pos_airtel_money_enabled boolean, p_pos_card_enabled boolean, p_pos_insurance_enabled boolean, p_pos_default_payment_method text, p_pos_require_patient_name boolean, p_pos_allow_discounts boolean, p_pos_show_patient_history boolean, p_expiry_alert_threshold_days integer, p_default_reorder_min integer, p_branch_id uuid) to authenticated;

-- ----------------------------------------------------------------------------

CREATE OR REPLACE FUNCTION public.update_branch_details(p_address text, p_phone text, p_tin text, p_logo_path text DEFAULT NULL::text, p_bank_account_number text DEFAULT NULL::text, p_bank_account_name text DEFAULT NULL::text, p_momo_pay_number text DEFAULT NULL::text, p_out_of_stock_reminder_hours integer DEFAULT NULL::integer, p_name text DEFAULT NULL::text, p_email text DEFAULT NULL::text, p_website text DEFAULT NULL::text, p_license_number text DEFAULT NULL::text, p_license_expiry_date date DEFAULT NULL::date, p_ebm_device_serial text DEFAULT NULL::text, p_default_language text DEFAULT NULL::text, p_receipt_number_prefix text DEFAULT NULL::text, p_pos_cash_enabled boolean DEFAULT NULL::boolean, p_pos_mtn_momo_enabled boolean DEFAULT NULL::boolean, p_pos_airtel_money_enabled boolean DEFAULT NULL::boolean, p_pos_card_enabled boolean DEFAULT NULL::boolean, p_pos_insurance_enabled boolean DEFAULT NULL::boolean, p_pos_default_payment_method text DEFAULT NULL::text, p_pos_require_patient_name boolean DEFAULT NULL::boolean, p_pos_allow_discounts boolean DEFAULT NULL::boolean, p_pos_show_patient_history boolean DEFAULT NULL::boolean, p_expiry_alert_threshold_days integer DEFAULT NULL::integer, p_default_reorder_min integer DEFAULT NULL::integer, p_branch_id uuid DEFAULT NULL::uuid, p_latitude double precision DEFAULT NULL::double precision, p_longitude double precision DEFAULT NULL::double precision)
 RETURNS void
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''
AS $function$
declare
  v_own_branch uuid;
  v_own_role text;
  v_branch uuid;
  v_caller_role text;
  v_target_org uuid;
  v_org_restricted boolean;
begin
  select u.branch_id, u.role into v_own_branch, v_own_role
  from public.users u
  where u.id = (select auth.uid()) and u.is_active and u.role in ('owner', 'manager');
  if v_own_branch is null then raise exception 'Only the branch owner or manager may update branch settings'; end if;

  v_branch := public.effective_branch_id(p_branch_id);
  if v_branch is null then raise exception 'No active branch for this session'; end if;
  perform public.assert_can_manage_org_branch_or_own(v_branch, v_own_branch);
  v_caller_role := case when v_branch = v_own_branch then v_own_role else 'owner' end;

  select organization_id into v_target_org from public.branches where id = v_branch;
  -- A manager acting on their OWN organization-affiliated branch: everything
  -- except address/phone/latitude/longitude stays fixed at its current
  -- value below. An org_owner/org_manager editing another branch was
  -- already normalized to v_caller_role = 'owner' above, so this never
  -- applies to them regardless of that branch's organization.
  v_org_restricted := v_caller_role <> 'owner' and v_target_org is not null;

  if p_out_of_stock_reminder_hours is not null and (p_out_of_stock_reminder_hours < 1 or p_out_of_stock_reminder_hours > 168) then
    raise exception 'Reminder interval must be between 1 and 168 hours';
  end if;
  if p_default_language is not null and p_default_language not in ('en','fr','rw') then
    raise exception 'Unsupported language %', p_default_language;
  end if;
  if p_pos_default_payment_method is not null and p_pos_default_payment_method not in ('cash','mtn_momo','airtel_money','card') then
    raise exception 'Unsupported default payment method %', p_pos_default_payment_method;
  end if;
  if p_expiry_alert_threshold_days is not null and p_expiry_alert_threshold_days < 1 then
    raise exception 'Expiry alert threshold must be at least 1 day';
  end if;
  if p_default_reorder_min is not null and p_default_reorder_min < 0 then
    raise exception 'Default reorder minimum cannot be negative';
  end if;
  if p_latitude is not null and (p_latitude < -90 or p_latitude > 90) then
    raise exception 'Latitude must be between -90 and 90';
  end if;
  if p_longitude is not null and (p_longitude < -180 or p_longitude > 180) then
    raise exception 'Longitude must be between -180 and 180';
  end if;

  update public.branches
  set address = nullif(btrim(coalesce(p_address, '')), ''),
      phone = nullif(btrim(coalesce(p_phone, '')), ''),
      tin = case when v_caller_role <> 'owner' then tin else nullif(btrim(coalesce(p_tin, '')), '') end,
      logo_path = case when p_logo_path is null then logo_path else nullif(btrim(p_logo_path), '') end,
      bank_account_number = case when v_caller_role <> 'owner' then bank_account_number
        when p_bank_account_number is null then bank_account_number else nullif(btrim(p_bank_account_number), '') end,
      bank_account_name = case when v_caller_role <> 'owner' then bank_account_name
        when p_bank_account_name is null then bank_account_name else nullif(btrim(p_bank_account_name), '') end,
      momo_pay_number = case when v_caller_role <> 'owner' then momo_pay_number
        when p_momo_pay_number is null then momo_pay_number else nullif(btrim(p_momo_pay_number), '') end,
      out_of_stock_reminder_hours = coalesce(p_out_of_stock_reminder_hours, out_of_stock_reminder_hours),
      name = case when v_org_restricted then name
        else coalesce(nullif(btrim(coalesce(p_name, '')), ''), name) end,
      email = case when v_org_restricted then email
        when p_email is null then email else nullif(btrim(p_email), '') end,
      website = case when v_org_restricted then website
        when p_website is null then website else nullif(btrim(p_website), '') end,
      license_number = case when v_caller_role <> 'owner' then license_number
        when p_license_number is null then license_number else nullif(btrim(p_license_number), '') end,
      license_expiry_date = case when v_caller_role <> 'owner' then license_expiry_date else p_license_expiry_date end,
      ebm_device_serial = case when v_caller_role <> 'owner' then ebm_device_serial
        when p_ebm_device_serial is null then ebm_device_serial else nullif(btrim(p_ebm_device_serial), '') end,
      default_language = coalesce(p_default_language, default_language),
      receipt_number_prefix = coalesce(nullif(btrim(coalesce(p_receipt_number_prefix, '')), ''), receipt_number_prefix),
      pos_cash_enabled = coalesce(p_pos_cash_enabled, pos_cash_enabled),
      pos_mtn_momo_enabled = coalesce(p_pos_mtn_momo_enabled, pos_mtn_momo_enabled),
      pos_airtel_money_enabled = coalesce(p_pos_airtel_money_enabled, pos_airtel_money_enabled),
      pos_card_enabled = coalesce(p_pos_card_enabled, pos_card_enabled),
      pos_insurance_enabled = coalesce(p_pos_insurance_enabled, pos_insurance_enabled),
      pos_default_payment_method = coalesce(p_pos_default_payment_method, pos_default_payment_method),
      pos_require_patient_name = coalesce(p_pos_require_patient_name, pos_require_patient_name),
      pos_allow_discounts = coalesce(p_pos_allow_discounts, pos_allow_discounts),
      pos_show_patient_history = coalesce(p_pos_show_patient_history, pos_show_patient_history),
      expiry_alert_threshold_days = coalesce(p_expiry_alert_threshold_days, expiry_alert_threshold_days),
      default_reorder_min = coalesce(p_default_reorder_min, default_reorder_min),
      latitude = p_latitude,
      longitude = p_longitude
  where id = v_branch;
end;
$function$
;

revoke all on function public.update_branch_details(p_address text, p_phone text, p_tin text, p_logo_path text, p_bank_account_number text, p_bank_account_name text, p_momo_pay_number text, p_out_of_stock_reminder_hours integer, p_name text, p_email text, p_website text, p_license_number text, p_license_expiry_date date, p_ebm_device_serial text, p_default_language text, p_receipt_number_prefix text, p_pos_cash_enabled boolean, p_pos_mtn_momo_enabled boolean, p_pos_airtel_money_enabled boolean, p_pos_card_enabled boolean, p_pos_insurance_enabled boolean, p_pos_default_payment_method text, p_pos_require_patient_name boolean, p_pos_allow_discounts boolean, p_pos_show_patient_history boolean, p_expiry_alert_threshold_days integer, p_default_reorder_min integer, p_branch_id uuid, p_latitude double precision, p_longitude double precision) from public, anon;
grant execute on function public.update_branch_details(p_address text, p_phone text, p_tin text, p_logo_path text, p_bank_account_number text, p_bank_account_name text, p_momo_pay_number text, p_out_of_stock_reminder_hours integer, p_name text, p_email text, p_website text, p_license_number text, p_license_expiry_date date, p_ebm_device_serial text, p_default_language text, p_receipt_number_prefix text, p_pos_cash_enabled boolean, p_pos_mtn_momo_enabled boolean, p_pos_airtel_money_enabled boolean, p_pos_card_enabled boolean, p_pos_insurance_enabled boolean, p_pos_default_payment_method text, p_pos_require_patient_name boolean, p_pos_allow_discounts boolean, p_pos_show_patient_history boolean, p_expiry_alert_threshold_days integer, p_default_reorder_min integer, p_branch_id uuid, p_latitude double precision, p_longitude double precision) to authenticated;

-- ----------------------------------------------------------------------------

CREATE OR REPLACE FUNCTION public.update_organization_details(p_organization_id uuid, p_legal_name text, p_trade_name text, p_tin text)
 RETURNS void
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''
AS $function$
begin
  perform public.assert_org_owner(p_organization_id);
  if nullif(btrim(coalesce(p_legal_name, '')), '') is null then
    raise exception 'A legal name is required';
  end if;

  update public.pharmacy_organizations
  set legal_name = btrim(p_legal_name),
      trade_name = nullif(btrim(coalesce(p_trade_name, '')), ''),
      tin = nullif(btrim(coalesce(p_tin, '')), '')
  where id = p_organization_id;
end;
$function$
;

revoke all on function public.update_organization_details(p_organization_id uuid, p_legal_name text, p_trade_name text, p_tin text) from public, anon;
grant execute on function public.update_organization_details(p_organization_id uuid, p_legal_name text, p_trade_name text, p_tin text) to authenticated;

-- ----------------------------------------------------------------------------

CREATE OR REPLACE FUNCTION public.upsert_patient(p_full_name text, p_gender text, p_age integer, p_phone text, p_tin text DEFAULT NULL::text, p_branch_id uuid DEFAULT NULL::uuid, p_insurance_number text DEFAULT NULL::text)
 RETURNS uuid
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''
AS $function$
declare
  v_user   uuid := (select auth.uid());
  v_branch uuid;
  v_phone  text := nullif(btrim(coalesce(p_phone, '')), '');
  v_tin    text := nullif(btrim(coalesce(p_tin, '')), '');
  v_ins    text := nullif(btrim(coalesce(p_insurance_number, '')), '');
  v_id     uuid;
begin
  v_branch := public.effective_branch_id(p_branch_id);
  if v_branch is null then raise exception 'Only an active branch user may record a patient'; end if;
  perform public.assert_can_manage_org_branch_or_own(v_branch, public.current_branch_id());
  if nullif(btrim(coalesce(p_full_name, '')), '') is null then raise exception 'A patient name is required'; end if;
  if v_phone is null then raise exception 'A phone number is required'; end if;
  if p_gender is not null and p_gender not in ('male','female','other') then raise exception 'Unknown gender'; end if;

  insert into public.patients (branch_id, full_name, gender, age, tin_or_phone, phone, tin, insurance_number, created_by)
  values (v_branch, btrim(p_full_name), p_gender, p_age, v_phone, v_phone, v_tin, v_ins, v_user)
  on conflict (branch_id, tin_or_phone)
  do update set
    full_name  = excluded.full_name,
    gender     = excluded.gender,
    age        = excluded.age,
    phone      = excluded.phone,
    -- Never blank an existing value just because this visit did not retype it.
    tin              = coalesce(excluded.tin, public.patients.tin),
    insurance_number = coalesce(excluded.insurance_number, public.patients.insurance_number),
    updated_at = now()
  returning id into v_id;

  return v_id;
end;
$function$
;

revoke all on function public.upsert_patient(p_full_name text, p_gender text, p_age integer, p_phone text, p_tin text, p_branch_id uuid, p_insurance_number text) from public, anon;
grant execute on function public.upsert_patient(p_full_name text, p_gender text, p_age integer, p_phone text, p_tin text, p_branch_id uuid, p_insurance_number text) to authenticated;


-- ============================================================================
-- POLICIES
-- ============================================================================

drop policy if exists "barcodes access" on public.barcodes;
create policy "barcodes access" on public.barcodes for SELECT to public
  using ((is_super_admin() OR (EXISTS ( SELECT 1
   FROM stock_batches sb
  WHERE ((sb.id = barcodes.stock_batch_id) AND ((sb.branch_id = current_branch_id()) OR (EXISTS ( SELECT 1
           FROM branches b
          WHERE ((b.id = sb.branch_id) AND (b.organization_id IS NOT NULL) AND is_org_member(b.organization_id))))))))));

drop policy if exists "recalls readable" on public.batch_recalls;
create policy "recalls readable" on public.batch_recalls for SELECT to authenticated
  using (true);

drop policy if exists "applications readable by holder or admin" on public.branch_applications;
create policy "applications readable by holder or admin" on public.branch_applications for SELECT to anon, authenticated
  using ((is_super_admin() OR false));

drop policy if exists "super admin manage applications" on public.branch_applications;
create policy "super admin manage applications" on public.branch_applications for ALL to authenticated
  using (is_super_admin())
  with check (is_super_admin());

drop policy if exists "branch directory is readable before sign-in" on public.branch_directory;
create policy "branch directory is readable before sign-in" on public.branch_directory for SELECT to anon, authenticated
  using (true);

drop policy if exists "org members view their measurements" on public.branch_distance_measurements;
create policy "org members view their measurements" on public.branch_distance_measurements for SELECT to authenticated
  using (is_org_member(organization_id));

drop policy if exists "categorization access" on public.branch_product_categorization;
create policy "categorization access" on public.branch_product_categorization for ALL to authenticated
  using ((is_super_admin() OR (branch_id = current_branch_id())))
  with check ((is_super_admin() OR (branch_id = current_branch_id())));

drop policy if exists "org members read branch_product_categorization org-wide" on public.branch_product_categorization;
create policy "org members read branch_product_categorization org-wide" on public.branch_product_categorization for SELECT to public
  using ((EXISTS ( SELECT 1
   FROM branches b
  WHERE ((b.id = branch_product_categorization.branch_id) AND (b.organization_id IS NOT NULL) AND is_org_member(b.organization_id)))));

drop policy if exists "branch access" on public.branch_settings;
create policy "branch access" on public.branch_settings for ALL to authenticated
  using ((is_super_admin() OR (branch_id = current_branch_id())))
  with check ((is_super_admin() OR (branch_id = current_branch_id())));

drop policy if exists "branch access" on public.branches;
create policy "branch access" on public.branches for SELECT to authenticated
  using ((is_super_admin() OR (id = current_branch_id())));

drop policy if exists "branch access" on public.dashboard_reports;
create policy "branch access" on public.dashboard_reports for ALL to authenticated
  using ((is_super_admin() OR (branch_id = current_branch_id())))
  with check ((is_super_admin() OR (branch_id = current_branch_id())));

drop policy if exists "super admin only" on public.deleted_branches_log;
create policy "super admin only" on public.deleted_branches_log for ALL to authenticated
  using (is_super_admin())
  with check (is_super_admin());

drop policy if exists "discounts readable" on public.discounts;
create policy "discounts readable" on public.discounts for SELECT to authenticated
  using (((branch_id IS NULL) OR (branch_id = current_branch_id()) OR is_super_admin()));

drop policy if exists "insurance claims branch access" on public.insurance_claims;
create policy "insurance claims branch access" on public.insurance_claims for SELECT to authenticated
  using ((is_super_admin() OR (EXISTS ( SELECT 1
   FROM sales s
  WHERE ((s.id = insurance_claims.sale_id) AND (s.branch_id = current_branch_id()))))));

drop policy if exists "insurance coverage readable" on public.insurance_product_coverage;
create policy "insurance coverage readable" on public.insurance_product_coverage for SELECT to authenticated
  using (true);

drop policy if exists "insurance providers readable" on public.insurance_providers;
create policy "insurance providers readable" on public.insurance_providers for SELECT to authenticated
  using (true);

drop policy if exists "insurance variant prices readable" on public.insurance_variant_prices;
create policy "insurance variant prices readable" on public.insurance_variant_prices for SELECT to authenticated
  using (true);

drop policy if exists "branch access" on public.notifications;
create policy "branch access" on public.notifications for ALL to authenticated
  using ((is_super_admin() OR (branch_id = current_branch_id()) OR (EXISTS ( SELECT 1
   FROM branches b
  WHERE ((b.id = notifications.branch_id) AND (b.organization_id IS NOT NULL) AND is_org_member(b.organization_id))))))
  with check ((is_super_admin() OR (branch_id = current_branch_id()) OR (EXISTS ( SELECT 1
   FROM branches b
  WHERE ((b.id = notifications.branch_id) AND (b.organization_id IS NOT NULL) AND is_org_member(b.organization_id))))));

drop policy if exists "org applications readable by admin" on public.organization_applications;
create policy "org applications readable by admin" on public.organization_applications for SELECT to anon, authenticated
  using ((is_super_admin() OR false));

drop policy if exists "super admin manage org applications" on public.organization_applications;
create policy "super admin manage org applications" on public.organization_applications for ALL to authenticated
  using (is_super_admin())
  with check (is_super_admin());

drop policy if exists "org members read own org invites" on public.organization_invites;
create policy "org members read own org invites" on public.organization_invites for SELECT to authenticated
  using ((is_super_admin() OR is_org_member(organization_id)));

drop policy if exists "organization members can read membership" on public.organization_members;
create policy "organization members can read membership" on public.organization_members for SELECT to authenticated
  using ((is_super_admin() OR (user_id = ( SELECT auth.uid() AS uid)) OR (EXISTS ( SELECT 1
   FROM organization_members m
  WHERE ((m.organization_id = organization_members.organization_id) AND (m.user_id = ( SELECT auth.uid() AS uid)))))));

drop policy if exists "branch access" on public.patients;
create policy "branch access" on public.patients for ALL to authenticated
  using ((is_super_admin() OR (branch_id = current_branch_id())))
  with check ((is_super_admin() OR (branch_id = current_branch_id())));

drop policy if exists pending_payments_select on public.pending_payments;
create policy pending_payments_select on public.pending_payments for SELECT to public
  using (((branch_id = current_branch_id()) OR is_org_member_or_own_branch_in_org(( SELECT branches.organization_id
   FROM branches
  WHERE (branches.id = pending_payments.branch_id))) OR is_super_admin()));

drop policy if exists "organization members can read" on public.pharmacy_organizations;
create policy "organization members can read" on public.pharmacy_organizations for SELECT to authenticated
  using ((is_super_admin() OR (EXISTS ( SELECT 1
   FROM organization_members m
  WHERE ((m.organization_id = m.id) AND (m.user_id = ( SELECT auth.uid() AS uid)))))));

drop policy if exists "branch access" on public.product_categories;
create policy "branch access" on public.product_categories for ALL to authenticated
  using ((is_super_admin() OR (branch_id = current_branch_id())))
  with check ((is_super_admin() OR (branch_id = current_branch_id())));

drop policy if exists "categories access" on public.product_categories;
create policy "categories access" on public.product_categories for ALL to authenticated
  using (((branch_id = current_branch_id()) OR is_super_admin()))
  with check (((branch_id = current_branch_id()) OR is_super_admin()));

drop policy if exists "org members read product_categories org-wide" on public.product_categories;
create policy "org members read product_categories org-wide" on public.product_categories for SELECT to public
  using ((EXISTS ( SELECT 1
   FROM branches b
  WHERE ((b.id = product_categories.branch_id) AND (b.organization_id IS NOT NULL) AND is_org_member(b.organization_id)))));

drop policy if exists "branch access" on public.product_requests;
create policy "branch access" on public.product_requests for ALL to authenticated
  using ((is_super_admin() OR (branch_id = current_branch_id())))
  with check ((is_super_admin() OR (branch_id = current_branch_id())));

drop policy if exists "product storage locations access" on public.product_storage_locations;
create policy "product storage locations access" on public.product_storage_locations for ALL to authenticated
  using (((branch_id = current_branch_id()) OR is_super_admin()))
  with check (((branch_id = current_branch_id()) OR is_super_admin()));

drop policy if exists "variants readable" on public.product_variants;
create policy "variants readable" on public.product_variants for SELECT to authenticated
  using (true);

drop policy if exists "products readable" on public.products;
create policy "products readable" on public.products for SELECT to authenticated
  using (true);

drop policy if exists "receipts branch access" on public.receipts;
create policy "receipts branch access" on public.receipts for SELECT to authenticated
  using ((is_super_admin() OR (EXISTS ( SELECT 1
   FROM sales s
  WHERE ((s.id = receipts.sale_id) AND (s.branch_id = current_branch_id()))))));

drop policy if exists "branch access" on public.reorder_points;
create policy "branch access" on public.reorder_points for ALL to authenticated
  using ((is_super_admin() OR (branch_id = current_branch_id()) OR (EXISTS ( SELECT 1
   FROM branches b
  WHERE ((b.id = reorder_points.branch_id) AND (b.organization_id IS NOT NULL) AND is_org_member(b.organization_id))))))
  with check ((is_super_admin() OR (branch_id = current_branch_id()) OR (EXISTS ( SELECT 1
   FROM branches b
  WHERE ((b.id = reorder_points.branch_id) AND (b.organization_id IS NOT NULL) AND is_org_member(b.organization_id))))));

drop policy if exists "role change log visible to relevant owners" on public.role_change_log;
create policy "role change log visible to relevant owners" on public.role_change_log for SELECT to authenticated
  using ((is_super_admin() OR ((organization_id IS NOT NULL) AND (EXISTS ( SELECT 1
   FROM organization_members m
  WHERE ((m.organization_id = role_change_log.organization_id) AND (m.user_id = ( SELECT auth.uid() AS uid)) AND ((m.role)::text = 'org_owner'::text))))) OR ((branch_id IS NOT NULL) AND (EXISTS ( SELECT 1
   FROM users u
  WHERE ((u.id = ( SELECT auth.uid() AS uid)) AND u.is_active AND ((u.role)::text = 'owner'::text) AND (u.branch_id = role_change_log.branch_id)))))));

drop policy if exists "sale items branch access" on public.sale_items;
create policy "sale items branch access" on public.sale_items for SELECT to authenticated
  using ((is_super_admin() OR (EXISTS ( SELECT 1
   FROM sales s
  WHERE ((s.id = sale_items.sale_id) AND (s.branch_id = current_branch_id()))))));

drop policy if exists "branch access" on public.sales;
create policy "branch access" on public.sales for ALL to authenticated
  using ((is_super_admin() OR (branch_id = current_branch_id())))
  with check ((is_super_admin() OR (branch_id = current_branch_id())));

drop policy if exists "sales branch access" on public.sales;
create policy "sales branch access" on public.sales for SELECT to authenticated
  using ((is_super_admin() OR (branch_id = current_branch_id())));

drop policy if exists "branch access" on public.sales_forecasts;
create policy "branch access" on public.sales_forecasts for ALL to authenticated
  using ((is_super_admin() OR (branch_id = current_branch_id())))
  with check ((is_super_admin() OR (branch_id = current_branch_id())));

drop policy if exists "adjustments access" on public.stock_adjustments;
create policy "adjustments access" on public.stock_adjustments for SELECT to authenticated
  using ((is_super_admin() OR (EXISTS ( SELECT 1
   FROM stock_batches sb
  WHERE ((sb.id = stock_adjustments.stock_batch_id) AND (sb.branch_id = current_branch_id())))) OR (EXISTS ( SELECT 1
   FROM (barcodes bc
     JOIN stock_batches sb ON ((sb.id = bc.stock_batch_id)))
  WHERE ((bc.id = stock_adjustments.barcode_id) AND (sb.branch_id = current_branch_id()))))));

drop policy if exists "branch access" on public.stock_batches;
create policy "branch access" on public.stock_batches for ALL to authenticated
  using ((is_super_admin() OR (branch_id = current_branch_id())))
  with check ((is_super_admin() OR (branch_id = current_branch_id())));

drop policy if exists "org members read stock_batches org-wide" on public.stock_batches;
create policy "org members read stock_batches org-wide" on public.stock_batches for SELECT to public
  using ((EXISTS ( SELECT 1
   FROM branches b
  WHERE ((b.id = stock_batches.branch_id) AND (b.organization_id IS NOT NULL) AND is_org_member(b.organization_id)))));

drop policy if exists "delivery access" on public.stock_deliveries;
create policy "delivery access" on public.stock_deliveries for ALL to authenticated
  using ((is_super_admin() OR (branch_id = current_branch_id())))
  with check ((is_super_admin() OR (branch_id = current_branch_id())));

drop policy if exists "transfer items follow their transfer" on public.stock_transfer_items;
create policy "transfer items follow their transfer" on public.stock_transfer_items for SELECT to authenticated
  using ((EXISTS ( SELECT 1
   FROM stock_transfers t
  WHERE ((t.id = stock_transfer_items.transfer_id) AND (is_super_admin() OR (t.from_branch_id = current_branch_id()) OR (t.to_branch_id = current_branch_id()) OR is_org_member(t.organization_id))))));

drop policy if exists "org members and the requesting branch see a stock need" on public.stock_transfer_needs;
create policy "org members and the requesting branch see a stock need" on public.stock_transfer_needs for SELECT to authenticated
  using ((is_super_admin() OR is_org_member(organization_id) OR (requesting_branch_id = current_branch_id())));

drop policy if exists "org members, the requester, and the asked branch see an offer" on public.stock_transfer_offers;
create policy "org members, the requester, and the asked branch see an offer" on public.stock_transfer_offers for SELECT to authenticated
  using ((is_super_admin() OR (target_branch_id = current_branch_id()) OR (EXISTS ( SELECT 1
   FROM stock_transfer_needs n
  WHERE ((n.id = stock_transfer_offers.need_id) AND (is_org_member(n.organization_id) OR (n.requesting_branch_id = current_branch_id())))))));

drop policy if exists "transfer visible to involved branches or org" on public.stock_transfers;
create policy "transfer visible to involved branches or org" on public.stock_transfers for SELECT to authenticated
  using ((is_super_admin() OR (from_branch_id = current_branch_id()) OR (to_branch_id = current_branch_id()) OR is_org_member(organization_id)));

drop policy if exists "storage locations access" on public.storage_locations;
create policy "storage locations access" on public.storage_locations for ALL to authenticated
  using (((branch_id = current_branch_id()) OR is_super_admin()))
  with check (((branch_id = current_branch_id()) OR is_super_admin()));

drop policy if exists "org members read suppliers org-wide" on public.suppliers;
create policy "org members read suppliers org-wide" on public.suppliers for SELECT to public
  using ((EXISTS ( SELECT 1
   FROM branches b
  WHERE ((b.id = suppliers.branch_id) AND (b.organization_id IS NOT NULL) AND is_org_member(b.organization_id)))));

drop policy if exists "suppliers access" on public.suppliers;
create policy "suppliers access" on public.suppliers for ALL to authenticated
  using ((is_super_admin() OR (branch_id = current_branch_id())))
  with check ((is_super_admin() OR (branch_id = current_branch_id())));

drop policy if exists "branch access" on public.support_tickets;
create policy "branch access" on public.support_tickets for ALL to authenticated
  using ((is_super_admin() OR (branch_id = current_branch_id())))
  with check ((is_super_admin() OR (branch_id = current_branch_id())));

drop policy if exists "tax rates readable" on public.tax_rates;
create policy "tax rates readable" on public.tax_rates for SELECT to authenticated
  using (true);

drop policy if exists "users read own branch" on public.users;
create policy "users read own branch" on public.users for SELECT to authenticated
  using ((is_super_admin() OR (id = ( SELECT auth.uid() AS uid)) OR (branch_id = current_branch_id())));


-- ============================================================================
-- TRIGGERS
-- ============================================================================

drop trigger if exists insurance_claims_stamp_insurer_tin on public.insurance_claims;
CREATE TRIGGER insurance_claims_stamp_insurer_tin AFTER INSERT ON public.insurance_claims FOR EACH ROW EXECUTE FUNCTION stamp_sale_insurer_tin();

drop trigger if exists trg_one_org_manager_per_org on public.organization_members;
CREATE CONSTRAINT TRIGGER trg_one_org_manager_per_org AFTER INSERT OR UPDATE OF role, organization_id ON public.organization_members DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION enforce_one_org_manager_per_org();

drop trigger if exists sales_stamp_patient_identifiers on public.sales;
CREATE TRIGGER sales_stamp_patient_identifiers BEFORE INSERT ON public.sales FOR EACH ROW EXECUTE FUNCTION stamp_sale_patient_identifiers();

drop trigger if exists trg_one_manager_per_branch on public.users;
CREATE CONSTRAINT TRIGGER trg_one_manager_per_branch AFTER INSERT OR UPDATE OF role, branch_id, is_active ON public.users DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION enforce_one_manager_per_branch();


-- ============================================================================
-- GRANTS (authenticated / anon)
-- ============================================================================

grant DELETE on public.barcodes to anon;
grant DELETE on public.barcodes to authenticated;
grant INSERT on public.barcodes to anon;
grant INSERT on public.barcodes to authenticated;
grant REFERENCES on public.barcodes to anon;
grant REFERENCES on public.barcodes to authenticated;
grant SELECT on public.barcodes to anon;
grant SELECT on public.barcodes to authenticated;
grant TRIGGER on public.barcodes to anon;
grant TRIGGER on public.barcodes to authenticated;
grant TRUNCATE on public.barcodes to anon;
grant TRUNCATE on public.barcodes to authenticated;
grant UPDATE on public.barcodes to anon;
grant UPDATE on public.barcodes to authenticated;
grant DELETE on public.batch_recalls to anon;
grant DELETE on public.batch_recalls to authenticated;
grant INSERT on public.batch_recalls to anon;
grant INSERT on public.batch_recalls to authenticated;
grant REFERENCES on public.batch_recalls to anon;
grant REFERENCES on public.batch_recalls to authenticated;
grant SELECT on public.batch_recalls to anon;
grant SELECT on public.batch_recalls to authenticated;
grant TRIGGER on public.batch_recalls to anon;
grant TRIGGER on public.batch_recalls to authenticated;
grant TRUNCATE on public.batch_recalls to anon;
grant TRUNCATE on public.batch_recalls to authenticated;
grant UPDATE on public.batch_recalls to anon;
grant UPDATE on public.batch_recalls to authenticated;
grant DELETE on public.branch_applications to anon;
grant DELETE on public.branch_applications to authenticated;
grant INSERT on public.branch_applications to anon;
grant INSERT on public.branch_applications to authenticated;
grant REFERENCES on public.branch_applications to anon;
grant REFERENCES on public.branch_applications to authenticated;
grant SELECT on public.branch_applications to anon;
grant SELECT on public.branch_applications to authenticated;
grant TRIGGER on public.branch_applications to anon;
grant TRIGGER on public.branch_applications to authenticated;
grant TRUNCATE on public.branch_applications to anon;
grant TRUNCATE on public.branch_applications to authenticated;
grant UPDATE on public.branch_applications to anon;
grant UPDATE on public.branch_applications to authenticated;
grant DELETE on public.branch_directory to anon;
grant DELETE on public.branch_directory to authenticated;
grant INSERT on public.branch_directory to anon;
grant INSERT on public.branch_directory to authenticated;
grant REFERENCES on public.branch_directory to anon;
grant REFERENCES on public.branch_directory to authenticated;
grant SELECT on public.branch_directory to anon;
grant SELECT on public.branch_directory to authenticated;
grant TRIGGER on public.branch_directory to anon;
grant TRIGGER on public.branch_directory to authenticated;
grant TRUNCATE on public.branch_directory to anon;
grant TRUNCATE on public.branch_directory to authenticated;
grant UPDATE on public.branch_directory to anon;
grant UPDATE on public.branch_directory to authenticated;
grant DELETE on public.branch_distance_measurements to anon;
grant DELETE on public.branch_distance_measurements to authenticated;
grant INSERT on public.branch_distance_measurements to anon;
grant INSERT on public.branch_distance_measurements to authenticated;
grant REFERENCES on public.branch_distance_measurements to anon;
grant REFERENCES on public.branch_distance_measurements to authenticated;
grant SELECT on public.branch_distance_measurements to anon;
grant SELECT on public.branch_distance_measurements to authenticated;
grant TRIGGER on public.branch_distance_measurements to anon;
grant TRIGGER on public.branch_distance_measurements to authenticated;
grant TRUNCATE on public.branch_distance_measurements to anon;
grant TRUNCATE on public.branch_distance_measurements to authenticated;
grant UPDATE on public.branch_distance_measurements to anon;
grant UPDATE on public.branch_distance_measurements to authenticated;
grant DELETE on public.branch_product_categorization to anon;
grant DELETE on public.branch_product_categorization to authenticated;
grant INSERT on public.branch_product_categorization to anon;
grant INSERT on public.branch_product_categorization to authenticated;
grant REFERENCES on public.branch_product_categorization to anon;
grant REFERENCES on public.branch_product_categorization to authenticated;
grant SELECT on public.branch_product_categorization to anon;
grant SELECT on public.branch_product_categorization to authenticated;
grant TRIGGER on public.branch_product_categorization to anon;
grant TRIGGER on public.branch_product_categorization to authenticated;
grant TRUNCATE on public.branch_product_categorization to anon;
grant TRUNCATE on public.branch_product_categorization to authenticated;
grant UPDATE on public.branch_product_categorization to anon;
grant UPDATE on public.branch_product_categorization to authenticated;
grant DELETE on public.branch_settings to anon;
grant DELETE on public.branch_settings to authenticated;
grant INSERT on public.branch_settings to anon;
grant INSERT on public.branch_settings to authenticated;
grant REFERENCES on public.branch_settings to anon;
grant REFERENCES on public.branch_settings to authenticated;
grant SELECT on public.branch_settings to anon;
grant SELECT on public.branch_settings to authenticated;
grant TRIGGER on public.branch_settings to anon;
grant TRIGGER on public.branch_settings to authenticated;
grant TRUNCATE on public.branch_settings to anon;
grant TRUNCATE on public.branch_settings to authenticated;
grant UPDATE on public.branch_settings to anon;
grant UPDATE on public.branch_settings to authenticated;
grant DELETE on public.branches to anon;
grant DELETE on public.branches to authenticated;
grant INSERT on public.branches to anon;
grant INSERT on public.branches to authenticated;
grant REFERENCES on public.branches to anon;
grant REFERENCES on public.branches to authenticated;
grant SELECT on public.branches to anon;
grant SELECT on public.branches to authenticated;
grant TRIGGER on public.branches to anon;
grant TRIGGER on public.branches to authenticated;
grant TRUNCATE on public.branches to anon;
grant TRUNCATE on public.branches to authenticated;
grant UPDATE on public.branches to anon;
grant UPDATE on public.branches to authenticated;
grant DELETE on public.dashboard_reports to anon;
grant DELETE on public.dashboard_reports to authenticated;
grant INSERT on public.dashboard_reports to anon;
grant INSERT on public.dashboard_reports to authenticated;
grant REFERENCES on public.dashboard_reports to anon;
grant REFERENCES on public.dashboard_reports to authenticated;
grant SELECT on public.dashboard_reports to anon;
grant SELECT on public.dashboard_reports to authenticated;
grant TRIGGER on public.dashboard_reports to anon;
grant TRIGGER on public.dashboard_reports to authenticated;
grant TRUNCATE on public.dashboard_reports to anon;
grant TRUNCATE on public.dashboard_reports to authenticated;
grant UPDATE on public.dashboard_reports to anon;
grant UPDATE on public.dashboard_reports to authenticated;
grant DELETE on public.deleted_branches_log to anon;
grant DELETE on public.deleted_branches_log to authenticated;
grant INSERT on public.deleted_branches_log to anon;
grant INSERT on public.deleted_branches_log to authenticated;
grant REFERENCES on public.deleted_branches_log to anon;
grant REFERENCES on public.deleted_branches_log to authenticated;
grant SELECT on public.deleted_branches_log to anon;
grant SELECT on public.deleted_branches_log to authenticated;
grant TRIGGER on public.deleted_branches_log to anon;
grant TRIGGER on public.deleted_branches_log to authenticated;
grant TRUNCATE on public.deleted_branches_log to anon;
grant TRUNCATE on public.deleted_branches_log to authenticated;
grant UPDATE on public.deleted_branches_log to anon;
grant UPDATE on public.deleted_branches_log to authenticated;
grant DELETE on public.discounts to anon;
grant DELETE on public.discounts to authenticated;
grant INSERT on public.discounts to anon;
grant INSERT on public.discounts to authenticated;
grant REFERENCES on public.discounts to anon;
grant REFERENCES on public.discounts to authenticated;
grant SELECT on public.discounts to anon;
grant SELECT on public.discounts to authenticated;
grant TRIGGER on public.discounts to anon;
grant TRIGGER on public.discounts to authenticated;
grant TRUNCATE on public.discounts to anon;
grant TRUNCATE on public.discounts to authenticated;
grant UPDATE on public.discounts to anon;
grant UPDATE on public.discounts to authenticated;
grant DELETE on public.insurance_claims to anon;
grant DELETE on public.insurance_claims to authenticated;
grant INSERT on public.insurance_claims to anon;
grant INSERT on public.insurance_claims to authenticated;
grant REFERENCES on public.insurance_claims to anon;
grant REFERENCES on public.insurance_claims to authenticated;
grant SELECT on public.insurance_claims to anon;
grant SELECT on public.insurance_claims to authenticated;
grant TRIGGER on public.insurance_claims to anon;
grant TRIGGER on public.insurance_claims to authenticated;
grant TRUNCATE on public.insurance_claims to anon;
grant TRUNCATE on public.insurance_claims to authenticated;
grant UPDATE on public.insurance_claims to anon;
grant UPDATE on public.insurance_claims to authenticated;
grant DELETE on public.insurance_product_coverage to anon;
grant DELETE on public.insurance_product_coverage to authenticated;
grant INSERT on public.insurance_product_coverage to anon;
grant INSERT on public.insurance_product_coverage to authenticated;
grant REFERENCES on public.insurance_product_coverage to anon;
grant REFERENCES on public.insurance_product_coverage to authenticated;
grant SELECT on public.insurance_product_coverage to anon;
grant SELECT on public.insurance_product_coverage to authenticated;
grant TRIGGER on public.insurance_product_coverage to anon;
grant TRIGGER on public.insurance_product_coverage to authenticated;
grant TRUNCATE on public.insurance_product_coverage to anon;
grant TRUNCATE on public.insurance_product_coverage to authenticated;
grant UPDATE on public.insurance_product_coverage to anon;
grant UPDATE on public.insurance_product_coverage to authenticated;
grant DELETE on public.insurance_providers to anon;
grant DELETE on public.insurance_providers to authenticated;
grant INSERT on public.insurance_providers to anon;
grant INSERT on public.insurance_providers to authenticated;
grant REFERENCES on public.insurance_providers to anon;
grant REFERENCES on public.insurance_providers to authenticated;
grant SELECT on public.insurance_providers to anon;
grant SELECT on public.insurance_providers to authenticated;
grant TRIGGER on public.insurance_providers to anon;
grant TRIGGER on public.insurance_providers to authenticated;
grant TRUNCATE on public.insurance_providers to anon;
grant TRUNCATE on public.insurance_providers to authenticated;
grant UPDATE on public.insurance_providers to anon;
grant UPDATE on public.insurance_providers to authenticated;
grant DELETE on public.insurance_variant_prices to anon;
grant DELETE on public.insurance_variant_prices to authenticated;
grant INSERT on public.insurance_variant_prices to anon;
grant INSERT on public.insurance_variant_prices to authenticated;
grant REFERENCES on public.insurance_variant_prices to anon;
grant REFERENCES on public.insurance_variant_prices to authenticated;
grant SELECT on public.insurance_variant_prices to anon;
grant SELECT on public.insurance_variant_prices to authenticated;
grant TRIGGER on public.insurance_variant_prices to anon;
grant TRIGGER on public.insurance_variant_prices to authenticated;
grant TRUNCATE on public.insurance_variant_prices to anon;
grant TRUNCATE on public.insurance_variant_prices to authenticated;
grant UPDATE on public.insurance_variant_prices to anon;
grant UPDATE on public.insurance_variant_prices to authenticated;
grant DELETE on public.notifications to anon;
grant DELETE on public.notifications to authenticated;
grant INSERT on public.notifications to anon;
grant INSERT on public.notifications to authenticated;
grant REFERENCES on public.notifications to anon;
grant REFERENCES on public.notifications to authenticated;
grant SELECT on public.notifications to anon;
grant SELECT on public.notifications to authenticated;
grant TRIGGER on public.notifications to anon;
grant TRIGGER on public.notifications to authenticated;
grant TRUNCATE on public.notifications to anon;
grant TRUNCATE on public.notifications to authenticated;
grant UPDATE on public.notifications to anon;
grant UPDATE on public.notifications to authenticated;
grant DELETE on public.organization_applications to anon;
grant DELETE on public.organization_applications to authenticated;
grant INSERT on public.organization_applications to anon;
grant INSERT on public.organization_applications to authenticated;
grant REFERENCES on public.organization_applications to anon;
grant REFERENCES on public.organization_applications to authenticated;
grant SELECT on public.organization_applications to anon;
grant SELECT on public.organization_applications to authenticated;
grant TRIGGER on public.organization_applications to anon;
grant TRIGGER on public.organization_applications to authenticated;
grant TRUNCATE on public.organization_applications to anon;
grant TRUNCATE on public.organization_applications to authenticated;
grant UPDATE on public.organization_applications to anon;
grant UPDATE on public.organization_applications to authenticated;
grant DELETE on public.organization_invites to anon;
grant DELETE on public.organization_invites to authenticated;
grant INSERT on public.organization_invites to anon;
grant INSERT on public.organization_invites to authenticated;
grant REFERENCES on public.organization_invites to anon;
grant REFERENCES on public.organization_invites to authenticated;
grant SELECT on public.organization_invites to anon;
grant SELECT on public.organization_invites to authenticated;
grant TRIGGER on public.organization_invites to anon;
grant TRIGGER on public.organization_invites to authenticated;
grant TRUNCATE on public.organization_invites to anon;
grant TRUNCATE on public.organization_invites to authenticated;
grant UPDATE on public.organization_invites to anon;
grant UPDATE on public.organization_invites to authenticated;
grant DELETE on public.organization_members to anon;
grant DELETE on public.organization_members to authenticated;
grant INSERT on public.organization_members to anon;
grant INSERT on public.organization_members to authenticated;
grant REFERENCES on public.organization_members to anon;
grant REFERENCES on public.organization_members to authenticated;
grant SELECT on public.organization_members to anon;
grant SELECT on public.organization_members to authenticated;
grant TRIGGER on public.organization_members to anon;
grant TRIGGER on public.organization_members to authenticated;
grant TRUNCATE on public.organization_members to anon;
grant TRUNCATE on public.organization_members to authenticated;
grant UPDATE on public.organization_members to anon;
grant UPDATE on public.organization_members to authenticated;
grant DELETE on public.patients to anon;
grant DELETE on public.patients to authenticated;
grant INSERT on public.patients to anon;
grant INSERT on public.patients to authenticated;
grant REFERENCES on public.patients to anon;
grant REFERENCES on public.patients to authenticated;
grant SELECT on public.patients to anon;
grant SELECT on public.patients to authenticated;
grant TRIGGER on public.patients to anon;
grant TRIGGER on public.patients to authenticated;
grant TRUNCATE on public.patients to anon;
grant TRUNCATE on public.patients to authenticated;
grant UPDATE on public.patients to anon;
grant UPDATE on public.patients to authenticated;
grant SELECT on public.pending_payments to authenticated;
grant DELETE on public.pharmacy_organizations to anon;
grant DELETE on public.pharmacy_organizations to authenticated;
grant INSERT on public.pharmacy_organizations to anon;
grant INSERT on public.pharmacy_organizations to authenticated;
grant REFERENCES on public.pharmacy_organizations to anon;
grant REFERENCES on public.pharmacy_organizations to authenticated;
grant SELECT on public.pharmacy_organizations to anon;
grant SELECT on public.pharmacy_organizations to authenticated;
grant TRIGGER on public.pharmacy_organizations to anon;
grant TRIGGER on public.pharmacy_organizations to authenticated;
grant TRUNCATE on public.pharmacy_organizations to anon;
grant TRUNCATE on public.pharmacy_organizations to authenticated;
grant UPDATE on public.pharmacy_organizations to anon;
grant UPDATE on public.pharmacy_organizations to authenticated;
grant DELETE on public.product_categories to anon;
grant DELETE on public.product_categories to authenticated;
grant INSERT on public.product_categories to anon;
grant INSERT on public.product_categories to authenticated;
grant REFERENCES on public.product_categories to anon;
grant REFERENCES on public.product_categories to authenticated;
grant SELECT on public.product_categories to anon;
grant SELECT on public.product_categories to authenticated;
grant TRIGGER on public.product_categories to anon;
grant TRIGGER on public.product_categories to authenticated;
grant TRUNCATE on public.product_categories to anon;
grant TRUNCATE on public.product_categories to authenticated;
grant UPDATE on public.product_categories to anon;
grant UPDATE on public.product_categories to authenticated;
grant DELETE on public.product_requests to anon;
grant DELETE on public.product_requests to authenticated;
grant INSERT on public.product_requests to anon;
grant INSERT on public.product_requests to authenticated;
grant REFERENCES on public.product_requests to anon;
grant REFERENCES on public.product_requests to authenticated;
grant SELECT on public.product_requests to anon;
grant SELECT on public.product_requests to authenticated;
grant TRIGGER on public.product_requests to anon;
grant TRIGGER on public.product_requests to authenticated;
grant TRUNCATE on public.product_requests to anon;
grant TRUNCATE on public.product_requests to authenticated;
grant UPDATE on public.product_requests to anon;
grant UPDATE on public.product_requests to authenticated;
grant DELETE on public.product_storage_locations to anon;
grant DELETE on public.product_storage_locations to authenticated;
grant INSERT on public.product_storage_locations to anon;
grant INSERT on public.product_storage_locations to authenticated;
grant REFERENCES on public.product_storage_locations to anon;
grant REFERENCES on public.product_storage_locations to authenticated;
grant SELECT on public.product_storage_locations to anon;
grant SELECT on public.product_storage_locations to authenticated;
grant TRIGGER on public.product_storage_locations to anon;
grant TRIGGER on public.product_storage_locations to authenticated;
grant TRUNCATE on public.product_storage_locations to anon;
grant TRUNCATE on public.product_storage_locations to authenticated;
grant UPDATE on public.product_storage_locations to anon;
grant UPDATE on public.product_storage_locations to authenticated;
grant DELETE on public.product_variants to anon;
grant DELETE on public.product_variants to authenticated;
grant INSERT on public.product_variants to anon;
grant INSERT on public.product_variants to authenticated;
grant REFERENCES on public.product_variants to anon;
grant REFERENCES on public.product_variants to authenticated;
grant SELECT on public.product_variants to anon;
grant SELECT on public.product_variants to authenticated;
grant TRIGGER on public.product_variants to anon;
grant TRIGGER on public.product_variants to authenticated;
grant TRUNCATE on public.product_variants to anon;
grant TRUNCATE on public.product_variants to authenticated;
grant UPDATE on public.product_variants to anon;
grant UPDATE on public.product_variants to authenticated;
grant DELETE on public.products to anon;
grant DELETE on public.products to authenticated;
grant INSERT on public.products to anon;
grant INSERT on public.products to authenticated;
grant REFERENCES on public.products to anon;
grant REFERENCES on public.products to authenticated;
grant SELECT on public.products to anon;
grant SELECT on public.products to authenticated;
grant TRIGGER on public.products to anon;
grant TRIGGER on public.products to authenticated;
grant TRUNCATE on public.products to anon;
grant TRUNCATE on public.products to authenticated;
grant UPDATE on public.products to anon;
grant UPDATE on public.products to authenticated;
grant DELETE on public.receipts to anon;
grant DELETE on public.receipts to authenticated;
grant INSERT on public.receipts to anon;
grant INSERT on public.receipts to authenticated;
grant REFERENCES on public.receipts to anon;
grant REFERENCES on public.receipts to authenticated;
grant SELECT on public.receipts to anon;
grant SELECT on public.receipts to authenticated;
grant TRIGGER on public.receipts to anon;
grant TRIGGER on public.receipts to authenticated;
grant TRUNCATE on public.receipts to anon;
grant TRUNCATE on public.receipts to authenticated;
grant UPDATE on public.receipts to anon;
grant UPDATE on public.receipts to authenticated;
grant DELETE on public.reorder_points to anon;
grant DELETE on public.reorder_points to authenticated;
grant INSERT on public.reorder_points to anon;
grant INSERT on public.reorder_points to authenticated;
grant REFERENCES on public.reorder_points to anon;
grant REFERENCES on public.reorder_points to authenticated;
grant SELECT on public.reorder_points to anon;
grant SELECT on public.reorder_points to authenticated;
grant TRIGGER on public.reorder_points to anon;
grant TRIGGER on public.reorder_points to authenticated;
grant TRUNCATE on public.reorder_points to anon;
grant TRUNCATE on public.reorder_points to authenticated;
grant UPDATE on public.reorder_points to anon;
grant UPDATE on public.reorder_points to authenticated;
grant DELETE on public.role_change_log to anon;
grant DELETE on public.role_change_log to authenticated;
grant INSERT on public.role_change_log to anon;
grant INSERT on public.role_change_log to authenticated;
grant REFERENCES on public.role_change_log to anon;
grant REFERENCES on public.role_change_log to authenticated;
grant SELECT on public.role_change_log to anon;
grant SELECT on public.role_change_log to authenticated;
grant TRIGGER on public.role_change_log to anon;
grant TRIGGER on public.role_change_log to authenticated;
grant TRUNCATE on public.role_change_log to anon;
grant TRUNCATE on public.role_change_log to authenticated;
grant UPDATE on public.role_change_log to anon;
grant UPDATE on public.role_change_log to authenticated;
grant DELETE on public.sale_items to anon;
grant DELETE on public.sale_items to authenticated;
grant INSERT on public.sale_items to anon;
grant INSERT on public.sale_items to authenticated;
grant REFERENCES on public.sale_items to anon;
grant REFERENCES on public.sale_items to authenticated;
grant SELECT on public.sale_items to anon;
grant SELECT on public.sale_items to authenticated;
grant TRIGGER on public.sale_items to anon;
grant TRIGGER on public.sale_items to authenticated;
grant TRUNCATE on public.sale_items to anon;
grant TRUNCATE on public.sale_items to authenticated;
grant UPDATE on public.sale_items to anon;
grant UPDATE on public.sale_items to authenticated;
grant DELETE on public.sales to anon;
grant DELETE on public.sales to authenticated;
grant INSERT on public.sales to anon;
grant INSERT on public.sales to authenticated;
grant REFERENCES on public.sales to anon;
grant REFERENCES on public.sales to authenticated;
grant SELECT on public.sales to anon;
grant SELECT on public.sales to authenticated;
grant TRIGGER on public.sales to anon;
grant TRIGGER on public.sales to authenticated;
grant TRUNCATE on public.sales to anon;
grant TRUNCATE on public.sales to authenticated;
grant UPDATE on public.sales to anon;
grant UPDATE on public.sales to authenticated;
grant DELETE on public.sales_forecast_snapshots to anon;
grant DELETE on public.sales_forecast_snapshots to authenticated;
grant INSERT on public.sales_forecast_snapshots to anon;
grant INSERT on public.sales_forecast_snapshots to authenticated;
grant REFERENCES on public.sales_forecast_snapshots to anon;
grant REFERENCES on public.sales_forecast_snapshots to authenticated;
grant SELECT on public.sales_forecast_snapshots to anon;
grant SELECT on public.sales_forecast_snapshots to authenticated;
grant TRIGGER on public.sales_forecast_snapshots to anon;
grant TRIGGER on public.sales_forecast_snapshots to authenticated;
grant TRUNCATE on public.sales_forecast_snapshots to anon;
grant TRUNCATE on public.sales_forecast_snapshots to authenticated;
grant UPDATE on public.sales_forecast_snapshots to anon;
grant UPDATE on public.sales_forecast_snapshots to authenticated;
grant DELETE on public.sales_forecasts to anon;
grant DELETE on public.sales_forecasts to authenticated;
grant INSERT on public.sales_forecasts to anon;
grant INSERT on public.sales_forecasts to authenticated;
grant REFERENCES on public.sales_forecasts to anon;
grant REFERENCES on public.sales_forecasts to authenticated;
grant SELECT on public.sales_forecasts to anon;
grant SELECT on public.sales_forecasts to authenticated;
grant TRIGGER on public.sales_forecasts to anon;
grant TRIGGER on public.sales_forecasts to authenticated;
grant TRUNCATE on public.sales_forecasts to anon;
grant TRUNCATE on public.sales_forecasts to authenticated;
grant UPDATE on public.sales_forecasts to anon;
grant UPDATE on public.sales_forecasts to authenticated;
grant DELETE on public.stock_adjustments to anon;
grant DELETE on public.stock_adjustments to authenticated;
grant INSERT on public.stock_adjustments to anon;
grant INSERT on public.stock_adjustments to authenticated;
grant REFERENCES on public.stock_adjustments to anon;
grant REFERENCES on public.stock_adjustments to authenticated;
grant SELECT on public.stock_adjustments to anon;
grant SELECT on public.stock_adjustments to authenticated;
grant TRIGGER on public.stock_adjustments to anon;
grant TRIGGER on public.stock_adjustments to authenticated;
grant TRUNCATE on public.stock_adjustments to anon;
grant TRUNCATE on public.stock_adjustments to authenticated;
grant UPDATE on public.stock_adjustments to anon;
grant UPDATE on public.stock_adjustments to authenticated;
grant DELETE on public.stock_batches to anon;
grant DELETE on public.stock_batches to authenticated;
grant INSERT on public.stock_batches to anon;
grant INSERT on public.stock_batches to authenticated;
grant REFERENCES on public.stock_batches to anon;
grant REFERENCES on public.stock_batches to authenticated;
grant SELECT on public.stock_batches to anon;
grant SELECT on public.stock_batches to authenticated;
grant TRIGGER on public.stock_batches to anon;
grant TRIGGER on public.stock_batches to authenticated;
grant TRUNCATE on public.stock_batches to anon;
grant TRUNCATE on public.stock_batches to authenticated;
grant UPDATE on public.stock_batches to anon;
grant UPDATE on public.stock_batches to authenticated;
grant DELETE on public.stock_deliveries to anon;
grant DELETE on public.stock_deliveries to authenticated;
grant INSERT on public.stock_deliveries to anon;
grant INSERT on public.stock_deliveries to authenticated;
grant REFERENCES on public.stock_deliveries to anon;
grant REFERENCES on public.stock_deliveries to authenticated;
grant SELECT on public.stock_deliveries to anon;
grant SELECT on public.stock_deliveries to authenticated;
grant TRIGGER on public.stock_deliveries to anon;
grant TRIGGER on public.stock_deliveries to authenticated;
grant TRUNCATE on public.stock_deliveries to anon;
grant TRUNCATE on public.stock_deliveries to authenticated;
grant UPDATE on public.stock_deliveries to anon;
grant UPDATE on public.stock_deliveries to authenticated;
grant DELETE on public.stock_transfer_items to anon;
grant DELETE on public.stock_transfer_items to authenticated;
grant INSERT on public.stock_transfer_items to anon;
grant INSERT on public.stock_transfer_items to authenticated;
grant REFERENCES on public.stock_transfer_items to anon;
grant REFERENCES on public.stock_transfer_items to authenticated;
grant SELECT on public.stock_transfer_items to anon;
grant SELECT on public.stock_transfer_items to authenticated;
grant TRIGGER on public.stock_transfer_items to anon;
grant TRIGGER on public.stock_transfer_items to authenticated;
grant TRUNCATE on public.stock_transfer_items to anon;
grant TRUNCATE on public.stock_transfer_items to authenticated;
grant UPDATE on public.stock_transfer_items to anon;
grant UPDATE on public.stock_transfer_items to authenticated;
grant DELETE on public.stock_transfer_needs to anon;
grant DELETE on public.stock_transfer_needs to authenticated;
grant INSERT on public.stock_transfer_needs to anon;
grant INSERT on public.stock_transfer_needs to authenticated;
grant REFERENCES on public.stock_transfer_needs to anon;
grant REFERENCES on public.stock_transfer_needs to authenticated;
grant SELECT on public.stock_transfer_needs to anon;
grant SELECT on public.stock_transfer_needs to authenticated;
grant TRIGGER on public.stock_transfer_needs to anon;
grant TRIGGER on public.stock_transfer_needs to authenticated;
grant TRUNCATE on public.stock_transfer_needs to anon;
grant TRUNCATE on public.stock_transfer_needs to authenticated;
grant UPDATE on public.stock_transfer_needs to anon;
grant UPDATE on public.stock_transfer_needs to authenticated;
grant DELETE on public.stock_transfer_offers to anon;
grant DELETE on public.stock_transfer_offers to authenticated;
grant INSERT on public.stock_transfer_offers to anon;
grant INSERT on public.stock_transfer_offers to authenticated;
grant REFERENCES on public.stock_transfer_offers to anon;
grant REFERENCES on public.stock_transfer_offers to authenticated;
grant SELECT on public.stock_transfer_offers to anon;
grant SELECT on public.stock_transfer_offers to authenticated;
grant TRIGGER on public.stock_transfer_offers to anon;
grant TRIGGER on public.stock_transfer_offers to authenticated;
grant TRUNCATE on public.stock_transfer_offers to anon;
grant TRUNCATE on public.stock_transfer_offers to authenticated;
grant UPDATE on public.stock_transfer_offers to anon;
grant UPDATE on public.stock_transfer_offers to authenticated;
grant DELETE on public.stock_transfers to anon;
grant DELETE on public.stock_transfers to authenticated;
grant INSERT on public.stock_transfers to anon;
grant INSERT on public.stock_transfers to authenticated;
grant REFERENCES on public.stock_transfers to anon;
grant REFERENCES on public.stock_transfers to authenticated;
grant SELECT on public.stock_transfers to anon;
grant SELECT on public.stock_transfers to authenticated;
grant TRIGGER on public.stock_transfers to anon;
grant TRIGGER on public.stock_transfers to authenticated;
grant TRUNCATE on public.stock_transfers to anon;
grant TRUNCATE on public.stock_transfers to authenticated;
grant UPDATE on public.stock_transfers to anon;
grant UPDATE on public.stock_transfers to authenticated;
grant DELETE on public.storage_locations to anon;
grant DELETE on public.storage_locations to authenticated;
grant INSERT on public.storage_locations to anon;
grant INSERT on public.storage_locations to authenticated;
grant REFERENCES on public.storage_locations to anon;
grant REFERENCES on public.storage_locations to authenticated;
grant SELECT on public.storage_locations to anon;
grant SELECT on public.storage_locations to authenticated;
grant TRIGGER on public.storage_locations to anon;
grant TRIGGER on public.storage_locations to authenticated;
grant TRUNCATE on public.storage_locations to anon;
grant TRUNCATE on public.storage_locations to authenticated;
grant UPDATE on public.storage_locations to anon;
grant UPDATE on public.storage_locations to authenticated;
grant DELETE on public.suppliers to anon;
grant DELETE on public.suppliers to authenticated;
grant INSERT on public.suppliers to anon;
grant INSERT on public.suppliers to authenticated;
grant REFERENCES on public.suppliers to anon;
grant REFERENCES on public.suppliers to authenticated;
grant SELECT on public.suppliers to anon;
grant SELECT on public.suppliers to authenticated;
grant TRIGGER on public.suppliers to anon;
grant TRIGGER on public.suppliers to authenticated;
grant TRUNCATE on public.suppliers to anon;
grant TRUNCATE on public.suppliers to authenticated;
grant UPDATE on public.suppliers to anon;
grant UPDATE on public.suppliers to authenticated;
grant DELETE on public.support_tickets to anon;
grant DELETE on public.support_tickets to authenticated;
grant INSERT on public.support_tickets to anon;
grant INSERT on public.support_tickets to authenticated;
grant REFERENCES on public.support_tickets to anon;
grant REFERENCES on public.support_tickets to authenticated;
grant SELECT on public.support_tickets to anon;
grant SELECT on public.support_tickets to authenticated;
grant TRIGGER on public.support_tickets to anon;
grant TRIGGER on public.support_tickets to authenticated;
grant TRUNCATE on public.support_tickets to anon;
grant TRUNCATE on public.support_tickets to authenticated;
grant UPDATE on public.support_tickets to anon;
grant UPDATE on public.support_tickets to authenticated;
grant DELETE on public.tax_rates to anon;
grant DELETE on public.tax_rates to authenticated;
grant INSERT on public.tax_rates to anon;
grant INSERT on public.tax_rates to authenticated;
grant REFERENCES on public.tax_rates to anon;
grant REFERENCES on public.tax_rates to authenticated;
grant SELECT on public.tax_rates to anon;
grant SELECT on public.tax_rates to authenticated;
grant TRIGGER on public.tax_rates to anon;
grant TRIGGER on public.tax_rates to authenticated;
grant TRUNCATE on public.tax_rates to anon;
grant TRUNCATE on public.tax_rates to authenticated;
grant UPDATE on public.tax_rates to anon;
grant UPDATE on public.tax_rates to authenticated;
grant DELETE on public.users to anon;
grant DELETE on public.users to authenticated;
grant INSERT on public.users to anon;
grant INSERT on public.users to authenticated;
grant REFERENCES on public.users to anon;
grant REFERENCES on public.users to authenticated;
grant SELECT on public.users to anon;
grant SELECT on public.users to authenticated;
grant TRIGGER on public.users to anon;
grant TRIGGER on public.users to authenticated;
grant TRUNCATE on public.users to anon;
grant TRUNCATE on public.users to authenticated;
grant UPDATE on public.users to anon;
grant UPDATE on public.users to authenticated;
