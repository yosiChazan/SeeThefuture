import { strict as assert } from 'node:assert';
import { test } from 'node:test';
import { taskWord } from './taskWord.ts';

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
  assert.ok(html.includes('2 תמונות מצורפות') && html.includes('נערך') && html.includes('בטיפול'));
  assert.ok(html.indexOf('בדקתי') < html.indexOf('תודה'));
});
