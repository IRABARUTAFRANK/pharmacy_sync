-- ============================================================================
-- PUBLIC RECEIPT LOOKUP (for the customer-facing "scan to view online" QR)
-- ============================================================================
-- Every printed sales receipt now carries a second QR code (independent of
-- the existing RRA/EBM compliance QR in complete_sale()/getSaleReceipt()) that
-- opens an unauthenticated web page showing that one receipt in full -- same
-- content as the printed copy, including patient name/insurance if present.
-- This was an explicit, informed product decision: the sale's UUID itself
-- (122 bits of randomness, not practically guessable) is the only access
-- control, the same trust model as physically handing someone a paper
-- receipt. Do not add extra gating here that the product decision didn't ask
-- for -- that would just be inconsistent with the "full receipt" promise.
--
-- Why a narrow RPC instead of an anon-readable RLS policy: getSaleReceipt()
-- (src/lib/sales.ts) touches sales, receipts, sale_items, branches, users,
-- barcodes, tax_rates, insurance_claims, insurance_providers, patients,
-- stock_batches, product_variants and products. Granting `anon` any RLS
-- policy on those tables -- even one scoped to "match this one id" -- opens
-- a PostgREST table endpoint that can be queried directly with arbitrary
-- filters (e.g. GET /rest/v1/sales?select=*), which would let anyone
-- enumerate/list ALL sales, not just the one they already hold the link for.
-- A single security-definer function taking exactly one p_sale_id uuid and
-- returning only that one sale's assembled jsonb has no such surface: it
-- can only ever be called with one id at a time and only ever returns that
-- id's own data. No RLS changes are made to any underlying table by this
-- migration.
--
-- Brute force: 122 bits of UUIDv4 randomness makes guessing a live sale id
-- computationally infeasible; no additional rate limiting is implemented
-- here (out of scope -- Postgres has no trivial built-in per-caller rate
-- limit for a SECURITY DEFINER function; if this ever becomes a concern,
-- handle it at the edge/CDN layer, not in this migration).
--
-- Run this once in the Supabase SQL editor (or via the CLI) against the
-- project's database. Safe to re-run: CREATE OR REPLACE.
-- ============================================================================

create or replace function public.get_public_receipt(p_sale_id uuid)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_branch_id uuid;
  v_cashier_id uuid;
  v_patient_id uuid;

  v_receipt_number text;
  v_issued_at timestamptz;

  v_branch_name text;
  v_branch_tin text;
  v_branch_address text;
  v_branch_phone text;
  v_branch_logo_path text;
  v_branch_bank_account_number text;
  v_branch_bank_account_name text;
  v_branch_momo_pay_number text;

  v_cashier_name text;

  v_patient_name text;
  v_patient_gender text;
  v_patient_age integer;
  v_patient_contact text;

  v_provider_id uuid;
  v_provider_name text;

  v_items jsonb;
  v_subtotal numeric;
  v_tax_total numeric;
  v_insurance_total numeric;
begin
  -- No auth.uid()/branch check here on purpose -- p_sale_id is the only
  -- filter, by design (see header comment above).
  select s.branch_id, s.cashier_id, s.patient_id
    into v_branch_id, v_cashier_id, v_patient_id
    from public.sales s
    where s.id = p_sale_id;

  if not found then
    return null; -- unknown sale id -- caller shows a "not found" state
  end if;

  select r.receipt_number, r.issued_at
    into v_receipt_number, v_issued_at
    from public.receipts r
    where r.sale_id = p_sale_id;

  if not found then
    return null; -- sale exists but has no receipt row (shouldn't happen once complete_sale() has run) -- fail closed
  end if;

  select b.name, b.tin, b.address, b.phone, b.logo_path,
         b.bank_account_number, b.bank_account_name, b.momo_pay_number
    into v_branch_name, v_branch_tin, v_branch_address, v_branch_phone, v_branch_logo_path,
         v_branch_bank_account_number, v_branch_bank_account_name, v_branch_momo_pay_number
    from public.branches b
    where b.id = v_branch_id;

  select u.full_name into v_cashier_name
    from public.users u
    where u.id = v_cashier_id;

  if v_patient_id is not null then
    select p.full_name, p.gender, p.age, p.tin_or_phone
      into v_patient_name, v_patient_gender, v_patient_age, v_patient_contact
      from public.patients p
      where p.id = v_patient_id;
  end if;

  select ic.insurance_provider_id into v_provider_id
    from public.insurance_claims ic
    where ic.sale_id = p_sale_id;

  if v_provider_id is not null then
    select ip.name into v_provider_name
      from public.insurance_providers ip
      where ip.id = v_provider_id;
  end if;

  -- Mirrors getSaleReceipt()'s per-item tax math exactly:
  -- taxAmount = round(subtotal * rate_percentage) / 100 (subtotal is the
  -- already-extracted pre-tax base -- see 2026-08-28_vat_inclusive_tax.sql).
  select
    coalesce(jsonb_agg(
      jsonb_build_object(
        'code', bc.code,
        'productName', coalesce(pr.name, 'Unknown product'),
        'dosage', pv.dosage,
        'form', pv.form,
        'quantity', si.quantity,
        'unitPrice', si.unit_price,
        'subtotal', si.subtotal,
        'taxRatePercentage', tr.rate_percentage,
        'taxAmount', round(si.subtotal * tr.rate_percentage) / 100,
        'insuranceCovered', si.insurance_covered_amount,
        'patientOwed', si.subtotal + round(si.subtotal * tr.rate_percentage) / 100 - si.insurance_covered_amount
      )
      order by si.id
    ), '[]'::jsonb),
    coalesce(sum(si.subtotal), 0),
    coalesce(sum(round(si.subtotal * tr.rate_percentage) / 100), 0),
    coalesce(sum(si.insurance_covered_amount), 0)
    into v_items, v_subtotal, v_tax_total, v_insurance_total
    from public.sale_items si
    join public.barcodes bc on bc.id = si.barcode_id
    join public.tax_rates tr on tr.id = si.tax_rate_id
    join public.stock_batches sb on sb.id = bc.stock_batch_id
    join public.product_variants pv on pv.id = sb.product_variant_id
    join public.products pr on pr.id = pv.product_id
    where si.sale_id = p_sale_id;

  return jsonb_build_object(
    'saleId', p_sale_id,
    'receiptNumber', v_receipt_number,
    'issuedAt', v_issued_at,
    'branchName', coalesce(v_branch_name, '—'),
    'branchTin', v_branch_tin,
    'branchAddress', v_branch_address,
    'branchPhone', v_branch_phone,
    -- Raw storage path, not a full URL -- get_public_receipt() has no idea
    -- what the project's public URL is; the TS layer builds the URL the
    -- exact same way getSaleReceipt() already does, via
    -- supabase.storage.from('branch-logos').getPublicUrl(path).
    'branchLogoPath', v_branch_logo_path,
    'branchBankAccountNumber', v_branch_bank_account_number,
    'branchBankAccountName', v_branch_bank_account_name,
    'branchMomoPayNumber', v_branch_momo_pay_number,
    'cashierName', coalesce(v_cashier_name, '—'),
    'patientName', v_patient_name,
    'patientGender', v_patient_gender,
    'patientAge', v_patient_age,
    'patientContact', v_patient_contact,
    'insuranceProviderName', v_provider_name,
    'items', v_items,
    'subtotal', v_subtotal,
    'taxTotal', v_tax_total,
    'insuranceCoveredTotal', v_insurance_total,
    'patientOwedTotal', v_subtotal + v_tax_total - v_insurance_total,
    'grandTotal', v_subtotal + v_tax_total,
    -- TODO: once complete_sale()/VSDC submission stores EBM fields on
    -- public.receipts, select and return those columns here instead of
    -- nulls, mirroring the same TODO in getSaleReceipt() (src/lib/sales.ts).
    'ebmSdcId', null,
    'ebmMrcNo', null,
    'ebmReceiptSignature', null,
    'ebmInvoiceNumber', null
  );
end;
$$;

revoke all on function public.get_public_receipt(uuid) from public;
grant execute on function public.get_public_receipt(uuid) to anon, authenticated;
