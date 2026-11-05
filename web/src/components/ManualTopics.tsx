import { Alert, Anchor, Badge, Button, Group, Modal, MultiSelect, Paper, Popover, Select, Stack, Switch, Text, Textarea, TextInput } from '@mantine/core';
import { modals } from '@mantine/modals';
import { notifications } from '@mantine/notifications';
import { IconExternalLink, IconLink, IconMail, IconTool } from '@tabler/icons-react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { Fragment, useEffect, useMemo, useState } from 'react';
import { Link } from 'react-router-dom';
import { useAccess } from '../lib/access';
import { appPath, fixLinkOk, namedLink, splitLinks } from '../lib/links';
import { must, supabase } from '../lib/supabase';
import { gmailLink, mailtoLink, topicMail, topicMailHtml } from '../lib/topicMail';

// Topics added by hand on the completeness page (SPEC decision 92): a question or a task,
// sent to an employee (or to no one), about any number of clients, contacts and
// properties, with an optional link "to fix it". Stored in app.tasks and app.task_links.
export interface TopicLink { entity_type: string; entity_id: string }
export interface Topic {
  id: string; title: string; notes: string | null; assignee_id: string | null; status: string; created_by: string | null;
  created_at: string; reply: string | null; done_at: string | null; fix_url: string | null; edited_at?: string | null; task_links: TopicLink[];
}
export interface Option { value: string; label: string }
export interface Lists { clients: Option[]; contacts: Option[]; properties: Option[] }

export interface Staff { user_id: string; display_name: string; email: string | null }
export function useStaff() {
  return useQuery({
    queryKey: ['staff-directory'],
    queryFn: async () => must(await supabase.rpc('staff_directory')) as Staff[],
  });
}
export function useTopics() {
  return useQuery({
    queryKey: ['manual-topics'],
    queryFn: async () => must(await supabase.from('tasks')
      // '*' so that a column added later (edited_at) does not break the list before its migration.
      .select('*, task_links(entity_type, entity_id)')
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

// Text with its links: a named link shows its name, a bare address shows itself. Web
// addresses open in a new tab, pages of the app open in place.
export function LinkedText({ text, size = 'sm' }: { text: string; size?: string }) {
  return (
    <Text size={size} style={{ whiteSpace: 'pre-wrap', overflowWrap: 'anywhere' }}>
      {splitLinks(text).map((p, i) => !('url' in p) ? <Fragment key={i}>{p.text}</Fragment>
        : p.url.startsWith('/')
          ? <Anchor key={i} component={Link} to={p.url} size={size}>{p.label ?? p.url}</Anchor>
          : <Anchor key={i} href={p.url} target="_blank" rel="noopener noreferrer" size={size}>{p.label ?? p.url}</Anchor>)}
    </Text>
  );
}

// "Add a link": an address and, if wanted, the words to show instead of it. Appends
// [words](address) to the text, or the bare address when no words are given.
function AddLink({ onAdd }: { onAdd: (link: string) => void }) {
  const [open, setOpen] = useState(false);
  const [label, setLabel] = useState(''), [url, setUrl] = useState('');
  const target = appPath(url, window.location.origin);
  const bad = !!url.trim() && !fixLinkOk(target);
  const add = () => { onAdd(namedLink(label, target)); setLabel(''); setUrl(''); setOpen(false); };
  return (
    <Popover opened={open} onChange={setOpen} position="bottom-start" withArrow trapFocus>
      <Popover.Target>
        <Button size="compact-xs" variant="subtle" leftSection={<IconLink size={14} />} onClick={() => setOpen((o) => !o)}>הוספת קישור</Button>
      </Popover.Target>
      <Popover.Dropdown>
        <Stack gap="xs" w={300}>
          <TextInput size="xs" label="כתובת" dir="ltr" placeholder="https://…" value={url} onChange={(e) => setUrl(e.currentTarget.value)}
            error={bad ? 'צריך להתחיל ב-https:// או להיות דף באתר' : undefined} data-autofocus />
          <TextInput size="xs" label="טקסט להצגה (לא חובה)" description="ריק: תוצג הכתובת עצמה" placeholder="למשל: החוזה בדרייב" value={label} onChange={(e) => setLabel(e.currentTarget.value)} />
          <Button size="xs" onClick={add} disabled={!url.trim() || bad}>הוספה</Button>
        </Stack>
      </Popover.Dropdown>
    </Popover>
  );
}
const append = (text: string, link: string) => (text && !/\s$/.test(text) ? `${text} ` : text) + link;

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

// A ready-made e-mail to the employee a topic was sent to: Gmail, the computer's mail app,
// or copy. The system sends nothing itself; the sender sends it from their own mailbox.
function MailDraft({ to, topic, from }: { to: Staff; topic: { title: string; notes: string | null; fix_url: string | null }; from: string }) {
  const input = { title: topic.title, notes: topic.notes, fixUrl: topic.fix_url, to: to.display_name, from, origin: window.location.origin };
  const { subject, body } = topicMail(input);
  const [copied, setCopied] = useState(false);
  if (!to.email) return <Text size="xs" c="dimmed">אין כתובת מייל ל{to.display_name}.</Text>;
  // A compose link carries plain text only, so the version with real links goes through the
  // clipboard: copy it (as HTML, with the plain text beside it), then paste into the draft.
  const copyRich = async () => {
    try {
      await navigator.clipboard.write([new ClipboardItem({
        'text/html': new Blob([topicMailHtml(input)], { type: 'text/html' }),
        'text/plain': new Blob([body], { type: 'text/plain' }),
      })]);
      setCopied(true);
      return true;
    } catch { return false; }
  };
  // Copy first, while this page has the focus, then open the draft. When the copy fails (a
  // browser that refuses, a phone) the draft opens with the plain text, so it is never empty.
  const gmail = async () => {
    const ok = await copyRich();
    const url = ok ? gmailLink(to.email!, subject) : gmailLink(to.email!, subject, body);
    if (!window.open(url, '_blank', 'noopener')) window.location.assign(url);
    if (!ok) notifications.show({ color: 'yellow', message: 'לא הצלחתי להעתיק עם קישורים, אז הטיוטה נפתחה עם טקסט רגיל' });
  };
  return (
    <Stack gap={6}>
      <Alert color="blue" variant="light" p="xs">
        <Text size="sm">בטיוטה שתיפתח ב-Gmail גוף ההודעה ריק: <b>לחץ בגוף ההודעה והדבק (Ctrl+V)</b>. ההודעה כבר מועתקת, עם הקישורים.</Text>
      </Alert>
      <Group gap="xs">
        <Button size="xs" leftSection={<IconMail size={14} />} onClick={gmail}>פתיחת טיוטה ב-Gmail</Button>
        <Button size="xs" variant="default" onClick={async () => { if (!(await copyRich())) notifications.show({ color: 'red', message: 'ההעתקה נכשלה' }); }}>{copied ? 'הועתק ✓' : 'העתקה עם קישורים'}</Button>
        <Button size="xs" variant="subtle" component="a" href={gmailLink(to.email, subject, body)} target="_blank" rel="noopener">Gmail בטקסט רגיל</Button>
        <Button size="xs" variant="subtle" component="a" href={mailtoLink(to.email, subject, body)}>תוכנת מייל</Button>
      </Group>
      <Text size="xs" c="dimmed">אל {to.email}. שולחים מהתיבה שלך. "Gmail בטקסט רגיל" פותח טיוטה מלאה, אבל עם כתובות במקום קישורים.</Text>
    </Stack>
  );
}

function MailButton({ to, topic, from, opened, setOpened }: { to: Staff; topic: Topic; from: string; opened: boolean; setOpened: (o: boolean) => void }) {
  return (
    <Popover opened={opened} onChange={setOpened} position="bottom-start" withArrow>
      <Popover.Target>
        <Button size="compact-xs" variant="subtle" leftSection={<IconMail size={14} />} onClick={() => setOpened(!opened)}>מייל ל{to.display_name}</Button>
      </Popover.Target>
      <Popover.Dropdown><MailDraft to={to} topic={topic} from={from} /></Popover.Dropdown>
    </Popover>
  );
}

// A new topic, or (with `topic`) editing one: only its author or an admin gets here, and
// the database checks the same (migration 39).
export function NewTopic({ lists, onClose, topic }: { lists: Lists; onClose: () => void; topic?: Topic }) {
  const qc = useQueryClient();
  const staff = useStaff();
  const [title, setTitle] = useState(topic?.title ?? ''), [notes, setNotes] = useState(topic?.notes ?? '');
  const [assignee, setAssignee] = useState<string | null>(topic?.assignee_id ?? null);
  const [about, setAbout] = useState<string[]>(() => (topic?.task_links ?? []).map(keyOf));
  const [fix, setFix] = useState(topic?.fix_url ?? '');
  const [busy, setBusy] = useState(false);
  const aboutOptions = useAboutOptions(lists);
  const fixUrl = appPath(fix, window.location.origin);
  const fixBad = !!fix.trim() && !fixLinkOk(fixUrl);
  const me = useMe();
  const [saved, setSaved] = useState<{ title: string; notes: string | null; fix_url: string | null } | null>(null);
  const to = (staff.data ?? []).find((s) => s.user_id === assignee);
  const from = (staff.data ?? []).find((s) => s.user_id === me)?.display_name ?? '';
  const save = async () => {
    setBusy(true);
    try {
      const fields = { title: title.trim(), notes: notes.trim() || null, assignee_id: assignee, fix_url: fix.trim() ? fixUrl : null };
      const id = topic
        ? (must(await supabase.from('tasks').update(fields).eq('id', topic.id)), topic.id)
        : (must(await supabase.from('tasks').insert(fields).select('id').single()) as { id: string }).id;
      const before = new Set((topic?.task_links ?? []).map(keyOf));
      const added = about.filter((a) => !before.has(a));
      const removed = [...before].filter((a) => !about.includes(a));
      if (added.length) {
        must(await supabase.from('task_links').insert(added.map((a) => { const [entity_type, entity_id] = a.split(':'); return { task_id: id, entity_type, entity_id }; })));
      }
      for (const a of removed) {
        const [entity_type, entity_id] = a.split(':');
        must(await supabase.from('task_links').delete().match({ task_id: id, entity_type, entity_id }));
      }
      notifications.show({ color: 'teal', message: topic ? 'הנושא עודכן' : 'הנושא נוסף' });
      qc.invalidateQueries({ queryKey: ['manual-topics'] });
      // With an employee newly chosen, the dialog stays open on the e-mail draft to them.
      if (to && assignee !== (topic?.assignee_id ?? null)) setSaved({ title: title.trim(), notes: notes.trim() || null, fix_url: fix.trim() ? fixUrl : null });
      else onClose();
    } catch (e) { notifications.show({ color: 'red', message: (e as Error).message }); } finally { setBusy(false); }
  };
  return (
    <Modal opened onClose={onClose} title={topic ? 'עריכת הנושא' : 'נושא חדש'} size="lg">
      {saved && to ? (
        <Stack>
          <Text>הנושא נשמר ומופיע לכל העובדים. נשאר לשלוח מייל ל{to.display_name}:</Text>
          <MailDraft to={to} topic={saved} from={from} />
          <Group justify="flex-end"><Button variant="default" onClick={onClose}>סגירה</Button></Group>
        </Stack>
      ) : (
      <Stack>
        <TextInput label="נושא" placeholder="למשל: לברר מי השוכר בדירה 23" value={title} onChange={(e) => setTitle(e.currentTarget.value)} required />
        <Stack gap={2}>
          <Textarea label="פירוט או שאלה" description="כתובת שמדביקים (https://…) תוצג כקישור. כדי שיופיע טקסט במקום הכתובת: הוספת קישור" autosize minRows={3}
            value={notes} onChange={(e) => setNotes(e.currentTarget.value)} />
          <Group><AddLink onAdd={(l) => setNotes((n) => append(n, l))} /></Group>
        </Stack>
        <TextInput label="קישור לתיקון (לא חובה)" description="כתובת של דף באתר (למשל כרטיס לקוח) או קישור חיצוני (Drive וכדומה)" dir="ltr"
          placeholder="https://…" value={fix} onChange={(e) => setFix(e.currentTarget.value)} error={fixBad ? 'צריך להתחיל ב-https:// או להיות דף באתר' : undefined} />
        <Select label="עובד/ת אחראי/ת (לא חובה)" description="הנושא גלוי לכל העובדים. אחרי השמירה תיפתח טיוטת מייל אליו/ה" placeholder="בלי שיוך" clearable searchable value={assignee} onChange={setAssignee}
          data={(staff.data ?? []).map((s) => ({ value: s.user_id, label: s.display_name }))} nothingFoundMessage="לא נמצא" />
        <MultiSelect label="קשור ל (לא חובה)" description="אפשר לבחור כמה: לקוחות, אנשי קשר ונכסים" placeholder="חיפוש לפי שם" clearable searchable
          value={about} onChange={setAbout} data={aboutOptions} limit={50} nothingFoundMessage="לא נמצא" />
        <Group justify="flex-end"><Button variant="default" onClick={onClose}>ביטול</Button>
          <Button onClick={save} loading={busy} disabled={!title.trim() || fixBad}>שמירה</Button></Group>
      </Stack>
      )}
    </Modal>
  );
}

function TopicCard({ t, names, about, me, isAdmin, staff, people, lists }: {
  t: Topic; names: Map<string, string>; about: Map<string, string>; me: string; isAdmin: boolean; staff: Option[]; people: Staff[]; lists: Lists;
}) {
  const [editing, setEditing] = useState(false);
  const mine = t.created_by === me || isAdmin;
  const [mailOpen, setMailOpen] = useState(false);
  const to = people.find((p) => p.user_id === t.assignee_id);
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
            <Text size="xs" c="dimmed">נשלח ע"י {names.get(t.created_by ?? '') ?? 'לא ידוע'} · {when(t.created_at)}{t.edited_at ? ` · נערך ${when(t.edited_at)}` : ''}{done && t.done_at ? ` · בוצע ${when(t.done_at)}` : ''}</Text>
            {editing && <NewTopic topic={t} lists={lists} onClose={() => setEditing(false)} />}
          </Stack>
          <Group gap="xs" wrap="nowrap">
            {t.fix_url && <FixLink url={t.fix_url} />}
            {mine && <Button size="compact-xs" variant="subtle" onClick={() => setEditing(true)}>עריכה</Button>}
            {mine && <Button size="compact-xs" variant="subtle" color="red" onClick={remove}>מחיקה</Button>}
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
        <Select size="xs" w={260} label="אחראי/ת" placeholder="לא שויך" clearable searchable data={staff} value={t.assignee_id}
          onChange={async (v) => { await update({ assignee_id: v }, v ? `שויך ל${names.get(v) ?? ''}` : 'השיוך הוסר'); if (v) setMailOpen(true); }} />
        {to && <Group><MailButton to={to} topic={t} from={names.get(me) ?? ''} opened={mailOpen} setOpened={setMailOpen} /></Group>}
        {t.reply && <Paper bg="gray.0" p="xs"><Text size="xs" c="dimmed">תשובה</Text><LinkedText text={t.reply} /></Paper>}
        <Textarea placeholder={t.reply ? 'עריכת התשובה' : 'תשובה (קישורים יוצגו כקישורים)'} autosize minRows={1} value={reply} onChange={(e) => setReply(e.currentTarget.value)} />
        <Group gap="xs">
          <AddLink onAdd={(l) => setReply((r) => append(r, l))} />
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
          { group: 'שלי', items: [{ value: 'mine', label: 'שויכו אליי' }, { value: 'sent', label: 'פתחתי' }, { value: 'none', label: 'לא שויכו' }] },
          { group: 'לפי עובד/ת', items: staffOptions },
        ]} />
        <Switch label="כולל נושאים שבוצעו" checked={showDone} onChange={(e) => setShowDone(e.currentTarget.checked)} />
      </Group>
      <Text size="sm" c="dimmed">{list.length} נושאים</Text>
      {list.map((t) => <TopicCard key={t.id} t={t} names={names} about={about} me={me} isAdmin={access.isAdmin} staff={staffOptions} people={staff.data ?? []} lists={lists} />)}
    </Stack>
  );
}
