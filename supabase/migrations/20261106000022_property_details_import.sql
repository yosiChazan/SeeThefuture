-- Importing the property details of Ukraine and Georgia from Airtable (SPEC decision 70).
--
-- Deals remember where they came from, so a second run updates instead of adding.
-- The document queue (migration 19) also carries property documents: entity_type and
-- entity_id name the record; a row with only party_id (as before) is a person's document.

alter table app.deals add column source text;
create unique index deals_source on app.deals (source) where source is not null;

alter table app.document_imports
  add column entity_type text not null default 'party' check (entity_type in ('party', 'property')),
  add column entity_id uuid;
update app.document_imports set entity_id = party_id where entity_id is null;
alter table app.document_imports alter column party_id drop not null;
alter table app.document_imports add constraint document_imports_target check (coalesce(entity_id, party_id) is not null);
alter table app.document_imports add column sensitive boolean not null default true;
