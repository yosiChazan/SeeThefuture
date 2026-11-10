import { Alert, Anchor, Badge, Button, Card, Group, Modal, MultiSelect, Paper, SegmentedControl, Select, Stack, Text, Textarea, TextInput, Timeline, Title } from '@mantine/core';
import { notifications } from '@mantine/notifications';
import { IconMail, IconPlus } from '@tabler/icons-react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { useMemo, useState } from 'react';
import { Link, useSearchParams } from 'react-router-dom';
import { AddLink, append, LinkedText, useMe } from '../components/ManualTopics';
import { useAccess } from '../lib/access';
import { COUNTRIES, COUNTRY_HE, propertyTitle } from '../lib/format';
import {
  assigneeKey, describeEvent, openByAssignee, PRIORITY_COLOR, PRIORITY_HE, sortTasks, STATUS_COLOR, STATUS_HE, taskMail, TRIGGER_HE,
  type Assignee, type OfficeTask, type Priority, type SortKey, type TaskEvent, type TaskLink, type TaskStatus, type Trigger,
} from '../lib/officeTasks';
import { useClients, useContacts, useProperties } from '../lib/queries';
import { must, supabase } from '../lib/supabase';
import { gmailLink, mailtoLink } from '../lib/topicMail';

// Tasks (SPEC decision 128). Each task is seen only by its author, whoever it is with,
// management and admins; the database enforces it. All of them may answer it.

interface Person { user_id: string; display_name: string; email: string | null; client_party_id: string | null }

function usePeople() {
  return useQuery({ queryKey: ['task-people'], queryFn: async () => must(await supabase.rpc('task_people')) as Person[] });
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
    return { nameOf, emailOf, linkName, linkPath, assigneeOptions, linkOptions, users };
  }, [people.data, clients.data, contacts.data, properties.data, access.isClient]);
}
type Directory = ReturnType<typeof useDirectory>;

const linkValue = (l: TaskLink) => `${l.kind}:${l.entity_id ?? l.country_code}`;
const toLink = (v: string): TaskLink => {
  const [kind, id] = v.split(':') as [TaskLink['kind'], string];
  return kind === 'country' ? { kind, entity_id: null, country_code: id } : { kind, entity_id: id, country_code: null };
};
const toAssignee = (v: string): Assignee => (v.startsWith('u:') ? { user_id: v.slice(2), party_id: null } : { user_id: null, party_id: v.slice(2) });
const TRIGGERS = (Object.keys(TRIGGER_HE) as Trigger[]).map((k) => ({ value: k, label: TRIGGER_HE[k] }));
const PRIORITIES = (Object.keys(PRIORITY_HE) as Priority[]).map((k) => ({ value: k, label: PRIORITY_HE[k] }));
const STATUSES = (Object.keys(STATUS_HE) as TaskStatus[]).map((k) => ({ value: k, label: STATUS_HE[k] }));

// The e-mail to each person a task is with: Gmail or the computer's mail app. The system
// sends nothing itself; the sender sends it from their own mailbox.
function MailLinks({ task, to, dir, from }: { task: OfficeTask; to: Assignee[]; dir: Directory; from: string }) {
  const withMail = to.filter((a) => dir.emailOf(a));
  if (!withMail.length) return <Text size="xs" c="dimmed">אין כתובת מייל לאף אחד מהם.</Text>;
  return (
    <Stack gap={4}>
      {withMail.map((a) => {
        const m = taskMail(task, dir.nameOf(a), from, window.location.origin);
        const email = dir.emailOf(a)!;
        return (
          <Group key={assigneeKey(a)} gap="xs">
            <IconMail size={14} />
            <Text size="sm">{dir.nameOf(a)}</Text>
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
    trigger: (task?.trigger_kind ?? null) as Trigger | null, subject: task?.subject ?? '', body: task?.body ?? '',
    priority: (task?.priority ?? 'medium') as Priority,
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
          p_links: v.links.map(toLink),
        })) as string;
      } else {
        const fields = { trigger_kind: v.trigger, subject: v.subject.trim(), body: v.body.trim() || null, priority: v.priority };
        if (fields.trigger_kind !== task.trigger_kind || fields.subject !== task.subject || fields.body !== (task.body ?? null) || fields.priority !== task.priority) {
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
          <Select label="טריגר" required data={TRIGGERS} value={v.trigger} onChange={(x) => setV({ ...v, trigger: x as Trigger })} />
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
          <Button onClick={save} loading={busy} disabled={!v.trigger || !v.subject.trim()}>{task ? 'שמירת השינויים' : 'יצירה'}</Button></Group>
      </Stack>
    </Modal>
  );
}

// One task: its details, its history, and the answer (a reply and the state).
function TaskView({ task, dir, onClose }: { task: OfficeTask; dir: Directory; onClose: () => void }) {
  const qc = useQueryClient();
  const access = useAccess();
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
          <Badge variant="outline">{TRIGGER_HE[task.trigger_kind]}</Badge>
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

export function Tasks() {
  const access = useAccess();
  const me = useMe();
  const tasks = useTasks();
  const dir = useDirectory();
  const [params, setParams] = useSearchParams();
  const [sort, setSort] = useState<SortKey>('updated');
  const [state, setState] = useState<'open' | 'done' | 'all'>('open');
  const [who, setWho] = useState<string | null>(null);
  const [adding, setAdding] = useState(false);
  const [created, setCreated] = useState<{ task: OfficeTask; to: Assignee[] } | null>(null);
  const all = tasks.data ?? [];
  const open = params.get('task');
  const current = all.find((t) => t.id === open) ?? null;
  const counts = openByAssignee(all);
  const whoOptions = [
    { value: 'mine', label: 'אצלי' }, { value: 'sent', label: 'שפתחתי' },
    ...[...counts].map(([k, n]) => ({ value: k, label: `${dir.nameOf(toAssignee(k))} (${n})` })).sort((a, b) => a.label.localeCompare(b.label, 'he')),
  ];
  const shown = sortTasks(all.filter((t) => (state === 'all' || (state === 'done') === (t.status === 'done'))
    && (!who || (who === 'mine' ? t.office_task_assignees.some((a) => a.user_id === me) : who === 'sent' ? t.created_by === me
      : t.office_task_assignees.some((a) => assigneeKey(a) === who)))), sort, dir.nameOf);

  return (
    <Stack>
      <Group justify="space-between">
        <Title order={2}>משימות</Title>
        {!access.isClient && <Button leftSection={<IconPlus size={16} />} onClick={() => setAdding(true)}>משימה חדשה</Button>}
      </Group>
      <Group gap="sm" align="flex-end">
        <SegmentedControl value={state} onChange={(x) => setState(x as typeof state)}
          data={[{ value: 'open', label: 'פתוחות' }, { value: 'done', label: 'טופלו' }, { value: 'all', label: 'הכול' }]} />
        <Select label="מיון" w={170} allowDeselect={false} value={sort} onChange={(x) => x && setSort(x as SortKey)}
          data={[{ value: 'updated', label: 'עדכון אחרון' }, { value: 'created', label: 'תאריך פתיחה' }, { value: 'priority', label: 'דחיפות' }, { value: 'subject', label: 'נושא' }, { value: 'assignee', label: 'בטיפול של' }]} />
        <Select label="בטיפול של" w={240} clearable placeholder="כל המשימות שאני רואה" data={whoOptions} value={who} onChange={setWho} searchable />
        <Text size="sm" c="dimmed">{shown.length} משימות</Text>
      </Group>
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
                  <Badge size="sm" variant="outline">{TRIGGER_HE[t.trigger_kind]}</Badge>
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
      {adding && <TaskForm dir={dir} onClose={() => setAdding(false)} onSaved={(t, to) => { setAdding(false); setCreated({ task: t, to }); }} />}
      {current && <TaskView key={current.id} task={current} dir={dir} onClose={() => setParams({})} />}
    </Stack>
  );
}
