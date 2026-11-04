import { Anchor, Badge, Button, Group, Modal, MultiSelect, Paper, Select, Stack, Switch, Text, Textarea, TextInput } from '@mantine/core';
import { modals } from '@mantine/modals';
import { notifications } from '@mantine/notifications';
import { IconExternalLink, IconTool } from '@tabler/icons-react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { Fragment, useEffect, useMemo, useState } from 'react';
import { Link } from 'react-router-dom';
import { useAccess } from '../lib/access';
import { appPath, fixLinkOk, splitLinks } from '../lib/links';
import { must, supabase } from '../lib/supabase';

// Topics added by hand on the completeness page (SPEC decision 92): a question or a task,
// sent to an employee (or to no one), about any number of clients, contacts and
// properties, with an optional link "to fix it". Stored in app.tasks and app.task_links.
export interface TopicLink { entity_type: string; entity_id: string }
export interface Topic {
  id: string; title: string; notes: string | null; assignee_id: string | null; status: string; created_by: string | null;
  created_at: string; reply: string | null; done_at: string | null; fix_url: string | null; task_links: TopicLink[];
}
export interface Option { value: string; label: string }
export interface Lists { clients: Option[]; contacts: Option[]; properties: Option[] }

export function useStaff() {
  return useQuery({
    queryKey: ['staff-directory'],
    queryFn: async () => must(await supabase.rpc('staff_directory')) as { user_id: string; display_name: string }[],
  });
}
export function useTopics() {
  return useQuery({
    queryKey: ['manual-topics'],
    queryFn: async () => must(await supabase.from('tasks')
      .select('id, title, notes, assignee_id, status, created_by, created_at, reply, done_at, fix_url, task_links(entity_type, entity_id)')
      .order('created_at', { ascending: false })) as Topic[],
  });
}
export function useMe() {
  const [me, setMe] = useState('');
  useEffect(() => { supabase.auth.getUser().then(({ data }) => setMe(data.user?.id ?? '')); }, []);
  return me;
}

const when = (s: string) => new Date(s).toLocaleDateString('he-IL');
const keyOf = (l: TopicLink) => `${l.entity_type}:${l.entity_id}`;
const pathOf = (l: TopicLink) => l.entity_type === 'property' ? `/properties/${l.entity_id}` : l.entity_type === 'lease' ? `/leases/${l.entity_id}` : `/clients/${l.entity_id}`;

// Text with its web addresses as links, opening in a new tab.
export function LinkedText({ text, size = 'sm' }: { text: string; size?: string }) {
  return (
    <Text size={size} style={{ whiteSpace: 'pre-wrap', overflowWrap: 'anywhere' }}>
      {splitLinks(text).map((p, i) => 'url' in p
        ? <Anchor key={i} href={p.url} target="_blank" rel="noopener noreferrer" size={size}>{p.url}</Anchor>
        : <Fragment key={i}>{p.text}</Fragment>)}
    </Text>
  );
}

function FixLink({ url }: { url: string }) {
  const inApp = url.startsWith('/');
  return inApp
    ? <Button size="xs" variant="light" color="orange" leftSection={<IconTool size={14} />} component={Link} to={url}>לתיקון</Button>
    : <Button size="xs" variant="light" color="orange" leftSection={<IconExternalLink size={14} />} component="a" href={url} target="_blank" rel="noopener noreferrer">לתיקון</Button>;
}

function useAboutOptions({ clients, contacts, properties }: Lists) {
  return useMemo(() => [
    { group: 'לקוחות', items: clients.map((c) => ({ value: `party:${c.value}`, label: c.label })) },
    { group: 'אנשי קשר', items: contacts.map((c) => ({ value: `party:${c.value}`, label: c.label })) },
    { group: 'נכסים', items: properties.map((p) => ({ value: `property:${p.value}`, label: p.label })) },
  ], [clients, contacts, properties]);
}

export function NewTopic({ lists, onClose }: { lists: Lists; onClose: () => void }) {
  const qc = useQueryClient();
  const staff = useStaff();
  const [title, setTitle] = useState(''), [notes, setNotes] = useState(''), [assignee, setAssignee] = useState<string | null>(null);
  const [about, setAbout] = useState<string[]>([]);
  const [fix, setFix] = useState('');
  const [busy, setBusy] = useState(false);
  const aboutOptions = useAboutOptions(lists);
  const fixUrl = appPath(fix, window.location.origin);
  const fixBad = !!fix.trim() && !fixLinkOk(fixUrl);
  const save = async () => {
    setBusy(true);
    try {
      const row = must(await supabase.from('tasks').insert({
        title: title.trim(), notes: notes.trim() || null, assignee_id: assignee, fix_url: fix.trim() ? fixUrl : null,
      }).select('id').single()) as { id: string };
      if (about.length) {
        must(await supabase.from('task_links').insert(about.map((a) => { const [entity_type, entity_id] = a.split(':'); return { task_id: row.id, entity_type, entity_id }; })));
      }
      notifications.show({ color: 'teal', message: assignee ? 'הנושא נשלח' : 'הנושא נוסף' });
      qc.invalidateQueries({ queryKey: ['manual-topics'] });
      onClose();
    } catch (e) { notifications.show({ color: 'red', message: (e as Error).message }); } finally { setBusy(false); }
  };
  return (
    <Modal opened onClose={onClose} title="נושא חדש" size="lg">
      <Stack>
        <TextInput label="נושא" placeholder="למשל: לברר מי השוכר בדירה 23" value={title} onChange={(e) => setTitle(e.currentTarget.value)} required />
        <Textarea label="פירוט או שאלה" description="קישורים שמדביקים כאן (https://…) יוצגו כקישורים" autosize minRows={3}
          value={notes} onChange={(e) => setNotes(e.currentTarget.value)} />
        <TextInput label="קישור לתיקון (לא חובה)" description="כתובת של דף באתר (למשל כרטיס לקוח) או קישור חיצוני (Drive וכדומה)" dir="ltr"
          placeholder="https://…" value={fix} onChange={(e) => setFix(e.currentTarget.value)} error={fixBad ? 'צריך להתחיל ב-https:// או להיות דף באתר' : undefined} />
        <Select label="לשלוח לעובד/ת (לא חובה)" placeholder="בלי שיוך: פתוח לכולם" clearable searchable value={assignee} onChange={setAssignee}
          data={(staff.data ?? []).map((s) => ({ value: s.user_id, label: s.display_name }))} nothingFoundMessage="לא נמצא" />
        <MultiSelect label="קשור ל (לא חובה)" description="אפשר לבחור כמה: לקוחות, אנשי קשר ונכסים" placeholder="חיפוש לפי שם" clearable searchable
          value={about} onChange={setAbout} data={aboutOptions} limit={50} nothingFoundMessage="לא נמצא" />
        <Group justify="flex-end"><Button variant="default" onClick={onClose}>ביטול</Button>
          <Button onClick={save} loading={busy} disabled={!title.trim() || fixBad}>{assignee ? 'שליחה' : 'הוספה'}</Button></Group>
      </Stack>
    </Modal>
  );
}

function TopicCard({ t, names, about, me, isAdmin, staff }: {
  t: Topic; names: Map<string, string>; about: Map<string, string>; me: string; isAdmin: boolean; staff: Option[];
}) {
  const qc = useQueryClient();
  const [reply, setReply] = useState(t.reply ?? '');
  const [busy, setBusy] = useState(false);
  const done = t.status === 'done';
  const update = async (changes: Partial<Topic>, msg: string) => {
    setBusy(true);
    try { must(await supabase.from('tasks').update(changes).eq('id', t.id)); notifications.show({ color: 'teal', message: msg }); qc.invalidateQueries({ queryKey: ['manual-topics'] }); }
    catch (e) { notifications.show({ color: 'red', message: (e as Error).message }); } finally { setBusy(false); }
  };
  const remove = () => modals.openConfirmModal({
    title: 'מחיקת הנושא', children: <Text size="sm">"{t.title}" יימחק. המחיקה נשמרת ביומן הפעילות.</Text>,
    labels: { confirm: 'מחיקה', cancel: 'ביטול' }, confirmProps: { color: 'red' },
    onConfirm: async () => { must(await supabase.from('tasks').delete().eq('id', t.id)); qc.invalidateQueries({ queryKey: ['manual-topics'] }); },
  });
  return (
    <Paper withBorder p="sm" style={done ? { opacity: 0.7 } : undefined}>
      <Stack gap={6}>
        <Group justify="space-between" align="flex-start" wrap="nowrap">
          <Stack gap={2} style={{ minWidth: 0, flex: 1 }}>
            <Group gap="xs">
              <Badge variant="light" color="violet">ידני</Badge>
              {done && <Badge variant="light" color="teal">בוצע</Badge>}
              <Text fw={600}>{t.title}</Text>
            </Group>
            <Text size="xs" c="dimmed">נשלח ע"י {names.get(t.created_by ?? '') ?? 'לא ידוע'} · {when(t.created_at)}{done && t.done_at ? ` · בוצע ${when(t.done_at)}` : ''}</Text>
          </Stack>
          <Group gap="xs" wrap="nowrap">
            {t.fix_url && <FixLink url={t.fix_url} />}
            {(t.created_by === me || isAdmin) && <Button size="compact-xs" variant="subtle" color="red" onClick={remove}>מחיקה</Button>}
          </Group>
        </Group>
        {t.notes && <LinkedText text={t.notes} />}
        {t.task_links.length > 0 && (
          <Group gap={6}>
            {t.task_links.map((l) => (
              <Badge key={keyOf(l)} variant="outline" size="md" style={{ textTransform: 'none' }}>
                <Anchor component={Link} to={pathOf(l)} size="xs">{about.get(keyOf(l)) ?? 'פתיחה'}</Anchor>
              </Badge>
            ))}
          </Group>
        )}
        <Select size="xs" w={260} label="נשלח אל" placeholder="לא שויך" clearable searchable data={staff} value={t.assignee_id}
          onChange={(v) => update({ assignee_id: v }, v ? `נשלח אל ${names.get(v) ?? ''}` : 'השיוך הוסר')} />
        {t.reply && <Paper bg="gray.0" p="xs"><Text size="xs" c="dimmed">תשובה</Text><LinkedText text={t.reply} /></Paper>}
        <Textarea placeholder={t.reply ? 'עריכת התשובה' : 'תשובה (קישורים יוצגו כקישורים)'} autosize minRows={1} value={reply} onChange={(e) => setReply(e.currentTarget.value)} />
        <Group gap="xs">
          <Button size="xs" variant="light" disabled={reply === (t.reply ?? '')} loading={busy} onClick={() => update({ reply: reply.trim() || null }, 'התשובה נשמרה')}>שמירת התשובה</Button>
          {done
            ? <Button size="xs" variant="default" loading={busy} onClick={() => update({ status: 'open', done_at: null }, 'הנושא נפתח מחדש')}>פתיחה מחדש</Button>
            : <Button size="xs" color="teal" loading={busy} onClick={() => update({ status: 'done', done_at: new Date().toISOString(), reply: reply.trim() || t.reply }, 'סומן כבוצע')}>בוצע</Button>}
        </Group>
      </Stack>
    </Paper>
  );
}

// The "manual" filter: topics, with a second filter by employee.
export function ManualTopics({ lists, search }: { lists: Lists; search: string }) {
  const access = useAccess();
  const me = useMe();
  const staff = useStaff();
  const topics = useTopics();
  const [who, setWho] = useState<string | null>(null);
  const [showDone, setShowDone] = useState(false);
  const names = useMemo(() => new Map((staff.data ?? []).map((s) => [s.user_id, s.display_name])), [staff.data]);
  const staffOptions = useMemo(() => (staff.data ?? []).map((s) => ({ value: s.user_id, label: s.display_name })), [staff.data]);
  const about = useMemo(() => new Map<string, string>([
    ...[...lists.clients, ...lists.contacts].map((c) => [`party:${c.value}`, c.label] as const),
    ...lists.properties.map((p) => [`property:${p.value}`, p.label] as const),
  ]), [lists]);
  const s = search.trim().toLowerCase();
  const list = (topics.data ?? []).filter((t) => (showDone ? true : t.status !== 'done')
    && (!who || (who === 'mine' ? t.assignee_id === me : who === 'sent' ? t.created_by === me : who === 'none' ? !t.assignee_id : t.assignee_id === who))
    && (!s || `${t.title} ${t.notes ?? ''} ${t.task_links.map((l) => about.get(keyOf(l)) ?? '').join(' ')}`.toLowerCase().includes(s)));
  return (
    <Stack>
      <Group>
        <Select placeholder="כל העובדים" clearable value={who} onChange={setWho} w={240} data={[
          { group: 'שלי', items: [{ value: 'mine', label: 'נשלחו אליי' }, { value: 'sent', label: 'שלחתי' }, { value: 'none', label: 'לא שויכו' }] },
          { group: 'לפי עובד/ת', items: staffOptions },
        ]} />
        <Switch label="כולל נושאים שבוצעו" checked={showDone} onChange={(e) => setShowDone(e.currentTarget.checked)} />
      </Group>
      <Text size="sm" c="dimmed">{list.length} נושאים</Text>
      {list.map((t) => <TopicCard key={t.id} t={t} names={names} about={about} me={me} isAdmin={access.isAdmin} staff={staffOptions} />)}
    </Stack>
  );
}
