# Loading development data

The development seed is designed for the canonical schema in
`supabase_pharmacy_schema.sql`. It intentionally does not create Auth users or
passwords; Supabase Auth must own those records.

## One-time setup

1. Run `supabase_pharmacy_schema.sql` in Supabase SQL Editor.
2. Run the following branch bootstrap in SQL Editor:

```sql
insert into public.branches (id, name, address, phone)
values ('10000000-0000-4000-8000-000000000001', 'Kigali HQ', 'KN 4 Ave, Kigali', '+250 788 000 101')
on conflict (id) do nothing;
```

3. In **Authentication → Users**, create the development user
   `dev.owner@pharmsync.local`, then copy its UUID.
4. In SQL Editor, replace `<AUTH_USER_UUID>` and run:

```sql
insert into public.users (id, branch_id, full_name, email, role, is_active)
values (
  '<AUTH_USER_UUID>',
  '10000000-0000-4000-8000-000000000001',
  'Development Owner',
  'dev.owner@pharmsync.local',
  'owner',
  true
)
on conflict (id) do update set
  branch_id = excluded.branch_id,
  full_name = excluded.full_name,
  email = excluded.email,
  role = excluded.role,
  is_active = excluded.is_active;
```

5. Run `development_seed.sql` in SQL Editor.

The seed is repeatable and uses fixed development UUIDs, so it can be run
again to restore the same catalog and inventory examples. It must not be used
in production.
