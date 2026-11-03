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

test('payment rows keep the dollar value only beside another currency', async () => {
  const { paymentValues } = await import('./ukraine_kyiv.ts');
  const [uah, usd] = paymentValues('p1', [
    { date: '2025-07-17', amount: 391940, currency: 'UAH', usd: 9374.04, kind: 'payment', label: 'תשלום שלישי' },
    { date: null, amount: 1500, currency: 'USD', usd: 1500, kind: 'fee', label: '' },
  ]);
  assert.match(uah, /391940::numeric, 'UAH'::app.currency, 9374.04::numeric/);
  assert.match(usd, /'USD'::app.currency, null::numeric, null, 'drive_kyiv:p1:2'/);
  assert.throws(() => paymentValues('p1', [{ date: null, amount: 1, currency: 'USD', usd: null, kind: 'gift', label: '' }]));
});
