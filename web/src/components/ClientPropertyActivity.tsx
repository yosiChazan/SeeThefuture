import { Anchor, Badge, Group, Paper, Stack, Text, Title } from '@mantine/core';
import { Link } from 'react-router-dom';
import { date, propertyTitle } from '../lib/format';
import { useClientPropertyActivity } from '../lib/queries';
import { DEAL_STATUS } from './PropertyDeals';
import { PurchaseOverview } from './PurchasePayments';
import type { Property } from '../lib/types';
import { ChargesTable } from './PropertyServices';


// What happened on the client's properties outside the ledger: purchases and bills
// (SPEC decision 74). Each bill shows only for the months the client owned the property.
export function ClientPropertyActivity({ partyIds, properties }: { partyIds: string[]; properties: Property[] }) {
  const q = useClientPropertyActivity(partyIds);
  if (!q.data) return null;
  const title = new Map(properties.map((p) => [p.id, propertyTitle(p)]));
  const share = new Map(q.data.owned.filter((o) => !o.valid_to).map((o) => [o.property_id, Number(o.share_pct)]));
  return (
    <>
      {q.data.deals.length > 0 && (
        <Paper withBorder p="md">
          <Title order={4} mb="sm">רכישות</Title>
          <Stack gap="lg">
            {[...q.data.deals].sort((a, b) => (b.signed_on ?? '').localeCompare(a.signed_on ?? '')).map((d) => {
              const sh = share.get(d.property_id);
              const first = q.data.deals.filter((x) => x.property_id === d.property_id).sort((a, b) => (a.signed_on ?? '9').localeCompare(b.signed_on ?? '9'))[0].id === d.id;
              return (
                <Stack key={d.id} gap={6}>
                  <Group gap="sm">
                    <Anchor component={Link} to={`/properties/${d.property_id}`} fw={600}>{title.get(d.property_id) ?? 'נכס'}</Anchor>
                    <Badge size="sm" variant="light" color={DEAL_STATUS[d.status].color}>{DEAL_STATUS[d.status].label}</Badge>
                    {d.signed_on && <Text size="sm" c="dimmed">נרכש ב-{date(d.signed_on)}</Text>}
                    {sh !== undefined && sh < 100 && <Text size="xs" c="dimmed">החלק שלך: {sh}%</Text>}
                  </Group>
                  <PurchaseOverview price={d.total_price} currency={d.price_currency}
                    payments={first ? q.data.payments.filter((p) => p.property_id === d.property_id) : []} installments={d.installments} />
                  {d.notes && <Text size="xs" c="dimmed" style={{ whiteSpace: 'pre-wrap' }}>{d.notes}</Text>}
                </Stack>
              );
            })}
          </Stack>
        </Paper>
      )}
      <ChargesTable title="חיובים בנכסים" note="חשבונות של הנכסים, בחודשים שבהם הלקוח היה הבעלים. לא נספרים בכרטיס החשבון."
        rows={q.data.charges.map((c) => ({ ...c, propertyId: c.property_id, propertyTitle: title.get(c.property_id) ?? 'נכס' }))} />
    </>
  );
}
