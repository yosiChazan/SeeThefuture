-- Any posted transaction can be voided from a ledger (SPEC decision 153): finance (or an admin)
-- types "מחיקה" to confirm and may give a reason. The transaction stays, marked void, with who
-- voided it, when and why, and the ledgers can show it struck through. A transaction a box line
-- points to (a payment to a client, a conversion, the office's fees) loses that line too, as
-- removing it from the box does.
alter table app.transactions
  add column voided_by uuid,
  add column voided_at timestamptz,
  add column void_reason text;
grant select (voided_by, voided_at, void_reason) on app.transactions to authenticated;

create function app.void_transaction(p_txn uuid, p_reason text) returns void
language plpgsql security definer set search_path = '' as $$
declare t app.transactions; m uuid;
begin
  select * into t from app.transactions where id = p_txn for update;
  if t.id is null then raise exception 'no such transaction'; end if;
  if t.status <> 'posted' then raise exception 'only a posted transaction is voided (this one is %)', t.status; end if;
  if not (app.is_admin() or app.can_approve_country(t.country_code)) then
    raise exception 'only finance can void a transaction' using errcode = '42501';
  end if;
  -- Its box lines: removing a line voids its transactions (app.cash_remove_movement).
  for m in select id from app.cash_movements where (transaction_id = p_txn or fx_transaction_id = p_txn) and mirror_of is null loop
    perform app.cash_remove_movement(m);
  end loop;
  update app.transactions set status = 'void', voided_by = auth.uid(), voided_at = now(), void_reason = nullif(trim(p_reason), '')
  where id = p_txn and status = 'posted';
  update app.transactions set voided_by = coalesce(voided_by, auth.uid()), voided_at = coalesce(voided_at, now()), void_reason = coalesce(void_reason, nullif(trim(p_reason), ''))
  where id = p_txn;
end $$;
grant execute on function app.void_transaction(uuid, text) to authenticated;
