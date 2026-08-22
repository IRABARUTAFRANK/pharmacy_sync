-- ============================================================================
-- PharmSync — CONSOLIDATED CANONICAL SCHEMA (PostgreSQL / Supabase)
-- ============================================================================
-- Run this single file in the Supabase SQL Editor on a new project. It replaces
-- running the following files in sequence and produces the same end state:
--
--   1. supabase_pharmacy_schema.sql      (base schema, Supabase Auth linkage, RLS)
--   2. branch_access_setup.sql           (branch_directory — superseded by 4)
--   3. stock_receiving_setup.sql         (stock_deliveries + receiving RPC — superseded by 4)
--   4. branch_onboarding_and_inventory.sql (onboarding flow, tightened RLS, receiving RPC)
--
-- `pharmacy_schema updated.sql` is a stale pre-Supabase-Auth draft (it stored
-- password_hash/otp on public.users) and is deliberately NOT a source here.
-- `development_seed.sql` is seed data and is still run separately, after this file.
--
-- Everything below is transcribed from those source files. No table, column,
-- constraint, index, policy, function or grant has been invented, renamed or
-- "improved". Duplicates were removed by keeping the newest declaration:
--   * stock_deliveries        -> branch_onboarding_and_inventory.sql (identical DDL)
--   * branch_directory        -> branch_onboarding_and_inventory.sql (has the
--                                drop-policy-if-exists guard)
--   * receive_stock_delivery  -> branch_onboarding_and_inventory.sql (handles new
--                                products/variants and never trusts a client code)
--   * barcodes_packing_shape  -> declared once (both sources are byte-identical)
--   * current_branch_id/is_owner -> branch_onboarding_and_inventory.sql versions
--   * "branch access"/"users read own branch"/"delivery access" policies ->
--     branch_onboarding_and_inventory.sql versions (super_admin, not owner)
--
-- Two statements that exist ONLY in the earlier receiving/access files and are
-- not re-declared or superseded by the newest file are preserved here and
-- marked "kept from stock_receiving_setup.sql" / "kept from branch_access_setup.sql".
--
-- It is intentionally schema-only: mock data in src/data.ts is not imported.
-- Every statement is idempotent, so the file is safe to re-run.
--
-- Super admin: Authentication -> user -> App metadata -> { "role": "super_admin" }
-- Email OTP:   Authentication -> Email templates -> Magic Link, include {{ .Token }}
-- ============================================================================

create extension if not exists pgcrypto;

-- ============================================================================
-- CORE / CATALOG
-- ============================================================================

create table if not exists public.branches (
  id uuid primary key default gen_random_uuid(), name varchar(150) not null,
  address text, phone varchar(30), created_at timestamptz not null default now()
);

-- A public user profile is linked to Supabase Auth. Never store password hashes
-- or OTP values in public tables: Supabase Auth owns those securely.
-- branch_id is not declared UNIQUE here (the base schema dropped that column
-- constraint). The onboarding migration below re-establishes 1 user per branch
-- with the `users_one_per_branch` unique index, so the live end state IS 1:1.
create table if not exists public.users (
  id uuid primary key references auth.users(id) on delete cascade,
  branch_id uuid not null references public.branches(id), full_name varchar(150) not null,
  email varchar(150) not null unique, role varchar(30) not null default 'staff'
    check (role in ('owner','manager','pharmacist','staff')),
  is_active boolean not null default true, created_at timestamptz not null default now()
);

create table if not exists public.branch_settings (
  id uuid primary key default gen_random_uuid(), branch_id uuid not null references public.branches(id),
  setting_key varchar(100) not null, setting_value text, updated_by uuid references public.users(id),
  updated_at timestamptz not null default now(), unique (branch_id, setting_key)
);

create table if not exists public.tax_rates (
  id uuid primary key default gen_random_uuid(), name varchar(80) not null unique,
  rate_percentage numeric(5,2) not null default 0 check (rate_percentage between 0 and 100)
);

-- Branch-owned: each category belongs to exactly one branch, private by default.
-- Two branches can each create "Antibiotics" as separate rows. The extra
-- unique(id, branch_id) exists purely so branch_product_categorization can point
-- at it with a composite foreign key.
create table if not exists public.product_categories (
  id uuid primary key default gen_random_uuid(), branch_id uuid not null references public.branches(id),
  name varchar(100) not null, description text, unique(branch_id, name), unique(id, branch_id)
);

-- No category_id here: categorization is branch-specific, see below.
create table if not exists public.products (
  id uuid primary key default gen_random_uuid(), tax_rate_id uuid not null references public.tax_rates(id),
  product_type varchar(20) not null default 'medicine' check(product_type in ('medicine','supply','other')),
  name varchar(150) not null, generic_name varchar(150), description text
);

create table if not exists public.product_variants (
  id uuid primary key default gen_random_uuid(), product_id uuid not null references public.products(id),
  dosage varchar(50), form varchar(50), unit varchar(30), created_at timestamptz not null default now()
);

create table if not exists public.reorder_points (
  id uuid primary key default gen_random_uuid(), product_id uuid not null references public.products(id),
  branch_id uuid not null references public.branches(id), min_quantity integer not null default 0 check(min_quantity >= 0),
  max_quantity integer check(max_quantity is null or max_quantity >= min_quantity), unique(product_id, branch_id)
);

-- Replaces the old branch_products AND branch_product_categories tables.
-- One row = "this branch carries this product, filed under this category."
-- The composite FK (category_id, branch_id) -> product_categories(id, branch_id)
-- makes the database itself guarantee the category belongs to the same branch;
-- do not simplify it to a plain category_id reference.
create table if not exists public.branch_product_categorization (
  branch_id uuid not null, product_id uuid not null references public.products(id), category_id uuid not null,
  primary key(branch_id, product_id),
  foreign key(branch_id) references public.branches(id),
  foreign key(category_id, branch_id) references public.product_categories(id, branch_id)
);

-- ============================================================================
-- STOCK / BARCODE
-- ============================================================================

-- Supplier list. Created global; the onboarding migration below adds an optional
-- branch_id so a pharmacy can own its own private supplier rows while legacy
-- rows with branch_id null stay shared.
create table if not exists public.suppliers (
  id uuid primary key default gen_random_uuid(), supplier_name varchar(150) not null,
  contact varchar(150), location varchar(150), created_at timestamptz not null default now()
);

-- One row per intake event, effectively one row per delivered product batch.
-- delivery_code groups multiple rows that arrived together; delivery_id (added
-- with stock_deliveries below) links them to the shipment header row.
create table if not exists public.stock_batches (
  id uuid primary key default gen_random_uuid(), product_variant_id uuid not null references public.product_variants(id),
  branch_id uuid not null references public.branches(id), supplier_id uuid references public.suppliers(id),
  manufacturer_name varchar(150), delivery_code varchar(80), logged_by uuid not null references public.users(id),
  batch_number varchar(80) not null, expiry_date date not null, cost_price numeric(12,2) not null check(cost_price >= 0),
  selling_price numeric(12,2) not null check(selling_price >= 0), quantity_received integer not null check(quantity_received >= 0),
  received_at timestamptz not null default now(), unique(product_variant_id, batch_number, branch_id)
);

-- One row per scannable unit — either a 'box' (outer carton, parent) or a
-- 'pack' (small box, child). parent_barcode_id self-references to link a pack
-- back to the box it came in. The named barcodes_packing_shape constraint added
-- with the receiving feature below tightens this further.
create table if not exists public.barcodes (
  id uuid primary key default gen_random_uuid(), stock_batch_id uuid not null references public.stock_batches(id),
  parent_barcode_id uuid references public.barcodes(id), barcode_type varchar(10) not null default 'pack' check(barcode_type in ('box','pack')),
  code varchar(64) not null unique, code_source varchar(20) not null default 'generated' check(code_source in ('manufacturer','generated')),
  child_count integer check(child_count is null or child_count >= 0), pieces_per_pack integer check(pieces_per_pack is null or pieces_per_pack > 0),
  quantity_available integer not null check(quantity_available >= 0), status varchar(20) not null default 'active'
    check(status in ('active','sold_out','expired','recalled','damaged')), created_at timestamptz not null default now(),
  check((barcode_type = 'box' and pieces_per_pack is null) or (barcode_type = 'pack' and child_count is null))
);

-- Targets a batch's real-world identity (product + lot + manufacturer), NOT a
-- single stock_batches row — so one recall cascades across every branch that
-- received the same lot.
create table if not exists public.batch_recalls (
  id uuid primary key default gen_random_uuid(), product_variant_id uuid not null references public.product_variants(id),
  batch_number varchar(80) not null, manufacturer_name varchar(150), reason text not null,
  recalled_by uuid not null references public.users(id), recalled_at timestamptz not null default now()
);

create table if not exists public.stock_adjustments (
  id uuid primary key default gen_random_uuid(), stock_batch_id uuid references public.stock_batches(id), barcode_id uuid references public.barcodes(id),
  adjustment_type varchar(30) not null check(adjustment_type in ('damage','loss','correction','return','expired_writeoff','recalled')),
  quantity integer not null, reason text, performed_by uuid not null references public.users(id), adjusted_at timestamptz not null default now(),
  check(stock_batch_id is not null or barcode_id is not null)
);

-- Persistent, trackable alerts only. One-off UI feedback (e.g. "stock saved
-- successfully") is handled client-side and never written here.
create table if not exists public.notifications (
  id uuid primary key default gen_random_uuid(), branch_id uuid not null references public.branches(id),
  source_type varchar(30) not null check(source_type in ('batch_recall','stock_adjustment')), source_id uuid not null,
  message text not null, is_read boolean not null default false, created_at timestamptz not null default now()
);

-- ============================================================================
-- SALES / INSURANCE
-- ============================================================================

create table if not exists public.discounts (
  id uuid primary key default gen_random_uuid(), name varchar(100) not null,
  discount_type varchar(20) not null check(discount_type in ('percentage','fixed')), value numeric(12,2) not null check(value >= 0),
  valid_from date, valid_to date, check(valid_to is null or valid_from is null or valid_to >= valid_from)
);

create table if not exists public.insurance_providers (
  id uuid primary key default gen_random_uuid(), name varchar(150) not null unique, contact_info text,
  default_coverage_percentage numeric(5,2) not null default 0 check(default_coverage_percentage between 0 and 100)
);

-- Only holds EXCEPTIONS to a provider's default coverage. A row existing here
-- IS the "differs" flag — no separate boolean needed.
create table if not exists public.insurance_product_coverage (
  insurance_provider_id uuid not null references public.insurance_providers(id), product_id uuid not null references public.products(id),
  coverage_percentage numeric(5,2) not null check(coverage_percentage between 0 and 100), primary key(insurance_provider_id, product_id)
);

create table if not exists public.sales (
  id uuid primary key default gen_random_uuid(), branch_id uuid not null references public.branches(id), cashier_id uuid not null references public.users(id),
  discount_id uuid references public.discounts(id), total_amount numeric(12,2) not null check(total_amount >= 0), sold_at timestamptz not null default now()
);

-- tax_rate_id lives HERE, not on sales, since one transaction can mix exempt and
-- taxed items. It defaults from the product but can be overridden per line.
create table if not exists public.sale_items (
  id uuid primary key default gen_random_uuid(), sale_id uuid not null references public.sales(id) on delete cascade,
  barcode_id uuid not null references public.barcodes(id), tax_rate_id uuid not null references public.tax_rates(id),
  quantity integer not null default 1 check(quantity > 0), unit_price numeric(12,2) not null check(unit_price >= 0), subtotal numeric(12,2) not null check(subtotal >= 0)
);

create table if not exists public.receipts (
  id uuid primary key default gen_random_uuid(), sale_id uuid not null unique references public.sales(id) on delete cascade,
  receipt_number varchar(50) not null unique, issued_at timestamptz not null default now()
);

-- coverage_percentage_applied and claim_amount are snapshotted at the time of
-- the claim, so historical records stay accurate even if the provider's default
-- or a product override changes later.
create table if not exists public.insurance_claims (
  id uuid primary key default gen_random_uuid(), sale_id uuid not null unique references public.sales(id),
  insurance_provider_id uuid not null references public.insurance_providers(id), coverage_percentage_applied numeric(5,2) not null check(coverage_percentage_applied between 0 and 100),
  claim_amount numeric(12,2) not null check(claim_amount >= 0), status varchar(20) not null default 'submitted' check(status in ('submitted','approved','rejected','paid')),
  submitted_at timestamptz not null default now()
);

-- ============================================================================
-- ANALYTICS / OPS
-- ============================================================================

create table if not exists public.sales_forecasts (
  id uuid primary key default gen_random_uuid(), branch_id uuid not null references public.branches(id), product_variant_id uuid not null references public.product_variants(id),
  forecast_period varchar(20) not null, predicted_quantity integer not null check(predicted_quantity >= 0), generated_at timestamptz not null default now()
);

create table if not exists public.dashboard_reports (
  id uuid primary key default gen_random_uuid(), branch_id uuid not null references public.branches(id), report_type varchar(50) not null,
  data jsonb not null default '{}'::jsonb, generated_at timestamptz not null default now()
);

create table if not exists public.support_tickets (
  id uuid primary key default gen_random_uuid(), branch_id uuid not null references public.branches(id), raised_by uuid not null references public.users(id),
  subject varchar(150) not null, description text, status varchar(20) not null default 'open' check(status in ('open','in_progress','resolved','closed')),
  created_at timestamptz not null default now()
);

-- ============================================================================
-- INDEXES
-- ============================================================================

create index if not exists idx_barcodes_batch on public.barcodes(stock_batch_id);
create index if not exists idx_barcodes_parent on public.barcodes(parent_barcode_id);
create index if not exists idx_stock_batches_variant_branch on public.stock_batches(product_variant_id, branch_id);
create index if not exists idx_stock_batches_delivery on public.stock_batches(delivery_code);
create index if not exists idx_sales_branch_date on public.sales(branch_id, sold_at desc);
create index if not exists idx_sale_items_sale on public.sale_items(sale_id);
create index if not exists idx_notifications_branch_unread on public.notifications(branch_id, is_read);

-- ============================================================================
-- RLS HELPER FUNCTIONS
-- ============================================================================
-- Supabase row-level security. A super admin (JWT app_metadata.role) can see all
-- branches; every other role only sees its own branch. Service-role keys bypass
-- RLS for trusted server jobs.

create or replace function public.current_branch_id()
returns uuid
language sql
stable
security definer
set search_path = ''
as $$
  select u.branch_id
  from public.users u
  where u.id = (select auth.uid())
    and u.is_active
$$;

create or replace function public.is_super_admin()
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  select coalesce(((select auth.jwt()) -> 'app_metadata' ->> 'role') = 'super_admin', false)
$$;

-- Pharmacy "owner" is a branch role, not a platform-wide bypass.
create or replace function public.is_owner()
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  select exists (
    select 1
    from public.users u
    where u.id = (select auth.uid())
      and u.role = 'owner'
      and u.is_active
  )
$$;

create or replace function public.assert_super_admin()
returns void
language plpgsql
stable
security definer
set search_path = ''
as $$
begin
  if not public.is_super_admin() then
    raise exception 'Super admin access is required';
  end if;
end;
$$;

-- ============================================================================
-- ROW LEVEL SECURITY — enable everywhere
-- ============================================================================
-- Tables without a client policy below deliberately stay inaccessible from the
-- browser until the relevant screen is migrated with a scoped policy/RPC. This
-- avoids exposing pharmacy and sales data by accident.

alter table public.users enable row level security;
alter table public.branches enable row level security;
alter table public.branch_settings enable row level security;
alter table public.product_categories enable row level security;
alter table public.reorder_points enable row level security;
alter table public.stock_batches enable row level security;
alter table public.notifications enable row level security;
alter table public.sales enable row level security;
alter table public.sales_forecasts enable row level security;
alter table public.dashboard_reports enable row level security;
alter table public.support_tickets enable row level security;
alter table public.tax_rates enable row level security;
alter table public.products enable row level security;
alter table public.product_variants enable row level security;
alter table public.branch_product_categorization enable row level security;
alter table public.suppliers enable row level security;
alter table public.barcodes enable row level security;
alter table public.batch_recalls enable row level security;
alter table public.stock_adjustments enable row level security;
alter table public.discounts enable row level security;
alter table public.insurance_providers enable row level security;
alter table public.insurance_product_coverage enable row level security;
alter table public.sale_items enable row level security;
alter table public.receipts enable row level security;
alter table public.insurance_claims enable row level security;

-- ============================================================================
-- ROW LEVEL SECURITY — policies
-- ============================================================================

drop policy if exists "users read own branch" on public.users;
create policy "users read own branch" on public.users
for select to authenticated
using (public.is_super_admin() or id = (select auth.uid()) or branch_id = public.current_branch_id());

drop policy if exists "branch access" on public.branches;
create policy "branch access" on public.branches
for select to authenticated
using (public.is_super_admin() or id = public.current_branch_id());

-- Directly branch-owned tables share the same access rule: super admin or own branch.
do $$
declare t text;
begin
  foreach t in array array[
    'branch_settings','product_categories','reorder_points','stock_batches',
    'notifications','sales','sales_forecasts','dashboard_reports','support_tickets'
  ]
  loop
    execute format('drop policy if exists "branch access" on public.%I', t);
    execute format(
      'create policy "branch access" on public.%I for all to authenticated using (public.is_super_admin() or branch_id = public.current_branch_id()) with check (public.is_super_admin() or branch_id = public.current_branch_id())',
      t
    );
  end loop;
end $$;

-- Shared catalog: readable by any signed-in pharmacy.
drop policy if exists "tax rates readable" on public.tax_rates;
create policy "tax rates readable" on public.tax_rates for select to authenticated using (true);

drop policy if exists "products readable" on public.products;
create policy "products readable" on public.products for select to authenticated using (true);

drop policy if exists "variants readable" on public.product_variants;
create policy "variants readable" on public.product_variants for select to authenticated using (true);

drop policy if exists "categorization access" on public.branch_product_categorization;
create policy "categorization access" on public.branch_product_categorization
for all to authenticated
using (public.is_super_admin() or branch_id = public.current_branch_id())
with check (public.is_super_admin() or branch_id = public.current_branch_id());

-- Legacy global suppliers (branch_id null) stay readable by everyone; a branch
-- may only write its own supplier rows.
drop policy if exists "suppliers access" on public.suppliers;
create policy "suppliers access" on public.suppliers
for all to authenticated
using (public.is_super_admin() or branch_id is null or branch_id = public.current_branch_id())
with check (public.is_super_admin() or branch_id = public.current_branch_id());

drop policy if exists "barcodes access" on public.barcodes;
create policy "barcodes access" on public.barcodes
for select to authenticated
using (
  public.is_super_admin()
  or exists (
    select 1 from public.stock_batches sb
    where sb.id = stock_batch_id and sb.branch_id = public.current_branch_id()
  )
);

-- A recall must be visible to every branch that received the lot.
drop policy if exists "recalls readable" on public.batch_recalls;
create policy "recalls readable" on public.batch_recalls for select to authenticated using (true);

drop policy if exists "adjustments access" on public.stock_adjustments;
create policy "adjustments access" on public.stock_adjustments
for select to authenticated
using (
  public.is_super_admin()
  or exists (
    select 1 from public.stock_batches sb
    where sb.id = stock_batch_id and sb.branch_id = public.current_branch_id()
  )
  or exists (
    select 1 from public.barcodes bc
    join public.stock_batches sb on sb.id = bc.stock_batch_id
    where bc.id = barcode_id and sb.branch_id = public.current_branch_id()
  )
);

-- ============================================================================
-- ONBOARDING — branch identity columns
-- ============================================================================

alter table public.branches
  add column if not exists email varchar(150),
  add column if not exists branch_code varchar(32),
  add column if not exists activation_code varchar(24),
  add column if not exists status varchar(20) not null default 'active',
  add column if not exists called_at timestamptz,
  add column if not exists locked_at timestamptz,
  add column if not exists failed_logins integer not null default 0,
  add column if not exists denied_reason text;

alter table public.branches drop constraint if exists branches_status_check;
alter table public.branches add constraint branches_status_check
  check (status in ('pending','otp_sent','active','locked','denied'));

create unique index if not exists branches_branch_code_unique
  on public.branches (branch_code) where branch_code is not null;

-- Branch <-> user is one-to-one for the MVP. The base schema left branch_id
-- non-unique; this index is what actually enforces the 1:1 rule in the live DB.
create unique index if not exists users_one_per_branch
  on public.users (branch_id);

-- ============================================================================
-- ONBOARDING — public branch directory
-- ============================================================================
-- Secure public directory for the branch-picker page. It contains only a branch
-- ID and display name: no phone, address, staff, inventory, or sales data is
-- exposed before the user signs in.

create table if not exists public.branch_directory (
  branch_id uuid primary key references public.branches(id) on delete cascade,
  display_name varchar(150) not null
);

-- Kept from branch_access_setup.sql: backfills the directory from any branches
-- that already exist. It is a no-op on a fresh database.
insert into public.branch_directory (branch_id, display_name)
select id, name from public.branches
on conflict (branch_id) do update set display_name = excluded.display_name;

alter table public.branch_directory enable row level security;
drop policy if exists "branch directory is readable before sign-in" on public.branch_directory;
create policy "branch directory is readable before sign-in"
on public.branch_directory for select to anon, authenticated using (true);

-- ============================================================================
-- ONBOARDING — branch-scoped suppliers
-- ============================================================================

alter table public.suppliers
  add column if not exists branch_id uuid references public.branches(id);

-- The old global case-insensitive unique name is replaced by a pair of partial
-- indexes so two pharmacies can each have their own "MedPharm Rwanda" row while
-- the shared/global rows stay unique among themselves.
drop index if exists public.suppliers_name_ci_unique;
create unique index if not exists suppliers_branch_name_ci_unique
  on public.suppliers (branch_id, (lower(supplier_name)))
  where branch_id is not null;
create unique index if not exists suppliers_global_name_ci_unique
  on public.suppliers ((lower(supplier_name)))
  where branch_id is null;

-- ============================================================================
-- ONBOARDING — applications (pending pharmacies before they operate)
-- ============================================================================

create table if not exists public.branch_applications (
  id uuid primary key default gen_random_uuid(),
  application_code varchar(32) not null unique,
  pharmacy_name varchar(150) not null,
  phone varchar(30) not null,
  email varchar(150) not null,
  location text not null,
  status varchar(20) not null default 'pending'
    check (status in ('pending','otp_sent','active','denied')),
  called_at timestamptz,
  denied_reason text,
  branch_id uuid references public.branches(id),
  submitted_at timestamptz not null default now()
);

-- One open application per email address; denied/active ones may be re-applied.
create unique index if not exists branch_applications_open_email
  on public.branch_applications (lower(email))
  where status in ('pending','otp_sent');

create index if not exists branch_applications_status_submitted
  on public.branch_applications (status, submitted_at desc);

alter table public.branch_applications enable row level security;

-- Direct table reads are super-admin only. Applicants reach their own row
-- through the security-definer get_pharmacy_application() RPC instead.
drop policy if exists "applications readable by holder or admin" on public.branch_applications;
create policy "applications readable by holder or admin"
on public.branch_applications
for select
to anon, authenticated
using (public.is_super_admin() or false);

drop policy if exists "super admin manage applications" on public.branch_applications;
create policy "super admin manage applications"
on public.branch_applications
for all
to authenticated
using (public.is_super_admin())
with check (public.is_super_admin());

-- ============================================================================
-- ONBOARDING RPCs — registration, approval, OTP activation, lockout
-- ============================================================================

create or replace function public.submit_pharmacy_registration(
  p_pharmacy_name text,
  p_phone text,
  p_email text,
  p_location text
)
returns table(application_id uuid, application_code text)
language plpgsql
security definer
set search_path = ''
as $$
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
$$;

create or replace function public.get_pharmacy_application(p_application_id uuid)
returns table (
  id uuid,
  application_code text,
  pharmacy_name text,
  phone text,
  email text,
  location text,
  status text,
  called_at timestamptz,
  denied_reason text,
  branch_id uuid,
  branch_code text,
  activation_code text,
  submitted_at timestamptz
)
language sql
stable
security definer
set search_path = ''
as $$
  select
    a.id,
    a.application_code::text,
    a.pharmacy_name::text,
    a.phone::text,
    a.email::text,
    a.location::text,
    a.status::text,
    a.called_at,
    a.denied_reason,
    a.branch_id,
    b.branch_code::text,
    b.activation_code::text,
    a.submitted_at
  from public.branch_applications a
  left join public.branches b on b.id = a.branch_id
  where a.id = p_application_id
$$;

create or replace function public.admin_list_pharmacy_applications()
returns table (
  id uuid,
  application_code text,
  pharmacy_name text,
  phone text,
  email text,
  location text,
  status text,
  called_at timestamptz,
  denied_reason text,
  branch_id uuid,
  branch_code text,
  activation_code text,
  failed_logins integer,
  locked_at timestamptz,
  submitted_at timestamptz
)
language plpgsql
stable
security definer
set search_path = ''
as $$
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
$$;

create or replace function public.admin_mark_pharmacy_called(p_application_id uuid)
returns void
language plpgsql
security definer
set search_path = ''
as $$
begin
  perform public.assert_super_admin();
  update public.branch_applications
  set called_at = now()
  where id = p_application_id and status = 'pending';
  if not found then
    raise exception 'Call can only be recorded on a pending application';
  end if;
end;
$$;

create or replace function public.admin_deny_pharmacy_application(p_application_id uuid, p_reason text)
returns void
language plpgsql
security definer
set search_path = ''
as $$
begin
  perform public.assert_super_admin();
  update public.branch_applications
  set status = 'denied', denied_reason = nullif(btrim(p_reason), '')
  where id = p_application_id and status in ('pending','otp_sent');
  if not found then
    raise exception 'This application cannot be denied';
  end if;
end;
$$;

-- Approval creates the branch row in 'otp_sent' state. The pharmacy only becomes
-- 'active' once it verifies the emailed OTP through activate_pharmacy_account().
create or replace function public.admin_approve_pharmacy_application(p_application_id uuid)
returns table(branch_id uuid, email text)
language plpgsql
security definer
set search_path = ''
as $$
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
  set status = 'otp_sent', branch_id = v_branch
  where id = p_application_id;

  return query select v_branch, v_app.email::text;
end;
$$;

create or replace function public.can_request_pharmacy_otp(p_email text)
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  select exists (
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
  )
$$;

-- Runs immediately after the applicant verifies the emailed OTP. It mints the
-- branch_code / activation_code, creates the single owner profile for the
-- branch, and publishes the branch to the sign-in directory.
create or replace function public.activate_pharmacy_account()
returns table(branch_id uuid, branch_code text, activation_code text, pharmacy_name text)
language plpgsql
security definer
set search_path = ''
as $$
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

  select * into v_app
  from public.branch_applications a
  where lower(a.email) = lower(v_email)
    and a.status = 'otp_sent'
  order by a.submitted_at desc
  limit 1;

  if v_app.id is null then
    return query
      select b.id, b.branch_code::text, b.activation_code::text, b.name::text
      from public.users u
      join public.branches b on b.id = u.branch_id
      where u.id = v_user;
    return;
  end if;

  if exists (select 1 from public.users u where u.branch_id = v_app.branch_id) then
    raise exception 'This pharmacy already has an operator account';
  end if;

  v_loc := upper(regexp_replace(split_part(v_app.location, ',', 1), '[^A-Za-z]', '', 'g'));
  if length(v_loc) < 3 then v_loc := rpad(v_loc, 3, 'X'); else v_loc := left(v_loc, 3); end if;

  select coalesce(max(substring(b.branch_code from '[0-9]+$')::integer), 0) + 1
  into v_seq
  from public.branches b
  where b.branch_code ~ '^PSYNC-[A-Z]{3}-[0-9]{4}$';

  v_code := format('PSYNC-%s-%s', v_loc, lpad(v_seq::text, 4, '0'));
  v_act := 'ACT-';
  for i in 1..6 loop
    v_act := v_act || substr(v_chars, 1 + floor(random() * length(v_chars))::integer, 1);
  end loop;

  update public.branches
  set status = 'active', branch_code = v_code, activation_code = v_act
  where id = v_app.branch_id;

  insert into public.users (id, branch_id, full_name, email, role, is_active)
  values (v_user, v_app.branch_id, v_app.pharmacy_name, lower(v_app.email), 'owner', true);

  insert into public.branch_directory (branch_id, display_name)
  values (v_app.branch_id, v_app.pharmacy_name)
  on conflict (branch_id) do update set display_name = excluded.display_name;

  update public.branch_applications set status = 'active' where id = v_app.id;

  return query select v_app.branch_id, v_code, v_act, v_app.pharmacy_name::text;
end;
$$;

create or replace function public.admin_set_branch_lock(p_branch_id uuid, p_locked boolean)
returns void
language plpgsql
security definer
set search_path = ''
as $$
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
$$;

-- ============================================================================
-- RECEIVING — deliveries and the barcode packing rule
-- ============================================================================
-- Each delivery is one supplier shipment; stock_batches are its product/batch lines.

create table if not exists public.stock_deliveries (
  id uuid primary key default gen_random_uuid(),
  branch_id uuid not null references public.branches(id),
  supplier_id uuid not null references public.suppliers(id),
  delivery_code varchar(80) not null,
  received_by uuid not null references public.users(id),
  received_at timestamptz not null default now(),
  notes text,
  created_at timestamptz not null default now(),
  unique (branch_id, delivery_code)
);

alter table public.stock_batches add column if not exists delivery_id uuid references public.stock_deliveries(id);

create index if not exists idx_stock_deliveries_branch_received on public.stock_deliveries(branch_id, received_at desc);
-- Kept from stock_receiving_setup.sql: these two indexes are not re-declared in
-- branch_onboarding_and_inventory.sql, so they are preserved rather than dropped.
create index if not exists idx_stock_deliveries_supplier on public.stock_deliveries(supplier_id);
create index if not exists idx_stock_batches_delivery_id on public.stock_batches(delivery_id);

alter table public.stock_deliveries enable row level security;
drop policy if exists "delivery access" on public.stock_deliveries;
create policy "delivery access" on public.stock_deliveries
for all to authenticated
using (public.is_super_admin() or branch_id = public.current_branch_id())
with check (public.is_super_admin() or branch_id = public.current_branch_id());

-- Barcode packing rule:
-- * A simple sellable pack has parent_barcode_id null and pieces_per_pack set.
-- * A carton (box) has one barcode per physical carton and child_count = packs inside.
-- * Every inner pack is a child barcode with pieces_per_pack set; individual pieces have no barcode.
-- Stock quantity is calculated from leaf pack barcodes only: quantity_available * pieces_per_pack.
alter table public.barcodes drop constraint if exists barcodes_packing_shape;
alter table public.barcodes add constraint barcodes_packing_shape check (
  (barcode_type = 'box' and parent_barcode_id is null and child_count is not null and child_count > 0 and pieces_per_pack is null)
  or
  (barcode_type = 'pack' and child_count is null and pieces_per_pack is not null and pieces_per_pack > 0)
);

-- ============================================================================
-- RECEIVING RPC — create products, branch categories, parent/child barcodes
-- ============================================================================
-- One atomic receiving operation: the client sends delivery lines, never a
-- delivery code. Do not create anonymous policies for stock, barcodes,
-- suppliers, or recalls.

-- Drops the pre-release signature that took an explicit supplier uuid.
drop function if exists public.receive_stock_delivery(uuid, text, jsonb);

create or replace function public.receive_stock_delivery(p_supplier_name text, p_notes text, p_lines jsonb)
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
  v_parent uuid;
  v_category uuid;
  v_product uuid;
  v_variant uuid;
  v_tax uuid;
  i integer;
  j integer;
  v_cartons integer;
  v_packs integer;
  v_pieces integer;
  v_name text;
  v_type text;
begin
  select u.branch_id into v_branch
  from public.users u
  where u.id = v_user and u.is_active;

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

  select t.id into v_tax from public.tax_rates t where t.rate_percentage = 0 order by t.name limit 1;
  if v_tax is null then
    insert into public.tax_rates (name, rate_percentage) values ('Exempt', 0) returning id into v_tax;
  end if;

  for line in select * from jsonb_array_elements(p_lines) loop
    v_cartons := coalesce((line->>'cartons')::integer, 0);
    v_packs := greatest(coalesce((line->>'packs_per_carton')::integer, (line->>'packs')::integer, 1), 1);
    v_pieces := greatest(coalesce((line->>'pieces_per_pack')::integer, 1), 1);

    if nullif(line->>'product_variant_id', '') is not null then
      v_variant := (line->>'product_variant_id')::uuid;
      select pv.product_id into v_product from public.product_variants pv where pv.id = v_variant;
      if v_product is null then raise exception 'Unknown product variant'; end if;
    else
      v_name := btrim(coalesce(line->>'product_name', ''));
      if v_name = '' then raise exception 'Each line needs a product or a new product name'; end if;
      v_type := coalesce(nullif(line->>'product_type', ''), 'medicine');
      if v_type not in ('medicine','supply','other') then v_type := 'other'; end if;

      select p.id into v_product from public.products p where lower(p.name) = lower(v_name) limit 1;
      if v_product is null then
        insert into public.products (tax_rate_id, product_type, name, generic_name)
        values (v_tax, v_type, v_name, nullif(btrim(coalesce(line->>'generic_name','')), ''))
        returning id into v_product;
      end if;

      select pv.id into v_variant
      from public.product_variants pv
      where pv.product_id = v_product
        and coalesce(pv.dosage, '') = coalesce(nullif(btrim(coalesce(line->>'dosage','')), ''), '')
        and coalesce(pv.form, '') = coalesce(nullif(btrim(coalesce(line->>'form','')), ''), '')
      limit 1;

      if v_variant is null then
        insert into public.product_variants (product_id, dosage, form, unit)
        values (
          v_product,
          nullif(btrim(coalesce(line->>'dosage','')), ''),
          nullif(btrim(coalesce(line->>'form','')), ''),
          nullif(btrim(coalesce(line->>'unit','')), '')
        )
        returning id into v_variant;
      end if;
    end if;

    if nullif(btrim(coalesce(line->>'category_name','')), '') is not null then
      insert into public.product_categories (branch_id, name)
      values (v_branch, btrim(line->>'category_name'))
      on conflict (branch_id, name) do update set name = excluded.name
      returning id into v_category;

      insert into public.branch_product_categorization (branch_id, product_id, category_id)
      values (v_branch, v_product, v_category)
      on conflict (branch_id, product_id) do update set category_id = excluded.category_id;
    end if;

    insert into public.stock_batches (
      product_variant_id, branch_id, supplier_id, manufacturer_name, delivery_id, delivery_code,
      logged_by, batch_number, expiry_date, cost_price, selling_price, quantity_received
    ) values (
      v_variant, v_branch, v_supplier, nullif(btrim(coalesce(line->>'manufacturer_name','')), ''),
      v_delivery, v_code, v_user, btrim(line->>'batch_number'), (line->>'expiry_date')::date,
      (line->>'cost_price')::numeric, (line->>'selling_price')::numeric,
      coalesce((line->>'quantity_received')::integer, case when v_cartons > 0 then v_cartons * v_packs * v_pieces else v_packs * v_pieces end)
    )
    returning id into v_batch;

    if v_cartons > 0 then
      for i in 1..v_cartons loop
        insert into public.barcodes (stock_batch_id, barcode_type, code, code_source, child_count, quantity_available)
        values (
          v_batch, 'box',
          format('%s-%s-C%s', v_code, substr(replace(v_batch::text,'-',''),1,6), lpad(i::text,2,'0')),
          'generated', v_packs, 1
        )
        returning id into v_parent;
        for j in 1..v_packs loop
          insert into public.barcodes (stock_batch_id, parent_barcode_id, barcode_type, code, code_source, pieces_per_pack, quantity_available)
          values (
            v_batch, v_parent, 'pack',
            format('%s-%s-C%s-P%s', v_code, substr(replace(v_batch::text,'-',''),1,6), lpad(i::text,2,'0'), lpad(j::text,2,'0')),
            'generated', v_pieces, 1
          );
        end loop;
      end loop;
    else
      for j in 1..v_packs loop
        insert into public.barcodes (stock_batch_id, barcode_type, code, code_source, pieces_per_pack, quantity_available)
        values (
          v_batch, 'pack',
          format('%s-%s-P%s', v_code, substr(replace(v_batch::text,'-',''),1,6), lpad(j::text,3,'0')),
          'generated', v_pieces, 1
        );
      end loop;
    end if;
  end loop;

  return query select v_delivery, v_code;
end;
$$;

-- ============================================================================
-- GRANTS
-- ============================================================================
-- Table privileges. RLS above still decides which rows are visible/writable.

grant select on public.branch_directory to anon, authenticated;
grant select, insert, update on public.branch_applications to authenticated;
grant select on public.branch_applications to anon;

grant select on public.tax_rates, public.products, public.product_variants to authenticated;
grant select, insert, update on public.product_categories, public.branch_product_categorization,
  public.suppliers, public.stock_batches, public.barcodes, public.reorder_points to authenticated;
grant select on public.stock_deliveries to authenticated;

-- batch_recalls and stock_adjustments had RLS policies with no matching GRANT:
-- PostgREST returned permission-denied for every request regardless of the
-- policy, making both tables unreachable from the browser. Both policies are
-- select-only (there is no insert/update policy on either table), so the
-- grant matches that scope exactly rather than opening up writes nothing
-- currently authorizes.
grant select on public.batch_recalls, public.stock_adjustments to authenticated;

-- Public onboarding RPCs: reachable before sign-in.
revoke all on function public.submit_pharmacy_registration(text, text, text, text) from public;
grant execute on function public.submit_pharmacy_registration(text, text, text, text) to anon, authenticated;
revoke all on function public.get_pharmacy_application(uuid) from public;
grant execute on function public.get_pharmacy_application(uuid) to anon, authenticated;
revoke all on function public.can_request_pharmacy_otp(text) from public;
grant execute on function public.can_request_pharmacy_otp(text) to anon, authenticated;
revoke all on function public.activate_pharmacy_account() from public;
grant execute on function public.activate_pharmacy_account() to authenticated;

-- Super-admin RPCs: signed in only; each one re-checks assert_super_admin().
revoke all on function public.admin_list_pharmacy_applications() from public;
revoke all on function public.admin_mark_pharmacy_called(uuid) from public;
revoke all on function public.admin_deny_pharmacy_application(uuid, text) from public;
revoke all on function public.admin_approve_pharmacy_application(uuid) from public;
revoke all on function public.admin_set_branch_lock(uuid, boolean) from public;
revoke all on function public.assert_super_admin() from public;
revoke all on function public.is_super_admin() from public;
grant execute on function public.is_super_admin() to authenticated;
grant execute on function public.admin_list_pharmacy_applications() to authenticated;
grant execute on function public.admin_mark_pharmacy_called(uuid) to authenticated;
grant execute on function public.admin_deny_pharmacy_application(uuid, text) to authenticated;
grant execute on function public.admin_approve_pharmacy_application(uuid) to authenticated;
grant execute on function public.admin_set_branch_lock(uuid, boolean) to authenticated;

revoke all on function public.receive_stock_delivery(text, text, jsonb) from public, anon;
grant execute on function public.receive_stock_delivery(text, text, jsonb) to authenticated;
