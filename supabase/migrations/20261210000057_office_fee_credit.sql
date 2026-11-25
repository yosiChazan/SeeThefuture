-- Odessa's management fee is the office's money (SPEC decision 146). The fee line on the
-- client stays as it is (off the client's hryvnia at Gershon); the same transaction now also
-- credits the office: + the fee to See the Future's own cash at Gershon (manager_cash held by
-- Gershon, beneficiary See the Future). So the office box shows what Gershon holds for the
-- office, and Gershon's box keeps counting that money as his.
-- When Gershon sends us a sum and the office's fees are divided from it, that part moves the
-- office's money from Gershon to the office's own account (app.cash_office_fee).

-- The office's box is held by See the Future.
update app.cash_boxes set holder_party_id = (select id from app.parties where display_name = 'SEE THE FUTURE LTD' order by created_at limit 1)
where is_office and holder_party_id is null;

create function app.office_party() returns uuid
language sql stable security definer set search_path = '' as $$
  select holder_party_id from app.cash_boxes where is_office and holder_party_id is not null order by position limit 1
$$;
grant execute on function app.office_party() to authenticated;

create function app.gershon_party() returns uuid
language sql stable security definer set search_path = '' as $$
  select holder_party_id from app.import_sources where adapter = 'gershon_utilities_xlsx' and holder_party_id is not null limit 1
$$;

-- When a transaction is posted: for every Odessa management fee taken off a client's money at
-- Gershon, the office gets the same amount, in the same currency and on the same property.
create function app.office_fee_credit() returns trigger
language plpgsql security definer set search_path = '' as $$
declare
  office uuid := app.office_party();
  gershon uuid := app.gershon_party();
  r record;
begin
  if new.category <> 'mgmt_fee' or new.status <> 'posted' or old.status <> 'draft' or office is null or gershon is null then
    return new;
  end if;
  if exists (select 1 from app.entries e join app.accounts a on a.id = e.account_id
             where e.transaction_id = new.id and a.beneficiary_party_id = office) then
    return new;   -- already credited
  end if;
  for r in
    select e.currency, e.property_id, a.country_code, sum(e.amount) as amount
    from app.entries e
    join app.accounts a on a.id = e.account_id and a.kind = 'manager_cash' and a.holder_party_id = gershon and a.beneficiary_party_id <> office
    join app.properties p on p.id = e.property_id
    join app.buildings b on b.id = p.building_id
    join app.cities c on c.id = b.city_id and c.name_en = 'Odessa'
    where e.transaction_id = new.id
    group by 1, 2, 3
  loop
    if r.amount <> 0 then
      insert into app.entries (transaction_id, account_id, property_id, amount, currency, memo)
      values (new.id, app.account_for('manager_cash', gershon, office, r.currency, r.country_code), r.property_id, -r.amount, r.currency,
              'דמי ניהול STF: זכות למשרד');
    end if;
  end loop;
  return new;
end $$;
-- Fires before transactions_guard (alphabetical), while the transaction is still a draft.
create trigger office_fee_credit before update of status on app.transactions
  for each row execute function app.office_fee_credit();

-- The office's part of a sum Gershon sent us: the office's money at Gershon goes to the
-- office's own account, as a client's part does (decisions 113, 123): with a rate, first a
-- conversion of the office's hryvnia at Gershon (p_uah, default the part at the sum's rate)
-- into the sum's currency, then the transfer to the office.
create function app.cash_office_fee(p_box uuid, p_amount numeric, p_uah numeric, p_on date, p_notes text, p_parent uuid)
returns uuid language plpgsql set search_path = '' as $$
declare
  b app.cash_boxes;
  s app.cash_movements;
  office uuid := app.office_party();
  cc char(2);
  cur app.currency;
  held uuid;
  uah numeric;
  fx uuid;
  t uuid;
  m uuid;
begin
  if not app.can_write_box(p_box) then raise exception 'not allowed to write to this box' using errcode = '42501'; end if;
  if p_amount is null or p_amount <= 0 then raise exception 'the amount must be positive'; end if;
  select * into b from app.cash_boxes where id = p_box;
  select * into s from app.cash_movements where id = p_parent and box_id = p_box and kind = 'to_office';
  if s.id is null then raise exception 'the part must belong to a sum sent to the office from this box'; end if;
  if office is null or b.holder_party_id is null then raise exception 'no office or no holder for this box'; end if;
  cc := coalesce(b.country_code, 'UA');
  cur := s.currency::app.currency;
  held := app.account_for('manager_cash', b.holder_party_id, office, cur, cc);
  if s.fx_rate is not null and cur <> 'UAH' then
    uah := round(coalesce(p_uah, p_amount * s.fx_rate), 2);
    if uah <= 0 then raise exception 'the hryvnia converted must be positive'; end if;
    insert into app.transactions (country_code, occurred_on, period, category, description, status)
    values (cc, p_on, date_trunc('month', p_on)::date, 'fx',
            'המרה בשער ' || trim(to_char(s.fx_rate, 'FM999999990.0000')) || ' של דמי ניהול STF להעברה מ' || b.name || coalesce(': ' || p_notes, ''), 'draft')
    returning id into fx;
    insert into app.entries (transaction_id, account_id, amount, currency, fx_rate, memo) values
      (fx, app.account_for('manager_cash', b.holder_party_id, office, 'UAH', cc), -uah, 'UAH', null, p_notes),
      (fx, held, round(uah / s.fx_rate, 2), cur, s.fx_rate, p_notes);
    update app.transactions set status = 'posted' where id = fx;
  end if;
  insert into app.transactions (country_code, occurred_on, period, category, description, status)
  values (cc, p_on, date_trunc('month', p_on)::date, 'transfer', 'דמי ניהול STF שהגיעו מ' || b.name || ' למשרד' || coalesce(': ' || p_notes, ''), 'draft')
  returning id into t;
  insert into app.entries (transaction_id, account_id, amount, currency, memo) values
    (t, held, -p_amount, cur, p_notes),
    (t, app.account_for('company', office, office, cur, cc), p_amount, cur, p_notes);
  update app.transactions set status = 'posted' where id = t;
  insert into app.cash_movements (box_id, occurred_on, amount, currency, kind, party_name, notes, transaction_id, fx_transaction_id, parent_id)
  values (p_box, p_on, -p_amount, s.currency, 'office_fee', 'המשרד', p_notes, t, fx, p_parent)
  returning id into m;
  return m;
end $$;
grant execute on function app.cash_office_fee(uuid, numeric, numeric, date, text, uuid) to authenticated;

-- Editing the office's part moves it again.
create or replace function app.cash_edit_movement(p_movement uuid, p_on date, p_amount numeric, p_notes text) returns uuid
language plpgsql set search_path = '' as $$
declare
  m app.cash_movements;
  src uuid;
  uah numeric;
  n uuid;
begin
  select * into m from app.cash_movements where id = p_movement;
  if m.id is null then raise exception 'no such movement, or not allowed' using errcode = '42501'; end if;
  if m.mirror_of is not null then raise exception 'this copy changes with the fee it copies'; end if;
  if not (m.created_by = auth.uid() or app.is_admin()) then
    raise exception 'only who recorded the movement, or an admin, edits it' using errcode = '42501';
  end if;
  if p_amount is null or p_amount = 0 then raise exception 'the amount must not be zero'; end if;
  if m.transaction_id is null then
    update app.cash_movements set occurred_on = p_on, amount = sign(m.amount) * abs(p_amount), notes = p_notes where id = p_movement;
    return p_movement;
  end if;
  -- The office's fees out of a sum (decision 146): moved again at the same rate.
  if m.kind = 'office_fee' then
    select -amount into uah from app.entries where transaction_id = m.fx_transaction_id and amount < 0 limit 1;
    if abs(p_amount) <> abs(m.amount) then uah := null; end if;
    perform app.cash_remove_movement(p_movement);
    return app.cash_office_fee(m.box_id, abs(p_amount), uah, p_on, p_notes, m.parent_id);
  end if;
  if m.fx_transaction_id is not null then
    select account_id, -amount into src, uah from app.entries where transaction_id = m.fx_transaction_id and amount < 0 limit 1;
    if abs(p_amount) <> abs(m.amount) then uah := null; end if;
    perform app.cash_remove_movement(p_movement);
    return app.cash_pay_client_fx(m.box_id, src, abs(p_amount), uah, p_on, p_notes, m.parent_id);
  end if;
  -- A payment to a client: the money it came from is the entry that went out.
  select account_id into src from app.entries where transaction_id = m.transaction_id and amount < 0 limit 1;
  perform app.cash_remove_movement(p_movement);
  n := app.cash_pay_client(m.box_id, src, abs(p_amount), p_on, p_notes, m.parent_id);
  return n;
end $$;
