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

-- Manual form (Yarach): the transfers reach Gershon, so the row names him as the holder.

insert into app.import_batches (id, source_id, country_code, status, scope)
select '50000000-0000-0000-0000-000000000009', s.id, 'UA', 'in_review', '2026-10' from app.import_sources s where s.adapter = 'manual_yarach';
insert into app.import_rows (batch_id, row_ref, raw, property_id, match_status, fingerprint, proposed) values
  ('50000000-0000-0000-0000-000000000009', 'yarach:30', '{"property_ref": "Arcadia 30"}', '30000000-0000-0000-0000-000000000004', 'matched',
   'yarach|30|2026-10-01|12991.51',
   '{"occurred_on": "2026-10-31", "period": "2026-10-01", "category": "rent", "description": "share of Yarach''s transfers",
     "entries": [{"amount": 12991.51, "currency": "UAH", "account": {"kind": "rent_pool", "holder": "a0000000-0000-4000-8000-000000000004"}}]}');
select pg_temp.as_user('00000000-0000-0000-0000-00000000000c');
select pg_temp.check(app.commit_import_batch('50000000-0000-0000-0000-000000000009') = 1, 'UA finance posts Yarach''s form');
select pg_temp.check(
  (select array_agg(balance order by balance)::text from app.account_balances
   where kind = 'rent_pool' and holder_party_id = 'a0000000-0000-4000-8000-000000000004' and currency = 'UAH'
     and beneficiary_party_id in ('10000000-0000-0000-0000-000000000001', '10000000-0000-0000-0000-000000000002')) = '{6495.75,6495.76}',
  'Yarach''s share lands in each owner''s rent pool at Gershon, not with Yarach');
select pg_temp.check(
  not exists (select 1 from app.accounts where holder_party_id = 'a0000000-0000-4000-8000-000000000002'),
  'no account is opened for Yarach');
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

select pg_temp.as_user('00000000-0000-0000-0000-00000000000c');
do $$ begin
  insert into app.documents (entity_type, entity_id, country_code, doc_type, storage_path, sensitive)
  values ('party', '10000000-0000-0000-0000-000000000001', 'UA', 'passport', 'UA/party/x/upload.pdf', true);
  raise exception 'FAILED: an editor without the sensitive flag added a sensitive document';
exception when insufficient_privilege then raise notice 'ok - adding a sensitive document needs the sensitive flag';
end $$;
reset role;
update app.user_country_roles set can_view_sensitive = true where user_id = '00000000-0000-0000-0000-00000000000c' and country_code = 'UA';
select pg_temp.as_user('00000000-0000-0000-0000-00000000000c');
insert into app.documents (entity_type, entity_id, country_code, doc_type, storage_path, sensitive)
values ('party', '10000000-0000-0000-0000-000000000001', 'UA', 'passport', 'UA/party/x/upload.pdf', true);
select pg_temp.check(true, 'with the flag, an editor adds a sensitive document');
delete from app.documents where storage_path = 'UA/party/x/upload.pdf';
reset role;
update app.user_country_roles set can_view_sensitive = false where user_id = '00000000-0000-0000-0000-00000000000c' and country_code = 'UA';

-- ID numbers: open to all staff (decision 72); writing needs edit rights.
insert into app.party_identity (party_id, id_number, source) values ('10000000-0000-0000-0000-000000000001', '000000018', 'manual');
select pg_temp.as_user('00000000-0000-0000-0000-00000000000e');
select pg_temp.check((select count(*) from app.party_identity) = 1, 'management (no edit rights) sees ID numbers');
do $$ begin
  insert into app.party_identity (party_id, id_number) values ('10000000-0000-0000-0000-000000000002', '000000026');
  raise exception 'FAILED: staff without edit rights wrote an ID number';
exception when insufficient_privilege then raise notice 'ok - writing an ID number needs edit rights';
end $$;
reset role;
select pg_temp.as_user('00000000-0000-0000-0000-00000000000c');
insert into app.party_identity (party_id, id_number) values ('10000000-0000-0000-0000-000000000002', '000000026');
select pg_temp.check((select count(*) from app.party_identity) = 2, 'an editor writes and sees ID numbers, without the sensitive flag');
reset role;
select pg_temp.as_user('00000000-0000-0000-0000-00000000000d', 'aal1');
select pg_temp.check((select array_agg(id_number)::text from app.party_identity) = '{000000018}', 'a client sees only their own ID number');
reset role;
select pg_temp.check(
  (select count(*) from app.audit_log where table_name = 'party_identity') >= 2, 'ID number changes are audited');

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

-- Deleting records entered by mistake (decision 67) -------------------------

insert into app.properties (id, building_id, unit_no, status) values
  ('30000000-0000-0000-0000-0000000000d1', '22000000-0000-0000-0000-000000000001', '99', 'vacant');
insert into app.parties (id, kind, display_name) values ('10000000-0000-0000-0000-0000000000d1', 'person', 'Mistake Client');
insert into app.party_roles (party_id, role) values ('10000000-0000-0000-0000-0000000000d1', 'client');
insert into app.party_identity (party_id, id_number) values ('10000000-0000-0000-0000-0000000000d1', '000000034');
insert into app.ownerships (property_id, party_id, share_pct, valid_from) values
  ('30000000-0000-0000-0000-0000000000d1', '10000000-0000-0000-0000-0000000000d1', 100, '2026-01-01');
insert into app.leases (id, property_id, start_date, rent_amount, rent_currency) values
  ('40000000-0000-0000-0000-0000000000d1', '30000000-0000-0000-0000-0000000000d1', '2026-01-01', 100, 'UAH'),
  ('40000000-0000-0000-0000-0000000000d2', '30000000-0000-0000-0000-0000000000d1', '2025-01-01', 90, 'UAH');

select pg_temp.as_user('00000000-0000-0000-0000-00000000000c');
do $$ begin
  perform app.delete_record('lease', '40000000-0000-0000-0000-0000000000d1', 'typo in the lease');
  raise exception 'FAILED: a non-admin deleted a lease';
exception when others then
  if sqlerrm like 'FAILED%' then raise; end if;
  raise notice 'ok - only an admin deletes';
end $$;
reset role;

select pg_temp.as_user('00000000-0000-0000-0000-00000000000a');
select pg_temp.check(jsonb_array_length(app.deletion_preview('property', '30000000-0000-0000-0000-000000000004') -> 'blocked') > 0,
  'a property with ledger entries cannot be deleted');
select pg_temp.check(jsonb_array_length(app.deletion_preview('client', '10000000-0000-0000-0000-0000000000d1') -> 'blocked') = 1,
  'a client who owns a property cannot be deleted');
do $$ begin
  perform app.delete_record('lease', '40000000-0000-0000-0000-0000000000d2', 'no');
  raise exception 'FAILED: deleted without a reason';
exception when others then
  if sqlerrm like 'FAILED%' then raise; end if;
  raise notice 'ok - a reason is required to delete';
end $$;
select app.delete_record('lease', '40000000-0000-0000-0000-0000000000d2', 'entered twice by mistake');
select pg_temp.check(not exists (select 1 from app.leases where id = '40000000-0000-0000-0000-0000000000d2')
  and exists (select 1 from app.leases where id = '40000000-0000-0000-0000-0000000000d1'), 'a lease is deleted, the other stays');
select pg_temp.check((app.deletion_preview('property', '30000000-0000-0000-0000-0000000000d1') -> 'deletes' ->> 'ownerships')::int = 1,
  'the preview counts what goes with the property');
select app.delete_record('property', '30000000-0000-0000-0000-0000000000d1', 'apartment does not exist');
select pg_temp.check(not exists (select 1 from app.properties where id = '30000000-0000-0000-0000-0000000000d1')
  and not exists (select 1 from app.ownerships where property_id = '30000000-0000-0000-0000-0000000000d1')
  and not exists (select 1 from app.leases where property_id = '30000000-0000-0000-0000-0000000000d1'),
  'a property without history is deleted with its ownership and leases');
select app.delete_record('client', '10000000-0000-0000-0000-0000000000d1', 'duplicate client');
select pg_temp.check(not exists (select 1 from app.parties where id = '10000000-0000-0000-0000-0000000000d1')
  and not exists (select 1 from app.party_identity where party_id = '10000000-0000-0000-0000-0000000000d1'),
  'once its property is gone, the client is deleted with the ID number');
reset role;
select pg_temp.check(
  (select count(*) from app.audit_log where action in ('DELETE_LEASE', 'DELETE_PROPERTY', 'DELETE_CLIENT') and new_row ? 'reason' and old_row is not null) = 3,
  'each deletion keeps the deleted row and the reason in the audit log');

-- Partners, contacts and the completeness page (decisions 76-78) -------------

select pg_temp.as_user('00000000-0000-0000-0000-00000000000c');
insert into app.party_links (member_party_id, main_party_id, relation) values ('10000000-0000-0000-0000-000000000002', '10000000-0000-0000-0000-000000000001', 'spouse');
insert into app.completeness_dismissals (check_key, entity_id, reason) values ('client_no_phone', '10000000-0000-0000-0000-000000000001', 'no phone on purpose');
select pg_temp.check((select count(*) from app.party_links) = 1 and (select count(*) from app.completeness_dismissals) = 1, 'an editor links partners and ignores a completeness item');
reset role;
select pg_temp.as_user('00000000-0000-0000-0000-00000000000e');
select pg_temp.check((select count(*) from app.party_links) = 1, 'staff without edit rights see the links');
do $$ begin
  delete from app.party_links;
  if found then raise exception 'FAILED: staff without edit rights removed a link'; end if;
  raise notice 'ok - staff without edit rights cannot unlink';
end $$;
reset role;
select pg_temp.check(exists (select 1 from app.audit_log where table_name = 'party_links'), 'linking partners is audited');
insert into app.party_roles (party_id, role) values ('10000000-0000-0000-0000-000000000002', 'contact');
select pg_temp.check(exists (select 1 from app.party_roles where role = 'contact'), 'a party can be a contact');
select pg_temp.as_user('00000000-0000-0000-0000-00000000000c');
select pg_temp.check((select count(*) from app.last_rent_by_property()) >= 1, 'last rent per property is readable');
reset role;
delete from app.party_links; delete from app.completeness_dismissals;

-- Assignments, activities and company partners (decisions 79-81) ------------

select pg_temp.as_user('00000000-0000-0000-0000-00000000000c');
insert into app.contact_assignments (party_id, building_id, role) values ('10000000-0000-0000-0000-000000000002', '22000000-0000-0000-0000-000000000001', 'עו"ד');
insert into app.activities (entity_type, entity_id, title, body) values ('party', '10000000-0000-0000-0000-000000000001', 'שיחה', 'דיברנו על החוזה');
insert into app.company_partners (company_party_id, partner_party_id, share_pct) values ('10000000-0000-0000-0000-000000000001', '10000000-0000-0000-0000-000000000002', 50);
select pg_temp.check((select count(*) from app.contact_assignments) = 1 and (select count(*) from app.activities) = 1 and (select count(*) from app.company_partners) = 1,
  'an editor assigns a contact, writes an activity and adds a company partner');
do $$ begin
  insert into app.contact_assignments (party_id, building_id, city_id) values ('10000000-0000-0000-0000-000000000002', '22000000-0000-0000-0000-000000000001', '20000000-0000-0000-0000-000000000001');
  raise exception 'FAILED: an assignment to two places at once';
exception when check_violation then raise notice 'ok - an assignment names exactly one place';
end $$;
reset role;
select pg_temp.as_user('00000000-0000-0000-0000-00000000000e');
do $$ begin
  insert into app.activities (entity_type, entity_id, title) values ('party', '10000000-0000-0000-0000-000000000001', 'x');
  raise exception 'FAILED: staff without edit rights wrote an activity';
exception when insufficient_privilege then raise notice 'ok - writing an activity needs edit rights';
end $$;
select pg_temp.check((select count(*) from app.activities) = 1, 'staff without edit rights read activities');
reset role;
select pg_temp.check(exists (select 1 from app.audit_log where table_name = 'activities'), 'activities are audited');
delete from app.contact_assignments; delete from app.activities; delete from app.company_partners;

-- Users screen (decision 86) --------------------------------------------

select pg_temp.as_user('00000000-0000-0000-0000-00000000000a');
select pg_temp.check((select count(*) from app.admin_users()) = 5, 'an admin lists who can sign in');
insert into app.user_country_roles (user_id, country_code, level, can_view_sensitive) values ('00000000-0000-0000-0000-00000000000e', 'GE', 'viewer', true);
update app.profiles set display_name = 'Management 2' where user_id = '00000000-0000-0000-0000-00000000000e';
select pg_temp.check((select level from app.user_country_roles where user_id = '00000000-0000-0000-0000-00000000000e' and country_code = 'GE') = 'viewer',
  'an admin gives a country role');
delete from app.user_country_roles where user_id = '00000000-0000-0000-0000-00000000000e' and country_code = 'GE';
reset role;
select pg_temp.as_user('00000000-0000-0000-0000-00000000000a', 'aal1');
do $$ begin
  perform app.admin_users();
  raise exception 'FAILED: the user list without TOTP';
exception when insufficient_privilege then raise notice 'ok - listing users needs TOTP';
end $$;
reset role;
select pg_temp.as_user('00000000-0000-0000-0000-00000000000b');
do $$ begin
  perform app.admin_users();
  raise exception 'FAILED: a non-admin listed users';
exception when insufficient_privilege then raise notice 'ok - only an admin lists users';
end $$;
do $$ begin
  insert into app.user_country_roles (user_id, country_code, level) values ('00000000-0000-0000-0000-00000000000b', 'UA', 'finance');
  raise exception 'FAILED: a non-admin gave themself a role';
exception when insufficient_privilege then raise notice 'ok - a non-admin cannot give themself a role';
end $$;
reset role;
do $$ begin
  update app.profiles set is_admin = false where user_id = '00000000-0000-0000-0000-00000000000a';
  set constraints all immediate;
  raise exception 'FAILED: the last admin was removed';
exception when check_violation then raise notice 'ok - the last admin cannot be removed';
end $$;
select pg_temp.check((select is_admin from app.profiles where user_id = '00000000-0000-0000-0000-00000000000a'), 'the admin is still an admin');
insert into auth.users (id, email) values ('00000000-0000-0000-0000-00000000000f', 'new@example.test');
set role service_role;
insert into app.profiles (user_id, display_name) values ('00000000-0000-0000-0000-00000000000f', 'New');
delete from app.profiles where user_id = '00000000-0000-0000-0000-00000000000f';
reset role;
select pg_temp.check(not exists (select 1 from app.profiles where user_id = '00000000-0000-0000-0000-00000000000f'), 'the admin-users function (service role) adds and removes a profile');
delete from auth.users where id = '00000000-0000-0000-0000-00000000000f';

-- Changing the first password (decision 87) -----------------------------

select pg_temp.as_user('00000000-0000-0000-0000-00000000000a');
update app.profiles set must_change_password = true where user_id in ('00000000-0000-0000-0000-00000000000b', '00000000-0000-0000-0000-00000000000c');
reset role;
select pg_temp.as_user('00000000-0000-0000-0000-00000000000b');
do $$ begin
  update app.profiles set must_change_password = false where user_id = '00000000-0000-0000-0000-00000000000b';
end $$;
reset role;
select pg_temp.check((select must_change_password from app.profiles where user_id = '00000000-0000-0000-0000-00000000000b'), 'a user cannot clear the flag by writing the profile');
select pg_temp.as_user('00000000-0000-0000-0000-00000000000b');
select app.password_changed();
reset role;
select pg_temp.check(not (select must_change_password from app.profiles where user_id = '00000000-0000-0000-0000-00000000000b')
  and (select must_change_password from app.profiles where user_id = '00000000-0000-0000-0000-00000000000c'), 'password_changed clears only the caller''s own flag');
update app.profiles set must_change_password = false;

-- Second factor by e-mail (decision 88) ---------------------------------

create function pg_temp.as_session(u text, sid text) returns void language plpgsql as $$
begin
  perform set_config('request.jwt.claim.sub', u, false);
  perform set_config('request.jwt.claims', json_build_object('sub', u, 'aal', 'aal1', 'session_id', sid)::text, false);
  execute 'set role authenticated';
end $$;
select pg_temp.as_session('00000000-0000-0000-0000-00000000000b', '50000000-0000-0000-0000-000000000001');
select pg_temp.check(not app.mfa_verified() and (select count(*) from app.properties) = 0, 'after the password only, an editor sees nothing');
reset role;
set role service_role;
insert into app.email_mfa_sessions (session_id, user_id) values
  ('50000000-0000-0000-0000-000000000001', '00000000-0000-0000-0000-00000000000b'),
  ('50000000-0000-0000-0000-000000000002', '00000000-0000-0000-0000-00000000000a');
reset role;
select pg_temp.as_session('00000000-0000-0000-0000-00000000000b', '50000000-0000-0000-0000-000000000001');
select pg_temp.check(app.mfa_verified() and (select count(*) from app.properties) > 0, 'with the e-mail code on this session, the editor sees their country');
reset role;
select pg_temp.as_session('00000000-0000-0000-0000-00000000000b', '50000000-0000-0000-0000-000000000009');
select pg_temp.check(not app.mfa_verified(), 'the code counts only for the session it was entered in');
reset role;
select pg_temp.as_session('00000000-0000-0000-0000-00000000000c', '50000000-0000-0000-0000-000000000001');
select pg_temp.check(not app.mfa_verified(), 'another user cannot use someone else''s verified session');
reset role;
select pg_temp.as_session('00000000-0000-0000-0000-00000000000a', '50000000-0000-0000-0000-000000000002');
select pg_temp.check(not app.mfa_verified(), 'an admin is never verified by e-mail');
reset role;
update app.email_mfa_sessions set verified_at = now() - interval '13 hours' where session_id = '50000000-0000-0000-0000-000000000001';
select pg_temp.as_session('00000000-0000-0000-0000-00000000000b', '50000000-0000-0000-0000-000000000001');
select pg_temp.check(not app.mfa_verified(), 'an e-mail verification lasts 12 hours');
do $$ begin
  insert into app.email_mfa_sessions (session_id, user_id) values ('50000000-0000-0000-0000-000000000003', '00000000-0000-0000-0000-00000000000b');
  raise exception 'FAILED: a user marked their own session verified';
exception when insufficient_privilege then raise notice 'ok - only the function records a verified session';
end $$;
reset role;
set role service_role;
insert into app.email_mfa_sessions (session_id, user_id) values ('50000000-0000-0000-0000-000000000001', '00000000-0000-0000-0000-00000000000b')
  on conflict (session_id) do update set verified_at = excluded.verified_at;
reset role;
select pg_temp.check((select verified_at > now() - interval '1 minute' from app.email_mfa_sessions where session_id = '50000000-0000-0000-0000-000000000001'),
  'the email-code function renews a verified session (upsert)');
delete from app.email_mfa_sessions;

-- User activity (decision 90) -------------------------------------------

select pg_temp.check(not exists (
  select 1 from unnest(array['properties', 'documents', 'import_batches', 'party_roles', 'buildings']) t
  where not exists (select 1 from pg_trigger g join pg_class c on c.oid = g.tgrelid where c.relname = t and g.tgname = 'audit')),
  'properties, documents, report approvals and roles are audited');
select pg_temp.as_session('00000000-0000-0000-0000-00000000000b', '60000000-0000-0000-0000-000000000001');
select app.log_sign_in(); select app.log_sign_in();
reset role;
select pg_temp.check((select count(*) from app.audit_log where action = 'LOGIN' and user_id = '00000000-0000-0000-0000-00000000000b') = 1,
  'a sign-in is recorded once per session');
select pg_temp.as_user('00000000-0000-0000-0000-00000000000b');
select pg_temp.check((select count(*) from app.audit_log) = 0, 'only an admin reads the activity log');
reset role;

-- A shared fund (decision 91) -------------------------------------------

-- Property ...01 belongs to Client One; its expense fund is Client Two's.
insert into app.fund_owners (property_id, account_kind, party_id) values
  ('30000000-0000-0000-0000-000000000001', 'expense_pool', '10000000-0000-0000-0000-000000000002');
insert into app.transactions (id, country_code, occurred_on, period, category, status)
  values ('70000000-0000-0000-0000-000000000001', 'UA', '2026-01-31', '2026-01-01', 'building_fees', 'draft');
select app.post_import_entry('70000000-0000-0000-0000-000000000001', '30000000-0000-0000-0000-000000000001',
  '10000000-0000-0000-0000-000000000003', 'UA', '2026-01-31', '{"amount": -100, "currency": "UAH", "account": {"kind": "expense_pool", "holder": "source"}}');
select app.post_import_entry('70000000-0000-0000-0000-000000000001', '30000000-0000-0000-0000-000000000001',
  '10000000-0000-0000-0000-000000000003', 'UA', '2026-01-31', '{"amount": 100, "currency": "UAH", "account": {"kind": "rent_pool", "holder": "source"}}');
select pg_temp.check(
  (select a.beneficiary_party_id from app.entries e join app.accounts a on a.id = e.account_id
   where e.transaction_id = '70000000-0000-0000-0000-000000000001' and a.kind = 'expense_pool') = '10000000-0000-0000-0000-000000000002'
  and (select a.beneficiary_party_id from app.entries e join app.accounts a on a.id = e.account_id
   where e.transaction_id = '70000000-0000-0000-0000-000000000001' and a.kind = 'rent_pool') = '10000000-0000-0000-0000-000000000001',
  'an expense of a property with a fund owner goes to the fund owner; other accounts stay with the owners');
delete from app.transactions where id = '70000000-0000-0000-0000-000000000001';
delete from app.fund_owners;

-- Manual topics (decision 92) -------------------------------------------

select pg_temp.as_user('00000000-0000-0000-0000-00000000000e');
select pg_temp.check((select count(*) from app.staff_directory()) >= 3 and not exists (select 1 from app.staff_directory() where display_name = 'Client One'),
  'every staff member sees the staff names, without clients');
select pg_temp.check(not exists (select 1 from app.staff_directory() where email is null),
  'the staff list carries each employee''s e-mail, for the topic e-mail draft');
insert into app.tasks (title, notes, assignee_id) values ('לבדוק חוזה', 'שאלה', '00000000-0000-0000-0000-00000000000b');
reset role;
select pg_temp.check((select created_by from app.tasks where title = 'לבדוק חוזה') = '00000000-0000-0000-0000-00000000000e', 'a topic records who sent it');
select pg_temp.as_user('00000000-0000-0000-0000-00000000000b');
update app.tasks set reply = 'נבדק', status = 'done', done_at = now() where title = 'לבדוק חוזה';
reset role;
select pg_temp.check((select reply from app.tasks where title = 'לבדוק חוזה') = 'נבדק', 'the employee it was sent to answers and closes it');
select pg_temp.as_user('00000000-0000-0000-0000-00000000000d');
do $$ begin
  perform app.staff_directory();
  raise exception 'FAILED: a client read the staff names';
exception when insufficient_privilege then raise notice 'ok - clients do not see staff names';
end $$;
reset role;
select pg_temp.as_user('00000000-0000-0000-0000-00000000000e');
insert into app.task_links (task_id, entity_type, entity_id)
  select id, 'party', '10000000-0000-0000-0000-000000000001'::uuid from app.tasks where title = 'לבדוק חוזה'
  union all select id, 'party', '10000000-0000-0000-0000-000000000003'::uuid from app.tasks where title = 'לבדוק חוזה';
update app.tasks set fix_url = '/clients/10000000-0000-0000-0000-000000000001' where title = 'לבדוק חוזה';
select pg_temp.check((select count(*) from app.task_links) = 2, 'a topic links several clients and contacts');
do $$ begin
  update app.tasks set fix_url = 'javascript:alert(1)' where title = 'לבדוק חוזה';
  raise exception 'FAILED: a fix link that is not a web address';
exception when check_violation then raise notice 'ok - a fix link is a web address or a page of the app';
end $$;
update app.tasks set title = 'לבדוק את החוזה' where title = 'לבדוק חוזה';
reset role;
select pg_temp.check((select edited_at is not null from app.tasks where title = 'לבדוק את החוזה'), 'the author edits a topic, and the edit is marked');
select pg_temp.as_user('00000000-0000-0000-0000-00000000000b');
do $$ begin
  update app.tasks set notes = 'שיניתי' where title = 'לבדוק את החוזה';
  raise exception 'FAILED: someone else edited the topic';
exception when insufficient_privilege then raise notice 'ok - only the author edits a topic';
end $$;
do $$ begin
  delete from app.task_links where entity_id = '10000000-0000-0000-0000-000000000003';
  raise exception 'FAILED: someone else changed the topic links';
exception when insufficient_privilege then raise notice 'ok - only the author changes what a topic is linked to';
end $$;
do $$ begin
  delete from app.tasks where title = 'לבדוק את החוזה';
  raise exception 'FAILED: someone else deleted the topic';
exception when insufficient_privilege then raise notice 'ok - only the author deletes a topic';
end $$;
update app.tasks set reply = 'עודכן', status = 'open', assignee_id = null where title = 'לבדוק את החוזה';
reset role;
select pg_temp.check((select reply from app.tasks where title = 'לבדוק את החוזה') = 'עודכן', 'anyone on staff still answers, reassigns and reopens');
select pg_temp.as_user('00000000-0000-0000-0000-00000000000e');
delete from app.tasks where title = 'לבדוק את החוזה';
reset role;
select pg_temp.check(not exists (select 1 from app.task_links), 'the author deletes the topic, and its links go with it');

-- A movement added from the property card (decision 103) -----------------

insert into app.ownerships (property_id, party_id, share_pct, valid_from) values
  ('30000000-0000-0000-0000-000000000002', '10000000-0000-0000-0000-000000000002', 100, '2023-01-01');
select pg_temp.as_user('00000000-0000-0000-0000-00000000000b');
insert into app.transactions (id, country_code, occurred_on, period, category, description, status)
  values ('71000000-0000-0000-0000-000000000001', 'RO', '2026-03-05', '2026-03-01', 'repair', 'תיקון', 'draft');
select app.post_import_entry('71000000-0000-0000-0000-000000000001', '30000000-0000-0000-0000-000000000002', null, 'RO', '2026-03-05',
  '{"amount": -120, "currency": "RON", "account": {"kind": "client_bank", "holder": "beneficiary"}}');
reset role;
select pg_temp.check((select count(*) from app.entries where transaction_id = '71000000-0000-0000-0000-000000000001') = 1,
  'an editor adds a draft movement to a property, in the owner''s account');
select pg_temp.as_user('00000000-0000-0000-0000-00000000000b');
do $$ begin
  update app.transactions set status = 'posted' where id = '71000000-0000-0000-0000-000000000001';
  raise exception 'FAILED: an editor posted a movement';
exception when raise_exception then
  if sqlerrm like 'FAILED%' then raise; end if;
  raise notice 'ok - only finance posts a movement added on the property card';
end $$;
delete from app.transactions where id = '71000000-0000-0000-0000-000000000001';
reset role;
select pg_temp.check(not exists (select 1 from app.transactions where id = '71000000-0000-0000-0000-000000000001'), 'the editor deletes a draft');

select pg_temp.as_user('00000000-0000-0000-0000-00000000000c');
insert into app.transactions (id, country_code, occurred_on, period, category, status)
  values ('71000000-0000-0000-0000-000000000002', 'UA', '2026-03-05', '2026-03-01', 'rent', 'draft');
select app.post_import_entry('71000000-0000-0000-0000-000000000002', '30000000-0000-0000-0000-000000000004', '10000000-0000-0000-0000-000000000003', 'UA', '2026-03-05',
  '{"amount": 1001, "currency": "UAH", "account": {"kind": "manager_cash", "holder": "source"}}');
update app.transactions set status = 'posted' where id = '71000000-0000-0000-0000-000000000002';
reset role;
select pg_temp.check((select array_agg(amount order by amount) from app.entries where transaction_id = '71000000-0000-0000-0000-000000000002') = '{500.50,500.50}'::numeric[]
  and (select status from app.transactions where id = '71000000-0000-0000-0000-000000000002') = 'posted',
  'finance adds and posts a movement; it is split between the owners by their shares');
delete from app.ownerships where property_id = '30000000-0000-0000-0000-000000000002';

-- Deleting a receipt from the property card (decision 106) -----------------

insert into app.documents (id, entity_type, entity_id, country_code, doc_type, storage_path, sensitive)
  values ('72000000-0000-0000-0000-000000000001', 'property', '30000000-0000-0000-0000-000000000002', 'RO', 'receipt', 'RO/property/x/receipt.pdf', false);
insert into app.charges (id, property_id, period, kind, amount, currency, document_id)
  values ('72000000-0000-0000-0000-000000000002', '30000000-0000-0000-0000-000000000002', '2026-01-01', 'water', 10, 'RON', '72000000-0000-0000-0000-000000000001');
select pg_temp.as_user('00000000-0000-0000-0000-00000000000b');
delete from app.documents where id = '72000000-0000-0000-0000-000000000001';
reset role;
select pg_temp.check((select document_id from app.charges where id = '72000000-0000-0000-0000-000000000002') is null
  and not exists (select 1 from app.documents where id = '72000000-0000-0000-0000-000000000001'),
  'an editor deletes a receipt; the charge keeps its amount and loses only the link');
delete from app.charges where id = '72000000-0000-0000-0000-000000000002';

-- File categories added in Settings (decision 107) ------------------------

select pg_temp.as_user('00000000-0000-0000-0000-00000000000a');
insert into app.file_categories (id, label, sensitive) values ('73000000-0000-0000-0000-000000000001', 'היתרי בנייה', true);
reset role;
select pg_temp.as_user('00000000-0000-0000-0000-00000000000b');
select pg_temp.check((select count(*) from app.file_categories) = 1, 'staff see the file categories');
do $$ begin
  insert into app.file_categories (label) values ('x');
  raise exception 'FAILED: an editor added a file category';
exception when insufficient_privilege then raise notice 'ok - only an admin adds a file category';
end $$;
reset role;
insert into app.documents (id, entity_type, entity_id, country_code, doc_type, storage_path)
  values ('73000000-0000-0000-0000-000000000002', 'property', '30000000-0000-0000-0000-000000000002', 'RO', 'cat:73000000-0000-0000-0000-000000000001', 'RO/property/x/permit.pdf');
select pg_temp.as_user('00000000-0000-0000-0000-00000000000a');
do $$ begin
  delete from app.file_categories where id = '73000000-0000-0000-0000-000000000001';
  raise exception 'FAILED: a category with files was removed';
exception when foreign_key_violation then raise notice 'ok - a category with files is not removed';
end $$;
reset role;
delete from app.documents where id = '73000000-0000-0000-0000-000000000002';
delete from app.file_categories;

-- Cash boxes (decision 112) ------------------------------------------------

select pg_temp.as_user('00000000-0000-0000-0000-00000000000c');
select pg_temp.check((select count(*) from app.cash_boxes) = 1 and (select name from app.cash_boxes) = 'קופת גרשון', 'UA finance sees Gershon''s box, not the office''s');
insert into app.cash_movements (box_id, occurred_on, amount, currency, kind, party_name)
  select id, '2026-10-01', 50000, 'UAH', 'from_manager', 'ויטאלי' from app.cash_boxes;
reset role;
select pg_temp.as_user('00000000-0000-0000-0000-00000000000b');
select pg_temp.check(not exists (select 1 from app.cash_boxes) and not exists (select 1 from app.cash_movements), 'a Romania editor sees no cash box');
reset role;
select pg_temp.as_user('00000000-0000-0000-0000-00000000000e');
select pg_temp.check((select count(*) from app.cash_boxes) = 2, 'management sees both boxes');
do $$ begin
  insert into app.cash_movements (box_id, occurred_on, amount, currency, kind)
    select id, '2026-10-01', 10, 'ILS', 'income' from app.cash_boxes where country_code is null;
  raise exception 'FAILED: management wrote to the office box';
exception when insufficient_privilege then raise notice 'ok - only an admin writes to the office box';
end $$;
reset role;
select pg_temp.check((select sum(amount) from app.cash_movements) = 50000, 'a movement is recorded in Gershon''s box');
delete from app.cash_movements;

-- Paying a client from Gershon's box posts the transfer (decision 113).
select pg_temp.as_user('00000000-0000-0000-0000-00000000000c');
insert into app.accounts (id, holder_party_id, beneficiary_party_id, country_code, currency, kind) values
  ('74000000-0000-0000-0000-000000000001', 'a0000000-0000-4000-8000-000000000001', '10000000-0000-0000-0000-000000000001', 'UA', 'UAH', 'manager_cash');
insert into app.transactions (id, country_code, occurred_on, period, category, status)
  values ('74000000-0000-0000-0000-000000000002', 'UA', '2026-09-05', '2026-09-01', 'rent', 'draft');
insert into app.entries (transaction_id, account_id, property_id, amount, currency)
  values ('74000000-0000-0000-0000-000000000002', '74000000-0000-0000-0000-000000000001', '30000000-0000-0000-0000-000000000001', 1000, 'UAH');
update app.transactions set status = 'posted' where id = '74000000-0000-0000-0000-000000000002';
select app.cash_pay_client((select id from app.cash_boxes where country_code = 'UA'), '74000000-0000-0000-0000-000000000001', 400, '2026-10-10', 'אוקטובר');
reset role;
select pg_temp.check(
  (select sum(e.amount) from app.entries e join app.transactions t on t.id = e.transaction_id where e.account_id = '74000000-0000-0000-0000-000000000001' and t.status = 'posted') = 600
  and (select sum(e.amount) from app.entries e join app.accounts a on a.id = e.account_id join app.transactions t on t.id = e.transaction_id
       where a.kind = 'client_bank' and a.beneficiary_party_id = '10000000-0000-0000-0000-000000000001' and t.status = 'posted' and t.category = 'transfer') = 400
  and (select amount from app.cash_movements where kind = 'to_client') = -400,
  'paying a client from Gershon''s box: out of Vitaly''s cash, into the client''s own account, and in the box');
select pg_temp.as_user('00000000-0000-0000-0000-00000000000b');
do $$ begin
  perform app.cash_pay_client((select id from app.cash_boxes limit 1), '74000000-0000-0000-0000-000000000001', 1, '2026-10-10', null);
  raise exception 'FAILED: a Romania editor paid from Gershon''s box';
exception when insufficient_privilege then raise notice 'ok - only who writes to the box pays from it';
end $$;
reset role;
select pg_temp.as_user('00000000-0000-0000-0000-00000000000c');
select app.cash_remove_movement((select id from app.cash_movements where kind = 'to_client'));
reset role;
select pg_temp.check(not exists (select 1 from app.cash_movements)
  and (select status from app.transactions where category = 'transfer' and description like 'העברה ללקוח%') = 'void',
  'removing the payment voids its transfer');

-- A sum Gershon sent to the office, divided between a client and the office's fees (decision 114).
select pg_temp.as_user('00000000-0000-0000-0000-00000000000c');
insert into app.cash_movements (id, box_id, occurred_on, amount, currency, kind, party_name)
  select '74000000-0000-0000-0000-000000000003', id, '2026-10-20', -500, 'UAH', 'to_office', 'המשרד' from app.cash_boxes where country_code = 'UA';
select app.cash_pay_client((select id from app.cash_boxes where country_code = 'UA'), '74000000-0000-0000-0000-000000000001', 300, '2026-10-20', null, '74000000-0000-0000-0000-000000000003');
insert into app.cash_movements (box_id, occurred_on, amount, currency, kind, parent_id, party_name)
  select id, '2026-10-20', -50, 'UAH', 'office_fee', '74000000-0000-0000-0000-000000000003', 'המשרד' from app.cash_boxes where country_code = 'UA';
reset role;
select pg_temp.check((select amount from app.cash_movements m join app.cash_boxes b on b.id = m.box_id where b.is_office and m.kind = 'income') = 50,
  'an office fee is also income in the office''s box');
select pg_temp.check((select count(*) from app.cash_movements where parent_id = '74000000-0000-0000-0000-000000000003') = 2
  and (select status from app.transactions t join app.cash_movements m on m.transaction_id = t.id where m.parent_id is not null) = 'posted',
  'a sum sent to the office is divided: a client paid (posted) and the office''s fees');
select pg_temp.as_user('00000000-0000-0000-0000-00000000000c');
select app.cash_remove_movement('74000000-0000-0000-0000-000000000003');
reset role;
select pg_temp.check(not exists (select 1 from app.cash_movements)
  and (select count(*) from app.transactions where description like 'העברה ללקוח%' and status = 'posted') = 0,
  'removing the sum removes its parts and voids the client''s transfer');

-- Editing what was entered by hand (decision 119) ---------------------------

-- A client's part of a sum Gershon sent: editing its amount pays again from the same money.
select pg_temp.as_user('00000000-0000-0000-0000-00000000000c');
insert into app.cash_movements (id, box_id, occurred_on, amount, currency, kind, party_name)
  select '75000000-0000-0000-0000-000000000003', id, '2026-10-21', -500, 'UAH', 'to_office', 'המשרד' from app.cash_boxes where country_code = 'UA';
select app.cash_edit_movement(
  app.cash_pay_client((select id from app.cash_boxes where country_code = 'UA'), '74000000-0000-0000-0000-000000000001', 300, '2026-10-21', null, '75000000-0000-0000-0000-000000000003'),
  '2026-10-22', 200, 'תוקן');
select app.cash_edit_movement('75000000-0000-0000-0000-000000000003', '2026-10-21', 450, null);
reset role;
select pg_temp.check((select amount from app.cash_movements where parent_id = '75000000-0000-0000-0000-000000000003') = -200
  and (select amount from app.cash_movements where id = '75000000-0000-0000-0000-000000000003') = -450
  and (select count(*) from app.transactions where description like 'העברה ללקוח%תוקן' and status = 'posted') = 1,
  'a cash box movement is edited; a client''s part is paid again with the new amount');
select pg_temp.as_user('00000000-0000-0000-0000-00000000000c');
select app.cash_remove_movement('75000000-0000-0000-0000-000000000003');
reset role;

-- A sum in dollars at a rate (decision 123): a client's part is converted out of the client's
-- hryvnia, then paid; what was converted beyond the part stays in dollars.
select pg_temp.as_user('00000000-0000-0000-0000-00000000000c');
insert into app.cash_movements (id, box_id, occurred_on, amount, currency, kind, party_name, fx_rate)
  select '76000000-0000-0000-0000-000000000001', id, '2026-10-25', -900, 'USD', 'to_office', 'המשרד', 44 from app.cash_boxes where country_code = 'UA';
select app.cash_pay_client_fx((select id from app.cash_boxes where country_code = 'UA'), '74000000-0000-0000-0000-000000000001', 10, 462, '2026-10-25', null, '76000000-0000-0000-0000-000000000001');
reset role;
select pg_temp.check(
  (select sum(e.amount) from app.entries e join app.transactions t on t.id = e.transaction_id where e.account_id = '74000000-0000-0000-0000-000000000001' and t.status = 'posted') = 538
  and (select sum(e.amount) from app.entries e join app.accounts a on a.id = e.account_id join app.transactions t on t.id = e.transaction_id
       where a.kind = 'manager_cash' and a.currency = 'USD' and a.beneficiary_party_id = '10000000-0000-0000-0000-000000000001' and t.status = 'posted') = 0.50
  and (select sum(e.amount) from app.entries e join app.accounts a on a.id = e.account_id join app.transactions t on t.id = e.transaction_id
       where a.kind = 'client_bank' and a.currency = 'USD' and t.status = 'posted') = 10
  and (select fx_transaction_id is not null from app.cash_movements where parent_id = '76000000-0000-0000-0000-000000000001'),
  'a part of a sum in dollars: hryvnia converted at the rate, the part paid, the rest stays in dollars');
select pg_temp.as_user('00000000-0000-0000-0000-00000000000c');
select app.cash_edit_movement((select id from app.cash_movements where parent_id = '76000000-0000-0000-0000-000000000001'), '2026-10-26', 20, null);
reset role;
select pg_temp.check(
  (select sum(e.amount) from app.entries e join app.transactions t on t.id = e.transaction_id where e.account_id = '74000000-0000-0000-0000-000000000001' and t.status = 'posted') = 120
  and (select count(*) from app.transactions where category = 'fx' and status = 'posted') = 1,
  'editing a converted part converts again at the sum''s rate');
select pg_temp.as_user('00000000-0000-0000-0000-00000000000c');
select app.cash_remove_movement('76000000-0000-0000-0000-000000000001');
reset role;
select pg_temp.check(not exists (select 1 from app.transactions where category in ('fx', 'transfer') and status = 'posted'),
  'removing the sum voids its conversions and transfers');

-- A draft by an editor: its author fixes it in place; another editor may not.
insert into app.ownerships (property_id, party_id, share_pct, valid_from) values
  ('30000000-0000-0000-0000-000000000002', '10000000-0000-0000-0000-000000000002', 100, '2023-01-01');
select pg_temp.as_user('00000000-0000-0000-0000-00000000000b');
insert into app.transactions (id, country_code, occurred_on, period, category, status)
  values ('75000000-0000-0000-0000-000000000001', 'RO', '2026-04-05', '2026-04-01', 'repair', 'draft');
select app.post_import_entry('75000000-0000-0000-0000-000000000001', '30000000-0000-0000-0000-000000000002', null, 'RO', '2026-04-05',
  '{"amount": -100, "currency": "RON", "account": {"kind": "client_bank", "holder": "beneficiary"}}');
select app.edit_manual_entry('75000000-0000-0000-0000-000000000001', '2026-04-06', '2026-04-01', 'repair', 'תוקן', -150, 'RON', 'client_bank', null);
reset role;
select pg_temp.check((select amount from app.entries where transaction_id = '75000000-0000-0000-0000-000000000001') = -150
  and (select description from app.transactions where id = '75000000-0000-0000-0000-000000000001') = 'תוקן',
  'the author of a draft edits it in place');

-- Posted: an admin's edit voids it and enters the corrected one.
select pg_temp.as_user('00000000-0000-0000-0000-00000000000a');
update app.transactions set status = 'posted' where id = '75000000-0000-0000-0000-000000000001';
select app.edit_manual_entry('75000000-0000-0000-0000-000000000001', '2026-04-06', '2026-04-01', 'repair', 'תוקן שוב', -170, 'RON', 'client_bank', null);
reset role;
select pg_temp.check((select status from app.transactions where id = '75000000-0000-0000-0000-000000000001') = 'void'
  and (select count(*) from app.transactions where description = 'תוקן שוב' and status = 'posted') = 1,
  'editing a posted movement voids it and posts the corrected one');

-- A report's movement is not edited here.
select pg_temp.as_user('00000000-0000-0000-0000-00000000000a');
do $$ begin
  perform app.edit_manual_entry((select id from app.transactions where import_batch_id is not null limit 1), '2026-01-01', '2026-01-01', 'rent', null, 1, 'UAH', 'manager_cash', null);
  raise exception 'FAILED: a report''s movement was edited by hand';
exception when raise_exception then
  if sqlerrm like 'FAILED%' then raise; end if;
  raise notice 'ok - a movement from a report is not edited by hand';
end $$;
reset role;
delete from app.ownerships where property_id = '30000000-0000-0000-0000-000000000002';

-- Tasks (decision 128): only the author, who it is with, management and admins see it.
select pg_temp.as_user('00000000-0000-0000-0000-00000000000c');
select app.create_office_task((select id from app.task_triggers where label = 'לקוח'), 'לבדוק חוזה', 'פרטים', 'high',
  array['00000000-0000-0000-0000-00000000000b']::uuid[], array['10000000-0000-0000-0000-000000000001']::uuid[],
  '[{"kind":"property","entity_id":"30000000-0000-0000-0000-000000000001"},{"kind":"country","country_code":"UA"}]');
select pg_temp.check((select count(*) from app.office_task_links) = 2 and (select count(*) from app.office_task_assignees) = 2
  and (select count(*) from app.office_task_events) = 1, 'a task is created with its links and assignees, as one "created" event');
reset role;
select pg_temp.as_user('00000000-0000-0000-0000-00000000000d');
select pg_temp.check((select count(*) from app.office_tasks) = 1 and (select count(*) from app.task_people()) >= 1, 'a client the task is with sees it, and the names on it');
reset role;
select pg_temp.as_user('00000000-0000-0000-0000-00000000000b');
select pg_temp.check((select count(*) from app.office_tasks) = 1, 'the employee it is with sees the task');
insert into app.office_task_events (task_id, kind, body) select id, 'reply', 'בטיפול' from app.office_tasks;
update app.office_tasks set status = 'in_progress', priority = 'low', category_id = (select id from app.task_categories where label = 'ייעול');
delete from app.office_task_assignees where party_id is not null;
reset role;
select pg_temp.check((select string_agg(kind, ',' order by created_at, kind) from app.office_task_events) like 'created,%'
  and (select count(*) from app.office_task_events where kind in ('reply', 'status', 'change', 'unassign')) = 4,
  'a reply, the state, a change of a detail and passing it on are all in the history');
select pg_temp.check((select data->'category'->>1 from app.office_task_events where kind = 'change') = 'ייעול', 'a change of category is in the history by name');
select pg_temp.as_user('00000000-0000-0000-0000-00000000000d');
select pg_temp.check(not exists (select 1 from app.office_tasks), 'a client no longer on the task does not see it');
reset role;
select pg_temp.as_user('00000000-0000-0000-0000-00000000000e');
select pg_temp.check((select count(*) from app.office_tasks) = 1, 'management sees every task');
reset role;
-- Another employee, not on the task: sees nothing and cannot answer.
insert into auth.users (id, email) values ('00000000-0000-0000-0000-00000000000f', 'ro.other@example.test');
insert into app.profiles (user_id, display_name) values ('00000000-0000-0000-0000-00000000000f', 'RO other');
insert into app.user_country_roles (user_id, country_code, level) values ('00000000-0000-0000-0000-00000000000f', 'RO', 'editor');
select pg_temp.as_user('00000000-0000-0000-0000-00000000000f');
select pg_temp.check(not exists (select 1 from app.office_tasks), 'an employee the task is not with does not see it');
do $$ begin
  insert into app.office_task_events (task_id, kind, body) select id, 'reply', 'x' from app.office_tasks;
  insert into app.office_task_events (task_id, kind, body) values ((select id from app.office_task_links limit 1), 'reply', 'x');
  raise exception 'FAILED: an outsider answered a task';
exception when others then
  if sqlerrm like 'FAILED%' then raise; end if;
  raise notice 'ok - an employee the task is not with cannot answer it';
end $$;
reset role;

-- Deleting a task (decision 134): only once done, by its author, management or an admin.
select pg_temp.as_user('00000000-0000-0000-0000-00000000000b');
delete from app.office_tasks where subject = 'לבדוק חוזה';
reset role;
select pg_temp.check(exists (select 1 from app.office_tasks where subject = 'לבדוק חוזה'), 'the employee a task is with does not delete it');
select pg_temp.as_user('00000000-0000-0000-0000-00000000000c');
delete from app.office_tasks where subject = 'לבדוק חוזה';
reset role;
select pg_temp.check(exists (select 1 from app.office_tasks where subject = 'לבדוק חוזה'), 'an open task is not deleted, even by its author');
update app.office_tasks set status = 'done' where subject = 'לבדוק חוזה';
select pg_temp.as_user('00000000-0000-0000-0000-00000000000c');
delete from app.office_tasks where subject = 'לבדוק חוזה';
reset role;
select pg_temp.check(not exists (select 1 from app.office_tasks where subject = 'לבדוק חוזה')
  and not exists (select 1 from app.office_task_events e where not exists (select 1 from app.office_tasks t where t.id = e.task_id)),
  'its author deletes a task once done, with its history');

-- Recurring tasks (decision 130): a monthly one on the 31st opens on the last day of a short
-- month, once per date however often it runs; the tasks are seen like any task.
select pg_temp.as_user('00000000-0000-0000-0000-00000000000c');
insert into app.office_task_series (subject, frequency, month_days, start_on, users, links)
values ('דוח גרשון', 'monthly', array[31], '2026-01-01', array['00000000-0000-0000-0000-00000000000b']::uuid[], '[{"kind":"country","country_code":"UA"}]');
insert into app.office_task_series (subject, frequency, workdays_only, start_on, end_on) values ('וואטסאפ', 'daily', true, '2026-03-01', '2026-03-07');
insert into app.office_task_series (subject, frequency, year_dates, lead_days, start_on) values ('ביטוח', 'yearly', array['02-29'], 7, '2026-01-01');
insert into app.office_task_series (subject, frequency, month_days, last_day, start_on, end_on) values ('גבייה', 'monthly', array[1, 15], true, '2026-04-01', '2026-04-30');
insert into app.office_task_series (subject, frequency, year_dates, start_on) values ('מיסים', 'yearly', array['03-31', '09-30'], '2026-01-01');
select app.spawn_recurring_tasks('2026-04-30');
select app.spawn_recurring_tasks('2026-04-30');
reset role;
select pg_temp.check(
  (select string_agg(occurrence_on::text, ',' order by occurrence_on) from app.office_tasks where subject = 'דוח גרשון') = '2026-01-31,2026-02-28,2026-03-31,2026-04-30'
  and (select count(*) from app.office_tasks where subject = 'וואטסאפ') = 5
  and (select string_agg(occurrence_on::text, ',') from app.office_tasks where subject = 'ביטוח') = '2026-02-28'
  and (select string_agg(occurrence_on::text, ',' order by occurrence_on) from app.office_tasks where subject = 'גבייה') = '2026-04-01,2026-04-15,2026-04-30'
  and (select string_agg(occurrence_on::text, ',') from app.office_tasks where subject = 'מיסים') = '2026-03-31'
  and (select count(*) from app.office_task_assignees a join app.office_tasks t on t.id = a.task_id where t.subject = 'דוח גרשון') = 4
  and (select count(*) from app.office_task_events e join app.office_tasks t on t.id = e.task_id where t.subject = 'דוח גרשון') = 4,
  'recurring tasks open on their days (several days a month or a year, last day of a short month, workdays only, ahead by lead days), once each');
select pg_temp.as_user('00000000-0000-0000-0000-00000000000b');
select pg_temp.check((select count(*) from app.office_tasks where subject = 'דוח גרשון') = 4
  and (select count(*) from app.office_tasks where subject = 'וואטסאפ') = 0, 'a recurring task''s tasks are seen by whom they are with');
reset role;
select pg_temp.as_user('00000000-0000-0000-0000-00000000000f');
select pg_temp.check(not exists (select 1 from app.office_task_series), 'an employee not on a recurring task does not see it');
reset role;

-- Audit -----------------------------------------------------------------

select pg_temp.check(
  (select count(*) from app.audit_log where table_name = 'transactions') >= 2,
  'ledger changes are audited');

\echo ALL TESTS PASSED
