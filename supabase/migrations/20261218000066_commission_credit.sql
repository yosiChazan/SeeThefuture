-- Commissions are the office's money (SPEC decision 178). Like the office's fee (decisions 146,
-- 167): when a commission is posted, for every line taken off a client's money, the same
-- transaction credits the office with the same amount, in the same currency, on the same
-- apartment, at the same place (the same kind of account with the same holder: a commission off
-- a client's hryvnia at Gershon becomes the office's hryvnia at Gershon).

create or replace function app.office_fee_credit() returns trigger
language plpgsql security definer set search_path = '' as $$
declare office uuid := app.office_party(); r record;
begin
  if new.category not in ('office_fee', 'commission') or new.status <> 'posted' or old.status <> 'draft' or office is null then return new; end if;
  if exists (select 1 from app.entries e join app.accounts a on a.id = e.account_id
             where e.transaction_id = new.id and a.beneficiary_party_id = office) then return new; end if;
  for r in
    select a.kind, a.holder_party_id, e.currency, e.property_id, a.country_code, sum(e.amount) as amount
    from app.entries e join app.accounts a on a.id = e.account_id and a.beneficiary_party_id <> office
    where e.transaction_id = new.id
      and (new.category = 'commission' or a.kind = 'manager_cash')
    group by 1, 2, 3, 4, 5
  loop
    if r.amount <> 0 then
      insert into app.entries (transaction_id, account_id, property_id, amount, currency, memo)
      values (new.id, app.account_for(r.kind, r.holder_party_id, office, r.currency, r.country_code), r.property_id, -r.amount, r.currency,
              case new.category when 'commission' then 'עמלה: זכות למשרד' else 'דמי ניהול משרד: זכות למשרד' end);
    end if;
  end loop;
  return new;
end $$;
