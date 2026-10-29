import { strict as assert } from 'node:assert';
import { test } from 'node:test';
import { parseRomanianAddress } from '../countries/romania.ts';
import { isCredentialColumn } from './csv.ts';
import { cleanName, nameKey, parseAmount, parseCurrency, parseDate, tokenSubset } from './parse.ts';

test('cleanName strips Airtable quoting, newlines and bidi marks', () => {
  assert.equal(cleanName('"Chaya Hirshman \n"'), 'Chaya Hirshman');
  assert.equal(cleanName('⁦+972 54-482-2677⁩'), '+972 54-482-2677');
});

test('nameKey ignores word order and case', () => {
  assert.equal(nameKey('Sheinberger Yaakov'), nameKey('YAAKOV SHEINBERGER'));
  assert.notEqual(nameKey('Yaakov Sheinberger'), nameKey('Yaakov Mendelbaum'));
});

test('tokenSubset spots shortened names', () => {
  assert.ok(tokenSubset(nameKey('Ayala Ravina'), nameKey('Ayala Malka Ravina')));
  assert.ok(!tokenSubset(nameKey('Ayala Ravina'), nameKey('Ayala Ravina')));
});

test('parseDate reads d/m/yyyy only', () => {
  assert.equal(parseDate('3/2/2021'), '2021-02-03');
  assert.equal(parseDate('25/12/2021'), '2021-12-25');
  assert.equal(parseDate('9/30/2026 12:00am'), undefined);
  assert.equal(parseDate(''), undefined);
});

test('parseAmount handles currency prefixes and thousands separators', () => {
  assert.equal(parseAmount('$56960'), 56960);
  assert.equal(parseAmount('UAH6000'), 6000);
  assert.equal(parseAmount('1,878.60 RON'), 1878.6);
  assert.equal(parseAmount('NaN'), undefined);
});

test('parseCurrency maps Hebrew and code names', () => {
  assert.equal(parseCurrency('גריבנה'), 'UAH');
  assert.equal(parseCurrency('דולר'), 'USD');
  assert.equal(parseCurrency('ש"ח '), 'ILS');
  assert.equal(parseCurrency('ron'), 'RON');
});

test('Romanian addresses keep split-apartment parts in the unit', () => {
  assert.deepEqual(parseRomanianAddress('Alexandru Beldiman 1, 3rd floor, Apt 31- (BIG)'),
    { street: 'Alexandru Beldiman 1', floor: '3', unitNo: '31-BIG' });
  assert.equal(parseRomanianAddress('Boteanu 3A, Apt 32 - LOT 1 - Big - ').unitNo, '32-LOT1-BIG');
  assert.equal(parseRomanianAddress('Boteanu 3A, 32 - LOT 3 - Small').unitNo, '32-LOT3-SMALL');
  assert.equal(parseRomanianAddress('Vasile Lascar 6, 5th floor, Apt 6 (1)').unitNo, '6-1');
  assert.equal(parseRomanianAddress('Mircea Vulcanescu').unitNo, undefined);
});

test('credential columns are recognised', () => {
  for (const h of ['password', 'סיסמא ', 'קוד סודי אשראי', '3 digit', 'pin', 'מספר כרטיס', 'מספר סים',
    'Internet User and password', 'סיסמה לאימיל שפתחנו ללקוח לבנק', 'מייל מקושר לאליאנס']) {
    assert.ok(isCredentialColumn(h), h);
  }
  for (const h of ['Name', 'Owner', 'Building', 'Phone number', 'Account NO', 'Apartment number']) {
    assert.ok(!isCredentialColumn(h), h);
  }
});
