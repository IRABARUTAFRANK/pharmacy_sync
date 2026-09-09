-- ============================================================================
-- Organization dashboard: stock transfers UI support, org settings, richer
-- branch/member listings
-- ============================================================================
-- Run once, AFTER PROPOSAL_multi_branch_organizations.sql,
-- 2026-09-09_organization_rbac.sql, and 2026-09-09_organization_first_
-- registration.sql have all already been applied. Idempotent -- safe to
-- re-run.
--
-- The stock-transfer workflow (request/approve/dispatch/receive/reject/
-- cancel) already exists in full in PROPOSAL_multi_branch_organizations.sql
-- -- nothing about that workflow changes here. What's missing is everything
-- an actual UI needs around it: an org-wide transfer list (the existing
-- list_branch_stock_transfers() only ever shows transfers touching the
-- CALLER's own branch, with no way to see the whole organization's activity,
-- and returns branch NAMES only, not ids, so a UI can't reliably tell which
-- side of a transfer the signed-in user's own branch is on), per-transfer
-- item detail (nothing today returns what's actually inside a transfer),
-- an "edit my organization's own profile" RPC (pharmacy_organizations has
-- been write-once since creation), and a staff count per branch (so the
-- Branches tab and the staffing modal know whether a branch already has an
-- owner before letting someone try to add a second one).
-- ============================================================================


-- ============================================================================
-- SECTION 1 — Stock transfers: org-wide list + item detail
-- ============================================================================

create or replace function public.list_organization_stock_transfers(p_organization_id uuid)
returns table(
  id uuid, from_branch_id uuid, from_branch_name text, to_branch_id uuid, to_branch_name text,
  status text, batch_count integer, requested_by_name text, notes text, rejection_reason text,
  requested_at timestamptz, received_at timestamptz
)
language plpgsql
stable
security definer
set search_path = ''
as $$
begin
  perform public.assert_org_member(p_organization_id);
  return query
    select
      t.id, t.from_branch_id, fb.name::text, t.to_branch_id, tb.name::text, t.status::text,
      (select count(*)::integer from public.stock_transfer_items i where i.transfer_id = t.id),
      u.full_name::text, t.notes, t.rejection_reason, t.requested_at, t.received_at
    from public.stock_transfers t
    join public.branches fb on fb.id = t.from_branch_id
    join public.branches tb on tb.id = t.to_branch_id
    left join public.users u on u.id = t.requested_by
    where t.organization_id = p_organization_id
    order by t.requested_at desc;
end;
$$;

-- Signature-compatible but the column LIST changes (from_branch_id/
-- to_branch_id added) -- a RETURNS TABLE column change requires dropping
-- the old function first, same discipline as everywhere else in this
-- schema. Re-declared with the same authorization as the original: any
-- signed-in user sees transfers where their own branch is sender or
-- receiver, no organization-wide visibility here (list_organization_
-- stock_transfers above is the org-wide equivalent).
drop function if exists public.list_branch_stock_transfers();
create or replace function public.list_branch_stock_transfers()
returns table(
  id uuid, from_branch_id uuid, from_branch_name text, to_branch_id uuid, to_branch_name text,
  status text, batch_count integer, requested_by_name text, notes text, rejection_reason text,
  requested_at timestamptz, received_at timestamptz
)
language sql
stable
security definer
set search_path = ''
as $$
  select
    t.id, t.from_branch_id, fb.name::text, t.to_branch_id, tb.name::text, t.status::text,
    (select count(*)::integer from public.stock_transfer_items i where i.transfer_id = t.id),
    u.full_name::text, t.notes, t.rejection_reason, t.requested_at, t.received_at
  from public.stock_transfers t
  join public.branches fb on fb.id = t.from_branch_id
  join public.branches tb on tb.id = t.to_branch_id
  left join public.users u on u.id = t.requested_by
  where t.from_branch_id = public.current_branch_id() or t.to_branch_id = public.current_branch_id()
  order by t.requested_at desc
$$;

-- What's actually inside a transfer -- product name, batch number, and how
-- much of it -- for the review step of requesting a transfer and for
-- showing reviewers what they're approving/receiving. Visible to the same
-- set of people who can see the transfer itself (super admin, either
-- involved branch, or any member of the owning organization).
create or replace function public.list_stock_transfer_items(p_transfer_id uuid)
returns table(stock_batch_id uuid, product_name text, batch_number text, quantity_available integer)
language plpgsql
stable
security definer
set search_path = ''
as $$
begin
  if not exists (
    select 1 from public.stock_transfers t
    where t.id = p_transfer_id
      and (
        public.is_super_admin()
        or t.from_branch_id = public.current_branch_id()
        or t.to_branch_id = public.current_branch_id()
        or public.is_org_member(t.organization_id)
      )
  ) then
    raise exception 'Transfer not found';
  end if;

  return query
    select
      sb.id, (p.name || coalesce(' ' || pv.dosage, ''))::text, sb.batch_number::text,
      coalesce((
        select sum(bc.quantity_available * bc.pieces_per_pack)
        from public.barcodes bc
        where bc.stock_batch_id = sb.id and bc.barcode_type = 'pack'
      ), 0)::integer
    from public.stock_transfer_items sti
    join public.stock_batches sb on sb.id = sti.stock_batch_id
    join public.product_variants pv on pv.id = sb.product_variant_id
    join public.products p on p.id = pv.product_id
    where sti.transfer_id = p_transfer_id;
end;
$$;

revoke all on function public.list_organization_stock_transfers(uuid) from public, anon;
grant execute on function public.list_organization_stock_transfers(uuid) to authenticated;
revoke all on function public.list_branch_stock_transfers() from public, anon;
grant execute on function public.list_branch_stock_transfers() to authenticated;
revoke all on function public.list_stock_transfer_items(uuid) from public, anon;
grant execute on function public.list_stock_transfer_items(uuid) to authenticated;


-- ============================================================================
-- SECTION 2 — Organization settings (pharmacy_organizations has been
-- write-once since creation until now)
-- ============================================================================

create or replace function public.update_organization_details(
  p_organization_id uuid, p_legal_name text, p_trade_name text, p_tin text
)
returns void
language plpgsql
security definer
set search_path = ''
as $$
begin
  perform public.assert_org_owner(p_organization_id);
  if nullif(btrim(coalesce(p_legal_name, '')), '') is null then
    raise exception 'A legal name is required';
  end if;

  update public.pharmacy_organizations
  set legal_name = btrim(p_legal_name),
      trade_name = nullif(btrim(coalesce(p_trade_name, '')), ''),
      tin = nullif(btrim(coalesce(p_tin, '')), '')
  where id = p_organization_id;
end;
$$;

revoke all on function public.update_organization_details(uuid, text, text, text) from public, anon;
grant execute on function public.update_organization_details(uuid, text, text, text) to authenticated;


-- ============================================================================
-- SECTION 3 — list_organization_branches gains a staff count
-- ============================================================================

-- Lets the Branches tab and the staffing modal show "No staff yet" vs "N
-- staff" and know, before even trying, whether a branch already has an
-- owner -- a branch can only ever have one (users_one_owner_per_branch),
-- and this is what the UI checks before offering that role as a choice.
drop function if exists public.list_organization_branches(uuid);
create or replace function public.list_organization_branches(p_organization_id uuid)
returns table(
  branch_id uuid, name text, address text, phone text, branch_code text, status text,
  staff_count integer, created_at timestamptz
)
language plpgsql
stable
security definer
set search_path = ''
as $$
begin
  perform public.assert_org_member(p_organization_id);
  return query
    select
      b.id, b.name::text, b.address, b.phone::text, b.branch_code::text, b.status::text,
      (select count(*)::integer from public.users u where u.branch_id = b.id),
      b.created_at
    from public.branches b
    where b.organization_id = p_organization_id
    order by b.name;
end;
$$;

revoke all on function public.list_organization_branches(uuid) from public, anon;
grant execute on function public.list_organization_branches(uuid) to authenticated;
