import { strict as assert } from 'node:assert';
import { test } from 'node:test';
import { buildStatement } from './statement.ts';

test('a statement: opening, months, lines, closing; an account with nothing is left out', () => {
  const accounts = [{ id: 'a', title: 'קופה אצל גרשון', currency: 'UAH' }, { id: 'b', title: 'ריק', currency: 'USD' }];
  const e = (on: string, amount: number) => ({ account_id: 'a', amount, on, label: 'x', place: null });
  const [s, ...rest] = buildStatement(accounts, [e('2026-01-10', 1000), e('2026-02-01', 500), e('2026-02-15', -200), e('2026-03-01', 300), e('2026-04-01', 50)], '2026-02-01', '2026-03-31');
  assert.equal(rest.length, 0);
  assert.equal(s.opening, 1000);
  assert.deepEqual(s.months.map((m) => [m.month, m.income, m.expenses, m.balance]), [['2026-02', 500, -200, 1300], ['2026-03', 300, 0, 1600]]);
  assert.deepEqual(s.lines.map((l) => l.balance), [1500, 1300, 1600]);
  assert.equal(s.closing, 1600);
});
