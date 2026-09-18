-- ============================================================================
-- STOCK TRANSFER SCAN MANIFEST -- barcode-level detail for a transfer, so
-- dispatch/receive can be a real scan-to-confirm step instead of one bare
-- button click
-- ============================================================================
-- Run once, after every prior file in this directory. Idempotent.
--
-- Requested directly: when a branch sends stock, the sender should scan
-- every item going into the shipment (the "package") before it can be sent,
-- and the receiving branch should scan every item as it arrives before it's
-- added to their own inventory -- with the exact same barcodes, so they can
-- sell immediately with no reprinting. dispatch_stock_transfer() and
-- receive_stock_transfer() (2026-09-14_stock_transfer_workflow_from_
-- proposal.sql / 2026-09-15_stock_transfer_negotiation.sql) already do
-- exactly the right thing server-side -- flip every barcode under the
-- transfer's batches 'active' -> 'in_transit' -> 'active', never
-- regenerating one -- they just never required proving the physical items
-- were actually scanned first. This function is the manifest the new scan
-- UI checks each scan against; the dispatch/receive RPCs themselves are
-- unchanged, so a transfer's OWN server-side truth (which batches move)
-- still can't be gamed by the client.
--
-- One row per physical item to scan -- a box, or a loose pack not inside any
-- box (its parent_barcode_id is null) -- not every individual pack sealed
-- inside a box, since those aren't physically reachable to scan until
-- opened. p_status is 'active' while building the outgoing package
-- (dispatch) or 'in_transit' while confirming an arriving one (receive) --
-- matching exactly what each RPC itself flips, so the manifest a scanner
-- checks off is always the live, current set of items that action will
-- actually touch, not a stale snapshot from when the transfer was created.
-- ============================================================================

create or replace function public.list_stock_transfer_manifest(p_transfer_id uuid, p_status text)
returns table(
  barcode_id uuid, code text, barcode_type text,
  stock_batch_id uuid, product_name text, dosage text, batch_number text
)
language plpgsql
stable
security definer
set search_path = ''
as $$
begin
  if p_status not in ('active', 'in_transit') then
    raise exception 'status must be active or in_transit';
  end if;

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
      b.id, b.code::text, b.barcode_type::text,
      sb.id, p.name::text, pv.dosage::text, sb.batch_number::text
    from public.stock_transfer_items sti
    join public.stock_batches sb on sb.id = sti.stock_batch_id
    join public.product_variants pv on pv.id = sb.product_variant_id
    join public.products p on p.id = pv.product_id
    join public.barcodes b on b.stock_batch_id = sb.id
    where sti.transfer_id = p_transfer_id
      and b.status = p_status
      and (b.barcode_type = 'box' or b.parent_barcode_id is null)
    order by p.name, b.code;
end;
$$;

revoke all on function public.list_stock_transfer_manifest(uuid, text) from public, anon;
grant execute on function public.list_stock_transfer_manifest(uuid, text) to authenticated;
