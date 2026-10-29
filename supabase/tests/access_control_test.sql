-- Policy tests. Run with scripts/test-db.sh. Any failed check raises and the
-- script stops with a non-zero exit code.

\set ON_ERROR_STOP on

-- Fixtures (as the migration owner, no RLS) -------------------------------

insert into auth.users (id, email) values
  ('00000000-0000-0000-0000-00000000000a', 'admin@example.test'),
  ('00000000-0000-0000-0000-00000000000b', 'ro.editor@example.test'),
  ('00000000-0000-0000-0000-00000000000c', 'ua.finance@example.test'),
  ('00000000-0000-0000-0000-00000000000d', 'client@example.test'),
  ('00000000-0000-0000-0000-00000000000e', 'management@example.test');

insert into app.parties (id, kind, display_name) values
  ('10000000-0000-0000-0000-000000000001', 'person',  'Client One'),
  ('10000000-0000-0000-0000-000000000002', 'person',  'Client Two'),
  ('10000000-0000-0000-0000-000000000003', 'person',  'Gershon'),
  ('10000000-0000-0000-0000-000000000004', 'company', 'Wordistry SRL');

insert into app.profiles (user_id, display_name, is_admin, is_management, client_party_id) values
  ('00000000-0000-0000-0000-00000000000a', 'Admin', true, false, null),
  ('00000000-0000-0000-0000-00000000000b', 'RO editor', false, false, null),
  ('00000000-0000-0000-0000-00000000000c', 'UA finance', false, false, null),
  ('00000000-0000-0000-0000-00000000000d', 'Client One', false, false, '10000000-0000-0000-0000-000000000001'),
  ('00000000-0000-0000-0000-00000000000e', 'Management', false, true, null);

insert into app.user_country_roles (user_id, country_code, level) values
  ('00000000-0000-0000-0000-00000000000b', 'RO', 'editor'),
  ('00000000-0000-0000-0000-00000000000c', 'UA', 'finance');

insert into app.cities (id, country_code, name_he, name_en) values
  ('20000000-0000-0000-0000-000000000001', 'UA', 'קייב', 'Kyiv'),
  ('20000000-0000-0000-0000-000000000002', 'RO', 'בוקרשט', 'Bucharest');

insert into app.projects (id, city_id, name) values
  ('21000000-0000-0000-0000-000000000001', '20000000-0000-0000-0000-000000000001', 'Lake City');

insert into app.buildings (id, city_id, project_id, name) values
  ('22000000-0000-0000-0000-000000000001', '20000000-0000-0000-0000-000000000001', '21000000-0000-0000-0000-000000000001', '2'),
  ('22000000-0000-0000-0000-000000000002', '20000000-0000-0000-0000-000000000002', null, 'Beldiman 1');

insert into app.properties (id, building_id, unit_no, status) values
  ('30000000-0000-0000-0000-000000000001', '22000000-0000-0000-0000-000000000001', '12', 'rented'),
  ('30000000-0000-0000-0000-000000000002', '22000000-0000-0000-0000-000000000002', '57', 'rented'),
  ('30000000-0000-0000-0000-000000000003', '22000000-0000-0000-0000-000000000001', '16', 'rented');

insert into app.ownerships (property_id, party_id, share_pct, valid_from) values
  ('30000000-0000-0000-0000-000000000001', '10000000-0000-0000-0000-000000000001', 100, '2023-01-01'),
  ('30000000-0000-0000-0000-000000000003', '10000000-0000-0000-0000-000000000002', 100, '2023-01-01');

insert into app.accounts (id, holder_party_id, beneficiary_party_id, country_code, currency, kind) values
  ('40000000-0000-0000-0000-000000000001', '10000000-0000-0000-0000-000000000003', '10000000-0000-0000-0000-000000000001', 'UA', 'UAH', 'rent_pool'),
  ('40000000-0000-0000-0000-000000000002', '10000000-0000-0000-0000-000000000003', '10000000-0000-0000-0000-000000000002', 'UA', 'UAH', 'rent_pool');

-- Helpers ---------------------------------------------------------------

-- Signed in with password and TOTP (aal2) unless told otherwise.
create function pg_temp.as_user(u text, aal text default 'aal2') returns void language plpgsql as $$
begin
  perform set_config('request.jwt.claim.sub', u, false);
  perform set_config('request.jwt.claims', json_build_object('sub', u, 'aal', aal)::text, false);
  execute 'set role authenticated';
end $$;

create function pg_temp.check(ok boolean, what text) returns void language plpgsql as $$
begin
  if not ok then raise exception 'FAILED: %', what; end if;
  raise notice 'ok - %', what;
end $$;

-- Derived country --------------------------------------------------------

select pg_temp.check(
  (select country_code from app.properties where id = '30000000-0000-0000-0000-000000000002') = 'RO',
  'property country is derived from its building');

-- Romania editor ---------------------------------------------------------

select pg_temp.as_user('00000000-0000-0000-0000-00000000000b');
select pg_temp.check((select count(*) from app.properties) = 1, 'RO editor sees only Romanian properties');
select pg_temp.check((select count(*) from app.accounts) = 0, 'RO editor sees no Ukrainian accounts');
do $$ begin
  begin
    insert into app.transactions (country_code, occurred_on, period, category, status)
    values ('UA', '2026-01-05', '2026-01-01', 'rent', 'draft');
    raise exception 'FAILED: RO editor inserted a UA transaction';
  exception when insufficient_privilege then raise notice 'ok - RO editor cannot write UA ledger';
  end;
end $$;
do $$ begin
  begin
    insert into app.transactions (country_code, occurred_on, period, category, status)
    values ('RO', '2026-01-05', '2026-01-01', 'rent', 'posted');
    raise exception 'FAILED: editor posted a transaction';
  exception when raise_exception then
    if sqlerrm like 'FAILED%' then raise; end if;
    raise notice 'ok - editor cannot post (%)', sqlerrm;
  end;
end $$;
reset role;

-- Ukraine finance: full ledger cycle ------------------------------------

select pg_temp.as_user('00000000-0000-0000-0000-00000000000c');
insert into app.transactions (id, country_code, occurred_on, period, category, description)
values ('50000000-0000-0000-0000-000000000001', 'UA', '2026-01-14', '2026-01-01', 'rent', 'January rent');
insert into app.entries (transaction_id, account_id, property_id, amount, currency) values
  ('50000000-0000-0000-0000-000000000001', '40000000-0000-0000-0000-000000000001', '30000000-0000-0000-0000-000000000001', 22500, 'UAH');
do $$ begin
  begin
    insert into app.entries (transaction_id, account_id, amount, currency)
    values ('50000000-0000-0000-0000-000000000001', '40000000-0000-0000-0000-000000000001', 1, 'USD');
    raise exception 'FAILED: entry currency mismatch accepted';
  exception when raise_exception then
    if sqlerrm like 'FAILED%' then raise; end if;
    raise notice 'ok - entry currency must match account';
  end;
end $$;
select pg_temp.check(
  (select balance from app.account_balances where account_id = '40000000-0000-0000-0000-000000000001') = 0,
  'draft transactions do not affect balances');
update app.transactions set status = 'posted' where id = '50000000-0000-0000-0000-000000000001';
select pg_temp.check(
  (select balance from app.account_balances where account_id = '40000000-0000-0000-0000-000000000001') = 22500,
  'posted transaction updates the balance');
select pg_temp.check(
  (select approved_by from app.transactions where id = '50000000-0000-0000-0000-000000000001')
    = '00000000-0000-0000-0000-00000000000c',
  'approver is recorded');
do $$ begin
  begin
    update app.entries set amount = 1 where transaction_id = '50000000-0000-0000-0000-000000000001';
    raise exception 'FAILED: posted entry changed';
  exception when raise_exception then
    if sqlerrm like 'FAILED%' then raise; end if;
    raise notice 'ok - posted entries are immutable';
  end;
end $$;
reset role;

-- Client ----------------------------------------------------------------

select pg_temp.as_user('00000000-0000-0000-0000-00000000000d');
select pg_temp.check((select count(*) from app.properties) = 1, 'client sees only own property');
select pg_temp.check((select count(*) from app.accounts) = 1, 'client sees only own account');
select pg_temp.check((select count(*) from app.parties) = 1, 'client sees only own party');
select pg_temp.check((select count(*) from app.transactions) = 1, 'client sees posted transaction on own account');
select pg_temp.check(
  (select balance from app.account_balances) = 22500, 'client sees own balance');
select pg_temp.check((select count(*) from app.audit_log) = 0, 'client cannot read audit log');
reset role;

-- Management ------------------------------------------------------------

select pg_temp.as_user('00000000-0000-0000-0000-00000000000e');
select pg_temp.check((select count(*) from app.properties) = 3, 'management reads all countries');
do $$ begin
  begin
    update app.properties set notes = 'x';
    if exists (select 1 from app.properties where notes = 'x') then
      raise exception 'FAILED: management edited a property';
    end if;
    raise notice 'ok - management is read-only';
  end;
end $$;
reset role;

-- Charges ----------------------------------------------------------------

select pg_temp.as_user('00000000-0000-0000-0000-00000000000b');
insert into app.charges (property_id, period, kind, amount, currency)
values ('30000000-0000-0000-0000-000000000002', '2026-01-01', 'electricity', 180, 'RON');
do $$ begin
  begin
    insert into app.charges (property_id, period, kind, amount, currency)
    values ('30000000-0000-0000-0000-000000000001', '2026-01-01', 'rent', 22500, 'UAH');
    raise exception 'FAILED: RO editor added a UA charge';
  exception when insufficient_privilege then raise notice 'ok - RO editor cannot add UA charges';
  end;
end $$;
select pg_temp.check((select count(*) from app.charges) = 1, 'RO editor sees Romanian charges');
reset role;

select pg_temp.as_user('00000000-0000-0000-0000-00000000000d');
select pg_temp.check((select count(*) from app.charges) = 0, 'client does not see charges of other properties');
reset role;

-- Two-factor sign-in -----------------------------------------------------

select pg_temp.as_user('00000000-0000-0000-0000-00000000000a', 'aal1');
select pg_temp.check((select count(*) from app.properties) = 0, 'admin without the TOTP code sees no properties');
select pg_temp.check((select count(*) from app.profiles) = 0, 'admin without the TOTP code cannot read profiles');
reset role;

select pg_temp.as_user('00000000-0000-0000-0000-00000000000b', 'aal1');
select pg_temp.check((select count(*) from app.properties) = 0, 'RO editor without the TOTP code sees nothing');
do $$ begin
  update app.properties set notes = 'x' where country_code = 'RO';
  if found then raise exception 'FAILED: RO editor without the TOTP code updated a property'; end if;
  raise notice 'ok - RO editor without the TOTP code cannot update';
end $$;
reset role;

select pg_temp.as_user('00000000-0000-0000-0000-00000000000d', 'aal1');
select pg_temp.check((select count(*) from app.properties) = 1, 'client with a one-time code (aal1) still sees own property');
reset role;

-- Audit -----------------------------------------------------------------

select pg_temp.check(
  (select count(*) from app.audit_log where table_name = 'transactions') >= 2,
  'ledger changes are audited');

\echo ALL TESTS PASSED
