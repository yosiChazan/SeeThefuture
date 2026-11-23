-- AI answers a client in WhatsApp on a staff member's request (SPEC decision 183; this narrows
-- §6.5's "no automatic answers": only where a person chose it, on one topic, and visibly).
-- * ai_guides: the guides the AI may answer from (e.g. opening a Wise account), written and
--   approved by the office; only an active guide can be used.
-- * A chat handed to the AI (ai_guide_id) is answered by it, message by message, until the topic
--   is done, a person presses stop, the time runs out (ai_until), or a question comes that the
--   guide does not cover: then it hands the chat back (ai_handback_reason) and the chat is open.
-- * Its messages are origin 'ai', so the inbox marks them.

create table app.ai_guides (
  id          uuid primary key default gen_random_uuid(),
  title       text not null,
  countries   char(2)[] not null default '{}',     -- whose clients it is for (empty: all)
  content     text not null,                        -- the guide itself, in Hebrew
  active      boolean not null default false,       -- approved for use
  updated_at  timestamptz not null default now(),
  updated_by  uuid default auth.uid()
);
alter table app.ai_guides enable row level security;
create policy staff_read on app.ai_guides for select to authenticated using (app.is_staff());
create policy admin_write on app.ai_guides for all to authenticated using (app.is_admin()) with check (app.is_admin());
create policy require_mfa on app.ai_guides as restrictive for all to authenticated
  using (app.mfa_verified() or app.my_party_id() is not null) with check (app.mfa_verified() or app.my_party_id() is not null);
grant select, insert, update, delete on app.ai_guides to authenticated;
grant select on app.ai_guides to service_role;
create trigger audit after insert or update or delete on app.ai_guides for each row execute function app.audit();

alter table app.conversations
  add column ai_guide_id        uuid references app.ai_guides,
  add column ai_started_at      timestamptz,
  add column ai_started_by      uuid,
  add column ai_until           timestamptz,
  add column ai_handback_reason text,
  add column ai_handback_at     timestamptz;

alter table app.messages drop constraint messages_origin_check;
alter table app.messages add constraint messages_origin_check check (origin in ('api', 'app', 'history', 'ai'));
