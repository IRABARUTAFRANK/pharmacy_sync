-- ============================================================================
-- CATCH-UP: one file that brings the database fully up to date
-- ============================================================================
-- RUN THIS ONE FILE. It is idempotent -- safe to run repeatedly, and safe
-- no matter which of the earlier dated files were or weren't applied.
--
-- Why this exists: this project has no migration runner, and several files
-- dated 2026-09-15 redeclare the SAME functions as each other (each
-- layering a further fix on top of an earlier one). Running a day's files
-- in plain alphabetical order silently ran some of them out of order, so a
-- later-alphabetically file's OLDER function body overwrote a newer fix.
-- Worse, some files were evidently never run at all -- proven by
-- "column b.latitude does not exist", which meant branches.latitude had
-- never been created even though functions referencing it had been.
--
-- Rather than asking anyone to replay a specific sequence of files, this
-- file contains the final, correct state of everything this session
-- touched, in dependency order (columns and constraints first, then
-- helpers, then the functions that call them). Every body below is copied
-- verbatim from the file named in its own section header -- except
-- org_change_member_role(), which is genuinely new here.
--
-- After running this, the following all work end to end:
--   - branch location pins save AND read back (the map stopped resetting)
--   - org-wide branch map + nearest-branch distance sorting
--   - a higher role's email is masked from a lower one, org AND branch level
--   - the super-admin Organizations tab (its missing RPC was silently
--     signing admins out -- see AdminPortal.tsx's own fix)
--   - promoting to org_manager, and moving someone back down to a branch role
-- ============================================================================


-- ============================================================================
-- SECTION 1 -- columns and constraints (must come before anything using them)
-- ============================================================================

alter table public.branches add column if not exists latitude double precision;
alter table public.branches add column if not exists longitude double precision;

-- ============================================================================
-- notification source types (branch_location_missing included)
-- ============================================================================

alter table public.notifications drop constraint if exists notifications_source_type_check;
alter table public.notifications add constraint notifications_source_type_check
  check (source_type in (
    'batch_recall','stock_adjustment','product_request_approved','product_request_rejected',
    'out_of_stock','license_expiring','forecast_completed','restock_recommendation','reorder_point_missing',
    'stock_offer_requested','stock_offer_accepted','stock_offer_denied',
    'stock_need_awaiting_approval','stock_need_approved','stock_need_rejected','stock_need_fulfilled',
    'branch_location_missing'
  ));


-- ============================================================================
-- SECTION 2 -- shared helpers (verbatim: org_manager_precedence_over_owner.sql,
-- stock_transfer_negotiation.sql)
-- ============================================================================

-- Same rule as assert_can_approve_stock_transfer(): if the organization has
-- an active org_manager, only that org_manager may act; otherwise the
-- org_owner may act as a fallback (there is always someone who can manage,
-- even before a manager is appointed).
create or replace function public.assert_can_manage_org_branch(p_organization_id uuid)
returns void
language plpgsql
stable
security definer
set search_path = ''
as $$
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
$$;

revoke all on function public.assert_can_manage_org_branch(uuid) from public, anon;
grant execute on function public.assert_can_manage_org_branch(uuid) to authenticated;


-- Convenience wrapper for the effective_branch_id() pattern: no-op for your
-- own branch (real owner/manager access there is untouched), otherwise
-- resolves the target branch's organization and applies the rule above.
-- p_effective_branch_id is trusted to already be org-membership-checked
-- (effective_branch_id() itself does that before ever returning a foreign
-- branch id), so the organization_id lookup here is just for the precedence
-- check, not a re-check of membership.
create or replace function public.assert_can_manage_org_branch_or_own(p_effective_branch_id uuid, p_own_branch_id uuid)
returns void
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  v_org_id uuid;
begin
  if p_effective_branch_id is null or p_effective_branch_id = p_own_branch_id then
    return;
  end if;

  select organization_id into v_org_id from public.branches where id = p_effective_branch_id;
  perform public.assert_can_manage_org_branch(v_org_id);
end;
$$;

revoke all on function public.assert_can_manage_org_branch_or_own(uuid, uuid) from public, anon;
grant execute on function public.assert_can_manage_org_branch_or_own(uuid, uuid) to authenticated;

create or replace function public.my_branch_organization_id()
returns uuid
language sql
stable
security definer
set search_path = ''
as $$
  select b.organization_id
  from public.users u
  join public.branches b on b.id = u.branch_id
  where u.id = (select auth.uid()) and u.is_active
$$;

revoke all on function public.my_branch_organization_id() from public, anon;
grant execute on function public.my_branch_organization_id() to authenticated;


-- Same authority as is_org_member(), plus "my own branch belongs to this
-- organization" -- deliberately not folded into is_org_member() itself,
-- since every OTHER caller of that function relies on it meaning "holds a
-- real org role", not merely "works somewhere in this org".
create or replace function public.is_org_member_or_own_branch_in_org(p_organization_id uuid)
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  select public.is_org_member(p_organization_id) or public.my_branch_organization_id() = p_organization_id
$$;

revoke all on function public.is_org_member_or_own_branch_in_org(uuid) from public, anon;
grant execute on function public.is_org_member_or_own_branch_in_org(uuid) to authenticated;


-- ============================================================================
-- SECTION 3 -- branch location (verbatim: 2026-09-15_branch_geolocation.sql)
-- ============================================================================

drop function if exists public.get_my_branch_details(uuid);
create or replace function public.get_my_branch_details(p_branch_id uuid default null)
returns table(
  name text, address text, phone text, tin text, logo_path text, bank_account_number text, bank_account_name text, momo_pay_number text,
  out_of_stock_reminder_hours integer, branch_code text, status text, created_at timestamptz,
  email text, website text, license_number text, license_expiry_date date, ebm_device_serial text, default_language text,
  receipt_number_prefix text, pos_cash_enabled boolean, pos_mtn_momo_enabled boolean, pos_airtel_money_enabled boolean,
  pos_card_enabled boolean, pos_insurance_enabled boolean, pos_default_payment_method text,
  pos_require_patient_name boolean, pos_allow_discounts boolean, pos_show_patient_history boolean,
  expiry_alert_threshold_days integer, default_reorder_min integer,
  latitude double precision, longitude double precision
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
         b.expiry_alert_threshold_days, b.default_reorder_min,
         b.latitude, b.longitude
  from public.branches b
  where b.id = public.effective_branch_id(p_branch_id)
$$;

revoke all on function public.get_my_branch_details(uuid) from public, anon;
grant execute on function public.get_my_branch_details(uuid) to authenticated;

create or replace function public.check_missing_branch_location()
returns integer
language plpgsql
security definer
set search_path = ''
as $$
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
$$;

revoke all on function public.check_missing_branch_location() from public, anon;
grant execute on function public.check_missing_branch_location() to authenticated;



-- ============================================================================
-- SECTION 4 -- role-hierarchy email masking (verbatim:
-- 2026-09-14_role_hierarchy_visibility.sql)
-- ============================================================================

-- still know who their organization's owner is, just not have their email
-- surfaced through this admin roster.
-- ============================================================================

create or replace function public.list_organization_people(p_organization_id uuid)
returns table(
  user_id uuid, full_name text, email text, scope text, role text,
  branch_id uuid, branch_name text, is_active boolean
)
language plpgsql
stable
security definer
set search_path = ''
as $$
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
      'organization'::text, m.role::text,
      null::uuid, null::text, u.is_active
    from public.organization_members m
    join public.users u on u.id = m.user_id
    where m.organization_id = p_organization_id
    union all
    select u.id, u.full_name::text, u.email::text, 'branch'::text, u.role::text,
      b.id, b.name::text, u.is_active
    from public.users u
    join public.branches b on b.id = u.branch_id
    where b.organization_id = p_organization_id
      and u.id not in (select om.user_id from public.organization_members om where om.organization_id = p_organization_id)
    order by 4, 5, 2;
end;
$$;

revoke all on function public.list_organization_people(uuid) from public, anon;
grant execute on function public.list_organization_people(uuid) to authenticated;


create or replace function public.list_organization_members(p_organization_id uuid)
returns table(user_id uuid, full_name text, email text, role text, created_at timestamptz)
language plpgsql
stable
security definer
set search_path = ''
as $$
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
$$;

revoke all on function public.list_organization_members(uuid) from public, anon;
grant execute on function public.list_organization_members(uuid) to authenticated;


-- ============================================================================
-- SECTION 5 -- org_manager assignment (verbatim:
-- 2026-09-15_org_manager_not_tied_to_branch.sql)
-- ============================================================================

drop function if exists public.invite_organization_member(uuid, uuid, text, text, text);
create or replace function public.invite_organization_member(
  p_organization_id uuid, p_user_email text, p_full_name text, p_role text default 'org_manager', p_branch_id uuid default null
)
returns text  -- 'granted' (existing user, immediate) or 'invited' (new person, pending OTP)
language plpgsql
security definer
set search_path = ''
as $$
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
$$;

revoke all on function public.invite_organization_member(uuid, text, text, text, uuid) from public, anon;
grant execute on function public.invite_organization_member(uuid, text, text, text, uuid) to authenticated;


-- ============================================================================
-- SECTION 6 -- super-admin organizations tab (verbatim:
-- 2026-09-15_admin_organizations.sql)
-- ============================================================================

create or replace function public.admin_list_organizations()
returns table(
  id uuid, legal_name text, trade_name text, tin text, status text,
  branch_count integer, created_at timestamptz
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
      o.id, o.legal_name::text, o.trade_name::text, o.tin::text, o.status::text,
      (select count(*)::integer from public.branches b where b.organization_id = o.id),
      o.created_at
    from public.pharmacy_organizations o
    order by o.created_at desc;
end;
$$;

revoke all on function public.admin_list_organizations() from public, anon;
grant execute on function public.admin_list_organizations() to authenticated;


create or replace function public.admin_set_organization_status(p_organization_id uuid, p_status text)
returns void
language plpgsql
security definer
set search_path = ''
as $$
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
$$;

revoke all on function public.admin_set_organization_status(uuid, text) from public, anon;
grant execute on function public.admin_set_organization_status(uuid, text) to authenticated;


-- ============================================================================
-- SECTION 7 -- changing an org member back to a branch role (NEW)
-- ============================================================================

-- ============================================================================
-- org_change_member_role(): promote to org_manager, OR move someone back down
-- to a branch role -- NEW in this file
-- ============================================================================
-- Until now the only org-level role action was invite_organization_member()
-- (one-way: grant org_manager) plus remove_organization_member() (revoke
-- entirely). There was no way to say "this person is no longer the
-- organization manager, make them a branch manager / salesperson instead"
-- without removing them and re-adding them from scratch. This is that
-- missing action, in one atomic call.
--
-- Demoting drops the organization_members row (so they stop being org-level
-- at all) and sets their branch-level users.role instead -- their branch_id
-- is untouched, so they land back at whichever branch they were already
-- anchored to, and list_branch_staff() starts surfacing them there again
-- the moment the org_manager row is gone (see that function's own
-- org_manager exclusion).
create or replace function public.org_change_member_role(
  p_organization_id uuid, p_user_id uuid, p_new_role text
)
returns void
language plpgsql
security definer
set search_path = ''
as $$
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
$$;

revoke all on function public.org_change_member_role(uuid, uuid, text) from public, anon;
grant execute on function public.org_change_member_role(uuid, uuid, text) to authenticated;


-- ============================================================================
-- SECTION 8 -- the five functions same-date ordering kept reverting
-- ============================================================================

-- ============================================================================
-- update_branch_details -- verbatim from 2026-09-15_branch_geolocation.sql
-- ============================================================================

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
  p_default_reorder_min integer default null,
  p_branch_id uuid default null,
  p_latitude double precision default null,
  p_longitude double precision default null
)
returns void
language plpgsql
security definer
set search_path = ''
as $$
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
      default_reorder_min = coalesce(p_default_reorder_min, default_reorder_min),
      latitude = p_latitude,
      longitude = p_longitude
  where id = v_branch;
end;
$$;

revoke all on function public.update_branch_details(
  text, text, text, text, text, text, text, integer, text, text, text, text, date, text, text, text,
  boolean, boolean, boolean, boolean, boolean, text, boolean, boolean, boolean, integer, integer, uuid,
  double precision, double precision
) from public, anon;
grant execute on function public.update_branch_details(
  text, text, text, text, text, text, text, integer, text, text, text, text, date, text, text, text,
  boolean, boolean, boolean, boolean, boolean, text, boolean, boolean, boolean, integer, integer, uuid,
  double precision, double precision
) to authenticated;


-- ============================================================================
-- list_organization_branches -- verbatim from 2026-09-15_branch_geolocation.sql
-- ============================================================================

drop function if exists public.list_organization_branches(uuid);
create or replace function public.list_organization_branches(p_organization_id uuid)
returns table(
  branch_id uuid, name text, address text, phone text, branch_code text, status text,
  staff_count integer, created_at timestamptz, latitude double precision, longitude double precision
)
language plpgsql
stable
security definer
set search_path = ''
as $$
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
$$;

revoke all on function public.list_organization_branches(uuid) from public, anon;
grant execute on function public.list_organization_branches(uuid) to authenticated;


-- ============================================================================
-- list_branch_staff -- verbatim from 2026-09-15_branch_staff_email_hierarchy.sql
-- ============================================================================

create or replace function public.list_branch_staff(p_branch_id uuid default null)
returns table(id uuid, full_name text, email text, role text, is_active boolean, created_at timestamptz)
language plpgsql
stable
security definer
set search_path = ''
as $$
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
      u.role::text, u.is_active, u.created_at
    from public.users u
    where u.branch_id = v_branch
      and not exists (select 1 from public.organization_members m where m.user_id = u.id and m.role = 'org_manager')
    order by u.role, u.full_name;
end;
$$;


-- ============================================================================
-- admin_set_seller_active -- verbatim from
-- 2026-09-15_org_manager_not_tied_to_branch.sql
-- ============================================================================

create or replace function public.admin_set_seller_active(p_user_id uuid, p_is_active boolean, p_branch_id uuid default null)
returns void
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_caller uuid := (select auth.uid());
  v_own_branch uuid;
  v_own_role text;
  v_branch uuid;
  v_caller_role text;
  v_target_role text;
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


-- ============================================================================
-- admin_update_staff_role -- verbatim from
-- 2026-09-15_org_manager_not_tied_to_branch.sql
-- ============================================================================

create or replace function public.admin_update_staff_role(p_user_id uuid, p_role text, p_branch_id uuid default null)
returns void
language plpgsql
security definer
set search_path = ''
as $$
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

  update public.users
  set role = p_role
  where id = p_user_id and branch_id = v_branch and role in ('manager', 'seller');
  if not found then raise exception 'Staff member not found for this branch'; end if;
end;
$$;
