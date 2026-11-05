-- Categories of a property's files that the office adds in Settings (SPEC decision 107),
-- next to the built-in ones (purchase and ownership, receipts, photos, floor plans, other).
-- A file in such a category has doc_type 'cat:<id>'. Staff read them; only an admin
-- adds, renames or removes one. A category with files is not removed (the screen asks
-- to move them first).
create table app.file_categories (
  id          uuid primary key default gen_random_uuid(),
  label       text not null unique check (length(trim(label)) between 1 and 40),
  sensitive   boolean not null default true,
  position    int not null default 100,
  created_at  timestamptz not null default now(),
  created_by  uuid default auth.uid()
);

alter table app.file_categories enable row level security;
create policy staff_read on app.file_categories for select to authenticated using (app.is_staff());
create policy admin_write on app.file_categories for all to authenticated using (app.is_admin()) with check (app.is_admin());
create policy require_mfa on app.file_categories as restrictive for all to authenticated
  using (app.mfa_verified() or app.my_party_id() is not null)
  with check (app.mfa_verified() or app.my_party_id() is not null);
grant select, insert, update, delete on app.file_categories to authenticated;
create trigger audit after insert or update or delete on app.file_categories for each row execute function app.audit();

-- Removing a category that still has files would hide them.
create function app.file_categories_guard() returns trigger
language plpgsql security definer set search_path = '' as $$
begin
  if exists (select 1 from app.documents where doc_type = 'cat:' || old.id::text) then
    raise exception 'the category still has files' using errcode = '23503';
  end if;
  return old;
end $$;
revoke all on function app.file_categories_guard() from public;
create trigger guard before delete on app.file_categories for each row execute function app.file_categories_guard();
