# Roadmap: org_owner / org_manager / branch_manager operations

Working notes for a multi-session build. Update the "Status" line on each
phase as work lands; keep the "Open decisions" lists trimmed as they get
resolved so this stays a live plan, not a transcript.

## IMPORTANT: run 2026-09-16_catch_up_full_state.sql -- it supersedes the rest

Two separate failure modes bit repeatedly across this build, both rooted in
there being no migration runner here:

1. **Same-dated files are not inherently ordered.** Several 2026-09-15
   files redeclare the same functions as each other, each layering a
   further fix on the last. Running a day's files alphabetically ran some
   out of order, so an alphabetically-later file's OLDER body silently
   overwrote a newer fix.
2. **Some files were simply never applied**, and nothing surfaced that
   until a dependent function failed at runtime -- "column b.latitude does
   not exist" proved branches.latitude had never been created even though
   functions referencing it had been. That single missing column made
   list_organization_branches() fail outright, which is why the Branches
   tab read "0 branches" rather than merely missing its map pins.

**Fix:** `src/datatabase/2026-09-16_catch_up_full_state.sql` is a single
idempotent file holding the final correct state of everything this session
touched -- columns and constraints first, then shared helpers, then the 17
functions that depend on them. Run that one file and the database is
correct regardless of which earlier files were or weren't applied, and in
what order. The earlier per-feature files are kept for history but should
not be replayed individually.

## Already answered / already true (no build needed)

- **Never delete a branch manager or seller, only deactivate.** This schema
  has no per-user delete RPC anywhere except `admin_delete_branch()`, which
  wipes an entire branch. `org_set_user_active()` / `admin_set_seller_active()`
  are the only lifecycle actions and they're both toggles. This is already
  the right design -- nothing to change.
- **A deactivated/replaced manager's sellers are unaffected.** `public.users`
  has no `created_by` column; a seller's ability to work depends only on
  `branch_id` + `is_active`, never on who invited them. Firing a manager
  cannot break their sellers.
- **Passwords are never visible anywhere, to anyone** -- Supabase Auth owns
  them, this app never reads them back. Email addresses ARE visible to
  org_owner/org_manager in the organization member list, because they need
  it to manage that person (deactivate, reassign, etc.) -- this is
  intentional, not a leak. If a specific screen shows an owner's email
  somewhere it shouldn't (e.g. to a plain seller), flag the exact screen.
- **"Staff" vs "Seller" labeling** -- fixed 2026-09-14. The Invite/Change-Role
  picker used to show "Manager / Staff" where "Staff" secretly meant
  `seller`. Now shows "Manager / Seller" in en/fr/rw
  (`src/lib/i18n/{en,fr,rw}.ts`, key `branchSettings.roleStaff`).
- **New staff login is immediate (email + password you set), no email
  verification step.** Decided 2026-09-14: keep it immediate, but add a
  non-blocking welcome email afterward so a typo'd address surfaces via a
  bounce instead of silently creating an unreachable account. **Not built
  yet** -- Supabase's Admin API (`auth.admin.createUser`) doesn't send any
  email on its own; sending one needs either (a) a transactional email
  provider (Resend, SendGrid, etc. -- needs an API key added as an Edge
  Function secret) called directly from `create-branch-seller`, or (b)
  wiring up Supabase's own SMTP settings + an auth email template. Needs the
  user to say which before this can be built.

## Phase 1 -- org_owner/org_manager can manage a branch's Settings while
viewing it -- DONE (2026-09-14)

**Built:** `get_my_branch_details()`, `update_branch_details()`,
`list_branch_categories()`, `list_branch_discounts()`,
`admin_set_seller_active()`, `admin_update_staff_role()` all gained an
optional `p_branch_id` resolved through `effective_branch_id()`; a brand-new
`list_branch_staff()` RPC replaces the old plain-select (which only ever
worked for your own branch, via RLS). Frontend: `BranchSettingsPage` takes a
`branchId` prop and forwards it everywhere; `App.tsx` passes
`branchId={viewingBranchId}` and elevates the `role` prop to `"owner"`
whenever the viewed branch isn't the caller's own (only possible for an
org_owner/org_manager in the first place). Migration file:
`src/datatabase/2026-09-14_org_manage_branch_settings.sql` -- still needs to
be run against the live Supabase project.

**Not yet done:** the `2026-09-14_org_manage_branch_settings.sql` file above
has not been run against the live Supabase project yet -- do that in the SQL
editor before testing.

## Role hierarchy verified + one real fix -- DONE (2026-09-14)

Confirmed against the user's stated model (org_owner > org_manager > branch
owner/manager > seller, each sees everyone below, never above): already true
almost everywhere (org-level people already couldn't be seen at all by a
plain branch owner/manager/seller with no org role -- `assert_org_member`
blocks them outright). The one real gap: `list_organization_people()` and
`list_organization_members()` let org_manager see the org_owner's email --
fixed in `2026-09-14_role_hierarchy_visibility.sql` (name/role still shown,
email masked specifically when caller is org_manager viewing the org_owner's
row). Frontend: `OrganizationPerson.email` is now `string | null`;
`OrganizationPage.tsx` shows "—" when hidden.

Also confirmed, no fix needed: an org_manager's "home branch" (where their
login is parked) never restricts or defines their authority -- that's
already fully org-wide via their separate `organization_members` row, and a
branch hosting the org_manager can still get its own distinct branch-level
manager (no uniqueness constraint blocks it). Matches "org_manager may not
be tied to any branch, other branches have their own managers" exactly as
described.

## Role model tightened: org_manager takes over branch MANAGEMENT once
appointed -- DONE (2026-09-15)

**The clarification that triggered this:** the owner registers the org and
first branch as both org_owner AND org_manager at once (so they run branches
day-to-day from the start). Creating a second branch, same thing -- still
both roles, still full operational reach. But the moment the owner appoints
a real, dedicated org_manager, the owner **loses hands-on management of
branches they don't personally run as that branch's own owner** -- what
they keep is oversight: every branch's performance, analytics,
recommendations, and some configuration. The org_manager becomes the one who
actually manages other branches from then on.

**The gap this caught:** `assert_can_approve_stock_transfer()` (built
2026-09-15 for stock-transfer approval) already implemented exactly this
precedence correctly -- org_manager exclusive once one exists, org_owner as
fallback only while the seat is empty. But everything built the day before
that (Phase 1's cross-branch Branch Settings access) did NOT: `
update_branch_details`, `admin_set_seller_active`, `admin_update_staff_role`
(`2026-09-14_org_manage_branch_settings.sql`), `org_assign_branch_role`
(`2026-09-09_organization_roles_v2.sql`), and `create_branch_discount`/
`create_branch_category`/`update_branch_category`
(`2026-09-11_view_branch_as_org_owner_writes.sql`) all granted blanket
"any org_owner or org_manager" access to any branch in the org, with no
check for whether a dedicated org_manager had since been appointed --
exactly the "just in case" access the user said should go away.

**Fixed:** two new shared helpers,
`assert_can_manage_org_branch(organization_id)` (the same has-a-manager?
check as `assert_can_approve_stock_transfer`, generalized) and
`assert_can_manage_org_branch_or_own(effective_branch_id, own_branch_id)` (a
no-op for your own branch, otherwise applies the rule above). Wired into
all seven functions listed above. Migration:
`2026-09-15_org_manager_precedence_over_owner.sql` -- still needs to be run
against the live Supabase project, after the files it re-declares on top of.

**Follow-up (2026-09-15, same day):** asked the user directly whether the
owner should also lose `complete_sale()`/`receive_stock_delivery()`/
`upsert_patient()` on other branches once a manager exists, or keep that as
day-to-day operational help regardless. Answer: restrict it too -- "the
org_owner must have the ability only to overlook what is being done, being
notified the most, not making any operation regarding the branches." Added
to the same migration (now Section 5 of
`2026-09-15_org_manager_precedence_over_owner.sql`): all three gained the
identical `assert_can_manage_org_branch_or_own()` guard. Reads (dashboards,
analytics, notifications) are untouched -- the owner's oversight stays
exactly as it was; only these three writes are now blocked on someone
else's branch once a dedicated org_manager exists.

**Also confirmed already correct, no fix needed:** both org_manager and a
branch's own owner/manager can already create sellers/other staff
(`admin_set_seller_active`'s invite path, `org_assign_branch_role`) --
matches "both org_manager and branch_manager can make sellers" from the
clarification directly.

## org_manager doesn't have to come from an existing branch, and isn't tied
to one -- DONE (2026-09-15)

**The ask:** appointing an org_manager shouldn't require picking them from
existing branch managers -- they can be a brand-new outside hire with no
branch association. And if an existing branch_manager IS the one promoted,
their old branch's "manager dashboard" should go dormant (stop showing them
as its staff) even though they keep full access to it -- and every other
branch -- through their new org_manager authority; when the org_owner later
staffs that branch with someone new, it's simply staffed again, with
up-to-date data (branch data was never touched by any of this).

**The constraint found:** `public.users.branch_id` is `NOT NULL` --
deliberately, per `2026-09-09_organization_rbac.sql`'s own header comment
("every org-level person still needs exactly one home branch"). Making it
nullable for real would mean reworking the DB schema, ~10 SQL functions,
AND the frontend login/session model (`src/lib/auth.ts`'s `BranchAccess`,
`App.tsx`'s routing) -- put this tradeoff to the user directly; they chose
the smaller, contained fix over the full rewrite.

**What shipped:** an org_manager still gets a technical `branch_id` under
the hood (the column requires it), but it's auto-picked -- the org_owner is
never asked to choose one -- and never surfaced anywhere as "their branch":
- `list_branch_staff()` now excludes anyone holding an active org_manager
  membership from every branch's roster (org_owner is NOT excluded -- the
  founding owner genuinely runs their own branch under the established
  dual-role model). This alone covers both cases: a brand-new org_manager's
  auto-picked anchor branch never shows them as staff, and an existing
  branch_manager who gets promoted disappears from their old branch's
  roster the instant it happens -- no data mutation, their `branch_id`/
  `role` columns are simply no longer surfaced. `list_organization_branches`'s
  `staff_count` gets the same exclusion so branch staff counts stay
  accurate.
- `admin_set_seller_active()`/`admin_update_staff_role()` now refuse to act
  on a target holding an active org_manager membership -- closes the one
  gap the roster-hiding alone doesn't (a branch owner calling the API
  directly, bypassing the now-filtered UI list).
- `invite_organization_member()`'s `p_branch_id` is now optional (moved to
  the end of the signature with a default) -- omitted for a brand-new
  org_manager invite, it auto-picks any branch belonging to the
  organization as the technical anchor. For an EXISTING person being
  promoted, `p_branch_id` was already unused (their branch_id/role were
  never touched) -- unaffected.
- `create-branch-seller` Edge Function (the primary immediate-password path
  `AssignRoleModal` actually uses) -- `branchId` is now optional for
  `role: "org_manager"`; the organization is resolved from the CALLER's own
  org_owner membership instead of from a chosen branch, and an anchor
  branch is auto-picked the same way.
- Frontend (`OrganizationPage.tsx`'s `AssignRoleModal`): the branch picker
  is no longer shown at all when assigning the org_manager role -- replaced
  with a short note that no branch is needed.

Migration: `2026-09-15_org_manager_not_tied_to_branch.sql` -- run after
`2026-09-14_org_manage_branch_settings.sql` and
`2026-09-09_organization_roles_v2.sql`. The Edge Function change needs a
redeploy: `supabase functions deploy create-branch-seller`.

**Deliberately not built:** true `branch_id is null` support (the bigger
rewrite the user chose not to take). If a future need requires it (e.g.
reporting cleanly distinguishes "no branch" from "a placeholder branch"),
that's the fallback path, scoped out above.

## Role transfer: promoting a branch manager to org_manager -- DONE (2026-09-15)

**The ask:** a proper, discoverable way for the org_owner to take an
existing branch manager and make them org_manager -- not something that
only worked by accident (re-typing the same email into the generic Assign
Role modal and letting the "already in use" fallback catch it). Plus:
confirm the dashboard genuinely "upgrades" to org_manager level on
promotion, confirm a LATER branch_manager assigned to that now-vacated
branch gets a clean, fully up-to-date dashboard, and confirm branch history/
data isn't lost or stuck with whoever used to run the branch.

**What shipped:**
1. **Direct "Promote to Org Manager" button** -- `OrganizationPage.tsx`'s
   Members list now shows this next to any active branch-level manager,
   visible only to the org_owner and only while the organization doesn't
   already have one (`handlePromoteToOrgManager` in `OrganizationPage.tsx`,
   using their already-known email/name -- no modal, no re-typing). Goes
   through the exact same `invite_organization_member()` RPC the generic
   modal's fallback always used; this is just a direct front door to it.
2. **The dashboard "sleep" on promotion, made real, not just a side effect
   of hiding from rosters:** `computeVisibleNav()` in `App.tsx` now hides
   EVERY branch-scoped nav item (Overview, Sales, Inventory, Receiving, ...)
   for a dedicated org_manager, not just Overview -- the exclusion the
   org_owner already had. The distinction: the org_owner's own home branch
   is genuinely, foundingly theirs (they may keep running it personally
   forever, even after delegating everything else), so only the redundant
   Overview goes away for them. An org_manager's own `users.branch_id` is
   NEVER genuinely theirs to keep running day to day -- either a placeholder
   anchor (a brand-new hire) or a branch they were just promoted OUT of (an
   ex-branch_manager) -- so their entire regular nav collapses to just
   Organization (+ Help), and every branch, including a former one of their
   own, is reached from there through Organization > Branches "View Branch"
   like any other. The redirect guard (`useLayoutEffect` in `App.tsx`) was
   also fixed to land on 'organization' rather than whatever sorts first in
   `NAV_ITEMS` ('help') when this newly-short allowed list kicks in mid-session.
3. **The acting org_owner's own nav reacts immediately, not just on next
   reload:** both the direct promote button and the generic Assign Role
   modal's "granted" path now call `onOrganizationChanged()` (App.tsx's
   `refreshOrganization`) after a successful promotion -- previously only
   this page's own local `members`/`branches` lists refreshed, leaving the
   App-level `organization.hasOrgManager` flag (which the owner's own
   `ownerDelegatedAway` nav rule depends on) stale until a full page reload.
   The PROMOTED person's own session, if they're signed in elsewhere at that
   moment, still only picks this up on their next reload/navigation --
   genuine real-time push across sessions would need Supabase Realtime, not
   attempted here.
4. **Confirmed, not built (already correct):** the branch's own data --
   sales, stock, patients, and `list_branch_history`'s full audit trail --
   is scoped entirely by `branch_id`, never by who the CURRENT manager is.
   A new branch_manager assigned to a freed-up branch sees its complete,
   accurate history immediately, including everything that happened while
   the org_manager (or the branch's previous manager) was running it --
   nothing to migrate or "restore," because nothing was ever tied to the
   departing person in the first place.

No new migration file -- this reused the existing `invite_organization_member()`
RPC as-is; only `App.tsx` and `OrganizationPage.tsx` changed.

## Phase 3, part 2 -- pull-request stock workflow -- REDESIGNED (2026-09-15)

**2026-09-14's first version is superseded** (file deleted) -- it had
org_manager proactively search for a branch with stock and match it
directly, no consent step from the source branch. The actual product
decision, given directly by the user, is a real branch-to-branch
negotiation:

1. The requesting branch's own manager picks ONE specific branch to ask
   (targeted, not a broadcast) and states product + quantity.
2. That branch's own manager reviews it and either ACCEPTS -- choosing
   which of THEIR OWN batches to send, since only they know their stock --
   or DENIES with a required reason.
3. If denied, the requester picks a DIFFERENT branch and tries again (only
   one outstanding ask at a time; full history of every branch asked is
   kept, not just the latest).
4. Once a branch accepts, an org_owner/org_manager gives ONE final approval
   before anything moves.
5. From there the EXISTING, unmodified push-transfer lifecycle
   (dispatch/receive) governs the physical movement -- the source branch
   still confirms hand-off, the requester still confirms arrival.

**Schema:** two tables now, not one -- `stock_transfer_needs` (the overall
ask: product, quantity, status open/org_review/fulfilling/fulfilled) and
`stock_transfer_offers` (one row per "asked branch X" attempt: pending/
accepted/denied, with the accepted batch ids or the denial reason). A
partial unique index enforces "only one pending ask at a time per need."

**RPCs:** `request_stock_from_branch()` (targeted ask),
`respond_to_stock_offer()` (the asked branch's own accept/deny --
deliberately NOT callable on a branch's behalf by an org role, since only
that branch knows its own stock), `retry_stock_need()` (requester tries a
different branch), `approve_stock_need()` / `reject_stock_need()`
(org_owner/org_manager's final say -- approve creates the real
`stock_transfers` row via the same widened `request_stock_transfer()` from
the first version and immediately marks it 'approved' in one decisive
action), plus `list_stock_needs()` (now includes the latest offer's own
state), `list_stock_need_offers()` (full negotiation trail), and
`list_incoming_stock_offers()` (a branch's own "someone is asking you for
stock" inbox).

Migration: `2026-09-15_stock_transfer_negotiation.sql` (self-contained --
safe to run whether or not 2026-09-14's deleted version was ever applied).
Frontend: `src/lib/stockNeeds.ts` rewritten to match; `OrganizationPage.tsx`
now has three stock-request sections in the Stock Transfers tab -- "Requests
Asking For Your Stock" (any branch, pending asks addressed to them), "My
Branch's Stock Requests" (with a "Try Another Branch" action after a
denial), and "Organization Stock Requests" (org_owner/org_manager only,
Approve/Reject once a branch has agreed).

**Known shared limitation** (pre-existing, not introduced by this): the
whole Stock Transfers tab -- push and both pull sections -- lives behind
`OrganizationPage`, which only a branch `owner` or an actual org_owner/
org_manager can reach (`computeVisibleNav` in `App.tsx`). A branch-level
`manager` with no org role cannot reach any of it today, including
responding to a request addressed to their own branch. Fixing that nav gap
is a separate task, not done here -- worth prioritizing given it now blocks
answering an incoming stock request, not just the org-oversight views.

## Phase 2 -- Reorder points, "not set" nudges, org-wide notification
visibility -- DONE (2026-09-14)

**Built:** `check_missing_reorder_points()` -- new recurring check (same
idempotent shape as `check_out_of_stock_alerts()`), fires once per product
with stock but no `reorder_points` row, re-fires weekly if ignored. Also
fixed a real, previously-dormant bug: `check_restock_recommendations()` has
always inserted `source_type = 'restock_recommendation'`, but that value was
never added to `notifications_source_type_check` -- every insert it ever
attempted would have failed (never triggered before since nothing in the
client called it; now wired into the poll). `notifications` and
`reorder_points` RLS both widened so an org_owner/org_manager sees/can-set
them for every branch in their org, not just their own, via
`is_org_member()` -- this is what makes out-of-stock/expiring/reorder-missing
notifications reach org_manager, and lets org_manager set a reorder point on
any branch's product (`lib/inventory.ts`'s `upsertStockLevels()` already took
an explicit `branchId`, so no frontend change was needed there). Migration:
`src/datatabase/2026-09-14_reorder_notifications_org_visibility.sql`.

**Deliberately not built:** a notification on every single sale. Contradicts
this schema's own established "meaningful, actionable alerts only" pattern
(see e.g. `AlwaysOnIndicator`'s own comment in `BranchSettingsPage.tsx`) --
flooding org_manager/branch_manager with one alert per transaction would
bury the real ones. If still wanted, say so and pick a shape (daily digest?
only sales above a threshold?) -- the existing `list_seller_activity_today()`
/ Overview "today so far" card already cover real-time sales visibility
without spamming notifications.

## Phase 3 -- Stock transfer workflow -- DONE, but not the shape originally
planned (2026-09-14)

**Important correction:** while building this, discovered that a *complete*
stock-transfer system (tables `stock_transfers`/`stock_transfer_items`, a
full request → approve → dispatch → receive/reject/cancel workflow, RLS, and
a matching UI already built into `OrganizationPage.tsx`'s "Stock Transfers"
tab) already existed in `PROPOSAL_multi_branch_organizations.sql` +
`2026-09-09_organization_dashboard.sql` -- and was already live in the
database (`org_branch_summary()`'s `pendingTransfersIn` column depends on
it). The ONLY missing piece was `src/lib/stockTransfers.ts` -- the frontend
never had a file to import from, so the entire tab silently threw a build
error. That file did not exist before this session; an early draft of this
work invented a different, conflicting API (quantity-based "I need N units"
requests) before this was discovered -- that draft was deleted.

**What actually shipped:**
- `src/lib/stockTransfers.ts` -- written from scratch, matching the
  already-built `OrganizationPage.tsx` UI exactly (function names, `StockTransfer`
  shape, `StockTransferStatus` values `pending/approved/in_transit/received/
  rejected/cancelled`).
- `src/datatabase/2026-09-14_stock_transfer_workflow_from_proposal.sql` --
  the stock-transfer-only portion of the proposal (tables, RLS, the 6
  workflow RPCs, plus the org-wide list/item-detail RPCs from the dashboard
  file), extracted into one clean, idempotent file. Deliberately does NOT
  include the proposal's organization-lifecycle functions
  (`create_pharmacy_organization`, `invite_organization_member`,
  `get_my_organization`) -- those have since been superseded by later,
  more evolved dated files, and re-running the proposal's older versions
  risks installing a stale second overload alongside the current one.
  **This file is likely already redundant** (the workflow was probably
  already live) but is 100% safe to run either way -- everything in it is
  `create table if not exists` / `create or replace function`.

**The actual gap vs. what the user described is now clear and NOT yet
built:** this existing workflow is *sender-initiated* -- the branch WITH
stock picks specific batches and sends them ("push"). The user described a
*receiver-initiated* flow -- a branch that's OUT of stock requests it, then
org_manager finds a source branch and arranges the send ("pull"). These are
related but different. The clean way to add the pull side without touching
any of the now-fixed push workflow: a new lightweight `stock_transfer_needs`
table (requesting branch, product variant, quantity, status open/matched),
a `request_stock` RPC (any branch owner/manager), a way for org_manager to
see which branches have the product (a small new query over
`stock_batches`/`barcodes`), and a `fulfill_stock_need` RPC that -- once
org_manager picks a source branch and specific batches -- calls the
already-working `request_stock_transfer()` on the source branch's behalf
(needs `request_stock_transfer()` widened to accept an org_owner/org_manager
acting for a branch that isn't their own, the same `effective_branch_id()`-
style pattern used throughout Phase 1). From there the existing
approve/dispatch/receive lifecycle takes over unchanged. Also still open:
today only `OrganizationPage.tsx`'s "Stock Transfers" tab exposes this
UI, and that tab is only reachable by an org_owner/org_manager (or a branch
`owner`) -- a plain branch `manager` with no org role currently cannot reach
it at all (same nav gap Phase 1 fixed for Branch Settings). A branch_manager
being able to *request* stock needs its own, more widely reachable nav entry
-- not tucked inside the org-only tab.

**Status:** push workflow fixed and functional; pull/request workflow (the
part of the original ask this phase was actually named for) is designed but
not yet built -- next session should start here.

## Phase 4 -- Branch comparison/performance analytics, inter-branch stock
optimization, deeper AI recommendations

**Ask:** org_manager compares branches' performance, gets system
recommendations after "deep analysis," inter-branch stock optimization
suggestions, batch recall + stock distribution view.

**What exists already:** `org_branch_summary()` (today/MTD revenue,
out-of-stock/low-stock counts per branch) is the seed of branch comparison;
`analytics_recall_log()` already exists org-wide (batch_recalls was never
branch-scoped). The AI analyst tools (`ai_*` functions) are the existing
pattern for "system analysis" -- likely extended with org-scoped versions
(today's `ai_*` functions are all single-branch, gated by
`current_branch_id()`/`effective_branch_id()`).

**Status:** not started.

## Phase 5 -- Tiered support tickets

**Ask:** not every ticket should be submittable by (or land on) the
branch_manager -- some should route to org_manager, some to org_owner, some
to super_admin.

**Open decision:** what determines the tier -- a category the submitter
picks (billing -> org_owner, technical bug -> super_admin, stock issue ->
org_manager, general -> branch_manager), or a manual "escalate to" action a
lower tier takes on a ticket they can't resolve? Needs an answer before
`support_tickets` gets a routing column and `submit_support_ticket()` gets a
per-role allow-list.

**Status:** not started.

## Phase 6 -- org_owner reports/exports + broader feature increase

**Ask:** org_owner should be able to configure all roles/access, produce
reports and exports, and generally get more capability than today.

**Status:** not started -- needs a concrete list of which reports/exports
(PDF? CSV? which data?) before scoping.

## Suggested build order (updated 2026-09-14)

1. ~~Phase 1~~ done.
2. ~~Phase 2~~ done.
3. ~~Phase 3 push workflow~~ done (turned out to already exist, just broken).
4. **Phase 3 pull/request workflow** -- the `stock_transfer_needs` design
   above. Do this next -- it's the one piece of the original ask still
   outstanding, and it's now well-scoped.
5. Phase 5 (ticket tiering -- moderate, needs the routing-criteria decision)
6. Phase 4 (branch comparison + AI recommendations)
7. Phase 6 (reports/exports)

Before starting anything else: **run the SQL migration files that haven't
been applied yet**, in this order -- `2026-09-14_org_manage_branch_settings.sql`,
`2026-09-14_reorder_notifications_org_visibility.sql`,
`2026-09-14_role_hierarchy_visibility.sql`,
`2026-09-14_stock_transfer_workflow_from_proposal.sql` (possibly redundant if
the proposal was already fully applied, but idempotent -- safe either way),
`2026-09-15_stock_transfer_negotiation.sql`,
`2026-09-15_backfill_missing_product_variants.sql`,
`2026-09-15_org_manager_precedence_over_owner.sql` (must run after
`2026-09-14_org_manage_branch_settings.sql`, `2026-09-09_organization_roles_v2.sql`,
and `2026-09-11_view_branch_as_org_owner_writes.sql` since it re-declares
functions from all three), and finally
`2026-09-15_org_manager_not_tied_to_branch.sql` (run after
`2026-09-14_org_manage_branch_settings.sql` and
`2026-09-09_organization_roles_v2.sql` -- also redeploy the
`create-branch-seller` Edge Function afterward:
`supabase functions deploy create-branch-seller`). Also worth 5 minutes: open `OrganizationPage`
→ Stock Transfers tab and confirm it now actually loads (it was silently
broken before `lib/stockTransfers.ts` existed).

Open to reordering -- tell me which phase to start on and I'll go into a
proper implementation plan for just that one.
