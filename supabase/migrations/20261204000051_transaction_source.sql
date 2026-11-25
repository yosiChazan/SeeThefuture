-- Where each transaction came from (SPEC decision 136), as documents and purchase payments
-- already keep: 'report:<batch>' (a report taken in at intake), 'airtable:<base>/<table>/<record>'
-- (a row imported from Airtable), 'excel:<file>' (a spreadsheet the office sent), 'manual' (entered
-- by hand; who and when are on the transaction). New rows get it on their own; older ones are
-- filled in by a script from the plans of each import. Once set it does not change, and filling
-- it in on a posted transaction changes nothing else.
alter table app.transactions add column source text;
create index on app.transactions (source);

create or replace function app.transactions_guard() returns trigger
language plpgsql set search_path = '' as $$
begin
  -- Filling in where a posted transaction came from, once, changes nothing else (decision 136).
  if tg_op = 'UPDATE' and old.source is null and new.source is not null
     and (new.status, new.occurred_on, new.period, new.category, new.country_code, new.description, new.import_batch_id, new.created_by)
         is not distinct from (old.status, old.occurred_on, old.period, old.category, old.country_code, old.description, old.import_batch_id, old.created_by) then
    return new;
  end if;
  if tg_op = 'UPDATE' and old.source is not null and new.source is distinct from old.source then
    raise exception 'where a transaction came from does not change';
  end if;
  if tg_op = 'UPDATE' and old.status = 'posted' then
    if new.status = 'void' and auth.uid() is not null
       and not app.can_approve_country(new.country_code) then
      raise exception 'only finance can void a posted transaction';
    end if;
    if new.status <> 'void'
       or (new.occurred_on, new.period, new.category, new.country_code)
          is distinct from (old.occurred_on, old.period, old.category, old.country_code) then
      raise exception 'posted transactions cannot be changed, only voided';
    end if;
  end if;

  if new.status = 'posted' and (tg_op = 'INSERT' or old.status <> 'posted') then
    if auth.uid() is not null and not app.can_approve_country(new.country_code) then
      raise exception 'only finance can post transactions';
    end if;
    new.approved_by := auth.uid();
    new.approved_at := now();
  end if;

  if tg_op = 'INSERT' then
    new.created_by := coalesce(new.created_by, auth.uid());
    new.source := coalesce(new.source, case when new.import_batch_id is not null then 'report:' || new.import_batch_id else 'manual' end);
  end if;
  return new;
end $$;

update app.transactions set source = 'report:' || import_batch_id where import_batch_id is not null and source is null;
