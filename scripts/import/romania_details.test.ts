import { strict as assert } from 'node:assert';
import { test } from 'node:test';
import { billAmount } from './romania_details.ts';

test('a bill amount comes from the first field that has one', () => {
  assert.deepEqual(billAmount({ 'Amount Euro': 52.4, 'Amount ron': 260 }), [52.4, 'EUR']);
  assert.deepEqual(billAmount({ 'Amount Euro': { specialValue: 'NaN' }, 'Amount ron': 260 }), [260, 'RON']);
  assert.deepEqual(billAmount({ 'Amount Euro': 0, 'monthly anount- EURO': '1.234,56 lei' }), [1234.56, 'RON']);
  assert.deepEqual(billAmount({ 'monthly anount- EURO': '87,5 Lei' }), [87.5, 'RON']);
  assert.deepEqual(billAmount({ 'monthly anount- EURO': '450' }), [450, 'EUR']);
  assert.deepEqual(billAmount({ 'what amount paid ron': 310 }), [310, 'RON']);
  assert.deepEqual(billAmount({ Type: 'rent', 'Monthly Price - Euro (from Lease Agreement)': [600] }), [600, 'EUR']);
  assert.deepEqual(billAmount({ Type: 'gas', 'Monthly Price - Euro (from Lease Agreement)': [600] }), [null, null]);
  assert.deepEqual(billAmount({ 'monthly anount- EURO': 'בניהול אופיר' }), [null, null]);
  assert.deepEqual(billAmount({}), [null, null]);
});
