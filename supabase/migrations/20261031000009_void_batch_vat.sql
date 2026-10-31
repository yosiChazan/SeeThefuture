-- Cancelling an approved report, and VAT as its own category (SPEC decisions 46-47).

-- VAT on a manager's invoice (Itai charges 19%, 21% from 1.8.2025, on his fees).
alter type app.txn_category add value if not exists 'vat';

alter table app.import_batches
  add column voided_at   timestamptz,
  add column voided_by   uuid,
  add column void_reason text;

-- Voids every posted transaction of a committed batch. Nothing is deleted: the
-- transactions stay, marked void, and drop out of every balance. The rows' fingerprints
-- no longer count as posted, so the corrected report can be imported again.
-- Finance of the batch's country (or admin) only, like approval.
create function app.void_import_batch(p_batch uuid, p_reason text) returns int
language plpgsql set search_path = '' as $$
declare
  b      app.import_batches;
  voided int;
begin
  select * into b from app.import_batches where id = p_batch for update;
  if b.id is null then raise exception 'batch not found'; end if;
  if b.status <> 'committed' then raise exception 'only an approved batch can be cancelled (it is %)', b.status; end if;
  if not app.can_approve_country(b.country_code) then raise exception 'only finance can cancel an approved batch'; end if;
  if coalesce(trim(p_reason), '') = '' then raise exception 'a reason is required'; end if;

  update app.transactions set status = 'void' where import_batch_id = p_batch and status = 'posted';
  get diagnostics voided = row_count;
  update app.import_batches
  set status = 'rejected', voided_at = now(), voided_by = auth.uid(), void_reason = p_reason
  where id = p_batch;
  return voided;
end $$;
