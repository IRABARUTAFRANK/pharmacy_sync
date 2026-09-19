-- ============================================================================
-- PARTIAL-QUANTITY STOCK TRANSFERS/REQUESTS -- "this medicine has 10 packs,
-- I only want to send/ask for some of them"
-- ============================================================================
-- Run once, after every prior file in this directory. Idempotent.
--
-- Every existing stock-transfer RPC (request/dispatch/receive/cancel/reject,
-- the manifest, the branch/org listings) operates on a WHOLE stock_batch --
-- checking one row in Request Transfer/Request Stock's "batches to send"
-- list, or scanning one barcode there, commits every currently-active pack
-- under that batch to the shipment; there was never a way to send/ask for
-- only some of them.
--
-- Rather than teaching all six of those RPCs a new "quantity" concept
-- (touching dispatch_stock_transfer's/receive_stock_transfer's/list_stock_
-- transfer_manifest's own barcode-selection logic, and the two cancel/
-- reject paths that would need to release a partial reservation), this adds
-- ONE new function that runs BEFORE any of them: given a batch and a
-- desired pack count, it splits off a brand-new stock_batches row holding
-- exactly that many of the original batch's own active, top-level barcodes
-- (re-pointing their stock_batch_id) and hands back that new batch's id.
-- The client then passes THAT id into request_stock_transfer/request_stock_
-- from_branch exactly as it already does today -- every other function in
-- the whole pipeline keeps working completely unchanged, because a split-off
-- batch is a perfectly ordinary batch in every other respect.
-- ============================================================================

-- Read-only: how many of a batch's own barcodes are both ACTIVE and
-- top-level (a loose pack, or a box -- never a box's own child pack counted
-- separately, same "one line per physical unit you'd hand over" rule
-- list_stock_transfer_manifest() already uses). The client calls this right
-- after a scan/pick to decide whether "how many packs?" is even a question
-- worth asking -- a batch of 1 has nothing to split.
create or replace function public.count_active_batch_units(p_stock_batch_id uuid)
returns integer
language sql
stable
security definer
set search_path = ''
as $$
  select count(*)::integer
  from public.barcodes bc
  join public.stock_batches sb on sb.id = bc.stock_batch_id
  where bc.stock_batch_id = p_stock_batch_id
    and bc.status = 'active'
    and bc.parent_barcode_id is null
    and (
      public.is_super_admin()
      or sb.branch_id = public.current_branch_id()
      or exists (
        select 1 from public.organization_members om
        join public.branches b on b.organization_id = om.organization_id
        where om.user_id = (select auth.uid()) and b.id = sb.branch_id
      )
    )
$$;

revoke all on function public.count_active_batch_units(uuid) from public, anon;
grant execute on function public.count_active_batch_units(uuid) to authenticated;

-- Returns p_stock_batch_id unchanged when p_quantity covers everything
-- currently active in it (the common case -- nothing to split, sending the
-- whole thing exactly as before). Otherwise clones the batch's own
-- identity (product, branch, supplier, cost/selling price, expiry, ...)
-- into a new row and moves exactly p_quantity of its active, top-level
-- barcodes onto that new batch, leaving the rest where they are. The new
-- batch_number is suffixed so it can never collide with the
-- (product_variant_id, batch_number, branch_id) uniqueness the original
-- relies on.
create or replace function public.split_stock_batch(p_stock_batch_id uuid, p_quantity integer)
returns uuid
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_caller uuid := (select auth.uid());
  v_own_branch uuid;
  v_batch public.stock_batches%rowtype;
  v_active_count integer;
  v_new_batch_id uuid;
  v_moved integer;
begin
  if p_quantity is null or p_quantity < 1 then
    raise exception 'quantity must be at least 1';
  end if;

  select * into v_batch from public.stock_batches where id = p_stock_batch_id;
  if v_batch.id is null then raise exception 'Stock batch not found'; end if;

  select u.branch_id into v_own_branch from public.users u where u.id = v_caller and u.is_active and u.role in ('owner', 'manager');
  if v_own_branch is null then raise exception 'Only an active branch manager or owner may split a stock batch'; end if;

  if v_batch.branch_id <> v_own_branch then
    if not exists (
      select 1 from public.organization_members om
      join public.branches b on b.organization_id = om.organization_id
      where om.user_id = v_caller and b.id = v_batch.branch_id
    ) then
      raise exception 'You do not have permission to split this stock batch';
    end if;
  end if;

  select count(*) into v_active_count
  from public.barcodes
  where stock_batch_id = p_stock_batch_id and status = 'active' and parent_barcode_id is null;

  if p_quantity >= v_active_count then
    return p_stock_batch_id;
  end if;

  insert into public.stock_batches (
    product_variant_id, branch_id, supplier_id, manufacturer_name, delivery_code, delivery_id, logged_by,
    batch_number, expiry_date, cost_price, selling_price, quantity_received
  ) values (
    v_batch.product_variant_id, v_batch.branch_id, v_batch.supplier_id, v_batch.manufacturer_name, v_batch.delivery_code, v_batch.delivery_id, v_caller,
    v_batch.batch_number || '-SPLIT-' || substr(gen_random_uuid()::text, 1, 6), v_batch.expiry_date, v_batch.cost_price, v_batch.selling_price, p_quantity
  ) returning id into v_new_batch_id;

  with moved as (
    select id from public.barcodes
    where stock_batch_id = p_stock_batch_id and status = 'active' and parent_barcode_id is null
    order by id
    limit p_quantity
  )
  update public.barcodes set stock_batch_id = v_new_batch_id where id in (select id from moved);
  get diagnostics v_moved = row_count;

  if v_moved < p_quantity then
    raise exception 'Only % pack(s) are available to split off', v_moved;
  end if;

  return v_new_batch_id;
end;
$$;

revoke all on function public.split_stock_batch(uuid, integer) from public, anon;
grant execute on function public.split_stock_batch(uuid, integer) to authenticated;
