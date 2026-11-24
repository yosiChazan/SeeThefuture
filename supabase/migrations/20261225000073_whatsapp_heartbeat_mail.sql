-- The WhatsApp reminder by e-mail too (SPEC decision 188): every hour the database calls the Edge
-- Function wa-heartbeat-mail, which mails the admins (from the no-reply address) when 10 days
-- passed since the later of: the connection, "פתחתי את האפליקציה בטלפון", and the last message
-- sent from the app or WhatsApp Web. On days 10, 11 and 12 once a day; from day 13 every hour,
-- until one of those happens. The function decides by itself (app.wa_heartbeat_due), so calling
-- it needs no secret: nothing beyond that schedule can come out of it.
alter table app.whatsapp_account add column heartbeat_mailed_at timestamptz;

-- The start of the current count: the connection, the last "opened", or the last message from the app.
create function app.wa_heartbeat_since() returns timestamptz
language sql stable security definer set search_path = '' as $$
  select greatest(a.connected_at, a.app_checked_at,
                  (select max(m.created_at) from app.messages m where m.origin = 'app'))
  from app.whatsapp_account a where a.id = 1 and a.connected_at is not null
$$;

create function app.wa_heartbeat_due() returns table (days int, emails text[])
language plpgsql stable security definer set search_path = '' as $$
declare since timestamptz := app.wa_heartbeat_since(); d int; sent timestamptz;
begin
  if since is null then return; end if;
  d := floor(extract(epoch from now() - since) / 86400)::int;
  if d < 10 then return; end if;
  select heartbeat_mailed_at into sent from app.whatsapp_account where id = 1;
  if sent is not null and sent >= since and (
       (d <= 12 and sent >= since + make_interval(days => d))          -- days 10-12: once that day
    or (d >= 13 and sent >= now() - interval '55 minutes')) then        -- from day 13: every hour
    return;
  end if;
  return query select d, (select array_agg(u.email::text) from app.profiles p join auth.users u on u.id = p.user_id where p.is_admin and u.email is not null);
end $$;

create function app.wa_heartbeat_mailed() returns void
language sql security definer set search_path = '' as $$
  update app.whatsapp_account set heartbeat_mailed_at = now() where id = 1;
$$;
revoke all on function app.wa_heartbeat_since() from public;
revoke all on function app.wa_heartbeat_due() from public;
revoke all on function app.wa_heartbeat_mailed() from public;
grant execute on function app.wa_heartbeat_since() to authenticated, service_role;
grant execute on function app.wa_heartbeat_due() to service_role;
grant execute on function app.wa_heartbeat_mailed() to service_role;

-- Every hour at :20. Skipped where pg_cron or pg_net is missing.
do $$
begin
  create extension if not exists pg_cron;
  perform cron.schedule('whatsapp-heartbeat-mail', '20 * * * *',
    $cmd$select net.http_post(url := 'https://oqvanprfxsdonzldgtnq.supabase.co/functions/v1/wa-heartbeat-mail', body := '{}'::jsonb, headers := '{"Content-Type": "application/json"}'::jsonb)$cmd$);
exception when others then
  raise notice 'pg_cron not available: %', sqlerrm;
end $$;
