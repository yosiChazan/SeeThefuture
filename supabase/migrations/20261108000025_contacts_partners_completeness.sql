-- Contacts apart from clients, partners of one client, and the completeness page
-- (SPEC decisions 76, 77, 78).

-- A person or company we deal with who is not a client (tenant, supplier, lawyer...).
-- "Set as contact" moves a party from the clients list here; nothing else changes.
alter type app.party_role add value if not exists 'contact';

-- Two people who are one client: the member (a spouse or partner) is shown inside the
-- main client's card as an authorized person, and not as a separate client. Linking
-- moves nothing: ownerships, accounts and recorded transactions stay as they were, so
-- unlinking restores the two clients exactly.
create table app.party_links (
  member_party_id  uuid primary key references app.parties on delete cascade,
  main_party_id    uuid not null references app.parties on delete cascade,
  relation         text not null default 'spouse' check (relation in ('spouse', 'partner', 'authorized')),
  created_by       uuid default auth.uid(),
  created_at       timestamptz not null default now(),
  check (member_party_id <> main_party_id)
);
create index on app.party_links (main_party_id);

-- Items of the completeness page that someone chose to ignore, with the reason.
create table app.completeness_dismissals (
  check_key     text not null,
  entity_id     uuid not null,
  reason        text,
  dismissed_by  uuid default auth.uid(),
  dismissed_at  timestamptz not null default now(),
  primary key (check_key, entity_id)
);

do $$
declare t text;
begin
  foreach t in array array['party_links', 'completeness_dismissals'] loop
    execute format('alter table app.%I enable row level security', t);
    execute format('create policy staff_read on app.%I for select to authenticated using (app.is_staff())', t);
    execute format($p$create policy staff_write on app.%I for all to authenticated
      using (app.is_admin() or exists (select 1 from app.user_country_roles where user_id = auth.uid() and level in ('editor', 'finance')))
      with check (app.is_admin() or exists (select 1 from app.user_country_roles where user_id = auth.uid() and level in ('editor', 'finance')))$p$, t);
    execute format($p$create policy require_mfa on app.%I as restrictive for all to authenticated
      using (app.mfa_verified() or app.my_party_id() is not null)
      with check (app.mfa_verified() or app.my_party_id() is not null)$p$, t);
    execute format('grant select, insert, update, delete on app.%I to authenticated', t);
    execute format('create trigger audit after insert or update or delete on app.%I for each row execute function app.audit()', t);
  end loop;
end $$;

-- The last rent recorded for each property (completeness check: rent not recorded).
-- Runs with the caller's rights, so each user sees only the countries they may read.
create function app.last_rent_by_property() returns table (property_id uuid, occurred_on date, amount numeric, currency app.currency)
language sql stable security invoker set search_path = '' as $$
  select distinct on (e.property_id) e.property_id, t.occurred_on, e.amount, e.currency
  from app.entries e join app.transactions t on t.id = e.transaction_id
  where t.status = 'posted' and t.category = 'rent' and e.property_id is not null and e.amount > 0
  order by e.property_id, t.occurred_on desc
$$;
grant execute on function app.last_rent_by_property() to authenticated;
