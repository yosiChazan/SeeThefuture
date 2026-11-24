-- Questions (SPEC decision 194): a question to employees is a task of kind 'question', with
-- everything a task has (who is asked, replies, history, mail). The first answer closes it
-- (status 'done'). Whoever asked or was asked, and management, may delete it at any time
-- ("already talked about"); the audit log keeps the record.

alter table app.office_tasks add column kind text not null default 'task' check (kind in ('task', 'question'));
create index on app.office_tasks (kind);

-- The first answer closes the question.
create function app.question_answered() returns trigger
language plpgsql security definer set search_path = '' as $$
begin
  if new.kind = 'reply' then
    update app.office_tasks set status = 'done', updated_at = now()
     where id = new.task_id and kind = 'question' and status <> 'done';
  end if;
  return null;
end $$;
create trigger question_answered after insert on app.office_task_events
  for each row execute function app.question_answered();

drop policy remove on app.office_tasks;
create policy remove on app.office_tasks for delete to authenticated
  using (status = 'done' and (app.is_management() or created_by = auth.uid())
         or kind = 'question' and (app.is_management() or app.office_task_mine(id)));

-- Creating one: the same as a task, and its kind.
drop function app.create_office_task(uuid, text, text, text, uuid[], uuid[], jsonb, uuid);
create function app.create_office_task(p_trigger uuid, p_subject text, p_body text, p_priority text,
                                       p_users uuid[], p_parties uuid[], p_links jsonb, p_category uuid default null,
                                       p_kind text default 'task') returns uuid
language plpgsql set search_path = '' as $$
declare t uuid; l jsonb;
begin
  insert into app.office_tasks (trigger_id, subject, body, priority, category_id, kind)
  values (p_trigger, trim(p_subject), nullif(trim(coalesce(p_body, '')), ''), coalesce(p_priority, 'medium'), p_category, coalesce(p_kind, 'task'))
  returning id into t;
  insert into app.office_task_assignees (task_id, user_id) select t, u from unnest(coalesce(p_users, '{}')) u on conflict do nothing;
  insert into app.office_task_assignees (task_id, party_id) select t, p from unnest(coalesce(p_parties, '{}')) p on conflict do nothing;
  for l in select * from jsonb_array_elements(coalesce(p_links, '[]'::jsonb)) loop
    insert into app.office_task_links (task_id, kind, entity_id, country_code)
    values (t, l ->> 'kind', (l ->> 'entity_id')::uuid, l ->> 'country_code') on conflict do nothing;
  end loop;
  return t;
end $$;
grant execute on function app.create_office_task(uuid, text, text, text, uuid[], uuid[], jsonb, uuid, text) to authenticated;
