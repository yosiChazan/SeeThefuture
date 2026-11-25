import { ActionIcon, Alert, Badge, Button, Group, Paper, Stack, Switch, Table, Text, TextInput, Title } from '@mantine/core';
import { notifications } from '@mantine/notifications';
import { IconArrowDown, IconArrowUp, IconTrash } from '@tabler/icons-react';
import { useQueryClient } from '@tanstack/react-query';
import { useState } from 'react';
import { useFileCategories } from '../lib/fileCategories';
import { BUILT_IN_LABELS, type FileCategory } from '../lib/fileGroups';
import { supabase } from '../lib/supabase';

// Settings: the categories of property files (SPEC decision 107). The built-in ones are
// fixed; the office adds its own, renames them, marks them sensitive or not, orders them,
// and removes one that has no files.
export function FileCategoriesSettings() {
  const qc = useQueryClient();
  const cats = useFileCategories();
  const [label, setLabel] = useState('');
  const [sensitive, setSensitive] = useState(true);
  const [busy, setBusy] = useState(false);
  const list = cats.data ?? [];
  const refresh = () => qc.invalidateQueries({ queryKey: ['file-categories'] });
  const taken = (l: string) => [...BUILT_IN_LABELS, ...list.map((c) => c.label)].some((x) => x.trim() === l.trim());

  async function run(p: PromiseLike<{ error: { message: string; code?: string } | null }>, ok: string) {
    setBusy(true);
    const { error } = await p;
    setBusy(false);
    if (error) notifications.show({ color: 'red', message: error.code === '23503' ? 'יש קבצים בקטגוריה הזו. קודם מעבירים אותם לקטגוריה אחרת (בחלון הקובץ, "סוג")' : error.message });
    else notifications.show({ color: 'teal', message: ok });
    await refresh();
    return !error;
  }
  const add = async () => {
    const max = Math.max(0, ...list.map((c) => c.position));
    if (await run(supabase.from('file_categories').insert({ label: label.trim(), sensitive, position: max + 10 }), 'הקטגוריה נוספה')) { setLabel(''); setSensitive(true); }
  };
  const move = async (c: FileCategory, dir: -1 | 1) => {
    const i = list.indexOf(c), other = list[i + dir];
    if (!other) return;
    await run(supabase.from('file_categories').update({ position: other.position }).eq('id', c.id), 'הסדר עודכן');
    await run(supabase.from('file_categories').update({ position: c.position }).eq('id', other.id), 'הסדר עודכן');
  };

  return (
    <Paper withBorder p="md">
      <Title order={4} mb={4}>קטגוריות של קבצים</Title>
      <Text size="sm" c="dimmed" mb="sm">הלשוניות בחלק "קבצים" בכרטיס הנכס, ובבחירת "לאן" בייבוא ZIP. קבועות: {BUILT_IN_LABELS.join(', ')}.</Text>
      <Stack gap="xs">
        {list.length > 0 && (
          <Table verticalSpacing={4}>
            <Table.Thead><Table.Tr><Table.Th>שם</Table.Th><Table.Th>רגיש</Table.Th><Table.Th /></Table.Tr></Table.Thead>
            <Table.Tbody>{list.map((c, i) => (
              <Table.Tr key={c.id}>
                <Table.Td><TextInput size="xs" defaultValue={c.label} maw={260}
                  onBlur={(e) => { const v = e.currentTarget.value.trim(); if (v && v !== c.label) run(supabase.from('file_categories').update({ label: v }).eq('id', c.id), 'השם עודכן'); }} /></Table.Td>
                <Table.Td><Switch checked={c.sensitive} onChange={(e) => run(supabase.from('file_categories').update({ sensitive: e.currentTarget.checked }).eq('id', c.id), 'עודכן')} /></Table.Td>
                <Table.Td><Group gap={2} justify="flex-end" wrap="nowrap">
                  <ActionIcon variant="subtle" disabled={i === 0} onClick={() => move(c, -1)} aria-label="למעלה"><IconArrowUp size={14} /></ActionIcon>
                  <ActionIcon variant="subtle" disabled={i === list.length - 1} onClick={() => move(c, 1)} aria-label="למטה"><IconArrowDown size={14} /></ActionIcon>
                  <ActionIcon variant="subtle" color="red" onClick={() => run(supabase.from('file_categories').delete().eq('id', c.id), 'הקטגוריה נמחקה')} aria-label="מחיקה"><IconTrash size={14} /></ActionIcon>
                </Group></Table.Td>
              </Table.Tr>
            ))}</Table.Tbody>
          </Table>
        )}
        <Group align="flex-end" gap="xs">
          <TextInput label="קטגוריה חדשה" placeholder="למשל: היתרי בנייה" value={label} onChange={(e) => setLabel(e.currentTarget.value)} maxLength={40} w={260}
            error={label.trim() && taken(label) ? 'כבר קיימת' : undefined} />
          <Switch label="רגיש" checked={sensitive} onChange={(e) => setSensitive(e.currentTarget.checked)} mb={8} />
          <Button onClick={add} loading={busy} disabled={!label.trim() || taken(label)}>הוספה</Button>
        </Group>
        <Text size="xs" c="dimmed">רגיש: רק מי שיש לו הרשאה למסמכים רגישים רואה את הקבצים, והתצוגה נפתחת בלחיצה. לא רגיש: מוצג מיד כתמונה ממוזערת. שינוי של "רגיש" חל על קבצים חדשים.</Text>
        {cats.error && <Alert color="red">{(cats.error as Error).message}</Alert>}
        {list.length > 0 && <Badge variant="light" w="fit-content">{list.length} קטגוריות שנוספו</Badge>}
      </Stack>
    </Paper>
  );
}
