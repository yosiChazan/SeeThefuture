-- A manual topic's content belongs to whoever wrote it (SPEC decision 92): only its author
-- (or an admin) changes the title, the details, the fix link and what it is linked to, or
-- deletes it. Every staff member still answers it, assigns it and marks it done.
-- edited_at shows that the content changed after it was sent.
alter table app.tasks add column edited_at timestamptz;

create function app.tasks_author_only() returns trigger
language plpgsql set search_path = '' as $$
begin
  -- Scripts and the service role (no signed-in user) are not limited.
  if auth.uid() is null or app.is_admin() then
    if tg_op = 'UPDATE' and (new.title, new.notes, new.fix_url) is distinct from (old.title, old.notes, old.fix_url) then
      new.edited_at := now();
    end if;
    return case when tg_op = 'DELETE' then old else new end;
  end if;
  if tg_op = 'DELETE' then
    if old.created_by is distinct from auth.uid() then
      raise exception 'only the author of a topic deletes it' using errcode = '42501';
    end if;
    return old;
  end if;
  if new.created_by is distinct from old.created_by then
    raise exception 'the author of a topic does not change' using errcode = '42501';
  end if;
  if (new.title, new.notes, new.fix_url) is distinct from (old.title, old.notes, old.fix_url) then
    if old.created_by is distinct from auth.uid() then
      raise exception 'only the author of a topic edits it' using errcode = '42501';
    end if;
    new.edited_at := now();
  end if;
  return new;
end $$;
create trigger author_only before update or delete on app.tasks
  for each row execute function app.tasks_author_only();

-- Links: added or removed by the topic's author (or an admin). A link that goes because its
-- topic was deleted is fine: the topic is already gone.
create function app.task_links_author_only() returns trigger
language plpgsql security definer set search_path = '' as $$
declare
  t uuid := case when tg_op = 'DELETE' then old.task_id else new.task_id end;
  author uuid;
begin
  if auth.uid() is null or app.is_admin() then return null; end if;
  select created_by into author from app.tasks where id = t;
  if not found then return null; end if;
  if author is distinct from auth.uid() then
    raise exception 'only the author of a topic changes what it is linked to' using errcode = '42501';
  end if;
  return null;
end $$;
revoke all on function app.task_links_author_only() from public;
create trigger author_only after insert or update or delete on app.task_links
  for each row execute function app.task_links_author_only();
