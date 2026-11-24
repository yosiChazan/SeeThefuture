-- The WhatsApp reminder counts only from "פתחתי את האפליקציה בטלפון" (or the connection), not from
-- messages (SPEC decision 188): Meta counts only opening the app on the main phone, and a message
-- from WhatsApp Web would reset the count wrongly.
create or replace function app.wa_heartbeat_since() returns timestamptz
language sql stable security definer set search_path = '' as $$
  select greatest(a.connected_at, a.app_checked_at)
  from app.whatsapp_account a where a.id = 1 and a.connected_at is not null
$$;
