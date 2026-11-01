-- A client's ID number (SPEC decision 66). Kept apart from app.parties, which every
-- staff member reads: like sensitive documents, the number is seen only by an admin,
-- by staff with the sensitive-documents flag in some country, and by the client.
-- Writing needs edit rights too. Every change is audited.

create function app.can_view_any_sensitive() returns boolean
language sql stable security definer set search_path = '' as $$
  select app.is_admin() or exists (
    select 1 from app.user_country_roles where user_id = auth.uid() and can_view_sensitive)
$$;

create function app.can_edit_any_sensitive() returns boolean
language sql stable security definer set search_path = '' as $$
  select app.is_admin() or exists (
    select 1 from app.user_country_roles
    where user_id = auth.uid() and can_view_sensitive and level in ('editor', 'finance'))
$$;

create table app.party_identity (
  party_id    uuid primary key references app.parties on delete cascade,
  id_number   text not null check (id_number ~ '^[0-9A-Za-z-]{5,20}$'),
  -- "manual", or "ocr:<document id>" when it was read from a scan and confirmed.
  source      text,
  updated_at  timestamptz not null default now()
);

alter table app.party_identity enable row level security;
create policy staff_read on app.party_identity for select to authenticated using (app.can_view_any_sensitive());
create policy client_read on app.party_identity for select to authenticated using (party_id = app.my_party_id());
create policy staff_insert on app.party_identity for insert to authenticated with check (app.can_edit_any_sensitive());
create policy staff_update on app.party_identity for update to authenticated
  using (app.can_edit_any_sensitive()) with check (app.can_edit_any_sensitive());
create policy staff_delete on app.party_identity for delete to authenticated using (app.can_edit_any_sensitive());
create policy require_mfa on app.party_identity as restrictive for all to authenticated
  using (app.mfa_verified() or app.my_party_id() is not null)
  with check (app.mfa_verified() or app.my_party_id() is not null);
grant select, insert, update, delete on app.party_identity to authenticated;

create trigger audit after insert or update or delete on app.party_identity
  for each row execute function app.audit();
