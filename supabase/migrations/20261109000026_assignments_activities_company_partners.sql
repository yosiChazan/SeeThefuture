-- Contacts responsible for places, activities on a card, and partners of a company
-- (SPEC decisions 79, 80, 81).

-- What a contact is responsible for: one property, a building, a city or a whole country
-- (a lawyer for a building, a manager for a city). Owners stay owners; this is beside them.
create table app.contact_assignments (
  id            uuid primary key default gen_random_uuid(),
  party_id      uuid not null references app.parties on delete cascade,
  property_id   uuid references app.properties on delete cascade,
  building_id   uuid references app.buildings on delete cascade,
  city_id       uuid references app.cities on delete cascade,
  country_code  char(2) references app.countries,
  role          text,                      -- in words: "עו\"ד", "ועד בית", "מנהל"
  created_at    timestamptz not null default now(),
  created_by    uuid default auth.uid(),
  check (num_nonnulls(property_id, building_id, city_id, country_code) = 1)
);
create index on app.contact_assignments (party_id);

-- Activities written on a card: a title, the text, and when it was written.
create table app.activities (
  id           uuid primary key default gen_random_uuid(),
  entity_type  text not null check (entity_type in ('party', 'property', 'lease')),
  entity_id    uuid not null,
  title        text not null check (length(trim(title)) > 0),
  body         text,
  created_at   timestamptz not null default now(),
  created_by   uuid default auth.uid()
);
create index on app.activities (entity_type, entity_id);

-- People who are partners in a company that is itself a client (Golovenzitz & Sheinberger).
-- Unlike spouses (decision 77), nothing is shown together: the company's card keeps its
-- own properties and leases, and each partner's card keeps theirs, with a link between.
create table app.company_partners (
  company_party_id  uuid not null references app.parties on delete cascade,
  partner_party_id  uuid not null references app.parties on delete cascade,
  share_pct         numeric(7,4) check (share_pct is null or (share_pct > 0 and share_pct <= 100)),
  created_at        timestamptz not null default now(),
  created_by        uuid default auth.uid(),
  primary key (company_party_id, partner_party_id),
  check (company_party_id <> partner_party_id)
);

do $$
declare t text;
begin
  foreach t in array array['contact_assignments', 'activities', 'company_partners'] loop
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
