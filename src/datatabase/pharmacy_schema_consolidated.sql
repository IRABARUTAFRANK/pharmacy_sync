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
  -- constraint). The onboarding migration below originally re-established 1
  -- user per branch via the `users_one_per_branch` unique index; the "FIX —
  -- relax 'one user per branch'" block near the end of this file replaces
  -- that with a partial index so only one 'owner' per branch is unique,
  -- since a branch now legitimately has any number of seller logins too.
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

  -- sale_items.barcode_id is a FK with no index. Deleting a barcode forces a
  -- sequential scan of sale_items per deleted row to check the foreign key --
  -- fine at small scale, but it hits Postgres's statement_timeout once the
  -- table has a few hundred thousand rows (found via a large-scale load
  -- test, but the same slowdown applies to any real branch after enough
  -- normal use). The matching index for sales.patient_id lives further down,
  -- right after that column is added -- it doesn't exist yet at this point
  -- in a from-scratch run of this file.
  create index if not exists idx_sale_items_barcode on public.sale_items(barcode_id);

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

  -- Branch <-> user was one-to-one for the MVP (a branch had only its owner
  -- login). Superseded further down (see "FIX — relax 'one user per branch'"
  -- near the end of this file) once the seller role shipped and a branch
  -- legitimately gained more than one login: that block drops this index and
  -- replaces it with a narrower one-owner-per-branch partial index instead.
  --
  -- Unlike every other "superseded later in this file" statement here, a
  -- unique index is not safely re-runnable once live data has outgrown it:
  -- on any database that has ever created a seller (more than one user for
  -- the same branch_id), this create would fail with "could not create
  -- unique index ... is duplicated" on every single re-run, forever, well
  -- before the script ever reaches the later block that drops it. Wrapped
  -- in its own block so that specific failure is swallowed here -- a fresh
  -- database still gets the index (and the later block still narrows it),
  -- while a database that already has sellers just skips straight to the
  -- later, correct, partial index.
  do $$
  begin
    create unique index if not exists users_one_per_branch on public.users (branch_id);
  exception when unique_violation then
    null;
  end $$;

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

  -- Legacy global suppliers (branch_id null) stay readable by everyone; a branch
  -- may only write its own supplier rows. (Must come after the branch_id column
  -- above -- moved out of the earlier RLS policies block, where it referenced a
  -- column that did not exist yet on a from-scratch run of this file.)
  drop policy if exists "suppliers access" on public.suppliers;
  create policy "suppliers access" on public.suppliers
  for all to authenticated
  using (public.is_super_admin() or branch_id is null or branch_id = public.current_branch_id())
  with check (public.is_super_admin() or branch_id = public.current_branch_id());

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

  -- A printed barcode is only ever this short opaque id -- never a description
  -- of the batch, delivery, or position. 8 characters over a 32-symbol alphabet
  -- (no 0/O/1/I, matching activate_pharmacy_account()'s activation codes) is
  -- ~1.1 trillion combinations, far beyond collision risk at pharmacy scale, so
  -- this deliberately doesn't retry on the (effectively never occurring) unique
  -- violation -- keeping it simple, per the request that prompted it.
  create or replace function public.generate_short_barcode_code()
  returns text
  language plpgsql
  as $$
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
  $$;

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
    v_existing_category uuid;
    v_existing_category_name text;
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

      -- Each barcode's printed/scanned value is just a short opaque id
      -- (public.generate_short_barcode_code()) -- never a description of the
      -- batch or delivery. Everything about the product, batch, price and
      -- supplier is reached by joining through stock_batch_id, exactly as
      -- lookup_barcode() already does. Keeping the printed code short is what
      -- keeps the printed barcode itself short and reliably scannable.
      if v_cartons > 0 then
        for i in 1..v_cartons loop
          insert into public.barcodes (stock_batch_id, barcode_type, code, code_source, child_count, quantity_available)
          values (v_batch, 'box', public.generate_short_barcode_code(), 'generated', v_packs, 1)
          returning id into v_parent;
          for j in 1..v_packs loop
            insert into public.barcodes (stock_batch_id, parent_barcode_id, barcode_type, code, code_source, pieces_per_pack, quantity_available)
            values (v_batch, v_parent, 'pack', public.generate_short_barcode_code(), 'generated', v_pieces, 1);
          end loop;
        end loop;
      else
        for j in 1..v_packs loop
          insert into public.barcodes (stock_batch_id, barcode_type, code, code_source, pieces_per_pack, quantity_available)
          values (v_batch, 'pack', public.generate_short_barcode_code(), 'generated', v_pieces, 1);
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

  -- ── Sale-time barcode lookup ────────────────────────────────────────────────
  -- Added directly against the live project (not through this file originally) --
  -- pulled in here so it's tracked and won't be lost if the schema is ever
  -- reconsolidated. Not yet called from any client code: sales/POS is still out
  -- of scope, but this is the RPC that scanning a pack barcode at sale time will
  -- call to resolve it back to product, batch, price and supplier info.
  --
  -- Dropped first, unconditionally: a database this file has already been run
  -- against in full has the later, wider redeclaration of this same function
  -- installed (see "lookup_barcode(): add product_id and tax_rate_id" further
  -- down) -- `create or replace` cannot narrow a function's OUT-parameter row
  -- shape back down to this older one, only Postgres's own DROP can. Safe to
  -- re-run: the wider version further down always recreates it either way.
  -- (That later declaration is also where child_pieces_per_pack/
  -- active_child_count -- the two carton-sale fields this one adds below --
  -- actually need to end up, since it's the one PostgREST ultimately sees;
  -- added there too, not just here.)
  drop function if exists public.lookup_barcode(text);
  create function public.lookup_barcode(p_code text)
  returns table(
    barcode_id uuid, code text, barcode_type text, status text,
    quantity_available integer, pieces_per_pack integer, child_count integer,
    child_pieces_per_pack integer, active_child_count integer,
    parent_code text, stock_batch_id uuid, batch_number text, expiry_date date,
    delivery_code text, selling_price numeric, product_name text, dosage text,
    form text, manufacturer_name text, supplier_name text
  )
  language sql
  stable
  security definer
  set search_path = ''
  as $$
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
      p.name::text,
      pv.dosage::text,
      pv.form::text,
      sb.manufacturer_name::text,
      s.supplier_name::text
    from public.barcodes bc
    join public.stock_batches sb on sb.id = bc.stock_batch_id
    join public.product_variants pv on pv.id = sb.product_variant_id
    join public.products p on p.id = pv.product_id
    left join public.barcodes parent on parent.id = bc.parent_barcode_id
    left join public.suppliers s on s.id = sb.supplier_id
    where upper(bc.code) = upper(btrim(p_code))
      and (
        public.is_super_admin()
        or sb.branch_id = public.current_branch_id()
      )
    limit 1
  $$;

  grant execute on function public.lookup_barcode(text) to authenticated;

  -- ============================================================================
  -- ONBOARDING — OTP activation window (3-hour expiry, auto-freeze) + email link
  -- ============================================================================
  -- The applicant is emailed a link + 6-digit code the moment the super admin
  -- approves the application (the admin's own browser triggers the send right
  -- after admin_approve_pharmacy_application succeeds — see approvePharmacyApplication
  -- in src/lib/onboarding.ts), not lazily whenever the applicant happens to
  -- still be on the pending-review page. otp_sent_at anchors a 3-hour
  -- activation window from that instant; any read of the application after
  -- that window flips it to 'denied' server-side, so a stale email link or
  -- code can never activate an account no matter which RPC touches the row
  -- first. (Also set Authentication -> Settings -> "Email OTP expiration" to
  -- 10800 seconds / 3 hours in the Supabase dashboard, so Supabase's own OTP
  -- verification rejects a stale code independently of this table.)

  alter table public.branch_applications
    add column if not exists otp_sent_at timestamptz;

  create or replace function public.freeze_expired_pharmacy_otp(p_application_id uuid)
  returns void
  language plpgsql
  security definer
  set search_path = ''
  as $$
  begin
    update public.branch_applications
    set status = 'denied',
        denied_reason = 'Activation window (3 hours) expired without verification'
    where id = p_application_id
      and status = 'otp_sent'
      and otp_sent_at is not null
      and now() > otp_sent_at + interval '3 hours';
  end;
  $$;

  -- Re-declared (see original definition above) to also stamp otp_sent_at,
  -- which starts the 3-hour activation window.
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
    set status = 'otp_sent', branch_id = v_branch, otp_sent_at = now()
    where id = p_application_id;

    return query select v_branch, v_app.email::text;
  end;
  $$;

  -- Re-declared to freeze an expired application before answering, and to stop
  -- offering OTPs once the 3-hour window has passed. Was `language sql`; needs
  -- plpgsql now so it can perform the freeze side-effect before the exists()
  -- check runs.
  create or replace function public.can_request_pharmacy_otp(p_email text)
  returns boolean
  language plpgsql
  stable
  security definer
  set search_path = ''
  as $$
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
  $$;

  -- Re-declared to freeze an expired 'otp_sent' application before returning
  -- it, so the applicant's status page reflects 'denied' the moment the
  -- 3-hour window has passed even if nothing else has touched the row yet.
  create or replace function public.get_pharmacy_application(p_application_id uuid)
  returns table (
    id uuid, application_code text, pharmacy_name text, phone text, email text,
    location text, status text, called_at timestamptz, denied_reason text,
    branch_id uuid, branch_code text, activation_code text, submitted_at timestamptz
  )
  language plpgsql
  stable
  security definer
  set search_path = ''
  as $$
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
  $$;

  -- Looks an application up by email instead of id, for the link emailed to
  -- the applicant once approved (.../#branch?email=...) — that link has to
  -- work from any device/browser, not just the one sessionStorage remembers
  -- the application id on.
  create or replace function public.get_pharmacy_application_by_email(p_email text)
  returns table (
    id uuid, application_code text, pharmacy_name text, phone text, email text,
    location text, status text, called_at timestamptz, denied_reason text,
    branch_id uuid, branch_code text, activation_code text, submitted_at timestamptz
  )
  language plpgsql
  stable
  security definer
  set search_path = ''
  as $$
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
  $$;

  revoke all on function public.freeze_expired_pharmacy_otp(uuid) from public;
  revoke all on function public.get_pharmacy_application_by_email(text) from public;
  grant execute on function public.get_pharmacy_application_by_email(text) to anon, authenticated;

-- ============================================================================
-- FIX — can_request_pharmacy_otp / get_pharmacy_application(_by_email) were
-- wrongly marked STABLE while calling freeze_expired_pharmacy_otp(), which
-- runs an UPDATE. PostgREST inspects a function's declared volatility and
-- runs STABLE/IMMUTABLE calls inside an explicit read-only transaction; the
-- nested UPDATE then fails with "cannot execute UPDATE in a read-only
-- transaction" the moment an application has actually expired. Re-declared
-- here as plain (volatile, the default) functions — same bodies, no other
-- change. This block only needs to be applied once; re-running it is safe
-- like the rest of this file.
-- ============================================================================

create or replace function public.can_request_pharmacy_otp(p_email text)
returns boolean
language plpgsql
security definer
set search_path = ''
as $$
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
$$;

create or replace function public.get_pharmacy_application(p_application_id uuid)
returns table (
  id uuid, application_code text, pharmacy_name text, phone text, email text,
  location text, status text, called_at timestamptz, denied_reason text,
  branch_id uuid, branch_code text, activation_code text, submitted_at timestamptz
)
language plpgsql
security definer
set search_path = ''
as $$
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
$$;

create or replace function public.get_pharmacy_application_by_email(p_email text)
returns table (
  id uuid, application_code text, pharmacy_name text, phone text, email text,
  location text, status text, called_at timestamptz, denied_reason text,
  branch_id uuid, branch_code text, activation_code text, submitted_at timestamptz
)
language plpgsql
security definer
set search_path = ''
as $$
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
$$;

-- ============================================================================
-- PUBLIC MARKETING STATS — real counts for the home page's trust-stat strip
-- ============================================================================
-- Aggregate counts only (never row-level data), readable before sign-in, so
-- the "12+ Pharmacies / 50k+ SKUs / 3 Cities" strip on the marketing home
-- page shows this project's real numbers instead of the Figma template's.

create or replace function public.public_platform_stats()
returns table(active_branches integer, tracked_skus integer, cities integer)
language sql
stable
security definer
set search_path = ''
as $$
  select
    (select count(*)::integer from public.branches where status = 'active'),
    (select count(distinct pv.id)::integer
       from public.product_variants pv
       join public.stock_batches sb on sb.product_variant_id = pv.id),
    (select count(distinct upper(btrim(split_part(b.address, ',', 1))))::integer
       from public.branches b
       where b.status = 'active' and nullif(btrim(b.address), '') is not null)
$$;

revoke all on function public.public_platform_stats() from public;
grant execute on function public.public_platform_stats() to anon, authenticated;

-- ============================================================================
-- SUPER ADMIN — delete a branch (destructive; wipes every row the branch
-- owns across the schema). The UI (AdminPortal.tsx) gates this behind a
-- step-up re-verification — the admin re-enters their email and a fresh
-- emailed OTP — before ever calling this RPC; assert_super_admin() below is
-- the actual server-side authority, the OTP step is a human confirmation
-- gate on top of it, not a substitute for it.
--
-- Deletes in FK-safe order, leaf tables first. Two things are deliberately
-- NOT touched:
--   * batch_recalls: a system-wide safety record (any branch can see any
--     recall), not owned by one branch — it must survive that branch being
--     deleted. Its recalled_by column is `not null references users(id)`,
--     so if anyone from this branch ever issued a recall, their public.users
--     row can't be removed without breaking that FK; the function raises a
--     clear error in that case rather than silently deleting the recall
--     record or leaving a dangling reference.
--   * branch_applications: the original application row is kept as a
--     historical record, with branch_id nulled out instead of deleted.
-- ============================================================================

create or replace function public.admin_delete_branch(p_branch_id uuid)
returns void
language plpgsql
security definer
set search_path = ''
as $$
begin
  perform public.assert_super_admin();

  if not exists (select 1 from public.branches where id = p_branch_id) then
    raise exception 'Branch not found';
  end if;

  if exists (
    select 1 from public.batch_recalls r
    join public.users u on u.id = r.recalled_by
    where u.branch_id = p_branch_id
  ) then
    raise exception 'This branch cannot be deleted: a user from this branch is recorded as having issued a system-wide batch recall, and that recall record must be kept. Contact support to reassign it first.';
  end if;

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

  delete from public.notifications where branch_id = p_branch_id;
  delete from public.sales_forecasts where branch_id = p_branch_id;
  delete from public.dashboard_reports where branch_id = p_branch_id;
  delete from public.support_tickets where branch_id = p_branch_id;
  delete from public.branch_settings where branch_id = p_branch_id;
  delete from public.suppliers where branch_id = p_branch_id;

  update public.branch_applications set branch_id = null where branch_id = p_branch_id;

  delete from public.branch_directory where branch_id = p_branch_id;
  delete from public.users where branch_id = p_branch_id;
  delete from public.branches where id = p_branch_id;
end;
$$;

revoke all on function public.admin_delete_branch(uuid) from public;
grant execute on function public.admin_delete_branch(uuid) to authenticated;

-- ============================================================================
-- PRODUCT OWNERSHIP LOCKDOWN, ADMIN-MANAGED TAX, PRODUCT REQUESTS, REAL
-- TICKETS/NOTIFICATIONS, DELIVERY-LINKED APPROVAL
-- ============================================================================
-- Branches can no longer invent products during stock receiving. A branch
-- that can't find a product in the catalogue files a product_requests row
-- instead; only the super admin creates products (and sets their tax rate),
-- via admin_create_product() or admin_approve_product_request(). This block
-- is additive/idempotent like the rest of this file and safe to re-run.
-- ============================================================================

-- ── Canonical tax rates ──────────────────────────────────────────────────
-- 'Exempt' (0%) may already exist (created lazily by the old
-- receive_stock_delivery(), or by re-running this block). Rwanda's 2025 VAT
-- law reform: standard rate 18%, pharmaceutical products VAT-exempt. These
-- are the two rates the super admin chooses between on the Products & Tax
-- screen; every product still defaults to Exempt (0%) on creation.
insert into public.tax_rates (name, rate_percentage)
values ('Exempt', 0), ('Standard Rate', 18)
on conflict (name) do nothing;

-- ── support_tickets — add priority, matching the console UI it now backs ──
alter table public.support_tickets
  add column if not exists priority varchar(10) not null default 'medium';
alter table public.support_tickets drop constraint if exists support_tickets_priority_check;
alter table public.support_tickets add constraint support_tickets_priority_check
  check (priority in ('low','medium','high'));

-- ── notifications — widen source_type for the new resolution events ──────
-- Includes 'out_of_stock' here too, even though that source type isn't
-- introduced until the "RECURRING OUT-OF-STOCK ALERTS" block further down:
-- a database this file has already been run against in full already has
-- 'out_of_stock' notification rows, and this statement would otherwise
-- briefly re-narrow the constraint below what's already live, which Postgres
-- rejects outright ("check constraint ... is violated by some row") rather
-- than just failing the rows that don't fit. Keeping both alters in sync so
-- neither one is ever narrower than the other, regardless of run order.
alter table public.notifications drop constraint if exists notifications_source_type_check;
alter table public.notifications add constraint notifications_source_type_check
  check (source_type in ('batch_recall','stock_adjustment','product_request_approved','product_request_rejected','out_of_stock'));

-- ============================================================================
-- PRODUCT REQUESTS
-- ============================================================================
-- A branch files one when a delivery includes a product not yet in the
-- catalogue. delivery_id/batch/price/packaging columns are only populated
-- when the request arose mid-receiving (see finish_pending_delivery_item()
-- below); a request filed with no delivery in progress leaves them null and
-- is a pure catalogue ask the branch will receive normally once approved.

create table if not exists public.product_requests (
  id uuid primary key default gen_random_uuid(),
  branch_id uuid not null references public.branches(id),
  requested_by uuid not null references public.users(id),
  product_name varchar(150) not null,
  generic_name varchar(150),
  product_type varchar(20) not null default 'medicine' check (product_type in ('medicine','supply','other')),
  dosage varchar(50), form varchar(50), unit varchar(30),
  category_name varchar(100),
  notes text,
  status varchar(20) not null default 'pending' check (status in ('pending','approved','rejected')),
  resolved_product_id uuid references public.products(id),
  resolved_variant_id uuid references public.product_variants(id),
  resolved_by uuid references public.users(id),
  resolved_at timestamptz,
  rejection_reason text,
  finished_at timestamptz,
  delivery_id uuid references public.stock_deliveries(id),
  batch_number varchar(80), expiry_date date,
  cost_price numeric(12,2), selling_price numeric(12,2),
  cartons integer, packs_per_carton integer, packs integer, pieces_per_pack integer,
  manufacturer_name varchar(150),
  created_at timestamptz not null default now()
);

create index if not exists idx_product_requests_branch_status on public.product_requests(branch_id, status);

alter table public.product_requests enable row level security;
drop policy if exists "branch access" on public.product_requests;
create policy "branch access" on public.product_requests
for all to authenticated
using (public.is_super_admin() or branch_id = public.current_branch_id())
with check (public.is_super_admin() or branch_id = public.current_branch_id());

-- Select-only: writes go through submit_product_request()/the admin RPCs
-- below, which validate branch/role/status before touching the row. The
-- branch's own "pending product requests" panel reads this table directly
-- (RLS already scopes it to branch_id = current_branch_id()).
grant select on public.product_requests to authenticated;

-- ============================================================================
-- SHARED HELPER — create one stock batch + its barcode tree
-- ============================================================================
-- Factored out of receive_stock_delivery() so finish_pending_delivery_item()
-- (below) can create a stock batch under an EARLIER delivery without
-- duplicating the carton/pack barcode-generation loop. Same packing rule as
-- barcodes_packing_shape: a carton (box) parent with pack children, or bare
-- packs with no parent.

create or replace function public.create_stock_batch_with_barcodes(
  p_variant uuid, p_branch uuid, p_supplier uuid, p_manufacturer text,
  p_delivery uuid, p_delivery_code text, p_user uuid,
  p_batch_number text, p_expiry date, p_cost numeric, p_sell numeric,
  p_cartons integer, p_packs integer, p_pieces integer
)
returns uuid
language plpgsql
security definer
set search_path = ''
as $$
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
$$;

-- ============================================================================
-- receive_stock_delivery() — remove inline product/variant creation
-- ============================================================================
-- Re-declared to drop the branch that used to create a public.products /
-- public.product_variants row from a bare product_name. A line without
-- product_variant_id now raises immediately, directing the caller to file a
-- product request instead. Batch/barcode creation now goes through the
-- shared create_stock_batch_with_barcodes() helper above. Supplier and
-- category handling are otherwise unchanged from the prior declaration.

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
  v_category uuid;
  v_existing_category uuid;
  v_existing_category_name text;
  v_product uuid;
  v_variant uuid;
  v_cartons integer;
  v_packs integer;
  v_pieces integer;
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
$$;

-- ============================================================================
-- finish_pending_delivery_item() — once a product_requests row is approved
-- and carries delivery-linkage columns (i.e. it arose mid-receiving), the
-- owning branch calls this to create the stock batch + barcode tree tagged
-- with the ORIGINAL delivery_id/delivery_code and supplier, so the item is
-- never orphaned from the delivery it physically arrived in.
-- ============================================================================

create or replace function public.finish_pending_delivery_item(p_request_id uuid)
returns table(stock_batch_id uuid, delivery_code text)
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_user uuid := (select auth.uid());
  v_branch uuid;
  v_req public.product_requests%rowtype;
  v_delivery_code text;
  v_supplier uuid;
  v_batch uuid;
  v_category uuid;
  v_existing_category uuid;
  v_existing_category_name text;
begin
  select u.branch_id into v_branch from public.users u where u.id = v_user and u.is_active;
  if v_branch is null then raise exception 'Only an active branch user may finish a delivery item'; end if;

  select * into v_req from public.product_requests where id = p_request_id;
  if v_req.id is null then raise exception 'Product request not found'; end if;
  if v_req.branch_id <> v_branch then raise exception 'This request belongs to a different branch'; end if;
  if v_req.status <> 'approved' then raise exception 'This request has not been approved yet'; end if;
  if v_req.finished_at is not null then raise exception 'This item has already been added to stock'; end if;
  if v_req.resolved_variant_id is null then raise exception 'No product variant was resolved for this request'; end if;
  if v_req.delivery_id is null or v_req.batch_number is null then
    raise exception 'This request was not tied to a delivery -- nothing to finish';
  end if;

  select sd.delivery_code, sd.supplier_id into v_delivery_code, v_supplier
  from public.stock_deliveries sd
  where sd.id = v_req.delivery_id;
  if v_delivery_code is null then raise exception 'The original delivery could not be found'; end if;

  if nullif(btrim(coalesce(v_req.category_name, '')), '') is not null then
    insert into public.product_categories (branch_id, name)
    values (v_branch, btrim(v_req.category_name))
    on conflict (branch_id, name) do update set name = excluded.name
    returning id into v_category;

    select bpc.category_id into v_existing_category
    from public.branch_product_categorization bpc
    where bpc.branch_id = v_branch and bpc.product_id = v_req.resolved_product_id;

    if v_existing_category is null then
      insert into public.branch_product_categorization (branch_id, product_id, category_id)
      values (v_branch, v_req.resolved_product_id, v_category);
    elsif v_existing_category <> v_category then
      select pc.name into v_existing_category_name from public.product_categories pc where pc.id = v_existing_category;
      raise exception 'This product does not belong to the category you chose. It belongs to "%" for this branch.', v_existing_category_name;
    end if;
  end if;

  v_batch := public.create_stock_batch_with_barcodes(
    v_req.resolved_variant_id, v_branch, v_supplier, v_req.manufacturer_name,
    v_req.delivery_id, v_delivery_code, v_user, v_req.batch_number, v_req.expiry_date,
    v_req.cost_price, v_req.selling_price,
    coalesce(v_req.cartons, 0), greatest(coalesce(v_req.packs_per_carton, v_req.packs, 1), 1), greatest(coalesce(v_req.pieces_per_pack, 1), 1)
  );

  update public.product_requests set finished_at = now() where id = p_request_id;

  return query select v_batch, v_delivery_code;
end;
$$;

-- ============================================================================
-- BRANCH-SIDE — file a product request
-- ============================================================================

create or replace function public.submit_product_request(
  p_product_name text, p_generic_name text, p_product_type text,
  p_dosage text, p_form text, p_unit text, p_category_name text, p_notes text,
  p_delivery_id uuid default null, p_batch_number text default null, p_expiry_date date default null,
  p_cost_price numeric default null, p_selling_price numeric default null,
  p_cartons integer default null, p_packs_per_carton integer default null,
  p_packs integer default null, p_pieces_per_pack integer default null,
  p_manufacturer_name text default null
)
returns uuid
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_user uuid := (select auth.uid());
  v_branch uuid;
  v_type text;
  v_id uuid;
begin
  select u.branch_id into v_branch from public.users u where u.id = v_user and u.is_active;
  if v_branch is null then raise exception 'Only an active branch user may request a product'; end if;
  if nullif(btrim(coalesce(p_product_name, '')), '') is null then
    raise exception 'A product name is required';
  end if;
  if p_delivery_id is not null and not exists (
    select 1 from public.stock_deliveries sd where sd.id = p_delivery_id and sd.branch_id = v_branch
  ) then
    raise exception 'That delivery does not belong to this branch';
  end if;

  v_type := coalesce(nullif(p_product_type, ''), 'medicine');
  if v_type not in ('medicine','supply','other') then v_type := 'other'; end if;

  insert into public.product_requests (
    branch_id, requested_by, product_name, generic_name, product_type, dosage, form, unit,
    category_name, notes, delivery_id, batch_number, expiry_date, cost_price, selling_price,
    cartons, packs_per_carton, packs, pieces_per_pack, manufacturer_name
  ) values (
    v_branch, v_user, btrim(p_product_name), nullif(btrim(coalesce(p_generic_name, '')), ''), v_type,
    nullif(btrim(coalesce(p_dosage, '')), ''), nullif(btrim(coalesce(p_form, '')), ''), nullif(btrim(coalesce(p_unit, '')), ''),
    nullif(btrim(coalesce(p_category_name, '')), ''), nullif(btrim(coalesce(p_notes, '')), ''),
    p_delivery_id, nullif(btrim(coalesce(p_batch_number, '')), ''), p_expiry_date, p_cost_price, p_selling_price,
    p_cartons, p_packs_per_carton, p_packs, p_pieces_per_pack, nullif(btrim(coalesce(p_manufacturer_name, '')), '')
  )
  returning id into v_id;

  return v_id;
end;
$$;

-- ============================================================================
-- ADMIN — products, tax rates, and product-request approval
-- ============================================================================

create or replace function public.admin_list_products()
returns table(
  product_id uuid, product_name text, generic_name text, product_type text,
  tax_rate_id uuid, tax_rate_name text, tax_rate_percentage numeric,
  variant_id uuid, dosage text, form text, unit text
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
      p.id, p.name::text, p.generic_name::text, p.product_type::text,
      t.id, t.name::text, t.rate_percentage,
      pv.id, pv.dosage::text, pv.form::text, pv.unit::text
    from public.products p
    join public.tax_rates t on t.id = p.tax_rate_id
    left join public.product_variants pv on pv.product_id = p.id
    order by p.name, pv.dosage nulls first;
end;
$$;

-- p_variants: jsonb array of {"dosage":..,"form":..,"unit":..}, at least one
-- entry required -- branches can only select an existing product_variant_id
-- now, so a product created with zero variants would never be receivable.
create or replace function public.admin_create_product(
  p_name text, p_generic_name text, p_product_type text, p_tax_rate_id uuid, p_variants jsonb
)
returns uuid
language plpgsql
security definer
set search_path = ''
as $$
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
$$;

create or replace function public.admin_set_product_tax(p_product_id uuid, p_tax_rate_id uuid)
returns void
language plpgsql
security definer
set search_path = ''
as $$
begin
  perform public.assert_super_admin();
  if not exists (select 1 from public.tax_rates t where t.id = p_tax_rate_id) then
    raise exception 'Unknown tax rate';
  end if;
  update public.products set tax_rate_id = p_tax_rate_id where id = p_product_id;
  if not found then raise exception 'Product not found'; end if;
end;
$$;

-- Dropped first, unconditionally: same reasoning as lookup_barcode() above --
-- a database this file has already been run against in full has the later,
-- narrower redeclaration of this function installed (see "PRODUCT REQUESTS
-- — simplified to a message + optional photo" further down), and
-- `create or replace` cannot change a function's OUT-parameter row shape
-- without an explicit DROP first. Safe to re-run either way: the narrower
-- version further down always recreates it regardless of which one existed.
drop function if exists public.admin_list_product_requests();
create or replace function public.admin_list_product_requests()
returns table(
  id uuid, branch_id uuid, branch_name text, requested_by_name text,
  product_name text, generic_name text, product_type text, dosage text, form text, unit text,
  category_name text, notes text, status text,
  delivery_id uuid, batch_number text, expiry_date date, cost_price numeric, selling_price numeric,
  cartons integer, packs_per_carton integer, packs integer, pieces_per_pack integer, manufacturer_name text,
  rejection_reason text, finished_at timestamptz, created_at timestamptz
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
      r.id, r.branch_id, b.name::text, u.full_name::text,
      r.product_name::text, r.generic_name::text, r.product_type::text, r.dosage::text, r.form::text, r.unit::text,
      r.category_name::text, r.notes, r.status::text,
      r.delivery_id, r.batch_number::text, r.expiry_date, r.cost_price, r.selling_price,
      r.cartons, r.packs_per_carton, r.packs, r.pieces_per_pack, r.manufacturer_name::text,
      r.rejection_reason, r.finished_at, r.created_at
    from public.product_requests r
    join public.branches b on b.id = r.branch_id
    join public.users u on u.id = r.requested_by
    order by (r.status = 'pending') desc, r.created_at desc;
end;
$$;

-- p_variants: same shape as admin_create_product(). The FIRST entry becomes
-- this request's resolved_variant_id (the variant this specific delivery
-- line/batch is for); any further entries just extend the catalogue entry
-- (e.g. the admin adds other known dosages of the same product while here).
create or replace function public.admin_approve_product_request(
  p_request_id uuid, p_product_name text, p_generic_name text, p_product_type text,
  p_tax_rate_id uuid, p_variants jsonb
)
returns table(product_id uuid, variant_id uuid)
language plpgsql
security definer
set search_path = ''
as $$
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
  if not exists (select 1 from public.tax_rates t where t.id = p_tax_rate_id) then
    raise exception 'Unknown tax rate';
  end if;
  if jsonb_typeof(p_variants) <> 'array' or jsonb_array_length(p_variants) = 0 then
    raise exception 'At least one variant (dosage/form/unit) is required';
  end if;

  v_type := coalesce(nullif(p_product_type, ''), 'medicine');
  if v_type not in ('medicine','supply','other') then v_type := 'other'; end if;

  select p.id into v_product from public.products p where lower(p.name) = lower(btrim(coalesce(p_product_name, v_req.product_name)));
  if v_product is null then
    insert into public.products (tax_rate_id, product_type, name, generic_name)
    values (p_tax_rate_id, v_type, btrim(coalesce(p_product_name, v_req.product_name)), nullif(btrim(coalesce(p_generic_name, v_req.generic_name, '')), ''))
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
    format('Your request for "%s" was approved and is ready to add to stock.', coalesce(p_product_name, v_req.product_name)));

  return query select v_product, v_first_variant;
end;
$$;

create or replace function public.admin_reject_product_request(p_request_id uuid, p_reason text)
returns void
language plpgsql
security definer
set search_path = ''
as $$
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
    format('Your request for "%s" was declined.%s', v_req.product_name,
      case when nullif(btrim(coalesce(p_reason, '')), '') is not null then ' Reason: ' || btrim(p_reason) else '' end));
end;
$$;

-- ============================================================================
-- SUPPORT TICKETS — real table, replacing the localStorage mock
-- ============================================================================

create or replace function public.submit_support_ticket(p_subject text, p_description text, p_priority text default 'medium')
returns uuid
language plpgsql
security definer
set search_path = ''
as $$
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
$$;

create or replace function public.list_my_support_tickets()
returns table(id uuid, subject text, description text, status text, priority text, created_at timestamptz)
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  v_branch uuid := public.current_branch_id();
begin
  if v_branch is null then raise exception 'Only an active branch user may view tickets'; end if;
  return query
    select t.id, t.subject::text, t.description, t.status::text, t.priority::text, t.created_at
    from public.support_tickets t
    where t.branch_id = v_branch
    order by t.created_at desc;
end;
$$;

create or replace function public.admin_list_support_tickets()
returns table(id uuid, branch_id uuid, branch_name text, raised_by_name text, subject text, description text, status text, priority text, created_at timestamptz)
language plpgsql
stable
security definer
set search_path = ''
as $$
begin
  perform public.assert_super_admin();
  return query
    select t.id, t.branch_id, b.name::text, u.full_name::text, t.subject::text, t.description, t.status::text, t.priority::text, t.created_at
    from public.support_tickets t
    join public.branches b on b.id = t.branch_id
    join public.users u on u.id = t.raised_by
    order by (t.status = 'open') desc, t.created_at desc;
end;
$$;

create or replace function public.admin_update_ticket_status(p_ticket_id uuid, p_status text)
returns void
language plpgsql
security definer
set search_path = ''
as $$
begin
  perform public.assert_super_admin();
  if p_status not in ('open','in_progress','resolved','closed') then raise exception 'Unknown status'; end if;
  update public.support_tickets set status = p_status where id = p_ticket_id;
  if not found then raise exception 'Ticket not found'; end if;
end;
$$;

-- ============================================================================
-- GRANTS — Phase 1 additions
-- ============================================================================

revoke all on function public.create_stock_batch_with_barcodes(uuid, uuid, uuid, text, uuid, text, uuid, text, date, numeric, numeric, integer, integer, integer) from public, anon, authenticated;

revoke all on function public.finish_pending_delivery_item(uuid) from public;
grant execute on function public.finish_pending_delivery_item(uuid) to authenticated;

revoke all on function public.submit_product_request(text, text, text, text, text, text, text, text, uuid, text, date, numeric, numeric, integer, integer, integer, integer, text) from public;
grant execute on function public.submit_product_request(text, text, text, text, text, text, text, text, uuid, text, date, numeric, numeric, integer, integer, integer, integer, text) to authenticated;

revoke all on function public.admin_list_products() from public;
grant execute on function public.admin_list_products() to authenticated;

revoke all on function public.admin_create_product(text, text, text, uuid, jsonb) from public;
grant execute on function public.admin_create_product(text, text, text, uuid, jsonb) to authenticated;

revoke all on function public.admin_set_product_tax(uuid, uuid) from public;
grant execute on function public.admin_set_product_tax(uuid, uuid) to authenticated;

revoke all on function public.admin_list_product_requests() from public;
grant execute on function public.admin_list_product_requests() to authenticated;

revoke all on function public.admin_approve_product_request(uuid, text, text, text, uuid, jsonb) from public;
grant execute on function public.admin_approve_product_request(uuid, text, text, text, uuid, jsonb) to authenticated;

revoke all on function public.admin_reject_product_request(uuid, text) from public;
grant execute on function public.admin_reject_product_request(uuid, text) to authenticated;

revoke all on function public.submit_support_ticket(text, text, text) from public;
grant execute on function public.submit_support_ticket(text, text, text) to authenticated;

revoke all on function public.list_my_support_tickets() from public;
grant execute on function public.list_my_support_tickets() to authenticated;

revoke all on function public.admin_list_support_tickets() from public;
grant execute on function public.admin_list_support_tickets() to authenticated;

revoke all on function public.admin_update_ticket_status(uuid, text) from public;
grant execute on function public.admin_update_ticket_status(uuid, text) to authenticated;

-- notifications had an RLS policy (in the original "branch access" loop
-- above) with no matching GRANT -- same class of bug already fixed for
-- batch_recalls/stock_adjustments elsewhere in this file, which made the
-- table unreachable from the browser regardless of policy. update is needed
-- so the client can mark a notification read.
grant select, update on public.notifications to authenticated;

-- ============================================================================
-- FOLLOW-UP FIXES — simplified product requests, category/tax admin control,
-- branch-only suppliers, category de-duplication
-- ============================================================================

-- ── Suppliers — branch-exclusive, no cross-branch "global" sharing ────────
-- Previously any branch could also see legacy branch_id-null supplier rows.
-- Now every branch only ever sees its own.
drop policy if exists "suppliers access" on public.suppliers;
create policy "suppliers access" on public.suppliers
for all to authenticated
using (public.is_super_admin() or branch_id = public.current_branch_id())
with check (public.is_super_admin() or branch_id = public.current_branch_id());

-- ── Category de-duplication + enforce the uniqueness this depends on ──────
-- A table created by an earlier variant of this schema (before the
-- unique(branch_id, name) constraint existed) never retroactively picks up
-- a constraint declared later, since `create table if not exists` is a
-- no-op once the table already exists. Repeated seeding then produced
-- duplicate rows (the same category name, same branch, several times over
-- -- e.g. "Allergy & Antihistamines" listed many times in the same
-- dropdown). This dedupes them (oldest row wins; any categorization
-- pointed at a row being removed is repointed at the surviving one first)
-- and makes sure the constraint actually exists so it can't happen again.
do $$
begin
  with ranked as (
    select id, branch_id,
           row_number() over (partition by branch_id, lower(name) order by id) as rn,
           first_value(id) over (partition by branch_id, lower(name) order by id) as keep_id
    from public.product_categories
  )
  update public.branch_product_categorization bpc
  set category_id = ranked.keep_id
  from ranked
  where bpc.category_id = ranked.id and ranked.rn > 1;

  with ranked as (
    select id, branch_id,
           row_number() over (partition by branch_id, lower(name) order by id) as rn
    from public.product_categories
  )
  delete from public.product_categories pc
  using ranked
  where pc.id = ranked.id and ranked.rn > 1;
end $$;

do $$
begin
  alter table public.product_categories add constraint product_categories_branch_id_name_key unique (branch_id, name);
-- Adding a constraint that already exists can surface as either error class
-- depending on the path Postgres takes internally (duplicate_object for the
-- constraint itself, duplicate_table for the unique index backing it) --
-- catching only one of the two is why the first version of this block
-- still failed on a database where the constraint was already present.
exception when duplicate_object or duplicate_table then null;
end $$;

-- ============================================================================
-- ADMIN — categories across every branch, and the ability to add new ones
-- (e.g. a Ministry of Health mandated category), system-wide or per branch.
-- ============================================================================

create or replace function public.admin_list_categories()
returns table(id uuid, branch_id uuid, branch_name text, name text, description text)
language plpgsql
stable
security definer
set search_path = ''
as $$
begin
  perform public.assert_super_admin();
  return query
    select pc.id, pc.branch_id, b.name::text, pc.name::text, pc.description
    from public.product_categories pc
    join public.branches b on b.id = pc.branch_id
    order by b.name, pc.name;
end;
$$;

-- p_branch_id null => create this category for every branch that doesn't
-- already have it (a new government-mandated category, say); a specific
-- branch id creates it for that one branch only. Returns how many branches
-- actually got a new row (existing ones are silently skipped).
create or replace function public.admin_create_category(p_name text, p_description text, p_branch_id uuid default null)
returns integer
language plpgsql
security definer
set search_path = ''
as $$
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
$$;

-- ============================================================================
-- ADMIN — tax rates: add new ones (a newly imposed tax, etc.)
-- ============================================================================

create or replace function public.admin_create_tax_rate(p_name text, p_rate_percentage numeric)
returns uuid
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_id uuid;
begin
  perform public.assert_super_admin();
  if nullif(btrim(coalesce(p_name, '')), '') is null then raise exception 'A tax rate name is required'; end if;
  if p_rate_percentage is null or p_rate_percentage < 0 or p_rate_percentage > 100 then
    raise exception 'Tax rate must be between 0 and 100';
  end if;
  insert into public.tax_rates (name, rate_percentage) values (btrim(p_name), p_rate_percentage) returning id into v_id;
  return v_id;
end;
$$;

-- ============================================================================
-- PRODUCT REQUESTS — simplified to a message + optional photo
-- ============================================================================
-- Replaces the earlier structured version (product name/type/dosage/form/
-- unit/category, plus delivery-linkage columns for a "finish receiving"
-- step) with the much simpler flow actually wanted: the branch describes
-- what's missing in their own words and can attach a photo; the super admin
-- reads it and creates the real catalogue entry (with proper name/variants/
-- tax) when approving. Once approved, the branch just receives it normally
-- as a "Known product" on their next delivery -- no separate finish step.
-- There is no live data in this table yet (the whole feature is
-- pre-launch), so it's dropped and recreated rather than migrated column by
-- column.

drop function if exists public.finish_pending_delivery_item(uuid);
drop function if exists public.submit_product_request(text, text, text, text, text, text, text, text, uuid, text, date, numeric, numeric, integer, integer, integer, integer, text);
drop function if exists public.admin_list_product_requests();
drop table if exists public.product_requests;

create table public.product_requests (
  id uuid primary key default gen_random_uuid(),
  branch_id uuid not null references public.branches(id),
  requested_by uuid not null references public.users(id),
  message text not null,
  image_path text,
  status varchar(20) not null default 'pending' check (status in ('pending','approved','rejected')),
  resolved_product_id uuid references public.products(id),
  resolved_variant_id uuid references public.product_variants(id),
  resolved_by uuid references public.users(id),
  resolved_at timestamptz,
  rejection_reason text,
  created_at timestamptz not null default now()
);

create index idx_product_requests_branch_status on public.product_requests(branch_id, status);

alter table public.product_requests enable row level security;
create policy "branch access" on public.product_requests
for all to authenticated
using (public.is_super_admin() or branch_id = public.current_branch_id())
with check (public.is_super_admin() or branch_id = public.current_branch_id());

-- Select-only: writes go through submit_product_request()/the admin RPCs
-- below, which validate branch/role/status before touching the row.
grant select on public.product_requests to authenticated;

create or replace function public.submit_product_request(p_message text, p_image_path text default null)
returns uuid
language plpgsql
security definer
set search_path = ''
as $$
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
$$;

create or replace function public.admin_list_product_requests()
returns table(
  id uuid, branch_id uuid, branch_name text, requested_by_name text,
  message text, image_path text, status text,
  resolved_product_id uuid, resolved_variant_id uuid,
  rejection_reason text, created_at timestamptz
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
      r.id, r.branch_id, b.name::text, u.full_name::text,
      r.message, r.image_path, r.status::text,
      r.resolved_product_id, r.resolved_variant_id,
      r.rejection_reason, r.created_at
    from public.product_requests r
    join public.branches b on b.id = r.branch_id
    join public.users u on u.id = r.requested_by
    order by (r.status = 'pending') desc, r.created_at desc;
end;
$$;

-- p_variants: jsonb array of {"dosage":..,"form":..,"unit":..}. The admin
-- types the real product name/type/variants/tax fresh here -- the request's
-- free-text message and photo are just their reference for what to create.
create or replace function public.admin_approve_product_request(
  p_request_id uuid, p_product_name text, p_generic_name text, p_product_type text,
  p_tax_rate_id uuid, p_variants jsonb
)
returns table(product_id uuid, variant_id uuid)
language plpgsql
security definer
set search_path = ''
as $$
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
$$;

create or replace function public.admin_reject_product_request(p_request_id uuid, p_reason text)
returns void
language plpgsql
security definer
set search_path = ''
as $$
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
$$;

-- ============================================================================
-- STORAGE — product request photos
-- ============================================================================
-- Public read (so the admin console can show the photo via a plain URL with
-- no signed-URL plumbing) but insert-only for authenticated users; nothing
-- else about this bucket is exposed since there's no update/delete/list
-- policy for anyone but the (RLS-bypassing) service role.

insert into storage.buckets (id, name, public)
values ('product-requests', 'product-requests', true)
on conflict (id) do nothing;

drop policy if exists "product request images are publicly readable" on storage.objects;
create policy "product request images are publicly readable"
on storage.objects for select
to public
using (bucket_id = 'product-requests');

drop policy if exists "authenticated users can upload product request images" on storage.objects;
create policy "authenticated users can upload product request images"
on storage.objects for insert
to authenticated
with check (bucket_id = 'product-requests');

-- ============================================================================
-- GRANTS — follow-up additions
-- ============================================================================

revoke all on function public.submit_product_request(text, text) from public;
grant execute on function public.submit_product_request(text, text) to authenticated;

revoke all on function public.admin_list_product_requests() from public;
grant execute on function public.admin_list_product_requests() to authenticated;

revoke all on function public.admin_list_categories() from public;
grant execute on function public.admin_list_categories() to authenticated;

revoke all on function public.admin_create_category(text, text, uuid) from public;
grant execute on function public.admin_create_category(text, text, uuid) to authenticated;

revoke all on function public.admin_create_tax_rate(text, numeric) from public;
grant execute on function public.admin_create_tax_rate(text, numeric) to authenticated;

-- ============================================================================
-- SALES / INSURANCE / RECEIPTS
-- ============================================================================
-- insurance_providers, insurance_product_coverage, sales, sale_items, receipts,
-- and insurance_claims all existed in the schema already but were never
-- actually reachable: RLS was enabled on every one of them with zero policies
-- and zero grants, which is a silent "always empty" state, not an error.
-- Closing that gap here, plus the one new column and the RPCs needed to
-- actually run a sale.

alter table public.insurance_providers enable row level security;
alter table public.insurance_product_coverage enable row level security;
alter table public.sales enable row level security;
alter table public.sale_items enable row level security;
alter table public.receipts enable row level security;
alter table public.insurance_claims enable row level security;

grant select on public.insurance_providers, public.insurance_product_coverage to authenticated;
grant select on public.sales, public.sale_items, public.receipts, public.insurance_claims to authenticated;
-- Deliberately no insert/update/delete grants anywhere in this block: insurance
-- providers/coverage are only ever written by the admin_* functions below
-- (each asserts super-admin internally); sales/sale_items/receipts/
-- insurance_claims are only ever written by complete_sale(), atomically, so a
-- sale can never exist without its stock decrement, receipt, and (if any)
-- insurance claim all landing together or not at all.

drop policy if exists "insurance providers readable" on public.insurance_providers;
create policy "insurance providers readable" on public.insurance_providers for select to authenticated using (true);

drop policy if exists "insurance coverage readable" on public.insurance_product_coverage;
create policy "insurance coverage readable" on public.insurance_product_coverage for select to authenticated using (true);

drop policy if exists "sales branch access" on public.sales;
create policy "sales branch access" on public.sales for select to authenticated
using (public.is_super_admin() or branch_id = public.current_branch_id());

drop policy if exists "sale items branch access" on public.sale_items;
create policy "sale items branch access" on public.sale_items for select to authenticated
using (
  public.is_super_admin()
  or exists (select 1 from public.sales s where s.id = sale_items.sale_id and s.branch_id = public.current_branch_id())
);

drop policy if exists "receipts branch access" on public.receipts;
create policy "receipts branch access" on public.receipts for select to authenticated
using (
  public.is_super_admin()
  or exists (select 1 from public.sales s where s.id = receipts.sale_id and s.branch_id = public.current_branch_id())
);

drop policy if exists "insurance claims branch access" on public.insurance_claims;
create policy "insurance claims branch access" on public.insurance_claims for select to authenticated
using (
  public.is_super_admin()
  or exists (select 1 from public.sales s where s.id = insurance_claims.sale_id and s.branch_id = public.current_branch_id())
);

-- Per-line insurance detail, requested explicitly: insurance_claims only ever
-- recorded one blended percentage/amount for a whole sale, which loses which
-- specific products insurance actually covered. This is the portion of THIS
-- line's total (subtotal + tax) that insurance paid, snapshotted at sale
-- time -- 0 for a self-pay line. insurance_claims remains the sale-level
-- summary (its coverage_percentage_applied is the blended effective rate
-- across the whole sale, its claim_amount the sum of every line's amount here).
alter table public.sale_items add column if not exists insurance_covered_amount numeric(12,2) not null default 0;
alter table public.sale_items drop constraint if exists sale_items_insurance_covered_amount_check;
alter table public.sale_items add constraint sale_items_insurance_covered_amount_check check (insurance_covered_amount >= 0);

-- ── lookup_barcode(): add product_id, tax_rate_id, and carton preview fields ──
-- Needed to check insurance_product_coverage and compute tax; complete_sale()
-- below does NOT reuse this function (it does its own row-locked, status- and
-- type-checked lookup), but the sale cart's "scan to preview" step does, so it
-- needs these fields too. create or replace cannot change a function's
-- return columns, so the old signature has to be dropped first.
--
-- child_pieces_per_pack / active_child_count populate only for cartons (null
-- for packs) so the POS can preview a "sell N packs from carton" or "sell N
-- pieces from carton" choice without a second round trip -- this is the
-- FINAL declaration of lookup_barcode in this file (everything above it is
-- superseded), so these two fields have to live here, not on the earlier,
-- narrower declaration.
drop function if exists public.lookup_barcode(text);
create function public.lookup_barcode(p_code text)
returns table(
  barcode_id uuid, code text, barcode_type text, status text,
  quantity_available integer, pieces_per_pack integer, child_count integer,
  child_pieces_per_pack integer, active_child_count integer,
  parent_code text, stock_batch_id uuid, batch_number text, expiry_date date,
  delivery_code text, selling_price numeric, product_id uuid, product_name text,
  tax_rate_id uuid, dosage text, form text, manufacturer_name text, supplier_name text
)
language sql
stable
security definer
set search_path = ''
as $$
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
    p.id,
    p.name::text,
    p.tax_rate_id,
    pv.dosage::text,
    pv.form::text,
    sb.manufacturer_name::text,
    s.supplier_name::text
  from public.barcodes bc
  join public.stock_batches sb on sb.id = bc.stock_batch_id
  join public.product_variants pv on pv.id = sb.product_variant_id
  join public.products p on p.id = pv.product_id
  left join public.barcodes parent on parent.id = bc.parent_barcode_id
  left join public.suppliers s on s.id = sb.supplier_id
  where upper(bc.code) = upper(btrim(p_code))
    and (
      public.is_super_admin()
      or sb.branch_id = public.current_branch_id()
    )
  limit 1
$$;

grant execute on function public.lookup_barcode(text) to authenticated;

-- ── Insurance admin RPCs ─────────────────────────────────────────────────

create or replace function public.admin_create_insurance_provider(
  p_name text, p_default_coverage_percentage numeric, p_contact_info text default null
)
returns uuid
language plpgsql
security definer
set search_path = ''
as $$
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
  insert into public.insurance_providers (name, default_coverage_percentage, contact_info)
  values (btrim(p_name), p_default_coverage_percentage, nullif(btrim(coalesce(p_contact_info, '')), ''))
  returning id into v_id;
  return v_id;
end;
$$;

create or replace function public.admin_update_insurance_provider(
  p_provider_id uuid, p_name text, p_default_coverage_percentage numeric, p_contact_info text default null
)
returns void
language plpgsql
security definer
set search_path = ''
as $$
begin
  perform public.assert_super_admin();
  if p_default_coverage_percentage is null or p_default_coverage_percentage < 0 or p_default_coverage_percentage > 100 then
    raise exception 'Default coverage percentage must be between 0 and 100';
  end if;
  update public.insurance_providers
  set name = btrim(p_name),
      default_coverage_percentage = p_default_coverage_percentage,
      contact_info = nullif(btrim(coalesce(p_contact_info, '')), '')
  where id = p_provider_id;
  if not found then raise exception 'Insurance provider not found'; end if;
end;
$$;

-- Sets (or changes) a per-product override. Pass 0 for "not covered at all" --
-- that is still a row here, not a special case, matching the table's own
-- "a row existing here IS the differs-from-default flag" design.
create or replace function public.admin_set_insurance_coverage(
  p_provider_id uuid, p_product_id uuid, p_coverage_percentage numeric
)
returns void
language plpgsql
security definer
set search_path = ''
as $$
begin
  perform public.assert_super_admin();
  if p_coverage_percentage is null or p_coverage_percentage < 0 or p_coverage_percentage > 100 then
    raise exception 'Coverage percentage must be between 0 and 100';
  end if;
  insert into public.insurance_product_coverage (insurance_provider_id, product_id, coverage_percentage)
  values (p_provider_id, p_product_id, p_coverage_percentage)
  on conflict (insurance_provider_id, product_id) do update set coverage_percentage = excluded.coverage_percentage;
end;
$$;

-- Removes the override, so the product reverts to the provider's default.
create or replace function public.admin_clear_insurance_coverage(p_provider_id uuid, p_product_id uuid)
returns void
language plpgsql
security definer
set search_path = ''
as $$
begin
  perform public.assert_super_admin();
  delete from public.insurance_product_coverage
  where insurance_provider_id = p_provider_id and product_id = p_product_id;
end;
$$;

revoke all on function public.admin_create_insurance_provider(text, numeric, text) from public;
grant execute on function public.admin_create_insurance_provider(text, numeric, text) to authenticated;

revoke all on function public.admin_update_insurance_provider(uuid, text, numeric, text) from public;
grant execute on function public.admin_update_insurance_provider(uuid, text, numeric, text) to authenticated;

revoke all on function public.admin_set_insurance_coverage(uuid, uuid, numeric) from public;
grant execute on function public.admin_set_insurance_coverage(uuid, uuid, numeric) to authenticated;

revoke all on function public.admin_clear_insurance_coverage(uuid, uuid) from public;
grant execute on function public.admin_clear_insurance_coverage(uuid, uuid) to authenticated;

-- ── complete_sale(): the one and only way a sale is ever created ───────────
-- One barcode code per line -- always a pack, never a carton (a carton isn't
-- a sellable unit, see Section 5 of the original design doc). Selling a pack
-- sells everything inside it at once (quantity = pieces_per_pack), since
-- quantity_available on a pack row is a 1-or-0 "does this exact physical pack
-- still exist" flag, not a piece-level counter -- consistent with how
-- receive_stock_delivery() creates these rows and how the inventory/barcode
-- dashboards already read them.
--
-- `for update of bc` row-locks each scanned barcode for the duration of the
-- transaction: without it, two cashiers scanning the same physical pack in
-- the same instant could both pass the "is it still available" check before
-- either one's update lands, selling the same physical pack twice.
-- complete_sale supports three shapes of line, chosen with sell_mode:
--   * pack   + whole  -- retire the pack (existing behaviour, sell_mode
--                       optional for legacy callers)
--   * pack   + pieces -- sell N loose pieces from the pack (partial sale)
--   * carton + whole  -- sell every remaining child pack in one shot
--   * carton + packs  -- sell N of the carton's active child packs (prefers
--                       untouched full packs)
--   * carton + pieces -- open one child pack and sell N pieces (prefers a
--                       pack that was already opened)
--
-- Adding p_patient_id changes this function's parameter signature (jsonb,uuid)
-- -> (jsonb,uuid,uuid) -- a different overload identity to Postgres even
-- though the new param has a default, so `create or replace` alone would
-- leave the OLD 2-arg version installed alongside this one instead of
-- replacing it, and PostgREST would then refuse ambiguous overload calls.
-- Dropped first so only one complete_sale() ever exists.
drop function if exists public.complete_sale(jsonb, uuid);
create or replace function public.complete_sale(p_lines jsonb, p_insurance_provider_id uuid default null, p_patient_id uuid default null)
returns table(
  sale_id uuid, receipt_number text, total_amount numeric,
  insurance_covered_total numeric, patient_owed_total numeric
)
language plpgsql
security definer
set search_path = ''
as $$
#variable_conflict use_column
declare
  v_branch uuid;
  v_user uuid := (select auth.uid());
  v_sale uuid := gen_random_uuid();
  v_receipt_number text;
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
begin
  select u.branch_id into v_branch from public.users u where u.id = v_user and u.is_active;
  if v_branch is null then
    raise exception 'Only an active branch user may complete a sale';
  end if;
  if exists (select 1 from public.branches b where b.id = v_branch and b.status <> 'active') then
    raise exception 'This pharmacy is not active';
  end if;
  if jsonb_typeof(p_lines) <> 'array' or jsonb_array_length(p_lines) = 0 then
    raise exception 'At least one item is required to complete a sale';
  end if;

  if p_insurance_provider_id is not null then
    select name into v_provider_name from public.insurance_providers where id = p_insurance_provider_id;
    if v_provider_name is null then raise exception 'Unknown insurance provider'; end if;
  end if;

  -- Optional: a walk-in cash sale is legitimate and stays unlinked. Validated
  -- against this branch when given so one branch can never attach a sale to
  -- another branch's patient record.
  if p_patient_id is not null and not exists (
    select 1 from public.patients where id = p_patient_id and branch_id = v_branch
  ) then
    raise exception 'Unknown patient for this branch';
  end if;

  v_receipt_number := format('RCT-%s-%s', to_char(now(), 'YYYYMMDD'), upper(substr(replace(gen_random_uuid()::text,'-',''),1,6)));

  insert into public.sales (id, branch_id, cashier_id, patient_id, total_amount)
  values (v_sale, v_branch, v_user, p_patient_id, 0); -- patched below once the real total is known

  for line in select * from jsonb_array_elements(p_lines) loop
    v_code := upper(btrim(coalesce(line->>'code', '')));
    if v_code = '' then raise exception 'Each line needs a barcode code'; end if;
    if v_code = any(v_seen_codes) then
      raise exception 'Barcode % was scanned twice in the same sale', v_code;
    end if;
    v_seen_codes := array_append(v_seen_codes, v_code);

    select bc.*, sb.selling_price, sb.product_variant_id
      into v_barcode
      from public.barcodes bc
      join public.stock_batches sb on sb.id = bc.stock_batch_id
      where upper(bc.code) = v_code and sb.branch_id = v_branch
      for update of bc;

    if not found then
      raise exception 'Barcode % was not found for this branch', v_code;
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

      -- VAT-inclusive: selling_price is what the customer actually pays, so
      -- line_total comes straight from it and tax_amount is *extracted* from
      -- that gross figure rather than added on top of a pre-tax base.
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

  update public.sales set total_amount = v_total where id = v_sale;

  insert into public.receipts (sale_id, receipt_number) values (v_sale, v_receipt_number);

  if p_insurance_provider_id is not null and v_covered_total > 0 then
    insert into public.insurance_claims (sale_id, insurance_provider_id, coverage_percentage_applied, claim_amount)
    values (
      v_sale, p_insurance_provider_id,
      round(v_covered_total / nullif(v_total, 0) * 100, 2),
      v_covered_total
    );
  end if;

  return query select v_sale, v_receipt_number, v_total, v_covered_total, v_total - v_covered_total;
end;
$$;

revoke all on function public.complete_sale(jsonb, uuid, uuid) from public, anon;
grant execute on function public.complete_sale(jsonb, uuid, uuid) to authenticated;

-- ============================================================================
-- RECURRING OUT-OF-STOCK ALERTS
-- ============================================================================
-- Nothing in the app has ever alerted on stock levels -- notifications only
-- ever recorded batch_recall/stock_adjustment/product_request events, each a
-- one-off. This adds a genuinely different kind: one that keeps coming back
-- on its own for as long as the underlying problem (a medicine sitting at
-- zero available stock) is real, instead of firing once and being gone the
-- moment someone dismisses it.

alter table public.notifications drop constraint if exists notifications_source_type_check;
alter table public.notifications add constraint notifications_source_type_check
  check (source_type in ('batch_recall','stock_adjustment','product_request_approved','product_request_rejected','out_of_stock'));

-- Re-fires an unread reminder for every product variant currently at zero
-- available stock for the caller's branch, on a 6-hour cadence (the user's
-- own choice -- "treat out-of-stock as urgent, hard to ignore"; change
-- v_interval below to retune it). Zero stock is computed the way the live
-- inventory dashboard does (sum of quantity_available * pieces_per_pack
-- across 'pack'-type barcodes only -- a 'box' row's quantity_available just
-- means "does this carton still exist", never a piece count) but aggregated
-- across ALL of a variant's batches at this branch, not per single batch: a
-- depleted old lot sitting next to a freshly-received one of the SAME
-- medicine is not actually out of stock, and a per-batch check would wrongly
-- say it is.
--
-- source_id is the product_variant_id, not the product_id -- two dosages of
-- the same product are two independently stockable items and need
-- independent alerts. Safe to call on every poll: a variant with an already-
-- unread reminder is left alone (never duplicated); a read one only gets a
-- fresh row once the interval has actually elapsed; a variant back in stock
-- is simply skipped, same as any row that was never a problem.
create or replace function public.check_out_of_stock_alerts()
returns integer
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_branch uuid := public.current_branch_id();
  v_interval interval := interval '6 hours';
  v_created integer := 0;
  rec record;
  v_last record;
begin
  if v_branch is null then
    return 0;
  end if;

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

    -- `found` is checked in its own branch, never combined into one boolean
    -- expression with a field read off v_last: PostgreSQL doesn't guarantee
    -- short-circuit order in AND/OR, so `not found or v_last.is_read` could
    -- evaluate the right-hand side even when v_last was never assigned,
    -- raising "record is not assigned yet" on the very first-ever alert.
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
$$;

revoke all on function public.check_out_of_stock_alerts() from public;
grant execute on function public.check_out_of_stock_alerts() to authenticated;

-- ============================================================================
-- STOCK ADJUSTMENTS
-- ============================================================================
-- public.stock_adjustments already existed (adjustment_type, stock_batch_id /
-- barcode_id, quantity, reason, performed_by) but nothing ever wrote to it --
-- the only UI trace was a dead, disconnected button in an unrouted legacy
-- page. This adds the real read/write path: a branch manager or owner writes
-- off damaged, lost, expired, recalled, or supplier-returned stock, or
-- corrects a recount that found more or fewer pieces than the system shows.

-- Removing stock (damage/loss/return/expired_writeoff/recalled, or a negative
-- correction) consumes whole packs first, oldest first, and for whatever
-- remainder doesn't fill a whole pack, shrinks ONE pack's own
-- pieces_per_pack down instead -- e.g. "3 of the 10 tablets in this opened
-- pack were damaged" leaves that same pack row active with
-- pieces_per_pack = 7, rather than forcing every adjustment to consume in
-- whole-pack multiples. Only 'active' packs with stock left are eligible,
-- the same eligibility complete_sale() already enforces when selling one --
-- `for update` row-locks them for the same double-booking reason complete_sale()
-- documents at its own barcode lookup.
--
-- Adding stock (a positive correction only -- a recount found MORE pieces
-- than recorded) inserts one new synthetic pack barcode, the same insert
-- shape receive_stock_delivery() already uses when receiving real stock, so
-- every place that already sums quantity_available * pieces_per_pack across
-- pack barcodes (loadInventoryDataset(), loadBarcodeDataset()) picks the
-- correction up with no new derived-quantity logic anywhere else.
create or replace function public.adjust_stock(p_stock_batch_id uuid, p_adjustment_type text, p_delta integer, p_reason text)
returns uuid
language plpgsql
security definer
set search_path = ''
as $$
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
$$;

revoke all on function public.adjust_stock(uuid, text, integer, text) from public, anon;
grant execute on function public.adjust_stock(uuid, text, integer, text) to authenticated;

-- Branch-scoped audit trail for the Stock Adjustment page's "Recent
-- adjustments" panel -- newest first, joined back to the product/variant/
-- batch it targeted and the staff member who made it.
create or replace function public.list_stock_adjustments()
returns table(
  id uuid, adjustment_type text, quantity integer, reason text, adjusted_at timestamptz,
  product_name text, dosage text, batch_number text, performed_by_name text
)
language sql
stable
security definer
set search_path = ''
as $$
  select
    sa.id, sa.adjustment_type, sa.quantity, sa.reason, sa.adjusted_at,
    p.name, pv.dosage, sb.batch_number, u.full_name
  from public.stock_adjustments sa
  join public.stock_batches sb on sb.id = sa.stock_batch_id
  join public.product_variants pv on pv.id = sb.product_variant_id
  join public.products p on p.id = pv.product_id
  left join public.users u on u.id = sa.performed_by
  where sb.branch_id = public.current_branch_id()
  order by sa.adjusted_at desc
  limit 200
$$;

revoke all on function public.list_stock_adjustments() from public, anon;
grant execute on function public.list_stock_adjustments() to authenticated;

-- ============================================================================
-- PATIENTS
-- ============================================================================
-- A sale has never carried who it was for -- just barcodes and a total. This
-- adds a real patient record, branch-owned like suppliers/categories, keyed
-- so the same person can be found again by phone or TIN on their next visit
-- without re-typing everything: unique(branch_id, tin_or_phone) is what makes
-- that lookup exact and dedupe-safe, and what upsert_patient() below conflicts
-- on to update rather than duplicate an existing patient.

create table if not exists public.patients (
  id uuid primary key default gen_random_uuid(),
  branch_id uuid not null references public.branches(id),
  full_name varchar(150) not null,
  gender varchar(10) check (gender is null or gender in ('male','female','other')),
  age integer check (age is null or (age >= 0 and age <= 130)),
  tin_or_phone varchar(50) not null,
  created_by uuid references public.users(id),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique(branch_id, tin_or_phone)
);

alter table public.patients enable row level security;
drop policy if exists "branch access" on public.patients;
create policy "branch access" on public.patients
for all to authenticated
using (public.is_super_admin() or branch_id = public.current_branch_id())
with check (public.is_super_admin() or branch_id = public.current_branch_id());

grant select, insert, update on public.patients to authenticated;

-- Optional link from a sale to the patient it was for -- nullable, a walk-in
-- cash sale with no name given is still a legitimate sale.
alter table public.sales add column if not exists patient_id uuid references public.patients(id);

-- Deleting a patient forces a sequential scan of sales per deleted row to
-- check this new FK otherwise -- see the sale_items.barcode_id index earlier
-- in this file for the same reasoning. Must come after the column above.
create index if not exists idx_sales_patient on public.sales(patient_id);

-- The pharmacy's own tax ID, shown on every printed invoice from here on.
alter table public.branches add column if not exists tin varchar(20);

-- Dropped first, unconditionally: the 2026-09-07_patient_and_insurer_tin.sql
-- migration widens this function (adds phone/tin to its returned columns),
-- and `create or replace` cannot narrow an OUT-parameter row shape back to
-- this one -- only DROP can. Without this, re-running this file against a
-- database that has had that migration applied fails with "cannot change
-- return type of existing function". Same guard already used for
-- lookup_barcode()/admin_list_product_requests()/get_my_branch_details()
-- above. Re-apply the dated migrations after this file, as always.
drop function if exists public.find_patient_by_identifier(text);

create or replace function public.find_patient_by_identifier(p_identifier text)
returns table(id uuid, full_name text, gender text, age integer, tin_or_phone text)
language sql
stable
security definer
set search_path = ''
as $$
  select p.id, p.full_name::text, p.gender::text, p.age, p.tin_or_phone::text
  from public.patients p
  where p.branch_id = public.current_branch_id()
    and p.tin_or_phone = btrim(p_identifier)
  limit 1
$$;

-- Insert-or-update on the (branch_id, tin_or_phone) unique key -- this is the
-- "found them, just change what's different" edit path from the sales
-- screen, not a separate create-vs-edit flow. created_by is only ever set on
-- the initial insert (left out of the do-update clause) so the original
-- registrar is preserved even if a later visit edits their details.
create or replace function public.upsert_patient(p_full_name text, p_gender text, p_age integer, p_tin_or_phone text)
returns uuid
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_user uuid := (select auth.uid());
  v_branch uuid;
  v_id uuid;
begin
  select u.branch_id into v_branch from public.users u where u.id = v_user and u.is_active;
  if v_branch is null then raise exception 'Only an active branch user may record a patient'; end if;
  if nullif(btrim(coalesce(p_full_name, '')), '') is null then raise exception 'A patient name is required'; end if;
  if nullif(btrim(coalesce(p_tin_or_phone, '')), '') is null then raise exception 'A phone number or TIN is required'; end if;
  if p_gender is not null and p_gender not in ('male','female','other') then raise exception 'Unknown gender'; end if;

  insert into public.patients (branch_id, full_name, gender, age, tin_or_phone, created_by)
  values (v_branch, btrim(p_full_name), p_gender, p_age, btrim(p_tin_or_phone), v_user)
  on conflict (branch_id, tin_or_phone)
  do update set full_name = excluded.full_name, gender = excluded.gender, age = excluded.age, updated_at = now()
  returning id into v_id;

  return v_id;
end;
$$;

-- Branch-scoped roster for the Patients page: each patient plus their most
-- recent visit and lifetime spend, computed from sales rather than stored
-- redundantly so it can never drift from the real sale history.
-- Dropped first for the same reason as find_patient_by_identifier() above.
drop function if exists public.list_branch_patients();

create or replace function public.list_branch_patients()
returns table(id uuid, full_name text, gender text, age integer, tin_or_phone text, visit_count integer, last_visit_at timestamptz, lifetime_spend numeric)
language sql
stable
security definer
set search_path = ''
as $$
  select
    p.id, p.full_name::text, p.gender::text, p.age, p.tin_or_phone::text,
    count(s.id)::integer, max(s.sold_at), coalesce(sum(s.total_amount), 0)
  from public.patients p
  left join public.sales s on s.patient_id = p.id
  where p.branch_id = public.current_branch_id()
  group by p.id, p.full_name, p.gender, p.age, p.tin_or_phone
  order by max(s.sold_at) desc nulls last, p.full_name
$$;

revoke all on function public.find_patient_by_identifier(text) from public, anon;
grant execute on function public.find_patient_by_identifier(text) to authenticated;

revoke all on function public.upsert_patient(text, text, integer, text) from public, anon;
grant execute on function public.upsert_patient(text, text, integer, text) to authenticated;

revoke all on function public.list_branch_patients() from public, anon;
grant execute on function public.list_branch_patients() to authenticated;

-- ============================================================================
-- SELLER ROLE
-- ============================================================================
-- A second real role: a branch's owner/manager can now create a limited
-- "seller" login (Sales + Patients + Help only in the UI, and enforced
-- server-side on every RPC that mutates something a seller should not
-- touch). The actual auth.users row + matching public.users row are created
-- by supabase/functions/create-branch-seller (a Supabase Edge Function) --
-- that part needs the service-role Admin API to set a real password for
-- someone else, which a plain RPC running as the calling user can never do.

alter table public.users drop constraint if exists users_role_check;
alter table public.users add constraint users_role_check
  check (role in ('owner','manager','pharmacist','staff','seller'));

-- users has never had an UPDATE policy (only the SELECT-only "users read own
-- branch" one) -- a small security-definer RPC here is safer than adding a
-- broad UPDATE policy that could let a manager edit a role, or a row outside
-- their own branch, that this narrow RPC deliberately can't touch.
create or replace function public.admin_set_seller_active(p_user_id uuid, p_is_active boolean)
returns void
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_caller uuid := (select auth.uid());
  v_branch uuid;
begin
  select u.branch_id into v_branch
  from public.users u
  where u.id = v_caller and u.is_active and u.role in ('owner','manager');
  if v_branch is null then raise exception 'Only an active branch manager or owner may manage staff'; end if;

  update public.users
  set is_active = p_is_active
  where id = p_user_id and branch_id = v_branch and role = 'seller';
  if not found then raise exception 'Seller not found for this branch'; end if;
end;
$$;

revoke all on function public.admin_set_seller_active(uuid, boolean) from public, anon;
grant execute on function public.admin_set_seller_active(uuid, boolean) to authenticated;

-- Per-seller "what did they do today" rollup for the Team page -- a live
-- summary rather than a notification fired on every single sale, which would
-- bury a busy manager in noise. patients_registered_today is attributed by
-- created_by, not just branch + today's date, so it is a per-seller count
-- and not the same branch-wide total repeated on every row.
create or replace function public.list_seller_activity_today()
returns table(user_id uuid, full_name text, sales_count integer, revenue_today numeric, patients_registered_today integer)
language plpgsql
stable
security definer
set search_path = ''
as $$
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
$$;

revoke all on function public.list_seller_activity_today() from public, anon;
grant execute on function public.list_seller_activity_today() to authenticated;

-- ============================================================================
-- BRANCH SETTINGS — owner-editable pharmacy identity, shown on every invoice
-- ============================================================================
-- public.branches only ever had a SELECT policy (see "branch access" in the
-- RLS section near the top of this file) -- nothing has ever let a branch
-- update its own row. The TIN/address/phone this RPC sets are exactly what
-- ReceiptView now prints on every invoice, so without this the new fields
-- on the receipt would just stay permanently blank.

-- Full pharmacy profile: logo (printed at the top of every invoice, replacing
-- the plain text header) and payment-collection details (bank account, momo
-- pay) that a real Rwandan invoice carries alongside TIN/address/phone.
alter table public.branches
  add column if not exists logo_path text,
  add column if not exists bank_account_number varchar(50),
  add column if not exists bank_account_name varchar(150),
  add column if not exists momo_pay_number varchar(50);

-- Dropped first: adding four new params changes this function's argument
-- signature ((text,text,text) -> (text,text,text,text,text,text,text)), a
-- different overload identity to Postgres, so a plain `create or replace`
-- would leave the old 3-arg version installed alongside this one.
drop function if exists public.update_branch_details(text, text, text);
create or replace function public.update_branch_details(
  p_address text, p_phone text, p_tin text, p_logo_path text default null,
  p_bank_account_number text default null, p_bank_account_name text default null, p_momo_pay_number text default null
)
returns void
language plpgsql
security definer
set search_path = ''
as $$
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
$$;

revoke all on function public.update_branch_details(text, text, text, text, text, text, text) from public, anon;
grant execute on function public.update_branch_details(text, text, text, text, text, text, text) to authenticated;

-- Dropped first: the return shape grew (name,address,phone,tin) -> (+logo_path,
-- +bank_account_number,+bank_account_name,+momo_pay_number) -- a zero-arg
-- function has no signature to overload on, so without this drop the
-- create-or-replace just below would fail immediately on a single top-to-
-- bottom run of this file, the same "cannot change return type" error as
-- lookup_barcode()/admin_list_product_requests() above, just triggered
-- within one run instead of across a re-run.
drop function if exists public.get_my_branch_details();
create or replace function public.get_my_branch_details()
returns table(name text, address text, phone text, tin text, logo_path text, bank_account_number text, bank_account_name text, momo_pay_number text)
language sql
stable
security definer
set search_path = ''
as $$
  select b.name::text, b.address, b.phone, b.tin, b.logo_path, b.bank_account_number, b.bank_account_name, b.momo_pay_number
  from public.branches b
  where b.id = public.current_branch_id()
$$;

revoke all on function public.get_my_branch_details() from public, anon;
grant execute on function public.get_my_branch_details() to authenticated;

-- ── Storage — pharmacy logo ─────────────────────────────────────────────
-- Same public-read/authenticated-insert shape as the product-request photos
-- bucket, plus UPDATE: a branch replaces its logo over time (product-request
-- photos never get overwritten in place, but a logo naturally does), so
-- authenticated users can also update objects they've already inserted here.

insert into storage.buckets (id, name, public)
values ('branch-logos', 'branch-logos', true)
on conflict (id) do nothing;

drop policy if exists "branch logos are publicly readable" on storage.objects;
create policy "branch logos are publicly readable"
on storage.objects for select
to public
using (bucket_id = 'branch-logos');

drop policy if exists "authenticated users can upload branch logos" on storage.objects;
create policy "authenticated users can upload branch logos"
on storage.objects for insert
to authenticated
with check (bucket_id = 'branch-logos');

drop policy if exists "authenticated users can replace branch logos" on storage.objects;
create policy "authenticated users can replace branch logos"
on storage.objects for update
to authenticated
using (bucket_id = 'branch-logos')
with check (bucket_id = 'branch-logos');

-- ============================================================================
-- FIX — relax "one user per branch" now that a branch legitimately has more
-- than one login (owner + any number of sellers, and managers in future).
-- ============================================================================
-- users_one_per_branch (declared near the top of this file, in the ONBOARDING
-- section) was correct back when a branch had exactly one login -- the owner
-- created by activate_pharmacy_account(). Once the seller role and
-- create-branch-seller shipped, every second insert with the same branch_id
-- (i.e. every seller after the owner) started failing with "duplicate key
-- value violates unique constraint users_one_per_branch", which is exactly
-- the bug this block fixes. The one-owner-per-branch invariant is still
-- worth keeping (activate_pharmacy_account() already enforces it in
-- application logic too), so it is narrowed to a partial index on
-- role = 'owner' rather than removed outright -- sellers/managers are free
-- to be as many as the branch creates.

drop index if exists public.users_one_per_branch;

create unique index if not exists users_one_owner_per_branch
  on public.users (branch_id)
  where role = 'owner';

-- Note: an earlier revision of this file had a "FIX — sell a partial
-- quantity from a pack" block here, redeclaring complete_sale() a third
-- time to support selling fewer pieces than a full pack. That capability is
-- now folded into the single, earlier complete_sale() declaration in the
-- "SALES / INSURANCE / RECEIPTS" section above (its sell_mode = 'pieces'
-- case, merged alongside a collaborator's carton-sale support), so this
-- redundant, pack-only, carton-unaware redeclaration was removed rather
-- than left here to silently overwrite the more capable version below it.

-- ============================================================================
-- EXPIRED STOCK — automatic write-off + a hard sell-time gate
-- ============================================================================
-- Two separate mechanisms, both needed:
--  1. check_expired_stock() below actively finds anything past its expiry
--     date and still marked 'active', writes a real stock_adjustments row
--     (adjustment_type 'expired_writeoff', same table/shape adjust_stock()
--     already uses for a manual write-off) and a notification, and flips the
--     barcode to 'expired' -- so it shows up on its own, even if nobody ever
--     tries to scan it.
--  2. complete_sale() (re-declared below, same signature, no drop needed)
--     gets a direct expiry_date check right after it locks the scanned
--     barcode's row -- independent of #1 and independent of whatever the
--     barcode's stored `status` currently says. This is the actual "deny the
--     sale" guarantee: even in the few minutes/hours before #1's next poll
--     has caught a freshly-expired item, a sale of it is still rejected,
--     because the check is against the real date, not a flag that might be
--     stale. A carton and every pack inside it share one stock_batches row
--     (and therefore one expiry_date), so this single check at the top --
--     before branching into pack/box-specific logic -- already covers every
--     sell_mode (whole pack, partial pieces, whole carton, N packs from a
--     carton, N loose pieces from a carton) without repeating it per branch.

alter table public.branches
  add column if not exists out_of_stock_reminder_hours integer not null default 6 check (out_of_stock_reminder_hours between 1 and 168);

create or replace function public.check_out_of_stock_alerts()
returns integer
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_branch uuid := public.current_branch_id();
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
$$;

-- Finds every barcode at this branch that is still 'active' but whose
-- batch's expiry_date has already passed, and writes it off: one
-- stock_adjustments row per barcode (adjustment_type = 'expired_writeoff',
-- quantity = the real remaining piece count for a pack, matching
-- adjust_stock()'s own positive-magnitude convention -- direction is
-- conveyed by adjustment_type, not sign), a notification (reusing the
-- existing 'stock_adjustment' source type rather than inventing a new one),
-- and flips status to 'expired'. A carton and its child packs share the
-- same stock_batches row, so both the carton barcode and each child pack
-- barcode are found and written off independently in the same pass -- no
-- special-casing needed for barcode_type. One-shot per barcode, not
-- recurring like check_out_of_stock_alerts(): once status is 'expired' it
-- can never match this query's `status = 'active'` filter again, so there is
-- nothing to re-remind about -- the write-off itself is the resolution.
-- Callable by any active branch user (unlike adjust_stock(), which is
-- owner/manager only for a human's discretionary call) since this has no
-- discretion in it: a batch is either past its expiry_date or it isn't.
create or replace function public.check_expired_stock()
returns integer
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_branch uuid := public.current_branch_id();
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
$$;

revoke all on function public.check_expired_stock() from public;
grant execute on function public.check_expired_stock() to authenticated;

-- complete_sale(), re-declared with the same 3-argument signature and the
-- same RETURNS TABLE shape (no drop needed): identical to the version above
-- except for the expiry guard added right after the barcode is locked, and
-- `sb.expiry_date` added to the initial select so it's available to check.
create or replace function public.complete_sale(p_lines jsonb, p_insurance_provider_id uuid default null, p_patient_id uuid default null)
returns table(
  sale_id uuid, receipt_number text, total_amount numeric,
  insurance_covered_total numeric, patient_owed_total numeric
)
language plpgsql
security definer
set search_path = ''
as $$
#variable_conflict use_column
declare
  v_branch uuid;
  v_user uuid := (select auth.uid());
  v_sale uuid := gen_random_uuid();
  v_receipt_number text;
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
begin
  select u.branch_id into v_branch from public.users u where u.id = v_user and u.is_active;
  if v_branch is null then
    raise exception 'Only an active branch user may complete a sale';
  end if;
  if exists (select 1 from public.branches b where b.id = v_branch and b.status <> 'active') then
    raise exception 'This pharmacy is not active';
  end if;
  if jsonb_typeof(p_lines) <> 'array' or jsonb_array_length(p_lines) = 0 then
    raise exception 'At least one item is required to complete a sale';
  end if;

  if p_insurance_provider_id is not null then
    select name into v_provider_name from public.insurance_providers where id = p_insurance_provider_id;
    if v_provider_name is null then raise exception 'Unknown insurance provider'; end if;
  end if;

  if p_patient_id is not null and not exists (
    select 1 from public.patients where id = p_patient_id and branch_id = v_branch
  ) then
    raise exception 'Unknown patient for this branch';
  end if;

  v_receipt_number := format('RCT-%s-%s', to_char(now(), 'YYYYMMDD'), upper(substr(replace(gen_random_uuid()::text,'-',''),1,6)));

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
    -- Checked against the batch's real expiry_date, not the barcode's stored
    -- `status` -- catches an item that expired since the last periodic
    -- check_expired_stock() sweep, so a sale can never slip through in that
    -- window. A carton and every child pack under it share this same
    -- expiry_date, so this one check covers every sell_mode below.
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

      -- VAT-inclusive: selling_price is what the customer actually pays, so
      -- line_total comes straight from it and tax_amount is *extracted* from
      -- that gross figure rather than added on top of a pre-tax base.
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

  update public.sales set total_amount = v_total where id = v_sale;

  insert into public.receipts (sale_id, receipt_number) values (v_sale, v_receipt_number);

  if p_insurance_provider_id is not null and v_covered_total > 0 then
    insert into public.insurance_claims (sale_id, insurance_provider_id, coverage_percentage_applied, claim_amount)
    values (
      v_sale, p_insurance_provider_id,
      round(v_covered_total / nullif(v_total, 0) * 100, 2),
      v_covered_total
    );
  end if;

  return query select v_sale, v_receipt_number, v_total, v_covered_total, v_total - v_covered_total;
end;
$$;

-- ============================================================================
-- BRANCH SETTINGS — out-of-stock reminder cadence + read-only profile fields
-- ============================================================================
-- Both dropped first: update_branch_details gains a new parameter, and
-- get_my_branch_details gains new return columns -- the same "different
-- overload identity" / "cannot change return type" reasons documented above
-- update_branch_details's first declaration.

-- Branch Profile redesign: identity fields (name, email were previously
-- admin/onboarding-only; website is new), legal/licensing fields RRA
-- compliance actually needs (license number + expiry, EBM device serial --
-- recorded for when the VSDC/e-invoicing integration goes live, not used by
-- receipts yet, same honesty as the Overview page's "RRA/VSDC -- Not
-- configured" tile), and a branch-wide default UI language (a fallback for a
-- viewer who hasn't picked their own in lib/i18n's detectDefaultLang() --
-- personal choice still wins, same relationship the theme picker has to any
-- future branch-level theme default).
alter table public.branches
  add column if not exists website varchar(150),
  add column if not exists license_number varchar(50),
  add column if not exists license_expiry_date date,
  add column if not exists ebm_device_serial varchar(50),
  add column if not exists default_language varchar(5) not null default 'en' check (default_language in ('en','fr','rw'));

drop function if exists public.update_branch_details(text, text, text, text, text, text, text, integer);
create or replace function public.update_branch_details(
  p_address text, p_phone text, p_tin text, p_logo_path text default null,
  p_bank_account_number text default null, p_bank_account_name text default null, p_momo_pay_number text default null,
  p_out_of_stock_reminder_hours integer default null,
  p_name text default null, p_email text default null, p_website text default null,
  p_license_number text default null, p_license_expiry_date date default null, p_ebm_device_serial text default null,
  p_default_language text default null
)
returns void
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_branch uuid;
begin
  select u.branch_id into v_branch
  from public.users u
  where u.id = (select auth.uid()) and u.is_active and u.role = 'owner';
  if v_branch is null then raise exception 'Only the branch owner may update branch settings'; end if;

  if p_out_of_stock_reminder_hours is not null and (p_out_of_stock_reminder_hours < 1 or p_out_of_stock_reminder_hours > 168) then
    raise exception 'Reminder interval must be between 1 and 168 hours';
  end if;
  if p_default_language is not null and p_default_language not in ('en','fr','rw') then
    raise exception 'Unsupported language %', p_default_language;
  end if;

  update public.branches
  set address = nullif(btrim(coalesce(p_address, '')), ''),
      phone = nullif(btrim(coalesce(p_phone, '')), ''),
      tin = nullif(btrim(coalesce(p_tin, '')), ''),
      logo_path = nullif(btrim(coalesce(p_logo_path, '')), ''),
      bank_account_number = nullif(btrim(coalesce(p_bank_account_number, '')), ''),
      bank_account_name = nullif(btrim(coalesce(p_bank_account_name, '')), ''),
      momo_pay_number = nullif(btrim(coalesce(p_momo_pay_number, '')), ''),
      out_of_stock_reminder_hours = coalesce(p_out_of_stock_reminder_hours, out_of_stock_reminder_hours),
      -- name is not nullable, so a blank/omitted value leaves it unchanged
      -- rather than nulling it out the way the optional fields above do.
      name = coalesce(nullif(btrim(coalesce(p_name, '')), ''), name),
      email = nullif(btrim(coalesce(p_email, '')), ''),
      website = nullif(btrim(coalesce(p_website, '')), ''),
      license_number = nullif(btrim(coalesce(p_license_number, '')), ''),
      license_expiry_date = p_license_expiry_date,
      ebm_device_serial = nullif(btrim(coalesce(p_ebm_device_serial, '')), ''),
      default_language = coalesce(p_default_language, default_language)
  where id = v_branch;
end;
$$;

revoke all on function public.update_branch_details(text, text, text, text, text, text, text, integer, text, text, text, text, date, text, text) from public, anon;
grant execute on function public.update_branch_details(text, text, text, text, text, text, text, integer, text, text, text, text, date, text, text) to authenticated;

drop function if exists public.get_my_branch_details();
create or replace function public.get_my_branch_details()
returns table(
  name text, address text, phone text, tin text, logo_path text, bank_account_number text, bank_account_name text, momo_pay_number text,
  out_of_stock_reminder_hours integer, branch_code text, status text, created_at timestamptz,
  email text, website text, license_number text, license_expiry_date date, ebm_device_serial text, default_language text
)
language sql
stable
security definer
set search_path = ''
as $$
  select b.name::text, b.address, b.phone, b.tin, b.logo_path, b.bank_account_number, b.bank_account_name, b.momo_pay_number,
         b.out_of_stock_reminder_hours, b.branch_code::text, b.status::text, b.created_at,
         b.email, b.website, b.license_number, b.license_expiry_date, b.ebm_device_serial, b.default_language::text
  from public.branches b
  where b.id = public.current_branch_id()
$$;

revoke all on function public.get_my_branch_details() from public, anon;
grant execute on function public.get_my_branch_details() to authenticated;

-- Widen the notifications source_type list once more for the license-expiry
-- reminder below -- same incremental-ALTER pattern already used to add
-- out_of_stock and the product-request outcomes.
alter table public.notifications drop constraint if exists notifications_source_type_check;
alter table public.notifications add constraint notifications_source_type_check
  check (source_type in ('batch_recall','stock_adjustment','product_request_approved','product_request_rejected','out_of_stock','license_expiring'));

-- Same recurring/idempotent shape as check_out_of_stock_alerts(), just a
-- single branch-level date instead of a per-product loop: fires once when
-- license_expiry_date first comes within 90 days (or is already past), then
-- re-fires at most once a day for as long as it stays read and still within
-- that window -- so it keeps surfacing as the deadline (or lateness) grows,
-- without nagging on every single poll.
create or replace function public.check_license_expiry()
returns integer
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_branch uuid := public.current_branch_id();
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
$$;

revoke all on function public.check_license_expiry() from public, anon;
grant execute on function public.check_license_expiry() to authenticated;

-- ============================================================================
-- BRANCH SETTINGS — POS & Sales tab (Branch Settings)
-- ============================================================================
-- Real branch-level POS behavior, not decorative toggles: complete_sale()
-- below actually reads payment_method/discount_id and the client actually
-- gates what it shows at checkout on these columns. Two reference-design
-- rules were deliberately left out rather than half-built or faked:
--   Require Prescription for Rx Drugs -- there is no per-product
--     "prescription only" flag anywhere in this schema, and adding one plus
--     the product-editing UI to set it is a materially bigger feature than a
--     branch setting.
--   Allow Refunds/Returns (from POS) + Refund Window -- stock_adjustments
--     already supports adjustment_type 'return', but only through the
--     general stock-adjustment tool; there is no "look up a past sale and
--     reverse it from the POS screen" flow anywhere to gate. Also dropped:
--     Require PIN to Open POS -- this app's only auth is the seller's own
--     Supabase Auth login; a separate PIN-per-shift concept doesn't exist.
alter table public.branches
  add column if not exists receipt_number_prefix varchar(10) not null default 'RCT',
  add column if not exists pos_cash_enabled boolean not null default true,
  add column if not exists pos_mtn_momo_enabled boolean not null default true,
  add column if not exists pos_airtel_money_enabled boolean not null default true,
  add column if not exists pos_card_enabled boolean not null default false,
  add column if not exists pos_insurance_enabled boolean not null default true,
  add column if not exists pos_default_payment_method varchar(20) not null default 'cash'
    check (pos_default_payment_method in ('cash','mtn_momo','airtel_money','card')),
  add column if not exists pos_require_patient_name boolean not null default false,
  add column if not exists pos_allow_discounts boolean not null default true,
  add column if not exists pos_show_patient_history boolean not null default true;

alter table public.sales
  add column if not exists payment_method varchar(20)
    check (payment_method is null or payment_method in ('cash','mtn_momo','airtel_money','card'));

drop function if exists public.update_branch_details(text, text, text, text, text, text, text, integer, text, text, text, text, date, text, text);
create or replace function public.update_branch_details(
  p_address text, p_phone text, p_tin text, p_logo_path text default null,
  p_bank_account_number text default null, p_bank_account_name text default null, p_momo_pay_number text default null,
  p_out_of_stock_reminder_hours integer default null,
  p_name text default null, p_email text default null, p_website text default null,
  p_license_number text default null, p_license_expiry_date date default null, p_ebm_device_serial text default null,
  p_default_language text default null,
  p_receipt_number_prefix text default null,
  p_pos_cash_enabled boolean default null, p_pos_mtn_momo_enabled boolean default null,
  p_pos_airtel_money_enabled boolean default null, p_pos_card_enabled boolean default null, p_pos_insurance_enabled boolean default null,
  p_pos_default_payment_method text default null,
  p_pos_require_patient_name boolean default null, p_pos_allow_discounts boolean default null, p_pos_show_patient_history boolean default null
)
returns void
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_branch uuid;
begin
  select u.branch_id into v_branch
  from public.users u
  where u.id = (select auth.uid()) and u.is_active and u.role = 'owner';
  if v_branch is null then raise exception 'Only the branch owner may update branch settings'; end if;

  if p_out_of_stock_reminder_hours is not null and (p_out_of_stock_reminder_hours < 1 or p_out_of_stock_reminder_hours > 168) then
    raise exception 'Reminder interval must be between 1 and 168 hours';
  end if;
  if p_default_language is not null and p_default_language not in ('en','fr','rw') then
    raise exception 'Unsupported language %', p_default_language;
  end if;
  if p_pos_default_payment_method is not null and p_pos_default_payment_method not in ('cash','mtn_momo','airtel_money','card') then
    raise exception 'Unsupported default payment method %', p_pos_default_payment_method;
  end if;

  update public.branches
  set address = nullif(btrim(coalesce(p_address, '')), ''),
      phone = nullif(btrim(coalesce(p_phone, '')), ''),
      tin = nullif(btrim(coalesce(p_tin, '')), ''),
      logo_path = nullif(btrim(coalesce(p_logo_path, '')), ''),
      bank_account_number = nullif(btrim(coalesce(p_bank_account_number, '')), ''),
      bank_account_name = nullif(btrim(coalesce(p_bank_account_name, '')), ''),
      momo_pay_number = nullif(btrim(coalesce(p_momo_pay_number, '')), ''),
      out_of_stock_reminder_hours = coalesce(p_out_of_stock_reminder_hours, out_of_stock_reminder_hours),
      -- name is not nullable, so a blank/omitted value leaves it unchanged
      -- rather than nulling it out the way the optional fields above do.
      name = coalesce(nullif(btrim(coalesce(p_name, '')), ''), name),
      email = nullif(btrim(coalesce(p_email, '')), ''),
      website = nullif(btrim(coalesce(p_website, '')), ''),
      license_number = nullif(btrim(coalesce(p_license_number, '')), ''),
      license_expiry_date = p_license_expiry_date,
      ebm_device_serial = nullif(btrim(coalesce(p_ebm_device_serial, '')), ''),
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
      pos_show_patient_history = coalesce(p_pos_show_patient_history, pos_show_patient_history)
  where id = v_branch;
end;
$$;

revoke all on function public.update_branch_details(
  text, text, text, text, text, text, text, integer, text, text, text, text, date, text, text, text,
  boolean, boolean, boolean, boolean, boolean, text, boolean, boolean, boolean
) from public, anon;
grant execute on function public.update_branch_details(
  text, text, text, text, text, text, text, integer, text, text, text, text, date, text, text, text,
  boolean, boolean, boolean, boolean, boolean, text, boolean, boolean, boolean
) to authenticated;

drop function if exists public.get_my_branch_details();
create or replace function public.get_my_branch_details()
returns table(
  name text, address text, phone text, tin text, logo_path text, bank_account_number text, bank_account_name text, momo_pay_number text,
  out_of_stock_reminder_hours integer, branch_code text, status text, created_at timestamptz,
  email text, website text, license_number text, license_expiry_date date, ebm_device_serial text, default_language text,
  receipt_number_prefix text, pos_cash_enabled boolean, pos_mtn_momo_enabled boolean, pos_airtel_money_enabled boolean,
  pos_card_enabled boolean, pos_insurance_enabled boolean, pos_default_payment_method text,
  pos_require_patient_name boolean, pos_allow_discounts boolean, pos_show_patient_history boolean
)
language sql
stable
security definer
set search_path = ''
as $$
  select b.name::text, b.address, b.phone, b.tin, b.logo_path, b.bank_account_number, b.bank_account_name, b.momo_pay_number,
         b.out_of_stock_reminder_hours, b.branch_code::text, b.status::text, b.created_at,
         b.email, b.website, b.license_number, b.license_expiry_date, b.ebm_device_serial, b.default_language::text,
         b.receipt_number_prefix::text, b.pos_cash_enabled, b.pos_mtn_momo_enabled, b.pos_airtel_money_enabled,
         b.pos_card_enabled, b.pos_insurance_enabled, b.pos_default_payment_method::text,
         b.pos_require_patient_name, b.pos_allow_discounts, b.pos_show_patient_history
  from public.branches b
  where b.id = public.current_branch_id()
$$;

revoke all on function public.get_my_branch_details() from public, anon;
grant execute on function public.get_my_branch_details() to authenticated;

-- complete_sale(), re-declared once more: gains p_payment_method (stored as-
-- is, just how the patient-owed portion was actually settled -- separate
-- from insurance, which already has its own provider/coverage path) and
-- p_discount_id (a real, previously-unused sales.discount_id column -- this
-- is the first thing that ever writes it). The discount reduces the
-- PATIENT-owed portion only, computed after insurance coverage, so a
-- generous discount can never make insurance's own billed amount move --
-- what an insurer is billed is the real line-item cost, independent of a
-- pharmacy's own loyalty/promo discount to the patient.
drop function if exists public.complete_sale(jsonb, uuid, uuid);
create or replace function public.complete_sale(
  p_lines jsonb, p_insurance_provider_id uuid default null, p_patient_id uuid default null,
  p_payment_method text default null, p_discount_id uuid default null
)
returns table(
  sale_id uuid, receipt_number text, total_amount numeric,
  insurance_covered_total numeric, patient_owed_total numeric
)
language plpgsql
security definer
set search_path = ''
as $$
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
  select u.branch_id into v_branch from public.users u where u.id = v_user and u.is_active;
  if v_branch is null then
    raise exception 'Only an active branch user may complete a sale';
  end if;
  if exists (select 1 from public.branches b where b.id = v_branch and b.status <> 'active') then
    raise exception 'This pharmacy is not active';
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
$$;

revoke all on function public.complete_sale(jsonb, uuid, uuid, text, uuid) from public, anon;
grant execute on function public.complete_sale(jsonb, uuid, uuid, text, uuid) to authenticated;

-- public.discounts had RLS enabled from day one but was never given a SELECT
-- policy or any way for a branch to create its own rows -- sales.discount_id
-- above and analytics_discount_usage() both already assumed it, but nothing
-- could actually populate or read it. branch_id is added (nullable, so any
-- future genuinely-global discount stays visible everywhere) so "Allow
-- Discounts at POS" is something an owner can actually use end-to-end:
-- create a discount for their own branch, see it, apply it at checkout.
alter table public.discounts add column if not exists branch_id uuid references public.branches(id);

drop policy if exists "discounts readable" on public.discounts;
create policy "discounts readable" on public.discounts for select to authenticated
  using (branch_id is null or branch_id = public.current_branch_id() or public.is_super_admin());

create or replace function public.create_branch_discount(
  p_name text, p_discount_type text, p_value numeric, p_valid_from date default null, p_valid_to date default null
)
returns uuid
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_id uuid;
begin
  perform public.assert_owner_or_manager();
  if p_discount_type not in ('percentage','fixed') then
    raise exception 'Discount type must be percentage or fixed';
  end if;
  if p_value < 0 or (p_discount_type = 'percentage' and p_value > 100) then
    raise exception 'Invalid discount value';
  end if;

  insert into public.discounts (name, discount_type, value, valid_from, valid_to, branch_id)
  values (btrim(p_name), p_discount_type, p_value, p_valid_from, p_valid_to, public.current_branch_id())
  returning id into v_id;

  return v_id;
end;
$$;

revoke all on function public.create_branch_discount(text, text, numeric, date, date) from public, anon;
grant execute on function public.create_branch_discount(text, text, numeric, date, date) to authenticated;

-- Every discount this branch can see (its own + any genuinely global ones),
-- with whether it's currently within its valid_from/valid_to window --
-- deactivating a discount is just setting valid_to to a past date, there's
-- no separate is_active flag to keep in sync.
create or replace function public.list_branch_discounts()
returns table(id uuid, name text, discount_type text, value numeric, valid_from date, valid_to date, is_current boolean)
language sql
stable
security definer
set search_path = ''
as $$
  select d.id, d.name::text, d.discount_type::text, d.value, d.valid_from, d.valid_to,
    (d.valid_from is null or d.valid_from <= current_date) and (d.valid_to is null or d.valid_to >= current_date)
  from public.discounts d
  where d.branch_id is null or d.branch_id = public.current_branch_id() or public.is_super_admin()
  order by d.name
$$;

revoke all on function public.list_branch_discounts() from public, anon;
grant execute on function public.list_branch_discounts() to authenticated;

-- ============================================================================
-- BRANCH HISTORY — one owner-only view across every kind of event
-- ============================================================================
-- Everything that has ever happened at this branch, in one place: sales,
-- stock adjustments (manual and the automatic expiry write-off), stock
-- deliveries received, insurance claims filed, patients registered, product
-- requests submitted, seller accounts created, and batch recalls that
-- touched this branch's own stock. Each source already has its own detail
-- page (Transactions, Stock Adjustments, Receiving, Insurance, Patients,
-- Product Requests, Team) -- this is deliberately not a replacement for any
-- of them, it's the one page that reads across all of them at once, so nothing
-- requires the owner to remember which page a given event lives on.
--
-- Owner-only is enforced HERE, not just by hiding the nav link client-side:
-- a seller calling this RPC directly gets the same "Only the branch owner..."
-- rejection adjust_stock()/update_branch_details() already use for their own
-- owner/manager-only actions.
drop function if exists public.list_branch_history(timestamptz, timestamptz);

create or replace function public.list_branch_history(p_from timestamptz default null, p_to timestamptz default null)
returns table(
  event_at timestamptz, category text, amount numeric, actor_name text, status text, meta jsonb
)
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_branch uuid;
begin
  select u.branch_id into v_branch
  from public.users u
  where u.id = (select auth.uid()) and u.is_active and u.role = 'owner';
  if v_branch is null then
    raise exception 'Only the branch owner may view the full history';
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
$$;

revoke all on function public.list_branch_history(timestamptz, timestamptz) from public, anon;
grant execute on function public.list_branch_history(timestamptz, timestamptz) to authenticated;

-- ============================================================================
-- AI ANALYST — read-only, branch-scoped tools for the ai-analyst Edge Function
-- ============================================================================
-- Every function below is a "tool" the ai-analyst Edge Function (supabase/
-- functions/ai-analyst) hands to Claude: real, parameterized, read-only SQL,
-- never a raw/arbitrary query the model could construct itself. Owner/manager
-- only (assert_owner_or_manager(), new below) -- a seller cannot reach any of
-- this, at the database level, not just because the client hides the nav
-- link. Every function is scoped to current_branch_id() exactly like every
-- other RPC in this schema; there is no separate auth path for "AI" access.
--
-- Correctness note that applies throughout this section: nothing here ever
-- joins public.sales and public.sale_items and then aggregates sales.total_
-- amount -- a sale with 3 line items would then have its total counted 3
-- times (once per joined row). Every revenue figure below is instead summed
-- directly from sale_items (unit_price * quantity for the gross/what-the-
-- customer-paid amount), which is safe under a join no matter how many lines
-- a sale has. Tax per line is derived the same way complete_sale() computes
-- it -- (unit_price * quantity) - subtotal -- since subtotal is the net,
-- tax-exclusive amount under the VAT-inclusive pricing model and unit_price
-- is the gross (tax-inclusive) price the customer actually paid.

create or replace function public.assert_owner_or_manager()
returns void
language plpgsql
security definer
set search_path = ''
as $$
begin
  if not exists (
    select 1 from public.users u
    where u.id = (select auth.uid()) and u.is_active and u.role in ('owner','manager')
  ) then
    raise exception 'Only the branch owner or manager may use the AI analyst';
  end if;
end;
$$;

revoke all on function public.assert_owner_or_manager() from public, anon;
grant execute on function public.assert_owner_or_manager() to authenticated;

-- "State of the business right now" -- today/week/month-to-date revenue,
-- stock alerts, pending requests, unread notifications. No arguments; a good
-- default first call for a broad question. Calls ai_stock_status() (below)
-- three times rather than duplicating its low/out/expiring logic here.
create or replace function public.ai_branch_snapshot()
returns table(
  branch_name text, today_revenue numeric, week_to_date_revenue numeric, month_to_date_revenue numeric,
  active_product_count integer, out_of_stock_count integer, low_stock_count integer, expiring_soon_count integer,
  pending_product_requests integer, unread_alerts integer
)
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_branch uuid := public.current_branch_id();
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
    (select count(*) from public.ai_stock_status('out'))::integer,
    (select count(*) from public.ai_stock_status('low'))::integer,
    (select count(*) from public.ai_stock_status('expiring'))::integer,
    (select count(*) from public.product_requests pr where pr.branch_id = v_branch and pr.status = 'pending')::integer,
    (select count(*) from public.notifications n where n.branch_id = v_branch and not n.is_read)::integer
  from public.branches b where b.id = v_branch;
end;
$$;

-- Revenue/tax/insurance/patient-paid totals + transaction count over a date
-- range, bucketed by day/week/month. The raw series behind trend questions
-- and behind sales_forecast's own math.
create or replace function public.ai_sales_trend(p_from date, p_to date, p_bucket text default 'day')
returns table(period_start date, revenue numeric, tax numeric, insurance_covered numeric, patient_owed numeric, transaction_count integer)
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_branch uuid := public.current_branch_id();
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
$$;

-- Ranks products by revenue or quantity, either direction -- one function
-- answers both "best sellers" (direction desc) and "slowest movers" (asc).
create or replace function public.ai_top_products(
  p_from date, p_to date, p_metric text default 'revenue', p_direction text default 'desc', p_limit integer default 10
)
returns table(product_id uuid, product_name text, dosage text, quantity_sold numeric, revenue numeric)
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_branch uuid := public.current_branch_id();
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
$$;

-- Revenue and quantity sold per category over a date range.
create or replace function public.ai_category_breakdown(p_from date, p_to date)
returns table(category_name text, revenue numeric, quantity_sold numeric)
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_branch uuid := public.current_branch_id();
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
$$;

-- Current stock per product variant, filterable to out-of-stock, low (below
-- its reorder point), expiring within 60 days, or already-expired. Same
-- pack-only quantity math as check_out_of_stock_alerts()/the live inventory
-- dashboard (quantity_available * pieces_per_pack, 'pack' barcodes only --
-- a 'box' row's quantity_available is just "does this carton exist", never a
-- piece count).
create or replace function public.ai_stock_status(p_filter text default 'all')
returns table(product_name text, dosage text, quantity_available integer, min_quantity integer, expiry_date date, days_to_expiry integer, status text)
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_branch uuid := public.current_branch_id();
begin
  perform public.assert_owner_or_manager();
  if v_branch is null then raise exception 'No active branch for this session'; end if;
  if p_filter not in ('low','out','expiring','expired','all') then raise exception 'filter must be low, out, expiring, expired or all'; end if;

  return query
  with stock as (
    select
      p.name::text as product_name, pv.dosage::text as dosage,
      coalesce(sum(bc.quantity_available * bc.pieces_per_pack) filter (where bc.barcode_type = 'pack'), 0)::integer as qty_available,
      coalesce(rp.min_quantity, 0) as min_quantity,
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
      when stock.nearest_expiry is not null and stock.nearest_expiry <= current_date + 60 then 'expiring'
      when stock.qty_available < stock.min_quantity then 'low'
      else 'ok'
    end
  from stock
  where p_filter = 'all'
    or (p_filter = 'out' and stock.qty_available = 0)
    or (p_filter = 'low' and stock.qty_available > 0 and stock.qty_available < stock.min_quantity)
    or (p_filter = 'expiring' and stock.nearest_expiry is not null and stock.nearest_expiry between current_date and current_date + 60)
    or (p_filter = 'expired' and stock.nearest_expiry is not null and stock.nearest_expiry < current_date)
  order by stock.qty_available asc
  limit 200;
end;
$$;

-- Real statistical forecast (least-squares linear regression via Postgres's
-- built-in regr_slope/regr_intercept over a daily-quantity time series) --
-- not something an LLM guesses. Pass product_id OR category_id OR neither
-- (whole-branch forecast); never both. Degrades safely to all-zero output
-- when there's no sales history yet, rather than erroring.
create or replace function public.ai_sales_forecast(
  p_product_id uuid default null,
  p_category_id uuid default null,
  p_days_history integer default 90,
  p_horizon_days integer default 30
)
returns table(
  scope text, days_of_history integer, avg_daily_quantity numeric, trend_per_day numeric,
  projected_quantity_next_period numeric, projected_revenue_next_period numeric
)
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_branch uuid := public.current_branch_id();
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
      -- regr_slope/regr_intercept always return double precision in Postgres,
      -- regardless of the input types (x/y are already cast to numeric above)
      -- -- cast back to numeric here so every round(x, n) below resolves to
      -- round(numeric, integer); round(double precision, integer) doesn't exist.
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
$$;

-- Per-insurance-provider claim totals over a date range: how many claims,
-- how much was claimed, how much has actually been paid out vs. is still
-- pending (submitted/approved but not yet paid).
create or replace function public.ai_insurance_summary(p_from date, p_to date)
returns table(provider_name text, claim_count integer, total_claimed numeric, paid_out numeric, pending numeric)
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_branch uuid := public.current_branch_id();
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
$$;

-- Per-staff-member transaction count and revenue over a date range.
create or replace function public.ai_seller_performance(p_from date, p_to date)
returns table(seller_name text, seller_role text, transaction_count integer, revenue numeric)
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_branch uuid := public.current_branch_id();
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
$$;

-- Patient activity over a date range: how many served, how many new, how
-- many repeat visits, and the single highest-spending patient.
create or replace function public.ai_patient_summary(p_from date, p_to date)
returns table(total_patients_served integer, new_patients integer, repeat_patients integer, top_patient_name text, top_patient_spend numeric)
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_branch uuid := public.current_branch_id();
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
$$;

revoke all on function public.ai_branch_snapshot() from public, anon;
grant execute on function public.ai_branch_snapshot() to authenticated;
revoke all on function public.ai_sales_trend(date, date, text) from public, anon;
grant execute on function public.ai_sales_trend(date, date, text) to authenticated;
revoke all on function public.ai_top_products(date, date, text, text, integer) from public, anon;
grant execute on function public.ai_top_products(date, date, text, text, integer) to authenticated;
revoke all on function public.ai_category_breakdown(date, date) from public, anon;
grant execute on function public.ai_category_breakdown(date, date) to authenticated;
revoke all on function public.ai_stock_status(text) from public, anon;
grant execute on function public.ai_stock_status(text) to authenticated;
revoke all on function public.ai_sales_forecast(uuid, uuid, integer, integer) from public, anon;
grant execute on function public.ai_sales_forecast(uuid, uuid, integer, integer) to authenticated;
revoke all on function public.ai_insurance_summary(date, date) from public, anon;
grant execute on function public.ai_insurance_summary(date, date) to authenticated;
revoke all on function public.ai_seller_performance(date, date) from public, anon;
grant execute on function public.ai_seller_performance(date, date) to authenticated;
revoke all on function public.ai_patient_summary(date, date) from public, anon;
grant execute on function public.ai_patient_summary(date, date) to authenticated;

-- ═══════════════════════════════════════════════════════════════════════════
-- ANALYTICS PAGE EXTRAS -- additional read-only, owner/manager-gated reports
-- for the non-AI Analytics & Forecasting page (src/pages/AnalyticsPage.tsx).
-- Same assert_owner_or_manager()/current_branch_id() scoping as the AI
-- analyst tools above; these are plain SQL, called directly via
-- supabase.rpc() from src/lib/analytics.ts, no LLM involved.
-- ═══════════════════════════════════════════════════════════════════════════

-- Stock losses (damage, theft, expired write-offs, corrections, ...) over a
-- date range, broken down by type and by who logged it, with an estimated
-- RWF value from the batch's own cost_price. expired_writeoff rows here ARE
-- the expired-stock-waste figure -- stock_receiving already auto-writes off
-- expired batches into this same table, so there is no separate function for
-- "value of expired stock" -- it would just double this one.
create or replace function public.analytics_stock_adjustments(p_from date, p_to date)
returns table(adjustment_type text, staff_name text, quantity numeric, adjustment_count integer, estimated_value numeric)
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_branch uuid := public.current_branch_id();
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
$$;

-- Products still sitting in stock with little or no recent sales -- capital
-- tied up in slow movers. Same pack-only on-hand math as ai_stock_status();
-- stock_value is that on-hand quantity priced at each batch's own cost_price.
create or replace function public.analytics_dead_stock(p_days integer default 60, p_limit integer default 50)
returns table(product_name text, dosage text, quantity_on_hand integer, stock_value numeric, days_since_last_sale integer)
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_branch uuid := public.current_branch_id();
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
$$;

-- Cost of goods sold (from each sold line's own batch cost_price) against
-- CURRENT on-hand inventory value, per category, over a date range. The
-- denominator is today's stock value, not a true period-average (this app
-- keeps no historical inventory snapshots) -- close enough to flag categories
-- with capital moving fast vs. sitting still, not a precise accounting ratio.
create or replace function public.analytics_inventory_turnover(p_from date, p_to date)
returns table(category_name text, cogs numeric, current_inventory_value numeric, turnover_ratio numeric)
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_branch uuid := public.current_branch_id();
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
$$;

-- Per-supplier spend and delivery volume over a date range, from stock
-- receiving (stock_batches.received_at/cost_price/quantity_received).
create or replace function public.analytics_supplier_performance(p_from date, p_to date)
returns table(supplier_name text, delivery_count integer, units_received numeric, total_cost numeric, avg_unit_cost numeric)
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_branch uuid := public.current_branch_id();
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
$$;

-- Revenue and transaction count per day-of-week (0=Sunday..6=Saturday, same
-- as Postgres extract(dow)) x hour-of-day -- a heatmap of when sales actually
-- happen, for staffing decisions. Aggregates at the sale level first so a
-- multi-line sale is never fanned out across sale_items.
create or replace function public.analytics_sales_heatmap(p_from date, p_to date)
returns table(day_of_week integer, hour_of_day integer, revenue numeric, transaction_count integer)
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_branch uuid := public.current_branch_id();
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
$$;

-- Average items-per-sale and revenue-per-sale, bucketed like ai_sales_trend.
create or replace function public.analytics_basket_size(p_from date, p_to date, p_bucket text default 'day')
returns table(period_start date, avg_items_per_sale numeric, avg_revenue_per_sale numeric, transaction_count integer)
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_branch uuid := public.current_branch_id();
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
$$;

-- How much revenue moved through each discount, and an estimated RWF value
-- of the discount itself (computed per SALE, not per line, so a fixed-amount
-- discount on a multi-item sale isn't counted once per line).
create or replace function public.analytics_discount_usage(p_from date, p_to date)
returns table(discount_name text, discount_type text, usage_count integer, revenue_with_discount numeric, estimated_discount_value numeric)
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_branch uuid := public.current_branch_id();
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
$$;

-- How long still-pending insurance claims (submitted/approved, not yet paid)
-- have been sitting, bucketed by age as of today. No date range -- this is a
-- snapshot of the current backlog, not a historical report.
create or replace function public.analytics_insurance_claim_aging()
returns table(age_bucket text, claim_count integer, total_amount numeric)
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_branch uuid := public.current_branch_id();
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
$$;

-- Per-provider claim volume, approval rate ((approved+paid)/total), and
-- average claim size/coverage over a date range -- deeper than
-- ai_insurance_summary()'s paid-vs-pending totals.
create or replace function public.analytics_insurance_provider_comparison(p_from date, p_to date)
returns table(provider_name text, claim_count integer, approved_count integer, approval_rate numeric, avg_claim_amount numeric, avg_coverage_percentage numeric)
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_branch uuid := public.current_branch_id();
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
$$;

-- Per-seller transaction count/revenue plus an ESTIMATED "active hours"
-- figure -- there is no clock-in/clock-out table in this app, so active time
-- per day is approximated as that seller's own first-sale-to-last-sale span
-- each day they sold anything. A seller who only ever rings up one sale on a
-- given day contributes 0 minutes for that day, which can make their
-- per-hour rate null (divide-by-zero guarded, not a crash) -- expected
-- behavior for light usage, not a bug.
create or replace function public.analytics_seller_productivity(p_from date, p_to date)
returns table(seller_name text, seller_role text, transaction_count integer, revenue numeric, active_hours numeric, revenue_per_hour numeric, transactions_per_hour numeric)
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_branch uuid := public.current_branch_id();
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
$$;

-- Recall history log. Deliberately NOT branch-scoped -- batch_recalls is a
-- system-wide safety record by design (see the RLS policy comment on that
-- table: "A recall must be visible to every branch that received the lot"),
-- so this returns every recall regardless of which branch's stock it hit.
-- Still owner/manager-gated like every function in this section.
create or replace function public.analytics_recall_log(p_limit integer default 50)
returns table(product_name text, dosage text, batch_number text, manufacturer_name text, reason text, recalled_by_name text, recalled_at timestamptz)
language plpgsql
security definer
set search_path = ''
as $$
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
$$;

-- Patients who bought within the lookback window but whose LAST visit was
-- more than p_inactive_days ago -- i.e. used to come back, now quiet.
-- Ranked by lifetime spend in that window so the highest-value lapsed
-- patients surface first.
create or replace function public.analytics_patient_retention(p_lookback_days integer default 180, p_inactive_days integer default 60, p_limit integer default 20)
returns table(patient_name text, last_visit date, days_since_last_visit integer, past_visit_count integer, lifetime_spend numeric)
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_branch uuid := public.current_branch_id();
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
$$;

revoke all on function public.analytics_stock_adjustments(date, date) from public, anon;
grant execute on function public.analytics_stock_adjustments(date, date) to authenticated;
revoke all on function public.analytics_dead_stock(integer, integer) from public, anon;
grant execute on function public.analytics_dead_stock(integer, integer) to authenticated;
revoke all on function public.analytics_inventory_turnover(date, date) from public, anon;
grant execute on function public.analytics_inventory_turnover(date, date) to authenticated;
revoke all on function public.analytics_supplier_performance(date, date) from public, anon;
grant execute on function public.analytics_supplier_performance(date, date) to authenticated;
revoke all on function public.analytics_sales_heatmap(date, date) from public, anon;
grant execute on function public.analytics_sales_heatmap(date, date) to authenticated;
revoke all on function public.analytics_basket_size(date, date, text) from public, anon;
grant execute on function public.analytics_basket_size(date, date, text) to authenticated;
revoke all on function public.analytics_discount_usage(date, date) from public, anon;
grant execute on function public.analytics_discount_usage(date, date) to authenticated;
revoke all on function public.analytics_insurance_claim_aging() from public, anon;
grant execute on function public.analytics_insurance_claim_aging() to authenticated;
revoke all on function public.analytics_insurance_provider_comparison(date, date) from public, anon;
grant execute on function public.analytics_insurance_provider_comparison(date, date) to authenticated;
revoke all on function public.analytics_seller_productivity(date, date) from public, anon;
grant execute on function public.analytics_seller_productivity(date, date) to authenticated;
revoke all on function public.analytics_recall_log(integer) from public, anon;
grant execute on function public.analytics_recall_log(integer) to authenticated;
revoke all on function public.analytics_patient_retention(integer, integer, integer) from public, anon;
grant execute on function public.analytics_patient_retention(integer, integer, integer) to authenticated;

-- ============================================================================
-- USERS & ROLES (Branch Settings) -- generalizes seller-only staff management
-- to also cover manager accounts, and adds a real "change role" action.
-- ============================================================================

-- Now covers manager targets too (previously seller-only). Deactivating a
-- fellow manager is owner-only -- a manager can still deactivate staff
-- (unchanged from before), matching "staff oversight" without letting a
-- manager touch a peer's access.
create or replace function public.admin_set_seller_active(p_user_id uuid, p_is_active boolean)
returns void
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_caller uuid := (select auth.uid());
  v_branch uuid;
  v_caller_role text;
  v_target_role text;
begin
  select u.branch_id, u.role into v_branch, v_caller_role
  from public.users u
  where u.id = v_caller and u.is_active and u.role in ('owner', 'manager');
  if v_branch is null then raise exception 'Only an active branch manager or owner may manage staff'; end if;

  select role into v_target_role from public.users where id = p_user_id and branch_id = v_branch;
  if v_target_role is null or v_target_role not in ('manager', 'seller') then
    raise exception 'Staff member not found for this branch';
  end if;
  if v_target_role = 'manager' and v_caller_role <> 'owner' then
    raise exception 'Only the branch owner may deactivate a manager';
  end if;

  update public.users
  set is_active = p_is_active
  where id = p_user_id and branch_id = v_branch and role in ('manager', 'seller');
end;
$$;

-- Owner-only: moves an existing manager/seller account between those two
-- tiers. Narrower than admin_set_seller_active (owner-or-manager) on
-- purpose -- granting or revoking peer-level manager access is an owner
-- decision, not something a manager should be able to do to themselves or
-- each other.
create or replace function public.admin_update_staff_role(p_user_id uuid, p_role text)
returns void
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_caller uuid := (select auth.uid());
  v_branch uuid;
begin
  if p_role not in ('manager', 'seller') then
    raise exception 'role must be manager or seller';
  end if;

  select u.branch_id into v_branch
  from public.users u
  where u.id = v_caller and u.is_active and u.role = 'owner';
  if v_branch is null then raise exception 'Only the branch owner may change a staff member''s role'; end if;

  update public.users
  set role = p_role
  where id = p_user_id and branch_id = v_branch and role in ('manager', 'seller');
  if not found then raise exception 'Staff member not found for this branch'; end if;
end;
$$;

revoke all on function public.admin_update_staff_role(uuid, text) from public, anon;
grant execute on function public.admin_update_staff_role(uuid, text) to authenticated;

-- ============================================================================
-- CATEGORY MANAGEMENT (Branch Settings -> Categories) -- product_categories
-- had RLS enabled since its original creation but no policy was ever added,
-- silently returning zero rows to any client query -- the exact same
-- dead-infrastructure shape the discounts table had before it. Fixed here
-- with a real branch-scoped policy, a created_at column (so categories have
-- a genuine chronological order to display/number by), and real CRUD RPCs --
-- previously the only way a category got created was inline free-text entry
-- during stock receiving.
-- ============================================================================

alter table public.product_categories add column if not exists created_at timestamptz not null default now();

drop policy if exists "categories access" on public.product_categories;
create policy "categories access" on public.product_categories
  for all to authenticated
  using (branch_id = public.current_branch_id() or public.is_super_admin())
  with check (branch_id = public.current_branch_id() or public.is_super_admin());

create or replace function public.list_branch_categories()
returns table(id uuid, name text, description text, product_count integer, code text)
language sql
stable
security definer
set search_path = ''
as $$
  select
    pc.id, pc.name::text, pc.description,
    (select count(*)::integer from public.branch_product_categorization bpc where bpc.category_id = pc.id and bpc.branch_id = pc.branch_id),
    'CAT-' || lpad(row_number() over (order by pc.created_at)::text, 3, '0')
  from public.product_categories pc
  where pc.branch_id = public.current_branch_id()
  order by pc.created_at;
$$;

revoke all on function public.list_branch_categories() from public, anon;
grant execute on function public.list_branch_categories() to authenticated;

create or replace function public.create_branch_category(p_name text, p_description text default null)
returns uuid
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_branch uuid := public.current_branch_id();
  v_id uuid;
begin
  perform public.assert_owner_or_manager();
  if v_branch is null then raise exception 'No active branch for this session'; end if;
  if nullif(btrim(coalesce(p_name, '')), '') is null then raise exception 'A category name is required'; end if;

  insert into public.product_categories (branch_id, name, description)
  values (v_branch, btrim(p_name), nullif(btrim(coalesce(p_description, '')), ''))
  returning id into v_id;
  return v_id;
exception
  when unique_violation then
    raise exception 'A category named "%" already exists for this branch.', btrim(p_name);
end;
$$;

revoke all on function public.create_branch_category(text, text) from public, anon;
grant execute on function public.create_branch_category(text, text) to authenticated;

create or replace function public.update_branch_category(p_category_id uuid, p_name text, p_description text default null)
returns void
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_branch uuid := public.current_branch_id();
begin
  perform public.assert_owner_or_manager();
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
$$;

revoke all on function public.update_branch_category(uuid, text, text) from public, anon;
grant execute on function public.update_branch_category(uuid, text, text) to authenticated;

-- ============================================================================
-- BRANCH SETTINGS — Inventory tab (Stock Levels)
-- ============================================================================
-- Two genuinely new, real per-branch settings: expiry_alert_threshold_days
-- (previously a hardcoded 60 in both the live Inventory Dashboard/Reports
-- computation and ai_stock_status()) and default_reorder_min (previously no
-- default existed at all -- a product with no reorder_points row always
-- showed min_quantity = 0 until a pharmacist manually set one). Both defaults
-- below (60, 0) preserve today's exact behavior for every existing branch
-- until an owner actually changes them.
--
-- "Allow Negative Stock" from the reference design is deliberately NOT
-- included here -- complete_sale() already hard-blocks selling a barcode
-- with zero quantity_available/pieces remaining (see "has already been
-- sold" / "only has % piece(s) left" / "no packs left to sell" checks).
-- Overriding that is a real, buildable feature, but it weakens the one
-- guarantee the whole POS flow currently relies on for accurate stock, so
-- it needs an explicit decision rather than being bundled in silently.

alter table public.branches
  add column if not exists expiry_alert_threshold_days integer not null default 60 check (expiry_alert_threshold_days > 0),
  add column if not exists default_reorder_min integer not null default 0 check (default_reorder_min >= 0);

drop function if exists public.update_branch_details(
  text, text, text, text, text, text, text, integer, text, text, text, text, date, text, text, text,
  boolean, boolean, boolean, boolean, boolean, text, boolean, boolean, boolean
);
create or replace function public.update_branch_details(
  p_address text, p_phone text, p_tin text, p_logo_path text default null,
  p_bank_account_number text default null, p_bank_account_name text default null, p_momo_pay_number text default null,
  p_out_of_stock_reminder_hours integer default null,
  p_name text default null, p_email text default null, p_website text default null,
  p_license_number text default null, p_license_expiry_date date default null, p_ebm_device_serial text default null,
  p_default_language text default null,
  p_receipt_number_prefix text default null,
  p_pos_cash_enabled boolean default null, p_pos_mtn_momo_enabled boolean default null,
  p_pos_airtel_money_enabled boolean default null, p_pos_card_enabled boolean default null, p_pos_insurance_enabled boolean default null,
  p_pos_default_payment_method text default null,
  p_pos_require_patient_name boolean default null, p_pos_allow_discounts boolean default null, p_pos_show_patient_history boolean default null,
  p_expiry_alert_threshold_days integer default null,
  p_default_reorder_min integer default null
)
returns void
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_branch uuid;
begin
  select u.branch_id into v_branch
  from public.users u
  where u.id = (select auth.uid()) and u.is_active and u.role = 'owner';
  if v_branch is null then raise exception 'Only the branch owner may update branch settings'; end if;

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
      tin = nullif(btrim(coalesce(p_tin, '')), ''),
      logo_path = nullif(btrim(coalesce(p_logo_path, '')), ''),
      bank_account_number = nullif(btrim(coalesce(p_bank_account_number, '')), ''),
      bank_account_name = nullif(btrim(coalesce(p_bank_account_name, '')), ''),
      momo_pay_number = nullif(btrim(coalesce(p_momo_pay_number, '')), ''),
      out_of_stock_reminder_hours = coalesce(p_out_of_stock_reminder_hours, out_of_stock_reminder_hours),
      name = coalesce(nullif(btrim(coalesce(p_name, '')), ''), name),
      email = nullif(btrim(coalesce(p_email, '')), ''),
      website = nullif(btrim(coalesce(p_website, '')), ''),
      license_number = nullif(btrim(coalesce(p_license_number, '')), ''),
      license_expiry_date = p_license_expiry_date,
      ebm_device_serial = nullif(btrim(coalesce(p_ebm_device_serial, '')), ''),
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
$$;

revoke all on function public.update_branch_details(
  text, text, text, text, text, text, text, integer, text, text, text, text, date, text, text, text,
  boolean, boolean, boolean, boolean, boolean, text, boolean, boolean, boolean, integer, integer
) from public, anon;
grant execute on function public.update_branch_details(
  text, text, text, text, text, text, text, integer, text, text, text, text, date, text, text, text,
  boolean, boolean, boolean, boolean, boolean, text, boolean, boolean, boolean, integer, integer
) to authenticated;

drop function if exists public.get_my_branch_details();
create or replace function public.get_my_branch_details()
returns table(
  name text, address text, phone text, tin text, logo_path text, bank_account_number text, bank_account_name text, momo_pay_number text,
  out_of_stock_reminder_hours integer, branch_code text, status text, created_at timestamptz,
  email text, website text, license_number text, license_expiry_date date, ebm_device_serial text, default_language text,
  receipt_number_prefix text, pos_cash_enabled boolean, pos_mtn_momo_enabled boolean, pos_airtel_money_enabled boolean,
  pos_card_enabled boolean, pos_insurance_enabled boolean, pos_default_payment_method text,
  pos_require_patient_name boolean, pos_allow_discounts boolean, pos_show_patient_history boolean,
  expiry_alert_threshold_days integer, default_reorder_min integer
)
language sql
stable
security definer
set search_path = ''
as $$
  select b.name::text, b.address, b.phone, b.tin, b.logo_path, b.bank_account_number, b.bank_account_name, b.momo_pay_number,
         b.out_of_stock_reminder_hours, b.branch_code::text, b.status::text, b.created_at,
         b.email, b.website, b.license_number, b.license_expiry_date, b.ebm_device_serial, b.default_language::text,
         b.receipt_number_prefix::text, b.pos_cash_enabled, b.pos_mtn_momo_enabled, b.pos_airtel_money_enabled,
         b.pos_card_enabled, b.pos_insurance_enabled, b.pos_default_payment_method::text,
         b.pos_require_patient_name, b.pos_allow_discounts, b.pos_show_patient_history,
         b.expiry_alert_threshold_days, b.default_reorder_min
  from public.branches b
  where b.id = public.current_branch_id()
$$;

revoke all on function public.get_my_branch_details() from public, anon;
grant execute on function public.get_my_branch_details() to authenticated;

-- ai_stock_status() signature is unchanged -- just reads the branch's real
-- configured threshold/default instead of the old hardcoded 60 / 0.
create or replace function public.ai_stock_status(p_filter text default 'all')
returns table(product_name text, dosage text, quantity_available integer, min_quantity integer, expiry_date date, days_to_expiry integer, status text)
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_branch uuid := public.current_branch_id();
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
$$;

-- Incident fix: update_branch_details() previously wiped logo_path (and 7
-- other optional fields) to null whenever a caller simply omitted that
-- parameter, rather than leaving the stored value untouched. The real
-- front-end always sends every field so this never surfaced there, but a
-- direct RPC call that omits one of these (exactly what happened during
-- this session's own Inventory-tab verification query, which wiped a real
-- branch's logo_path) silently destroyed real data with no error at all.
--
-- Fix: NULL now means "leave this field alone" (matches how
-- out_of_stock_reminder_hours/default_language already behave in this same
-- function); an explicit empty string still clears it, since the front-end
-- always .trim()s user-editable text fields before sending them, so a
-- genuinely blanked field arrives as '' , never SQL null.
create or replace function public.update_branch_details(
  p_address text, p_phone text, p_tin text, p_logo_path text default null,
  p_bank_account_number text default null, p_bank_account_name text default null, p_momo_pay_number text default null,
  p_out_of_stock_reminder_hours integer default null,
  p_name text default null, p_email text default null, p_website text default null,
  p_license_number text default null, p_license_expiry_date date default null, p_ebm_device_serial text default null,
  p_default_language text default null,
  p_receipt_number_prefix text default null,
  p_pos_cash_enabled boolean default null, p_pos_mtn_momo_enabled boolean default null,
  p_pos_airtel_money_enabled boolean default null, p_pos_card_enabled boolean default null, p_pos_insurance_enabled boolean default null,
  p_pos_default_payment_method text default null,
  p_pos_require_patient_name boolean default null, p_pos_allow_discounts boolean default null, p_pos_show_patient_history boolean default null,
  p_expiry_alert_threshold_days integer default null,
  p_default_reorder_min integer default null
)
returns void
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_branch uuid;
begin
  select u.branch_id into v_branch
  from public.users u
  where u.id = (select auth.uid()) and u.is_active and u.role = 'owner';
  if v_branch is null then raise exception 'Only the branch owner may update branch settings'; end if;

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
      tin = nullif(btrim(coalesce(p_tin, '')), ''),
      -- NULL parameter = leave unchanged; '' = clear; anything else = set.
      logo_path = case when p_logo_path is null then logo_path else nullif(btrim(p_logo_path), '') end,
      bank_account_number = case when p_bank_account_number is null then bank_account_number else nullif(btrim(p_bank_account_number), '') end,
      bank_account_name = case when p_bank_account_name is null then bank_account_name else nullif(btrim(p_bank_account_name), '') end,
      momo_pay_number = case when p_momo_pay_number is null then momo_pay_number else nullif(btrim(p_momo_pay_number), '') end,
      out_of_stock_reminder_hours = coalesce(p_out_of_stock_reminder_hours, out_of_stock_reminder_hours),
      name = coalesce(nullif(btrim(coalesce(p_name, '')), ''), name),
      email = case when p_email is null then email else nullif(btrim(p_email), '') end,
      website = case when p_website is null then website else nullif(btrim(p_website), '') end,
      license_number = case when p_license_number is null then license_number else nullif(btrim(p_license_number), '') end,
      license_expiry_date = p_license_expiry_date,
      ebm_device_serial = case when p_ebm_device_serial is null then ebm_device_serial else nullif(btrim(p_ebm_device_serial), '') end,
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
$$;

-- ============================================================================
-- RRA COMPLIANCE PAGE
-- ============================================================================
-- Real VAT/receipt reporting from actual sales data. Deliberately does NOT
-- claim any of the following, since none of it exists in this system:
--   - A live RRA/EBM (Electronic Billing Machine) integration, or any real
--     "submit to RRA" action -- branches.ebm_device_serial is stored for a
--     future integration but nothing reads/writes to a government system.
--   - A verified "% RRA compliant" status -- there is no compliance check to
--     verify against, so no per-transaction or aggregate compliance score is
--     computed or displayed anywhere here.
--   - A receipt "delivery channel" (SMS/WhatsApp/E-Receipt/Physical) -- this
--     app only ever produces one kind of receipt (a printable HTML document);
--     there is no send-by-SMS/WhatsApp feature.
-- What IS real: VAT is computed the same way complete_sale()/getSaleReceipt()
-- already do (subtotal * tax_rate.rate_percentage), aggregated per month or
-- per transaction directly from sale_items/tax_rates.

create or replace function public.analytics_vat_by_month(p_months integer default 8)
returns table(month_label text, month_start date, revenue numeric, vat_total numeric)
language plpgsql
security definer
set search_path = ''
as $$
#variable_conflict use_column
declare
  v_branch uuid := public.current_branch_id();
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
$$;

revoke all on function public.analytics_vat_by_month(integer) from public, anon;
grant execute on function public.analytics_vat_by_month(integer) to authenticated;

-- Per-transaction subtotal/VAT breakdown, computed straight from sale_items
-- (the gross, pre-discount figures VAT is actually owed on) alongside the
-- real final total_amount (post-discount/insurance) -- these two can
-- legitimately differ by a discount amount, which is correct, not a bug.
create or replace function public.list_compliance_transactions(p_from date, p_to date, p_limit integer default 200)
returns table(
  sale_id uuid, receipt_number text, sold_at timestamptz, patient_name text, item_count integer,
  subtotal numeric, tax_total numeric, total_amount numeric, payment_method text, has_insurance boolean
)
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_branch uuid := public.current_branch_id();
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
$$;

revoke all on function public.list_compliance_transactions(date, date, integer) from public, anon;
grant execute on function public.list_compliance_transactions(date, date, integer) to authenticated;

-- ============================================================================
-- FOLDED-IN MIGRATIONS -- applied to production individually as dated files,
-- never previously copied into this consolidated snapshot. Folded in on
-- 2026-09-08 so a fresh project bootstrapped from this one file actually
-- matches production, instead of silently missing these tables/functions.
-- Order matters -- validated by applying them in exactly this sequence
-- against a brand-new Supabase project with no errors.
-- ============================================================================

-- ── originally 2026-09-05_restock_recommendations.sql ────────────────────────

-- ============================================================================
-- VELOCITY-AWARE RESTOCK RECOMMENDATIONS
-- ============================================================================
-- The existing low-stock check (check_out_of_stock_alerts / ai_stock_status)
-- only compares current stock against a manually-set reorder point
-- (reorder_points.min_quantity) -- it has no idea which products are
-- actually best-sellers or how fast they're moving. A product with a
-- generous min_quantity that suddenly starts flying off the shelf gets no
-- warning until it's already at zero.
--
-- This adds a second, independent signal: for each product, how many units
-- per day it has actually been selling recently (last 30 days, requiring
-- sales on at least 3 distinct days so a single one-off sale can't trigger
-- it), divided into how many units are on hand right now. If that's 14 days
-- or fewer, it's about to run out at the current pace -- regardless of
-- whether anyone ever configured a reorder point for it.
--
-- Two functions, following the exact pattern of check_out_of_stock_alerts()
-- and ai_top_products()/ai_sales_forecast() already in this schema:
--
--   1. check_restock_recommendations() -- security definer, callable by any
--      authenticated branch user (same as check_out_of_stock_alerts /
--      check_expired_stock), writes public.notifications rows. Meant to be
--      polled every 30s from the client alongside those two, so it's the
--      "repetitive" piece -- it runs on its own, no cron needed. Same
--      anti-spam rule as check_out_of_stock_alerts: only re-fire once the
--      previous notification for that product was read and is >24h old.
--
--   2. ai_restock_recommendations(...) -- read-only, owner/manager gated
--      (assert_owner_or_manager, same as ai_top_products), parameterized,
--      for the Analytics & Forecasting page's "Best Sellers at Risk" chart.
--      No notifications written here.
--
-- Run this once in the Supabase SQL editor (or via the CLI) against the
-- project's database. Safe to re-run: CREATE OR REPLACE.
-- ============================================================================

create or replace function public.check_restock_recommendations()
returns integer
language plpgsql
security definer
set search_path = ''
as $$
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
$$;

revoke all on function public.check_restock_recommendations() from public;
grant execute on function public.check_restock_recommendations() to authenticated;

create or replace function public.ai_restock_recommendations(
  p_days_history integer default 30,
  p_horizon_days integer default 14,
  p_limit integer default 10
)
returns table(
  product_id uuid, product_name text, dosage text,
  avg_daily_quantity numeric, quantity_available integer, days_to_stockout numeric
)
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_branch uuid := public.current_branch_id();
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
$$;

revoke all on function public.ai_restock_recommendations(integer, integer, integer) from public, anon;
grant execute on function public.ai_restock_recommendations(integer, integer, integer) to authenticated;

-- ── originally 2026-09-07_admin_branch_edit_and_application_expiry.sql ───────

-- ============================================================================
-- Super-admin branch editing + 7-day application expiry
-- ============================================================================
-- Run once. Idempotent -- safe to re-run.
--
--   1. admin_update_branch_details() -- the super admin can correct a
--      pharmacy's own details when the pharmacy asks. update_branch_details()
--      already exists but is owner-only (role = 'owner'), so nothing let an
--      admin act on a request like "we moved, please change our address".
--      Deliberately a separate function rather than widening the owner one:
--      the owner edits THEIR branch (implicit, from their session), an admin
--      edits ANY branch (explicit p_branch_id). Merging them would mean a
--      function whose target depends on who is calling it.
--
--   2. admin_expire_stale_applications() -- a registration nobody has
--      approved within 7 days is deleted. The admin console warns from day 5
--      (two days left) and day 6 (one day left); those warnings are computed
--      client-side from submitted_at, which admin_list_pharmacy_applications()
--      already returns, so no new alerting table is needed.

-- ── 1. Super admin edits a branch ───────────────────────────────────────────

create or replace function public.admin_update_branch_details(
  p_branch_id uuid,
  p_name text default null, p_phone text default null, p_email text default null,
  p_address text default null, p_tin text default null, p_website text default null,
  p_license_number text default null, p_license_expiry_date date default null
)
returns void
language plpgsql
security definer
set search_path = ''
as $$
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
$$;

revoke all on function public.admin_update_branch_details(uuid, text, text, text, text, text, text, text, date) from public, anon;
grant execute on function public.admin_update_branch_details(uuid, text, text, text, text, text, text, text, date) to authenticated;

-- ── 2. Applications expire after 7 days without approval ────────────────────
-- Only ever touches rows that are still 'pending' AND have no branch attached.
-- An approved application has a branch row (and possibly a live account)
-- behind it -- deleting that from a cleanup sweep would be destructive in a
-- way nobody asked for. Denied ones are kept as history, same as elsewhere.
--
-- Returns how many were removed so the console can say so rather than having
-- rows silently disappear between page loads.

create or replace function public.admin_expire_stale_applications()
returns integer
language plpgsql
security definer
set search_path = ''
as $$
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
$$;

revoke all on function public.admin_expire_stale_applications() from public, anon;
grant execute on function public.admin_expire_stale_applications() to authenticated;

-- ── originally 2026-09-07_branch_delete_fixes_and_archive.sql ────────────────

-- ============================================================================
-- admin_delete_branch(): fix missing cleanup, free the applicant's email,
-- and keep a lightweight archive of what was deleted
-- ============================================================================
-- Run once. Idempotent -- safe to re-run.
--
-- Three real bugs in the original admin_delete_branch():
--
--   1. Three tables that reference branches(id) were never cleaned up:
--      public.patients, public.discounts (branch-owned rows), and
--      public.product_requests. None of those foreign keys are ON DELETE
--      CASCADE, so `delete from public.branches where id = p_branch_id` at
--      the end of the function raised a raw foreign-key-violation error --
--      not our own friendly exception text -- for ANY branch that had ever
--      registered a patient, created a discount, or filed a product
--      request. In normal use that is nearly every real branch, so the
--      delete-branch feature was effectively broken for production data.
--
--   2. The applicant's original branch_applications row was left with
--      branch_id = null but its status untouched (typically 'active'), and
--      submit_pharmacy_registration() refuses a new application from an
--      email already on an application with status in
--      ('pending','otp_sent','active'). Deleting a branch therefore
--      permanently blocked that email from ever registering again --
--      exactly the opposite of what deleting the branch should do. Fixed
--      by moving that application to 'denied' (which the same check
--      excludes, and which the unique index on open applications already
--      treats as free to re-apply).
--
--   3. Nothing recorded that a deletion happened at all. Added
--      public.deleted_branches_log: pharmacy name, phone, email, branch
--      code and location as they stood at deletion time, who deleted it,
--      when, and the optional reason they gave. This is a log, not a
--      recovery mechanism -- the branch's actual data (sales, stock,
--      barcodes, ...) is still genuinely gone; this is only the "who/what/
--      when" record the super admin console's new "Deleted branches" panel
--      reads from.
--
-- Pharmacy NAME reuse was checked too and is NOT a problem: branches.name
-- has no unique constraint anywhere in this schema, so a fresh registration
-- under the same pharmacy name a deleted branch used has always worked.

-- ── 1. Archive table ─────────────────────────────────────────────────────

create table if not exists public.deleted_branches_log (
  id uuid primary key default gen_random_uuid(),
  branch_id uuid not null, -- not a live FK: the branch this refers to no longer exists
  pharmacy_name varchar(150) not null,
  phone varchar(30),
  email varchar(150),
  branch_code varchar(32),
  location text,
  reason text,
  deleted_by_email text,
  deleted_at timestamptz not null default now()
);

create index if not exists idx_deleted_branches_log_deleted_at on public.deleted_branches_log (deleted_at desc);

alter table public.deleted_branches_log enable row level security;
drop policy if exists "super admin only" on public.deleted_branches_log;
create policy "super admin only" on public.deleted_branches_log
for all to authenticated
using (public.is_super_admin())
with check (public.is_super_admin());

-- Writes only ever happen inside admin_delete_branch() (security definer,
-- runs as table owner), so no INSERT grant is needed for the client -- this
-- is read-only from the browser's own perspective.
grant select on public.deleted_branches_log to authenticated;

-- ── 2. admin_delete_branch(): same behaviour, gains p_reason, fixes the ──
--       three missing deletes, frees the applicant's email, logs the event

-- p_reason is a new parameter with a default, which is still a different
-- overload identity to Postgres -- the same "cannot silently widen a
-- function's signature" rule documented throughout this schema. Dropped
-- first so only one admin_delete_branch() ever exists.
drop function if exists public.admin_delete_branch(uuid);

create or replace function public.admin_delete_branch(p_branch_id uuid, p_reason text default null)
returns void
language plpgsql
security definer
set search_path = ''
as $$
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
$$;

revoke all on function public.admin_delete_branch(uuid, text) from public;
grant execute on function public.admin_delete_branch(uuid, text) to authenticated;

-- ── 3. Read the archive from the console ────────────────────────────────

create or replace function public.admin_list_deleted_branches()
returns table(
  id uuid, branch_id uuid, pharmacy_name text, phone text, email text,
  branch_code text, location text, reason text, deleted_by_email text, deleted_at timestamptz
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
      l.id, l.branch_id, l.pharmacy_name::text, l.phone::text, l.email::text,
      l.branch_code::text, l.location, l.reason, l.deleted_by_email::text, l.deleted_at
    from public.deleted_branches_log l
    order by l.deleted_at desc;
end;
$$;

revoke all on function public.admin_list_deleted_branches() from public;
grant execute on function public.admin_list_deleted_branches() to authenticated;

-- ── originally 2026-09-07_patient_and_insurer_tin.sql ────────────────────────

-- ============================================================================
-- Patient phone + TIN, insurer TIN, and TIN snapshots on every sale
-- ============================================================================
-- Run this whole file once against the project (SQL editor or `supabase db
-- execute`). It is idempotent -- every statement is add-if-missing or
-- create-or-replace, so re-running it is safe.
--
-- What changes:
--   1. patients gains `phone` and `tin` as separate columns. Until now a
--      patient had ONE `tin_or_phone` field, so a patient who had both could
--      only be recorded under one of them. `tin_or_phone` stays as the
--      per-branch identity key (and is what `phone` is backfilled from), so
--      nothing that already points at a patient breaks.
--   2. insurance_providers gains `tin` -- insurers are businesses and have one.
--   3. sales gains `patient_phone`, `patient_tin`, `insurer_tin`: values
--      SNAPSHOT at the moment of sale. These are deliberately copies, not
--      joins -- a provider or patient can change their TIN later, and an
--      already-issued receipt must keep the number it was actually issued
--      under.
--
-- The snapshots are filled by triggers rather than by editing complete_sale().
-- complete_sale() is long, locks barcodes, and is the single path every sale
-- goes through; extending it by hand risked breaking selling outright. The
-- triggers below are additive and cannot fail a sale (see the exception
-- guards).

-- ── 1. Patients: phone and TIN as separate fields ───────────────────────────

alter table public.patients add column if not exists phone varchar(50);
alter table public.patients add column if not exists tin   varchar(50);

-- Existing rows only ever had the one field. Treat it as the phone, which is
-- what it is for the overwhelming majority of records, and leave tin null --
-- the sales screen can fill a real TIN in on the patient's next visit.
update public.patients
set phone = tin_or_phone
where phone is null;

-- Search hits these three columns on every keystroke in the sales screen.
create index if not exists patients_branch_phone_idx on public.patients (branch_id, phone);
create index if not exists patients_branch_tin_idx   on public.patients (branch_id, tin);
create index if not exists patients_branch_name_idx  on public.patients (branch_id, lower(full_name));

-- ── 2. Insurance providers: TIN ─────────────────────────────────────────────

alter table public.insurance_providers add column if not exists tin varchar(50);

-- ── 3. Sales: TIN/phone snapshots ───────────────────────────────────────────

alter table public.sales add column if not exists patient_phone varchar(50);
alter table public.sales add column if not exists patient_tin   varchar(50);
alter table public.sales add column if not exists insurer_tin   varchar(50);

-- Stamp the patient's phone/TIN as they stand when the sale is written.
create or replace function public.stamp_sale_patient_identifiers()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  if new.patient_id is not null then
    select p.phone, p.tin into new.patient_phone, new.patient_tin
    from public.patients p
    where p.id = new.patient_id;
  end if;
  return new;
end;
$$;

drop trigger if exists sales_stamp_patient_identifiers on public.sales;
create trigger sales_stamp_patient_identifiers
before insert on public.sales
for each row execute function public.stamp_sale_patient_identifiers();

-- The insurer is not known at the moment the sales row is inserted --
-- complete_sale() writes the claim afterwards -- so the insurer TIN is
-- stamped from the claim instead.
create or replace function public.stamp_sale_insurer_tin()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  update public.sales s
  set insurer_tin = ip.tin
  from public.insurance_providers ip
  where s.id = new.sale_id
    and ip.id = new.insurance_provider_id;
  return new;
end;
$$;

drop trigger if exists insurance_claims_stamp_insurer_tin on public.insurance_claims;
create trigger insurance_claims_stamp_insurer_tin
after insert on public.insurance_claims
for each row execute function public.stamp_sale_insurer_tin();

-- ── 4. Patient RPCs ─────────────────────────────────────────────────────────

-- Phone is the identity (it is what the cashier always has); TIN is optional
-- and stored alongside. The old 4-argument signature is dropped so a stale
-- client can't silently write a patient with no phone recorded.
drop function if exists public.upsert_patient(text, text, integer, text);

create or replace function public.upsert_patient(
  p_full_name text, p_gender text, p_age integer, p_phone text, p_tin text default null
)
returns uuid
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_user   uuid := (select auth.uid());
  v_branch uuid;
  v_phone  text := nullif(btrim(coalesce(p_phone, '')), '');
  v_tin    text := nullif(btrim(coalesce(p_tin, '')), '');
  v_id     uuid;
begin
  select u.branch_id into v_branch from public.users u where u.id = v_user and u.is_active;
  if v_branch is null then raise exception 'Only an active branch user may record a patient'; end if;
  if nullif(btrim(coalesce(p_full_name, '')), '') is null then raise exception 'A patient name is required'; end if;
  if v_phone is null then raise exception 'A phone number is required'; end if;
  if p_gender is not null and p_gender not in ('male','female','other') then raise exception 'Unknown gender'; end if;

  insert into public.patients (branch_id, full_name, gender, age, tin_or_phone, phone, tin, created_by)
  values (v_branch, btrim(p_full_name), p_gender, p_age, v_phone, v_phone, v_tin, v_user)
  on conflict (branch_id, tin_or_phone)
  do update set
    full_name  = excluded.full_name,
    gender     = excluded.gender,
    age        = excluded.age,
    phone      = excluded.phone,
    -- Never blank an existing TIN just because this visit did not retype it.
    tin        = coalesce(excluded.tin, public.patients.tin),
    updated_at = now()
  returning id into v_id;

  return v_id;
end;
$$;

revoke all on function public.upsert_patient(text, text, integer, text, text) from public, anon;
grant execute on function public.upsert_patient(text, text, integer, text, text) to authenticated;

-- Matches phone OR TIN, so a patient found by either is the same record.
--
-- Dropped first, not just replaced: both this and list_branch_patients() keep
-- their argument list but return extra columns, and Postgres refuses to change
-- a function's return type through CREATE OR REPLACE ("cannot change return
-- type of existing function").
drop function if exists public.find_patient_by_identifier(text);

create or replace function public.find_patient_by_identifier(p_identifier text)
returns table(id uuid, full_name text, gender text, age integer, tin_or_phone text, phone text, tin text)
language sql
stable
security definer
set search_path = ''
as $$
  select p.id, p.full_name::text, p.gender::text, p.age,
         p.tin_or_phone::text, p.phone::text, p.tin::text
  from public.patients p
  where p.branch_id = public.current_branch_id()
    and (p.tin_or_phone = btrim(p_identifier)
      or p.phone        = btrim(p_identifier)
      or p.tin          = btrim(p_identifier))
  limit 1
$$;

-- Re-granted because DROP FUNCTION above took the old grants with it.
revoke all on function public.find_patient_by_identifier(text) from public, anon;
grant execute on function public.find_patient_by_identifier(text) to authenticated;

drop function if exists public.list_branch_patients();

create or replace function public.list_branch_patients()
returns table(
  id uuid, full_name text, gender text, age integer, tin_or_phone text,
  phone text, tin text, visit_count integer, last_visit_at timestamptz, lifetime_spend numeric
)
language sql
stable
security definer
set search_path = ''
as $$
  select
    p.id, p.full_name::text, p.gender::text, p.age, p.tin_or_phone::text,
    p.phone::text, p.tin::text,
    count(s.id)::integer, max(s.sold_at), coalesce(sum(s.total_amount), 0)
  from public.patients p
  left join public.sales s on s.patient_id = p.id
  where p.branch_id = public.current_branch_id()
  group by p.id, p.full_name, p.gender, p.age, p.tin_or_phone, p.phone, p.tin
  order by max(s.sold_at) desc nulls last, p.full_name
$$;

revoke all on function public.list_branch_patients() from public, anon;
grant execute on function public.list_branch_patients() to authenticated;

-- ── 5. Insurance provider RPCs ──────────────────────────────────────────────

create or replace function public.admin_create_insurance_provider(
  p_name text, p_default_coverage_percentage numeric, p_contact_info text default null, p_tin text default null
)
returns uuid
language plpgsql
security definer
set search_path = ''
as $$
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
$$;

create or replace function public.admin_update_insurance_provider(
  p_provider_id uuid, p_name text, p_default_coverage_percentage numeric,
  p_contact_info text default null, p_tin text default null
)
returns void
language plpgsql
security definer
set search_path = ''
as $$
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
$$;

-- The old 3/4-argument signatures would otherwise still resolve and silently
-- drop the TIN.
drop function if exists public.admin_create_insurance_provider(text, numeric, text);
drop function if exists public.admin_update_insurance_provider(uuid, text, numeric, text);

revoke all on function public.admin_create_insurance_provider(text, numeric, text, text) from public, anon;
grant execute on function public.admin_create_insurance_provider(text, numeric, text, text) to authenticated;

revoke all on function public.admin_update_insurance_provider(uuid, text, numeric, text, text) from public, anon;
grant execute on function public.admin_update_insurance_provider(uuid, text, numeric, text, text) to authenticated;

-- ── 6. Backfill snapshots for sales already on record ───────────────────────
-- Best-effort, so historical receipts show the numbers too where they are
-- still derivable. Only fills rows that are still null.

update public.sales s
set patient_phone = p.phone, patient_tin = p.tin
from public.patients p
where s.patient_id = p.id
  and s.patient_phone is null
  and s.patient_tin is null;

update public.sales s
set insurer_tin = ip.tin
from public.insurance_claims ic
join public.insurance_providers ip on ip.id = ic.insurance_provider_id
where ic.sale_id = s.id
  and s.insurer_tin is null
  and ip.tin is not null;

-- ── originally 2026-09-07_public_receipt_lookup.sql ──────────────────────────

-- ============================================================================
-- PUBLIC RECEIPT LOOKUP (for the customer-facing "scan to view online" QR)
-- ============================================================================
-- Every printed sales receipt now carries a second QR code (independent of
-- the existing RRA/EBM compliance QR in complete_sale()/getSaleReceipt()) that
-- opens an unauthenticated web page showing that one receipt in full -- same
-- content as the printed copy, including patient name/insurance if present.
-- This was an explicit, informed product decision: the sale's UUID itself
-- (122 bits of randomness, not practically guessable) is the only access
-- control, the same trust model as physically handing someone a paper
-- receipt. Do not add extra gating here that the product decision didn't ask
-- for -- that would just be inconsistent with the "full receipt" promise.
--
-- Why a narrow RPC instead of an anon-readable RLS policy: getSaleReceipt()
-- (src/lib/sales.ts) touches sales, receipts, sale_items, branches, users,
-- barcodes, tax_rates, insurance_claims, insurance_providers, patients,
-- stock_batches, product_variants and products. Granting `anon` any RLS
-- policy on those tables -- even one scoped to "match this one id" -- opens
-- a PostgREST table endpoint that can be queried directly with arbitrary
-- filters (e.g. GET /rest/v1/sales?select=*), which would let anyone
-- enumerate/list ALL sales, not just the one they already hold the link for.
-- A single security-definer function taking exactly one p_sale_id uuid and
-- returning only that one sale's assembled jsonb has no such surface: it
-- can only ever be called with one id at a time and only ever returns that
-- id's own data. No RLS changes are made to any underlying table by this
-- migration.
--
-- Brute force: 122 bits of UUIDv4 randomness makes guessing a live sale id
-- computationally infeasible; no additional rate limiting is implemented
-- here (out of scope -- Postgres has no trivial built-in per-caller rate
-- limit for a SECURITY DEFINER function; if this ever becomes a concern,
-- handle it at the edge/CDN layer, not in this migration).
--
-- Run this once in the Supabase SQL editor (or via the CLI) against the
-- project's database. Safe to re-run: CREATE OR REPLACE.
-- ============================================================================

create or replace function public.get_public_receipt(p_sale_id uuid)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_branch_id uuid;
  v_cashier_id uuid;
  v_patient_id uuid;

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
begin
  -- No auth.uid()/branch check here on purpose -- p_sale_id is the only
  -- filter, by design (see header comment above).
  select s.branch_id, s.cashier_id, s.patient_id
    into v_branch_id, v_cashier_id, v_patient_id
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

  return jsonb_build_object(
    'saleId', p_sale_id,
    'receiptNumber', v_receipt_number,
    'issuedAt', v_issued_at,
    'branchName', coalesce(v_branch_name, '—'),
    'branchTin', v_branch_tin,
    'branchAddress', v_branch_address,
    'branchPhone', v_branch_phone,
    -- Raw storage path, not a full URL -- get_public_receipt() has no idea
    -- what the project's public URL is; the TS layer builds the URL the
    -- exact same way getSaleReceipt() already does, via
    -- supabase.storage.from('branch-logos').getPublicUrl(path).
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
    'patientOwedTotal', v_subtotal + v_tax_total - v_insurance_total,
    'grandTotal', v_subtotal + v_tax_total,
    -- TODO: once complete_sale()/VSDC submission stores EBM fields on
    -- public.receipts, select and return those columns here instead of
    -- nulls, mirroring the same TODO in getSaleReceipt() (src/lib/sales.ts).
    'ebmSdcId', null,
    'ebmMrcNo', null,
    'ebmReceiptSignature', null,
    'ebmInvoiceNumber', null
  );
end;
$$;

revoke all on function public.get_public_receipt(uuid) from public;
grant execute on function public.get_public_receipt(uuid) to anon, authenticated;

-- ── originally 2026-09-07_sales_forecast_accuracy.sql ────────────────────────

-- ============================================================================
-- SALES FORECAST ACCURACY (predicted-vs-actual tracking)
-- ============================================================================
-- ai_sales_forecast_series() (2026-09-07_sales_forecast_series.sql) always
-- computes a forecast fresh, relative to "now" -- once a forecasted period is
-- in the past, the next run just folds it into real "actual" data. That's
-- correct for the forecast itself, but it throws away what was PREDICTED at
-- the time, so there's no way to later see "how close was this?".
--
-- This migration adds a small backing store (sales_forecast_snapshots) that
-- remembers each forecast run's future points, and a read function
-- (ai_sales_forecast_accuracy) that -- for a given historical date range --
-- looks up the most recent prediction that was made *before* each period
-- actually happened, so the Analytics chart can draw a third line: what we
-- predicted, next to what the real "Actual Revenue" line turned out to be.
--
-- The table has RLS enabled with NO policies -- like every other reporting
-- table in this app, it is never read or written directly by the client;
-- both operations go through the two SECURITY DEFINER functions below,
-- which enforce assert_owner_or_manager() + branch scoping themselves.
--
-- Snapshot cadence: an auto-running forecast (see AnalyticsPage.tsx, which
-- re-runs on every product/category/history/horizon change) would otherwise
-- write a near-identical row every few seconds while someone is just
-- tweaking inputs. save_sales_forecast_snapshot() instead keeps at most one
-- row per (branch, scope) per calendar day, updating it in place if one
-- already exists for today -- so history accumulates one genuine snapshot
-- per day, kept forever, without that noise.
--
-- Run this once in the Supabase SQL editor (or via the CLI) against the
-- project's database. Safe to re-run: CREATE TABLE IF NOT EXISTS / CREATE OR
-- REPLACE FUNCTION.
-- ============================================================================

create table if not exists public.sales_forecast_snapshots (
  id uuid primary key default gen_random_uuid(),
  branch_id uuid not null references public.branches(id) on delete cascade,
  product_id uuid references public.products(id) on delete cascade,
  category_id uuid references public.product_categories(id) on delete cascade,
  generated_at timestamptz not null default now(),
  bucket text not null check (bucket in ('day','week','month')),
  -- One element per future period this run predicted:
  -- {"period_start": "2026-09-01", "predicted_revenue": 123, "predicted_quantity": 45, "lower_bound": 100, "upper_bound": 150}
  points jsonb not null
);

create index if not exists idx_forecast_snapshots_scope on public.sales_forecast_snapshots (branch_id, product_id, category_id, generated_at desc);

alter table public.sales_forecast_snapshots enable row level security;

create or replace function public.save_sales_forecast_snapshot(
  p_product_id uuid default null,
  p_category_id uuid default null,
  p_bucket text default 'month',
  p_points jsonb default '[]'::jsonb
)
returns void
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_branch uuid := public.current_branch_id();
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
$$;

create or replace function public.ai_sales_forecast_accuracy(
  p_product_id uuid default null,
  p_category_id uuid default null,
  p_from date default null,
  p_to date default null
)
returns table(period_start date, predicted_revenue numeric, predicted_quantity numeric, predicted_at timestamptz)
language plpgsql
security definer
set search_path = ''
as $$
#variable_conflict use_column
declare
  v_branch uuid := public.current_branch_id();
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
  -- Only predictions made before the period they predicted actually started
  -- count as a real forecast of it; among those, the most recent one is the
  -- most-informed guess available at the time, so that's what gets compared
  -- against the real outcome.
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
$$;

revoke all on function public.save_sales_forecast_snapshot(uuid, uuid, text, jsonb) from public, anon;
grant execute on function public.save_sales_forecast_snapshot(uuid, uuid, text, jsonb) to authenticated;
revoke all on function public.ai_sales_forecast_accuracy(uuid, uuid, date, date) from public, anon;
grant execute on function public.ai_sales_forecast_accuracy(uuid, uuid, date, date) to authenticated;

-- ── originally 2026-09-07_sales_forecast_series.sql ──────────────────────────

-- ============================================================================
-- SALES FORECAST SERIES (for the Analytics page's forecast chart)
-- ============================================================================
-- ai_sales_forecast() (see pharmacy_schema_consolidated.sql) already returns
-- a real linear-regression forecast, but only as a single lump-sum number
-- for the whole horizon -- fine for the AI analyst's text answers, but not
-- something you can plot. This function reuses the exact same regression
-- (same daily x/y points, same regr_slope/regr_intercept) and instead
-- returns one row per bucketed period (day/week/month), so the Analytics
-- page can draw a real line chart: a solid "actual" line over history, a
-- dashed "forecast" line over the horizon, and a shaded confidence band
-- around the forecast.
--
-- ai_sales_forecast() itself is untouched -- it's also used by the AI
-- analyst as a tool (see that function's own comment), and this migration
-- must not change its existing contract.
--
-- Confidence band: the residual standard deviation of daily quantity around
-- the fitted regression line (stddev_pop of actual - predicted, over the
-- history window), scaled by sqrt(days in that future bucket) since daily
-- residuals are treated as independent, times a z-score of ~1.28 for an
-- (approximate, normal-theory) 80% two-sided interval -- matching the
-- "Shaded area shows 80% confidence interval" caption on the chart.
--
-- Run this once in the Supabase SQL editor (or via the CLI) against the
-- project's database. Safe to re-run: CREATE OR REPLACE.
-- ============================================================================

create or replace function public.ai_sales_forecast_series(
  p_product_id uuid default null,
  p_category_id uuid default null,
  p_days_history integer default 90,
  p_horizon_days integer default 30,
  p_bucket text default null -- null = auto-pick from the total span (see below)
)
returns table(
  period_start date, is_forecast boolean,
  actual_revenue numeric, actual_quantity numeric,
  forecast_revenue numeric, forecast_quantity numeric,
  lower_bound numeric, upper_bound numeric
)
language plpgsql
security definer
set search_path = ''
as $$
#variable_conflict use_column
declare
  v_branch uuid := public.current_branch_id();
  v_bucket text := p_bucket;
begin
  perform public.assert_owner_or_manager();
  if v_branch is null then raise exception 'No active branch for this session'; end if;
  if p_product_id is not null and p_category_id is not null then
    raise exception 'Pass product_id or category_id, not both';
  end if;
  if p_days_history < 7 or p_days_history > 730 then raise exception 'days_history must be between 7 and 730'; end if;
  if p_horizon_days < 1 or p_horizon_days > 365 then raise exception 'horizon_days must be between 1 and 365'; end if;

  -- Auto-pick a bucket size that keeps the chart readable regardless of how
  -- wide a window was requested, unless the caller pinned one explicitly.
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
    -- Past/actual periods. The last actual period also carries a forecast
    -- value equal to its own actual value -- a "bridge" point so the dashed
    -- forecast line visually connects to the solid actual line with no gap,
    -- the same way the reference chart's Aug point does.
    select
      ab.period_start, false as is_forecast,
      round(ab.revenue, 2) as actual_revenue, round(ab.quantity, 2) as actual_quantity,
      case when ab.period_start = la.period_start then round(ab.revenue, 2) end as forecast_revenue,
      case when ab.period_start = la.period_start then round(ab.quantity, 2) end as forecast_quantity,
      null::numeric as lower_bound, null::numeric as upper_bound
    from actual_buckets ab cross join last_actual la
    union all
    -- Future/forecast periods, with an 80%-ish confidence band around each.
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
$$;

revoke all on function public.ai_sales_forecast_series(uuid, uuid, integer, integer, text) from public, anon;
grant execute on function public.ai_sales_forecast_series(uuid, uuid, integer, integer, text) to authenticated;

-- ── originally 2026-09-07_forecast_completed_notifications.sql ───────────────

-- ============================================================================
-- FORECAST-COMPLETED NOTIFICATIONS
-- ============================================================================
-- Once every period a saved forecast (sales_forecast_snapshots, see
-- 2026-09-07_sales_forecast_accuracy.sql) predicted has actually elapsed,
-- surface it as a real notification -- same public.notifications table and
-- check-then-insert idempotent pattern already used by
-- check_out_of_stock_alerts()/check_expired_stock()/check_license_expiry()
-- in lib/alerts.ts, not a separate notification system.
--
-- notified_at on the snapshot itself is the de-dup guard (mirroring how
-- out-of-stock reuses "is_read + a cooldown" for ITS de-dup) -- once a
-- snapshot has been notified about, it's never picked up again by this
-- function, even though its points stay in the table forever for the
-- accuracy chart (ai_sales_forecast_accuracy) to keep reading.
--
-- Run this once in the Supabase SQL editor (or via the CLI) against the
-- project's database. Safe to re-run: ALTER ... ADD COLUMN IF NOT EXISTS /
-- CREATE OR REPLACE FUNCTION.
-- ============================================================================

alter table public.sales_forecast_snapshots add column if not exists notified_at timestamptz;

-- Widen the notifications source_type list once more (same incremental-ALTER
-- pattern already used for out_of_stock, license_expiring, etc.).
alter table public.notifications drop constraint if exists notifications_source_type_check;
alter table public.notifications add constraint notifications_source_type_check
  check (source_type in ('batch_recall','stock_adjustment','product_request_approved','product_request_rejected','out_of_stock','license_expiring','forecast_completed'));

create or replace function public.check_forecast_accuracy_notifications()
returns integer
language plpgsql
security definer
set search_path = ''
as $$
#variable_conflict use_column
declare
  v_branch uuid := public.current_branch_id();
  v_count integer := 0;
  v_snap record;
  v_scope text;
  v_actual numeric;
  v_pct text;
begin
  if v_branch is null then return 0; end if;

  -- One pass per not-yet-notified snapshot whose entire predicted horizon
  -- has fully elapsed (period_to <= today) -- period_to is the end of the
  -- LAST bucket it predicted, computed from its own bucket size so a
  -- monthly point starting Sept 1 isn't considered "finished" until Oct 1.
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
      continue; -- horizon hasn't fully elapsed yet -- leave it for a later poll
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
$$;

revoke all on function public.check_forecast_accuracy_notifications() from public, anon;
grant execute on function public.check_forecast_accuracy_notifications() to authenticated;

-- ============================================================================
-- INSURANCE FIXED VARIANT PRICES
-- ============================================================================
-- Per-provider, per-exact-variant FIXED selling price for insurance sales,
-- completely independent of the branch's own wholesale-cost-based
-- stock_batches.selling_price. Real pharmacist feedback: insurance providers
-- negotiate one fixed price per medicine (per exact strength/form, since
-- "Amoxicillin 500mg" and "Amoxicillin 250mg" are billed separately), and
-- that price has nothing to do with what any given branch paid for its own
-- stock. A row existing here for (provider, variant) means "this is what
-- that provider pays for that exact item" -- complete_sale() (redeclared
-- below) prices the line from here instead of the batch's selling_price
-- when a match exists, then still applies insurance_product_coverage's
-- normal percentage split on top of THIS price, not the walk-in one.
-- No row here for a given (provider, variant) just falls back to the
-- existing walk-in-price behavior, unchanged.
create table if not exists public.insurance_variant_prices (
  insurance_provider_id uuid not null references public.insurance_providers(id),
  product_variant_id uuid not null references public.product_variants(id),
  fixed_price numeric(12,2) not null check(fixed_price >= 0),
  primary key(insurance_provider_id, product_variant_id)
);

alter table public.insurance_variant_prices enable row level security;
grant select on public.insurance_variant_prices to authenticated;

drop policy if exists "insurance variant prices readable" on public.insurance_variant_prices;
create policy "insurance variant prices readable" on public.insurance_variant_prices for select to authenticated using (true);

-- Sets (or changes) the fixed price for one (provider, variant) pair.
-- Mirrors admin_set_insurance_coverage()'s upsert shape exactly.
create or replace function public.admin_set_insurance_variant_price(
  p_provider_id uuid, p_product_variant_id uuid, p_fixed_price numeric
)
returns void
language plpgsql
security definer
set search_path = ''
as $$
begin
  perform public.assert_super_admin();
  if p_fixed_price is null or p_fixed_price < 0 then
    raise exception 'Fixed price must be zero or greater';
  end if;
  insert into public.insurance_variant_prices (insurance_provider_id, product_variant_id, fixed_price)
  values (p_provider_id, p_product_variant_id, p_fixed_price)
  on conflict (insurance_provider_id, product_variant_id) do update set fixed_price = excluded.fixed_price;
end;
$$;

-- Removes the fixed price, so the variant reverts to walk-in pricing for
-- that provider.
create or replace function public.admin_clear_insurance_variant_price(p_provider_id uuid, p_product_variant_id uuid)
returns void
language plpgsql
security definer
set search_path = ''
as $$
begin
  perform public.assert_super_admin();
  delete from public.insurance_variant_prices
  where insurance_provider_id = p_provider_id and product_variant_id = p_product_variant_id;
end;
$$;

revoke all on function public.admin_set_insurance_variant_price(uuid, uuid, numeric) from public, anon;
grant execute on function public.admin_set_insurance_variant_price(uuid, uuid, numeric) to authenticated;
revoke all on function public.admin_clear_insurance_variant_price(uuid, uuid) from public, anon;
grant execute on function public.admin_clear_insurance_variant_price(uuid, uuid) to authenticated;

-- ============================================================================
-- complete_sale() — price insurance sales from insurance_variant_prices
-- ============================================================================
-- Re-declared solely to add v_effective_price: every one of the four pricing
-- branches below (pack whole/pieces, box whole, box packs, box pieces) used
-- to price a line straight from v_barcode.selling_price (the walk-in price)
-- unconditionally, insurance or not. Now, for an insurance sale, each line
-- first checks insurance_variant_prices for that provider + the line's exact
-- product_variant_id; if a fixed price is on file, the line is priced from
-- that instead, and insurance_product_coverage's percentage split (already
-- existing, unchanged) is applied on top of it. No match (including every
-- walk-in sale, since p_insurance_provider_id is null) falls back to
-- v_barcode.selling_price exactly as before. Everything else in this
-- function is unchanged from the prior declaration.
create or replace function public.complete_sale(
  p_lines jsonb, p_insurance_provider_id uuid default null, p_patient_id uuid default null,
  p_payment_method text default null, p_discount_id uuid default null
)
returns table(
  sale_id uuid, receipt_number text, total_amount numeric,
  insurance_covered_total numeric, patient_owed_total numeric
)
language plpgsql
security definer
set search_path = ''
as $$
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
  select u.branch_id into v_branch from public.users u where u.id = v_user and u.is_active;
  if v_branch is null then
    raise exception 'Only an active branch user may complete a sale';
  end if;
  if exists (select 1 from public.branches b where b.id = v_branch and b.status <> 'active') then
    raise exception 'This pharmacy is not active';
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
$$;

revoke all on function public.complete_sale(jsonb, uuid, uuid, text, uuid) from public, anon;
grant execute on function public.complete_sale(jsonb, uuid, uuid, text, uuid) to authenticated;

-- ── lookup_barcode(): add cost_price, for the sale cart's bargain/profit check ──
-- Needed so the Sales page can show a cashier, live, whether a bargained
-- price still clears what the branch actually paid for this exact batch,
-- before they commit to it. complete_sale() does its own separate, row-locked
-- lookup and is unaffected by this. create or replace cannot change a
-- function's return columns, so the old signature has to be dropped first --
-- this is the FINAL declaration of lookup_barcode() in this file.
drop function if exists public.lookup_barcode(text);
create function public.lookup_barcode(p_code text)
returns table(
  barcode_id uuid, code text, barcode_type text, status text,
  quantity_available integer, pieces_per_pack integer, child_count integer,
  child_pieces_per_pack integer, active_child_count integer,
  parent_code text, stock_batch_id uuid, batch_number text, expiry_date date,
  delivery_code text, selling_price numeric, cost_price numeric, product_id uuid, product_name text,
  tax_rate_id uuid, dosage text, form text, manufacturer_name text, supplier_name text
)
language sql
stable
security definer
set search_path = ''
as $$
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
    s.supplier_name::text
  from public.barcodes bc
  join public.stock_batches sb on sb.id = bc.stock_batch_id
  join public.product_variants pv on pv.id = sb.product_variant_id
  join public.products p on p.id = pv.product_id
  left join public.barcodes parent on parent.id = bc.parent_barcode_id
  left join public.suppliers s on s.id = sb.supplier_id
  where upper(bc.code) = upper(btrim(p_code))
    and (
      public.is_super_admin()
      or sb.branch_id = public.current_branch_id()
    )
  limit 1
$$;

grant execute on function public.lookup_barcode(text) to authenticated;

-- ============================================================================
-- complete_sale() — accept a cashier-bargained final price (walk-in only)
-- ============================================================================
-- Re-declared to add p_bargain_final_price: a real-world pharmacist workflow
-- where a customer haggles down to a specific number ("give me this for
-- 500"), rather than a named percentage/fixed discount from the discounts
-- catalog. When provided, the discount applied is simply
-- greatest(v_total - p_bargain_final_price, 0) -- computed from the
-- server's own authoritative v_total, never trusting a client-sent discount
-- amount directly. Rejected outright for an insurance sale (this is a
-- walk-in-only negotiation -- insurance pricing is already fixed/negotiated
-- separately via insurance_variant_prices) or alongside a catalog
-- p_discount_id (avoids ambiguous stacking; pick one or the other).
-- Everything else is unchanged from the prior declaration.
create or replace function public.complete_sale(
  p_lines jsonb, p_insurance_provider_id uuid default null, p_patient_id uuid default null,
  p_payment_method text default null, p_discount_id uuid default null, p_bargain_final_price numeric default null
)
returns table(
  sale_id uuid, receipt_number text, total_amount numeric,
  insurance_covered_total numeric, patient_owed_total numeric
)
language plpgsql
security definer
set search_path = ''
as $$
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
  select u.branch_id into v_branch from public.users u where u.id = v_user and u.is_active;
  if v_branch is null then
    raise exception 'Only an active branch user may complete a sale';
  end if;
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

  if p_insurance_provider_id is not null then
    select name into v_provider_name from public.insurance_providers where id = p_insurance_provider_id;
    if v_provider_name is null then raise exception 'Unknown insurance provider'; end if;
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
$$;

drop function if exists public.complete_sale(jsonb, uuid, uuid, text, uuid);
revoke all on function public.complete_sale(jsonb, uuid, uuid, text, uuid, numeric) from public, anon;
grant execute on function public.complete_sale(jsonb, uuid, uuid, text, uuid, numeric) to authenticated;

-- ============================================================================
-- RECEIPT NOTE — an optional, per-sale free-text note the pharmacist can
-- add for the customer, shown on the printed receipt underneath the
-- itemized total. Nothing on the receipt is removed or restructured to make
-- room for it -- it's a purely additive line, blank/absent by default.
-- ============================================================================
alter table public.sales add column if not exists receipt_note varchar(500);

-- sales has no direct UPDATE grant (only complete_sale() writes it, and only
-- at creation -- see the "SALES / INSURANCE / RECEIPTS" RLS block earlier in
-- this file), so this is the one narrow, branch-scoped way to edit the note
-- on an existing sale after the fact.
create or replace function public.set_sale_receipt_note(p_sale_id uuid, p_note text)
returns void
language plpgsql
security definer
set search_path = ''
as $$
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
$$;

revoke all on function public.set_sale_receipt_note(uuid, text) from public, anon;
grant execute on function public.set_sale_receipt_note(uuid, text) to authenticated;

-- get_public_receipt() — carry receipt_note through to the public "scan to
-- view online" QR too, so what a customer sees online matches what was
-- printed. Re-declared (not a new function) since it's a create or replace
-- on the same signature; everything else here is identical to
-- 2026-09-07_public_receipt_lookup.sql's own declaration -- see that file
-- for the full rationale on why this is a single narrow RPC rather than an
-- RLS policy.
create or replace function public.get_public_receipt(p_sale_id uuid)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_branch_id uuid;
  v_cashier_id uuid;
  v_patient_id uuid;
  v_receipt_note text;

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
begin
  select s.branch_id, s.cashier_id, s.patient_id, s.receipt_note
    into v_branch_id, v_cashier_id, v_patient_id, v_receipt_note
    from public.sales s
    where s.id = p_sale_id;

  if not found then
    return null;
  end if;

  select r.receipt_number, r.issued_at
    into v_receipt_number, v_issued_at
    from public.receipts r
    where r.sale_id = p_sale_id;

  if not found then
    return null;
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
    'patientOwedTotal', v_subtotal + v_tax_total - v_insurance_total,
    'grandTotal', v_subtotal + v_tax_total,
    'ebmSdcId', null,
    'ebmMrcNo', null,
    'ebmReceiptSignature', null,
    'ebmInvoiceNumber', null,
    'receiptNote', v_receipt_note
  );
end;
$$;

revoke all on function public.get_public_receipt(uuid) from public;
grant execute on function public.get_public_receipt(uuid) to anon, authenticated;

-- ============================================================================
-- PATIENT INSURANCE NUMBER
-- ============================================================================
-- The patient's own insurance membership/policy number -- distinct from
-- insurance_providers.tin (the insurer's own business tax ID) and from
-- patients.tin (the patient's own, unrelated tax ID). Optional, since a
-- walk-in cash patient has none. Follows the exact pattern
-- 2026-09-07_patient_and_insurer_tin.sql already established for tin: a new
-- nullable column, threaded through upsert_patient() (never blanked by a
-- visit that doesn't retype it), and returned alongside everything else by
-- the two read RPCs.

alter table public.patients add column if not exists insurance_number varchar(50);

-- Old signature dropped: adding a new trailing parameter is otherwise a
-- distinct overload, not a replacement, so a not-yet-updated client would
-- keep calling a version that silently has nowhere to put this value.
drop function if exists public.upsert_patient(text, text, integer, text, text);

create or replace function public.upsert_patient(
  p_full_name text, p_gender text, p_age integer, p_phone text, p_tin text default null, p_insurance_number text default null
)
returns uuid
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_user   uuid := (select auth.uid());
  v_branch uuid;
  v_phone  text := nullif(btrim(coalesce(p_phone, '')), '');
  v_tin    text := nullif(btrim(coalesce(p_tin, '')), '');
  v_ins    text := nullif(btrim(coalesce(p_insurance_number, '')), '');
  v_id     uuid;
begin
  select u.branch_id into v_branch from public.users u where u.id = v_user and u.is_active;
  if v_branch is null then raise exception 'Only an active branch user may record a patient'; end if;
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
$$;

revoke all on function public.upsert_patient(text, text, integer, text, text, text) from public, anon;
grant execute on function public.upsert_patient(text, text, integer, text, text, text) to authenticated;

drop function if exists public.find_patient_by_identifier(text);

create or replace function public.find_patient_by_identifier(p_identifier text)
returns table(id uuid, full_name text, gender text, age integer, tin_or_phone text, phone text, tin text, insurance_number text)
language sql
stable
security definer
set search_path = ''
as $$
  select p.id, p.full_name::text, p.gender::text, p.age,
         p.tin_or_phone::text, p.phone::text, p.tin::text, p.insurance_number::text
  from public.patients p
  where p.branch_id = public.current_branch_id()
    and (p.tin_or_phone = btrim(p_identifier)
      or p.phone        = btrim(p_identifier)
      or p.tin          = btrim(p_identifier))
  limit 1
$$;

revoke all on function public.find_patient_by_identifier(text) from public, anon;
grant execute on function public.find_patient_by_identifier(text) to authenticated;

drop function if exists public.list_branch_patients();

create or replace function public.list_branch_patients()
returns table(
  id uuid, full_name text, gender text, age integer, tin_or_phone text,
  phone text, tin text, insurance_number text, visit_count integer, last_visit_at timestamptz, lifetime_spend numeric
)
language sql
stable
security definer
set search_path = ''
as $$
  select
    p.id, p.full_name::text, p.gender::text, p.age, p.tin_or_phone::text,
    p.phone::text, p.tin::text, p.insurance_number::text,
    count(s.id)::integer, max(s.sold_at), coalesce(sum(s.total_amount), 0)
  from public.patients p
  left join public.sales s on s.patient_id = p.id
  where p.branch_id = public.current_branch_id()
  group by p.id, p.full_name, p.gender, p.age, p.tin_or_phone, p.phone, p.tin, p.insurance_number
  order by max(s.sold_at) desc nulls last, p.full_name
$$;

revoke all on function public.list_branch_patients() from public, anon;
grant execute on function public.list_branch_patients() to authenticated;

-- get_public_receipt() — expose the real discount amount and the true
-- final charged total. Until now this RPC's subtotal/taxTotal/
-- insuranceCoveredTotal were summed straight from sale_items and never
-- compared against sales.total_amount, so any sale that used a discount
-- code or a cashier-bargained final price (see complete_sale()) showed a
-- "grand total" that was too HIGH -- the pre-discount line-item sum, not
-- what was actually charged. Mirrors the exact same fix just made in
-- getSaleReceipt() (src/lib/sales.ts).
create or replace function public.get_public_receipt(p_sale_id uuid)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
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
  select s.branch_id, s.cashier_id, s.patient_id, s.receipt_note, s.total_amount
    into v_branch_id, v_cashier_id, v_patient_id, v_receipt_note, v_total_amount
    from public.sales s
    where s.id = p_sale_id;

  if not found then
    return null;
  end if;

  select r.receipt_number, r.issued_at
    into v_receipt_number, v_issued_at
    from public.receipts r
    where r.sale_id = p_sale_id;

  if not found then
    return null;
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
    'patientOwedTotal', v_final_owed,
    'grandTotal', v_subtotal + v_tax_total,
    'ebmSdcId', null,
    'ebmMrcNo', null,
    'ebmReceiptSignature', null,
    'ebmInvoiceNumber', null,
    'receiptNote', v_receipt_note
  );
end;
$$;

revoke all on function public.get_public_receipt(uuid) from public;
grant execute on function public.get_public_receipt(uuid) to anon, authenticated;

-- ============================================================================
-- EXPIRING-SOON NOTIFICATION (the actual missing piece)
-- ============================================================================
-- Already-expired stock was already fully handled before this block:
-- check_expired_stock() auto-writes it off (real stock_adjustments row +
-- notification + flips status to 'expired'), and complete_sale() separately,
-- unconditionally, hard-blocks selling anything past its expiry_date --
-- both were already live. What did NOT exist was a proactive warning
-- BEFORE that point -- branches.expiry_alert_threshold_days has existed as a
-- setting since the Inventory tab's "Stock Levels" work, but nothing ever
-- actually read it to raise a notification; it only ever drove passive
-- dashboard/report display. This adds that missing check, reusing the exact
-- same setting rather than inventing a second one.
--
-- One-shot per batch (like check_expired_stock(), unlike out_of_stock's
-- repeating reminder): expiry_warned_at is set the first time a batch is
-- found inside the warning window, so it is never re-notified on every
-- 30-second poll. A batch that still has zero sellable stock left (already
-- sold out) is skipped -- nothing useful to warn about there.

alter table public.stock_batches add column if not exists expiry_warned_at timestamptz;

create or replace function public.check_expiring_soon_stock()
returns integer
language plpgsql
security definer
set search_path = ''
as $$
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
$$;

revoke all on function public.check_expiring_soon_stock() from public, anon;
grant execute on function public.check_expiring_soon_stock() to authenticated;

-- ============================================================================
-- complete_sale() — a patient is mandatory for an insurance sale
-- ============================================================================
-- Real-world requirement: an insurance claim with no named patient behind it
-- isn't billable/auditable, so a cashier can no longer pick a provider and
-- check out on a bare "self-pay" style patient_id of null. Walk-in sales are
-- completely unaffected -- p_patient_id stays optional whenever
-- p_insurance_provider_id is null. Everything else below is byte-for-byte
-- the prior declaration; the only change is the new check right after the
-- provider is looked up.
create or replace function public.complete_sale(
  p_lines jsonb, p_insurance_provider_id uuid default null, p_patient_id uuid default null,
  p_payment_method text default null, p_discount_id uuid default null, p_bargain_final_price numeric default null
)
returns table(
  sale_id uuid, receipt_number text, total_amount numeric,
  insurance_covered_total numeric, patient_owed_total numeric
)
language plpgsql
security definer
set search_path = ''
as $$
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
  select u.branch_id into v_branch from public.users u where u.id = v_user and u.is_active;
  if v_branch is null then
    raise exception 'Only an active branch user may complete a sale';
  end if;
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
$$;

revoke all on function public.complete_sale(jsonb, uuid, uuid, text, uuid, numeric) from public, anon;
grant execute on function public.complete_sale(jsonb, uuid, uuid, text, uuid, numeric) to authenticated;

-- ============================================================================
-- INSURANCE PRICE LIST IMPORT — admin console upload (CSV/Excel)
-- ============================================================================
-- Lets an admin re-run the RHIA/MMI-style bulk import from the app itself
-- (Insurance tab -> "Upload Price List") instead of a one-off script, since
-- every insurer reissues their reimbursable-medicines list roughly every six
-- months. The browser (src/lib/insuranceImport.ts) does the file parsing,
-- header detection, and column-mapping guess; this function only ever
-- receives already-shaped rows and does the same idempotent upsert the first
-- RHIA import did by hand.
--
-- Product identity across re-imports is `[INS:<provider_id>:<drug_code>]` in
-- products.description -- NOT a free-text tag, so the admin never has to
-- know or type anything about it: picking the insurer from the dropdown IS
-- the identity. Re-uploading that same insurer's next revision six months
-- from now matches existing products by this marker and updates them in
-- place (new price, refreshed name) instead of creating duplicates.
--
-- One-time migration below: the very first RHIA import (done directly
-- against this database before this RPC existed) used a different marker
-- shape, '[RHIA:<drug_code>]'. Rewritten here to the '[INS:<provider_id>:...'
-- shape so it lines up with everything this function does from now on --
-- otherwise a future re-upload of MMI's list through the app would treat all
-- 1,446 of those products as new instead of updating them.
update public.products
set description = regexp_replace(description, '^\[RHIA:([^\]]+)\]', '[INS:5f42d232-5078-46ed-83d4-a6b987f309f8:\1]')
where description like '[RHIA:%';

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
    -- Defensive only -- the client (buildImportPreview()) has already
    -- filtered out rows missing these, this just guards a hand-built payload.
    if r.drug_code is null or r.product_name is null or r.price is null then
      continue;
    end if;

    v_description := '[INS:' || p_provider_id::text || ':' || r.drug_code || '] ' || coalesce(r.generic_name, r.product_name);

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

revoke all on function public.admin_import_insurance_price_list(uuid, uuid, jsonb) from public, anon;
grant execute on function public.admin_import_insurance_price_list(uuid, uuid, jsonb) to authenticated;

-- ============================================================================
-- complete_sale() — pharmacist-entered per-sale patient coverage percentage
-- ============================================================================
-- Real pharmacist feedback: insurance coverage is a property of the PATIENT'S
-- own plan, not of the product -- two patients on the same insurer buying the
-- same medicine can owe 10% and 25% respectively depending on their personal
-- plan/category. insurance_product_coverage (a per-provider, per-PRODUCT
-- override) and insurance_providers.default_coverage_percentage stay exactly
-- as they were and still apply whenever nothing else is specified -- this
-- just adds a per-sale override on top: the pharmacist types what the
-- PATIENT pays (e.g. "10"), and every line in this sale uses
-- 100 - p_patient_coverage_percentage as insurance's share instead of the
-- per-product/provider lookup. Only meaningful for an insurance sale; passing
-- it on a walk-in sale is rejected the same way a bargained price is
-- rejected on an insurance sale. Everything else below is byte-for-byte the
-- prior declaration.
--
-- Adding a new trailing parameter (even with a default) makes Postgres treat
-- this as a DIFFERENT overload rather than replacing the prior one in place
-- (the same reason every earlier complete_sale() signature change in this
-- file drops the old one first) -- without this, a 6-arg and 7-arg
-- complete_sale would exist side by side.
drop function if exists public.complete_sale(jsonb, uuid, uuid, text, uuid, numeric);
create or replace function public.complete_sale(
  p_lines jsonb, p_insurance_provider_id uuid default null, p_patient_id uuid default null,
  p_payment_method text default null, p_discount_id uuid default null, p_bargain_final_price numeric default null,
  p_patient_coverage_percentage numeric default null
)
returns table(
  sale_id uuid, receipt_number text, total_amount numeric,
  insurance_covered_total numeric, patient_owed_total numeric
)
language plpgsql
security definer
set search_path = ''
as $$
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
  select u.branch_id into v_branch from public.users u where u.id = v_user and u.is_active;
  if v_branch is null then
    raise exception 'Only an active branch user may complete a sale';
  end if;
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
$$;

revoke all on function public.complete_sale(jsonb, uuid, uuid, text, uuid, numeric, numeric) from public, anon;
grant execute on function public.complete_sale(jsonb, uuid, uuid, text, uuid, numeric, numeric) to authenticated;

-- ============================================================================
-- LOW STOCK (below reorder point) — recurring reminder, same shape as
-- check_out_of_stock_alerts() above
-- ============================================================================
-- check_out_of_stock_alerts() only ever fires at exactly zero stock -- there
-- was nothing warning a branch BEFORE it ran out, only after. This mirrors
-- that function exactly (same re-fire condition: silent while the last
-- notification for this variant is still unread, re-fires once
-- out_of_stock_reminder_hours has passed since it WAS read and the item is
-- still below its reorder point) but for "still has stock, just not enough" --
-- qty_available > 0 and < the product's reorder point (a per-product
-- reorder_points row for this branch, or branches.default_reorder_min when
-- none is set, exactly how ai_stock_status()'s 'low' status is computed).
-- Deliberately excludes qty_available = 0: that is check_out_of_stock_alerts()'s
-- job, not this one's -- otherwise a fully out-of-stock item would fire both.
create or replace function public.check_low_stock_alerts()
returns integer
language plpgsql
security definer
set search_path = ''
as $$
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
$$;

revoke all on function public.check_low_stock_alerts() from public, anon;
grant execute on function public.check_low_stock_alerts() to authenticated;

-- ============================================================================
-- ONBOARDING CHECKLIST — real usage, not a client-side "did they click next"
-- flag
-- ============================================================================
-- Backs the "Getting Started" card on the Overview dashboard: five genuinely
-- useful first tasks for a brand-new branch, each one a plain existence check
-- against the real tables that action actually writes to. Unlike the
-- one-shot GuidedTour (lib/tour.tsx, a client-only localStorage flag), this
-- reflects what the branch has actually DONE, so it stays correct even if
-- opened from a different device/browser than the one where the work happened.
create or replace function public.get_onboarding_progress()
returns table(
  received_stock boolean, completed_sale boolean, set_reorder_point boolean,
  added_patient boolean, invited_staff boolean
)
language sql
stable
security definer
set search_path = ''
as $$
  select
    exists(select 1 from public.stock_batches sb where sb.branch_id = public.current_branch_id()),
    exists(select 1 from public.sales s where s.branch_id = public.current_branch_id()),
    exists(select 1 from public.reorder_points rp where rp.branch_id = public.current_branch_id()),
    exists(select 1 from public.patients p where p.branch_id = public.current_branch_id()),
    (select count(*) from public.users u where u.branch_id = public.current_branch_id() and u.is_active) > 1
$$;

revoke all on function public.get_onboarding_progress() from public, anon;
grant execute on function public.get_onboarding_progress() to authenticated;

-- ============================================================================
-- ONBOARDING CHECKLIST — three more real-usage signals for the App.tsx
-- feature-discovery popup (FEATURE_DISCOVERY)
-- ============================================================================
-- Same function, three more columns -- a new output column changes the
-- function's return type, so (same reasoning as complete_sale()'s own
-- signature-change comment above) the prior 5-column declaration has to be
-- dropped first or both would exist side by side as distinct overloads.
--
-- These three are deliberately NOT added to the Getting Started checklist on
-- Overview -- that stays the five core "set up your branch" tasks. These are
-- "did you know" feature-discovery signals instead (see App.tsx's
-- FEATURE_DISCOVERY list): one popup at a time, picked from whichever of all
-- eight signals is still false, so growing this list doesn't make popups
-- show up more often -- it only broadens what might be picked.
drop function if exists public.get_onboarding_progress();
create or replace function public.get_onboarding_progress()
returns table(
  received_stock boolean, completed_sale boolean, set_reorder_point boolean,
  added_patient boolean, invited_staff boolean, used_discount boolean,
  created_category boolean, used_insurance boolean
)
language sql
stable
security definer
set search_path = ''
as $$
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
$$;

revoke all on function public.get_onboarding_progress() from public, anon;
grant execute on function public.get_onboarding_progress() to authenticated;
