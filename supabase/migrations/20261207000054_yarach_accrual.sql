-- Yarach's rent is charged monthly, not split from his transfers (SPEC decision 141).
--
-- On the 1st of each month the system drafts a report "ירח · זקיפה חודשית": for every
-- apartment Yarach manages that has an expected rent that month, the rent goes to the
-- owners' cash at Gershon (manager_cash, split by ownership as every report), less the
-- office's fee where the agreement has one (Arcadia and Frenkel: 10%). Finance reviews it,
-- leaves out an apartment that did not pay that month, and approves it as any report.
-- A rent in dollars (Arcadia: 350$) is converted at the National Bank of Ukraine's rate of
-- the 1st, fetched the same morning; finance can redraft the month with another rate.
--
-- Yarach's own transfers are no longer split between clients: they are money received
-- from him in Gershon's box ("התקבל ממנהל", party Yarach). What he still owes Gershon is
-- the rent charged since 1.11.2026 less what he transferred since then (app.yarach_debt).

-- The report's source: Gershon holds the money.
insert into app.import_sources (name, adapter, country_code, active, holder_party_id)
select 'ירח · זקיפה חודשית', 'yarach_accrual', 'UA', true, holder_party_id
from app.import_sources where adapter = 'gershon_utilities_xlsx' and holder_party_id is not null
  and not exists (select 1 from app.import_sources where adapter = 'yarach_accrual')
limit 1;

-- Exchange-rate requests sent to the National Bank of Ukraine, read back later (pg_net
-- answers asynchronously).
create table app.fx_requests (
  request_id  bigint primary key,
  rate_date   date not null,
  done        boolean not null default false,
  created_at  timestamptz not null default now()
);
alter table app.fx_requests enable row level security;
create policy admin_read on app.fx_requests for select to authenticated using (app.is_admin());
create policy require_mfa on app.fx_requests as restrictive for all to authenticated
  using (app.mfa_verified() or app.my_party_id() is not null) with check (app.mfa_verified() or app.my_party_id() is not null);
grant select on app.fx_requests to authenticated;

-- Asks the NBU for the dollar's rate on a date.
create function app.request_usd_rate(p_date date default current_date) returns bigint
language plpgsql security definer set search_path = '' as $$
declare id bigint;
begin
  select net.http_get(format('https://bank.gov.ua/NBUStatService/v1/statdirectory/exchange?valcode=USD&date=%s&json', to_char(p_date, 'YYYYMMDD')))
  into id;
  insert into app.fx_requests (request_id, rate_date) values (id, p_date);
  return id;
end $$;

-- Reads the answers that arrived: [{"rate": 41.5, "cc": "USD", ...}] → app.fx_rates.
create function app.collect_usd_rates() returns int
language plpgsql security definer set search_path = '' as $$
declare r record; got int := 0; v numeric;
begin
  for r in select q.request_id, q.rate_date, h.status_code, h.content
           from app.fx_requests q join net._http_response h on h.id = q.request_id where not q.done
  loop
    begin
      v := (r.content::jsonb -> 0 ->> 'rate')::numeric;
    exception when others then v := null;
    end;
    if r.status_code = 200 and v > 0 then
      insert into app.fx_rates (rate_date, base, quote, rate, source) values (r.rate_date, 'USD', 'UAH', v, 'NBU')
      on conflict (rate_date, base, quote, source) do update set rate = excluded.rate;
      got := got + 1;
    end if;
    update app.fx_requests set done = true where request_id = r.request_id;
  end loop;
  return got;
exception when undefined_table or invalid_schema_name then
  return 0;   -- no pg_net (the local test database)
end $$;

-- Drafts the month's report. Called by pg_cron on the 1st (no user), or by finance from the
-- review screen with another rate: an open draft of the month is then rejected and redrafted.
-- An approved month is never redrafted.
create function app.yarach_accrual(p_period date, p_rate numeric default null) returns uuid
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
          'description', format('דמי ניהול %s%% (%s)', u.fee_pct, month),
          'entries', jsonb_build_array(jsonb_build_object('amount', -fee, 'currency', 'UAH',
            'account', jsonb_build_object('kind', 'manager_cash', 'holder', src.holder_party_id)))),
        format('yarach_accrual|%s|%s|fee', u.id, v_scope), '{}', u.id, 'matched',
        jsonb_build_object('row', n * 2, 'property_ref', u.title, 'kind', format('דמי ניהול %s%%', u.fee_pct), 'owner', u.owner,
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
grant execute on function app.yarach_accrual(date, numeric) to authenticated;

-- What Yarach owes Gershon, by month: rent charged in approved months since the start,
-- less what he transferred (money received from him in the boxes, in hryvnia).
create function app.yarach_debt() returns table (month date, charged numeric, paid numeric)
language sql stable security definer set search_path = '' as $$
  with start as (select date '2026-11-01' as d),
  yarach as (select holder_party_id as id from app.import_sources where adapter = 'manual_yarach' limit 1),
  charged as (
    select t.period as month, sum(e.amount) as amount
    from app.transactions t
    join app.import_batches b on b.id = t.import_batch_id
    join app.import_sources s on s.id = b.source_id and s.adapter = 'yarach_accrual'
    join app.entries e on e.transaction_id = t.id
    where t.status = 'posted' and t.category = 'rent' and e.currency = 'UAH' and t.period >= (select d from start)
    group by 1
  ),
  paid as (
    select date_trunc('month', m.occurred_on)::date as month, sum(m.amount) as amount
    from app.cash_movements m
    where m.kind = 'from_manager' and m.currency = 'UAH' and m.party_id = (select id from yarach)
      and m.occurred_on >= (select d from start) and m.parent_id is null
    group by 1
  )
  select coalesce(c.month, p.month), coalesce(c.amount, 0), coalesce(p.amount, 0)
  from charged c full join paid p on p.month = c.month
  where app.can_read_country('UA')
  order by 1
$$;
grant execute on function app.yarach_debt() to authenticated;

-- On the 1st: the rate at 05:00 Israel time (03:00 UTC), the draft an hour later.
do $$
begin
  create extension if not exists pg_cron;
  perform cron.schedule('usd-rate-1st', '0 3 1 * *', 'select app.request_usd_rate(current_date)');
  perform cron.schedule('yarach-accrual-1st', '0 4 1 * *', 'select app.yarach_accrual(current_date)');
exception when others then
  raise notice 'pg_cron not available: %', sqlerrm;
end $$;
