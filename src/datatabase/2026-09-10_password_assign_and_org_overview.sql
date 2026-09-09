-- ============================================================================
-- Password-based role assignment (audit log) + org-wide/per-branch Overview
-- ============================================================================
-- Run once, AFTER every prior organization-related file this session
-- (..., 2026-09-09_organization_roles_v2.sql). Idempotent -- safe to re-run.
--
-- Two independent additions:
--
--   1. log_org_manager_grant() -- a thin, authenticated-callable audit-log
--      wrapper for the new org_manager creation path in the
--      create-branch-seller Edge Function (which now sets a real password
--      for org_manager too, not just branch manager/seller). Same shape as
--      the existing log_first_branch_login() a few lines below it in
--      2026-09-09_organization_rbac.sql -- calling it grants no privilege,
--      it only produces a correctly-attributed audit row.
--
--   2. org_overview_raw() -- lets an org_owner/org_manager see the Overview
--      page for their whole organization (every branch combined) or any one
--      branch in it, not just their own home branch. Deliberately does NOT
--      touch the existing "branch access" RLS policies that scope sales/
--      stock_batches/etc. to branch_id = current_branch_id() on ~10 tables
--      -- those are relied on by Inventory/Sales/Reports for every role, and
--      none of those pages filter by branch_id themselves (they lean on RLS
--      to do it), so widening them would leak cross-branch rows into pages
--      that were never designed to show more than one branch at a time.
--      Instead this is a separate, additive, security-definer function that
--      bundles exactly the raw rows src/lib/overview.ts already fetches
--      client-side, pre-filtered to the caller's own organization -- zero
--      change to how any existing role reads these tables anywhere else.
-- ============================================================================


-- ============================================================================
-- SECTION 1 — log_org_manager_grant: audit log for password-based org_manager
-- ============================================================================

create or replace function public.log_org_manager_grant(p_organization_id uuid, p_target_user_id uuid)
returns void
language plpgsql
security definer
set search_path = ''
as $$
begin
  perform public.log_role_change('organization', p_organization_id, null, p_target_user_id, null, 'org_manager', 'grant');
end;
$$;

revoke all on function public.log_org_manager_grant(uuid, uuid) from public, anon;
grant execute on function public.log_org_manager_grant(uuid, uuid) to authenticated;


-- ============================================================================
-- SECTION 2 — org_overview_raw: raw rows behind an org-wide/per-branch
-- Overview, for org_owner/org_manager only
-- ============================================================================

-- p_branch_ids null means "every branch in the organization"; otherwise every
-- id in the array must already belong to p_organization_id. p_from/p_to are
-- the same widened fetch window resolveRange()/loadOverview() already
-- compute today (covers both the requested period and the current
-- Mon..Sun week the Daily Transactions card needs).
--
-- tax_rates, product_variants and products are NOT bundled here -- none of
-- them carry a branch_id, so the existing plain client-side reads for those
-- three tables are unaffected and stay exactly as they are.
create or replace function public.org_overview_raw(
  p_organization_id uuid, p_branch_ids uuid[], p_from timestamptz, p_to timestamptz
)
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  v_branch_ids uuid[];
  v_result jsonb;
begin
  perform public.assert_org_member(p_organization_id);

  if p_branch_ids is null then
    select coalesce(array_agg(id), array[]::uuid[]) into v_branch_ids
    from public.branches where organization_id = p_organization_id;
  else
    if exists (
      select 1 from unnest(p_branch_ids) as bid
      where not exists (select 1 from public.branches b where b.id = bid and b.organization_id = p_organization_id)
    ) then
      raise exception 'One or more branches do not belong to this organization';
    end if;
    v_branch_ids := p_branch_ids;
  end if;

  select jsonb_build_object(
    'sales', (
      select coalesce(jsonb_agg(jsonb_build_object('id', s.id, 'total_amount', s.total_amount, 'sold_at', s.sold_at)), '[]'::jsonb)
      from public.sales s
      where s.branch_id = any(v_branch_ids) and s.sold_at >= p_from and s.sold_at < p_to
    ),
    'sale_items', (
      select coalesce(jsonb_agg(jsonb_build_object(
        'sale_id', si.sale_id, 'barcode_id', si.barcode_id, 'tax_rate_id', si.tax_rate_id,
        'quantity', si.quantity, 'unit_price', si.unit_price, 'subtotal', si.subtotal,
        'insurance_covered_amount', si.insurance_covered_amount
      )), '[]'::jsonb)
      from public.sale_items si
      join public.sales s on s.id = si.sale_id
      where s.branch_id = any(v_branch_ids) and s.sold_at >= p_from and s.sold_at < p_to
    ),
    'barcodes', (
      select coalesce(jsonb_agg(jsonb_build_object(
        'id', bc.id, 'stock_batch_id', bc.stock_batch_id, 'barcode_type', bc.barcode_type,
        'pieces_per_pack', bc.pieces_per_pack, 'quantity_available', bc.quantity_available, 'status', bc.status
      )), '[]'::jsonb)
      from public.barcodes bc
      join public.stock_batches sb on sb.id = bc.stock_batch_id
      where sb.branch_id = any(v_branch_ids)
    ),
    'stock_batches', (
      select coalesce(jsonb_agg(jsonb_build_object(
        'id', sb.id, 'product_variant_id', sb.product_variant_id,
        'expiry_date', sb.expiry_date, 'selling_price', sb.selling_price
      )), '[]'::jsonb)
      from public.stock_batches sb
      where sb.branch_id = any(v_branch_ids)
    ),
    'reorder_points', (
      select coalesce(jsonb_agg(jsonb_build_object('product_id', rp.product_id, 'min_quantity', rp.min_quantity)), '[]'::jsonb)
      from public.reorder_points rp
      where rp.branch_id = any(v_branch_ids)
    ),
    'product_categories', (
      select coalesce(jsonb_agg(jsonb_build_object('id', pc.id, 'name', pc.name)), '[]'::jsonb)
      from public.product_categories pc
      where pc.branch_id = any(v_branch_ids)
    ),
    'branch_product_categorization', (
      select coalesce(jsonb_agg(jsonb_build_object('product_id', bpc.product_id, 'category_id', bpc.category_id)), '[]'::jsonb)
      from public.branch_product_categorization bpc
      where bpc.branch_id = any(v_branch_ids)
    )
  ) into v_result;

  return v_result;
end;
$$;

revoke all on function public.org_overview_raw(uuid, uuid[], timestamptz, timestamptz) from public, anon;
grant execute on function public.org_overview_raw(uuid, uuid[], timestamptz, timestamptz) to authenticated;
