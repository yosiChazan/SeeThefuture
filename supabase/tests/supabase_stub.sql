-- Minimal stand-in for what a Supabase project provides, so migrations and
-- policy tests run on a plain local Postgres. Never applied to Supabase.

create role anon nologin;
create role authenticated nologin;
create role service_role nologin bypassrls;

create schema auth;
create table auth.users (id uuid primary key, email text);

create function auth.uid() returns uuid
language sql stable as $$
  select nullif(current_setting('request.jwt.claim.sub', true), '')::uuid
$$;

-- Same definition as Supabase: the whole JWT payload of the request.
create function auth.jwt() returns jsonb
language sql stable as $$
  select coalesce(nullif(current_setting('request.jwt.claim', true), ''),
                  nullif(current_setting('request.jwt.claims', true), ''))::jsonb
$$;

grant usage on schema auth to authenticated, anon;
grant execute on function auth.uid() to authenticated, anon;
grant execute on function auth.jwt() to authenticated, anon;
