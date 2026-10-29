-- Airtable has leases without a start date, an amount or a currency. They are
-- imported with those fields empty and completed by hand (SPEC decision 35).
alter table app.leases
  alter column start_date drop not null,
  alter column rent_amount drop not null,
  alter column rent_currency drop not null;
