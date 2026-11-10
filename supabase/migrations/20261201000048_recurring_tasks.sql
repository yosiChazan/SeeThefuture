-- Task triggers in Settings, and recurring tasks (SPEC decision 130).
--
-- Triggers: like the categories (decision 129), a list the office keeps in Settings. The fixed
-- ones become rows; "monthly" goes (a recurring task's frequency says that now), so its
-- tasks are left without a trigger. A change of trigger goes into a task's history by name.
create table app.task_triggers (
  id          uuid primary key default gen_random_uuid(),
  label       text not null unique check (length(trim(label)) between 1 and 40),
  position    int not null default 100,
  created_at  timestamptz not null default now(),
  created_by  uuid default auth.uid()
);
alter table app.task_triggers enable row level security;
create policy read on app.task_triggers for select to authenticated using (app.is_staff() or app.my_party_id() is not null);
create policy admin_write on app.task_triggers for all to authenticated using (app.is_admin()) with check (app.is_admin());
create policy require_mfa on app.task_triggers as restrictive for all to authenticated
  using (app.mfa_verified() or app.my_party_id() is not null)
  with check (app.mfa_verified() or app.my_party_id() is not null);
grant select, insert, update, delete on app.task_triggers to authenticated;
create trigger audit after insert or update or delete on app.task_triggers for each row execute function app.audit();
insert into app.task_triggers (label, position) values ('ישיבת הנהלה', 10), ('לקוח', 20), ('תקלה במערכת', 30);

alter table app.office_tasks add column trigger_id uuid references app.task_triggers on delete set null;
update app.office_tasks t set trigger_id = g.id from app.task_triggers g
where g.label = case t.trigger_kind when 'management_meeting' then 'ישיבת הנהלה' when 'client' then 'לקוח' when 'system_issue' then 'תקלה במערכת' end;
alter table app.office_tasks drop column trigger_kind;

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
    if new.trigger_id is distinct from old.trigger_id then
      ch := ch || jsonb_build_object('trigger', jsonb_build_array(
        (select label from app.task_triggers where id = old.trigger_id), (select label from app.task_triggers where id = new.trigger_id)));
    end if;
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

-- Recurring tasks: written once, with everything a task has and how often. Each morning the
-- database opens a task from every one whose date has come (lead_days before it); the task is
-- then like any other, with its own history and state. Editing a recurring task changes the
-- tasks opened from then on; removing it leaves the tasks already opened.
create table app.office_task_series (
  id             uuid primary key default gen_random_uuid(),
  created_by     uuid not null default auth.uid(),
  created_at     timestamptz not null default now(),
  updated_at     timestamptz not null default now(),
  active         boolean not null default true,
  subject        text not null check (length(trim(subject)) > 0),
  body           text,
  priority       text not null default 'medium' check (priority in ('low', 'medium', 'high')),
  category_id    uuid references app.task_categories on delete set null,
  trigger_id     uuid references app.task_triggers on delete set null,
  users          uuid[] not null default '{}',
  parties        uuid[] not null default '{}',
  links          jsonb not null default '[]',
  frequency      text not null check (frequency in ('daily', 'weekly', 'monthly', 'yearly')),
  workdays_only  boolean not null default false,                         -- daily: Sunday to Thursday
  weekday        int check (weekday between 0 and 6),                    -- weekly: 0 = Sunday
  month_day      int check (month_day between 1 and 31),                 -- monthly, yearly
  last_day       boolean not null default false,                         -- monthly: the last day
  year_month     int check (year_month between 1 and 12),                -- yearly
  start_on       date not null default current_date,
  end_on         date,
  lead_days      int not null default 0 check (lead_days between 0 and 60),
  last_spawned   date,                                                   -- the last date a task was opened for
  check (frequency <> 'weekly' or weekday is not null),
  check (frequency <> 'monthly' or last_day or month_day is not null),
  check (frequency <> 'yearly' or (year_month is not null and month_day is not null)),
  check (end_on is null or end_on >= start_on)
);

alter table app.office_tasks add column series_id uuid references app.office_task_series on delete set null,
  add column occurrence_on date;
create unique index on app.office_tasks (series_id, occurrence_on) where series_id is not null;

create function app.can_see_task_series(s uuid) returns boolean
language sql stable security definer set search_path = '' as $$
  select app.is_management() or exists (select 1 from app.office_task_series x where x.id = s
    and (x.created_by = auth.uid() or auth.uid() = any (x.users) or app.my_party_id() = any (x.parties)))
$$;
revoke all on function app.can_see_task_series(uuid) from public;
grant execute on function app.can_see_task_series(uuid) to authenticated;

alter table app.office_task_series enable row level security;
create policy see on app.office_task_series for select to authenticated using (app.can_see_task_series(id) or created_by = auth.uid());
create policy add on app.office_task_series for insert to authenticated with check (app.is_staff() and created_by = auth.uid());
create policy change on app.office_task_series for update to authenticated using (app.is_staff() and app.can_see_task_series(id)) with check (app.is_staff());
create policy remove on app.office_task_series for delete to authenticated using (app.is_admin() or created_by = auth.uid());
create policy require_mfa on app.office_task_series as restrictive for all to authenticated
  using (app.mfa_verified() or app.my_party_id() is not null)
  with check (app.mfa_verified() or app.my_party_id() is not null);
grant select, insert, update, delete on app.office_task_series to authenticated;
create trigger audit after insert or update or delete on app.office_task_series for each row execute function app.audit();

-- Whether a recurring task falls on a day. A day that a month lacks (31 in a short month,
-- 29 February) is the month's last day.
create function app.series_on(s app.office_task_series, d date) returns boolean
language sql immutable set search_path = '' as $$
  select case s.frequency
    when 'daily' then not s.workdays_only or extract(dow from d) between 0 and 4
    when 'weekly' then extract(dow from d) = s.weekday
    when 'monthly' then case when s.last_day then d = (date_trunc('month', d) + interval '1 month - 1 day')::date
      else extract(day from d) = least(s.month_day, extract(day from date_trunc('month', d) + interval '1 month - 1 day')) end
    when 'yearly' then extract(month from d) = s.year_month
      and extract(day from d) = least(s.month_day, extract(day from date_trunc('month', d) + interval '1 month - 1 day'))
  end
$$;

-- Opens the tasks whose day has come, up to today in Israel (and lead_days ahead). Run each
-- morning by pg_cron, and harmless to run again: a day already opened is not opened twice.
create function app.spawn_recurring_tasks(p_today date default (now() at time zone 'Asia/Jerusalem')::date) returns int
language plpgsql security definer set search_path = '' as $$
declare
  s app.office_task_series;
  d date;
  t uuid;
  l jsonb;
  n int := 0;
begin
  if auth.uid() is not null and not app.is_staff() then return 0; end if;
  for s in select * from app.office_task_series where active for update skip locked loop
    d := greatest(coalesce(s.last_spawned + 1, s.start_on), s.start_on);
    while d <= p_today + s.lead_days and (s.end_on is null or d <= s.end_on) and d < s.start_on + 3660 loop
      if app.series_on(s, d) then
        t := null;
        insert into app.office_tasks (created_by, subject, body, priority, category_id, trigger_id, series_id, occurrence_on)
        values (s.created_by, s.subject, s.body, s.priority, s.category_id, s.trigger_id, s.id, d)
        on conflict do nothing returning id into t;
        if t is not null then
          insert into app.office_task_assignees (task_id, user_id, created_by) select t, u, s.created_by from unnest(s.users) u
            where exists (select 1 from app.profiles p where p.user_id = u) on conflict do nothing;
          insert into app.office_task_assignees (task_id, party_id, created_by) select t, p, s.created_by from unnest(s.parties) p
            where exists (select 1 from app.parties x where x.id = p) on conflict do nothing;
          for l in select * from jsonb_array_elements(s.links) loop
            insert into app.office_task_links (task_id, kind, entity_id, country_code)
            values (t, l ->> 'kind', (l ->> 'entity_id')::uuid, l ->> 'country_code') on conflict do nothing;
          end loop;
          n := n + 1;
        end if;
        update app.office_task_series set last_spawned = d where id = s.id;
      end if;
      d := d + 1;
    end loop;
  end loop;
  return n;
end $$;
revoke all on function app.spawn_recurring_tasks(date) from public;
grant execute on function app.spawn_recurring_tasks(date) to authenticated;

-- A task opened from a recurring one is created inside spawn_recurring_tasks, so its
-- assignees and links are part of "created" (same transaction), as with a new task.

drop function app.create_office_task(text, text, text, text, uuid[], uuid[], jsonb, uuid);
create function app.create_office_task(p_trigger uuid, p_subject text, p_body text, p_priority text,
                                       p_users uuid[], p_parties uuid[], p_links jsonb, p_category uuid default null) returns uuid
language plpgsql set search_path = '' as $$
declare t uuid; l jsonb;
begin
  insert into app.office_tasks (trigger_id, subject, body, priority, category_id)
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
grant execute on function app.create_office_task(uuid, text, text, text, uuid[], uuid[], jsonb, uuid) to authenticated;

-- Each morning at about 06:05 in Israel (03:05 UTC). Where pg_cron is missing (the local test
-- database), the tasks page also runs it when it opens.
do $$
begin
  create extension if not exists pg_cron;
  perform cron.schedule('spawn-recurring-tasks', '5 3 * * *', 'select app.spawn_recurring_tasks()');
exception when others then
  raise notice 'pg_cron not available: %', sqlerrm;
end $$;
