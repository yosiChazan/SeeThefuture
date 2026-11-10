-- The spreadsheets transactions came from (SPEC decision 137): a transaction whose source is
-- 'excel:<name>' links to the file itself: the sheet in Google Drive where it lives (url), or a
-- copy uploaded to the imports bucket under its country ('UA/sources/…'), read by whoever reads
-- that country. Set once; every transaction from it links to it. Staff read the list; finance of the country
-- (or an admin) uploads and replaces.
create table app.source_files (
  source        text primary key check (source like 'excel:%'),
  country_code  char(2) not null references app.countries,
  storage_path  text,
  url           text check (url is null or url ~ '^https://'),
  file_name     text,
  uploaded_at   timestamptz not null default now(),
  uploaded_by   uuid default auth.uid(),
  check (num_nonnulls(storage_path, url) = 1)
);
alter table app.source_files enable row level security;
create policy staff_read on app.source_files for select to authenticated using (app.can_read_country(country_code));
create policy finance_write on app.source_files for all to authenticated
  using (app.can_approve_country(country_code)) with check (app.can_approve_country(country_code));
create policy require_mfa on app.source_files as restrictive for all to authenticated
  using (app.mfa_verified() or app.my_party_id() is not null)
  with check (app.mfa_verified() or app.my_party_id() is not null);
grant select, insert, update, delete on app.source_files to authenticated;
create trigger audit after insert or update or delete on app.source_files for each row execute function app.audit();

-- Gershon's sheet for the Odessa clients, in Drive: where the conversions and transfers to the
-- clients (and the corrections) were taken from.
insert into app.source_files (source, country_code, url, file_name) values
  ('excel:גרשון – המרות והעברות ללקוחות', 'UA', 'https://docs.google.com/spreadsheets/d/1ntG75cbQMT2Y8EYjy-zemHvFFMbIZgzsVrNIOPy6Bfo/edit', 'סכום במזומן ללקוחות אודסה'),
  ('excel:גרשון – מה הועבר ללקוחות (תיקונים)', 'UA', 'https://docs.google.com/spreadsheets/d/1ntG75cbQMT2Y8EYjy-zemHvFFMbIZgzsVrNIOPy6Bfo/edit', 'סכום במזומן ללקוחות אודסה')
on conflict (source) do nothing;
