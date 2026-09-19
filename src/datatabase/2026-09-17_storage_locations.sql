-- ============================================================================
-- STORAGE LOCATIONS -- optional, per-branch, manager-defined physical
-- locations ("Cabinet A", "Fridge 2", "Shelf near counter") that a product
-- can be tagged with, so staff can see exactly where to find it when
-- selling or searching -- entirely opt-in: a branch that never creates one
-- sees nothing different anywhere in the app.
-- ============================================================================
-- Same shape and access pattern as product_categories (its closest sibling
-- in this schema -- a small, branch-scoped, owner/manager-curated reference
-- list): direct table RLS for reads/writes, plus dedicated RPCs that add
-- validation (name required, owner/manager only to create/rename/delete/
-- assign) on top.
--
-- Two tables:
--   storage_locations           -- the named locations themselves
--   product_storage_locations   -- which product is currently AT which
--                                  location (per branch; a product can be
--                                  at only one location at a time, matching
--                                  how a physical cabinet actually works)
--
-- Surfaced in lookup_barcode() (below) so it shows up wherever a sale
-- scans/looks up a product -- the actual "help staff find it" payoff.
-- ============================================================================

create table if not exists public.storage_locations (
  id uuid primary key default gen_random_uuid(),
    branch_id uuid not null references public.branches(id) on delete cascade,
      name varchar(100) not null,
        created_at timestamptz not null default now(),
          unique (branch_id, name)
          );

          alter table public.storage_locations enable row level security;
          drop policy if exists "storage locations access" on public.storage_locations;
          create policy "storage locations access" on public.storage_locations
            for all to authenticated
              using (branch_id = public.current_branch_id() or public.is_super_admin())
                with check (branch_id = public.current_branch_id() or public.is_super_admin());
                grant select, insert, update, delete on public.storage_locations to authenticated;


                create table if not exists public.product_storage_locations (
                  branch_id uuid not null references public.branches(id) on delete cascade,
                    product_id uuid not null references public.products(id) on delete cascade,
                      storage_location_id uuid not null references public.storage_locations(id) on delete cascade,
                        updated_at timestamptz not null default now(),
                          updated_by uuid references public.users(id),
                            primary key (branch_id, product_id)
                            );

                            alter table public.product_storage_locations enable row level security;
                            drop policy if exists "product storage locations access" on public.product_storage_locations;
                            create policy "product storage locations access" on public.product_storage_locations
                              for all to authenticated
                                using (branch_id = public.current_branch_id() or public.is_super_admin())
                                  with check (branch_id = public.current_branch_id() or public.is_super_admin());
                                  grant select, insert, update, delete on public.product_storage_locations to authenticated;


                                  create or replace function public.list_storage_locations()
                                  returns table(id uuid, name text, product_count integer)
                                  language sql
                                  stable
                                  security definer
                                  set search_path = ''
                                  as $$
                                    select sl.id, sl.name::text,
                                        (select count(*)::integer from public.product_storage_locations psl where psl.storage_location_id = sl.id)
                                          from public.storage_locations sl
                                            where sl.branch_id = public.current_branch_id()
                                              order by sl.name;
                                              $$;

                                              revoke all on function public.list_storage_locations() from public, anon;
                                              grant execute on function public.list_storage_locations() to authenticated;


                                              -- Creates a new location, or returns the existing one if a location with
                                              -- this name (case-insensitive) already exists -- lets the caller always
                                              -- "just create it" from a free-text box without a separate duplicate check.
                                              create or replace function public.create_storage_location(p_name text)
                                              returns uuid
                                              language plpgsql
                                              security definer
                                              set search_path = ''
                                              as $$
                                              declare
                                                v_branch uuid := public.current_branch_id();
                                                  v_id uuid;
                                                  begin
                                                    perform public.assert_owner_or_manager();
                                                      if v_branch is null then raise exception 'No active branch for this session'; end if;
                                                        if nullif(btrim(coalesce(p_name, '')), '') is null then raise exception 'A location name is required'; end if;

                                                          select id into v_id from public.storage_locations
                                                              where branch_id = v_branch and lower(name) = lower(btrim(p_name));
                                                                if v_id is not null then return v_id; end if;

                                                                  insert into public.storage_locations (branch_id, name) values (v_branch, btrim(p_name))
                                                                    returning id into v_id;
                                                                      return v_id;
                                                                      end;
                                                                      $$;

                                                                      revoke all on function public.create_storage_location(text) from public, anon;
                                                                      grant execute on function public.create_storage_location(text) to authenticated;


                                                                      create or replace function public.rename_storage_location(p_id uuid, p_name text)
                                                                      returns void
                                                                      language plpgsql
                                                                      security definer
                                                                      set search_path = ''
                                                                      as $$
                                                                      declare
                                                                        v_branch uuid := public.current_branch_id();
                                                                        begin
                                                                          perform public.assert_owner_or_manager();
                                                                            if nullif(btrim(coalesce(p_name, '')), '') is null then raise exception 'A location name is required'; end if;

                                                                              update public.storage_locations set name = btrim(p_name)
                                                                                where id = p_id and branch_id = v_branch;
                                                                                  if not found then raise exception 'Storage location not found for this branch'; end if;
                                                                                  end;
                                                                                  $$;

                                                                                  revoke all on function public.rename_storage_location(uuid, text) from public, anon;
                                                                                  grant execute on function public.rename_storage_location(uuid, text) to authenticated;


                                                                                  -- Deleting a location leaves the products that were assigned to it simply
                                                                                  -- unassigned (product_storage_locations rows cascade-delete via the FK) --
                                                                                  -- never deletes or touches the products/stock themselves.
                                                                                  create or replace function public.delete_storage_location(p_id uuid)
                                                                                  returns void
                                                                                  language plpgsql
                                                                                  security definer
                                                                                  set search_path = ''
                                                                                  as $$
                                                                                  declare
                                                                                    v_branch uuid := public.current_branch_id();
                                                                                    begin
                                                                                      perform public.assert_owner_or_manager();
                                                                                        delete from public.storage_locations where id = p_id and branch_id = v_branch;
                                                                                        end;
                                                                                        $$;

                                                                                        revoke all on function public.delete_storage_location(uuid) from public, anon;
                                                                                        grant execute on function public.delete_storage_location(uuid) to authenticated;


                                                                                        -- Assigns a product to a location, or unassigns it when
                                                                                        -- p_storage_location_id is null -- the one write path for "where do I keep
                                                                                        -- this medicine", usable any time (right after receiving stock, or much
                                                                                        -- later when the manager finally gets around to organizing the shelves).
                                                                                        create or replace function public.set_product_storage_location(p_product_id uuid, p_storage_location_id uuid)
                                                                                        returns void
                                                                                        language plpgsql
                                                                                        security definer
                                                                                        set search_path = ''
                                                                                        as $$
                                                                                        declare
                                                                                          v_branch uuid := public.current_branch_id();
                                                                                            v_user uuid := (select auth.uid());
                                                                                            begin
                                                                                              perform public.assert_owner_or_manager();
                                                                                                if v_branch is null then raise exception 'No active branch for this session'; end if;

                                                                                                  if p_storage_location_id is null then
                                                                                                      delete from public.product_storage_locations where branch_id = v_branch and product_id = p_product_id;
                                                                                                          return;
                                                                                                            end if;

                                                                                                              if not exists (select 1 from public.storage_locations where id = p_storage_location_id and branch_id = v_branch) then
                                                                                                                  raise exception 'Storage location not found for this branch';
                                                                                                                    end if;

                                                                                                                      insert into public.product_storage_locations (branch_id, product_id, storage_location_id, updated_by)
                                                                                                                        values (v_branch, p_product_id, p_storage_location_id, v_user)
                                                                                                                          on conflict (branch_id, product_id) do update
                                                                                                                              set storage_location_id = excluded.storage_location_id, updated_at = now(), updated_by = excluded.updated_by;
                                                                                                                              end;
                                                                                                                              $$;

                                                                                                                              revoke all on function public.set_product_storage_location(uuid, uuid) from public, anon;
                                                                                                                              grant execute on function public.set_product_storage_location(uuid, uuid) to authenticated;


                                                                                                                              -- Every product ever stocked at this branch, with its current location (if
                                                                                                                              -- any) -- backs the management screen's "assign a product" search/picker,
                                                                                                                              -- so a manager can organize from a full product list rather than only
                                                                                                                              -- ever being offered it during receiving.
                                                                                                                              create or replace function public.list_branch_products_for_location_picker()
                                                                                                                              returns table(product_id uuid, product_name text, generic_name text, storage_location_id uuid, storage_location_name text)
                                                                                                                              language sql
                                                                                                                              stable
                                                                                                                              security definer
                                                                                                                              set search_path = ''
                                                                                                                              as $$
                                                                                                                                select distinct on (p.id)
                                                                                                                                    p.id, p.name::text, p.generic_name::text, psl.storage_location_id, sl.name::text
                                                                                                                                      from public.stock_batches sb
                                                                                                                                        join public.product_variants pv on pv.id = sb.product_variant_id
                                                                                                                                          join public.products p on p.id = pv.product_id
                                                                                                                                            left join public.product_storage_locations psl on psl.branch_id = sb.branch_id and psl.product_id = p.id
                                                                                                                                              left join public.storage_locations sl on sl.id = psl.storage_location_id
                                                                                                                                                where sb.branch_id = public.current_branch_id()
                                                                                                                                                  order by p.id, p.name;
                                                                                                                                                  $$;

                                                                                                                                                  revoke all on function public.list_branch_products_for_location_picker() from public, anon;
                                                                                                                                                  grant execute on function public.list_branch_products_for_location_picker() to authenticated;


                                                                                                                                                  -- ============================================================================
                                                                                                                                                  -- lookup_barcode() -- widened with storage_location_name so a sale/search
                                                                                                                                                  -- shows exactly where the product physically is. Same body otherwise as
                                                                                                                                                  -- pharmacy_schema_consolidated.sql's own latest declaration.
                                                                                                                                                  -- ============================================================================

                                                                                                                                                  drop function if exists public.lookup_barcode(text);
                                                                                                                                                  create function public.lookup_barcode(p_code text)
                                                                                                                                                  returns table(
                                                                                                                                                    barcode_id uuid, code text, barcode_type text, status text,
                                                                                                                                                      quantity_available integer, pieces_per_pack integer, child_count integer,
                                                                                                                                                        child_pieces_per_pack integer, active_child_count integer,
                                                                                                                                                          parent_code text, stock_batch_id uuid, batch_number text, expiry_date date,
                                                                                                                                                            delivery_code text, selling_price numeric, product_id uuid, product_name text,
                                                                                                                                                              tax_rate_id uuid, dosage text, form text, manufacturer_name text, supplier_name text,
                                                                                                                                                                storage_location_name text
                                                                                                                                                                )
                                                                                                                                                                language sql
                                                                                                                                                                stable
                                                                                                                                                                security definer
                                                                                                                                                                set search_path = ''
                                                                                                                                                                as $$
                                                                                                                                                                  select
                                                                                                                                                                      bc.id,
                                                                                                                                                                          bc.code::text,
                                                                                                                                                                              bc.barcode_type::text,
                                                                                                                                                                                  bc.status::text,
                                                                                                                                                                                      bc.quantity_available,
                                                                                                                                                                                          bc.pieces_per_pack,
                                                                                                                                                                                              bc.child_count,
                                                                                                                                                                                                  case when bc.barcode_type = 'box' then (
                                                                                                                                                                                                        select max(cpp.pieces_per_pack)::integer
                                                                                                                                                                                                              from public.barcodes cpp
                                                                                                                                                                                                                    where cpp.parent_barcode_id = bc.id
                                                                                                                                                                                                                            and cpp.barcode_type = 'pack'
                                                                                                                                                                                                                                    and cpp.status = 'active'
                                                                                                                                                                                                                                            and cpp.quantity_available > 0
                                                                                                                                                                                                                                                ) end as child_pieces_per_pack,
                                                                                                                                                                                                                                                    case when bc.barcode_type = 'box' then (
                                                                                                                                                                                                                                                          select count(*)::integer
                                                                                                                                                                                                                                                                from public.barcodes cpp
                                                                                                                                                                                                                                                                      where cpp.parent_barcode_id = bc.id
                                                                                                                                                                                                                                                                              and cpp.barcode_type = 'pack'
                                                                                                                                                                                                                                                                                      and cpp.status = 'active'
                                                                                                                                                                                                                                                                                              and cpp.quantity_available > 0
                                                                                                                                                                                                                                                                                                  ) end as active_child_count,
                                                                                                                                                                                                                                                                                                      parent.code::text,
                                                                                                                                                                                                                                                                                                          sb.id,
                                                                                                                                                                                                                                                                                                              sb.batch_number::text,
                                                                                                                                                                                                                                                                                                                  sb.expiry_date,
                                                                                                                                                                                                                                                                                                                      sb.delivery_code::text,
                                                                                                                                                                                                                                                                                                                          sb.selling_price,
                                                                                                                                                                                                                                                                                                                              p.id,
                                                                                                                                                                                                                                                                                                                                  p.name::text,
                                                                                                                                                                                                                                                                                                                                      p.tax_rate_id,
                                                                                                                                                                                                                                                                                                                                          pv.dosage::text,
                                                                                                                                                                                                                                                                                                                                              pv.form::text,
                                                                                                                                                                                                                                                                                                                                                  sb.manufacturer_name::text,
                                                                                                                                                                                                                                                                                                                                                      s.supplier_name::text,
                                                                                                                                                                                                                                                                                                                                                          sl.name::text
                                                                                                                                                                                                                                                                                                                                                            from public.barcodes bc
                                                                                                                                                                                                                                                                                                                                                              join public.stock_batches sb on sb.id = bc.stock_batch_id
                                                                                                                                                                                                                                                                                                                                                                join public.product_variants pv on pv.id = sb.product_variant_id
                                                                                                                                                                                                                                                                                                                                                                  join public.products p on p.id = pv.product_id
                                                                                                                                                                                                                                                                                                                                                                    left join public.barcodes parent on parent.id = bc.parent_barcode_id
                                                                                                                                                                                                                                                                                                                                                                      left join public.suppliers s on s.id = sb.supplier_id
                                                                                                                                                                                                                                                                                                                                                                        left join public.product_storage_locations psl on psl.branch_id = sb.branch_id and psl.product_id = p.id
                                                                                                                                                                                                                                                                                                                                                                          left join public.storage_locations sl on sl.id = psl.storage_location_id
                                                                                                                                                                                                                                                                                                                                                                            where upper(bc.code) = upper(btrim(p_code))
                                                                                                                                                                                                                                                                                                                                                                                and (
                                                                                                                                                                                                                                                                                                                                                                                      public.is_super_admin()
                                                                                                                                                                                                                                                                                                                                                                                            or sb.branch_id = public.current_branch_id()
                                                                                                                                                                                                                                                                                                                                                                                                )
                                                                                                                                                                                                                                                                                                                                                                                                  limit 1
                                                                                                                                                                                                                                                                                                                                                                                                  $$;

                                                                                                                                                                                                                                                                                                                                                                                                  grant execute on function public.lookup_barcode(text) to authenticated;
                                                                                                                                                                                                                                                                                                                                                                                                  