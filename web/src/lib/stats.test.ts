import { strict as assert } from 'node:assert';
import { test } from 'node:test';
import { byCity, change, contractRent, occupancy, expensesByCategory, flowOf, monthly, quiet, trend, yearBefore, type StatEntry } from './stats.ts';

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

test('quiet apartments: no income in the last months that have data, per country', () => {
  const entries = [
    e('2026-06-01', 'rent', 100, 'a'), e('2026-07-01', 'rent', 100, 'a'), e('2026-08-01', 'rent', 100, 'a'),
    e('2026-05-01', 'rent', 100, 'b'), e('2026-08-01', 'transfer', 100, 'b'),
  ].map((x) => ({ ...x, country: 'RO' }));
  const props = [
    { id: 'a', country: 'RO', expected: true }, { id: 'b', country: 'RO', expected: true },
    { id: 'c', country: 'RO', expected: true }, { id: 'd', country: 'RO', expected: false }, { id: 'u', country: 'UA', expected: true },
  ];
  const r = quiet(entries, props, 2);
  assert.deepEqual(r.rows, [{ id: 'c', country: 'RO', lastIncome: null }, { id: 'b', country: 'RO', lastIncome: '2026-05-01' }]);
  assert.equal(r.windowEnd.get('RO'), '2026-08-01');
  assert.equal(quiet(entries, props, 4).rows.length, 1);
});

test('a year earlier: the same months, and the change', () => {
  const rows = ['2025-07-01', '2025-08-01', '2026-07-01', '2026-08-01'].map((period, i) => ({ period, gross: [100, 100, 120, 150][i], expenses: 0, net: 0 }));
  assert.equal(yearBefore('2026-08-01'), '2025-08-01');
  assert.equal(change(150, 100), 50);
  assert.equal(change(150, undefined), null);
  assert.deepEqual(trend(rows, 2), { now: 270, before: 200, months: ['2026-07-01', '2026-08-01'] });
  assert.equal(trend(rows, 3)!.before, null);
});

test('the average counts only apartments rented now', () => {
  const cityOf = new Map([['r', 'X'], ['v', 'X']]);
  const rows = byCity([e('2026-01-01', 'rent', 1000, 'r'), e('2026-01-01', 'rent', 200, 'v')], cityOf, new Map([['X', 2]]), new Set(['r']));
  assert.equal(rows[0].gross, 1200);
  assert.equal(rows[0].earning, 1);
  assert.equal(rows[0].perUnit, 1000);
});

test('occupancy: not rented out of the apartments that can be rented', () => {
  const r = occupancy([
    { city: 'X', status: 'rented' }, { city: 'X', status: 'short_term' }, { city: 'X', status: 'vacant' },
    { city: 'X', status: 'under_construction' }, { city: 'X', status: 'owner_use' }, { city: 'X', status: 'sold' },
  ]);
  assert.deepEqual(r, [{ city: 'X', total: 5, construction: 1, ownerUse: 1, rentable: 3, rented: 2, notRented: 1, notRentedPct: 33.3 }]);
});

test('average contract rent of apartments rented now', () => {
  const lease = (rent: number, end: string | null) => ({ start_date: '2025-01-01', end_date: end, rent_amount: rent, rent_currency: 'EUR' });
  assert.deepEqual(contractRent([
    { city: 'X', status: 'rented', leases: [lease(400, null)] }, { city: 'X', status: 'rented', leases: [lease(999, '2025-06-30'), lease(600, null)] },
    { city: 'X', status: 'vacant', leases: [lease(5000, null)] },
  ], '2026-01-01'), [{ city: 'X', currency: 'EUR', leases: 2, avg: 500 }]);
});
