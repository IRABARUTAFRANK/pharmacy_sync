-- ============================================================================
-- Org role UI restrictions: org_manager's tabs, seller's Alerts, owner's
-- branch Overview once delegated
-- ============================================================================
-- Run once, any time after PROPOSAL_multi_branch_organizations.sql. Idempotent.
--
-- Purely a data-shape change to support new frontend gating (this file makes
-- no authorization changes itself -- every RPC an org_manager or seller could
-- already call is unaffected; this only tells the client what to show):
--
-- get_my_organization() gains has_org_manager, so the client can tell an
-- org_owner apart from an org_owner who has delegated to an org_manager --
-- once true, App.tsx hides that owner's own branch-level "Overview" nav item
-- (they still have the Organization > Dashboard tab, which shows the exact
-- same org-wide view). Return shape changed (new column), so this needs a
-- drop first -- plain create or replace cannot add an out column.
-- ============================================================================

drop function if exists public.get_my_organization();

create or replace function public.get_my_organization()
returns table(
  organization_id uuid, legal_name text, trade_name text, tin text, status text,
  my_role text, branch_count integer, has_org_manager boolean
)
language sql
stable
security definer
set search_path = ''
as $$
  select
    o.id, o.legal_name::text, o.trade_name::text, o.tin::text, o.status::text,
    m.role::text,
    (select count(*)::integer from public.branches b where b.organization_id = o.id),
    exists (select 1 from public.organization_members om where om.organization_id = o.id and om.role = 'org_manager')
  from public.organization_members m
  join public.pharmacy_organizations o on o.id = m.organization_id
  where m.user_id = (select auth.uid())
$$;

revoke all on function public.get_my_organization() from public, anon;
grant execute on function public.get_my_organization() to authenticated;
