-- A tenant's deposit held by the local manager (Itai's company when the lease is
-- between it and the tenant). It is the tenant's money, not the owner's income, so
-- it is kept apart from the manager's running balance with the owner (SPEC decision 55).
alter type app.account_kind add value if not exists 'deposit_held';
