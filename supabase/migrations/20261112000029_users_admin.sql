-- The users screen (SPEC decision 86): an admin sees who can sign in and gives access.
-- Creating a sign-in, setting a password and resetting the authenticator app happen in the
-- Edge Function admin-users (they need the service role); everything else is plain rows in
-- app.profiles and app.user_country_roles, written under the existing admin-only policies.

-- Who can sign in, for an admin who completed TOTP: e-mail, last sign-in and whether an
-- authenticator app is set up. Never passwords or factor secrets.
create function app.admin_users()
returns table (user_id uuid, email text, created_at timestamptz, last_sign_in_at timestamptz, has_totp boolean)
language plpgsql stable security definer set search_path = '' as $$
begin
  if not (app.is_admin() and app.mfa_verified()) then
    raise exception 'admins only' using errcode = '42501';
  end if;
  return query
    select u.id, u.email::text, u.created_at, u.last_sign_in_at,
           exists (select 1 from auth.mfa_factors f where f.user_id = u.id and f.factor_type = 'totp' and f.status = 'verified')
    from auth.users u
    order by u.created_at;
end $$;
revoke all on function app.admin_users() from public;
grant execute on function app.admin_users() to authenticated;

-- There is always at least one admin: removing the last one would lock everyone out.
create function app.keep_an_admin() returns trigger
language plpgsql security definer set search_path = '' as $$
begin
  if not exists (select 1 from app.profiles where is_admin) then
    raise exception 'at least one admin must remain' using errcode = '23514';
  end if;
  return null;
end $$;
create constraint trigger keep_an_admin after update or delete on app.profiles
  deferrable initially deferred for each row execute function app.keep_an_admin();
