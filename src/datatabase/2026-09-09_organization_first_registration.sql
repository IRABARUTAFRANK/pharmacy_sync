-- ============================================================================
-- Organization-first public registration
-- ============================================================================
-- Run once, AFTER `PROPOSAL_multi_branch_organizations.sql` and
-- `2026-09-09_organization_rbac.sql` have both already been applied.
-- Idempotent -- safe to re-run.
--
-- Replaces the PUBLIC ENTRY POINT of pharmacy sign-up. Today, a brand-new
-- pharmacy registers as a single standalone branch with no organization
-- concept (public.branch_applications -> admin call+approve -> OTP ->
-- activate_pharmacy_account() -> one 'owner' tied to one branch). Going
-- forward, the public registration screen (src/pages/BranchPortal.tsx)
-- instead registers a COMPANY first, then a separate step registers that
-- company's first branch -- landing the applicant as an org_owner with one
-- branch, free to add more branches and assign org_manager/branch_manager
-- roles using everything already built in the two files named above.
--
-- Nothing here touches branch_applications/submit_pharmacy_registration/
-- activate_pharmacy_account -- this is purely additive. Any pre-existing
-- standalone branch, and any application already mid-flow through the old
-- functions, is completely unaffected.
--
-- The split worth stating explicitly: only legal_name/tin ever become
-- columns on pharmacy_organizations itself (which has no contact columns at
-- all -- see PROPOSAL_multi_branch_organizations.sql). phone/email/location
-- live only on organization_applications -- they exist so the super admin
-- has someone to call, and get reused as editable pre-filled defaults on
-- the "register your first branch" screen. This mirrors exactly how
-- branch_applications.phone/email/location today are both verification-
-- contact info AND the eventual branch's own contact columns.
-- ============================================================================


-- ============================================================================
-- SECTION 1 — organization_applications table
-- ============================================================================

create table if not exists public.organization_applications (
  id uuid primary key default gen_random_uuid(),
  application_code varchar(32) not null unique,
  legal_name varchar(200) not null,
  tin varchar(20),
  phone varchar(30) not null,
  email varchar(150) not null,
  location text not null,
  status varchar(20) not null default 'pending'
    check (status in ('pending', 'otp_sent', 'active', 'denied')),
  called_at timestamptz,
  denied_reason text,
  otp_sent_at timestamptz,
  -- Set at admin approval, mirroring branch_applications.branch_id.
  organization_id uuid references public.pharmacy_organizations(id),
  -- Set only once register_first_branch() succeeds. This is what
  -- distinguishes "OTP verified, no branch yet" from "fully done" -- status
  -- alone can't express it, since 'active' must mean "verified" the instant
  -- activate_organization_registration() runs, before any branch exists.
  first_branch_id uuid references public.branches(id),
  submitted_at timestamptz not null default now()
);

create unique index if not exists organization_applications_open_email
  on public.organization_applications (lower(email)) where status in ('pending', 'otp_sent');
create index if not exists organization_applications_status_submitted
  on public.organization_applications (status, submitted_at desc);

alter table public.organization_applications enable row level security;

-- Same shape as branch_applications' own RLS: direct table reads are
-- super-admin only, applicants reach their own row through security-definer
-- RPCs instead.
drop policy if exists "org applications readable by admin" on public.organization_applications;
create policy "org applications readable by admin" on public.organization_applications
for select to anon, authenticated
using (public.is_super_admin() or false);

drop policy if exists "super admin manage org applications" on public.organization_applications;
create policy "super admin manage org applications" on public.organization_applications
for all to authenticated
using (public.is_super_admin())
with check (public.is_super_admin());

grant select, insert, update on public.organization_applications to authenticated;
grant select on public.organization_applications to anon;


-- ============================================================================
-- SECTION 2 — Public application lifecycle (mirrors branch_applications')
-- ============================================================================

create or replace function public.submit_organization_registration(
  p_legal_name text, p_tin text, p_phone text, p_email text, p_location text
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
$$;

create or replace function public.admin_list_organization_applications()
returns table(
  id uuid, application_code text, legal_name text, tin text, phone text, email text,
  location text, status text, called_at timestamptz, denied_reason text,
  organization_id uuid, first_branch_id uuid, branch_code text, activation_code text,
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
      a.id, a.application_code::text, a.legal_name::text, a.tin::text, a.phone::text,
      a.email::text, a.location::text, a.status::text, a.called_at, a.denied_reason,
      a.organization_id, a.first_branch_id, b.branch_code::text, b.activation_code::text,
      a.submitted_at
    from public.organization_applications a
    left join public.branches b on b.id = a.first_branch_id
    order by a.submitted_at desc;
end;
$$;

create or replace function public.admin_mark_organization_called(p_application_id uuid)
returns void
language plpgsql
security definer
set search_path = ''
as $$
begin
  perform public.assert_super_admin();
  update public.organization_applications
  set called_at = now()
  where id = p_application_id and status = 'pending';
  if not found then
    raise exception 'Call can only be recorded on a pending application';
  end if;
end;
$$;

create or replace function public.admin_deny_organization_application(p_application_id uuid, p_reason text)
returns void
language plpgsql
security definer
set search_path = ''
as $$
begin
  perform public.assert_super_admin();
  update public.organization_applications
  set status = 'denied', denied_reason = nullif(btrim(p_reason), '')
  where id = p_application_id and status in ('pending', 'otp_sent');
  if not found then
    raise exception 'This application cannot be denied';
  end if;
end;
$$;

-- Unlike admin_approve_pharmacy_application (which creates a `branches` row
-- immediately, still pending its own OTP-driven activation), an organization
-- has no equivalent in-between state to be in -- pharmacy_organizations'
-- own status check only allows ('active','suspended'). There's nothing left
-- to verify about the ORGANIZATION itself once the admin has approved, so
-- it's created 'active' immediately -- the applicant's own OTP verification
-- gates activate_organization_registration()/register_first_branch()
-- instead, exactly the same way add_branch_to_organization() already treats
-- an org_owner-added branch as immediately active because the org itself
-- has already been vetted.
create or replace function public.admin_approve_organization_application(p_application_id uuid)
returns table(organization_id uuid, email text)
language plpgsql
security definer
set search_path = ''
as $$
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
$$;

create or replace function public.freeze_expired_organization_application(p_application_id uuid)
returns void
language plpgsql
security definer
set search_path = ''
as $$
begin
  update public.organization_applications
  set status = 'denied',
      denied_reason = 'Activation window (3 hours) expired without verification'
  where id = p_application_id
    and status = 'otp_sent'
    and otp_sent_at is not null
    and now() > otp_sent_at + interval '3 hours';
end;
$$;

-- Plain (volatile) plpgsql, NOT stable -- must call the freeze function
-- first, which runs an UPDATE. This schema's own can_request_pharmacy_otp()
-- was originally marked STABLE and broke under PostgREST's read-only
-- transaction wrapping for exactly this reason; not repeating that mistake
-- here. Drops the "already an active user" branch can_request_pharmacy_otp
-- has -- there is no equivalent state in this flow between OTP verification
-- and first-branch registration to check against.
create or replace function public.can_request_organization_registration_otp(p_email text)
returns boolean
language plpgsql
security definer
set search_path = ''
as $$
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
$$;

create or replace function public.get_organization_application(p_application_id uuid)
returns table(
  id uuid, application_code text, legal_name text, tin text, phone text, email text,
  location text, status text, called_at timestamptz, denied_reason text,
  organization_id uuid, first_branch_id uuid, branch_code text, activation_code text,
  submitted_at timestamptz
)
language plpgsql
security definer
set search_path = ''
as $$
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
$$;

-- Looks an application up by email, for the emailed activation link
-- (.../#branch?email=...), same reasoning as get_pharmacy_application_by_email.
create or replace function public.get_organization_application_by_email(p_email text)
returns table(
  id uuid, application_code text, legal_name text, tin text, phone text, email text,
  location text, status text, called_at timestamptz, denied_reason text,
  organization_id uuid, first_branch_id uuid, branch_code text, activation_code text,
  submitted_at timestamptz
)
language plpgsql
security definer
set search_path = ''
as $$
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
$$;

create or replace function public.admin_expire_stale_organization_applications()
returns integer
language plpgsql
security definer
set search_path = ''
as $$
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
$$;


-- ============================================================================
-- SECTION 3 — Activation and first-branch registration
-- ============================================================================

-- Runs right after the client's supabase.auth.verifyOtp(). Idempotent like
-- activate_pharmacy_account() (a public.users row already existing means
-- this session already finished register_first_branch() at some point --
-- return current state instead of erroring on a stray re-run). Deliberately
-- creates NOTHING in branches/users/organization_members: users.branch_id
-- stays NOT NULL, and no branch exists yet at this point, so there is
-- nothing valid to insert into public.users until register_first_branch()
-- runs. This function's only job is flipping the application to 'active'
-- and handing back the org + contact fields for the next screen to pre-fill.
create or replace function public.activate_organization_registration()
returns table(
  organization_id uuid, legal_name text, tin text, phone text, email text,
  location text, first_branch_id uuid
)
language plpgsql
security definer
set search_path = ''
as $$
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
$$;

-- The one genuinely new piece: atomically creates the first branch, the
-- applicant's own login, and their org_owner membership. Reuses
-- activate_pharmacy_account()'s exact branch_code/activation_code generator
-- and category/branch_directory seeding, unchanged.
--
-- p_full_name is the applicant's own personal name (NOT the business name)
-- -- deliberately a separate, required field. Once invite_organization_
-- member()/OrganizationPage.tsx show multiple real people side by side in
-- the Members list and audit log from day one, reusing the legal/business
-- name as the founding owner's own full_name (the way activate_pharmacy_
-- account() does today, where a lone owner never appears next to anyone
-- else) would look wrong the moment a second person is invited.
create or replace function public.register_first_branch(
  p_full_name text, p_pharmacy_name text, p_phone text, p_email text, p_location text
)
returns table(branch_id uuid, branch_code text, activation_code text, organization_id uuid, pharmacy_name text)
language plpgsql
security definer
set search_path = ''
as $$
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
$$;


-- ============================================================================
-- SECTION 4 — Admin console gap-fix: every branch, regardless of origin
-- ============================================================================

-- AdminPortal.tsx's Branch Directory/Security/Categories/Dashboard tabs all
-- source their branch list from admin_list_pharmacy_applications()'s join --
-- a branch created via add_branch_to_organization() or register_first_
-- branch() has no branch_applications row at all, so it was invisible to
-- those tabs even before this file. This is the fix: one read-only RPC that
-- lists every branch regardless of how it came to exist.
create or replace function public.admin_list_all_branches()
returns table(
  id uuid, name text, phone text, email text, address text, status text,
  branch_code text, activation_code text, failed_logins integer, locked_at timestamptz,
  organization_id uuid, organization_legal_name text, created_at timestamptz
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
      b.id, b.name::text, b.phone::text, b.email::text, b.address, b.status::text,
      b.branch_code::text, b.activation_code::text, coalesce(b.failed_logins, 0), b.locked_at,
      b.organization_id, o.legal_name::text, b.created_at
    from public.branches b
    left join public.pharmacy_organizations o on o.id = b.organization_id
    order by b.created_at desc;
end;
$$;


-- ============================================================================
-- SECTION 5 — Grants
-- ============================================================================

revoke all on function public.submit_organization_registration(text, text, text, text, text) from public;
grant execute on function public.submit_organization_registration(text, text, text, text, text) to anon, authenticated;

revoke all on function public.admin_list_organization_applications() from public;
grant execute on function public.admin_list_organization_applications() to authenticated;

revoke all on function public.admin_mark_organization_called(uuid) from public;
grant execute on function public.admin_mark_organization_called(uuid) to authenticated;

revoke all on function public.admin_deny_organization_application(uuid, text) from public;
grant execute on function public.admin_deny_organization_application(uuid, text) to authenticated;

revoke all on function public.admin_approve_organization_application(uuid) from public;
grant execute on function public.admin_approve_organization_application(uuid) to authenticated;

revoke all on function public.freeze_expired_organization_application(uuid) from public;

revoke all on function public.can_request_organization_registration_otp(text) from public;
grant execute on function public.can_request_organization_registration_otp(text) to anon, authenticated;

revoke all on function public.get_organization_application(uuid) from public;
grant execute on function public.get_organization_application(uuid) to anon, authenticated;

revoke all on function public.get_organization_application_by_email(text) from public;
grant execute on function public.get_organization_application_by_email(text) to anon, authenticated;

revoke all on function public.admin_expire_stale_organization_applications() from public;
grant execute on function public.admin_expire_stale_organization_applications() to authenticated;

revoke all on function public.activate_organization_registration() from public;
grant execute on function public.activate_organization_registration() to authenticated;

revoke all on function public.register_first_branch(text, text, text, text, text) from public;
grant execute on function public.register_first_branch(text, text, text, text, text) to authenticated;

revoke all on function public.admin_list_all_branches() from public;
grant execute on function public.admin_list_all_branches() to authenticated;
