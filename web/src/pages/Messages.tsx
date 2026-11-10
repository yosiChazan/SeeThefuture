import { ActionIcon, Alert, Anchor, Avatar, Badge, Box, Group, Menu, ScrollArea, Select, Stack, Switch, Text, TextInput, Title, Tooltip, UnstyledButton } from '@mantine/core';
import { notifications } from '@mantine/notifications';
import { IconArrowRight, IconBrandWhatsapp, IconChecks, IconDotsVertical, IconMoodSmile, IconPaperclip, IconSearch, IconSend } from '@tabler/icons-react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { useMemo, useState } from 'react';
import { Link, useSearchParams } from 'react-router-dom';
import { useStaff } from '../components/ManualTopics';
import { waLink } from '../components/Phone';
import { useClients } from '../lib/queries';
import { must, supabase } from '../lib/supabase';

// The shared WhatsApp inbox (SPEC §6.5, decisions 135, 139), laid out like WhatsApp: chats on
// one side with the last message and its time, the chat on the other with green and white
// bubbles on WhatsApp's background (ours on the left, as WhatsApp shows them in Hebrew), and the typing bar below. Until WhatsApp is connected,
// sending is off; "a sample" shows how it will look, with made-up names.

interface Conversation { id: string; client_party_id: string | null; wa_phone: string; assigned_to: string | null; status: 'open' | 'waiting' | 'closed'; last_message_at: string | null }
interface Message { id: string; conversation_id: string; direction: 'in' | 'out'; body: string | null; media_path: string | null; sent_by: string | null; created_at: string }

const WA = {
  green: '#00a884', header: '#f0f2f5', panel: '#ffffff', chatBg: '#efeae2', out: '#d9fdd3', in: '#ffffff',
  text: '#111b21', muted: '#667781', line: '#e9edef', active: '#f0f2f5', tick: '#53bdeb',
};
// WhatsApp's light doodle background, drawn here so nothing is loaded from outside.
const DOODLE = `url("data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' width='80' height='80' viewBox='0 0 80 80'%3E%3Cg fill='none' stroke='%23d6cfc4' stroke-width='1.2' opacity='.55'%3E%3Ccircle cx='14' cy='14' r='5'/%3E%3Cpath d='M48 10l6 6m0-6l-6 6'/%3E%3Crect x='30' y='44' width='10' height='8' rx='2'/%3E%3Cpath d='M62 56c4-4 8 0 4 4s-8 0-4-4z'/%3E%3Cpath d='M8 60h10M13 55v10'/%3E%3C/g%3E%3C/svg%3E")`;
const STATUS_HE = { open: 'פתוחה', waiting: 'ממתינה ללקוח', closed: 'סגורה' } as const;
const WINDOW_MS = 24 * 3600 * 1000;

const hhmm = (s: string) => new Date(s).toLocaleTimeString('he-IL', { hour: '2-digit', minute: '2-digit' });
function listTime(s: string | null) {
  if (!s) return '';
  const d = new Date(s), now = new Date();
  if (d.toDateString() === now.toDateString()) return hhmm(s);
  const y = new Date(now); y.setDate(now.getDate() - 1);
  if (d.toDateString() === y.toDateString()) return 'אתמול';
  return d.toLocaleDateString('he-IL', { day: '2-digit', month: '2-digit', year: '2-digit' });
}
function dayLabel(s: string) {
  const d = new Date(s), now = new Date();
  if (d.toDateString() === now.toDateString()) return 'היום';
  const y = new Date(now); y.setDate(now.getDate() - 1);
  if (d.toDateString() === y.toDateString()) return 'אתמול';
  return d.toLocaleDateString('he-IL', { day: 'numeric', month: 'long', year: 'numeric' });
}
const initials = (name: string) => name.replace(/[^\p{L}\s]/gu, '').trim().split(/\s+/).slice(0, 2).map((w) => w[0]).join('');

// A sample, with made-up names, to see the screen before WhatsApp is connected.
function sample(): { conversations: Conversation[]; messages: Message[]; names: Map<string, string> } {
  const t = (minAgo: number) => new Date(Date.now() - minAgo * 60000).toISOString();
  const conversations: Conversation[] = [
    { id: 's1', client_party_id: 'p1', wa_phone: '+972500000001', assigned_to: null, status: 'open', last_message_at: t(4) },
    { id: 's2', client_party_id: 'p2', wa_phone: '+972500000002', assigned_to: null, status: 'waiting', last_message_at: t(95) },
    { id: 's3', client_party_id: null, wa_phone: '+380500000003', assigned_to: null, status: 'open', last_message_at: t(60 * 26) },
  ];
  const m = (id: string, c: string, direction: 'in' | 'out', body: string, minAgo: number): Message => ({ id, conversation_id: c, direction, body, media_path: null, sent_by: null, created_at: t(minAgo) });
  const messages = [
    m('1', 's1', 'in', 'שלום, רציתי לשאול אם התקבלה השכירות של אוקטובר בדירה באודסה?', 30),
    m('2', 's1', 'out', 'שלום! כן, השכירות התקבלה ב-3 לחודש ונרשמה בכרטיס שלך 🙂', 22),
    m('3', 's1', 'out', 'אפשר לראות את הפירוט בדוח החודשי שנשלח אליך במייל.', 21),
    m('4', 's1', 'in', 'מעולה, תודה רבה!', 4),
    m('5', 's2', 'out', 'שלום, צריך את חתימתך על ייפוי הכוח לבנק. שלחנו את המסמך במייל.', 120),
    m('6', 's2', 'in', 'אחתום הערב ואשלח', 95),
    m('7', 's3', 'in', 'Hello, the boiler in the apartment was fixed, invoice attached.', 60 * 26),
  ];
  return { conversations, messages, names: new Map([['p1', 'לקוחה לדוגמה'], ['p2', 'לקוח לדוגמה']]) };
}

function useConversations() {
  return useQuery({ queryKey: ['conversations'], queryFn: async () => must(await supabase.from('conversations').select('*').order('last_message_at', { ascending: false, nullsFirst: false })) as Conversation[] });
}
// The last messages of all chats, for each chat's last line in the list.
function useRecentMessages() {
  return useQuery({ queryKey: ['messages-recent'], queryFn: async () => must(await supabase.from('messages').select('*').order('created_at', { ascending: false }).limit(1000)) as Message[] });
}
function useMessages(id: string | null) {
  return useQuery({
    queryKey: ['messages', id], enabled: !!id && !id.startsWith('s'),
    queryFn: async () => must(await supabase.from('messages').select('*').eq('conversation_id', id!).order('created_at')) as Message[],
  });
}

export function Messages() {
  const qc = useQueryClient();
  const real = useConversations();
  const recent = useRecentMessages();
  const clients = useClients();
  const staff = useStaff();
  const [params, setParams] = useSearchParams();
  const [search, setSearch] = useState('');
  const [showClosed, setShowClosed] = useState(false);
  const [demo, setDemo] = useState(false);
  const demoData = useMemo(sample, []);
  const names = useMemo(() => demo ? demoData.names : new Map((clients.data ?? []).map((c) => [c.id, c.display_name])), [clients.data, demo, demoData]);
  const staffNames = useMemo(() => new Map((staff.data ?? []).map((s) => [s.user_id, s.display_name])), [staff.data]);
  const conversations = demo ? demoData.conversations : (real.data ?? []);
  const lastOf = useMemo(() => {
    const out = new Map<string, Message>();
    for (const m of demo ? [...demoData.messages].reverse() : recent.data ?? []) if (!out.has(m.conversation_id)) out.set(m.conversation_id, m);
    return out;
  }, [recent.data, demo, demoData]);
  const who = (c: Conversation) => (c.client_party_id ? names.get(c.client_party_id) : null) ?? c.wa_phone;
  const list = conversations.filter((c) => (showClosed || c.status !== 'closed')
    && (!search.trim() || `${who(c)} ${c.wa_phone}`.includes(search.trim())));
  const current = conversations.find((c) => c.id === params.get('c')) ?? null;
  const thread = useMessages(current?.id ?? null);
  const messages = demo ? demoData.messages.filter((m) => m.conversation_id === current?.id) : thread.data ?? [];
  const lastIn = [...messages].reverse().find((m) => m.direction === 'in');
  const windowOpen = !!lastIn && Date.now() - new Date(lastIn.created_at).getTime() < WINDOW_MS;
  async function update(fields: Partial<Conversation>) {
    if (demo) return;
    const r = await supabase.from('conversations').update(fields).eq('id', current!.id);
    if (r.error) notifications.show({ color: 'red', message: r.error.message });
    await qc.invalidateQueries({ queryKey: ['conversations'] });
  }

  return (
    <Stack gap="sm">
      <Group justify="space-between">
        <Title order={2}>הודעות</Title>
        <Switch label="תצוגה לדוגמה" checked={demo} onChange={(e) => { setDemo(e.currentTarget.checked); setParams({}); }} />
      </Group>
      {!demo && !conversations.length && (
        <Alert color="green" icon={<IconBrandWhatsapp size={18} />} title="הוואטסאפ עוד לא מחובר למערכת">
          כשיחובר, כל הודעה מלקוח תופיע כאן ותשויך לכרטיס שלו לפי מספר הטלפון. עד אז, ליד כל טלפון בכרטיסים יש כפתור וואטסאפ. "תצוגה לדוגמה" מראה איך זה ייראה.
        </Alert>
      )}
      <Box style={{ display: 'flex', height: 'calc(100vh - 190px)', minHeight: 480, border: `1px solid ${WA.line}`, borderRadius: 8, overflow: 'hidden', background: WA.panel }}>
        {/* The chats */}
        <Box style={{ width: 340, flexShrink: 0, borderInlineEnd: `1px solid ${WA.line}`, display: current ? undefined : 'flex', flexDirection: 'column' }}
          visibleFrom={current ? 'sm' : undefined} w={{ base: current ? 340 : '100%', sm: 340 }}>
          <Group h={59} px="md" bg={WA.header} justify="space-between" wrap="nowrap">
            <Text fw={600} c={WA.text}>צ'אטים</Text>
            <Tooltip label="להציג גם שיחות סגורות"><Switch size="xs" checked={showClosed} onChange={(e) => setShowClosed(e.currentTarget.checked)} /></Tooltip>
          </Group>
          <Box p={8} bg={WA.panel}>
            <TextInput size="sm" radius="md" placeholder="חיפוש או התחלת צ'אט חדש" leftSection={<IconSearch size={16} />}
              styles={{ input: { background: WA.header, border: 'none' } }} value={search} onChange={(e) => setSearch(e.currentTarget.value)} />
          </Box>
          <ScrollArea style={{ flex: 1 }} h="calc(100% - 115px)">
            {!list.length && <Text size="sm" c={WA.muted} ta="center" p="lg">אין צ'אטים</Text>}
            {list.map((c) => {
              const last = lastOf.get(c.id);
              const active = c.id === current?.id;
              return (
                <UnstyledButton key={c.id} w="100%" onClick={() => setParams({ c: c.id })} style={{ background: active ? WA.active : undefined }}>
                  <Group gap="sm" px="md" py={10} wrap="nowrap" style={{ borderBottom: `1px solid ${WA.line}` }}>
                    <Avatar radius="xl" size={49} color="teal">{initials(who(c)) || <IconBrandWhatsapp size={22} />}</Avatar>
                    <Box style={{ flex: 1, minWidth: 0 }}>
                      <Group justify="space-between" wrap="nowrap" gap={4}>
                        <Text size="md" c={WA.text} lineClamp={1}>{who(c)}</Text>
                        <Text size="xs" c={last?.direction === 'in' && c.status === 'open' ? WA.green : WA.muted} style={{ flexShrink: 0 }}>{listTime(c.last_message_at)}</Text>
                      </Group>
                      <Group justify="space-between" wrap="nowrap" gap={4}>
                        <Group gap={3} wrap="nowrap" style={{ minWidth: 0 }}>
                          {last?.direction === 'out' && <IconChecks size={16} color={WA.tick} style={{ flexShrink: 0 }} />}
                          <Text size="sm" c={WA.muted} lineClamp={1}>{last?.body ?? (last?.media_path ? '📎 קובץ' : c.wa_phone)}</Text>
                        </Group>
                        {last?.direction === 'in' && c.status === 'open' && <Badge size="sm" circle color={WA.green} style={{ flexShrink: 0 }}>1</Badge>}
                      </Group>
                    </Box>
                  </Group>
                </UnstyledButton>
              );
            })}
          </ScrollArea>
        </Box>

        {/* The chat */}
        <Box style={{ flex: 1, display: current ? 'flex' : undefined, flexDirection: 'column', minWidth: 0 }} visibleFrom={current ? undefined : 'sm'}>
          {!current ? (
            <Stack h="100%" align="center" justify="center" gap="xs" bg={WA.header} style={{ borderBottom: `6px solid ${WA.green}` }}>
              <IconBrandWhatsapp size={72} color={WA.muted} stroke={1} />
              <Text size="xl" c={WA.text} fw={300}>See the Future · וואטסאפ</Text>
              <Text size="sm" c={WA.muted} ta="center" maw={420}>בוחרים צ'אט מהרשימה. התשובות יוצאות מהמספר העסקי של החברה, ונשמרות בכרטיס הלקוח.</Text>
            </Stack>
          ) : (
            <>
              <Group h={59} px="md" bg={WA.header} justify="space-between" wrap="nowrap" style={{ borderBottom: `1px solid ${WA.line}` }}>
                <Group gap="sm" wrap="nowrap" style={{ minWidth: 0 }}>
                  <ActionIcon variant="subtle" color="gray" hiddenFrom="sm" onClick={() => setParams({})} aria-label="חזרה"><IconArrowRight size={20} /></ActionIcon>
                  <Avatar radius="xl" size={40} color="teal">{initials(who(current))}</Avatar>
                  <Box style={{ minWidth: 0 }}>
                    <Text c={WA.text} lineClamp={1}>{who(current)}</Text>
                    <Text size="xs" c={WA.muted} dir="ltr" ta="right">{current.wa_phone}{current.assigned_to ? ` · ${staffNames.get(current.assigned_to) ?? ''}` : ''}</Text>
                  </Box>
                </Group>
                <Group gap={4} wrap="nowrap">
                  <Badge variant="light" color={current.status === 'open' ? 'green' : current.status === 'waiting' ? 'yellow' : 'gray'}>{STATUS_HE[current.status]}</Badge>
                  <Menu position="bottom-end" withinPortal>
                    <Menu.Target><ActionIcon variant="subtle" color="gray" aria-label="אפשרויות"><IconDotsVertical size={20} /></ActionIcon></Menu.Target>
                    <Menu.Dropdown>
                      {current.client_party_id && !demo && <Menu.Item component={Link} to={`/clients/${current.client_party_id}`}>לכרטיס הלקוח</Menu.Item>}
                      {waLink(current.wa_phone) && <Menu.Item component="a" href={waLink(current.wa_phone)!} target="_blank" rel="noopener noreferrer">פתיחה באפליקציה</Menu.Item>}
                      <Menu.Label>מצב</Menu.Label>
                      {(Object.keys(STATUS_HE) as Conversation['status'][]).map((s) => <Menu.Item key={s} onClick={() => update({ status: s })}>{STATUS_HE[s]}</Menu.Item>)}
                    </Menu.Dropdown>
                  </Menu>
                </Group>
              </Group>
              <Group px="md" py={4} bg={WA.header} gap="xs" wrap="nowrap" style={{ borderBottom: `1px solid ${WA.line}` }}>
                <Text size="xs" c={WA.muted}>בטיפול של:</Text>
                <Select size="xs" w={190} variant="unstyled" placeholder="לא שויכה" clearable value={current.assigned_to}
                  data={(staff.data ?? []).map((s) => ({ value: s.user_id, label: s.display_name }))} onChange={(x) => update({ assigned_to: x })} />
              </Group>
              <ScrollArea style={{ flex: 1, backgroundColor: WA.chatBg, backgroundImage: DOODLE }}>
                <Stack gap={2} px={{ base: 'sm', sm: 60 }} py="md">
                  {messages.map((m, i) => {
                    const newDay = i === 0 || new Date(messages[i - 1].created_at).toDateString() !== new Date(m.created_at).toDateString();
                    const first = i === 0 || messages[i - 1].direction !== m.direction || newDay;
                    const out = m.direction === 'out';
                    return (
                      <Box key={m.id}>
                        {newDay && <Group justify="center" my={8}><Text size="xs" c={WA.muted} px={10} py={4} style={{ background: '#ffffffe6', borderRadius: 8, boxShadow: '0 1px 0.5px rgba(11,20,26,.13)' }}>{dayLabel(m.created_at)}</Text></Group>}
                        <Group justify={out ? 'flex-end' : 'flex-start'} mt={first ? 8 : 0}>
                          <Box maw="65%" px={9} pt={6} pb={8} style={{
                            position: 'relative', background: out ? WA.out : WA.in, borderRadius: 8, boxShadow: '0 1px 0.5px rgba(11,20,26,.13)',
                            ...(first ? (out ? { borderStartEndRadius: 0 } : { borderStartStartRadius: 0 }) : {}),
                          }}>
                            <Text size="sm" c={WA.text} style={{ whiteSpace: 'pre-wrap', overflowWrap: 'anywhere' }} dir="auto">{m.body ?? (m.media_path ? '📎 קובץ' : '')}</Text>
                            <Group gap={3} justify="flex-end" mt={2} wrap="nowrap">
                              {out && m.sent_by && <Text size="10px" c={WA.muted}>{staffNames.get(m.sent_by) ?? ''} ·</Text>}
                              <Text size="10px" c={WA.muted}>{hhmm(m.created_at)}</Text>
                              {out && <IconChecks size={15} color={WA.tick} />}
                            </Group>
                          </Box>
                        </Group>
                      </Box>
                    );
                  })}
                </Stack>
              </ScrollArea>
              <Box bg={WA.header} px="sm" py={8}>
                <Text size="xs" c={windowOpen ? WA.muted : '#b25e00'} ta="center" mb={6}>
                  {windowOpen ? 'הלקוח כתב ב-24 השעות האחרונות: אפשר לענות חופשי' : 'עברו 24 שעות מההודעה האחרונה של הלקוח: אפשר לשלוח רק תבנית מאושרת'}
                </Text>
                <Group gap="xs" wrap="nowrap">
                  <ActionIcon variant="subtle" color="gray" size="lg" disabled aria-label="אימוג'י"><IconMoodSmile size={24} /></ActionIcon>
                  <ActionIcon variant="subtle" color="gray" size="lg" disabled aria-label="צירוף"><IconPaperclip size={24} /></ActionIcon>
                  <TextInput style={{ flex: 1 }} radius="md" disabled placeholder="השליחה תופעל כשהוואטסאפ יחובר למערכת" styles={{ input: { background: '#fff', border: 'none' } }} />
                  <ActionIcon size={42} radius="xl" color={WA.green} variant="filled" disabled aria-label="שליחה"><IconSend size={20} style={{ transform: 'scaleX(-1)' }} /></ActionIcon>
                </Group>
              </Box>
            </>
          )}
        </Box>
      </Box>
      {demo && <Text size="xs" c="dimmed">תצוגה לדוגמה: שמות והודעות מומצאים, לא נשמר כלום.</Text>}
      {!demo && conversations.length > 0 && <Anchor size="xs" c="dimmed" onClick={() => qc.invalidateQueries({ queryKey: ['conversations'] })}>רענון</Anchor>}
    </Stack>
  );
}
