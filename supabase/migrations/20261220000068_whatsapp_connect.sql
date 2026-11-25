-- WhatsApp connected to the system (SPEC §6.5, decisions 135, 139, 180). The company's number
-- stays in the WhatsApp Business app and is also on the Cloud API (Meta's "coexistence"):
-- * a message a client sends, and one we send from the phone's app, reach the webhook
--   (Edge Function whatsapp-webhook) and are written here; so is the chat history of the last
--   6 months, which Meta sends once after the number is connected;
-- * a message written in the inbox goes out through the Edge Function whatsapp-send.
-- A chat belongs to a client when its number is one of the client's phones (app.wa_party_for).
-- The connection (whatsapp_account) is read by staff; its token (whatsapp_secret) is read by no
-- one but the Edge Functions (service role).

alter table app.conversations add column contact_name text;   -- the name the person gave WhatsApp

alter table app.messages
  add column kind        text not null default 'text',          -- text, image, document, audio, video, sticker, location, template, …
  add column origin      text not null default 'api' check (origin in ('api', 'app', 'history')),   -- the inbox / the phone's app / the history
  add column status      text,                                   -- of ours: sent, delivered, read, failed
  add column error       text,
  add column file_name   text,
  add column wa_timestamp timestamptz;                           -- when WhatsApp says it was sent

-- The connected number (one row).
create table app.whatsapp_account (
  id               int primary key default 1 check (id = 1),
  waba_id          text,
  phone_number_id  text,
  display_phone    text,
  connected_at     timestamptz,
  connected_by     uuid,
  contacts_sync_at timestamptz,
  history_sync_at  timestamptz,
  last_webhook_at  timestamptz,
  last_error       text
);
alter table app.whatsapp_account enable row level security;
create policy staff_read on app.whatsapp_account for select to authenticated using (app.is_staff());
create policy require_mfa on app.whatsapp_account as restrictive for all to authenticated
  using (app.mfa_verified() or app.my_party_id() is not null) with check (app.mfa_verified() or app.my_party_id() is not null);
grant select on app.whatsapp_account to authenticated;

-- The business token Meta gives for the number. No policy lets anyone read it.
create table app.whatsapp_secret (
  id      int primary key default 1 check (id = 1),
  token   text not null,
  set_at  timestamptz not null default now()
);
alter table app.whatsapp_secret enable row level security;
create policy require_mfa on app.whatsapp_secret as restrictive for all to authenticated
  using (app.mfa_verified() or app.my_party_id() is not null) with check (app.mfa_verified() or app.my_party_id() is not null);
revoke all on app.whatsapp_secret from anon, authenticated;

-- The client whose phone (main or extra) is this number, by its digits ("972521234567").
create function app.wa_party_for(p_digits text) returns uuid
language sql stable security definer set search_path = '' as $$
  with d as (select regexp_replace(coalesce(p_digits, ''), '\D', '', 'g') as n)
  select p.id from app.parties p, d
  where d.n <> '' and (
    regexp_replace(coalesce(p.phone, ''), '\D', '', 'g') = d.n
    or exists (select 1 from jsonb_array_elements(p.extra_phones) x where regexp_replace(coalesce(x ->> 'phone', ''), '\D', '', 'g') = d.n))
  order by exists (select 1 from app.party_roles r where r.party_id = p.id and r.role = 'client') desc, p.created_at
  limit 1
$$;

-- A chat whose client was not known yet is matched when a phone is added to a client.
create function app.wa_match_conversations() returns trigger
language plpgsql security definer set search_path = '' as $$
begin
  update app.conversations c set client_party_id = app.wa_party_for(c.wa_phone)
  where c.client_party_id is null and app.wa_party_for(c.wa_phone) is not null;
  return null;
end $$;
create trigger wa_match after insert or update of phone, extra_phones on app.parties
  for each statement execute function app.wa_match_conversations();

-- Pictures and files of the chats (private bucket "whatsapp", read by staff).
do $$
begin
  if exists (select 1 from pg_namespace where nspname = 'storage') then
    insert into storage.buckets (id, name, public) values ('whatsapp', 'whatsapp', false) on conflict (id) do nothing;
    create policy whatsapp_read on storage.objects for select to authenticated
      using (bucket_id = 'whatsapp' and app.is_staff() and app.mfa_verified());
  end if;
end $$;
