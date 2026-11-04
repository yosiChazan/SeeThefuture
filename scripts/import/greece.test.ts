import { strict as assert } from 'node:assert';
import { test } from 'node:test';
import { greekUnit, proposeMatch } from './greece.ts';

test('Greek apartments: building, apartment and floor from the address', () => {
  assert.deepEqual(greekUnit('BODA 3A', 'BODA'), { building: 'Boda', unit: '3A', floor: '3' });
  assert.deepEqual(greekUnit('BODA gf2', 'BODA'), { building: 'Boda', unit: 'GF2', floor: '0' });
  assert.deepEqual(greekUnit('BODA BASEMENTS', 'BODA'), { building: 'Boda', unit: 'BASEMENTS', floor: '-1' });
  assert.deepEqual(greekUnit('2TH FLOOR FRONT', 'AKADIMOS'), { building: 'Akadimos', unit: '2 FRONT', floor: '2' });
  assert.deepEqual(greekUnit('BASMENT ', 'AKADIMOS'), { building: 'Akadimos', unit: 'B', floor: '-1' });
  assert.deepEqual(greekUnit('GROUND FLOOR FRONT', 'AKADIMOS'), { building: 'Akadimos', unit: 'G FRONT', floor: '0' });
  assert.deepEqual(greekUnit('Feron 13', null), { building: 'Feron 13', unit: 'ללא מספר' });
  assert.deepEqual(greekUnit('Derigny 40A', null), { building: 'Derigny 40a', unit: 'ללא מספר' });
  assert.deepEqual(greekUnit('SONERIOU B', null), { building: 'Soneriou', unit: 'B' });
  assert.deepEqual(greekUnit('ARISTOTELOUS', null), { building: 'Aristotelous', unit: 'ללא מספר' });
});

test('a person matches an existing party by two shared words, never by one', () => {
  const parties = [
    { id: 'a', display_name: 'דנה לוי', spellings: ['LEVI DANA'] },
    { id: 'b', display_name: 'Levi Moshe', spellings: [] },
  ];
  assert.equal(proposeMatch('LEVI  DANA ', parties), 'a');
  assert.equal(proposeMatch('LEVI RUTH', parties), null);
  assert.equal(proposeMatch('Moshe Levi', parties), 'b');
  const family = [
    { id: 'pair', display_name: 'זוג', spellings: ['Moshe Katz&Dana Shteinberg'] },
    { id: 'dana', display_name: 'דנה', spellings: ['Dana Shteinberg'] },
    { id: 'ruth', display_name: 'רות', spellings: ['Ruth Shtienberg'] },
  ];
  assert.equal(proposeMatch('SHTEINBERG DANA', family), 'dana');
  assert.equal(proposeMatch('SHTEINBERG RUTH', family), 'ruth');
  assert.equal(proposeMatch('SHTEINBERG NOA', family), null);
});
