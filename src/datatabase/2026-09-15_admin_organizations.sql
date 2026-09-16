-- ============================================================================
-- Super-admin console: organizations tab
-- ============================================================================
-- Run once. Idempotent.
--
-- Gap found: the super-admin console (AdminPortal.tsx) had no dedicated
-- view of organizations at all -- only a narrow, read-only, unfiltered list
-- of org-owned branches buried inside the Approvals tab
-- (admin_list_all_branches(), PROPOSAL_multi_branch_organizations.sql).
-- There was no way to see the platform's organizations as chains (branch
-- counts, status, TIN), and no admin action on an organization existed at
-- all -- pharmacy_organizations.status ('active'/'suspended') has existed
-- since the column was created but nothing ever set it.
--
-- This adds exactly two things:
--   1. admin_list_organizations() -- every organization with its branch
--      count, for a real Organizations tab. Branch-level detail for one
--      org is NOT a second RPC -- the frontend already fetches every
--      org-owned branch via admin_list_all_branches() for the Approvals
--      tab; the Organizations tab reuses that same data, filtered by
--      organization_id, rather than duplicating the query.
--   2. admin_set_organization_status() -- the platform-level kill switch,
--      mirroring admin_set_branch_lock()'s existing pattern exactly.
--      Deliberately does NOT cascade into locking every branch underneath
--      (see pharmacy_organizations' own table comment in
--      PROPOSAL_multi_branch_organizations.sql: org status is a SEPARATE
--      switch from any one branch's own status) -- today this blocks the
--      organization from adding new branches (add_branch_to_organization()
--      already checks status <> 'active') and flags it in the console;
--      it does not freeze already-running branches' day-to-day operations.
--      If stronger cascading suspension is wanted later, that's a
--      deliberate, separate follow-up, not bundled in here.
-- ============================================================================

create or replace function public.admin_list_organizations()
returns table(
  id uuid, legal_name text, trade_name text, tin text, status text,
  branch_count integer, created_at timestamptz
)
language plpgsql
stable
security definer
set search_path = ''
as $$
begin
  perform public.assert_super_admin();
  return query
    select
      o.id, o.legal_name::text, o.trade_name::text, o.tin::text, o.status::text,
      (select count(*)::integer from public.branches b where b.organization_id = o.id),
      o.created_at
    from public.pharmacy_organizations o
    order by o.created_at desc;
end;
$$;

revoke all on function public.admin_list_organizations() from public, anon;
grant execute on function public.admin_list_organizations() to authenticated;


create or replace function public.admin_set_organization_status(p_organization_id uuid, p_status text)
returns void
language plpgsql
security definer
set search_path = ''
as $$
begin
  perform public.assert_super_admin();
  if p_status not in ('active', 'suspended') then
    raise exception 'status must be active or suspended';
  end if;
  if not exists (select 1 from public.pharmacy_organizations where id = p_organization_id) then
    raise exception 'Unknown organization';
  end if;
  update public.pharmacy_organizations set status = p_status where id = p_organization_id;
end;
$$;

revoke all on function public.admin_set_organization_status(uuid, text) from public, anon;
grant execute on function public.admin_set_organization_status(uuid, text) to authenticated;
