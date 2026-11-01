import { strict as assert } from 'node:assert';
import { test } from 'node:test';
import { buildLiana, buildYarach, proRata, type ManagedUnit } from './manual.ts';
import { FormatError } from './types.ts';

const sum = (xs: number[]) => Math.round(xs.reduce((a, b) => a + b, 0) * 100) / 100;
const amounts = (r: ReturnType<typeof buildYarach>) => r.rows.map((x) => x.proposed!.entries[0].amount);

test('pro-rata split adds up to the cent', () => {
  assert.deepEqual(proRata(100, [1, 1, 1]), [33.34, 33.33, 33.33]);
  assert.equal(sum(proRata(174_500, Array(10).fill(17_450))), 174_500);
  assert.deepEqual(proRata(0, [1, 2]), [0, 0]);
  assert.deepEqual(proRata(50, [0, 0]), [0, 0]);
});

const odessa: ManagedUnit[] = [
  { id: 'a', ref: 'Arcadia 106', owner: 'Owner A', expected: 17_450 },
  { id: 'b', ref: 'Arcadia 220', owner: 'Owner B', expected: 17_450 },
  { id: 'c', ref: 'Center 23', owner: 'Owner C', expected: 6_000 },
  { id: 'd', ref: 'Arcadia 230', owner: 'Owner D' },   // not rented: no expected rent
];

test('Yarach: transfers are split by expected rent into Gershon\'s rent pool', () => {
  const r = buildYarach('2026-10-01', { transfers: [{ on: '2026-10-02', amount: 20_000 }, { on: '2026-10-05', amount: 10_450 }] }, odessa, 'gershon-id');
  assert.equal(r.rows.length, 3);
  assert.equal(sum(amounts(r)), 30_450);
  assert.deepEqual(amounts(r), [12_991.51, 12_991.5, 4_466.99]);
  const e = r.rows[0].proposed!.entries[0];
  assert.deepEqual(e.account, { kind: 'rent_pool', holder: 'gershon-id' });
  assert.equal(e.currency, 'UAH');
  assert.equal(r.rows[0].property.id, 'a');
  assert.equal(r.rows[0].proposed!.occurred_on, '2026-10-31');
  assert.match(r.rows[0].issues[0], /פתוח 4,458\.49/);
  assert.match(r.warnings[0], /Arcadia 230/);
  assert.equal(r.rows[0].errors.length, 0);
  assert.equal(r.scope, '2026-10');
});

test('Yarach: a later version with more transfers keeps each row\'s identity', () => {
  const a = buildYarach('2026-10-01', { transfers: [{ on: '2026-10-02', amount: 1000 }] }, odessa, 'g');
  const b = buildYarach('2026-10-01', { transfers: [{ on: '2026-10-02', amount: 1000 }, { on: '2026-10-09', amount: 500 }] }, odessa, 'g');
  assert.deepEqual(a.rows.map((r) => [r.proposed!.occurred_on, r.proposed!.description]), b.rows.map((r) => [r.proposed!.occurred_on, r.proposed!.description]));
  assert.notEqual(a.rows[0].fingerprint, b.rows[0].fingerprint);
});

test('Yarach: more than expected is an error to check; bad input is refused', () => {
  const r = buildYarach('2026-10-01', { transfers: [{ on: '2026-10-02', amount: 50_000 }] }, odessa, 'g');
  assert.ok(r.rows.every((x) => x.errors.length === 1));
  assert.throws(() => buildYarach('2026-10-01', { transfers: [] }, odessa, 'g'), FormatError);
  assert.throws(() => buildYarach('2026-10-01', { transfers: [{ on: '2026-09-30', amount: 5 }] }, odessa, 'g'), FormatError);
  assert.throws(() => buildYarach('2026-10-01', { transfers: [{ on: '2026-10-01', amount: 5 }] }, [odessa[3]], 'g'), FormatError);
});

const alliance: ManagedUnit[] = [
  { id: 'x', ref: 'Alliance 1305', owner: 'Owner X', feePct: 10 },
  { id: 'y', ref: 'Alliance 1311', owner: 'Owner Y', feePct: 12 },
];

test('Liana: income, her fee and the net to the client bank', () => {
  const r = buildLiana('2026-10-01', { lines: [{ property_id: 'x', gross: 1234.5 }] }, alliance);
  assert.deepEqual(r.rows.map((x) => x.proposed!.category), ['rent', 'mgmt_fee', 'transfer']);
  const [rent, fee, transfer] = r.rows.map((x) => x.proposed!.entries);
  assert.deepEqual(rent, [{ amount: 1234.5, currency: 'GEL', account: { kind: 'manager_cash', holder: 'source' } }]);
  assert.equal(fee[0].amount, -123.45);
  assert.equal(fee[1].external, 'source');
  assert.equal(transfer[0].amount, -1111.05);
  assert.deepEqual(transfer[1].account, { kind: 'client_bank', holder: 'beneficiary' });
  // Liana's cash returns to zero.
  assert.equal(sum([rent[0].amount, fee[0].amount, transfer[0].amount]), 0);
  assert.match(r.warnings[0], /Alliance 1311/);
  assert.equal(r.rows[0].proposed!.occurred_on, '2026-10-31');
});

test('Liana: the fee comes from the agreement; bad input is refused', () => {
  const r = buildLiana('2026-10-01', { paid_on: '2026-10-15', lines: [{ property_id: 'y', gross: 100 }] }, alliance);
  assert.equal(r.rows[1].proposed!.entries[1].amount, 12);
  assert.equal(r.rows[0].proposed!.occurred_on, '2026-10-15');
  assert.throws(() => buildLiana('2026-10-01', { lines: [] }, alliance), FormatError);
  assert.throws(() => buildLiana('2026-10-01', { lines: [{ property_id: 'z', gross: 1 }] }, alliance), FormatError);
  assert.throws(() => buildLiana('2026-10-01', { paid_on: '2026-11-01', lines: [{ property_id: 'x', gross: 1 }] }, alliance), FormatError);
});
