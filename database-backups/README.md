# Database backups

This folder holds point-in-time snapshots of the live Supabase database's
actual data (not just the schema/code, which is already backed up as the
rest of this repository).

Each dated subfolder is one snapshot: one JSON file per `public` schema
table (an array of that table's rows, straight from `to_jsonb(row)`), plus
`_row_counts.json` summarizing how many rows each table had at snapshot
time.

## What is NOT included

- **`auth.users`** (login credentials/password hashes) and other Supabase-
  internal schemas — these are managed by Supabase itself, not part of your
  application data, and deliberately excluded.
- **Storage bucket files** (branch logos, uploaded images) — these live in
  Supabase Storage, not in the Postgres tables captured here. Back those up
  separately if needed (e.g. via the Supabase dashboard or `supabase storage`
  commands).
- **Live database schema (DDL)** — the authoritative schema history lives in
  `src/datatabase/pharmacy_schema_consolidated.sql` elsewhere in this
  repository. These snapshots capture data only, not table/column/function
  definitions.

## How this was generated

Produced by running a `jsonb_agg(to_jsonb(t))` query against every base
table in the `public` schema (via `supabase db query --linked`), since the
machine that generated it didn't have Docker installed (required by
`supabase db dump`'s bundled `pg_dump`). If Docker becomes available later,
`supabase db dump --linked -f schema.sql` and
`supabase db dump --linked --data-only -f data.sql` produce a more
standard, directly-restorable SQL dump instead.

## Restoring from a snapshot

There's no one-command restore for this JSON format (unlike a `pg_dump`
SQL file). To restore a table, write a small script that reads the file
and re-inserts each row via `insert into public.<table> (...) values (...)`
or the Supabase client's `.insert()`/`.upsert()`, respecting foreign-key
order (roughly: `branches` → `users` → `products`/`suppliers` →
`product_variants` → everything else that references them).
