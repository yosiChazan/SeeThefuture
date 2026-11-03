import { strict as assert } from 'node:assert';
import { test } from 'node:test';
import { purchaseSummary, type PurchasePayment } from './purchase.ts';

const pay = (kind: PurchasePayment['kind'], amount: number, currency: PurchasePayment['currency'], amount_usd: number | null = null): PurchasePayment =>
  ({ id: String(Math.random()), paid_on: null, kind, amount, currency, amount_usd, notes: null });

test('paid counts dollars and stated dollar values, never converts', () => {
  const s = purchaseSummary(92690, 'USD', [
    pay('payment', 27808, 'USD'), pay('payment', 391940, 'UAH', 9374.04), pay('payment', 1000, 'UAH'),
    pay('fee', 1959.7, 'UAH', 46.87), pay('fee', 50, 'UAH'), pay('transfer', 50000, 'USD'),
  ], [{ amount: 23172, currency: 'USD', paid_txn_id: null }, { amount: 5, currency: 'USD', paid_txn_id: 'x' }]);
  assert.equal(s.paid, 37182.04);
  assert.equal(s.remaining, 55507.96);
  assert.deepEqual(s.unvalued, { UAH: 1000 });
  assert.deepEqual(s.costs, { USD: 46.87, UAH: 50 });
  assert.deepEqual(s.planned, { USD: 23172 });
});

test('no payment toward the price: paid and remaining unknown', () => {
  const s = purchaseSummary(100, 'USD', [pay('expense', 10, 'ILS')], []);
  assert.equal(s.paid, null);
  assert.equal(s.remaining, null);
  assert.deepEqual(s.costs, { ILS: 10 });
});
