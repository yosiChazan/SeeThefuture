-- Yarach's month: his transfers, then one allocation of what arrived (SPEC decision 159; replaces
-- the monthly charge on the 1st of decision 141). Each transfer is money received from Yarach in
-- Gershon's box, for a rent month. When the month's last transfer is in, the office divides the
-- month's transfers: fixed sums to Frenkel and to the company's apartments in the centre, the rest
-- among the Arcadia apartments (equal parts, or by hand). The division is a report for finance;
-- once approved, each apartment has that month's rent in hryvnia, at the rate Yarach really used,
-- and its STF fee is added (decision 158).
alter table app.cash_movements
  add column rent_month date check (rent_month = date_trunc('month', rent_month)::date),
  add column allocated_batch uuid references app.import_batches on delete set null;

-- The charge on the 1st and the dollar rate for it stop.
do $$
begin
  perform cron.unschedule('yarach-accrual-1st');
  perform cron.unschedule('usd-rate-1st');
exception when others then
  raise notice 'pg_cron jobs not removed: %', sqlerrm;
end $$;

update app.import_sources set name = 'ירח · חלוקה חודשית' where adapter = 'yarach_accrual';

-- A drafted charge still waiting is no longer wanted: the month is divided from the transfers.
update app.import_batches set status = 'rejected', reviewed_at = now()
where status in ('parsed', 'in_review') and source_id in (select id from app.import_sources where adapter = 'yarach_accrual');
