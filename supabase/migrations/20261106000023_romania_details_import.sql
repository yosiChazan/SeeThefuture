-- Importing Romania's property details and bills history from Airtable (SPEC decision 71).
-- Services and charges remember where they came from, so a second run updates instead of
-- adding: a service by "airtable:<record>:<kind>", a charge by "airtable:<bill record>".

alter table app.utility_contracts add column source text;
create unique index utility_contracts_source on app.utility_contracts (source) where source is not null;

alter table app.charges add column source text;
create unique index charges_source on app.charges (source) where source is not null;
