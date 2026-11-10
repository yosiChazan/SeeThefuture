import { strict as assert } from 'node:assert';
import { test } from 'node:test';
import { describeEvent, filterTasks, nextOccurrence, openByAssignee, recurrenceText, seriesOn, sortTasks, taskMail, type OfficeTask } from './officeTasks.ts';

const t = (id: string, o: Partial<OfficeTask>): OfficeTask => ({
  id, created_by: 'u0', created_at: '2026-11-01', updated_at: '2026-11-01', trigger_id: 'g1', subject: id, body: null,
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
  const rank = (id: string | null | undefined) => ({ c1: 1, c2: 2 }[id ?? ''] ?? 99);
  assert.deepEqual(sortTasks([{ ...a, category_id: 'c2' }, { ...b, category_id: null }, { ...c, category_id: 'c1' }], 'category', name, { category: rank }).map((x) => x.id), ['ג', 'ב', 'א']);
  assert.deepEqual(sortTasks([{ ...a, trigger_id: 'g0' }, { ...b, trigger_id: 'g1' }, c], 'trigger', name, { trigger: (id) => ({ g0: 0, g1: 1 }[id ?? ''] ?? 9) }).map((x) => x.id), ['ב', 'א', 'ג']);
  assert.deepEqual([...openByAssignee([a, b, { ...c, status: 'done', office_task_assignees: [{ user_id: 'x', party_id: null }] }])], [['u:x', 1], ['u:y', 1]]);
});

test('the history in words, and the e-mail', () => {
  const ev = (kind: string, data: Record<string, unknown>) => ({ id: '1', task_id: 't', kind, body: null, data, created_by: null, created_at: '' });
  const who = () => 'דנה', link = () => 'נכס 12';
  assert.equal(describeEvent(ev('status', { from: 'assigned', to: 'done' }), who, link), 'שינה/תה את המצב: מוען ← טופל');
  assert.equal(describeEvent(ev('change', { priority: ['low', 'high'], body: ['a', 'b'] }), who, link), 'העדיפות: "נמוכה" ← "גבוהה" · שינה/תה את התוכן');
  assert.equal(describeEvent(ev('assign', { user_id: 'x' }), who, link), 'העביר/ה לטיפול של דנה');
  const m = taskMail({ id: 'abc', subject: 'חוזה', body: 'ראו [החוזה](https://x.y/z)', priority: 'high', trigger: 'חודשי' }, 'דנה', 'יוסי', 'https://app');
  assert.equal(m.subject, 'משימה: חוזה');
  assert.ok(m.body.includes('החוזה: https://x.y/z') && m.body.includes('https://app/tasks?task=abc') && m.body.includes('עדיפות: גבוהה · חודשי'));
});

test('when a recurring task falls', () => {
  const r = { workdays_only: false, weekday: null, month_days: [] as number[], last_day: false, year_dates: [] as string[] };
  const monthly31 = { ...r, frequency: 'monthly' as const, month_days: [31], start_on: '2026-01-01', end_on: null };
  assert.equal(nextOccurrence(monthly31, '2026-02-01'), '2026-02-28');
  assert.equal(nextOccurrence({ ...r, frequency: 'daily', workdays_only: true, start_on: '2026-01-01', end_on: null }, '2026-03-06'), '2026-03-08');
  assert.equal(nextOccurrence({ ...r, frequency: 'yearly', year_dates: ['02-29'], start_on: '2026-01-01', end_on: null }, '2026-03-01'), '2027-02-28');
  assert.equal(nextOccurrence({ ...r, frequency: 'weekly', weekday: 0, start_on: '2026-01-01', end_on: '2026-03-07' }, '2026-03-02'), null);
  assert.ok(seriesOn({ ...r, frequency: 'monthly', last_day: true }, '2026-04-30'));
  const many = { ...r, frequency: 'monthly' as const, month_days: [15, 1], last_day: true, start_on: '2026-04-01', end_on: null };
  assert.equal(nextOccurrence(many, '2026-04-02'), '2026-04-15');
  assert.equal(nextOccurrence(many, '2026-04-16'), '2026-04-30');
  assert.equal(recurrenceText({ ...many, lead_days: 0 }), 'כל חודש, ב-1 וב-15 וביום האחרון');
  assert.equal(recurrenceText({ ...r, frequency: 'yearly', year_dates: ['09-30', '03-31'], lead_days: 0 }), 'כל שנה, ב-31 במרץ וב-30 בספטמבר');
  assert.equal(recurrenceText({ ...r, frequency: 'weekly', weekday: 0, lead_days: 2 }), 'כל שבוע, ביום ראשון · מופיעה 2 ימים לפני');
});

test('filters: by field, several values are any of them, several filters all hold', () => {
  const a = t('a', { category_id: 'c1', trigger_id: 'g1', priority: 'high', created_at: '2026-11-01', office_task_assignees: [{ user_id: 'me', party_id: null }] });
  const b = t('b', { category_id: 'c2', trigger_id: null, priority: 'low', created_at: '2026-11-08', subject: 'חוזה שכירות' });
  const c = t('c', { category_id: null, trigger_id: 'g1', priority: 'high', created_by: 'me', created_at: '2026-11-09' });
  const ids = (f: Parameters<typeof filterTasks>[1]) => filterTasks([a, b, c], f, 'me').map((x) => x.id).join('');
  assert.equal(ids([{ field: 'category', values: ['c1', 'none'] }]), 'ac');
  assert.equal(ids([{ field: 'category', values: ['c1', 'none'] }, { field: 'trigger', values: ['g1'] }, { field: 'priority', values: ['high'] }]), 'ac');
  assert.equal(ids([{ field: 'trigger', values: ['none'] }]), 'b');
  assert.equal(ids([{ field: 'assignee', values: ['mine'] }]), 'a');
  assert.equal(ids([{ field: 'assignee', values: ['sent', 'none'] }]), 'bc');
  assert.equal(ids([{ field: 'subject', values: ['שכירות'] }]), 'b');
  assert.equal(ids([{ field: 'created', values: ['2026-11-05', ''] }]), 'bc');
  assert.equal(ids([{ field: 'created', values: ['', '2026-11-08'] }, { field: 'priority', values: [] }]), 'ab');
});
