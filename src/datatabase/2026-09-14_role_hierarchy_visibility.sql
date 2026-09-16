-- ============================================================================
-- Role hierarchy: a role can see the roles below it, never the one above
-- ============================================================================
-- Run once, after every prior file in this directory. Idempotent.
--
-- Hierarchy (highest to lowest): org_owner > org_manager > branch owner/
-- manager > seller. The rule: a role can see full info -- including email --
-- of every role below it, but never the email of a role above it. This was
-- already true for branch-level people viewed by an org member (org_owner/
-- org_manager sit above branch owner/manager/seller, so seeing their email
-- is downward visibility, already correct) and already true that a plain
-- branch owner/manager/seller with no organization_members row can't call
-- either function below at all (assert_org_member rejects them outright, so
-- they never see anyone outside their own branch this way).
--
-- The one real gap: list_organization_people()/list_organization_members()
-- let ANY org member call them (assert_org_member doesn't distinguish role),
-- and returned every row's email unconditionally -- so an org_manager could
-- see the org_owner's email, upward visibility, which the hierarchy above
-- forbids. Both are re-declared here (same signature, no drop needed) to
-- mask the org_owner's email specifically when the caller is the org_manager
-- (not the org_owner themselves, and not super_admin, who always sees
-- everything). Name and role stay visible either way -- a subordinate should
-- still know who their organization's owner is, just not have their email
-- surfaced through this admin roster.
-- ============================================================================

create or replace function public.list_organization_people(p_organization_id uuid)
returns table(
  user_id uuid, full_name text, email text, scope text, role text,
  branch_id uuid, branch_name text, is_active boolean
)
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  v_caller_role text;
begin
  perform public.assert_org_member(p_organization_id);

  -- Aliased on purpose: this function's RETURNS TABLE declares OUT columns
  -- named role/user_id, so inside plpgsql a bare "role" or "user_id" here is
  -- ambiguous between that OUT column and organization_members' own column
  -- ("column reference role is ambiguous"), which made the whole
  -- function fail at runtime rather than just mis-resolve.
  select m_self.role into v_caller_role
  from public.organization_members m_self
  where m_self.organization_id = p_organization_id and m_self.user_id = (select auth.uid());

  return query
    select u.id, u.full_name::text,
      case when v_caller_role = 'org_manager' and m.role = 'org_owner' and not public.is_super_admin()
        then null else u.email::text end,
      'organization'::text, m.role::text,
      null::uuid, null::text, u.is_active
    from public.organization_members m
    join public.users u on u.id = m.user_id
    where m.organization_id = p_organization_id
    union all
    select u.id, u.full_name::text, u.email::text, 'branch'::text, u.role::text,
      b.id, b.name::text, u.is_active
    from public.users u
    join public.branches b on b.id = u.branch_id
    where b.organization_id = p_organization_id
      and u.id not in (select om.user_id from public.organization_members om where om.organization_id = p_organization_id)
    order by 4, 5, 2;
end;
$$;

revoke all on function public.list_organization_people(uuid) from public, anon;
grant execute on function public.list_organization_people(uuid) to authenticated;


create or replace function public.list_organization_members(p_organization_id uuid)
returns table(user_id uuid, full_name text, email text, role text, created_at timestamptz)
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  v_caller_role text;
begin
  perform public.assert_org_member(p_organization_id);

  -- Aliased on purpose: this function's RETURNS TABLE declares OUT columns
  -- named role/user_id, so inside plpgsql a bare "role" or "user_id" here is
  -- ambiguous between that OUT column and organization_members' own column
  -- ("column reference role is ambiguous"), which made the whole
  -- function fail at runtime rather than just mis-resolve.
  select m_self.role into v_caller_role
  from public.organization_members m_self
  where m_self.organization_id = p_organization_id and m_self.user_id = (select auth.uid());

  return query
    select u.id, u.full_name::text,
      case when v_caller_role = 'org_manager' and m.role = 'org_owner' and not public.is_super_admin()
        then null else u.email::text end,
      m.role::text, m.created_at
    from public.organization_members m
    join public.users u on u.id = m.user_id
    where m.organization_id = p_organization_id
    order by m.role, u.full_name;
end;
$$;

revoke all on function public.list_organization_members(uuid) from public, anon;
grant execute on function public.list_organization_members(uuid) to authenticated;
