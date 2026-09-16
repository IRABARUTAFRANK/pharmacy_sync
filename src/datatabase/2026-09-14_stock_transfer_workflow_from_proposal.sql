-- ============================================================================
-- Stock transfer workflow -- isolated from PROPOSAL_multi_branch_organizations.sql
-- ============================================================================
-- Run once, after every prior file in this directory. Idempotent -- safe to
-- re-run even if the workflow below is already live.
--
-- Context: PROPOSAL_multi_branch_organizations.sql already contains a full,
-- carefully-designed stock transfer workflow (this file's tables and first
-- six functions are copied VERBATIM from it, unchanged), and
-- 2026-09-09_organization_dashboard.sql already adds the org-wide list +
-- item-detail RPCs on top of it (also copied verbatim below, replacing the
-- proposal's own narrower 3-branch-name-only list_branch_stock_transfers()).
-- src/pages/OrganizationPage.tsx already has a complete UI built against
-- this exact API (RequestTransferModal, TransferRow, the Stock Transfers
-- tab) -- but src/lib/stockTransfers.ts, the file that UI imports from,
-- never existed, so the whole feature has been silently non-functional
-- (every action throws "module not found" at build time) regardless of
-- whether this SQL was ever applied. That file has now been written
-- (2026-09-14) to match this exact API.
--
-- This file exists so the stock-transfer portion specifically can be
-- (re-)applied on its own with confidence: PROPOSAL_multi_branch_
-- organizations.sql also contains organization-lifecycle functions
-- (create_pharmacy_organization, invite_organization_member,
-- get_my_organization, etc.) that HAVE since been superseded by later,
-- more evolved dated files (2026-09-09_organization_rbac.sql,
-- 2026-09-09_organization_roles_v2.sql, 2026-09-11_owner_manager_nav_
-- restrictions.sql) -- running the whole proposal file top-to-bottom today
-- risks re-installing those older, narrower versions alongside the newer
-- ones. This file only ever touches stock_transfers/stock_transfer_items
-- and their RPCs, none of which any later file has touched or superseded.
-- ============================================================================


-- ============================================================================
-- SECTION 1 — barcodes gains 'in_transit', and the two transfer tables
-- ============================================================================

-- A pack/box dispatched from its origin branch but not yet confirmed
-- received at its destination is neither this branch's sellable stock nor
-- that branch's yet -- it is physically in a vehicle. Without a distinct
-- status, a barcode still marked 'active' during that window would still be
-- sellable at the origin branch's POS even though the physical carton has
-- already left the building.
alter table public.barcodes drop constraint if exists barcodes_status_check;
alter table public.barcodes add constraint barcodes_status_check
  check (status in ('active', 'sold_out', 'expired', 'recalled', 'damaged', 'in_transit'));

-- One inter-branch stock movement, start to finish. Always between two
-- branches of the SAME organization -- enforced in the RPCs below.
create table if not exists public.stock_transfers (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references public.pharmacy_organizations(id),
  from_branch_id uuid not null references public.branches(id),
  to_branch_id uuid not null references public.branches(id),
  status varchar(20) not null default 'pending'
    check (status in ('pending', 'approved', 'in_transit', 'received', 'rejected', 'cancelled')),
  requested_by uuid not null references public.users(id),
  approved_by uuid references public.users(id),
  requested_at timestamptz not null default now(),
  approved_at timestamptz,
  dispatched_at timestamptz,
  received_at timestamptz,
  notes text,
  rejection_reason text,
  check (from_branch_id <> to_branch_id)
);

create index if not exists idx_stock_transfers_from on public.stock_transfers (from_branch_id, status);
create index if not exists idx_stock_transfers_to on public.stock_transfers (to_branch_id, status);
create index if not exists idx_stock_transfers_org on public.stock_transfers (organization_id, requested_at desc);

-- One row per WHOLE stock_batches row being moved by this transfer -- not
-- per unit, not per barcode. A transfer moves entire batches, never a
-- partial split of one: every barcode in this schema is a physical printed
-- label, and moving a batch is just re-pointing its existing
-- stock_batches.branch_id (Section 2) -- every barcode already printed and
-- stuck on those boxes stays exactly as valid after the move as before it.
create table if not exists public.stock_transfer_items (
  id uuid primary key default gen_random_uuid(),
  transfer_id uuid not null references public.stock_transfers(id) on delete cascade,
  stock_batch_id uuid not null references public.stock_batches(id),
  unique (transfer_id, stock_batch_id)
);

create index if not exists idx_stock_transfer_items_batch on public.stock_transfer_items (stock_batch_id);

alter table public.stock_transfers enable row level security;
alter table public.stock_transfer_items enable row level security;

-- Visible to: the sending branch, the receiving branch, or any member of
-- the owning organization. Writes go through the RPCs in Section 2, each of
-- which re-derives and re-checks who is allowed to act at every step.
drop policy if exists "transfer visible to involved branches or org" on public.stock_transfers;
create policy "transfer visible to involved branches or org" on public.stock_transfers
for select to authenticated
using (
  public.is_super_admin()
  or from_branch_id = public.current_branch_id()
  or to_branch_id = public.current_branch_id()
  or public.is_org_member(organization_id)
);

drop policy if exists "transfer items follow their transfer" on public.stock_transfer_items;
create policy "transfer items follow their transfer" on public.stock_transfer_items
for select to authenticated
using (
  exists (
    select 1 from public.stock_transfers t
    where t.id = transfer_id
      and (
        public.is_super_admin()
        or t.from_branch_id = public.current_branch_id()
        or t.to_branch_id = public.current_branch_id()
        or public.is_org_member(t.organization_id)
      )
  )
);

grant select on public.stock_transfers to authenticated;
grant select on public.stock_transfer_items to authenticated;


-- ============================================================================
-- SECTION 2 — workflow RPCs: request, approve, dispatch, receive, reject,
-- cancel
-- ============================================================================
-- pending -> approved -> in_transit -> received
--        \-> rejected (before dispatch only)      \-> rejected (before dispatch only)
--        \-> cancelled (before dispatch only)
-- Once a transfer is in_transit, it can only ever resolve to received --
-- reversing a shipment that has physically left a building is a real-world
-- logistics problem (loss, damage, a wrong turn), not a status flip.

-- Raised by the SENDING branch's own owner/manager. Every batch listed must
-- already belong to the caller's own current_branch_id(), and the
-- destination must be a different branch in the SAME organization.
create or replace function public.request_stock_transfer(
  p_to_branch_id uuid, p_stock_batch_ids uuid[], p_notes text default null
)
returns uuid
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_user uuid := (select auth.uid());
  v_from_branch uuid;
  v_organization uuid;
  v_transfer uuid;
  v_batch_id uuid;
begin
  select u.branch_id into v_from_branch
  from public.users u
  where u.id = v_user and u.is_active and u.role in ('owner', 'manager');
  if v_from_branch is null then
    raise exception 'Only an active branch manager or owner may request a stock transfer';
  end if;
  if v_from_branch = p_to_branch_id then
    raise exception 'Cannot transfer stock to the same branch';
  end if;

  select organization_id into v_organization from public.branches where id = v_from_branch;
  if v_organization is null or v_organization <> (select organization_id from public.branches where id = p_to_branch_id) then
    raise exception 'The destination branch is not part of the same organization';
  end if;

  if p_stock_batch_ids is null or array_length(p_stock_batch_ids, 1) is null then
    raise exception 'At least one stock batch is required';
  end if;

  insert into public.stock_transfers (organization_id, from_branch_id, to_branch_id, requested_by, notes)
  values (v_organization, v_from_branch, p_to_branch_id, v_user, nullif(btrim(coalesce(p_notes, '')), ''))
  returning id into v_transfer;

  foreach v_batch_id in array p_stock_batch_ids loop
    if not exists (select 1 from public.stock_batches where id = v_batch_id and branch_id = v_from_branch) then
      raise exception 'Batch % does not belong to this branch', v_batch_id;
    end if;
    insert into public.stock_transfer_items (transfer_id, stock_batch_id) values (v_transfer, v_batch_id);
  end loop;

  return v_transfer;
end;
$$;

-- Either the RECEIVING branch's own owner/manager (they are agreeing to
-- take the stock in) or any org member (central oversight) may approve.
create or replace function public.approve_stock_transfer(p_transfer_id uuid)
returns void
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_transfer public.stock_transfers%rowtype;
  v_user uuid := (select auth.uid());
begin
  select * into v_transfer from public.stock_transfers where id = p_transfer_id;
  if v_transfer.id is null then raise exception 'Transfer not found'; end if;
  if v_transfer.status <> 'pending' then raise exception 'Only a pending transfer can be approved'; end if;

  if not (
    public.is_org_member(v_transfer.organization_id)
    or exists (
      select 1 from public.users u
      where u.id = v_user and u.is_active and u.role in ('owner', 'manager') and u.branch_id = v_transfer.to_branch_id
    )
  ) then
    raise exception 'Only the receiving branch or an organization member may approve this transfer';
  end if;

  update public.stock_transfers
  set status = 'approved', approved_by = v_user, approved_at = now()
  where id = p_transfer_id;
end;
$$;

-- The SENDING branch confirms physical hand-off -- the moment every
-- transferred batch's active packs stop being sellable at the origin.
create or replace function public.dispatch_stock_transfer(p_transfer_id uuid)
returns void
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_transfer public.stock_transfers%rowtype;
  v_from_branch uuid;
begin
  select * into v_transfer from public.stock_transfers where id = p_transfer_id;
  if v_transfer.id is null then raise exception 'Transfer not found'; end if;
  if v_transfer.status <> 'approved' then raise exception 'Only an approved transfer can be dispatched'; end if;

  select u.branch_id into v_from_branch
  from public.users u
  where u.id = (select auth.uid()) and u.is_active and u.role in ('owner', 'manager');
  if v_from_branch is null or v_from_branch <> v_transfer.from_branch_id then
    raise exception 'Only the sending branch may dispatch this transfer';
  end if;

  update public.barcodes
  set status = 'in_transit'
  where status = 'active'
    and stock_batch_id in (select stock_batch_id from public.stock_transfer_items where transfer_id = p_transfer_id);

  update public.stock_transfers set status = 'in_transit', dispatched_at = now() where id = p_transfer_id;
end;
$$;

-- The RECEIVING branch confirms the stock has physically arrived. Moves
-- every transferred batch's branch_id to the destination -- no new
-- barcodes, no cloned batch rows, the exact same printed labels that left
-- the origin branch are what the destination branch now owns.
create or replace function public.receive_stock_transfer(p_transfer_id uuid)
returns void
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_transfer public.stock_transfers%rowtype;
  v_to_branch uuid;
  v_item record;
begin
  select * into v_transfer from public.stock_transfers where id = p_transfer_id;
  if v_transfer.id is null then raise exception 'Transfer not found'; end if;
  if v_transfer.status <> 'in_transit' then raise exception 'Only a transfer that is in transit can be received'; end if;

  select u.branch_id into v_to_branch
  from public.users u
  where u.id = (select auth.uid()) and u.is_active and u.role in ('owner', 'manager');
  if v_to_branch is null or v_to_branch <> v_transfer.to_branch_id then
    raise exception 'Only the receiving branch may confirm this transfer';
  end if;

  for v_item in
    select sti.stock_batch_id, sb.product_variant_id, sb.batch_number
    from public.stock_transfer_items sti
    join public.stock_batches sb on sb.id = sti.stock_batch_id
    where sti.transfer_id = p_transfer_id
  loop
    if exists (
      select 1 from public.stock_batches sb2
      where sb2.branch_id = v_to_branch
        and sb2.product_variant_id = v_item.product_variant_id
        and sb2.batch_number = v_item.batch_number
        and sb2.id <> v_item.stock_batch_id
    ) then
      raise exception 'Batch number % for this product already exists at the receiving branch -- resolve the clash before receiving this transfer', v_item.batch_number;
    end if;

    update public.stock_batches set branch_id = v_to_branch where id = v_item.stock_batch_id;

    update public.barcodes
    set status = 'active'
    where status = 'in_transit' and stock_batch_id = v_item.stock_batch_id;
  end loop;

  update public.stock_transfers set status = 'received', received_at = now() where id = p_transfer_id;
end;
$$;

-- Only before dispatch -- once stock has physically left the building, this
-- workflow does not support reversing an in-transit shipment.
create or replace function public.reject_stock_transfer(p_transfer_id uuid, p_reason text default null)
returns void
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_transfer public.stock_transfers%rowtype;
begin
  select * into v_transfer from public.stock_transfers where id = p_transfer_id;
  if v_transfer.id is null then raise exception 'Transfer not found'; end if;
  if v_transfer.status not in ('pending', 'approved') then
    raise exception 'Only a pending or approved transfer can be rejected';
  end if;
  if not (
    public.is_org_member(v_transfer.organization_id)
    or exists (
      select 1 from public.users u
      where u.id = (select auth.uid()) and u.is_active and u.role in ('owner', 'manager') and u.branch_id = v_transfer.to_branch_id
    )
  ) then
    raise exception 'Only the receiving branch or an organization member may reject this transfer';
  end if;

  update public.stock_transfers
  set status = 'rejected', rejection_reason = nullif(btrim(coalesce(p_reason, '')), '')
  where id = p_transfer_id;
end;
$$;

create or replace function public.cancel_stock_transfer(p_transfer_id uuid)
returns void
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_transfer public.stock_transfers%rowtype;
  v_from_branch uuid;
begin
  select * into v_transfer from public.stock_transfers where id = p_transfer_id;
  if v_transfer.id is null then raise exception 'Transfer not found'; end if;
  if v_transfer.status not in ('pending', 'approved') then
    raise exception 'Only a pending or approved transfer can be cancelled';
  end if;

  select u.branch_id into v_from_branch
  from public.users u
  where u.id = (select auth.uid()) and u.is_active and u.role in ('owner', 'manager');
  if v_from_branch is null or v_from_branch <> v_transfer.from_branch_id then
    raise exception 'Only the sending branch may cancel this transfer';
  end if;

  update public.stock_transfers set status = 'cancelled' where id = p_transfer_id;
end;
$$;

revoke all on function public.request_stock_transfer(uuid, uuid[], text) from public, anon;
grant execute on function public.request_stock_transfer(uuid, uuid[], text) to authenticated;
revoke all on function public.approve_stock_transfer(uuid) from public, anon;
grant execute on function public.approve_stock_transfer(uuid) to authenticated;
revoke all on function public.dispatch_stock_transfer(uuid) from public, anon;
grant execute on function public.dispatch_stock_transfer(uuid) to authenticated;
revoke all on function public.receive_stock_transfer(uuid) from public, anon;
grant execute on function public.receive_stock_transfer(uuid) to authenticated;
revoke all on function public.reject_stock_transfer(uuid, text) from public, anon;
grant execute on function public.reject_stock_transfer(uuid, text) to authenticated;
revoke all on function public.cancel_stock_transfer(uuid) from public, anon;
grant execute on function public.cancel_stock_transfer(uuid) to authenticated;


-- ============================================================================
-- SECTION 3 — reading transfers: org-wide list, branch list (with ids), item
-- detail
-- ============================================================================
-- from_branch_id/to_branch_id are what let a UI reliably tell which side of
-- a transfer the signed-in user's own branch is on (branch NAMES alone
-- can't be compared against current_branch_id()).

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
-- showing reviewers what they're approving/receiving.
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
      sti.stock_batch_id, p.name::text, sb.batch_number::text,
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
