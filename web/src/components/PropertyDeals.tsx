import { Anchor, Badge, Group, Paper, Stack, Table, Text, Title } from '@mantine/core';
import { Link } from 'react-router-dom';
import { date, money } from '../lib/format';
import { usePropertyDeals, type DealRow } from '../lib/queries';
import { QueryState } from './common';

const STATUS: Record<DealRow['status'], { label: string; color: string }> = {
  lead: { label: 'ליד', color: 'gray' }, in_progress: { label: 'בתהליך', color: 'orange' },
  completed: { label: 'הושלמה', color: 'teal' }, cancelled: { label: 'בוטלה', color: 'red' },
};

// The purchase of the property: price, date, referrer and payments (SPEC decision 70).
export function PropertyDeals({ propertyId }: { propertyId: string }) {
  const q = usePropertyDeals(propertyId);
  return (
    <Paper withBorder p="md">
      <Title order={4} mb="sm">רכישה</Title>
      <QueryState q={q}>{(deals) => deals.length ? (
        <Stack>
          {deals.map((d) => {
            const paid = d.installments.reduce((a, i) => a + Number(i.amount), 0);
            return (
              <Stack key={d.id} gap="xs">
                <Group gap="lg">
                  <Badge variant="light" color={STATUS[d.status].color}>{STATUS[d.status].label}</Badge>
                  <Text size="sm">מחיר: <b>{money(d.total_price, d.price_currency)}</b></Text>
                  <Text size="sm">תאריך: {date(d.signed_on)}</Text>
                  {d.client && <Text size="sm">לקוח: <Anchor component={Link} to={`/clients/${d.client.id}`} size="sm">{d.client.display_name}</Anchor></Text>}
                  {d.referrer && <Text size="sm">הגיע דרך: {d.referrer.display_name}</Text>}
                </Group>
                {d.installments.length > 0 && (
                  <Table verticalSpacing={4} maw={560}>
                    <Table.Thead><Table.Tr><Table.Th>תשלום</Table.Th><Table.Th>תאריך</Table.Th><Table.Th>סכום</Table.Th></Table.Tr></Table.Thead>
                    <Table.Tbody>
                      {[...d.installments].sort((a, b) => (a.notes ?? '').localeCompare(b.notes ?? '')).map((i) => (
                        <Table.Tr key={i.id}><Table.Td>{i.notes}</Table.Td><Table.Td>{date(i.due_date)}</Table.Td><Table.Td>{money(i.amount, i.currency)}</Table.Td></Table.Tr>
                      ))}
                      <Table.Tr><Table.Td fw={600}>סה"כ</Table.Td><Table.Td /><Table.Td fw={600}>{money(paid, d.installments[0].currency)}</Table.Td></Table.Tr>
                    </Table.Tbody>
                  </Table>
                )}
                {d.notes && <Text size="sm" c="dimmed" style={{ whiteSpace: 'pre-wrap' }}>{d.notes}</Text>}
              </Stack>
            );
          })}
        </Stack>
      ) : <Text c="dimmed" size="sm">אין פרטי רכישה</Text>}</QueryState>
    </Paper>
  );
}
