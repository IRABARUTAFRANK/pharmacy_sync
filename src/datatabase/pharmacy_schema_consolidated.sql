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

-- The pharmacy's own tax ID, shown on every printed invoice from here on.
alter table public.branches add column if not exists tin varchar(20);

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

      v_subtotal := v_barcode.selling_price * v_child_quantity;
      v_tax_amount := round(v_subtotal * coalesce(v_tax_pct, 0) / 100, 2);
      v_line_total := v_subtotal + v_tax_amount;
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
          v_subtotal := v_barcode.selling_price * v_child.pieces_per_pack;
          v_tax_amount := round(v_subtotal * coalesce(v_tax_pct, 0) / 100, 2);
          v_line_total := v_subtotal + v_tax_amount;
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
          v_subtotal := v_barcode.selling_price * v_child.pieces_per_pack;
          v_tax_amount := round(v_subtotal * coalesce(v_tax_pct, 0) / 100, 2);
          v_line_total := v_subtotal + v_tax_amount;
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

        v_subtotal := v_barcode.selling_price * v_quantity;
        v_tax_amount := round(v_subtotal * coalesce(v_tax_pct, 0) / 100, 2);
        v_line_total := v_subtotal + v_tax_amount;
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

drop function if exists public.update_branch_details(text, text, text, text, text, text, text);
create or replace function public.update_branch_details(
  p_address text, p_phone text, p_tin text, p_logo_path text default null,
  p_bank_account_number text default null, p_bank_account_name text default null, p_momo_pay_number text default null,
  p_out_of_stock_reminder_hours integer default null
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

  update public.branches
  set address = nullif(btrim(coalesce(p_address, '')), ''),
      phone = nullif(btrim(coalesce(p_phone, '')), ''),
      tin = nullif(btrim(coalesce(p_tin, '')), ''),
      logo_path = nullif(btrim(coalesce(p_logo_path, '')), ''),
      bank_account_number = nullif(btrim(coalesce(p_bank_account_number, '')), ''),
      bank_account_name = nullif(btrim(coalesce(p_bank_account_name, '')), ''),
      momo_pay_number = nullif(btrim(coalesce(p_momo_pay_number, '')), ''),
      out_of_stock_reminder_hours = coalesce(p_out_of_stock_reminder_hours, out_of_stock_reminder_hours)
  where id = v_branch;
end;
$$;

revoke all on function public.update_branch_details(text, text, text, text, text, text, text, integer) from public, anon;
grant execute on function public.update_branch_details(text, text, text, text, text, text, text, integer) to authenticated;

drop function if exists public.get_my_branch_details();
create or replace function public.get_my_branch_details()
returns table(
  name text, address text, phone text, tin text, logo_path text, bank_account_number text, bank_account_name text, momo_pay_number text,
  out_of_stock_reminder_hours integer, branch_code text, status text, created_at timestamptz
)
language sql
stable
security definer
set search_path = ''
as $$
  select b.name::text, b.address, b.phone, b.tin, b.logo_path, b.bank_account_number, b.bank_account_name, b.momo_pay_number,
         b.out_of_stock_reminder_hours, b.branch_code::text, b.status::text, b.created_at
  from public.branches b
  where b.id = public.current_branch_id()
$$;

revoke all on function public.get_my_branch_details() from public, anon;
grant execute on function public.get_my_branch_details() to authenticated;

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
create or replace function public.list_branch_history(p_from timestamptz default null, p_to timestamptz default null)
returns table(
  event_at timestamptz, category text, title text, description text, amount numeric, actor_name text
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

  return query
  select s.sold_at, 'sale'::text, 'Sale completed'::text,
    format('Receipt %s%s', r.receipt_number, case when p.full_name is not null then ' -- ' || p.full_name else '' end),
    s.total_amount, u1.full_name::text
  from public.sales s
  join public.receipts r on r.sale_id = s.id
  left join public.patients p on p.id = s.patient_id
  left join public.users u1 on u1.id = s.cashier_id
  where s.branch_id = v_branch and (p_from is null or s.sold_at >= p_from) and (p_to is null or s.sold_at <= p_to)

  union all

  select sa.adjusted_at, 'stock_adjustment'::text, initcap(sa.adjustment_type),
    format('%s -- %s piece(s)%s', concat_ws(' ', pr1.name, pv1.dosage), sa.quantity, case when sa.reason is not null then ' -- ' || sa.reason else '' end),
    null::numeric, u2.full_name::text
  from public.stock_adjustments sa
  join public.stock_batches sb1 on sb1.id = sa.stock_batch_id
  join public.product_variants pv1 on pv1.id = sb1.product_variant_id
  join public.products pr1 on pr1.id = pv1.product_id
  left join public.users u2 on u2.id = sa.performed_by
  where sb1.branch_id = v_branch and (p_from is null or sa.adjusted_at >= p_from) and (p_to is null or sa.adjusted_at <= p_to)

  union all

  select sd.received_at, 'stock_received'::text, 'Stock delivery received'::text,
    format('%s from %s', sd.delivery_code, sup.supplier_name), null::numeric, u3.full_name::text
  from public.stock_deliveries sd
  join public.suppliers sup on sup.id = sd.supplier_id
  left join public.users u3 on u3.id = sd.received_by
  where sd.branch_id = v_branch and (p_from is null or sd.received_at >= p_from) and (p_to is null or sd.received_at <= p_to)

  union all

  select ic.submitted_at, 'insurance_claim'::text, 'Insurance claim filed'::text,
    format('%s -- %s', ip.name, initcap(ic.status)), ic.claim_amount, null::text
  from public.insurance_claims ic
  join public.sales s2 on s2.id = ic.sale_id
  join public.insurance_providers ip on ip.id = ic.insurance_provider_id
  where s2.branch_id = v_branch and (p_from is null or ic.submitted_at >= p_from) and (p_to is null or ic.submitted_at <= p_to)

  union all

  select pt.created_at, 'patient'::text, 'Patient registered'::text,
    pt.full_name::text, null::numeric, u4.full_name::text
  from public.patients pt
  left join public.users u4 on u4.id = pt.created_by
  where pt.branch_id = v_branch and (p_from is null or pt.created_at >= p_from) and (p_to is null or pt.created_at <= p_to)

  union all

  select pq.created_at, 'product_request'::text, 'Product request submitted'::text,
    left(pq.message, 140), null::numeric, u5.full_name::text
  from public.product_requests pq
  left join public.users u5 on u5.id = pq.requested_by
  where pq.branch_id = v_branch and (p_from is null or pq.created_at >= p_from) and (p_to is null or pq.created_at <= p_to)

  union all

  select us.created_at, 'staff'::text, 'Seller account created'::text,
    concat_ws(' ', us.full_name, '(' || us.email || ')'), null::numeric, null::text
  from public.users us
  where us.branch_id = v_branch and us.role = 'seller' and (p_from is null or us.created_at >= p_from) and (p_to is null or us.created_at <= p_to)

  union all

  select br.recalled_at, 'batch_recall'::text, 'Batch recalled'::text,
    format('%s -- %s', concat_ws(' ', pr2.name, pv2.dosage), br.reason), null::numeric, u6.full_name::text
  from public.batch_recalls br
  join public.product_variants pv2 on pv2.id = br.product_variant_id
  join public.products pr2 on pr2.id = pv2.product_id
  left join public.users u6 on u6.id = br.recalled_by
  where exists (
    select 1 from public.stock_batches sb2
    where sb2.product_variant_id = br.product_variant_id and sb2.batch_number = br.batch_number and sb2.branch_id = v_branch
  ) and (p_from is null or br.recalled_at >= p_from) and (p_to is null or br.recalled_at <= p_to)

  order by 1 desc
  limit 2000;
end;
$$;

revoke all on function public.list_branch_history(timestamptz, timestamptz) from public, anon;
grant execute on function public.list_branch_history(timestamptz, timestamptz) to authenticated;
