-- Deleting a property's file from its card (SPEC decision 106).
-- 1. The file in storage may be deleted by whoever may delete its row: same rule as
--    app.documents' delete policy. The card deletes the file first, then the row.
-- 2. A charge that points to a deleted receipt keeps its amount and loses only the link.

alter table app.charges drop constraint charges_document_id_fkey;
alter table app.charges add constraint charges_document_id_fkey
  foreign key (document_id) references app.documents on delete set null;

do $$
begin
  if exists (select 1 from pg_namespace where nspname = 'storage') then
    create policy documents_delete on storage.objects for delete to authenticated
      using (bucket_id = 'documents' and app.mfa_verified()
             and exists (select 1 from app.documents d where d.storage_path = name
                         and app.can_edit_country(d.country_code)
                         and (not d.sensitive or app.can_view_sensitive(d.country_code))));
  end if;
end $$;
