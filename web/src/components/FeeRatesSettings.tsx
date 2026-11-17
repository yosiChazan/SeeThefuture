import { ActionIcon, Alert, Button, Group, Modal, NumberInput, Paper, Stack, Table, Text, TextInput, Title } from '@mantine/core';
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
  // A change is shown with what it does before it is made (decision 162).
  const [change, setChange] = useState<{ month: string; pct: number | null; notes: string } | null>(null);
  const save = () => setChange({ month: month!, pct: Number(pct), notes });
  const remove = (r: Rate) => setChange({ month: r.month, pct: null, notes: '' });
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
      {change && <Confirm change={change} onClose={async (applied) => { setChange(null); if (applied) { setPct(''); setNotes(''); } await refresh(); setBusy(false); }} />}
    </Paper>
  );
}

interface Effect { rent_id: string; period: string; property: string; owner: string | null; rent: number; currency: string; fee_now: number; fee_new: number; manual: boolean }
const fmt = (n: number) => Number(n).toLocaleString('en-US', { maximumFractionDigits: 2 });

// Every rent the change governs, with its fee now and after; approve or cancel.
function Confirm({ change, onClose }: { change: { month: string; pct: number | null; notes: string }; onClose: (applied: boolean) => void }) {
  const q = useQuery({
    queryKey: ['fee-rate-preview', change],
    queryFn: async () => must(await supabase.rpc('fee_rate_preview', { p_city: 'Odessa', p_month: change.month, p_pct: change.pct })) as Effect[],
  });
  const [busy, setBusy] = useState(false);
  const rows = q.data ?? [];
  const changed = rows.filter((r) => !r.manual && Number(r.fee_now) !== Number(r.fee_new));
  const diff = changed.reduce((a, r) => a + Number(r.fee_new) - Number(r.fee_now), 0);
  async function apply() {
    setBusy(true);
    const { data, error } = await supabase.rpc('fee_rate_apply', { p_city: 'Odessa', p_month: change.month, p_pct: change.pct, p_notes: change.notes });
    setBusy(false);
    if (error) { notifications.show({ color: 'red', message: error.message }); return; }
    notifications.show({ color: 'teal', message: `האחוז נשמר. דמי הניהול חושבו מחדש ב-${data} שכירויות` });
    onClose(true);
  }
  const title = change.pct === null ? `מחיקת האחוז מ-${dayjs(change.month).format('MM.YYYY')}` : `${change.pct}% מ-${dayjs(change.month).format('MM.YYYY')}`;
  return (
    <Modal opened onClose={() => onClose(false)} title={`ההשלכות: ${title}`} size="xl">
      <Stack>
        {q.isLoading ? <Text size="sm" c="dimmed">מחשב…</Text> : !rows.length ? (
          <Alert color="teal">אין שכירות רשומה בחודשים האלה. השינוי יחול על שכירות שתירשם מעכשיו.</Alert>
        ) : (
          <>
            <Alert color={changed.length ? 'orange' : 'teal'}>
              {changed.length ? `${changed.length} שכירויות יקבלו דמי ניהול חדשים: הישנים יבוטלו והחדשים יירשמו. הפרש כולל: ${diff > 0 ? '+' : ''}${fmt(diff)} ₴` : 'אין שכירות שדמי הניהול שלה משתנים.'}
              {rows.some((r) => r.manual) && ' שכירות עם דמי ניהול שהוזנו ידנית לא משתנה (מסומנת).'}
            </Alert>
            <Table.ScrollContainer minWidth={640}>
              <Table fz="sm" striped verticalSpacing={4}>
                <Table.Thead><Table.Tr><Table.Th>חודש</Table.Th><Table.Th>דירה</Table.Th><Table.Th>בעלים</Table.Th><Table.Th>שכירות</Table.Th><Table.Th>דמי ניהול עכשיו</Table.Th><Table.Th>אחרי</Table.Th></Table.Tr></Table.Thead>
                <Table.Tbody>{rows.map((r) => (
                  <Table.Tr key={r.rent_id + r.property} c={r.manual ? 'dimmed' : undefined}>
                    <Table.Td>{dayjs(r.period).format('MM.YYYY')}</Table.Td>
                    <Table.Td>{r.property}</Table.Td>
                    <Table.Td><Text size="xs">{r.owner}</Text></Table.Td>
                    <Table.Td>{fmt(r.rent)} {r.currency}</Table.Td>
                    <Table.Td>{fmt(r.fee_now)}</Table.Td>
                    <Table.Td fw={!r.manual && Number(r.fee_now) !== Number(r.fee_new) ? 700 : undefined}>{r.manual ? 'ידני, לא משתנה' : fmt(r.fee_new)}</Table.Td>
                  </Table.Tr>
                ))}</Table.Tbody>
              </Table>
            </Table.ScrollContainer>
          </>
        )}
        <Group justify="flex-end">
          <Button variant="default" onClick={() => onClose(false)}>ביטול</Button>
          <Button onClick={apply} loading={busy} disabled={q.isLoading || q.isError}>אישור</Button>
        </Group>
      </Stack>
    </Modal>
  );
}
