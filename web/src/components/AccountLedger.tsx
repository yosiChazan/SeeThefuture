import { Group, Paper, SegmentedControl, Stack, Table, Text } from '@mantine/core';
import { useState } from 'react';
import { ACCOUNT_KIND_HE, CATEGORY_HE, amountLabel, date, money } from '../lib/format';
import type { EntryRow } from '../lib/queries';
import type { Account, Currency } from '../lib/types';

const FROM = '2026-01-01';

// One card per account: entries with a running total. From 2026 by default, with
// everything before 1.1.2026 summed into one opening line; or the whole history.
export function AccountLedger({ accounts, entries }: { accounts: Account[]; entries: EntryRow[] }) {
  const [range, setRange] = useState<'2026' | 'all'>('2026');
  const shown = accounts.filter((a) => entries.some((e) => e.account_id === a.id));
  return (
    <Stack>
      <SegmentedControl value={range} onChange={(v) => setRange(v as '2026' | 'all')} w="fit-content"
        data={[{ value: '2026', label: 'מתחילת 2026' }, { value: 'all', label: 'כל התנועות' }]} />
      {!shown.length && <Text c="dimmed" size="sm">עוד אין תנועות. הן ייכנסו עם קליטת הדוחות מהמנהלים המקומיים.</Text>}
      {shown.map((a) => {
        const mine = entries.filter((e) => e.account_id === a.id);
        const before = range === '2026' ? mine.filter((e) => e.transaction.occurred_on < FROM) : [];
        const rows = range === '2026' ? mine.filter((e) => e.transaction.occurred_on >= FROM) : mine;
        let running = before.reduce((s, e) => s + Number(e.amount), 0);
        const label = amountLabel(a.kind);
        return (
          <Paper key={a.id} withBorder p="sm">
            <Group justify="space-between" mb="xs">
              <Text fw={600} size="sm">{ACCOUNT_KIND_HE[a.kind] ?? a.kind} · {a.holder.display_name} · {a.currency}</Text>
              <Text size="sm">{label}: <b>{money(mine.reduce((s, e) => s + Number(e.amount), 0), a.currency)}</b></Text>
            </Group>
            <Table.ScrollContainer minWidth={600}>
              <Table verticalSpacing={4} striped>
                <Table.Thead>
                  <Table.Tr><Table.Th w={100}>תאריך</Table.Th><Table.Th w={110}>סוג</Table.Th><Table.Th>תיאור</Table.Th><Table.Th w={120}>סכום</Table.Th><Table.Th w={130}>{label} מצטבר</Table.Th></Table.Tr>
                </Table.Thead>
                <Table.Tbody>
                  {range === '2026' && (
                    <Table.Tr fw={600}>
                      <Table.Td>01.01.2026</Table.Td>
                      <Table.Td colSpan={2}>{a.kind === 'client_bank' ? 'הופקד עד 1.1.2026' : 'יתרת פתיחה ב-1.1.2026'} ({before.length} תנועות קודמות)</Table.Td>
                      <Table.Td />
                      <Table.Td style={{ whiteSpace: 'nowrap' }}>{money(running, a.currency)}</Table.Td>
                    </Table.Tr>
                  )}
                  {rows.map((e) => {
                    running += Number(e.amount);
                    return (
                      <Table.Tr key={e.id}>
                        <Table.Td>{date(e.transaction.occurred_on)}</Table.Td>
                        <Table.Td>{CATEGORY_HE[e.transaction.category] ?? e.transaction.category}</Table.Td>
                        <Table.Td><Text size="sm" lineClamp={2}>{e.memo ?? e.transaction.description}</Text></Table.Td>
                        <Table.Td style={{ whiteSpace: 'nowrap' }} c={Number(e.amount) < 0 ? 'red.7' : undefined}>{money(Number(e.amount), e.currency as Currency)}</Table.Td>
                        <Table.Td style={{ whiteSpace: 'nowrap' }}>{money(running, a.currency)}</Table.Td>
                      </Table.Tr>
                    );
                  })}
                </Table.Tbody>
              </Table>
            </Table.ScrollContainer>
          </Paper>
        );
      })}
    </Stack>
  );
}
