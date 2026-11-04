-- A fund one property draws from although it belongs to someone else (SPEC decision 91).
-- Gershon pays the expenses of 3(44) (Heshin) from the same dollar fund as 4(30) and
-- 4(33) (Tfilinsky); the office keeps that fund with Tfilinsky. Without a row here an
-- entry belongs to the property's owners by their shares, as before.
create table app.fund_owners (
  property_id   uuid not null references app.properties on delete cascade,
  account_kind  app.account_kind not null,
  party_id      uuid not null references app.parties,
  notes         text,
  created_at    timestamptz not null default now(),
  created_by    uuid default auth.uid(),
  primary key (property_id, account_kind)
);
alter table app.fund_owners enable row level security;
create policy staff_read on app.fund_owners for select to authenticated using (app.can_read_country(app.property_country(property_id)));
create policy staff_write on app.fund_owners for all to authenticated
  using (app.can_approve_country(app.property_country(property_id))) with check (app.can_approve_country(app.property_country(property_id)));
create policy require_mfa on app.fund_owners as restrictive for all to authenticated
  using (app.mfa_verified() or app.my_party_id() is not null) with check (app.mfa_verified() or app.my_party_id() is not null);
grant select, insert, update, delete on app.fund_owners to authenticated;
create trigger audit after insert or update or delete on app.fund_owners for each row execute function app.audit();

-- The same function, one more rule: an account entry of a property with a fund owner for
-- that kind of account goes whole to the fund owner's account.
create or replace function app.post_import_entry(p_txn uuid, p_property uuid, p_source_holder uuid,
                                                 p_country char(2), p_on date, e jsonb) returns void
language plpgsql set search_path = '' as $$
declare
  amount   numeric := (e ->> 'amount')::numeric;
  cur      app.currency := (e ->> 'currency')::app.currency;
  rate     numeric := (e ->> 'fx_rate')::numeric;
  memo     text := e ->> 'memo';
  who      text;
  holder   uuid;
  fund     uuid;
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
  who := e -> 'account' ->> 'holder';

  select f.party_id into fund from app.fund_owners f
  where f.property_id = p_property and f.account_kind = (e -> 'account' ->> 'kind')::app.account_kind;
  if fund is not null then
    holder := case who when 'source' then p_source_holder when 'beneficiary' then fund else who::uuid end;
    if holder is null then raise exception 'source has no holder party'; end if;
    insert into app.entries (transaction_id, account_id, property_id, amount, currency, fx_rate, memo)
    values (p_txn, app.account_for((e -> 'account' ->> 'kind')::app.account_kind, holder, fund, cur, p_country),
            p_property, amount, cur, rate, memo);
    return;
  end if;

  select count(*) into owners from app.ownerships
  where property_id = p_property and valid_from <= p_on and (valid_to is null or valid_to >= p_on);
  if owners = 0 then raise exception 'property % has no owner on %', p_property, p_on; end if;

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

-- The one known case: Heshin's 3(44) draws from Tfilinsky's dollar fund at Gershon.
insert into app.fund_owners (property_id, account_kind, party_id, notes)
select p.id, 'expense_pool', t.id, 'הקופה הדולרית אצל גרשון משותפת ל-3(44), 4(30) ו-4(33), ונשמרת אצל תפילינסקי (החלטה 91)'
from app.properties p join app.buildings b on b.id = p.building_id, app.parties t
where p.country_code = 'UA' and b.name = '3' and p.unit_no = '44' and t.legal_name = 'Tfilinsky David'
on conflict do nothing;
