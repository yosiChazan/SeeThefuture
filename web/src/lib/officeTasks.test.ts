import { strict as assert } from 'node:assert';
import { test } from 'node:test';
import { describeEvent, openByAssignee, sortTasks, taskMail, type OfficeTask } from './officeTasks.ts';

const t = (id: string, o: Partial<OfficeTask>): OfficeTask => ({
  id, created_by: 'u0', created_at: '2026-11-01', updated_at: '2026-11-01', trigger_kind: 'client', subject: id, body: null,
  priority: 'medium', status: 'assigned', office_task_assignees: [], office_task_links: [], ...o,
});

test('tasks sort by date, priority, subject and by who handles them', () => {
  const a = t('ב', { priority: 'low', updated_at: '2026-11-05', office_task_assignees: [{ user_id: 'x', party_id: null }] });
  const b = t('א', { priority: 'high', updated_at: '2026-11-02', office_task_assignees: [{ user_id: 'y', party_id: null }] });
  const c = t('ג', { priority: 'medium', updated_at: '2026-11-09' });
  const name = (x: { user_id: string | null }) => ({ x: 'רונית', y: 'אבי' }[x.user_id ?? ''] ?? '');
  assert.deepEqual(sortTasks([a, b, c], 'updated', name).map((x) => x.id), ['ג', 'ב', 'א']);
  assert.deepEqual(sortTasks([a, b, c], 'priority', name).map((x) => x.id), ['א', 'ג', 'ב']);
  assert.deepEqual(sortTasks([a, b, c], 'subject', name).map((x) => x.id), ['א', 'ב', 'ג']);
  assert.deepEqual(sortTasks([a, b, c], 'assignee', name).map((x) => x.id), ['א', 'ב', 'ג']);
  assert.deepEqual([...openByAssignee([a, b, { ...c, status: 'done', office_task_assignees: [{ user_id: 'x', party_id: null }] }])], [['u:x', 1], ['u:y', 1]]);
});

test('the history in words, and the e-mail', () => {
  const ev = (kind: string, data: Record<string, unknown>) => ({ id: '1', task_id: 't', kind, body: null, data, created_by: null, created_at: '' });
  const who = () => 'דנה', link = () => 'נכס 12';
  assert.equal(describeEvent(ev('status', { from: 'assigned', to: 'done' }), who, link), 'שינה/תה את המצב: מוען ← טופל');
  assert.equal(describeEvent(ev('change', { priority: ['low', 'high'], body: ['a', 'b'] }), who, link), 'העדיפות: "נמוכה" ← "גבוהה" · שינה/תה את התוכן');
  assert.equal(describeEvent(ev('assign', { user_id: 'x' }), who, link), 'העביר/ה לטיפול של דנה');
  const m = taskMail({ id: 'abc', subject: 'חוזה', body: 'ראו [החוזה](https://x.y/z)', priority: 'high', trigger_kind: 'monthly' }, 'דנה', 'יוסי', 'https://app');
  assert.equal(m.subject, 'משימה: חוזה');
  assert.ok(m.body.includes('החוזה: https://x.y/z') && m.body.includes('https://app/tasks?task=abc') && m.body.includes('עדיפות: גבוהה · חודשי'));
});
