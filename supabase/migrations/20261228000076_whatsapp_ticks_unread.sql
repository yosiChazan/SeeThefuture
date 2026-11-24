-- WhatsApp inbox (SPEC decision 192): ticks that follow the real chat, and unread counts.
--
-- Ticks. WhatsApp does not always report every message: a "read" for a later message, or the
-- client writing back, means everything before it was read too. A status never goes back
-- (a late "delivered" after "read" is ignored). A failed message stays failed.
--
-- Unread. The office reads a chat when it is open on the screen: staff_read_at. Client messages
-- after it are unread (counted in the app).

alter table app.conversations add column staff_read_at timestamptz;
update app.conversations set staff_read_at = now();

create function app.wa_tick_rank(s text) returns int language sql immutable as $$
  select case s when 'read' then 3 when 'delivered' then 2 when 'sent' then 1 else 0 end
$$;

create function app.wa_tick_keep() returns trigger language plpgsql as $$
begin
  if old.status = 'failed' or app.wa_tick_rank(new.status) < app.wa_tick_rank(old.status) and new.status is distinct from 'failed' then
    new.status := old.status;
  end if;
  return new;
end $$;

create trigger wa_tick_keep before update of status on app.messages
  for each row when (old.direction = 'out') execute function app.wa_tick_keep();

create function app.wa_tick_spread() returns trigger language plpgsql as $$
declare to_status text;
begin
  if pg_trigger_depth() > 1 then return null; end if;
  if new.direction = 'in' and new.origin is distinct from 'history' then to_status := 'read';
  elsif new.direction = 'out' and new.status in ('read', 'delivered') then to_status := new.status;
  else return null; end if;
  update app.messages set status = to_status
   where conversation_id = new.conversation_id and direction = 'out' and id <> new.id
     and created_at <= new.created_at and status is distinct from 'failed'
     and app.wa_tick_rank(status) < app.wa_tick_rank(to_status);
  return null;
end $$;

create trigger wa_tick_spread after insert or update of status on app.messages
  for each row execute function app.wa_tick_spread();

-- What is already there.
update app.messages m set status = 'read'
 where m.direction = 'out' and m.status is distinct from 'failed' and m.status is distinct from 'read'
   and exists (select 1 from app.messages l where l.conversation_id = m.conversation_id and l.created_at > m.created_at
               and (l.direction = 'in' and l.origin is distinct from 'history' or l.direction = 'out' and l.status = 'read'));
update app.messages m set status = 'delivered'
 where m.direction = 'out' and app.wa_tick_rank(m.status) < 2 and m.status is distinct from 'failed'
   and exists (select 1 from app.messages l where l.conversation_id = m.conversation_id and l.created_at > m.created_at
               and l.direction = 'out' and l.status = 'delivered');
