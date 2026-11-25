-- Manual topics, second round (SPEC decision 92): a link "to fix it" and several
-- clients, contacts and properties per topic.
alter table app.tasks add column fix_url text
  check (fix_url is null or fix_url ~ '^(https?://|/)');

create table app.task_links (
  task_id      uuid not null references app.tasks on delete cascade,
  entity_type  text not null check (entity_type in ('party', 'property', 'lease')),
  entity_id    uuid not null,
  created_at   timestamptz not null default now(),
  primary key (task_id, entity_type, entity_id)
);
create index on app.task_links (entity_type, entity_id);
alter table app.task_links enable row level security;
create policy staff_all on app.task_links for all to authenticated using (app.is_staff()) with check (app.is_staff());
create policy require_mfa on app.task_links as restrictive for all to authenticated
  using (app.mfa_verified() or app.my_party_id() is not null) with check (app.mfa_verified() or app.my_party_id() is not null);
grant select, insert, update, delete on app.task_links to authenticated;
create trigger audit after insert or update or delete on app.task_links for each row execute function app.audit();

-- A topic's single link from before goes into the new table.
insert into app.task_links (task_id, entity_type, entity_id)
select id, entity_type, entity_id from app.tasks where entity_type in ('party', 'property', 'lease') and entity_id is not null
on conflict do nothing;
