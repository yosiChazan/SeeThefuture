import { Anchor, Badge, Button, Collapse, Group, Stack, Table, Text } from '@mantine/core';
import { useState } from 'react';
import { Link } from 'react-router-dom';
import { date, money } from '../lib/format';
import { KIND_HE, purchaseSummary, type Planned } from '../lib/purchase';
import type { PurchasePaymentRow } from '../lib/queries';
import type { Currency } from '../lib/types';

function Who({ party, name }: { party: PurchasePaymentRow['payer']; name: string | null }) {
  if (party) return <Anchor component={Link} to={`/clients/${party.id}`} size="sm">{party.display_name}</Anchor>;
  return <>{name ?? ''}</>;
}

const byCurrency = (m: Partial<Record<Currency, number>>) => Object.entries(m).map(([c, n]) => money(n, c as Currency)).join(' + ');

// A purchase at a glance: price, paid, remaining, then every movement with its date
// (SPEC decisions 83, 84). Nothing is converted between currencies.
export function PurchaseOverview({ price, currency, payments, installments }: {
  price: number | null; currency: Currency | null; payments: PurchasePaymentRow[];
  installments: (Planned & { id: string; due_date: string | null; notes: string | null })[];
}) {
  const [open, setOpen] = useState(false);
  const s = purchaseSummary(price, currency, payments, installments);
  const cur = currency ?? 'USD';
  const planned = installments.filter((i) => !i.paid_txn_id);
  const hasParties = payments.some((p) => p.payer_name || p.payee_name);
  const unvalued = byCurrency(s.unvalued), costs = byCurrency(s.costs);
  return (
    <Stack gap={6}>
      <Group gap="xs">
        <Badge variant="light" color="gray" size="lg">מחיר: {money(price, cur)}</Badge>
        {s.paid !== null && <Badge variant="light" color="teal" size="lg">שולם: {money(s.paid, cur)}{unvalued && ` + ${unvalued}`}</Badge>}
        {s.paid === null && unvalued && <Badge variant="light" color="teal" size="lg">שולם: {unvalued}</Badge>}
        {s.remaining !== null && <Badge variant="light" color={s.remaining > 0 ? 'orange' : 'teal'} size="lg">נשאר: {money(s.remaining, cur)}</Badge>}
      </Group>
      {unvalued && <Text size="xs" c="dimmed">חלק מהתשלומים בגריבנה בלי שווי בדולר במקור, ולכן לא נספרו ב"נשאר".</Text>}
      {costs && <Text size="sm" c="dimmed">עמלות והוצאות נוספות: {costs}</Text>}
      {planned.length > 0 && (
        <Table verticalSpacing={2} maw={560} fz="sm">
          <Table.Thead><Table.Tr><Table.Th>עוד לא שולם</Table.Th><Table.Th>מועד</Table.Th><Table.Th>סכום</Table.Th></Table.Tr></Table.Thead>
          <Table.Tbody>{planned.map((i) => (
            <Table.Tr key={i.id}><Table.Td>{(i.notes ?? '').replace(' (קייב)', '')}</Table.Td><Table.Td>{date(i.due_date)}</Table.Td><Table.Td>{money(i.amount, i.currency)}</Table.Td></Table.Tr>
          ))}</Table.Tbody>
        </Table>
      )}
      {payments.length > 0 && (
        <>
          <Group gap="xs">
            <Text size="sm" fw={600}>תנועות ברכישה ({payments.length})</Text>
            <Button size="compact-xs" variant="subtle" onClick={() => setOpen((o) => !o)}>{open ? 'הסתר' : 'הצג'}</Button>
          </Group>
          <Collapse in={open}>
            <Table.ScrollContainer minWidth={hasParties ? 800 : 620}>
              <Table verticalSpacing={4} striped fz="sm">
                <Table.Thead><Table.Tr>
                  <Table.Th>תאריך</Table.Th><Table.Th>סוג</Table.Th><Table.Th>סכום</Table.Th><Table.Th>בדולר לפי המקור</Table.Th>
                  {hasParties && <><Table.Th>משלם</Table.Th><Table.Th>מקבל</Table.Th></>}<Table.Th>פירוט</Table.Th>
                </Table.Tr></Table.Thead>
                <Table.Tbody>
                  {payments.map((r) => (
                    <Table.Tr key={r.id} c={r.kind === 'payment' ? undefined : 'dimmed'}>
                      <Table.Td style={{ whiteSpace: 'nowrap' }}>{date(r.paid_on)}</Table.Td>
                      <Table.Td>{KIND_HE[r.kind]}</Table.Td>
                      <Table.Td style={{ whiteSpace: 'nowrap' }}>{money(r.amount, r.currency)}</Table.Td>
                      <Table.Td style={{ whiteSpace: 'nowrap' }}>{r.amount_usd !== null ? money(r.amount_usd, 'USD') : ''}</Table.Td>
                      {hasParties && <><Table.Td><Who party={r.payer} name={r.payer_name} /></Table.Td><Table.Td><Who party={r.payee} name={r.payee_name} /></Table.Td></>}
                      <Table.Td style={{ whiteSpace: 'pre-wrap' }}>{r.notes}</Table.Td>
                    </Table.Tr>
                  ))}
                </Table.Tbody>
              </Table>
            </Table.ScrollContainer>
          </Collapse>
        </>
      )}
    </Stack>
  );
}
