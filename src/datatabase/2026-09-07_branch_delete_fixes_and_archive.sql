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
