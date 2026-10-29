-- Intake, second step (SPEC decisions 43-45):
--  * a row with errors (raw.errors) is posted only after a person marks it checked
--    (raw.checked); the app shows the same rule, the database enforces it;
--  * Itai's per-client file is the Romanian source, with Itai holding the balance of
--    expenses he paid for the owner.

do $$
begin
  insert into app.parties (id, kind, display_name)
  values ('a0000000-0000-4000-8000-000000000005', 'person', 'איתי')
  on conflict (id) do nothing;
  insert into app.party_roles (party_id, role)
  values ('a0000000-0000-4000-8000-000000000005', 'manager')
  on conflict do nothing;
  update app.import_sources
  set name = 'איתי · קובץ לקוח (properties table)', adapter = 'itai_client_xlsx',
      holder_party_id = 'a0000000-0000-4000-8000-000000000005'
  where adapter = 'itai_incomes_xlsx';
end $$;

create or replace function app.commit_import_batch(p_batch uuid) returns int
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
  if exists (
    select 1 from app.import_rows
    where batch_id = p_batch and match_status = 'matched'
      and jsonb_array_length(coalesce(raw -> 'errors', '[]')) > 0
      and not coalesce((raw ->> 'checked')::boolean, false)
  ) then
    raise exception 'the batch has rows with errors nobody has checked';
  end if;

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
