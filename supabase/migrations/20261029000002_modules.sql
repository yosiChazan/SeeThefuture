-- Supporting modules: ingestion, deals and construction, utilities, documents,
-- tasks, client communication and monthly statements. See docs/SPEC.md §4–6.

-- ---------------------------------------------------------------------------
-- Ingestion: parse → review → commit. Nothing writes to the ledger directly.
-- ---------------------------------------------------------------------------

create type app.batch_status as enum ('parsed', 'in_review', 'committed', 'rejected');

create table app.import_sources (
  id            uuid primary key default gen_random_uuid(),
  name          text not null unique,
  adapter       text not null,   -- e.g. vitaly_rent_xlsx, gershon_utilities_xlsx, itai_incomes_xlsx
  country_code  char(2) not null references app.countries,
  active        boolean not null default true
);

create table app.import_batches (
  id            uuid primary key default gen_random_uuid(),
  source_id     uuid not null references app.import_sources,
  country_code  char(2) not null references app.countries,
  file_path     text,             -- storage path of the original file
  received_at   timestamptz not null default now(),
  status        app.batch_status not null default 'parsed',
  reviewed_by   uuid,
  reviewed_at   timestamptz,
  notes         text
);

create table app.import_rows (
  id                    uuid primary key default gen_random_uuid(),
  batch_id              uuid not null references app.import_batches on delete cascade,
  row_ref               text,      -- sheet/row or page/line in the original file
  raw                   jsonb not null,
  proposed              jsonb,     -- transaction + entries the adapter suggests
  match_status          text not null default 'unmatched'
                        check (match_status in ('matched', 'unmatched', 'duplicate', 'ignored')),
  issues                text[],
  transaction_id        uuid references app.transactions
);
create index on app.import_rows (batch_id);

alter table app.transactions
  add constraint transactions_import_batch_fk
  foreign key (import_batch_id) references app.import_batches;

-- ---------------------------------------------------------------------------
-- Deals (purchase through SEE THE FUTURE) and construction tracking
-- ---------------------------------------------------------------------------

create type app.deal_status as enum ('lead', 'in_progress', 'completed', 'cancelled');

create table app.deals (
  id                 uuid primary key default gen_random_uuid(),
  property_id        uuid not null references app.properties,
  client_party_id    uuid not null references app.parties,
  developer_party_id uuid references app.parties,
  country_code       char(2) not null references app.countries,
  signed_on          date,
  status             app.deal_status not null default 'in_progress',
  total_price        numeric(14,2),
  price_currency     app.currency,
  company_fee        numeric(14,2),
  fee_currency       app.currency,
  notes              text
);

create table app.installments (
  id              uuid primary key default gen_random_uuid(),
  deal_id         uuid not null references app.deals on delete cascade,
  due_date        date,
  amount          numeric(14,2) not null,
  currency        app.currency not null,
  paid_txn_id     uuid references app.transactions,
  notes           text
);

create table app.milestones (
  id             uuid primary key default gen_random_uuid(),
  deal_id        uuid not null references app.deals on delete cascade,
  name           text not null,
  planned_date   date,
  actual_date    date
);

create table app.site_updates (
  id            uuid primary key default gen_random_uuid(),
  project_id    uuid references app.projects,
  property_id   uuid references app.properties,
  country_code  char(2) not null references app.countries,
  happened_on   date not null,
  body          text not null,
  created_by    uuid,
  check (project_id is not null or property_id is not null)
);

-- ---------------------------------------------------------------------------
-- Utility contracts (mainly Romania). Passwords stay in Bitwarden.
-- ---------------------------------------------------------------------------

create table app.utility_contracts (
  id            uuid primary key default gen_random_uuid(),
  property_id   uuid not null references app.properties,
  kind          text not null check (kind in ('electricity', 'gas', 'water', 'internet', 'building_assoc')),
  provider      text,
  client_code   text,
  payer         text check (payer in ('tenant', 'owner', 'building')),
  status        text,
  deadline      date,
  notes         text
);

-- ---------------------------------------------------------------------------
-- Documents (files live in private storage; this is the index)
-- ---------------------------------------------------------------------------

create table app.documents (
  id            uuid primary key default gen_random_uuid(),
  entity_type   text not null check (entity_type in ('property', 'party', 'lease', 'deal', 'transaction', 'import_batch')),
  entity_id     uuid not null,
  country_code  char(2) references app.countries,
  doc_type      text not null,   -- passport, purchase_contract, lease_contract, receipt, report...
  storage_path  text not null,
  sensitive     boolean not null default false,
  uploaded_by   uuid,
  uploaded_at   timestamptz not null default now()
);
create index on app.documents (entity_type, entity_id);

-- ---------------------------------------------------------------------------
-- Tasks
-- ---------------------------------------------------------------------------

create table app.tasks (
  id            uuid primary key default gen_random_uuid(),
  title         text not null,
  notes         text,
  country_code  char(2) references app.countries,
  entity_type   text check (entity_type in ('property', 'party', 'lease', 'deal')),
  entity_id     uuid,
  assignee_id   uuid,
  due_date      date,
  status        text not null default 'open' check (status in ('open', 'in_progress', 'done', 'cancelled')),
  created_by    uuid,
  created_at    timestamptz not null default now()
);

-- ---------------------------------------------------------------------------
-- Client communication (WhatsApp, answered by people only) and statements
-- ---------------------------------------------------------------------------

create table app.conversations (
  id               uuid primary key default gen_random_uuid(),
  client_party_id  uuid references app.parties,
  wa_phone         text not null unique,
  assigned_to      uuid,
  status           text not null default 'open' check (status in ('open', 'waiting', 'closed')),
  last_message_at  timestamptz
);

create table app.messages (
  id               uuid primary key default gen_random_uuid(),
  conversation_id  uuid not null references app.conversations on delete cascade,
  direction        text not null check (direction in ('in', 'out')),
  body             text,
  media_path       text,
  wa_message_id    text unique,
  sent_by          uuid,
  created_at       timestamptz not null default now()
);
create index on app.messages (conversation_id, created_at);

create table app.statements (
  id               uuid primary key default gen_random_uuid(),
  client_party_id  uuid not null references app.parties,
  period           date not null check (extract(day from period) = 1),
  pdf_path         text,
  status           text not null default 'draft' check (status in ('draft', 'approved', 'sent')),
  approved_by      uuid,
  approved_at      timestamptz,
  sent_at          timestamptz,
  unique (client_party_id, period)
);
