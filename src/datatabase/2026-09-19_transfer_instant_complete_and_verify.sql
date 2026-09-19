-- ============================================================================
-- STOCK TRANSFERS: approving now completes the transfer, no dispatch/receive
-- scan step; a lightweight "Verify" ticket replaces it. STOCK REQUESTS:
-- the organization no longer approves them, only sees an FYI notification.
-- ============================================================================
-- Run once, after every prior file in this directory. Idempotent except for
-- the one-time backfill block at the bottom, which is itself idempotent
-- (only touches rows still in the old 'approved'/'in_transit' states).
--
-- OLD flow: request -> approved (org/receiving branch signs off) ->
-- in_transit (sending branch scans the package out) -> received (receiving
-- branch scans it back in). Two real-world problems with this: an
-- org_owner/org_manager approving a transfer from the Organization dashboard
-- is never physically standing at the sending branch holding the boxes, so
-- they ended up doing the barcode-by-barcode "Dispatch" scan themselves,
-- remotely, which is both tedious and meaningless (they can't actually
-- verify what's in front of them). And for stock REQUESTS specifically,
-- requiring the organization to separately approve an offer the target
-- branch had *already agreed to send* was a redundant extra step.
--
-- NEW flow: request -> approved, which now means DONE -- the same action
-- that used to just flip a status now also moves every batch to the
-- receiving branch's stock, in one atomic step. dispatch_stock_transfer()/
-- receive_stock_transfer() are gone; there is nothing left for them to do.
-- A new verify_stock_transfer() lets the receiving branch confirm
-- afterwards (confirmed / not received / damaged) -- purely a paper trail,
-- it never undoes the movement that already happened.
--
-- For stock requests (stock_transfer_needs/offers): accepting an offer
-- (respond_to_stock_offer, p_accept = true) now creates AND completes the
-- underlying transfer immediately, the same way approve_stock_transfer()
-- does for a manually-requested one. approve_stock_need()/reject_stock_need()
-- and the 'org_review' status they gated are gone -- there is nothing left
-- to approve. request_stock_from_branch() now also tells the organization
-- (FYI only, no action implied) the moment a branch asks another for stock.
-- ============================================================================

alter table public.stock_transfers
  add column if not exists verify_status text not null default 'pending'
    check (verify_status in ('pending', 'confirmed', 'not_received', 'damaged')),
  add column if not exists verified_by uuid references public.users(id),
  add column if not exists verified_at timestamptz,
  add column if not exists verify_notes text;

drop function if exists public.dispatch_stock_transfer(uuid);
drop function if exists public.receive_stock_transfer(uuid);
drop function if exists public.approve_stock_need(uuid);
drop function if exists public.reject_stock_need(uuid);
drop function if exists public.assert_can_approve_stock_transfer(uuid);

-- Approving IS completing, in one step: every batch moves to the receiving
-- branch right away, and a verify ticket goes out. Same authorization as
-- before (the receiving branch's own owner/manager, or any org member).
create or replace function public.approve_stock_transfer(p_transfer_id uuid)
returns void
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_transfer public.stock_transfers%rowtype;
  v_user uuid := (select auth.uid());
  v_item record;
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

  for v_item in
    select sti.stock_batch_id, sb.product_variant_id, sb.batch_number
    from public.stock_transfer_items sti
    join public.stock_batches sb on sb.id = sti.stock_batch_id
    where sti.transfer_id = p_transfer_id
  loop
    if exists (
      select 1 from public.stock_batches sb2
      where sb2.branch_id = v_transfer.to_branch_id
        and sb2.product_variant_id = v_item.product_variant_id
        and sb2.batch_number = v_item.batch_number
        and sb2.id <> v_item.stock_batch_id
    ) then
      raise exception 'Batch number % for this product already exists at the receiving branch -- resolve the clash before approving this transfer', v_item.batch_number;
    end if;

    update public.stock_batches set branch_id = v_transfer.to_branch_id where id = v_item.stock_batch_id;
  end loop;

  update public.stock_transfers
  set status = 'received', approved_by = v_user, approved_at = now(), received_at = now(), verify_status = 'pending'
  where id = p_transfer_id;

  insert into public.notifications (branch_id, source_type, source_id, message)
  select v_transfer.to_branch_id, 'transfer_verify_requested', p_transfer_id,
    format('%s batch(es) arrived from %s -- please verify it arrived OK.',
      (select count(*) from public.stock_transfer_items where transfer_id = p_transfer_id), fb.name)
  from public.branches fb where fb.id = v_transfer.from_branch_id;

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

-- Nothing left to physically move once approved -- only 'pending' (never
-- sent anywhere yet) can still be called off.
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
  if v_transfer.status <> 'pending' then
    raise exception 'Only a pending transfer can be cancelled';
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

-- The receiving branch's own confirmation, after the fact -- purely a
-- record of what actually happened physically; it never reverses the
-- movement approve_stock_transfer() already made. p_result 'not_received'
-- or 'damaged' just flags this transfer for the sending branch/org to
-- follow up on outside the system (a fresh transfer back, a credit, etc.).
create or replace function public.verify_stock_transfer(p_transfer_id uuid, p_result text, p_notes text default null)
returns void
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_transfer public.stock_transfers%rowtype;
  v_to_branch uuid;
begin
  if p_result not in ('confirmed', 'not_received', 'damaged') then
    raise exception 'result must be confirmed, not_received, or damaged';
  end if;

  select * into v_transfer from public.stock_transfers where id = p_transfer_id;
  if v_transfer.id is null then raise exception 'Transfer not found'; end if;
  if v_transfer.status <> 'received' then raise exception 'This transfer has not been completed yet'; end if;
  if v_transfer.verify_status <> 'pending' then raise exception 'This transfer has already been verified'; end if;

  select u.branch_id into v_to_branch
  from public.users u
  where u.id = (select auth.uid()) and u.is_active and u.role in ('owner', 'manager');
  if v_to_branch is null or v_to_branch <> v_transfer.to_branch_id then
    raise exception 'Only the receiving branch may verify this transfer';
  end if;

  update public.stock_transfers
  set verify_status = p_result, verified_by = (select auth.uid()), verified_at = now(),
      verify_notes = nullif(btrim(coalesce(p_notes, '')), '')
  where id = p_transfer_id;

  insert into public.notifications (branch_id, source_type, source_id, message)
  select v_transfer.from_branch_id, 'stock_transfer_verified', p_transfer_id,
    case p_result
      when 'confirmed' then format('%s confirmed the stock arrived OK.', b.name)
      when 'not_received' then format('%s reported the stock never arrived.%s', b.name,
        case when nullif(btrim(coalesce(p_notes, '')), '') is not null then ' ' || btrim(p_notes) else '' end)
      else format('%s reported the stock arrived damaged.%s', b.name,
        case when nullif(btrim(coalesce(p_notes, '')), '') is not null then ' ' || btrim(p_notes) else '' end)
    end
  from public.branches b where b.id = v_transfer.to_branch_id;
end;
$$;

revoke all on function public.verify_stock_transfer(uuid, text, text) from public, anon;
grant execute on function public.verify_stock_transfer(uuid, text, text) to authenticated;

-- The organization sees this the moment a branch asks another for stock --
-- an FYI, not a request for action (there is no more approval step).
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

  -- Org-wide FYI (branch_id = the ASKING branch, "which branch this
  -- concerns" -- see public.notifications' own RLS: any org member can
  -- already see every branch's notifications, so this alone reaches every
  -- org_owner/org_manager without a separate org-level notification type).
  insert into public.notifications (branch_id, source_type, source_id, message)
  select v_branch, 'stock_need_requested_fyi', v_need,
    format('%s requested %s unit(s) of %s from %s.', b_from.name, p_requested_quantity, concat_ws(' ', p.name, pv.dosage), b_to.name)
  from public.branches b_from
  join public.branches b_to on b_to.id = p_target_branch_id
  join public.product_variants pv on pv.id = p_product_variant_id
  join public.products p on p.id = pv.product_id
  where b_from.id = v_branch;

  return v_need;
end;
$$;

-- Accepting now completes the transfer immediately (no org sign-off left to
-- wait for) -- the same request_stock_transfer()+approve_stock_transfer()
-- pair a manually-created "Request Transfer" already goes through.
create or replace function public.respond_to_stock_offer(p_offer_id uuid, p_accept boolean, p_reason text default null, p_batch_ids uuid[] default null)
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
  v_transfer_id uuid;
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

    v_transfer_id := public.request_stock_transfer(
      v_need.requesting_branch_id, p_batch_ids, format('Fulfilling stock request %s', v_need.id), v_own_branch
    );
    update public.stock_transfer_needs set transfer_id = v_transfer_id where id = v_need.id;
    -- approve_stock_transfer()'s own tail moves the stock, marks this need
    -- 'fulfilled', and notifies the requesting branch that it arrived.
    perform public.approve_stock_transfer(v_transfer_id);

    insert into public.notifications (branch_id, source_type, source_id, message)
    select v_need.requesting_branch_id, 'stock_offer_accepted_fyi', v_need.id,
      format('%s agreed to send %s unit(s) of %s to %s -- already on its way.',
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

-- ── One-time backfill ───────────────────────────────────────────────────────
-- Any transfer still sitting in the OLD 'approved' (awaiting dispatch) or
-- 'in_transit' (awaiting receive) state predates this migration -- under the
-- new rules "approved" already means done, so bring these forward the same
-- way approve_stock_transfer() now would, instead of leaving them stranded
-- with no dispatch/receive screen left to advance them.
do $$
declare
  v_transfer record;
  v_item record;
begin
  for v_transfer in select * from public.stock_transfers where status in ('approved', 'in_transit') loop
    for v_item in
      select sti.stock_batch_id, sb.product_variant_id, sb.batch_number
      from public.stock_transfer_items sti
      join public.stock_batches sb on sb.id = sti.stock_batch_id
      where sti.transfer_id = v_transfer.id
    loop
      if not exists (
        select 1 from public.stock_batches sb2
        where sb2.branch_id = v_transfer.to_branch_id
          and sb2.product_variant_id = v_item.product_variant_id
          and sb2.batch_number = v_item.batch_number
          and sb2.id <> v_item.stock_batch_id
      ) then
        update public.stock_batches set branch_id = v_transfer.to_branch_id where id = v_item.stock_batch_id;
      end if;
    end loop;

    update public.barcodes set status = 'active'
    where status = 'in_transit'
      and stock_batch_id in (select stock_batch_id from public.stock_transfer_items where transfer_id = v_transfer.id);

    update public.stock_transfers
    set status = 'received', received_at = coalesce(received_at, now()), verify_status = 'pending'
    where id = v_transfer.id;

    insert into public.notifications (branch_id, source_type, source_id, message)
    select v_transfer.to_branch_id, 'transfer_verify_requested', v_transfer.id,
      format('%s batch(es) arrived from %s -- please verify it arrived OK.',
        (select count(*) from public.stock_transfer_items where transfer_id = v_transfer.id), fb.name)
    from public.branches fb where fb.id = v_transfer.from_branch_id;

    if exists (select 1 from public.stock_transfer_needs where transfer_id = v_transfer.id) then
      update public.stock_transfer_needs set status = 'fulfilled' where transfer_id = v_transfer.id;
    end if;
  end loop;
end $$;
