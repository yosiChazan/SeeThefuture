import { Anchor, Badge, Paper, Table, Text, Title } from '@mantine/core';
import { Link } from 'react-router-dom';
import { date, money, propertyTitle } from '../lib/format';
import { useClientPropertyActivity, type DealRow } from '../lib/queries';
import type { Property } from '../lib/types';
import { ChargesTable } from './PropertyServices';

const STATUS: Record<DealRow['status'], { label: string; color: string }> = {
  lead: { label: 'ליד', color: 'gray' }, in_progress: { label: 'בתהליך', color: 'orange' },
  completed: { label: 'הושלמה', color: 'teal' }, cancelled: { label: 'בוטלה', color: 'red' },
};

// What happened on the client's properties outside the ledger: purchases and bills
// (SPEC decision 74). Each bill shows only for the months the client owned the property.
export function ClientPropertyActivity({ partyId, properties }: { partyId: string; properties: Property[] }) {
  const q = useClientPropertyActivity(partyId);
  if (!q.data) return null;
  const title = new Map(properties.map((p) => [p.id, propertyTitle(p)]));
  const share = new Map(q.data.owned.filter((o) => !o.valid_to).map((o) => [o.property_id, Number(o.share_pct)]));
  return (
    <>
      {q.data.deals.length > 0 && (
        <Paper withBorder p="md">
          <Title order={4} mb="sm">רכישות</Title>
          <Table.ScrollContainer minWidth={640}>
            <Table verticalSpacing="xs">
              <Table.Thead><Table.Tr><Table.Th>נכס</Table.Th><Table.Th>תאריך</Table.Th><Table.Th>מחיר</Table.Th><Table.Th>תשלומים</Table.Th><Table.Th>מצב</Table.Th><Table.Th>הערות</Table.Th></Table.Tr></Table.Thead>
              <Table.Tbody>
                {[...q.data.deals].sort((a, b) => (b.signed_on ?? '').localeCompare(a.signed_on ?? '')).map((d) => {
                  const paid = d.installments.reduce((a, i) => a + Number(i.amount), 0);
                  const sh = share.get(d.property_id);
                  return (
                    <Table.Tr key={d.id}>
                      <Table.Td><Anchor component={Link} to={`/properties/${d.property_id}`} size="sm">{title.get(d.property_id) ?? 'נכס'}</Anchor>
                        {sh !== undefined && sh < 100 && <Text size="xs" c="dimmed">החלק שלך: {sh}%</Text>}</Table.Td>
                      <Table.Td>{date(d.signed_on)}</Table.Td>
                      <Table.Td style={{ whiteSpace: 'nowrap' }}>{money(d.total_price, d.price_currency)}</Table.Td>
                      <Table.Td style={{ whiteSpace: 'nowrap' }}>{d.installments.length ? `${d.installments.length} · ${money(paid, d.installments[0].currency)}` : '—'}</Table.Td>
                      <Table.Td><Badge size="sm" variant="light" color={STATUS[d.status].color}>{STATUS[d.status].label}</Badge></Table.Td>
                      <Table.Td><Text size="xs" c="dimmed" lineClamp={2} style={{ whiteSpace: 'pre-wrap' }}>{d.notes}</Text></Table.Td>
                    </Table.Tr>
                  );
                })}
              </Table.Tbody>
            </Table>
          </Table.ScrollContainer>
        </Paper>
      )}
      <ChargesTable title="חיובים בנכסים" note="חשבונות של הנכסים, בחודשים שבהם הלקוח היה הבעלים. לא נספרים בכרטיס החשבון."
        rows={q.data.charges.map((c) => ({ ...c, propertyId: c.property_id, propertyTitle: title.get(c.property_id) ?? 'נכס' }))} />
    </>
  );
}
