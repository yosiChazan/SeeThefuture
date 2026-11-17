-- Odessa's fee rates, month by month, retroactive, with locked lines (SPEC decision 162).
-- A rate belongs to one month only. A month without a rate takes, when its first rent is posted,
-- a copy of the latest earlier rate (as a row of its own, so it shows in Settings).
-- Adding, changing or removing a month's rate first shows every apartment of that month: its rent,
-- its fee now (automatic, entered by hand or from Airtable) and the rate that fee is, and the fee
-- the new rate gives. A line can be locked ("קבוע"): it is not changed, now or later, until it is
-- unlocked. On approval the fees of every changed, unlocked line are voided and posted again at the
-- new rate, with the office's credit. A fee posted together with other apartments cannot be split,
-- and is shown and left as it is.

-- Locked apartment-months.
create table app.fee_locks (
  property_id uuid not null references app.properties on delete cascade,
  period      date not null,
  locked_by   uuid default auth.uid(),
  locked_at   timestamptz not null default now(),
  primary key (property_id, period)
);
alter table app.fee_locks enable row level security;
create policy staff_read on app.fee_locks for select to authenticated using (app.can_read_country('UA'));
create policy finance_write on app.fee_locks for all to authenticated
  using (app.is_admin() or app.can_approve_country('UA')) with check (app.is_admin() or app.can_approve_country('UA'));
create policy require_mfa on app.fee_locks as restrictive for all to authenticated
  using (app.mfa_verified() or app.my_party_id() is not null) with check (app.mfa_verified() or app.my_party_id() is not null);
grant select, insert, update, delete on app.fee_locks to authenticated;
create trigger audit after insert or update or delete on app.fee_locks for each row execute function app.audit();

-- The rate of exactly this month (no carrying forward).
create or replace function app.fee_rate(p_city text, p_month date) returns numeric
language sql stable security definer set search_path = '' as $$
  select pct from app.fee_rates where city_en = p_city and month = date_trunc('month', p_month)::date
$$;

-- For a rent being posted: the month's rate, or a copy of the latest earlier one made the month's.
create function app.fee_rate_for_posting(p_city text, p_month date) returns numeric
language plpgsql security definer set search_path = '' as $$
declare m date := date_trunc('month', p_month)::date; v numeric;
begin
  v := app.fee_rate(p_city, m);
  if v is not null then return v; end if;
  select pct into v from app.fee_rates where city_en = p_city and month < m order by month desc limit 1;
  if v is null then return null; end if;
  insert into app.fee_rates (city_en, month, pct, notes) values (p_city, m, v, 'הועתק מהחודש הקודם עם השכירות הראשונה של החודש')
  on conflict do nothing;
  return v;
end $$;

-- The fee of one rent (or of one apartment of it) at a given rate, with its office credit.
create function app.create_office_fee(p_rent uuid, p_property uuid, p_pct numeric) returns uuid
language plpgsql security definer set search_path = '' as $$
declare t app.transactions; r record; fee uuid;
begin
  select * into t from app.transactions where id = p_rent;
  if t.id is null or t.status <> 'posted' or t.category <> 'rent' or coalesce(p_pct, 0) <= 0 then return null; end if;
  for r in
    select e.account_id, e.property_id, e.currency, sum(e.amount) as amount
    from app.entries e
    join app.properties p on p.id = e.property_id
    join app.buildings b on b.id = p.building_id
    join app.cities c on c.id = b.city_id and c.name_en = 'Odessa'
    where e.transaction_id = t.id and e.account_id is not null and (p_property is null or e.property_id = p_property)
      and not exists (select 1 from app.fee_locks l where l.property_id = e.property_id and l.period = t.period)
    group by 1, 2, 3
    having sum(e.amount) > 0
  loop
    if fee is null then
      insert into app.transactions (country_code, occurred_on, period, category, description, status, fee_of, created_by, source)
      values (t.country_code, t.occurred_on, t.period, 'mgmt_fee', format('דמי ניהול STF %s%%', trim_scale(p_pct)), 'draft', t.id, t.created_by, 'manual')
      returning id into fee;
    end if;
    insert into app.entries (transaction_id, account_id, property_id, amount, currency, memo)
    values (fee, r.account_id, r.property_id, -round(r.amount * p_pct / 100, 2), r.currency, format('%s%% משכירות %s', trim_scale(p_pct), to_char(t.period, 'MM.YYYY')));
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
  if new.status = 'posted' and old.status = 'draft' and new.category = 'rent'
     and exists (select 1 from app.entries e join app.properties p on p.id = e.property_id join app.buildings b on b.id = p.building_id
                 join app.cities c on c.id = b.city_id and c.name_en = 'Odessa' where e.transaction_id = new.id) then
    perform app.create_office_fee(new.id, null, app.fee_rate_for_posting('Odessa', new.period));
  end if;
  return null;
end $$;

-- What the rate p_pct (null: no rate) for month p_month would do, apartment by apartment.
-- shared: the apartment's fee sits in a transaction with other apartments and cannot be changed.
create function app.fee_rate_preview(p_city text, p_month date, p_pct numeric)
returns table (property_id uuid, property text, owner text, rent numeric, currency text, fee_now numeric, pct_now numeric, fee_new numeric, locked boolean, shared boolean)
language plpgsql stable security definer set search_path = '' as $$
declare m date := date_trunc('month', p_month)::date; office uuid := app.office_party();
begin
  if not (app.is_admin() or app.can_approve_country('UA')) then raise exception 'only finance changes the fee rates' using errcode = '42501'; end if;
  return query
  with odessa as (
    select p.id, trim(coalesce(b.name, '') || ' ' || coalesce(p.unit_no, '')) as title
    from app.properties p join app.buildings b on b.id = p.building_id join app.cities c on c.id = b.city_id and c.name_en = p_city
  ),
  rents as (
    select e.property_id, e.currency::text as currency, sum(e.amount) as amount, sum(round(e.amount * coalesce(p_pct, 0) / 100, 2)) as fee_new
    from (select t.id, e.account_id, e.property_id, e.currency, sum(e.amount) as amount
          from app.transactions t join app.entries e on e.transaction_id = t.id and e.account_id is not null
          where t.category = 'rent' and t.status = 'posted' and t.period = m and e.property_id in (select id from odessa)
          group by 1, 2, 3, 4 having sum(e.amount) > 0) e
    group by 1, 2
  ),
  fees as (
    select fe.property_id, f.id as txn,
           -sum(fe.amount) as amount,
           (select count(distinct x.property_id) from app.entries x where x.transaction_id = f.id and x.property_id is not null) as props
    from app.transactions f join app.entries fe on fe.transaction_id = f.id
    join app.accounts fa on fa.id = fe.account_id and fa.beneficiary_party_id is distinct from office
    where f.category = 'mgmt_fee' and f.status = 'posted' and f.period = m and fe.property_id in (select id from odessa)
    group by 1, 2
  )
  select r.property_id, o.title,
         (select string_agg(x.display_name, ', ') from app.ownerships w join app.parties x on x.id = w.party_id
          where w.property_id = r.property_id and w.valid_from <= m and (w.valid_to is null or w.valid_to >= m)),
         r.amount, r.currency,
         coalesce((select sum(f.amount) from fees f where f.property_id = r.property_id), 0),
         round(coalesce((select sum(f.amount) from fees f where f.property_id = r.property_id), 0) * 100 / nullif(r.amount, 0), 2),
         r.fee_new,
         exists (select 1 from app.fee_locks l where l.property_id = r.property_id and l.period = m),
         exists (select 1 from fees f where f.property_id = r.property_id and f.props > 1)
  from rents r join odessa o on o.id = r.property_id
  order by 2;
end $$;
grant execute on function app.fee_rate_preview(text, date, numeric) to authenticated;

-- Sets (p_pct) or removes (null) the month's rate, sets the locks as given, and redoes the fees of
-- every changed, unlocked, unshared apartment of the month.
create function app.fee_rate_apply(p_city text, p_month date, p_pct numeric, p_notes text, p_lock uuid[], p_unlock uuid[]) returns int
language plpgsql security definer set search_path = '' as $$
declare m date := date_trunc('month', p_month)::date; r record; t uuid; n int := 0;
begin
  if not (app.is_admin() or app.can_approve_country('UA')) then raise exception 'only finance changes the fee rates' using errcode = '42501'; end if;
  delete from app.fee_locks where period = m and property_id = any (coalesce(p_unlock, '{}'));
  insert into app.fee_locks (property_id, period) select x, m from unnest(coalesce(p_lock, '{}')) x on conflict do nothing;
  if p_pct is null then
    delete from app.fee_rates where city_en = p_city and month = m;
  else
    insert into app.fee_rates (city_en, month, pct, notes) values (p_city, m, p_pct, nullif(trim(p_notes), ''))
    on conflict (city_en, month) do update set pct = excluded.pct, notes = excluded.notes, set_by = auth.uid(), set_at = now();
  end if;
  for r in select * from app.fee_rate_preview(p_city, m, p_pct) where not locked and not shared and fee_now <> fee_new loop
    -- Its fees of the month go (automatic or by hand)...
    update app.transactions f set status = 'void', voided_by = auth.uid(), voided_at = now(), void_reason = 'שינוי אחוז דמי הניהול בהגדרות'
    where f.category = 'mgmt_fee' and f.status = 'posted' and f.period = m
      and exists (select 1 from app.entries e where e.transaction_id = f.id and e.property_id = r.property_id);
    -- ...and each of its rents of the month gets the fee at the new rate.
    for t in select distinct tr.id from app.transactions tr join app.entries e on e.transaction_id = tr.id
             where tr.category = 'rent' and tr.status = 'posted' and tr.period = m and e.property_id = r.property_id loop
      perform app.create_office_fee(t, r.property_id, p_pct);
    end loop;
    n := n + 1;
  end loop;
  return n;
end $$;
grant execute on function app.fee_rate_apply(text, date, numeric, text, uuid[], uuid[]) to authenticated;
