import { strict as assert } from 'node:assert';
import { test } from 'node:test';
import { mergeNotes } from './ukraine_kyiv.ts';

test('the Kyiv section is appended once and replaced on a re-run', () => {
  const first = mergeNotes('דמי תיווך: 3,000$', ['שולם: 100$']);
  assert.equal(first, 'דמי תיווך: 3,000$\n\n— מהקבצים של קייב (Drive) —\nשולם: 100$');
  assert.equal(mergeNotes(first, ['שולם: 200$']), 'דמי תיווך: 3,000$\n\n— מהקבצים של קייב (Drive) —\nשולם: 200$');
  assert.equal(mergeNotes(null, []), null);
  assert.equal(mergeNotes(first, []), 'דמי תיווך: 3,000$');
});
