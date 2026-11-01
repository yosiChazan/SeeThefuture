-- Documents of people (ID cards, passports, powers of attorney, other attachments),
-- first imported from Airtable (SPEC decision 64).
--
-- Files live in the private bucket "documents" at "<country>/<entity_type>/<entity_id>/<file>".
-- A file can be read only by someone who can read its row in app.documents, so the
-- sensitive flag and the country decide, exactly as for the row. Rows are written by
-- staff with edit rights, or by the import function with the service role.

alter table app.documents add column file_name text;
alter table app.documents add column source text;   -- e.g. "airtable:att…" (the attachment id)
create unique index documents_storage_path on app.documents (storage_path);

-- The old write policy was "for all", so it also granted SELECT: any editor could read
-- sensitive documents. Writing is split by command, and touching a sensitive row needs
-- the sensitive flag too.
drop policy staff_write on app.documents;
create policy staff_insert on app.documents for insert to authenticated
  with check (app.can_edit_country(country_code) and (not sensitive or app.can_view_sensitive(country_code)));
create policy staff_update on app.documents for update to authenticated
  using (app.can_edit_country(country_code) and (not sensitive or app.can_view_sensitive(country_code)))
  with check (app.can_edit_country(country_code) and (not sensitive or app.can_view_sensitive(country_code)));
create policy staff_delete on app.documents for delete to authenticated
  using (app.can_edit_country(country_code) and (not sensitive or app.can_view_sensitive(country_code)));

do $$
begin
  if exists (select 1 from pg_namespace where nspname = 'storage') then
    insert into storage.buckets (id, name, public) values ('documents', 'documents', false)
    on conflict (id) do nothing;
    -- The subquery runs under the reader's own row-level security on app.documents.
    create policy documents_read on storage.objects for select to authenticated
      using (bucket_id = 'documents' and app.mfa_verified()
             and exists (select 1 from app.documents d where d.storage_path = name));
    create policy documents_write on storage.objects for insert to authenticated
      with check (bucket_id = 'documents' and app.mfa_verified()
                  and app.can_edit_country(split_part(name, '/', 1)::char(2)));
  end if;
end $$;
