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
