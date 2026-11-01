import { strict as assert } from 'node:assert';
import { test } from 'node:test';
import { fullName, suggestSplit } from './names.ts';

// Made-up names.
test('the last word is the family name', () => {
  assert.deepEqual(suggestSplit('ישראל ישראלי'), { first: 'ישראל', last: 'ישראלי', sure: true });
  assert.deepEqual(suggestSplit('שרה  מלכה כהן '), { first: 'שרה מלכה', last: 'כהן', sure: true });
});

test('particles stay with the family name', () => {
  assert.deepEqual(suggestSplit('אסף בן יוסף'), { first: 'אסף', last: 'בן יוסף', sure: true });
  assert.deepEqual(suggestSplit('Dan van der Berg'), { first: 'Dan', last: 'van der Berg', sure: true });
});

test('names to check by hand', () => {
  assert.equal(suggestSplit('כהן').sure, false);
  assert.equal(suggestSplit('כהן').last, 'כהן');
  assert.equal(suggestSplit('יעל ורבקה לוי').sure, false);
  assert.equal(suggestSplit('ורד לוי').sure, true);   // a first name that starts with ו
  assert.equal(suggestSplit('אברהם יצחק יעקב לוי').sure, false);
});

test('the full name is first then last', () => {
  assert.equal(fullName(' ישראל ', 'ישראלי'), 'ישראל ישראלי');
  assert.equal(fullName('', 'כהן'), 'כהן');
});
