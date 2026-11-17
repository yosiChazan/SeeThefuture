import { strict as assert } from 'node:assert';
import { test } from 'node:test';
import { nextSort, sortLedger, type LedgerFields } from './ledgerSort.ts';

test('a ledger sorts by any column, up and down, ties by date', () => {
  const rows: LedgerFields[] = [
    { date: '2026-03-01', type: 'שכירות', desc: 'ב', amount: 100, currency: 'UAH' },
    { date: '2026-01-01', type: 'דמי ניהול', desc: 'א', amount: -10, currency: 'USD' },
    { date: '2026-02-01', type: 'שכירות', desc: 'ג', amount: 50, currency: 'UAH' },
  ];
  const d = (s: Parameters<typeof sortLedger>[1]) => sortLedger(rows, s, (r) => r).map((r) => r.date.slice(5, 7)).join(',');
  assert.equal(d({ key: 'date', desc: true }), '03,02,01');
  assert.equal(d({ key: 'date', desc: false }), '01,02,03');
  assert.equal(d({ key: 'type', desc: false }), '01,02,03');          // דמי ניהול, then שכירות by date
  assert.equal(d({ key: 'amount', desc: true }), '03,02,01');
  assert.equal(d({ key: 'desc', desc: true }), '02,03,01');
  assert.equal(d({ key: 'currency', desc: false }), '02,03,01');
  assert.equal(sortLedger([{ ...rows[0], unit: 'דירה 12 · Arcadia' }, { ...rows[1], unit: 'דירה 3 · Arcadia' }], { key: 'unit', desc: false }, (r) => r).map((r) => r.unit).join('|'), 'דירה 3 · Arcadia|דירה 12 · Arcadia');
  assert.deepEqual(nextSort({ key: 'date', desc: true }, 'date'), { key: 'date', desc: false });
  assert.deepEqual(nextSort({ key: 'date', desc: true }, 'type'), { key: 'type', desc: false, then: { key: 'date', desc: true } });
  assert.deepEqual(nextSort({ key: 'type', desc: false }, 'amount'), { key: 'amount', desc: true, then: { key: 'type', desc: false } });
  // Sorted by currency, then by description: equal currencies keep the description order (not the date).
  assert.equal(d({ key: 'currency', desc: false, then: { key: 'desc', desc: false } }), '03,02,01');
});
