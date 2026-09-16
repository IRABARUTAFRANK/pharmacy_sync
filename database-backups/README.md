# Database backups

This folder holds point-in-time snapshots of the live Supabase database.
There are two kinds of dated subfolder, covering two different things:

- **`YYYY-MM-DD/`** — the actual **data**: one JSON file per `public` schema
  table (an array of that table's rows, straight from `to_jsonb(row)`), plus
  `_row_counts.json` summarizing how many rows each table had at snapshot
  time.
- **`schema-YYYY-MM-DD/`** — the **structure**: `functions.sql` (every
  `public` function's complete, live definition via `pg_get_functiondef`,
  one per function, exactly as it runs today) and `tables.sql` (every
  table's columns/types, primary keys, foreign keys, and RLS policy names,
  reconstructed from `information_schema`/`pg_policies`). This is a
  mechanically-generated cross-check of what's *actually deployed*, not a
  replacement for the hand-maintained migration history below.

## What is NOT included

- **`auth.users`** (login credentials/password hashes) and other Supabase-
  internal schemas — these are managed by Supabase itself, not part of your
  application data, and deliberately excluded.
- **Storage bucket files** (branch logos, uploaded images) — these live in
  Supabase Storage, not in the Postgres tables captured here. Back those up
  separately if needed (e.g. via the Supabase dashboard or `supabase storage`
  commands).
- **The authoritative, hand-maintained schema history** — that's
  `src/datatabase/pharmacy_schema_consolidated.sql` elsewhere in this
  repository, with the reasoning/comments behind each change. The
  `schema-YYYY-MM-DD/` snapshots here are a generated point-in-time mirror
  of it for verification, not a substitute for it.

## How this was generated

Produced entirely via `supabase db query --linked` (data via
`jsonb_agg(to_jsonb(t))` per table, functions via `pg_get_functiondef`,
tables via `information_schema`), since the machine that generated it didn't
have Docker installed (required by `supabase db dump`'s bundled `pg_dump`).
If Docker becomes available later, `supabase db dump --linked -f schema.sql`
and `supabase db dump --linked --data-only -f data.sql` produce a more
standard, directly-restorable SQL dump instead.

## Restoring from a snapshot

There's no one-command restore for the `YYYY-MM-DD/` JSON data format
(unlike a `pg_dump` SQL file). To restore a table, write a small script that
reads the file and re-inserts each row via
`insert into public.<table> (...) values (...)` or the Supabase client's
`.insert()`/`.upsert()`, respecting foreign-key order (roughly: `branches` →
`users` → `products`/`suppliers` → `product_variants` → everything else
that references them).

The `schema-YYYY-MM-DD/functions.sql` file, by contrast, *is* directly
runnable: every entry is a real `CREATE OR REPLACE FUNCTION ...;` statement,
so the whole file (or any function in it) can be re-applied as-is via
`supabase db query --linked --file functions.sql`.
