import { strict as assert } from 'node:assert';
import { test } from 'node:test';
import { appPath, fixLinkOk, namedLink, splitLinks } from './links.ts';

test('addresses in text become links, without the sentence punctuation', () => {
  assert.deepEqual(splitLinks('ראו https://drive.google.com/x?id=1. ותודה'), [
    { text: 'ראו ' }, { url: 'https://drive.google.com/x?id=1' }, { text: '. ותודה' },
  ]);
  assert.deepEqual(splitLinks('בלי קישור'), [{ text: 'בלי קישור' }]);
  assert.equal(splitLinks('a https://a.b c http://d.e').filter((p) => 'url' in p).length, 2);
});

test('a fix link is a web address or a page of the app', () => {
  assert.ok(fixLinkOk('https://drive.google.com/file/d/1'));
  assert.ok(fixLinkOk('/clients/abc'));
  assert.ok(!fixLinkOk('javascript:alert(1)'));
  assert.ok(!fixLinkOk('drive.google.com'));
  assert.equal(appPath('https://seethefuture-office.pages.dev/properties/1', 'https://seethefuture-office.pages.dev'), '/properties/1');
});

test('a link can carry a name instead of its address', () => {
  assert.deepEqual(splitLinks('ראו [החוזה](https://drive.google.com/x) ו-[הלקוח](/clients/1).'), [
    { text: 'ראו ' }, { url: 'https://drive.google.com/x', label: 'החוזה' }, { text: ' ו-' },
    { url: '/clients/1', label: 'הלקוח' }, { text: '.' },
  ]);
  assert.deepEqual(splitLinks('[x](javascript:alert(1))'), [{ text: '[x](javascript:alert(1))' }]);
  assert.equal(namedLink('החוזה [חדש]', ' https://a.b/c '), '[החוזה חדש](https://a.b/c)');
  assert.equal(namedLink('', 'https://a.b'), 'https://a.b');
});
