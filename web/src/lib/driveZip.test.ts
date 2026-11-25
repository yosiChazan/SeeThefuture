import { strict as assert } from 'node:assert';
import { test } from 'node:test';
import { docTypeFor, folderGroup, foldersOf, groupByFolder, matchFolder, parseFolder, pathKey, skipReason } from './driveZip.ts';

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
  assert.equal(skipReason({ path: 'דירה/סרטון.mp4', size: 1 }), null);
  assert.equal(docTypeFor('דירה/תמונות/a.MP4'), 'photo');
  assert.equal(skipReason({ path: 'דירה/a.pdf', size: 600 * 1024 * 1024 }), null);
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
  assert.equal(groupOf('payment_proof'), 'receipts');
  assert.equal(typeInGroup('receipts', 'attachment'), 'receipt');
  assert.equal(docTypeFor('דירה/קבלה חשמל.pdf'), 'receipt');
  assert.equal(groupOf('lease_contract'), 'other');
  assert.equal(typeInGroup('purchase', 'land_registry'), 'land_registry');
  assert.equal(typeInGroup('purchase', 'attachment'), 'purchase_contract');
  assert.equal(typeInGroup('plans', 'photo'), 'floor_plan');
  assert.equal(typeInGroup('other', 'bank_document'), 'bank_document');
  assert.equal(typeInGroup('other', 'photo'), 'attachment');
  assert.equal(isSensitive('photo'), false);
  assert.equal(isSensitive('bank_document'), true);
});

test('categories added in Settings are groups of their own', async () => {
  const { buildGroups, groupOf, typeInGroup, isSensitive, typeLabel } = await import('./fileGroups.ts');
  const g = buildGroups([{ id: 'p1', label: 'היתרים', sensitive: false, position: 1 }]);
  assert.equal(g.at(-1)!.key, 'other');
  assert.equal(groupOf('cat:p1', g), 'cat:p1');
  assert.equal(typeInGroup('cat:p1', 'land_registry', g), 'cat:p1');
  assert.equal(isSensitive('cat:p1', g), false);
  assert.equal(typeLabel('cat:p1', g), 'היתרים');
  assert.equal(groupOf('cat:gone', g), 'other');
});

test('a property ZIP: every folder at every depth, under its root, and the group its name says', async () => {
  const { FILE_GROUPS } = await import('./fileGroups.ts');
  const f = foldersOf(['דירה 1/מסמכי רכישה ובעלות _/a.pdf', 'דירה 1/מסמכי רכישה ובעלות _/נוספים 6.9/b.pdf', 'דירה 1/תמונות /c.mp4', 'דירה 1/d.pdf']);
  assert.deepEqual([...f.keys()], ['(בלי תיקייה)', 'מסמכי רכישה ובעלות _', 'מסמכי רכישה ובעלות _ / נוספים 6.9', 'תמונות']);
  assert.equal(folderGroup('מסמכי רכישה ובעלות _', FILE_GROUPS), 'purchase');
  assert.equal(folderGroup('מסמכי רכישה ובעלות _ / נוספים 6.9', FILE_GROUPS), 'purchase');
  assert.equal(folderGroup('תמונות', FILE_GROUPS), 'photos');
  assert.equal(folderGroup('קבלות חשמל', FILE_GROUPS), 'receipts');
  assert.equal(folderGroup('שונות', FILE_GROUPS), null);
  assert.equal(folderGroup('מסמכי רכישה ובעלות _ / מסמכים נוספים מ-6.9', FILE_GROUPS), 'purchase');
  assert.equal(folderGroup('מסמכים נוספים', FILE_GROUPS), 'other');
  assert.deepEqual([...foldersOf(['a.pdf', 'b.pdf']).keys()], ['(בלי תיקייה)']);
});
