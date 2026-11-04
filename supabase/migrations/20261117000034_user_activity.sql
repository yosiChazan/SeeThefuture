-- Everything a user did, with the date (SPEC decision 90): the users screen reads audit_log
-- by user. Until now some tables were not audited at all (properties, documents, report
-- approvals...), and sign-ins were not recorded anywhere the app can read.

-- 1. Audit the tables that were left out. Not: the log itself, the copy queue, the e-mail
-- code sessions (written by functions), the fixed list of countries, and report rows (a
-- report's approval is recorded on import_batches; its rows would only add noise).
do $$
declare t text;
begin
  foreach t in array array[
    'buildings', 'charges', 'cities', 'conversations', 'documents', 'external_refs', 'fx_rates',
    'import_batches', 'import_sources', 'messages', 'milestones', 'party_roles', 'projects',
    'properties', 'site_updates', 'tasks', 'utility_contracts'
  ] loop
    if not exists (select 1 from pg_trigger g join pg_class c on c.oid = g.tgrelid join pg_namespace n on n.oid = c.relnamespace
                   where n.nspname = 'app' and c.relname = t and g.tgname = 'audit') then
      execute format('create trigger audit after insert or update or delete on app.%I for each row execute function app.audit()', t);
    end if;
  end loop;
end $$;

create index if not exists audit_log_user_at on app.audit_log (user_id, at desc);

-- 2. Sign-ins: the app calls this once the second step is done. One row per session.
create function app.log_sign_in() returns void
language sql security definer set search_path = '' as $$
  insert into app.audit_log (user_id, table_name, row_id, action)
  select auth.uid(), 'sessions', nullif(auth.jwt() ->> 'session_id', '')::uuid, 'LOGIN'
  where auth.uid() is not null
    and not exists (select 1 from app.audit_log a where a.table_name = 'sessions' and a.action = 'LOGIN'
                    and a.row_id = nullif(auth.jwt() ->> 'session_id', '')::uuid and a.user_id = auth.uid());
$$;
revoke all on function app.log_sign_in() from public;
grant execute on function app.log_sign_in() to authenticated;
