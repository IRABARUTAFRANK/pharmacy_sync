-- ============================================================
-- TABLE: barcodes
-- ============================================================
  id uuid not null default gen_random_uuid()
  stock_batch_id uuid not null
  parent_barcode_id uuid
  barcode_type character varying(10) not null default 'pack'::character varying
  code character varying(64) not null
  code_source character varying(20) not null default 'generated'::character varying
  child_count integer
  pieces_per_pack integer
  quantity_available integer not null
  status character varying(20) not null default 'active'::character varying
  created_at timestamp with time zone not null default now()
  PRIMARY KEY: id
  FOREIGN KEYS: stock_batch_id -> stock_batches.id, parent_barcode_id -> barcodes.id
  RLS POLICIES:
  barcodes access (SELECT, roles: authenticated)
  barcodes update own branch (UPDATE, roles: authenticated)
  barcodes write own branch (INSERT, roles: authenticated)

-- ============================================================
-- TABLE: batch_recalls
-- ============================================================
  id uuid not null default gen_random_uuid()
  product_variant_id uuid not null
  batch_number character varying(80) not null
  manufacturer_name character varying(150)
  reason text not null
  recalled_by uuid not null
  recalled_at timestamp with time zone not null default now()
  PRIMARY KEY: id
  FOREIGN KEYS: recalled_by -> users.id, product_variant_id -> product_variants.id
  RLS POLICIES:
  recalls readable (SELECT, roles: authenticated)

-- ============================================================
-- TABLE: branch_applications
-- ============================================================
  id uuid not null default gen_random_uuid()
  application_code character varying(32) not null
  pharmacy_name character varying(150) not null
  phone character varying(30) not null
  email character varying(150) not null
  location text not null
  status character varying(20) not null default 'pending'::character varying
  called_at timestamp with time zone
  denied_reason text
  branch_id uuid
  submitted_at timestamp with time zone not null default now()
  otp_sent_at timestamp with time zone
  PRIMARY KEY: id
  FOREIGN KEYS: branch_id -> branches.id
  RLS POLICIES:
  applications readable by holder or admin (SELECT, roles: anon,authenticated)
  super admin manage applications (ALL, roles: authenticated)

-- ============================================================
-- TABLE: branch_directory
-- ============================================================
  branch_id uuid not null
  display_name character varying(150) not null
  PRIMARY KEY: branch_id
  FOREIGN KEYS: branch_id -> branches.id
  RLS POLICIES:
  branch directory is readable before sign-in (SELECT, roles: anon,authenticated)

-- ============================================================
-- TABLE: branch_product_categorization
-- ============================================================
  branch_id uuid not null
  product_id uuid not null
  category_id uuid not null
  PRIMARY KEY: branch_id, product_id
  FOREIGN KEYS: category_id -> product_categories.branch_id, product_id -> products.id, branch_id -> branches.id, category_id -> product_categories.id, branch_id -> product_categories.branch_id, branch_id -> product_categories.id
  RLS POLICIES:
  categorization access (ALL, roles: authenticated)

-- ============================================================
-- TABLE: branch_settings
-- ============================================================
  id uuid not null default gen_random_uuid()
  branch_id uuid not null
  setting_key character varying(100) not null
  setting_value text
  updated_by uuid
  updated_at timestamp with time zone not null default now()
  PRIMARY KEY: id
  FOREIGN KEYS: updated_by -> users.id, branch_id -> branches.id
  RLS POLICIES:
  branch access (ALL, roles: authenticated)

-- ============================================================
-- TABLE: branches
-- ============================================================
  id uuid not null default gen_random_uuid()
  name character varying(150) not null
  address text
  phone character varying(30)
  created_at timestamp with time zone not null default now()
  email character varying(150)
  branch_code character varying(32)
  activation_code character varying(24)
  status character varying(20) not null default 'active'::character varying
  called_at timestamp with time zone
  locked_at timestamp with time zone
  failed_logins integer not null default 0
  denied_reason text
  tin character varying(20)
  logo_path text
  bank_account_number character varying(50)
  bank_account_name character varying(150)
  momo_pay_number character varying(50)
  out_of_stock_reminder_hours integer not null default 6
  website character varying(150)
  license_number character varying(50)
  license_expiry_date date
  ebm_device_serial character varying(50)
  default_language character varying(5) not null default 'en'::character varying
  receipt_number_prefix character varying(10) not null default 'RCT'::character varying
  pos_cash_enabled boolean not null default true
  pos_mtn_momo_enabled boolean not null default true
  pos_airtel_money_enabled boolean not null default true
  pos_card_enabled boolean not null default false
  pos_insurance_enabled boolean not null default true
  pos_default_payment_method character varying(20) not null default 'cash'::character varying
  pos_require_patient_name boolean not null default false
  pos_allow_discounts boolean not null default true
  pos_show_patient_history boolean not null default true
  expiry_alert_threshold_days integer not null default 60
  default_reorder_min integer not null default 0
  PRIMARY KEY: id
  RLS POLICIES:
  branch access (SELECT, roles: authenticated)

-- ============================================================
-- TABLE: dashboard_reports
-- ============================================================
  id uuid not null default gen_random_uuid()
  branch_id uuid not null
  report_type character varying(50) not null
  data jsonb not null default '{}'::jsonb
  generated_at timestamp with time zone not null default now()
  PRIMARY KEY: id
  FOREIGN KEYS: branch_id -> branches.id
  RLS POLICIES:
  branch access (ALL, roles: authenticated)

-- ============================================================
-- TABLE: deleted_branches_log
-- ============================================================
  id uuid not null default gen_random_uuid()
  branch_id uuid not null
  pharmacy_name character varying(150) not null
  phone character varying(30)
  email character varying(150)
  branch_code character varying(32)
  location text
  reason text
  deleted_by_email text
  deleted_at timestamp with time zone not null default now()
  PRIMARY KEY: id
  RLS POLICIES:
  super admin only (ALL, roles: authenticated)

-- ============================================================
-- TABLE: discounts
-- ============================================================
  id uuid not null default gen_random_uuid()
  name character varying(100) not null
  discount_type character varying(20) not null
  value numeric not null
  valid_from date
  valid_to date
  branch_id uuid
  PRIMARY KEY: id
  FOREIGN KEYS: branch_id -> branches.id
  RLS POLICIES:
  discounts readable (SELECT, roles: authenticated)

-- ============================================================
-- TABLE: insurance_claims
-- ============================================================
  id uuid not null default gen_random_uuid()
  sale_id uuid not null
  insurance_provider_id uuid not null
  coverage_percentage_applied numeric not null
  claim_amount numeric not null
  status character varying(20) not null default 'submitted'::character varying
  submitted_at timestamp with time zone not null default now()
  PRIMARY KEY: id
  FOREIGN KEYS: insurance_provider_id -> insurance_providers.id, sale_id -> sales.id
  RLS POLICIES:
  insurance claims branch access (SELECT, roles: authenticated)

-- ============================================================
-- TABLE: insurance_product_coverage
-- ============================================================
  insurance_provider_id uuid not null
  product_id uuid not null
  coverage_percentage numeric not null
  PRIMARY KEY: insurance_provider_id, product_id
  FOREIGN KEYS: product_id -> products.id, insurance_provider_id -> insurance_providers.id
  RLS POLICIES:
  insurance coverage readable (SELECT, roles: authenticated)

-- ============================================================
-- TABLE: insurance_providers
-- ============================================================
  id uuid not null default gen_random_uuid()
  name character varying(150) not null
  contact_info text
  default_coverage_percentage numeric not null default 0
  tin character varying(50)
  PRIMARY KEY: id
  RLS POLICIES:
  insurance providers readable (SELECT, roles: authenticated)

-- ============================================================
-- TABLE: insurance_variant_prices
-- ============================================================
  insurance_provider_id uuid not null
  product_variant_id uuid not null
  fixed_price numeric not null
  PRIMARY KEY: insurance_provider_id, product_variant_id
  FOREIGN KEYS: insurance_provider_id -> insurance_providers.id, product_variant_id -> product_variants.id
  RLS POLICIES:
  insurance variant prices readable (SELECT, roles: authenticated)

-- ============================================================
-- TABLE: notifications
-- ============================================================
  id uuid not null default gen_random_uuid()
  branch_id uuid not null
  source_type character varying(30) not null
  source_id uuid not null
  message text not null
  is_read boolean not null default false
  created_at timestamp with time zone not null default now()
  PRIMARY KEY: id
  FOREIGN KEYS: branch_id -> branches.id
  RLS POLICIES:
  branch access (ALL, roles: authenticated)

-- ============================================================
-- TABLE: patients
-- ============================================================
  id uuid not null default gen_random_uuid()
  branch_id uuid not null
  full_name character varying(150) not null
  gender character varying(10)
  age integer
  tin_or_phone character varying(50) not null
  created_by uuid
  created_at timestamp with time zone not null default now()
  updated_at timestamp with time zone not null default now()
  phone character varying(50)
  tin character varying(50)
  insurance_number character varying(50)
  PRIMARY KEY: id
  FOREIGN KEYS: branch_id -> branches.id, created_by -> users.id
  RLS POLICIES:
  branch access (ALL, roles: authenticated)

-- ============================================================
-- TABLE: product_categories
-- ============================================================
  id uuid not null default gen_random_uuid()
  branch_id uuid not null
  name character varying(100) not null
  description text
  created_at timestamp with time zone not null default now()
  PRIMARY KEY: id
  FOREIGN KEYS: branch_id -> branches.id
  RLS POLICIES:
  branch access (ALL, roles: authenticated)
  categories access (ALL, roles: authenticated)

-- ============================================================
-- TABLE: product_requests
-- ============================================================
  id uuid not null default gen_random_uuid()
  branch_id uuid not null
  requested_by uuid not null
  message text not null
  image_path text
  status character varying(20) not null default 'pending'::character varying
  resolved_product_id uuid
  resolved_variant_id uuid
  resolved_by uuid
  resolved_at timestamp with time zone
  rejection_reason text
  created_at timestamp with time zone not null default now()
  PRIMARY KEY: id
  FOREIGN KEYS: resolved_by -> users.id, resolved_variant_id -> product_variants.id, requested_by -> users.id, branch_id -> branches.id, resolved_product_id -> products.id
  RLS POLICIES:
  branch access (ALL, roles: authenticated)

-- ============================================================
-- TABLE: product_variants
-- ============================================================
  id uuid not null default gen_random_uuid()
  product_id uuid not null
  dosage character varying(50)
  form character varying(50)
  unit character varying(30)
  created_at timestamp with time zone not null default now()
  PRIMARY KEY: id
  FOREIGN KEYS: product_id -> products.id
  RLS POLICIES:
  variants insert (INSERT, roles: authenticated)
  variants readable (SELECT, roles: authenticated)

-- ============================================================
-- TABLE: products
-- ============================================================
  id uuid not null default gen_random_uuid()
  tax_rate_id uuid not null
  product_type character varying(20) not null default 'medicine'::character varying
  name character varying(150) not null
  generic_name character varying(150)
  description text
  PRIMARY KEY: id
  FOREIGN KEYS: tax_rate_id -> tax_rates.id
  RLS POLICIES:
  products insert (INSERT, roles: authenticated)
  products readable (SELECT, roles: authenticated)

-- ============================================================
-- TABLE: receipts
-- ============================================================
  id uuid not null default gen_random_uuid()
  sale_id uuid not null
  receipt_number character varying(50) not null
  issued_at timestamp with time zone not null default now()
  PRIMARY KEY: id
  FOREIGN KEYS: sale_id -> sales.id
  RLS POLICIES:
  receipts branch access (SELECT, roles: authenticated)

-- ============================================================
-- TABLE: reorder_points
-- ============================================================
  id uuid not null default gen_random_uuid()
  product_id uuid not null
  branch_id uuid not null
  min_quantity integer not null default 0
  max_quantity integer
  PRIMARY KEY: id
  FOREIGN KEYS: branch_id -> branches.id, product_id -> products.id
  RLS POLICIES:
  branch access (ALL, roles: authenticated)

-- ============================================================
-- TABLE: sale_items
-- ============================================================
  id uuid not null default gen_random_uuid()
  sale_id uuid not null
  barcode_id uuid not null
  tax_rate_id uuid not null
  quantity integer not null default 1
  unit_price numeric not null
  subtotal numeric not null
  insurance_covered_amount numeric not null default 0
  PRIMARY KEY: id
  FOREIGN KEYS: barcode_id -> barcodes.id, sale_id -> sales.id, tax_rate_id -> tax_rates.id
  RLS POLICIES:
  sale items branch access (SELECT, roles: authenticated)

-- ============================================================
-- TABLE: sales
-- ============================================================
  id uuid not null default gen_random_uuid()
  branch_id uuid not null
  cashier_id uuid not null
  discount_id uuid
  total_amount numeric not null
  sold_at timestamp with time zone not null default now()
  patient_id uuid
  payment_method character varying(20)
  patient_phone character varying(50)
  patient_tin character varying(50)
  insurer_tin character varying(50)
  receipt_note character varying(500)
  PRIMARY KEY: id
  FOREIGN KEYS: cashier_id -> users.id, discount_id -> discounts.id, branch_id -> branches.id, patient_id -> patients.id
  RLS POLICIES:
  branch access (ALL, roles: authenticated)
  sales branch access (SELECT, roles: authenticated)

-- ============================================================
-- TABLE: sales_forecast_snapshots
-- ============================================================
  id uuid not null default gen_random_uuid()
  branch_id uuid not null
  product_id uuid
  category_id uuid
  generated_at timestamp with time zone not null default now()
  bucket text not null
  points jsonb not null
  notified_at timestamp with time zone
  PRIMARY KEY: id
  FOREIGN KEYS: branch_id -> branches.id, category_id -> product_categories.id, product_id -> products.id
  RLS POLICIES: (none)

-- ============================================================
-- TABLE: sales_forecasts
-- ============================================================
  id uuid not null default gen_random_uuid()
  branch_id uuid not null
  product_variant_id uuid not null
  forecast_period character varying(20) not null
  predicted_quantity integer not null
  generated_at timestamp with time zone not null default now()
  PRIMARY KEY: id
  FOREIGN KEYS: branch_id -> branches.id, product_variant_id -> product_variants.id
  RLS POLICIES:
  branch access (ALL, roles: authenticated)

-- ============================================================
-- TABLE: stock_adjustments
-- ============================================================
  id uuid not null default gen_random_uuid()
  stock_batch_id uuid
  barcode_id uuid
  adjustment_type character varying(30) not null
  quantity integer not null
  reason text
  performed_by uuid not null
  adjusted_at timestamp with time zone not null default now()
  PRIMARY KEY: id
  FOREIGN KEYS: barcode_id -> barcodes.id, performed_by -> users.id, stock_batch_id -> stock_batches.id
  RLS POLICIES:
  adjustments access (SELECT, roles: authenticated)

-- ============================================================
-- TABLE: stock_batches
-- ============================================================
  id uuid not null default gen_random_uuid()
  product_variant_id uuid not null
  branch_id uuid not null
  supplier_id uuid
  manufacturer_name character varying(150)
  delivery_code character varying(80)
  logged_by uuid not null
  batch_number character varying(80) not null
  expiry_date date not null
  cost_price numeric not null
  selling_price numeric not null
  quantity_received integer not null
  received_at timestamp with time zone not null default now()
  delivery_id uuid
  expiry_warned_at timestamp with time zone
  PRIMARY KEY: id
  FOREIGN KEYS: product_variant_id -> product_variants.id, delivery_id -> stock_deliveries.id, logged_by -> users.id, supplier_id -> suppliers.id, branch_id -> branches.id
  RLS POLICIES:
  branch access (ALL, roles: authenticated)

-- ============================================================
-- TABLE: stock_deliveries
-- ============================================================
  id uuid not null default gen_random_uuid()
  branch_id uuid not null
  supplier_id uuid not null
  delivery_code character varying(80) not null
  received_by uuid not null
  received_at timestamp with time zone not null default now()
  notes text
  created_at timestamp with time zone not null default now()
  PRIMARY KEY: id
  FOREIGN KEYS: supplier_id -> suppliers.id, received_by -> users.id, branch_id -> branches.id
  RLS POLICIES:
  delivery access (ALL, roles: authenticated)

-- ============================================================
-- TABLE: suppliers
-- ============================================================
  id uuid not null default gen_random_uuid()
  supplier_name character varying(150) not null
  contact character varying(150)
  location character varying(150)
  created_at timestamp with time zone not null default now()
  branch_id uuid
  PRIMARY KEY: id
  FOREIGN KEYS: branch_id -> branches.id
  RLS POLICIES:
  suppliers access (ALL, roles: authenticated)

-- ============================================================
-- TABLE: support_tickets
-- ============================================================
  id uuid not null default gen_random_uuid()
  branch_id uuid not null
  raised_by uuid not null
  subject character varying(150) not null
  description text
  status character varying(20) not null default 'open'::character varying
  created_at timestamp with time zone not null default now()
  priority character varying(10) not null default 'medium'::character varying
  PRIMARY KEY: id
  FOREIGN KEYS: raised_by -> users.id, branch_id -> branches.id
  RLS POLICIES:
  branch access (ALL, roles: authenticated)

-- ============================================================
-- TABLE: tax_rates
-- ============================================================
  id uuid not null default gen_random_uuid()
  name character varying(80) not null
  rate_percentage numeric not null default 0
  PRIMARY KEY: id
  RLS POLICIES:
  tax rates readable (SELECT, roles: authenticated)

-- ============================================================
-- TABLE: users
-- ============================================================
  id uuid not null
  branch_id uuid not null
  full_name character varying(150) not null
  email character varying(150) not null
  role character varying(30) not null default 'staff'::character varying
  is_active boolean not null default true
  created_at timestamp with time zone not null default now()
  PRIMARY KEY: id
  FOREIGN KEYS: branch_id -> branches.id
  RLS POLICIES:
  users read own branch (SELECT, roles: authenticated)
