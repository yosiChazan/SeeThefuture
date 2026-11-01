-- Deleting a property, a lease or a client entered by mistake (SPEC decision 67).
--
-- Only an admin who completed two-factor sign-in, with a written reason. Anything with
-- financial history is refused: transactions are never deleted (decision 50), so a
-- property or client with entries, accounts, deals or statements stays, and is closed
-- instead. What hangs on the record without history (ownership, leases, expected rent,
-- management, documents, names learned from reports) goes with it. A copy of every
-- deleted row is kept in audit_log, with the reason.
--
--   app.deletion_preview(kind, id)       what would be deleted, or why it cannot be
--   app.delete_record(kind, id, reason)  deletes; returns the document files to remove

create function app.deletion_preview(p_kind text, p_id uuid) returns jsonb
language plpgsql stable security definer set search_path = '' as $$
declare
  blocked text[] := '{}';
  n int;
  deletes jsonb := '{}';
  add_count text;
begin
  if not app.is_admin() then raise exception 'only an admin can delete'; end if;

  if p_kind = 'property' then
    if not exists (select 1 from app.properties where id = p_id) then raise exception 'property not found'; end if;
    select count(*) into n from app.entries where property_id = p_id;
    if n > 0 then blocked := blocked || format('יש לנכס %s רשומות בכרטיסי החשבון (תנועות לא נמחקות)', n); end if;
    if exists (select 1 from app.deals where property_id = p_id) then blocked := blocked || 'לנכס יש עסקת רכישה'::text; end if;
    if exists (select 1 from app.charges where property_id = p_id) then blocked := blocked || 'לנכס יש חיובים'::text; end if;
    if exists (select 1 from app.site_updates where property_id = p_id) then blocked := blocked || 'לנכס יש עדכוני בנייה'::text; end if;
    if exists (select 1 from app.utility_contracts where property_id = p_id) then blocked := blocked || 'לנכס יש חוזי חשמל/מים'::text; end if;
    if exists (select 1 from app.import_rows r join app.import_batches b on b.id = r.batch_id
               where r.property_id = p_id and b.status in ('parsed', 'in_review') and r.match_status = 'matched') then
      blocked := blocked || 'הנכס מופיע בדוח שממתין לאישור'::text;
    end if;
    deletes := jsonb_build_object(
      'ownerships', (select count(*) from app.ownerships where property_id = p_id),
      'leases', (select count(*) from app.leases where property_id = p_id),
      'rent_schedule', (select count(*) from app.rent_schedule where property_id = p_id),
      'management', (select count(*) from app.management_agreements where property_id = p_id),
      'documents', (select count(*) from app.documents where entity_type = 'property' and entity_id = p_id));

  elsif p_kind = 'lease' then
    if not exists (select 1 from app.leases where id = p_id) then raise exception 'lease not found'; end if;
    deletes := jsonb_build_object('documents', (select count(*) from app.documents where entity_type = 'lease' and entity_id = p_id));

  elsif p_kind = 'client' then
    if not exists (select 1 from app.parties where id = p_id) then raise exception 'client not found'; end if;
    select count(*) into n from app.ownerships where party_id = p_id;
    if n > 0 then blocked := blocked || format('הלקוח רשום כבעלים של %s נכסים (גם בעבר). קודם מוחקים או מעבירים את הנכסים', n); end if;
    if exists (select 1 from app.accounts where beneficiary_party_id = p_id or holder_party_id = p_id) then blocked := blocked || 'ללקוח יש חשבונות בכרטיס החשבון'::text; end if;
    if exists (select 1 from app.entries where external_party_id = p_id) then blocked := blocked || 'הלקוח מופיע בתנועות'::text; end if;
    if exists (select 1 from app.leases where tenant_party_id = p_id) then blocked := blocked || 'הלקוח רשום כשוכר בחוזה'::text; end if;
    if exists (select 1 from app.deals where p_id in (client_party_id, developer_party_id, referrer_party_id)) then blocked := blocked || 'הלקוח קשור לעסקת רכישה'::text; end if;
    if exists (select 1 from app.statements where client_party_id = p_id) then blocked := blocked || 'ללקוח יש דוחות חודשיים'::text; end if;
    if exists (select 1 from app.conversations where client_party_id = p_id) then blocked := blocked || 'ללקוח יש שיחות'::text; end if;
    if exists (select 1 from app.profiles where client_party_id = p_id) then blocked := blocked || 'ללקוח יש משתמש כניסה למערכת'::text; end if;
    if exists (select 1 from app.management_agreements where manager_party_id = p_id)
       or exists (select 1 from app.import_sources where holder_party_id = p_id) then
      blocked := blocked || 'זה מנהל נכסים או מקור דוחות, לא לקוח'::text;
    end if;
    deletes := jsonb_build_object(
      'documents', (select count(*) from app.documents where entity_type = 'party' and entity_id = p_id),
      'id_number', (select count(*) from app.party_identity where party_id = p_id),
      'referred', (select count(*) from app.parties where referred_by_party_id = p_id));
  else
    raise exception 'unknown kind %', p_kind;
  end if;

  return jsonb_build_object('blocked', to_jsonb(blocked), 'deletes', deletes);
end $$;

create function app.delete_record(p_kind text, p_id uuid, p_reason text) returns jsonb
language plpgsql security definer set search_path = '' as $$
declare
  preview jsonb;
  files   text[];
  old     jsonb;
begin
  if not app.is_admin() then raise exception 'only an admin can delete'; end if;
  if not app.mfa_verified() then raise exception 'two-factor sign-in is required'; end if;
  if length(trim(coalesce(p_reason, ''))) < 5 then raise exception 'a reason of at least 5 characters is required'; end if;
  preview := app.deletion_preview(p_kind, p_id);
  if jsonb_array_length(preview -> 'blocked') > 0 then
    raise exception 'cannot delete: %', preview ->> 'blocked';
  end if;

  if p_kind = 'property' then
    select to_jsonb(p) || jsonb_build_object(
      'ownerships', (select coalesce(jsonb_agg(o), '[]') from app.ownerships o where o.property_id = p_id),
      'leases', (select coalesce(jsonb_agg(l), '[]') from app.leases l where l.property_id = p_id))
      into old from app.properties p where p.id = p_id;
    select coalesce(array_agg(storage_path), '{}') into files from app.documents
      where (entity_type = 'property' and entity_id = p_id)
         or (entity_type = 'lease' and entity_id in (select id from app.leases where property_id = p_id));
    delete from app.documents where (entity_type = 'property' and entity_id = p_id)
      or (entity_type = 'lease' and entity_id in (select id from app.leases where property_id = p_id));
    delete from app.ownerships where property_id = p_id;
    delete from app.leases where property_id = p_id;
    delete from app.rent_schedule where property_id = p_id;
    delete from app.management_agreements where property_id = p_id;
    delete from app.external_refs where entity_type = 'property' and entity_id = p_id;
    -- Rows of reports that only pointed at it (ignored, or in rejected and posted-without-it reports).
    update app.import_rows set property_id = null where property_id = p_id;
    delete from app.properties where id = p_id;

  elsif p_kind = 'lease' then
    select to_jsonb(l) into old from app.leases l where l.id = p_id;
    select coalesce(array_agg(storage_path), '{}') into files from app.documents where entity_type = 'lease' and entity_id = p_id;
    delete from app.documents where entity_type = 'lease' and entity_id = p_id;
    delete from app.leases where id = p_id;

  elsif p_kind = 'client' then
    select to_jsonb(p) into old from app.parties p where p.id = p_id;
    select coalesce(array_agg(storage_path), '{}') into files from app.documents where entity_type = 'party' and entity_id = p_id;
    delete from app.documents where entity_type = 'party' and entity_id = p_id;
    delete from app.document_imports where party_id = p_id;
    delete from app.external_refs where entity_type = 'party' and entity_id = p_id;
    update app.parties set referred_by_party_id = null where referred_by_party_id = p_id;
    delete from app.parties where id = p_id;   -- roles and ID number go with it (cascade)
  end if;

  insert into app.audit_log (user_id, table_name, row_id, action, old_row, new_row)
  values (auth.uid(), case p_kind when 'property' then 'properties' when 'lease' then 'leases' else 'parties' end,
          p_id, 'DELETE_' || upper(p_kind), old,
          jsonb_build_object('reason', trim(p_reason), 'deleted', preview -> 'deletes', 'files', to_jsonb(files)));
  return jsonb_build_object('files', to_jsonb(files));
end $$;

revoke execute on function app.deletion_preview(text, uuid) from public, anon;
revoke execute on function app.delete_record(text, uuid, text) from public, anon;
grant execute on function app.deletion_preview(text, uuid) to authenticated;
grant execute on function app.delete_record(text, uuid, text) to authenticated;

-- The deleted documents' files: an admin removes them right after (the function lists them).
do $$
begin
  if exists (select 1 from pg_namespace where nspname = 'storage') then
    create policy documents_delete on storage.objects for delete to authenticated
      using (bucket_id = 'documents' and app.mfa_verified() and app.is_admin()
             and not exists (select 1 from app.documents d where d.storage_path = name));
  end if;
end $$;
