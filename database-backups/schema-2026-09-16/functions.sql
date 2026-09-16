-- ============================================================
-- activate_pharmacy_account()
-- ============================================================
CREATE OR REPLACE FUNCTION public.activate_pharmacy_account()
 RETURNS TABLE(branch_id uuid, branch_code text, activation_code text, pharmacy_name text)
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''
AS $function$
  #variable_conflict use_column
  declare
    v_user uuid := (select auth.uid());
    v_email text;
    v_app public.branch_applications%rowtype;
    v_loc text;
    v_seq integer;
    v_code text;
    v_act text;
    v_chars text := 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
    i integer;
  begin
    if v_user is null then raise exception 'Sign in with the emailed OTP first'; end if;

    select u.email into v_email from auth.users u where u.id = v_user;
    if v_email is null then raise exception 'Auth user email was not found'; end if;

    -- Checked FIRST so this function is idempotent. verifyOtp() runs before this
    -- RPC on the client, so any failure here leaves a live auth session with no
    -- public.users row; re-running must heal that state rather than fail again.
    if exists (select 1 from public.users u where u.id = v_user) then
      return query
        select b.id, b.branch_code::text, b.activation_code::text, b.name::text
        from public.users u
        join public.branches b on b.id = u.branch_id
        where u.id = v_user;
      return;
    end if;

    select * into v_app
    from public.branch_applications a
    where lower(a.email) = lower(v_email)
      and a.status = 'otp_sent'
    order by a.submitted_at desc
    limit 1;

    if v_app.id is null then
      raise exception 'No approved application is awaiting activation for %. Ask the super admin to approve the pharmacy first.', v_email;
    end if;

    if v_app.branch_id is null then
      raise exception 'This application has no branch record yet. Ask the super admin to approve it again.';
    end if;

    if exists (select 1 from public.users u where u.branch_id = v_app.branch_id) then
      raise exception 'This pharmacy already has an operator account';
    end if;

    -- Reuse identifiers from an earlier partial run instead of burning a new
    -- sequence number and silently changing a code the branch may already hold.
    select b.branch_code, b.activation_code
    into v_code, v_act
    from public.branches b
    where b.id = v_app.branch_id;

    if v_code is null then
      v_loc := upper(regexp_replace(split_part(v_app.location, ',', 1), '[^A-Za-z]', '', 'g'));
      if length(coalesce(v_loc, '')) < 3 then v_loc := rpad(coalesce(v_loc, ''), 3, 'X'); else v_loc := left(v_loc, 3); end if;

      select coalesce(max(substring(b.branch_code from '[0-9]+$')::integer), 0) + 1
      into v_seq
      from public.branches b
      where b.branch_code ~ '^PSYNC-[A-Z]{3}-[0-9]{4}$';

      v_code := format('PSYNC-%s-%s', v_loc, lpad(v_seq::text, 4, '0'));
    end if;

    if v_act is null then
      v_act := 'ACT-';
      for i in 1..6 loop
        v_act := v_act || substr(v_chars, 1 + floor(random() * length(v_chars))::integer, 1);
      end loop;
    end if;

    update public.branches
    set status = 'active', branch_code = v_code, activation_code = v_act
    where id = v_app.branch_id;

    insert into public.users (id, branch_id, full_name, email, role, is_active)
    values (v_user, v_app.branch_id, v_app.pharmacy_name, lower(v_email), 'owner', true);

    -- Starter category set, seeded once at true first activation only (never
    -- on the early-return path above for an already-active account) -- a
    -- branch that later deletes one of these deliberately should not have it
    -- silently reappear on a later sign-in. Same reasoning as branch_directory
    -- just below: targeted by constraint name, not by column list, since
    -- `branch_id` is this function's own RETURNS TABLE output parameter too.
    insert into public.product_categories (branch_id, name, description) values
      (v_app.branch_id, 'Allergy & Antihistamines', 'Allergy relief medicines'),
      (v_app.branch_id, 'Antibiotics', 'Prescription antibacterial medicines'),
      (v_app.branch_id, 'Antimalarials', 'Malaria prevention and treatment'),
      (v_app.branch_id, 'Cardiovascular', 'Heart and blood pressure medicines'),
      (v_app.branch_id, 'Contraceptives & Family Planning', 'Reproductive health products'),
      (v_app.branch_id, 'Cough, Cold & Flu', 'Respiratory and cold symptom relief'),
      (v_app.branch_id, 'Diabetes Care', 'Blood sugar management'),
      (v_app.branch_id, 'Digestive Health', 'Antacids and gastrointestinal medicines'),
      (v_app.branch_id, 'Eye & Ear Care', 'Ophthalmic and ENT products'),
      (v_app.branch_id, 'First Aid & Wound Care', 'Bandages, antiseptics, and wound supplies'),
      (v_app.branch_id, 'Herbal & Traditional Medicine', 'Non-conventional remedies'),
      (v_app.branch_id, 'Maternal & Child Health', 'Products for mothers and infants'),
      (v_app.branch_id, 'Medical Supplies', 'PPE, gloves, syringes, and general supplies'),
      (v_app.branch_id, 'Pain Relief & Fever', 'Analgesics and antipyretics'),
      (v_app.branch_id, 'Personal Care & Hygiene', 'General hygiene and personal care items'),
      (v_app.branch_id, 'Skin Care & Dermatology', 'Topical and skin treatment products'),
      (v_app.branch_id, 'Vitamins & Supplements', 'Nutritional support products')
    on conflict on constraint product_categories_branch_id_name_key do nothing;

    -- Targeted by constraint name, NOT by column list. `on conflict (branch_id)`
    -- cannot be resolved here: the inference clause only accepts bare column
    -- names, and `branch_id` is also this function's RETURNS TABLE output
    -- parameter, so Postgres raises "column reference branch_id is ambiguous"
    -- at runtime. Naming the constraint removes the inference step entirely.
    insert into public.branch_directory (branch_id, display_name)
    values (v_app.branch_id, v_app.pharmacy_name)
    on conflict on constraint branch_directory_pkey
    do update set display_name = excluded.display_name;

    update public.branch_applications set status = 'active' where id = v_app.id;

    return query select v_app.branch_id, v_code, v_act, v_app.pharmacy_name::text;
  end;
  $function$
;

-- ============================================================
-- adjust_stock(p_stock_batch_id uuid, p_adjustment_type text, p_delta integer, p_reason text)
-- ============================================================
CREATE OR REPLACE FUNCTION public.adjust_stock(p_stock_batch_id uuid, p_adjustment_type text, p_delta integer, p_reason text)
 RETURNS uuid
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''
AS $function$
declare
  v_branch uuid;
  v_user uuid := (select auth.uid());
  v_batch record;
  v_remaining integer;
  v_take integer;
  v_new_status text;
  v_pack record;
  v_adjustment uuid;
begin
  select u.branch_id into v_branch
  from public.users u
  where u.id = v_user and u.is_active;

  if v_branch is null or not exists (
    select 1 from public.users u where u.id = v_user and u.role in ('owner','manager')
  ) then
    raise exception 'Only an active branch manager or owner may adjust stock';
  end if;

  if p_adjustment_type not in ('damage','loss','correction','return','expired_writeoff','recalled') then
    raise exception 'Unknown adjustment type: %', p_adjustment_type;
  end if;
  if p_delta = 0 then
    raise exception 'Adjustment quantity cannot be zero';
  end if;
  if p_adjustment_type <> 'correction' and p_delta > 0 then
    raise exception '% must reduce stock, not add it', p_adjustment_type;
  end if;
  if nullif(btrim(coalesce(p_reason, '')), '') is null then
    raise exception 'A reason is required for every stock adjustment';
  end if;

  select sb.*, p.name as product_name, pv.dosage
    into v_batch
    from public.stock_batches sb
    join public.product_variants pv on pv.id = sb.product_variant_id
    join public.products p on p.id = pv.product_id
    where sb.id = p_stock_batch_id and sb.branch_id = v_branch;
  if not found then
    raise exception 'Stock batch not found for this branch';
  end if;

  v_new_status := case p_adjustment_type
    when 'damage' then 'damaged'
    when 'recalled' then 'recalled'
    when 'expired_writeoff' then 'expired'
    else 'sold_out'
  end;

  if p_delta < 0 then
    v_remaining := abs(p_delta);
    for v_pack in
      select * from public.barcodes
      where stock_batch_id = p_stock_batch_id and barcode_type = 'pack'
        and status = 'active' and quantity_available > 0
      order by created_at asc
      for update
    loop
      exit when v_remaining <= 0;
      v_take := least(v_remaining, coalesce(v_pack.pieces_per_pack, 0));
      if v_take >= v_pack.pieces_per_pack then
        update public.barcodes set quantity_available = 0, status = v_new_status where id = v_pack.id;
      else
        update public.barcodes set pieces_per_pack = v_pack.pieces_per_pack - v_take where id = v_pack.id;
      end if;
      v_remaining := v_remaining - v_take;
    end loop;

    if v_remaining > 0 then
      raise exception 'Only % piece(s) available in this batch -- cannot remove %', abs(p_delta) - v_remaining, abs(p_delta);
    end if;
  else
    insert into public.barcodes (stock_batch_id, barcode_type, code, code_source, pieces_per_pack, quantity_available, status)
    values (p_stock_batch_id, 'pack', public.generate_short_barcode_code(), 'generated', p_delta, 1, 'active');
  end if;

  insert into public.stock_adjustments (stock_batch_id, adjustment_type, quantity, reason, performed_by)
  values (p_stock_batch_id, p_adjustment_type, abs(p_delta), btrim(p_reason), v_user)
  returning id into v_adjustment;

  insert into public.notifications (branch_id, source_type, source_id, message)
  values (
    v_branch, 'stock_adjustment', v_adjustment,
    format('%s: %s %s piece(s) of %s (%s)',
      initcap(p_adjustment_type), case when p_delta < 0 then 'removed' else 'added' end,
      abs(p_delta), concat_ws(' ', v_batch.product_name, v_batch.dosage), btrim(p_reason))
  );

  return v_adjustment;
end;
$function$
;

-- ============================================================
-- admin_approve_pharmacy_application(p_application_id uuid)
-- ============================================================
CREATE OR REPLACE FUNCTION public.admin_approve_pharmacy_application(p_application_id uuid)
 RETURNS TABLE(branch_id uuid, email text)
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''
AS $function$
  declare
    v_app public.branch_applications%rowtype;
    v_branch uuid := gen_random_uuid();
  begin
    perform public.assert_super_admin();
    select * into v_app from public.branch_applications where id = p_application_id;
    if v_app.id is null then raise exception 'Application not found'; end if;
    if v_app.status <> 'pending' then raise exception 'Only pending applications can be approved'; end if;
    if v_app.called_at is null then raise exception 'Call the pharmacy before approving'; end if;

    insert into public.branches (id, name, address, phone, email, status)
    values (v_branch, v_app.pharmacy_name, v_app.location, v_app.phone, v_app.email, 'otp_sent');

    update public.branch_applications
    set status = 'otp_sent', branch_id = v_branch, otp_sent_at = now()
    where id = p_application_id;

    return query select v_branch, v_app.email::text;
  end;
  $function$
;

-- ============================================================
-- admin_approve_product_request(p_request_id uuid, p_product_name text, p_generic_name text, p_product_type text, p_tax_rate_id uuid, p_variants jsonb)
-- ============================================================
CREATE OR REPLACE FUNCTION public.admin_approve_product_request(p_request_id uuid, p_product_name text, p_generic_name text, p_product_type text, p_tax_rate_id uuid, p_variants jsonb)
 RETURNS TABLE(product_id uuid, variant_id uuid)
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''
AS $function$
declare
  v_req public.product_requests%rowtype;
  v_type text;
  v_product uuid;
  v_first_variant uuid;
  v_variant uuid;
  v_variant_json jsonb;
  v_is_first boolean := true;
begin
  perform public.assert_super_admin();

  select * into v_req from public.product_requests where id = p_request_id;
  if v_req.id is null then raise exception 'Product request not found'; end if;
  if v_req.status <> 'pending' then raise exception 'Only a pending request can be approved'; end if;
  if nullif(btrim(coalesce(p_product_name, '')), '') is null then raise exception 'A product name is required'; end if;
  if not exists (select 1 from public.tax_rates t where t.id = p_tax_rate_id) then
    raise exception 'Unknown tax rate';
  end if;
  if jsonb_typeof(p_variants) <> 'array' or jsonb_array_length(p_variants) = 0 then
    raise exception 'At least one variant (dosage/form/unit) is required';
  end if;

  v_type := coalesce(nullif(p_product_type, ''), 'medicine');
  if v_type not in ('medicine','supply','other') then v_type := 'other'; end if;

  select p.id into v_product from public.products p where lower(p.name) = lower(btrim(p_product_name));
  if v_product is null then
    insert into public.products (tax_rate_id, product_type, name, generic_name)
    values (p_tax_rate_id, v_type, btrim(p_product_name), nullif(btrim(coalesce(p_generic_name, '')), ''))
    returning id into v_product;
  else
    update public.products set tax_rate_id = p_tax_rate_id where id = v_product;
  end if;

  for v_variant_json in select * from jsonb_array_elements(p_variants) loop
    select pv.id into v_variant
    from public.product_variants pv
    where pv.product_id = v_product
      and coalesce(pv.dosage, '') = coalesce(nullif(btrim(coalesce(v_variant_json->>'dosage', '')), ''), '')
      and coalesce(pv.form, '') = coalesce(nullif(btrim(coalesce(v_variant_json->>'form', '')), ''), '')
    limit 1;

    if v_variant is null then
      insert into public.product_variants (product_id, dosage, form, unit)
      values (
        v_product,
        nullif(btrim(coalesce(v_variant_json->>'dosage', '')), ''),
        nullif(btrim(coalesce(v_variant_json->>'form', '')), ''),
        nullif(btrim(coalesce(v_variant_json->>'unit', '')), '')
      )
      returning id into v_variant;
    end if;

    if v_is_first then v_first_variant := v_variant; v_is_first := false; end if;
  end loop;

  update public.product_requests
  set status = 'approved', resolved_product_id = v_product, resolved_variant_id = v_first_variant,
      resolved_by = (select auth.uid()), resolved_at = now()
  where id = p_request_id;

  insert into public.notifications (branch_id, source_type, source_id, message)
  values (v_req.branch_id, 'product_request_approved', p_request_id,
    format('Your product request was approved: "%s" is now in the catalogue.', btrim(p_product_name)));

  return query select v_product, v_first_variant;
end;
$function$
;

-- ============================================================
-- admin_clear_insurance_coverage(p_provider_id uuid, p_product_id uuid)
-- ============================================================
CREATE OR REPLACE FUNCTION public.admin_clear_insurance_coverage(p_provider_id uuid, p_product_id uuid)
 RETURNS void
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''
AS $function$
begin
  perform public.assert_super_admin();
  delete from public.insurance_product_coverage
  where insurance_provider_id = p_provider_id and product_id = p_product_id;
end;
$function$
;

-- ============================================================
-- admin_clear_insurance_variant_price(p_provider_id uuid, p_product_variant_id uuid)
-- ============================================================
CREATE OR REPLACE FUNCTION public.admin_clear_insurance_variant_price(p_provider_id uuid, p_product_variant_id uuid)
 RETURNS void
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''
AS $function$
begin
  perform public.assert_super_admin();
  delete from public.insurance_variant_prices
  where insurance_provider_id = p_provider_id and product_variant_id = p_product_variant_id;
end;
$function$
;

-- ============================================================
-- admin_create_category(p_name text, p_description text, p_branch_id uuid)
-- ============================================================
CREATE OR REPLACE FUNCTION public.admin_create_category(p_name text, p_description text, p_branch_id uuid DEFAULT NULL::uuid)
 RETURNS integer
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''
AS $function$
declare
  v_count integer := 0;
begin
  perform public.assert_super_admin();
  if nullif(btrim(coalesce(p_name, '')), '') is null then raise exception 'A category name is required'; end if;

  if p_branch_id is not null then
    insert into public.product_categories (branch_id, name, description)
    values (p_branch_id, btrim(p_name), nullif(btrim(coalesce(p_description, '')), ''))
    on conflict (branch_id, name) do nothing;
    get diagnostics v_count = row_count;
  else
    insert into public.product_categories (branch_id, name, description)
    select b.id, btrim(p_name), nullif(btrim(coalesce(p_description, '')), '')
    from public.branches b
    on conflict (branch_id, name) do nothing;
    get diagnostics v_count = row_count;
  end if;

  return v_count;
end;
$function$
;

-- ============================================================
-- admin_create_insurance_provider(p_name text, p_default_coverage_percentage numeric, p_contact_info text)
-- ============================================================
CREATE OR REPLACE FUNCTION public.admin_create_insurance_provider(p_name text, p_default_coverage_percentage numeric, p_contact_info text DEFAULT NULL::text)
 RETURNS uuid
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''
AS $function$
declare
  v_id uuid;
begin
  perform public.assert_super_admin();
  if nullif(btrim(p_name), '') is null then
    raise exception 'Insurance provider name is required';
  end if;
  if p_default_coverage_percentage is null or p_default_coverage_percentage < 0 or p_default_coverage_percentage > 100 then
    raise exception 'Default coverage percentage must be between 0 and 100';
  end if;
  insert into public.insurance_providers (name, default_coverage_percentage, contact_info)
  values (btrim(p_name), p_default_coverage_percentage, nullif(btrim(coalesce(p_contact_info, '')), ''))
  returning id into v_id;
  return v_id;
end;
$function$
;

-- ============================================================
-- admin_create_insurance_provider(p_name text, p_default_coverage_percentage numeric, p_contact_info text, p_tin text)
-- ============================================================
CREATE OR REPLACE FUNCTION public.admin_create_insurance_provider(p_name text, p_default_coverage_percentage numeric, p_contact_info text DEFAULT NULL::text, p_tin text DEFAULT NULL::text)
 RETURNS uuid
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''
AS $function$
declare
  v_id uuid;
begin
  perform public.assert_super_admin();
  if nullif(btrim(p_name), '') is null then
    raise exception 'Insurance provider name is required';
  end if;
  if p_default_coverage_percentage is null or p_default_coverage_percentage < 0 or p_default_coverage_percentage > 100 then
    raise exception 'Default coverage percentage must be between 0 and 100';
  end if;
  insert into public.insurance_providers (name, default_coverage_percentage, contact_info, tin)
  values (
    btrim(p_name), p_default_coverage_percentage,
    nullif(btrim(coalesce(p_contact_info, '')), ''),
    nullif(btrim(coalesce(p_tin, '')), '')
  )
  returning id into v_id;
  return v_id;
end;
$function$
;

-- ============================================================
-- admin_create_product(p_name text, p_generic_name text, p_product_type text, p_tax_rate_id uuid, p_variants jsonb)
-- ============================================================
CREATE OR REPLACE FUNCTION public.admin_create_product(p_name text, p_generic_name text, p_product_type text, p_tax_rate_id uuid, p_variants jsonb)
 RETURNS uuid
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''
AS $function$
declare
  v_type text;
  v_product uuid;
  v_variant jsonb;
begin
  perform public.assert_super_admin();
  if nullif(btrim(coalesce(p_name, '')), '') is null then raise exception 'A product name is required'; end if;
  if not exists (select 1 from public.tax_rates t where t.id = p_tax_rate_id) then
    raise exception 'Unknown tax rate';
  end if;
  if jsonb_typeof(p_variants) <> 'array' or jsonb_array_length(p_variants) = 0 then
    raise exception 'At least one variant (dosage/form/unit) is required';
  end if;

  v_type := coalesce(nullif(p_product_type, ''), 'medicine');
  if v_type not in ('medicine','supply','other') then v_type := 'other'; end if;

  insert into public.products (tax_rate_id, product_type, name, generic_name)
  values (p_tax_rate_id, v_type, btrim(p_name), nullif(btrim(coalesce(p_generic_name, '')), ''))
  returning id into v_product;

  for v_variant in select * from jsonb_array_elements(p_variants) loop
    insert into public.product_variants (product_id, dosage, form, unit)
    values (
      v_product,
      nullif(btrim(coalesce(v_variant->>'dosage', '')), ''),
      nullif(btrim(coalesce(v_variant->>'form', '')), ''),
      nullif(btrim(coalesce(v_variant->>'unit', '')), '')
    );
  end loop;

  return v_product;
end;
$function$
;

-- ============================================================
-- admin_create_tax_rate(p_name text, p_rate_percentage numeric)
-- ============================================================
CREATE OR REPLACE FUNCTION public.admin_create_tax_rate(p_name text, p_rate_percentage numeric)
 RETURNS uuid
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''
AS $function$
declare
  v_id uuid;
begin
  perform public.assert_super_admin();
  if nullif(btrim(coalesce(p_name, '')), '') is null then raise exception 'A tax rate name is required'; end if;
  if p_rate_percentage is null or p_rate_percentage < 0 or p_rate_percentage > 100 then
    raise exception 'Tax rate must be between 0 and 100';
  end if;
  insert into public.tax_rates (name, rate_percentage) values (btrim(p_name), p_rate_percentage) returning id into v_id;
  return v_id;
end;
$function$
;

-- ============================================================
-- admin_delete_branch(p_branch_id uuid, p_reason text)
-- ============================================================
CREATE OR REPLACE FUNCTION public.admin_delete_branch(p_branch_id uuid, p_reason text DEFAULT NULL::text)
 RETURNS void
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''
AS $function$
declare
  v_branch public.branches%rowtype;
  v_deleted_by_email text;
begin
  perform public.assert_super_admin();

  select * into v_branch from public.branches where id = p_branch_id;
  if v_branch.id is null then
    raise exception 'Branch not found';
  end if;

  if exists (
    select 1 from public.batch_recalls r
    join public.users u on u.id = r.recalled_by
    where u.branch_id = p_branch_id
  ) then
    raise exception 'This branch cannot be deleted: a user from this branch is recorded as having issued a system-wide batch recall, and that recall record must be kept. Contact support to reassign it first.';
  end if;

  select email into v_deleted_by_email from auth.users where id = (select auth.uid());

  insert into public.deleted_branches_log (
    branch_id, pharmacy_name, phone, email, branch_code, location, reason, deleted_by_email
  ) values (
    v_branch.id, v_branch.name, v_branch.phone, v_branch.email, v_branch.branch_code, v_branch.address,
    nullif(btrim(coalesce(p_reason, '')), ''), v_deleted_by_email
  );

  delete from public.sale_items where sale_id in (select id from public.sales where branch_id = p_branch_id);
  delete from public.receipts where sale_id in (select id from public.sales where branch_id = p_branch_id);
  delete from public.insurance_claims where sale_id in (select id from public.sales where branch_id = p_branch_id);
  delete from public.sales where branch_id = p_branch_id;

  delete from public.stock_adjustments
  where stock_batch_id in (select id from public.stock_batches where branch_id = p_branch_id)
     or barcode_id in (
       select bc.id from public.barcodes bc
       join public.stock_batches sb on sb.id = bc.stock_batch_id
       where sb.branch_id = p_branch_id
     );

  delete from public.barcodes
  where stock_batch_id in (select id from public.stock_batches where branch_id = p_branch_id);

  delete from public.stock_batches where branch_id = p_branch_id;
  delete from public.stock_deliveries where branch_id = p_branch_id;

  delete from public.reorder_points where branch_id = p_branch_id;
  delete from public.branch_product_categorization where branch_id = p_branch_id;
  delete from public.product_categories where branch_id = p_branch_id;

  -- Previously missing: all three reference branches(id) with no ON DELETE
  -- CASCADE, so any branch that had ever registered a patient, created a
  -- discount, or filed a product request made the delete below fail with a
  -- raw foreign-key-violation error instead of actually deleting the branch.
  delete from public.patients where branch_id = p_branch_id;
  delete from public.discounts where branch_id = p_branch_id;
  delete from public.product_requests where branch_id = p_branch_id;

  delete from public.notifications where branch_id = p_branch_id;
  delete from public.sales_forecasts where branch_id = p_branch_id;
  delete from public.dashboard_reports where branch_id = p_branch_id;
  delete from public.support_tickets where branch_id = p_branch_id;
  delete from public.branch_settings where branch_id = p_branch_id;
  delete from public.suppliers where branch_id = p_branch_id;

  -- Denied (not just unlinked): submit_pharmacy_registration() blocks a new
  -- application from an email that already has one with status in
  -- ('pending','otp_sent','active'). Leaving this row 'active' with no
  -- branch behind it permanently locked that email out of ever registering
  -- again, which is the opposite of what deleting the branch should do.
  update public.branch_applications
  set branch_id = null,
      status = 'denied',
      denied_reason = coalesce(nullif(btrim(coalesce(p_reason, '')), ''), 'Branch deleted by admin')
  where branch_id = p_branch_id;

  delete from public.branch_directory where branch_id = p_branch_id;
  delete from public.users where branch_id = p_branch_id;
  delete from public.branches where id = p_branch_id;
end;
$function$
;

-- ============================================================
-- admin_deny_pharmacy_application(p_application_id uuid, p_reason text)
-- ============================================================
CREATE OR REPLACE FUNCTION public.admin_deny_pharmacy_application(p_application_id uuid, p_reason text)
 RETURNS void
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''
AS $function$
  begin
    perform public.assert_super_admin();
    update public.branch_applications
    set status = 'denied', denied_reason = nullif(btrim(p_reason), '')
    where id = p_application_id and status in ('pending','otp_sent');
    if not found then
      raise exception 'This application cannot be denied';
    end if;
  end;
  $function$
;

-- ============================================================
-- admin_expire_stale_applications()
-- ============================================================
CREATE OR REPLACE FUNCTION public.admin_expire_stale_applications()
 RETURNS integer
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''
AS $function$
declare
  v_deleted integer := 0;
begin
  perform public.assert_super_admin();

  delete from public.branch_applications
  where status = 'pending'
    and branch_id is null
    and submitted_at < now() - interval '7 days';

  get diagnostics v_deleted = row_count;
  return v_deleted;
end;
$function$
;

-- ============================================================
-- admin_import_insurance_price_list(p_provider_id uuid, p_tax_rate_id uuid, p_rows jsonb)
-- ============================================================
CREATE OR REPLACE FUNCTION public.admin_import_insurance_price_list(p_provider_id uuid, p_tax_rate_id uuid, p_rows jsonb)
 RETURNS TABLE(created_products integer, updated_products integer, created_variants integer, reused_variants integer, prices_set integer)
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''
AS $function$
declare
  v_product_id uuid;
  v_variant_id uuid;
  v_description text;
  r record;
  v_created_products int := 0;
  v_updated_products int := 0;
  v_created_variants int := 0;
  v_reused_variants int := 0;
  v_prices_set int := 0;
begin
  perform public.assert_super_admin();

  if not exists (select 1 from public.tax_rates where id = p_tax_rate_id) then
    raise exception 'Unknown tax rate';
  end if;
  if not exists (select 1 from public.insurance_providers where id = p_provider_id) then
    raise exception 'Unknown insurance provider';
  end if;
  if jsonb_typeof(p_rows) <> 'array' or jsonb_array_length(p_rows) = 0 then
    raise exception 'At least one row is required';
  end if;

  for r in
    select
      nullif(btrim(coalesce(row_data->>'drugCode', '')), '') as drug_code,
      coalesce(nullif(row_data->>'productType', ''), 'medicine') as product_type,
      nullif(btrim(coalesce(row_data->>'productName', '')), '') as product_name,
      nullif(btrim(coalesce(row_data->>'genericName', '')), '') as generic_name,
      nullif(btrim(coalesce(row_data->>'dosage', '')), '') as dosage,
      nullif(btrim(coalesce(row_data->>'form', '')), '') as form,
      nullif(btrim(coalesce(row_data->>'unit', '')), '') as unit,
      (row_data->>'price')::numeric as price
    from jsonb_array_elements(p_rows) as row_data
  loop
    -- Defensive only -- the client (buildImportPreview()) has already
    -- filtered out rows missing these, this just guards a hand-built payload.
    if r.drug_code is null or r.product_name is null or r.price is null then
      continue;
    end if;

    v_description := '[INS:' || p_provider_id::text || ':' || r.drug_code || '] ' || coalesce(r.generic_name, r.product_name);

    select id into v_product_id from public.products where description = v_description limit 1;

    if v_product_id is null then
      insert into public.products (tax_rate_id, product_type, name, generic_name, description)
      values (
        p_tax_rate_id, case when r.product_type in ('medicine','supply','other') then r.product_type else 'medicine' end,
        r.product_name, r.generic_name, v_description
      )
      returning id into v_product_id;
      v_created_products := v_created_products + 1;
    else
      update public.products
        set tax_rate_id = p_tax_rate_id,
            product_type = case when r.product_type in ('medicine','supply','other') then r.product_type else 'medicine' end,
            name = r.product_name, generic_name = r.generic_name
        where id = v_product_id;
      v_updated_products := v_updated_products + 1;
    end if;

    select id into v_variant_id from public.product_variants
      where product_id = v_product_id
        and coalesce(dosage, '') = coalesce(r.dosage, '')
        and coalesce(form, '') = coalesce(r.form, '')
      limit 1;

    if v_variant_id is null then
      insert into public.product_variants (product_id, dosage, form, unit)
      values (v_product_id, r.dosage, r.form, r.unit)
      returning id into v_variant_id;
      v_created_variants := v_created_variants + 1;
    else
      v_reused_variants := v_reused_variants + 1;
    end if;

    insert into public.insurance_variant_prices (insurance_provider_id, product_variant_id, fixed_price)
    values (p_provider_id, v_variant_id, r.price)
    on conflict (insurance_provider_id, product_variant_id)
      do update set fixed_price = excluded.fixed_price;
    v_prices_set := v_prices_set + 1;
  end loop;

  return query select v_created_products, v_updated_products, v_created_variants, v_reused_variants, v_prices_set;
end;
$function$
;

-- ============================================================
-- admin_list_categories()
-- ============================================================
CREATE OR REPLACE FUNCTION public.admin_list_categories()
 RETURNS TABLE(id uuid, branch_id uuid, branch_name text, name text, description text)
 LANGUAGE plpgsql
 STABLE SECURITY DEFINER
 SET search_path TO ''
AS $function$
begin
  perform public.assert_super_admin();
  return query
    select pc.id, pc.branch_id, b.name::text, pc.name::text, pc.description
    from public.product_categories pc
    join public.branches b on b.id = pc.branch_id
    order by b.name, pc.name;
end;
$function$
;

-- ============================================================
-- admin_list_deleted_branches()
-- ============================================================
CREATE OR REPLACE FUNCTION public.admin_list_deleted_branches()
 RETURNS TABLE(id uuid, branch_id uuid, pharmacy_name text, phone text, email text, branch_code text, location text, reason text, deleted_by_email text, deleted_at timestamp with time zone)
 LANGUAGE plpgsql
 STABLE SECURITY DEFINER
 SET search_path TO ''
AS $function$
begin
  perform public.assert_super_admin();
  return query
    select
      l.id, l.branch_id, l.pharmacy_name::text, l.phone::text, l.email::text,
      l.branch_code::text, l.location, l.reason, l.deleted_by_email::text, l.deleted_at
    from public.deleted_branches_log l
    order by l.deleted_at desc;
end;
$function$
;

-- ============================================================
-- admin_list_pharmacy_applications()
-- ============================================================
CREATE OR REPLACE FUNCTION public.admin_list_pharmacy_applications()
 RETURNS TABLE(id uuid, application_code text, pharmacy_name text, phone text, email text, location text, status text, called_at timestamp with time zone, denied_reason text, branch_id uuid, branch_code text, activation_code text, failed_logins integer, locked_at timestamp with time zone, submitted_at timestamp with time zone)
 LANGUAGE plpgsql
 STABLE SECURITY DEFINER
 SET search_path TO ''
AS $function$
  begin
    perform public.assert_super_admin();
    return query
      select
        a.id,
        a.application_code::text,
        a.pharmacy_name::text,
        a.phone::text,
        a.email::text,
        a.location::text,
        case
          when b.status = 'locked' then 'locked'
          else a.status
        end::text,
        a.called_at,
        a.denied_reason,
        a.branch_id,
        b.branch_code::text,
        b.activation_code::text,
        coalesce(b.failed_logins, 0),
        b.locked_at,
        a.submitted_at
      from public.branch_applications a
      left join public.branches b on b.id = a.branch_id
      order by a.submitted_at desc;
  end;
  $function$
;

-- ============================================================
-- admin_list_product_requests()
-- ============================================================
CREATE OR REPLACE FUNCTION public.admin_list_product_requests()
 RETURNS TABLE(id uuid, branch_id uuid, branch_name text, requested_by_name text, message text, image_path text, status text, resolved_product_id uuid, resolved_variant_id uuid, rejection_reason text, created_at timestamp with time zone)
 LANGUAGE plpgsql
 STABLE SECURITY DEFINER
 SET search_path TO ''
AS $function$
begin
  perform public.assert_super_admin();
  return query
    select
      r.id, r.branch_id, b.name::text, u.full_name::text,
      r.message, r.image_path, r.status::text,
      r.resolved_product_id, r.resolved_variant_id,
      r.rejection_reason, r.created_at
    from public.product_requests r
    join public.branches b on b.id = r.branch_id
    join public.users u on u.id = r.requested_by
    order by (r.status = 'pending') desc, r.created_at desc;
end;
$function$
;

-- ============================================================
-- admin_list_products()
-- ============================================================
CREATE OR REPLACE FUNCTION public.admin_list_products()
 RETURNS TABLE(product_id uuid, product_name text, generic_name text, product_type text, tax_rate_id uuid, tax_rate_name text, tax_rate_percentage numeric, variant_id uuid, dosage text, form text, unit text)
 LANGUAGE plpgsql
 STABLE SECURITY DEFINER
 SET search_path TO ''
AS $function$
begin
  perform public.assert_super_admin();
  return query
    select
      p.id, p.name::text, p.generic_name::text, p.product_type::text,
      t.id, t.name::text, t.rate_percentage,
      pv.id, pv.dosage::text, pv.form::text, pv.unit::text
    from public.products p
    join public.tax_rates t on t.id = p.tax_rate_id
    left join public.product_variants pv on pv.product_id = p.id
    order by p.name, pv.dosage nulls first;
end;
$function$
;

-- ============================================================
-- admin_list_support_tickets()
-- ============================================================
CREATE OR REPLACE FUNCTION public.admin_list_support_tickets()
 RETURNS TABLE(id uuid, branch_id uuid, branch_name text, raised_by_name text, subject text, description text, status text, priority text, created_at timestamp with time zone)
 LANGUAGE plpgsql
 STABLE SECURITY DEFINER
 SET search_path TO ''
AS $function$
begin
  perform public.assert_super_admin();
  return query
    select t.id, t.branch_id, b.name::text, u.full_name::text, t.subject::text, t.description, t.status::text, t.priority::text, t.created_at
    from public.support_tickets t
    join public.branches b on b.id = t.branch_id
    join public.users u on u.id = t.raised_by
    order by (t.status = 'open') desc, t.created_at desc;
end;
$function$
;

-- ============================================================
-- admin_mark_pharmacy_called(p_application_id uuid)
-- ============================================================
CREATE OR REPLACE FUNCTION public.admin_mark_pharmacy_called(p_application_id uuid)
 RETURNS void
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''
AS $function$
  begin
    perform public.assert_super_admin();
    update public.branch_applications
    set called_at = now()
    where id = p_application_id and status = 'pending';
    if not found then
      raise exception 'Call can only be recorded on a pending application';
    end if;
  end;
  $function$
;

-- ============================================================
-- admin_reject_product_request(p_request_id uuid, p_reason text)
-- ============================================================
CREATE OR REPLACE FUNCTION public.admin_reject_product_request(p_request_id uuid, p_reason text)
 RETURNS void
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''
AS $function$
declare
  v_req public.product_requests%rowtype;
begin
  perform public.assert_super_admin();
  select * into v_req from public.product_requests where id = p_request_id;
  if v_req.id is null then raise exception 'Product request not found'; end if;
  if v_req.status <> 'pending' then raise exception 'Only a pending request can be rejected'; end if;

  update public.product_requests
  set status = 'rejected', rejection_reason = nullif(btrim(coalesce(p_reason, '')), ''),
      resolved_by = (select auth.uid()), resolved_at = now()
  where id = p_request_id;

  insert into public.notifications (branch_id, source_type, source_id, message)
  values (v_req.branch_id, 'product_request_rejected', p_request_id,
    format('Your product request was declined.%s',
      case when nullif(btrim(coalesce(p_reason, '')), '') is not null then ' Reason: ' || btrim(p_reason) else '' end));
end;
$function$
;

-- ============================================================
-- admin_set_branch_lock(p_branch_id uuid, p_locked boolean)
-- ============================================================
CREATE OR REPLACE FUNCTION public.admin_set_branch_lock(p_branch_id uuid, p_locked boolean)
 RETURNS void
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''
AS $function$
  begin
    perform public.assert_super_admin();
    if p_locked then
      update public.branches
      set status = 'locked', locked_at = now()
      where id = p_branch_id;
      update public.users set is_active = false where branch_id = p_branch_id;
    else
      update public.branches
      set status = 'active', locked_at = null, failed_logins = 0
      where id = p_branch_id;
      update public.users set is_active = true where branch_id = p_branch_id;
    end if;
  end;
  $function$
;

-- ============================================================
-- admin_set_insurance_coverage(p_provider_id uuid, p_product_id uuid, p_coverage_percentage numeric)
-- ============================================================
CREATE OR REPLACE FUNCTION public.admin_set_insurance_coverage(p_provider_id uuid, p_product_id uuid, p_coverage_percentage numeric)
 RETURNS void
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''
AS $function$
begin
  perform public.assert_super_admin();
  if p_coverage_percentage is null or p_coverage_percentage < 0 or p_coverage_percentage > 100 then
    raise exception 'Coverage percentage must be between 0 and 100';
  end if;
  insert into public.insurance_product_coverage (insurance_provider_id, product_id, coverage_percentage)
  values (p_provider_id, p_product_id, p_coverage_percentage)
  on conflict (insurance_provider_id, product_id) do update set coverage_percentage = excluded.coverage_percentage;
end;
$function$
;

-- ============================================================
-- admin_set_insurance_variant_price(p_provider_id uuid, p_product_variant_id uuid, p_fixed_price numeric)
-- ============================================================
CREATE OR REPLACE FUNCTION public.admin_set_insurance_variant_price(p_provider_id uuid, p_product_variant_id uuid, p_fixed_price numeric)
 RETURNS void
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''
AS $function$
begin
  perform public.assert_super_admin();
  if p_fixed_price is null or p_fixed_price < 0 then
    raise exception 'Fixed price must be zero or greater';
  end if;
  insert into public.insurance_variant_prices (insurance_provider_id, product_variant_id, fixed_price)
  values (p_provider_id, p_product_variant_id, p_fixed_price)
  on conflict (insurance_provider_id, product_variant_id) do update set fixed_price = excluded.fixed_price;
end;
$function$
;

-- ============================================================
-- admin_set_product_tax(p_product_id uuid, p_tax_rate_id uuid)
-- ============================================================
CREATE OR REPLACE FUNCTION public.admin_set_product_tax(p_product_id uuid, p_tax_rate_id uuid)
 RETURNS void
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''
AS $function$
begin
  perform public.assert_super_admin();
  if not exists (select 1 from public.tax_rates t where t.id = p_tax_rate_id) then
    raise exception 'Unknown tax rate';
  end if;
  update public.products set tax_rate_id = p_tax_rate_id where id = p_product_id;
  if not found then raise exception 'Product not found'; end if;
end;
$function$
;

-- ============================================================
-- admin_set_seller_active(p_user_id uuid, p_is_active boolean)
-- ============================================================
CREATE OR REPLACE FUNCTION public.admin_set_seller_active(p_user_id uuid, p_is_active boolean)
 RETURNS void
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''
AS $function$
declare
  v_caller uuid := (select auth.uid());
  v_branch uuid;
  v_caller_role text;
  v_target_role text;
begin
  select u.branch_id, u.role into v_branch, v_caller_role
  from public.users u
  where u.id = v_caller and u.is_active and u.role in ('owner', 'manager');
  if v_branch is null then raise exception 'Only an active branch manager or owner may manage staff'; end if;

  select role into v_target_role from public.users where id = p_user_id and branch_id = v_branch;
  if v_target_role is null or v_target_role not in ('manager', 'seller') then
    raise exception 'Staff member not found for this branch';
  end if;
  if v_target_role = 'manager' and v_caller_role <> 'owner' then
    raise exception 'Only the branch owner may deactivate a manager';
  end if;

  update public.users
  set is_active = p_is_active
  where id = p_user_id and branch_id = v_branch and role in ('manager', 'seller');
end;
$function$
;

-- ============================================================
-- admin_update_branch_details(p_branch_id uuid, p_name text, p_phone text, p_email text, p_address text, p_tin text, p_website text, p_license_number text, p_license_expiry_date date)
-- ============================================================
CREATE OR REPLACE FUNCTION public.admin_update_branch_details(p_branch_id uuid, p_name text DEFAULT NULL::text, p_phone text DEFAULT NULL::text, p_email text DEFAULT NULL::text, p_address text DEFAULT NULL::text, p_tin text DEFAULT NULL::text, p_website text DEFAULT NULL::text, p_license_number text DEFAULT NULL::text, p_license_expiry_date date DEFAULT NULL::date)
 RETURNS void
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''
AS $function$
begin
  perform public.assert_super_admin();

  if not exists (select 1 from public.branches where id = p_branch_id) then
    raise exception 'Branch not found';
  end if;

  update public.branches
  set
    -- name is not nullable, so a blank leaves it alone rather than nulling it.
    name = coalesce(nullif(btrim(coalesce(p_name, '')), ''), name),
    phone = coalesce(nullif(btrim(coalesce(p_phone, '')), ''), phone),
    email = coalesce(nullif(btrim(coalesce(p_email, '')), ''), email),
    address = coalesce(nullif(btrim(coalesce(p_address, '')), ''), address),
    tin = coalesce(nullif(btrim(coalesce(p_tin, '')), ''), tin),
    website = coalesce(nullif(btrim(coalesce(p_website, '')), ''), website),
    license_number = coalesce(nullif(btrim(coalesce(p_license_number, '')), ''), license_number),
    license_expiry_date = coalesce(p_license_expiry_date, license_expiry_date)
  where id = p_branch_id;

  -- The sign-in directory shows the branch name, so it has to follow a rename.
  update public.branch_directory
  set display_name = (select b.name from public.branches b where b.id = p_branch_id)
  where branch_id = p_branch_id;
end;
$function$
;

-- ============================================================
-- admin_update_insurance_provider(p_provider_id uuid, p_name text, p_default_coverage_percentage numeric, p_contact_info text)
-- ============================================================
CREATE OR REPLACE FUNCTION public.admin_update_insurance_provider(p_provider_id uuid, p_name text, p_default_coverage_percentage numeric, p_contact_info text DEFAULT NULL::text)
 RETURNS void
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''
AS $function$
begin
  perform public.assert_super_admin();
  if p_default_coverage_percentage is null or p_default_coverage_percentage < 0 or p_default_coverage_percentage > 100 then
    raise exception 'Default coverage percentage must be between 0 and 100';
  end if;
  update public.insurance_providers
  set name = btrim(p_name),
      default_coverage_percentage = p_default_coverage_percentage,
      contact_info = nullif(btrim(coalesce(p_contact_info, '')), '')
  where id = p_provider_id;
  if not found then raise exception 'Insurance provider not found'; end if;
end;
$function$
;

-- ============================================================
-- admin_update_insurance_provider(p_provider_id uuid, p_name text, p_default_coverage_percentage numeric, p_contact_info text, p_tin text)
-- ============================================================
CREATE OR REPLACE FUNCTION public.admin_update_insurance_provider(p_provider_id uuid, p_name text, p_default_coverage_percentage numeric, p_contact_info text DEFAULT NULL::text, p_tin text DEFAULT NULL::text)
 RETURNS void
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''
AS $function$
begin
  perform public.assert_super_admin();
  if p_default_coverage_percentage is null or p_default_coverage_percentage < 0 or p_default_coverage_percentage > 100 then
    raise exception 'Default coverage percentage must be between 0 and 100';
  end if;
  update public.insurance_providers
  set name = btrim(p_name),
      default_coverage_percentage = p_default_coverage_percentage,
      contact_info = nullif(btrim(coalesce(p_contact_info, '')), ''),
      tin = nullif(btrim(coalesce(p_tin, '')), '')
  where id = p_provider_id;
  if not found then raise exception 'Insurance provider not found'; end if;
end;
$function$
;

-- ============================================================
-- admin_update_staff_role(p_user_id uuid, p_role text)
-- ============================================================
CREATE OR REPLACE FUNCTION public.admin_update_staff_role(p_user_id uuid, p_role text)
 RETURNS void
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''
AS $function$
declare
  v_caller uuid := (select auth.uid());
  v_branch uuid;
begin
  if p_role not in ('manager', 'seller') then
    raise exception 'role must be manager or seller';
  end if;

  select u.branch_id into v_branch
  from public.users u
  where u.id = v_caller and u.is_active and u.role = 'owner';
  if v_branch is null then raise exception 'Only the branch owner may change a staff member''s role'; end if;

  update public.users
  set role = p_role
  where id = p_user_id and branch_id = v_branch and role in ('manager', 'seller');
  if not found then raise exception 'Staff member not found for this branch'; end if;
end;
$function$
;

-- ============================================================
-- admin_update_ticket_status(p_ticket_id uuid, p_status text)
-- ============================================================
CREATE OR REPLACE FUNCTION public.admin_update_ticket_status(p_ticket_id uuid, p_status text)
 RETURNS void
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''
AS $function$
begin
  perform public.assert_super_admin();
  if p_status not in ('open','in_progress','resolved','closed') then raise exception 'Unknown status'; end if;
  update public.support_tickets set status = p_status where id = p_ticket_id;
  if not found then raise exception 'Ticket not found'; end if;
end;
$function$
;

-- ============================================================
-- ai_branch_snapshot()
-- ============================================================
CREATE OR REPLACE FUNCTION public.ai_branch_snapshot()
 RETURNS TABLE(branch_name text, today_revenue numeric, week_to_date_revenue numeric, month_to_date_revenue numeric, active_product_count integer, out_of_stock_count integer, low_stock_count integer, expiring_soon_count integer, pending_product_requests integer, unread_alerts integer)
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''
AS $function$
declare
  v_branch uuid := public.current_branch_id();
begin
  perform public.assert_owner_or_manager();
  if v_branch is null then raise exception 'No active branch for this session'; end if;

  return query
  select
    b.name::text,
    coalesce((select round(sum(si.unit_price * si.quantity), 2) from public.sale_items si join public.sales s on s.id = si.sale_id where s.branch_id = v_branch and s.sold_at >= date_trunc('day', now())), 0),
    coalesce((select round(sum(si.unit_price * si.quantity), 2) from public.sale_items si join public.sales s on s.id = si.sale_id where s.branch_id = v_branch and s.sold_at >= date_trunc('week', now())), 0),
    coalesce((select round(sum(si.unit_price * si.quantity), 2) from public.sale_items si join public.sales s on s.id = si.sale_id where s.branch_id = v_branch and s.sold_at >= date_trunc('month', now())), 0),
    (select count(distinct pv.product_id) from public.stock_batches sb join public.product_variants pv on pv.id = sb.product_variant_id where sb.branch_id = v_branch)::integer,
    (select count(*) from public.ai_stock_status('out'))::integer,
    (select count(*) from public.ai_stock_status('low'))::integer,
    (select count(*) from public.ai_stock_status('expiring'))::integer,
    (select count(*) from public.product_requests pr where pr.branch_id = v_branch and pr.status = 'pending')::integer,
    (select count(*) from public.notifications n where n.branch_id = v_branch and not n.is_read)::integer
  from public.branches b where b.id = v_branch;
end;
$function$
;

-- ============================================================
-- ai_category_breakdown(p_from date, p_to date)
-- ============================================================
CREATE OR REPLACE FUNCTION public.ai_category_breakdown(p_from date, p_to date)
 RETURNS TABLE(category_name text, revenue numeric, quantity_sold numeric)
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''
AS $function$
declare
  v_branch uuid := public.current_branch_id();
begin
  perform public.assert_owner_or_manager();
  if v_branch is null then raise exception 'No active branch for this session'; end if;

  return query
  select
    coalesce(c.name::text, 'Uncategorized'), round(sum(si.unit_price * si.quantity), 2), sum(si.quantity)::numeric
  from public.sale_items si
  join public.sales s on s.id = si.sale_id
  join public.barcodes bc on bc.id = si.barcode_id
  join public.stock_batches sb on sb.id = bc.stock_batch_id
  join public.product_variants pv on pv.id = sb.product_variant_id
  left join public.branch_product_categorization cat on cat.product_id = pv.product_id and cat.branch_id = v_branch
  left join public.product_categories c on c.id = cat.category_id
  where s.branch_id = v_branch and s.sold_at >= p_from::timestamptz and s.sold_at < (p_to + 1)::timestamptz
  group by c.name
  order by 2 desc;
end;
$function$
;

-- ============================================================
-- ai_insurance_summary(p_from date, p_to date)
-- ============================================================
CREATE OR REPLACE FUNCTION public.ai_insurance_summary(p_from date, p_to date)
 RETURNS TABLE(provider_name text, claim_count integer, total_claimed numeric, paid_out numeric, pending numeric)
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''
AS $function$
declare
  v_branch uuid := public.current_branch_id();
begin
  perform public.assert_owner_or_manager();
  if v_branch is null then raise exception 'No active branch for this session'; end if;

  return query
  select
    ip.name::text,
    count(*)::integer,
    round(sum(ic.claim_amount), 2),
    round(coalesce(sum(ic.claim_amount) filter (where ic.status = 'paid'), 0), 2),
    round(coalesce(sum(ic.claim_amount) filter (where ic.status in ('submitted','approved')), 0), 2)
  from public.insurance_claims ic
  join public.sales s on s.id = ic.sale_id
  join public.insurance_providers ip on ip.id = ic.insurance_provider_id
  where s.branch_id = v_branch and ic.submitted_at >= p_from::timestamptz and ic.submitted_at < (p_to + 1)::timestamptz
  group by ip.name
  order by 3 desc;
end;
$function$
;

-- ============================================================
-- ai_patient_summary(p_from date, p_to date)
-- ============================================================
CREATE OR REPLACE FUNCTION public.ai_patient_summary(p_from date, p_to date)
 RETURNS TABLE(total_patients_served integer, new_patients integer, repeat_patients integer, top_patient_name text, top_patient_spend numeric)
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''
AS $function$
declare
  v_branch uuid := public.current_branch_id();
begin
  perform public.assert_owner_or_manager();
  if v_branch is null then raise exception 'No active branch for this session'; end if;

  return query
  with visits as (
    select s.patient_id, count(*) as visit_count, sum(si.unit_price * si.quantity) as spend
    from public.sales s
    join public.sale_items si on si.sale_id = s.id
    where s.branch_id = v_branch and s.patient_id is not null
      and s.sold_at >= p_from::timestamptz and s.sold_at < (p_to + 1)::timestamptz
    group by s.patient_id
  ),
  top as (
    select pt.full_name::text as full_name, v.spend from visits v
    join public.patients pt on pt.id = v.patient_id
    order by v.spend desc limit 1
  )
  select
    (select count(*) from visits)::integer,
    (select count(*) from public.patients pt where pt.branch_id = v_branch and pt.created_at >= p_from::timestamptz and pt.created_at < (p_to + 1)::timestamptz)::integer,
    (select count(*) from visits where visit_count > 1)::integer,
    (select top.full_name from top),
    (select round(top.spend, 2) from top);
end;
$function$
;

-- ============================================================
-- ai_restock_recommendations(p_days_history integer, p_horizon_days integer, p_limit integer)
-- ============================================================
CREATE OR REPLACE FUNCTION public.ai_restock_recommendations(p_days_history integer DEFAULT 30, p_horizon_days integer DEFAULT 14, p_limit integer DEFAULT 10)
 RETURNS TABLE(product_id uuid, product_name text, dosage text, avg_daily_quantity numeric, quantity_available integer, days_to_stockout numeric)
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''
AS $function$
declare
  v_branch uuid := public.current_branch_id();
begin
  perform public.assert_owner_or_manager();
  if v_branch is null then raise exception 'No active branch for this session'; end if;
  if p_days_history < 7 or p_days_history > 365 then raise exception 'days_history must be between 7 and 365'; end if;
  if p_horizon_days < 1 or p_horizon_days > 90 then raise exception 'horizon_days must be between 1 and 90'; end if;
  if p_limit < 1 or p_limit > 50 then raise exception 'limit must be between 1 and 50'; end if;

  return query
  with recent_sales as (
    select
      pv.product_id as product_id,
      pv.id as variant_id,
      sum(si.quantity)::numeric / p_days_history as avg_daily_qty,
      sum(si.quantity) as total_qty,
      count(distinct date_trunc('day', s.sold_at)) as active_days
    from public.sale_items si
    join public.sales s on s.id = si.sale_id
    join public.barcodes bc on bc.id = si.barcode_id
    join public.stock_batches sb on sb.id = bc.stock_batch_id
    join public.product_variants pv on pv.id = sb.product_variant_id
    where s.branch_id = v_branch and s.sold_at >= now() - (p_days_history || ' days')::interval
    group by pv.product_id, pv.id
    having count(distinct date_trunc('day', s.sold_at)) >= 3
  ),
  stock as (
    select
      pv.id as variant_id, p.id as product_id, p.name as product_name, pv.dosage,
      coalesce(sum(bc.quantity_available * bc.pieces_per_pack) filter (where bc.barcode_type = 'pack'), 0)::integer as qty_available
    from public.stock_batches sb
    join public.product_variants pv on pv.id = sb.product_variant_id
    join public.products p on p.id = pv.product_id
    left join public.barcodes bc on bc.stock_batch_id = sb.id
    where sb.branch_id = v_branch
    group by pv.id, p.id, p.name, pv.dosage
  )
  select
    st.product_id, st.product_name::text, st.dosage::text,
    round(rs.avg_daily_qty, 2), st.qty_available, round(st.qty_available / rs.avg_daily_qty, 1)
  from recent_sales rs
  join stock st on st.variant_id = rs.variant_id
  where rs.avg_daily_qty > 0 and st.qty_available > 0
    and st.qty_available / rs.avg_daily_qty <= p_horizon_days
  order by rs.total_qty desc, (st.qty_available / rs.avg_daily_qty) asc
  limit p_limit;
end;
$function$
;

-- ============================================================
-- ai_sales_forecast(p_product_id uuid, p_category_id uuid, p_days_history integer, p_horizon_days integer)
-- ============================================================
CREATE OR REPLACE FUNCTION public.ai_sales_forecast(p_product_id uuid DEFAULT NULL::uuid, p_category_id uuid DEFAULT NULL::uuid, p_days_history integer DEFAULT 90, p_horizon_days integer DEFAULT 30)
 RETURNS TABLE(scope text, days_of_history integer, avg_daily_quantity numeric, trend_per_day numeric, projected_quantity_next_period numeric, projected_revenue_next_period numeric)
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''
AS $function$
declare
  v_branch uuid := public.current_branch_id();
  v_scope text;
begin
  perform public.assert_owner_or_manager();
  if v_branch is null then raise exception 'No active branch for this session'; end if;
  if p_product_id is not null and p_category_id is not null then
    raise exception 'Pass product_id or category_id, not both';
  end if;
  if p_days_history < 7 or p_days_history > 730 then raise exception 'days_history must be between 7 and 730'; end if;
  if p_horizon_days < 1 or p_horizon_days > 365 then raise exception 'horizon_days must be between 1 and 365'; end if;

  if p_product_id is not null then
    select p.name into v_scope from public.products p where p.id = p_product_id;
    if v_scope is null then raise exception 'Unknown product'; end if;
  elsif p_category_id is not null then
    select c.name into v_scope from public.product_categories c where c.id = p_category_id and c.branch_id = v_branch;
    if v_scope is null then raise exception 'Unknown category for this branch'; end if;
  else
    v_scope := 'All products';
  end if;

  return query
  with daily as (
    select
      date_trunc('day', s.sold_at)::date as sale_day,
      sum(si.quantity) as qty,
      sum(si.unit_price * si.quantity) as revenue
    from public.sale_items si
    join public.sales s on s.id = si.sale_id
    join public.barcodes bc on bc.id = si.barcode_id
    join public.stock_batches sb on sb.id = bc.stock_batch_id
    join public.product_variants pv on pv.id = sb.product_variant_id
    left join public.branch_product_categorization cat on cat.product_id = pv.product_id and cat.branch_id = v_branch
    where s.branch_id = v_branch
      and s.sold_at >= now() - (p_days_history || ' days')::interval
      and (p_product_id is null or pv.product_id = p_product_id)
      and (p_category_id is null or cat.category_id = p_category_id)
    group by 1
  ),
  numbered as (
    select
      (sale_day - (select min(sale_day) from daily))::numeric as x,
      qty::numeric as y,
      revenue
    from daily
  ),
  stats as (
    select
      coalesce(avg(y), 0) as avg_qty,
      -- regr_slope/regr_intercept always return double precision in Postgres,
      -- regardless of the input types (x/y are already cast to numeric above)
      -- -- cast back to numeric here so every round(x, n) below resolves to
      -- round(numeric, integer); round(double precision, integer) doesn't exist.
      coalesce(regr_slope(y, x), 0)::numeric as slope,
      coalesce(regr_intercept(y, x), avg(y), 0)::numeric as intercept,
      coalesce(sum(revenue) / nullif(sum(y), 0), 0) as avg_unit_revenue,
      coalesce(max(x), 0) as max_x
    from numbered
  )
  select
    v_scope,
    p_days_history,
    round(stats.avg_qty, 2),
    round(stats.slope, 4),
    round(sum_projected.total_qty, 2),
    round(sum_projected.total_qty * stats.avg_unit_revenue, 2)
  from stats
  cross join lateral (
    select coalesce(sum(greatest(0, stats.intercept + stats.slope * (stats.max_x + d))), 0) as total_qty
    from generate_series(1, p_horizon_days) as d
  ) sum_projected;
end;
$function$
;

-- ============================================================
-- ai_sales_forecast_accuracy(p_product_id uuid, p_category_id uuid, p_from date, p_to date)
-- ============================================================
CREATE OR REPLACE FUNCTION public.ai_sales_forecast_accuracy(p_product_id uuid DEFAULT NULL::uuid, p_category_id uuid DEFAULT NULL::uuid, p_from date DEFAULT NULL::date, p_to date DEFAULT NULL::date)
 RETURNS TABLE(period_start date, predicted_revenue numeric, predicted_quantity numeric, predicted_at timestamp with time zone)
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''
AS $function$
#variable_conflict use_column
declare
  v_branch uuid := public.current_branch_id();
begin
  perform public.assert_owner_or_manager();
  if v_branch is null then raise exception 'No active branch for this session'; end if;
  if p_product_id is not null and p_category_id is not null then
    raise exception 'Pass product_id or category_id, not both';
  end if;

  return query
  with expanded as (
    select
      s.generated_at,
      (pt->>'period_start')::date as period_start,
      (pt->>'predicted_revenue')::numeric as predicted_revenue,
      (pt->>'predicted_quantity')::numeric as predicted_quantity
    from public.sales_forecast_snapshots s
    cross join lateral jsonb_array_elements(s.points) as pt
    where s.branch_id = v_branch
      and ((p_product_id is null and s.product_id is null) or s.product_id = p_product_id)
      and ((p_category_id is null and s.category_id is null) or s.category_id = p_category_id)
      and (p_from is null or (pt->>'period_start')::date >= p_from)
      and (p_to is null or (pt->>'period_start')::date <= p_to)
  ),
  -- Only predictions made before the period they predicted actually started
  -- count as a real forecast of it; among those, the most recent one is the
  -- most-informed guess available at the time, so that's what gets compared
  -- against the real outcome.
  ranked as (
    select *, row_number() over (partition by period_start order by generated_at desc) as rn
    from expanded
    where generated_at::date < period_start
  )
  select period_start, predicted_revenue, predicted_quantity, generated_at as predicted_at
  from ranked
  where rn = 1
  order by period_start;
end;
$function$
;

-- ============================================================
-- ai_sales_forecast_series(p_product_id uuid, p_category_id uuid, p_days_history integer, p_horizon_days integer, p_bucket text)
-- ============================================================
CREATE OR REPLACE FUNCTION public.ai_sales_forecast_series(p_product_id uuid DEFAULT NULL::uuid, p_category_id uuid DEFAULT NULL::uuid, p_days_history integer DEFAULT 90, p_horizon_days integer DEFAULT 30, p_bucket text DEFAULT NULL::text)
 RETURNS TABLE(period_start date, is_forecast boolean, actual_revenue numeric, actual_quantity numeric, forecast_revenue numeric, forecast_quantity numeric, lower_bound numeric, upper_bound numeric)
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''
AS $function$
#variable_conflict use_column
declare
  v_branch uuid := public.current_branch_id();
  v_bucket text := p_bucket;
begin
  perform public.assert_owner_or_manager();
  if v_branch is null then raise exception 'No active branch for this session'; end if;
  if p_product_id is not null and p_category_id is not null then
    raise exception 'Pass product_id or category_id, not both';
  end if;
  if p_days_history < 7 or p_days_history > 730 then raise exception 'days_history must be between 7 and 730'; end if;
  if p_horizon_days < 1 or p_horizon_days > 365 then raise exception 'horizon_days must be between 1 and 365'; end if;

  -- Auto-pick a bucket size that keeps the chart readable regardless of how
  -- wide a window was requested, unless the caller pinned one explicitly.
  if v_bucket is null then
    v_bucket := case
      when p_days_history + p_horizon_days <= 45 then 'day'
      when p_days_history + p_horizon_days <= 180 then 'week'
      else 'month'
    end;
  end if;
  if v_bucket not in ('day','week','month') then raise exception 'bucket must be day, week or month'; end if;

  return query
  with daily as (
    select
      date_trunc('day', s.sold_at)::date as sale_day,
      sum(si.quantity) as qty,
      sum(si.unit_price * si.quantity) as revenue
    from public.sale_items si
    join public.sales s on s.id = si.sale_id
    join public.barcodes bc on bc.id = si.barcode_id
    join public.stock_batches sb on sb.id = bc.stock_batch_id
    join public.product_variants pv on pv.id = sb.product_variant_id
    left join public.branch_product_categorization cat on cat.product_id = pv.product_id and cat.branch_id = v_branch
    where s.branch_id = v_branch
      and s.sold_at >= now() - (p_days_history || ' days')::interval
      and (p_product_id is null or pv.product_id = p_product_id)
      and (p_category_id is null or cat.category_id = p_category_id)
    group by 1
  ),
  history_bounds as (
    select min(sale_day) as start_day, max(sale_day) as end_day from daily
  ),
  numbered as (
    select (d.sale_day - hb.start_day)::numeric as x, d.qty::numeric as y, d.revenue
    from daily d cross join history_bounds hb
  ),
  stats as (
    select
      coalesce(regr_slope(y, x), 0)::numeric as slope,
      coalesce(regr_intercept(y, x), avg(y), 0)::numeric as intercept,
      coalesce(sum(revenue) / nullif(sum(y), 0), 0) as avg_unit_revenue,
      coalesce(max(x), 0) as max_x
    from numbered
  ),
  model as (
    select stats.*, coalesce(stddev_pop(n.y - (stats.intercept + stats.slope * n.x)), 0) as resid_stddev
    from numbered n cross join stats
    group by stats.slope, stats.intercept, stats.avg_unit_revenue, stats.max_x
  ),
  actual_buckets as (
    select date_trunc(v_bucket, sale_day)::date as period_start, sum(qty)::numeric as quantity, sum(revenue)::numeric as revenue
    from daily
    group by 1
  ),
  last_actual as (select max(period_start) as period_start from actual_buckets),
  future_daily as (
    select
      (hb.end_day + gs.d) as future_day,
      greatest(0, m.intercept + m.slope * (m.max_x + gs.d)) as proj_qty
    from generate_series(1, p_horizon_days) as gs(d)
    cross join history_bounds hb
    cross join model m
  ),
  future_buckets as (
    select date_trunc(v_bucket, future_day)::date as period_start, sum(proj_qty)::numeric as quantity, count(*)::numeric as n_days
    from future_daily
    group by 1
  )
  select * from (
    -- Past/actual periods. The last actual period also carries a forecast
    -- value equal to its own actual value -- a "bridge" point so the dashed
    -- forecast line visually connects to the solid actual line with no gap,
    -- the same way the reference chart's Aug point does.
    select
      ab.period_start, false as is_forecast,
      round(ab.revenue, 2) as actual_revenue, round(ab.quantity, 2) as actual_quantity,
      case when ab.period_start = la.period_start then round(ab.revenue, 2) end as forecast_revenue,
      case when ab.period_start = la.period_start then round(ab.quantity, 2) end as forecast_quantity,
      null::numeric as lower_bound, null::numeric as upper_bound
    from actual_buckets ab cross join last_actual la
    union all
    -- Future/forecast periods, with an 80%-ish confidence band around each.
    select
      fb.period_start, true as is_forecast,
      null::numeric, null::numeric,
      round(fb.quantity * m.avg_unit_revenue, 2), round(fb.quantity, 2),
      round(greatest(0, fb.quantity - 1.28 * m.resid_stddev * sqrt(fb.n_days)) * m.avg_unit_revenue, 2),
      round((fb.quantity + 1.28 * m.resid_stddev * sqrt(fb.n_days)) * m.avg_unit_revenue, 2)
    from future_buckets fb cross join model m
  ) t
  order by period_start;
end;
$function$
;

-- ============================================================
-- ai_sales_trend(p_from date, p_to date, p_bucket text)
-- ============================================================
CREATE OR REPLACE FUNCTION public.ai_sales_trend(p_from date, p_to date, p_bucket text DEFAULT 'day'::text)
 RETURNS TABLE(period_start date, revenue numeric, tax numeric, insurance_covered numeric, patient_owed numeric, transaction_count integer)
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''
AS $function$
declare
  v_branch uuid := public.current_branch_id();
begin
  perform public.assert_owner_or_manager();
  if v_branch is null then raise exception 'No active branch for this session'; end if;
  if p_bucket not in ('day','week','month') then raise exception 'bucket must be day, week or month'; end if;

  return query
  select
    date_trunc(p_bucket, s.sold_at)::date,
    round(sum(si.unit_price * si.quantity), 2),
    round(sum((si.unit_price * si.quantity) - si.subtotal), 2),
    round(sum(si.insurance_covered_amount), 2),
    round(sum((si.unit_price * si.quantity) - si.insurance_covered_amount), 2),
    count(distinct s.id)::integer
  from public.sales s
  join public.sale_items si on si.sale_id = s.id
  where s.branch_id = v_branch and s.sold_at >= p_from::timestamptz and s.sold_at < (p_to + 1)::timestamptz
  group by 1
  order by 1;
end;
$function$
;

-- ============================================================
-- ai_seller_performance(p_from date, p_to date)
-- ============================================================
CREATE OR REPLACE FUNCTION public.ai_seller_performance(p_from date, p_to date)
 RETURNS TABLE(seller_name text, seller_role text, transaction_count integer, revenue numeric)
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''
AS $function$
declare
  v_branch uuid := public.current_branch_id();
begin
  perform public.assert_owner_or_manager();
  if v_branch is null then raise exception 'No active branch for this session'; end if;

  return query
  select u.full_name::text, u.role::text, count(distinct s.id)::integer, round(sum(si.unit_price * si.quantity), 2)
  from public.sale_items si
  join public.sales s on s.id = si.sale_id
  join public.users u on u.id = s.cashier_id
  where s.branch_id = v_branch and s.sold_at >= p_from::timestamptz and s.sold_at < (p_to + 1)::timestamptz
  group by u.id, u.full_name, u.role
  order by 4 desc;
end;
$function$
;

-- ============================================================
-- ai_stock_status(p_filter text)
-- ============================================================
CREATE OR REPLACE FUNCTION public.ai_stock_status(p_filter text DEFAULT 'all'::text)
 RETURNS TABLE(product_name text, dosage text, quantity_available integer, min_quantity integer, expiry_date date, days_to_expiry integer, status text)
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''
AS $function$
declare
  v_branch uuid := public.current_branch_id();
  v_expiry_threshold integer;
  v_default_reorder_min integer;
begin
  perform public.assert_owner_or_manager();
  if v_branch is null then raise exception 'No active branch for this session'; end if;
  if p_filter not in ('low','out','expiring','expired','all') then raise exception 'filter must be low, out, expiring, expired or all'; end if;

  select b.expiry_alert_threshold_days, b.default_reorder_min
    into v_expiry_threshold, v_default_reorder_min
    from public.branches b where b.id = v_branch;

  return query
  with stock as (
    select
      p.name::text as product_name, pv.dosage::text as dosage,
      coalesce(sum(bc.quantity_available * bc.pieces_per_pack) filter (where bc.barcode_type = 'pack'), 0)::integer as qty_available,
      coalesce(rp.min_quantity, v_default_reorder_min) as min_quantity,
      min(sb.expiry_date) filter (where bc.status = 'active') as nearest_expiry
    from public.stock_batches sb
    join public.product_variants pv on pv.id = sb.product_variant_id
    join public.products p on p.id = pv.product_id
    left join public.barcodes bc on bc.stock_batch_id = sb.id
    left join public.reorder_points rp on rp.product_id = pv.product_id and rp.branch_id = v_branch
    where sb.branch_id = v_branch
    group by p.name, pv.id, pv.dosage, rp.min_quantity
  )
  select
    stock.product_name, stock.dosage, stock.qty_available, stock.min_quantity, stock.nearest_expiry,
    (stock.nearest_expiry - current_date)::integer,
    case
      when stock.qty_available = 0 then 'out'
      when stock.nearest_expiry is not null and stock.nearest_expiry < current_date then 'expired'
      when stock.nearest_expiry is not null and stock.nearest_expiry <= current_date + v_expiry_threshold then 'expiring'
      when stock.qty_available < stock.min_quantity then 'low'
      else 'ok'
    end
  from stock
  where p_filter = 'all'
    or (p_filter = 'out' and stock.qty_available = 0)
    or (p_filter = 'low' and stock.qty_available > 0 and stock.qty_available < stock.min_quantity)
    or (p_filter = 'expiring' and stock.nearest_expiry is not null and stock.nearest_expiry between current_date and current_date + v_expiry_threshold)
    or (p_filter = 'expired' and stock.nearest_expiry is not null and stock.nearest_expiry < current_date)
  order by stock.qty_available asc
  limit 200;
end;
$function$
;

-- ============================================================
-- ai_top_products(p_from date, p_to date, p_metric text, p_direction text, p_limit integer)
-- ============================================================
CREATE OR REPLACE FUNCTION public.ai_top_products(p_from date, p_to date, p_metric text DEFAULT 'revenue'::text, p_direction text DEFAULT 'desc'::text, p_limit integer DEFAULT 10)
 RETURNS TABLE(product_id uuid, product_name text, dosage text, quantity_sold numeric, revenue numeric)
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''
AS $function$
declare
  v_branch uuid := public.current_branch_id();
begin
  perform public.assert_owner_or_manager();
  if v_branch is null then raise exception 'No active branch for this session'; end if;
  if p_metric not in ('revenue','quantity') then raise exception 'metric must be revenue or quantity'; end if;
  if p_direction not in ('asc','desc') then raise exception 'direction must be asc or desc'; end if;
  if p_limit < 1 or p_limit > 50 then raise exception 'limit must be between 1 and 50'; end if;

  return query
  select
    p.id, p.name::text, pv.dosage::text, sum(si.quantity)::numeric, round(sum(si.unit_price * si.quantity), 2)
  from public.sale_items si
  join public.sales s on s.id = si.sale_id
  join public.barcodes bc on bc.id = si.barcode_id
  join public.stock_batches sb on sb.id = bc.stock_batch_id
  join public.product_variants pv on pv.id = sb.product_variant_id
  join public.products p on p.id = pv.product_id
  where s.branch_id = v_branch and s.sold_at >= p_from::timestamptz and s.sold_at < (p_to + 1)::timestamptz
  group by p.id, p.name, pv.id, pv.dosage
  order by (case when p_metric = 'revenue' then sum(si.unit_price * si.quantity) else sum(si.quantity) end) * (case when p_direction = 'asc' then 1 else -1 end)
  limit p_limit;
end;
$function$
;

-- ============================================================
-- analytics_basket_size(p_from date, p_to date, p_bucket text)
-- ============================================================
CREATE OR REPLACE FUNCTION public.analytics_basket_size(p_from date, p_to date, p_bucket text DEFAULT 'day'::text)
 RETURNS TABLE(period_start date, avg_items_per_sale numeric, avg_revenue_per_sale numeric, transaction_count integer)
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''
AS $function$
declare
  v_branch uuid := public.current_branch_id();
begin
  perform public.assert_owner_or_manager();
  if v_branch is null then raise exception 'No active branch for this session'; end if;
  if p_bucket not in ('day','week','month') then raise exception 'bucket must be day, week or month'; end if;

  return query
  with per_sale as (
    select s.id, date_trunc(p_bucket, s.sold_at)::date as period, sum(si.quantity) as items, sum(si.unit_price * si.quantity) as revenue
    from public.sales s
    join public.sale_items si on si.sale_id = s.id
    where s.branch_id = v_branch and s.sold_at >= p_from::timestamptz and s.sold_at < (p_to + 1)::timestamptz
    group by s.id, period
  )
  select period, round(avg(items), 2), round(avg(revenue), 2), count(*)::integer
  from per_sale
  group by period
  order by period;
end;
$function$
;

-- ============================================================
-- analytics_dead_stock(p_days integer, p_limit integer)
-- ============================================================
CREATE OR REPLACE FUNCTION public.analytics_dead_stock(p_days integer DEFAULT 60, p_limit integer DEFAULT 50)
 RETURNS TABLE(product_name text, dosage text, quantity_on_hand integer, stock_value numeric, days_since_last_sale integer)
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''
AS $function$
declare
  v_branch uuid := public.current_branch_id();
begin
  perform public.assert_owner_or_manager();
  if v_branch is null then raise exception 'No active branch for this session'; end if;
  if p_days < 1 or p_days > 730 then raise exception 'days must be between 1 and 730'; end if;

  return query
  with onhand as (
    select
      pv.id as variant_id, p.name as product_name, pv.dosage as dosage,
      sum(bc.quantity_available * bc.pieces_per_pack) filter (where bc.barcode_type = 'pack') as qty,
      sum(bc.quantity_available * bc.pieces_per_pack * coalesce(sb.cost_price, 0)) filter (where bc.barcode_type = 'pack') as value
    from public.stock_batches sb
    join public.product_variants pv on pv.id = sb.product_variant_id
    join public.products p on p.id = pv.product_id
    left join public.barcodes bc on bc.stock_batch_id = sb.id
    where sb.branch_id = v_branch
    group by pv.id, p.name, pv.dosage
  ),
  last_sale as (
    select pv.id as variant_id, max(s.sold_at) as last_sold_at
    from public.sale_items si
    join public.sales s on s.id = si.sale_id
    join public.barcodes bc on bc.id = si.barcode_id
    join public.stock_batches sb on sb.id = bc.stock_batch_id
    join public.product_variants pv on pv.id = sb.product_variant_id
    where s.branch_id = v_branch
    group by pv.id
  )
  select
    onhand.product_name::text, onhand.dosage::text,
    coalesce(onhand.qty, 0)::integer, round(coalesce(onhand.value, 0), 2),
    case when last_sale.last_sold_at is null then null else (current_date - last_sale.last_sold_at::date)::integer end
  from onhand
  left join last_sale on last_sale.variant_id = onhand.variant_id
  where coalesce(onhand.qty, 0) > 0
    and (last_sale.last_sold_at is null or last_sale.last_sold_at < now() - (p_days || ' days')::interval)
  order by round(coalesce(onhand.value, 0), 2) desc
  limit p_limit;
end;
$function$
;

-- ============================================================
-- analytics_discount_usage(p_from date, p_to date)
-- ============================================================
CREATE OR REPLACE FUNCTION public.analytics_discount_usage(p_from date, p_to date)
 RETURNS TABLE(discount_name text, discount_type text, usage_count integer, revenue_with_discount numeric, estimated_discount_value numeric)
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''
AS $function$
declare
  v_branch uuid := public.current_branch_id();
begin
  perform public.assert_owner_or_manager();
  if v_branch is null then raise exception 'No active branch for this session'; end if;

  return query
  with per_sale as (
    select s.id as sale_id, s.discount_id, sum(si.unit_price * si.quantity) as sale_revenue
    from public.sales s
    join public.sale_items si on si.sale_id = s.id
    where s.branch_id = v_branch and s.discount_id is not null
      and s.sold_at >= p_from::timestamptz and s.sold_at < (p_to + 1)::timestamptz
    group by s.id, s.discount_id
  )
  select
    d.name::text, d.discount_type::text, count(*)::integer, round(sum(ps.sale_revenue), 2),
    round(sum(case when d.discount_type = 'percentage' then ps.sale_revenue * (d.value / 100.0) else least(d.value, ps.sale_revenue) end), 2)
  from per_sale ps
  join public.discounts d on d.id = ps.discount_id
  group by d.id, d.name, d.discount_type
  order by 4 desc;
end;
$function$
;

-- ============================================================
-- analytics_insurance_claim_aging()
-- ============================================================
CREATE OR REPLACE FUNCTION public.analytics_insurance_claim_aging()
 RETURNS TABLE(age_bucket text, claim_count integer, total_amount numeric)
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''
AS $function$
declare
  v_branch uuid := public.current_branch_id();
begin
  perform public.assert_owner_or_manager();
  if v_branch is null then raise exception 'No active branch for this session'; end if;

  return query
  select
    case
      when (current_date - ic.submitted_at::date) <= 7 then '0-7 days'
      when (current_date - ic.submitted_at::date) <= 14 then '8-14 days'
      when (current_date - ic.submitted_at::date) <= 30 then '15-30 days'
      else '31+ days'
    end,
    count(*)::integer,
    round(sum(ic.claim_amount), 2)
  from public.insurance_claims ic
  join public.sales s on s.id = ic.sale_id
  where s.branch_id = v_branch and ic.status in ('submitted','approved')
  group by 1
  order by min(case
    when (current_date - ic.submitted_at::date) <= 7 then 0
    when (current_date - ic.submitted_at::date) <= 14 then 1
    when (current_date - ic.submitted_at::date) <= 30 then 2
    else 3
  end);
end;
$function$
;

-- ============================================================
-- analytics_insurance_provider_comparison(p_from date, p_to date)
-- ============================================================
CREATE OR REPLACE FUNCTION public.analytics_insurance_provider_comparison(p_from date, p_to date)
 RETURNS TABLE(provider_name text, claim_count integer, approved_count integer, approval_rate numeric, avg_claim_amount numeric, avg_coverage_percentage numeric)
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''
AS $function$
declare
  v_branch uuid := public.current_branch_id();
begin
  perform public.assert_owner_or_manager();
  if v_branch is null then raise exception 'No active branch for this session'; end if;

  return query
  select
    ip.name::text,
    count(*)::integer,
    count(*) filter (where ic.status in ('approved','paid'))::integer,
    round(100.0 * count(*) filter (where ic.status in ('approved','paid')) / nullif(count(*), 0), 1),
    round(avg(ic.claim_amount), 2),
    round(avg(ic.coverage_percentage_applied), 1)
  from public.insurance_claims ic
  join public.sales s on s.id = ic.sale_id
  join public.insurance_providers ip on ip.id = ic.insurance_provider_id
  where s.branch_id = v_branch and ic.submitted_at >= p_from::timestamptz and ic.submitted_at < (p_to + 1)::timestamptz
  group by ip.name
  order by 2 desc;
end;
$function$
;

-- ============================================================
-- analytics_inventory_turnover(p_from date, p_to date)
-- ============================================================
CREATE OR REPLACE FUNCTION public.analytics_inventory_turnover(p_from date, p_to date)
 RETURNS TABLE(category_name text, cogs numeric, current_inventory_value numeric, turnover_ratio numeric)
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''
AS $function$
declare
  v_branch uuid := public.current_branch_id();
begin
  perform public.assert_owner_or_manager();
  if v_branch is null then raise exception 'No active branch for this session'; end if;

  return query
  with cogs_by_cat as (
    select
      coalesce(c.name, 'Uncategorized') as category_name,
      sum(si.quantity * coalesce(sb.cost_price, 0)) as cogs
    from public.sale_items si
    join public.sales s on s.id = si.sale_id
    join public.barcodes bc on bc.id = si.barcode_id
    join public.stock_batches sb on sb.id = bc.stock_batch_id
    join public.product_variants pv on pv.id = sb.product_variant_id
    left join public.branch_product_categorization cat on cat.product_id = pv.product_id and cat.branch_id = v_branch
    left join public.product_categories c on c.id = cat.category_id
    where s.branch_id = v_branch and s.sold_at >= p_from::timestamptz and s.sold_at < (p_to + 1)::timestamptz
    group by c.name
  ),
  value_by_cat as (
    select
      coalesce(c.name, 'Uncategorized') as category_name,
      sum(bc.quantity_available * bc.pieces_per_pack * coalesce(sb.cost_price, 0)) filter (where bc.barcode_type = 'pack') as value
    from public.stock_batches sb
    join public.product_variants pv on pv.id = sb.product_variant_id
    left join public.branch_product_categorization cat on cat.product_id = pv.product_id and cat.branch_id = v_branch
    left join public.product_categories c on c.id = cat.category_id
    left join public.barcodes bc on bc.stock_batch_id = sb.id
    where sb.branch_id = v_branch
    group by c.name
  )
  select
    coalesce(cogs_by_cat.category_name, value_by_cat.category_name)::text,
    round(coalesce(cogs_by_cat.cogs, 0), 2),
    round(coalesce(value_by_cat.value, 0), 2),
    round(coalesce(cogs_by_cat.cogs, 0) / nullif(coalesce(value_by_cat.value, 0), 0), 2)
  from cogs_by_cat
  full outer join value_by_cat on value_by_cat.category_name = cogs_by_cat.category_name
  order by 2 desc nulls last;
end;
$function$
;

-- ============================================================
-- analytics_patient_retention(p_lookback_days integer, p_inactive_days integer, p_limit integer)
-- ============================================================
CREATE OR REPLACE FUNCTION public.analytics_patient_retention(p_lookback_days integer DEFAULT 180, p_inactive_days integer DEFAULT 60, p_limit integer DEFAULT 20)
 RETURNS TABLE(patient_name text, last_visit date, days_since_last_visit integer, past_visit_count integer, lifetime_spend numeric)
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''
AS $function$
declare
  v_branch uuid := public.current_branch_id();
begin
  perform public.assert_owner_or_manager();
  if v_branch is null then raise exception 'No active branch for this session'; end if;
  if p_lookback_days < 1 or p_lookback_days > 1825 then raise exception 'lookback_days must be between 1 and 1825'; end if;
  if p_inactive_days < 1 or p_inactive_days > 730 then raise exception 'inactive_days must be between 1 and 730'; end if;

  return query
  with visits as (
    select s.id as sale_id, s.patient_id, s.sold_at, si.unit_price * si.quantity as line_revenue
    from public.sales s
    join public.sale_items si on si.sale_id = s.id
    where s.branch_id = v_branch and s.patient_id is not null
      and s.sold_at >= now() - (p_lookback_days || ' days')::interval
  ),
  per_patient as (
    select patient_id, max(sold_at) as last_visit, count(distinct sale_id) as visit_count, sum(line_revenue) as spend
    from visits
    group by patient_id
  )
  select
    pt.full_name::text,
    per_patient.last_visit::date,
    (current_date - per_patient.last_visit::date)::integer,
    per_patient.visit_count::integer,
    round(per_patient.spend, 2)
  from per_patient
  join public.patients pt on pt.id = per_patient.patient_id
  where per_patient.last_visit < now() - (p_inactive_days || ' days')::interval
  order by per_patient.spend desc
  limit p_limit;
end;
$function$
;

-- ============================================================
-- analytics_recall_log(p_limit integer)
-- ============================================================
CREATE OR REPLACE FUNCTION public.analytics_recall_log(p_limit integer DEFAULT 50)
 RETURNS TABLE(product_name text, dosage text, batch_number text, manufacturer_name text, reason text, recalled_by_name text, recalled_at timestamp with time zone)
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''
AS $function$
begin
  perform public.assert_owner_or_manager();
  if p_limit < 1 or p_limit > 200 then raise exception 'limit must be between 1 and 200'; end if;

  return query
  select
    p.name::text, pv.dosage::text, br.batch_number::text, br.manufacturer_name::text, br.reason,
    u.full_name::text, br.recalled_at
  from public.batch_recalls br
  join public.product_variants pv on pv.id = br.product_variant_id
  join public.products p on p.id = pv.product_id
  left join public.users u on u.id = br.recalled_by
  order by br.recalled_at desc
  limit p_limit;
end;
$function$
;

-- ============================================================
-- analytics_sales_heatmap(p_from date, p_to date)
-- ============================================================
CREATE OR REPLACE FUNCTION public.analytics_sales_heatmap(p_from date, p_to date)
 RETURNS TABLE(day_of_week integer, hour_of_day integer, revenue numeric, transaction_count integer)
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''
AS $function$
declare
  v_branch uuid := public.current_branch_id();
begin
  perform public.assert_owner_or_manager();
  if v_branch is null then raise exception 'No active branch for this session'; end if;

  return query
  with per_sale as (
    select s.id, s.sold_at, sum(si.unit_price * si.quantity) as sale_revenue
    from public.sales s
    join public.sale_items si on si.sale_id = s.id
    where s.branch_id = v_branch and s.sold_at >= p_from::timestamptz and s.sold_at < (p_to + 1)::timestamptz
    group by s.id, s.sold_at
  )
  select
    extract(dow from sold_at)::integer, extract(hour from sold_at)::integer,
    round(sum(sale_revenue), 2), count(*)::integer
  from per_sale
  group by 1, 2
  order by 1, 2;
end;
$function$
;

-- ============================================================
-- analytics_seller_productivity(p_from date, p_to date)
-- ============================================================
CREATE OR REPLACE FUNCTION public.analytics_seller_productivity(p_from date, p_to date)
 RETURNS TABLE(seller_name text, seller_role text, transaction_count integer, revenue numeric, active_hours numeric, revenue_per_hour numeric, transactions_per_hour numeric)
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''
AS $function$
declare
  v_branch uuid := public.current_branch_id();
begin
  perform public.assert_owner_or_manager();
  if v_branch is null then raise exception 'No active branch for this session'; end if;

  return query
  with daily as (
    select s.cashier_id, date_trunc('day', s.sold_at) as sale_day,
      extract(epoch from (max(s.sold_at) - min(s.sold_at))) / 3600.0 as hours,
      count(*) as txns
    from public.sales s
    where s.branch_id = v_branch and s.sold_at >= p_from::timestamptz and s.sold_at < (p_to + 1)::timestamptz
    group by s.cashier_id, date_trunc('day', s.sold_at)
  ),
  per_seller as (
    select cashier_id, sum(hours) as active_hours, sum(txns) as txn_count
    from daily
    group by cashier_id
  ),
  seller_revenue as (
    select s.cashier_id, sum(si.unit_price * si.quantity) as rev
    from public.sales s
    join public.sale_items si on si.sale_id = s.id
    where s.branch_id = v_branch and s.sold_at >= p_from::timestamptz and s.sold_at < (p_to + 1)::timestamptz
    group by s.cashier_id
  )
  select
    u.full_name::text, u.role::text, ps.txn_count::integer, round(coalesce(r.rev, 0), 2),
    round(ps.active_hours, 2),
    round(coalesce(r.rev, 0) / nullif(ps.active_hours, 0), 2),
    round(ps.txn_count / nullif(ps.active_hours, 0), 2)
  from per_seller ps
  join public.users u on u.id = ps.cashier_id
  left join seller_revenue r on r.cashier_id = ps.cashier_id
  order by ps.txn_count desc;
end;
$function$
;

-- ============================================================
-- analytics_stock_adjustments(p_from date, p_to date)
-- ============================================================
CREATE OR REPLACE FUNCTION public.analytics_stock_adjustments(p_from date, p_to date)
 RETURNS TABLE(adjustment_type text, staff_name text, quantity numeric, adjustment_count integer, estimated_value numeric)
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''
AS $function$
declare
  v_branch uuid := public.current_branch_id();
begin
  perform public.assert_owner_or_manager();
  if v_branch is null then raise exception 'No active branch for this session'; end if;

  return query
  select
    sa.adjustment_type::text,
    coalesce(u.full_name::text, 'System'),
    sum(sa.quantity)::numeric,
    count(*)::integer,
    round(sum(sa.quantity * coalesce(sb.cost_price, 0)), 2)
  from public.stock_adjustments sa
  join public.stock_batches sb on sb.id = sa.stock_batch_id
  left join public.users u on u.id = sa.performed_by
  where sb.branch_id = v_branch and sa.adjusted_at >= p_from::timestamptz and sa.adjusted_at < (p_to + 1)::timestamptz
  group by sa.adjustment_type, u.full_name
  order by 5 desc;
end;
$function$
;

-- ============================================================
-- analytics_supplier_performance(p_from date, p_to date)
-- ============================================================
CREATE OR REPLACE FUNCTION public.analytics_supplier_performance(p_from date, p_to date)
 RETURNS TABLE(supplier_name text, delivery_count integer, units_received numeric, total_cost numeric, avg_unit_cost numeric)
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''
AS $function$
declare
  v_branch uuid := public.current_branch_id();
begin
  perform public.assert_owner_or_manager();
  if v_branch is null then raise exception 'No active branch for this session'; end if;

  return query
  select
    coalesce(sup.supplier_name, 'Unknown supplier')::text,
    count(*)::integer,
    sum(sb.quantity_received)::numeric,
    round(sum(sb.quantity_received * coalesce(sb.cost_price, 0)), 2),
    round(sum(sb.quantity_received * coalesce(sb.cost_price, 0)) / nullif(sum(sb.quantity_received), 0), 2)
  from public.stock_batches sb
  left join public.suppliers sup on sup.id = sb.supplier_id
  where sb.branch_id = v_branch and sb.received_at >= p_from::timestamptz and sb.received_at < (p_to + 1)::timestamptz
  group by sup.supplier_name
  order by 4 desc;
end;
$function$
;

-- ============================================================
-- analytics_vat_by_month(p_months integer)
-- ============================================================
CREATE OR REPLACE FUNCTION public.analytics_vat_by_month(p_months integer DEFAULT 8)
 RETURNS TABLE(month_label text, month_start date, revenue numeric, vat_total numeric)
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''
AS $function$
#variable_conflict use_column
declare
  v_branch uuid := public.current_branch_id();
begin
  perform public.assert_owner_or_manager();
  if v_branch is null then raise exception 'No active branch for this session'; end if;
  if p_months < 1 or p_months > 24 then raise exception 'months must be between 1 and 24'; end if;

  return query
  with months as (
    select date_trunc('month', current_date - (n || ' months')::interval)::date as month_start
    from generate_series(0, p_months - 1) as n
  ),
  line_tax as (
    select s.id as sale_id, date_trunc('month', s.sold_at)::date as month_start,
           si.subtotal, round(si.subtotal * t.rate_percentage / 100, 2) as tax_amount
    from public.sales s
    join public.sale_items si on si.sale_id = s.id
    join public.tax_rates t on t.id = si.tax_rate_id
    where s.branch_id = v_branch
      and s.sold_at >= (select min(month_start) from months)
  )
  select
    to_char(m.month_start, 'Mon')::text,
    m.month_start,
    coalesce(round(sum(lt.subtotal + lt.tax_amount), 2), 0),
    coalesce(round(sum(lt.tax_amount), 2), 0)
  from months m
  left join line_tax lt on lt.month_start = m.month_start
  group by m.month_start
  order by m.month_start;
end;
$function$
;

-- ============================================================
-- assert_owner_or_manager()
-- ============================================================
CREATE OR REPLACE FUNCTION public.assert_owner_or_manager()
 RETURNS void
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''
AS $function$
begin
  if not exists (
    select 1 from public.users u
    where u.id = (select auth.uid()) and u.is_active and u.role in ('owner','manager')
  ) then
    raise exception 'Only the branch owner or manager may use the AI analyst';
  end if;
end;
$function$
;

-- ============================================================
-- assert_super_admin()
-- ============================================================
CREATE OR REPLACE FUNCTION public.assert_super_admin()
 RETURNS void
 LANGUAGE plpgsql
 STABLE SECURITY DEFINER
 SET search_path TO ''
AS $function$
  begin
    if not public.is_super_admin() then
      raise exception 'Super admin access is required';
    end if;
  end;
  $function$
;

-- ============================================================
-- can_request_pharmacy_otp(p_email text)
-- ============================================================
CREATE OR REPLACE FUNCTION public.can_request_pharmacy_otp(p_email text)
 RETURNS boolean
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''
AS $function$
declare
  v_app_id uuid;
begin
  select a.id into v_app_id
  from public.branch_applications a
  where lower(a.email) = lower(btrim(p_email)) and a.status = 'otp_sent';

  if v_app_id is not null then
    perform public.freeze_expired_pharmacy_otp(v_app_id);
  end if;

  return exists (
    select 1
    from public.branch_applications a
    left join public.branches b on b.id = a.branch_id
    where lower(a.email) = lower(btrim(p_email))
      and a.status = 'otp_sent'
      and coalesce(b.status, 'otp_sent') <> 'locked'
  ) or exists (
    select 1
    from public.users u
    join public.branches b on b.id = u.branch_id
    where lower(u.email) = lower(btrim(p_email))
      and u.is_active
      and b.status = 'active'
  );
end;
$function$
;

-- ============================================================
-- check_expired_stock()
-- ============================================================
CREATE OR REPLACE FUNCTION public.check_expired_stock()
 RETURNS integer
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''
AS $function$
declare
  v_branch uuid := public.current_branch_id();
  v_user uuid := (select auth.uid());
  v_flagged integer := 0;
  rec record;
  v_adjustment uuid;
begin
  if v_branch is null then
    return 0;
  end if;

  for rec in
    select bc.id as barcode_id, bc.code, bc.quantity_available, bc.pieces_per_pack,
           sb.id as stock_batch_id, sb.expiry_date, p.name as product_name, pv.dosage
    from public.barcodes bc
    join public.stock_batches sb on sb.id = bc.stock_batch_id
    join public.product_variants pv on pv.id = sb.product_variant_id
    join public.products p on p.id = pv.product_id
    where sb.branch_id = v_branch
      and bc.status = 'active'
      and sb.expiry_date < current_date
    for update of bc
  loop
    update public.barcodes set status = 'expired' where id = rec.barcode_id;

    insert into public.stock_adjustments (stock_batch_id, barcode_id, adjustment_type, quantity, reason, performed_by)
    values (
      rec.stock_batch_id, rec.barcode_id, 'expired_writeoff',
      greatest(coalesce(rec.quantity_available, 0) * coalesce(rec.pieces_per_pack, 1), 1),
      format('Automatically written off -- batch expired on %s', rec.expiry_date),
      v_user
    )
    returning id into v_adjustment;

    insert into public.notifications (branch_id, source_type, source_id, message)
    values (
      v_branch, 'stock_adjustment', v_adjustment,
      format('Expired Writeoff: %s (%s) expired on %s and was automatically written off.',
        concat_ws(' ', rec.product_name, rec.dosage), rec.code, rec.expiry_date)
    );

    v_flagged := v_flagged + 1;
  end loop;

  return v_flagged;
end;
$function$
;

-- ============================================================
-- check_expiring_soon_stock()
-- ============================================================
CREATE OR REPLACE FUNCTION public.check_expiring_soon_stock()
 RETURNS integer
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''
AS $function$
declare
  v_branch uuid := public.current_branch_id();
  v_threshold integer;
  v_flagged integer := 0;
  rec record;
begin
  if v_branch is null then
    return 0;
  end if;

  select coalesce(expiry_alert_threshold_days, 60) into v_threshold
    from public.branches where id = v_branch;

  for rec in
    select sb.id as stock_batch_id, sb.expiry_date, p.name as product_name, pv.dosage
    from public.stock_batches sb
    join public.product_variants pv on pv.id = sb.product_variant_id
    join public.products p on p.id = pv.product_id
    where sb.branch_id = v_branch
      and sb.expiry_warned_at is null
      and sb.expiry_date >= current_date
      and sb.expiry_date <= current_date + v_threshold
      and exists (
        select 1 from public.barcodes bc
        where bc.stock_batch_id = sb.id and bc.status = 'active' and bc.quantity_available > 0
      )
  loop
    update public.stock_batches set expiry_warned_at = now() where id = rec.stock_batch_id;

    insert into public.notifications (branch_id, source_type, source_id, message)
    values (
      v_branch, 'expiring_soon', rec.stock_batch_id,
      format('%s expires on %s -- consider prioritizing it for sale or requesting a return.',
        concat_ws(' ', rec.product_name, rec.dosage), rec.expiry_date)
    );

    v_flagged := v_flagged + 1;
  end loop;

  return v_flagged;
end;
$function$
;

-- ============================================================
-- check_forecast_accuracy_notifications()
-- ============================================================
CREATE OR REPLACE FUNCTION public.check_forecast_accuracy_notifications()
 RETURNS integer
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''
AS $function$
#variable_conflict use_column
declare
  v_branch uuid := public.current_branch_id();
  v_count integer := 0;
  v_snap record;
  v_scope text;
  v_actual numeric;
  v_pct text;
begin
  if v_branch is null then return 0; end if;

  -- One pass per not-yet-notified snapshot whose entire predicted horizon
  -- has fully elapsed (period_to <= today) -- period_to is the end of the
  -- LAST bucket it predicted, computed from its own bucket size so a
  -- monthly point starting Sept 1 isn't considered "finished" until Oct 1.
  for v_snap in
    select
      s.id, s.product_id, s.category_id, s.generated_at, s.bucket,
      (select min((pt->>'period_start')::date) from jsonb_array_elements(s.points) pt) as period_from,
      (select max(
         case s.bucket
           when 'day' then (pt->>'period_start')::date + 1
           when 'week' then (pt->>'period_start')::date + 7
           else ((pt->>'period_start')::date + interval '1 month')::date
         end
       ) from jsonb_array_elements(s.points) pt) as period_to,
      (select coalesce(sum((pt->>'predicted_revenue')::numeric), 0) from jsonb_array_elements(s.points) pt) as predicted_total
    from public.sales_forecast_snapshots s
    where s.branch_id = v_branch and s.notified_at is null
  loop
    if v_snap.period_to is null or v_snap.period_to > current_date then
      continue; -- horizon hasn't fully elapsed yet -- leave it for a later poll
    end if;

    v_scope := case
      when v_snap.product_id is not null then (select p.name from public.products p where p.id = v_snap.product_id)
      when v_snap.category_id is not null then (select c.name from public.product_categories c where c.id = v_snap.category_id and c.branch_id = v_branch)
      else 'All products'
    end;
    v_scope := coalesce(v_scope, 'All products');

    select coalesce(sum(si.unit_price * si.quantity), 0)
      into v_actual
      from public.sale_items si
      join public.sales s2 on s2.id = si.sale_id
      join public.barcodes bc on bc.id = si.barcode_id
      join public.stock_batches sb on sb.id = bc.stock_batch_id
      join public.product_variants pv on pv.id = sb.product_variant_id
      left join public.branch_product_categorization cat on cat.product_id = pv.product_id and cat.branch_id = v_branch
      where s2.branch_id = v_branch
        and s2.sold_at >= v_snap.period_from::timestamptz
        and s2.sold_at < v_snap.period_to::timestamptz
        and (v_snap.product_id is null or pv.product_id = v_snap.product_id)
        and (v_snap.category_id is null or cat.category_id = v_snap.category_id);

    v_pct := case when v_snap.predicted_total > 0
      then round(100 * v_actual / v_snap.predicted_total)::text || '%'
      else 'n/a'
    end;

    insert into public.notifications (branch_id, source_type, source_id, message)
    values (
      v_branch, 'forecast_completed', v_snap.id,
      format(
        'Forecast for %s (made %s) has completed: predicted RWF %s, actual RWF %s (%s of predicted).',
        v_scope, to_char(v_snap.generated_at, 'YYYY-MM-DD'),
        to_char(v_snap.predicted_total, 'FM999,999,999'), to_char(v_actual, 'FM999,999,999'), v_pct
      )
    );

    update public.sales_forecast_snapshots set notified_at = now() where id = v_snap.id;
    v_count := v_count + 1;
  end loop;

  return v_count;
end;
$function$
;

-- ============================================================
-- check_license_expiry()
-- ============================================================
CREATE OR REPLACE FUNCTION public.check_license_expiry()
 RETURNS integer
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''
AS $function$
declare
  v_branch uuid := public.current_branch_id();
  v_expiry date;
  v_days_left integer;
  v_last record;
begin
  if v_branch is null then
    return 0;
  end if;

  select license_expiry_date into v_expiry from public.branches where id = v_branch;
  if v_expiry is null then
    return 0;
  end if;

  v_days_left := v_expiry - current_date;
  if v_days_left > 90 then
    return 0;
  end if;

  select id, is_read, created_at into v_last
    from public.notifications
    where branch_id = v_branch and source_type = 'license_expiring'
    order by created_at desc
    limit 1;

  if not found or (v_last.is_read and v_last.created_at < now() - interval '1 day') then
    insert into public.notifications (branch_id, source_type, source_id, message)
    values (
      v_branch, 'license_expiring', v_branch,
      case when v_days_left < 0
        then format('Pharmacy license expired %s day(s) ago (on %s). Renew as soon as possible.', abs(v_days_left), v_expiry)
        else format('Pharmacy license expires in %s day(s) (on %s).', v_days_left, v_expiry)
      end
    );
    return 1;
  end if;

  return 0;
end;
$function$
;

-- ============================================================
-- check_low_stock_alerts()
-- ============================================================
CREATE OR REPLACE FUNCTION public.check_low_stock_alerts()
 RETURNS integer
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''
AS $function$
declare
  v_branch uuid := public.current_branch_id();
  v_interval interval;
  v_default_reorder_min integer;
  v_created integer := 0;
  rec record;
  v_last record;
begin
  if v_branch is null then
    return 0;
  end if;

  select (out_of_stock_reminder_hours || ' hours')::interval, default_reorder_min
    into v_interval, v_default_reorder_min
    from public.branches where id = v_branch;

  for rec in
    with stock as (
      select
        pv.id as variant_id, p.name as product_name, pv.dosage,
        coalesce(sum(bc.quantity_available * bc.pieces_per_pack) filter (where bc.barcode_type = 'pack'), 0) as qty_available,
        coalesce(rp.min_quantity, v_default_reorder_min) as min_quantity
      from public.stock_batches sb
      join public.product_variants pv on pv.id = sb.product_variant_id
      join public.products p on p.id = pv.product_id
      left join public.barcodes bc on bc.stock_batch_id = sb.id
      left join public.reorder_points rp on rp.product_id = pv.product_id and rp.branch_id = v_branch
      where sb.branch_id = v_branch
      group by pv.id, p.name, pv.dosage, rp.min_quantity
    )
    select variant_id, product_name, dosage, qty_available, min_quantity
    from stock
    where qty_available > 0 and qty_available < min_quantity
  loop
    select id, is_read, created_at into v_last
      from public.notifications
      where branch_id = v_branch and source_type = 'low_stock' and source_id = rec.variant_id
      order by created_at desc
      limit 1;

    if not found then
      insert into public.notifications (branch_id, source_type, source_id, message)
      values (
        v_branch, 'low_stock', rec.variant_id,
        format('%s is below its reorder point (%s left, minimum %s).', concat_ws(' ', rec.product_name, rec.dosage), rec.qty_available, rec.min_quantity)
      );
      v_created := v_created + 1;
    elsif v_last.is_read and v_last.created_at < now() - v_interval then
      insert into public.notifications (branch_id, source_type, source_id, message)
      values (
        v_branch, 'low_stock', rec.variant_id,
        format('%s is still below its reorder point (%s left, minimum %s).', concat_ws(' ', rec.product_name, rec.dosage), rec.qty_available, rec.min_quantity)
      );
      v_created := v_created + 1;
    end if;
  end loop;

  return v_created;
end;
$function$
;

-- ============================================================
-- check_out_of_stock_alerts()
-- ============================================================
CREATE OR REPLACE FUNCTION public.check_out_of_stock_alerts()
 RETURNS integer
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''
AS $function$
declare
  v_branch uuid := public.current_branch_id();
  v_interval interval;
  v_created integer := 0;
  rec record;
  v_last record;
begin
  if v_branch is null then
    return 0;
  end if;

  select (out_of_stock_reminder_hours || ' hours')::interval into v_interval
    from public.branches where id = v_branch;

  for rec in
    select pv.id as variant_id, p.name as product_name, pv.dosage
    from public.stock_batches sb
    join public.product_variants pv on pv.id = sb.product_variant_id
    join public.products p on p.id = pv.product_id
    left join public.barcodes bc on bc.stock_batch_id = sb.id and bc.barcode_type = 'pack'
    where sb.branch_id = v_branch
    group by pv.id, p.name, pv.dosage
    having coalesce(sum(bc.quantity_available * bc.pieces_per_pack), 0) = 0
  loop
    select id, is_read, created_at into v_last
      from public.notifications
      where branch_id = v_branch and source_type = 'out_of_stock' and source_id = rec.variant_id
      order by created_at desc
      limit 1;

    if not found then
      insert into public.notifications (branch_id, source_type, source_id, message)
      values (v_branch, 'out_of_stock', rec.variant_id, format('%s is out of stock.', concat_ws(' ', rec.product_name, rec.dosage)));
      v_created := v_created + 1;
    elsif v_last.is_read and v_last.created_at < now() - v_interval then
      insert into public.notifications (branch_id, source_type, source_id, message)
      values (v_branch, 'out_of_stock', rec.variant_id, format('%s is still out of stock.', concat_ws(' ', rec.product_name, rec.dosage)));
      v_created := v_created + 1;
    end if;
  end loop;

  return v_created;
end;
$function$
;

-- ============================================================
-- check_restock_recommendations()
-- ============================================================
CREATE OR REPLACE FUNCTION public.check_restock_recommendations()
 RETURNS integer
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''
AS $function$
declare
  v_branch uuid := public.current_branch_id();
  v_created integer := 0;
  rec record;
  v_last record;
begin
  if v_branch is null then
    return 0;
  end if;

  for rec in
    with recent_sales as (
      select
        pv.id as variant_id,
        sum(si.quantity)::numeric / 30 as avg_daily_qty,
        count(distinct date_trunc('day', s.sold_at)) as active_days
      from public.sale_items si
      join public.sales s on s.id = si.sale_id
      join public.barcodes bc on bc.id = si.barcode_id
      join public.stock_batches sb on sb.id = bc.stock_batch_id
      join public.product_variants pv on pv.id = sb.product_variant_id
      where s.branch_id = v_branch and s.sold_at >= now() - interval '30 days'
      group by pv.id
      having count(distinct date_trunc('day', s.sold_at)) >= 3
    ),
    stock as (
      select
        pv.id as variant_id, p.name as product_name, pv.dosage,
        coalesce(sum(bc.quantity_available * bc.pieces_per_pack) filter (where bc.barcode_type = 'pack'), 0)::integer as qty_available
      from public.stock_batches sb
      join public.product_variants pv on pv.id = sb.product_variant_id
      join public.products p on p.id = pv.product_id
      left join public.barcodes bc on bc.stock_batch_id = sb.id
      where sb.branch_id = v_branch
      group by pv.id, p.name, pv.dosage
    )
    select
      rs.variant_id, st.product_name, st.dosage, rs.avg_daily_qty, st.qty_available,
      (st.qty_available / rs.avg_daily_qty) as days_to_stockout
    from recent_sales rs
    join stock st on st.variant_id = rs.variant_id
    where rs.avg_daily_qty > 0 and st.qty_available > 0
      and st.qty_available / rs.avg_daily_qty <= 14
  loop
    select id, is_read, created_at into v_last
      from public.notifications
      where branch_id = v_branch and source_type = 'restock_recommendation' and source_id = rec.variant_id
      order by created_at desc
      limit 1;

    if not found or (v_last.is_read and v_last.created_at < now() - interval '24 hours') then
      insert into public.notifications (branch_id, source_type, source_id, message)
      values (
        v_branch, 'restock_recommendation', rec.variant_id,
        format('%s is one of your best sellers (~%s/day) and will run out in about %s days at this pace -- restock soon.',
          concat_ws(' ', rec.product_name, rec.dosage), round(rec.avg_daily_qty, 1), round(rec.days_to_stockout))
      );
      v_created := v_created + 1;
    end if;
  end loop;

  return v_created;
end;
$function$
;

-- ============================================================
-- complete_sale(p_lines jsonb, p_insurance_provider_id uuid, p_patient_id uuid, p_payment_method text, p_discount_id uuid, p_bargain_final_price numeric, p_patient_coverage_percentage numeric)
-- ============================================================
CREATE OR REPLACE FUNCTION public.complete_sale(p_lines jsonb, p_insurance_provider_id uuid DEFAULT NULL::uuid, p_patient_id uuid DEFAULT NULL::uuid, p_payment_method text DEFAULT NULL::text, p_discount_id uuid DEFAULT NULL::uuid, p_bargain_final_price numeric DEFAULT NULL::numeric, p_patient_coverage_percentage numeric DEFAULT NULL::numeric)
 RETURNS TABLE(sale_id uuid, receipt_number text, total_amount numeric, insurance_covered_total numeric, patient_owed_total numeric)
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''
AS $function$
#variable_conflict use_column
declare
  v_branch uuid;
  v_user uuid := (select auth.uid());
  v_sale uuid := gen_random_uuid();
  v_receipt_number text;
  v_receipt_prefix text;
  line jsonb;
  v_code text;
  v_mode text;
  v_quantity integer;
  v_barcode record;
  v_child record;
  v_child_quantity integer;
  v_packs_remaining integer;
  v_pieces_remaining integer;
  v_product_id uuid;
  v_tax_rate_id uuid;
  v_tax_pct numeric;
  v_coverage_pct numeric;
  v_effective_price numeric;
  v_subtotal numeric;
  v_tax_amount numeric;
  v_line_total numeric;
  v_line_covered numeric;
  v_total numeric := 0;
  v_covered_total numeric := 0;
  v_seen_codes text[] := array[]::text[];
  v_provider_name text;
  v_discount record;
  v_discount_amount numeric := 0;
begin
  select u.branch_id into v_branch from public.users u where u.id = v_user and u.is_active;
  if v_branch is null then
    raise exception 'Only an active branch user may complete a sale';
  end if;
  if exists (select 1 from public.branches b where b.id = v_branch and b.status <> 'active') then
    raise exception 'This pharmacy is not active';
  end if;
  if jsonb_typeof(p_lines) <> 'array' or jsonb_array_length(p_lines) = 0 then
    raise exception 'At least one item is required to complete a sale';
  end if;

  if p_payment_method is not null and p_payment_method not in ('cash','mtn_momo','airtel_money','card') then
    raise exception 'Unsupported payment method %', p_payment_method;
  end if;

  if p_bargain_final_price is not null then
    if p_insurance_provider_id is not null then
      raise exception 'A bargained price only applies to walk-in sales, not insurance sales';
    end if;
    if p_discount_id is not null then
      raise exception 'Use either a bargained price or a discount code, not both';
    end if;
    if p_bargain_final_price < 0 then
      raise exception 'Bargained price cannot be negative';
    end if;
  end if;

  if p_patient_coverage_percentage is not null then
    if p_insurance_provider_id is null then
      raise exception 'A patient coverage percentage only applies to an insurance sale';
    end if;
    if p_patient_coverage_percentage < 0 or p_patient_coverage_percentage > 100 then
      raise exception 'Patient coverage percentage must be between 0 and 100';
    end if;
  end if;

  if p_insurance_provider_id is not null then
    select name into v_provider_name from public.insurance_providers where id = p_insurance_provider_id;
    if v_provider_name is null then raise exception 'Unknown insurance provider'; end if;
    if p_patient_id is null then
      raise exception 'A patient must be recorded for an insurance sale';
    end if;
  end if;

  if p_patient_id is not null and not exists (
    select 1 from public.patients where id = p_patient_id and branch_id = v_branch
  ) then
    raise exception 'Unknown patient for this branch';
  end if;

  if p_discount_id is not null then
    select * into v_discount from public.discounts where id = p_discount_id;
    if v_discount.id is null then raise exception 'Unknown discount'; end if;
    if (v_discount.valid_from is not null and v_discount.valid_from > current_date)
       or (v_discount.valid_to is not null and v_discount.valid_to < current_date) then
      raise exception 'This discount is not currently valid';
    end if;
  end if;

  select coalesce(receipt_number_prefix, 'RCT') into v_receipt_prefix from public.branches where id = v_branch;
  v_receipt_number := format('%s-%s-%s', v_receipt_prefix, to_char(now(), 'YYYYMMDD'), upper(substr(replace(gen_random_uuid()::text,'-',''),1,6)));

  insert into public.sales (id, branch_id, cashier_id, patient_id, total_amount)
  values (v_sale, v_branch, v_user, p_patient_id, 0);

  for line in select * from jsonb_array_elements(p_lines) loop
    v_code := upper(btrim(coalesce(line->>'code', '')));
    if v_code = '' then raise exception 'Each line needs a barcode code'; end if;
    if v_code = any(v_seen_codes) then
      raise exception 'Barcode % was scanned twice in the same sale', v_code;
    end if;
    v_seen_codes := array_append(v_seen_codes, v_code);

    select bc.*, sb.selling_price, sb.product_variant_id, sb.expiry_date
      into v_barcode
      from public.barcodes bc
      join public.stock_batches sb on sb.id = bc.stock_batch_id
      where upper(bc.code) = v_code and sb.branch_id = v_branch
      for update of bc;

    if not found then
      raise exception 'Barcode % was not found for this branch', v_code;
    end if;
    if v_barcode.expiry_date < current_date then
      raise exception 'Barcode %: this batch expired on % and cannot be sold', v_code, v_barcode.expiry_date;
    end if;
    if v_barcode.status <> 'active' then
      raise exception 'Barcode % is % and cannot be sold', v_code, v_barcode.status;
    end if;

    v_mode := lower(coalesce(nullif(line->>'sell_mode', ''), 'whole'));
    v_quantity := nullif(line->>'quantity', '')::integer;

    select pv.product_id into v_product_id from public.product_variants pv where pv.id = v_barcode.product_variant_id;
    select p.tax_rate_id into v_tax_rate_id from public.products p where p.id = v_product_id;
    select t.rate_percentage into v_tax_pct from public.tax_rates t where t.id = v_tax_rate_id;

    if p_insurance_provider_id is null then
      v_coverage_pct := 0;
    elsif p_patient_coverage_percentage is not null then
      -- Pharmacist-entered override for this specific sale/patient visit --
      -- real coverage varies by the PATIENT'S own plan, not by product, so
      -- this takes priority over any per-product/provider default below.
      v_coverage_pct := 100 - p_patient_coverage_percentage;
    else
      select coverage_percentage into v_coverage_pct
        from public.insurance_product_coverage
        where insurance_provider_id = p_insurance_provider_id and product_id = v_product_id;
      if v_coverage_pct is null then
        select default_coverage_percentage into v_coverage_pct
          from public.insurance_providers where id = p_insurance_provider_id;
      end if;
    end if;

    -- Fixed insurance price, if one is on file for this exact provider +
    -- variant; otherwise the normal walk-in price, unchanged.
    if p_insurance_provider_id is null then
      v_effective_price := v_barcode.selling_price;
    else
      select fixed_price into v_effective_price
        from public.insurance_variant_prices
        where insurance_provider_id = p_insurance_provider_id and product_variant_id = v_barcode.product_variant_id;
      if v_effective_price is null then
        v_effective_price := v_barcode.selling_price;
      end if;
    end if;

    if v_barcode.barcode_type = 'pack' then
      if coalesce(v_barcode.quantity_available, 0) < 1 then
        raise exception 'Barcode % has already been sold', v_code;
      end if;
      if v_mode not in ('whole', 'pieces') then
        raise exception 'Barcode % is a pack; sell_mode must be whole or pieces', v_code;
      end if;

      v_child_quantity := coalesce(v_quantity, v_barcode.pieces_per_pack);
      if v_mode = 'whole' then
        v_child_quantity := v_barcode.pieces_per_pack;
      end if;
      if v_child_quantity < 1 then
        raise exception 'Barcode % needs a quantity of at least 1 piece', v_code;
      end if;
      if v_child_quantity > v_barcode.pieces_per_pack then
        raise exception 'Barcode % only has % piece(s) left', v_code, v_barcode.pieces_per_pack;
      end if;

      v_line_total := v_effective_price * v_child_quantity;
      v_tax_amount := round(v_line_total * coalesce(v_tax_pct, 0) / (100 + coalesce(v_tax_pct, 0)), 2);
      v_subtotal := v_line_total - v_tax_amount;
      v_line_covered := round(v_line_total * coalesce(v_coverage_pct, 0) / 100, 2);

      insert into public.sale_items (sale_id, barcode_id, tax_rate_id, quantity, unit_price, subtotal, insurance_covered_amount)
      values (v_sale, v_barcode.id, v_tax_rate_id, v_child_quantity, v_effective_price, v_subtotal, v_line_covered);

      if v_child_quantity = v_barcode.pieces_per_pack then
        update public.barcodes set quantity_available = 0, status = 'sold_out' where id = v_barcode.id;
      else
        update public.barcodes set pieces_per_pack = pieces_per_pack - v_child_quantity where id = v_barcode.id;
      end if;

      v_total := v_total + v_line_total;
      v_covered_total := v_covered_total + v_line_covered;

    elsif v_barcode.barcode_type = 'box' then
      if v_mode not in ('whole', 'packs', 'pieces') then
        raise exception 'Barcode % is a carton; sell_mode must be whole, packs or pieces', v_code;
      end if;

      select count(*), coalesce(sum(pieces_per_pack), 0)
        into v_packs_remaining, v_pieces_remaining
        from public.barcodes
        where parent_barcode_id = v_barcode.id
          and barcode_type = 'pack'
          and status = 'active'
          and quantity_available > 0;

      if v_packs_remaining = 0 then
        raise exception 'Carton % has no packs left to sell', v_code;
      end if;

      if v_mode = 'whole' then
        for v_child in
          select bc.id, bc.pieces_per_pack
          from public.barcodes bc
          where bc.parent_barcode_id = v_barcode.id
            and bc.barcode_type = 'pack'
            and bc.status = 'active'
            and bc.quantity_available > 0
          order by bc.created_at
          for update
        loop
          v_line_total := v_effective_price * v_child.pieces_per_pack;
          v_tax_amount := round(v_line_total * coalesce(v_tax_pct, 0) / (100 + coalesce(v_tax_pct, 0)), 2);
          v_subtotal := v_line_total - v_tax_amount;
          v_line_covered := round(v_line_total * coalesce(v_coverage_pct, 0) / 100, 2);

          insert into public.sale_items (sale_id, barcode_id, tax_rate_id, quantity, unit_price, subtotal, insurance_covered_amount)
          values (v_sale, v_child.id, v_tax_rate_id, v_child.pieces_per_pack, v_effective_price, v_subtotal, v_line_covered);

          update public.barcodes set quantity_available = 0, status = 'sold_out' where id = v_child.id;

          v_total := v_total + v_line_total;
          v_covered_total := v_covered_total + v_line_covered;
        end loop;

        update public.barcodes set quantity_available = 0, status = 'sold_out' where id = v_barcode.id;

      elsif v_mode = 'packs' then
        if v_quantity is null or v_quantity < 1 then
          raise exception 'Carton % needs a pack quantity of at least 1', v_code;
        end if;
        if v_quantity > v_packs_remaining then
          raise exception 'Carton % only has % pack(s) left', v_code, v_packs_remaining;
        end if;

        for v_child in
          select id, pieces_per_pack from public.barcodes
          where parent_barcode_id = v_barcode.id
            and barcode_type = 'pack'
            and status = 'active'
            and quantity_available > 0
          order by pieces_per_pack desc, created_at
          limit v_quantity
          for update
        loop
          v_line_total := v_effective_price * v_child.pieces_per_pack;
          v_tax_amount := round(v_line_total * coalesce(v_tax_pct, 0) / (100 + coalesce(v_tax_pct, 0)), 2);
          v_subtotal := v_line_total - v_tax_amount;
          v_line_covered := round(v_line_total * coalesce(v_coverage_pct, 0) / 100, 2);

          insert into public.sale_items (sale_id, barcode_id, tax_rate_id, quantity, unit_price, subtotal, insurance_covered_amount)
          values (v_sale, v_child.id, v_tax_rate_id, v_child.pieces_per_pack, v_effective_price, v_subtotal, v_line_covered);

          update public.barcodes set quantity_available = 0, status = 'sold_out' where id = v_child.id;

          v_total := v_total + v_line_total;
          v_covered_total := v_covered_total + v_line_covered;
        end loop;

        if v_quantity = v_packs_remaining then
          update public.barcodes set quantity_available = 0, status = 'sold_out' where id = v_barcode.id;
        end if;

      else -- pieces from carton
        if v_quantity is null or v_quantity < 1 then
          raise exception 'Carton % needs a piece quantity of at least 1', v_code;
        end if;

        select id, pieces_per_pack into v_child
          from public.barcodes
          where parent_barcode_id = v_barcode.id
            and barcode_type = 'pack'
            and status = 'active'
            and quantity_available > 0
          order by pieces_per_pack asc, created_at
          limit 1
          for update;

        if v_child.pieces_per_pack is null then
          raise exception 'Carton % has no packs left to sell', v_code;
        end if;
        if v_quantity > v_child.pieces_per_pack then
          raise exception 'Carton %: the openable pack only has % piece(s) left -- sell fewer pieces or use packs mode', v_code, v_child.pieces_per_pack;
        end if;

        v_line_total := v_effective_price * v_quantity;
        v_tax_amount := round(v_line_total * coalesce(v_tax_pct, 0) / (100 + coalesce(v_tax_pct, 0)), 2);
        v_subtotal := v_line_total - v_tax_amount;
        v_line_covered := round(v_line_total * coalesce(v_coverage_pct, 0) / 100, 2);

        insert into public.sale_items (sale_id, barcode_id, tax_rate_id, quantity, unit_price, subtotal, insurance_covered_amount)
        values (v_sale, v_child.id, v_tax_rate_id, v_quantity, v_effective_price, v_subtotal, v_line_covered);

        if v_quantity = v_child.pieces_per_pack then
          update public.barcodes set quantity_available = 0, status = 'sold_out' where id = v_child.id;
          if v_packs_remaining = 1 then
            update public.barcodes set quantity_available = 0, status = 'sold_out' where id = v_barcode.id;
          end if;
        else
          update public.barcodes set pieces_per_pack = pieces_per_pack - v_quantity where id = v_child.id;
        end if;

        v_total := v_total + v_line_total;
        v_covered_total := v_covered_total + v_line_covered;
      end if;

    else
      raise exception 'Barcode % has unknown type %', v_code, v_barcode.barcode_type;
    end if;
  end loop;

  -- Discount comes off the patient's own portion only (post-insurance),
  -- capped so it can never push what the patient owes below zero. What
  -- insurance is billed (v_covered_total, and the claim's own
  -- coverage_percentage_applied below) is computed from the real gross
  -- v_total and never touched by a pharmacy-side discount.
  if p_discount_id is not null then
    v_discount_amount := case
      when v_discount.discount_type = 'percentage' then round((v_total - v_covered_total) * v_discount.value / 100, 2)
      else least(v_discount.value, greatest(v_total - v_covered_total, 0))
    end;
  elsif p_bargain_final_price is not null then
    -- v_covered_total is always 0 here (insurance + bargain are mutually
    -- exclusive, enforced above), so this is just v_total - the agreed price.
    v_discount_amount := greatest(v_total - p_bargain_final_price, 0);
  end if;

  update public.sales
  set total_amount = v_total - v_discount_amount, discount_id = p_discount_id, payment_method = p_payment_method
  where id = v_sale;

  insert into public.receipts (sale_id, receipt_number) values (v_sale, v_receipt_number);

  if p_insurance_provider_id is not null and v_covered_total > 0 then
    insert into public.insurance_claims (sale_id, insurance_provider_id, coverage_percentage_applied, claim_amount)
    values (
      v_sale, p_insurance_provider_id,
      round(v_covered_total / nullif(v_total, 0) * 100, 2),
      v_covered_total
    );
  end if;

  return query select v_sale, v_receipt_number, v_total - v_discount_amount, v_covered_total, (v_total - v_discount_amount) - v_covered_total;
end;
$function$
;

-- ============================================================
-- create_branch_category(p_name text, p_description text)
-- ============================================================
CREATE OR REPLACE FUNCTION public.create_branch_category(p_name text, p_description text DEFAULT NULL::text)
 RETURNS uuid
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''
AS $function$
declare
  v_branch uuid := public.current_branch_id();
  v_id uuid;
begin
  perform public.assert_owner_or_manager();
  if v_branch is null then raise exception 'No active branch for this session'; end if;
  if nullif(btrim(coalesce(p_name, '')), '') is null then raise exception 'A category name is required'; end if;

  insert into public.product_categories (branch_id, name, description)
  values (v_branch, btrim(p_name), nullif(btrim(coalesce(p_description, '')), ''))
  returning id into v_id;
  return v_id;
exception
  when unique_violation then
    raise exception 'A category named "%" already exists for this branch.', btrim(p_name);
end;
$function$
;

-- ============================================================
-- create_branch_discount(p_name text, p_discount_type text, p_value numeric, p_valid_from date, p_valid_to date)
-- ============================================================
CREATE OR REPLACE FUNCTION public.create_branch_discount(p_name text, p_discount_type text, p_value numeric, p_valid_from date DEFAULT NULL::date, p_valid_to date DEFAULT NULL::date)
 RETURNS uuid
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''
AS $function$
declare
  v_id uuid;
begin
  perform public.assert_owner_or_manager();
  if p_discount_type not in ('percentage','fixed') then
    raise exception 'Discount type must be percentage or fixed';
  end if;
  if p_value < 0 or (p_discount_type = 'percentage' and p_value > 100) then
    raise exception 'Invalid discount value';
  end if;

  insert into public.discounts (name, discount_type, value, valid_from, valid_to, branch_id)
  values (btrim(p_name), p_discount_type, p_value, p_valid_from, p_valid_to, public.current_branch_id())
  returning id into v_id;

  return v_id;
end;
$function$
;

-- ============================================================
-- create_stock_batch_with_barcodes(p_variant uuid, p_branch uuid, p_supplier uuid, p_manufacturer text, p_delivery uuid, p_delivery_code text, p_user uuid, p_batch_number text, p_expiry date, p_cost numeric, p_sell numeric, p_cartons integer, p_packs integer, p_pieces integer)
-- ============================================================
CREATE OR REPLACE FUNCTION public.create_stock_batch_with_barcodes(p_variant uuid, p_branch uuid, p_supplier uuid, p_manufacturer text, p_delivery uuid, p_delivery_code text, p_user uuid, p_batch_number text, p_expiry date, p_cost numeric, p_sell numeric, p_cartons integer, p_packs integer, p_pieces integer)
 RETURNS uuid
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''
AS $function$
declare
  v_batch uuid;
  v_parent uuid;
  i integer;
  j integer;
begin
  insert into public.stock_batches (
    product_variant_id, branch_id, supplier_id, manufacturer_name, delivery_id, delivery_code,
    logged_by, batch_number, expiry_date, cost_price, selling_price, quantity_received
  ) values (
    p_variant, p_branch, p_supplier, p_manufacturer, p_delivery, p_delivery_code, p_user,
    p_batch_number, p_expiry, p_cost, p_sell,
    case when p_cartons > 0 then p_cartons * p_packs * p_pieces else p_packs * p_pieces end
  )
  returning id into v_batch;

  if p_cartons > 0 then
    for i in 1..p_cartons loop
      insert into public.barcodes (stock_batch_id, barcode_type, code, code_source, child_count, quantity_available)
      values (v_batch, 'box', public.generate_short_barcode_code(), 'generated', p_packs, 1)
      returning id into v_parent;
      for j in 1..p_packs loop
        insert into public.barcodes (stock_batch_id, parent_barcode_id, barcode_type, code, code_source, pieces_per_pack, quantity_available)
        values (v_batch, v_parent, 'pack', public.generate_short_barcode_code(), 'generated', p_pieces, 1);
      end loop;
    end loop;
  else
    for j in 1..p_packs loop
      insert into public.barcodes (stock_batch_id, barcode_type, code, code_source, pieces_per_pack, quantity_available)
      values (v_batch, 'pack', public.generate_short_barcode_code(), 'generated', p_pieces, 1);
    end loop;
  end if;

  return v_batch;
end;
$function$
;

-- ============================================================
-- current_branch_id()
-- ============================================================
CREATE OR REPLACE FUNCTION public.current_branch_id()
 RETURNS uuid
 LANGUAGE sql
 STABLE SECURITY DEFINER
 SET search_path TO ''
AS $function$
    select u.branch_id
    from public.users u
    where u.id = (select auth.uid())
      and u.is_active
  $function$
;

-- ============================================================
-- find_patient_by_identifier(p_identifier text)
-- ============================================================
CREATE OR REPLACE FUNCTION public.find_patient_by_identifier(p_identifier text)
 RETURNS TABLE(id uuid, full_name text, gender text, age integer, tin_or_phone text, phone text, tin text, insurance_number text)
 LANGUAGE sql
 STABLE SECURITY DEFINER
 SET search_path TO ''
AS $function$
  select p.id, p.full_name::text, p.gender::text, p.age,
         p.tin_or_phone::text, p.phone::text, p.tin::text, p.insurance_number::text
  from public.patients p
  where p.branch_id = public.current_branch_id()
    and (p.tin_or_phone = btrim(p_identifier)
      or p.phone        = btrim(p_identifier)
      or p.tin          = btrim(p_identifier))
  limit 1
$function$
;

-- ============================================================
-- freeze_expired_pharmacy_otp(p_application_id uuid)
-- ============================================================
CREATE OR REPLACE FUNCTION public.freeze_expired_pharmacy_otp(p_application_id uuid)
 RETURNS void
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''
AS $function$
  begin
    update public.branch_applications
    set status = 'denied',
        denied_reason = 'Activation window (3 hours) expired without verification'
    where id = p_application_id
      and status = 'otp_sent'
      and otp_sent_at is not null
      and now() > otp_sent_at + interval '3 hours';
  end;
  $function$
;

-- ============================================================
-- generate_short_barcode_code()
-- ============================================================
CREATE OR REPLACE FUNCTION public.generate_short_barcode_code()
 RETURNS text
 LANGUAGE plpgsql
AS $function$
  declare
    v_chars text := 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
    v_result text := '';
    i integer;
  begin
    for i in 1..8 loop
      v_result := v_result || substr(v_chars, 1 + floor(random() * length(v_chars))::integer, 1);
    end loop;
    return v_result;
  end;
  $function$
;

-- ============================================================
-- get_my_branch_details()
-- ============================================================
CREATE OR REPLACE FUNCTION public.get_my_branch_details()
 RETURNS TABLE(name text, address text, phone text, tin text, logo_path text, bank_account_number text, bank_account_name text, momo_pay_number text, out_of_stock_reminder_hours integer, branch_code text, status text, created_at timestamp with time zone, email text, website text, license_number text, license_expiry_date date, ebm_device_serial text, default_language text, receipt_number_prefix text, pos_cash_enabled boolean, pos_mtn_momo_enabled boolean, pos_airtel_money_enabled boolean, pos_card_enabled boolean, pos_insurance_enabled boolean, pos_default_payment_method text, pos_require_patient_name boolean, pos_allow_discounts boolean, pos_show_patient_history boolean, expiry_alert_threshold_days integer, default_reorder_min integer)
 LANGUAGE sql
 STABLE SECURITY DEFINER
 SET search_path TO ''
AS $function$
  select b.name::text, b.address, b.phone, b.tin, b.logo_path, b.bank_account_number, b.bank_account_name, b.momo_pay_number,
         b.out_of_stock_reminder_hours, b.branch_code::text, b.status::text, b.created_at,
         b.email, b.website, b.license_number, b.license_expiry_date, b.ebm_device_serial, b.default_language::text,
         b.receipt_number_prefix::text, b.pos_cash_enabled, b.pos_mtn_momo_enabled, b.pos_airtel_money_enabled,
         b.pos_card_enabled, b.pos_insurance_enabled, b.pos_default_payment_method::text,
         b.pos_require_patient_name, b.pos_allow_discounts, b.pos_show_patient_history,
         b.expiry_alert_threshold_days, b.default_reorder_min
  from public.branches b
  where b.id = public.current_branch_id()
$function$
;

-- ============================================================
-- get_onboarding_progress()
-- ============================================================
CREATE OR REPLACE FUNCTION public.get_onboarding_progress()
 RETURNS TABLE(received_stock boolean, completed_sale boolean, set_reorder_point boolean, added_patient boolean, invited_staff boolean, used_discount boolean, created_category boolean, used_insurance boolean)
 LANGUAGE sql
 STABLE SECURITY DEFINER
 SET search_path TO ''
AS $function$
  select
    exists(select 1 from public.stock_batches sb where sb.branch_id = public.current_branch_id()),
    exists(select 1 from public.sales s where s.branch_id = public.current_branch_id()),
    exists(select 1 from public.reorder_points rp where rp.branch_id = public.current_branch_id()),
    exists(select 1 from public.patients p where p.branch_id = public.current_branch_id()),
    (select count(*) from public.users u where u.branch_id = public.current_branch_id() and u.is_active) > 1,
    exists(select 1 from public.sales s where s.branch_id = public.current_branch_id() and s.discount_id is not null),
    exists(select 1 from public.product_categories pc where pc.branch_id = public.current_branch_id()),
    exists(
      select 1 from public.insurance_claims ic
      join public.sales s on s.id = ic.sale_id
      where s.branch_id = public.current_branch_id()
    )
$function$
;

-- ============================================================
-- get_pharmacy_application(p_application_id uuid)
-- ============================================================
CREATE OR REPLACE FUNCTION public.get_pharmacy_application(p_application_id uuid)
 RETURNS TABLE(id uuid, application_code text, pharmacy_name text, phone text, email text, location text, status text, called_at timestamp with time zone, denied_reason text, branch_id uuid, branch_code text, activation_code text, submitted_at timestamp with time zone)
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''
AS $function$
begin
  perform public.freeze_expired_pharmacy_otp(p_application_id);
  return query
    select
      a.id, a.application_code::text, a.pharmacy_name::text, a.phone::text,
      a.email::text, a.location::text, a.status::text, a.called_at,
      a.denied_reason, a.branch_id, b.branch_code::text, b.activation_code::text,
      a.submitted_at
    from public.branch_applications a
    left join public.branches b on b.id = a.branch_id
    where a.id = p_application_id;
end;
$function$
;

-- ============================================================
-- get_pharmacy_application_by_email(p_email text)
-- ============================================================
CREATE OR REPLACE FUNCTION public.get_pharmacy_application_by_email(p_email text)
 RETURNS TABLE(id uuid, application_code text, pharmacy_name text, phone text, email text, location text, status text, called_at timestamp with time zone, denied_reason text, branch_id uuid, branch_code text, activation_code text, submitted_at timestamp with time zone)
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''
AS $function$
declare
  v_app_id uuid;
begin
  select a.id into v_app_id
  from public.branch_applications a
  where lower(a.email) = lower(btrim(p_email))
  order by a.submitted_at desc
  limit 1;

  if v_app_id is not null then
    perform public.freeze_expired_pharmacy_otp(v_app_id);
  end if;

  return query
    select
      a.id, a.application_code::text, a.pharmacy_name::text, a.phone::text,
      a.email::text, a.location::text, a.status::text, a.called_at,
      a.denied_reason, a.branch_id, b.branch_code::text, b.activation_code::text,
      a.submitted_at
    from public.branch_applications a
    left join public.branches b on b.id = a.branch_id
    where a.id = v_app_id;
end;
$function$
;

-- ============================================================
-- get_public_receipt(p_sale_id uuid)
-- ============================================================
CREATE OR REPLACE FUNCTION public.get_public_receipt(p_sale_id uuid)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''
AS $function$
declare
  v_branch_id uuid;
  v_cashier_id uuid;
  v_patient_id uuid;
  v_receipt_note text;
  v_total_amount numeric;

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
  v_discount_amount numeric;
  v_final_owed numeric;
begin
  select s.branch_id, s.cashier_id, s.patient_id, s.receipt_note, s.total_amount
    into v_branch_id, v_cashier_id, v_patient_id, v_receipt_note, v_total_amount
    from public.sales s
    where s.id = p_sale_id;

  if not found then
    return null;
  end if;

  select r.receipt_number, r.issued_at
    into v_receipt_number, v_issued_at
    from public.receipts r
    where r.sale_id = p_sale_id;

  if not found then
    return null;
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

  v_final_owed := coalesce(v_total_amount, v_subtotal + v_tax_total - v_insurance_total);
  v_discount_amount := greatest(0, (v_subtotal + v_tax_total - v_insurance_total) - v_final_owed);

  return jsonb_build_object(
    'saleId', p_sale_id,
    'receiptNumber', v_receipt_number,
    'issuedAt', v_issued_at,
    'branchName', coalesce(v_branch_name, '—'),
    'branchTin', v_branch_tin,
    'branchAddress', v_branch_address,
    'branchPhone', v_branch_phone,
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
    'discountAmount', v_discount_amount,
    'patientOwedTotal', v_final_owed,
    'grandTotal', v_subtotal + v_tax_total,
    'ebmSdcId', null,
    'ebmMrcNo', null,
    'ebmReceiptSignature', null,
    'ebmInvoiceNumber', null,
    'receiptNote', v_receipt_note
  );
end;
$function$
;

-- ============================================================
-- is_owner()
-- ============================================================
CREATE OR REPLACE FUNCTION public.is_owner()
 RETURNS boolean
 LANGUAGE sql
 STABLE SECURITY DEFINER
 SET search_path TO ''
AS $function$
    select exists (
      select 1
      from public.users u
      where u.id = (select auth.uid())
        and u.role = 'owner'
        and u.is_active
    )
  $function$
;

-- ============================================================
-- is_super_admin()
-- ============================================================
CREATE OR REPLACE FUNCTION public.is_super_admin()
 RETURNS boolean
 LANGUAGE sql
 STABLE SECURITY DEFINER
 SET search_path TO ''
AS $function$
    select coalesce(((select auth.jwt()) -> 'app_metadata' ->> 'role') = 'super_admin', false)
  $function$
;

-- ============================================================
-- list_branch_categories()
-- ============================================================
CREATE OR REPLACE FUNCTION public.list_branch_categories()
 RETURNS TABLE(id uuid, name text, description text, product_count integer, code text)
 LANGUAGE sql
 STABLE SECURITY DEFINER
 SET search_path TO ''
AS $function$
  select
    pc.id, pc.name::text, pc.description,
    (select count(*)::integer from public.branch_product_categorization bpc where bpc.category_id = pc.id and bpc.branch_id = pc.branch_id),
    'CAT-' || lpad(row_number() over (order by pc.created_at)::text, 3, '0')
  from public.product_categories pc
  where pc.branch_id = public.current_branch_id()
  order by pc.created_at;
$function$
;

-- ============================================================
-- list_branch_discounts()
-- ============================================================
CREATE OR REPLACE FUNCTION public.list_branch_discounts()
 RETURNS TABLE(id uuid, name text, discount_type text, value numeric, valid_from date, valid_to date, is_current boolean)
 LANGUAGE sql
 STABLE SECURITY DEFINER
 SET search_path TO ''
AS $function$
  select d.id, d.name::text, d.discount_type::text, d.value, d.valid_from, d.valid_to,
    (d.valid_from is null or d.valid_from <= current_date) and (d.valid_to is null or d.valid_to >= current_date)
  from public.discounts d
  where d.branch_id is null or d.branch_id = public.current_branch_id() or public.is_super_admin()
  order by d.name
$function$
;

-- ============================================================
-- list_branch_history(p_from timestamp with time zone, p_to timestamp with time zone)
-- ============================================================
CREATE OR REPLACE FUNCTION public.list_branch_history(p_from timestamp with time zone DEFAULT NULL::timestamp with time zone, p_to timestamp with time zone DEFAULT NULL::timestamp with time zone)
 RETURNS TABLE(event_at timestamp with time zone, category text, amount numeric, actor_name text, status text, meta jsonb)
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''
AS $function$
declare
  v_branch uuid;
begin
  select u.branch_id into v_branch
  from public.users u
  where u.id = (select auth.uid()) and u.is_active and u.role = 'owner';
  if v_branch is null then
    raise exception 'Only the branch owner may view the full history';
  end if;

  -- title/description text is NOT built here -- it's built client-side from
  -- this raw meta data, so the History page can render it in the viewer's
  -- chosen language (see src/pages/HistoryPage.tsx eventText()).
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
$function$
;

-- ============================================================
-- list_branch_patients()
-- ============================================================
CREATE OR REPLACE FUNCTION public.list_branch_patients()
 RETURNS TABLE(id uuid, full_name text, gender text, age integer, tin_or_phone text, phone text, tin text, insurance_number text, visit_count integer, last_visit_at timestamp with time zone, lifetime_spend numeric)
 LANGUAGE sql
 STABLE SECURITY DEFINER
 SET search_path TO ''
AS $function$
  select
    p.id, p.full_name::text, p.gender::text, p.age, p.tin_or_phone::text,
    p.phone::text, p.tin::text, p.insurance_number::text,
    count(s.id)::integer, max(s.sold_at), coalesce(sum(s.total_amount), 0)
  from public.patients p
  left join public.sales s on s.patient_id = p.id
  where p.branch_id = public.current_branch_id()
  group by p.id, p.full_name, p.gender, p.age, p.tin_or_phone, p.phone, p.tin, p.insurance_number
  order by max(s.sold_at) desc nulls last, p.full_name
$function$
;

-- ============================================================
-- list_compliance_transactions(p_from date, p_to date, p_limit integer)
-- ============================================================
CREATE OR REPLACE FUNCTION public.list_compliance_transactions(p_from date, p_to date, p_limit integer DEFAULT 200)
 RETURNS TABLE(sale_id uuid, receipt_number text, sold_at timestamp with time zone, patient_name text, item_count integer, subtotal numeric, tax_total numeric, total_amount numeric, payment_method text, has_insurance boolean)
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''
AS $function$
declare
  v_branch uuid := public.current_branch_id();
begin
  perform public.assert_owner_or_manager();
  if v_branch is null then raise exception 'No active branch for this session'; end if;
  if p_limit < 1 or p_limit > 2000 then raise exception 'limit must be between 1 and 2000'; end if;

  return query
  with line_agg as (
    select si.sale_id, sum(si.subtotal) as subtotal, sum(round(si.subtotal * t.rate_percentage / 100, 2)) as tax_total, count(*) as item_count
    from public.sale_items si
    join public.tax_rates t on t.id = si.tax_rate_id
    group by si.sale_id
  )
  select
    s.id, coalesce(r.receipt_number, '—')::text, s.sold_at, p.full_name::text, coalesce(la.item_count, 0)::integer,
    coalesce(la.subtotal, 0), coalesce(la.tax_total, 0), s.total_amount, s.payment_method::text,
    exists(select 1 from public.insurance_claims ic where ic.sale_id = s.id)
  from public.sales s
  left join line_agg la on la.sale_id = s.id
  left join public.receipts r on r.sale_id = s.id
  left join public.patients p on p.id = s.patient_id
  where s.branch_id = v_branch
    and s.sold_at >= p_from::timestamptz and s.sold_at < (p_to + 1)::timestamptz
  order by s.sold_at desc
  limit p_limit;
end;
$function$
;

-- ============================================================
-- list_my_support_tickets()
-- ============================================================
CREATE OR REPLACE FUNCTION public.list_my_support_tickets()
 RETURNS TABLE(id uuid, subject text, description text, status text, priority text, created_at timestamp with time zone)
 LANGUAGE plpgsql
 STABLE SECURITY DEFINER
 SET search_path TO ''
AS $function$
declare
  v_branch uuid := public.current_branch_id();
begin
  if v_branch is null then raise exception 'Only an active branch user may view tickets'; end if;
  return query
    select t.id, t.subject::text, t.description, t.status::text, t.priority::text, t.created_at
    from public.support_tickets t
    where t.branch_id = v_branch
    order by t.created_at desc;
end;
$function$
;

-- ============================================================
-- list_seller_activity_today()
-- ============================================================
CREATE OR REPLACE FUNCTION public.list_seller_activity_today()
 RETURNS TABLE(user_id uuid, full_name text, sales_count integer, revenue_today numeric, patients_registered_today integer)
 LANGUAGE plpgsql
 STABLE SECURITY DEFINER
 SET search_path TO ''
AS $function$
declare
  v_caller uuid := (select auth.uid());
  v_branch uuid;
begin
  select u.branch_id into v_branch
  from public.users u
  where u.id = v_caller and u.is_active and u.role in ('owner','manager');
  if v_branch is null then raise exception 'Only an active branch manager or owner may view staff activity'; end if;

  return query
    select
      u.id, u.full_name::text,
      count(distinct s.id) filter (where s.sold_at >= date_trunc('day', now()))::integer,
      coalesce(sum(s.total_amount) filter (where s.sold_at >= date_trunc('day', now())), 0),
      count(distinct p.id) filter (where p.created_at >= date_trunc('day', now()))::integer
    from public.users u
    left join public.sales s on s.cashier_id = u.id and s.branch_id = v_branch
    left join public.patients p on p.created_by = u.id and p.branch_id = v_branch
    where u.branch_id = v_branch and u.role = 'seller'
    group by u.id, u.full_name
    order by u.full_name;
end;
$function$
;

-- ============================================================
-- list_stock_adjustments()
-- ============================================================
CREATE OR REPLACE FUNCTION public.list_stock_adjustments()
 RETURNS TABLE(id uuid, adjustment_type text, quantity integer, reason text, adjusted_at timestamp with time zone, product_name text, dosage text, batch_number text, performed_by_name text)
 LANGUAGE sql
 STABLE SECURITY DEFINER
 SET search_path TO ''
AS $function$
  select
    sa.id, sa.adjustment_type, sa.quantity, sa.reason, sa.adjusted_at,
    p.name, pv.dosage, sb.batch_number, u.full_name
  from public.stock_adjustments sa
  join public.stock_batches sb on sb.id = sa.stock_batch_id
  join public.product_variants pv on pv.id = sb.product_variant_id
  join public.products p on p.id = pv.product_id
  left join public.users u on u.id = sa.performed_by
  where sb.branch_id = public.current_branch_id()
  order by sa.adjusted_at desc
  limit 200
$function$
;

-- ============================================================
-- lookup_barcode(p_code text)
-- ============================================================
CREATE OR REPLACE FUNCTION public.lookup_barcode(p_code text)
 RETURNS TABLE(barcode_id uuid, code text, barcode_type text, status text, quantity_available integer, pieces_per_pack integer, child_count integer, child_pieces_per_pack integer, active_child_count integer, parent_code text, stock_batch_id uuid, batch_number text, expiry_date date, delivery_code text, selling_price numeric, cost_price numeric, product_id uuid, product_name text, tax_rate_id uuid, dosage text, form text, manufacturer_name text, supplier_name text)
 LANGUAGE sql
 STABLE SECURITY DEFINER
 SET search_path TO ''
AS $function$
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
    sb.cost_price,
    p.id,
    p.name::text,
    p.tax_rate_id,
    pv.dosage::text,
    pv.form::text,
    sb.manufacturer_name::text,
    s.supplier_name::text
  from public.barcodes bc
  join public.stock_batches sb on sb.id = bc.stock_batch_id
  join public.product_variants pv on pv.id = sb.product_variant_id
  join public.products p on p.id = pv.product_id
  left join public.barcodes parent on parent.id = bc.parent_barcode_id
  left join public.suppliers s on s.id = sb.supplier_id
  where upper(bc.code) = upper(btrim(p_code))
    and (
      public.is_super_admin()
      or sb.branch_id = public.current_branch_id()
    )
  limit 1
$function$
;

-- ============================================================
-- public_platform_stats()
-- ============================================================
CREATE OR REPLACE FUNCTION public.public_platform_stats()
 RETURNS TABLE(active_branches integer, tracked_skus integer, cities integer)
 LANGUAGE sql
 STABLE SECURITY DEFINER
 SET search_path TO ''
AS $function$
  select
    (select count(*)::integer from public.branches where status = 'active'),
    (select count(distinct pv.id)::integer
       from public.product_variants pv
       join public.stock_batches sb on sb.product_variant_id = pv.id),
    (select count(distinct upper(btrim(split_part(b.address, ',', 1))))::integer
       from public.branches b
       where b.status = 'active' and nullif(btrim(b.address), '') is not null)
$function$
;

-- ============================================================
-- receive_stock_delivery(p_supplier_name text, p_notes text, p_lines jsonb)
-- ============================================================
CREATE OR REPLACE FUNCTION public.receive_stock_delivery(p_supplier_name text, p_notes text, p_lines jsonb)
 RETURNS TABLE(delivery_id uuid, delivery_code text)
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''
AS $function$
declare
  v_branch uuid;
  v_user uuid := (select auth.uid());
  v_delivery uuid := gen_random_uuid();
  v_supplier uuid;
  v_code text;
  line jsonb;
  v_batch uuid;
  v_category uuid;
  v_existing_category uuid;
  v_existing_category_name text;
  v_product uuid;
  v_variant uuid;
  v_cartons integer;
  v_packs integer;
  v_pieces integer;
begin
  select u.branch_id into v_branch
  from public.users u
  where u.id = v_user and u.is_active;

  if v_branch is null or not exists (
    select 1 from public.users u
    where u.id = v_user and u.role in ('owner','manager')
  ) then
    raise exception 'Only an active branch manager or owner may receive stock';
  end if;

  if exists (select 1 from public.branches b where b.id = v_branch and b.status <> 'active') then
    raise exception 'This pharmacy is not active';
  end if;

  if jsonb_typeof(p_lines) <> 'array' or jsonb_array_length(p_lines) = 0 then
    raise exception 'At least one delivery line is required';
  end if;
  if nullif(btrim(p_supplier_name), '') is null then
    raise exception 'Supplier name is required';
  end if;

  select s.id into v_supplier
  from public.suppliers s
  where s.branch_id = v_branch
    and lower(s.supplier_name) = lower(btrim(p_supplier_name));
  if v_supplier is null then
    insert into public.suppliers (supplier_name, branch_id)
    values (btrim(p_supplier_name), v_branch)
    returning id into v_supplier;
  end if;

  v_code := format('DEL-%s-%s', to_char(now(), 'YYYYMMDD'), upper(substr(replace(v_delivery::text, '-', ''), 1, 6)));

  insert into public.stock_deliveries (id, branch_id, supplier_id, delivery_code, received_by, notes)
  values (v_delivery, v_branch, v_supplier, v_code, v_user, p_notes);

  for line in select * from jsonb_array_elements(p_lines) loop
    v_cartons := coalesce((line->>'cartons')::integer, 0);
    v_packs := greatest(coalesce((line->>'packs_per_carton')::integer, (line->>'packs')::integer, 1), 1);
    v_pieces := greatest(coalesce((line->>'pieces_per_pack')::integer, 1), 1);

    if nullif(line->>'product_variant_id', '') is null then
      raise exception 'This line has no product selected. Use "Request new product" for a product that is not yet in the catalogue -- branches can no longer add products directly.';
    end if;

    v_variant := (line->>'product_variant_id')::uuid;
    select pv.product_id into v_product from public.product_variants pv where pv.id = v_variant;
    if v_product is null then raise exception 'Unknown product variant'; end if;

    if nullif(btrim(coalesce(line->>'category_name','')), '') is not null then
      insert into public.product_categories (branch_id, name)
      values (v_branch, btrim(line->>'category_name'))
      on conflict (branch_id, name) do update set name = excluded.name
      returning id into v_category;

      -- A product's category is a fact about the product at this branch, not
      -- about this one delivery -- it is set once and locked, not silently
      -- moved every time it happens to be received under a different name.
      select bpc.category_id into v_existing_category
      from public.branch_product_categorization bpc
      where bpc.branch_id = v_branch and bpc.product_id = v_product;

      if v_existing_category is null then
        insert into public.branch_product_categorization (branch_id, product_id, category_id)
        values (v_branch, v_product, v_category);
      elsif v_existing_category <> v_category then
        select pc.name into v_existing_category_name
        from public.product_categories pc
        where pc.id = v_existing_category;
        raise exception 'This product does not belong to the category you chose. It belongs to "%" for this branch -- choose "%", or ask an admin to recategorize it first.',
          v_existing_category_name, v_existing_category_name;
      end if;
      -- else: already filed under this same category, nothing to change.
    end if;

    v_batch := public.create_stock_batch_with_barcodes(
      v_variant, v_branch, v_supplier, nullif(btrim(coalesce(line->>'manufacturer_name','')), ''),
      v_delivery, v_code, v_user, btrim(line->>'batch_number'), (line->>'expiry_date')::date,
      (line->>'cost_price')::numeric, (line->>'selling_price')::numeric, v_cartons, v_packs, v_pieces
    );
  end loop;

  return query select v_delivery, v_code;
end;
$function$
;

-- ============================================================
-- save_sales_forecast_snapshot(p_product_id uuid, p_category_id uuid, p_bucket text, p_points jsonb)
-- ============================================================
CREATE OR REPLACE FUNCTION public.save_sales_forecast_snapshot(p_product_id uuid DEFAULT NULL::uuid, p_category_id uuid DEFAULT NULL::uuid, p_bucket text DEFAULT 'month'::text, p_points jsonb DEFAULT '[]'::jsonb)
 RETURNS void
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''
AS $function$
declare
  v_branch uuid := public.current_branch_id();
  v_nil uuid := '00000000-0000-0000-0000-000000000000';
begin
  perform public.assert_owner_or_manager();
  if v_branch is null then raise exception 'No active branch for this session'; end if;
  if p_product_id is not null and p_category_id is not null then
    raise exception 'Pass product_id or category_id, not both';
  end if;
  if p_bucket not in ('day','week','month') then raise exception 'bucket must be day, week or month'; end if;

  update public.sales_forecast_snapshots
  set generated_at = now(), bucket = p_bucket, points = p_points
  where branch_id = v_branch
    and coalesce(product_id, v_nil) = coalesce(p_product_id, v_nil)
    and coalesce(category_id, v_nil) = coalesce(p_category_id, v_nil)
    and generated_at::date = current_date;

  if not found then
    insert into public.sales_forecast_snapshots (branch_id, product_id, category_id, bucket, points)
    values (v_branch, p_product_id, p_category_id, p_bucket, p_points);
  end if;
end;
$function$
;

-- ============================================================
-- set_sale_receipt_note(p_sale_id uuid, p_note text)
-- ============================================================
CREATE OR REPLACE FUNCTION public.set_sale_receipt_note(p_sale_id uuid, p_note text)
 RETURNS void
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''
AS $function$
declare
  v_branch uuid;
begin
  select u.branch_id into v_branch from public.users u where u.id = (select auth.uid()) and u.is_active;
  if v_branch is null then
    raise exception 'Only an active branch user may edit a receipt';
  end if;

  update public.sales
  set receipt_note = nullif(btrim(coalesce(p_note, '')), '')
  where id = p_sale_id and branch_id = v_branch;

  if not found then
    raise exception 'Sale not found for this branch';
  end if;
end;
$function$
;

-- ============================================================
-- stamp_sale_insurer_tin()
-- ============================================================
CREATE OR REPLACE FUNCTION public.stamp_sale_insurer_tin()
 RETURNS trigger
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''
AS $function$
begin
  update public.sales s
  set insurer_tin = ip.tin
  from public.insurance_providers ip
  where s.id = new.sale_id
    and ip.id = new.insurance_provider_id;
  return new;
end;
$function$
;

-- ============================================================
-- stamp_sale_patient_identifiers()
-- ============================================================
CREATE OR REPLACE FUNCTION public.stamp_sale_patient_identifiers()
 RETURNS trigger
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''
AS $function$
begin
  if new.patient_id is not null then
    select p.phone, p.tin into new.patient_phone, new.patient_tin
    from public.patients p
    where p.id = new.patient_id;
  end if;
  return new;
end;
$function$
;

-- ============================================================
-- submit_pharmacy_registration(p_pharmacy_name text, p_phone text, p_email text, p_location text)
-- ============================================================
CREATE OR REPLACE FUNCTION public.submit_pharmacy_registration(p_pharmacy_name text, p_phone text, p_email text, p_location text)
 RETURNS TABLE(application_id uuid, application_code text)
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''
AS $function$
  declare
    v_id uuid := gen_random_uuid();
    v_code text;
    v_email text := lower(btrim(p_email));
  begin
    if nullif(btrim(p_pharmacy_name), '') is null
      or nullif(btrim(p_phone), '') is null
      or v_email is null
      or v_email !~ '^[^@]+@[^@]+\.[^@]+$'
      or nullif(btrim(p_location), '') is null then
      raise exception 'Pharmacy name, phone, email and location are required';
    end if;

    if exists (
      select 1 from public.users u where lower(u.email) = v_email
    ) or exists (
      select 1 from public.branch_applications a
      where lower(a.email) = v_email and a.status in ('pending','otp_sent','active')
    ) then
      raise exception 'This email is already registered or awaiting approval';
    end if;

    v_code := format(
      'APP-%s-%s',
      to_char(now(), 'YYYYMMDD'),
      upper(substr(replace(v_id::text, '-', ''), 1, 6))
    );

    insert into public.branch_applications (
      id, application_code, pharmacy_name, phone, email, location, status
    ) values (
      v_id, v_code, btrim(p_pharmacy_name), btrim(p_phone), v_email, btrim(p_location), 'pending'
    );

    return query select v_id, v_code;
  end;
  $function$
;

-- ============================================================
-- submit_product_request(p_message text, p_image_path text)
-- ============================================================
CREATE OR REPLACE FUNCTION public.submit_product_request(p_message text, p_image_path text DEFAULT NULL::text)
 RETURNS uuid
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''
AS $function$
declare
  v_user uuid := (select auth.uid());
  v_branch uuid;
  v_id uuid;
begin
  select u.branch_id into v_branch from public.users u where u.id = v_user and u.is_active;
  if v_branch is null then raise exception 'Only an active branch user may request a product'; end if;
  if nullif(btrim(coalesce(p_message, '')), '') is null then
    raise exception 'Describe the product you need';
  end if;

  insert into public.product_requests (branch_id, requested_by, message, image_path)
  values (v_branch, v_user, btrim(p_message), nullif(btrim(coalesce(p_image_path, '')), ''))
  returning id into v_id;

  return v_id;
end;
$function$
;

-- ============================================================
-- submit_support_ticket(p_subject text, p_description text, p_priority text)
-- ============================================================
CREATE OR REPLACE FUNCTION public.submit_support_ticket(p_subject text, p_description text, p_priority text DEFAULT 'medium'::text)
 RETURNS uuid
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''
AS $function$
declare
  v_user uuid := (select auth.uid());
  v_branch uuid;
  v_priority text;
  v_id uuid;
begin
  select u.branch_id into v_branch from public.users u where u.id = v_user and u.is_active;
  if v_branch is null then raise exception 'Only an active branch user may submit a ticket'; end if;
  if nullif(btrim(coalesce(p_subject, '')), '') is null then raise exception 'A subject is required'; end if;

  v_priority := coalesce(nullif(p_priority, ''), 'medium');
  if v_priority not in ('low','medium','high') then v_priority := 'medium'; end if;

  insert into public.support_tickets (branch_id, raised_by, subject, description, priority)
  values (v_branch, v_user, btrim(p_subject), nullif(btrim(coalesce(p_description, '')), ''), v_priority)
  returning id into v_id;

  return v_id;
end;
$function$
;

-- ============================================================
-- update_branch_category(p_category_id uuid, p_name text, p_description text)
-- ============================================================
CREATE OR REPLACE FUNCTION public.update_branch_category(p_category_id uuid, p_name text, p_description text DEFAULT NULL::text)
 RETURNS void
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''
AS $function$
declare
  v_branch uuid := public.current_branch_id();
begin
  perform public.assert_owner_or_manager();
  if v_branch is null then raise exception 'No active branch for this session'; end if;
  if nullif(btrim(coalesce(p_name, '')), '') is null then raise exception 'A category name is required'; end if;

  update public.product_categories
  set name = btrim(p_name), description = nullif(btrim(coalesce(p_description, '')), '')
  where id = p_category_id and branch_id = v_branch;
  if not found then raise exception 'Category not found for this branch'; end if;
exception
  when unique_violation then
    raise exception 'A category named "%" already exists for this branch.', btrim(p_name);
end;
$function$
;

-- ============================================================
-- update_branch_details(p_address text, p_phone text, p_tin text, p_logo_path text, p_bank_account_number text, p_bank_account_name text, p_momo_pay_number text)
-- ============================================================
CREATE OR REPLACE FUNCTION public.update_branch_details(p_address text, p_phone text, p_tin text, p_logo_path text DEFAULT NULL::text, p_bank_account_number text DEFAULT NULL::text, p_bank_account_name text DEFAULT NULL::text, p_momo_pay_number text DEFAULT NULL::text)
 RETURNS void
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''
AS $function$
declare
  v_branch uuid;
begin
  select u.branch_id into v_branch
  from public.users u
  where u.id = (select auth.uid()) and u.is_active and u.role = 'owner';
  if v_branch is null then raise exception 'Only the branch owner may update branch settings'; end if;

  update public.branches
  set address = nullif(btrim(coalesce(p_address, '')), ''),
      phone = nullif(btrim(coalesce(p_phone, '')), ''),
      tin = nullif(btrim(coalesce(p_tin, '')), ''),
      logo_path = nullif(btrim(coalesce(p_logo_path, '')), ''),
      bank_account_number = nullif(btrim(coalesce(p_bank_account_number, '')), ''),
      bank_account_name = nullif(btrim(coalesce(p_bank_account_name, '')), ''),
      momo_pay_number = nullif(btrim(coalesce(p_momo_pay_number, '')), '')
  where id = v_branch;
end;
$function$
;

-- ============================================================
-- update_branch_details(p_address text, p_phone text, p_tin text, p_logo_path text, p_bank_account_number text, p_bank_account_name text, p_momo_pay_number text, p_out_of_stock_reminder_hours integer, p_name text, p_email text, p_website text, p_license_number text, p_license_expiry_date date, p_ebm_device_serial text, p_default_language text, p_receipt_number_prefix text, p_pos_cash_enabled boolean, p_pos_mtn_momo_enabled boolean, p_pos_airtel_money_enabled boolean, p_pos_card_enabled boolean, p_pos_insurance_enabled boolean, p_pos_default_payment_method text, p_pos_require_patient_name boolean, p_pos_allow_discounts boolean, p_pos_show_patient_history boolean, p_expiry_alert_threshold_days integer, p_default_reorder_min integer)
-- ============================================================
CREATE OR REPLACE FUNCTION public.update_branch_details(p_address text, p_phone text, p_tin text, p_logo_path text DEFAULT NULL::text, p_bank_account_number text DEFAULT NULL::text, p_bank_account_name text DEFAULT NULL::text, p_momo_pay_number text DEFAULT NULL::text, p_out_of_stock_reminder_hours integer DEFAULT NULL::integer, p_name text DEFAULT NULL::text, p_email text DEFAULT NULL::text, p_website text DEFAULT NULL::text, p_license_number text DEFAULT NULL::text, p_license_expiry_date date DEFAULT NULL::date, p_ebm_device_serial text DEFAULT NULL::text, p_default_language text DEFAULT NULL::text, p_receipt_number_prefix text DEFAULT NULL::text, p_pos_cash_enabled boolean DEFAULT NULL::boolean, p_pos_mtn_momo_enabled boolean DEFAULT NULL::boolean, p_pos_airtel_money_enabled boolean DEFAULT NULL::boolean, p_pos_card_enabled boolean DEFAULT NULL::boolean, p_pos_insurance_enabled boolean DEFAULT NULL::boolean, p_pos_default_payment_method text DEFAULT NULL::text, p_pos_require_patient_name boolean DEFAULT NULL::boolean, p_pos_allow_discounts boolean DEFAULT NULL::boolean, p_pos_show_patient_history boolean DEFAULT NULL::boolean, p_expiry_alert_threshold_days integer DEFAULT NULL::integer, p_default_reorder_min integer DEFAULT NULL::integer)
 RETURNS void
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''
AS $function$
declare
  v_branch uuid;
begin
  select u.branch_id into v_branch
  from public.users u
  where u.id = (select auth.uid()) and u.is_active and u.role = 'owner';
  if v_branch is null then raise exception 'Only the branch owner may update branch settings'; end if;

  if p_out_of_stock_reminder_hours is not null and (p_out_of_stock_reminder_hours < 1 or p_out_of_stock_reminder_hours > 168) then
    raise exception 'Reminder interval must be between 1 and 168 hours';
  end if;
  if p_default_language is not null and p_default_language not in ('en','fr','rw') then
    raise exception 'Unsupported language %', p_default_language;
  end if;
  if p_pos_default_payment_method is not null and p_pos_default_payment_method not in ('cash','mtn_momo','airtel_money','card') then
    raise exception 'Unsupported default payment method %', p_pos_default_payment_method;
  end if;
  if p_expiry_alert_threshold_days is not null and p_expiry_alert_threshold_days < 1 then
    raise exception 'Expiry alert threshold must be at least 1 day';
  end if;
  if p_default_reorder_min is not null and p_default_reorder_min < 0 then
    raise exception 'Default reorder minimum cannot be negative';
  end if;

  update public.branches
  set address = nullif(btrim(coalesce(p_address, '')), ''),
      phone = nullif(btrim(coalesce(p_phone, '')), ''),
      tin = nullif(btrim(coalesce(p_tin, '')), ''),
      -- NULL parameter = leave unchanged; '' = clear; anything else = set.
      logo_path = case when p_logo_path is null then logo_path else nullif(btrim(p_logo_path), '') end,
      bank_account_number = case when p_bank_account_number is null then bank_account_number else nullif(btrim(p_bank_account_number), '') end,
      bank_account_name = case when p_bank_account_name is null then bank_account_name else nullif(btrim(p_bank_account_name), '') end,
      momo_pay_number = case when p_momo_pay_number is null then momo_pay_number else nullif(btrim(p_momo_pay_number), '') end,
      out_of_stock_reminder_hours = coalesce(p_out_of_stock_reminder_hours, out_of_stock_reminder_hours),
      name = coalesce(nullif(btrim(coalesce(p_name, '')), ''), name),
      email = case when p_email is null then email else nullif(btrim(p_email), '') end,
      website = case when p_website is null then website else nullif(btrim(p_website), '') end,
      license_number = case when p_license_number is null then license_number else nullif(btrim(p_license_number), '') end,
      license_expiry_date = p_license_expiry_date,
      ebm_device_serial = case when p_ebm_device_serial is null then ebm_device_serial else nullif(btrim(p_ebm_device_serial), '') end,
      default_language = coalesce(p_default_language, default_language),
      receipt_number_prefix = coalesce(nullif(btrim(coalesce(p_receipt_number_prefix, '')), ''), receipt_number_prefix),
      pos_cash_enabled = coalesce(p_pos_cash_enabled, pos_cash_enabled),
      pos_mtn_momo_enabled = coalesce(p_pos_mtn_momo_enabled, pos_mtn_momo_enabled),
      pos_airtel_money_enabled = coalesce(p_pos_airtel_money_enabled, pos_airtel_money_enabled),
      pos_card_enabled = coalesce(p_pos_card_enabled, pos_card_enabled),
      pos_insurance_enabled = coalesce(p_pos_insurance_enabled, pos_insurance_enabled),
      pos_default_payment_method = coalesce(p_pos_default_payment_method, pos_default_payment_method),
      pos_require_patient_name = coalesce(p_pos_require_patient_name, pos_require_patient_name),
      pos_allow_discounts = coalesce(p_pos_allow_discounts, pos_allow_discounts),
      pos_show_patient_history = coalesce(p_pos_show_patient_history, pos_show_patient_history),
      expiry_alert_threshold_days = coalesce(p_expiry_alert_threshold_days, expiry_alert_threshold_days),
      default_reorder_min = coalesce(p_default_reorder_min, default_reorder_min)
  where id = v_branch;
end;
$function$
;

-- ============================================================
-- upsert_patient(p_full_name text, p_gender text, p_age integer, p_phone text, p_tin text, p_insurance_number text)
-- ============================================================
CREATE OR REPLACE FUNCTION public.upsert_patient(p_full_name text, p_gender text, p_age integer, p_phone text, p_tin text DEFAULT NULL::text, p_insurance_number text DEFAULT NULL::text)
 RETURNS uuid
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''
AS $function$
declare
  v_user   uuid := (select auth.uid());
  v_branch uuid;
  v_phone  text := nullif(btrim(coalesce(p_phone, '')), '');
  v_tin    text := nullif(btrim(coalesce(p_tin, '')), '');
  v_ins    text := nullif(btrim(coalesce(p_insurance_number, '')), '');
  v_id     uuid;
begin
  select u.branch_id into v_branch from public.users u where u.id = v_user and u.is_active;
  if v_branch is null then raise exception 'Only an active branch user may record a patient'; end if;
  if nullif(btrim(coalesce(p_full_name, '')), '') is null then raise exception 'A patient name is required'; end if;
  if v_phone is null then raise exception 'A phone number is required'; end if;
  if p_gender is not null and p_gender not in ('male','female','other') then raise exception 'Unknown gender'; end if;

  insert into public.patients (branch_id, full_name, gender, age, tin_or_phone, phone, tin, insurance_number, created_by)
  values (v_branch, btrim(p_full_name), p_gender, p_age, v_phone, v_phone, v_tin, v_ins, v_user)
  on conflict (branch_id, tin_or_phone)
  do update set
    full_name  = excluded.full_name,
    gender     = excluded.gender,
    age        = excluded.age,
    phone      = excluded.phone,
    -- Never blank an existing value just because this visit did not retype it.
    tin              = coalesce(excluded.tin, public.patients.tin),
    insurance_number = coalesce(excluded.insurance_number, public.patients.insurance_number),
    updated_at = now()
  returning id into v_id;

  return v_id;
end;
$function$
;

-- ============================================================
-- upsert_patient(p_full_name text, p_gender text, p_age integer, p_tin_or_phone text)
-- ============================================================
CREATE OR REPLACE FUNCTION public.upsert_patient(p_full_name text, p_gender text, p_age integer, p_tin_or_phone text)
 RETURNS uuid
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''
AS $function$
declare
  v_user uuid := (select auth.uid());
  v_branch uuid;
  v_id uuid;
begin
  select u.branch_id into v_branch from public.users u where u.id = v_user and u.is_active;
  if v_branch is null then raise exception 'Only an active branch user may record a patient'; end if;
  if nullif(btrim(coalesce(p_full_name, '')), '') is null then raise exception 'A patient name is required'; end if;
  if nullif(btrim(coalesce(p_tin_or_phone, '')), '') is null then raise exception 'A phone number or TIN is required'; end if;
  if p_gender is not null and p_gender not in ('male','female','other') then raise exception 'Unknown gender'; end if;

  insert into public.patients (branch_id, full_name, gender, age, tin_or_phone, created_by)
  values (v_branch, btrim(p_full_name), p_gender, p_age, btrim(p_tin_or_phone), v_user)
  on conflict (branch_id, tin_or_phone)
  do update set full_name = excluded.full_name, gender = excluded.gender, age = excluded.age, updated_at = now()
  returning id into v_id;

  return v_id;
end;
$function$
;