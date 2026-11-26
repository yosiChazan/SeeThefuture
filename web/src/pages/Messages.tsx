import { ActionIcon, Alert, Anchor, Avatar, Badge, Box, Button, Checkbox, Group, MultiSelect, Image, Menu, Modal, ScrollArea, Select, Stack, Switch, Text, Textarea, TextInput, Title, Tooltip, UnstyledButton } from '@mantine/core';
import { notifications } from '@mantine/notifications';
import { IconAlertCircle, IconArrowBackUp, IconArrowRight, IconRobot, IconBrandWhatsapp, IconCheck, IconChecks, IconDeviceMobile, IconDotsVertical, IconExternalLink, IconFileText, IconMicrophone, IconSearch, IconSend, IconTemplate, IconX } from '@tabler/icons-react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { Link, useSearchParams, useNavigate } from 'react-router-dom';
import { useStaff } from '../components/ManualTopics';
import { waLink } from '../components/Phone';
import { useClients, useContacts } from '../lib/queries';
import { createBatch, readReport, useSources, type Source } from '../lib/intake';
import { ADAPTERS } from '../intake/adapters';
import { useAccess } from '../lib/access';
import { WaSaveDoc, type WaFile } from '../components/WaSaveDoc';
import { ClientForm } from '../components/ClientForm';
import { ClientReport } from '../components/ClientReport';
import { toE164 } from '../lib/phone';
import { useAiGuides } from '../components/AiGuidesSettings';
import { ChatSummary } from '../components/ChatSummary';
import { must, supabase } from '../lib/supabase';

// The shared WhatsApp inbox (SPEC §6.5, decisions 135, 139), laid out like WhatsApp: chats on
// one side with the last message and its time, the chat on the other with green and white
// bubbles on WhatsApp's background (ours on the left, as WhatsApp shows them in Hebrew), and the typing bar below. Until WhatsApp is connected,
// sending is off; "a sample" shows how it will look, with made-up names. Once connected (decision
// 180): sending through whatsapp-send (a text within 24 hours of the client's last message, an
// approved template after them), pictures and files, delivery ticks, and what was sent from the
// phone's app marked as such. New messages are fetched every 15 seconds.

interface Conversation { id: string; client_party_id: string | null; wa_phone: string; contact_name?: string | null; assigned_to: string | null; status: 'open' | 'waiting' | 'closed'; last_message_at: string | null;
  ai_guide_id?: string | null; ai_until?: string | null; ai_handback_reason?: string | null; ai_handback_at?: string | null;
  ai_summary?: string | null; ai_summary_at?: string | null; ai_waiting_on?: 'us' | 'client' | 'none' | null; staff_read_at?: string | null }
interface Message { id: string; conversation_id: string; direction: 'in' | 'out'; body: string | null; media_path: string | null; sent_by: string | null; created_at: string;
  kind?: string; origin?: 'api' | 'app' | 'history' | 'ai'; status?: string | null; error?: string | null; file_name?: string | null;
  wa_message_id?: string | null; reply_to?: string | null; played_at?: string | null }

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
  return useQuery({ queryKey: ['conversations'], refetchInterval: 15_000, queryFn: async () => must(await supabase.from('conversations').select('*').order('last_message_at', { ascending: false, nullsFirst: false })) as Conversation[] });
}
// The last messages of all chats, for each chat's last line in the list.
function useRecentMessages() {
  return useQuery({ queryKey: ['messages-recent'], refetchInterval: 15_000, queryFn: async () => must(await supabase.from('messages').select('*').order('created_at', { ascending: false }).limit(1000)) as Message[] });
}
function useMessages(id: string | null) {
  return useQuery({
    queryKey: ['messages', id], enabled: !!id && !id.startsWith('s'), refetchInterval: 15_000,
    queryFn: async () => must(await supabase.from('messages').select('*').eq('conversation_id', id!).order('created_at')) as Message[],
  });
}

export function Messages() {
  const qc = useQueryClient();
  const real = useConversations();
  const recent = useRecentMessages();
  const clients = useClients();
  const contacts = useContacts();
  const staff = useStaff();
  const [params, setParams] = useSearchParams();
  const navigate = useNavigate();
  const [search, setSearch] = useState('');
  const [showClosed, setShowClosed] = useState(false);
  // Filter by city (decision 210): a chat's cities are those of its person's apartments now.
  const [cities, setCities] = useState<string[]>([]);
  const partyCities = useQuery({
    queryKey: ['party-cities'], staleTime: 10 * 60_000,
    queryFn: async () => {
      const rows = must(await supabase.from('ownerships').select('party_id, valid_to, property:properties(building:buildings(city:cities(name_he)))').is('valid_to', null)) as unknown as
        { party_id: string; property: { building: { city: { name_he: string } | null } | null } | null }[];
      const m = new Map<string, Set<string>>();
      for (const r of rows) { const c = r.property?.building?.city?.name_he; if (c) (m.get(r.party_id) ?? m.set(r.party_id, new Set()).get(r.party_id)!).add(c); }
      return m;
    },
  });
  const [demo, setDemo] = useState(false);
  const demoData = useMemo(sample, []);
  const names = useMemo(() => demo ? demoData.names : new Map([...(contacts.data ?? []), ...(clients.data ?? [])].map((c) => [c.id, c.display_name])), [clients.data, contacts.data, demo, demoData]);
  // A known chat says whether it is a client or a contact (decision 195).
  const roleOf = useMemo(() => {
    const c = new Set((clients.data ?? []).map((x) => x.id)), k = new Set((contacts.data ?? []).map((x) => x.id));
    return (id: string | null) => (!id ? null : c.has(id) || demo ? { label: 'לקוח', color: 'teal' } : k.has(id) ? { label: 'איש קשר', color: 'grape' } : null);
  }, [clients.data, contacts.data, demo]);
  const staffNames = useMemo(() => new Map((staff.data ?? []).map((s) => [s.user_id, s.display_name])), [staff.data]);
  const conversations = demo ? demoData.conversations : (real.data ?? []);
  const lastOf = useMemo(() => {
    const out = new Map<string, Message>();
    for (const m of demo ? [...demoData.messages].reverse() : recent.data ?? []) if (!out.has(m.conversation_id)) out.set(m.conversation_id, m);
    return out;
  }, [recent.data, demo, demoData]);
  // Client messages the office has not seen yet (decision 192): after the chat was last open on a screen.
  const unreadOf = useMemo(() => {
    const out = new Map<string, number>();
    const readAt = new Map(conversations.map((c) => [c.id, c.staff_read_at ?? '']));
    for (const m of demo ? demoData.messages : recent.data ?? []) {
      if (m.direction !== 'in' || m.origin === 'history') continue;
      if (new Date(m.created_at).getTime() > new Date(readAt.get(m.conversation_id) || 0).getTime()) out.set(m.conversation_id, (out.get(m.conversation_id) ?? 0) + 1);
    }
    return out;
  }, [recent.data, conversations, demo, demoData]);
  // What the person's card says about this number (decision 203): "נייד", "עבודה"… to tell two numbers of one person apart.
  const digitsOf = (x: string | null | undefined) => (x ?? '').replace(/\D/g, '');
  const phoneLabel = (c: Conversation) => {
    const p = [...(clients.data ?? []), ...(contacts.data ?? [])].find((x) => x.id === c.client_party_id);
    if (!p) return null;
    const d = digitsOf(c.wa_phone);
    if (digitsOf(p.phone) === d) return p.phone_label || null;
    return (p.extra_phones ?? []).find((x) => digitsOf(x.phone) === d)?.label || null;
  };
  // A number someone sent as a contact card: who has it in the system, and its chat.
  const partyByPhone = (e164: string) => [...(clients.data ?? []), ...(contacts.data ?? [])].find((x) => digitsOf(x.phone) === digitsOf(e164) || (x.extra_phones ?? []).some((y) => digitsOf(y.phone) === digitsOf(e164)));
  const [addingContact, setAddingContact] = useState<{ name: string; phone: string } | null>(null);
  async function openChat(e164: string) {
    const found = conversations.find((c) => digitsOf(c.wa_phone) === digitsOf(e164));
    if (found) { setParams({ c: found.id }); return; }
    const r = await supabase.from('conversations').insert({ wa_phone: e164, client_party_id: partyByPhone(e164)?.id ?? null }).select('id').single();
    if (r.error) { notifications.show({ color: 'red', message: r.error.message }); return; }
    await qc.invalidateQueries({ queryKey: ['conversations'] });
    setParams({ c: r.data.id });
  }
  const who = (c: Conversation) => (c.client_party_id ? names.get(c.client_party_id) : null) ?? c.contact_name ?? c.wa_phone;
  // The AI summary is written again by itself only on the first visit to this page after an hour
  // away (decision 189); otherwise only with its refresh button.
  const [autoSummary] = useState(() => {
    try {
      const last = Number(localStorage.getItem('messages-last-visit') ?? 0);
      return Date.now() - last > 3600_000;
    } catch { return false; }
  });
  useEffect(() => {
    const mark = () => { try { localStorage.setItem('messages-last-visit', String(Date.now())); } catch { /* not kept */ } };
    mark();
    const t = setInterval(mark, 60_000);
    return () => { clearInterval(t); mark(); };
  }, []);
  const account = useQuery({ queryKey: ['whatsapp-account'], queryFn: async () => (must(await supabase.from('whatsapp_account').select('phone_number_id, connected_at, display_phone').eq('id', 1).maybeSingle()) as { phone_number_id: string | null; connected_at: string | null; display_phone: string | null } | null) });
  const connected = !demo && !!account.data?.phone_number_id && !!account.data.connected_at;
  const citiesOf = (c: Conversation) => (c.client_party_id ? [...(partyCities.data?.get(c.client_party_id) ?? [])] : []);
  const cityOptions = [...new Set([...(partyCities.data?.values() ?? [])].flatMap((x) => [...x]))].sort((a, b) => a.localeCompare(b, 'he'));
  const list = conversations.filter((c) => (showClosed || c.status !== 'closed')
    && (!cities.length || citiesOf(c).some((x) => cities.includes(x)) || (cities.includes('—') && !citiesOf(c).length))
    && (!search.trim() || `${who(c)} ${c.wa_phone}`.includes(search.trim())));
  const current = conversations.find((c) => c.id === params.get('c')) ?? null;
  const thread = useMessages(current?.id ?? null);
  const messages = demo ? demoData.messages.filter((m) => m.conversation_id === current?.id) : thread.data ?? [];
  // Where the chat opens (decision 192): at its end, or at the first message not seen yet, under a line.
  const [opened, setOpened] = useState<{ id: string; readAt: number } | null>(null);
  if (current && opened?.id !== current.id) setOpened({ id: current.id, readAt: new Date(current.staff_read_at ?? 0).getTime() });
  const firstUnread = opened ? messages.find((m) => m.direction === 'in' && m.origin !== 'history' && new Date(m.created_at).getTime() > opened.readAt) : undefined;
  const unreadHere = firstUnread ? messages.filter((m) => m.direction === 'in' && m.origin !== 'history' && new Date(m.created_at).getTime() > opened!.readAt).length : 0;
  const viewport = useRef<HTMLDivElement>(null);
  const placed = useRef<string | null>(null);
  const atEnd = useRef(true);
  useLayoutEffect(() => {
    const v = viewport.current;
    if (!v || !current || !messages.length) return;
    if (placed.current !== current.id) {
      placed.current = current.id;
      const line = firstUnread && v.querySelector<HTMLElement>('[data-unread-line]');
      v.scrollTop = line ? Math.max(0, line.getBoundingClientRect().top - v.getBoundingClientRect().top + v.scrollTop - v.clientHeight / 3) : v.scrollHeight;
    } else if (atEnd.current) v.scrollTop = v.scrollHeight;   // a new message while at the end: follow it
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [current?.id, messages.length]);
  // The chat on the screen is read.
  const lastInAt = [...messages].reverse().find((m) => m.direction === 'in')?.created_at;
  useEffect(() => {
    if (demo || !current || !lastInAt) return;
    if (current.staff_read_at && new Date(current.staff_read_at) >= new Date(lastInAt)) return;
    supabase.from('conversations').update({ staff_read_at: new Date().toISOString() }).eq('id', current.id)
      .then(() => qc.invalidateQueries({ queryKey: ['conversations'] }));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [current?.id, lastInAt, demo]);
  // The 24 hours start from the client's last message to the connected number (not from the history).
  const lastIn = [...messages].reverse().find((m) => m.direction === 'in' && m.origin !== 'history');
  const windowOpen = !!lastIn && Date.now() - new Date(lastIn.created_at).getTime() < WINDOW_MS;
  // The AI in a chat (decision 183): hand over with a guide, or take back.
  const guides = useAiGuides();
  const guideTitle = (id: string) => guides.data?.find((g) => g.id === id)?.title ?? 'מדריך';
  const [aiPick, setAiPick] = useState(false);
  const [reporting, setReporting] = useState(false);   // a statement for the client (decision 208)
  // "Alliance special" (decision 197): clients of those apartments; no AI without the admin's approval.
  const access = useAccess();
  const specialQ = useQuery({ queryKey: ['special-alliance'], enabled: !demo, queryFn: async () => new Set((must(await supabase.rpc('special_alliance_parties')) as { party_id: string }[]).map((r) => r.party_id)) });
  const isSpecial = (c: Conversation | null) => !!c?.client_party_id && !!specialQ.data?.has(c.client_party_id);
  const [specialOk, setSpecialOk] = useState(false);
  // Quoted replies (decision 196): the message quoted, and the one being answered with a quote.
  const byWa = useMemo(() => new Map(messages.filter((m) => m.wa_message_id).map((m) => [m.wa_message_id!, m])), [messages]);
  // Reactions (decision 205) sit on the message they react to, as in WhatsApp, not as messages of
  // their own. A reaction saved before its target was kept goes on the last message before it
  // from the other side; a later reaction from the same side replaces it, an empty one removes it.
  const { bubbles, reactions } = useMemo(() => {
    const on = new Map<string, Map<'in' | 'out', string>>();
    let lastIn: Message | null = null, lastOut: Message | null = null;
    for (const m of messages) {
      if (m.kind !== 'reaction') { if (m.direction === 'in') lastIn = m; else lastOut = m; continue; }
      const target = (m.reply_to && byWa.get(m.reply_to)) || (m.direction === 'in' ? lastOut : lastIn);
      if (!target) continue;
      const emoji = (m.body ?? '').replace(/\s*\(תגובה להודעה\)\s*$/, '').trim();
      const r = on.get(target.id) ?? on.set(target.id, new Map()).get(target.id)!;
      if (emoji) r.set(m.direction, emoji); else r.delete(m.direction);
    }
    return { bubbles: messages.filter((m) => m.kind !== 'reaction'), reactions: on };
  }, [messages, byWa]);
  const [quoting, setQuoting] = useState<Message | null>(null);
  useEffect(() => setQuoting(null), [current?.id]);
  const jumpTo = (id: string) => { const el = viewport.current?.querySelector<HTMLElement>(`[data-msg="${id}"]`); if (el) { el.scrollIntoView({ block: 'center', behavior: 'smooth' }); el.animate([{ background: '#fff3bf' }, { background: 'transparent' }], { duration: 1500 }); } };
  const quoteName = (m: Message) => (m.direction === 'out' ? 'המשרד' : current ? who(current) : '');
  // Files of this chat already kept in the system (decision 195).
  const [saving, setSaving] = useState<WaFile | null>(null);
  // A manager's report sent in the chat (decision 207): read into the intake straight from the message.
  // Offered on a file of the kind the manager's source reads, in the chat of the source's holder, named
  // like his reports ("… ניהול דירה.docx", "… Apt 31 …").
  const sources = useSources();
  const reportSource = (m: Message): Source | null => {
    const name = m.file_name ?? '';
    if (!current || !/\.docx$/i.test(name) || !/ניהול (דירה|חשבונות)|\b(ap|apt)\.?\s*\d+/i.test(name)) return null;
    const docx = (sources.data ?? []).filter((s) => ADAPTERS[s.adapter]?.accept.includes('.docx'));
    // The company's own chat ("(אתה)"): reports forwarded to it are read like the manager's.
    const self = !!account.data?.display_phone && digitsOf(current.wa_phone) === digitsOf(account.data.display_phone);
    return docx.find((s) => s.holder_party_id && s.holder_party_id === current.client_party_id) ?? (self ? docx[0] ?? null : null);
  };
  const [reading, setReading] = useState<string | null>(null);
  async function intake(m: Message, source: Source) {
    setReading(m.id);
    try {
      const { data, error } = await supabase.storage.from('whatsapp').download(m.media_path!);
      if (error || !data) throw new Error(error?.message ?? 'הקובץ לא נמצא');
      const file = new File([data], m.file_name ?? 'report.docx', { type: data.type });
      const result = await readReport(source, file);
      const id = await createBatch(source, file, result);
      navigate(`/intake/${id}`);
    } catch (e) { notifications.show({ color: 'red', title: 'קליטת הדוח נכשלה', message: (e as Error).message }); } finally { setReading(null); }
  }
  const mediaIds = messages.filter((m) => m.media_path).map((m) => m.id);
  const saved = useQuery({
    queryKey: ['wa-saved', current?.id, mediaIds.length], enabled: !demo && mediaIds.length > 0,
    queryFn: async () => new Set((must(await supabase.from('documents').select('source').in('source', mediaIds.map((id) => `whatsapp:${id}`))) as { source: string }[]).map((d) => d.source.slice(9))),
  });
  const [aiGuide, setAiGuide] = useState<string | null>(null);
  const [aiBusy, setAiBusy] = useState(false);
  async function aiCall(body: Record<string, unknown>) {
    setAiBusy(true);
    try {
      const { error } = await supabase.functions.invoke('whatsapp-ai', { body });
      if (error) {
        let msg = error.message;
        try { msg = (await (error as { context?: Response }).context?.json())?.error ?? msg; } catch { /* keep */ }
        throw new Error(msg);
      }
    } catch (e) { notifications.show({ color: 'red', message: (e as Error).message }); } finally {
      setAiBusy(false);
      await qc.invalidateQueries({ queryKey: ['conversations'] });
      await qc.invalidateQueries({ queryKey: ['messages', current?.id] });
    }
  }
  const aiStop = (id: string) => aiCall({ action: 'stop', conversation_id: id });
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
        <Group gap="sm">
          <Switch label="תצוגה לדוגמה" checked={demo} onChange={(e) => { setDemo(e.currentTarget.checked); setParams({}); }} />
        </Group>
      </Group>
      {!demo && !conversations.length && !connected && (
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
            {!demo && <MultiSelect size="xs" mt={6} radius="md" placeholder={cities.length ? undefined : 'כל הערים'} clearable value={cities} onChange={setCities}
              data={[...cityOptions.map((c) => ({ value: c, label: c })), { value: '—', label: 'בלי עיר (לא לקוח / בלי דירה)' }]} />}
          </Box>
          <ScrollArea style={{ flex: 1 }} h={!demo ? 'calc(100% - 150px)' : 'calc(100% - 115px)'}>
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
                        <Group gap={4} wrap="nowrap" style={{ minWidth: 0 }}>
                          {c.ai_guide_id && <Tooltip label="ה-AI עונה בשיחה הזו"><IconRobot size={16} color="#7048e8" style={{ flexShrink: 0 }} /></Tooltip>}
                          <Text size="md" c={WA.text} lineClamp={1}>{who(c)}</Text>
                          {phoneLabel(c) && <Text size="xs" c={WA.muted} style={{ flexShrink: 0 }}>({phoneLabel(c)})</Text>}
                          {roleOf(c.client_party_id) && <Badge size="xs" variant="light" color={roleOf(c.client_party_id)!.color} style={{ flexShrink: 0 }}>{roleOf(c.client_party_id)!.label}</Badge>}
                          {isSpecial(c) && <Badge size="xs" variant="filled" color="red" style={{ flexShrink: 0 }}>אליאנס מיוחד</Badge>}
                        </Group>
                        <Text size="xs" c={unreadOf.get(c.id) ? WA.green : WA.muted} style={{ flexShrink: 0 }}>{listTime(c.last_message_at)}</Text>
                      </Group>
                      <Group justify="space-between" wrap="nowrap" gap={4}>
                        <Group gap={3} wrap="nowrap" style={{ minWidth: 0 }}>
                          {last?.direction === 'out' && <Ticks status={last.status} error={last.error} />}
                          <Text size="sm" c={WA.muted} lineClamp={1}>{last?.body ?? (last ? kindLabel(last) : c.wa_phone)}</Text>
                        </Group>
                        {!!unreadOf.get(c.id) && !active && <Badge size="sm" circle color={WA.green} style={{ flexShrink: 0 }}>{unreadOf.get(c.id)}</Badge>}
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
                    <Group gap={6} wrap="nowrap"><Text c={WA.text} lineClamp={1}>{who(current)}</Text>
                      {phoneLabel(current) && <Text size="sm" c={WA.muted} style={{ flexShrink: 0 }}>({phoneLabel(current)})</Text>}
                      {roleOf(current.client_party_id) && <Badge size="xs" variant="light" color={roleOf(current.client_party_id)!.color} style={{ flexShrink: 0 }}>{roleOf(current.client_party_id)!.label}</Badge>}
                      {/* The client's or contact's card, in a new tab (decision 195). */}
                      {roleOf(current.client_party_id) && !demo && <Tooltip label={`פתיחת הכרטיס של ${roleOf(current.client_party_id)!.label === 'לקוח' ? 'הלקוח' : 'איש הקשר'} בדף חדש`}>
                        <ActionIcon size="sm" variant="subtle" color="gray" component="a" target="_blank" rel="noopener"
                          href={`/${roleOf(current.client_party_id)!.label === 'לקוח' ? 'clients' : 'contacts'}/${current.client_party_id}`} aria-label="פתיחת הכרטיס בדף חדש">
                          <IconExternalLink size={16} /></ActionIcon></Tooltip>}</Group>
                    <Text size="xs" c={WA.muted} dir="ltr" ta="right">{current.wa_phone}{current.assigned_to ? ` · ${staffNames.get(current.assigned_to) ?? ''}` : ''}</Text>
                  </Box>
                </Group>
                <Group gap={4} wrap="nowrap">
                  <Badge variant="light" color={current.status === 'open' ? 'green' : current.status === 'waiting' ? 'yellow' : 'gray'}>{STATUS_HE[current.status]}</Badge>
                  <Menu position="bottom-end" withinPortal>
                    <Menu.Target><ActionIcon variant="subtle" color="gray" aria-label="אפשרויות"><IconDotsVertical size={20} /></ActionIcon></Menu.Target>
                    <Menu.Dropdown>
                      {current.client_party_id && !demo && <Menu.Item component={Link} to={`/clients/${current.client_party_id}`}>לכרטיס הלקוח</Menu.Item>}
                      {roleOf(current.client_party_id)?.label === 'לקוח' && !demo && <Menu.Item leftSection={<IconFileText size={16} />} onClick={() => setReporting(true)}>דוח ללקוח…</Menu.Item>}
                      {waLink(current.wa_phone) && <Menu.Item component="a" href={waLink(current.wa_phone)!} target="_blank" rel="noopener noreferrer">פתיחה באפליקציה</Menu.Item>}
                      {!demo && connected && (current.ai_guide_id
                        ? <Menu.Item color="violet" leftSection={<IconRobot size={16} />} onClick={() => aiStop(current.id)}>עצירת ה-AI</Menu.Item>
                        : <Menu.Item color="violet" leftSection={<IconRobot size={16} />} onClick={() => setAiPick(true)}>העבר ל-AI…</Menu.Item>)}
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
              {isSpecial(current) && (
                <Group px="md" py={8} gap="xs" wrap="nowrap" style={{ background: '#c92a2a' }}>
                  <IconAlertCircle size={22} color="#fff" style={{ flexShrink: 0 }} />
                  <Text fw={800} c="#fff" size="md">אליאנס מיוחד</Text>
                  <Text size="sm" c="#fff">· בלי הודעות אוטומטיות ובלי AI ללקוח הזה, אלא באישור של מנהל המערכת.</Text>
                </Group>
              )}
              {!demo && connected && <ChatSummary chat={current} auto={autoSummary} />}
              {current.ai_guide_id ? (
                <Group px="md" py={6} gap="xs" wrap="nowrap" justify="space-between" style={{ background: '#f3f0ff', borderBottom: '1px solid #d0bfff' }}>
                  <Group gap={6} wrap="nowrap"><IconRobot size={18} color="#7048e8" />
                    <Text size="sm" c="#5f3dc4">ה-AI עונה ללקוח בשיחה הזו לפי "{guideTitle(current.ai_guide_id)}"{current.ai_until ? `, עד ${new Date(current.ai_until).toLocaleString('he-IL', { day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit' })}` : ''}. תשובה שלך (מכאן או מהטלפון) עוצרת אותו.</Text></Group>
                  <Button size="compact-xs" color="violet" variant="light" onClick={() => aiStop(current.id)}>עצירה</Button>
                </Group>
              ) : current.ai_handback_reason && current.ai_handback_at && Date.now() - new Date(current.ai_handback_at).getTime() < 48 * 3600_000 ? (
                <Group px="md" py={6} gap="xs" wrap="nowrap" justify="space-between" style={{ background: '#fff4e6', borderBottom: '1px solid #ffd8a8' }}>
                  <Group gap={6} wrap="nowrap"><IconRobot size={18} color="#d9480f" />
                    <Text size="sm" c="#d9480f">ה-AI החזיר אליך את השיחה ({hhmm(current.ai_handback_at)}): {current.ai_handback_reason}</Text></Group>
                  <Button size="compact-xs" color="orange" variant="subtle" onClick={() => update({ ai_handback_reason: null })}>הבנתי</Button>
                </Group>
              ) : null}
              {/* The quote button shows on hovering a message; Emoji: Noto Color Emoji for everyone (main.tsx, decision 196). */}
              <style>{`.wa-row .wa-reply{opacity:0;transition:opacity .15s}.wa-row:hover .wa-reply{opacity:1}@media (hover:none){.wa-row .wa-reply{opacity:.7}}`}</style>
              <ScrollArea className="wa-chat" viewportRef={viewport} onScrollPositionChange={() => { const v = viewport.current; if (v) atEnd.current = v.scrollHeight - v.scrollTop - v.clientHeight < 80; }}
                style={{ flex: 1, backgroundColor: WA.chatBg, backgroundImage: DOODLE }}>
                <Stack gap={2} px={{ base: 'sm', sm: 60 }} py="md">
                  {bubbles.map((m, i) => {
                    const newDay = i === 0 || new Date(bubbles[i - 1].created_at).toDateString() !== new Date(m.created_at).toDateString();
                    const first = i === 0 || bubbles[i - 1].direction !== m.direction || newDay;
                    const reacted = [...(reactions.get(m.id)?.values() ?? [])];
                    const out = m.direction === 'out';
                    return (
                      <Box key={m.id} data-msg={m.id} className="wa-row">
                        {m === firstUnread && <Group justify="center" my={8} data-unread-line><Text size="xs" c={WA.muted} px={12} py={4} style={{ background: '#ffffffe6', borderRadius: 8 }}>{unreadHere === 1 ? 'הודעה אחת שלא נקראה' : `${unreadHere} הודעות שלא נקראו`}</Text></Group>}
                        {newDay && <Group justify="center" my={8}><Text size="xs" c={WA.muted} px={10} py={4} style={{ background: '#ffffffe6', borderRadius: 8, boxShadow: '0 1px 0.5px rgba(11,20,26,.13)' }}>{dayLabel(m.created_at)}</Text></Group>}
                        <Group justify={out ? 'flex-end' : 'flex-start'} mt={first ? 8 : 0} mb={reacted.length ? 14 : 0} gap={4} wrap="nowrap">
                          <Box maw="65%" px={9} pt={6} pb={8} style={{
                            position: 'relative', background: out ? WA.out : WA.in, borderRadius: 8, boxShadow: '0 1px 0.5px rgba(11,20,26,.13)',
                            ...(first ? (out ? { borderStartEndRadius: 0 } : { borderStartStartRadius: 0 }) : {}),
                          }}>
                            {out && (() => {
                              // Who in the office answered (decision 189): the staff member, the AI, or the company phone.
                              const s = m.origin === 'ai' ? { t: 'AI', c: '#7048e8', i: <IconRobot size={12} /> }
                                : m.origin === 'app' || m.origin === 'history' ? { t: 'מהטלפון של החברה', c: '#0b7a5f', i: <IconDeviceMobile size={12} /> }
                                : { t: (m.sent_by && staffNames.get(m.sent_by)) || 'המשרד', c: '#1c7ed6', i: null };
                              return <Group gap={3} mb={2} wrap="nowrap" style={{ color: s.c }}>{s.i}<Text size="xs" fw={700} c={s.c}>{s.t}</Text></Group>;
                            })()}
                            {m.reply_to && <Quote q={byWa.get(m.reply_to)} name={(q) => quoteName(q)} out={out} onClick={(q) => jumpTo(q.id)} />}
                            {m.media_path && (m.kind === 'audio'
                              ? <VoiceNote id={m.id} path={m.media_path} incoming={!out} played={!!m.played_at} onPlayed={() => qc.invalidateQueries({ queryKey: ['messages', current.id] })} />
                              : <Media path={m.media_path} kind={m.kind} name={m.file_name} />)}
                            {m.media_path && !/\.zip$/i.test(m.file_name ?? m.media_path) && ['image', 'document', 'video'].includes(m.kind ?? '') && (
                              <Group gap={4} mt={4}>{saved.data?.has(m.id)
                                ? <Badge size="xs" variant="light" color="teal" leftSection={<IconCheck size={10} />} style={{ cursor: 'pointer' }} onClick={() => setSaving(m as WaFile)}>נשמר במערכת</Badge>
                                : <Button size="compact-xs" variant="light" leftSection={<IconFileText size={12} />} onClick={() => setSaving(m as WaFile)}>שמירה במערכת</Button>}
                                {reportSource(m) && <Button size="compact-xs" variant="light" color="grape" loading={reading === m.id} onClick={() => intake(m, reportSource(m)!)}>קליטת דוח</Button>}</Group>)}
                            {m.kind === 'contacts' && m.body ? <SharedContacts body={m.body} known={(e) => partyByPhone(e)?.display_name ?? null}
                                onChat={openChat} onAdd={(name, phone) => setAddingContact({ name, phone })} />
                              : (m.body || !m.media_path) && <Text size="sm" c={WA.text} style={{ whiteSpace: 'pre-wrap', overflowWrap: 'anywhere' }} dir="auto">{m.body ?? kindLabel(m)}</Text>}
                            <Group gap={3} justify="flex-end" mt={2} wrap="nowrap">
                              <Text size="10px" c={WA.muted}>{hhmm(m.created_at)}</Text>
                              {out && !(m.origin === 'history' && !m.status) && <Ticks status={m.status} error={m.error} />}
                            </Group>
                            {reacted.length > 0 && (
                              <Box pos="absolute" bottom={-12} style={{ insetInlineStart: 8, background: '#fff', borderRadius: 12, padding: '0 5px', boxShadow: '0 1px 2px rgba(11,20,26,.2)', fontSize: 14, lineHeight: '20px' }}>{reacted.join(' ')}</Box>
                            )}
                          </Box>
                          {connected && windowOpen && m.wa_message_id && !m.wa_message_id.startsWith('import:') && (
                            <Tooltip label="תשובה עם ציטוט"><ActionIcon className="wa-reply" style={{ order: out ? -1 : 1 }} size="sm" radius="xl" variant="white" color="gray" onClick={() => setQuoting(m)} aria-label="תשובה עם ציטוט">
                              <IconArrowBackUp size={14} /></ActionIcon></Tooltip>)}
                        </Group>
                      </Box>
                    );
                  })}
                </Stack>
              </ScrollArea>
              <Composer conversation={current} connected={connected} windowOpen={windowOpen} quoting={quoting} quoteName={quoteName} onUnquote={() => setQuoting(null)} onSent={() => { setQuoting(null); qc.invalidateQueries({ queryKey: ['messages', current.id] }); qc.invalidateQueries({ queryKey: ['messages-recent'] }); qc.invalidateQueries({ queryKey: ['conversations'] }); }} />
            </>
          )}
        </Box>
      </Box>
      {aiPick && current && (
        <Modal opened onClose={() => setAiPick(false)} title="העברת השיחה ל-AI">
          <Stack>
            <Text size="sm">ה-AI יענה ללקוח לפי המדריך שתבחר, כולל על צילומי מסך, עד שהנושא ייגמר, עד שתעצור, או עד 24 שעות. הוא לא רואה את הכרטיס של הלקוח ולא מדבר על כסף. אם הלקוח שואל משהו אחר, ה-AI מחזיר אליך את השיחה. התשובות שלו מסומנות "AI".</Text>
            <Select label="מדריך" data={(guides.data ?? []).filter((g) => g.active).map((g) => ({ value: g.id, label: g.title }))} value={aiGuide} onChange={setAiGuide}
              nothingFoundMessage="אין מדריך פעיל" placeholder={(guides.data ?? []).some((g) => g.active) ? 'בחירת מדריך' : 'אין מדריך פעיל (הגדרות ← מדריכים ל-AI)'} />
            {isSpecial(current) && <Alert color="red" title="אליאנס מיוחד">
              {access.isAdmin ? <Checkbox label="אני מאשר שה-AI יענה ללקוח הזה" checked={specialOk} onChange={(e) => setSpecialOk(e.currentTarget.checked)} />
                : <Text size="sm">רק מנהל המערכת יכול להעביר שיחה של לקוח זה ל-AI.</Text>}
            </Alert>}
            <Group justify="flex-end">
              <Button variant="default" onClick={() => setAiPick(false)}>ביטול</Button>
              <Button color="violet" leftSection={<IconRobot size={16} />} loading={aiBusy} disabled={!aiGuide || (isSpecial(current) && (!access.isAdmin || !specialOk))}
                onClick={async () => { await aiCall({ action: 'start', conversation_id: current.id, guide_id: aiGuide, special_approved: isSpecial(current) && specialOk }); setAiPick(false); setSpecialOk(false); }}>העברה ל-AI</Button>
            </Group>
          </Stack>
        </Modal>
      )}
      {addingContact && (() => {
        const parts = addingContact.name.trim().split(/\s+/);
        return <ClientForm opened contact initial={{ first_name: parts.length > 1 ? parts[0] : '', last_name: parts.length > 1 ? parts.slice(1).join(' ') : parts[0], phone: addingContact.phone }}
          onClose={() => setAddingContact(null)} onAdded={() => { qc.invalidateQueries({ queryKey: ['conversations'] }); }} />;
      })()}
      {reporting && current?.client_party_id && (
        <ClientReport partyId={current.client_party_id} name={who(current)} conversationId={current.id} canSend={connected && windowOpen}
          onClose={() => setReporting(false)} onSent={() => { qc.invalidateQueries({ queryKey: ['messages', current.id] }); qc.invalidateQueries({ queryKey: ['messages-recent'] }); }} />
      )}
      {saving && current && <WaSaveDoc file={saving} partyId={roleOf(current.client_party_id)?.label === 'לקוח' ? current.client_party_id : null} onClose={() => setSaving(null)} />}
      {demo && <Text size="xs" c="dimmed">תצוגה לדוגמה: שמות והודעות מומצאים, לא נשמר כלום.</Text>}
      {!demo && conversations.length > 0 && <Anchor size="xs" c="dimmed" onClick={() => qc.invalidateQueries({ queryKey: ['conversations'] })}>רענון</Anchor>}
    </Stack>
  );
}

// A contact card sent in a chat (decision 203). The webhook writes each as "👤 name phone, phone";
// each number can be opened as a chat, and a number not in the system added as a contact.
function SharedContacts({ body, known, onChat, onAdd }: { body: string; known: (e164: string) => string | null; onChat: (e164: string) => void; onAdd: (name: string, phone: string) => void }) {
  const cards = body.split('\n').map((line) => {
    const t = line.replace(/[\u200e\u200f\u202a-\u202e\u2066-\u2069]/g, '').replace(/^👤\s*/, '');
    const m = /^(.*?)\s*((?:\+?[\d][\d\s().-]{5,}\d)(?:,\s*\+?[\d][\d\s().-]{5,}\d)*)\s*$/.exec(t);
    return m ? { name: m[1].trim() || 'בלי שם', phones: m[2].split(/,\s*/).map((p) => p.trim()) } : { name: t.trim(), phones: [] as string[] };
  });
  return (
    <Stack gap={6} my={2}>
      {cards.map((c, i) => (
        <Box key={i} p={8} style={{ background: '#ffffff99', borderRadius: 6, border: `1px solid ${WA.line}` }}>
          <Group gap={6} mb={4} wrap="nowrap"><Avatar size={28} radius="xl" color="gray">{initials(c.name)}</Avatar><Text size="sm" fw={600}>{c.name}</Text></Group>
          {!c.phones.length && <Text size="xs" c={WA.muted}>אין מספר בכרטיס</Text>}
          {c.phones.map((p) => {
            const e = toE164(p);
            const who = e ? known(e) : null;
            return (
              <Group key={p} gap={4} wrap="wrap">
                <Text size="xs" dir="ltr">{p}</Text>
                {who && <Badge size="xs" variant="light" color="teal">{who}</Badge>}
                {e && <Button size="compact-xs" variant="light" leftSection={<IconBrandWhatsapp size={12} />} onClick={() => onChat(e)}>פתיחת צ'אט</Button>}
                {e && !who && <Button size="compact-xs" variant="light" color="grape" onClick={() => onAdd(c.name, p)}>הוספה כאיש קשר</Button>}
              </Group>
            );
          })}
        </Box>
      ))}
    </Stack>
  );
}

// What a message without text is.
function kindLabel(m: Message): string {
  const k = m.kind ?? 'text';
  return ({ image: '📷 תמונה', video: '🎥 סרטון', audio: '🎤 הקלטה', document: `📄 ${m.file_name ?? 'מסמך'}`, sticker: 'מדבקה', location: '📍 מיקום', template: 'תבנית' } as Record<string, string>)[k] ?? (m.media_path ? '📎 קובץ' : '');
}

// The ticks of one of ours: sent ✓, delivered ✓✓, read ✓✓ in blue, failed ! with why.
// The message a message quotes, as WhatsApp shows it: a colored bar, who wrote it, a line of it.
function Quote({ q, name, out, onClick }: { q?: Message; name: (m: Message) => string; out: boolean; onClick?: (m: Message) => void }) {
  const color = q?.direction === 'out' ? '#06cf9c' : '#a5b337';
  return (
    <Box mb={4} px={8} py={4} onClick={() => q && onClick?.(q)} style={{ background: out ? '#d1f4cc' : '#f5f6f6', borderRadius: 6, borderInlineStart: `4px solid ${color}`, cursor: q && onClick ? 'pointer' : undefined }}>
      {q ? <>
        <Text size="xs" fw={700} c={color}>{name(q)}</Text>
        <Text size="xs" c={WA.muted} lineClamp={2} dir="auto" style={{ whiteSpace: 'pre-wrap' }}>{q.body ? `${q.kind && q.kind !== 'text' ? `${kindLabel(q).split(' ')[0]} ` : ''}${q.body}` : kindLabel(q)}</Text>
      </> : <Text size="xs" c={WA.muted}>הודעה מצוטטת (לא נמצאת במערכת)</Text>}
    </Box>
  );
}

function Ticks({ status, error }: { status?: string | null; error?: string | null }) {
  if (status === 'failed') return <Tooltip label={error ?? 'לא נמסרה'}><IconAlertCircle size={14} color="#d9480f" /></Tooltip>;
  if (status === 'read') return <IconChecks size={15} color={WA.tick} />;
  if (status === 'delivered') return <IconChecks size={15} color={WA.muted} />;
  return <IconCheck size={14} color={WA.muted} />;
}

// A picture or file of a message, from the private bucket (a link that works for an hour).
// A voice message (decision 206): its microphone green until the office first plays a client's
// one, blue after (kept on the message, for everyone); and 1, 1.5 or 2 times the speed.
const SPEEDS = [1, 1.5, 2];
function VoiceNote({ id, path, incoming, played, onPlayed }: { id: string; path: string; incoming: boolean; played: boolean; onPlayed: () => void }) {
  const url = useQuery({ queryKey: ['wa-media', path], staleTime: 50 * 60_000, queryFn: async () => (await supabase.storage.from('whatsapp').createSignedUrl(path, 3600)).data?.signedUrl ?? null });
  const audio = useRef<HTMLAudioElement>(null);
  const [speed, setSpeed] = useState(1);
  const [heard, setHeard] = useState(played);
  useEffect(() => setHeard(played), [played]);
  useEffect(() => { if (audio.current) audio.current.playbackRate = speed; }, [speed, url.data]);
  async function first() {
    if (!incoming || heard) return;
    setHeard(true);
    const { data: u } = await supabase.auth.getUser();
    await supabase.from('messages').update({ played_at: new Date().toISOString(), played_by: u.user?.id ?? null }).eq('id', id).is('played_at', null);
    onPlayed();
  }
  if (!url.data) return <Text size="xs" c={WA.muted}>טוען הקלטה…</Text>;
  const color = !incoming ? WA.muted : heard ? '#53bdeb' : WA.green;
  return (
    <Group gap={6} wrap="nowrap" mb={2}>
      <Tooltip label={!incoming ? 'הקלטה' : heard ? 'הושמעה' : 'עוד לא הושמעה'}><IconMicrophone size={22} color={color} style={{ flexShrink: 0 }} /></Tooltip>
      <audio ref={audio} controls src={url.data} style={{ maxWidth: 240, height: 36 }} onPlay={first} />
      <Button size="compact-xs" radius="xl" variant="light" color="gray" w={42} onClick={() => setSpeed(SPEEDS[(SPEEDS.indexOf(speed) + 1) % SPEEDS.length])} aria-label="מהירות">{speed}×</Button>
    </Group>
  );
}

function Media({ path, kind, name }: { path: string; kind?: string; name?: string | null }) {
  const url = useQuery({ queryKey: ['wa-media', path], staleTime: 50 * 60_000, queryFn: async () => (await supabase.storage.from('whatsapp').createSignedUrl(path, 3600)).data?.signedUrl ?? null });
  if (!url.data) return <Text size="xs" c={WA.muted}>טוען קובץ…</Text>;
  if (kind === 'image' || kind === 'sticker') return <Anchor href={url.data} target="_blank"><Image src={url.data} maw={kind === 'sticker' ? 120 : 280} radius="sm" mb={4} alt="" /></Anchor>;
  if (kind === 'audio') return <audio controls src={url.data} style={{ maxWidth: 260 }} />;
  if (kind === 'video') return <video controls src={url.data} style={{ maxWidth: 280, borderRadius: 6 }} />;
  return <Anchor href={url.data} target="_blank" size="sm"><Group gap={4} wrap="nowrap"><IconFileText size={18} />{name ?? 'קובץ'}</Group></Anchor>;
}

interface Template { name: string; language: string; category: string; body: string }

// The typing bar: a text within the 24 hours; after them, an approved template.
function Composer({ conversation, connected, windowOpen, quoting, quoteName, onUnquote, onSent }: { conversation: Conversation; connected: boolean; windowOpen: boolean; quoting: Message | null; quoteName: (m: Message) => string; onUnquote: () => void; onSent: () => void }) {
  const [text, setText] = useState('');
  const [busy, setBusy] = useState(false);
  const [picking, setPicking] = useState(false);
  async function send(body: Record<string, unknown>) {
    setBusy(true);
    try {
      const { error } = await supabase.functions.invoke('whatsapp-send', { body: { conversation_id: conversation.id, ...body } });
      if (error) {
        let msg = error.message;
        try { msg = (await (error as { context?: Response }).context?.json())?.error ?? msg; } catch { /* keep */ }
        throw new Error(msg);
      }
      setText(''); setPicking(false); onSent();
      return true;
    } catch (e) { notifications.show({ color: 'red', message: (e as Error).message }); return false; } finally { setBusy(false); }
  }
  return (
    <Box bg={WA.header} px="sm" py={8}>
      <Text size="xs" c={windowOpen ? WA.muted : '#b25e00'} ta="center" mb={6}>
        {!connected ? 'השליחה תופעל כשהוואטסאפ יחובר למערכת (הגדרות ← וואטסאפ)'
          : windowOpen ? 'הלקוח כתב ב-24 השעות האחרונות: אפשר לענות חופשי' : 'עברו 24 שעות מההודעה האחרונה של הלקוח: אפשר לשלוח רק תבנית מאושרת'}
      </Text>
      {quoting && <Group gap={4} wrap="nowrap" mb={6} px={4}><Box style={{ flex: 1, minWidth: 0 }}><Quote q={quoting} name={quoteName} out={false} /></Box>
        <ActionIcon variant="subtle" color="gray" onClick={onUnquote} aria-label="ביטול הציטוט"><IconX size={16} /></ActionIcon></Group>}
      <Group gap="xs" wrap="nowrap" align="flex-end">
        <Tooltip label="שליחת תבנית מאושרת"><ActionIcon variant="subtle" color="gray" size="lg" disabled={!connected} onClick={() => setPicking(true)} aria-label="תבנית"><IconTemplate size={24} /></ActionIcon></Tooltip>
        <Textarea style={{ flex: 1 }} radius="md" autosize minRows={1} maxRows={6} disabled={!connected || !windowOpen || busy}
          placeholder={!connected ? 'השליחה תופעל כשהוואטסאפ יחובר למערכת' : windowOpen ? 'הקלדת הודעה (Enter שולח, Shift+Enter שורה חדשה)' : 'אפשר לשלוח רק תבנית'}
          value={text} onChange={(e) => setText(e.currentTarget.value)} styles={{ input: { background: '#fff', border: 'none' } }}
          onKeyDown={(e) => { if (e.key === 'Enter' && !e.shiftKey && text.trim()) { e.preventDefault(); send({ text, reply_to: quoting?.wa_message_id }); } }} />
        <ActionIcon size={42} radius="xl" color={WA.green} variant="filled" disabled={!connected || !windowOpen || !text.trim()} loading={busy} onClick={() => send({ text, reply_to: quoting?.wa_message_id })} aria-label="שליחה">
          <IconSend size={20} style={{ transform: 'scaleX(-1)' }} />
        </ActionIcon>
      </Group>
      {picking && <TemplatePicker busy={busy} onClose={() => setPicking(false)} onSend={(t, params) => send({ template: t.name, language: t.language, params, preview: fill(t.body, params) })} />}
    </Box>
  );
}

const fill = (body: string, params: string[]) => body.replace(/\{\{(\d+)\}\}/g, (_, n) => params[Number(n) - 1] || `{{${n}}}`);

function TemplatePicker({ busy, onClose, onSend }: { busy: boolean; onClose: () => void; onSend: (t: Template, params: string[]) => void }) {
  const q = useQuery({
    queryKey: ['wa-templates'], staleTime: 5 * 60_000,
    queryFn: async () => {
      const { data, error } = await supabase.functions.invoke('whatsapp-send', { body: { action: 'templates' } });
      if (error) {
        let msg = error.message;
        try { msg = (await (error as { context?: Response }).context?.json())?.error ?? msg; } catch { /* keep */ }
        throw new Error(msg);
      }
      return data.templates as Template[];
    },
  });
  const [pick, setPick] = useState<string | null>(null);
  const [params, setParams] = useState<string[]>([]);
  const t = (q.data ?? []).find((x) => `${x.name}|${x.language}` === pick);
  const count = t ? new Set(t.body.match(/\{\{\d+\}\}/g) ?? []).size : 0;
  return (
    <Modal opened onClose={onClose} title="שליחת תבנית מאושרת">
      <Stack>
        {q.isLoading ? <Text size="sm" c="dimmed">טוען תבניות…</Text> : q.error ? <Alert color="red">{(q.error as Error).message}</Alert> : !(q.data ?? []).length
          ? <Alert color="yellow">אין תבניות מאושרות. יוצרים תבנית ב-WhatsApp Manager, ומחכים לאישור של Meta.</Alert>
          : <Select label="תבנית" data={(q.data ?? []).map((x) => ({ value: `${x.name}|${x.language}`, label: `${x.name} (${x.language})` }))} value={pick} onChange={(x) => { setPick(x); setParams([]); }} />}
        {t && <>
          {Array.from({ length: count }, (_, i) => <TextInput key={i} label={`{{${i + 1}}}`} value={params[i] ?? ''} onChange={(e) => { const p = [...params]; p[i] = e.currentTarget.value; setParams(p); }} />)}
          <Box p="sm" style={{ background: WA.out, borderRadius: 8 }}><Text size="sm" style={{ whiteSpace: 'pre-wrap' }} dir="auto">{fill(t.body, params)}</Text></Box>
        </>}
        <Group justify="flex-end">
          <Button variant="default" onClick={onClose}>ביטול</Button>
          <Button color="green" loading={busy} disabled={!t || params.filter((x) => x?.trim()).length < count} onClick={() => onSend(t!, params)}>שליחה</Button>
        </Group>
      </Stack>
    </Modal>
  );
}
