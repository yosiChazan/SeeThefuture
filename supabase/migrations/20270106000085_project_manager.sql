-- Project and property manager on every property (SPEC decision 211). The project is the
-- building's (app.projects); the manager is the open management agreement. This sets them where
-- the office said so (26.11.2026):
--   Odessa: the city-centre buildings are the project "אודסה"; Arcadia stays Arcadia (the two
--   Arcadia buildings without a project join it). Every Odessa apartment is managed by Yarach.
--   Kyiv: Vitaly manages the 10 apartments of his monthly report (15% of the rent); the others
--   (vacant, or still being built) get a manager when they have one, on the property card.
-- Batumi already has its projects (Panorama, Alliance, Marina club); Kyiv has Lake city (Park Lake City).

update app.projects set name = 'אודסה'
 where name = 'City center' and city_id = (select id from app.cities where name_he = 'אודסה');

update app.buildings set project_id = (select p.id from app.projects p join app.cities c on c.id = p.city_id where c.name_he = 'אודסה' and p.name = 'Arcadia')
 where project_id is null and name like 'Arcadia%' and city_id = (select id from app.cities where name_he = 'אודסה');

-- Yarach: the Odessa apartments without an open agreement.
insert into app.management_agreements (property_id, manager_party_id, fee_model, valid_from, notes)
select p.id, 'a0000000-0000-4000-8000-000000000002', 'none', '2026-11-26', 'מנהל הנכס באודסה (החלטה 211)'
from app.properties p join app.buildings b on b.id = p.building_id join app.cities c on c.id = b.city_id
where c.name_he = 'אודסה' and p.status <> 'sold'
  and not exists (select 1 from app.management_agreements m where m.property_id = p.id and m.valid_to is null);

-- Vitaly: the apartments of his posted reports, without an open agreement.
insert into app.management_agreements (property_id, manager_party_id, fee_model, fee_pct, valid_from, notes)
select distinct r.property_id, 'a0000000-0000-4000-8000-000000000001'::uuid, 'pct_of_gross'::app.fee_model, 15, '2026-11-26'::date, 'בדוח החודשי של ויטאלי (החלטה 211)'
from app.import_rows r join app.import_batches bt on bt.id = r.batch_id join app.import_sources s on s.id = bt.source_id
where s.adapter = 'vitaly_rent_xlsx' and bt.status = 'committed' and r.property_id is not null
  and not exists (select 1 from app.management_agreements m where m.property_id = r.property_id and m.valid_to is null);
