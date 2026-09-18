-- ============================================================================
-- ⚠ FULL RESET: DELETES EVERY ORGANIZATION, BRANCH, USER/SELLER, AND ALL OF
-- THEIR DATA (SALES, PATIENTS, STOCK, DELIVERIES, ETC.) -- PLATFORM-WIDE.
-- ============================================================================
-- This is NOT a schema migration like every other file in this folder -- it
-- is a one-time, irreversible DATA WIPE. It does not create or alter any
-- table/function. Run it only when you genuinely want to reset the whole
-- platform back to "nothing has ever signed up yet", for every organization
-- and branch that exists, not just your own test data.
--
-- KEPT (never touched by this script) -- platform-wide reference data the
-- super admin curates, not tied to any one organization:
--   - products, product_variants, tax_rates
--   - insurance_providers, insurance_product_coverage, insurance_variant_prices
--   - suppliers WITH branch_id IS NULL (legacy/global supplier rows)
-- Everything else that is organization/branch/user-scoped is deleted.
--
-- v2: the first version of this script failed partway through with
-- `update or delete on table "sales" violates foreign key constraint
-- "pending_payments_sale_id_fkey"` -- pending_payments.sale_id references
-- sales(id) with no ON DELETE CASCADE, and v1 deleted sales first. Nothing
-- was actually deleted (see the transaction note below), but this version
-- fixes that by re-deriving the FULL delete order directly from every
-- `references public.<table>` in this folder rather than spot-checking --
-- that same pass also caught a second, not-yet-triggered case of the exact
-- same mistake (stock_transfer_items.stock_batch_id -> stock_batches, also
-- no cascade) and added a defensive two-phase delete for barcodes' own
-- self-referencing parent_barcode_id column, so a bulk delete can't trip
-- over a row that references a sibling row being deleted in the same
-- statement.
--
-- The whole thing is wrapped in one transaction: if anything fails partway
-- (e.g. a table renamed since this was written), NOTHING is deleted -- it
-- rolls back atomically rather than leaving the database half-wiped. That
-- is exactly what happened with v1's error: the DELETE that failed was
-- never committed, so nothing needs undoing before running this version.
--
-- Deliberately more thorough than admin_delete_branch()'s single-branch path:
-- that function refuses to delete a branch that issued a batch_recalls row
-- (a real regulatory-audit safeguard, worth keeping for a single delete).
-- This script does not honor that safeguard -- there is no "other branch's
-- audit trail" to protect when every branch is being removed at once -- and
-- deletes batch_recalls too. If you need those recall records preserved,
-- export them before running this.
-- ============================================================================


-- ----------------------------------------------------------------------------
-- STEP 1 (run this first, on its own -- read-only, changes nothing): a
-- preview of exactly how much this will delete. Look at these numbers
-- before running Step 2.
-- ----------------------------------------------------------------------------
select
  (select count(*) from public.pharmacy_organizations) as organizations,
  (select count(*) from public.branches)                as branches,
  (select count(*) from public.users)                   as users_sellers,
  (select count(*) from public.sales)                   as sales,
  (select count(*) from public.patients)                as patients,
  (select count(*) from public.stock_batches)           as stock_batches,
  (select count(*) from public.stock_deliveries)        as deliveries,
  (select count(*) from public.product_categories)      as branch_categories,
  (select count(*) from public.suppliers where branch_id is not null) as branch_suppliers_only,
  (select count(*) from public.products)                as products_kept,
  (select count(*) from public.tax_rates)               as tax_rates_kept,
  (select count(*) from public.insurance_providers)     as insurance_providers_kept;


-- ----------------------------------------------------------------------------
-- STEP 2: the actual wipe. Only run this once you've reviewed Step 1's
-- output and are certain.
-- ----------------------------------------------------------------------------
begin;

-- Gateway payment attempts (Pesapal/pawaPay) -- MUST come before sales:
-- pending_payments.sale_id references sales(id), no cascade (the bug in v1).
delete from public.pending_payments;

-- Sales and everything derived from a sale. sale_items/receipts cascade from
-- sales on their own; insurance_claims does not, so it's listed explicitly
-- before sales too.
delete from public.sale_items;
delete from public.receipts;
delete from public.insurance_claims;
delete from public.sales;

-- Cross-branch stock transfer negotiation. stock_transfer_items MUST come
-- before stock_batches below (stock_transfer_items.stock_batch_id
-- references stock_batches(id), no cascade -- the second instance of v1's
-- bug, caught before it could fail the same way).
delete from public.stock_transfer_items;
delete from public.stock_transfer_offers;
delete from public.stock_transfer_needs;
delete from public.stock_transfers;

-- Stock: adjustments, then barcodes (self-referencing parent_barcode_id --
-- deleted in two passes so a "child" barcode row is always gone before the
-- "parent" row it points to is, regardless of internal row processing
-- order), then batches, then deliveries.
delete from public.stock_adjustments;
delete from public.barcodes where parent_barcode_id is not null;
delete from public.barcodes;
delete from public.batch_recalls;
delete from public.stock_batches;
delete from public.stock_deliveries;

-- Per-branch categorization (product_categories is branch-owned -- see
-- 2026-09-18_organization_shared_categories.sql's own header for why).
delete from public.reorder_points;
delete from public.branch_product_categorization;
delete from public.product_categories;

-- Patients, discounts, and "product not in catalogue" requests.
delete from public.patients;
delete from public.discounts;
delete from public.product_requests;

-- Notifications, forecasting, reporting, support tickets.
delete from public.notifications;
delete from public.sales_forecast_snapshots;
delete from public.sales_forecasts;
delete from public.dashboard_reports;
delete from public.support_tickets;

-- Branch-level configuration: settings, storage locations (and their
-- product assignments), and this branch's own private suppliers -- legacy
-- global suppliers (branch_id is null) are deliberately left alone.
delete from public.branch_settings;
delete from public.product_storage_locations;
delete from public.storage_locations;
delete from public.suppliers where branch_id is not null;

-- Organization-level tables that reference branches/users WITHOUT an
-- ON DELETE CASCADE (verified against their actual create table statements)
-- -- these MUST be cleared before branches/users below, or those deletes
-- would fail on a foreign-key violation, same as v1's original bug.
delete from public.organization_invites;
delete from public.organization_applications;
delete from public.role_change_log;
delete from public.branch_distance_measurements;
delete from public.organization_members;

-- Pending pharmacy sign-ups (pre-branch applications).
delete from public.branch_applications;

-- The public sign-in directory entry for every branch.
delete from public.branch_directory;

-- Every seller/owner/manager/pharmacist/staff login, at every branch.
delete from public.users;

-- Every branch itself.
delete from public.branches;

-- Every organization (chain) itself.
delete from public.pharmacy_organizations;

-- Historical log of past single-branch deletions -- cleared too, for a
-- genuinely clean history. No live foreign key depends on this table.
delete from public.deleted_branches_log;

commit;

-- After this commits, the only thing left in the database that resembles
-- "data" is the platform-wide catalogue this script deliberately kept
-- (products/product_variants/tax_rates/insurance_*) plus your own super
-- admin login, which lives in Supabase Auth, not any table this script
-- touches.
