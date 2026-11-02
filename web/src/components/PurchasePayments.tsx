import { Anchor, Badge, Button, Collapse, Group, Stack, Table, Text } from '@mantine/core';
import { useState } from 'react';
import { Link } from 'react-router-dom';
import { date, money } from '../lib/format';
import type { Currency } from '../lib/types';
import { usePurchasePayments, type PurchasePaymentRow } from '../lib/queries';
import { QueryState } from './common';

const KIND: Record<PurchasePaymentRow['kind'], string> = { expense: 'הוצאה', income: 'הכנסה', loan: 'הלוואה', transfer: 'העברה' };

function Who({ party, name }: { party: PurchasePaymentRow['payer']; name: string | null }) {
  if (party) return <Anchor component={Link} to={`/clients/${party.id}`} size="sm">{party.display_name}</Anchor>;
  return <>{name ?? '—'}</>;
}

// Payments around the purchase, from Airtable (SPEC decision 83). Totals per currency: never converted.
export function PurchasePayments({ propertyId }: { propertyId: string }) {
  const q = usePurchasePayments(propertyId);
  const [open, setOpen] = useState(false);
  return (
    <QueryState q={q}>{(rows) => {
      if (!rows.length) return null;
      const totals = new Map<Currency, number>();
      for (const r of rows) if (r.amount !== null && r.currency && r.kind === 'expense') totals.set(r.currency, (totals.get(r.currency) ?? 0) + Number(r.amount));
      return (
        <Stack gap="xs">
          <Group gap="sm">
            <Text fw={600} size="sm">תשלומים סביב הרכישה ({rows.length})</Text>
            {[...totals].map(([c, t]) => <Badge key={c} variant="light">{money(t, c)}</Badge>)}
            <Button size="compact-xs" variant="subtle" onClick={() => setOpen((o) => !o)}>{open ? 'הסתר' : 'הצג'}</Button>
          </Group>
          <Collapse in={open}>
            <Table.ScrollContainer minWidth={700}>
              <Table verticalSpacing={4} striped>
                <Table.Thead><Table.Tr>
                  <Table.Th>תאריך</Table.Th><Table.Th>סוג</Table.Th><Table.Th>סכום</Table.Th><Table.Th>משלם</Table.Th><Table.Th>מקבל</Table.Th><Table.Th>הערות</Table.Th>
                </Table.Tr></Table.Thead>
                <Table.Tbody>
                  {rows.map((r) => (
                    <Table.Tr key={r.id}>
                      <Table.Td>{date(r.paid_on)}</Table.Td>
                      <Table.Td>{KIND[r.kind]}</Table.Td>
                      <Table.Td style={{ whiteSpace: 'nowrap' }}>{money(r.amount, r.currency)}</Table.Td>
                      <Table.Td><Who party={r.payer} name={r.payer_name} /></Table.Td>
                      <Table.Td><Who party={r.payee} name={r.payee_name} /></Table.Td>
                      <Table.Td style={{ whiteSpace: 'pre-wrap' }}>{r.notes}</Table.Td>
                    </Table.Tr>
                  ))}
                </Table.Tbody>
              </Table>
            </Table.ScrollContainer>
            <Text size="xs" c="dimmed">הסכומים בבאדג'ים הם סך ההוצאות בכל מטבע, בלי המרה.</Text>
          </Collapse>
        </Stack>
      );
    }}</QueryState>
  );
}
