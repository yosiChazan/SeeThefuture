-- The admin-users function (SPEC decision 86) writes the new user's app.profiles row, and
-- removes it with the sign-in, as the service role. The service role had no rights on
-- app.profiles, so creating a user failed with "permission denied for table profiles".
grant usage on schema app to service_role;
grant select, insert, delete on app.profiles to service_role;
