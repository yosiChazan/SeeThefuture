-- Purchase payments as structured rows (SPEC decision 84): what was paid toward the price,
-- fees, other costs and the client's own transfers, each with its date.
--   payment   toward the property's price: these make "paid" and "remaining" on the cards
--   fee       lawyer, notary, broker, bank and transfer fees
--   expense   other costs around the purchase (renovation, our management, Georgia's rows)
--   transfer  the client moving money toward the purchase (to the Kyiv account, to Gershon)
-- amount_usd is the dollar value the source itself states for a payment made in another
-- currency. It is copied, never computed: a payment without one stays in its own currency.
alter table app.purchase_payments drop constraint purchase_payments_kind_check;
alter table app.purchase_payments add constraint purchase_payments_kind_check
  check (kind in ('payment', 'fee', 'expense', 'income', 'loan', 'transfer'));
alter table app.purchase_payments add column amount_usd numeric(14,2)
  check (amount_usd is null or currency is distinct from 'USD');
