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
