#!/usr/bin/env node
// Reusable importer: turns an insurer's reimbursable-medicines price list CSV
// into a single idempotent SQL script that creates/updates the product
// catalogue and attaches per-variant fixed insurance prices.
//
// Usage:
//   node scripts/import_insurance_price_list.js \
//     --csv path/to/list.csv \
//     --provider-id <insurance_providers.id> \
//     --source-tag RHIA \
//     [--tax-rate-id <tax_rates.id>]   (defaults to the 0% "Exempt" rate)
//     [--out path/to/output.sql]       (defaults next to the csv)
//
// Expected CSV columns (header row required, any casing/spacing):
//   SN, DRUG_CODE, GENERIC_DESCRIPTION (or "GENERIC DESCRIPTION"), DESIGNATION,
//   INSTRUCTIONS, SELLING_UNIT (or "SELLING UNIT"), PRICE
//
// --source-tag identifies the CODING SCHEME the DRUG_CODE column comes from —
// e.g. "RHIA" for MMI's RHIA-coded formulary — NOT a date or revision. Each
// product is tagged with `[<source_tag>:<drug_code>]` in its description, so
// re-running this same importer against next quarter's/next year's revision
// of the SAME price list (same code scheme, prices/names updated) is safe and
// idempotent: it matches existing products by that tag and updates them in
// place — new price, refreshed name — instead of creating duplicates. Give a
// genuinely different coding scheme (a different insurer whose DRUG_CODE
// values aren't drawn from the same list, e.g. RSSB's own formulary codes)
// its own --source-tag so the two never collide; if that insurer happens to
// cover the same physical drug, it will end up as a second row in
// insurance_variant_prices against the SAME product/variant once matched by
// hand or a future code-crosswalk — never a duplicate product on its own.

import fs from 'fs';
import path from 'path';

const EXEMPT_TAX_RATE_ID = 'a2000000-0000-0000-0000-000000000001';

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
if (!args.csv || !args['provider-id'] || !args['source-tag']) {
  console.error('Usage: node import_insurance_price_list.js --csv <file> --provider-id <uuid> --source-tag <tag> [--tax-rate-id <uuid>] [--out <file>]');
  process.exit(1);
}

const csvPath = path.resolve(args.csv);
const providerId = args['provider-id'];
const sourceTag = args['source-tag'];
const taxRateId = args['tax-rate-id'] || EXEMPT_TAX_RATE_ID;
const outPath = args.out ? path.resolve(args.out) : csvPath.replace(/\.csv$/i, '') + '.import.sql';

function isUuid(s) {
  return /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(s);
}
if (!isUuid(providerId)) { console.error('Error: --provider-id must be a uuid'); process.exit(1); }
if (!isUuid(taxRateId)) { console.error('Error: --tax-rate-id must be a uuid'); process.exit(1); }
if (!/^[A-Za-z0-9_.-]{1,40}$/.test(sourceTag)) { console.error('Error: --source-tag must be short alphanumeric (dashes/dots/underscores ok)'); process.exit(1); }

// Full-text RFC4180-style CSV parser: handles quoted fields containing commas
// and literal newlines (some source sheets wrap long ingredient lists onto
// multiple physical lines inside one quoted cell).
function parseCsv(text) {
  const records = [];
  let row = [];
  let cur = '';
  let inQuotes = false;
  let i = 0;
  const n = text.length;
  while (i < n) {
    const c = text[i];
    if (inQuotes) {
      if (c === '"') {
        if (text[i + 1] === '"') { cur += '"'; i += 2; continue; }
        inQuotes = false; i++; continue;
      }
      cur += c; i++; continue;
    } else {
      if (c === '"') { inQuotes = true; i++; continue; }
      if (c === ',') { row.push(cur); cur = ''; i++; continue; }
      if (c === '\r') { i++; continue; }
      if (c === '\n') { row.push(cur); records.push(row); row = []; cur = ''; i++; continue; }
      cur += c; i++; continue;
    }
  }
  if (cur.length > 0 || row.length > 0) { row.push(cur); records.push(row); }
  return records;
}

function normHeader(h) {
  return h.trim().toUpperCase().replace(/\s+/g, '_');
}

const raw = fs.readFileSync(csvPath, 'utf8');
const records = parseCsv(raw).filter((r) => r.length > 1 && r.some((f) => f && f.trim()));
if (records.length === 0) { console.error('Error: no rows found in CSV'); process.exit(1); }

const headerRow = records[0].map(normHeader);
const col = (name) => headerRow.indexOf(name);
const idx = {
  sn: col('SN'),
  drugCode: col('DRUG_CODE'),
  generic: col('GENERIC_DESCRIPTION') >= 0 ? col('GENERIC_DESCRIPTION') : col('GENERIC DESCRIPTION'),
  designation: col('DESIGNATION'),
  instructions: col('INSTRUCTIONS'),
  unit: col('SELLING_UNIT') >= 0 ? col('SELLING_UNIT') : col('SELLING UNIT'),
  price: col('PRICE'),
};
for (const [k, v] of Object.entries(idx)) {
  if (v < 0) { console.error(`Error: could not find required column for "${k}" in header: ${records[0].join(' | ')}`); process.exit(1); }
}

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

function sqlStr(v) {
  if (v === null || v === undefined) return 'null';
  return "'" + String(v).replace(/'/g, "''") + "'";
}
function sqlStrOrNull(v) {
  if (v === null || v === undefined || String(v).trim() === '') return 'null';
  return sqlStr(v);
}

const rows = [];
let skipped = 0;
for (let r = 1; r < records.length; r++) {
  const f = records[r];
  const sn = (f[idx.sn] || '').trim();
  const drugCode = (f[idx.drugCode] || '').trim();
  if (!/^[0-9]+$/.test(sn) || !drugCode) { skipped++; continue; }

  const genericFull = (f[idx.generic] || '').trim().replace(/\s+/g, ' ');
  const designation = (f[idx.designation] || '').trim().replace(/\s+/g, ' ');
  const unitRaw = (f[idx.unit] || '').trim().replace(/\s+/g, ' ');
  const priceClean = (f[idx.price] || '').replace(/[,\s]/g, '');
  const price = parseInt(priceClean, 10);
  if (!Number.isFinite(price)) { console.warn(`Skipping SN ${sn} (${drugCode}): unparseable price "${f[idx.price]}"`); skipped++; continue; }

  const productName = (designation || genericFull).slice(0, 150);
  const genericName = genericFull ? genericFull.slice(0, 150) : null;
  const productType = classifyProductType(genericFull, designation);
  const dosage = extractDosage(genericFull);
  const form = titleCaseUnit(unitRaw).slice(0, 50);
  const unit = form.slice(0, 30);
  const description = `[${sourceTag}:${drugCode}] ${genericFull}`.slice(0, 2000);

  rows.push({ drugCode, productType, productName, genericName, description, dosage, form, unit, price });
}

const valuesSql = rows.map((r) => [
  sqlStr(r.drugCode),
  sqlStr(r.productType),
  sqlStr(r.productName),
  sqlStrOrNull(r.genericName),
  sqlStr(r.description),
  sqlStrOrNull(r.dosage),
  sqlStr(r.form),
  sqlStr(r.unit),
  r.price,
].join(', ')).map((line) => `    (${line})`).join(',\n');

const sql = `-- ============================================================================
-- Insurance price list import — generated by scripts/import_insurance_price_list.js
-- Source CSV: ${path.basename(csvPath)}
-- Source tag: ${sourceTag}  (re-running with this same tag updates in place, no duplicates)
-- Provider:   ${providerId}
-- Tax rate:   ${taxRateId}
-- Rows:       ${rows.length} (skipped ${skipped} unparseable/header rows)
-- ============================================================================
do $$
declare
  v_tax_rate_id uuid := ${sqlStr(taxRateId)};
  v_provider_id uuid := ${sqlStr(providerId)};
  v_product_id uuid;
  v_variant_id uuid;
  r record;
  v_created_products int := 0;
  v_updated_products int := 0;
  v_created_variants int := 0;
  v_reused_variants int := 0;
  v_prices_set int := 0;
begin
  if not exists (select 1 from public.tax_rates where id = v_tax_rate_id) then
    raise exception 'Unknown tax_rate_id %', v_tax_rate_id;
  end if;
  if not exists (select 1 from public.insurance_providers where id = v_provider_id) then
    raise exception 'Unknown insurance provider %', v_provider_id;
  end if;

  for r in
    select * from ( values
${valuesSql}
    ) as t(drug_code, product_type, product_name, generic_name, description, dosage, form, unit, price)
  loop
    select id into v_product_id from public.products
      where description = r.description
      limit 1;

    if v_product_id is null then
      insert into public.products (tax_rate_id, product_type, name, generic_name, description)
      values (v_tax_rate_id, r.product_type, r.product_name, r.generic_name, r.description)
      returning id into v_product_id;
      v_created_products := v_created_products + 1;
    else
      update public.products
        set tax_rate_id = v_tax_rate_id, product_type = r.product_type,
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
    values (v_provider_id, v_variant_id, r.price)
    on conflict (insurance_provider_id, product_variant_id)
      do update set fixed_price = excluded.fixed_price;
    v_prices_set := v_prices_set + 1;
  end loop;

  raise notice 'products created=%, updated=%; variants created=%, reused=%; prices set=%',
    v_created_products, v_updated_products, v_created_variants, v_reused_variants, v_prices_set;
end $$;
`;

fs.writeFileSync(outPath, sql, 'utf8');
console.log(`Wrote ${rows.length} rows (skipped ${skipped}) to ${outPath}`);
console.log(`Run it with: npx supabase db query --linked --file "${outPath}"`);
