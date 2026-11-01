-- Client details can now be edited in the office app (SPEC decision 62): every
-- change to a party is kept in the audit log, with the previous values.
create trigger audit after insert or update or delete on app.parties
  for each row execute function app.audit();
