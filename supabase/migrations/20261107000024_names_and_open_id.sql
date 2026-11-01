-- First and last name, and the ID number open to staff (SPEC decision 72, replaces the
-- sensitivity part of decision 66).
--
-- The ID number is no longer sensitive: every staff member reads it (like the rest of a
-- client's details), and staff with edit rights write it. A client still sees only their
-- own. Changes stay audited. The scans it is read from remain sensitive documents.

drop policy staff_read on app.party_identity;
drop policy staff_insert on app.party_identity;
drop policy staff_update on app.party_identity;
drop policy staff_delete on app.party_identity;
create policy staff_read on app.party_identity for select to authenticated using (app.is_staff());
create policy staff_write on app.party_identity for all to authenticated
  using (app.is_admin() or exists (select 1 from app.user_country_roles where user_id = auth.uid() and level in ('editor', 'finance')))
  with check (app.is_admin() or exists (select 1 from app.user_country_roles where user_id = auth.uid() and level in ('editor', 'finance')));
drop function app.can_view_any_sensitive();
drop function app.can_edit_any_sensitive();

-- A person's name in two parts. display_name stays the name shown everywhere ("first
-- last" once both are set); the reports keep matching on display_name and legal_name.
alter table app.parties add column first_name text, add column last_name text;
