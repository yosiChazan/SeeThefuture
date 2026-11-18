import { strict as assert } from 'node:assert';
import { test } from 'node:test';
import { strFromU8, unzipSync } from 'fflate';
import { taskDocx, taskDocxParts } from './taskWord.ts';

const base = { status: 'a', priority: 'b', trigger: null, category: null, series: null, author: 'x', created: 'd', body: null, links: [], assignees: [], openBranches: 0, history: [] };

test('a task as a Word document: right to left, links clickable, replies as a tree', () => {
  const parts = taskDocxParts({
    ...base, subject: 'חוזה <חדש>', status: 'מוען', priority: 'גבוהה', trigger: 'חודשי', author: 'יוסי', created: '01.11.2026',
    body: 'ראו [החוזה](https://x.y/z) ו-/tasks', links: ['נכס 12'], assignees: ['דנה'], openBranches: 1,
    replies: [{ who: 'דנה', at: '02.11', body: 'בדקתי', edited: true, files: 2, open: false, resolved: null,
      children: [{ who: 'יוסי', at: '03.11', body: 'תודה', edited: false, files: 0, open: true, resolved: null, children: [] }] }],
    history: [{ who: 'יוסי', what: 'פתח/ה את המשימה', at: '01.11', body: null }],
  }, 'https://app');
  const doc = strFromU8(parts['word/document.xml']);
  const rels = strFromU8(parts['word/_rels/document.xml.rels']);
  assert.ok(doc.includes('<w:bidi/>') && doc.includes('חוזה &lt;חדש&gt;'));
  assert.ok(doc.includes('<w:hyperlink r:id=') && rels.includes('Target="https://x.y/z" TargetMode="External"'));
  assert.ok(doc.includes('2 תמונות לא נטענו') && doc.includes('נערך') && doc.includes('בטיפול'));
  assert.ok(doc.indexOf('בדקתי') < doc.indexOf('תודה'));
});

test('the pictures go inside the file', () => {
  const bytes = new Uint8Array([137, 80, 78, 71]);
  const file = taskDocx({ ...base, subject: 's',
    replies: [{ who: 'x', at: 'd', body: null, edited: false, files: 1, images: ['p1'], open: true, resolved: null, children: [] }] },
    'https://app', [{ name: 'p1', ext: 'png', bytes, width: 800, height: 400 }]);
  const z = unzipSync(file);
  const doc = strFromU8(z['word/document.xml']);
  assert.deepEqual([...z['word/media/image1.png']], [...bytes]);
  assert.ok(strFromU8(z['[Content_Types].xml']).includes('Extension="png"'));
  assert.ok(doc.includes('<a:blip r:embed=') && !doc.includes('לא נטענו'));
  assert.ok(doc.includes('cx="4572000" cy="2286000"'));   // scaled to the page, same proportions
});
