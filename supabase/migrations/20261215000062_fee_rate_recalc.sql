-- Changing an Odessa fee rate changes the fees already taken at it (SPEC decision 162). In
-- Settings a new rate, a changed one or a removed one first shows what it does: every rent of the
-- months it governs (from its month to the next rate), with the fee it has and the fee it will
-- have; only on approval are the old fees voided and the new ones posted. A month whose fee was
-- entered by hand (not taken automatically) is left alone and shown as such.

-- The fee of one rent at its month's rate (the body of app.auto_office_fee, on its own).
create function app.create_office_fee(p_rent uuid) returns uuid
language plpgsql security definer set search_path = '' as $$
declare
  t app.transactions;
  pct numeric;
  r record;
  fee uuid;
begin
  select * into t from app.transactions where id = p_rent;
  if t.id is null or t.status <> 'posted' or t.category <> 'rent' then return null; end if;
  pct := app.fee_rate('Odessa', t.period);
  if coalesce(pct, 0) <= 0 then return null; end if;
  for r in
    select e.account_id, e.property_id, e.currency, sum(e.amount) as amount
    from app.entries e
    join app.properties p on p.id = e.property_id
    join app.buildings b on b.id = p.building_id
    join app.cities c on c.id = b.city_id and c.name_en = 'Odessa'
    where e.transaction_id = t.id and e.account_id is not null
    group by 1, 2, 3
    having sum(e.amount) > 0
  loop
    if fee is null then
      insert into app.transactions (country_code, occurred_on, period, category, description, status, fee_of, created_by, source)
      values (t.country_code, t.occurred_on, t.period, 'mgmt_fee', format('דמי ניהול STF %s%%', trim_scale(pct)), 'draft', t.id, t.created_by, 'manual')
      returning id into fee;
    end if;
    insert into app.entries (transaction_id, account_id, property_id, amount, currency, memo)
    values (fee, r.account_id, r.property_id, -round(r.amount * pct / 100, 2), r.currency, format('%s%% משכירות %s', trim_scale(pct), to_char(t.period, 'MM.YYYY')));
  end loop;
  if fee is not null then update app.transactions set status = 'posted' where id = fee; end if;
  return fee;
end $$;

create or replace function app.auto_office_fee() returns trigger
language plpgsql security definer set search_path = '' as $$
begin
  if new.status = 'void' and old.status = 'posted' then
    update app.transactions set status = 'void', voided_by = new.voided_by, voided_at = coalesce(new.voided_at, now()),
      void_reason = coalesce(new.void_reason, 'בוטלה השכירות שממנה נלקחו דמי הניהול')
    where fee_of = new.id and status = 'posted';
    return null;
  end if;
  if new.status = 'posted' and old.status = 'draft' and new.category = 'rent' then
    perform app.create_office_fee(new.id);
  end if;
  return null;
end $$;

-- The months a rate set at p_month governs: from it to the next rate's month (or on).
create function app.fee_rate_until(p_city text, p_month date) returns date
language sql stable security definer set search_path = '' as $$
  select min(month) from app.fee_rates where city_en = p_city and month > p_month
$$;

-- What setting (p_pct) or removing (p_pct null) the rate of p_month would do to each rent.
create function app.fee_rate_preview(p_city text, p_month date, p_pct numeric)
returns table (rent_id uuid, period date, property text, owner text, rent numeric, currency text, fee_now numeric, fee_new numeric, manual boolean)
language plpgsql stable security definer set search_path = '' as $$
declare
  m date := date_trunc('month', p_month)::date;
  upto date := app.fee_rate_until(p_city, m);
  before numeric := (select pct from app.fee_rates where city_en = p_city and month < m order by month desc limit 1);
  pct numeric := coalesce(p_pct, before, 0);
begin
  if not (app.is_admin() or app.can_approve_country('UA')) then raise exception 'only finance changes the fee rates' using errcode = '42501'; end if;
  return query
  with rents as (
    select t.id, t.period, e.property_id, e.currency::text as currency, sum(e.amount) as amount,
           sum(round(e.amount * pct / 100, 2)) as fee_new
    from app.transactions t
    join app.entries e on e.transaction_id = t.id and e.account_id is not null and e.amount > 0
    join app.properties p on p.id = e.property_id
    join app.buildings b on b.id = p.building_id
    join app.cities c on c.id = b.city_id and c.name_en = p_city
    where t.category = 'rent' and t.status = 'posted' and t.period >= m and (upto is null or t.period < upto)
    group by 1, 2, 3, 4
  )
  select r.id, r.period, trim(coalesce(b.name, '') || ' ' || coalesce(p.unit_no, '')),
         (select string_agg(x.display_name, ', ') from app.ownerships o join app.parties x on x.id = o.party_id
          where o.property_id = r.property_id and o.valid_from <= r.period and (o.valid_to is null or o.valid_to >= r.period)),
         r.amount, r.currency,
         coalesce((select -sum(fe.amount) from app.transactions f join app.entries fe on fe.transaction_id = f.id
                   join app.accounts fa on fa.id = fe.account_id and fa.beneficiary_party_id <> app.office_party()
                   where f.fee_of = r.id and f.status = 'posted' and fe.property_id = r.property_id), 0),
         r.fee_new,
         exists (select 1 from app.transactions f join app.entries fe on fe.transaction_id = f.id
                 where f.category = 'mgmt_fee' and f.status = 'posted' and f.fee_of is null and f.period = r.period and fe.property_id = r.property_id)
  from rents r join app.properties p on p.id = r.property_id left join app.buildings b on b.id = p.building_id
  order by r.period, 3;
end $$;
grant execute on function app.fee_rate_preview(text, date, numeric) to authenticated;

-- Sets (or removes) the rate, and redoes the automatic fees of the rents it governs.
create function app.fee_rate_apply(p_city text, p_month date, p_pct numeric, p_notes text) returns int
language plpgsql security definer set search_path = '' as $$
declare
  m date := date_trunc('month', p_month)::date;
  r record;
  n int := 0;
begin
  if not (app.is_admin() or app.can_approve_country('UA')) then raise exception 'only finance changes the fee rates' using errcode = '42501'; end if;
  -- The rents to redo, collected before the rate changes.
  create temp table if not exists _fee_redo (rent_id uuid) on commit drop;
  delete from _fee_redo;
  insert into _fee_redo select distinct rent_id from app.fee_rate_preview(p_city, m, p_pct) where not manual and fee_now is distinct from fee_new;
  if p_pct is null then
    delete from app.fee_rates where city_en = p_city and month = m;
  else
    insert into app.fee_rates (city_en, month, pct, notes) values (p_city, m, p_pct, nullif(trim(p_notes), ''))
    on conflict (city_en, month) do update set pct = excluded.pct, notes = excluded.notes, set_by = auth.uid(), set_at = now();
  end if;
  for r in select rent_id from _fee_redo loop
    update app.transactions set status = 'void', voided_by = auth.uid(), voided_at = now(), void_reason = 'שינוי אחוז דמי הניהול בהגדרות'
    where fee_of = r.rent_id and status = 'posted';
    perform app.create_office_fee(r.rent_id);
    n := n + 1;
  end loop;
  return n;
end $$;
grant execute on function app.fee_rate_apply(text, date, numeric, text) to authenticated;
