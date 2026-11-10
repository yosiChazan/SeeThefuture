import { Alert, Anchor, Badge, Button, Card, Grid, Group, Paper, ScrollArea, SegmentedControl, Select, Stack, Text, Textarea, TextInput, Title } from '@mantine/core';
import { notifications } from '@mantine/notifications';
import { IconBrandWhatsapp, IconSearch } from '@tabler/icons-react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { useMemo, useState } from 'react';
import { Link, useSearchParams } from 'react-router-dom';
import { useStaff } from '../components/ManualTopics';
import { waLink } from '../components/Phone';
import { useClients } from '../lib/queries';
import { must, supabase } from '../lib/supabase';

// The shared WhatsApp inbox (SPEC §6.5, decision 135). A message that comes in is matched to
// its client by phone number; people answer from here, never a bot. Until WhatsApp is
// connected to the system the list fills only once it is; meanwhile every phone number in the
// system opens a chat in the WhatsApp Business app or WhatsApp Web.

interface Conversation { id: string; client_party_id: string | null; wa_phone: string; assigned_to: string | null; status: 'open' | 'waiting' | 'closed'; last_message_at: string | null }
interface Message { id: string; conversation_id: string; direction: 'in' | 'out'; body: string | null; media_path: string | null; sent_by: string | null; created_at: string }

const STATUS_HE = { open: 'פתוחה', waiting: 'ממתינה ללקוח', closed: 'סגורה' };
const STATUS_COLOR = { open: 'green', waiting: 'yellow', closed: 'gray' };
const WINDOW_MS = 24 * 3600 * 1000;

function useConversations() {
  return useQuery({ queryKey: ['conversations'], queryFn: async () => must(await supabase.from('conversations').select('*').order('last_message_at', { ascending: false, nullsFirst: false })) as Conversation[] });
}
function useMessages(id: string | null) {
  return useQuery({
    queryKey: ['messages', id], enabled: !!id,
    queryFn: async () => must(await supabase.from('messages').select('*').eq('conversation_id', id!).order('created_at')) as Message[],
  });
}

export function Messages() {
  const qc = useQueryClient();
  const conversations = useConversations();
  const clients = useClients();
  const staff = useStaff();
  const [params, setParams] = useSearchParams();
  const [search, setSearch] = useState('');
  const [state, setState] = useState<'active' | 'closed' | 'all'>('active');
  const names = useMemo(() => new Map((clients.data ?? []).map((c) => [c.id, c.display_name])), [clients.data]);
  const staffNames = useMemo(() => new Map((staff.data ?? []).map((s) => [s.user_id, s.display_name])), [staff.data]);
  const list = (conversations.data ?? []).filter((c) => (state === 'all' || (state === 'closed') === (c.status === 'closed'))
    && (!search.trim() || `${names.get(c.client_party_id ?? '') ?? ''} ${c.wa_phone}`.includes(search.trim())));
  const current = (conversations.data ?? []).find((c) => c.id === params.get('c')) ?? null;
  const messages = useMessages(current?.id ?? null);
  const lastIn = [...(messages.data ?? [])].reverse().find((m) => m.direction === 'in');
  const windowOpen = !!lastIn && Date.now() - new Date(lastIn.created_at).getTime() < WINDOW_MS;
  async function update(fields: Partial<Conversation>) {
    const r = await supabase.from('conversations').update(fields).eq('id', current!.id);
    if (r.error) notifications.show({ color: 'red', message: r.error.message });
    await qc.invalidateQueries({ queryKey: ['conversations'] });
  }
  const who = (c: Conversation) => (c.client_party_id ? names.get(c.client_party_id) : null) ?? c.wa_phone;

  return (
    <Stack>
      <Title order={2}>הודעות</Title>
      <Alert color="blue" icon={<IconBrandWhatsapp size={18} />} title="הוואטסאפ עוד לא מחובר למערכת">
        כשהוואטסאפ העסקי יחובר, כל הודעה מלקוח תופיע כאן, משויכת לכרטיס שלו לפי מספר הטלפון, ועובדים יענו מכאן. עד אז, ליד כל מספר טלפון
        בכרטיסי הלקוחות ובאנשי הקשר יש כפתור וואטסאפ שפותח שיחה באפליקציה העסקית או ב-WhatsApp Web.
      </Alert>
      <Grid>
        <Grid.Col span={{ base: 12, md: 4 }}>
          <Paper withBorder p="sm">
            <Stack gap="xs">
              <TextInput size="xs" placeholder="חיפוש לקוח או מספר" leftSection={<IconSearch size={14} />} value={search} onChange={(e) => setSearch(e.currentTarget.value)} />
              <SegmentedControl size="xs" value={state} onChange={(x) => setState(x as typeof state)}
                data={[{ value: 'active', label: 'פעילות' }, { value: 'closed', label: 'סגורות' }, { value: 'all', label: 'הכול' }]} />
              {!list.length && <Text size="sm" c="dimmed">אין שיחות.</Text>}
              {list.map((c) => (
                <Card key={c.id} withBorder padding="xs" style={{ cursor: 'pointer' }} bg={c.id === current?.id ? 'blue.0' : undefined} onClick={() => setParams({ c: c.id })}>
                  <Group justify="space-between" wrap="nowrap">
                    <Text size="sm" fw={600} lineClamp={1}>{who(c)}</Text>
                    <Badge size="xs" color={STATUS_COLOR[c.status]}>{STATUS_HE[c.status]}</Badge>
                  </Group>
                  <Text size="xs" c="dimmed">{c.assigned_to ? `אצל ${staffNames.get(c.assigned_to) ?? ''}` : 'לא שויכה'}{c.last_message_at ? ` · ${new Date(c.last_message_at).toLocaleString('he-IL')}` : ''}</Text>
                </Card>
              ))}
            </Stack>
          </Paper>
        </Grid.Col>
        <Grid.Col span={{ base: 12, md: 8 }}>
          {!current ? <Paper withBorder p="xl"><Text c="dimmed" ta="center">בוחרים שיחה מהרשימה</Text></Paper> : (
            <Paper withBorder p="sm">
              <Stack gap="xs">
                <Group justify="space-between">
                  <Group gap="xs">
                    <Text fw={700}>{who(current)}</Text>
                    {current.client_party_id && <Anchor component={Link} to={`/clients/${current.client_party_id}`} size="sm">לכרטיס הלקוח</Anchor>}
                    {waLink(current.wa_phone) && <Anchor href={waLink(current.wa_phone)!} target="_blank" rel="noopener noreferrer" size="sm">פתיחה בוואטסאפ</Anchor>}
                  </Group>
                  <Group gap="xs">
                    <Select size="xs" w={170} placeholder="שיוך לעובד" clearable value={current.assigned_to}
                      data={(staff.data ?? []).map((s) => ({ value: s.user_id, label: s.display_name }))} onChange={(x) => update({ assigned_to: x })} />
                    <Select size="xs" w={140} allowDeselect={false} value={current.status} onChange={(x) => x && update({ status: x as Conversation['status'] })}
                      data={Object.entries(STATUS_HE).map(([value, label]) => ({ value, label }))} />
                  </Group>
                </Group>
                <ScrollArea h={420} type="auto">
                  <Stack gap={6} p="xs">
                    {(messages.data ?? []).map((m) => (
                      <Group key={m.id} justify={m.direction === 'in' ? 'flex-start' : 'flex-end'}>
                        <Paper p="xs" radius="md" maw="75%" bg={m.direction === 'in' ? 'gray.1' : 'green.1'}>
                          <Text size="sm" style={{ whiteSpace: 'pre-wrap' }}>{m.body ?? (m.media_path ? '📎 קובץ' : '')}</Text>
                          <Text size="xs" c="dimmed">{new Date(m.created_at).toLocaleString('he-IL')}{m.direction === 'out' && m.sent_by ? ` · ${staffNames.get(m.sent_by) ?? ''}` : ''}</Text>
                        </Paper>
                      </Group>
                    ))}
                  </Stack>
                </ScrollArea>
                <Textarea placeholder="השליחה תופעל כשהוואטסאפ יחובר למערכת" disabled autosize minRows={2} />
                <Group justify="space-between">
                  <Text size="xs" c="dimmed">{windowOpen ? 'הלקוח כתב ב-24 השעות האחרונות: אפשר לענות חופשי.' : 'עברו 24 שעות מההודעה האחרונה של הלקוח: אפשר לשלוח רק תבנית מאושרת.'}</Text>
                  <Button size="xs" disabled>שליחה</Button>
                </Group>
              </Stack>
            </Paper>
          )}
        </Grid.Col>
      </Grid>
    </Stack>
  );
}
