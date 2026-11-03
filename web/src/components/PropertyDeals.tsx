import { Anchor, Badge, Group, Paper, Stack, Text, Title } from '@mantine/core';
import { Link } from 'react-router-dom';
import { date } from '../lib/format';
import { usePropertyDeals, usePurchasePayments, type DealRow } from '../lib/queries';
import { QueryState } from './common';
import { PurchaseOverview } from './PurchasePayments';

export const DEAL_STATUS: Record<DealRow['status'], { label: string; color: string }> = {
  lead: { label: 'ליד', color: 'gray' }, in_progress: { label: 'בתהליך', color: 'orange' },
  completed: { label: 'הושלמה', color: 'teal' }, cancelled: { label: 'בוטלה', color: 'red' },
};

// The purchase of the property: price, paid, remaining and every payment (SPEC decisions 70, 83, 84).
export function PropertyDeals({ propertyId }: { propertyId: string }) {
  const q = usePropertyDeals(propertyId);
  const pays = usePurchasePayments(propertyId);
  return (
    <Paper withBorder p="md">
      <Title order={4} mb="sm">רכישה</Title>
      <QueryState q={q}>{(deals) => {
        const payments = pays.data ?? [];
        if (!deals.length && !payments.length) return <Text c="dimmed" size="sm">אין פרטי רכישה</Text>;
        if (!deals.length) return <PurchaseOverview price={null} currency={null} payments={payments} installments={[]} />;
        return (
          <Stack>
            {deals.map((d, n) => (
              <Stack key={d.id} gap="xs">
                <Group gap="lg">
                  <Badge variant="light" color={DEAL_STATUS[d.status].color}>{DEAL_STATUS[d.status].label}</Badge>
                  <Text size="sm">תאריך: {date(d.signed_on)}</Text>
                  {d.client && <Text size="sm">לקוח: <Anchor component={Link} to={`/clients/${d.client.id}`} size="sm">{d.client.display_name}</Anchor></Text>}
                  {d.referrer && <Text size="sm">הגיע דרך: {d.referrer.display_name}</Text>}
                </Group>
                {/* The payments belong to the property; they show under its first deal. */}
                <PurchaseOverview price={d.total_price} currency={d.price_currency} payments={n === 0 ? payments : []} installments={d.installments} />
                {d.notes && <Text size="sm" c="dimmed" style={{ whiteSpace: 'pre-wrap' }}>{d.notes}</Text>}
              </Stack>
            ))}
          </Stack>
        );
      }}</QueryState>
    </Paper>
  );
}
