import { ActionIcon, Alert, Button, Group, Paper, Stack, Table, Text, TextInput, Title } from '@mantine/core';
import { notifications } from '@mantine/notifications';
import { IconArrowDown, IconArrowUp, IconTrash } from '@tabler/icons-react';
import { useQueryClient } from '@tanstack/react-query';
import { useState } from 'react';
import { useTaskCategories, type TaskCategory } from '../pages/Tasks';
import { supabase } from '../lib/supabase';

// Settings: the categories of tasks (SPEC decision 129). The office adds, renames, orders
// and removes them; a removed category leaves its tasks without one. Admin only.
export function TaskCategoriesSettings() {
  const qc = useQueryClient();
  const cats = useTaskCategories();
  const [label, setLabel] = useState('');
  const [busy, setBusy] = useState(false);
  const list = cats.data ?? [];
  const taken = (l: string) => list.some((c) => c.label.trim() === l.trim());
  async function run(p: PromiseLike<{ error: { message: string } | null }>, ok: string) {
    setBusy(true);
    const { error } = await p;
    setBusy(false);
    notifications.show(error ? { color: 'red', message: error.message } : { color: 'teal', message: ok });
    await qc.invalidateQueries({ queryKey: ['task-categories'] });
    return !error;
  }
  const add = async () => {
    const max = Math.max(0, ...list.map((c) => c.position));
    if (await run(supabase.from('task_categories').insert({ label: label.trim(), position: max + 10 }), 'הקטגוריה נוספה')) setLabel('');
  };
  const move = async (c: TaskCategory, dir: -1 | 1) => {
    const other = list[list.indexOf(c) + dir];
    if (!other) return;
    await run(supabase.from('task_categories').update({ position: other.position }).eq('id', c.id), 'הסדר עודכן');
    await run(supabase.from('task_categories').update({ position: c.position }).eq('id', other.id), 'הסדר עודכן');
  };
  return (
    <Paper withBorder p="md">
      <Title order={4} mb={4}>קטגוריות של משימות</Title>
      <Text size="sm" c="dimmed" mb="sm">לבחירה במשימה, למיון ולסינון בדף המשימות. מחיקה של קטגוריה משאירה את המשימות שלה בלי קטגוריה.</Text>
      <Stack gap="xs">
        {list.length > 0 && (
          <Table verticalSpacing={4}>
            <Table.Tbody>{list.map((c, i) => (
              <Table.Tr key={c.id}>
                <Table.Td><TextInput size="xs" defaultValue={c.label} maw={260}
                  onBlur={(e) => { const v = e.currentTarget.value.trim(); if (v && v !== c.label) run(supabase.from('task_categories').update({ label: v }).eq('id', c.id), 'השם עודכן'); }} /></Table.Td>
                <Table.Td><Group gap={2} justify="flex-end" wrap="nowrap">
                  <ActionIcon variant="subtle" disabled={i === 0} onClick={() => move(c, -1)} aria-label="למעלה"><IconArrowUp size={14} /></ActionIcon>
                  <ActionIcon variant="subtle" disabled={i === list.length - 1} onClick={() => move(c, 1)} aria-label="למטה"><IconArrowDown size={14} /></ActionIcon>
                  <ActionIcon variant="subtle" color="red" onClick={() => run(supabase.from('task_categories').delete().eq('id', c.id), 'הקטגוריה נמחקה')} aria-label="מחיקה"><IconTrash size={14} /></ActionIcon>
                </Group></Table.Td>
              </Table.Tr>
            ))}</Table.Tbody>
          </Table>
        )}
        <Group align="flex-end" gap="xs">
          <TextInput label="קטגוריה חדשה" placeholder="למשל: הנהלת חשבונות" value={label} onChange={(e) => setLabel(e.currentTarget.value)} maxLength={40} w={260}
            error={label.trim() && taken(label) ? 'כבר קיימת' : undefined} />
          <Button onClick={add} loading={busy} disabled={!label.trim() || taken(label)}>הוספה</Button>
        </Group>
        {cats.error && <Alert color="red">{(cats.error as Error).message}</Alert>}
      </Stack>
    </Paper>
  );
}
