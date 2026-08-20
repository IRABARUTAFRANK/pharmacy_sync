# Supabase setup

1. Create a new Supabase project.
2. In **SQL Editor**, open and run [supabase_pharmacy_schema.sql](./supabase_pharmacy_schema.sql).
3. In **Authentication → Providers**, configure email/password sign-in. Keep public sign-up disabled until your branch/user provisioning flow is ready.
4. Create a branch first, then create each person in **Authentication → Users**. The `public.users.id` value must equal that Auth user's UUID; create the matching profile with a trusted server/admin process (never from a browser using a service-role key).

## Important data notes

- `src/data.ts` is demo data only. Its IDs such as `BR-001` and `USR-001` are not UUIDs, so they cannot be inserted directly into this schema. Generate real UUIDs, or prepare a separate mapped seed migration.
- Password hashes and one-time passwords from the older draft were intentionally removed. Supabase Auth stores credentials securely.
- The original `users.branch_id UNIQUE` constraint was removed: the current demo data has multiple users assigned to Kigali HQ.
- The branch-owned tables are immediately protected by Row Level Security. The other operational tables have RLS enabled but no client policies yet, so they remain inaccessible from the browser until the relevant screens are migrated with scoped policies/RPCs. This avoids exposing pharmacy and sales data by accident.

## Connecting the React app (next implementation step)

Install the Supabase browser client, then create `src/lib/supabase.ts` using only these Vite environment values:

```env
VITE_SUPABASE_URL=https://your-project-ref.supabase.co
VITE_SUPABASE_ANON_KEY=your-public-anon-key
```

Do not put `service_role` keys in this Vite project: anything prefixed `VITE_` is sent to the browser.

The first practical migration is Inventory: replace `dbProducts`, `dbProductVariants`, `dbStockBatches`, and `dbBarcodes` with a Supabase query/view, then migrate writes through a transaction-safe RPC. Sales should follow, because a sale must decrement stock and create its sale records atomically.
