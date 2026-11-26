-- Ofir's owner statements (SPEC decision 207): a Word document per apartment in Bucharest, read by
-- the ofir_owner_docx adapter. Ofir holds the money of the apartments he runs, in euro and in lei,
-- so he is the source's holder; he is a property manager.
insert into app.party_roles (party_id, role)
select id, 'manager' from app.parties where id = '432a5db0-4735-40de-a8cf-82793cbdafe8'   -- אופיר צווירן ניהול דירות בוקרשט
on conflict do nothing;

insert into app.import_sources (name, adapter, country_code, holder_party_id)
select 'אופיר · דוח בעלים (Word)', 'ofir_owner_docx', 'RO', id from app.parties where id = '432a5db0-4735-40de-a8cf-82793cbdafe8'
on conflict (name) do nothing;
