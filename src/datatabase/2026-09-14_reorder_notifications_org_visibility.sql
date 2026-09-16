-- ============================================================================
-- Phase 2: missing-reorder-point nudges + org-wide notification/reorder-point
-- visibility for org_owner/org_manager
-- ============================================================================
-- Run once, after every prior file in this directory. Idempotent.
--
-- Three things:
--   1. check_missing_reorder_points() -- a new recurring, idempotent check
--      (same shape as check_out_of_stock_alerts()/check_license_expiry()):
--      any product with stock at this branch but no reorder_points row gets
--      a notification, re-fired at most once a week once read.
--   2. Fixes a real, pre-existing (if never yet triggered -- nothing in the
--      client calls it) bug: check_restock_recommendations() has always
--      inserted source_type = 'restock_recommendation', but that value was
--      never added to notifications_source_type_check, so every insert it
--      ever attempted would fail the check constraint. Added here alongside
--      the new 'reorder_point_missing' value.
--   3. notifications and reorder_points both widen their RLS so an
--      org_owner/org_manager sees/can-set them for EVERY branch in their
--      organization, not just their own -- this is what actually delivers
--      "expiring/out-of-stock/reorder notifications reach org_manager too"
--      and "org_manager can set reorder points for a specific product on any
--      branch": the per-branch check_*() functions keep running exactly as
--      before (triggered by that branch's own staff polling), this just
--      widens who can SEE the resulting rows and who can write a reorder
--      point, via public.is_org_member() (already used throughout the org
--      schema) rather than a same-branch-only check.
-- ============================================================================


-- ============================================================================
-- SECTION 1 — check_missing_reorder_points()
-- ============================================================================

create or replace function public.check_missing_reorder_points()
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
    select distinct p.id as product_id, p.name as product_name
    from public.stock_batches sb
    join public.product_variants pv on pv.id = sb.product_variant_id
    join public.products p on p.id = pv.product_id
    where sb.branch_id = v_branch
      and not exists (
        select 1 from public.reorder_points rp
        where rp.product_id = p.id and rp.branch_id = v_branch
      )
  loop
    select id, is_read, created_at into v_last
      from public.notifications
      where branch_id = v_branch and source_type = 'reorder_point_missing' and source_id = rec.product_id
      order by created_at desc
      limit 1;

    if not found or (v_last.is_read and v_last.created_at < now() - interval '7 days') then
      insert into public.notifications (branch_id, source_type, source_id, message)
      values (
        v_branch, 'reorder_point_missing', rec.product_id,
        format('%s has no reorder point set for this branch -- set one so low-stock alerts work for it.', rec.product_name)
      );
      v_created := v_created + 1;
    end if;
  end loop;

  return v_created;
end;
$$;

revoke all on function public.check_missing_reorder_points() from public;
grant execute on function public.check_missing_reorder_points() to authenticated;


-- ============================================================================
-- SECTION 2 — widen notifications_source_type_check (adds the missing
-- 'restock_recommendation' value plus the new 'reorder_point_missing')
-- ============================================================================

alter table public.notifications drop constraint if exists notifications_source_type_check;
alter table public.notifications add constraint notifications_source_type_check
  check (source_type in (
    'batch_recall','stock_adjustment','product_request_approved','product_request_rejected',
    'out_of_stock','license_expiring','forecast_completed','restock_recommendation','reorder_point_missing'
  ));


-- ============================================================================
-- SECTION 3 — org-wide visibility: notifications
-- ============================================================================
-- Overrides the generic "branch access" policy notifications got from the
-- shared do-loop near the top of pharmacy_schema_consolidated.sql, the same
-- way suppliers'/categories' policies were already overridden later in that
-- same file. `for all` is safe to widen here: the table grant is still only
-- `select, update` (see pharmacy_schema_consolidated.sql), so no client can
-- insert/delete a notification regardless of what this policy allows.

drop policy if exists "branch access" on public.notifications;
create policy "branch access" on public.notifications
for all to authenticated
using (
  public.is_super_admin()
  or branch_id = public.current_branch_id()
  or exists (
    select 1 from public.branches b
    where b.id = notifications.branch_id and b.organization_id is not null and public.is_org_member(b.organization_id)
  )
)
with check (
  public.is_super_admin()
  or branch_id = public.current_branch_id()
  or exists (
    select 1 from public.branches b
    where b.id = notifications.branch_id and b.organization_id is not null and public.is_org_member(b.organization_id)
  )
);


-- ============================================================================
-- SECTION 4 — org-wide reorder-point management
-- ============================================================================
-- reorder_points got its "branch access" policy from the same shared
-- do-loop; overridden here the same way. Table grant stays
-- `select, insert, update` (unchanged) -- see lib/inventory.ts's
-- upsertStockLevels(), which already takes an explicit branchId and needs no
-- code change, only this policy widening.

drop policy if exists "branch access" on public.reorder_points;
create policy "branch access" on public.reorder_points
for all to authenticated
using (
  public.is_super_admin()
  or branch_id = public.current_branch_id()
  or exists (
    select 1 from public.branches b
    where b.id = reorder_points.branch_id and b.organization_id is not null and public.is_org_member(b.organization_id)
  )
)
with check (
  public.is_super_admin()
  or branch_id = public.current_branch_id()
  or exists (
    select 1 from public.branches b
    where b.id = reorder_points.branch_id and b.organization_id is not null and public.is_org_member(b.organization_id)
  )
);
