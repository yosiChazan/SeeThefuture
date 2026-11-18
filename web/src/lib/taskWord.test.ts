import { strict as assert } from 'node:assert';
import { test } from 'node:test';
import { mhtml, taskWord } from './taskWord.ts';

test('a task as a Word document: right to left, links clickable, replies as a tree', () => {
  const html = taskWord({
    subject: 'חוזה <חדש>', status: 'מוען', priority: 'גבוהה', trigger: 'חודשי', category: null, series: null, author: 'יוסי', created: '01.11.2026',
    body: 'ראו [החוזה](https://x.y/z) ו-/tasks', links: ['נכס 12'], assignees: ['דנה'], openBranches: 1,
    replies: [{ who: 'דנה', at: '02.11', body: 'בדקתי', edited: true, files: 2, open: false, resolved: null,
      children: [{ who: 'יוסי', at: '03.11', body: 'תודה', edited: false, files: 0, open: true, resolved: null, children: [] }] }],
    history: [{ who: 'יוסי', what: 'פתח/ה את המשימה', at: '01.11', body: null }],
  }, 'https://app');
  assert.ok(html.includes('dir="rtl"') && html.includes('חוזה &lt;חדש&gt;'));
  assert.ok(html.includes('<a href="https://x.y/z">החוזה</a>'));
  assert.ok(html.includes('2 תמונות לא נטענו') && html.includes('נערך') && html.includes('בטיפול'));
  assert.ok(html.indexOf('בדקתי') < html.indexOf('תודה'));
});

test('the pictures go inside the file', () => {
  const html = taskWord({ subject: 's', status: 'a', priority: 'b', trigger: null, category: null, series: null, author: 'x', created: 'd', body: null, links: [], assignees: [], openBranches: 0, history: [],
    replies: [{ who: 'x', at: 'd', body: null, edited: false, files: 1, images: ['file:///C:/img1.png'], open: true, resolved: null, children: [] }] }, 'https://app');
  assert.ok(html.includes('<img src="file:///C:/img1.png"') && !html.includes('לא נטענו'));
  const m = mhtml(html, [{ name: 'img1.png', type: 'image/png', base64: 'AAAA' }]);
  assert.ok(m.startsWith('MIME-Version: 1.0') && m.includes('Content-Location: file:///C:/img1.png') && m.trim().endsWith('--'));
});
