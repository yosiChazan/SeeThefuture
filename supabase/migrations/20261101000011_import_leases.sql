-- Leases from a report (SPEC decision 51). Itai's file lists every lease on top of the
-- Incomes sheet; approving the batch adds the new ones and updates changed terms.

create function app.apply_import_lease(p_property uuid, l jsonb) returns void
language plpgsql set search_path = '' as $$
declare
  tenant uuid;
  name   text := trim(l ->> 'tenant');
begin
  if p_property is null then raise exception 'lease row has no property'; end if;
  if l ? 'lease_id' then
    update app.leases set
      end_date       = coalesce((l ->> 'end')::date, end_date),
      rent_amount    = coalesce((l ->> 'rent')::numeric, rent_amount),
      deposit_amount = coalesce((l ->> 'deposit')::numeric, deposit_amount),
      notes          = concat_ws(E'\n', notes, nullif(l ->> 'notes', ''))
    where id = (l ->> 'lease_id')::uuid and property_id = p_property;
    if not found then raise exception 'lease % not found on this property', l ->> 'lease_id'; end if;
    return;
  end if;

  select id into tenant from app.parties where lower(display_name) = lower(name) order by created_at limit 1;
  if tenant is null and name <> '' then
    insert into app.parties (kind, display_name)
    values (case when name ~* '\m(srl|sa|pfa|ii|ltd)\M' then 'company' else 'person' end::app.party_kind, name)
    returning id into tenant;
  end if;
  if tenant is not null then
    insert into app.party_roles (party_id, role) values (tenant, 'tenant') on conflict do nothing;
  end if;
  insert into app.leases (property_id, tenant_party_id, start_date, end_date, rent_amount, rent_currency,
                          deposit_amount, deposit_currency, withholding_tax_pct, notes)
  values (p_property, tenant, (l ->> 'start')::date, (l ->> 'end')::date, (l ->> 'rent')::numeric,
          (l ->> 'currency')::app.currency, (l ->> 'deposit')::numeric,
          case when l ->> 'deposit' is not null then (l ->> 'currency')::app.currency end,
          coalesce((l ->> 'withholding')::numeric, 0), nullif(l ->> 'notes', ''));
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

  -- Leases the report states (raw.lease): updated when raw.lease.lease_id names one,
  -- otherwise added. The tenant is found by name or created.
  for r in
    select * from app.import_rows
    where batch_id = p_batch and match_status = 'matched' and proposed is null and raw ? 'lease'
  loop
    perform app.apply_import_lease(r.property_id, r.raw -> 'lease');
  end loop;

  -- Rows the new version of the file no longer has: their transactions are voided.
  for r in
    select * from app.import_rows
    where batch_id = p_batch and match_status = 'matched' and proposed is null and raw ? 'voids'
  loop
    -- Only a transaction this source posted, in this country, can be voided this way.
    update app.transactions set status = 'void' where id = (r.raw ->> 'voids')::uuid and status = 'posted'
      and country_code = b.country_code
      and import_batch_id in (select id from app.import_batches where source_id = b.source_id);
  end loop;

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

    -- A row the source changed replaces what was posted from the earlier version.
    if r.raw ? 'replaces' then
      update app.transactions set status = 'void' where id = (r.raw ->> 'replaces')::uuid and status = 'posted'
      and country_code = b.country_code
      and import_batch_id in (select id from app.import_batches where source_id = b.source_id);
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
