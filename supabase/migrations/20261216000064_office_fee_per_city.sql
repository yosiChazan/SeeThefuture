-- The office's fee in every city that has rates, as its own category (SPEC decision 167).
-- * Odessa's fees, all of them the office's, become "דמי ניהול משרד" (office_fee); Kyiv's and the
--   other managers' stay "דמי ניהול מנהל" (mgmt_fee). A classification, not a change of money: the
--   guard on posted transactions is set aside for this one update.
-- * The automatic fee (decision 158) and its rates (162) work per city: Settings → a city's rate
--   per month; a rent in a city with rates gets the office's fee at its month's rate.
-- * The office's credit (146) follows every office fee, at whoever holds the money it was taken
--   from (Gershon in Odessa, Vitaly in Kyiv).

alter table app.transactions disable trigger transactions_guard;
update app.transactions t set category = 'office_fee'
where t.category = 'mgmt_fee' and t.country_code = 'UA'
  and exists (select 1 from app.entries e join app.properties p on p.id = e.property_id join app.buildings b on b.id = p.building_id
              join app.cities c on c.id = b.city_id and c.name_en = 'Odessa' where e.transaction_id = t.id);
alter table app.transactions enable trigger transactions_guard;

-- The office's credit: on posting an office fee, + the fee to the office's money at the same holder.
create or replace function app.office_fee_credit() returns trigger
language plpgsql security definer set search_path = '' as $$
declare office uuid := app.office_party(); r record;
begin
  if new.category <> 'office_fee' or new.status <> 'posted' or old.status <> 'draft' or office is null then return new; end if;
  if exists (select 1 from app.entries e join app.accounts a on a.id = e.account_id
             where e.transaction_id = new.id and a.beneficiary_party_id = office) then return new; end if;
  for r in
    select a.holder_party_id, e.currency, e.property_id, a.country_code, sum(e.amount) as amount
    from app.entries e join app.accounts a on a.id = e.account_id and a.kind = 'manager_cash' and a.beneficiary_party_id <> office
    where e.transaction_id = new.id
    group by 1, 2, 3, 4
  loop
    if r.amount <> 0 then
      insert into app.entries (transaction_id, account_id, property_id, amount, currency, memo)
      values (new.id, app.account_for('manager_cash', r.holder_party_id, office, r.currency, r.country_code), r.property_id, -r.amount, r.currency, 'דמי ניהול משרד: זכות למשרד');
    end if;
  end loop;
  return new;
end $$;

-- The office's fee of one rent (or one apartment of it): at p_pct, or at each apartment's city rate.
create or replace function app.create_office_fee(p_rent uuid, p_property uuid, p_pct numeric) returns uuid
language plpgsql security definer set search_path = '' as $$
declare t app.transactions; r record; fee uuid; pct numeric; first numeric;
begin
  select * into t from app.transactions where id = p_rent;
  if t.id is null or t.status <> 'posted' or t.category <> 'rent' then return null; end if;
  for r in
    select e.account_id, e.property_id, e.currency, c.name_en as city, sum(e.amount) as amount
    from app.entries e
    join app.properties p on p.id = e.property_id
    join app.buildings b on b.id = p.building_id
    join app.cities c on c.id = b.city_id
    where e.transaction_id = t.id and e.account_id is not null and (p_property is null or e.property_id = p_property)
      and exists (select 1 from app.fee_rates fr where fr.city_en = c.name_en)
      and not exists (select 1 from app.fee_locks l where l.property_id = e.property_id and l.period = t.period)
    group by 1, 2, 3, 4
    having sum(e.amount) > 0
  loop
    pct := coalesce(p_pct, app.fee_rate_for_posting(r.city, t.period));
    if coalesce(pct, 0) <= 0 then continue; end if;
    if fee is null then
      first := pct;
      insert into app.transactions (country_code, occurred_on, period, category, description, status, fee_of, created_by, source)
      values (t.country_code, t.occurred_on, t.period, 'office_fee', format('דמי ניהול משרד %s%%', trim_scale(pct)), 'draft', t.id, t.created_by, 'manual')
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
    perform app.create_office_fee(new.id, null, null);
  end if;
  return null;
end $$;

-- The preview and the apply of a city's monthly rate look at the office's fees.
create or replace function app.fee_rate_preview(p_city text, p_month date, p_pct numeric)
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
    where f.category = 'office_fee' and f.status = 'posted' and f.period = m and fe.property_id in (select id from odessa)
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

create or replace function app.fee_rate_apply(p_city text, p_month date, p_pct numeric, p_notes text, p_lock uuid[], p_unlock uuid[]) returns int
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
    where f.category = 'office_fee' and f.status = 'posted' and f.period = m
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
