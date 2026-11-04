import { strict as assert } from 'node:assert';
import { test } from 'node:test';
import { appPath, fixLinkOk, splitLinks } from './links.ts';

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
