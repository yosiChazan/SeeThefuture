-- Decision 146: Odessa's posted management fees (UAH, taken off the client's money at Gershon)
-- become the client's debt to the office. Each is voided and posted again, the same date,
-- period, category, description, source and author, on the client's office_due account.
-- Undo: void the new ones (description unchanged, created now) and set the old ones back to posted.
do $$
declare
  t record; n uuid; e record; office uuid := app.office_party(); k int := 0;
begin
  if office is null then raise exception 'no office party'; end if;
  for t in
    select distinct tr.* from app.transactions tr
    join app.entries en on en.transaction_id = tr.id
    join app.accounts a on a.id = en.account_id and a.kind = 'manager_cash' and a.currency = 'UAH'
    join app.properties p on p.id = en.property_id join app.buildings b on b.id = p.building_id join app.cities c on c.id = b.city_id
    where tr.category = 'mgmt_fee' and tr.status = 'posted' and c.name_en = 'Odessa' and en.amount <> 0
  loop
    if exists (select 1 from app.entries x join app.accounts y on y.id = x.account_id where x.transaction_id = t.id and not (y.kind = 'manager_cash' and y.currency = 'UAH')) then
      raise notice 'skipped mixed %', t.id; continue;
    end if;
    insert into app.transactions (country_code, occurred_on, period, category, description, status, import_batch_id, created_by, source)
    values (t.country_code, t.occurred_on, t.period, t.category, t.description, 'draft', t.import_batch_id, t.created_by, t.source)
    returning id into n;
    for e in select en.*, a.beneficiary_party_id, a.country_code as cc from app.entries en join app.accounts a on a.id = en.account_id where en.transaction_id = t.id loop
      insert into app.entries (transaction_id, account_id, property_id, amount, currency, fx_rate, memo)
      values (n, app.account_for('office_due', office, e.beneficiary_party_id, 'UAH', e.cc), e.property_id, e.amount, 'UAH', e.fx_rate, e.memo);
    end loop;
    update app.transactions set status = 'posted' where id = n;
    update app.transactions set status = 'void' where id = t.id;
    update app.import_rows set transaction_id = n where transaction_id = t.id;
    k := k + 1;
  end loop;
  raise notice 'converted %', k;
end $$;
select a.kind, count(*) n, sum(e.amount) from app.entries e join app.accounts a on a.id = e.account_id join app.transactions t on t.id = e.transaction_id and t.status = 'posted'
where t.category = 'mgmt_fee' and a.kind in ('office_due', 'manager_cash') and t.country_code = 'UA' group by 1;
