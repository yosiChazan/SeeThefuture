-- Queue for copying people's documents from Airtable (SPEC decision 64).
--
-- scripts/import/documents.ts writes one row per attachment (with Airtable's
-- short-lived signed link) through the Management API; the airtable-documents Edge
-- Function, running with the service role, takes rows from here and copies the
-- files. The function accepts no input, so calling it can only advance this queue:
-- no secret is needed. Nobody signed in can read the table (no policy grants it).

create table app.document_imports (
  att_id        text primary key,          -- Airtable attachment id
  url           text,                      -- cleared once handled
  file_name     text not null,
  content_type  text,
  country_code  char(2) not null references app.countries,
  party_id      uuid not null references app.parties,
  doc_type      text not null,
  status        text not null default 'pending' check (status in ('pending', 'working', 'done', 'failed')),
  result        text,
  updated_at    timestamptz not null default now()
);

alter table app.document_imports enable row level security;
create policy require_mfa on app.document_imports as restrictive for all to authenticated
  using (app.mfa_verified() or app.my_party_id() is not null)
  with check (app.mfa_verified() or app.my_party_id() is not null);
revoke all on app.document_imports from anon, authenticated;

-- Takes up to n pending rows for one call of the function. Rows left "working" by a
-- call that died are taken again after ten minutes.
create function app.claim_document_imports(n int) returns setof app.document_imports
language sql security definer set search_path = '' as $$
  update app.document_imports set status = 'working', updated_at = now()
  where att_id in (
    select att_id from app.document_imports
    where status = 'pending' or (status = 'working' and updated_at < now() - interval '10 minutes')
    order by att_id limit n for update skip locked)
  returning *
$$;
revoke execute on function app.claim_document_imports(int) from public, anon, authenticated;

-- The Edge Function's role: only what the copy needs.
grant usage on schema app to service_role;
grant select, update on app.document_imports to service_role;
grant select, insert on app.documents to service_role;
grant execute on function app.claim_document_imports(int) to service_role;
