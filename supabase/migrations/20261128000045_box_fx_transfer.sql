-- A sum Gershon sent to us in dollars or euros, at a rate (SPEC decision 123): each client's
-- part is converted out of the client's hryvnia in the box and paid to the client, the same
-- rows the office recorded from Gershon's Excel: an FX transaction
-- (hryvnia out, the sum's currency in, at the rate) and a transfer to the client's bank.
alter table app.cash_movements
  add column fx_rate numeric(18,8) check (fx_rate > 0),            -- on a sum: hryvnia per unit
  add column fx_transaction_id uuid references app.transactions;    -- on a part: its conversion

-- p_from: the client's hryvnia in the box (a linked manager's cash or the holder's).
-- p_uah: the hryvnia converted; by default the part times the rate. What is converted beyond
-- (or short of) the part stays in the client's cash in that currency, as in the Excel.
create function app.cash_pay_client_fx(p_box uuid, p_from uuid, p_amount numeric, p_uah numeric, p_on date, p_notes text, p_parent uuid)
returns uuid language plpgsql set search_path = '' as $$
declare
  b app.cash_boxes;
  s app.cash_movements;
  a app.accounts;
  target uuid;
  prop uuid;
  props int;
  uah numeric;
  t uuid;
  m uuid;
begin
  if not app.can_write_box(p_box) then raise exception 'not allowed to write to this box' using errcode = '42501'; end if;
  if p_amount is null or p_amount <= 0 then raise exception 'the amount must be positive'; end if;
  select * into b from app.cash_boxes where id = p_box;
  select * into s from app.cash_movements where id = p_parent and box_id = p_box and kind = 'to_office';
  if s.id is null then raise exception 'the part must belong to a sum sent to the office from this box'; end if;
  if s.fx_rate is null then raise exception 'the sum has no rate'; end if;
  select * into a from app.accounts where id = p_from;
  if a.id is null or a.kind <> 'manager_cash' or a.currency <> 'UAH'
     or not (a.holder_party_id = any (b.linked_manager_ids) or a.holder_party_id = b.holder_party_id) then
    raise exception 'this is not a client''s hryvnia held in this box';
  end if;
  uah := round(coalesce(p_uah, p_amount * s.fx_rate), 2);
  if uah < 0 then raise exception 'the hryvnia converted must not be negative'; end if;
  target := app.account_for('manager_cash', a.holder_party_id, a.beneficiary_party_id, s.currency, a.country_code);
  if uah > 0 then
    select count(distinct property_id), min(property_id::text)::uuid into props, prop from app.entries where account_id = a.id and property_id is not null;
    insert into app.transactions (country_code, occurred_on, period, category, description, status)
    values (a.country_code, p_on, date_trunc('month', p_on)::date, 'fx',
            'המרה בשער ' || trim(to_char(s.fx_rate, 'FM999999990.0000')) || ' להעברה מ' || b.name || coalesce(': ' || p_notes, ''), 'draft')
    returning id into t;
    insert into app.entries (transaction_id, account_id, property_id, amount, currency, fx_rate, memo) values
      (t, a.id, case when props = 1 then prop end, -uah, 'UAH', null, p_notes),
      (t, target, case when props = 1 then prop end, round(uah / s.fx_rate, 2), s.currency, s.fx_rate, p_notes);
    update app.transactions set status = 'posted' where id = t;
  end if;
  m := app.cash_pay_client(p_box, target, p_amount, p_on, p_notes, p_parent);
  update app.cash_movements set fx_transaction_id = t where id = m;
  return m;
end $$;

-- Removing a movement voids its conversions too.
create or replace function app.cash_remove_movement(p_movement uuid) returns void
language plpgsql set search_path = '' as $$
declare ts uuid[];
begin
  select array_agg(x) filter (where x is not null) into ts
  from app.cash_movements, unnest(array[transaction_id, fx_transaction_id]) x
  where id = p_movement or parent_id = p_movement;
  delete from app.cash_movements where id = p_movement;
  if not found then raise exception 'no such movement, or not allowed' using errcode = '42501'; end if;
  if ts is not null then
    update app.transactions set status = 'void' where id = any (ts) and status = 'posted';
    delete from app.transactions where id = any (ts) and status = 'draft';
  end if;
end $$;

-- Editing a converted part: paid again at the sum's rate. The hryvnia converted stays when
-- the amount is unchanged, else it is the new amount times the rate.
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
