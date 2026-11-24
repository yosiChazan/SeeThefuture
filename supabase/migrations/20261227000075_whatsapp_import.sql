-- Importing chats exported from WhatsApp (SPEC decision 191): staff upload the exported files'
-- pictures into the "whatsapp" bucket, under import/ only.
do $$
begin
  if exists (select 1 from pg_namespace where nspname = 'storage') then
    create policy whatsapp_import on storage.objects for insert to authenticated
      with check (bucket_id = 'whatsapp' and name like 'import/%' and app.is_staff() and app.mfa_verified());
  end if;
end $$;
