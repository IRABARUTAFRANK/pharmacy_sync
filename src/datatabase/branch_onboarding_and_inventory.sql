-- PharmSync: pharmacy registration, 1:1 branch user, live receiving/barcodes.
-- Run after supabase_pharmacy_schema.sql (and stock_receiving_setup.sql if already applied).
-- Super admin: Authentication → user → App metadata → { "role": "super_admin" }
-- Email OTP: Authentication → Email templates → Magic Link, include {{ .Token }}

create extension if not exists pgcrypto;

-- ── Branch identity ───────────────────────────────────────────────────────────
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

create unique index if not exists users_one_per_branch
  on public.users (branch_id);

create table if not exists public.branch_directory (
  branch_id uuid primary key references public.branches(id) on delete cascade,
  display_name varchar(150) not null
);
alter table public.branch_directory enable row level security;
grant select on public.branch_directory to anon, authenticated;
drop policy if exists "branch directory is readable before sign-in" on public.branch_directory;
create policy "branch directory is readable before sign-in"
on public.branch_directory for select to anon, authenticated using (true);

alter table public.suppliers
  add column if not exists branch_id uuid references public.branches(id);

drop index if exists public.suppliers_name_ci_unique;
create unique index if not exists suppliers_branch_name_ci_unique
  on public.suppliers (branch_id, (lower(supplier_name)))
  where branch_id is not null;
create unique index if not exists suppliers_global_name_ci_unique
  on public.suppliers ((lower(supplier_name)))
  where branch_id is null;

-- ── Applications (pending pharmacies before they operate) ─────────────────────
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

create unique index if not exists branch_applications_open_email
  on public.branch_applications (lower(email))
  where status in ('pending','otp_sent');

create index if not exists branch_applications_status_submitted
  on public.branch_applications (status, submitted_at desc);

alter table public.branch_applications enable row level security;
grant select, insert, update on public.branch_applications to authenticated;
grant select on public.branch_applications to anon;

-- ── Helpers ───────────────────────────────────────────────────────────────────
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

-- ── Registration RPCs ─────────────────────────────────────────────────────────
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

revoke all on function public.submit_pharmacy_registration(text, text, text, text) from public;
grant execute on function public.submit_pharmacy_registration(text, text, text, text) to anon, authenticated;
revoke all on function public.get_pharmacy_application(uuid) from public;
grant execute on function public.get_pharmacy_application(uuid) to anon, authenticated;
revoke all on function public.can_request_pharmacy_otp(text) from public;
grant execute on function public.can_request_pharmacy_otp(text) to anon, authenticated;
revoke all on function public.activate_pharmacy_account() from public;
grant execute on function public.activate_pharmacy_account() to authenticated;

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

-- ── Catalog / stock visibility ────────────────────────────────────────────────
grant select on public.tax_rates, public.products, public.product_variants to authenticated;
grant select, insert, update on public.product_categories, public.branch_product_categorization,
  public.suppliers, public.stock_batches, public.barcodes, public.reorder_points to authenticated;
grant select on public.stock_deliveries to authenticated;

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

-- Tighten branch-scoped tables: super admin or own branch only
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

drop policy if exists "branch access" on public.branches;
create policy "branch access" on public.branches
for select to authenticated
using (public.is_super_admin() or id = public.current_branch_id());

drop policy if exists "users read own branch" on public.users;
create policy "users read own branch" on public.users
for select to authenticated
using (public.is_super_admin() or id = (select auth.uid()) or branch_id = public.current_branch_id());

-- ── Receiving: create products, branch categories, parent/child barcodes ──────
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
alter table public.stock_deliveries enable row level security;
drop policy if exists "delivery access" on public.stock_deliveries;
create policy "delivery access" on public.stock_deliveries
for all to authenticated
using (public.is_super_admin() or branch_id = public.current_branch_id())
with check (public.is_super_admin() or branch_id = public.current_branch_id());

alter table public.barcodes drop constraint if exists barcodes_packing_shape;
alter table public.barcodes add constraint barcodes_packing_shape check (
  (barcode_type = 'box' and parent_barcode_id is null and child_count is not null and child_count > 0 and pieces_per_pack is null)
  or
  (barcode_type = 'pack' and child_count is null and pieces_per_pack is not null and pieces_per_pack > 0)
);

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

revoke all on function public.receive_stock_delivery(text, text, jsonb) from public, anon;
grant execute on function public.receive_stock_delivery(text, text, jsonb) to authenticated;
