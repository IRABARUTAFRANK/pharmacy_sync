-- ============================================================
-- Pharmacy ERP Database Schema (PostgreSQL) — Final Version
-- ============================================================
CREATE EXTENSION IF NOT EXISTS pgcrypto;

-- ============================================================
-- CORE / CATALOG
-- ============================================================

CREATE TABLE branches (
    id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    name            VARCHAR(150) NOT NULL,
    address         TEXT,
    phone           VARCHAR(30),
    created_at      TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE users (
    id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    branch_id       UUID NOT NULL UNIQUE REFERENCES branches(id), -- MVP: one user per branch
    full_name       VARCHAR(150) NOT NULL,
    email           VARCHAR(150) NOT NULL UNIQUE,
    password_hash   TEXT NOT NULL,
    otp             VARCHAR(10),
    role            VARCHAR(30) NOT NULL DEFAULT 'staff',
    is_active       BOOLEAN NOT NULL DEFAULT TRUE,
    created_at      TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE branch_settings (
    id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    branch_id       UUID NOT NULL REFERENCES branches(id),
    setting_key     VARCHAR(100) NOT NULL,
    setting_value   TEXT,
    updated_by      UUID REFERENCES users(id),
    updated_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
    UNIQUE (branch_id, setting_key)
);

CREATE TABLE tax_rates (
    id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    name            VARCHAR(80) NOT NULL,           -- e.g. 'Standard VAT', 'Exempt'
    rate_percentage NUMERIC(5,2) NOT NULL DEFAULT 0 -- 'Exempt' is just a row with 0
);

-- Branch-owned: each category belongs to exactly one branch, private by
-- default. Two branches can each create "Antibiotics" as separate rows.
CREATE TABLE product_categories (
    id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    branch_id       UUID NOT NULL REFERENCES branches(id),
    name            VARCHAR(100) NOT NULL,
    description     TEXT,
    UNIQUE (branch_id, name)  -- unique within a branch, not globally
);

CREATE TABLE products (
    id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    tax_rate_id     UUID NOT NULL REFERENCES tax_rates(id),
    product_type    VARCHAR(20) NOT NULL DEFAULT 'medicine'
        CHECK (product_type IN ('medicine', 'supply', 'other')),
    name            VARCHAR(150) NOT NULL,
    generic_name    VARCHAR(150),
    description     TEXT
    -- no category_id here: categorization is branch-specific, see below
);

CREATE TABLE product_variants (
    id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    product_id      UUID NOT NULL REFERENCES products(id),
    dosage          VARCHAR(50),
    form            VARCHAR(50),
    unit            VARCHAR(30),
    created_at      TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE reorder_points (
    id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    product_id      UUID NOT NULL REFERENCES products(id),
    branch_id       UUID NOT NULL REFERENCES branches(id),
    min_quantity    INTEGER NOT NULL DEFAULT 0,
    max_quantity    INTEGER,
    UNIQUE (product_id, branch_id)
);

-- Replaces the old branch_products AND branch_product_categories.
-- One row = "this branch carries this product, filed under this category."
-- category_id must belong to the same branch_id — enforce this at the
-- app layer (only offer that branch's own categories in the dropdown).
CREATE TABLE branch_product_categorization (
    branch_id       UUID NOT NULL REFERENCES branches(id),
    product_id      UUID NOT NULL REFERENCES products(id),
    category_id     UUID NOT NULL REFERENCES product_categories(id),
    PRIMARY KEY (branch_id, product_id)
);

-- ============================================================
-- STOCK / BARCODE
-- ============================================================

-- Global supplier list — not branch-scoped, so multiple branches
-- can share the same distributor record instead of duplicating it
CREATE TABLE suppliers (
    id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    supplier_name   VARCHAR(150) NOT NULL,
    contact         VARCHAR(150),
    location        VARCHAR(150),
    created_at      TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- One row per intake event, effectively one row per delivered product batch.
-- delivery_code groups multiple rows that arrived together WITHOUT a
-- separate deliveries table — every product logged in the same intake
-- session shares the same delivery_code.
CREATE TABLE stock_batches (
    id                  UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    product_variant_id  UUID NOT NULL REFERENCES product_variants(id),
    branch_id           UUID NOT NULL REFERENCES branches(id),
    supplier_id         UUID REFERENCES suppliers(id),      -- who we bought it from
    manufacturer_name   VARCHAR(150),                        -- who made it (for recalls)
    delivery_code       VARCHAR(80),                         -- groups same-shipment rows
    logged_by           UUID NOT NULL REFERENCES users(id),
    batch_number        VARCHAR(80) NOT NULL,
    expiry_date         DATE NOT NULL,
    cost_price          NUMERIC(12,2) NOT NULL,   -- per piece
    selling_price       NUMERIC(12,2) NOT NULL,   -- per piece
    quantity_received   INTEGER NOT NULL,
    received_at         TIMESTAMPTZ NOT NULL DEFAULT now(),
    UNIQUE (product_variant_id, batch_number, branch_id)
);

-- One row per scannable unit — either a 'box' (outer carton, parent) or a
-- 'pack' (small box, child). parent_barcode_id self-references to link a
-- pack back to the box it came in.
CREATE TABLE barcodes (
    id                  UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    stock_batch_id      UUID NOT NULL REFERENCES stock_batches(id),
    parent_barcode_id   UUID REFERENCES barcodes(id),  -- pack's parent box, if any
    barcode_type        VARCHAR(10) NOT NULL DEFAULT 'pack'
        CHECK (barcode_type IN ('box', 'pack')),
    code                VARCHAR(64) NOT NULL UNIQUE,
    code_source         VARCHAR(20) NOT NULL DEFAULT 'generated'
        CHECK (code_source IN ('manufacturer', 'generated')),
    child_count         INTEGER,  -- 'box' rows only: how many packs inside
    pieces_per_pack     INTEGER,  -- 'pack' rows only: pieces inside this pack
    quantity_available  INTEGER NOT NULL,
    status              VARCHAR(20) NOT NULL DEFAULT 'active',
        -- active | sold_out | expired | recalled | damaged
    created_at          TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- Targets a batch's real-world identity (product + lot + manufacturer),
-- NOT a single stock_batches row — so one recall cascades across every
-- branch that received the same lot.
CREATE TABLE batch_recalls (
    id                  UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    product_variant_id  UUID NOT NULL REFERENCES product_variants(id),
    batch_number        VARCHAR(80) NOT NULL,
    manufacturer_name   VARCHAR(150),
    reason              TEXT NOT NULL,
    recalled_by         UUID NOT NULL REFERENCES users(id),
    recalled_at         TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE stock_adjustments (
    id                  UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    stock_batch_id      UUID REFERENCES stock_batches(id),
    barcode_id          UUID REFERENCES barcodes(id),
    adjustment_type     VARCHAR(30) NOT NULL,
        -- damage | loss | correction | return | expired_writeoff | recalled
    quantity            INTEGER NOT NULL,
    reason              TEXT,
    performed_by        UUID NOT NULL REFERENCES users(id),
    adjusted_at         TIMESTAMPTZ NOT NULL DEFAULT now(),
    CHECK (stock_batch_id IS NOT NULL OR barcode_id IS NOT NULL)
);

-- Persistent, trackable alerts only. One-off UI feedback (e.g. "stock
-- saved successfully") is handled client-side and never written here.
CREATE TABLE notifications (
    id                  UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    branch_id           UUID NOT NULL REFERENCES branches(id),
    source_type         VARCHAR(30) NOT NULL,  -- batch_recall | stock_adjustment
    source_id           UUID NOT NULL,
    message             TEXT NOT NULL,
    is_read             BOOLEAN NOT NULL DEFAULT FALSE,
    created_at          TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- ============================================================
-- SALES
-- ============================================================

CREATE TABLE discounts (
    id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    name            VARCHAR(100) NOT NULL,
    discount_type   VARCHAR(20) NOT NULL,  -- percentage | fixed
    value           NUMERIC(12,2) NOT NULL,
    valid_from      DATE,
    valid_to        DATE
);

CREATE TABLE insurance_providers (
    id                          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    name                        VARCHAR(150) NOT NULL,
    contact_info                TEXT,
    default_coverage_percentage NUMERIC(5,2) NOT NULL DEFAULT 0
);

-- Only holds EXCEPTIONS to a provider's default coverage. A row existing
-- here IS the "differs" flag — no separate boolean needed.
CREATE TABLE insurance_product_coverage (
    insurance_provider_id  UUID NOT NULL REFERENCES insurance_providers(id),
    product_id              UUID NOT NULL REFERENCES products(id),
    coverage_percentage     NUMERIC(5,2) NOT NULL,
    PRIMARY KEY (insurance_provider_id, product_id)
);

CREATE TABLE sales (
    id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    branch_id       UUID NOT NULL REFERENCES branches(id),
    cashier_id      UUID NOT NULL REFERENCES users(id),
    discount_id     UUID REFERENCES discounts(id),
    total_amount    NUMERIC(12,2) NOT NULL,
    sold_at         TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- tax_rate_id lives HERE, not on sales, since one transaction can mix
-- exempt and taxed items. Defaults from the product but can be
-- overridden per line if the cashier needs to.
CREATE TABLE sale_items (
    id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    sale_id         UUID NOT NULL REFERENCES sales(id),
    barcode_id      UUID NOT NULL REFERENCES barcodes(id),
    tax_rate_id     UUID NOT NULL REFERENCES tax_rates(id),
    quantity        INTEGER NOT NULL DEFAULT 1,
    unit_price      NUMERIC(12,2) NOT NULL,
    subtotal        NUMERIC(12,2) NOT NULL
);

CREATE TABLE receipts (
    id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    sale_id         UUID NOT NULL UNIQUE REFERENCES sales(id),
    receipt_number  VARCHAR(50) NOT NULL UNIQUE,
    issued_at       TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- coverage_percentage_applied and claim_amount are snapshotted at the
-- time of the claim, so historical records stay accurate even if the
-- provider's default or a product override changes later.
CREATE TABLE insurance_claims (
    id                          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    sale_id                     UUID NOT NULL UNIQUE REFERENCES sales(id),
    insurance_provider_id       UUID NOT NULL REFERENCES insurance_providers(id),
    coverage_percentage_applied NUMERIC(5,2) NOT NULL,
    claim_amount                NUMERIC(12,2) NOT NULL,
    status                      VARCHAR(20) NOT NULL DEFAULT 'submitted',
        -- submitted | approved | rejected | paid
    submitted_at                TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- ============================================================
-- ANALYTICS / OPS
-- ============================================================

CREATE TABLE sales_forecasts (
    id                      UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    branch_id               UUID NOT NULL REFERENCES branches(id),
    product_variant_id      UUID NOT NULL REFERENCES product_variants(id),
    forecast_period         VARCHAR(20) NOT NULL,
    predicted_quantity      INTEGER NOT NULL,
    generated_at            TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE dashboard_reports (
    id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    branch_id       UUID NOT NULL REFERENCES branches(id),
    report_type     VARCHAR(50) NOT NULL,
    data            JSONB NOT NULL,
    generated_at    TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE support_tickets (
    id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    branch_id       UUID NOT NULL REFERENCES branches(id),
    raised_by       UUID NOT NULL REFERENCES users(id),
    subject         VARCHAR(150) NOT NULL,
    description     TEXT,
    status          VARCHAR(20) NOT NULL DEFAULT 'open',
    created_at      TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- ============================================================
-- INDEXES
-- ============================================================
CREATE INDEX idx_barcodes_code ON barcodes(code);
CREATE INDEX idx_barcodes_batch ON barcodes(stock_batch_id);
CREATE INDEX idx_barcodes_parent ON barcodes(parent_barcode_id);
CREATE INDEX idx_stock_batches_variant_branch ON stock_batches(product_variant_id, branch_id);
CREATE INDEX idx_stock_batches_delivery ON stock_batches(delivery_code);
CREATE INDEX idx_sales_branch_date ON sales(branch_id, sold_at);
CREATE INDEX idx_sale_items_sale ON sale_items(sale_id);
CREATE INDEX idx_notifications_branch_unread ON notifications(branch_id, is_read);
