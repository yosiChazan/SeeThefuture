-- Clients exempt from the office's fee (SPEC decision 177). A client on this list (גולובנציץ &
-- שיינברגר, for their City center apartments in Odessa) gets no automatic office fee on a rent
-- of theirs, and a rate set or changed in Settings gives their lines 0 (so applying a month
-- removes a fee of theirs that is there). Settings → the fee rates → "פטורים מדמי ניהול משרד".

create table app.office_fee_exempt (
  party_id uuid primary key references app.parties on delete cascade,
  notes    text,
  set_by   uuid default auth.uid(),
  set_at   timestamptz not null default now()
);
alter table app.office_fee_exempt enable row level security;
create policy staff_read on app.office_fee_exempt for select to authenticated using (app.can_read_country('UA'));
create policy finance_write on app.office_fee_exempt for all to authenticated
  using (app.is_admin() or app.can_approve_country('UA')) with check (app.is_admin() or app.can_approve_country('UA'));
create policy require_mfa on app.office_fee_exempt as restrictive for all to authenticated
  using (app.mfa_verified() or app.my_party_id() is not null) with check (app.mfa_verified() or app.my_party_id() is not null);
grant select, insert, update, delete on app.office_fee_exempt to authenticated;
create trigger audit after insert or update or delete on app.office_fee_exempt for each row execute function app.audit();

insert into app.office_fee_exempt (party_id, notes)
select id, 'הדירות במרכז העיר באודסה: בלי דמי ניהול משרד' from app.parties where id = '5cf066a6-28b0-59a5-aab0-b70209f365fd'
on conflict do nothing;

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
    join app.accounts a on a.id = e.account_id
    where e.transaction_id = t.id and e.account_id is not null and (p_property is null or e.property_id = p_property)
      and exists (select 1 from app.fee_rates fr where fr.city_en = c.name_en)
      and not exists (select 1 from app.fee_locks l where l.property_id = e.property_id and l.period = t.period)
      and not exists (select 1 from app.office_fee_exempt x where x.party_id = a.beneficiary_party_id)
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
    select e.property_id, e.currency::text as currency, sum(e.amount) as amount,
           sum(case when e.exempt then 0 else round(e.amount * coalesce(p_pct, 0) / 100, 2) end) as fee_new
    from (select t.id, e.account_id, e.property_id, e.currency, sum(e.amount) as amount,
                 exists (select 1 from app.accounts a join app.office_fee_exempt x on x.party_id = a.beneficiary_party_id where a.id = e.account_id) as exempt
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

