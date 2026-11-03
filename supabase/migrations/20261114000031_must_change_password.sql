-- A user given a password by an admin must replace it at the next sign-in (SPEC decision 87).
-- The admin sets the flag (creating a user, or giving a new password) under the existing
-- admin-only policy. The user cannot write app.profiles, so clearing it goes through
-- app.password_changed(), which touches only the caller's own flag.
alter table app.profiles add column must_change_password boolean not null default false;

create function app.password_changed() returns void
language sql security definer set search_path = '' as $$
  update app.profiles set must_change_password = false where user_id = auth.uid() and must_change_password;
$$;
revoke all on function app.password_changed() from public;
grant execute on function app.password_changed() to authenticated;
