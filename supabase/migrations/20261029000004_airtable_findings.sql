-- Additions found while profiling the full Airtable export (docs/SPEC.md §12).

-- Ukraine: some leases pay management as one month's rent per year.
alter type app.fee_model add value 'one_month_per_year';

-- Georgia payments include loans; Ukraine and Georgia leases pay a local brokerage fee.
alter type app.txn_category add value 'loan';
alter type app.txn_category add value 'brokerage';

alter table app.leases
  add column brokerage_fee      numeric(14,2),
  add column brokerage_currency app.currency;

-- Clients come through a referrer (e.g. "came through Chani"); Romania keeps NIF numbers.
alter table app.parties
  add column tax_id                text,
  add column address               text,
  add column referred_by_party_id  uuid references app.parties;

alter table app.deals
  add column referrer_party_id uuid references app.parties;

-- ---------------------------------------------------------------------------
-- Official exchange rates (BNR, NBU, NBG), fetched daily. Used for reporting
-- and to suggest a rate; the rate actually applied is stored on the entry.
-- ---------------------------------------------------------------------------

create table app.fx_rates (
  rate_date  date not null,
  base       app.currency not null,
  quote      app.currency not null,
  rate       numeric(18,8) not null check (rate > 0),
  source     text not null,   -- BNR | NBU | NBG
  primary key (rate_date, base, quote, source)
);

-- ---------------------------------------------------------------------------
-- Charges: what is due for a property in a month (rent, utilities, building
-- fees) and whether it was paid. Drives arrears and "unpaid bill" alerts.
-- ---------------------------------------------------------------------------

create table app.charges (
  id            uuid primary key default gen_random_uuid(),
  property_id   uuid not null references app.properties,
  period        date not null check (extract(day from period) = 1),
  kind          text not null check (kind in (
                  'rent', 'electricity', 'gas', 'water', 'internet', 'building_assoc', 'other')),
  amount        numeric(14,2) not null,
  currency      app.currency not null,
  due_date      date,
  payer         text not null default 'tenant' check (payer in ('tenant', 'owner')),
  status        text not null default 'due' check (status in ('due', 'paid', 'partial', 'waived')),
  paid_txn_id   uuid references app.transactions,
  document_id   uuid references app.documents,
  notes         text
);
create index on app.charges (property_id, period);

alter table app.fx_rates enable row level security;
alter table app.charges enable row level security;
grant select, insert, update, delete on app.fx_rates, app.charges to authenticated;

create policy read_all on app.fx_rates for select to authenticated using (true);
create policy admin_write on app.fx_rates for all to authenticated
  using (app.is_admin()) with check (app.is_admin());

create policy staff_read on app.charges for select to authenticated
  using (app.can_read_country(app.property_country(property_id)));
create policy client_read on app.charges for select to authenticated
  using (app.client_owns_property(property_id));
create policy staff_write on app.charges for all to authenticated
  using (app.can_edit_country(app.property_country(property_id)))
  with check (app.can_edit_country(app.property_country(property_id)));
