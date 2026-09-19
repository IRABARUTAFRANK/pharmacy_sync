-- ============================================================================
-- ADMIN CATEGORIES TABLE: ORGANIZATION FOR FILTERING/SORTING BY BRANCH OR ORG
-- ============================================================================
-- admin_list_categories() only ever returned branch_id/branch_name -- no way
-- to filter or group its (branch x category) rows by organization, or to
-- narrow the table down to "just this one branch" / "just this one
-- organization's branches" the way the super admin actually wants to look
-- at it. This adds organization_id/organization_name (left join: a branch
-- created before organizations existed, or never assigned one, still shows
-- up with organization_name null rather than being silently dropped).
--
-- Return shape changes (2 new columns), so the old declaration must be
-- dropped first -- create or replace alone errors on a changed return
-- table shape (unlike a changed argument list, which would silently leave
-- a duplicate overload instead).
-- ============================================================================

drop function if exists public.admin_list_categories();

create or replace function public.admin_list_categories()
returns table(
  id uuid, branch_id uuid, branch_name text,
  organization_id uuid, organization_name text,
  name text, description text
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
      pc.id, pc.branch_id, b.name::text,
      b.organization_id, coalesce(o.trade_name, o.legal_name)::text,
      pc.name::text, pc.description
    from public.product_categories pc
    join public.branches b on b.id = pc.branch_id
    left join public.pharmacy_organizations o on o.id = b.organization_id
    order by o.legal_name nulls last, b.name, pc.name;
end;
$$;

revoke all on function public.admin_list_categories() from public;
grant execute on function public.admin_list_categories() to authenticated;
