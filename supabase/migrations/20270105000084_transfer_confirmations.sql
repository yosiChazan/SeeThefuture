-- A transfer to an owner is confirmed as received (SPEC decision 209): every transfer posted from
-- 26.11.2026 on (category 'transfer', into the owner's own account) waits on the dashboard until
-- someone marks that it reached the owner. The confirmation is its own row: posted transactions
-- do not change.

create table app.transfer_confirmations (
  transaction_id  uuid primary key references app.transactions on delete cascade,
  confirmed_by    uuid not null default auth.uid(),
  confirmed_at    timestamptz not null default now(),
  note            text
);
alter table app.transfer_confirmations enable row level security;
create policy staff_read on app.transfer_confirmations for select to authenticated using (app.is_staff());
create policy staff_confirm on app.transfer_confirmations for insert to authenticated
  with check (app.is_staff() and confirmed_by = auth.uid()
              and exists (select 1 from app.transactions t where t.id = transaction_id and app.can_edit_country(t.country_code)));
-- A mistaken confirmation is taken back by whoever made it, or an admin.
create policy staff_undo on app.transfer_confirmations for delete to authenticated
  using (confirmed_by = auth.uid() or app.is_admin());
create policy require_mfa on app.transfer_confirmations as restrictive for all to authenticated
  using (app.mfa_verified() or app.my_party_id() is not null)
  with check (app.mfa_verified() or app.my_party_id() is not null);

-- The transfers to owners that need a confirmation, with it when there is one.
create view app.owner_transfers with (security_invoker = true) as
select t.id as transaction_id, t.occurred_on, t.description, t.country_code, t.approved_at,
       e.amount, e.currency, a.beneficiary_party_id as owner_id, p.display_name as owner_name, e.property_id,
       c.confirmed_at, c.confirmed_by, c.note
from app.transactions t
join app.entries e on e.transaction_id = t.id and e.amount > 0
join app.accounts a on a.id = e.account_id and a.kind = 'client_bank'
join app.parties p on p.id = a.beneficiary_party_id
left join app.transfer_confirmations c on c.transaction_id = t.id
where t.category = 'transfer' and t.status = 'posted' and t.approved_at >= '2026-11-26';
grant select on app.owner_transfers to authenticated;
grant select, insert, delete on app.transfer_confirmations to authenticated;
