-- ============================================================================
-- lookup_barcode(): add p_branch_id -- the missing piece of "view another
-- branch as org owner/manager"
-- ============================================================================
-- Every OTHER write/lookup an org_owner/org_manager makes while viewing
-- another branch's Sales page already threads branchId through to
-- effective_branch_id() -- complete_sale(), upsert_patient(),
-- find_patient_by_identifier(), list_branch_patients(). lookup_barcode()
-- never got that update: it always scoped to current_branch_id(), the
-- caller's own literal home branch, with no way to override it.
--
-- The bug this caused: an org_owner/org_manager scanning a barcode while
-- viewing another branch got a scan that silently checked their OWN home
-- branch instead of the one on screen. If they happen to also be a seller
-- at their own branch and that branch happens to stock the same barcode
-- (rare), the scan succeeds and lands in the cart looking completely
-- normal -- right up until complete_sale() re-validates against the
-- correctly-resolved viewed branch and rejects it with "Barcode X was not
-- found for this branch", because it was never really scoped to that
-- branch in the first place. Confirmed live: 2026-09-16's on-disk
-- definition of lookup_barcode() (in pharmacy_schema_consolidated.sql) has
-- no p_branch_id parameter at all.
--
-- Also folds in this database's other lookup_barcode() gap while at it:
-- src/lib/sales.ts (scanBarcode()) already reads row.storage_location_name
-- off the response (added client-side alongside the Locate Product page),
-- but the version actually deployed here predates that column and was
-- silently returning it as null (harmless, but the location info the
-- Sales page is supposed to show was just never there). Same fix, same
-- migration, since both are "this function is behind what the client
-- expects of it".
-- ============================================================================

drop function if exists public.lookup_barcode(text);

create or replace function public.lookup_barcode(p_code text, p_branch_id uuid default null)
returns table(
  barcode_id uuid, code text, barcode_type text, status text,
  quantity_available integer, pieces_per_pack integer, child_count integer,
  child_pieces_per_pack integer, active_child_count integer,
  parent_code text, stock_batch_id uuid, batch_number text, expiry_date date,
  delivery_code text, selling_price numeric, cost_price numeric, product_id uuid, product_name text,
  tax_rate_id uuid, dosage text, form text, manufacturer_name text, supplier_name text,
  storage_location_name text
)
language sql
stable
security definer
set search_path = ''
as $$
  select
    bc.id,
    bc.code::text,
    bc.barcode_type::text,
    bc.status::text,
    bc.quantity_available,
    bc.pieces_per_pack,
    bc.child_count,
    case when bc.barcode_type = 'box' then (
      select max(cpp.pieces_per_pack)::integer
      from public.barcodes cpp
      where cpp.parent_barcode_id = bc.id
        and cpp.barcode_type = 'pack'
        and cpp.status = 'active'
        and cpp.quantity_available > 0
    ) end as child_pieces_per_pack,
    case when bc.barcode_type = 'box' then (
      select count(*)::integer
      from public.barcodes cpp
      where cpp.parent_barcode_id = bc.id
        and cpp.barcode_type = 'pack'
        and cpp.status = 'active'
        and cpp.quantity_available > 0
    ) end as active_child_count,
    parent.code::text,
    sb.id,
    sb.batch_number::text,
    sb.expiry_date,
    sb.delivery_code::text,
    sb.selling_price,
    sb.cost_price,
    p.id,
    p.name::text,
    p.tax_rate_id,
    pv.dosage::text,
    pv.form::text,
    sb.manufacturer_name::text,
    s.supplier_name::text,
    sl.name::text
  from public.barcodes bc
  join public.stock_batches sb on sb.id = bc.stock_batch_id
  join public.product_variants pv on pv.id = sb.product_variant_id
  join public.products p on p.id = pv.product_id
  left join public.barcodes parent on parent.id = bc.parent_barcode_id
  left join public.suppliers s on s.id = sb.supplier_id
  left join public.product_storage_locations psl on psl.branch_id = sb.branch_id and psl.product_id = p.id
  left join public.storage_locations sl on sl.id = psl.storage_location_id
  where upper(bc.code) = upper(btrim(p_code))
    and (
      public.is_super_admin()
      or sb.branch_id = public.effective_branch_id(p_branch_id)
    )
  limit 1
$$;

revoke all on function public.lookup_barcode(text, uuid) from public, anon;
grant execute on function public.lookup_barcode(text, uuid) to authenticated;
