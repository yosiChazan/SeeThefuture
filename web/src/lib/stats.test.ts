import { strict as assert } from 'node:assert';
import { test } from 'node:test';
import { byCity, expensesByCategory, flowOf, monthly, type StatEntry } from './stats.ts';

const e = (period: string, category: string, amount: number, property_id: string | null = 'p1', currency = 'RON'): StatEntry => ({ period, category, amount, currency, property_id });

test('income, expenses and money that only moves', () => {
  assert.equal(flowOf('rent'), 'income');
  assert.equal(flowOf('mgmt_fee'), 'expense');
  assert.equal(flowOf('vat'), 'expense');
  assert.equal(flowOf('transfer'), null);
  assert.equal(flowOf('deposit'), null);
});

test('per currency and month: gross, expenses and net, never mixing currencies', () => {
  const m = monthly([
    e('2026-01-01', 'rent', 1000), e('2026-01-01', 'mgmt_fee', -150), e('2026-01-01', 'transfer', -800),
    e('2026-02-01', 'rent', 500), e('2026-01-01', 'rent', 300, 'p9', 'EUR'),
  ]);
  assert.deepEqual(m.get('RON'), [
    { period: '2026-01-01', gross: 1000, expenses: 150, net: 850 },
    { period: '2026-02-01', gross: 500, expenses: 0, net: 500 },
  ]);
  assert.deepEqual(m.get('EUR'), [{ period: '2026-01-01', gross: 300, expenses: 0, net: 300 }]);
});

test('per city: what an apartment that earns brings in a month', () => {
  const cityOf = new Map([['p1', 'Bucharest'], ['p2', 'Bucharest'], ['p3', 'Kyiv']]);
  const units = new Map([['Bucharest', 5], ['Kyiv', 2]]);
  const rows = byCity([
    e('2026-01-01', 'rent', 1000, 'p1'), e('2026-02-01', 'rent', 1000, 'p1'), e('2026-01-01', 'rent', 400, 'p2'),
    e('2026-01-01', 'repair', -200, 'p2'), e('2026-01-01', 'rent', 600, 'p3', 'USD'),
  ], cityOf, units);
  assert.deepEqual(rows[0], { city: 'Bucharest', currency: 'RON', units: 5, earning: 2, gross: 2400, expenses: 200, net: 2200, months: 2, perUnit: 600 });
  assert.equal(rows[1].city, 'Kyiv');
  assert.equal(rows[1].perUnit, 600);
});

test('expenses by category, largest first, one currency', () => {
  assert.deepEqual(expensesByCategory([e('2026-01-01', 'repair', -50), e('2026-01-01', 'mgmt_fee', -150), e('2026-01-01', 'mgmt_fee', -10, 'p1', 'EUR'), e('2026-01-01', 'rent', 900)], 'RON'),
    [{ category: 'mgmt_fee', amount: 150 }, { category: 'repair', amount: 50 }]);
});
