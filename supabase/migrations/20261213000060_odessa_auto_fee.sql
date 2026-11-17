-- Odessa's STF management fee is added automatically, at a rate set per month (SPEC decision 158).
-- Settings → "דמי ניהול באודסה": a rate from a month on (it holds until the next one). Whenever a
-- rent of an Odessa apartment is posted, from any source (Yarach's monthly charge, a hand entry,
-- an import), a second transaction is posted with it: the management fee, that month's rate of
-- the rent, off the same accounts and apartment. Its office credit follows (decision 146). If the
-- rent is voided, its fee is voided too. Company-owned apartments pay it as well: from one pocket
-- to the other. Yarach's monthly draft no longer carries fee rows of its own.

create table app.fee_rates (
  city_en   text not null,
  month     date not null check (month = date_trunc('month', month)::date),
  pct       numeric(5,2) not null check (pct >= 0 and pct <= 100),
  notes     text,
  set_by    uuid default auth.uid(),
  set_at    timestamptz not null default now(),
  primary key (city_en, month)
);
alter table app.fee_rates enable row level security;
create policy staff_read on app.fee_rates for select to authenticated using (app.can_read_country('UA'));
create policy finance_write on app.fee_rates for all to authenticated
  using (app.is_admin() or app.can_approve_country('UA')) with check (app.is_admin() or app.can_approve_country('UA'));
create policy require_mfa on app.fee_rates as restrictive for all to authenticated
  using (app.mfa_verified() or app.my_party_id() is not null) with check (app.mfa_verified() or app.my_party_id() is not null);
grant select, insert, update, delete on app.fee_rates to authenticated;
create trigger audit after insert or update or delete on app.fee_rates for each row execute function app.audit();

insert into app.fee_rates (city_en, month, pct, notes) values ('Odessa', '2026-11-01', 10, 'כמו עד עכשיו בארקדיה ובפרנקל');

-- The rate of a month: the last one set from that month or before.
create function app.fee_rate(p_city text, p_month date) returns numeric
language sql stable security definer set search_path = '' as $$
  select pct from app.fee_rates where city_en = p_city and month <= date_trunc('month', p_month)::date order by month desc limit 1
$$;
grant execute on function app.fee_rate(text, date) to authenticated;

-- A fee transaction points to the rent it was taken from.
alter table app.transactions add column fee_of uuid references app.transactions;
create index on app.transactions (fee_of);
grant select (fee_of) on app.transactions to authenticated;

create function app.auto_office_fee() returns trigger
language plpgsql security definer set search_path = '' as $$
declare
  pct numeric;
  r record;
  fee uuid;
begin
  if new.status = 'void' and old.status = 'posted' then
    update app.transactions set status = 'void', voided_by = new.voided_by, voided_at = coalesce(new.voided_at, now()),
      void_reason = coalesce(new.void_reason, 'בוטלה השכירות שממנה נלקחו דמי הניהול')
    where fee_of = new.id and status = 'posted';
    return null;
  end if;
  if not (new.status = 'posted' and old.status = 'draft' and new.category = 'rent') then return null; end if;
  pct := app.fee_rate('Odessa', new.period);
  if coalesce(pct, 0) <= 0 then return null; end if;
  for r in
    select e.account_id, e.property_id, e.currency, sum(e.amount) as amount
    from app.entries e
    join app.properties p on p.id = e.property_id
    join app.buildings b on b.id = p.building_id
    join app.cities c on c.id = b.city_id and c.name_en = 'Odessa'
    where e.transaction_id = new.id and e.account_id is not null
    group by 1, 2, 3
    having sum(e.amount) > 0
  loop
    if fee is null then
      insert into app.transactions (country_code, occurred_on, period, category, description, status, fee_of, created_by, source)
      values (new.country_code, new.occurred_on, new.period, 'mgmt_fee', format('דמי ניהול STF %s%%', trim_scale(pct)), 'draft', new.id, new.created_by, 'manual')
      returning id into fee;
    end if;
    insert into app.entries (transaction_id, account_id, property_id, amount, currency, memo)
    values (fee, r.account_id, r.property_id, -round(r.amount * pct / 100, 2), r.currency, format('%s%% משכירות %s', trim_scale(pct), to_char(new.period, 'MM.YYYY')));
  end loop;
  if fee is not null then
    update app.transactions set status = 'posted' where id = fee;   -- adds the office's credit (app.office_fee_credit)
  end if;
  return null;
end $$;
create trigger auto_office_fee after update of status on app.transactions
  for each row execute function app.auto_office_fee();

-- Yarach's monthly charge without fee rows (the fee comes with the rent).
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

    -- The STF fee is no longer a row here: posting the rent adds it (decision 158).
  end loop;

  if n = 0 then
    warnings := warnings || to_jsonb('אין דירות של ירח עם שכירות צפויה לחודש הזה'::text);
  end if;
  update app.import_batches set notes = jsonb_build_object(
    'period', p_period, 'file_name', 'זקיפה חודשית', 'warnings', warnings,
    'checks', jsonb_build_array(
      format('%s דירות, שכירות %s ₴. דמי ניהול STF (%s%% לחודש הזה) נוספים לבד באישור', n, to_char(gross, 'FM999,999,990.00'), trim_scale(coalesce(app.fee_rate('Odessa', p_period), 0))),
      'השכירות נזקפת ללקוחות כיתרה אצל גרשון, וירח חייב אותה לגרשון. דירה שלא שילמה החודש: מסמנים "לא לרשום"'),
    'accrual', jsonb_build_object('rate', rate, 'rate_date', rate_on))::text
  where id = b;
  return b;
end $$;
