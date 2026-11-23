import { Badge, Button, Group, Modal, MultiSelect, Paper, Stack, Switch, Table, Text, Textarea, TextInput, Title } from '@mantine/core';
import { notifications } from '@mantine/notifications';
import { IconRobot } from '@tabler/icons-react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { useState } from 'react';
import { useAccess } from '../lib/access';
import { COUNTRY_HE } from '../lib/format';
import { must, supabase } from '../lib/supabase';

// The guides the AI may answer clients from in WhatsApp (SPEC decision 183). An admin writes
// and approves each one ("פעיל"); only an active guide can be given to a chat.

export interface AiGuide { id: string; title: string; countries: string[]; content: string; active: boolean; updated_at: string }

export function useAiGuides() {
  return useQuery({ queryKey: ['ai-guides'], queryFn: async () => must(await supabase.from('ai_guides').select('*').order('title')) as AiGuide[] });
}

export function AiGuidesSettings() {
  const access = useAccess();
  const q = useAiGuides();
  const [editing, setEditing] = useState<Partial<AiGuide> | null>(null);
  return (
    <Paper withBorder p="md">
      <Group justify="space-between" mb={4}>
        <Group gap="xs"><IconRobot size={22} /><Title order={4}>מדריכים ל-AI בוואטסאפ</Title></Group>
        {access.isAdmin && <Button size="xs" variant="light" onClick={() => setEditing({ title: '', countries: [], content: '', active: false })}>מדריך חדש</Button>}
      </Group>
      <Text size="sm" c="dimmed" mb="sm">בצ'אט, "העבר ל-AI" נותן ל-AI לענות ללקוח לפי מדריך אחד מכאן, עד שהנושא נגמר, עד שעוצרים, או עד שהוא מחזיר את השיחה. ה-AI לא רואה את כרטיס הלקוח ולא מדבר על כסף. רק מדריך "פעיל" (שאושר) אפשר לבחור.</Text>
      <Table fz="sm" verticalSpacing={4}>
        <Table.Tbody>{(q.data ?? []).map((g) => (
          <Table.Tr key={g.id}>
            <Table.Td fw={500}>{g.title}</Table.Td>
            <Table.Td>{g.countries.length ? g.countries.map((c) => COUNTRY_HE[c as keyof typeof COUNTRY_HE] ?? c).join(', ') : 'כל המדינות'}</Table.Td>
            <Table.Td>{g.active ? <Badge color="teal" variant="light">פעיל</Badge> : <Badge color="gray" variant="light">טיוטה</Badge>}</Table.Td>
            <Table.Td>{access.isAdmin && <Button size="compact-xs" variant="subtle" onClick={() => setEditing(g)}>עריכה</Button>}</Table.Td>
          </Table.Tr>
        ))}</Table.Tbody>
      </Table>
      {!q.data?.length && <Text size="sm" c="dimmed">אין מדריכים עדיין.</Text>}
      {editing && <GuideForm guide={editing} onClose={() => setEditing(null)} />}
    </Paper>
  );
}

function GuideForm({ guide, onClose }: { guide: Partial<AiGuide>; onClose: () => void }) {
  const qc = useQueryClient();
  const [v, setV] = useState({ title: guide.title ?? '', countries: guide.countries ?? [], content: guide.content ?? '', active: guide.active ?? false });
  const [busy, setBusy] = useState(false);
  async function save() {
    setBusy(true);
    const row = { ...v, updated_at: new Date().toISOString() };
    const r = guide.id ? await supabase.from('ai_guides').update(row).eq('id', guide.id) : await supabase.from('ai_guides').insert(row);
    setBusy(false);
    if (r.error) { notifications.show({ color: 'red', message: r.error.message }); return; }
    await qc.invalidateQueries({ queryKey: ['ai-guides'] });
    onClose();
  }
  return (
    <Modal opened onClose={onClose} title={guide.id ? 'עריכת מדריך' : 'מדריך חדש'} size="xl">
      <Stack>
        <TextInput label="כותרת" required value={v.title} onChange={(e) => setV({ ...v, title: e.currentTarget.value })} placeholder="פתיחת חשבון Wise" />
        <MultiSelect label="ללקוחות של" description="ריק: כל המדינות" data={Object.entries(COUNTRY_HE).map(([value, label]) => ({ value, label }))} value={v.countries} onChange={(x) => setV({ ...v, countries: x })} />
        <Textarea label="המדריך" description="מה שה-AI יודע ועונה לפיו: שלבים, מסכים, בעיות נפוצות. הוא לא יוסיף דברים שלא כתובים כאן." autosize minRows={14} maxRows={30} value={v.content} onChange={(e) => setV({ ...v, content: e.currentTarget.value })} />
        <Switch label="פעיל (בדקתי ואישרתי את התוכן)" checked={v.active} onChange={(e) => setV({ ...v, active: e.currentTarget.checked })} />
        <Group justify="flex-end">
          <Button variant="default" onClick={onClose}>ביטול</Button>
          <Button onClick={save} loading={busy} disabled={!v.title.trim() || !v.content.trim()}>שמירה</Button>
        </Group>
      </Stack>
    </Modal>
  );
}
