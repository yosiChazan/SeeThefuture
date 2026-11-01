import { Alert, Badge, Button, Checkbox, Group, Paper, SegmentedControl, Stack, Table, Text, TextInput, Title } from '@mantine/core';
import { notifications } from '@mantine/notifications';
import { useQueryClient } from '@tanstack/react-query';
import { useMemo, useState } from 'react';
import { fullName, suggestSplit, type NameSplit } from '../lib/names';
import { useClients } from '../lib/queries';
import { supabase } from '../lib/supabase';

interface Row extends NameSplit { id: string; display: string; legal: string | null; ok: boolean }

// Splitting the clients' stored names into first and last name (SPEC decision 72). Every
// suggestion is shown, can be corrected, and only the checked ones are saved. Names that
// need a look are unchecked. The shown name becomes "first last"; when that differs from
// the old one and no name as in the reports is set, the old one is kept there (decision 62).
export function SplitNames() {
  const clients = useClients();
  const qc = useQueryClient();
  const initial = useMemo(() => (clients.data ?? [])
    .filter((c) => c.kind === 'person' && !c.first_name && !c.last_name)
    .map((c): Row => { const s = suggestSplit(c.display_name); return { ...s, id: c.id, display: c.display_name, legal: c.legal_name, ok: s.sure }; })
    .sort((a, b) => Number(a.sure) - Number(b.sure) || a.last.localeCompare(b.last, 'he')), [clients.data]);
  const [edits, setEdits] = useState<Record<string, Partial<Row>>>({});
  const [show, setShow] = useState('check');
  const [busy, setBusy] = useState(false);
  const rows = initial.map((r) => ({ ...r, ...edits[r.id] }));
  const set = (id: string, patch: Partial<Row>) => setEdits((e) => ({ ...e, [id]: { ...e[id], ...patch } }));
  const chosen = rows.filter((r) => r.ok && r.last.trim());
  const visible = rows.filter((r) => show === 'all' || !r.sure);

  async function save() {
    setBusy(true);
    let saved = 0;
    for (const r of chosen) {
      const name = fullName(r.first, r.last);
      const { error } = await supabase.from('parties').update({
        first_name: r.first.trim() || null, last_name: r.last.trim(), display_name: name,
        ...(name !== r.display && !r.legal ? { legal_name: r.display } : {}),
      }).eq('id', r.id);
      if (error) notifications.show({ color: 'red', title: r.display, message: error.message }); else saved += 1;
    }
    notifications.show({ color: 'teal', message: `נשמרו ${saved} שמות` });
    setEdits({});
    await qc.invalidateQueries();
    setBusy(false);
  }

  if (!clients.data) return null;
  return (
    <Paper withBorder p="md">
      <Title order={4} mb={4}>פיצול שמות לקוחות</Title>
      <Text size="sm" c="dimmed" mb="sm">
        לכל לקוח שעוד אין לו שם פרטי ושם משפחה מוצעת חלוקה: המילה האחרונה היא שם המשפחה (עם "בן", "בר" וכדומה לפניה).
        אפשר לתקן כל שורה. נשמרות רק השורות המסומנות; שורות שכדאי לבדוק לא מסומנות מראש.
      </Text>
      {!rows.length ? <Alert color="teal">לכל הלקוחות כבר יש שם פרטי ושם משפחה.</Alert> : (
        <Stack gap="xs">
          <Group justify="space-between">
            <SegmentedControl size="xs" value={show} onChange={setShow}
              data={[{ value: 'check', label: `לבדיקה (${rows.filter((r) => !r.sure).length})` }, { value: 'all', label: `הכול (${rows.length})` }]} />
            <Button onClick={save} loading={busy} disabled={!chosen.length}>שמירת {chosen.length} המסומנים</Button>
          </Group>
          <Table.ScrollContainer minWidth={640} mah={520}>
            <Table verticalSpacing={4} stickyHeader>
              <Table.Thead><Table.Tr><Table.Th w={40} /><Table.Th>השם היום</Table.Th><Table.Th>שם פרטי</Table.Th><Table.Th>שם משפחה</Table.Th><Table.Th /></Table.Tr></Table.Thead>
              <Table.Tbody>
                {visible.map((r) => (
                  <Table.Tr key={r.id}>
                    <Table.Td><Checkbox checked={r.ok} onChange={(e) => set(r.id, { ok: e.currentTarget.checked })} aria-label="לשמור" /></Table.Td>
                    <Table.Td><Text size="sm">{r.display}</Text></Table.Td>
                    <Table.Td><TextInput size="xs" value={r.first} onChange={(e) => set(r.id, { first: e.currentTarget.value, ok: true })} /></Table.Td>
                    <Table.Td><TextInput size="xs" value={r.last} onChange={(e) => set(r.id, { last: e.currentTarget.value, ok: true })} /></Table.Td>
                    <Table.Td>{!r.sure && <Badge size="xs" variant="light" color="orange">{r.why}</Badge>}</Table.Td>
                  </Table.Tr>
                ))}
              </Table.Tbody>
            </Table>
          </Table.ScrollContainer>
          {show === 'check' && <Text size="xs" c="dimmed">השורות הבטוחות מוסתרות כאן ומסומנות לשמירה. "הכול" מציג גם אותן.</Text>}
        </Stack>
      )}
    </Paper>
  );
}
