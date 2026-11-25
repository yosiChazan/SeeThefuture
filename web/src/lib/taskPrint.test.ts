import { strict as assert } from 'node:assert';
import { test } from 'node:test';
import { taskPrint } from './taskPrint.ts';

const base = { status: 'a', priority: 'b', trigger: null, category: null, series: null, author: 'x', created: 'd', body: null, links: [], assignees: [], openBranches: 0, history: [] };

test('a task as a page for PDF: right to left, links clickable, replies as a tree', () => {
  const html = taskPrint({
    ...base, subject: 'חוזה <חדש>', status: 'מוען', priority: 'גבוהה', trigger: 'חודשי', author: 'יוסי', created: '01.11.2026',
    body: 'ראו [החוזה](https://x.y/z) ו-/tasks', links: ['נכס 12'], assignees: ['דנה'], openBranches: 1,
    replies: [{ who: 'דנה', at: '02.11', body: 'בדקתי', edited: true, files: 2, open: false, resolved: null,
      children: [{ who: 'יוסי', at: '03.11', body: 'תודה', edited: false, files: 0, open: true, resolved: null, children: [] }] }],
    history: [{ who: 'יוסי', what: 'פתח/ה את המשימה', at: '01.11', body: null }],
  }, 'https://app');
  assert.ok(html.includes('dir="rtl"') && html.includes('<title>חוזה &lt;חדש&gt;</title>'));
  assert.ok(html.includes('<a href="https://x.y/z">החוזה</a>'));
  assert.ok(html.includes('2 תמונות לא נטענו') && html.includes('נערך') && html.includes('בטיפול'));
  assert.ok(html.indexOf('בדקתי') < html.indexOf('תודה'));
});

test('the pictures are on the page', () => {
  const html = taskPrint({ ...base, subject: 's',
    replies: [{ who: 'x', at: 'd', body: null, edited: false, files: 1, images: ['data:image/png;base64,AAAA'], open: true, resolved: null, children: [] }] }, 'https://app');
  assert.ok(html.includes('<img src="data:image/png;base64,AAAA">') && !html.includes('לא נטענו'));
});
