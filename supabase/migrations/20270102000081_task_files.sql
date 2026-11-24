-- Pictures and files on a question or a task itself (SPEC decision 201), not only on its replies.
-- They live in the "tasks" bucket under the task's id, like the replies' files.
alter table app.office_tasks add column files text[] not null default '{}';

-- A question is closed by an answer from someone else: the asker adding a note or a file does not close it.
create or replace function app.question_answered() returns trigger
language plpgsql security definer set search_path = '' as $$
begin
  if new.kind = 'reply' then
    update app.office_tasks set status = 'done', updated_at = now()
     where id = new.task_id and kind = 'question' and status <> 'done'
       and created_by is distinct from new.created_by;
  end if;
  return null;
end $$;
