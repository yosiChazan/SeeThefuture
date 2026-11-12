import { ActionIcon, Alert, Anchor, Badge, Button, Card, Group, Modal, MultiSelect, NumberInput, Paper, SegmentedControl, Select, Stack, Switch, Tabs, Text, Textarea, TextInput, Timeline, Title } from '@mantine/core';
import { DateInput } from '@mantine/dates';
import { modals } from '@mantine/modals';
import dayjs from 'dayjs';
import { notifications } from '@mantine/notifications';
import { IconMail, IconPencil, IconPlus, IconRepeat, IconTrash } from '@tabler/icons-react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { useEffect, useMemo, useState } from 'react';
import { Link, useSearchParams } from 'react-router-dom';
import { AddLink, append, LinkedText, useMe } from '../components/ManualTopics';
import { useAccess } from '../lib/access';
import { COUNTRIES, COUNTRY_HE, propertyTitle } from '../lib/format';
import {
  assigneeKey, describeEvent, FILTER_FIELD_HE, filterTasks, MONTH_HE, nextOccurrence, openByAssignee, PRIORITY_COLOR, PRIORITY_HE, recurrenceText, sortTasks, STATUS_COLOR, STATUS_HE, taskMail, WEEKDAY_HE,
  type Assignee, type FilterField, type OfficeTask, type TaskFilter, type Priority, type Series, type SortKey, type TaskEvent, type TaskLink, type TaskStatus,
} from '../lib/officeTasks';
import { useClients, useContacts, useProperties } from '../lib/queries';
import { must, supabase } from '../lib/supabase';
import { gmailLink, mailtoLink } from '../lib/topicMail';
import { SendMailButton } from '../components/SendMailButton';

// Tasks (SPEC decisions 128–130). Each task is seen only by its author, whoever it is with,
// management and admins; the database enforces it. All of them may answer it. Recurring
// tasks are written once and open a task on each of their dates.

interface Person { user_id: string; display_name: string; email: string | null; client_party_id: string | null }

function usePeople() {
  return useQuery({ queryKey: ['task-people'], queryFn: async () => must(await supabase.rpc('task_people')) as Person[] });
}
export interface TaskCategory { id: string; label: string; position: number }
// The lists kept in Settings: categories and triggers (decisions 129, 130).
export function useLabelList(table: 'task_categories' | 'task_triggers') {
  return useQuery({ queryKey: [table], queryFn: async () => must(await supabase.from(table).select('id, label, position').order('position').order('label')) as TaskCategory[] });
}
export const useTaskCategories = () => useLabelList('task_categories');
function useSeries() {
  return useQuery({ queryKey: ['office-task-series'], queryFn: async () => must(await supabase.from('office_task_series').select('*').order('subject')) as Series[] });
}
function useTasks() {
  return useQuery({
    queryKey: ['office-tasks'],
    queryFn: async () => must(await supabase.from('office_tasks')
      .select('*, office_task_assignees(id, user_id, party_id), office_task_links(id, kind, entity_id, country_code)')
      .order('updated_at', { ascending: false })) as OfficeTask[],
  });
}
function useEvents(taskId: string | null) {
  return useQuery({
    queryKey: ['office-task-events', taskId], enabled: !!taskId,
    queryFn: async () => must(await supabase.from('office_task_events').select('*').eq('task_id', taskId!).order('created_at')) as TaskEvent[],
  });
}

// Names, e-mails and the choices of every list the page needs, in one place.
function useDirectory() {
  const access = useAccess();
  const people = usePeople();
  const clients = useClients();
  const contacts = useContacts();
  const properties = useProperties();
  const cats = useTaskCategories();
  const trigs = useLabelList('task_triggers');
  return useMemo(() => {
    const users = new Map((people.data ?? []).map((p) => [p.user_id, p]));
    const parties = new Map<string, { name: string; email: string | null }>();
    for (const c of clients.data ?? []) parties.set(c.id, { name: c.display_name, email: c.email ?? null });
    for (const c of contacts.data ?? []) parties.set(c.id, { name: c.display_name, email: c.email ?? null });
    const props = new Map((properties.data ?? []).map((p) => [p.id, propertyTitle(p)]));
    const nameOf = (a: { user_id: string | null; party_id: string | null }) =>
      (a.user_id ? users.get(a.user_id)?.display_name : a.party_id ? parties.get(a.party_id)?.name : null) ?? 'לא ידוע';
    const emailOf = (a: Assignee) => (a.user_id ? users.get(a.user_id)?.email : a.party_id ? parties.get(a.party_id)?.email : null) ?? null;
    const linkName = (l: TaskLink) => l.kind === 'country' ? `מדינה: ${COUNTRY_HE[l.country_code as keyof typeof COUNTRY_HE] ?? l.country_code}`
      : l.kind === 'property' ? `נכס ${props.get(l.entity_id ?? '') ?? ''}` : `${l.kind === 'client' ? 'לקוח' : 'איש קשר'} ${parties.get(l.entity_id ?? '')?.name ?? ''}`;
    const linkPath = (l: TaskLink) => l.kind === 'property' ? `/properties/${l.entity_id}` : l.kind === 'client' ? `/clients/${l.entity_id}` : l.kind === 'contact' ? `/contacts/${l.entity_id}` : null;
    // Who a task can be with: users (staff, management, client users), and clients without a login.
    const staffUsers = (people.data ?? []).filter((p) => !p.client_party_id);
    const clientUsers = (people.data ?? []).filter((p) => p.client_party_id);
    const withLogin = new Set(clientUsers.map((p) => p.client_party_id));
    const assigneeOptions = access.isClient ? [] : [
      { group: 'עובדים והנהלה', items: staffUsers.map((p) => ({ value: `u:${p.user_id}`, label: p.display_name })) },
      { group: 'לקוחות עם כניסה למערכת', items: clientUsers.map((p) => ({ value: `u:${p.user_id}`, label: p.display_name })) },
      { group: 'לקוחות בלי כניסה (מייל בלבד)', items: (clients.data ?? []).filter((c) => !withLogin.has(c.id)).map((c) => ({ value: `p:${c.id}`, label: c.display_name })) },
    ];
    const linkOptions = [
      { group: 'לקוחות', items: (clients.data ?? []).map((c) => ({ value: `client:${c.id}`, label: c.display_name })) },
      { group: 'נכסים', items: (properties.data ?? []).map((p) => ({ value: `property:${p.id}`, label: propertyTitle(p) })) },
      { group: 'אנשי קשר', items: (contacts.data ?? []).map((c) => ({ value: `contact:${c.id}`, label: c.display_name })) },
      { group: 'מדינות', items: COUNTRIES.map((c) => ({ value: `country:${c}`, label: COUNTRY_HE[c] })) },
    ];
    const catList = cats.data ?? [];
    const catLabel = (id: string | null | undefined) => catList.find((c) => c.id === id)?.label ?? null;
    const catRank = (id: string | null | undefined) => { const i = catList.findIndex((c) => c.id === id); return i < 0 ? 9999 : i; };
    const catOptions = catList.map((c) => ({ value: c.id, label: c.label }));
    const trList = trigs.data ?? [];
    const trigLabel = (id: string | null | undefined) => trList.find((c) => c.id === id)?.label ?? null;
    const trigRank = (id: string | null | undefined) => { const i = trList.findIndex((c) => c.id === id); return i < 0 ? 9999 : i; };
    const trigOptions = trList.map((c) => ({ value: c.id, label: c.label }));
    return { nameOf, emailOf, linkName, linkPath, assigneeOptions, linkOptions, users, catLabel, catRank, catOptions, trigLabel, trigRank, trigOptions };
  }, [people.data, clients.data, contacts.data, properties.data, cats.data, trigs.data, access.isClient]);
}
type Directory = ReturnType<typeof useDirectory>;

const linkValue = (l: TaskLink) => `${l.kind}:${l.entity_id ?? l.country_code}`;
const toLink = (v: string): TaskLink => {
  const [kind, id] = v.split(':') as [TaskLink['kind'], string];
  return kind === 'country' ? { kind, entity_id: null, country_code: id } : { kind, entity_id: id, country_code: null };
};
const toAssignee = (v: string): Assignee => (v.startsWith('u:') ? { user_id: v.slice(2), party_id: null } : { user_id: null, party_id: v.slice(2) });
const PRIORITIES = (Object.keys(PRIORITY_HE) as Priority[]).map((k) => ({ value: k, label: PRIORITY_HE[k] }));
const STATUSES = (Object.keys(STATUS_HE) as TaskStatus[]).map((k) => ({ value: k, label: STATUS_HE[k] }));

// The e-mail to each person a task is with: sent from the system on a press (replies go to
// the sender), or a draft in Gmail or the computer's mail app.
function MailLinks({ task, to, dir, from }: { task: OfficeTask; to: Assignee[]; dir: Directory; from: string }) {
  const withMail = to.filter((a) => dir.emailOf(a));
  if (!withMail.length) return <Text size="xs" c="dimmed">אין כתובת מייל לאף אחד מהם.</Text>;
  return (
    <Stack gap={4}>
      {withMail.map((a) => {
        const m = taskMail({ ...task, trigger: dir.trigLabel(task.trigger_id) }, dir.nameOf(a), from, window.location.origin);
        const email = dir.emailOf(a)!;
        return (
          <Group key={assigneeKey(a)} gap="xs">
            <IconMail size={14} />
            <Text size="sm">{dir.nameOf(a)}</Text>
            <SendMailButton size="xs" to={email} subject={m.subject} text={m.body} />
            <Anchor size="sm" href={gmailLink(email, m.subject, m.body)} target="_blank" rel="noopener noreferrer">Gmail</Anchor>
            <Anchor size="sm" href={mailtoLink(email, m.subject, m.body)}>תוכנת מייל</Anchor>
          </Group>
        );
      })}
    </Stack>
  );
}

// New task, or changing one (every change goes to the history).
function TaskForm({ dir, task, onClose, onSaved }: { dir: Directory; task?: OfficeTask; onClose: () => void; onSaved: (t: OfficeTask, added: Assignee[]) => void }) {
  const qc = useQueryClient();
  const [v, setV] = useState({
    trigger: (task?.trigger_id ?? null) as string | null, subject: task?.subject ?? '', body: task?.body ?? '',
    priority: (task?.priority ?? 'medium') as Priority, category: (task?.category_id ?? null) as string | null,
    links: (task?.office_task_links ?? []).map(linkValue), assignees: (task?.office_task_assignees ?? []).map(assigneeKey),
  });
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  async function save() {
    setBusy(true); setError(null);
    try {
      let id = task?.id;
      if (!task) {
        const assignees = v.assignees.map(toAssignee);
        id = must(await supabase.rpc('create_office_task', {
          p_trigger: v.trigger, p_subject: v.subject, p_body: v.body, p_priority: v.priority,
          p_users: assignees.filter((a) => a.user_id).map((a) => a.user_id), p_parties: assignees.filter((a) => a.party_id).map((a) => a.party_id),
          p_links: v.links.map(toLink), p_category: v.category,
        })) as string;
      } else {
        const fields = { trigger_id: v.trigger, subject: v.subject.trim(), body: v.body.trim() || null, priority: v.priority, category_id: v.category };
        if (fields.trigger_id !== (task.trigger_id ?? null) || fields.subject !== task.subject || fields.body !== (task.body ?? null) || fields.priority !== task.priority || fields.category_id !== (task.category_id ?? null)) {
          must(await supabase.from('office_tasks').update(fields).eq('id', task.id));
        }
        const oldA = new Map(task.office_task_assignees.map((a) => [assigneeKey(a), a]));
        for (const k of v.assignees.filter((k) => !oldA.has(k))) must(await supabase.from('office_task_assignees').insert({ task_id: task.id, ...toAssignee(k) }));
        for (const [k, a] of oldA) if (!v.assignees.includes(k)) must(await supabase.from('office_task_assignees').delete().eq('id', a.id!));
        const oldL = new Map(task.office_task_links.map((l) => [linkValue(l), l]));
        for (const k of v.links.filter((k) => !oldL.has(k))) must(await supabase.from('office_task_links').insert({ task_id: task.id, ...toLink(k) }));
        for (const [k, l] of oldL) if (!v.links.includes(k)) must(await supabase.from('office_task_links').delete().eq('id', l.id!));
      }
      await qc.invalidateQueries({ queryKey: ['office-tasks'] });
      await qc.invalidateQueries({ queryKey: ['office-task-events', id] });
      const fresh = must(await supabase.from('office_tasks').select('*, office_task_assignees(id, user_id, party_id), office_task_links(id, kind, entity_id, country_code)').eq('id', id!).single()) as OfficeTask;
      const before = new Set((task?.office_task_assignees ?? []).map(assigneeKey));
      onSaved(fresh, fresh.office_task_assignees.filter((a) => !before.has(assigneeKey(a))));
    } catch (e) { setError((e as Error).message); } finally { setBusy(false); }
  }
  return (
    <Modal opened onClose={onClose} title={task ? 'שינוי פרטי המשימה' : 'משימה חדשה'} size="lg">
      <Stack>
        <Group grow align="flex-start">
          <Select label="טריגר" placeholder="בלי טריגר" clearable data={dir.trigOptions} value={v.trigger} onChange={(x) => setV({ ...v, trigger: x })} />
          <Select label="קטגוריה" placeholder="בלי קטגוריה" clearable data={dir.catOptions} value={v.category} onChange={(x) => setV({ ...v, category: x })} />
          <Select label="עדיפות" required data={PRIORITIES} value={v.priority} allowDeselect={false} onChange={(x) => x && setV({ ...v, priority: x as Priority })} />
        </Group>
        <TextInput label="נושא" required value={v.subject} onChange={(e) => setV({ ...v, subject: e.currentTarget.value })} />
        <div>
          <Textarea label="תוכן" autosize minRows={3} value={v.body} onChange={(e) => setV({ ...v, body: e.currentTarget.value })} />
          <AddLink onAdd={(l) => setV({ ...v, body: append(v.body, l) })} />
        </div>
        <MultiSelect label="קשור ל" placeholder="לקוחות, נכסים, אנשי קשר, מדינות" searchable clearable data={dir.linkOptions} value={v.links}
          onChange={(x) => setV({ ...v, links: x })} nothingFoundMessage="לא נמצא" limit={60} />
        <MultiSelect label="לטיפול של" placeholder="עובד, מנהל או לקוח" searchable clearable data={dir.assigneeOptions} value={v.assignees}
          onChange={(x) => setV({ ...v, assignees: x })} nothingFoundMessage="לא נמצא" limit={60}
          description="המשימה גלויה רק לך, למי שהיא בטיפולו, להנהלה ולמנהל המערכת. אחרי השמירה יופיעו קישורים למייל אליהם" />
        {task && <Text size="xs" c="dimmed">כל שינוי נרשם בהיסטוריה של המשימה.</Text>}
        {error && <Alert color="red">{error}</Alert>}
        <Group justify="flex-end"><Button variant="default" onClick={onClose}>ביטול</Button>
          <Button onClick={save} loading={busy} disabled={!v.subject.trim()}>{task ? 'שמירת השינויים' : 'יצירה'}</Button></Group>
      </Stack>
    </Modal>
  );
}

// One task: its details, its history, and the answer (a reply and the state).
// A done task may be deleted by its author, management or an admin (decision 134).
function useCanDelete() {
  const access = useAccess();
  const me = useMe();
  return (t: OfficeTask) => t.status === 'done' && (access.isManagement || access.isAdmin || t.created_by === me);
}
function TaskView({ task, dir, onClose }: { task: OfficeTask; dir: Directory; onClose: () => void }) {
  const qc = useQueryClient();
  const access = useAccess();
  const canDelete = useCanDelete();
  const remove = () => modals.openConfirmModal({
    title: 'מחיקת משימה', children: <Text size="sm">"{task.subject}" תימחק עם ההיסטוריה שלה. אי אפשר לשחזר.</Text>,
    labels: { confirm: 'מחיקה', cancel: 'ביטול' }, confirmProps: { color: 'red' },
    onConfirm: async () => {
      const r = await supabase.from('office_tasks').delete().eq('id', task.id).select('id');
      if (r.error || !r.data?.length) { notifications.show({ color: 'red', message: r.error?.message ?? 'המשימה לא נמחקה' }); return; }
      notifications.show({ color: 'teal', message: 'המשימה נמחקה' });
      await qc.invalidateQueries({ queryKey: ['office-tasks'] });
      onClose();
    },
  });
  const events = useEvents(task.id);
  const [reply, setReply] = useState('');
  const [status, setStatus] = useState<TaskStatus>(task.status);
  const [editing, setEditing] = useState(false);
  const [mailTo, setMailTo] = useState<Assignee[] | null>(null);
  const [busy, setBusy] = useState(false);
  async function send() {
    setBusy(true);
    try {
      if (reply.trim()) must(await supabase.from('office_task_events').insert({ task_id: task.id, kind: 'reply', body: reply.trim() }));
      if (status !== task.status) must(await supabase.from('office_tasks').update({ status }).eq('id', task.id));
      setReply('');
      await qc.invalidateQueries({ queryKey: ['office-tasks'] });
      await qc.invalidateQueries({ queryKey: ['office-task-events', task.id] });
      notifications.show({ color: 'teal', message: 'נשמר' });
    } catch (e) { notifications.show({ color: 'red', message: (e as Error).message }); } finally { setBusy(false); }
  }
  const author = dir.users.get(task.created_by)?.display_name ?? 'לא ידוע';
  return (
    <Modal opened onClose={onClose} size="xl" title={task.subject}>
      <Stack>
        <Group gap="xs">
          <Badge color={STATUS_COLOR[task.status]}>{STATUS_HE[task.status]}</Badge>
          <Badge variant="light" color={PRIORITY_COLOR[task.priority]}>עדיפות {PRIORITY_HE[task.priority]}</Badge>
          {dir.trigLabel(task.trigger_id) && <Badge variant="outline">{dir.trigLabel(task.trigger_id)}</Badge>}
          {task.series_id && <Badge variant="light" color="indigo" leftSection={<IconRepeat size={12} />}>חוזרת · {task.occurrence_on && dayjs(task.occurrence_on).format('DD.MM.YYYY')}</Badge>}
          {dir.catLabel(task.category_id) && <Badge variant="light" color="cyan">{dir.catLabel(task.category_id)}</Badge>}
          <Text size="xs" c="dimmed">נפתחה ע"י {author}, {new Date(task.created_at).toLocaleString('he-IL')}</Text>
        </Group>
        {task.body && <Paper withBorder p="sm"><LinkedText text={task.body} /></Paper>}
        <Group gap="xs" align="flex-start">
          <Text size="sm" fw={600} w={80}>קשור ל:</Text>
          <Group gap={6}>{task.office_task_links.length ? task.office_task_links.map((l) => {
            const p = dir.linkPath(l);
            return p ? <Badge key={linkValue(l)} variant="light" component={Link} to={p} style={{ cursor: 'pointer' }}>{dir.linkName(l)}</Badge>
              : <Badge key={linkValue(l)} variant="light">{dir.linkName(l)}</Badge>;
          }) : <Text size="sm" c="dimmed">—</Text>}</Group>
        </Group>
        <Group gap="xs" align="flex-start">
          <Text size="sm" fw={600} w={80}>בטיפול של:</Text>
          <Group gap={6}>{task.office_task_assignees.length ? task.office_task_assignees.map((a) => <Badge key={assigneeKey(a)} color="grape" variant="light">{dir.nameOf(a)}</Badge>) : <Text size="sm" c="dimmed">—</Text>}</Group>
          {!access.isClient && task.office_task_assignees.length > 0 && <Button size="compact-xs" variant="subtle" leftSection={<IconMail size={12} />} onClick={() => setMailTo(task.office_task_assignees)}>מייל</Button>}
        </Group>
        {mailTo && <Paper withBorder p="sm"><MailLinks task={task} to={mailTo} dir={dir} from={access.displayName} /></Paper>}

        <Title order={5}>היסטוריה</Title>
        <Timeline bulletSize={12} lineWidth={2}>
          {(events.data ?? []).map((e) => (
            <Timeline.Item key={e.id} title={<Text size="sm"><b>{e.created_by ? dir.users.get(e.created_by)?.display_name ?? 'לא ידוע' : 'המערכת'}</b> {describeEvent(e, dir.nameOf, dir.linkName)}</Text>}>
              {e.body && <LinkedText text={e.body} />}
              <Text size="xs" c="dimmed">{new Date(e.created_at).toLocaleString('he-IL')}</Text>
            </Timeline.Item>
          ))}
        </Timeline>

        <Paper withBorder p="sm">
          <Stack gap="xs">
            <Textarea label="מענה" autosize minRows={2} value={reply} onChange={(e) => setReply(e.currentTarget.value)} />
            <Group justify="space-between" align="flex-end">
              <Group gap="xs" align="flex-end">
                <AddLink onAdd={(l) => setReply(append(reply, l))} />
                <Select size="xs" w={150} label="מצב" data={STATUSES} value={status} allowDeselect={false} onChange={(x) => x && setStatus(x as TaskStatus)} />
              </Group>
              <Group gap="xs">
                {canDelete(task) && <Button size="xs" variant="subtle" color="red" leftSection={<IconTrash size={14} />} onClick={remove}>מחיקה</Button>}
                {!access.isClient && <Button size="xs" variant="default" onClick={() => setEditing(true)}>העברה ושינוי פרטים</Button>}
                <Button size="xs" onClick={send} loading={busy} disabled={!reply.trim() && status === task.status}>שליחה</Button>
              </Group>
            </Group>
          </Stack>
        </Paper>
      </Stack>
      {editing && <TaskForm dir={dir} task={task} onClose={() => setEditing(false)}
        onSaved={(_t, added) => { setEditing(false); if (added.length) setMailTo(added); }} />}
    </Modal>
  );
}


// A recurring task: everything a task has, and how often (decision 130). Editing it changes
// the tasks opened from now on; the tasks already opened stay as they are.
const FREQ = [{ value: 'daily', label: 'יומית' }, { value: 'weekly', label: 'שבועית' }, { value: 'monthly', label: 'חודשית' }, { value: 'yearly', label: 'שנתית' }];
const today = () => dayjs().format('YYYY-MM-DD');
function SeriesForm({ dir, series, onClose }: { dir: Directory; series?: Series; onClose: () => void }) {
  const qc = useQueryClient();
  const [v, setV] = useState({
    subject: series?.subject ?? '', body: series?.body ?? '', priority: (series?.priority ?? 'medium') as Priority,
    category: series?.category_id ?? null as string | null, trigger: series?.trigger_id ?? null as string | null,
    links: (series?.links ?? []).map(linkValue), assignees: [...(series?.users ?? []).map((u) => `u:${u}`), ...(series?.parties ?? []).map((p) => `p:${p}`)],
    frequency: (series?.frequency ?? 'monthly') as Series['frequency'], workdays_only: series?.workdays_only ?? true, weekday: series?.weekday ?? 0,
    month_days: (series?.month_days ?? [1]).map(String), last_day: series?.last_day ?? false, year_dates: series?.year_dates ?? [] as string[],
    newDay: 1, newMonth: 1,
    start_on: series?.start_on ?? today(), end_on: series?.end_on ?? null as string | null, lead_days: series?.lead_days ?? 0,
  });
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const rule = { ...v, weekday: v.frequency === 'weekly' ? v.weekday : null, month_days: v.frequency === 'monthly' ? v.month_days.map(Number) : [],
    last_day: v.frequency === 'monthly' && v.last_day, year_dates: v.frequency === 'yearly' ? v.year_dates : [], workdays_only: v.frequency === 'daily' && v.workdays_only };
  const dateKey = (m: number, d: number) => `${String(m).padStart(2, '0')}-${String(d).padStart(2, '0')}`;
  const daysOk = v.frequency === 'monthly' ? v.month_days.length > 0 || v.last_day : v.frequency === 'yearly' ? v.year_dates.length > 0 : true;
  const next = nextOccurrence(rule, series?.last_spawned ? dayjs(series.last_spawned).add(1, 'day').format('YYYY-MM-DD') : v.start_on);
  async function save() {
    setBusy(true); setError(null);
    const a = v.assignees.map(toAssignee);
    const row = {
      subject: v.subject.trim(), body: v.body.trim() || null, priority: v.priority, category_id: v.category, trigger_id: v.trigger,
      users: a.filter((x) => x.user_id).map((x) => x.user_id), parties: a.filter((x) => x.party_id).map((x) => x.party_id), links: v.links.map(toLink),
      frequency: v.frequency, workdays_only: rule.workdays_only, weekday: rule.weekday, month_days: rule.month_days, last_day: rule.last_day,
      year_dates: rule.year_dates, start_on: v.start_on, end_on: v.end_on, lead_days: v.lead_days, updated_at: new Date().toISOString(),
    };
    const r = series ? await supabase.from('office_task_series').update(row).eq('id', series.id) : await supabase.from('office_task_series').insert(row);
    if (r.error) { setBusy(false); setError(r.error.message); return; }
    const opened = await supabase.rpc('spawn_recurring_tasks');
    setBusy(false);
    await qc.invalidateQueries({ queryKey: ['office-task-series'] });
    await qc.invalidateQueries({ queryKey: ['office-tasks'] });
    notifications.show({ color: 'teal', message: opened.data ? `נשמר, ונפתחו ${opened.data} משימות שהמועד שלהן הגיע` : 'נשמר' });
    onClose();
  }
  return (
    <Modal opened onClose={onClose} title={series ? 'עריכת משימה חוזרת' : 'משימה חוזרת חדשה'} size="lg">
      <Stack>
        <TextInput label="נושא" required value={v.subject} onChange={(e) => setV({ ...v, subject: e.currentTarget.value })} />
        <div>
          <Textarea label="תוכן" autosize minRows={2} value={v.body} onChange={(e) => setV({ ...v, body: e.currentTarget.value })} />
          <AddLink onAdd={(l) => setV({ ...v, body: append(v.body, l) })} />
        </div>
        <Group grow align="flex-start">
          <Select label="טריגר" placeholder="בלי טריגר" clearable data={dir.trigOptions} value={v.trigger} onChange={(x) => setV({ ...v, trigger: x })} />
          <Select label="קטגוריה" placeholder="בלי קטגוריה" clearable data={dir.catOptions} value={v.category} onChange={(x) => setV({ ...v, category: x })} />
          <Select label="עדיפות" data={PRIORITIES} value={v.priority} allowDeselect={false} onChange={(x) => x && setV({ ...v, priority: x as Priority })} />
        </Group>
        <MultiSelect label="קשור ל" searchable clearable data={dir.linkOptions} value={v.links} onChange={(x) => setV({ ...v, links: x })} nothingFoundMessage="לא נמצא" limit={60} />
        <MultiSelect label="לטיפול של" searchable clearable data={dir.assigneeOptions} value={v.assignees} onChange={(x) => setV({ ...v, assignees: x })} nothingFoundMessage="לא נמצא" limit={60} />
        <Paper withBorder p="sm">
          <Stack gap="xs">
            <SegmentedControl value={v.frequency} onChange={(x) => setV({ ...v, frequency: x as Series['frequency'] })} data={FREQ} />
            {v.frequency === 'daily' && <Switch label="רק בימי עבודה (א׳–ה׳)" checked={v.workdays_only} onChange={(e) => setV({ ...v, workdays_only: e.currentTarget.checked })} />}
            {v.frequency === 'weekly' && <Select label="ביום" w={160} allowDeselect={false} value={String(v.weekday)} onChange={(x) => x && setV({ ...v, weekday: Number(x) })}
              data={WEEKDAY_HE.map((d, i) => ({ value: String(i), label: d }))} />}
            {v.frequency === 'monthly' && <Group align="flex-end">
              <MultiSelect label="בימים בחודש" placeholder="אפשר לבחור כמה" style={{ flex: 1 }} value={v.month_days}
                onChange={(x) => setV({ ...v, month_days: [...x].sort((a, b) => Number(a) - Number(b)) })}
                data={Array.from({ length: 31 }, (_, i) => String(i + 1))} />
              <Switch label="וגם היום האחרון בחודש" checked={v.last_day} onChange={(e) => setV({ ...v, last_day: e.currentTarget.checked })} mb={8} />
            </Group>}
            {v.frequency === 'yearly' && <Stack gap={6}>
              <Group gap={6}>{v.year_dates.length ? [...v.year_dates].sort().map((x) => (
                <Badge key={x} variant="light" rightSection={<ActionIcon size="xs" variant="transparent" onClick={() => setV({ ...v, year_dates: v.year_dates.filter((y) => y !== x) })} aria-label="הסרה"><IconTrash size={10} /></ActionIcon>}>
                  {Number(x.slice(3))} ב{MONTH_HE[Number(x.slice(0, 2)) - 1]}</Badge>
              )) : <Text size="xs" c="dimmed">עוד לא נבחר תאריך</Text>}</Group>
              <Group align="flex-end" gap="xs">
                <NumberInput label="יום" w={90} min={1} max={31} value={v.newDay} onChange={(x) => setV({ ...v, newDay: Number(x) || 1 })} />
                <Select label="חודש" w={140} allowDeselect={false} value={String(v.newMonth)} onChange={(x) => x && setV({ ...v, newMonth: Number(x) })}
                  data={MONTH_HE.map((m, i) => ({ value: String(i + 1), label: m }))} />
                <Button size="xs" variant="light" mb={4} disabled={v.year_dates.includes(dateKey(v.newMonth, v.newDay))}
                  onClick={() => setV({ ...v, year_dates: [...v.year_dates, dateKey(v.newMonth, v.newDay)] })}>הוספת תאריך</Button>
              </Group>
            </Stack>}
            {['monthly', 'yearly'].includes(v.frequency) && <Text size="xs" c="dimmed">יום שאין בחודש (31 בחודש קצר, 29 בפברואר) נופל ביום האחרון של החודש.</Text>}
            <Group grow>
              <DateInput label="מתאריך" valueFormat="DD.MM.YYYY" value={v.start_on} onChange={(d) => d && setV({ ...v, start_on: dayjs(d).format('YYYY-MM-DD') })} />
              <DateInput label="עד תאריך (לא חובה)" valueFormat="DD.MM.YYYY" clearable value={v.end_on} onChange={(d) => setV({ ...v, end_on: d ? dayjs(d).format('YYYY-MM-DD') : null })} />
              <NumberInput label="להופיע ימים לפני" min={0} max={60} value={v.lead_days} onChange={(x) => setV({ ...v, lead_days: Number(x) || 0 })} />
            </Group>
            <Text size="sm">{recurrenceText(rule)} · המועד הבא: <b>{next ? dayjs(next).format('DD.MM.YYYY') : 'אין (עבר תאריך הסיום)'}</b></Text>
          </Stack>
        </Paper>
        {series && <Text size="xs" c="dimmed">השינוי חל על המשימות שייפתחו מעכשיו. משימות שכבר נפתחו לא משתנות.</Text>}
        {error && <Alert color="red">{error}</Alert>}
        <Group justify="flex-end"><Button variant="default" onClick={onClose}>ביטול</Button>
          <Button onClick={save} loading={busy} disabled={!v.subject.trim() || !daysOk}>שמירה</Button></Group>
      </Stack>
    </Modal>
  );
}

function SeriesList({ dir }: { dir: Directory }) {
  const qc = useQueryClient();
  const series = useSeries();
  const me = useMe();
  const access = useAccess();
  const [editing, setEditing] = useState<Series | 'new' | null>(null);
  const toggle = async (s: Series, active: boolean) => {
    const r = await supabase.from('office_task_series').update({ active }).eq('id', s.id);
    if (r.error) notifications.show({ color: 'red', message: r.error.message });
    await qc.invalidateQueries({ queryKey: ['office-task-series'] });
  };
  const remove = (s: Series) => modals.openConfirmModal({
    title: 'מחיקת משימה חוזרת', children: <Text size="sm">"{s.subject}" לא תיפתח יותר. המשימות שכבר נפתחו ממנה נשארות.</Text>,
    labels: { confirm: 'מחיקה', cancel: 'ביטול' }, confirmProps: { color: 'red' },
    onConfirm: async () => {
      const r = await supabase.from('office_task_series').delete().eq('id', s.id);
      if (r.error) notifications.show({ color: 'red', message: r.error.message });
      await qc.invalidateQueries({ queryKey: ['office-task-series'] });
    },
  });
  const list = series.data ?? [];
  return (
    <Stack>
      <Group justify="space-between">
        <Text size="sm" c="dimmed">נרשמות פעם אחת; בכל מועד נפתחת מהן משימה רגילה (כל בוקר, ובפתיחת הדף). השהיה עוצרת את הפתיחה עד שמחדשים.</Text>
        <Button leftSection={<IconPlus size={16} />} onClick={() => setEditing('new')}>משימה חוזרת חדשה</Button>
      </Group>
      {series.error && <Alert color="red">{(series.error as Error).message}</Alert>}
      {!list.length && !series.isLoading && <Text c="dimmed">אין משימות חוזרות.</Text>}
      {list.map((s) => {
        const next = s.active ? nextOccurrence(s, s.last_spawned ? dayjs(s.last_spawned).add(1, 'day').format('YYYY-MM-DD') : s.start_on) : null;
        const people = [...s.users.map((u) => dir.nameOf({ user_id: u, party_id: null })), ...s.parties.map((p) => dir.nameOf({ user_id: null, party_id: p }))];
        return (
          <Card key={s.id} withBorder padding="sm" opacity={s.active ? 1 : 0.6}>
            <Group justify="space-between" wrap="nowrap" align="flex-start">
              <Stack gap={4} style={{ minWidth: 0 }}>
                <Group gap="xs">
                  <Text fw={600}>{s.subject}</Text>
                  <Badge size="sm" variant="light" color={PRIORITY_COLOR[s.priority]}>{PRIORITY_HE[s.priority]}</Badge>
                  {dir.trigLabel(s.trigger_id) && <Badge size="sm" variant="outline">{dir.trigLabel(s.trigger_id)}</Badge>}
                  {dir.catLabel(s.category_id) && <Badge size="sm" variant="light" color="cyan">{dir.catLabel(s.category_id)}</Badge>}
                </Group>
                <Text size="sm"><IconRepeat size={12} /> {recurrenceText(s)}</Text>
                <Text size="xs" c="dimmed">{people.length ? `בטיפול של ${people.join(', ')}` : 'בלי מטפל'}
                  {s.links.length ? ` · ${s.links.map(dir.linkName).join(', ')}` : ''}</Text>
              </Stack>
              <Stack gap={4} align="flex-end">
                <Text size="xs" c="dimmed">{s.active ? (next ? `המועד הבא: ${dayjs(next).format('DD.MM.YYYY')}` : 'הסתיימה') : 'מושהית'}</Text>
                <Group gap={4} wrap="nowrap">
                  <Switch size="xs" label="פעילה" checked={s.active} onChange={(e) => toggle(s, e.currentTarget.checked)} />
                  <ActionIcon variant="subtle" onClick={() => setEditing(s)} aria-label="עריכה"><IconPencil size={14} /></ActionIcon>
                  {(access.isAdmin || s.created_by === me) && <ActionIcon variant="subtle" color="red" onClick={() => remove(s)} aria-label="מחיקה"><IconTrash size={14} /></ActionIcon>}
                </Group>
              </Stack>
            </Group>
          </Card>
        );
      })}
      {editing && <SeriesForm dir={dir} series={editing === 'new' ? undefined : editing} onClose={() => setEditing(null)} />}
    </Stack>
  );
}

// Filters, the same fields as sorting (decision 132): choose a field, then one or more of its
// values (a text for the subject, a range for the dates). Several filters narrow together:
// first a category, then within it a trigger, and so on.
function TaskFilters({ filters, setFilters, choices }: {
  filters: TaskFilter[]; setFilters: (f: TaskFilter[]) => void; choices: Partial<Record<FilterField, { value: string; label: string }[]>>;
}) {
  const used = new Set(filters.map((f) => f.field));
  const fields = (Object.keys(FILTER_FIELD_HE) as FilterField[]).filter((f) => !used.has(f));
  const set = (i: number, values: string[]) => setFilters(filters.map((f, j) => (j === i ? { ...f, values } : f)));
  const remove = (i: number) => setFilters(filters.filter((_, j) => j !== i));
  return (
    <Group gap="xs" align="flex-end">
      {filters.map((f, i) => (
        <Group key={f.field} gap={4} align="flex-end" wrap="nowrap">
          {f.field === 'subject'
            ? <TextInput size="xs" w={200} label={FILTER_FIELD_HE.subject} placeholder="מילה בנושא או בתוכן" value={f.values[0] ?? ''} onChange={(e) => set(i, [e.currentTarget.value])} />
            : f.field === 'created' || f.field === 'updated'
              ? <Group gap={4} wrap="nowrap">
                  <DateInput size="xs" w={120} label={`${FILTER_FIELD_HE[f.field]} מ-`} valueFormat="DD.MM.YYYY" clearable value={f.values[0] || null}
                    onChange={(d) => set(i, [d ? dayjs(d).format('YYYY-MM-DD') : '', f.values[1] ?? ''])} />
                  <DateInput size="xs" w={120} label="עד" valueFormat="DD.MM.YYYY" clearable value={f.values[1] || null}
                    onChange={(d) => set(i, [f.values[0] ?? '', d ? dayjs(d).format('YYYY-MM-DD') : ''])} />
                </Group>
              : <MultiSelect size="xs" w={260} label={FILTER_FIELD_HE[f.field]} placeholder="בחירה (אפשר כמה)" searchable data={choices[f.field] ?? []}
                  value={f.values} onChange={(x) => set(i, x)} />}
          <ActionIcon variant="subtle" color="gray" mb={2} onClick={() => remove(i)} aria-label="הסרת הסינון"><IconTrash size={14} /></ActionIcon>
        </Group>
      ))}
      {fields.length > 0 && <Select size="xs" w={170} label={filters.length ? 'ועוד סינון לפי' : 'סינון לפי'} placeholder="בחירת שדה" value={null}
        data={fields.map((f) => ({ value: f, label: FILTER_FIELD_HE[f] }))}
        onChange={(x) => x && setFilters([...filters, { field: x as FilterField, values: [] }])} />}
      {filters.length > 0 && <Button size="xs" variant="subtle" color="gray" onClick={() => setFilters([])}>ניקוי הסינון</Button>}
    </Group>
  );
}

export function Tasks() {
  const access = useAccess();
  const me = useMe();
  const tasks = useTasks();
  const dir = useDirectory();
  const [params, setParams] = useSearchParams();
  const [sort, setSort] = useState<SortKey>('updated');
  const [state, setState] = useState<'open' | 'done' | 'all'>('open');
  const [filters, setFilters] = useState<TaskFilter[]>([]);
  const canDelete = useCanDelete();
  const [adding, setAdding] = useState(false);
  const [created, setCreated] = useState<{ task: OfficeTask; to: Assignee[] } | null>(null);
  const all = tasks.data ?? [];
  const qc = useQueryClient();
  const [tab, setTab] = useState<string>('tasks');
  // Recurring tasks whose date has come open now too, if the morning run has not yet.
  useEffect(() => {
    if (access.isClient) return;
    supabase.rpc('spawn_recurring_tasks').then(({ data }) => { if (data) qc.invalidateQueries({ queryKey: ['office-tasks'] }); });
  }, [access.isClient, qc]);
  // A task from a recurring one whose earlier task is not done yet.
  const stillOpen = new Set(all.filter((t) => t.series_id && all.some((o) => o.series_id === t.series_id && o.id !== t.id
    && (o.occurrence_on ?? '') < (t.occurrence_on ?? '') && o.status !== 'done')).map((t) => t.id));
  const open = params.get('task');
  const current = all.find((t) => t.id === open) ?? null;
  const counts = openByAssignee(all);
  const whoOptions = [
    { value: 'mine', label: 'אצלי' }, { value: 'sent', label: 'שפתחתי' },
    ...[...counts].map(([k, n]) => ({ value: k, label: `${dir.nameOf(toAssignee(k))} (${n})` })).sort((a, b) => a.label.localeCompare(b.label, 'he')),
  ];
  const shown = sortTasks(filterTasks(all.filter((t) => state === 'all' || (state === 'done') === (t.status === 'done')), filters, me),
    sort, dir.nameOf, { trigger: dir.trigRank, category: dir.catRank });
  // Deleting the done tasks shown (after the filters), those the viewer may delete.
  const removeDone = () => {
    const ids = shown.filter(canDelete).map((t) => t.id);
    modals.openConfirmModal({
      title: 'מחיקת משימות שטופלו', children: <Text size="sm">{ids.length} משימות שטופלו, כפי שהן מסוננות עכשיו, יימחקו עם ההיסטוריה שלהן. אי אפשר לשחזר.</Text>,
      labels: { confirm: 'מחיקה', cancel: 'ביטול' }, confirmProps: { color: 'red' },
      onConfirm: async () => {
        const r = await supabase.from('office_tasks').delete().in('id', ids).select('id');
        notifications.show(r.error ? { color: 'red', message: r.error.message } : { color: 'teal', message: `נמחקו ${r.data?.length ?? 0} משימות` });
        await qc.invalidateQueries({ queryKey: ['office-tasks'] });
      },
    });
  };
  // The values each filter offers, as in sorting.
  const choices: Partial<Record<FilterField, { value: string; label: string }[]>> = {
    priority: [{ value: 'high', label: PRIORITY_HE.high }, { value: 'medium', label: PRIORITY_HE.medium }, { value: 'low', label: PRIORITY_HE.low }],
    assignee: [...whoOptions, { value: 'none', label: 'לא הועברה לטיפול' }],
    trigger: [...dir.trigOptions, { value: 'none', label: 'בלי טריגר' }],
    category: [...dir.catOptions, { value: 'none', label: 'בלי קטגוריה' }],
  };

  return (
    <Stack>
      <Group justify="space-between">
        <Title order={2}>משימות</Title>
        {!access.isClient && tab === 'tasks' && <Button leftSection={<IconPlus size={16} />} onClick={() => setAdding(true)}>משימה חדשה</Button>}
      </Group>
      <Tabs value={tab} onChange={(x) => x && setTab(x)}>
        <Tabs.List><Tabs.Tab value="tasks">משימות</Tabs.Tab>{!access.isClient && <Tabs.Tab value="series" leftSection={<IconRepeat size={14} />}>משימות חוזרות</Tabs.Tab>}</Tabs.List>
      </Tabs>
      {tab === 'series' ? <SeriesList dir={dir} /> : <>
      <Group gap="sm" align="flex-end">
        <SegmentedControl value={state} onChange={(x) => setState(x as typeof state)}
          data={[{ value: 'open', label: 'פתוחות' }, { value: 'done', label: 'טופלו' }, { value: 'all', label: 'הכול' }]} />
        <Select label="מיון" w={170} allowDeselect={false} value={sort} onChange={(x) => x && setSort(x as SortKey)}
          data={[{ value: 'updated', label: 'עדכון אחרון' }, { value: 'created', label: 'תאריך פתיחה' }, { value: 'priority', label: 'דחיפות' }, { value: 'subject', label: 'נושא' }, { value: 'assignee', label: 'בטיפול של' }, { value: 'trigger', label: 'טריגר' }, { value: 'category', label: 'קטגוריה' }]} />
        <Text size="sm" c="dimmed">{shown.length} משימות</Text>
        {state === 'done' && shown.some(canDelete) && <Button size="xs" variant="subtle" color="red" leftSection={<IconTrash size={14} />} onClick={removeDone}>מחיקת המשימות שטופלו ({shown.filter(canDelete).length})</Button>}
      </Group>
      <TaskFilters filters={filters} setFilters={setFilters} choices={choices} />
      {tasks.error && <Alert color="red">{(tasks.error as Error).message}</Alert>}
      {created && (
        <Alert color="teal" withCloseButton onClose={() => setCreated(null)} title={`המשימה "${created.task.subject}" נשמרה`}>
          {created.to.length ? <><Text size="sm" mb={4}>מייל למי שהמשימה בטיפולו:</Text><MailLinks task={created.task} to={created.to} dir={dir} from={access.displayName} /></> : null}
        </Alert>
      )}
      {!shown.length && !tasks.isLoading && <Text c="dimmed">אין משימות להצגה.</Text>}
      <Stack gap="xs">
        {shown.map((t) => (
          <Card key={t.id} withBorder padding="sm" style={{ cursor: 'pointer' }} onClick={() => setParams({ task: t.id })}>
            <Group justify="space-between" wrap="nowrap" align="flex-start">
              <Stack gap={4} style={{ minWidth: 0 }}>
                <Group gap="xs">
                  <Text fw={600}>{t.subject}</Text>
                  <Badge size="sm" variant="light" color={PRIORITY_COLOR[t.priority]}>{PRIORITY_HE[t.priority]}</Badge>
                  {dir.trigLabel(t.trigger_id) && <Badge size="sm" variant="outline">{dir.trigLabel(t.trigger_id)}</Badge>}
                  {t.series_id && <Badge size="sm" variant="light" color="indigo" leftSection={<IconRepeat size={10} />}>{t.occurrence_on && dayjs(t.occurrence_on).format('DD.MM')}</Badge>}
                  {stillOpen.has(t.id) && <Badge size="sm" variant="light" color="orange">גם הקודמת עוד פתוחה</Badge>}
                  {dir.catLabel(t.category_id) && <Badge size="sm" variant="light" color="cyan">{dir.catLabel(t.category_id)}</Badge>}
                </Group>
                <Text size="xs" c="dimmed" lineClamp={1}>
                  {t.office_task_assignees.length ? `בטיפול של ${t.office_task_assignees.map(dir.nameOf).join(', ')}` : 'לא הועברה לטיפול'}
                  {t.office_task_links.length ? ` · ${t.office_task_links.map(dir.linkName).join(', ')}` : ''}
                </Text>
              </Stack>
              <Stack gap={4} align="flex-end">
                <Badge color={STATUS_COLOR[t.status]}>{STATUS_HE[t.status]}</Badge>
                <Text size="xs" c="dimmed">{new Date(t.updated_at).toLocaleDateString('he-IL')}</Text>
              </Stack>
            </Group>
          </Card>
        ))}
      </Stack>
      </>}
      {adding && <TaskForm dir={dir} onClose={() => setAdding(false)} onSaved={(t, to) => { setAdding(false); setCreated({ task: t, to }); }} />}
      {current && <TaskView key={current.id} task={current} dir={dir} onClose={() => setParams({})} />}
    </Stack>
  );
}
