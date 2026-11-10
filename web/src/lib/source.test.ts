import { strict as assert } from 'node:assert';
import { test } from 'node:test';
import { sourceInfo } from './source.ts';

test('where a transaction came from, with a link', () => {
  assert.deepEqual(sourceInfo('report:b1'), { kind: 'report', label: 'דוח', href: '/intake/b1', detail: 'נקלט מדוח במסך הקליטה' });
  assert.equal(sourceInfo('airtable:appX/tblY/recZ').href, 'https://airtable.com/appX/tblY/recZ');
  assert.equal(sourceInfo('airtable:appX/tblY/recZ#fee').detail, 'דמי הניהול שבשורה ב-Airtable');
  assert.equal(sourceInfo('airtable:appX/tblY').href, 'https://airtable.com/appX/tblY');
  assert.equal(sourceInfo('excel:גרשון').detail, 'גרשון');
  assert.equal(sourceInfo(null, 'b2').href, '/intake/b2');
  assert.equal(sourceInfo('manual').label, 'ידני');
  assert.equal(sourceInfo(undefined).kind, 'unknown');
});
