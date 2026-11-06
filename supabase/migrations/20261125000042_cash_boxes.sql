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
  kind         text not null check (kind in ('from_manager', 'to_office', 'to_client', 'office_fee', 'expense', 'income', 'transfer', 'other')),
  party_id     uuid references app.parties on delete set null,
  party_name   text,
  property_id  uuid references app.properties on delete set null,
  notes        text,
  -- A transfer to a client is also posted to the client's accounts (decision 113).
  transaction_id uuid references app.transactions,
  -- How a sum sent to the office was divided (decision 114): its parts, each to a client
  -- (posted, as above) or to the office as fees, point to it.
  parent_id    uuid references app.cash_movements on delete cascade,
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

-- Paying a client from a box (decision 113): one call records the movement and posts the
-- transfer in the ledger: out of the client's money held in the box (a linked manager's
-- cash, or the rent the box's holder keeps for the client), into the client's own bank
-- account, in that account's currency. Only who may write to the box may call it, and the
-- ledger's own guard lets only finance post. The property is set when the money came from
-- one property only.
create function app.cash_pay_client(p_box uuid, p_from_account uuid, p_amount numeric, p_on date, p_notes text, p_parent uuid default null)
returns uuid language plpgsql set search_path = '' as $$
declare
  b app.cash_boxes;
  a app.accounts;
  prop uuid;
  props int;
  t uuid;
  m uuid;
begin
  if not app.can_write_box(p_box) then raise exception 'not allowed to write to this box' using errcode = '42501'; end if;
  if p_amount is null or p_amount <= 0 then raise exception 'the amount must be positive'; end if;
  select * into b from app.cash_boxes where id = p_box;
  if p_parent is not null and not exists (select 1 from app.cash_movements where id = p_parent and box_id = p_box and kind = 'to_office') then
    raise exception 'the part must belong to a sum sent to the office from this box';
  end if;
  select * into a from app.accounts where id = p_from_account;
  if a.id is null or not ((a.kind = 'manager_cash' and a.holder_party_id = any (b.linked_manager_ids))
                          or (a.kind = 'rent_pool' and a.holder_party_id = b.holder_party_id)) then
    raise exception 'this account is not held in this box';
  end if;
  select count(distinct property_id), min(property_id::text)::uuid into props, prop from app.entries where account_id = a.id and property_id is not null;
  insert into app.transactions (country_code, occurred_on, period, category, description, status)
  values (a.country_code, p_on, date_trunc('month', p_on)::date, 'transfer', 'העברה ללקוח מ' || b.name || coalesce(': ' || p_notes, ''), 'draft')
  returning id into t;
  insert into app.entries (transaction_id, account_id, property_id, amount, currency, memo) values
    (t, a.id, case when props = 1 then prop end, -p_amount, a.currency, p_notes),
    (t, app.account_for('client_bank', a.beneficiary_party_id, a.beneficiary_party_id, a.currency, a.country_code),
       case when props = 1 then prop end, p_amount, a.currency, p_notes);
  update app.transactions set status = 'posted' where id = t;
  insert into app.cash_movements (box_id, occurred_on, amount, currency, kind, party_id, notes, transaction_id, parent_id)
  values (p_box, p_on, -p_amount, a.currency, 'to_client', a.beneficiary_party_id, p_notes, t, p_parent)
  returning id into m;
  return m;
end $$;

-- Removing a movement voids the transfers it posted, its parts' too (posted rows are never
-- deleted).
create function app.cash_remove_movement(p_movement uuid) returns void
language plpgsql set search_path = '' as $$
declare ts uuid[];
begin
  select array_agg(transaction_id) filter (where transaction_id is not null) into ts
  from app.cash_movements where id = p_movement or parent_id = p_movement;
  delete from app.cash_movements where id = p_movement;
  if not found then raise exception 'no such movement, or not allowed' using errcode = '42501'; end if;
  if ts is not null then
    update app.transactions set status = 'void' where id = any (ts) and status = 'posted';
    delete from app.transactions where id = any (ts) and status = 'draft';
  end if;
end $$;
