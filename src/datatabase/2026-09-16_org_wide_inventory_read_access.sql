-- ============================================================================
-- ORG-WIDE INVENTORY READ ACCESS (org_owner/org_manager viewing another branch)
-- ============================================================================
-- LiveInventoryPage's loadInventoryDataset() has always relied purely on RLS
-- (no client-side branch_id filter) rather than an effective_branch_id()-style
-- RPC. Unlike notifications (2026-09-14_reorder_notifications_org_visibility.sql)
-- and reorder_points (PROPOSAL_multi_branch_organizations.sql), stock_batches,
-- barcodes, suppliers, product_categories, and branch_product_categorization
-- were never widened for org members -- so "View Branch" -> Inventory has
-- always silently shown the caller's OWN branch's stock (or nothing), never
-- the branch actually being viewed. This is a real bug, not a hardening.
--
-- Fix: add a SEPARATE, SELECT-ONLY policy per table granting org-wide read to
-- any active member of that branch's organization, alongside the existing
-- policy (left completely unchanged) that still governs INSERT/UPDATE/DELETE
-- as branch_id = current_branch_id() only. Postgres OR's multiple permissive
-- policies together for a given command, so this only ever ADDS read rows --
-- it cannot loosen who may write. Unlike reorder_points' own widened policy
-- (cmd 'ALL', so any org member can already upsert reorder points for any
-- branch in the org directly -- a pre-existing, out-of-scope inconsistency
-- worth flagging separately), every write path into these five tables that
-- matters (receive_stock_delivery, dispatch_stock_transfer,
-- receive_stock_transfer, create_branch_discount/category, etc.) already goes
-- through a SECURITY DEFINER RPC gated by assert_can_manage_org_branch's
-- owner/manager precedence rule -- direct-client writes to another branch
-- must keep failing exactly as they do today.
--
-- loadInventoryDataset() itself is updated separately (src/lib/inventory.ts)
-- to pass an explicit branch_id filter now that RLS can return more than one
-- branch's rows -- this migration only stops UNDER-returning; the app still
-- narrows to exactly the intended branch(es) client-side.
-- ============================================================================

create policy "org members read stock_batches org-wide"
  on public.stock_batches for select
  using (
    exists (
      select 1 from public.branches b
      where b.id = stock_batches.branch_id
        and b.organization_id is not null
        and public.is_org_member(b.organization_id)
    )
  );

drop policy if exists "barcodes access" on public.barcodes;
create policy "barcodes access" on public.barcodes for select
  using (
    public.is_super_admin()
    or exists (
      select 1 from public.stock_batches sb
      where sb.id = barcodes.stock_batch_id
        and (
          sb.branch_id = public.current_branch_id()
          or exists (
            select 1 from public.branches b
            where b.id = sb.branch_id
              and b.organization_id is not null
              and public.is_org_member(b.organization_id)
          )
        )
    )
  );

create policy "org members read suppliers org-wide"
  on public.suppliers for select
  using (
    exists (
      select 1 from public.branches b
      where b.id = suppliers.branch_id
        and b.organization_id is not null
        and public.is_org_member(b.organization_id)
    )
  );

create policy "org members read product_categories org-wide"
  on public.product_categories for select
  using (
    exists (
      select 1 from public.branches b
      where b.id = product_categories.branch_id
        and b.organization_id is not null
        and public.is_org_member(b.organization_id)
    )
  );

create policy "org members read branch_product_categorization org-wide"
  on public.branch_product_categorization for select
  using (
    exists (
      select 1 from public.branches b
      where b.id = branch_product_categorization.branch_id
        and b.organization_id is not null
        and public.is_org_member(b.organization_id)
    )
  );
