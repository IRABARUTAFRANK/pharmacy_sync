-- ============================================================================
-- FIX: add_branch_to_organization() never generated a branch_code
-- ============================================================================
-- register_first_branch() (2026-09-09_organization_first_registration.sql)
-- computes a real PSYNC-<LOC>-#### branch_code for a pharmacy's first
-- branch, but add_branch_to_organization() (an org owner adding a SECOND+
-- location, PROPOSAL_multi_branch_organizations.sql) never did the same --
-- it left branch_code null, which the Branch Directory screen renders as
-- "—". Confirmed live: "One Kayonza" (added this way) has no branch code
-- while "One Pharmacies" (the org's first, register_first_branch-created
-- branch) does.
--
-- Fix: port the exact same location-code + sequence logic here so every
-- branch, first or additional, gets a real branch_code.
-- ============================================================================

create or replace function public.add_branch_to_organization(
  p_organization_id uuid, p_pharmacy_name text, p_phone text, p_email text, p_location text
)
returns uuid
language plpgsql
security definer
set search_path = ''
as $$
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
$$;

-- One-time backfill: give every already-existing branch_code-less branch
-- (like "One Kayonza") a real code too, in creation order so the sequence
-- stays consistent with branches that already have one.
do $$
declare
  r record;
  v_loc text;
  v_seq int;
  v_code text;
begin
  for r in
    select b.id, b.address
    from public.branches b
    where b.branch_code is null
    order by b.id
  loop
    v_loc := upper(regexp_replace(split_part(coalesce(r.address, ''), ',', 1), '[^A-Za-z]', '', 'g'));
    if length(coalesce(v_loc, '')) < 3 then v_loc := rpad(coalesce(v_loc, ''), 3, 'X'); else v_loc := left(v_loc, 3); end if;

    select coalesce(max(substring(b2.branch_code from '[0-9]+$')::integer), 0) + 1
    into v_seq
    from public.branches b2
    where b2.branch_code ~ '^PSYNC-[A-Z]{3}-[0-9]{4}$';

    v_code := format('PSYNC-%s-%s', v_loc, lpad(v_seq::text, 4, '0'));
    update public.branches set branch_code = v_code where id = r.id;
  end loop;
end $$;
