-- Money paid around the purchase of a property (SPEC decision 83): to the seller, the
-- developer, lawyers, notaries, the referrer. Georgia kept these in Airtable `payments`.
-- A historical record of what was paid, not a ledger entry: it is not posted and moves no
-- balance. Payer and payee keep the name as written, and a link to the party when known.
create table app.purchase_payments (
  id               uuid primary key default gen_random_uuid(),
  property_id      uuid not null references app.properties on delete cascade,
  country_code     char(2) not null references app.countries,
  paid_on          date,
  kind             text not null default 'expense' check (kind in ('expense', 'income', 'loan', 'transfer')),
  amount           numeric(14,2),
  currency         app.currency,
  payer_party_id   uuid references app.parties on delete set null,
  payer_name       text,
  payee_party_id   uuid references app.parties on delete set null,
  payee_name       text,
  notes            text,
  source           text,
  created_at       timestamptz not null default now(),
  created_by       uuid default auth.uid(),
  check (amount is null or currency is not null)
);
create index on app.purchase_payments (property_id);
create unique index purchase_payments_source on app.purchase_payments (source) where source is not null;

alter table app.purchase_payments enable row level security;
create policy staff_read on app.purchase_payments for select to authenticated using (app.can_read_country(country_code));
create policy client_read on app.purchase_payments for select to authenticated using (app.client_owns_property(property_id));
create policy staff_write on app.purchase_payments for all to authenticated
  using (app.can_edit_country(country_code)) with check (app.can_edit_country(country_code));
create policy require_mfa on app.purchase_payments as restrictive for all to authenticated
  using (app.mfa_verified() or app.my_party_id() is not null)
  with check (app.mfa_verified() or app.my_party_id() is not null);
grant select, insert, update, delete on app.purchase_payments to authenticated;
create trigger audit after insert or update or delete on app.purchase_payments for each row execute function app.audit();
