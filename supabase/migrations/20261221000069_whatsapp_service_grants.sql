-- The WhatsApp Edge Functions write with the service role (SPEC decision 182), which in this
-- project has no table rights in the app schema by default: the first messages that reached
-- whatsapp-webhook were refused ("permission denied for table whatsapp_account"). Only what the
-- functions use.
grant select, insert, update on app.whatsapp_account to service_role;
grant select, insert, update on app.whatsapp_secret to service_role;
grant select, insert, update on app.conversations to service_role;
grant select, insert, update on app.messages to service_role;
grant insert on app.audit_log to service_role;
grant execute on function app.wa_party_for(text) to service_role;
