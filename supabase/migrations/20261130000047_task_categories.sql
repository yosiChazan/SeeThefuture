-- Task categories (SPEC decision 129): software, clients, countries, efficiency, and any the
-- office adds in Settings. A task has one category (or none). Who sees tasks reads the
-- names; an admin adds, renames, orders and removes them. A removed category leaves its
-- tasks without one. A change of a task's category goes into its history by name.
create table app.task_categories (
  id          uuid primary key default gen_random_uuid(),
  label       text not null unique check (length(trim(label)) between 1 and 40),
  position    int not null default 100,
  created_at  timestamptz not null default now(),
  created_by  uuid default auth.uid()
);
alter table app.task_categories enable row level security;
create policy read on app.task_categories for select to authenticated using (app.is_staff() or app.my_party_id() is not null);
create policy admin_write on app.task_categories for all to authenticated using (app.is_admin()) with check (app.is_admin());
create policy require_mfa on app.task_categories as restrictive for all to authenticated
  using (app.mfa_verified() or app.my_party_id() is not null)
  with check (app.mfa_verified() or app.my_party_id() is not null);
grant select, insert, update, delete on app.task_categories to authenticated;
create trigger audit after insert or update or delete on app.task_categories for each row execute function app.audit();

insert into app.task_categories (label, position) values ('תוכנה', 10), ('לקוחות', 20), ('מדינות', 30), ('ייעול', 40);

alter table app.office_tasks add column category_id uuid references app.task_categories on delete set null;

create or replace function app.office_task_log() returns trigger
language plpgsql security definer set search_path = '' as $$
declare
  t uuid;
  fresh boolean;
  ch jsonb := '{}'::jsonb;
begin
  if tg_table_name = 'office_tasks' then
    if tg_op = 'INSERT' then
      insert into app.office_task_events (task_id, kind, created_by) values (new.id, 'created', new.created_by);
      return null;
    end if;
    if new.status is distinct from old.status then
      insert into app.office_task_events (task_id, kind, data) values (new.id, 'status', jsonb_build_object('from', old.status, 'to', new.status));
    end if;
    if new.subject is distinct from old.subject then ch := ch || jsonb_build_object('subject', jsonb_build_array(old.subject, new.subject)); end if;
    if new.body is distinct from old.body then ch := ch || jsonb_build_object('body', jsonb_build_array(old.body, new.body)); end if;
    if new.priority is distinct from old.priority then ch := ch || jsonb_build_object('priority', jsonb_build_array(old.priority, new.priority)); end if;
    if new.trigger_kind is distinct from old.trigger_kind then ch := ch || jsonb_build_object('trigger_kind', jsonb_build_array(old.trigger_kind, new.trigger_kind)); end if;
    if new.category_id is distinct from old.category_id then
      ch := ch || jsonb_build_object('category', jsonb_build_array(
        (select label from app.task_categories where id = old.category_id), (select label from app.task_categories where id = new.category_id)));
    end if;
    if ch <> '{}'::jsonb then insert into app.office_task_events (task_id, kind, data) values (new.id, 'change', ch); end if;
    return null;
  end if;
  t := case when tg_op = 'DELETE' then old.task_id else new.task_id end;
  select created_at = now() into fresh from app.office_tasks where id = t;
  if not found or fresh then return null; end if;
  if tg_table_name = 'office_task_assignees' then
    insert into app.office_task_events (task_id, kind, data) values (t, case when tg_op = 'INSERT' then 'assign' else 'unassign' end,
      case when tg_op = 'INSERT' then jsonb_build_object('user_id', new.user_id, 'party_id', new.party_id) else jsonb_build_object('user_id', old.user_id, 'party_id', old.party_id) end);
  else
    insert into app.office_task_events (task_id, kind, data) values (t, case when tg_op = 'INSERT' then 'link' else 'unlink' end,
      case when tg_op = 'INSERT' then jsonb_build_object('kind', new.kind, 'entity_id', new.entity_id, 'country_code', new.country_code)
           else jsonb_build_object('kind', old.kind, 'entity_id', old.entity_id, 'country_code', old.country_code) end);
  end if;
  return null;
end $$;

drop function app.create_office_task(text, text, text, text, uuid[], uuid[], jsonb);
create function app.create_office_task(p_trigger text, p_subject text, p_body text, p_priority text,
                                       p_users uuid[], p_parties uuid[], p_links jsonb, p_category uuid default null) returns uuid
language plpgsql set search_path = '' as $$
declare t uuid; l jsonb;
begin
  insert into app.office_tasks (trigger_kind, subject, body, priority, category_id)
  values (p_trigger, trim(p_subject), nullif(trim(coalesce(p_body, '')), ''), coalesce(p_priority, 'medium'), p_category)
  returning id into t;
  insert into app.office_task_assignees (task_id, user_id) select t, u from unnest(coalesce(p_users, '{}')) u on conflict do nothing;
  insert into app.office_task_assignees (task_id, party_id) select t, p from unnest(coalesce(p_parties, '{}')) p on conflict do nothing;
  for l in select * from jsonb_array_elements(coalesce(p_links, '[]'::jsonb)) loop
    insert into app.office_task_links (task_id, kind, entity_id, country_code)
    values (t, l ->> 'kind', (l ->> 'entity_id')::uuid, l ->> 'country_code') on conflict do nothing;
  end loop;
  return t;
end $$;
grant execute on function app.create_office_task(text, text, text, text, uuid[], uuid[], jsonb, uuid) to authenticated;
