-- Core schema: geography, parties, ownership, management, leases, money ledger.
-- See docs/SPEC.md §4 for the model and the reasoning behind it.

create schema if not exists app;

-- ---------------------------------------------------------------------------
-- Reference values
-- ---------------------------------------------------------------------------

create type app.currency as enum ('ILS', 'USD', 'EUR', 'UAH', 'RON', 'GEL');

create type app.party_kind as enum ('person', 'company');

create type app.party_role as enum (
  'client', 'tenant', 'manager', 'lawyer', 'hotel', 'developer',
  'supplier', 'marketer', 'internal'
);

create type app.property_status as enum (
  'under_construction', 'vacant', 'rented', 'short_term', 'owner_use', 'sold'
);

create type app.fee_model as enum (
  'pct_of_gross',        -- Vitaly, Liana: % of collected rent
  'pct_after_expenses',  -- Marina: % after commission and utilities
  'hotel_split',         -- Alliance: owner gets fixed share per reservation
  'pooled_allocation',   -- Marina: pooled revenue split by coefficient
  'none'                 -- Itai (Romania): no management fee to us
);

create type app.account_kind as enum (
  'rent_pool',      -- rent collected and held for the client (Gershon UAH)
  'expense_pool',   -- prepaid fund for building costs (Gershon USD)
  'manager_cash',   -- held by the local manager before transfer (Vitaly, Itai, Yarach)
  'hotel_balance',  -- owner balance kept by a hotel (Marina)
  'client_bank',    -- the client's own bank account (Wise, BoG, Solo, Libra)
  'company',        -- our own companies' accounts (SEE THE FUTURE, Yom-Tov)
  'legacy_card'     -- old UKRGASBANK client cards, history only
);

create type app.txn_category as enum (
  'rent', 'mgmt_fee', 'hotel_share', 'utilities', 'building_fees', 'legal_fees',
  'repair', 'tax_withheld', 'transfer', 'fx', 'deposit', 'purchase_installment',
  'deal_fee', 'commission', 'opening_balance', 'other'
);

create type app.txn_status as enum ('draft', 'posted', 'void');

-- ---------------------------------------------------------------------------
-- Geography
-- ---------------------------------------------------------------------------

create table app.countries (
  code        char(2) primary key,
  name_he     text not null,
  name_en     text not null
);

create table app.cities (
  id            uuid primary key default gen_random_uuid(),
  country_code  char(2) not null references app.countries,
  name_he       text not null,
  name_en       text not null,
  unique (country_code, name_en)
);

create table app.projects (
  id          uuid primary key default gen_random_uuid(),
  city_id     uuid not null references app.cities,
  name        text not null,
  notes       text,
  unique (city_id, name)
);

create table app.buildings (
  id          uuid primary key default gen_random_uuid(),
  city_id     uuid not null references app.cities,
  project_id  uuid references app.projects,
  name        text not null,
  address     text,
  notes       text
);

-- country_code is denormalized from building → city so row-level security
-- can filter by country without joins.
create table app.properties (
  id            uuid primary key default gen_random_uuid(),
  building_id   uuid not null references app.buildings,
  country_code  char(2) not null references app.countries,
  unit_no       text not null,
  floor         text,
  sqm           numeric(8,2),
  status        app.property_status not null default 'vacant',
  notes         text,
  created_at    timestamptz not null default now(),
  unique (building_id, unit_no)
);

create function app.properties_set_country() returns trigger
language plpgsql as $$
begin
  select c.country_code into new.country_code
  from app.buildings b join app.cities c on c.id = b.city_id
  where b.id = new.building_id;
  return new;
end $$;

create trigger properties_set_country
  before insert or update of building_id on app.properties
  for each row execute function app.properties_set_country();

-- ---------------------------------------------------------------------------
-- Parties: every person or company we deal with
-- ---------------------------------------------------------------------------

create table app.parties (
  id            uuid primary key default gen_random_uuid(),
  kind          app.party_kind not null default 'person',
  display_name  text not null,
  legal_name    text,
  email         text,
  phone         text,
  notes         text,
  created_at    timestamptz not null default now()
);

create table app.party_roles (
  party_id  uuid not null references app.parties on delete cascade,
  role      app.party_role not null,
  primary key (party_id, role)
);

-- ---------------------------------------------------------------------------
-- Time-bound relations (history is never deleted, only closed with valid_to)
-- ---------------------------------------------------------------------------

create table app.ownerships (
  id           uuid primary key default gen_random_uuid(),
  property_id  uuid not null references app.properties,
  party_id     uuid not null references app.parties,
  share_pct    numeric(7,4) not null check (share_pct > 0 and share_pct <= 100),
  valid_from   date not null,
  valid_to     date,
  notes        text,
  check (valid_to is null or valid_to >= valid_from)
);
create index on app.ownerships (property_id);
create index on app.ownerships (party_id);

create table app.management_agreements (
  id                uuid primary key default gen_random_uuid(),
  property_id       uuid not null references app.properties,
  manager_party_id  uuid not null references app.parties,
  fee_model         app.fee_model not null,
  fee_pct           numeric(5,2) check (fee_pct between 0 and 100),
  valid_from        date not null,
  valid_to          date,
  notes             text,
  check (valid_to is null or valid_to >= valid_from)
);
create index on app.management_agreements (property_id);

create table app.leases (
  id                   uuid primary key default gen_random_uuid(),
  property_id          uuid not null references app.properties,
  tenant_party_id      uuid references app.parties,
  start_date           date not null,
  end_date             date,
  rent_amount          numeric(14,2) not null,
  rent_currency        app.currency not null,
  payment_currency     app.currency,
  deposit_amount       numeric(14,2),
  deposit_currency     app.currency,
  collect_day          smallint check (collect_day between 1 and 31),
  -- Romania: 8% when the tenant is a company, 0 for a private tenant.
  withholding_tax_pct  numeric(5,2) not null default 0,
  notes                text,
  check (end_date is null or end_date >= start_date)
);
create index on app.leases (property_id);

-- Expected monthly rent per property; drives arrears and pro-rata allocation
-- (Odessa: transfers in a month are split by each unit's share of this amount).
create table app.rent_schedule (
  id           uuid primary key default gen_random_uuid(),
  property_id  uuid not null references app.properties,
  amount       numeric(14,2) not null check (amount >= 0),
  currency     app.currency not null,
  valid_from   date not null,
  valid_to     date,
  check (valid_to is null or valid_to >= valid_from)
);
create index on app.rent_schedule (property_id);

-- ---------------------------------------------------------------------------
-- Money: accounts ("who holds the money, for whom, in what currency")
-- ---------------------------------------------------------------------------

create table app.accounts (
  id                    uuid primary key default gen_random_uuid(),
  holder_party_id       uuid not null references app.parties,
  beneficiary_party_id  uuid not null references app.parties,
  country_code          char(2) not null references app.countries,
  currency              app.currency not null,
  kind                  app.account_kind not null,
  label                 text,
  -- Bank identifiers only. Credentials, card numbers, CVV and PIN never go here.
  bank_name             text,
  iban                  text,
  card_last4            char(4),
  active                boolean not null default true,
  created_at            timestamptz not null default now()
);
create index on app.accounts (beneficiary_party_id);
create index on app.accounts (holder_party_id);

create table app.transactions (
  id               uuid primary key default gen_random_uuid(),
  country_code     char(2) not null references app.countries,
  occurred_on      date not null,
  period           date not null check (extract(day from period) = 1),
  category         app.txn_category not null,
  description      text,
  status           app.txn_status not null default 'draft',
  import_batch_id  uuid,
  created_by       uuid,
  created_at       timestamptz not null default now(),
  approved_by      uuid,
  approved_at      timestamptz
);
create index on app.transactions (country_code, period);

-- One transaction has one or more entries. A currency exchange is a single
-- transaction with two entries in two currencies and the rate on each.
create table app.entries (
  id               uuid primary key default gen_random_uuid(),
  transaction_id   uuid not null references app.transactions on delete cascade,
  account_id       uuid references app.accounts,
  external_party_id uuid references app.parties,
  property_id      uuid references app.properties,
  amount           numeric(18,2) not null,
  currency         app.currency not null,
  fx_rate          numeric(18,8),
  memo             text,
  check (account_id is not null or external_party_id is not null)
);
create index on app.entries (transaction_id);
create index on app.entries (account_id);
create index on app.entries (property_id);

-- The entry currency must match its account currency.
create function app.entries_check_currency() returns trigger
language plpgsql as $$
declare acc_currency app.currency;
begin
  if new.account_id is not null then
    select currency into acc_currency from app.accounts where id = new.account_id;
    if acc_currency <> new.currency then
      raise exception 'entry currency % does not match account currency %',
        new.currency, acc_currency;
    end if;
  end if;
  return new;
end $$;

create trigger entries_check_currency
  before insert or update on app.entries
  for each row execute function app.entries_check_currency();

-- Balances count posted transactions only.
create view app.account_balances with (security_invoker = true) as
select a.id as account_id, a.beneficiary_party_id, a.holder_party_id,
       a.country_code, a.currency, a.kind,
       coalesce(sum(e.amount) filter (where t.status = 'posted'), 0) as balance
from app.accounts a
left join app.entries e on e.account_id = a.id
left join app.transactions t on t.id = e.transaction_id
group by a.id;

-- ---------------------------------------------------------------------------
-- Name mapping between sources ("Beldiman1_ap.57" in Itai's file is the same
-- property as "2 - Alexandru Beldiman 1, ... Apt 57" in Airtable)
-- ---------------------------------------------------------------------------

create table app.external_refs (
  id            uuid primary key default gen_random_uuid(),
  entity_type   text not null check (entity_type in ('property', 'party', 'lease', 'account')),
  entity_id     uuid not null,
  source        text not null,
  external_key  text not null,
  unique (source, entity_type, external_key)
);
create index on app.external_refs (entity_type, entity_id);

-- ---------------------------------------------------------------------------
-- Seed reference data
-- ---------------------------------------------------------------------------

insert into app.countries (code, name_he, name_en) values
  ('UA', 'אוקראינה', 'Ukraine'),
  ('RO', 'רומניה',   'Romania'),
  ('GE', 'גאורגיה',  'Georgia'),
  ('GR', 'יוון',     'Greece');
