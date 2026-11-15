import { strict as assert } from 'node:assert';
import { test } from 'node:test';
import { toggleRows, totalsByCurrency } from './selection.ts';

test('marking rows: one by one, a range with Shift, and the totals per currency', () => {
  const order = ['a', 'b', 'c', 'd', 'e'];
  let s = toggleRows(new Set(), order, 'b', null, false);
  assert.deepEqual([...s], ['b']);
  s = toggleRows(s, order, 'e', 'b', true);
  assert.deepEqual([...s].sort(), ['b', 'c', 'd', 'e']);
  s = toggleRows(s, order, 'c', 'e', true);   // c is on, so the range c..e goes off
  assert.deepEqual([...s].sort(), ['b']);
  assert.deepEqual(totalsByCurrency([{ amount: 100.1, currency: 'UAH' }, { amount: -0.1, currency: 'UAH' }, { amount: 5, currency: 'USD' }]),
    [{ currency: 'UAH', total: 100, count: 2 }, { currency: 'USD', total: 5, count: 1 }]);
});
