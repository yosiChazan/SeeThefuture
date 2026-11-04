-- Topics added by hand on the completeness page (SPEC decision 92): a question or a task,
-- sent to an employee, answered and closed there. They live in app.tasks (built for this,
-- unused until now, already audited).
alter table app.tasks alter column created_by set default auth.uid();
alter table app.tasks
  add column reply     text,
  add column done_at   timestamptz,
  add column done_by   uuid;

-- The names of the office's users, for every staff member: to send a topic to someone and
-- to see who sent it. Names only; no e-mail, roles or anything else from app.profiles.
create function app.staff_directory() returns table (user_id uuid, display_name text)
language plpgsql stable security definer set search_path = '' as $$
begin
  if not (app.is_staff() and app.mfa_verified()) then
    raise exception 'staff only' using errcode = '42501';
  end if;
  return query
    select p.user_id, p.display_name from app.profiles p
    where p.client_party_id is null
      and (p.is_admin or p.is_management or exists (select 1 from app.user_country_roles r where r.user_id = p.user_id))
    order by p.display_name;
end $$;
revoke all on function app.staff_directory() from public;
grant execute on function app.staff_directory() to authenticated;
