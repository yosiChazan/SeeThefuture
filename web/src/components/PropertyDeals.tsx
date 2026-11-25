import { Anchor, Badge, Button, Group, Paper, Stack, Text, Title } from '@mantine/core';
import { IconPencil } from '@tabler/icons-react';
import { useState } from 'react';
import { Link } from 'react-router-dom';
import { date } from '../lib/format';
import { usePropertyDeals, usePurchasePayments, type DealRow } from '../lib/queries';
import { QueryState } from './common';
import { PurchaseOverview } from './PurchasePayments';
import { PurchaseEdit } from './PurchaseEdit';
import type { Country } from '../lib/types';

export const DEAL_STATUS: Record<DealRow['status'], { label: string; color: string }> = {
  lead: { label: 'ליד', color: 'gray' }, in_progress: { label: 'בתהליך', color: 'orange' },
  completed: { label: 'הושלמה', color: 'teal' }, cancelled: { label: 'בוטלה', color: 'red' },
};

// The purchase of the property: price, paid, remaining and every payment (SPEC decisions 70, 83, 84).
export function PropertyDeals({ propertyId, country, ownerId, canEdit = false }: { propertyId: string; country?: Country; ownerId?: string | null; canEdit?: boolean }) {
  const q = usePropertyDeals(propertyId);
  const pays = usePurchasePayments(propertyId);
  const [editing, setEditing] = useState(false);
  return (
    <Paper withBorder p="md">
      <Group justify="space-between" mb="sm">
        <Title order={4}>רכישה</Title>
        {canEdit && country && q.data && <Button size="xs" variant="light" leftSection={<IconPencil size={14} />} onClick={() => setEditing(true)}>{q.data.length || (pays.data ?? []).length ? 'עריכת הרכישה' : 'הוספת פרטי רכישה'}</Button>}
      </Group>
      {editing && country && q.data && (
        <PurchaseEdit propertyId={propertyId} country={country} deals={q.data} payments={pays.data ?? []} ownerId={ownerId ?? null} onClose={() => setEditing(false)} />
      )}
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
