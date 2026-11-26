import { Anchor, Badge, Box, Group, Image, ScrollArea, Stack, Text, TextInput, UnstyledButton } from '@mantine/core';
import { IconSearch, IconUsersGroup } from '@tabler/icons-react';
import { useQuery } from '@tanstack/react-query';
import { useState } from 'react';
import { must, supabase } from '../lib/supabase';

// WhatsApp groups as the WhatsApp Web extension read them (SPEC decision 212): read only. A group
// opened on the office's computer has all its messages; otherwise only the last lines of the list.

interface WaGroup { id: string; title: string; last_message_at: string | null }
interface GroupMessage { id: string; sender: string | null; body: string | null; sent_at: string | null; created_at: string; kind: string; file_name: string | null; media_path: string | null; origin: 'open' | 'preview' }

const at = (m: GroupMessage) => new Date(m.sent_at ?? m.created_at).toLocaleString('he-IL', { day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit' });

function Picture({ path }: { path: string }) {
  const url = useQuery({ queryKey: ['wa-media', path], staleTime: 50 * 60_000, queryFn: async () => (await supabase.storage.from('whatsapp').createSignedUrl(path, 3600)).data?.signedUrl ?? null });
  return url.data ? <Anchor href={url.data} target="_blank"><Image src={url.data} maw={260} radius="sm" mb={4} alt="" /></Anchor> : null;
}

export function WaGroups() {
  const [search, setSearch] = useState('');
  const [current, setCurrent] = useState<string | null>(null);
  const groups = useQuery({ queryKey: ['wa-groups'], refetchInterval: 20_000, queryFn: async () => must(await supabase.from('wa_groups').select('id, title, last_message_at').order('last_message_at', { ascending: false, nullsFirst: false })) as WaGroup[] });
  const messages = useQuery({
    queryKey: ['wa-group-messages', current], enabled: !!current, refetchInterval: 20_000,
    queryFn: async () => must(await supabase.from('wa_group_messages').select('id, sender, body, sent_at, created_at, kind, file_name, media_path, origin').eq('group_id', current!).order('sent_at', { ascending: true, nullsFirst: false }).order('created_at').limit(1000)) as GroupMessage[],
  });
  const list = (groups.data ?? []).filter((g) => !search.trim() || g.title.includes(search.trim()));
  const g = list.find((x) => x.id === current) ?? (groups.data ?? []).find((x) => x.id === current);
  return (
    <Box style={{ display: 'flex', height: 'calc(100vh - 170px)', minHeight: 420, border: '1px solid #e9edef', borderRadius: 8, overflow: 'hidden' }}>
      <Box w={320} style={{ borderInlineEnd: '1px solid #e9edef', display: 'flex', flexDirection: 'column' }}>
        <Box p={8}><TextInput size="sm" placeholder="חיפוש קבוצה" leftSection={<IconSearch size={16} />} value={search} onChange={(e) => setSearch(e.currentTarget.value)} /></Box>
        <ScrollArea style={{ flex: 1 }}>
          {!list.length && <Text size="sm" c="dimmed" ta="center" p="lg">עוד לא נקראו קבוצות. התוסף ב-WhatsApp Web שולח אותן לכאן (הגדרות ← וואטסאפ).</Text>}
          {list.map((x) => (
            <UnstyledButton key={x.id} w="100%" onClick={() => setCurrent(x.id)} style={{ background: x.id === current ? '#f0f2f5' : undefined }}>
              <Group gap="sm" px="md" py={10} wrap="nowrap" style={{ borderBottom: '1px solid #e9edef' }}>
                <IconUsersGroup size={22} color="#667781" />
                <Box style={{ minWidth: 0 }}><Text size="sm" lineClamp={1}>{x.title}</Text>
                  <Text size="xs" c="dimmed">{x.last_message_at ? new Date(x.last_message_at).toLocaleString('he-IL', { day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit' }) : ''}</Text></Box>
              </Group>
            </UnstyledButton>
          ))}
        </ScrollArea>
      </Box>
      <Box style={{ flex: 1, display: 'flex', flexDirection: 'column', background: '#efeae2' }}>
        {!g ? <Text c="dimmed" ta="center" mt="xl">בוחרים קבוצה. קריאה בלבד: אי אפשר לכתוב בקבוצות מכאן.</Text> : <>
          <Group px="md" py={10} bg="#f0f2f5" justify="space-between"><Text fw={600}>{g.title}</Text><Badge variant="light" color="gray">קריאה בלבד</Badge></Group>
          <ScrollArea style={{ flex: 1 }} p="md">
            <Stack gap={6}>
              {/* A last line seen in the list is left out once the same message was read in the open group. */}
              {(messages.data ?? []).filter((m, _, all) => m.origin === 'open' || !all.some((o) => o.origin === 'open' && o.sender === m.sender && o.body === m.body)).map((m) => (
                <Box key={m.id} p={8} maw="75%" style={{ background: m.sender === 'אני' ? '#d9fdd3' : '#fff', borderRadius: 8, alignSelf: m.sender === 'אני' ? 'flex-end' : 'flex-start' }}>
                  {m.sender && <Text size="xs" fw={700} c="#1c7ed6">{m.sender}</Text>}
                  {m.media_path && <Picture path={m.media_path} />}
                  {m.file_name && <Text size="sm">📄 {m.file_name}</Text>}
                  {m.body && <Text size="sm" style={{ whiteSpace: 'pre-wrap' }} dir="auto">{m.body}</Text>}
                  <Group gap={4} justify="flex-end"><Text size="10px" c="dimmed">{at(m)}</Text>{m.origin === 'preview' && <Text size="10px" c="dimmed">· מתוך רשימת השיחות</Text>}</Group>
                </Box>
              ))}
            </Stack>
          </ScrollArea>
        </>}
      </Box>
    </Box>
  );
}
