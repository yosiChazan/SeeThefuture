-- Cash boxes (SPEC decision 112): money held by someone for the company or its clients,
-- outside the clients' accounts: the office's cash and Gershon's. A cash book, like the
-- purchase payments: a record of what came in and went out, not ledger entries, so it
-- moves no client balance. Each movement is signed (+ in, − out), in its own currency.
-- A box of a country follows that country's access (finance writes); a box with no country
-- (the office) is for admins and management to read, admins to write.
create table app.cash_boxes (
  id               uuid primary key default gen_random_uuid(),
  name             text not null unique,
  country_code     char(2) references app.countries,
  holder_party_id  uuid references app.parties,
  -- Managers whose cash flows into this box on its own (Vitaly's into Gershon's: they are
  -- partners). Their manager cash from approved reports counts as received, as does the
  -- rent held by the box's holder (Yarach's transfers reach Gershon). Nothing is entered twice.
  linked_manager_ids uuid[] not null default '{}',
  notes            text,
  position         int not null default 100,
  created_at       timestamptz not null default now()
);

create table app.cash_movements (
  id           uuid primary key default gen_random_uuid(),
  box_id       uuid not null references app.cash_boxes,
  occurred_on  date not null,
  amount       numeric(14,2) not null check (amount <> 0),
  currency     app.currency not null,
  kind         text not null check (kind in ('from_manager', 'to_client', 'expense', 'income', 'transfer', 'other')),
  party_id     uuid references app.parties on delete set null,
  party_name   text,
  property_id  uuid references app.properties on delete set null,
  notes        text,
  created_at   timestamptz not null default now(),
  created_by   uuid default auth.uid()
);
create index on app.cash_movements (box_id, occurred_on);

create function app.can_read_box(b uuid) returns boolean
language sql stable security definer set search_path = '' as $$
  select coalesce((select case when c.country_code is null then app.is_admin() or app.is_management()
                               else app.can_read_country(c.country_code) end
                   from app.cash_boxes c where c.id = b), false)
$$;
create function app.can_write_box(b uuid) returns boolean
language sql stable security definer set search_path = '' as $$
  select coalesce((select case when c.country_code is null then app.is_admin()
                               else app.can_approve_country(c.country_code) end
                   from app.cash_boxes c where c.id = b), false)
$$;

alter table app.cash_boxes enable row level security;
alter table app.cash_movements enable row level security;
create policy staff_read on app.cash_boxes for select to authenticated using (app.can_read_box(id));
create policy admin_write on app.cash_boxes for all to authenticated using (app.is_admin()) with check (app.is_admin());
create policy staff_read on app.cash_movements for select to authenticated using (app.can_read_box(box_id));
create policy finance_write on app.cash_movements for all to authenticated using (app.can_write_box(box_id)) with check (app.can_write_box(box_id));
create policy require_mfa on app.cash_boxes as restrictive for all to authenticated
  using (app.mfa_verified()) with check (app.mfa_verified());
create policy require_mfa on app.cash_movements as restrictive for all to authenticated
  using (app.mfa_verified()) with check (app.mfa_verified());
grant select, insert, update, delete on app.cash_boxes, app.cash_movements to authenticated;
create trigger audit after insert or update or delete on app.cash_boxes for each row execute function app.audit();
create trigger audit after insert or update or delete on app.cash_movements for each row execute function app.audit();

-- The two boxes there are today.
insert into app.cash_boxes (name, country_code, holder_party_id, position, notes)
values ('קופת המשרד', null, null, 10, null);
insert into app.cash_boxes (name, country_code, holder_party_id, linked_manager_ids, position, notes)
select 'קופת גרשון', 'UA',
       (select holder_party_id from app.import_sources where adapter = 'gershon_utilities_xlsx'),
       coalesce((select array_agg(holder_party_id) from app.import_sources where adapter = 'vitaly_rent_xlsx' and holder_party_id is not null), '{}'),
       20, 'גרשון וויטאלי שותפים: הקופה של ויטאלי נכנסת לכאן לבד מהדוחות שאושרו, וכך גם השכירות מירח. מזינים כאן את ההעברות ללקוחות ומה שלא מגיע מהדוחות';
