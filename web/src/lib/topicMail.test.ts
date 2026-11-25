import { strict as assert } from 'node:assert';
import { test } from 'node:test';
import { gmailLink, siteName, topicMail, topicMailHtml } from './topicMail.ts';

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

test('the topic e-mail with real links: names instead of addresses', () => {
  const html = topicMailHtml({
    title: 'נכס <4>', notes: 'בדוחות: https://app.test/intake/1 ובדרייב: https://drive.google.com/x.\nו-[החוזה](https://a.b/c)', fixUrl: '/properties',
    to: 'דנה', from: 'יוסי', origin: 'https://app.test',
  });
  assert.ok(html.includes('<b>נכס &lt;4&gt;</b>'));
  assert.ok(html.includes('<a href="https://app.test/intake/1">קישור במערכת</a>'));
  assert.ok(html.includes('<a href="https://drive.google.com/x">Google Drive</a>.<br>'));
  assert.ok(html.includes('<a href="https://a.b/c">החוזה</a>'));
  assert.ok(html.includes('<a href="https://app.test/properties">קישור לתיקון</a>'));
  assert.ok(html.includes('>לצפייה, לתשובה ולסימון &quot;בוצע&quot;</a>'));
  assert.equal(siteName('https://airtable.com/app1', 'o'), 'Airtable');
  assert.ok(!gmailLink('a@b.c', 's').includes('body='));
});
