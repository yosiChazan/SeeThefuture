import { strict as assert } from 'node:assert';
import { test } from 'node:test';
import { gmailLink, topicMail } from './topicMail.ts';

test('the topic e-mail draft: plain links, the fix link and the way back to the topic', () => {
  const m = topicMail({
    title: 'חוזה דירה 5', notes: 'ראו [החוזה](https://drive.google.com/x) ו-[הלקוח](/clients/1)', fixUrl: '/properties/9',
    to: 'דנה', from: 'יוסי', origin: 'https://app.test',
  });
  assert.equal(m.subject, 'נושא חדש: חוזה דירה 5');
  assert.ok(m.body.startsWith('שלום דנה,'));
  assert.ok(m.body.includes('ראו החוזה: https://drive.google.com/x ו-הלקוח: https://app.test/clients/1'));
  assert.ok(m.body.includes('קישור לתיקון: https://app.test/properties/9'));
  assert.ok(m.body.includes('https://app.test/completeness?g=manual&q=' + encodeURIComponent('חוזה דירה 5')));
  assert.ok(!topicMail({ title: 'x', notes: null, fixUrl: null, to: 'a', from: 'b', origin: 'o' }).body.includes('לתיקון'));
  assert.ok(gmailLink('a@b.c', 's', 'b').includes('to=a%40b.c'));
});
