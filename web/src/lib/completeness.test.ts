import { strict as assert } from 'node:assert';
import { test } from 'node:test';
import { findItems, type Client, type Data, type Doc, type Property } from './completeness.ts';

const client = (id: string, over: Partial<Client> = {}): Client => ({
  id, name: `Client ${id}`, last_name: `Last${id}`, kind: 'person', phone: '050', email: 'a@b.c', address: null, id_number: '000000018', referred_by: null, property_ids: [], ...over,
});
const doc = (id: string, entity_type: string, entity_id: string, doc_type: string): Doc => ({ id, entity_type, entity_id, doc_type, file_name: `${id}.pdf`, storage_path: `x/${id}` });
const prop = (id: string, over: Partial<Property> = {}): Property => ({
  id, title: `Apt ${id}`, country: 'UA', building_id: 'b1', status: 'vacant', sqm: 50, floor: '2',
  ownerships: [{ party: { id: 'c1', display_name: 'Client c1' }, share_pct: 100, valid_from: '2020-01-01', valid_to: null }], leases: [], ...over,
});
const base = (over: Partial<Data> = {}): Data => ({
  today: '2026-11-01', clients: [], members: new Map(), docs: [], properties: [], deals: [], managers: [], rents: [], batches: [], ...over,
});
const keys = (d: Data) => findItems(d).map((i) => i.key);

test('a client without an ID number shows the passport scans and offers reading them', () => {
  const d = base({ clients: [client('c1', { id_number: null, property_ids: ['p1'] })], properties: [prop('p1')], docs: [doc('d1', 'party', 'c1', 'passport'), doc('d2', 'property', 'p1', 'poa')] });
  const item = findItems(d).find((i) => i.key === 'client_no_id')!;
  assert.equal(item.context[0].docs![0].id, 'd1');
  assert.deepEqual(item.fixes, [{ kind: 'scan-id', partyId: 'c1' }]);
  assert.ok(!keys(d).includes('client_no_poa'), 'a power of attorney on the property counts');
});

test('a client without properties can be set as a contact; a partner does not count', () => {
  const d = base({ clients: [client('c1'), client('c2')], members: new Map([['c2', 'c1']]) });
  const items = findItems(d).filter((i) => i.key === 'client_no_property');
  assert.deepEqual(items.map((i) => i.entityId), ['c1']);
  assert.deepEqual(items[0].fixes, [{ kind: 'contact', partyId: 'c1' }]);
});

test('same family name suggests linking, once per pair, not for partners already linked', () => {
  const d = base({ clients: [client('c1', { last_name: 'Levi' }), client('c2', { last_name: 'levi' }), client('c3', { last_name: 'Levi' })], members: new Map([['c3', 'c1']]) });
  const dup = findItems(d).filter((i) => i.key === 'client_duplicate');
  assert.equal(dup.length, 1);
  assert.equal(dup[0].fixes.length, 2);
});

test('property status against its leases', () => {
  const lease = { id: 'l1', property_id: 'p1', start_date: '2026-01-01', end_date: '2027-01-01', rent_amount: 500, rent_currency: 'USD', deposit_amount: 500, collect_day: 5, notes: null, tenant: { id: 't', display_name: 'T' } };
  const d = base({ properties: [prop('p1', { leases: [lease] }), prop('p2', { status: 'rented' })], rents: [{ property_id: 'p1', occurred_on: '2026-10-05', amount: 500, currency: 'USD' }] });
  const items = findItems(d);
  assert.deepEqual(items.find((i) => i.key === 'property_lease_not_rented')!.fixes, [{ kind: 'status', propertyId: 'p1', status: 'rented' }]);
  assert.deepEqual(items.find((i) => i.key === 'property_rented_no_lease')!.fixes, [{ kind: 'status', propertyId: 'p2', status: 'vacant' }]);
  assert.ok(!items.some((i) => i.key === 'money_rent_missing'), 'rent recorded in October');
});

test('rent missing for two months, and a lease ending soon, come first', () => {
  const lease = { id: 'l1', property_id: 'p1', start_date: '2026-01-01', end_date: '2026-12-01', rent_amount: 500, rent_currency: 'USD', deposit_amount: null, collect_day: null, notes: null, tenant: null };
  const items = findItems(base({ properties: [prop('p1', { status: 'rented', leases: [lease] })], rents: [{ property_id: 'p1', occurred_on: '2026-07-01', amount: 500, currency: 'USD' }] }));
  assert.deepEqual(items.slice(0, 2).map((i) => i.key), ['money_rent_missing', 'lease_ending']);
  for (const k of ['lease_no_tenant', 'lease_no_deposit', 'lease_no_collect_day', 'lease_no_contract_doc']) assert.ok(items.some((i) => i.key === k), k);
});

test('overlapping leases offer closing the earlier one the day before', () => {
  const a = { id: 'a', property_id: 'p1', start_date: '2025-06-01', end_date: '2026-06-01', rent_amount: 1, rent_currency: 'USD', deposit_amount: 1, collect_day: 1, notes: null, tenant: null };
  const b = { ...a, id: 'b', start_date: '2026-03-01', end_date: '2027-03-01' };
  const o = findItems(base({ properties: [prop('p1', { status: 'rented', leases: [a, b] })] })).find((i) => i.key === 'lease_overlap')!;
  assert.deepEqual(o.fixes, [{ kind: 'close-lease', leaseId: 'a', endDate: '2026-02-28' }]);
});

test('a sold property is checked only for an active lease', () => {
  assert.deepEqual(keys(base({ properties: [prop('p1', { status: 'sold', sqm: null, floor: null })] })), []);
});
