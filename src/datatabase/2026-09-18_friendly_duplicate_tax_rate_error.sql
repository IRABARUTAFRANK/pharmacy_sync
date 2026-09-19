-- ============================================================================
-- SUPER ADMIN: A DUPLICATE TAX RATE NAME NOW FAILS WITH A READABLE MESSAGE
-- ============================================================================
-- admin_create_tax_rate() had no duplicate check of its own -- it relied
-- entirely on tax_rates' own unique(name) constraint, so typing a name that
-- already exists (e.g. "Exempt", which every branch is seeded with) surfaced
-- the raw Postgres error verbatim in the Add Tax Rate modal:
-- `duplicate key value violates unique constraint "tax_rates_name_key"`.
--
-- This adds an explicit, case-insensitive pre-check with a message that
-- names the actual conflicting tax rate, matching how every other
-- create/upsert RPC in this schema (create_branch_category,
-- create_branch_discount, etc.) already surfaces a duplicate as plain
-- language instead of a raw constraint name.
-- ============================================================================

create or replace function public.admin_create_tax_rate(p_name text, p_rate_percentage numeric)
returns uuid
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_id uuid;
begin
  perform public.assert_super_admin();
  if nullif(btrim(coalesce(p_name, '')), '') is null then raise exception 'A tax rate name is required'; end if;
  if p_rate_percentage is null or p_rate_percentage < 0 or p_rate_percentage > 100 then
    raise exception 'Tax rate must be between 0 and 100';
  end if;
  if exists (select 1 from public.tax_rates where lower(name) = lower(btrim(p_name))) then
    raise exception 'A tax rate named "%" already exists', btrim(p_name);
  end if;
  insert into public.tax_rates (name, rate_percentage) values (btrim(p_name), p_rate_percentage) returning id into v_id;
  return v_id;
end;
$$;
