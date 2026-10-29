-- Users, roles and row-level security. See docs/SPEC.md §3 and §7.
--
-- Staff levels are per country and cumulative: viewer < editor < finance.
-- "Sensitive documents" is a separate per-country flag. Admin and management
-- are global flags on the profile. Clients see only what they own.
--
-- Edge Functions that run with the service role bypass RLS; every other
-- access goes through these policies.

create type app.staff_level as enum ('viewer', 'editor', 'finance');

create table app.profiles (
  user_id          uuid primary key references auth.users on delete cascade,
  display_name     text not null,
  is_admin         boolean not null default false,
  is_management    boolean not null default false,
  -- Set for client users: the party whose properties and balances they see.
  client_party_id  uuid unique references app.parties,
  created_at       timestamptz not null default now()
);

create table app.user_country_roles (
  user_id             uuid not null references app.profiles on delete cascade,
  country_code        char(2) not null references app.countries,
  level               app.staff_level not null,
  can_view_sensitive  boolean not null default false,
  primary key (user_id, country_code)
);

-- ---------------------------------------------------------------------------
-- Helper functions (security definer so policies can read the role tables)
-- ---------------------------------------------------------------------------

create function app.is_admin() returns boolean
language sql stable security definer set search_path = '' as $$
  select coalesce((select is_admin from app.profiles where user_id = auth.uid()), false)
$$;

create function app.is_management() returns boolean
language sql stable security definer set search_path = '' as $$
  select coalesce((select is_management or is_admin from app.profiles where user_id = auth.uid()), false)
$$;

create function app.is_staff() returns boolean
language sql stable security definer set search_path = '' as $$
  select app.is_management()
      or exists (select 1 from app.user_country_roles where user_id = auth.uid())
$$;

-- 0 = no access, 1 = viewer, 2 = editor, 3 = finance
create function app.country_level(c char(2)) returns int
language sql stable security definer set search_path = '' as $$
  select case
    when app.is_admin() then 3
    else coalesce((
      select case level when 'viewer' then 1 when 'editor' then 2 when 'finance' then 3 end
      from app.user_country_roles where user_id = auth.uid() and country_code = c
    ), 0)
  end
$$;

create function app.can_read_country(c char(2)) returns boolean
language sql stable set search_path = '' as $$
  select app.is_management() or app.country_level(c) >= 1
$$;

create function app.can_edit_country(c char(2)) returns boolean
language sql stable set search_path = '' as $$
  select app.country_level(c) >= 2
$$;

create function app.can_approve_country(c char(2)) returns boolean
language sql stable set search_path = '' as $$
  select app.country_level(c) >= 3
$$;

create function app.can_view_sensitive(c char(2)) returns boolean
language sql stable security definer set search_path = '' as $$
  select app.is_admin() or exists (
    select 1 from app.user_country_roles
    where user_id = auth.uid() and country_code = c and can_view_sensitive
  )
$$;

create function app.my_party_id() returns uuid
language sql stable security definer set search_path = '' as $$
  select client_party_id from app.profiles where user_id = auth.uid()
$$;

create function app.property_country(p uuid) returns char(2)
language sql stable security definer set search_path = '' as $$
  select country_code from app.properties where id = p
$$;

-- Client has (or had) an ownership share in the property.
create function app.client_owns_property(p uuid) returns boolean
language sql stable security definer set search_path = '' as $$
  select exists (
    select 1 from app.ownerships
    where property_id = p and party_id = app.my_party_id()
  )
$$;

create function app.client_owns_account(a uuid) returns boolean
language sql stable security definer set search_path = '' as $$
  select exists (
    select 1 from app.accounts
    where id = a and beneficiary_party_id = app.my_party_id()
  )
$$;

-- Ledger lookups. Policies on transactions and entries refer to each other,
-- so they go through these functions to avoid recursive policy evaluation.
create function app.txn_country(t uuid) returns char(2)
language sql stable security definer set search_path = '' as $$
  select country_code from app.transactions where id = t
$$;

create function app.txn_is_posted(t uuid) returns boolean
language sql stable security definer set search_path = '' as $$
  select coalesce((select status = 'posted' from app.transactions where id = t), false)
$$;

create function app.client_has_txn(t uuid) returns boolean
language sql stable security definer set search_path = '' as $$
  select exists (
    select 1 from app.entries e join app.accounts a on a.id = e.account_id
    where e.transaction_id = t and a.beneficiary_party_id = app.my_party_id()
  )
$$;

create function app.deal_country(d uuid) returns char(2)
language sql stable security definer set search_path = '' as $$
  select country_code from app.deals where id = d
$$;

-- ---------------------------------------------------------------------------
-- Ledger guards: only finance posts; posted rows are immutable except void.
-- auth.uid() is null for migrations and service-role jobs.
-- ---------------------------------------------------------------------------

create function app.transactions_guard() returns trigger
language plpgsql set search_path = '' as $$
begin
  if tg_op = 'UPDATE' and old.status = 'posted' then
    if new.status = 'void' and auth.uid() is not null
       and not app.can_approve_country(new.country_code) then
      raise exception 'only finance can void a posted transaction';
    end if;
    if new.status <> 'void'
       or (new.occurred_on, new.period, new.category, new.country_code)
          is distinct from (old.occurred_on, old.period, old.category, old.country_code) then
      raise exception 'posted transactions cannot be changed, only voided';
    end if;
  end if;

  if new.status = 'posted' and (tg_op = 'INSERT' or old.status <> 'posted') then
    if auth.uid() is not null and not app.can_approve_country(new.country_code) then
      raise exception 'only finance can post transactions';
    end if;
    new.approved_by := auth.uid();
    new.approved_at := now();
  end if;

  if tg_op = 'INSERT' then
    new.created_by := coalesce(new.created_by, auth.uid());
  end if;
  return new;
end $$;

create trigger transactions_guard
  before insert or update on app.transactions
  for each row execute function app.transactions_guard();

create function app.entries_guard() returns trigger
language plpgsql set search_path = '' as $$
declare st app.txn_status;
begin
  select status into st from app.transactions
  where id = coalesce(new.transaction_id, old.transaction_id);
  if st = 'posted' or st = 'void' then
    raise exception 'entries of a % transaction cannot be changed', st;
  end if;
  return coalesce(new, old);
end $$;

create trigger entries_guard
  before insert or update or delete on app.entries
  for each row execute function app.entries_guard();

-- ---------------------------------------------------------------------------
-- Audit log
-- ---------------------------------------------------------------------------

create table app.audit_log (
  id          bigint generated always as identity primary key,
  at          timestamptz not null default now(),
  user_id     uuid,
  table_name  text not null,
  row_id      uuid,
  action      text not null,
  old_row     jsonb,
  new_row     jsonb
);

create function app.audit() returns trigger
language plpgsql security definer set search_path = '' as $$
begin
  insert into app.audit_log (user_id, table_name, row_id, action, old_row, new_row)
  values (
    auth.uid(), tg_table_name,
    coalesce((to_jsonb(new) ->> 'id')::uuid, (to_jsonb(old) ->> 'id')::uuid),
    tg_op,
    case when tg_op <> 'INSERT' then to_jsonb(old) end,
    case when tg_op <> 'DELETE' then to_jsonb(new) end
  );
  return coalesce(new, old);
end $$;

do $$
declare t text;
begin
  foreach t in array array[
    'transactions', 'entries', 'accounts', 'ownerships', 'leases', 'rent_schedule',
    'management_agreements', 'deals', 'installments', 'statements', 'user_country_roles', 'profiles'
  ] loop
    execute format(
      'create trigger audit after insert or update or delete on app.%I
       for each row execute function app.audit()', t);
  end loop;
end $$;

-- Document views of sensitive files are logged by the download function,
-- which calls this before issuing a signed URL.
create function app.log_document_access(doc uuid) returns void
language sql security definer set search_path = '' as $$
  insert into app.audit_log (user_id, table_name, row_id, action)
  values (auth.uid(), 'documents', doc, 'VIEW')
$$;

-- ---------------------------------------------------------------------------
-- Row-level security
-- ---------------------------------------------------------------------------

do $$
declare t text;
begin
  for t in select tablename from pg_tables where schemaname = 'app' loop
    execute format('alter table app.%I enable row level security', t);
  end loop;
end $$;

grant usage on schema app to authenticated;
grant select, insert, update, delete on all tables in schema app to authenticated;
grant select on app.account_balances to authenticated;
revoke insert, update, delete on app.audit_log from authenticated;

-- Reference geography: readable by every signed-in user.
create policy read_all on app.countries for select to authenticated using (true);
create policy read_all on app.cities    for select to authenticated using (true);
create policy read_all on app.projects  for select to authenticated using (true);
create policy read_all on app.buildings for select to authenticated using (true);

create policy admin_write on app.countries for all to authenticated using (app.is_admin()) with check (app.is_admin());
create policy staff_write on app.cities for all to authenticated
  using (app.can_edit_country(country_code)) with check (app.can_edit_country(country_code));
create policy staff_write on app.projects for all to authenticated
  using (app.can_edit_country((select country_code from app.cities where id = city_id)))
  with check (app.can_edit_country((select country_code from app.cities where id = city_id)));
create policy staff_write on app.buildings for all to authenticated
  using (app.can_edit_country((select country_code from app.cities where id = city_id)))
  with check (app.can_edit_country((select country_code from app.cities where id = city_id)));

-- Properties
create policy staff_read on app.properties for select to authenticated
  using (app.can_read_country(country_code));
create policy client_read on app.properties for select to authenticated
  using (app.client_owns_property(id));
create policy staff_write on app.properties for all to authenticated
  using (app.can_edit_country(country_code)) with check (app.can_edit_country(country_code));

-- Parties span countries, so any staff member can read them.
create policy staff_read on app.parties for select to authenticated using (app.is_staff());
create policy client_read on app.parties for select to authenticated using (id = app.my_party_id());
create policy staff_write on app.parties for all to authenticated
  using (app.is_admin() or exists (select 1 from app.user_country_roles where user_id = auth.uid() and level in ('editor', 'finance')))
  with check (app.is_admin() or exists (select 1 from app.user_country_roles where user_id = auth.uid() and level in ('editor', 'finance')));

create policy staff_read on app.party_roles for select to authenticated using (app.is_staff());
create policy staff_write on app.party_roles for all to authenticated
  using (app.is_admin() or exists (select 1 from app.user_country_roles where user_id = auth.uid() and level in ('editor', 'finance')))
  with check (app.is_admin() or exists (select 1 from app.user_country_roles where user_id = auth.uid() and level in ('editor', 'finance')));

-- Property-linked tables share one pattern.
do $$
declare t text;
begin
  foreach t in array array[
    'ownerships', 'management_agreements', 'leases', 'rent_schedule', 'utility_contracts'
  ] loop
    execute format($f$
      create policy staff_read on app.%1$I for select to authenticated
        using (app.can_read_country(app.property_country(property_id)));
      create policy staff_write on app.%1$I for all to authenticated
        using (app.can_edit_country(app.property_country(property_id)))
        with check (app.can_edit_country(app.property_country(property_id)));
    $f$, t);
  end loop;
end $$;

create policy client_read on app.ownerships for select to authenticated using (party_id = app.my_party_id());
create policy client_read on app.leases for select to authenticated using (app.client_owns_property(property_id));

-- Accounts and ledger
create policy staff_read on app.accounts for select to authenticated using (app.can_read_country(country_code));
create policy client_read on app.accounts for select to authenticated using (beneficiary_party_id = app.my_party_id());
create policy staff_write on app.accounts for all to authenticated
  using (app.can_edit_country(country_code)) with check (app.can_edit_country(country_code));

create policy staff_read on app.transactions for select to authenticated using (app.can_read_country(country_code));
create policy client_read on app.transactions for select to authenticated
  using (status = 'posted' and app.client_has_txn(id));
create policy staff_write on app.transactions for all to authenticated
  using (app.can_edit_country(country_code)) with check (app.can_edit_country(country_code));

create policy staff_read on app.entries for select to authenticated
  using (app.can_read_country(app.txn_country(transaction_id)));
create policy client_read on app.entries for select to authenticated
  using (app.client_owns_account(account_id) and app.txn_is_posted(transaction_id));
create policy staff_write on app.entries for all to authenticated
  using (app.can_edit_country(app.txn_country(transaction_id)))
  with check (app.can_edit_country(app.txn_country(transaction_id)));

create policy staff_read on app.external_refs for select to authenticated using (app.is_staff());
create policy staff_write on app.external_refs for all to authenticated
  using (app.is_admin() or exists (select 1 from app.user_country_roles where user_id = auth.uid() and level in ('editor', 'finance')))
  with check (app.is_admin() or exists (select 1 from app.user_country_roles where user_id = auth.uid() and level in ('editor', 'finance')));

-- Ingestion: staff of the country; committing is finance (enforced by the
-- transaction guard when the batch's transactions are posted).
create policy staff_read on app.import_sources for select to authenticated using (app.can_read_country(country_code));
create policy admin_write on app.import_sources for all to authenticated using (app.is_admin()) with check (app.is_admin());
create policy staff_all on app.import_batches for all to authenticated
  using (app.can_edit_country(country_code)) with check (app.can_edit_country(country_code));
create policy staff_read on app.import_batches for select to authenticated using (app.can_read_country(country_code));
create policy staff_all on app.import_rows for all to authenticated
  using (app.can_edit_country((select country_code from app.import_batches where id = batch_id)))
  with check (app.can_edit_country((select country_code from app.import_batches where id = batch_id)));

-- Deals and construction
create policy staff_read on app.deals for select to authenticated using (app.can_read_country(country_code));
create policy client_read on app.deals for select to authenticated using (client_party_id = app.my_party_id());
create policy staff_write on app.deals for all to authenticated
  using (app.can_edit_country(country_code)) with check (app.can_edit_country(country_code));

do $$
declare t text;
begin
  foreach t in array array['installments', 'milestones'] loop
    execute format($f$
      create policy staff_read on app.%1$I for select to authenticated
        using (app.can_read_country(app.deal_country(deal_id)));
      create policy client_read on app.%1$I for select to authenticated
        using (exists (select 1 from app.deals d where d.id = deal_id and d.client_party_id = app.my_party_id()));
      create policy staff_write on app.%1$I for all to authenticated
        using (app.can_edit_country(app.deal_country(deal_id)))
        with check (app.can_edit_country(app.deal_country(deal_id)));
    $f$, t);
  end loop;
end $$;

create policy staff_read on app.site_updates for select to authenticated using (app.can_read_country(country_code));
create policy client_read on app.site_updates for select to authenticated
  using (app.client_owns_property(property_id)
         or exists (select 1 from app.properties p join app.buildings b on b.id = p.building_id
                    where b.project_id = site_updates.project_id and app.client_owns_property(p.id)));
create policy staff_write on app.site_updates for all to authenticated
  using (app.can_edit_country(country_code)) with check (app.can_edit_country(country_code));

-- Documents: sensitive files need the per-country flag.
create policy staff_read on app.documents for select to authenticated
  using (app.can_read_country(country_code) and (not sensitive or app.can_view_sensitive(country_code)));
create policy client_read on app.documents for select to authenticated
  using ((entity_type = 'party' and entity_id = app.my_party_id())
      or (entity_type = 'property' and not sensitive and app.client_owns_property(entity_id)));
create policy staff_write on app.documents for all to authenticated
  using (app.can_edit_country(country_code)) with check (app.can_edit_country(country_code));

-- Tasks: country tasks follow country access; tasks without a country are for all staff.
create policy staff_all on app.tasks for all to authenticated
  using (case when country_code is null then app.is_staff() else app.can_read_country(country_code) end)
  with check (case when country_code is null then app.is_staff() else app.can_edit_country(country_code) end);

-- Communication: staff only (clients write on WhatsApp, not in the app).
create policy staff_all on app.conversations for all to authenticated using (app.is_staff()) with check (app.is_staff());
create policy staff_all on app.messages for all to authenticated using (app.is_staff()) with check (app.is_staff());

-- Statements: staff read; finance approves (checked in the send function);
-- clients see their approved or sent statements.
create policy staff_read on app.statements for select to authenticated using (app.is_staff());
create policy staff_write on app.statements for all to authenticated
  using (app.is_admin() or exists (select 1 from app.user_country_roles where user_id = auth.uid() and level = 'finance'))
  with check (app.is_admin() or exists (select 1 from app.user_country_roles where user_id = auth.uid() and level = 'finance'));
create policy client_read on app.statements for select to authenticated
  using (client_party_id = app.my_party_id() and status in ('approved', 'sent'));

-- Profiles and roles: users read their own; admins manage everyone.
create policy self_read on app.profiles for select to authenticated using (user_id = auth.uid() or app.is_admin());
create policy admin_write on app.profiles for all to authenticated using (app.is_admin()) with check (app.is_admin());
create policy self_read on app.user_country_roles for select to authenticated using (user_id = auth.uid() or app.is_admin());
create policy admin_write on app.user_country_roles for all to authenticated using (app.is_admin()) with check (app.is_admin());

create policy admin_read on app.audit_log for select to authenticated using (app.is_admin());
