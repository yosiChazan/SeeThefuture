-- A clearer note on the office's credit line (SPEC decision 179): "עמלה מ-<client>: <the note of
-- the line taken off the client>" (and the same for the office's fee: "דמי ניהול משרד מ-<client>: ..."),
-- so the office's ledger says whose money it came from and what for.

create or replace function app.office_fee_credit() returns trigger
language plpgsql security definer set search_path = '' as $$
declare office uuid := app.office_party(); r record;
begin
  if new.category not in ('office_fee', 'commission') or new.status <> 'posted' or old.status <> 'draft' or office is null then return new; end if;
  if exists (select 1 from app.entries e join app.accounts a on a.id = e.account_id
             where e.transaction_id = new.id and a.beneficiary_party_id = office) then return new; end if;
  for r in
    select a.kind, a.holder_party_id, e.currency, e.property_id, a.country_code, sum(e.amount) as amount,
           string_agg(distinct x.display_name, ', ') as clients,
           string_agg(distinct nullif(trim(coalesce(e.memo, new.description)), ''), ' · ') as notes
    from app.entries e join app.accounts a on a.id = e.account_id and a.beneficiary_party_id <> office
    join app.parties x on x.id = a.beneficiary_party_id
    where e.transaction_id = new.id
      and (new.category = 'commission' or a.kind = 'manager_cash')
    group by 1, 2, 3, 4, 5
  loop
    if r.amount <> 0 then
      insert into app.entries (transaction_id, account_id, property_id, amount, currency, memo)
      values (new.id, app.account_for(r.kind, r.holder_party_id, office, r.currency, r.country_code), r.property_id, -r.amount, r.currency,
              case new.category when 'commission' then 'עמלה מ-' else 'דמי ניהול משרד מ-' end || r.clients || coalesce(': ' || r.notes, ''));
    end if;
  end loop;
  return new;
end $$;
