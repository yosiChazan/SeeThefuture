-- Deleting reports still waiting for review (SPEC decision 57). Nothing of them is
-- posted, so they go entirely: the batch, its rows (cascade) and the original file.
-- A batch with transactions cannot be deleted: transactions.import_batch_id points
-- to it, and this policy also limits deleting to batches never approved.

drop policy staff_all on app.import_batches;
create policy staff_write on app.import_batches for insert to authenticated
  with check (app.can_edit_country(country_code));
create policy staff_update on app.import_batches for update to authenticated
  using (app.can_edit_country(country_code)) with check (app.can_edit_country(country_code));
create policy staff_delete_pending on app.import_batches for delete to authenticated
  using (app.can_edit_country(country_code) and status in ('parsed', 'in_review'));

do $$
begin
  if exists (select 1 from pg_namespace where nspname = 'storage') then
    create policy imports_delete on storage.objects for delete to authenticated
      using (bucket_id = 'imports' and app.mfa_verified()
             and app.can_edit_country(split_part(name, '/', 1)::char(2)));
  end if;
end $$;
