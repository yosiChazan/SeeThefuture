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

-- Intake commit -----------------------------------------------------------

-- A UA property owned half and half; one Vitaly batch with rent and his fee.
insert into app.properties (id, building_id, unit_no, status) values
  ('30000000-0000-0000-0000-000000000004', '22000000-0000-0000-0000-000000000001', '30', 'rented');
insert into app.ownerships (property_id, party_id, share_pct, valid_from) values
  ('30000000-0000-0000-0000-000000000004', '10000000-0000-0000-0000-000000000001', 50, '2023-01-01'),
  ('30000000-0000-0000-0000-000000000004', '10000000-0000-0000-0000-000000000002', 50, '2023-01-01');

create function pg_temp.vitaly_batch(p_id uuid) returns void language sql as $$
  insert into app.import_batches (id, source_id, country_code, status)
  select p_id, s.id, 'UA', 'in_review' from app.import_sources s where s.adapter = 'vitaly_rent_xlsx';
  insert into app.import_rows (batch_id, row_ref, raw, property_id, match_status, fingerprint, proposed) values
    (p_id, '001', '{"property_ref": "PLC 17(2), APT. 30"}', '30000000-0000-0000-0000-000000000004', 'matched',
     'vitaly|30|2026-01|rent|20001',
     '{"occurred_on": "2026-01-08", "period": "2026-01-01", "category": "rent", "description": "Rent",
       "entries": [{"amount": 20000.01, "currency": "UAH", "account": {"kind": "manager_cash", "holder": "source"}}]}'),
    (p_id, '002', '{}', '30000000-0000-0000-0000-000000000004', 'matched',
     'vitaly|30|2026-01|mgmt_fee|2000',
     '{"occurred_on": "2026-01-31", "period": "2026-01-01", "category": "mgmt_fee", "description": "10%",
       "entries": [{"amount": -2000, "currency": "UAH", "account": {"kind": "manager_cash", "holder": "source"}},
                   {"amount": 2000, "currency": "UAH", "external": "source"}]}'),
    (p_id, '003', '{}', null, 'ignored', null, null);
$$;
select pg_temp.vitaly_batch('50000000-0000-0000-0000-000000000001');

select pg_temp.as_user('00000000-0000-0000-0000-00000000000b');
do $$ begin
  perform app.commit_import_batch('50000000-0000-0000-0000-000000000001');
  raise exception 'FAILED: RO editor committed a UA batch';
exception when others then
  if sqlerrm like 'FAILED%' then raise; end if;
  raise notice 'ok - RO editor cannot commit a UA batch';
end $$;
reset role;

select pg_temp.as_user('00000000-0000-0000-0000-00000000000c');
select pg_temp.check(app.commit_import_batch('50000000-0000-0000-0000-000000000001') = 2,
  'UA finance commits the matched rows and skips the ignored one');
select pg_temp.check(
  (select array_agg(balance order by balance)::text from app.account_balances
   where kind = 'manager_cash' and holder_party_id = 'a0000000-0000-4000-8000-000000000001') = '{9000.00,9000.01}',
  'rent and fee are split between co-owners by share, remainder to the last owner');
select pg_temp.check(
  (select status from app.import_batches where id = '50000000-0000-0000-0000-000000000001') = 'committed',
  'batch is marked committed');
select pg_temp.check(
  (select count(*) from app.transactions where import_batch_id = '50000000-0000-0000-0000-000000000001' and status = 'posted') = 2,
  'committed rows become posted transactions linked to the batch');
reset role;

select pg_temp.check(
  exists (select 1 from app.external_refs where source = 'vitaly_rent_xlsx' and external_key = 'PLC 17(2), APT. 30'),
  'commit remembers the source''s name for the property');

select pg_temp.vitaly_batch('50000000-0000-0000-0000-000000000002');
select pg_temp.as_user('00000000-0000-0000-0000-00000000000c');
select pg_temp.check(app.commit_import_batch('50000000-0000-0000-0000-000000000002') = 0,
  'the same report again posts nothing');
select pg_temp.check(
  (select count(*) from app.import_rows where batch_id = '50000000-0000-0000-0000-000000000002' and match_status = 'duplicate') = 2,
  'rows already posted are marked duplicate');
reset role;

-- A row with an unchecked error blocks the whole batch.
select pg_temp.vitaly_batch('50000000-0000-0000-0000-000000000003');
update app.import_rows set fingerprint = fingerprint || '|b3',
  raw = raw || '{"errors": ["Need to pay 3707.06, rows add up to 3710.06"]}'
where batch_id = '50000000-0000-0000-0000-000000000003' and row_ref = '001';
select pg_temp.as_user('00000000-0000-0000-0000-00000000000c');
do $$ begin
  perform app.commit_import_batch('50000000-0000-0000-0000-000000000003');
  raise exception 'FAILED: a batch with an unchecked error was committed';
exception when others then
  if sqlerrm like 'FAILED%' then raise; end if;
  raise notice 'ok - a row with an unchecked error blocks the batch';
end $$;
update app.import_rows set raw = raw || '{"checked": true}'
where batch_id = '50000000-0000-0000-0000-000000000003' and row_ref = '001';
select pg_temp.check(app.commit_import_batch('50000000-0000-0000-0000-000000000003') = 1,
  'once checked, the row is posted (the other row is a duplicate)');
reset role;

-- Cancelling an approved batch ---------------------------------------------

select pg_temp.as_user('00000000-0000-0000-0000-00000000000b');
do $$ begin
  perform app.void_import_batch('50000000-0000-0000-0000-000000000001', 'wrong file');
  raise exception 'FAILED: RO editor cancelled a UA batch';
exception when others then
  if sqlerrm like 'FAILED%' then raise; end if;
  raise notice 'ok - RO editor cannot cancel a UA batch';
end $$;
reset role;

select pg_temp.as_user('00000000-0000-0000-0000-00000000000c');
select pg_temp.check(app.void_import_batch('50000000-0000-0000-0000-000000000001', 'VAT was missing') = 2,
  'UA finance cancels an approved batch: its transactions become void');
select pg_temp.check(
  (select status from app.import_batches where id = '50000000-0000-0000-0000-000000000001') = 'rejected'
  and (select void_reason from app.import_batches where id = '50000000-0000-0000-0000-000000000001') = 'VAT was missing',
  'the batch is marked cancelled with the reason');
select pg_temp.check(
  (select coalesce(sum(balance), 0) from app.account_balances
   where kind = 'manager_cash' and holder_party_id = 'a0000000-0000-4000-8000-000000000001') = 20000.01,
  'void transactions drop out of the balances (only batch 3''s rent is left)');
select pg_temp.check(
  (select count(*) from app.entries e join app.transactions t on t.id = e.transaction_id
   where t.import_batch_id = '50000000-0000-0000-0000-000000000001') = 5,
  'nothing is deleted (rent split between two owners, fee split plus Vitaly''s side)');
reset role;

-- The same report can now be imported again.
select pg_temp.vitaly_batch('50000000-0000-0000-0000-000000000004');
select pg_temp.as_user('00000000-0000-0000-0000-00000000000c');
select pg_temp.check(app.commit_import_batch('50000000-0000-0000-0000-000000000004') = 2,
  'after cancelling, the corrected report posts again');
reset role;

-- Updated reports: replace a changed row, void a removed one -----------------

-- Batch 4 posted rent 20000.01 (row 001) and the fee (row 002). A corrected version:
-- the rent is now 21000, and the fee row is gone.
insert into app.import_batches (id, source_id, country_code, status, scope)
select '50000000-0000-0000-0000-000000000005', s.id, 'UA', 'in_review', '2026-01'
from app.import_sources s where s.adapter = 'vitaly_rent_xlsx';
insert into app.import_rows (batch_id, row_ref, raw, property_id, match_status, fingerprint, proposed)
select '50000000-0000-0000-0000-000000000005'::uuid, '001',
  jsonb_build_object('property_ref', 'PLC 17(2), APT. 30', 'replaces', x.transaction_id),
  '30000000-0000-0000-0000-000000000004'::uuid, 'matched', 'vitaly|30|2026-01|rent|21000',
  '{"occurred_on": "2026-01-08", "period": "2026-01-01", "category": "rent", "description": "Rent",
    "entries": [{"amount": 21000, "currency": "UAH", "account": {"kind": "manager_cash", "holder": "source"}}]}'::jsonb
from app.import_rows x where x.batch_id = '50000000-0000-0000-0000-000000000004' and x.row_ref = '001'
union all
select '50000000-0000-0000-0000-000000000005', '002', jsonb_build_object('voids', x.transaction_id),
  '30000000-0000-0000-0000-000000000004', 'matched', null, null
from app.import_rows x where x.batch_id = '50000000-0000-0000-0000-000000000004' and x.row_ref = '002'
union all
-- A row pointing at a transaction of another source must not void it.
(select '50000000-0000-0000-0000-000000000005', '003', jsonb_build_object('voids', t.id), null, 'matched', null, null
 from app.transactions t where t.import_batch_id is null and t.status = 'posted' limit 1);

select pg_temp.as_user('00000000-0000-0000-0000-00000000000c');
select pg_temp.check(app.commit_import_batch('50000000-0000-0000-0000-000000000005') = 1, 'the corrected rent is posted');
select pg_temp.check(
  (select count(*) from app.transactions where import_batch_id = '50000000-0000-0000-0000-000000000004' and status = 'void') = 2,
  'the old rent (replaced) and the removed fee are void');
select pg_temp.check(
  (select coalesce(sum(balance), 0) from app.account_balances
   where kind = 'manager_cash' and holder_party_id = 'a0000000-0000-4000-8000-000000000001') = 41000.01,
  'balances: batch 3 rent 20000.01 + corrected rent 21000');
reset role;
select pg_temp.check(
  (select count(*) from app.import_rows where batch_id = '50000000-0000-0000-0000-000000000005') = 3
  and (select count(*) from app.transactions where import_batch_id is null and status = 'void') = 0,
  'a row cannot void a transaction that another source posted');

-- Leases from a report -------------------------------------------------------

insert into app.import_batches (id, source_id, country_code, status, scope)
select '50000000-0000-0000-0000-000000000006', s.id, 'UA', 'in_review', 'leases'
from app.import_sources s where s.adapter = 'vitaly_rent_xlsx';
insert into app.leases (id, property_id, tenant_party_id, start_date, end_date, rent_amount, rent_currency)
values ('60000000-0000-0000-0000-000000000001', '30000000-0000-0000-0000-000000000004', '10000000-0000-0000-0000-000000000004',
        '2025-07-01', '2026-06-30', 400, 'EUR');
insert into app.import_rows (batch_id, row_ref, raw, property_id, match_status) values
  ('50000000-0000-0000-0000-000000000006', 'L1',
   '{"property_ref": "x", "lease": {"tenant": "Wordistry SRL", "lease_id": "60000000-0000-0000-0000-000000000001",
     "end": "2027-06-30", "rent": 425, "currency": "EUR", "notes": "prolonged for one year"}}',
   '30000000-0000-0000-0000-000000000004', 'matched'),
  ('50000000-0000-0000-0000-000000000006', 'L2',
   '{"property_ref": "x", "lease": {"tenant": "Nova Tenant SRL", "start": "2026-08-01", "end": "2027-07-31",
     "rent": 820, "deposit": 1640, "currency": "EUR", "withholding": 8, "notes": "חוזה 3"}}',
   '30000000-0000-0000-0000-000000000004', 'matched');

select pg_temp.as_user('00000000-0000-0000-0000-00000000000c');
select pg_temp.check(app.commit_import_batch('50000000-0000-0000-0000-000000000006') = 0, 'a batch of leases posts no transactions');
select pg_temp.check(
  (select (end_date, rent_amount) = ('2027-06-30'::date, 425::numeric) and notes like '%prolonged%'
   from app.leases where id = '60000000-0000-0000-0000-000000000001'),
  'a changed lease is updated: end date, rent, and the manager''s note');
select pg_temp.check(
  (select count(*) from app.leases l join app.parties p on p.id = l.tenant_party_id
   where p.display_name = 'Nova Tenant SRL' and p.kind = 'company' and l.rent_amount = 820 and l.deposit_currency = 'EUR' and l.withholding_tax_pct = 8) = 1,
  'a new lease is added with a new company tenant');
reset role;

-- Integrations: admins only -------------------------------------------------

insert into app.integrations (name, refresh_token, settings) values ('dropbox', 'secret-token', '{"shared_link": "https://example.test/x"}');
select pg_temp.as_user('00000000-0000-0000-0000-00000000000c');
select pg_temp.check((select count(*) from app.integrations) = 0, 'finance cannot read the Dropbox token');
reset role;
select pg_temp.as_user('00000000-0000-0000-0000-00000000000e');
select pg_temp.check((select count(*) from app.integrations) = 0, 'management cannot read the Dropbox token');
reset role;
select pg_temp.as_user('00000000-0000-0000-0000-00000000000a', 'aal1');
select pg_temp.check((select count(*) from app.integrations) = 0, 'an admin without the TOTP code cannot read it');
reset role;
select pg_temp.as_user('00000000-0000-0000-0000-00000000000a');
select pg_temp.check((select refresh_token from app.integrations where name = 'dropbox') = 'secret-token', 'an admin reads it');
reset role;

-- Deleting pending reports --------------------------------------------------

insert into app.import_batches (id, source_id, country_code, status)
select '50000000-0000-0000-0000-000000000007', s.id, 'UA', 'in_review' from app.import_sources s where s.adapter = 'vitaly_rent_xlsx';
insert into app.import_rows (batch_id, row_ref, raw, match_status) values ('50000000-0000-0000-0000-000000000007', '1', '{}', 'ignored');
select pg_temp.as_user('00000000-0000-0000-0000-00000000000b');
delete from app.import_batches where id = '50000000-0000-0000-0000-000000000007';
reset role;
select pg_temp.check((select count(*) from app.import_batches where id = '50000000-0000-0000-0000-000000000007') = 1,
  'RO editor cannot delete a UA report');
select pg_temp.as_user('00000000-0000-0000-0000-00000000000c');
delete from app.import_batches where id = '50000000-0000-0000-0000-000000000007';
delete from app.import_batches where id = '50000000-0000-0000-0000-000000000004';
reset role;
select pg_temp.check((select count(*) from app.import_batches where id = '50000000-0000-0000-0000-000000000007') = 0
  and (select count(*) from app.import_rows where batch_id = '50000000-0000-0000-0000-000000000007') = 0,
  'a pending report is deleted with its rows');
select pg_temp.check((select count(*) from app.import_batches where id = '50000000-0000-0000-0000-000000000004') = 1,
  'an approved report cannot be deleted');

-- Resetting Itai's imports -------------------------------------------------

insert into app.import_batches (id, source_id, country_code, status)
select '50000000-0000-0000-0000-000000000008', s.id, 'UA', 'in_review' from app.import_sources s where s.adapter = 'itai_client_xlsx';
insert into app.import_rows (batch_id, row_ref, raw, property_id, match_status, fingerprint, proposed) values
  ('50000000-0000-0000-0000-000000000008', '1', '{"property_ref": "x"}', '30000000-0000-0000-0000-000000000004', 'matched', 'itai|x',
   '{"occurred_on": "2026-02-01", "period": "2026-02-01", "category": "rent", "description": "r",
     "entries": [{"amount": 100, "currency": "UAH", "account": {"kind": "manager_cash", "holder": "source"}}]}');
select pg_temp.as_user('00000000-0000-0000-0000-00000000000a');
select app.commit_import_batch('50000000-0000-0000-0000-000000000008');
reset role;
select pg_temp.check((select count(*) from app.transactions where import_batch_id = '50000000-0000-0000-0000-000000000008' and status = 'posted') = 1, 'an Itai report is posted');

-- As the admin with TOTP but without an email code: refused.
select pg_temp.as_user('00000000-0000-0000-0000-00000000000a');
do $$ begin
  perform app.reset_itai_imports('re-import with the new adapter');
  raise exception 'FAILED: reset without an email code';
exception when others then
  if sqlerrm like 'FAILED%' then raise; end if;
  raise notice 'ok - reset needs a fresh code from email';
end $$;
reset role;

-- With a fresh email code (amr otp) but no reason: refused. With both: done.
create function pg_temp.as_admin_with_otp(age_seconds int) returns void language plpgsql as $$
begin
  perform set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-00000000000a', false);
  perform set_config('request.jwt.claims', json_build_object('sub', '00000000-0000-0000-0000-00000000000a', 'aal', 'aal2',
    'amr', json_build_array(json_build_object('method', 'totp', 'timestamp', extract(epoch from now())::bigint),
                            json_build_object('method', 'otp', 'timestamp', extract(epoch from now())::bigint - age_seconds)))::text, false);
  execute 'set role authenticated';
end $$;
select pg_temp.as_admin_with_otp(30 * 60);
do $$ begin
  perform app.reset_itai_imports('re-import with the new adapter');
  raise exception 'FAILED: reset with a stale email code';
exception when others then
  if sqlerrm like 'FAILED%' then raise; end if;
  raise notice 'ok - an email code older than 15 minutes is refused';
end $$;
reset role;
select pg_temp.as_admin_with_otp(60);
do $$ begin
  perform app.reset_itai_imports('short');
  raise exception 'FAILED: reset without a real reason';
exception when others then
  if sqlerrm like 'FAILED%' then raise; end if;
  raise notice 'ok - a reason is required';
end $$;
select pg_temp.check((app.reset_itai_imports('re-import with the new adapter') ->> 'transactions')::int = 1, 'the reset removes Itai''s posted transactions');
reset role;
select pg_temp.check(
  (select count(*) from app.import_batches b join app.import_sources s on s.id = b.source_id where s.adapter = 'itai_client_xlsx') = 0
  and (select count(*) from app.import_batches b join app.import_sources s on s.id = b.source_id where s.adapter = 'vitaly_rent_xlsx') > 0,
  'only Itai''s reports are gone; other sources stay');
select pg_temp.check(
  (select new_row ->> 'reason' from app.audit_log where action = 'RESET_ITAI' order by id desc limit 1) = 're-import with the new adapter',
  'the reason is kept in the audit log');
select pg_temp.as_user('00000000-0000-0000-0000-00000000000c');
do $$ begin
  perform app.reset_itai_imports('finance is not an admin');
  raise exception 'FAILED: a non-admin reset';
exception when others then
  if sqlerrm like 'FAILED%' then raise; end if;
  raise notice 'ok - only an admin can reset';
end $$;
reset role;

-- Party documents: sensitive files need the per-country flag -----------------

insert into app.documents (entity_type, entity_id, country_code, doc_type, storage_path, sensitive, file_name, source) values
  ('party', '10000000-0000-0000-0000-000000000001', 'UA', 'passport', 'UA/party/10000000-0000-0000-0000-000000000001/att1_passport.pdf', true, 'passport.pdf', 'airtable:att1');
select pg_temp.as_user('00000000-0000-0000-0000-00000000000c');
select pg_temp.check((select count(*) from app.documents) = 0, 'UA finance without the sensitive flag sees no sensitive document');
reset role;
update app.user_country_roles set can_view_sensitive = true where user_id = '00000000-0000-0000-0000-00000000000c' and country_code = 'UA';
select pg_temp.as_user('00000000-0000-0000-0000-00000000000c');
select pg_temp.check((select count(*) from app.documents) = 1, 'with the UA sensitive flag the document is visible');
reset role;
update app.user_country_roles set can_view_sensitive = false where user_id = '00000000-0000-0000-0000-00000000000c' and country_code = 'UA';
select pg_temp.as_user('00000000-0000-0000-0000-00000000000b');
select pg_temp.check((select count(*) from app.documents) = 0, 'RO staff do not see UA documents');
reset role;
select pg_temp.as_user('00000000-0000-0000-0000-00000000000e');
select pg_temp.check((select count(*) from app.documents) = 0, 'management without the flag does not see sensitive documents');
reset role;
select pg_temp.as_user('00000000-0000-0000-0000-00000000000d', 'aal1');
select pg_temp.check((select count(*) from app.documents) = 1, 'a client sees their own documents');
reset role;
do $$ begin
  insert into app.documents (entity_type, entity_id, country_code, doc_type, storage_path, sensitive)
  values ('party', '10000000-0000-0000-0000-000000000001', 'UA', 'passport', 'UA/party/10000000-0000-0000-0000-000000000001/att1_passport.pdf', true);
  raise exception 'FAILED: the same file was recorded twice';
exception when unique_violation then raise notice 'ok - a file is recorded once (re-running the import adds nothing)';
end $$;

-- The document import queue is out of reach of every signed-in user.
insert into app.document_imports (att_id, url, file_name, country_code, party_id, doc_type) values
  ('attQ1', 'https://v5.airtableusercontent.com/x', 'poa.pdf', 'UA', '10000000-0000-0000-0000-000000000001', 'poa');
select pg_temp.as_user('00000000-0000-0000-0000-00000000000a');
do $$ begin
  perform 1 from app.document_imports;
  raise exception 'FAILED: an admin read the import queue';
exception when insufficient_privilege then raise notice 'ok - nobody signed in reads the import queue (it holds signed links)';
end $$;
do $$ begin
  perform app.claim_document_imports(5);
  raise exception 'FAILED: a signed-in user claimed queue rows';
exception when insufficient_privilege then raise notice 'ok - only the service role takes rows from the queue';
end $$;
reset role;
select pg_temp.check((select count(*) from app.claim_document_imports(5)) = 1, 'a call takes the pending row');
select pg_temp.check((select count(*) from app.claim_document_imports(5)) = 0, 'a row being copied is not taken twice');

-- Audit -----------------------------------------------------------------

select pg_temp.check(
  (select count(*) from app.audit_log where table_name = 'transactions') >= 2,
  'ledger changes are audited');

\echo ALL TESTS PASSED
