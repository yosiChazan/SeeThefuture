import { strict as assert } from 'node:assert';
import { test } from 'node:test';
import { buildSql, lit, stableId } from './load.ts';

test('stableId is deterministic and looks like a UUID v5', () => {
  assert.equal(stableId('party', 'a'), stableId('party', 'a'));
  assert.notEqual(stableId('party', 'a'), stableId('property', 'a'));
  assert.match(stableId('party', 'a'), /^[0-9a-f]{8}-[0-9a-f]{4}-5[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
});

test('lit escapes quotes and maps empty values to null', () => {
  assert.equal(lit("O'Brien"), "'O''Brien'");
  assert.equal(lit(''), 'null');
  assert.equal(lit(undefined), 'null');
  assert.equal(lit(12.5), '12.5');
  assert.equal(lit(Number.NaN), 'null');
});

test('Romanian company tenants get 8% withholding; duplicate rows are written once', () => {
  const sql = buildSql({
    parties: [
      { key: 'owner', name: 'Owner', kind: 'person', roles: ['client'], emails: [], phones: [], spellings: ['Owner'] },
      { key: 'co', name: 'Wordistry SRL', kind: 'company', roles: ['tenant'], emails: [], phones: [], spellings: ['Wordistry SRL'] },
    ],
    buildings: [{ key: 'b', country: 'RO', city: 'Bucharest', name: 'Plevnei 1' }],
    properties: [{ key: 'RO|b|12', sourceId: 'p12', aliases: [], externalRefs: [], country: 'RO', buildingKey: 'b', unitNo: '12', status: 'rented' }],
    ownerships: [{ propertyKey: 'RO|b|12', partyKey: 'owner', sharePct: 100, shareAssumed: false }],
    leases: [
      { propertyKey: 'RO|b|12', tenantKey: 'co', start: '2024-10-30', rent: 550, currency: 'EUR' },
      { propertyKey: 'RO|b|12', tenantKey: 'co', start: '2024-10-30', rent: 550, currency: 'EUR' },
    ],
    accounts: [],
  });
  const leaseInsert = sql.slice(sql.indexOf('insert into app.leases'), sql.indexOf('on conflict', sql.indexOf('insert into app.leases')));
  assert.equal(leaseInsert.match(/\n  \(/g)?.length, 1);
  assert.match(leaseInsert, /'EUR', null, null, null, null, null, 8, /);
  assert.ok(sql.startsWith('-- Generated') && sql.trimEnd().endsWith('commit;'));
});

test('a lease without start or rent is written with those fields empty and keeps its end date', () => {
  const sql = buildSql({
    parties: [{ key: 'owner', name: 'Owner', kind: 'person', roles: ['client'], emails: [], phones: [], spellings: ['Owner'] }],
    buildings: [{ key: 'b', country: 'GE', city: 'Batumi', name: 'Alliance' }],
    properties: [{ key: 'GE|b|1505', sourceId: 'p', aliases: [], externalRefs: [], country: 'GE', buildingKey: 'b', unitNo: '1505', status: 'short_term' }],
    ownerships: [{ propertyKey: 'GE|b|1505', partyKey: 'owner', sharePct: 100, shareAssumed: false }],
    leases: [{ propertyKey: 'GE|b|1505', end: '2027-01-31', currency: 'USD' }],
    accounts: [],
  });
  assert.match(sql, /, null, null, '2027-01-31', null, 'USD', /);
});
