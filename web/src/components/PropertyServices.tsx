import { Badge, Group, Paper, SegmentedControl, Select, SimpleGrid, Stack, Table, Text, Title } from '@mantine/core';
import { useMemo, useState } from 'react';
import { date, money } from '../lib/format';
import { usePropertyCharges, usePropertyServices } from '../lib/queries';
import { QueryState } from './common';

export const SERVICE_HE: Record<string, string> = {
  electricity: 'חשמל', gas: 'גז', water: 'מים', internet: 'אינטרנט', building_assoc: 'ועד בית', rent: 'שכירות', other: 'אחר',
};
const STATUS_COLOR: Record<string, string> = { OK: 'teal', 'NOT OK': 'red', 'IN WORK': 'orange' };
const CHARGE_STATUS_HE: Record<string, string> = { due: 'לתשלום', paid: 'שולם', partial: 'שולם חלקית', waived: 'בוטל' };

// Electricity, gas, internet and the building committee of a property (SPEC decision 71).
export function PropertyServices({ propertyId }: { propertyId: string }) {
  const q = usePropertyServices(propertyId);
  return (
    <Paper withBorder p="md">
      <Title order={4} mb="sm">שירותים</Title>
      <QueryState q={q}>{(rows) => rows.length ? (
        <SimpleGrid cols={{ base: 1, sm: 2 }}>
          {[...rows].sort((a, b) => a.kind.localeCompare(b.kind)).map((s) => (
            <Stack key={s.id} gap={2} p="xs" style={{ border: '1px solid var(--mantine-color-default-border)', borderRadius: 8 }}>
              <Group justify="space-between">
                <Text fw={600} size="sm">{SERVICE_HE[s.kind] ?? s.kind}</Text>
                {s.status && <Badge size="sm" variant="light" color={STATUS_COLOR[s.status] ?? 'gray'}>{s.status}</Badge>}
              </Group>
              {s.provider && <Text size="sm" style={{ whiteSpace: 'pre-wrap' }}>{s.kind === 'building_assoc' ? 'מנהל הבניין: ' : 'ספק: '}{s.provider}</Text>}
              {s.client_code && <Text size="sm">קוד לקוח: <span dir="ltr">{s.client_code}</span></Text>}
              {s.deadline && <Text size="sm">סיום חוזה: {date(s.deadline)}</Text>}
              {s.notes && <Text size="xs" c="dimmed" style={{ whiteSpace: 'pre-wrap' }}>{s.notes}</Text>}
            </Stack>
          ))}
        </SimpleGrid>
      ) : <Text c="dimmed" size="sm">אין פרטי שירותים</Text>}</QueryState>
    </Paper>
  );
}

// The property's charges (bills), newest first, by kind and year (SPEC decision 71).
export function PropertyCharges({ propertyId }: { propertyId: string }) {
  const q = usePropertyCharges(propertyId);
  const [kind, setKind] = useState('all');
  const [year, setYear] = useState<string | null>(null);
  const data = q.data ?? [];
  const kinds = useMemo(() => [...new Set(data.map((c) => c.kind))], [data]);
  const years = useMemo(() => [...new Set(data.map((c) => c.period.slice(0, 4)))].sort().reverse(), [data]);
  const rows = data.filter((c) => (kind === 'all' || c.kind === kind) && (!year || c.period.startsWith(year)));
  if (q.data && !data.length) return null;
  return (
    <Paper withBorder p="md">
      <Group justify="space-between" mb="sm">
        <Title order={4}>חיובים</Title>
        <Text size="xs" c="dimmed">היסטוריית חשבונות. לא נספרת בכרטיס החשבון.</Text>
      </Group>
      <QueryState q={q}>{() => (
        <Stack gap="xs">
          <Group>
            <SegmentedControl size="xs" value={kind} onChange={setKind} data={[{ value: 'all', label: `הכול (${data.length})` }, ...kinds.map((k) => ({ value: k, label: SERVICE_HE[k] ?? k }))]} />
            <Select size="xs" placeholder="כל השנים" data={years} value={year} onChange={setYear} clearable w={120} />
          </Group>
          <Table.ScrollContainer minWidth={560} mah={420}>
            <Table verticalSpacing={4} stickyHeader>
              <Table.Thead><Table.Tr><Table.Th>חודש</Table.Th><Table.Th>סוג</Table.Th><Table.Th>סכום</Table.Th><Table.Th>שילם</Table.Th><Table.Th>מצב</Table.Th><Table.Th>הערות</Table.Th></Table.Tr></Table.Thead>
              <Table.Tbody>
                {rows.map((c) => (
                  <Table.Tr key={c.id}>
                    <Table.Td style={{ whiteSpace: 'nowrap' }}>{c.period.slice(5, 7)}.{c.period.slice(0, 4)}</Table.Td>
                    <Table.Td>{SERVICE_HE[c.kind] ?? c.kind}</Table.Td>
                    <Table.Td style={{ whiteSpace: 'nowrap' }}>{money(c.amount, c.currency)}</Table.Td>
                    <Table.Td>{c.payer === 'owner' ? 'בעלים' : 'שוכר'}</Table.Td>
                    <Table.Td>{CHARGE_STATUS_HE[c.status] ?? c.status}</Table.Td>
                    <Table.Td><Text size="xs" c="dimmed" lineClamp={2} style={{ whiteSpace: 'pre-wrap' }}>{c.notes}</Text></Table.Td>
                  </Table.Tr>
                ))}
              </Table.Tbody>
            </Table>
          </Table.ScrollContainer>
        </Stack>
      )}</QueryState>
    </Paper>
  );
}
