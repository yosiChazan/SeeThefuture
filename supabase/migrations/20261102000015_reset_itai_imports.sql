-- Resetting Itai's imports (SPEC decision 58): every report imported from Itai's files
-- and what it posted, so they can be imported again from scratch. Nothing else is
-- touched: properties, clients, leases, the owners' bank accounts, other managers'
-- reports and settings stay. Leases added from Itai's files also stay.
--
-- Hardened, and enforced here rather than in the browser:
--  * an admin, after two-factor sign-in (aal2);
--  * a one-time code sent to the admin's email, entered in the last 15 minutes
--    (Supabase records it in the JWT's "amr" as method "otp");
--  * a written reason, kept with the counts in the audit log.

create function app.reset_itai_imports(p_reason text) returns jsonb
language plpgsql security definer set search_path = '' as $$
declare
  batches   uuid[];
  n_txn     int;
  n_rows    int;
  n_batches int;
  n_acc     int;
  itai      uuid;
  fresh_otp boolean;
begin
  if not app.is_admin() then raise exception 'only a system administrator can reset'; end if;
  if not app.mfa_verified() then raise exception 'two-factor sign-in is required'; end if;
  select exists (
    select 1 from jsonb_array_elements(coalesce(auth.jwt() -> 'amr', '[]')) a
    where a ->> 'method' in ('otp', 'magiclink', 'email/otp')
      and (a ->> 'timestamp')::bigint > extract(epoch from now()) - 15 * 60
  ) into fresh_otp;
  if not fresh_otp then raise exception 'a code from email, entered in the last 15 minutes, is required'; end if;
  if length(trim(coalesce(p_reason, ''))) < 10 then raise exception 'a reason of at least 10 characters is required'; end if;

  select array_agg(b.id) into batches
  from app.import_batches b join app.import_sources s on s.id = b.source_id
  where s.adapter = 'itai_client_xlsx';
  batches := coalesce(batches, '{}');
  select holder_party_id into itai from app.import_sources where adapter = 'itai_client_xlsx';

  delete from app.import_rows where batch_id = any(batches);
  get diagnostics n_rows = row_count;
  -- Entries go with their transaction (on delete cascade).
  delete from app.transactions where import_batch_id = any(batches);
  get diagnostics n_txn = row_count;
  delete from app.import_batches where id = any(batches);
  get diagnostics n_batches = row_count;
  -- Accounts Itai holds that the imports created and that are now empty.
  delete from app.accounts a
  where a.holder_party_id = itai and a.kind in ('manager_cash', 'deposit_held')
    and not exists (select 1 from app.entries e where e.account_id = a.id);
  get diagnostics n_acc = row_count;

  insert into app.audit_log (user_id, table_name, action, new_row)
  values (auth.uid(), 'import_batches', 'RESET_ITAI',
          jsonb_build_object('reason', trim(p_reason), 'batches', n_batches, 'rows', n_rows,
                             'transactions', n_txn, 'accounts', n_acc));
  return jsonb_build_object('batches', n_batches, 'rows', n_rows, 'transactions', n_txn, 'accounts', n_acc);
end $$;

revoke execute on function app.reset_itai_imports(text) from public;
grant execute on function app.reset_itai_imports(text) to authenticated;
