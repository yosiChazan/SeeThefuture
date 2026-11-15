-- One-time (SPEC decision 146): Odessa's management fees posted before migration 57 get the
-- office's credit too. Each is voided and posted again (same date, period, category,
-- description, source and author, same entries); posting it adds the credit (the trigger
-- app.office_fee_credit). Undo: void the new ones and set the old ones back to posted.
do $$
declare t record; n uuid; k int := 0;
begin
  if app.office_party() is null or app.gershon_party() is null then raise exception 'no office or Gershon party'; end if;
  for t in
    select distinct tr.* from app.transactions tr
    join app.entries en on en.transaction_id = tr.id
    join app.accounts a on a.id = en.account_id and a.kind = 'manager_cash' and a.holder_party_id = app.gershon_party()
    join app.properties p on p.id = en.property_id join app.buildings b on b.id = p.building_id join app.cities c on c.id = b.city_id
    where tr.category = 'mgmt_fee' and tr.status = 'posted' and c.name_en = 'Odessa' and en.amount <> 0
      and not exists (select 1 from app.entries x join app.accounts y on y.id = x.account_id where x.transaction_id = tr.id and y.beneficiary_party_id = app.office_party())
  loop
    insert into app.transactions (country_code, occurred_on, period, category, description, status, import_batch_id, created_by, source)
    values (t.country_code, t.occurred_on, t.period, t.category, t.description, 'draft', t.import_batch_id, t.created_by, t.source)
    returning id into n;
    insert into app.entries (transaction_id, account_id, external_party_id, property_id, amount, currency, fx_rate, memo)
    select n, account_id, external_party_id, property_id, amount, currency, fx_rate, memo from app.entries where transaction_id = t.id;
    update app.transactions set status = 'posted' where id = n;
    update app.transactions set status = 'void' where id = t.id;
    update app.import_rows set transaction_id = n where transaction_id = t.id;
    k := k + 1;
  end loop;
  raise notice 'reposted %', k;
end $$;
select a.currency, sum(e.amount) as office_credit, count(*) from app.entries e join app.accounts a on a.id = e.account_id
join app.transactions t on t.id = e.transaction_id and t.status = 'posted'
where a.beneficiary_party_id = app.office_party() and a.kind = 'manager_cash' group by 1;
