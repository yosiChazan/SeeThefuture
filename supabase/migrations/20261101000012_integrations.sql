-- Connections to outside services (SPEC decision 53). First: Itai's Dropbox folder,
-- read through its shared link with the office's own Dropbox authorization.
--
-- The row holds a Dropbox refresh token and the shared link, both as good as a
-- password: only an admin who completed two-factor sign-in can read or change it.

create table app.integrations (
  name           text primary key check (name in ('dropbox')),
  refresh_token  text,
  settings       jsonb not null default '{}',   -- dropbox: {"shared_link": ..., "files": {name: content_hash}}
  connected_by   uuid,
  connected_at   timestamptz,
  updated_at     timestamptz not null default now()
);

alter table app.integrations enable row level security;
create policy admin_all on app.integrations for all to authenticated
  using (app.is_admin()) with check (app.is_admin());
create policy require_mfa on app.integrations as restrictive for all to authenticated
  using (app.mfa_verified() or app.my_party_id() is not null)
  with check (app.mfa_verified() or app.my_party_id() is not null);
grant select, insert, update, delete on app.integrations to authenticated;

create trigger audit after insert or update or delete on app.integrations
  for each row execute function app.audit();
