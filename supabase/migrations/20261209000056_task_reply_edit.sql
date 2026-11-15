-- Replies in a task can be edited and carry pictures (SPEC decision 143).
-- Who may edit a reply (or the note of a "טופל"): whoever wrote it, and an admin. Only the
-- text and the pictures change; every earlier text is kept in data.edits, with who and when.
-- Pictures live in the private bucket "tasks", under "<task id>/…": whoever sees the task
-- sees them and may add to it.
alter table app.office_task_events
  add column files text[] not null default '{}',
  add column edited_at timestamptz;

-- Every picture of a reply is under its own task's folder.
create function app.office_task_files_ok(p_task uuid, p_files text[]) returns boolean
language sql immutable set search_path = '' as $$
  select coalesce(bool_and(f like p_task::text || '/%' and f !~ '\.\.'), true) from unnest(p_files) f
$$;

-- A reply needs text or a picture.
drop policy reply on app.office_task_events;
create policy reply on app.office_task_events for insert to authenticated
  with check (kind in ('reply', 'resolve') and created_by = auth.uid() and app.can_see_office_task(task_id)
              and (kind = 'resolve' or length(trim(coalesce(body, ''))) > 0 or cardinality(files) > 0)
              and app.office_task_parent_ok(task_id, parent_id, kind)
              and app.office_task_files_ok(task_id, files));

create policy edit on app.office_task_events for update to authenticated
  using (kind in ('reply', 'resolve') and (created_by = auth.uid() or app.is_admin()) and app.can_see_office_task(task_id))
  with check (kind in ('reply', 'resolve') and app.can_see_office_task(task_id)
              and (kind = 'resolve' or length(trim(coalesce(body, ''))) > 0 or cardinality(files) > 0)
              and app.office_task_files_ok(task_id, files));
grant update (body, files) on app.office_task_events to authenticated;

-- Keeps the earlier text; nothing but the text and the pictures may change.
create function app.office_task_event_edit() returns trigger
language plpgsql set search_path = '' as $$
begin
  if new.task_id <> old.task_id or new.kind <> old.kind or new.parent_id is distinct from old.parent_id
     or new.created_by is distinct from old.created_by or new.created_at <> old.created_at
     or new.data is distinct from old.data and auth.uid() is not null then
    raise exception 'only the text and the pictures of a reply can change';
  end if;
  if new.body is distinct from old.body or new.files is distinct from old.files then
    new.data := coalesce(old.data, '{}'::jsonb) || jsonb_build_object('edits',
      coalesce(old.data -> 'edits', '[]'::jsonb) || jsonb_build_array(jsonb_build_object(
        'at', now(), 'by', auth.uid(), 'body', old.body, 'files', to_jsonb(old.files))));
    new.edited_at := now();
  end if;
  return new;
end $$;
create trigger edit before update on app.office_task_events for each row execute function app.office_task_event_edit();

-- The pictures' bucket (skipped on the local test database, which has no storage schema).
create function app.task_file_visible(p_name text) returns boolean
language plpgsql stable security definer set search_path = '' as $$
begin
  return (app.mfa_verified() or app.my_party_id() is not null)
     and app.can_see_office_task(split_part(p_name, '/', 1)::uuid);
exception when invalid_text_representation then
  return false;
end $$;

do $$
begin
  if exists (select 1 from pg_namespace where nspname = 'storage') then
    insert into storage.buckets (id, name, public) values ('tasks', 'tasks', false)
    on conflict (id) do nothing;
    create policy tasks_read on storage.objects for select to authenticated
      using (bucket_id = 'tasks' and app.task_file_visible(name));
    create policy tasks_write on storage.objects for insert to authenticated
      with check (bucket_id = 'tasks' and app.task_file_visible(name));
  end if;
end $$;
