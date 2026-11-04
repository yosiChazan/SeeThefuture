import { Anchor, Badge, Button, Group, Modal, Paper, Select, Stack, Switch, Text, Textarea, TextInput } from '@mantine/core';
import { modals } from '@mantine/modals';
import { notifications } from '@mantine/notifications';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { useEffect, useMemo, useState } from 'react';
import { Link } from 'react-router-dom';
import { useAccess } from '../lib/access';
import { must, supabase } from '../lib/supabase';

// Topics added by hand on the completeness page (SPEC decision 92): a question or a task,
// sent to an employee, answered and closed there. Stored in app.tasks.
export interface Topic {
  id: string; title: string; notes: string | null; entity_type: string | null; entity_id: string | null;
  assignee_id: string | null; status: string; created_by: string | null; created_at: string; reply: string | null; done_at: string | null;
}
interface Option { value: string; label: string }

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
      .select('id, title, notes, entity_type, entity_id, assignee_id, status, created_by, created_at, reply, done_at')
      .order('created_at', { ascending: false })) as Topic[],
  });
}
export function useMe() {
  const [me, setMe] = useState('');
  useEffect(() => { supabase.auth.getUser().then(({ data }) => setMe(data.user?.id ?? '')); }, []);
  return me;
}

const when = (s: string) => new Date(s).toLocaleDateString('he-IL');
const linkOf = (t: Topic) => !t.entity_id ? null : t.entity_type === 'property' ? `/properties/${t.entity_id}` : t.entity_type === 'party' ? `/clients/${t.entity_id}` : t.entity_type === 'lease' ? `/leases/${t.entity_id}` : null;

export function NewTopic({ clients, properties, onClose }: { clients: Option[]; properties: Option[]; onClose: () => void }) {
  const qc = useQueryClient();
  const staff = useStaff();
  const [title, setTitle] = useState(''), [notes, setNotes] = useState(''), [assignee, setAssignee] = useState<string | null>(null);
  const [about, setAbout] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const aboutOptions = useMemo(() => [
    { group: 'לקוחות', items: clients.map((c) => ({ value: `party:${c.value}`, label: c.label })) },
    { group: 'נכסים', items: properties.map((p) => ({ value: `property:${p.value}`, label: p.label })) },
  ], [clients, properties]);
  const save = async () => {
    setBusy(true);
    try {
      const [entity_type, entity_id] = about ? about.split(':') : [null, null];
      must(await supabase.from('tasks').insert({ title: title.trim(), notes: notes.trim() || null, assignee_id: assignee, entity_type, entity_id }));
      notifications.show({ color: 'teal', message: assignee ? 'הנושא נשלח' : 'הנושא נוסף' });
      qc.invalidateQueries({ queryKey: ['manual-topics'] });
      onClose();
    } catch (e) { notifications.show({ color: 'red', message: (e as Error).message }); } finally { setBusy(false); }
  };
  return (
    <Modal opened onClose={onClose} title="נושא חדש" size="lg">
      <Stack>
        <TextInput label="נושא" placeholder="למשל: לברר מי השוכר בדירה 23" value={title} onChange={(e) => setTitle(e.currentTarget.value)} required />
        <Textarea label="פירוט או שאלה" autosize minRows={3} value={notes} onChange={(e) => setNotes(e.currentTarget.value)} />
        <Select label="לשלוח לעובד/ת" placeholder="בלי שיוך: פתוח לכולם" clearable searchable value={assignee} onChange={setAssignee}
          data={(staff.data ?? []).map((s) => ({ value: s.user_id, label: s.display_name }))} />
        <Select label="קשור ל (לא חובה)" placeholder="לקוח או נכס" clearable searchable value={about} onChange={setAbout} data={aboutOptions} limit={50} />
        <Group justify="flex-end"><Button variant="default" onClick={onClose}>ביטול</Button>
          <Button onClick={save} loading={busy} disabled={!title.trim()}>{assignee ? 'שליחה' : 'הוספה'}</Button></Group>
      </Stack>
    </Modal>
  );
}

function TopicCard({ t, names, about, me, isAdmin }: { t: Topic; names: Map<string, string>; about: Map<string, string>; me: string; isAdmin: boolean }) {
  const qc = useQueryClient();
  const [reply, setReply] = useState(t.reply ?? '');
  const [busy, setBusy] = useState(false);
  const done = t.status === 'done';
  const link = linkOf(t);
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
            <Text size="xs" c="dimmed">
              נשלח ע"י {names.get(t.created_by ?? '') ?? 'לא ידוע'} · {when(t.created_at)} · {t.assignee_id ? `אל ${names.get(t.assignee_id) ?? 'עובד/ת'}` : 'לא שויך'}
              {done && t.done_at ? ` · בוצע ${when(t.done_at)}` : ''}
            </Text>
          </Stack>
          {(t.created_by === me || isAdmin) && <Button size="compact-xs" variant="subtle" color="red" onClick={remove}>מחיקה</Button>}
        </Group>
        {t.notes && <Text size="sm" style={{ whiteSpace: 'pre-wrap' }}>{t.notes}</Text>}
        {link && <Anchor component={Link} to={link} size="sm">{about.get(`${t.entity_type}:${t.entity_id}`) ?? 'פתיחה'}</Anchor>}
        <Textarea placeholder="תשובה" autosize minRows={1} value={reply} onChange={(e) => setReply(e.currentTarget.value)} />
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
export function ManualTopics({ clients, properties, search }: { clients: Option[]; properties: Option[]; search: string }) {
  const access = useAccess();
  const me = useMe();
  const staff = useStaff();
  const topics = useTopics();
  const [who, setWho] = useState<string | null>(null);
  const [showDone, setShowDone] = useState(false);
  const names = useMemo(() => new Map((staff.data ?? []).map((s) => [s.user_id, s.display_name])), [staff.data]);
  const about = useMemo(() => new Map([...clients.map((c) => [`party:${c.value}`, c.label] as const), ...properties.map((p) => [`property:${p.value}`, p.label] as const)]), [clients, properties]);
  const s = search.trim().toLowerCase();
  const list = (topics.data ?? []).filter((t) => (showDone ? true : t.status !== 'done')
    && (!who || (who === 'mine' ? t.assignee_id === me : who === 'sent' ? t.created_by === me : who === 'none' ? !t.assignee_id : t.assignee_id === who))
    && (!s || `${t.title} ${t.notes ?? ''}`.toLowerCase().includes(s)));
  return (
    <Stack>
      <Group>
        <Select placeholder="כל העובדים" clearable value={who} onChange={setWho} w={240} data={[
          { group: 'שלי', items: [{ value: 'mine', label: 'נשלחו אליי' }, { value: 'sent', label: 'שלחתי' }, { value: 'none', label: 'לא שויכו' }] },
          { group: 'לפי עובד/ת', items: (staff.data ?? []).map((x) => ({ value: x.user_id, label: x.display_name })) },
        ]} />
        <Switch label="כולל נושאים שבוצעו" checked={showDone} onChange={(e) => setShowDone(e.currentTarget.checked)} />
      </Group>
      <Text size="sm" c="dimmed">{list.length} נושאים</Text>
      {list.map((t) => <TopicCard key={t.id} t={t} names={names} about={about} me={me} isAdmin={access.isAdmin} />)}
    </Stack>
  );
}
