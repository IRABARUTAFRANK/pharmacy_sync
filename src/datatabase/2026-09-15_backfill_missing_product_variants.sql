-- ============================================================================
-- Backfill: give every variant-less product a default "self" variant
-- ============================================================================
-- Run once. Idempotent -- the WHERE NOT EXISTS guard makes re-running a
-- no-op once every product has at least one variant.
--
-- Root cause (confirmed by reading the actual code, not guessed): every
-- product-creation path in this app TODAY (admin_create_product(),
-- admin_approve_product_request()) already requires at least one variant --
-- see their own `if jsonb_array_length(p_variants) = 0 then raise
-- exception...` checks. receive_stock_delivery() itself can no longer
-- create a product at all (branches file a product request instead). So a
-- variant-less product cannot be created going forward through anything
-- reachable in the app -- what the user hit is left-over data from before
-- these checks existed (or a manual edit), not a live gap in the creation
-- flow. No new ongoing safeguard is added here for that reason: adding one
-- would be guarding against a path that no longer exists.
--
-- The actual, reported symptom: Stock Receiving's variant picker
-- (StockReceivingPage.tsx) is correctly disabled when a product has zero
-- variants -- "Generate Barcodes" was never going to work for it, by
-- design, because there is nothing to receive it AS. The fix is the data,
-- not the receiving form: give every such product exactly one variant with
-- no dosage/form/unit set, i.e. the product name itself stands for the
-- product -- exactly the "this product is its own variant" framing asked
-- for. Once this row exists, the existing variant picker already renders
-- it correctly with no code change: [product.name, variant.dosage, ...]
-- filtered and joined already collapses to just the product name when
-- dosage/form/unit are all null.
insert into public.product_variants (product_id, dosage, form, unit)
select p.id, null, null, null
from public.products p
where not exists (
  select 1 from public.product_variants pv where pv.product_id = p.id
);
