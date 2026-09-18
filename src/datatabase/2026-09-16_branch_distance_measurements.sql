-- ============================================================================
-- BRANCH DISTANCE MEASUREMENTS -- lets an org_owner/org_manager save a
-- straight-line distance they measured on the Organization > Branches map
-- (the click-to-measure tool in BranchesMiniMap), instead of it disappearing
-- the moment they navigate away or measure a different pair.
-- ============================================================================
-- Table + three RPCs, all gated by is_org_member() (org_owner or
-- org_manager of the organization the measurement belongs to -- the same
-- authority level that can already see the map itself). No direct
-- client INSERT/UPDATE/DELETE grant on the table, same pattern as
-- role_change_log in 2026-09-09_organization_rbac.sql -- every write goes
-- through the RPCs below, which validate both branches actually belong to
-- the caller's own organization before saving.
-- ============================================================================

create table if not exists public.branch_distance_measurements (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references public.pharmacy_organizations(id) on delete cascade,
  branch_a_id uuid not null references public.branches(id) on delete cascade,
  branch_b_id uuid not null references public.branches(id) on delete cascade,
  distance_km numeric(10,2) not null check (distance_km >= 0),
  measured_by uuid references public.users(id),
  created_at timestamptz not null default now(),
  check (branch_a_id <> branch_b_id)
);

create index if not exists idx_branch_distance_measurements_org
  on public.branch_distance_measurements (organization_id, created_at desc);

alter table public.branch_distance_measurements enable row level security;

drop policy if exists "org members view their measurements" on public.branch_distance_measurements;
create policy "org members view their measurements" on public.branch_distance_measurements
for select to authenticated
using (public.is_org_member(organization_id));

-- No insert/update/delete grant -- every write goes through the RPCs below.
grant select on public.branch_distance_measurements to authenticated;


create or replace function public.save_branch_distance_measurement(
  p_organization_id uuid, p_branch_a_id uuid, p_branch_b_id uuid, p_distance_km numeric
)
returns uuid
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_id uuid;
begin
  if not public.is_org_member(p_organization_id) then
    raise exception 'Not authorized for this organization';
  end if;
  if p_branch_a_id = p_branch_b_id then
    raise exception 'Cannot measure a branch against itself';
  end if;
  if p_distance_km is null or p_distance_km < 0 then
    raise exception 'Invalid distance';
  end if;
  if not exists (select 1 from public.branches where id = p_branch_a_id and organization_id = p_organization_id)
     or not exists (select 1 from public.branches where id = p_branch_b_id and organization_id = p_organization_id) then
    raise exception 'Both branches must belong to this organization';
  end if;

  insert into public.branch_distance_measurements (organization_id, branch_a_id, branch_b_id, distance_km, measured_by)
  values (p_organization_id, p_branch_a_id, p_branch_b_id, p_distance_km, (select auth.uid()))
  returning id into v_id;

  return v_id;
end;
$$;

revoke all on function public.save_branch_distance_measurement(uuid, uuid, uuid, numeric) from public, anon;
grant execute on function public.save_branch_distance_measurement(uuid, uuid, uuid, numeric) to authenticated;


create or replace function public.list_branch_distance_measurements(p_organization_id uuid)
returns table(
  id uuid, branch_a_id uuid, branch_a_name text, branch_b_id uuid, branch_b_name text,
  distance_km numeric, measured_by_name text, created_at timestamptz
)
language plpgsql
stable
security definer
set search_path = ''
as $$
begin
  if not public.is_org_member(p_organization_id) then
    raise exception 'Not authorized for this organization';
  end if;

  return query
    select
      m.id, m.branch_a_id, ba.name::text, m.branch_b_id, bb.name::text,
      m.distance_km, u.full_name::text, m.created_at
    from public.branch_distance_measurements m
    join public.branches ba on ba.id = m.branch_a_id
    join public.branches bb on bb.id = m.branch_b_id
    left join public.users u on u.id = m.measured_by
    where m.organization_id = p_organization_id
    order by m.created_at desc;
end;
$$;

revoke all on function public.list_branch_distance_measurements(uuid) from public, anon;
grant execute on function public.list_branch_distance_measurements(uuid) to authenticated;


create or replace function public.delete_branch_distance_measurement(p_id uuid)
returns void
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_org_id uuid;
begin
  select organization_id into v_org_id from public.branch_distance_measurements where id = p_id;
  if v_org_id is null then
    return;
  end if;
  if not public.is_org_member(v_org_id) then
    raise exception 'Not authorized for this organization';
  end if;
  delete from public.branch_distance_measurements where id = p_id;
end;
$$;

revoke all on function public.delete_branch_distance_measurement(uuid) from public, anon;
grant execute on function public.delete_branch_distance_measurement(uuid) to authenticated;
