-- Makes the History page translatable into Kinyarwanda/French.
--
-- Problem: list_branch_history() previously built each event's title and
-- description as plain formatted English text ("Sale — RCT-0001", "Qty 5 —
-- correction", "Raised by John · Status: open", etc.) directly in SQL. That
-- text left the database already baked into one language, so switching the
-- app's language never changed anything on this page — the UI chrome
-- translated, but the actual event content never did.
--
-- Fix: the function now returns raw, structured data (a `meta` jsonb column
-- holding just the per-category facts — product name, quantity, receipt
-- number, etc.) instead of pre-formatted sentences. The client
-- (src/pages/HistoryPage.tsx) builds the displayed title/description from
-- this data using the app's existing i18n dictionaries, the same way every
-- other page already does. See PROPOSAL_multi_branch_organizations*.* for an
-- unrelated, separate, NOT-applied feature proposal — this file is a real,
-- applied fix to the live schema.

drop function if exists public.list_branch_history(timestamptz, timestamptz);

create or replace function public.list_branch_history(p_from timestamptz default null, p_to timestamptz default null)
returns table(
  event_at timestamptz, category text, amount numeric, actor_name text, status text, meta jsonb
)
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_branch uuid;
begin
  select u.branch_id into v_branch
  from public.users u
  where u.id = (select auth.uid()) and u.is_active and u.role = 'owner';
  if v_branch is null then
    raise exception 'Only the branch owner may view the full history';
  end if;

  return query
  select s.sold_at, 'sale'::text, s.total_amount, u1.full_name::text, null::text,
    jsonb_build_object('receiptNumber', r.receipt_number, 'itemCount', si.cnt, 'patientName', p.full_name)
  from public.sales s
  join public.receipts r on r.sale_id = s.id
  left join public.patients p on p.id = s.patient_id
  left join public.users u1 on u1.id = s.cashier_id
  join lateral (select count(*) cnt from public.sale_items si2 where si2.sale_id = s.id) si on true
  where s.branch_id = v_branch and (p_from is null or s.sold_at >= p_from) and (p_to is null or s.sold_at <= p_to)

  union all

  select sa.adjusted_at, 'stock_adjustment'::text, null::numeric, u2.full_name::text, sa.adjustment_type::text,
    jsonb_build_object('quantity', sa.quantity, 'productName', concat_ws(' ', pr1.name, pv1.dosage), 'reason', sa.reason)
  from public.stock_adjustments sa
  join public.stock_batches sb1 on sb1.id = sa.stock_batch_id
  join public.product_variants pv1 on pv1.id = sb1.product_variant_id
  join public.products pr1 on pr1.id = pv1.product_id
  left join public.users u2 on u2.id = sa.performed_by
  where sb1.branch_id = v_branch and (p_from is null or sa.adjusted_at >= p_from) and (p_to is null or sa.adjusted_at <= p_to)

  union all

  select sb3.received_at, 'stock_batch'::text, (sb3.quantity_received * sb3.cost_price), u7.full_name::text, null::text,
    jsonb_build_object('productName', concat_ws(' ', pr3.name, pv3.dosage), 'batchNumber', sb3.batch_number, 'quantityReceived', sb3.quantity_received)
  from public.stock_batches sb3
  join public.product_variants pv3 on pv3.id = sb3.product_variant_id
  join public.products pr3 on pr3.id = pv3.product_id
  left join public.users u7 on u7.id = sb3.logged_by
  where sb3.branch_id = v_branch and (p_from is null or sb3.received_at >= p_from) and (p_to is null or sb3.received_at <= p_to)

  union all

  select ic.submitted_at, 'insurance_claim'::text, ic.claim_amount, null::text, ic.status::text,
    jsonb_build_object('providerName', ip.name, 'coveragePercentage', ic.coverage_percentage_applied)
  from public.insurance_claims ic
  join public.sales s2 on s2.id = ic.sale_id
  join public.insurance_providers ip on ip.id = ic.insurance_provider_id
  where s2.branch_id = v_branch and (p_from is null or ic.submitted_at >= p_from) and (p_to is null or ic.submitted_at <= p_to)

  union all

  select pt.created_at, 'patient'::text, null::numeric, u4.full_name::text, null::text,
    jsonb_build_object('patientName', pt.full_name, 'tinOrPhone', pt.tin_or_phone)
  from public.patients pt
  left join public.users u4 on u4.id = pt.created_by
  where pt.branch_id = v_branch and (p_from is null or pt.created_at >= p_from) and (p_to is null or pt.created_at <= p_to)

  union all

  select pq.created_at, 'product_request'::text, null::numeric, u5.full_name::text, pq.status::text,
    jsonb_build_object('message', left(pq.message, 140))
  from public.product_requests pq
  left join public.users u5 on u5.id = pq.requested_by
  where pq.branch_id = v_branch and (p_from is null or pq.created_at >= p_from) and (p_to is null or pq.created_at <= p_to)

  union all

  select us.created_at, 'staff'::text, null::numeric, null::text, null::text,
    jsonb_build_object('staffName', us.full_name, 'email', us.email)
  from public.users us
  where us.branch_id = v_branch and us.role = 'seller' and (p_from is null or us.created_at >= p_from) and (p_to is null or us.created_at <= p_to)

  union all

  select br.recalled_at, 'batch_recall'::text, null::numeric, u6.full_name::text, 'recalled'::text,
    jsonb_build_object('productName', concat_ws(' ', pr2.name, pv2.dosage), 'batchNumber', br.batch_number, 'manufacturerName', br.manufacturer_name, 'reason', br.reason)
  from public.batch_recalls br
  join public.product_variants pv2 on pv2.id = br.product_variant_id
  join public.products pr2 on pr2.id = pv2.product_id
  left join public.users u6 on u6.id = br.recalled_by
  where exists (
    select 1 from public.stock_batches sb2
    where sb2.product_variant_id = br.product_variant_id and sb2.batch_number = br.batch_number and sb2.branch_id = v_branch
  ) and (p_from is null or br.recalled_at >= p_from) and (p_to is null or br.recalled_at <= p_to)

  union all

  select b.created_at, 'barcode_created'::text, null::numeric, null::text, b.status::text,
    jsonb_build_object('barcodeType', b.barcode_type, 'code', b.code, 'codeSource', b.code_source)
  from public.barcodes b
  join public.stock_batches sb4 on sb4.id = b.stock_batch_id
  where sb4.branch_id = v_branch and (p_from is null or b.created_at >= p_from) and (p_to is null or b.created_at <= p_to)

  union all

  select n.created_at, 'notification'::text, null::numeric, null::text, (case when n.is_read then 'read' else 'unread' end)::text,
    jsonb_build_object('sourceType', n.source_type, 'message', n.message)
  from public.notifications n
  where n.branch_id = v_branch and (p_from is null or n.created_at >= p_from) and (p_to is null or n.created_at <= p_to)

  union all

  select st.created_at, 'support_ticket'::text, null::numeric, u8.full_name::text, st.status::text,
    jsonb_build_object('subject', st.subject)
  from public.support_tickets st
  left join public.users u8 on u8.id = st.raised_by
  where st.branch_id = v_branch and (p_from is null or st.created_at >= p_from) and (p_to is null or st.created_at <= p_to)

  order by 1 desc
  limit 2000;
end;
$$;

revoke all on function public.list_branch_history(timestamptz, timestamptz) from public, anon;
grant execute on function public.list_branch_history(timestamptz, timestamptz) to authenticated;
