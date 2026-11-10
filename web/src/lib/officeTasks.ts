// Tasks (SPEC decision 128): labels, sorting, the history in words and the e-mail to whoever
// a task is with. Pure, tested.

export type Trigger = 'management_meeting' | 'client' | 'system_issue' | 'monthly';
export type Priority = 'low' | 'medium' | 'high';
export type TaskStatus = 'assigned' | 'in_progress' | 'done';

export const TRIGGER_HE: Record<Trigger, string> = { management_meeting: 'ישיבת הנהלה', client: 'לקוח', system_issue: 'תקלה במערכת', monthly: 'חודשי' };
export const PRIORITY_HE: Record<Priority, string> = { low: 'נמוכה', medium: 'בינונית', high: 'גבוהה' };
export const PRIORITY_COLOR: Record<Priority, string> = { low: 'gray', medium: 'yellow', high: 'red' };
export const STATUS_HE: Record<TaskStatus, string> = { assigned: 'מוען', in_progress: 'בטיפול', done: 'טופל' };
export const STATUS_COLOR: Record<TaskStatus, string> = { assigned: 'blue', in_progress: 'orange', done: 'teal' };
const PRIORITY_RANK: Record<Priority, number> = { high: 0, medium: 1, low: 2 };
const FIELD_HE: Record<string, string> = { subject: 'הנושא', body: 'התוכן', priority: 'העדיפות', trigger_kind: 'הטריגר' };

export interface Assignee { id?: string; user_id: string | null; party_id: string | null }
export interface TaskLink { id?: string; kind: 'client' | 'property' | 'contact' | 'country'; entity_id: string | null; country_code: string | null }
export interface OfficeTask {
  id: string; created_by: string; created_at: string; updated_at: string; trigger_kind: Trigger; subject: string; body: string | null;
  priority: Priority; status: TaskStatus; office_task_assignees: Assignee[]; office_task_links: TaskLink[];
}
export interface TaskEvent { id: string; task_id: string; kind: string; body: string | null; data: Record<string, unknown> | null; created_by: string | null; created_at: string }

export type SortKey = 'updated' | 'created' | 'priority' | 'subject' | 'assignee';

export const assigneeKey = (a: Assignee) => (a.user_id ? `u:${a.user_id}` : `p:${a.party_id}`);

// Sorting the list. "By who handles it" orders by the first assignee's name; a task with
// no one comes last.
export function sortTasks(tasks: OfficeTask[], key: SortKey, nameOf: (a: Assignee) => string): OfficeTask[] {
  const first = (t: OfficeTask) => t.office_task_assignees.map(nameOf).sort((a, b) => a.localeCompare(b, 'he'))[0] ?? '￿';
  const by: Record<SortKey, (a: OfficeTask, b: OfficeTask) => number> = {
    updated: (a, b) => b.updated_at.localeCompare(a.updated_at),
    created: (a, b) => b.created_at.localeCompare(a.created_at),
    priority: (a, b) => PRIORITY_RANK[a.priority] - PRIORITY_RANK[b.priority] || b.updated_at.localeCompare(a.updated_at),
    subject: (a, b) => a.subject.localeCompare(b.subject, 'he'),
    assignee: (a, b) => first(a).localeCompare(first(b), 'he') || PRIORITY_RANK[a.priority] - PRIORITY_RANK[b.priority],
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
        const show = (x: string | null) => (k === 'priority' ? PRIORITY_HE[x as Priority] : k === 'trigger_kind' ? TRIGGER_HE[x as Trigger] : k === 'body' ? null : x) ?? '';
        return k === 'body' ? 'שינה/תה את התוכן' : `${FIELD_HE[k] ?? k}: "${show(from)}" ← "${show(to)}"`;
      });
      return parts.join(' · ');
    }
    default: return e.kind;
  }
}

// The e-mail to whoever the task is with: plain text, links as "name: address".
const NAMED = /\[([^\]\n]+)\]\((https?:\/\/[^\s)]+|\/[^\s)]*)\)/g;
export function taskMail(t: { subject: string; body: string | null; priority: Priority; trigger_kind: Trigger; id: string },
                         to: string, from: string, origin: string): { subject: string; body: string } {
  const full = (u: string) => (u.startsWith('/') ? origin + u : u);
  const text = (t.body ?? '').trim().replace(NAMED, (_, n: string, u: string) => `${n}: ${full(u)}`);
  const lines = [
    `שלום ${to},`, '',
    `${from} העביר/ה אליך משימה: ${t.subject}`,
    `עדיפות: ${PRIORITY_HE[t.priority]} · ${TRIGGER_HE[t.trigger_kind]}`,
    ...(text ? ['', text] : []),
    '', `למשימה, לתשובה ולעדכון המצב: ${origin}/tasks?task=${t.id}`, '', 'תודה',
  ];
  return { subject: `משימה: ${t.subject}`, body: lines.join('\n') };
}
