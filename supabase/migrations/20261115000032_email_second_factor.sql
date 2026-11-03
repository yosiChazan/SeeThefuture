-- A second factor by e-mail for users who are not admins (SPEC decision 88).
-- Supabase's own second factor is an authenticator app (TOTP) or SMS; e-mail is not one of
-- them, and only Supabase can mark a session 'aal2'. So the code by e-mail is kept here:
-- after the password, the Edge Function email-code sends a 6-digit code (through Supabase's
-- own sign-in e-mail) and, when the right code comes back, records the caller's own session.
-- That session then counts as verified, like aal2, for 12 hours. Admins always use the app.
create table app.email_mfa_sessions (
  session_id   uuid primary key,
  user_id      uuid not null references auth.users on delete cascade,
  verified_at  timestamptz not null default now()
);
create index on app.email_mfa_sessions (user_id);
alter table app.email_mfa_sessions enable row level security;
-- Read by app.mfa_verified() as the user; written only by the function (service role).
-- Deliberately without require_mfa: it is what require_mfa reads.
create policy own_read on app.email_mfa_sessions for select to authenticated using (user_id = auth.uid());
grant select on app.email_mfa_sessions to authenticated;
grant select, insert, delete on app.email_mfa_sessions to service_role;

-- Same function, one more way to be verified. Kept in SQL so the planner evaluates the
-- check once per query, not once per row.
create or replace function app.mfa_verified() returns boolean
language sql stable set search_path = '' as $$
  select coalesce(auth.jwt() ->> 'aal', '') = 'aal2'
      or exists (
        select 1 from app.email_mfa_sessions e
        where e.session_id = nullif(auth.jwt() ->> 'session_id', '')::uuid
          and e.user_id = auth.uid()
          and e.verified_at > now() - interval '12 hours'
          and not app.is_admin())
$$;
