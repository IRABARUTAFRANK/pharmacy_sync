-- PharmSync / Supabase PostgreSQL schema
-- Run this whole file in the Supabase SQL Editor on a new project.
-- It is intentionally schema-only: mock data in src/data.ts is not imported.

create extension if not exists pgcrypto;

-- A public user profile is linked to Supabase Auth. Never store password hashes
-- or OTP values in public tables: Supabase Auth owns those securely.
create table public.branches (
  id uuid primary key default gen_random_uuid(), name varchar(150) not null,
  address text, phone varchar(30), created_at timestamptz not null default now()
);
create table public.users (
  id uuid primary key references auth.users(id) on delete cascade,
  branch_id uuid not null references public.branches(id), full_name varchar(150) not null,
  email varchar(150) not null unique, role varchar(30) not null default 'staff'
    check (role in ('owner','manager','pharmacist','staff')),
  is_active boolean not null default true, created_at timestamptz not null default now()
);
-- Unlike the source draft, branch_id is not UNIQUE: the UI already has several
-- staff members in one branch.
create table public.branch_settings (
  id uuid primary key default gen_random_uuid(), branch_id uuid not null references public.branches(id),
  setting_key varchar(100) not null, setting_value text, updated_by uuid references public.users(id),
  updated_at timestamptz not null default now(), unique (branch_id, setting_key)
);
create table public.tax_rates (
  id uuid primary key default gen_random_uuid(), name varchar(80) not null unique,
  rate_percentage numeric(5,2) not null default 0 check (rate_percentage between 0 and 100)
);
create table public.product_categories (
  id uuid primary key default gen_random_uuid(), branch_id uuid not null references public.branches(id),
  name varchar(100) not null, description text, unique(branch_id, name), unique(id, branch_id)
);
create table public.products (
  id uuid primary key default gen_random_uuid(), tax_rate_id uuid not null references public.tax_rates(id),
  product_type varchar(20) not null default 'medicine' check(product_type in ('medicine','supply','other')),
  name varchar(150) not null, generic_name varchar(150), description text
);
create table public.product_variants (
  id uuid primary key default gen_random_uuid(), product_id uuid not null references public.products(id),
  dosage varchar(50), form varchar(50), unit varchar(30), created_at timestamptz not null default now()
);
create table public.reorder_points (
  id uuid primary key default gen_random_uuid(), product_id uuid not null references public.products(id),
  branch_id uuid not null references public.branches(id), min_quantity integer not null default 0 check(min_quantity >= 0),
  max_quantity integer check(max_quantity is null or max_quantity >= min_quantity), unique(product_id, branch_id)
);
create table public.branch_product_categorization (
  branch_id uuid not null, product_id uuid not null references public.products(id), category_id uuid not null,
  primary key(branch_id, product_id),
  foreign key(branch_id) references public.branches(id),
  foreign key(category_id, branch_id) references public.product_categories(id, branch_id)
);
create table public.suppliers (
  id uuid primary key default gen_random_uuid(), supplier_name varchar(150) not null,
  contact varchar(150), location varchar(150), created_at timestamptz not null default now()
);
create table public.stock_batches (
  id uuid primary key default gen_random_uuid(), product_variant_id uuid not null references public.product_variants(id),
  branch_id uuid not null references public.branches(id), supplier_id uuid references public.suppliers(id),
  manufacturer_name varchar(150), delivery_code varchar(80), logged_by uuid not null references public.users(id),
  batch_number varchar(80) not null, expiry_date date not null, cost_price numeric(12,2) not null check(cost_price >= 0),
  selling_price numeric(12,2) not null check(selling_price >= 0), quantity_received integer not null check(quantity_received >= 0),
  received_at timestamptz not null default now(), unique(product_variant_id, batch_number, branch_id)
);
create table public.barcodes (
  id uuid primary key default gen_random_uuid(), stock_batch_id uuid not null references public.stock_batches(id),
  parent_barcode_id uuid references public.barcodes(id), barcode_type varchar(10) not null default 'pack' check(barcode_type in ('box','pack')),
  code varchar(64) not null unique, code_source varchar(20) not null default 'generated' check(code_source in ('manufacturer','generated')),
  child_count integer check(child_count is null or child_count >= 0), pieces_per_pack integer check(pieces_per_pack is null or pieces_per_pack > 0),
  quantity_available integer not null check(quantity_available >= 0), status varchar(20) not null default 'active'
    check(status in ('active','sold_out','expired','recalled','damaged')), created_at timestamptz not null default now(),
  check((barcode_type = 'box' and pieces_per_pack is null) or (barcode_type = 'pack' and child_count is null))
);
create table public.batch_recalls (
  id uuid primary key default gen_random_uuid(), product_variant_id uuid not null references public.product_variants(id),
  batch_number varchar(80) not null, manufacturer_name varchar(150), reason text not null,
  recalled_by uuid not null references public.users(id), recalled_at timestamptz not null default now()
);
create table public.stock_adjustments (
  id uuid primary key default gen_random_uuid(), stock_batch_id uuid references public.stock_batches(id), barcode_id uuid references public.barcodes(id),
  adjustment_type varchar(30) not null check(adjustment_type in ('damage','loss','correction','return','expired_writeoff','recalled')),
  quantity integer not null, reason text, performed_by uuid not null references public.users(id), adjusted_at timestamptz not null default now(),
  check(stock_batch_id is not null or barcode_id is not null)
);
create table public.notifications (
  id uuid primary key default gen_random_uuid(), branch_id uuid not null references public.branches(id),
  source_type varchar(30) not null check(source_type in ('batch_recall','stock_adjustment')), source_id uuid not null,
  message text not null, is_read boolean not null default false, created_at timestamptz not null default now()
);
create table public.discounts (
  id uuid primary key default gen_random_uuid(), name varchar(100) not null,
  discount_type varchar(20) not null check(discount_type in ('percentage','fixed')), value numeric(12,2) not null check(value >= 0),
  valid_from date, valid_to date, check(valid_to is null or valid_from is null or valid_to >= valid_from)
);
create table public.insurance_providers (
  id uuid primary key default gen_random_uuid(), name varchar(150) not null unique, contact_info text,
  default_coverage_percentage numeric(5,2) not null default 0 check(default_coverage_percentage between 0 and 100)
);
create table public.insurance_product_coverage (
  insurance_provider_id uuid not null references public.insurance_providers(id), product_id uuid not null references public.products(id),
  coverage_percentage numeric(5,2) not null check(coverage_percentage between 0 and 100), primary key(insurance_provider_id, product_id)
);
create table public.sales (
  id uuid primary key default gen_random_uuid(), branch_id uuid not null references public.branches(id), cashier_id uuid not null references public.users(id),
  discount_id uuid references public.discounts(id), total_amount numeric(12,2) not null check(total_amount >= 0), sold_at timestamptz not null default now()
);
create table public.sale_items (
  id uuid primary key default gen_random_uuid(), sale_id uuid not null references public.sales(id) on delete cascade,
  barcode_id uuid not null references public.barcodes(id), tax_rate_id uuid not null references public.tax_rates(id),
  quantity integer not null default 1 check(quantity > 0), unit_price numeric(12,2) not null check(unit_price >= 0), subtotal numeric(12,2) not null check(subtotal >= 0)
);
create table public.receipts (
  id uuid primary key default gen_random_uuid(), sale_id uuid not null unique references public.sales(id) on delete cascade,
  receipt_number varchar(50) not null unique, issued_at timestamptz not null default now()
);
create table public.insurance_claims (
  id uuid primary key default gen_random_uuid(), sale_id uuid not null unique references public.sales(id),
  insurance_provider_id uuid not null references public.insurance_providers(id), coverage_percentage_applied numeric(5,2) not null check(coverage_percentage_applied between 0 and 100),
  claim_amount numeric(12,2) not null check(claim_amount >= 0), status varchar(20) not null default 'submitted' check(status in ('submitted','approved','rejected','paid')),
  submitted_at timestamptz not null default now()
);
create table public.sales_forecasts (
  id uuid primary key default gen_random_uuid(), branch_id uuid not null references public.branches(id), product_variant_id uuid not null references public.product_variants(id),
  forecast_period varchar(20) not null, predicted_quantity integer not null check(predicted_quantity >= 0), generated_at timestamptz not null default now()
);
create table public.dashboard_reports (
  id uuid primary key default gen_random_uuid(), branch_id uuid not null references public.branches(id), report_type varchar(50) not null,
  data jsonb not null default '{}'::jsonb, generated_at timestamptz not null default now()
);
create table public.support_tickets (
  id uuid primary key default gen_random_uuid(), branch_id uuid not null references public.branches(id), raised_by uuid not null references public.users(id),
  subject varchar(150) not null, description text, status varchar(20) not null default 'open' check(status in ('open','in_progress','resolved','closed')),
  created_at timestamptz not null default now()
);

create index idx_barcodes_batch on public.barcodes(stock_batch_id);
create index idx_barcodes_parent on public.barcodes(parent_barcode_id);
create index idx_stock_batches_variant_branch on public.stock_batches(product_variant_id, branch_id);
create index idx_stock_batches_delivery on public.stock_batches(delivery_code);
create index idx_sales_branch_date on public.sales(branch_id, sold_at desc);
create index idx_sale_items_sale on public.sale_items(sale_id);
create index idx_notifications_branch_unread on public.notifications(branch_id, is_read);

-- Supabase row-level security. An owner can see all branches; other roles only
-- see their own branch. Service-role keys bypass RLS for trusted server jobs.
create function public.current_branch_id() returns uuid language sql stable security definer set search_path = public as
  $$ select branch_id from public.users where id = auth.uid() and is_active $$;
create function public.is_owner() returns boolean language sql stable security definer set search_path = public as
  $$ select exists(select 1 from public.users where id = auth.uid() and role = 'owner' and is_active) $$;

alter table public.users enable row level security;
create policy "users read own branch" on public.users for select to authenticated using (public.is_owner() or branch_id = public.current_branch_id());

-- Directly branch-owned tables share the same access rule.
do $$
declare t text;
begin
  foreach t in array array['branches','branch_settings','product_categories','reorder_points','stock_batches','notifications','sales','sales_forecasts','dashboard_reports','support_tickets']
  loop
    execute format('alter table public.%I enable row level security', t);
    if t = 'branches' then
      execute 'create policy "branch access" on public.branches for select to authenticated using (public.is_owner() or id = public.current_branch_id())';
    else
      execute format('create policy "branch access" on public.%I for all to authenticated using (public.is_owner() or branch_id = public.current_branch_id()) with check (public.is_owner() or branch_id = public.current_branch_id())', t);
    end if;
  end loop;
end $$;

-- Enable RLS on remaining operational tables. Add narrowly scoped policies as
-- each screen is migrated; this deliberately prevents accidental exposure.
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
