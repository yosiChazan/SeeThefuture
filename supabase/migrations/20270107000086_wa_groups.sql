-- WhatsApp groups, read only (SPEC decision 212). A browser extension on WhatsApp Web, open on the
-- office's computer, reads what the page shows (never clicks, never writes) and sends it to the
-- function wa-groups-ingest with a key made in Settings. Groups by their name (and WhatsApp id once
-- seen); messages by WhatsApp's id when the group was open, or by their text when only the chat
-- list's preview was seen. Pictures shown in an open group are kept in the "whatsapp" bucket.

create table app.wa_groups (
  id               uuid primary key default gen_random_uuid(),
  title            text not null unique,
  jid              text unique,
  first_seen_at    timestamptz not null default now(),
  last_message_at  timestamptz
);

create table app.wa_group_messages (
  id            uuid primary key default gen_random_uuid(),
  group_id      uuid not null references app.wa_groups on delete cascade,
  wa_id         text unique,          -- WhatsApp's id: the group was open on the screen
  preview_key   text unique,          -- the chat list's last line only
  sender        text,
  body          text,
  sent_at       timestamptz,
  sent_at_text  text,
  kind          text not null default 'text' check (kind in ('text', 'image', 'document', 'other')),
  file_name     text,
  media_path    text,
  origin        text not null check (origin in ('open', 'preview')),
  created_at    timestamptz not null default now(),
  check (num_nonnulls(wa_id, preview_key) = 1)
);
create index on app.wa_group_messages (group_id, created_at);

-- The extension's keys: only a hash is kept; the key is shown once when made.
create table app.ext_tokens (
  id            uuid primary key default gen_random_uuid(),
  token_hash    text not null unique,
  label         text not null,
  created_by    uuid default auth.uid(),
  created_at    timestamptz not null default now(),
  last_used_at  timestamptz,
  revoked_at    timestamptz
);

alter table app.wa_groups enable row level security;
alter table app.wa_group_messages enable row level security;
alter table app.ext_tokens enable row level security;
create policy staff_read on app.wa_groups for select to authenticated using (app.is_staff());
create policy staff_read on app.wa_group_messages for select to authenticated using (app.is_staff());
create policy admin_all on app.ext_tokens for all to authenticated using (app.is_admin()) with check (app.is_admin());
do $$
declare t text;
begin
  foreach t in array array['wa_groups', 'wa_group_messages', 'ext_tokens'] loop
    execute format('create policy require_mfa on app.%I as restrictive for all to authenticated
      using (app.mfa_verified() or app.my_party_id() is not null) with check (app.mfa_verified() or app.my_party_id() is not null)', t);
  end loop;
end $$;
grant select on app.wa_groups, app.wa_group_messages to authenticated;
grant select, insert, update, delete on app.ext_tokens to authenticated;
grant select, insert, update on app.wa_groups, app.wa_group_messages, app.ext_tokens to service_role;
