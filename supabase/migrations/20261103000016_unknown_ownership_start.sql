-- Ownerships whose start date Airtable did not have were loaded from the opening
-- date (2026-01-01). Since Romania is imported from the start of its accounts
-- (SPEC decision 48), reports carry earlier dates and their rows had no owner.
-- An unknown start now means "owned before any report": 2000-01-01, with the note
-- kept so the app shows the date as unknown (SPEC decision 60).
update app.ownerships
set valid_from = date '2000-01-01',
    notes = trim(replace(notes, 'Start date unknown; set to the opening date.', 'Start date unknown.'))
where notes like '%Start date unknown; set to the opening date.%'
  and valid_from = date '2026-01-01';
