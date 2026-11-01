import { strict as assert } from 'node:assert';
import { test } from 'node:test';
import { findIdNumbers, validIsraeliId } from './idnumber.ts';

// Made-up numbers that pass the check digit; none is a real person's.
test('Israeli ID check digit', () => {
  assert.ok(validIsraeliId('123456782'));
  assert.ok(validIsraeliId('000000018'));
  assert.ok(validIsraeliId('18'.padStart(9, '0')));
  assert.ok(!validIsraeliId('123456789'));
  assert.ok(!validIsraeliId('000000000'));
  assert.ok(!validIsraeliId('12345678901'));
});

test('ID card text: the labelled number, split or whole', () => {
  const card = 'מדינת ישראל\nתעודת זהות\nמס\' זהות 1 2345678 2\nשם משפחה ישראלי\nתאריך 12.03.1980';
  assert.deepEqual(findIdNumbers(card).map((c) => [c.id, c.how]), [['123456782', 'label']]);
  const invalid = 'מס\' זהות 123456789';
  assert.deepEqual(findIdNumbers(invalid), []);
});

test('passport MRZ: the personal number, not the passport number', () => {
  // Passport number 123456782 passes the check digit too: it must not be taken as the ID.
  const mrz = [
    'P<ISRISRAELI<<YOSEF<<<<<<<<<<<<<<<<<<<<<<<<<',
    '1234567820ISR8003125M3001017000000018<<<<<06',
  ].join('\n');
  const found = findIdNumbers(mrz);
  assert.equal(found[0].id, '000000018');
  assert.equal(found[0].how, 'mrz');
});

test('OCR noise in the MRZ: O for 0, spaces', () => {
  const mrz = 'P<ISRISRAELI<<YOSEF\n1234567820 ISR8003125M300101 7OOOOOOO18<<<<<06';
  assert.equal(findIdNumbers(mrz)[0]?.id, '000000018');
});

test('bare nine digits rank below labelled ones', () => {
  const text = 'Ref 123456782\nIdentity No. 000000026';
  assert.deepEqual(findIdNumbers(text).map((c) => c.id), ['000000026', '123456782']);
});
