-- Replies to replies in a task (SPEC decision 142): the replies form a tree. A reply answers
-- the task (no parent) or another reply. "טופל" is a node of its own (kind 'resolve') under a
-- reply, and ends that branch. A branch whose last reply has no "טופל" under it is still open
-- (בטיפול). Nothing is edited or deleted: a new reply under a reply that already has "טופל"
-- starts a new branch, open until it ends with its own "טופל".
alter table app.office_task_events add column parent_id uuid references app.office_task_events on delete cascade;
create index on app.office_task_events (parent_id);

alter table app.office_task_events drop constraint office_task_events_kind_check;
alter table app.office_task_events add constraint office_task_events_kind_check
  check (kind in ('created', 'reply', 'resolve', 'status', 'change', 'assign', 'unassign', 'link', 'unlink'));

-- A reply hangs on nothing or on a reply of the same task; "טופל" hangs on a reply of the same
-- task that has none yet.
create function app.office_task_parent_ok(p_task uuid, p_parent uuid, p_kind text) returns boolean
language sql stable security definer set search_path = '' as $$
  select case
    when p_parent is null then p_kind = 'reply'
    else exists (select 1 from app.office_task_events x where x.id = p_parent and x.task_id = p_task and x.kind = 'reply')
         and (p_kind = 'reply' or not exists (select 1 from app.office_task_events y where y.parent_id = p_parent and y.kind = 'resolve'))
  end
$$;

drop policy reply on app.office_task_events;
create policy reply on app.office_task_events for insert to authenticated
  with check (kind in ('reply', 'resolve') and created_by = auth.uid() and app.can_see_office_task(task_id)
              and (kind = 'resolve' or length(trim(coalesce(body, ''))) > 0)
              and app.office_task_parent_ok(task_id, parent_id, kind));

-- Open branches per task, for the list: replies nothing hangs on (no reply, no "טופל").
create function app.office_task_open_branches(p_tasks uuid[]) returns table (task_id uuid, open int)
language sql stable security definer set search_path = '' as $$
  select r.task_id, count(*)::int
  from app.office_task_events r
  where r.task_id = any(p_tasks) and r.kind = 'reply' and app.can_see_office_task(r.task_id)
    and not exists (select 1 from app.office_task_events c where c.parent_id = r.id)
  group by r.task_id
$$;
grant execute on function app.office_task_open_branches(uuid[]) to authenticated;
