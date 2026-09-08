-- ============================================================================
-- PROPOSAL — Multi-branch pharmacy organizations
-- ============================================================================
-- STATUS: NOT APPLIED. NOT WIRED INTO THE APP. FOR REVIEW ONLY.
--
-- This file is not part of the normal dated-migration sequence in this
-- directory (compare the filename to `2026-09-07_*.sql`) and is deliberately
-- named so it cannot be mistaken for one. Nothing in the running application
-- imports, calls, or otherwise depends on anything in this file. It changes
-- nothing about how the system behaves today. It is a concrete, reviewable
-- design for a feature that has not been built yet: letting one pharmacy own
-- and centrally manage several physical branches.
--
-- Read this whole header before the SQL below -- it explains what problem
-- this solves, how it fits onto the schema that already exists, what is
-- deliberately left out of this first version and why, and a set of open
-- questions/recommendations at the very end that need a decision before this
-- should ever be applied.
--
--
-- ── THE PROBLEM, IN THE SYSTEM'S OWN TERMS ─────────────────────────────────
--
-- Today, "branch" (public.branches) means an entire independent pharmacy
-- business. One branch = one owner, one branch_code, one TIN, one set of
-- staff, one stock room, one everything. current_branch_id() -- the function
-- almost every RLS policy and RPC in this schema is built on -- resolves the
-- calling user's OWN branch_id and scopes the query to exactly that one row.
-- There is no concept anywhere in the schema of two branches belonging to
-- the same real-world company.
--
-- What was asked for: some pharmacies are not one location, they are a
-- company with several. The owner of that company needs to see and manage
-- all of it from one place -- stock across every branch, staff across every
-- branch, consolidated sales -- while each individual branch keeps operating
-- day to day exactly as it does now (a cashier in Huye still only sells from
-- Huye's own shelf, a receiving clerk still only receives into their own
-- branch's stock room).
--
--
-- ── THE CORE DESIGN DECISION ────────────────────────────────────────────────
--
-- Introduce ONE new concept above branches: public.pharmacy_organizations,
-- a company that owns a set of branches. A branch's membership in an
-- organization is OPTIONAL (branches.organization_id, nullable). This is
-- the single most important property of this design:
--
--   Every branch that exists today has organization_id = null after this
--   migration runs, and organization_id = null branches are completely
--   unaffected by anything in this file -- no new RLS policy in this
--   proposal narrows or widens what they can see, no existing function is
--   redefined, no existing table loses a column or a constraint. A
--   standalone, single-location pharmacy signing up tomorrow never has to
--   know this feature exists.
--
-- A branch only gains cross-branch visibility/management by explicitly
-- opting in -- an existing branch owner calls create_pharmacy_organization()
-- to found a company around their own branch, or a super admin/organization
-- owner calls add_branch_to_organization() to bring a new location in.
--
-- The second core decision, just as important as the first:
--
--   READS may cross branches inside an organization. WRITES never do.
--
-- An organization owner can see every branch's stock, sales and staff. They
-- cannot sell from another branch's stock, adjust another branch's
-- inventory, or receive a delivery into another branch's stock room by
-- remote control -- every write in this schema that touches physical stock
-- or money (complete_sale, receive_stock_delivery, adjust_stock, ...) stays
-- scoped to current_branch_id(), completely untouched by this proposal. The
-- ONLY new way stock legitimately moves between two branches is the formal
-- stock_transfers workflow below, which is itself just a controlled,
-- audited write to stock_batches.branch_id -- there is no other new path
-- that lets a write cross a branch boundary.
--
--
-- ── WHY THIS MAPS ONTO RWANDA'S OWN TAX STRUCTURE ───────────────────────────
--
-- This is not a generic multi-tenancy pattern picked out of a textbook. RRA's
-- own EBM/VSDC e-invoicing system already works this exact way: one TIN
-- (the registered taxpayer/company) with several registered branch codes
-- underneath it, each branch invoicing independently but consolidating up to
-- one legal entity. public.pharmacy_organizations.tin below is meant to BE
-- that company-level TIN -- the same field public.branches.tin already holds
-- per-branch today for a standalone pharmacy. Confirm the exact RRA branch
-- numbering convention before this ships (see RECOMMENDATIONS at the end);
-- the shape of the tables does not depend on getting that number format
-- exactly right today.
--
--
-- ── WHAT THIS FIRST VERSION DELIBERATELY DOES NOT DO ────────────────────────
--
-- * Shared patients across branches. A patient seen at two branches of the
--   same chain today (and after this proposal) is still two separate rows,
--   because public.patients keeps its existing unique(branch_id,
--   tin_or_phone) as-is. Recognizing "this is the same person at another
--   location" is a real, valuable feature and a genuinely hard one --
--   fuzzy identity matching, merge conflicts, which branch's record wins.
--   It deserves its own dedicated design once the organization concept
--   itself is proven, not a rushed column added here. See RECOMMENDATIONS.
--
-- * Partial-batch stock transfers. A transfer in this design always moves
--   one WHOLE stock_batches row (and every barcode under it) to another
--   branch, never a subset of a batch's packs. This is a deliberate
--   simplification, not an oversight -- see the long comment on
--   stock_transfer_items below for the actual reasoning (it comes down to
--   printed barcode stickers staying physically valid after a move).
--
-- * Organization-level billing/subscription changes. A chain probably needs
--   a different commercial arrangement than a single branch. That is a
--   product/business decision, not a schema one, and is out of scope here.
--
-- * Rewriting any existing RLS policy or RPC. Every single addition below
--   is either a brand new table or a brand new function. Nothing in the
--   consolidated schema or the dated migrations already in this directory
--   is dropped, replaced, or altered by this file, other than two additive,
--   backward-compatible ALTER TABLE statements called out explicitly where
--   they happen (branches gains one nullable column; barcodes' status
--   CHECK constraint gains one new allowed value). Both follow the same
--   incremental-ALTER pattern already used repeatedly elsewhere in this
--   schema (e.g. notifications.source_type has been widened this way
--   several times).
--
--
-- ── HOW TO READ THE REST OF THIS FILE ───────────────────────────────────────
--
--   SECTION 1  New tables: pharmacy_organizations, organization_members,
--              stock_transfers, stock_transfer_items, and the two additive
--              ALTERs on existing tables.
--   SECTION 2  Access-control helper functions (the organization-aware
--              equivalents of current_branch_id() / assert_super_admin()).
--   SECTION 3  Organization lifecycle RPCs -- create an organization, add a
--              branch to it, invite/remove organization-level members.
--   SECTION 4  Stock transfer RPCs -- request, approve, dispatch, receive,
--              reject, cancel.
--   SECTION 5  One example organization-aware reporting RPC, as a template
--              for how the existing ai_*/analytics_* family would grow
--              chain-aware siblings later, without touching the originals.
--   SECTION 6  RECOMMENDATIONS -- my own advice, called out explicitly,
--              with the open questions that need an answer before this is
--              approved.
--   SECTION 7  Suggested rollout plan for whenever this does get approved.
--
-- Every function below follows the exact conventions already established in
-- this schema: security definer, set search_path = '', p_-prefixed
-- parameters, an assert_*() guard as the first line of anything privileged,
-- and a plain RAISE EXCEPTION with a human-readable message rather than a
-- generic Postgres error. This is written to look like it grew out of the
-- existing file, not like it was bolted on from outside it.
-- ============================================================================


-- ============================================================================
-- SECTION 1 — New tables
-- ============================================================================

-- The company. legal_name is the registered business name; trade_name is
-- optional and only needed if the chain markets itself under a different
-- public-facing brand than its legal registration (common enough in retail
-- to be worth a real column instead of overloading legal_name).
--
-- status is a SEPARATE kill switch from any one branch's own status --
-- suspending the organization (e.g. a billing lapse) is a different action
-- from suspending one branch (e.g. that branch's own license issue), and
-- conflating them would mean an organization-level problem could only ever
-- be expressed by manually locking every branch one at a time.
create table if not exists public.pharmacy_organizations (
  id uuid primary key default gen_random_uuid(),
  legal_name varchar(200) not null,
  trade_name varchar(200),
  -- The company-level RRA TIN. See the header note on EBM/VSDC alignment --
  -- this is meant to be the ONE TIN the whole chain invoices under, distinct
  -- from (and eventually authoritative over) any individual branch's own
  -- public.branches.tin, which today exists because every branch is
  -- currently assumed to be its own independent taxpayer.
  tin varchar(20),
  status varchar(20) not null default 'active' check (status in ('active', 'suspended')),
  created_at timestamptz not null default now()
);

-- Which branches belong to which organization. Nullable and with no default
-- other than null, which is the whole backward-compatibility guarantee this
-- design rests on -- see the header. A branch can belong to at most one
-- organization (a pharmacy cannot simultaneously be independently owned and
-- owned by a chain), enforced by this being a plain scalar FK, not a join
-- table.
alter table public.branches
  add column if not exists organization_id uuid references public.pharmacy_organizations(id);

create index if not exists idx_branches_organization on public.branches (organization_id) where organization_id is not null;

-- Cross-branch admin access, kept entirely separate from public.users.
-- Deliberately NOT a change to users.branch_id or users.role: every user in
-- this schema still has exactly one home branch (branch_id not null, same
-- as today) where they physically work and where their operational writes
-- stay scoped. This table is purely an ADDITIONAL grant of read/oversight
-- access across every branch in one organization, layered on top of that
-- unchanged home-branch relationship -- a branch's own manager can also
-- happen to be that chain's org_manager, without those being the same
-- concept or the same column.
--
-- Two roles, not one, mirroring the owner/manager split branches already
-- have: org_owner can restructure the organization itself (add/remove
-- branches, grant/revoke other members); org_manager gets the same
-- cross-branch VISIBILITY and operational oversight (approving transfers,
-- reading consolidated reports) without the power to change what the
-- organization itself looks like.
--
-- Unlike users_one_owner_per_branch, this does NOT enforce exactly one
-- org_owner. Real pharmacy chains often have more than one partner/owner,
-- and nothing about this design needs a single point of authority the way
-- a single branch's activation flow does. If that turns out to be wrong in
-- practice, narrowing it later is a single index, not a schema rewrite.
create table if not exists public.organization_members (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references public.pharmacy_organizations(id) on delete cascade,
  user_id uuid not null references public.users(id) on delete cascade,
  role varchar(20) not null check (role in ('org_owner', 'org_manager')),
  created_at timestamptz not null default now(),
  unique (organization_id, user_id)
);

create index if not exists idx_organization_members_user on public.organization_members (user_id);

alter table public.pharmacy_organizations enable row level security;
alter table public.organization_members enable row level security;

-- Readable by any member of the organization (both roles); only an
-- org_owner may write to the organization's own profile (name/TIN/status --
-- status changes are actually reserved for the super admin in practice, see
-- the RPCs in Section 3, but the RLS stays permissive here since every
-- mutating path already goes through security-definer functions that do
-- their own, stricter checks -- this mirrors how public.branches itself
-- only ever had a SELECT policy for the same reason).
drop policy if exists "organization members can read" on public.pharmacy_organizations;
create policy "organization members can read" on public.pharmacy_organizations
for select to authenticated
using (
  public.is_super_admin()
  or exists (select 1 from public.organization_members m where m.organization_id = id and m.user_id = (select auth.uid()))
);

drop policy if exists "organization members can read membership" on public.organization_members;
create policy "organization members can read membership" on public.organization_members
for select to authenticated
using (
  public.is_super_admin()
  or user_id = (select auth.uid())
  or exists (select 1 from public.organization_members m where m.organization_id = organization_members.organization_id and m.user_id = (select auth.uid()))
);

-- No direct INSERT/UPDATE/DELETE grant on either table from the browser --
-- every write goes through the security-definer RPCs in Section 3, the same
-- shape as public.branches (SELECT-only RLS, all writes through RPCs).
grant select on public.pharmacy_organizations to authenticated;
grant select on public.organization_members to authenticated;


-- Barcodes gain one new status: a pack/box that has been dispatched from its
-- origin branch but not yet confirmed received at its destination is
-- neither this branch's sellable stock nor that branch's yet -- it is
-- physically in a vehicle. Without a distinct status, a barcode still
-- marked 'active' during that window would still be sellable at the origin
-- branch's POS even though the physical carton has already left the
-- building. See dispatch_stock_transfer()/receive_stock_transfer() in
-- Section 4 for exactly when this gets set and cleared.
--
-- Same incremental-ALTER shape already used for notifications.source_type
-- earlier in this schema's own history -- additive, never narrows what was
-- already allowed.
alter table public.barcodes drop constraint if exists barcodes_status_check;
alter table public.barcodes add constraint barcodes_status_check
  check (status in ('active', 'sold_out', 'expired', 'recalled', 'damaged', 'in_transit'));


-- One inter-branch stock movement, start to finish. Always between two
-- branches of the SAME organization -- enforced in the RPCs below (a plain
-- CHECK constraint cannot express "these two FKs' referenced rows share a
-- third value" without a trigger, and a trigger duplicating what
-- request_stock_transfer() already validates is redundant surface area).
create table if not exists public.stock_transfers (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references public.pharmacy_organizations(id),
  from_branch_id uuid not null references public.branches(id),
  to_branch_id uuid not null references public.branches(id),
  status varchar(20) not null default 'pending'
    check (status in ('pending', 'approved', 'in_transit', 'received', 'rejected', 'cancelled')),
  requested_by uuid not null references public.users(id),
  approved_by uuid references public.users(id),
  requested_at timestamptz not null default now(),
  approved_at timestamptz,
  dispatched_at timestamptz,
  received_at timestamptz,
  notes text,
  rejection_reason text,
  check (from_branch_id <> to_branch_id)
);

create index if not exists idx_stock_transfers_from on public.stock_transfers (from_branch_id, status);
create index if not exists idx_stock_transfers_to on public.stock_transfers (to_branch_id, status);
create index if not exists idx_stock_transfers_org on public.stock_transfers (organization_id, requested_at desc);

-- One row per WHOLE stock_batches row being moved by this transfer -- not
-- per unit, not per barcode. A transfer moves entire batches, never a
-- partial split of one. This is a deliberate scope decision for this first
-- version, not a limitation nobody noticed:
--
-- Every barcode in this schema is a physical, printed label
-- (generate_short_barcode_code()) -- the sticker on a real box or pack. A
-- transfer that could move HALF of a batch's packs to another branch would
-- need to either (a) print entirely new barcodes for the moved half, which
-- means the physical stickers already on those boxes stop matching what
-- the system says is on them the moment they cross a branch boundary, or
-- (b) invent some notion of a barcode belonging to a different logical
-- batch than the sticker printed on it implies. Neither is a small,
-- confident addition to design blind. Restricting a transfer to WHOLE
-- batches sidesteps the problem entirely: moving a batch is just
-- re-pointing its existing stock_batches.branch_id (Section 4), and every
-- barcode already printed and stuck on those boxes stays exactly as valid
-- after the move as before it. If partial-batch transfers turn out to be
-- needed in practice, that is a real follow-up design, not a checkbox to
-- rush in here -- see RECOMMENDATIONS.
create table if not exists public.stock_transfer_items (
  id uuid primary key default gen_random_uuid(),
  transfer_id uuid not null references public.stock_transfers(id) on delete cascade,
  stock_batch_id uuid not null references public.stock_batches(id),
  unique (transfer_id, stock_batch_id)
);

create index if not exists idx_stock_transfer_items_batch on public.stock_transfer_items (stock_batch_id);

alter table public.stock_transfers enable row level security;
alter table public.stock_transfer_items enable row level security;

-- Visible to: the sending branch, the receiving branch, or any member of
-- the owning organization. Writes go through the RPCs in Section 4, each of
-- which re-derives and re-checks who is allowed to act at every step of the
-- workflow -- this policy only governs reading the record, not acting on it.
drop policy if exists "transfer visible to involved branches or org" on public.stock_transfers;
create policy "transfer visible to involved branches or org" on public.stock_transfers
for select to authenticated
using (
  public.is_super_admin()
  or from_branch_id = public.current_branch_id()
  or to_branch_id = public.current_branch_id()
  or exists (select 1 from public.organization_members m where m.organization_id = stock_transfers.organization_id and m.user_id = (select auth.uid()))
);

drop policy if exists "transfer items follow their transfer" on public.stock_transfer_items;
create policy "transfer items follow their transfer" on public.stock_transfer_items
for select to authenticated
using (
  exists (
    select 1 from public.stock_transfers t
    where t.id = transfer_id
      and (
        public.is_super_admin()
        or t.from_branch_id = public.current_branch_id()
        or t.to_branch_id = public.current_branch_id()
        or exists (select 1 from public.organization_members m where m.organization_id = t.organization_id and m.user_id = (select auth.uid()))
      )
  )
);

grant select on public.stock_transfers to authenticated;
grant select on public.stock_transfer_items to authenticated;


-- ============================================================================
-- SECTION 2 — Access-control helpers
-- ============================================================================

-- Every branch_id the calling user may READ: their own home branch (always
-- -- this is exactly current_branch_id()'s existing result, unchanged) plus,
-- if they hold ANY organization_members row, every branch under that same
-- organization. A user with no organization membership gets back exactly
-- what current_branch_id() alone would have given them -- one row, their
-- own branch -- so this function is a strict superset, never a narrowing,
-- of the access every existing user already has today.
--
-- Named for what it is used for -- consciously not calling this
-- current_branch_id()'s replacement, because it is not one. Existing RLS
-- policies and RPCs keep calling current_branch_id() and stay exactly as
-- narrow as they are today; this new function is additive, only ever used
-- by brand-new, organization-aware read paths (see Section 5).
create or replace function public.current_accessible_branch_ids()
returns setof uuid
language sql
stable
security definer
set search_path = ''
as $$
  select b.id
  from public.branches b
  where b.id = public.current_branch_id()
  union
  select b2.id
  from public.branches b2
  where b2.organization_id in (
    select m.organization_id
    from public.organization_members m
    where m.user_id = (select auth.uid())
  )
$$;

create or replace function public.is_org_member(p_organization_id uuid)
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  select exists (
    select 1 from public.organization_members m
    where m.organization_id = p_organization_id and m.user_id = (select auth.uid())
  )
$$;

create or replace function public.assert_org_owner(p_organization_id uuid)
returns void
language plpgsql
stable
security definer
set search_path = ''
as $$
begin
  if not exists (
    select 1 from public.organization_members m
    where m.organization_id = p_organization_id and m.user_id = (select auth.uid()) and m.role = 'org_owner'
  ) then
    raise exception 'Only an owner of this organization may do that';
  end if;
end;
$$;

create or replace function public.assert_org_member(p_organization_id uuid)
returns void
language plpgsql
stable
security definer
set search_path = ''
as $$
begin
  if not public.is_org_member(p_organization_id) then
    raise exception 'You are not a member of this organization';
  end if;
end;
$$;

revoke all on function public.current_accessible_branch_ids() from public, anon;
grant execute on function public.current_accessible_branch_ids() to authenticated;
revoke all on function public.is_org_member(uuid) from public, anon;
grant execute on function public.is_org_member(uuid) to authenticated;
revoke all on function public.assert_org_owner(uuid) from public, anon;
grant execute on function public.assert_org_owner(uuid) to authenticated;
revoke all on function public.assert_org_member(uuid) from public, anon;
grant execute on function public.assert_org_member(uuid) to authenticated;


-- ============================================================================
-- SECTION 3 — Organization lifecycle
-- ============================================================================

-- Founds a new organization AROUND the calling user's own existing branch --
-- the natural on-ramp for a pharmacy that started as one standalone location
-- (exactly today's model) and is now expanding. Their branch becomes the
-- organization's first member and they become its first org_owner. Nothing
-- about their existing branch changes except gaining an organization_id --
-- same branch_code, same stock, same staff, same everything.
create or replace function public.create_pharmacy_organization(p_legal_name text, p_tin text default null)
returns uuid
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_user uuid := (select auth.uid());
  v_branch uuid;
  v_org uuid;
begin
  select u.branch_id into v_branch
  from public.users u
  where u.id = v_user and u.is_active and u.role = 'owner';
  if v_branch is null then
    raise exception 'Only an active branch owner may create a pharmacy organization';
  end if;

  if exists (select 1 from public.branches where id = v_branch and organization_id is not null) then
    raise exception 'This branch already belongs to an organization';
  end if;
  if nullif(btrim(coalesce(p_legal_name, '')), '') is null then
    raise exception 'A company/legal name is required';
  end if;

  insert into public.pharmacy_organizations (legal_name, tin)
  values (btrim(p_legal_name), nullif(btrim(coalesce(p_tin, '')), ''))
  returning id into v_org;

  update public.branches set organization_id = v_org where id = v_branch;

  insert into public.organization_members (organization_id, user_id, role)
  values (v_org, v_user, 'org_owner');

  return v_org;
end;
$$;

-- Adds a brand-new location directly under an existing organization.
-- Created ACTIVE immediately, unlike submit_pharmacy_registration()'s
-- public cold-registration flow, which exists to let a super admin phone-
-- verify a complete stranger before granting access -- there is nothing
-- left to verify here: an org_owner adding a second location to a business
-- the platform has already vetted is not a stranger.
--
-- What this deliberately does NOT do: create a login for anyone to operate
-- the new branch. Staffing it (an owner or seller account tied to
-- v_branch) is a separate step -- see the open question in
-- RECOMMENDATIONS about reusing supabase/functions/create-branch-seller
-- for this, since minting a real Supabase Auth login is an Admin-API
-- operation, not something a plain SQL function can do.
create or replace function public.add_branch_to_organization(
  p_organization_id uuid, p_pharmacy_name text, p_phone text, p_email text, p_location text
)
returns uuid
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_branch uuid := gen_random_uuid();
begin
  perform public.assert_org_owner(p_organization_id);

  if nullif(btrim(coalesce(p_pharmacy_name, '')), '') is null then
    raise exception 'A branch name is required';
  end if;
  if exists (select 1 from public.pharmacy_organizations where id = p_organization_id and status <> 'active') then
    raise exception 'This organization is not active';
  end if;

  insert into public.branches (id, organization_id, name, phone, email, address, status)
  values (
    v_branch, p_organization_id, btrim(p_pharmacy_name),
    nullif(btrim(coalesce(p_phone, '')), ''), nullif(btrim(coalesce(p_email, '')), ''),
    nullif(btrim(coalesce(p_location, '')), ''), 'active'
  );

  -- Same reasoning as activate_pharmacy_account()'s own branch_directory
  -- insert: every branch, including one created this way, has to appear in
  -- the public sign-in directory the moment it can be signed into.
  insert into public.branch_directory (branch_id, display_name)
  values (v_branch, btrim(p_pharmacy_name));

  return v_branch;
end;
$$;

-- Grants (or re-grants, if this user already left and rejoined) an
-- EXISTING branch user cross-organization access -- e.g. making the branch
-- manager who already runs Kigali's day-to-day also able to see every
-- other branch's numbers. Does not create a new login; the user must
-- already exist in public.users.
create or replace function public.invite_organization_member(
  p_organization_id uuid, p_user_email text, p_role text default 'org_manager'
)
returns void
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_target uuid;
begin
  perform public.assert_org_owner(p_organization_id);
  if p_role not in ('org_owner', 'org_manager') then
    raise exception 'role must be org_owner or org_manager';
  end if;

  select id into v_target from public.users where lower(email) = lower(btrim(p_user_email));
  if v_target is null then
    raise exception 'No user found with that email';
  end if;

  insert into public.organization_members (organization_id, user_id, role)
  values (p_organization_id, v_target, p_role)
  on conflict (organization_id, user_id) do update set role = excluded.role;
end;
$$;

create or replace function public.remove_organization_member(p_organization_id uuid, p_user_id uuid)
returns void
language plpgsql
security definer
set search_path = ''
as $$
begin
  perform public.assert_org_owner(p_organization_id);
  -- An org_owner may not remove themselves this way if they are the LAST
  -- owner -- that would leave the organization with no one able to manage
  -- it at all (short of a super admin stepping in). A different org_owner
  -- removing them is fine; nothing stops the organization dropping to zero
  -- org_managers, only zero org_owners.
  if (select role from public.organization_members where organization_id = p_organization_id and user_id = p_user_id) = 'org_owner'
     and (select count(*) from public.organization_members where organization_id = p_organization_id and role = 'org_owner') <= 1 then
    raise exception 'Cannot remove the last owner of an organization';
  end if;

  delete from public.organization_members where organization_id = p_organization_id and user_id = p_user_id;
end;
$$;

-- Everything an org member needs for a "my organization" screen: the
-- company profile plus every branch under it, in one call.
create or replace function public.get_my_organization()
returns table(
  organization_id uuid, legal_name text, trade_name text, tin text, status text,
  my_role text, branch_count integer
)
language sql
stable
security definer
set search_path = ''
as $$
  select
    o.id, o.legal_name::text, o.trade_name::text, o.tin::text, o.status::text,
    m.role::text,
    (select count(*)::integer from public.branches b where b.organization_id = o.id)
  from public.organization_members m
  join public.pharmacy_organizations o on o.id = m.organization_id
  where m.user_id = (select auth.uid())
$$;

create or replace function public.list_organization_branches(p_organization_id uuid)
returns table(
  branch_id uuid, name text, address text, phone text, branch_code text, status text, created_at timestamptz
)
language plpgsql
stable
security definer
set search_path = ''
as $$
begin
  perform public.assert_org_member(p_organization_id);
  return query
    select b.id, b.name::text, b.address, b.phone, b.branch_code::text, b.status::text, b.created_at
    from public.branches b
    where b.organization_id = p_organization_id
    order by b.name;
end;
$$;

revoke all on function public.create_pharmacy_organization(text, text) from public, anon;
grant execute on function public.create_pharmacy_organization(text, text) to authenticated;
revoke all on function public.add_branch_to_organization(uuid, text, text, text, text) from public, anon;
grant execute on function public.add_branch_to_organization(uuid, text, text, text, text) to authenticated;
revoke all on function public.invite_organization_member(uuid, text, text) from public, anon;
grant execute on function public.invite_organization_member(uuid, text, text) to authenticated;
revoke all on function public.remove_organization_member(uuid, uuid) from public, anon;
grant execute on function public.remove_organization_member(uuid, uuid) to authenticated;
revoke all on function public.get_my_organization() from public, anon;
grant execute on function public.get_my_organization() to authenticated;
revoke all on function public.list_organization_branches(uuid) from public, anon;
grant execute on function public.list_organization_branches(uuid) to authenticated;


-- ============================================================================
-- SECTION 4 — Stock transfers between branches
-- ============================================================================
-- pending -> approved -> in_transit -> received
--                \-> rejected              (before dispatch only)
--        \-> cancelled                     (before dispatch only)
--
-- Once a transfer is in_transit, it can only ever resolve to received --
-- reversing a shipment that has physically left a building is a real-world
-- logistics problem (loss, damage, a wrong turn), not a status flip, and
-- deliberately is not handled by cancel_stock_transfer() below. See
-- RECOMMENDATIONS for how an in-transit loss should actually be handled.

-- Raised by the SENDING branch's own owner/manager. Every batch listed must
-- already belong to the caller's own current_branch_id() (never someone
-- else's), and the destination must be a different branch in the SAME
-- organization -- this is the one place that "same organization" rule from
-- the header is actually enforced.
create or replace function public.request_stock_transfer(
  p_to_branch_id uuid, p_stock_batch_ids uuid[], p_notes text default null
)
returns uuid
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_user uuid := (select auth.uid());
  v_from_branch uuid;
  v_organization uuid;
  v_transfer uuid;
  v_batch_id uuid;
begin
  select u.branch_id into v_from_branch
  from public.users u
  where u.id = v_user and u.is_active and u.role in ('owner', 'manager');
  if v_from_branch is null then
    raise exception 'Only an active branch manager or owner may request a stock transfer';
  end if;
  if v_from_branch = p_to_branch_id then
    raise exception 'Cannot transfer stock to the same branch';
  end if;

  select organization_id into v_organization from public.branches where id = v_from_branch;
  if v_organization is null or v_organization <> (select organization_id from public.branches where id = p_to_branch_id) then
    raise exception 'The destination branch is not part of the same organization';
  end if;

  if p_stock_batch_ids is null or array_length(p_stock_batch_ids, 1) is null then
    raise exception 'At least one stock batch is required';
  end if;

  insert into public.stock_transfers (organization_id, from_branch_id, to_branch_id, requested_by, notes)
  values (v_organization, v_from_branch, p_to_branch_id, v_user, nullif(btrim(coalesce(p_notes, '')), ''))
  returning id into v_transfer;

  foreach v_batch_id in array p_stock_batch_ids loop
    if not exists (select 1 from public.stock_batches where id = v_batch_id and branch_id = v_from_branch) then
      raise exception 'Batch % does not belong to this branch', v_batch_id;
    end if;
    insert into public.stock_transfer_items (transfer_id, stock_batch_id) values (v_transfer, v_batch_id);
  end loop;

  return v_transfer;
end;
$$;

-- Either the RECEIVING branch's own owner/manager (they are agreeing to
-- take the stock in) or any org-level member (central oversight) may
-- approve. Either is sufficient on its own -- this is a judgement call, see
-- RECOMMENDATIONS on whether both should be required instead.
create or replace function public.approve_stock_transfer(p_transfer_id uuid)
returns void
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_transfer public.stock_transfers%rowtype;
  v_user uuid := (select auth.uid());
begin
  select * into v_transfer from public.stock_transfers where id = p_transfer_id;
  if v_transfer.id is null then raise exception 'Transfer not found'; end if;
  if v_transfer.status <> 'pending' then raise exception 'Only a pending transfer can be approved'; end if;

  if not (
    public.is_org_member(v_transfer.organization_id)
    or exists (
      select 1 from public.users u
      where u.id = v_user and u.is_active and u.role in ('owner', 'manager') and u.branch_id = v_transfer.to_branch_id
    )
  ) then
    raise exception 'Only the receiving branch or an organization member may approve this transfer';
  end if;

  update public.stock_transfers
  set status = 'approved', approved_by = v_user, approved_at = now()
  where id = p_transfer_id;
end;
$$;

-- The SENDING branch confirms physical hand-off. This is the moment every
-- transferred batch's active packs stop being sellable at the origin --
-- they are no longer on that branch's shelf. See the barcodes.status
-- ALTER in Section 1 for why 'in_transit' exists as its own state rather
-- than just leaving them 'active' until received.
create or replace function public.dispatch_stock_transfer(p_transfer_id uuid)
returns void
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_transfer public.stock_transfers%rowtype;
  v_from_branch uuid;
begin
  select * into v_transfer from public.stock_transfers where id = p_transfer_id;
  if v_transfer.id is null then raise exception 'Transfer not found'; end if;
  if v_transfer.status <> 'approved' then raise exception 'Only an approved transfer can be dispatched'; end if;

  select u.branch_id into v_from_branch
  from public.users u
  where u.id = (select auth.uid()) and u.is_active and u.role in ('owner', 'manager');
  if v_from_branch is null or v_from_branch <> v_transfer.from_branch_id then
    raise exception 'Only the sending branch may dispatch this transfer';
  end if;

  update public.barcodes
  set status = 'in_transit'
  where status = 'active'
    and stock_batch_id in (select stock_batch_id from public.stock_transfer_items where transfer_id = p_transfer_id);

  update public.stock_transfers set status = 'in_transit', dispatched_at = now() where id = p_transfer_id;
end;
$$;

-- The RECEIVING branch confirms the stock has physically arrived. Moves
-- every transferred batch's branch_id to the destination -- no new
-- barcodes, no cloned batch rows, the exact same printed labels that left
-- the origin branch are what the destination branch now owns. Guards
-- against the destination already independently holding the same
-- (product_variant_id, batch_number) combination, which stock_batches'
-- own unique constraint would otherwise reject with a raw, unfriendly
-- database error.
create or replace function public.receive_stock_transfer(p_transfer_id uuid)
returns void
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_transfer public.stock_transfers%rowtype;
  v_to_branch uuid;
  v_item record;
begin
  select * into v_transfer from public.stock_transfers where id = p_transfer_id;
  if v_transfer.id is null then raise exception 'Transfer not found'; end if;
  if v_transfer.status <> 'in_transit' then raise exception 'Only a transfer that is in transit can be received'; end if;

  select u.branch_id into v_to_branch
  from public.users u
  where u.id = (select auth.uid()) and u.is_active and u.role in ('owner', 'manager');
  if v_to_branch is null or v_to_branch <> v_transfer.to_branch_id then
    raise exception 'Only the receiving branch may confirm this transfer';
  end if;

  for v_item in
    select sti.stock_batch_id, sb.product_variant_id, sb.batch_number
    from public.stock_transfer_items sti
    join public.stock_batches sb on sb.id = sti.stock_batch_id
    where sti.transfer_id = p_transfer_id
  loop
    if exists (
      select 1 from public.stock_batches sb2
      where sb2.branch_id = v_to_branch
        and sb2.product_variant_id = v_item.product_variant_id
        and sb2.batch_number = v_item.batch_number
        and sb2.id <> v_item.stock_batch_id
    ) then
      raise exception 'Batch number % for this product already exists at the receiving branch -- resolve the clash before receiving this transfer', v_item.batch_number;
    end if;

    update public.stock_batches set branch_id = v_to_branch where id = v_item.stock_batch_id;

    update public.barcodes
    set status = 'active'
    where status = 'in_transit' and stock_batch_id = v_item.stock_batch_id;
  end loop;

  update public.stock_transfers set status = 'received', received_at = now() where id = p_transfer_id;
end;
$$;

-- Only before dispatch -- once stock has physically left the building,
-- see the header note on why this workflow does not support reversing an
-- in-transit shipment.
create or replace function public.reject_stock_transfer(p_transfer_id uuid, p_reason text default null)
returns void
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_transfer public.stock_transfers%rowtype;
begin
  select * into v_transfer from public.stock_transfers where id = p_transfer_id;
  if v_transfer.id is null then raise exception 'Transfer not found'; end if;
  if v_transfer.status not in ('pending', 'approved') then
    raise exception 'Only a pending or approved transfer can be rejected';
  end if;
  if not (
    public.is_org_member(v_transfer.organization_id)
    or exists (
      select 1 from public.users u
      where u.id = (select auth.uid()) and u.is_active and u.role in ('owner', 'manager') and u.branch_id = v_transfer.to_branch_id
    )
  ) then
    raise exception 'Only the receiving branch or an organization member may reject this transfer';
  end if;

  update public.stock_transfers
  set status = 'rejected', rejection_reason = nullif(btrim(coalesce(p_reason, '')), '')
  where id = p_transfer_id;
end;
$$;

create or replace function public.cancel_stock_transfer(p_transfer_id uuid)
returns void
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_transfer public.stock_transfers%rowtype;
  v_from_branch uuid;
begin
  select * into v_transfer from public.stock_transfers where id = p_transfer_id;
  if v_transfer.id is null then raise exception 'Transfer not found'; end if;
  if v_transfer.status not in ('pending', 'approved') then
    raise exception 'Only a pending or approved transfer can be cancelled';
  end if;

  select u.branch_id into v_from_branch
  from public.users u
  where u.id = (select auth.uid()) and u.is_active and u.role in ('owner', 'manager');
  if v_from_branch is null or v_from_branch <> v_transfer.from_branch_id then
    raise exception 'Only the sending branch may cancel this transfer';
  end if;

  update public.stock_transfers set status = 'cancelled' where id = p_transfer_id;
end;
$$;

create or replace function public.list_branch_stock_transfers()
returns table(
  id uuid, from_branch_name text, to_branch_name text, status text, batch_count integer,
  requested_by_name text, notes text, rejection_reason text, requested_at timestamptz, received_at timestamptz
)
language sql
stable
security definer
set search_path = ''
as $$
  select
    t.id, fb.name::text, tb.name::text, t.status::text,
    (select count(*)::integer from public.stock_transfer_items i where i.transfer_id = t.id),
    u.full_name::text, t.notes, t.rejection_reason, t.requested_at, t.received_at
  from public.stock_transfers t
  join public.branches fb on fb.id = t.from_branch_id
  join public.branches tb on tb.id = t.to_branch_id
  left join public.users u on u.id = t.requested_by
  where t.from_branch_id = public.current_branch_id() or t.to_branch_id = public.current_branch_id()
  order by t.requested_at desc
$$;

revoke all on function public.request_stock_transfer(uuid, uuid[], text) from public, anon;
grant execute on function public.request_stock_transfer(uuid, uuid[], text) to authenticated;
revoke all on function public.approve_stock_transfer(uuid) from public, anon;
grant execute on function public.approve_stock_transfer(uuid) to authenticated;
revoke all on function public.dispatch_stock_transfer(uuid) from public, anon;
grant execute on function public.dispatch_stock_transfer(uuid) to authenticated;
revoke all on function public.receive_stock_transfer(uuid) from public, anon;
grant execute on function public.receive_stock_transfer(uuid) to authenticated;
revoke all on function public.reject_stock_transfer(uuid, text) from public, anon;
grant execute on function public.reject_stock_transfer(uuid, text) to authenticated;
revoke all on function public.cancel_stock_transfer(uuid) from public, anon;
grant execute on function public.cancel_stock_transfer(uuid) to authenticated;
revoke all on function public.list_branch_stock_transfers() from public, anon;
grant execute on function public.list_branch_stock_transfers() to authenticated;


-- ============================================================================
-- SECTION 5 — Example organization-aware reporting RPC
-- ============================================================================
-- A template, not a complete analytics suite. The existing ai_*/analytics_*
-- functions (AnalyticsPage.tsx, the AI analyst) are all built the same way:
-- assert a role, resolve current_branch_id(), query scoped to it. Growing
-- chain-aware versions of each one later means the exact same shape, with
-- current_branch_id() = ANY(current_accessible_branch_ids()) and a GROUP BY
-- branch_id added to the SELECT list -- mechanical, not risky, and does not
-- require touching a single existing analytics function. This one example
-- (today/week/month revenue and stock alerts, per branch, for one
-- organization) is enough to validate the pattern before committing to
-- rewriting the whole analytics family this way.
create or replace function public.org_branch_summary(p_organization_id uuid)
returns table(
  branch_id uuid, branch_name text, today_revenue numeric, month_to_date_revenue numeric,
  out_of_stock_count integer, low_stock_count integer, pending_transfers_in integer
)
language plpgsql
security definer
set search_path = ''
as $$
begin
  perform public.assert_org_member(p_organization_id);

  return query
  select
    b.id, b.name::text,
    coalesce((
      select round(sum(si.unit_price * si.quantity), 2)
      from public.sale_items si join public.sales s on s.id = si.sale_id
      where s.branch_id = b.id and s.sold_at >= date_trunc('day', now())
    ), 0),
    coalesce((
      select round(sum(si.unit_price * si.quantity), 2)
      from public.sale_items si join public.sales s on s.id = si.sale_id
      where s.branch_id = b.id and s.sold_at >= date_trunc('month', now())
    ), 0),
    (
      select count(distinct pv.id)::integer
      from public.stock_batches sb
      join public.product_variants pv on pv.id = sb.product_variant_id
      left join public.barcodes bc on bc.stock_batch_id = sb.id and bc.barcode_type = 'pack'
      where sb.branch_id = b.id
      group by sb.branch_id
      having coalesce(sum(bc.quantity_available * bc.pieces_per_pack), 0) = 0
    ),
    (
      select count(*)::integer from public.reorder_points rp
      join public.stock_batches sb2 on sb2.product_variant_id = rp.product_id and sb2.branch_id = rp.branch_id
      where rp.branch_id = b.id
    ),
    (select count(*)::integer from public.stock_transfers t where t.to_branch_id = b.id and t.status in ('pending', 'approved', 'in_transit'))
  from public.branches b
  where b.organization_id = p_organization_id
  order by b.name;
end;
$$;

revoke all on function public.org_branch_summary(uuid) from public, anon;
grant execute on function public.org_branch_summary(uuid) to authenticated;


-- ============================================================================
-- SECTION 6 — RECOMMENDATIONS AND OPEN QUESTIONS
-- ============================================================================
-- Read before approving this design. These are judgement calls I made to
-- produce a concrete, complete first draft; several of them are genuinely
-- close calls that deserve a decision from you, not just my assumption.
--
-- 1. CONFIRM THE RRA/EBM BRANCH MAPPING BEFORE THIS SHIPS.
--    pharmacy_organizations.tin is designed to be the one company-level TIN
--    RRA's EBM system invoices under, with each branch mapping to an RRA
--    branch code underneath it. I have not verified the exact branch-code
--    format RRA's VSDC integration expects (this schema's own Overview page
--    already flags RRA/VSDC as "Not configured" -- that work has not
--    started yet). Confirm this before locking the schema, since it may
--    want an explicit ebm_branch_code column on public.branches rather than
--    relying on branch_code (PharmSync's own internal identifier, unrelated
--    to RRA's numbering).
--
-- 2. SHOULD APPROVING A TRANSFER REQUIRE BOTH SIDES, NOT EITHER?
--    approve_stock_transfer() currently lets EITHER the receiving branch OR
--    any org-level member approve on their own. The alternative -- require
--    both an org signal AND the receiving branch's own agreement -- is more
--    cautious but adds a step to every single transfer. I picked the
--    single-approval version to keep the common case fast; reconsider if a
--    chain's real workflow wants the receiving branch to always have a say
--    even when head office has already decided.
--
-- 3. AN IN-TRANSIT LOSS IS NOT HANDLED BY THIS WORKFLOW ON PURPOSE.
--    Once a transfer is 'in_transit', it can only resolve to 'received'.
--    A real shipment that is lost, stolen, or damaged in transit needs a
--    human decision about who absorbs the loss, which is a business
--    process, not a status flip. My recommendation: when that happens, the
--    origin branch's owner/manager records it as a plain stock_adjustment
--    (adjustment_type 'loss', which already exists) against the batch, and
--    the transfer itself gets a manual note -- do not add an automatic
--    "transfer failed, restore stock" RPC without a real incident to design
--    it against; a rushed automatic reversal is exactly the kind of thing
--    that quietly corrupts inventory numbers if the real-world edge case
--    turns out to be subtly different from what was imagined here.
--
-- 4. PARTIAL-BATCH TRANSFERS: A REAL PHASE-2 CANDIDATE, NOT INCLUDED HERE.
--    See the long comment on stock_transfer_items above. If, after using
--    whole-batch transfers for a while, it turns out pharmacies frequently
--    want to split a batch across two branches, the honest way to build
--    that is: clone the stock_batches row (same batch_number/expiry/cost/
--    manufacturer, new id) under the destination branch, then re-point only
--    the specific transferred barcodes.stock_batch_id to the clone --
--    WITHOUT touching their `code`, so the physical sticker on each moved
--    pack stays exactly what it always was. That is a bigger, riskier
--    change than anything in this file and deserves its own design pass
--    once whole-batch transfers have proven the rest of the workflow works.
--
-- 5. SHARED PATIENT IDENTITY ACROSS BRANCHES IS DELIBERATELY OUT OF SCOPE.
--    A patient seen at two branches of the same chain is still two
--    unconnected rows after this proposal. Recognizing them as the same
--    person needs real matching logic (name/phone/TIN alone is not
--    reliable at chain scale) and a clear answer to "whose record wins" --
--    it is a genuinely separate feature, not a column to bolt on here.
--
-- 6. TERMINOLOGY COLLISION WORTH A PRODUCT DECISION, NOT JUST A SCHEMA ONE.
--    "Branch" already means "an entire independent pharmacy" everywhere in
--    today's UI copy and translated strings -- branch_code, "Register your
--    pharmacy," the Branch Settings page, all of it. This proposal makes
--    "branch" ALSO correctly mean "one location within a chain," which is a
--    real ambiguity a pharmacy owner reading the UI could trip over. I
--    deliberately did not rename public.branches (it is threaded through
--    50+ existing functions and renaming it is pure, unnecessary risk for
--    a schema change), but before any UI gets built on top of this, decide
--    whether the product itself should introduce a clearer word for "one
--    physical location" (a lot of retail software says "Location" or
--    "Store" once a parent company exists) so the three-language
--    translation work already done for the rest of this app does not have
--    to retrofit a meaning change onto strings that were written assuming
--    "branch" always meant "a whole pharmacy."
--
-- 7. STAFFING A NEWLY ADDED BRANCH NEEDS A FOLLOW-UP, NOT INVENTED HERE.
--    add_branch_to_organization() creates a branch with no one able to sign
--    into it yet. Minting a real login is an Admin-API operation (setting
--    an actual password for someone else), which is exactly what
--    supabase/functions/create-branch-seller already does for the existing
--    seller-creation flow -- extending that Edge Function (or a sibling of
--    it) to also handle "assign an owner/manager to a freshly added branch"
--    is the natural next piece of work once this schema is approved, not
--    something expressible in plain SQL.
--
-- 8. BILLING FOR A CHAIN IS A BUSINESS DECISION THIS FILE DOES NOT MAKE.
--    Whether an organization is priced per branch, as one flat chain plan,
--    or some other way is entirely outside what a schema proposal should
--    decide. Flagging it only so it does not get forgotten before this
--    ships to a real paying multi-branch customer.
--
--
-- ============================================================================
-- SECTION 7 — Suggested rollout, once this is approved
-- ============================================================================
-- 1. Resolve the open questions above, especially #1 (RRA/EBM mapping) and
--    #6 (terminology) -- both are cheaper to settle before writing UI than
--    after.
-- 2. Split this file into its own dated migration (e.g.
--    2026-MM-DD_multi_branch_organizations.sql) at that point, following
--    this schema's own established discipline: DROP FUNCTION before
--    CREATE OR REPLACE for anything whose signature changes on a later
--    revision, re-declare grants after every such drop (a DROP FUNCTION
--    takes its grants with it -- this cost real time to relearn earlier in
--    this project), and validate the file's dollar-quoting is balanced
--    before ever pasting it into the SQL editor.
-- 3. Apply it FIRST against a disposable/staging Supabase project, not
--    production directly -- this is a wider-blast-radius change than any
--    single dated migration in this directory so far (it touches
--    public.barcodes' status constraint, which every sale and every
--    inventory screen reads).
-- 4. Only after that: build the actual UI (an "Organization" section in the
--    super admin console or a new owner-facing area, a stock-transfer
--    screen, an organization-wide dashboard) -- none of which this file
--    attempts, on purpose, since UI work should follow an approved schema,
--    not run ahead of one.
-- ============================================================================
