-- Secure public directory for the branch-picker page.
-- It contains only a branch ID and display name: no phone, address, staff,
-- inventory, or sales data is exposed before the user signs in.

create table if not exists public.branch_directory (
  branch_id uuid primary key references public.branches(id) on delete cascade,
  display_name varchar(150) not null
);

insert into public.branch_directory (branch_id, display_name)
select id, name from public.branches
on conflict (branch_id) do update set display_name = excluded.display_name;

alter table public.branch_directory enable row level security;
grant select on public.branch_directory to anon, authenticated;

drop policy if exists "branch directory is readable before sign-in" on public.branch_directory;
create policy "branch directory is readable before sign-in"
on public.branch_directory
for select
to anon, authenticated
using (true);
