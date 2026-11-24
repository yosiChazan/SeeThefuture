-- The WhatsApp reminder by e-mail too (SPEC decision 188): every morning the database calls the
-- Edge Function wa-heartbeat-mail, which mails the admins (from the no-reply address) when 10 days
-- passed since "פתחתי את האפליקציה בטלפון" (or the connection), and again every 3 days until
-- someone presses it. The function decides by itself (app.wa_heartbeat_due), so calling it
-- needs no secret: at most one mail per 3 days can come out of it.
alter table app.whatsapp_account add column heartbeat_mailed_at timestamptz;

create function app.wa_heartbeat_due() returns table (days int, emails text[])
language sql stable security definer set search_path = '' as $$
  select floor(extract(epoch from now() - greatest(a.connected_at, coalesce(a.app_checked_at, a.connected_at))) / 86400)::int,
         (select array_agg(u.email::text) from app.profiles p join auth.users u on u.id = p.user_id where p.is_admin and u.email is not null)
  from app.whatsapp_account a
  where a.id = 1 and a.connected_at is not null
    and now() - greatest(a.connected_at, coalesce(a.app_checked_at, a.connected_at)) >= interval '10 days'
    and (a.heartbeat_mailed_at is null
         or a.heartbeat_mailed_at < greatest(a.connected_at, coalesce(a.app_checked_at, a.connected_at))
         or a.heartbeat_mailed_at < now() - interval '3 days')
$$;
create function app.wa_heartbeat_mailed() returns void
language sql security definer set search_path = '' as $$
  update app.whatsapp_account set heartbeat_mailed_at = now() where id = 1;
$$;
revoke all on function app.wa_heartbeat_due() from public;
revoke all on function app.wa_heartbeat_mailed() from public;
grant execute on function app.wa_heartbeat_due() to service_role;
grant execute on function app.wa_heartbeat_mailed() to service_role;

-- Each morning at 06:20 UTC (08:20 / 09:20 in Israel). Skipped where pg_cron or pg_net is missing.
do $$
begin
  create extension if not exists pg_cron;
  perform cron.schedule('whatsapp-heartbeat-mail', '20 6 * * *',
    $cmd$select net.http_post(url := 'https://oqvanprfxsdonzldgtnq.supabase.co/functions/v1/wa-heartbeat-mail', body := '{}'::jsonb, headers := '{"Content-Type": "application/json"}'::jsonb)$cmd$);
exception when others then
  raise notice 'pg_cron not available: %', sqlerrm;
end $$;
