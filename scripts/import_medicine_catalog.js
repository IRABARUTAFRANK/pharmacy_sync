#!/usr/bin/env node
// Turns a WHO-ATC-classified medicines list (.xlsx, section headers
// interspersed as plain rows above the medicines they group -- e.g. the
// RHIA Reimbursable Medicines List) into a single idempotent SQL script
// that adds every medicine to the SHARED, provider-agnostic product
// catalogue -- not tied to any insurer, matching admin_import_product_
// catalog()'s own "general medicine catalog upload" feature
// (see 2026-09-19_catalog_import_variant_grouping.sql) and reusing its
// exact '[CATALOG] <base name>' product marker and catalog_code variant
// key, so this script and that in-app wizard can never create duplicates
// of each other's work.
//
// A list like this gives every pack size/strength of the same medicine its
// own row and drug_code (ELMEX SENSITIVE TUBE 50ml, 75ml child, and 75ml
// adult are three different codes for the same toothpaste) -- so each row
// is split into a base product name + a variant descriptor (see
// splitNameAndVariant() below, ported from src/lib/insuranceImport.ts's
// identical helper) and grouped onto one product with several variants,
// instead of becoming three separate products.
//
// Deliberately does NOT call that RPC directly: it asserts
// public.assert_super_admin(), which needs a real authenticated app
// session (auth.uid()) to resolve -- meaningless from a raw SQL editor/CLI
// connection, the same reason this project's other generated scripts
// (see import_insurance_price_list.js) write directly to the tables
// instead. This mirrors that RPC's own insert/update logic exactly, just
// run as you (the database owner) rather than as the app.
//
// Categories are NOT written anywhere here -- product_categories is
// branch-owned (see 2026-09-18_organization_shared_categories.sql), and a
// platform-wide catalogue import has no branch to own them. Instead this
// prints the real ATC category breakdown (level 1 + level 2 section
// headers, read directly from the sheet) to the console, so you can see
// how these medicines group even though nothing persists it yet.
//
// Usage:
//   node scripts/import_medicine_catalog.js \
//     --xlsx "src/assets/RHIA REIMBURSABLE MEDICINES LIST JUNE-2026.xlsx" \
//     [--sheet "RHIA MEDICINES TARIFF June 2026"]  (defaults to the first sheet)
//     [--out path/to/output.sql]                    (defaults next to the xlsx)

import fs from 'fs';
import path from 'path';
import XLSX from 'xlsx';

function parseArgs(argv) {
  const args = {};
  for (let i = 0; i < argv.length; i++) {
    if (argv[i].startsWith('--')) {
      const key = argv[i].slice(2);
      const val = argv[i + 1] && !argv[i + 1].startsWith('--') ? argv[++i] : true;
      args[key] = val;
    }
  }
  return args;
}

const args = parseArgs(process.argv.slice(2));
if (!args.xlsx) {
  console.error('Usage: node import_medicine_catalog.js --xlsx <file> [--sheet <name>] [--out <file>]');
  process.exit(1);
}

const xlsxPath = path.resolve(args.xlsx);
const outPath = args.out ? path.resolve(args.out) : xlsxPath.replace(/\.xlsx?$/i, '') + '.import.sql';

// XLSX.readFile() (its own file-path-based reader) throws "Cannot access
// file" under this package's ESM build even when the file genuinely exists
// and is readable -- reading the bytes ourselves and handing XLSX.read() a
// buffer sidesteps whatever that internal path handling is doing wrong.
const workbook = XLSX.read(fs.readFileSync(xlsxPath), { type: 'buffer' });
const sheetName = args.sheet || workbook.SheetNames[0];
const sheet = workbook.Sheets[sheetName];
if (!sheet) { console.error(`Error: sheet "${sheetName}" not found. Available: ${workbook.SheetNames.join(', ')}`); process.exit(1); }
const allRows = XLSX.utils.sheet_to_json(sheet, { header: 1, raw: false, defval: '' });

// ── Same classification helpers as import_insurance_price_list.js, kept
// identical on purpose so a medicine imported by either script is
// classified the same way. ──────────────────────────────────────────────
const SUPPLY_KEYWORDS = [
  'bandage', 'gauze', 'glove', 'syringe', 'condom', 'catheter', 'suture', 'cotton wool',
  'mask', 'test strip', 'strips', 'thermometer', 'plaster', 'swab', 'needle', 'cannula',
  'tourniquet', 'dressing', 'diaper', 'sanitary', 'adhesive tape', 'crepe bandage',
  'infusion set', 'giving set', 'urine bag', 'colostomy', 'nebulizer kit',
];
function classifyProductType(genericDesc, designation) {
  const hay = `${genericDesc} ${designation}`.toLowerCase();
  if (SUPPLY_KEYWORDS.some((kw) => hay.includes(kw))) return 'supply';
  return 'medicine';
}
const DOSAGE_RE = /\d[\d.,]*\s*(?:mg|g|mcg|µg|ml|IU|UI|MIU|mIU|%)(?:\s*(?:\/|\+)\s*\d[\d.,]*\s*(?:mg|g|mcg|µg|ml|IU|UI|MIU|mIU|%))*/i;
function extractDosage(genericDesc) {
  const m = genericDesc.match(DOSAGE_RE);
  return m ? m[0].replace(/\s+/g, ' ').trim() : null;
}
function titleCaseUnit(unit) {
  const u = unit.trim();
  if (!u) return 'Unit';
  return u.toLowerCase().replace(/\b\w/g, (c) => c.toUpperCase());
}

// Ported verbatim from src/lib/insuranceImport.ts's splitNameAndVariant() --
// keep the two in sync if the heuristic ever changes.
const NAME_VARIANT_SPLIT_RE = /\d[\d.,]*\s*(?:mg|g|mcg|µg|ml|IU|UI|MIU|mIU|%|GR)\b/i;
function splitNameAndVariant(designation) {
  const m = designation.match(NAME_VARIANT_SPLIT_RE);
  if (!m || m.index === 0) return { baseName: designation, variantLabel: null };
  const baseName = designation.slice(0, m.index).trim();
  const variantLabel = designation.slice(m.index).trim();
  return baseName ? { baseName, variantLabel: variantLabel || null } : { baseName: designation, variantLabel: null };
}

function sqlStr(v) { return "'" + String(v).replace(/'/g, "''") + "'"; }
function sqlStrOrNull(v) { return v === null || v === undefined || String(v).trim() === '' ? 'null' : sqlStr(v); }

// ── Find the real header row (the sheet has a title + blank rows above
// it, same shape as the RHIA file), then walk every row after it, tracking
// which ATC level-1/level-2 section header we're currently under. A
// section header row has text only in column A; a data row has a numeric
// SN in column A. ─────────────────────────────────────────────────────
function normHeader(h) { return h.toString().trim().toUpperCase().replace(/\s+/g, '_'); }

let headerRowIndex = -1;
for (let i = 0; i < allRows.length; i++) {
  const normalized = allRows[i].map(normHeader);
  if (normalized.includes('SN') && normalized.some((c) => c.startsWith('DRUG_CODE'))) { headerRowIndex = i; break; }
}
if (headerRowIndex === -1) { console.error('Error: could not find the SN/DRUG_CODE header row in this sheet'); process.exit(1); }

const headerRow = allRows[headerRowIndex].map(normHeader);
const col = (name) => headerRow.indexOf(name);
const idx = {
  sn: col('SN'),
  drugCode: col('DRUG_CODE'),
  generic: col('GENERIC_DESCRIPTION') >= 0 ? col('GENERIC_DESCRIPTION') : col('GENERIC_DESCRIPTION'.replace('_', ' ').toUpperCase().replace(/\s+/g, '_')),
  designation: col('DESIGNATION'),
  unit: col('SELLING_UNIT'),
};
// GENERIC DESCRIPTION has a stray leading space in some header cells that
// survives normHeader's trim -- fall back to a loose match if the exact
// key isn't found.
if (idx.generic < 0) idx.generic = headerRow.findIndex((h) => h.includes('GENERIC'));
if (idx.unit < 0) idx.unit = headerRow.findIndex((h) => h.includes('SELLING'));
for (const [k, v] of Object.entries(idx)) {
  if (v < 0) { console.error(`Error: could not find required column for "${k}" in header: ${allRows[headerRowIndex].join(' | ')}`); process.exit(1); }
}

const rows = [];
const categoryBreakdown = new Map(); // level1 -> Map(level2 -> count)
let level1 = null;
let level2 = null;
let skipped = 0;

for (let i = headerRowIndex + 1; i < allRows.length; i++) {
  const r = allRows[i];
  const colA = (r[0] || '').toString().trim();
  const restEmpty = r.slice(1).every((c) => !c || !c.toString().trim());

  if (!colA && restEmpty) continue; // blank spacer row

  if (restEmpty) {
    // A section header row (only column A has text). Level 1 is a bare
    // letter ("A. ..."); anything else under it (letter+digits, or one of
    // the handful of typo'd headers like "JO7 VACCINES") is level 2.
    if (/^[A-Z][.\s]/.test(colA) && !/^[A-Z]\d/.test(colA)) {
      level1 = colA.replace(/^[A-Z][.\s]+/, '').trim();
      level2 = null;
    } else {
      level2 = colA.replace(/^[A-Z0-9]+[.\s]*/, '').trim() || colA;
    }
    if (level1) {
      if (!categoryBreakdown.has(level1)) categoryBreakdown.set(level1, new Map());
      if (level2 && !categoryBreakdown.get(level1).has(level2)) categoryBreakdown.get(level1).set(level2, 0);
    }
    continue;
  }

  const sn = (r[idx.sn] || '').toString().trim();
  const drugCode = (r[idx.drugCode] || '').toString().trim();
  if (!/^\d+$/.test(sn) || !drugCode) { skipped++; continue; }

  const genericFull = (r[idx.generic] || '').toString().trim().replace(/\s+/g, ' ');
  const designation = (r[idx.designation] || '').toString().trim().replace(/\s+/g, ' ');
  const unitRaw = (r[idx.unit] || '').toString().trim().replace(/\s+/g, ' ');

  const { baseName, variantLabel } = splitNameAndVariant(designation || genericFull);
  const productName = baseName.slice(0, 150);
  const genericName = genericFull ? genericFull.slice(0, 150) : null;
  const productType = classifyProductType(genericFull, designation);
  const dosage = variantLabel || extractDosage(genericFull);
  const form = titleCaseUnit(unitRaw).slice(0, 50);
  const unit = form.slice(0, 30);
  // Product identity is now the base name (shared across every pack-size
  // row), NOT the per-row drug_code -- see this file's header comment.
  const description = `[CATALOG] ${productName}`.slice(0, 2000);

  rows.push({ drugCode, productType, productName, genericName, description, dosage, form, unit, level1, level2 });
  if (level1 && level2) categoryBreakdown.get(level1).set(level2, categoryBreakdown.get(level1).get(level2) + 1);
}

if (rows.length === 0) { console.error('Error: no medicine rows found'); process.exit(1); }

// ── SQL: mirrors admin_import_product_catalog()'s own logic exactly
// (same [CATALOG:<code>] dedup key, same create-or-update-in-place
// behavior), just run directly against the tables instead of through the
// RPC -- see this file's header comment for why. ────────────────────────
const valuesSql = rows.map((r) => [
  sqlStr(r.drugCode), sqlStr(r.productType), sqlStr(r.productName),
  sqlStrOrNull(r.genericName), sqlStr(r.description), sqlStrOrNull(r.dosage),
  sqlStr(r.form), sqlStr(r.unit),
].join(', ')).map((line) => `    (${line})`).join(',\n');

const sql = `-- ============================================================================
-- General medicine catalog import — generated by scripts/import_medicine_catalog.js
-- Source: ${path.basename(xlsxPath)} (sheet "${sheetName}")
-- Rows:   ${rows.length} (skipped ${skipped} header/unparseable rows)
--
-- Same '[CATALOG] <base name>' product marker and catalog_code variant key
-- as admin_import_product_catalog() (see
-- 2026-09-19_catalog_import_variant_grouping.sql) -- re-running this (or
-- that in-app import wizard) against the same or a revised list updates
-- matching products/variants in place rather than creating duplicates, and
-- pack-size rows sharing a base name (e.g. "ELMEX SENSITIVE TUBE 50ml" /
-- "75ml") collapse onto ONE product with several variants instead of one
-- product each. Resolves the "Exempt" tax rate BY NAME at run time (not a
-- hardcoded id) -- if you don't have a tax rate named exactly "Exempt",
-- change v_tax_rate_name below or pass a different one.
-- ============================================================================
do $$
declare
  v_tax_rate_name text := 'Exempt';
  v_tax_rate_id uuid;
  v_product_id uuid;
  v_variant_id uuid;
  v_description text;
  r record;
  v_created_products int := 0;
  v_updated_products int := 0;
  v_created_variants int := 0;
  v_reused_variants int := 0;
begin
  select id into v_tax_rate_id from public.tax_rates where name = v_tax_rate_name limit 1;
  if v_tax_rate_id is null then
    raise exception 'No tax rate named "%" exists -- check public.tax_rates and adjust v_tax_rate_name', v_tax_rate_name;
  end if;

  for r in
    select * from ( values
${valuesSql}
    ) as t(drug_code, product_type, product_name, generic_name, description, dosage, form, unit)
  loop
    v_description := '[CATALOG] ' || r.product_name;

    select id into v_product_id from public.products where description = v_description limit 1;

    if v_product_id is null then
      insert into public.products (tax_rate_id, product_type, name, generic_name, description)
      values (v_tax_rate_id, r.product_type, r.product_name, r.generic_name, v_description)
      returning id into v_product_id;
      v_created_products := v_created_products + 1;
    else
      update public.products
        set tax_rate_id = v_tax_rate_id, product_type = r.product_type,
            name = r.product_name, generic_name = r.generic_name
        where id = v_product_id;
      v_updated_products := v_updated_products + 1;
    end if;

    -- Variant identity is the source drug_code (stable across a revised
    -- list re-import), falling back to a dosage/form match only for a
    -- variant that has no catalog_code at all yet.
    select id into v_variant_id from public.product_variants
      where product_id = v_product_id and catalog_code = r.drug_code
      limit 1;

    if v_variant_id is null then
      select id into v_variant_id from public.product_variants
        where product_id = v_product_id
          and catalog_code is null
          and coalesce(dosage, '') = coalesce(r.dosage, '')
          and coalesce(form, '') = coalesce(r.form, '')
        limit 1;
    end if;

    if v_variant_id is null then
      insert into public.product_variants (product_id, dosage, form, unit, catalog_code)
      values (v_product_id, r.dosage, r.form, r.unit, r.drug_code)
      returning id into v_variant_id;
      v_created_variants := v_created_variants + 1;
    else
      update public.product_variants
        set dosage = r.dosage, form = r.form, unit = r.unit, catalog_code = r.drug_code
        where id = v_variant_id;
      v_reused_variants := v_reused_variants + 1;
    end if;
  end loop;

  raise notice 'products created=%, updated=%; variants created=%, reused=%',
    v_created_products, v_updated_products, v_created_variants, v_reused_variants;
end $$;
`;

fs.writeFileSync(outPath, sql, 'utf8');

// ── Console report: the category breakdown that can't be persisted yet. ──
console.log(`Wrote ${rows.length} rows (skipped ${skipped}) to ${outPath}`);
console.log(`Run it via the Supabase SQL editor, or: npx supabase db query --linked --file "${outPath}"`);
console.log('');
console.log(`Category breakdown (${categoryBreakdown.size} top-level ATC groups, from the sheet's own section headers):`);
for (const [l1, subs] of [...categoryBreakdown.entries()].sort()) {
  const total = [...subs.values()].reduce((a, b) => a + b, 0);
  console.log(`  ${l1} -- ${total} medicine(s), ${subs.size} subgroup(s)`);
}
