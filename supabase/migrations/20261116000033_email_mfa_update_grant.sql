-- The email-code function records a verified session with an upsert (a second code in the
-- same session renews it). An upsert needs UPDATE as well as INSERT, which migration 32 did
-- not give: the code was accepted by Supabase, but the session was not recorded, and the
-- screen said "wrong code" (SPEC decision 88).
grant update on app.email_mfa_sessions to service_role;
