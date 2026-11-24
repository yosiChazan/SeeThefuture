import { strict as assert } from 'node:assert';
import { test } from 'node:test';
import { parseWaExport, senders } from './waExport.ts';

test('Android export, Hebrew, with a multi-line message and an attachment', () => {
  const raw = [
    '23.11.2026, 14:05 - ההודעות והשיחות מוצפנות מקצה לקצה.',
    '23.11.2026, 14:05 - דנה כהן: שלום, שאלה על הדירה',
    'שורה שנייה',
    '23.11.2026, 14:07 - לראות את העתיד: היי דנה',
    '‎23.11.2026, 14:08 - דנה כהן: ‎IMG-20261123-WA0001.jpg (קובץ מצורף)',
  ].join('\n');
  const m = parseWaExport(raw);
  assert.equal(m.length, 3);
  assert.equal(m[0].sender, 'דנה כהן');
  assert.equal(m[0].text, 'שלום, שאלה על הדירה\nשורה שנייה');
  assert.equal(m[0].at.getHours(), 14);
  assert.equal(m[0].at.getMonth(), 10);
  assert.equal(m[2].file, 'IMG-20261123-WA0001.jpg');
  assert.deepEqual(senders(m).map((s) => s.name), ['דנה כהן', 'לראות את העתיד']);
});

test('iOS export with seconds, slashes and an attachment', () => {
  const raw = '[1/2/26, 9:03:44 PM] Dana: Hello\n[1/2/26, 21:04:00] See the Future: ‎<attached: 00000012-PHOTO-2026-02-01.jpg>';
  const m = parseWaExport(raw);
  assert.equal(m.length, 2);
  assert.equal(m[0].at.getFullYear(), 2026);
  assert.equal(m[0].at.getDate(), 1);
  assert.equal(m[0].at.getMonth(), 1);
  assert.equal(m[0].at.getHours(), 21);
  assert.equal(m[1].file, '00000012-PHOTO-2026-02-01.jpg');
  assert.equal(m[1].text, '');
});
