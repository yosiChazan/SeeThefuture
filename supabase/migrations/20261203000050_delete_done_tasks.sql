-- Deleting tasks once they are done (SPEC decision 134): a task marked "done" may be removed
-- by whoever opened it, by management and by an admin; an open task is not removed. Its
-- history goes with it; the audit log keeps the record.
drop policy remove on app.office_tasks;
create policy remove on app.office_tasks for delete to authenticated
  using (status = 'done' and (app.is_management() or created_by = auth.uid()));
