-- Odessa's management fee is the office's (STF), and a debt to the office's box (SPEC
-- decision 146). Until now the fee was taken off the client's money at Gershon. From now the
-- client's rent stays whole at Gershon, and the fee is the client's debt to the office:
-- an account of kind office_due, held by See the Future, one per client (negative = owes).
-- The debt is paid when Gershon sends us money and the sum is divided: a part "to the office
-- (fees)" names the client, and moves that much of the client's hryvnia at Gershon into the
-- debt (app.cash_office_fee). The fees posted before (Odessa, to October 2026) are re-posted
-- the same way by a one-time data script, run after this migration.
alter type app.account_kind add value if not exists 'office_due';

-- The office's box is held by See the Future.
update app.cash_boxes set holder_party_id = (select id from app.parties where display_name = 'SEE THE FUTURE LTD' order by created_at limit 1)
where is_office and holder_party_id is null;

create function app.office_party() returns uuid
language sql stable security definer set search_path = '' as $$
  select holder_party_id from app.cash_boxes where is_office and holder_party_id is not null order by position limit 1
$$;
grant execute on function app.office_party() to authenticated;

-- Yarach's monthly charge: the fee is now the client's debt to the office.
create or replace function app.yarach_accrual(p_period date, p_rate numeric default null) returns uuid
language plpgsql security definer set search_path = '' as $$
declare
  src       app.import_sources;
  yarach    uuid;
  v_scope   text;
  old       app.import_batches;
  rate      numeric := p_rate;
  rate_on   date;
  rate_note text;
  b         uuid := gen_random_uuid();
  u         record;
  n         int := 0;
  amount    numeric;
  fee       numeric;
  gross     numeric := 0;
  fees      numeric := 0;
  errs      jsonb;
  month     text;
  warnings  jsonb := '[]';
begin
  if auth.uid() is not null and not app.can_approve_country('UA') then
    raise exception 'only finance can draft the month';
  end if;
  p_period := date_trunc('month', p_period)::date;
  v_scope := to_char(p_period, 'YYYY-MM');
  month := to_char(p_period, 'MM.YYYY');
  select * into src from app.import_sources where adapter = 'yarach_accrual' limit 1;
  if src.id is null then raise exception 'no source with adapter yarach_accrual'; end if;
  select holder_party_id into yarach from app.import_sources where adapter = 'manual_yarach' and holder_party_id is not null limit 1;
  if yarach is null then raise exception 'Yarach is not the holder of the manual_yarach source'; end if;

  select * into old from app.import_batches
  where source_id = src.id and import_batches.scope = v_scope and status in ('parsed', 'in_review', 'committed')
  order by received_at desc limit 1;
  if old.id is not null then
    if p_rate is null or old.status = 'committed' then return old.id; end if;
    update app.import_batches set status = 'rejected', reviewed_by = auth.uid(), reviewed_at = now() where id = old.id;
  end if;

  if rate is not null then
    if rate <= 0 then raise exception 'rate must be positive'; end if;
    insert into app.fx_rates (rate_date, base, quote, rate, source) values (p_period, 'USD', 'UAH', rate, 'manual')
    on conflict (rate_date, base, quote, source) do update set rate = excluded.rate;
    rate_on := p_period; rate_note := 'שער שהוזן ידנית';
  else
    perform app.collect_usd_rates();
    select r.rate, r.rate_date into rate, rate_on from app.fx_rates r
    where r.base = 'USD' and r.quote = 'UAH' and r.rate_date <= p_period
    order by r.rate_date desc, (r.source = 'NBU') desc limit 1;
    rate_note := 'השער הרשמי של הבנק המרכזי של אוקראינה';
    if rate is not null and rate_on <> p_period then
      warnings := warnings || to_jsonb(format('אין שער ל-%s; נלקח השער מ-%s. אפשר לעדכן שער במסך הזה', to_char(p_period, 'DD.MM.YYYY'), to_char(rate_on, 'DD.MM.YYYY')));
    end if;
  end if;

  insert into app.import_batches (id, source_id, country_code, status, scope, notes)
  values (b, src.id, 'UA', 'in_review', v_scope, '{}');

  for u in
    select p.id, trim(coalesce(bl.name, '') || ' ' || coalesce(p.unit_no, '')) as title,
           s.amount as rent, s.currency, coalesce(ma.fee_pct, 0) as fee_pct,
           (select string_agg(x.display_name, ', ') from app.ownerships o join app.parties x on x.id = o.party_id
            where o.property_id = p.id and o.valid_from <= p_period and (o.valid_to is null or o.valid_to >= p_period)) as owner
    from app.management_agreements ma
    join app.properties p on p.id = ma.property_id
    left join app.buildings bl on bl.id = p.building_id
    join app.rent_schedule s on s.property_id = p.id and s.valid_from <= p_period and (s.valid_to is null or s.valid_to >= p_period)
    where ma.manager_party_id = yarach and ma.valid_from <= p_period and (ma.valid_to is null or ma.valid_to >= p_period)
      and s.amount > 0
    order by 2
  loop
    n := n + 1;
    errs := '[]';
    if u.currency = 'UAH' then amount := u.rent;
    elsif u.currency = 'USD' and rate is not null then amount := round(u.rent * rate, 2);
    else
      amount := 0;
      errs := to_jsonb(array[format('אין שער ל-%s. מעדכנים שער במסך הזה, והחודש נבנה מחדש', u.currency)]);
    end if;
    gross := gross + amount;
    insert into app.import_rows (batch_id, row_ref, proposed, fingerprint, issues, property_id, match_status, raw)
    values (b, format('accrual:%s:1', u.id),
      jsonb_build_object('occurred_on', p_period, 'period', p_period, 'category', 'rent',
        'description', format('שכירות %s (זקיפה חודשית, ירח)', month),
        'entries', jsonb_build_array(jsonb_strip_nulls(jsonb_build_object('amount', amount, 'currency', 'UAH',
          'memo', case when u.currency = 'USD' then format('%s $ × %s', u.rent, rate) end,
          'fx_rate', case when u.currency = 'USD' then rate end,
          'account', jsonb_build_object('kind', 'manager_cash', 'holder', src.holder_party_id))))),
      format('yarach_accrual|%s|%s|rent', u.id, v_scope),
      case when u.currency = 'USD' and rate is not null then array[format('%s $ לפי שער %s (%s)', u.rent, rate, rate_note)] else '{}' end,
      u.id, 'matched',
      jsonb_build_object('row', n * 2 - 1, 'property_ref', u.title, 'kind', 'שכירות (זקיפה)', 'owner', u.owner,
        'amount', amount, 'errors', errs, 'description', format('שכירות %s', month)));

    if u.fee_pct > 0 and amount > 0 then
      fee := round(amount * u.fee_pct / 100, 2);
      fees := fees + fee;
      insert into app.import_rows (batch_id, row_ref, proposed, fingerprint, issues, property_id, match_status, raw)
      values (b, format('accrual:%s:2', u.id),
        jsonb_build_object('occurred_on', p_period, 'period', p_period, 'category', 'mgmt_fee',
          'description', format('דמי ניהול STF %s%% (%s)', u.fee_pct, month),
          'entries', jsonb_build_array(jsonb_build_object('amount', -fee, 'currency', 'UAH',
            'account', jsonb_build_object('kind', 'office_due', 'holder', app.office_party())))),
        format('yarach_accrual|%s|%s|fee', u.id, v_scope), '{}', u.id, 'matched',
        jsonb_build_object('row', n * 2, 'property_ref', u.title, 'kind', format('דמי ניהול STF %s%%', u.fee_pct), 'owner', u.owner,
          'amount', -fee, 'errors', '[]'::jsonb, 'description', 'דמי ניהול'));
    end if;
  end loop;

  if n = 0 then
    warnings := warnings || to_jsonb('אין דירות של ירח עם שכירות צפויה לחודש הזה'::text);
  end if;
  update app.import_batches set notes = jsonb_build_object(
    'period', p_period, 'file_name', 'זקיפה חודשית', 'warnings', warnings,
    'checks', jsonb_build_array(
      format('%s דירות, שכירות %s ₴, דמי ניהול %s ₴', n, to_char(gross, 'FM999,999,990.00'), to_char(fees, 'FM999,999,990.00')),
      'השכירות נזקפת ללקוחות כיתרה אצל גרשון, וירח חייב אותה לגרשון. דירה שלא שילמה החודש: מסמנים "לא לרשום"'),
    'accrual', jsonb_build_object('rate', rate, 'rate_date', rate_on))::text
  where id = b;
  return b;
end $$;

-- A part of a sum Gershon sent us that goes to the office's fees, for one client: the
-- client's hryvnia at Gershon pay that much of their debt to the office. When the sum came in
-- dollars or euros, p_uah is the hryvnia it stands for (default: the part at the sum's rate).
create function app.cash_office_fee(p_box uuid, p_from uuid, p_amount numeric, p_uah numeric, p_on date, p_notes text, p_parent uuid)
returns uuid language plpgsql set search_path = '' as $$
declare
  b app.cash_boxes;
  s app.cash_movements;
  a app.accounts;
  uah numeric;
  props int;
  prop uuid;
  t uuid;
  m uuid;
begin
  if not app.can_write_box(p_box) then raise exception 'not allowed to write to this box' using errcode = '42501'; end if;
  if p_amount is null or p_amount <= 0 then raise exception 'the amount must be positive'; end if;
  select * into b from app.cash_boxes where id = p_box;
  select * into s from app.cash_movements where id = p_parent and box_id = p_box and kind = 'to_office';
  if s.id is null then raise exception 'the part must belong to a sum sent to the office from this box'; end if;
  select * into a from app.accounts where id = p_from;
  if a.id is null or a.kind <> 'manager_cash' or a.currency <> 'UAH'
     or not (a.holder_party_id = any (b.linked_manager_ids) or a.holder_party_id = b.holder_party_id) then
    raise exception 'this is not a client''s hryvnia held in this box';
  end if;
  uah := round(case when s.currency = 'UAH' then p_amount else coalesce(p_uah, p_amount * s.fx_rate) end, 2);
  if uah is null or uah <= 0 then raise exception 'the hryvnia paid must be positive (the sum has no rate?)'; end if;
  select count(distinct property_id), min(property_id::text)::uuid into props, prop from app.entries where account_id = a.id and property_id is not null;
  insert into app.transactions (country_code, occurred_on, period, category, description, status)
  values (a.country_code, p_on, date_trunc('month', p_on)::date, 'mgmt_fee',
          'תשלום דמי ניהול STF מ' || b.name || coalesce(': ' || p_notes, ''), 'draft')
  returning id into t;
  insert into app.entries (transaction_id, account_id, property_id, amount, currency, memo) values
    (t, a.id, case when props = 1 then prop end, -uah, 'UAH', p_notes),
    (t, app.account_for('office_due', app.office_party(), a.beneficiary_party_id, 'UAH', a.country_code),
       case when props = 1 then prop end, uah, 'UAH', p_notes);
  update app.transactions set status = 'posted' where id = t;
  insert into app.cash_movements (box_id, occurred_on, amount, currency, kind, party_id, notes, transaction_id, parent_id, fx_rate)
  values (p_box, p_on, -p_amount, s.currency, 'office_fee', a.beneficiary_party_id, p_notes, t, p_parent,
          case when s.currency <> 'UAH' then round(uah / p_amount, 6) end)
  returning id into m;
  return m;
end $$;
grant execute on function app.cash_office_fee(uuid, uuid, numeric, numeric, date, text, uuid) to authenticated;

-- Editing such a part pays it again from the same client's money.
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
  -- A client's fee paid to the office (decision 146): paid again from the same money.
  if m.kind = 'office_fee' then
    select account_id, -amount into src, uah from app.entries where transaction_id = m.transaction_id and amount < 0 limit 1;
    if abs(p_amount) <> abs(m.amount) then uah := null; end if;
    perform app.cash_remove_movement(p_movement);
    return app.cash_office_fee(m.box_id, src, abs(p_amount), uah, p_on, p_notes, m.parent_id);
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
