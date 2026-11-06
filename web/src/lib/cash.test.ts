import { strict as assert } from 'node:assert';
import { test } from 'node:test';
import { summarize, type CashMovement } from './cash.ts';

const m = (kind: string, amount: number, party_name: string | null = null, currency = 'UAH'): CashMovement =>
  ({ id: String(Math.random()), occurred_on: '2026-10-01', amount, currency, kind, party_id: null, party_name, notes: null, created_by: null });

test('what a box should hold: received from managers minus handed to clients', () => {
  const [s] = summarize([
    m('from_manager', 1000, 'ירח'), m('from_manager', 2500, 'ויטאלי'), m('from_manager', 500, 'ירח'),
    m('to_client', -3000, 'לקוח'), m('expense', -100),
  ], (x) => x.party_name ?? '?');
  assert.deepEqual(s.fromManagers, [{ who: 'ויטאלי', amount: 2500 }, { who: 'ירח', amount: 1500 }]);
  assert.equal(s.received, 4000);
  assert.equal(s.toClients, 3000);
  assert.equal(s.expected, 1000);
  assert.equal(s.others, -100);
  assert.equal(s.balance, 900);
});

test('every currency apart', () => {
  const r = summarize([m('from_manager', 100, 'a', 'USD'), m('from_manager', 5, 'a', 'UAH')], (x) => x.party_name ?? '');
  assert.deepEqual(r.map((x) => [x.currency, x.received]), [['UAH', 5], ['USD', 100]]);
});

test('a partner manager\'s cash flows in from the reports, with what is entered by hand', () => {
  const [s] = summarize([m('to_client', -700, 'לקוח')], (x) => x.party_name ?? '', [{ who: 'ויטאלי (מהדוחות)', currency: 'UAH', amount: 1000 }, { who: 'x', currency: 'USD', amount: 5 }]);
  assert.equal(s.received, 1000);
  assert.equal(s.expected, 300);
});
