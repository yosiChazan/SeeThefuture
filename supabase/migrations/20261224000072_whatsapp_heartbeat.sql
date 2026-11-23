-- A reminder to use the WhatsApp Business app (SPEC decision 188): Meta disconnects a number
-- that is on the API together with the app when the app is not opened for about 14 days. The
-- system shows a reminder to every staff member once 10 days passed since the last message sent
-- from the app (or WhatsApp Web), or since someone marked "I opened the app".
alter table app.whatsapp_account add column app_checked_at timestamptz;

create function app.wa_app_checked() returns void
language sql security definer set search_path = '' as $$
  update app.whatsapp_account set app_checked_at = now() where id = 1 and app.is_staff();
$$;
revoke all on function app.wa_app_checked() from public;
grant execute on function app.wa_app_checked() to authenticated;
