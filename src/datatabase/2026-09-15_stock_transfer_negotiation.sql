-- ============================================================================
-- Stock transfer negotiation: targeted requests, per-branch accept/deny,
-- org_manager final approval
-- ============================================================================
-- Run once, after every prior file in this directory. Idempotent -- safe to
-- re-run, including on top of 2026-09-14_stock_needs_pull_request.sql if
-- that was already applied (this file drops and replaces every object it
-- introduced).
--
-- SUPERSEDES 2026-09-14_stock_needs_pull_request.sql (deleted -- do not run
-- it if you still have a copy). That file had org_manager proactively
-- search for a branch with stock and match it directly, with no consent
-- step from the source branch. The actual product decision is different:
--
--   1. The requesting branch's own manager picks ONE specific branch to ask
--      (not a broadcast) and states what they need.
--   2. That branch's manager reviews it and either ACCEPTS -- choosing
--      which of their own batches to send -- or DENIES with a required
--      reason.
--   3. If denied, the requesting branch picks a DIFFERENT branch and tries
--      again (repeat 1-2 as many times as needed; only one outstanding ask
--      at a time per request).
--   4. Once a branch accepts, an org_owner/org_manager gives one final
--      approval before anything actually moves.
--   5. From there the EXISTING, unmodified push-transfer lifecycle
--      (dispatch/receive) governs the physical movement: the source branch
--      still confirms hand-off, the requester still confirms arrival.
--
-- Two tables: stock_transfer_needs (the overall ask -- product, quantity,
-- who's asking) and stock_transfer_offers (one row per "asked branch X"
-- attempt, so the full negotiation history -- who was asked, in what
-- order, and why each no said no -- is never lost, not just the latest
-- attempt). A need has at most one 'pending' offer at a time, enforced by a
-- partial unique index, matching rule 3 above ("wait for an answer before
-- trying someone else").
-- ============================================================================


-- ============================================================================
-- SECTION 1 — tables
-- ============================================================================

drop table if exists public.stock_transfer_needs cascade;

create table public.stock_transfer_needs (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references public.pharmacy_organizations(id) on delete cascade,
  requesting_branch_id uuid not null references public.branches(id),
  product_variant_id uuid not null references public.product_variants(id),
  requested_quantity integer not null check (requested_quantity > 0),
  notes text,
  -- open: no accepted offer yet (either never asked, currently waiting on
  --   an answer, or was denied and needs a retry with a different branch --
  --   see the offers table for which of those it actually is).
  -- org_review: a branch accepted; waiting on org_owner/org_manager.
  -- fulfilling: approved -- a real stock_transfers row exists and is
  --   somewhere in its own pending/approved/in_transit lifecycle.
  -- fulfilled: the transfer was received.
  status varchar(20) not null default 'open' check (status in ('open', 'org_review', 'fulfilling', 'fulfilled')),
  transfer_id uuid references public.stock_transfers(id),
  requested_by uuid not null references public.users(id),
  created_at timestamptz not null default now()
);

create index idx_stock_transfer_needs_org_status on public.stock_transfer_needs (organization_id, status, created_at desc);
create index idx_stock_transfer_needs_branch on public.stock_transfer_needs (requesting_branch_id, created_at desc);

drop table if exists public.stock_transfer_offers cascade;

create table public.stock_transfer_offers (
  id uuid primary key default gen_random_uuid(),
  need_id uuid not null references public.stock_transfer_needs(id) on delete cascade,
  target_branch_id uuid not null references public.branches(id),
  status varchar(20) not null default 'pending' check (status in ('pending', 'accepted', 'denied')),
  -- Only set once accepted -- the SPECIFIC batches that branch is offering,
  -- chosen by them (only they know their own stock), handed straight to
  -- request_stock_transfer() once org approves.
  accepted_batch_ids uuid[],
  denial_reason text,
  responded_by uuid references public.users(id),
  responded_at timestamptz,
  created_at timestamptz not null default now()
);

create index idx_stock_transfer_offers_need on public.stock_transfer_offers (need_id, created_at desc);
create index idx_stock_transfer_offers_target on public.stock_transfer_offers (target_branch_id, status);

-- One outstanding ask at a time per request -- the requesting branch must
-- see the current answer before trying someone else.
create unique index idx_one_pending_offer_per_need on public.stock_transfer_offers (need_id) where status = 'pending';

alter table public.stock_transfer_needs enable row level security;
alter table public.stock_transfer_offers enable row level security;

create policy "org members and the requesting branch see a stock need" on public.stock_transfer_needs
for select to authenticated
using (
  public.is_super_admin()
  or public.is_org_member(organization_id)
  or requesting_branch_id = public.current_branch_id()
);

-- Also visible to the TARGET branch of an offer -- they need to see and act
-- on requests addressed to them even though they didn't raise the need.
create policy "org members, the requester, and the asked branch see an offer" on public.stock_transfer_offers
for select to authenticated
using (
  public.is_super_admin()
  or target_branch_id = public.current_branch_id()
  or exists (
    select 1 from public.stock_transfer_needs n
    where n.id = need_id and (public.is_org_member(n.organization_id) or n.requesting_branch_id = public.current_branch_id())
  )
);

-- No client insert/update grant on either -- every write goes through the
-- RPCs below.
grant select on public.stock_transfer_needs to authenticated;
grant select on public.stock_transfer_offers to authenticated;


-- ============================================================================
-- SECTION 2 — notification source types this adds
-- ============================================================================

alter table public.notifications drop constraint if exists notifications_source_type_check;
alter table public.notifications add constraint notifications_source_type_check
  check (source_type in (
    'batch_recall','stock_adjustment','product_request_approved','product_request_rejected',
    'out_of_stock','license_expiring','forecast_completed','restock_recommendation','reorder_point_missing',
    'stock_offer_requested','stock_offer_accepted','stock_offer_denied',
    'stock_need_awaiting_approval','stock_need_approved','stock_need_rejected','stock_need_fulfilled'
  ));


-- ============================================================================
-- SECTION 3 — widen request_stock_transfer() to allow acting on a different
-- branch's behalf (unchanged from 2026-09-14_stock_needs_pull_request.sql --
-- reapplied here so this file is self-sufficient whether or not that one
-- was ever run)
-- ============================================================================
-- p_from_branch_id omitted (or equal to the caller's own branch): IDENTICAL
-- behavior to the original proposal -- the caller must be that branch's own
-- active owner/manager. A DIFFERENT branch: only valid when the caller is
-- an org_owner/org_manager of THAT branch's organization. This is what
-- approve_stock_need() below uses -- the org_owner/org_manager who is not
-- physically at the accepting branch can still create the transfer on its
-- behalf; the accepting branch's own owner/manager still has to separately
-- confirm dispatch (dispatch_stock_transfer(), untouched), and the
-- requester still has to confirm receipt (receive_stock_transfer(),
-- untouched) -- matching real physical custody, not bypassing it.
drop function if exists public.request_stock_transfer(uuid, uuid[], text);
create or replace function public.request_stock_transfer(
  p_to_branch_id uuid, p_stock_batch_ids uuid[], p_notes text default null, p_from_branch_id uuid default null
)
returns uuid
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_user uuid := (select auth.uid());
  v_own_branch uuid;
  v_from_branch uuid;
  v_target_org uuid;
  v_organization uuid;
  v_transfer uuid;
  v_batch_id uuid;
begin
  select u.branch_id into v_own_branch
  from public.users u
  where u.id = v_user and u.is_active and u.role in ('owner', 'manager');
  if v_own_branch is null then
    raise exception 'Only an active branch manager or owner may request a stock transfer';
  end if;

  if p_from_branch_id is null or p_from_branch_id = v_own_branch then
    v_from_branch := v_own_branch;
  else
    select organization_id into v_target_org from public.branches where id = p_from_branch_id;
    if v_target_org is null then raise exception 'Unknown source branch'; end if;
    perform public.assert_org_member(v_target_org);
    v_from_branch := p_from_branch_id;
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

revoke all on function public.request_stock_transfer(uuid, uuid[], text, uuid) from public, anon;
grant execute on function public.request_stock_transfer(uuid, uuid[], text, uuid) to authenticated;


-- ============================================================================
-- SECTION 4 — link a need's status to its transfer's outcome (receive/
-- reject/cancel, same signatures as the original proposal -- no drop needed)
-- ============================================================================

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

  if exists (select 1 from public.stock_transfer_needs where transfer_id = p_transfer_id) then
    update public.stock_transfer_needs set status = 'fulfilled' where transfer_id = p_transfer_id;

    insert into public.notifications (branch_id, source_type, source_id, message)
    select n.requesting_branch_id, 'stock_need_fulfilled', n.id,
      format('%s unit(s) of %s arrived from %s.', n.requested_quantity, concat_ws(' ', p.name, pv.dosage), fb.name)
    from public.stock_transfer_needs n
    join public.product_variants pv on pv.id = n.product_variant_id
    join public.products p on p.id = pv.product_id
    join public.branches fb on fb.id = v_transfer.from_branch_id
    where n.transfer_id = p_transfer_id;
  end if;
end;
$$;

-- A rejected/cancelled transfer that was serving an approved need reopens
-- that need (transfer_id cleared, status back to 'open') and marks the
-- offer that led to it as denied, with an explanatory reason -- so the
-- requesting branch can pick a different branch, and the negotiation
-- history still makes sense to anyone reading it back later.
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

  update public.stock_transfer_offers o
  set status = 'denied', denial_reason = coalesce(nullif(btrim(coalesce(p_reason, '')), ''), 'The arranged transfer was rejected')
  from public.stock_transfer_needs n
  where n.transfer_id = p_transfer_id and o.need_id = n.id and o.status = 'accepted';

  update public.stock_transfer_needs set status = 'open', transfer_id = null where transfer_id = p_transfer_id;
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

  update public.stock_transfer_offers o
  set status = 'denied', denial_reason = 'The sending branch cancelled the arranged transfer'
  from public.stock_transfer_needs n
  where n.transfer_id = p_transfer_id and o.need_id = n.id and o.status = 'accepted';

  update public.stock_transfer_needs set status = 'open', transfer_id = null where transfer_id = p_transfer_id;
end;
$$;


-- ============================================================================
-- SECTION 5 — request_stock_from_branch(): ask ONE specific branch
-- ============================================================================

create or replace function public.request_stock_from_branch(
  p_target_branch_id uuid, p_product_variant_id uuid, p_requested_quantity integer,
  p_notes text default null, p_branch_id uuid default null
)
returns uuid
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_user uuid := (select auth.uid());
  v_branch uuid;
  v_org uuid;
  v_target_org uuid;
  v_need uuid;
begin
  perform public.assert_owner_or_manager();
  v_branch := public.effective_branch_id(p_branch_id);
  if v_branch is null then raise exception 'No active branch for this session'; end if;
  if p_requested_quantity is null or p_requested_quantity < 1 then
    raise exception 'Requested quantity must be at least 1';
  end if;
  if not exists (select 1 from public.product_variants where id = p_product_variant_id) then
    raise exception 'Unknown product variant';
  end if;
  if p_target_branch_id = v_branch then
    raise exception 'Cannot request stock from your own branch';
  end if;

  select organization_id into v_org from public.branches where id = v_branch;
  if v_org is null then
    raise exception 'This branch does not belong to an organization -- stock requests require an organization';
  end if;
  select organization_id into v_target_org from public.branches where id = p_target_branch_id;
  if v_target_org is null or v_target_org <> v_org then
    raise exception 'That branch is not part of your organization';
  end if;

  insert into public.stock_transfer_needs (organization_id, requesting_branch_id, product_variant_id, requested_quantity, notes, requested_by)
  values (v_org, v_branch, p_product_variant_id, p_requested_quantity, nullif(btrim(coalesce(p_notes, '')), ''), v_user)
  returning id into v_need;

  insert into public.stock_transfer_offers (need_id, target_branch_id) values (v_need, p_target_branch_id);

  insert into public.notifications (branch_id, source_type, source_id, message)
  select p_target_branch_id, 'stock_offer_requested', v_need,
    format('%s is asking if you can send %s unit(s) of %s.', b.name, p_requested_quantity, concat_ws(' ', p.name, pv.dosage))
  from public.branches b
  join public.product_variants pv on pv.id = p_product_variant_id
  join public.products p on p.id = pv.product_id
  where b.id = v_branch;

  return v_need;
end;
$$;

revoke all on function public.request_stock_from_branch(uuid, uuid, integer, text, uuid) from public, anon;
grant execute on function public.request_stock_from_branch(uuid, uuid, integer, text, uuid) to authenticated;


-- ============================================================================
-- SECTION 6 — respond_to_stock_offer(): the asked branch accepts or denies
-- ============================================================================
-- Only the target branch's own active owner/manager may respond -- this is
-- deliberately NOT effective_branch_id()-aware (an org_owner/org_manager
-- cannot answer on a branch's behalf): whether a branch can spare stock is
-- a fact only that branch's own operator actually knows.

create or replace function public.respond_to_stock_offer(
  p_offer_id uuid, p_accept boolean, p_reason text default null, p_batch_ids uuid[] default null
)
returns void
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_user uuid := (select auth.uid());
  v_offer public.stock_transfer_offers%rowtype;
  v_need public.stock_transfer_needs%rowtype;
  v_own_branch uuid;
  v_batch_id uuid;
begin
  select * into v_offer from public.stock_transfer_offers where id = p_offer_id for update;
  if v_offer.id is null then raise exception 'Request not found'; end if;
  if v_offer.status <> 'pending' then raise exception 'This request has already been answered'; end if;

  select * into v_need from public.stock_transfer_needs where id = v_offer.need_id;
  if v_need.id is null then raise exception 'Stock request not found'; end if;

  select u.branch_id into v_own_branch
  from public.users u
  where u.id = v_user and u.is_active and u.role in ('owner', 'manager');
  if v_own_branch is null or v_own_branch <> v_offer.target_branch_id then
    raise exception 'Only the branch being asked may respond to this request';
  end if;

  if p_accept then
    if p_batch_ids is null or array_length(p_batch_ids, 1) is null then
      raise exception 'Choose at least one batch to offer';
    end if;
    foreach v_batch_id in array p_batch_ids loop
      if not exists (
        select 1 from public.stock_batches
        where id = v_batch_id and branch_id = v_own_branch and product_variant_id = v_need.product_variant_id
      ) then
        raise exception 'Batch % does not belong to this branch or does not match the requested product', v_batch_id;
      end if;
    end loop;

    update public.stock_transfer_offers
    set status = 'accepted', accepted_batch_ids = p_batch_ids, responded_by = v_user, responded_at = now()
    where id = p_offer_id;

    update public.stock_transfer_needs set status = 'org_review' where id = v_need.id;

    insert into public.notifications (branch_id, source_type, source_id, message)
    select v_need.requesting_branch_id, 'stock_offer_accepted', v_need.id,
      format('%s agreed to send %s. Waiting for organization approval.', b.name, concat_ws(' ', p.name, pv.dosage))
    from public.branches b
    join public.product_variants pv on pv.id = v_need.product_variant_id
    join public.products p on p.id = pv.product_id
    where b.id = v_own_branch;

    -- Reaches every org_owner/org_manager in the organization (not just one
    -- branch) via the org-wide notifications visibility already set up in
    -- 2026-09-14_reorder_notifications_org_visibility.sql -- branch_id here
    -- is "which branch this concerns", not who caused it. Worded neutrally
    -- ("needs approval", not "needs YOUR approval") since the org_owner sees
    -- this too but can only act on it while no org_manager exists yet (see
    -- assert_can_approve_stock_transfer()).
    insert into public.notifications (branch_id, source_type, source_id, message)
    select v_need.requesting_branch_id, 'stock_need_awaiting_approval', v_need.id,
      format('%s agreed to send %s unit(s) of %s to %s -- needs organization approval.',
        b_from.name, v_need.requested_quantity, concat_ws(' ', p.name, pv.dosage), b_to.name)
    from public.branches b_from
    join public.branches b_to on b_to.id = v_need.requesting_branch_id
    join public.product_variants pv on pv.id = v_need.product_variant_id
    join public.products p on p.id = pv.product_id
    where b_from.id = v_own_branch;
  else
    if nullif(btrim(coalesce(p_reason, '')), '') is null then
      raise exception 'A reason is required to decline';
    end if;

    update public.stock_transfer_offers
    set status = 'denied', denial_reason = btrim(p_reason), responded_by = v_user, responded_at = now()
    where id = p_offer_id;

    insert into public.notifications (branch_id, source_type, source_id, message)
    select v_need.requesting_branch_id, 'stock_offer_denied', v_need.id,
      format('%s declined your request for %s: %s', b.name, concat_ws(' ', p.name, pv.dosage), btrim(p_reason))
    from public.branches b
    join public.product_variants pv on pv.id = v_need.product_variant_id
    join public.products p on p.id = pv.product_id
    where b.id = v_own_branch;
  end if;
end;
$$;

revoke all on function public.respond_to_stock_offer(uuid, boolean, text, uuid[]) from public, anon;
grant execute on function public.respond_to_stock_offer(uuid, boolean, text, uuid[]) to authenticated;


-- ============================================================================
-- SECTION 7 — retry_stock_need(): the requester tries a different branch
-- ============================================================================

create or replace function public.retry_stock_need(p_need_id uuid, p_target_branch_id uuid)
returns uuid
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_user uuid := (select auth.uid());
  v_need public.stock_transfer_needs%rowtype;
  v_own_branch uuid;
  v_target_org uuid;
  v_offer uuid;
begin
  select * into v_need from public.stock_transfer_needs where id = p_need_id for update;
  if v_need.id is null then raise exception 'Stock request not found'; end if;
  if v_need.status <> 'open' then raise exception 'This request is not open for a new offer'; end if;

  select u.branch_id into v_own_branch
  from public.users u
  where u.id = v_user and u.is_active and u.role in ('owner', 'manager');
  if v_own_branch is null or v_own_branch <> v_need.requesting_branch_id then
    raise exception 'Only the requesting branch may pick another branch to ask';
  end if;

  if p_target_branch_id = v_need.requesting_branch_id then
    raise exception 'Cannot request stock from your own branch';
  end if;
  if exists (select 1 from public.stock_transfer_offers where need_id = p_need_id and status = 'pending') then
    raise exception 'There is already a pending request out for this -- wait for a response first';
  end if;

  select organization_id into v_target_org from public.branches where id = p_target_branch_id;
  if v_target_org is null or v_target_org <> v_need.organization_id then
    raise exception 'That branch is not part of your organization';
  end if;

  insert into public.stock_transfer_offers (need_id, target_branch_id) values (p_need_id, p_target_branch_id)
  returning id into v_offer;

  insert into public.notifications (branch_id, source_type, source_id, message)
  select p_target_branch_id, 'stock_offer_requested', v_need.id,
    format('%s is asking if you can send %s unit(s) of %s.', b.name, v_need.requested_quantity, concat_ws(' ', p.name, pv.dosage))
  from public.branches b
  join public.product_variants pv on pv.id = v_need.product_variant_id
  join public.products p on p.id = pv.product_id
  where b.id = v_need.requesting_branch_id;

  return v_offer;
end;
$$;

revoke all on function public.retry_stock_need(uuid, uuid) from public, anon;
grant execute on function public.retry_stock_need(uuid, uuid) to authenticated;


-- ============================================================================
-- SECTION 8 — approve_stock_need() / reject_stock_need(): the org's final say
-- ============================================================================
-- The final approval is the org_manager's call specifically, not the
-- org_owner's -- the owner's role here is oversight (they still see
-- everything via the org-wide notifications and lists already set up), not
-- action. The one exception: an organization with NO org_manager yet (the
-- one-org_manager-per-org cap means this is a real, ordinary state, not an
-- edge case) still needs SOMEONE able to approve, so the org_owner may act
-- only while no org_manager exists -- consistent with the org_owner acting
-- AS the org_manager until one is actually appointed, established
-- elsewhere in this schema's own role model.
create or replace function public.assert_can_approve_stock_transfer(p_organization_id uuid)
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
      raise exception 'Only the organization manager may approve or reject a stock transfer request';
    end if;
  else
    if v_caller_role not in ('org_owner', 'org_manager') then
      raise exception 'Only the organization owner or manager may approve or reject a stock transfer request';
    end if;
  end if;
end;
$$;

revoke all on function public.assert_can_approve_stock_transfer(uuid) from public, anon;
grant execute on function public.assert_can_approve_stock_transfer(uuid) to authenticated;


-- Creates the real stock_transfers row via request_stock_transfer() acting
-- on the accepting branch's behalf, immediately advances it to 'approved'
-- (one decisive action from the org's side, not two), and links it to the
-- need. Dispatch and receipt are separate, later, physical-custody steps --
-- unchanged.
create or replace function public.approve_stock_need(p_need_id uuid)
returns uuid
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_need public.stock_transfer_needs%rowtype;
  v_offer public.stock_transfer_offers%rowtype;
  v_transfer uuid;
begin
  select * into v_need from public.stock_transfer_needs where id = p_need_id for update;
  if v_need.id is null then raise exception 'Stock request not found'; end if;
  if v_need.status <> 'org_review' then raise exception 'This request is not awaiting approval'; end if;

  perform public.assert_can_approve_stock_transfer(v_need.organization_id);

  select * into v_offer from public.stock_transfer_offers
  where need_id = p_need_id and status = 'accepted'
  order by responded_at desc
  limit 1;
  if v_offer.id is null then raise exception 'No accepted offer found for this request'; end if;

  v_transfer := public.request_stock_transfer(
    v_need.requesting_branch_id, v_offer.accepted_batch_ids,
    format('Approved stock request %s', v_need.id), v_offer.target_branch_id
  );

  perform public.approve_stock_transfer(v_transfer);

  update public.stock_transfer_needs set status = 'fulfilling', transfer_id = v_transfer where id = p_need_id;

  insert into public.notifications (branch_id, source_type, source_id, message)
  select v_need.requesting_branch_id, 'stock_need_approved', p_need_id,
    format('Approved: %s will send %s. Waiting for dispatch.', b.name, concat_ws(' ', p.name, pv.dosage))
  from public.branches b
  join public.product_variants pv on pv.id = v_need.product_variant_id
  join public.products p on p.id = pv.product_id
  where b.id = v_offer.target_branch_id;

  insert into public.notifications (branch_id, source_type, source_id, message)
  select v_offer.target_branch_id, 'stock_need_approved', p_need_id,
    format('Your offer to send %s to %s was approved -- dispatch it when ready.', concat_ws(' ', p.name, pv.dosage), b.name)
  from public.branches b
  join public.product_variants pv on pv.id = v_need.product_variant_id
  join public.products p on p.id = pv.product_id
  where b.id = v_need.requesting_branch_id;

  return v_transfer;
end;
$$;

revoke all on function public.approve_stock_need(uuid) from public, anon;
grant execute on function public.approve_stock_need(uuid) to authenticated;


-- Sends an accepted-but-not-yet-approved request back to 'open' rather than
-- closing it outright, so the requesting branch can try a different branch
-- -- an org-level "no" to THIS pairing is not the same as "give up
-- entirely", which stays the requester's own call.
create or replace function public.reject_stock_need(p_need_id uuid, p_reason text default null)
returns void
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_need public.stock_transfer_needs%rowtype;
  v_offer public.stock_transfer_offers%rowtype;
begin
  select * into v_need from public.stock_transfer_needs where id = p_need_id for update;
  if v_need.id is null then raise exception 'Stock request not found'; end if;
  if v_need.status <> 'org_review' then raise exception 'This request is not awaiting approval'; end if;

  perform public.assert_can_approve_stock_transfer(v_need.organization_id);

  select * into v_offer from public.stock_transfer_offers
  where need_id = p_need_id and status = 'accepted'
  order by responded_at desc
  limit 1;

  if v_offer.id is not null then
    update public.stock_transfer_offers
    set status = 'denied', denial_reason = coalesce(nullif(btrim(coalesce(p_reason, '')), ''), 'Not approved by the organization')
    where id = v_offer.id;
  end if;

  update public.stock_transfer_needs set status = 'open' where id = p_need_id;

  insert into public.notifications (branch_id, source_type, source_id, message)
  select v_need.requesting_branch_id, 'stock_need_rejected', p_need_id,
    format('Your request for %s unit(s) of %s was not approved.%s', v_need.requested_quantity, concat_ws(' ', p.name, pv.dosage),
      case when nullif(btrim(coalesce(p_reason, '')), '') is not null then ' ' || btrim(p_reason) else '' end)
  from public.product_variants pv
  join public.products p on p.id = pv.product_id
  where pv.id = v_need.product_variant_id;
end;
$$;

revoke all on function public.reject_stock_need(uuid, text) from public, anon;
grant execute on function public.reject_stock_need(uuid, text) to authenticated;


-- ============================================================================
-- SECTION 9 — reading: needs (with their latest offer), incoming offers,
-- full offer history, and a branch's own batches for one product
-- ============================================================================

-- p_organization_id: org-wide view (org_owner/org_manager). Omitted: the
-- caller's own branch's own requests. Includes the LATEST offer's own state
-- so the UI can tell "waiting on an answer" from "was denied, needs a
-- retry" from "accepted, awaiting org approval" without a second call.
drop function if exists public.list_stock_needs(uuid, text);
create or replace function public.list_stock_needs(p_organization_id uuid default null, p_status text default null)
returns table(
  id uuid, requesting_branch_id uuid, requesting_branch_name text,
  product_variant_id uuid, product_name text, dosage text,
  requested_quantity integer, status text, notes text,
  transfer_id uuid, transfer_status text,
  latest_offer_id uuid, latest_offer_branch_id uuid, latest_offer_branch_name text,
  latest_offer_status text, latest_offer_denial_reason text,
  requested_by_name text, created_at timestamptz
)
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  v_branch uuid := public.current_branch_id();
begin
  if p_organization_id is not null then
    perform public.assert_org_member(p_organization_id);
  end if;

  return query
    select
      n.id, n.requesting_branch_id, rb.name::text,
      n.product_variant_id, p.name::text, pv.dosage::text,
      n.requested_quantity, n.status::text, n.notes,
      n.transfer_id, t.status::text,
      lo.id, lo.target_branch_id, ob.name::text, lo.status::text, lo.denial_reason,
      u.full_name::text, n.created_at
    from public.stock_transfer_needs n
    join public.branches rb on rb.id = n.requesting_branch_id
    join public.product_variants pv on pv.id = n.product_variant_id
    join public.products p on p.id = pv.product_id
    left join public.stock_transfers t on t.id = n.transfer_id
    left join public.users u on u.id = n.requested_by
    left join lateral (
      select o.* from public.stock_transfer_offers o where o.need_id = n.id order by o.created_at desc limit 1
    ) lo on true
    left join public.branches ob on ob.id = lo.target_branch_id
    where (p_organization_id is not null and n.organization_id = p_organization_id and (p_status is null or n.status = p_status))
       or (p_organization_id is null and n.requesting_branch_id = v_branch and (p_status is null or n.status = p_status))
    order by n.created_at desc;
end;
$$;

revoke all on function public.list_stock_needs(uuid, text) from public, anon;
grant execute on function public.list_stock_needs(uuid, text) to authenticated;


-- Every offer ever made for one need, oldest first -- the full negotiation
-- trail (who was asked, in what order, and why each "no" happened).
drop function if exists public.list_stock_need_offers(uuid);
create or replace function public.list_stock_need_offers(p_need_id uuid)
returns table(
  id uuid, target_branch_id uuid, target_branch_name text, status text,
  denial_reason text, responded_by_name text, responded_at timestamptz, created_at timestamptz
)
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  v_need public.stock_transfer_needs%rowtype;
  v_branch uuid := public.current_branch_id();
begin
  select * into v_need from public.stock_transfer_needs where id = p_need_id;
  if v_need.id is null then raise exception 'Stock request not found'; end if;
  if not (
    public.is_super_admin() or public.is_org_member(v_need.organization_id)
    or v_need.requesting_branch_id = v_branch
    or exists (select 1 from public.stock_transfer_offers o where o.need_id = p_need_id and o.target_branch_id = v_branch)
  ) then
    raise exception 'You do not have access to this request';
  end if;

  return query
    select o.id, o.target_branch_id, b.name::text, o.status::text,
      o.denial_reason, u.full_name::text, o.responded_at, o.created_at
    from public.stock_transfer_offers o
    join public.branches b on b.id = o.target_branch_id
    left join public.users u on u.id = o.responded_by
    where o.need_id = p_need_id
    order by o.created_at asc;
end;
$$;

revoke all on function public.list_stock_need_offers(uuid) from public, anon;
grant execute on function public.list_stock_need_offers(uuid) to authenticated;


-- Pending offers addressed to MY branch -- the "someone is asking you for
-- stock" inbox, for any owner/manager to act on regardless of whether they
-- hold an org role.
drop function if exists public.list_incoming_stock_offers(uuid);
create or replace function public.list_incoming_stock_offers(p_branch_id uuid default null)
returns table(
  id uuid, need_id uuid, requesting_branch_id uuid, requesting_branch_name text,
  product_variant_id uuid, product_name text, dosage text,
  requested_quantity integer, notes text, created_at timestamptz
)
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  v_branch uuid;
begin
  v_branch := public.effective_branch_id(p_branch_id);
  if v_branch is null then raise exception 'No active branch for this session'; end if;

  return query
    select
      o.id, n.id, n.requesting_branch_id, rb.name::text,
      n.product_variant_id, p.name::text, pv.dosage::text,
      n.requested_quantity, n.notes, o.created_at
    from public.stock_transfer_offers o
    join public.stock_transfer_needs n on n.id = o.need_id
    join public.branches rb on rb.id = n.requesting_branch_id
    join public.product_variants pv on pv.id = n.product_variant_id
    join public.products p on p.id = pv.product_id
    where o.target_branch_id = v_branch and o.status = 'pending'
    order by o.created_at asc;
end;
$$;

revoke all on function public.list_incoming_stock_offers(uuid) from public, anon;
grant execute on function public.list_incoming_stock_offers(uuid) to authenticated;


-- The specific batches at one branch for one variant -- what an accepting
-- branch picks from when responding "yes". FEFO order, same convention as
-- every other stock-consuming path in this schema.
--
-- Authorization is EITHER org membership OR being physically at that
-- branch -- deliberately not org-member-only. The accepting branch is
-- usually a plain owner/manager with no organization_members row at all
-- (most branches in a chain never need one), and they must be able to see
-- their OWN available batches to decide how to respond to an offer
-- addressed to them; an org_owner/org_manager can also look on any
-- branch's behalf for oversight.
drop function if exists public.list_branch_batches_for_variant(uuid, uuid);
create or replace function public.list_branch_batches_for_variant(p_branch_id uuid, p_product_variant_id uuid)
returns table(stock_batch_id uuid, batch_number text, expiry_date date, quantity_available integer)
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  v_org uuid;
begin
  select organization_id into v_org from public.branches where id = p_branch_id;
  if v_org is null then raise exception 'Unknown branch'; end if;
  if p_branch_id <> public.current_branch_id() then
    perform public.assert_org_member(v_org);
  end if;

  return query
    select
      sb.id, sb.batch_number::text, sb.expiry_date,
      coalesce(sum(bc.quantity_available * bc.pieces_per_pack) filter (where bc.barcode_type = 'pack' and bc.status = 'active'), 0)::integer
    from public.stock_batches sb
    left join public.barcodes bc on bc.stock_batch_id = sb.id
    where sb.branch_id = p_branch_id and sb.product_variant_id = p_product_variant_id
    group by sb.id, sb.batch_number, sb.expiry_date
    having coalesce(sum(bc.quantity_available * bc.pieces_per_pack) filter (where bc.barcode_type = 'pack' and bc.status = 'active'), 0) > 0
    order by sb.expiry_date asc;
end;
$$;

revoke all on function public.list_branch_batches_for_variant(uuid, uuid) from public, anon;
grant execute on function public.list_branch_batches_for_variant(uuid, uuid) to authenticated;


-- ============================================================================
-- SECTION 10 — let a plain branch owner/manager (no org_owner/org_manager
-- role of their own) actually reach and use this feature for their own
-- branch
-- ============================================================================
-- Every RPC above already worked for such a person EXCEPT list_organization_
-- branches() (assert_org_member-gated), which the requesting side needs to
-- pick a target branch to ask, and the org-wide approve/reject/list actions
-- (correctly still org-role-only -- unchanged). Also adds the one new
-- signal the frontend needs to even show them the tab at all: whether their
-- own branch belongs to an organization, independent of whether they hold
-- any role in it.

-- null unless the caller's own branch belongs to an organization -- true
-- even without an org_owner/org_manager role. get_my_organization() stays
-- exactly as it was (null for such a person, since they have no
-- organization_members row) -- this is a deliberately separate, narrower
-- signal used only to decide whether the Stock Transfers tab should show at
-- all, not a replacement for it.
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


-- Re-declared (same signature as 2026-09-09_organization_dashboard.sql's
-- version, no drop needed) with the widened check swapped in -- everything
-- else about the function is unchanged. Only name/address/phone/status/
-- staff_count are returned, nothing sensitive, so letting any branch in the
-- org see its siblings' listing (to pick a stock-transfer target) is safe.
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
  if not public.is_org_member_or_own_branch_in_org(p_organization_id) then
    raise exception 'You are not part of this organization';
  end if;
  return query
    select
      b.id, b.name::text, b.address, b.phone::text, b.branch_code::text, b.status::text,
      -- Excludes anyone whose real authority is org-level (a dedicated
      -- org_manager's technical anchor branch_id), same as
      -- list_branch_staff() -- otherwise a branch would show one extra
      -- "staff" member who never appears in its own roster.
      (select count(*)::integer from public.users u
        where u.branch_id = b.id
          and not exists (select 1 from public.organization_members m where m.user_id = u.id and m.role = 'org_manager')),
      b.created_at
    from public.branches b
    where b.organization_id = p_organization_id
    order by b.name;
end;
$$;

revoke all on function public.list_organization_branches(uuid) from public, anon;
grant execute on function public.list_organization_branches(uuid) to authenticated;
