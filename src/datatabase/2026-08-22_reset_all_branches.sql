-- Wipes every branch and everything scoped to a branch, so the live project
-- starts clean for real onboarding. Run this yourself in the Supabase SQL
-- Editor (Claude does not have service-role / dashboard access to run this).
--
-- Review before running: this is irreversible. It does NOT delete the
-- underlying Supabase Auth identities (auth.users) for any accounts that
-- were created for these branches -- if you want those gone too, remove them
-- separately in Authentication -> Users in the dashboard. It also does not
-- touch tax_rates, products, product_variants, insurance_providers, or
-- discounts, since those are global (not branch-owned) catalog data.
--
-- Order matters: child tables are cleared before the branches row itself,
-- so this respects the foreign keys instead of fighting them.

begin;

delete from public.sale_items where sale_id in (select id from public.sales);
delete from public.receipts where sale_id in (select id from public.sales);
delete from public.insurance_claims where sale_id in (select id from public.sales);
delete from public.sales;

delete from public.stock_adjustments;
delete from public.barcodes;
delete from public.batch_recalls;
delete from public.stock_batches;
delete from public.stock_deliveries;
delete from public.branch_product_categorization;
delete from public.reorder_points;
delete from public.product_categories;
delete from public.suppliers where branch_id is not null;

delete from public.notifications;
delete from public.sales_forecasts;
delete from public.dashboard_reports;
delete from public.support_tickets;
delete from public.branch_settings;

delete from public.branch_applications;
delete from public.branch_directory;
delete from public.users;
delete from public.branches;

commit;
