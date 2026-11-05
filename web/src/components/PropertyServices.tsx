import { ActionIcon, Anchor, Badge, Group, Paper, SegmentedControl, Select, SimpleGrid, Stack, Table, Text, Title } from '@mantine/core';
import { notifications } from '@mantine/notifications';
import { IconReceipt } from '@tabler/icons-react';
import { Link } from 'react-router-dom';
import { supabase } from '../lib/supabase';
import { useMemo, useState } from 'react';
import { date, money } from '../lib/format';
import { usePropertyCharges, usePropertyServices, type ChargeRow } from '../lib/queries';
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

export interface ChargeWithProperty extends ChargeRow { propertyTitle?: string; propertyId?: string }

// Charges (bills), newest first, filtered by kind, year and, for a client, property
// (SPEC decisions 71, 74). History only: not counted in the account ledger.
// The proof of a payment (Greece, decision 94): opened like any document, the opening logged.
async function openProof(id: string) {
  const doc = await supabase.from('documents').select('storage_path').eq('id', id).maybeSingle();
  if (doc.error || !doc.data) { notifications.show({ color: 'red', message: doc.error?.message ?? 'אין הרשאה למסמך' }); return; }
  const log = await supabase.rpc('log_document_access', { doc: id });
  if (log.error) { notifications.show({ color: 'red', message: log.error.message }); return; }
  const { data, error } = await supabase.storage.from('documents').createSignedUrl(doc.data.storage_path, 60);
  if (error) notifications.show({ color: 'red', message: error.message }); else window.open(data.signedUrl, '_blank');
}

export function ChargesTable({ rows: data, title = 'חיובים', note }: { rows: ChargeWithProperty[]; title?: string; note?: string }) {
  const [kind, setKind] = useState('all');
  const [year, setYear] = useState<string | null>(null);
  const [prop, setProp] = useState<string | null>(null);
  const kinds = useMemo(() => [...new Set(data.map((c) => c.kind))], [data]);
  const years = useMemo(() => [...new Set(data.map((c) => c.period.slice(0, 4)))].sort().reverse(), [data]);
  const props = useMemo(() => [...new Map(data.filter((c) => c.propertyId).map((c) => [c.propertyId!, c.propertyTitle ?? ''])).entries()], [data]);
  const rows = data.filter((c) => (kind === 'all' || c.kind === kind) && (!year || c.period.startsWith(year)) && (!prop || c.propertyId === prop));
  const showProperty = props.length > 0;
  if (!data.length) return null;
  return (
    <Paper withBorder p="md">
      <Group justify="space-between" mb="sm">
        <Title order={4}>{title}</Title>
        <Text size="xs" c="dimmed">{note ?? 'היסטוריית חשבונות. לא נספרת בכרטיס החשבון.'}</Text>
      </Group>
      <Stack gap="xs">
        <Group>
          <SegmentedControl size="xs" value={kind} onChange={setKind} data={[{ value: 'all', label: `הכול (${data.length})` }, ...kinds.map((k) => ({ value: k, label: SERVICE_HE[k] ?? k }))]} />
          <Select size="xs" placeholder="כל השנים" data={years} value={year} onChange={setYear} clearable w={120} />
          {props.length > 1 && <Select size="xs" placeholder="כל הנכסים" data={props.map(([value, label]) => ({ value, label }))} value={prop} onChange={setProp} clearable w={240} />}
        </Group>
        <Table.ScrollContainer minWidth={showProperty ? 720 : 560} mah={420}>
          <Table verticalSpacing={4} stickyHeader>
            <Table.Thead><Table.Tr><Table.Th>חודש</Table.Th>{showProperty && <Table.Th>נכס</Table.Th>}<Table.Th>סוג</Table.Th><Table.Th>סכום</Table.Th><Table.Th>שילם</Table.Th><Table.Th>מצב</Table.Th><Table.Th>הערות</Table.Th></Table.Tr></Table.Thead>
            <Table.Tbody>
              {rows.map((c) => (
                <Table.Tr key={c.id}>
                  <Table.Td style={{ whiteSpace: 'nowrap' }}>{c.period.slice(5, 7)}.{c.period.slice(0, 4)}</Table.Td>
                  {showProperty && <Table.Td><Anchor component={Link} to={`/properties/${c.propertyId}`} size="xs">{c.propertyTitle}</Anchor></Table.Td>}
                  <Table.Td>{SERVICE_HE[c.kind] ?? c.kind}</Table.Td>
                  <Table.Td style={{ whiteSpace: 'nowrap' }}>{money(c.amount, c.currency)}</Table.Td>
                  <Table.Td>{c.payer === 'owner' ? 'בעלים' : 'שוכר'}</Table.Td>
                  <Table.Td>{CHARGE_STATUS_HE[c.status] ?? c.status}</Table.Td>
                  <Table.Td><Group gap={4} wrap="nowrap" align="flex-start">
                    {c.document_id && <ActionIcon size="sm" variant="subtle" title="הוכחת תשלום" onClick={() => openProof(c.document_id!)}><IconReceipt size={14} /></ActionIcon>}
                    <Text size="xs" c="dimmed" lineClamp={2} style={{ whiteSpace: 'pre-wrap' }}>{c.notes}</Text>
                  </Group></Table.Td>
                </Table.Tr>
              ))}
            </Table.Tbody>
          </Table>
        </Table.ScrollContainer>
      </Stack>
    </Paper>
  );
}

export function PropertyCharges({ propertyId }: { propertyId: string }) {
  const q = usePropertyCharges(propertyId);
  return q.data ? <ChargesTable rows={q.data} /> : null;
}
