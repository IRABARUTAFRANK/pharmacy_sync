-- ============================================================================
-- ENSURE DEFAULT PRODUCT VARIANT
-- ============================================================================
-- Stock Receiving deliberately blocks a product with zero product_variants
-- rows (see StockReceivingPage.tsx's problemsFor()) -- that page used to let
-- staff type a brand new product name and have a product + variant created
-- for it inline, which caused duplicate products/variants and was removed;
-- receive_stock_delivery() now only ever accepts a real, existing
-- product_variant_id. New products go through submit_product_request() +
-- admin_approve_product_request() instead, which always creates at least
-- one variant.
--
-- That leaves one gap: a product that is already in the catalogue (created
-- correctly, with a variant, at some point) but currently has zero variants
-- -- e.g. its only variant was later deleted -- has no way back into
-- Receiving at all, since there is no "add a variant to an EXISTING
-- product" action anywhere in the app.
--
-- This RPC is that action, scoped as narrowly as possible to avoid
-- reopening the duplicate-creation bug: get-or-create, not create-always --
-- if the product already has any variant, this returns the first one
-- untouched; only when it truly has zero does it insert exactly one blank
-- (null dosage/form/unit) variant. Calling it twice for the same product is
-- a no-op the second time, so it can never itself produce a duplicate.
-- ============================================================================

create or replace function public.ensure_default_product_variant(p_product_id uuid)
returns uuid
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_variant uuid;
begin
  perform public.assert_owner_or_manager();

  if not exists (select 1 from public.products where id = p_product_id) then
    raise exception 'Unknown product';
  end if;

  select id into v_variant from public.product_variants
  where product_id = p_product_id
  order by created_at
  limit 1;

  if v_variant is not null then
    return v_variant;
  end if;

  insert into public.product_variants (product_id, dosage, form, unit)
  values (p_product_id, null, null, null)
  returning id into v_variant;

  return v_variant;
end;
$$;

revoke all on function public.ensure_default_product_variant(uuid) from public, anon;
grant execute on function public.ensure_default_product_variant(uuid) to authenticated;
