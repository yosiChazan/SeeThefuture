import { strict as assert } from 'node:assert';
import { test } from 'node:test';
import type { Corrections } from './corrections.ts';
import { MISSING_UNIT, Staging } from './staging.ts';

const fix: Corrections = {
  unitOverrides: { 'A-882': '882א' },
  allowMissingUnit: ['No-number'],
  mergeProperties: [{ keep: 'Row 68', merge: 'Row 48' }],
  externalRefs: [{ property: 'Row 68', source: 'hotel', key: '3607' }],
  partyAliases: { 'Ayala Ravina': 'Ayala Malka Ravina', 'Golo&Sheinberger': 'G & S' },
  companies: ['G & S'],
  internal: ['Uri Golovenzitz'],
};

test('aliases merge spellings into one party and keep every spelling', () => {
  const s = new Staging(fix);
  const a = s.party('Ayala Malka Ravina', 'UA', { role: 'client' });
  const b = s.party('Ayala  Ravina', 'GE', { role: 'client' });
  assert.equal(a, b);
  assert.deepEqual([...s.parties.get(a!)!.spellings], ['Ayala Malka Ravina', 'Ayala Ravina']);
  assert.deepEqual([...s.parties.get(a!)!.countries], ['UA', 'GE']);
});

test('companies and internal people are flagged', () => {
  const s = new Staging(fix);
  assert.equal(s.parties.get(s.party('Golo&Sheinberger', 'UA')!)!.kind, 'company');
  assert.ok(s.parties.get(s.party('Uri Golovenzitz', 'GE')!)!.roles.has('internal'));
});

test('unit overrides and allowed missing units', () => {
  const s = new Staging(fix);
  assert.equal(s.unitFor('UA', 'A-882', '882'), '882א');
  assert.equal(s.unitFor('UA', 'No-number', undefined), MISSING_UNIT);
  assert.equal(s.unitFor('UA', 'Other', undefined), undefined);
  assert.equal(s.issues.at(-1)!.code, 'missing-unit');
});

test('duplicate records merge only when the corrections say so', () => {
  const s = new Staging(fix);
  const owner = s.party('Flint Yehudith', 'RO')!;
  const base = { country: 'RO' as const, buildingKey: 'b1', unitNo: '4', status: 'vacant' as const };
  const k48 = s.addProperty({ ...base, sourceId: 'Row 48' }, []);
  const k68 = s.addProperty({ ...base, sourceId: 'Row 68' }, [owner]);
  assert.equal(k48, k68);
  const p = s.properties.get(k68!)!;
  assert.equal(p.sourceId, 'Row 68');
  assert.deepEqual(p.aliases, ['Row 48']);
  assert.deepEqual(p.ownerKeys, [owner]);

  assert.equal(s.addProperty({ ...base, sourceId: 'Row 99' }, [owner]), undefined);
  assert.equal(s.issues.at(-1)!.code, 'duplicate-property');
});

test('external refs attach to the property and co-owners split equally', () => {
  const s = new Staging(fix);
  const a = s.party('A Person', 'GE')!, b = s.party('B Person', 'GE')!;
  const k = s.addProperty({ country: 'GE', buildingKey: 'b', unitNo: '3023', status: 'short_term', sourceId: 'Row 68' }, [a, b])!;
  assert.deepEqual(s.properties.get(k)!.externalRefs, [{ source: 'hotel', key: '3607' }]);
  s.finalizeOwnerships();
  assert.deepEqual(s.ownerships.map((o) => o.sharePct), [50, 50]);
});
