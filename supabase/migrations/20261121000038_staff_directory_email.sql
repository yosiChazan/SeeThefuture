-- A topic assigned to an employee stays visible to every staff member; the assignee gets a
-- ready-made e-mail draft from the sender's own mailbox (SPEC decision 92). For that the
-- directory now carries each employee's address. Still staff only, still no clients, and
-- nothing else from app.profiles (no roles).
drop function app.staff_directory();
create function app.staff_directory() returns table (user_id uuid, display_name text, email text)
language plpgsql stable security definer set search_path = '' as $$
begin
  if not (app.is_staff() and app.mfa_verified()) then
    raise exception 'staff only' using errcode = '42501';
  end if;
  return query
    select p.user_id, p.display_name, u.email::text from app.profiles p
    join auth.users u on u.id = p.user_id
    where p.client_party_id is null
      and (p.is_admin or p.is_management or exists (select 1 from app.user_country_roles r where r.user_id = p.user_id))
    order by p.display_name;
end $$;
revoke all on function app.staff_directory() from public;
grant execute on function app.staff_directory() to authenticated;
