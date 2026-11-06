import { strict as assert } from 'node:assert';
import { test } from 'node:test';
import { division, summarize, type CashMovement } from './cash.ts';

let n = 0;
const m = (kind: string, amount: number, party_name: string | null = null, currency = 'UAH', parent_id: string | null = null): CashMovement =>
  ({ id: `m${++n}`, occurred_on: '2026-10-01', amount, currency, kind, party_id: null, party_name, notes: null, created_by: null, parent_id });

test('what Gershon should hold: received from the reports minus what he sent to us', () => {
  const sent = m('to_office', -1000000);
  const [s] = summarize([sent, m('to_client', -600000, 'לקוח', 'UAH', sent.id), m('office_fee', -50000, null, 'UAH', sent.id), m('expense', -100)],
    (x) => x.party_name ?? '?', [{ who: 'ויטאלי, מהדוחות', currency: 'UAH', amount: 1442402 }]);
  assert.equal(s.received, 1442402);
  assert.equal(s.sentToOffice, 1000000);
  assert.equal(s.toClients, 0);
  assert.equal(s.expected, 442402);
  assert.equal(s.balance, 442302);
});

test('how a sum sent to us was divided, and what is left to divide', () => {
  const sent = m('to_office', -1000000);
  const parts = [m('to_client', -600000, 'א', 'UAH', sent.id), m('to_client', -250000, 'ב', 'UAH', sent.id), m('office_fee', -50000, null, 'UAH', sent.id)];
  assert.deepEqual(division(sent, parts), { total: 1000000, toClients: 850000, officeFees: 50000, other: 0, left: 100000 });
});

test('every currency apart', () => {
  const r = summarize([m('from_manager', 100, 'a', 'USD'), m('from_manager', 5, 'a', 'UAH')], (x) => x.party_name ?? '');
  assert.deepEqual(r.map((x) => [x.currency, x.received]), [['UAH', 5], ['USD', 100]]);
});
