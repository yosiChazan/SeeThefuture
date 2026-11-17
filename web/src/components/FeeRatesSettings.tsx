import { ActionIcon, Button, Group, NumberInput, Paper, Table, Text, TextInput, Title } from '@mantine/core';
import { MonthPickerInput } from '@mantine/dates';
import { notifications } from '@mantine/notifications';
import { IconTrash } from '@tabler/icons-react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import dayjs from 'dayjs';
import { useState } from 'react';
import { must, supabase } from '../lib/supabase';

// Odessa's STF management fee per month (SPEC decision 158): a rate holds from its month on,
// until the next one. Every rent posted for an Odessa apartment gets its fee at its month's rate.
interface Rate { city_en: string; month: string; pct: number; notes: string | null }
export function FeeRatesSettings() {
  const qc = useQueryClient();
  const q = useQuery({ queryKey: ['fee-rates'], queryFn: async () => must(await supabase.from('fee_rates').select('city_en, month, pct, notes').eq('city_en', 'Odessa').order('month', { ascending: false })) as Rate[] });
  const [month, setMonth] = useState<string | null>(dayjs().startOf('month').format('YYYY-MM-DD'));
  const [pct, setPct] = useState<number | ''>('');
  const [notes, setNotes] = useState('');
  const [busy, setBusy] = useState(false);
  const refresh = () => qc.invalidateQueries({ queryKey: ['fee-rates'] });
  async function save() {
    setBusy(true);
    const { error } = await supabase.from('fee_rates').upsert({ city_en: 'Odessa', month, pct: Number(pct), notes: notes.trim() || null }, { onConflict: 'city_en,month' });
    setBusy(false);
    if (error) { notifications.show({ color: 'red', message: error.message }); return; }
    setPct(''); setNotes(''); await refresh();
  }
  async function remove(r: Rate) {
    const { error } = await supabase.from('fee_rates').delete().eq('city_en', r.city_en).eq('month', r.month);
    if (error) notifications.show({ color: 'red', message: error.message }); else await refresh();
  }
  const rows = q.data ?? [];
  return (
    <Paper withBorder p="md">
      <Title order={4} mb={4}>דמי ניהול STF באודסה</Title>
      <Text size="sm" c="dimmed" mb="sm">אחוז מהשכירות, מהחודש שנבחר והלאה, עד לשינוי הבא. כל שכירות שנרשמת לדירה באודסה, מכל מקור, מקבלת לבד שורת דמי ניהול לפי האחוז של החודש שלה. שינוי חל רק על שכירות שתירשם מעכשיו.</Text>
      <Table fz="sm" mb="sm" verticalSpacing={4}>
        <Table.Thead><Table.Tr><Table.Th>מחודש</Table.Th><Table.Th>אחוז</Table.Th><Table.Th>הערה</Table.Th><Table.Th w={40} /></Table.Tr></Table.Thead>
        <Table.Tbody>{rows.map((r, i) => (
          <Table.Tr key={r.month}>
            <Table.Td>{dayjs(r.month).format('MM.YYYY')}{i === 0 && <Text span size="xs" c="teal"> · בתוקף</Text>}</Table.Td>
            <Table.Td>{Number(r.pct)}%</Table.Td>
            <Table.Td>{r.notes}</Table.Td>
            <Table.Td><ActionIcon size="sm" variant="subtle" color="red" onClick={() => remove(r)} aria-label="מחיקה"><IconTrash size={14} /></ActionIcon></Table.Td>
          </Table.Tr>
        ))}</Table.Tbody>
      </Table>
      <Group align="flex-end" gap="xs">
        <MonthPickerInput label="מחודש" value={month} onChange={(d) => setMonth(d ? dayjs(d).startOf('month').format('YYYY-MM-DD') : null)} valueFormat="MM.YYYY" w={130} />
        <NumberInput label="אחוז" min={0} max={100} decimalScale={2} value={pct} onChange={(x) => setPct(x === '' ? '' : Number(x))} w={100} />
        <TextInput label="הערה" value={notes} onChange={(e) => setNotes(e.currentTarget.value)} style={{ flex: 1 }} />
        <Button onClick={save} loading={busy} disabled={!month || pct === ''}>שמירה</Button>
      </Group>
    </Paper>
  );
}
