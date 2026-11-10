// Tasks (SPEC decisions 128–130): labels, sorting, the history in words, the e-mail to whoever
// a task is with, and when a recurring task falls. Pure, tested.

export type Priority = 'low' | 'medium' | 'high';
export type TaskStatus = 'assigned' | 'in_progress' | 'done';

// Triggers before they moved to Settings (decision 130), for the history of old changes.
const OLD_TRIGGER_HE: Record<string, string> = { management_meeting: 'ישיבת הנהלה', client: 'לקוח', system_issue: 'תקלה במערכת', monthly: 'חודשי' };
export const PRIORITY_HE: Record<Priority, string> = { low: 'נמוכה', medium: 'בינונית', high: 'גבוהה' };
export const PRIORITY_COLOR: Record<Priority, string> = { low: 'gray', medium: 'yellow', high: 'red' };
export const STATUS_HE: Record<TaskStatus, string> = { assigned: 'מוען', in_progress: 'בטיפול', done: 'טופל' };
export const STATUS_COLOR: Record<TaskStatus, string> = { assigned: 'blue', in_progress: 'orange', done: 'teal' };
const PRIORITY_RANK: Record<Priority, number> = { high: 0, medium: 1, low: 2 };
const FIELD_HE: Record<string, string> = { subject: 'הנושא', body: 'התוכן', priority: 'העדיפות', trigger_kind: 'הטריגר', trigger: 'הטריגר', category: 'הקטגוריה' };

export interface Assignee { id?: string; user_id: string | null; party_id: string | null }
export interface TaskLink { id?: string; kind: 'client' | 'property' | 'contact' | 'country'; entity_id: string | null; country_code: string | null }
export interface OfficeTask {
  id: string; created_by: string; created_at: string; updated_at: string; trigger_id: string | null; subject: string; body: string | null;
  priority: Priority; status: TaskStatus; category_id?: string | null; series_id?: string | null; occurrence_on?: string | null; office_task_assignees: Assignee[]; office_task_links: TaskLink[];
}
export interface TaskEvent { id: string; task_id: string; kind: string; body: string | null; data: Record<string, unknown> | null; created_by: string | null; created_at: string }

export type SortKey = 'updated' | 'created' | 'priority' | 'subject' | 'assignee' | 'trigger' | 'category';

export const assigneeKey = (a: Assignee) => (a.user_id ? `u:${a.user_id}` : `p:${a.party_id}`);

// Sorting the list. "By who handles it" orders by the first assignee's name; a task with
// no one comes last.
// "By trigger" and "by category" order by their place in Settings (`rank`); none comes last.
export function sortTasks(tasks: OfficeTask[], key: SortKey, nameOf: (a: Assignee) => string,
                          rank: { trigger?: (id: string | null | undefined) => number; category?: (id: string | null | undefined) => number } = {}): OfficeTask[] {
  const tr = rank.trigger ?? (() => 0), cr = rank.category ?? (() => 0);
  const first = (t: OfficeTask) => t.office_task_assignees.map(nameOf).sort((a, b) => a.localeCompare(b, 'he'))[0] ?? '￿';
  const by: Record<SortKey, (a: OfficeTask, b: OfficeTask) => number> = {
    updated: (a, b) => b.updated_at.localeCompare(a.updated_at),
    created: (a, b) => b.created_at.localeCompare(a.created_at),
    priority: (a, b) => PRIORITY_RANK[a.priority] - PRIORITY_RANK[b.priority] || b.updated_at.localeCompare(a.updated_at),
    subject: (a, b) => a.subject.localeCompare(b.subject, 'he'),
    assignee: (a, b) => first(a).localeCompare(first(b), 'he') || PRIORITY_RANK[a.priority] - PRIORITY_RANK[b.priority],
    trigger: (a, b) => tr(a.trigger_id) - tr(b.trigger_id) || PRIORITY_RANK[a.priority] - PRIORITY_RANK[b.priority],
    category: (a, b) => cr(a.category_id) - cr(b.category_id) || PRIORITY_RANK[a.priority] - PRIORITY_RANK[b.priority],
  };
  return [...tasks].sort(by[key]);
}

// How many open tasks each person has, for "by who handles it".
export function openByAssignee(tasks: OfficeTask[]): Map<string, number> {
  const out = new Map<string, number>();
  for (const t of tasks) if (t.status !== 'done') for (const a of t.office_task_assignees) out.set(assigneeKey(a), (out.get(assigneeKey(a)) ?? 0) + 1);
  return out;
}

// One line of the history in words. `who` names a person; `link` names a linked item.
export function describeEvent(e: TaskEvent, who: (a: Assignee) => string, link: (l: TaskLink) => string): string {
  const d = (e.data ?? {}) as Record<string, unknown>;
  switch (e.kind) {
    case 'created': return 'פתח/ה את המשימה';
    case 'reply': return 'ענה/תה';
    case 'status': return `שינה/תה את המצב: ${STATUS_HE[d.from as TaskStatus] ?? d.from} ← ${STATUS_HE[d.to as TaskStatus] ?? d.to}`;
    case 'assign': return `העביר/ה לטיפול של ${who(d as unknown as Assignee)}`;
    case 'unassign': return `הוציא/ה מהטיפול את ${who(d as unknown as Assignee)}`;
    case 'link': return `קישר/ה ל${link(d as unknown as TaskLink)}`;
    case 'unlink': return `הסיר/ה את הקישור ל${link(d as unknown as TaskLink)}`;
    case 'change': {
      const parts = Object.entries(d).map(([k, v]) => {
        const [from, to] = v as [string | null, string | null];
        const show = (x: string | null) => (k === 'priority' ? PRIORITY_HE[x as Priority] : k === 'trigger_kind' ? OLD_TRIGGER_HE[x ?? ''] ?? x : k === 'body' ? null : x) ?? '';
        return k === 'body' ? 'שינה/תה את התוכן' : `${FIELD_HE[k] ?? k}: "${show(from)}" ← "${show(to)}"`;
      });
      return parts.join(' · ');
    }
    default: return e.kind;
  }
}

// The e-mail to whoever the task is with: plain text, links as "name: address".
const NAMED = /\[([^\]\n]+)\]\((https?:\/\/[^\s)]+|\/[^\s)]*)\)/g;
export function taskMail(t: { subject: string; body: string | null; priority: Priority; id: string; trigger?: string | null },
                         to: string, from: string, origin: string): { subject: string; body: string } {
  const full = (u: string) => (u.startsWith('/') ? origin + u : u);
  const text = (t.body ?? '').trim().replace(NAMED, (_, n: string, u: string) => `${n}: ${full(u)}`);
  const lines = [
    `שלום ${to},`, '',
    `${from} העביר/ה אליך משימה: ${t.subject}`,
    `עדיפות: ${PRIORITY_HE[t.priority]}${t.trigger ? ` · ${t.trigger}` : ''}`,
    ...(text ? ['', text] : []),
    '', `למשימה, לתשובה ולעדכון המצב: ${origin}/tasks?task=${t.id}`, '', 'תודה',
  ];
  return { subject: `משימה: ${t.subject}`, body: lines.join('\n') };
}

// Recurring tasks (decision 130). The same rule as app.series_on: a day a month lacks (31 in a
// short month, 29 February) is the month's last day; "work days" are Sunday to Thursday.
export interface Series {
  id: string; created_by: string; active: boolean; subject: string; body: string | null; priority: Priority;
  category_id: string | null; trigger_id: string | null; users: string[]; parties: string[]; links: TaskLink[];
  frequency: 'daily' | 'weekly' | 'monthly' | 'yearly'; workdays_only: boolean; weekday: number | null; month_days: number[];
  last_day: boolean; year_dates: string[];   // year_dates: 'MM-DD'
  start_on: string; end_on: string | null; lead_days: number; last_spawned: string | null;
}
export const WEEKDAY_HE = ['ראשון', 'שני', 'שלישי', 'רביעי', 'חמישי', 'שישי', 'שבת'];
export const MONTH_HE = ['ינואר', 'פברואר', 'מרץ', 'אפריל', 'מאי', 'יוני', 'יולי', 'אוגוסט', 'ספטמבר', 'אוקטובר', 'נובמבר', 'דצמבר'];
type Rule = Pick<Series, 'frequency' | 'workdays_only' | 'weekday' | 'month_days' | 'last_day' | 'year_dates'>;

const iso = (d: Date) => d.toISOString().slice(0, 10);
const day = (s: string) => new Date(`${s}T00:00:00Z`);
const lastOfMonth = (d: Date) => new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth() + 1, 0)).getUTCDate();

export function seriesOn(s: Rule, on: string): boolean {
  const d = day(on), dow = d.getUTCDay(), dom = d.getUTCDate(), last = lastOfMonth(d);
  switch (s.frequency) {
    case 'daily': return !s.workdays_only || dow <= 4;
    case 'weekly': return dow === s.weekday;
    case 'monthly': return (s.last_day && dom === last) || s.month_days.some((x) => Math.min(x, last) === dom);
    case 'yearly': return s.year_dates.some((x) => Number(x.slice(0, 2)) === d.getUTCMonth() + 1 && Math.min(Number(x.slice(3)), last) === dom);
  }
}

// The next date a recurring task falls on, from `from` (inclusive); null when it ends first.
export function nextOccurrence(s: Rule & Pick<Series, 'start_on' | 'end_on'>, from: string): string | null {
  let d = day(from < s.start_on ? s.start_on : from);
  for (let i = 0; i < 400; i++, d = new Date(d.getTime() + 86400000)) {
    const on = iso(d);
    if (s.end_on && on > s.end_on) return null;
    if (seriesOn(s, on)) return on;
  }
  return null;
}

const list = (xs: string[]) => (xs.length <= 1 ? xs.join('') : `${xs.slice(0, -1).join(', ')} וב-${xs[xs.length - 1]}`);
export function recurrenceText(s: Rule & Pick<Series, 'lead_days'>): string {
  const base = s.frequency === 'daily' ? (s.workdays_only ? 'כל יום עבודה (א׳–ה׳)' : 'כל יום')
    : s.frequency === 'weekly' ? `כל שבוע, ביום ${WEEKDAY_HE[s.weekday ?? 0]}`
    : s.frequency === 'monthly' ? `כל חודש, ${[s.month_days.length ? `ב-${list([...s.month_days].sort((a, b) => a - b).map(String))}` : '', s.last_day ? 'ביום האחרון' : ''].filter(Boolean).join(' ו')}`
    : `כל שנה, ב-${list([...s.year_dates].sort().map((x) => `${Number(x.slice(3))} ב${MONTH_HE[Number(x.slice(0, 2)) - 1]}`))}`;
  return s.lead_days ? `${base} · מופיעה ${s.lead_days} ימים לפני` : base;
}

// Filtering the list (SPEC decision 132) by the same fields as sorting. Several filters
// together must all hold; several values in one filter are "any of them". "none" is a task
// without a trigger or a category; "mine" and "sent" are the viewer's.
export type FilterField = 'updated' | 'created' | 'priority' | 'subject' | 'assignee' | 'trigger' | 'category';
export interface TaskFilter { field: FilterField; values: string[] }
export const FILTER_FIELD_HE: Record<FilterField, string> = {
  updated: 'עדכון אחרון', created: 'תאריך פתיחה', priority: 'דחיפות', subject: 'נושא', assignee: 'בטיפול של', trigger: 'טריגר', category: 'קטגוריה',
};
export function filterTasks(tasks: OfficeTask[], filters: TaskFilter[], me: string): OfficeTask[] {
  const holds = (t: OfficeTask, f: TaskFilter): boolean => {
    const v = f.values;
    switch (f.field) {
      case 'updated': case 'created': {
        const d = (f.field === 'updated' ? t.updated_at : t.created_at).slice(0, 10);
        return (!v[0] || d >= v[0]) && (!v[1] || d <= v[1]);
      }
      case 'subject': return !v[0] || `${t.subject} ${t.body ?? ''}`.toLowerCase().includes(v[0].trim().toLowerCase());
      case 'priority': return v.includes(t.priority);
      case 'trigger': return v.includes(t.trigger_id ?? 'none');
      case 'category': return v.includes(t.category_id ?? 'none');
      case 'assignee': return v.some((x) => x === 'mine' ? t.office_task_assignees.some((a) => a.user_id === me)
        : x === 'sent' ? t.created_by === me : x === 'none' ? !t.office_task_assignees.length : t.office_task_assignees.some((a) => assigneeKey(a) === x));
    }
  };
  return tasks.filter((t) => filters.every((f) => !f.values.length || holds(t, f)));
}
