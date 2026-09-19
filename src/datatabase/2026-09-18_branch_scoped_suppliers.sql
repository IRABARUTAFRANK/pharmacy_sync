-- ============================================================================
-- STOCK RECEIVING: SUPPLIERS FOLLOW THE VIEWED BRANCH, NOT THE CALLER'S OWN
-- ============================================================================
-- Same bug, same fix shape as list_branch_categories() (see
-- 2026-09-14_org_manage_branch_settings.sql): the suppliers dropdown on the
-- Stock Receiving page comes from a plain `select * from public.suppliers`,
-- which RLS resolves to `branch_id is null or branch_id = current_branch_id()`
-- -- current_branch_id() is always the CALLER's own branch, with no way to
-- honor an org_owner/org_manager's "view this other branch" override. An
-- org owner/manager receiving stock into a branch that isn't their own
-- therefore saw that branch's suppliers as if they didn't exist (an empty
-- or wrong list), even though receive_stock_delivery() itself already
-- correctly receives into the viewed branch.
--
-- This is a SECURITY DEFINER read scoped by effective_branch_id(p_branch_id)
-- instead -- that function already enforces org membership on its own (see
-- 2026-09-11_view_branch_as_org_owner.sql), so no extra permission check is
-- needed here, exactly like list_branch_categories(). Global rows
-- (branch_id is null) stay visible to everyone, matching the existing RLS
-- policy's own behavior.
--
-- src/lib/receiving.ts's loadReceivingReference() now calls this instead of
-- a raw table select.
-- ============================================================================

create or replace function public.list_branch_suppliers(p_branch_id uuid default null)
returns table(id uuid, supplier_name text)
language sql
stable
security definer
set search_path = ''
as $$
  select s.id, s.supplier_name::text
  from public.suppliers s
  where s.branch_id is null or s.branch_id = public.effective_branch_id(p_branch_id)
  order by s.supplier_name;
$$;

revoke all on function public.list_branch_suppliers(uuid) from public, anon;
grant execute on function public.list_branch_suppliers(uuid) to authenticated;
