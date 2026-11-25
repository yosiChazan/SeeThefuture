-- Where a transaction came from is seen only by whoever recorded it and by an admin (SPEC
-- decision 138). The column is no longer readable directly; app.transaction_sources gives the
-- source (and its file, for a spreadsheet) of the transactions the caller may see it for.
revoke select on app.transactions from authenticated;
grant select (id, country_code, occurred_on, period, category, description, status, import_batch_id,
              created_by, created_at, approved_by, approved_at) on app.transactions to authenticated;

-- The spreadsheet links follow the same rule: read through the function only.
drop policy staff_read on app.source_files;
create policy admin_read on app.source_files for select to authenticated using (app.is_admin());

create function app.transaction_sources(p_ids uuid[])
returns table (id uuid, source text, file_url text, file_path text, file_name text)
language sql stable security definer set search_path = '' as $$
  select t.id, t.source, f.url, f.storage_path, f.file_name
  from app.transactions t left join app.source_files f on f.source = t.source
  where t.id = any (p_ids) and app.mfa_verified() and app.can_read_country(t.country_code)
    and (app.is_admin() or t.created_by = auth.uid())
$$;
revoke all on function app.transaction_sources(uuid[]) from public;
grant execute on function app.transaction_sources(uuid[]) to authenticated;

-- Editing a movement by hand reads only the columns it needs (the source is no longer readable).
create or replace function app.edit_manual_entry(p_txn uuid, p_on date, p_period date, p_category app.txn_category, p_description text,
                                      p_amount numeric, p_currency app.currency, p_kind app.account_kind, p_holder uuid)
returns uuid language plpgsql set search_path = '' as $$
declare
  t record;
  prop uuid;
  props int;
  n uuid;
begin
  select id, country_code, status, import_batch_id, created_by into t from app.transactions where id = p_txn;
  if not found then raise exception 'no such movement'; end if;
  if t.import_batch_id is not null then raise exception 'a movement from a report is changed by a new version of the report'; end if;
  if exists (select 1 from app.cash_movements where transaction_id = p_txn) then raise exception 'a payment from a cash box is edited in the box'; end if;
  if not (t.created_by = auth.uid() or app.is_admin()) then
    raise exception 'only who recorded the movement, or an admin, edits it' using errcode = '42501';
  end if;
  if t.status = 'void' then raise exception 'the movement was voided'; end if;
  select count(distinct property_id), min(property_id::text)::uuid into props, prop from app.entries where transaction_id = p_txn;
  if props <> 1 then raise exception 'the movement is not of one property'; end if;

  if t.status = 'draft' then
    delete from app.entries where transaction_id = p_txn;
    update app.transactions set occurred_on = p_on, period = p_period, category = p_category, description = p_description where id = p_txn;
    n := p_txn;
  else
    update app.transactions set status = 'void' where id = p_txn;
    insert into app.transactions (country_code, occurred_on, period, category, description, status)
    values (t.country_code, p_on, p_period, p_category, p_description, 'draft') returning id into n;
  end if;
  perform app.post_import_entry(n, prop, p_holder, t.country_code, p_on, jsonb_build_object(
    'amount', p_amount, 'currency', p_currency, 'memo', p_description,
    'account', jsonb_build_object('kind', p_kind, 'holder', case when p_holder is null then 'beneficiary' else 'source' end)));
  if t.status = 'posted' then update app.transactions set status = 'posted' where id = n; end if;
  return n;
end $$;
