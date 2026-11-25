-- Tasks (SPEC decision 128): a task has an author, what started it, a subject, text with
-- links, what it is about (clients, properties, contacts, countries), who handles it
-- (employees, management, clients) and a priority. It is answered on its own page: a reply,
-- passing it on, changing any of its details, and its state. Every change is written to the
-- task's history by the database, so nothing changes silently.
-- Separate from the manual topics of the completeness page (app.tasks, decision 92), which
-- every employee sees.

create table app.office_tasks (
  id            uuid primary key default gen_random_uuid(),
  created_by    uuid not null default auth.uid(),
  created_at    timestamptz not null default now(),
  updated_at    timestamptz not null default now(),
  trigger_kind  text not null check (trigger_kind in ('management_meeting', 'client', 'system_issue', 'monthly')),
  subject       text not null check (length(trim(subject)) > 0),
  body          text,
  priority      text not null default 'medium' check (priority in ('low', 'medium', 'high')),
  status        text not null default 'assigned' check (status in ('assigned', 'in_progress', 'done'))
);
create index on app.office_tasks (updated_at desc);

-- Who handles it: a user of the system (employee, management, a client with a login) or a
-- client without one (then only by e-mail).
create table app.office_task_assignees (
  id          uuid primary key default gen_random_uuid(),
  task_id     uuid not null references app.office_tasks on delete cascade,
  user_id     uuid references app.profiles on delete cascade,
  party_id    uuid references app.parties on delete cascade,
  created_at  timestamptz not null default now(),
  created_by  uuid default auth.uid(),
  check (num_nonnulls(user_id, party_id) = 1)
);
create unique index on app.office_task_assignees (task_id, user_id) where user_id is not null;
create unique index on app.office_task_assignees (task_id, party_id) where party_id is not null;
create index on app.office_task_assignees (user_id);
create index on app.office_task_assignees (party_id);

create table app.office_task_links (
  id            uuid primary key default gen_random_uuid(),
  task_id       uuid not null references app.office_tasks on delete cascade,
  kind          text not null check (kind in ('client', 'property', 'contact', 'country')),
  entity_id     uuid,
  country_code  char(2) references app.countries,
  created_at    timestamptz not null default now(),
  check ((kind = 'country') = (country_code is not null)), check ((kind = 'country') = (entity_id is null))
);
create unique index on app.office_task_links (task_id, kind, coalesce(entity_id::text, country_code));

-- The history: replies (written by people) and changes (written by the database).
create table app.office_task_events (
  id          uuid primary key default gen_random_uuid(),
  task_id     uuid not null references app.office_tasks on delete cascade,
  kind        text not null check (kind in ('created', 'reply', 'status', 'change', 'assign', 'unassign', 'link', 'unlink')),
  body        text,
  data        jsonb,
  created_by  uuid default auth.uid(),
  created_at  timestamptz not null default now()
);
create index on app.office_task_events (task_id, created_at);

-- Who sees a task and may answer it: its author, whoever it is with (a user, or a client
-- user through their party), management and admins. Nobody else, not even other staff.
create function app.office_task_mine(t uuid) returns boolean
language sql stable security definer set search_path = '' as $$
  select exists (select 1 from app.office_tasks where id = t and created_by = auth.uid())
      or exists (select 1 from app.office_task_assignees a where a.task_id = t
                 and (a.user_id = auth.uid() or (a.party_id is not null and a.party_id = app.my_party_id())))
$$;
create function app.can_see_office_task(t uuid) returns boolean
language sql stable security definer set search_path = '' as $$
  select app.is_management() or app.office_task_mine(t)
$$;
revoke all on function app.office_task_mine(uuid) from public;
revoke all on function app.can_see_office_task(uuid) from public;
grant execute on function app.office_task_mine(uuid), app.can_see_office_task(uuid) to authenticated;

alter table app.office_tasks enable row level security;
alter table app.office_task_assignees enable row level security;
alter table app.office_task_links enable row level security;
alter table app.office_task_events enable row level security;

create policy see on app.office_tasks for select to authenticated using (app.can_see_office_task(id) or created_by = auth.uid());
create policy add on app.office_tasks for insert to authenticated with check (app.is_staff() and created_by = auth.uid());
create policy answer on app.office_tasks for update to authenticated using (app.can_see_office_task(id)) with check (app.can_see_office_task(id));
create policy remove on app.office_tasks for delete to authenticated using (app.is_admin());

do $$
declare t text;
begin
  foreach t in array array['office_task_assignees', 'office_task_links'] loop
    execute format('create policy see on app.%I for select to authenticated using (app.can_see_office_task(task_id))', t);
    execute format('create policy change on app.%I for all to authenticated using (app.can_see_office_task(task_id)) with check (app.can_see_office_task(task_id))', t);
  end loop;
end $$;
create policy see on app.office_task_events for select to authenticated using (app.can_see_office_task(task_id));
create policy reply on app.office_task_events for insert to authenticated
  with check (kind = 'reply' and created_by = auth.uid() and length(trim(coalesce(body, ''))) > 0 and app.can_see_office_task(task_id));

do $$
declare t text;
begin
  foreach t in array array['office_tasks', 'office_task_assignees', 'office_task_links', 'office_task_events'] loop
    -- Staff complete the second factor; a client user (an assignee) is exempt, as everywhere.
    execute format($p$create policy require_mfa on app.%I as restrictive for all to authenticated
      using (app.mfa_verified() or app.my_party_id() is not null)
      with check (app.mfa_verified() or app.my_party_id() is not null)$p$, t);
    execute format('grant select, insert, update, delete on app.%I to authenticated', t);
    execute format('create trigger audit after insert or update or delete on app.%I for each row execute function app.audit()', t);
  end loop;
end $$;
revoke update, delete on app.office_task_events from authenticated;

-- The history, written by the database. What is set while the task is being created (in the
-- same transaction) is part of "created", not a change.
create function app.office_task_log() returns trigger
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
revoke all on function app.office_task_log() from public;
create trigger history after insert or update on app.office_tasks for each row execute function app.office_task_log();
create trigger history after insert or delete on app.office_task_assignees for each row execute function app.office_task_log();
create trigger history after insert or delete on app.office_task_links for each row execute function app.office_task_log();

-- Any event moves the task to the top of "last updated".
create function app.office_task_touch() returns trigger
language plpgsql security definer set search_path = '' as $$
begin
  update app.office_tasks set updated_at = now() where id = new.task_id and updated_at < now();
  return null;
end $$;
revoke all on function app.office_task_touch() from public;
create trigger touch after insert on app.office_task_events for each row execute function app.office_task_touch();

-- Creating a task with its links and assignees in one call (one transaction, so it is one
-- "created" event and the author sees it at once).
create function app.create_office_task(p_trigger text, p_subject text, p_body text, p_priority text,
                                       p_users uuid[], p_parties uuid[], p_links jsonb) returns uuid
language plpgsql set search_path = '' as $$
declare t uuid; l jsonb;
begin
  insert into app.office_tasks (trigger_kind, subject, body, priority)
  values (p_trigger, trim(p_subject), nullif(trim(coalesce(p_body, '')), ''), coalesce(p_priority, 'medium'))
  returning id into t;
  insert into app.office_task_assignees (task_id, user_id) select t, u from unnest(coalesce(p_users, '{}')) u on conflict do nothing;
  insert into app.office_task_assignees (task_id, party_id) select t, p from unnest(coalesce(p_parties, '{}')) p on conflict do nothing;
  for l in select * from jsonb_array_elements(coalesce(p_links, '[]'::jsonb)) loop
    insert into app.office_task_links (task_id, kind, entity_id, country_code)
    values (t, l ->> 'kind', (l ->> 'entity_id')::uuid, l ->> 'country_code') on conflict do nothing;
  end loop;
  return t;
end $$;
grant execute on function app.create_office_task(text, text, text, text, uuid[], uuid[], jsonb) to authenticated;

-- Names of the people a task can be with: for staff, every user (employees, management and
-- client users), with e-mail; for a client user, only the names on their own tasks.
create function app.task_people() returns table (user_id uuid, display_name text, email text, client_party_id uuid)
language sql stable security definer set search_path = '' as $$
  select p.user_id, p.display_name, case when app.is_staff() then u.email::text end, p.client_party_id
  from app.profiles p join auth.users u on u.id = p.user_id
  where (app.is_staff() and app.mfa_verified())
     or (app.my_party_id() is not null and p.user_id in (
          select t.created_by from app.office_tasks t where app.can_see_office_task(t.id)
          union select a.user_id from app.office_task_assignees a where app.can_see_office_task(a.task_id)
          union select e.created_by from app.office_task_events e where app.can_see_office_task(e.task_id)))
  order by p.display_name
$$;
revoke all on function app.task_people() from public;
grant execute on function app.task_people() to authenticated;
