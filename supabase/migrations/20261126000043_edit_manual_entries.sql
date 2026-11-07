-- Editing what was entered by hand (SPEC decision 119): a movement added on a property card
-- (a ledger transaction with no import batch) and a cash box movement. Only who recorded it,
-- or an admin, edits it. Posted transactions are never changed: the edit voids the old one
-- and enters the corrected one (CLAUDE.md), so the ledger's own guard applies: voiding and
-- posting are finance's (an admin's) to do, and a draft may be fixed by its author.

create function app.edit_manual_entry(p_txn uuid, p_on date, p_period date, p_category app.txn_category, p_description text,
                                      p_amount numeric, p_currency app.currency, p_kind app.account_kind, p_holder uuid)
returns uuid language plpgsql set search_path = '' as $$
declare
  t app.transactions;
  prop uuid;
  props int;
  n uuid;
begin
  select * into t from app.transactions where id = p_txn;
  if t.id is null then raise exception 'no such movement'; end if;
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

-- A cash box movement: date, amount and notes. A payment to a client is paid again with the
-- new amount from the same money (its transfer voided and re-posted); an office fee's copy
-- in the office box follows by itself.
create function app.cash_edit_movement(p_movement uuid, p_on date, p_amount numeric, p_notes text) returns uuid
language plpgsql set search_path = '' as $$
declare
  m app.cash_movements;
  src uuid;
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
  -- A payment to a client: the money it came from is the entry that went out.
  select account_id into src from app.entries where transaction_id = m.transaction_id and amount < 0 limit 1;
  perform app.cash_remove_movement(p_movement);
  n := app.cash_pay_client(m.box_id, src, abs(p_amount), p_on, p_notes, m.parent_id);
  return n;
end $$;
