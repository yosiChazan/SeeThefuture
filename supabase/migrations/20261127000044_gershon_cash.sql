-- Gershon's cash (SPEC decision 121): the rent the office records as held by Gershon is his
-- cash ("מזומן אצל גרשון"), not a separate rent pool. A box's holder's own cash is therefore
-- money held in the box, like a linked manager's: a client can be paid from it.
create or replace function app.cash_pay_client(p_box uuid, p_from_account uuid, p_amount numeric, p_on date, p_notes text, p_parent uuid default null)
returns uuid language plpgsql set search_path = '' as $$
declare
  b app.cash_boxes;
  a app.accounts;
  prop uuid;
  props int;
  t uuid;
  m uuid;
begin
  if not app.can_write_box(p_box) then raise exception 'not allowed to write to this box' using errcode = '42501'; end if;
  if p_amount is null or p_amount <= 0 then raise exception 'the amount must be positive'; end if;
  select * into b from app.cash_boxes where id = p_box;
  if p_parent is not null and not exists (select 1 from app.cash_movements where id = p_parent and box_id = p_box and kind = 'to_office') then
    raise exception 'the part must belong to a sum sent to the office from this box';
  end if;
  select * into a from app.accounts where id = p_from_account;
  if a.id is null or not ((a.kind = 'manager_cash' and (a.holder_party_id = any (b.linked_manager_ids) or a.holder_party_id = b.holder_party_id))
                          or (a.kind = 'rent_pool' and a.holder_party_id = b.holder_party_id)) then
    raise exception 'this account is not held in this box';
  end if;
  select count(distinct property_id), min(property_id::text)::uuid into props, prop from app.entries where account_id = a.id and property_id is not null;
  insert into app.transactions (country_code, occurred_on, period, category, description, status)
  values (a.country_code, p_on, date_trunc('month', p_on)::date, 'transfer', 'העברה ללקוח מ' || b.name || coalesce(': ' || p_notes, ''), 'draft')
  returning id into t;
  insert into app.entries (transaction_id, account_id, property_id, amount, currency, memo) values
    (t, a.id, case when props = 1 then prop end, -p_amount, a.currency, p_notes),
    (t, app.account_for('client_bank', a.beneficiary_party_id, a.beneficiary_party_id, a.currency, a.country_code),
       case when props = 1 then prop end, p_amount, a.currency, p_notes);
  update app.transactions set status = 'posted' where id = t;
  insert into app.cash_movements (box_id, occurred_on, amount, currency, kind, party_id, notes, transaction_id, parent_id)
  values (p_box, p_on, -p_amount, a.currency, 'to_client', a.beneficiary_party_id, p_notes, t, p_parent)
  returning id into m;
  return m;
end $$;
