import { strict as assert } from 'node:assert';
import { test } from 'node:test';
import { docTypeFor, groupByFolder, matchFolder, parseFolder, pathKey, skipReason } from './driveZip.ts';

test('building and apartment from the folder name, in any order', () => {
  assert.deepEqual(parseFolder('דירה לוי 19 בנין2.2 LAKE CITY קייב'), { building: '2.2', unit: '19' });
  assert.deepEqual(parseFolder('דירה כהן בנין 2 דירה 25 PLC'), { building: '2', unit: '25' });
  assert.deepEqual(parseFolder('דירה 9 בניין 5 משה כהן LAKE CITY'), { building: '5', unit: '9' });
  assert.deepEqual(parseFolder('דירה כהן אליעזר20 בנין 5 PLC'), { building: '5', unit: '20' });
  assert.deepEqual(parseFolder('תמונות וסרטונים'), { building: undefined, unit: undefined });
});

test('a folder matches one apartment; the owner in its name makes it sure', () => {
  const t = [
    { id: 'a', building: '2.2', unit: '19', owners: ['דנה לוי'] },
    { id: 'b', building: '2.4', unit: '19', owners: ['משה כהן'] },
  ];
  assert.deepEqual(matchFolder('דירה לוי 19 בנין2.2', t), { id: 'a', sure: true });
  assert.deepEqual(matchFolder('דירה 19 בנין 2.4', t), { id: 'b', sure: false });
  assert.deepEqual(matchFolder('דירה 19 בנין 3', t), { id: null, sure: false });
});

test('the ZIP root folder is dropped; files go by apartment folder', () => {
  const g = groupByFolder([{ path: 'פארק/דירה א/x.pdf', size: 1 }, { path: 'פארק/דירה א/sub/y.pdf', size: 1 }, { path: 'פארק/דירה ב/z.pdf', size: 1 }]);
  assert.deepEqual([...g.keys()], ['דירה א', 'דירה ב']);
  assert.equal(g.get('דירה א')![1].path, 'דירה א/sub/y.pdf');
});

test('bank account details, passwords, videos and huge files are not copied', () => {
  assert.ok(skipReason({ path: 'דירה/פרטי חשבון UKRGASBANK/a.pdf', size: 1 }));
  assert.ok(skipReason({ path: 'דירה/סיסמאות.txt', size: 1 }));
  assert.ok(skipReason({ path: 'דירה/סרטון.mp4', size: 1 }));
  assert.ok(skipReason({ path: 'דירה/a.pdf', size: 60 * 1024 * 1024 }));
  assert.equal(skipReason({ path: 'דירה/מסמכים לבנק/חוזה.pdf', size: 1 }), null);
});

test('the kind of document from its folder and name', () => {
  assert.equal(docTypeFor('דירה/ייפויי כוח לגרשון/a.pdf'), 'poa');
  assert.equal(docTypeFor('דירה/תשלומי רכישה/b.pdf'), 'payment_proof');
  assert.equal(docTypeFor('דירה/חוזה רכישה.pdf'), 'purchase_contract');
  assert.equal(docTypeFor('דירה/Passport.jpg'), 'passport');
  assert.equal(docTypeFor('דירה/x.pdf'), 'attachment');
  assert.equal(docTypeFor('דירה/שרטוט דירה.pdf'), 'floor_plan');
  assert.equal(pathKey('a/b'), pathKey('a/b'));
  assert.notEqual(pathKey('a/b'), pathKey('a/c'));
});

test('file groups: every type has one group, and a chosen group decides the type', async () => {
  const { groupOf, typeInGroup, isSensitive } = await import('./fileGroups.ts');
  assert.equal(groupOf('land_registry'), 'purchase');
  assert.equal(groupOf('lease_contract'), 'other');
  assert.equal(typeInGroup('purchase', 'land_registry'), 'land_registry');
  assert.equal(typeInGroup('purchase', 'attachment'), 'purchase_contract');
  assert.equal(typeInGroup('plans', 'photo'), 'floor_plan');
  assert.equal(typeInGroup('other', 'bank_document'), 'bank_document');
  assert.equal(typeInGroup('other', 'photo'), 'attachment');
  assert.equal(isSensitive('photo'), false);
  assert.equal(isSensitive('bank_document'), true);
});
