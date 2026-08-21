-- Stock receiving foundation. Run after supabase_pharmacy_schema.sql.
-- Each delivery is one supplier shipment; stock_batches are its product/batch lines.

create table if not exists public.stock_deliveries (
  id uuid primary key default gen_random_uuid(),
  branch_id uuid not null references public.branches(id),
  supplier_id uuid not null references public.suppliers(id),
  delivery_code varchar(80) not null,
  received_by uuid not null references public.users(id),
  received_at timestamptz not null default now(),
  notes text,
  created_at timestamptz not null default now(),
  unique (branch_id, delivery_code)
);

alter table public.stock_batches add column if not exists delivery_id uuid references public.stock_deliveries(id);
create index if not exists idx_stock_deliveries_branch_received on public.stock_deliveries(branch_id, received_at desc);
create index if not exists idx_stock_deliveries_supplier on public.stock_deliveries(supplier_id);
create index if not exists idx_stock_batches_delivery_id on public.stock_batches(delivery_id);
create unique index if not exists suppliers_name_ci_unique on public.suppliers ((lower(supplier_name)));

alter table public.stock_deliveries enable row level security;
drop policy if exists "delivery access" on public.stock_deliveries;
create policy "delivery access" on public.stock_deliveries for all to authenticated
using (public.is_owner() or branch_id = public.current_branch_id())
with check (public.is_owner() or branch_id = public.current_branch_id());

-- Barcode packing rule:
-- * A simple sellable pack has parent_barcode_id null and pieces_per_pack set.
-- * A carton (box) has one barcode per physical carton and child_count = packs inside.
-- * Every inner pack is a child barcode with pieces_per_pack set; individual pieces have no barcode.
-- Stock quantity is calculated from leaf pack barcodes only: quantity_available * pieces_per_pack.

alter table public.barcodes drop constraint if exists barcodes_packing_shape;
alter table public.barcodes add constraint barcodes_packing_shape check (
  (barcode_type = 'box' and parent_barcode_id is null and child_count is not null and child_count > 0 and pieces_per_pack is null)
  or
  (barcode_type = 'pack' and child_count is null and pieces_per_pack is not null and pieces_per_pack > 0)
);

-- Do not create anonymous policies for stock, barcodes, suppliers, or recalls.
-- One atomic receiving operation: the client sends delivery lines, never a delivery code.
drop function if exists public.receive_stock_delivery(uuid, text, jsonb);
create function public.receive_stock_delivery(p_supplier_name text, p_notes text, p_lines jsonb)
returns table(delivery_id uuid, delivery_code text)
language plpgsql security definer set search_path = '' as $$
declare v_branch uuid; v_user uuid := auth.uid(); v_delivery uuid := public.gen_random_uuid(); v_supplier uuid; v_code text;
declare line jsonb; v_batch uuid; v_parent uuid; v_category uuid; v_product uuid; i integer; j integer; v_cartons integer; v_packs integer; v_pieces integer;
begin
  select u.branch_id into v_branch from public.users u where u.id = v_user and u.is_active;
  if v_branch is null or not exists (select 1 from public.users u where u.id = v_user and u.role in ('owner','manager')) then
    raise exception 'Only an active branch manager or owner may receive stock';
  end if;
  if jsonb_typeof(p_lines) <> 'array' or jsonb_array_length(p_lines) = 0 then raise exception 'At least one delivery line is required'; end if;
  if nullif(btrim(p_supplier_name), '') is null then raise exception 'Supplier name is required'; end if;
  insert into public.suppliers(supplier_name) values(btrim(p_supplier_name))
  on conflict ((lower(supplier_name))) do update set supplier_name = excluded.supplier_name
  returning id into v_supplier;
  v_code := format('DEL-%s-%s', to_char(now(), 'YYYYMMDD'), upper(substr(replace(v_delivery::text, '-', ''), 1, 6)));
  insert into public.stock_deliveries(id, branch_id, supplier_id, delivery_code, received_by, notes)
  values(v_delivery, v_branch, v_supplier, v_code, v_user, p_notes);
  for line in select * from jsonb_array_elements(p_lines) loop
    v_cartons := coalesce((line->>'cartons')::integer, 0); v_packs := greatest(coalesce((line->>'packs_per_carton')::integer, 1), 1); v_pieces := greatest(coalesce((line->>'pieces_per_pack')::integer, 1), 1);
    if nullif(line->>'category_name','') is not null then
      insert into public.product_categories(branch_id, name) values(v_branch, line->>'category_name')
      on conflict (branch_id, name) do update set name = excluded.name returning id into v_category;
      select product_id into v_product from public.product_variants where id = (line->>'product_variant_id')::uuid;
      insert into public.branch_product_categorization(branch_id, product_id, category_id) values(v_branch, v_product, v_category)
      on conflict (branch_id, product_id) do update set category_id = excluded.category_id;
    end if;
    insert into public.stock_batches(product_variant_id, branch_id, supplier_id, manufacturer_name, delivery_id, delivery_code, logged_by, batch_number, expiry_date, cost_price, selling_price, quantity_received)
    values((line->>'product_variant_id')::uuid, v_branch, v_supplier, nullif(line->>'manufacturer_name',''), v_delivery, v_code, v_user, line->>'batch_number', (line->>'expiry_date')::date, (line->>'cost_price')::numeric, (line->>'selling_price')::numeric, coalesce((line->>'quantity_received')::integer, v_cartons * v_packs * v_pieces)) returning id into v_batch;
    if v_cartons > 0 then
      for i in 1..v_cartons loop
        insert into public.barcodes(stock_batch_id, barcode_type, code, code_source, child_count, quantity_available)
        values(v_batch, 'box', format('%s-%s-C%s', v_code, substr(replace(v_batch::text,'-',''),1,6), lpad(i::text,2,'0')), 'generated', v_packs, 1) returning id into v_parent;
        for j in 1..v_packs loop
          insert into public.barcodes(stock_batch_id, parent_barcode_id, barcode_type, code, code_source, pieces_per_pack, quantity_available)
          values(v_batch, v_parent, 'pack', format('%s-%s-C%s-P%s', v_code, substr(replace(v_batch::text,'-',''),1,6), lpad(i::text,2,'0'), lpad(j::text,2,'0')), 'generated', v_pieces, 1);
        end loop;
      end loop;
    else
      insert into public.barcodes(stock_batch_id, barcode_type, code, code_source, pieces_per_pack, quantity_available)
      values(v_batch, 'pack', format('%s-%s-P01', v_code, substr(replace(v_batch::text,'-',''),1,6)), 'generated', v_pieces, 1);
    end if;
  end loop;
  return query select v_delivery, v_code;
end $$;
revoke execute on function public.receive_stock_delivery(text, text, jsonb) from public, anon;
grant execute on function public.receive_stock_delivery(text, text, jsonb) to authenticated;
