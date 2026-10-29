-- Staff must complete two-factor sign-in (TOTP) before they can read or write
-- anything (SPEC §3, §7). Supabase puts the assurance level in the JWT: 'aal1'
-- after the password, 'aal2' after the code. Clients sign in with a one-time code
-- and are exempt (SPEC decision 38).
--
-- A restrictive policy is ANDed with the permissive ones, so this adds the
-- condition to every existing rule without rewriting them. Every new table in
-- `app` needs the same policy.

create function app.mfa_verified() returns boolean
language sql stable set search_path = '' as $$
  select coalesce(auth.jwt() ->> 'aal', '') = 'aal2'
$$;

do $$
declare t text;
begin
  for t in select tablename from pg_tables where schemaname = 'app' loop
    execute format(
      'create policy require_mfa on app.%I as restrictive for all to authenticated
         using (app.mfa_verified() or app.my_party_id() is not null)
         with check (app.mfa_verified() or app.my_party_id() is not null)', t);
  end loop;
end $$;
