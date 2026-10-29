-- Intake of local managers' reports (SPEC §5): a file is parsed in the office app
-- into import_rows, a person reviews them, and finance commits the batch. Commit is
-- one database transaction: every reviewed row becomes a posted transaction, or
-- nothing does.

-- The manager or lawyer who holds the money a source reports on (Vitaly's cash,
-- Gershon's pools). Entries that say "source" are booked against this party.
alter table app.import_sources add column holder_party_id uuid references app.parties;

alter table app.import_rows
  add column property_id  uuid references app.properties,
  -- Stable key of what the row reports (source, property, period, kind, amount).
  -- A fingerprint that is already posted marks the row as a duplicate.
  add column fingerprint  text;
create index on app.import_rows (fingerprint);

-- ---------------------------------------------------------------------------
-- Local managers and sources
-- ---------------------------------------------------------------------------

do $$
declare gershon uuid;
begin
  insert into app.parties (id, kind, display_name) values
    ('a0000000-0000-4000-8000-000000000001', 'person', 'ויטאלי'),
    ('a0000000-0000-4000-8000-000000000002', 'person', 'ירח'),
    ('a0000000-0000-4000-8000-000000000003', 'person', 'ליאנה')
  on conflict (id) do nothing;
  insert into app.party_roles (party_id, role) values
    ('a0000000-0000-4000-8000-000000000001', 'manager'),
    ('a0000000-0000-4000-8000-000000000002', 'manager'),
    ('a0000000-0000-4000-8000-000000000003', 'manager')
  on conflict do nothing;

  -- Gershon came from Airtable as "עוד גרשון"; create him where he is missing (tests).
  select id into gershon from app.parties where display_name = 'עוד גרשון' limit 1;
  if gershon is null then
    insert into app.parties (id, kind, display_name)
    values ('a0000000-0000-4000-8000-000000000004', 'person', 'עו"ד גרשון') returning id into gershon;
  end if;
  insert into app.party_roles (party_id, role) values (gershon, 'lawyer') on conflict do nothing;

  insert into app.import_sources (name, adapter, country_code, holder_party_id) values
    ('ויטאלי · דוח שכירות PLC',       'vitaly_rent_xlsx',       'UA', 'a0000000-0000-4000-8000-000000000001'),
    ('גרשון · הוצאות בניין PLC',     'gershon_utilities_xlsx', 'UA', gershon),
    ('איתי · Incomes',              'itai_incomes_xlsx',      'RO', null),
    ('Alliance · Owner Statement',  'alliance_pdf',           'GE', null),
    ('Marina Club · Income statement', 'marina_pdf',          'GE', null),
    ('ירח · העברות אודסה',           'manual_yarach',          'UA', 'a0000000-0000-4000-8000-000000000002'),
    ('ליאנה · Alliance',            'manual_liana',           'GE', 'a0000000-0000-4000-8000-000000000003')
  on conflict (name) do nothing;
end $$;

-- ---------------------------------------------------------------------------
-- Commit
-- ---------------------------------------------------------------------------

-- The account that holds money of `beneficiary` with `holder` in `currency`;
-- created on first use, so a new client needs no setup before their first report.
create function app.account_for(p_kind app.account_kind, p_holder uuid, p_beneficiary uuid,
                                p_currency app.currency, p_country char(2)) returns uuid
language plpgsql set search_path = '' as $$
declare a uuid;
begin
  select id into a from app.accounts
  where kind = p_kind and holder_party_id = p_holder and beneficiary_party_id = p_beneficiary
    and currency = p_currency and country_code = p_country and active
  order by created_at limit 1;
  if a is null then
    insert into app.accounts (holder_party_id, beneficiary_party_id, country_code, currency, kind)
    values (p_holder, p_beneficiary, p_country, p_currency, p_kind) returning id into a;
  end if;
  return a;
end $$;

-- One proposed entry:
--   {"amount": 20000, "currency": "UAH", "memo": "...", "fx_rate": 43.0,
--    "account": {"kind": "manager_cash", "holder": "source" | "beneficiary" | <uuid>}}
-- or {"amount": ..., "currency": ..., "external": "source" | <uuid>}.
-- An account entry belongs to the property's owners on that date and is split by
-- their shares; the last owner takes the rounding remainder.
create function app.post_import_entry(p_txn uuid, p_property uuid, p_source_holder uuid,
                                      p_country char(2), p_on date, e jsonb) returns void
language plpgsql set search_path = '' as $$
declare
  amount   numeric := (e ->> 'amount')::numeric;
  cur      app.currency := (e ->> 'currency')::app.currency;
  rate     numeric := (e ->> 'fx_rate')::numeric;
  memo     text := e ->> 'memo';
  who      text;
  holder   uuid;
  o        record;
  owners   int;
  i        int := 0;
  rest     numeric := amount;
  part     numeric;
begin
  if e ? 'external' then
    who := e ->> 'external';
    insert into app.entries (transaction_id, external_party_id, property_id, amount, currency, fx_rate, memo)
    values (p_txn, case when who = 'source' then p_source_holder else who::uuid end,
            p_property, amount, cur, rate, memo);
    return;
  end if;

  if p_property is null then raise exception 'row has no property'; end if;
  select count(*) into owners from app.ownerships
  where property_id = p_property and valid_from <= p_on and (valid_to is null or valid_to >= p_on);
  if owners = 0 then raise exception 'property % has no owner on %', p_property, p_on; end if;

  who := e -> 'account' ->> 'holder';
  for o in
    select party_id, share_pct from app.ownerships
    where property_id = p_property and valid_from <= p_on and (valid_to is null or valid_to >= p_on)
    order by share_pct, party_id
  loop
    i := i + 1;
    part := case when i = owners then rest else round(amount * o.share_pct / 100, 2) end;
    rest := rest - part;
    holder := case who when 'source' then p_source_holder when 'beneficiary' then o.party_id else who::uuid end;
    if holder is null then raise exception 'source has no holder party'; end if;
    insert into app.entries (transaction_id, account_id, property_id, amount, currency, fx_rate, memo)
    values (p_txn,
            app.account_for((e -> 'account' ->> 'kind')::app.account_kind, holder, o.party_id, cur, p_country),
            p_property, part, cur, rate, memo);
  end loop;
end $$;

-- Posts every matched row of a batch. Only finance of the batch's country (or an
-- admin) may call it; the transaction guard enforces the same on each posting.
-- Proposed transaction: {"occurred_on", "period", "category", "description", "entries": [...]}.
create function app.commit_import_batch(p_batch uuid) returns int
language plpgsql set search_path = '' as $$
declare
  b       app.import_batches;
  src     app.import_sources;
  r       app.import_rows;
  t       uuid;
  e       jsonb;
  posted  int := 0;
begin
  select * into b from app.import_batches where id = p_batch for update;
  if b.id is null then raise exception 'batch not found'; end if;
  if b.status not in ('parsed', 'in_review') then raise exception 'batch is already %', b.status; end if;
  if not app.can_approve_country(b.country_code) then raise exception 'only finance can approve a batch'; end if;
  select * into src from app.import_sources where id = b.source_id;

  for r in
    select * from app.import_rows
    where batch_id = p_batch and match_status = 'matched' and transaction_id is null and proposed is not null
    order by row_ref
  loop
    if r.fingerprint is not null and exists (
      select 1 from app.import_rows x join app.transactions tx on tx.id = x.transaction_id
      where x.fingerprint = r.fingerprint and tx.status = 'posted'
    ) then
      update app.import_rows set match_status = 'duplicate' where id = r.id;
      continue;
    end if;

    insert into app.transactions (country_code, occurred_on, period, category, description, status, import_batch_id)
    values (b.country_code, (r.proposed ->> 'occurred_on')::date, (r.proposed ->> 'period')::date,
            (r.proposed ->> 'category')::app.txn_category, r.proposed ->> 'description', 'draft', p_batch)
    returning id into t;
    for e in select * from jsonb_array_elements(r.proposed -> 'entries') loop
      perform app.post_import_entry(t, r.property_id, src.holder_party_id, b.country_code,
                                    (r.proposed ->> 'occurred_on')::date, e);
    end loop;
    update app.transactions set status = 'posted' where id = t;
    update app.import_rows set transaction_id = t where id = r.id;
    posted := posted + 1;

    -- Remember how this source names the property, so next month matches exactly.
    if r.raw ? 'property_ref' and r.property_id is not null then
      insert into app.external_refs (entity_type, entity_id, source, external_key)
      values ('property', r.property_id, src.adapter, r.raw ->> 'property_ref')
      on conflict (source, entity_type, external_key) do nothing;
    end if;
  end loop;

  update app.import_batches set status = 'committed', reviewed_by = auth.uid(), reviewed_at = now()
  where id = p_batch;
  return posted;
end $$;

-- ---------------------------------------------------------------------------
-- Original files: private bucket, path "<country>/<batch id>/<file name>"
-- (skipped on the local test database, which has no storage schema)
-- ---------------------------------------------------------------------------

do $$
begin
  if exists (select 1 from pg_namespace where nspname = 'storage') then
    insert into storage.buckets (id, name, public) values ('imports', 'imports', false)
    on conflict (id) do nothing;
    create policy imports_read on storage.objects for select to authenticated
      using (bucket_id = 'imports' and app.mfa_verified()
             and app.can_read_country(split_part(name, '/', 1)::char(2)));
    create policy imports_write on storage.objects for insert to authenticated
      with check (bucket_id = 'imports' and app.mfa_verified()
                  and app.can_edit_country(split_part(name, '/', 1)::char(2)));
  end if;
end $$;
