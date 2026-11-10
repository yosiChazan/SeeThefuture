import { Button, Group, Paper, SegmentedControl, Select, Stack, Table, Text } from '@mantine/core';
import { useState } from 'react';
import { ACCOUNT_KIND_HE, CATEGORY_HE, amountLabel, date, money } from '../lib/format';
import type { EntryRow } from '../lib/queries';
import { SourceBadge } from './SourceBadge';
import type { Account, Currency } from '../lib/types';

const FROM = '2026-01-01';

// One card per account: entries with a running total. From 2026 by default, with
// everything before 1.1.2026 summed into one opening line; or the whole history.
// On a property card only that property's entries are given, so the total is the
// property's share of the account, and the account's owner is named.
// Shown by date by default (SPEC decision 122): one list, newest first, with the account and the
// currency of each entry, and no running total (it would mix accounts and currencies); or one
// card per account as above.
// `edit`: an edit button on a row the user may edit (SPEC decision 119: a movement entered by
// hand, by its author or an admin).
export function AccountLedger({ accounts, entries, property = false, edit }: {
  accounts: Account[]; entries: EntryRow[]; property?: boolean; edit?: { can: (e: EntryRow) => boolean; open: (transactionId: string) => void };
}) {
  const [range, setRange] = useState<'2026' | 'all'>('2026');
  const [view, setView] = useState<'date' | 'account'>('date');
  const shown = accounts.filter((a) => entries.some((e) => e.account_id === a.id));
  return (
    <Stack>
      <Group gap="sm">
        <SegmentedControl value={view} onChange={(v) => setView(v as 'date' | 'account')} w="fit-content"
          data={[{ value: 'date', label: 'לפי תאריך' }, { value: 'account', label: 'לפי קופה' }]} />
        <SegmentedControl value={range} onChange={(v) => setRange(v as '2026' | 'all')} w="fit-content"
          data={[{ value: '2026', label: 'מתחילת 2026' }, { value: 'all', label: 'כל התנועות' }]} />
      </Group>
      {!shown.length && <Text c="dimmed" size="sm">עוד אין תנועות. הן ייכנסו עם קליטת הדוחות מהמנהלים המקומיים.</Text>}
      {view === 'date' && !!shown.length && <ByDate accounts={shown} entries={entries} from={range === '2026' ? FROM : null} property={property} edit={edit} />}
      {view === 'account' && shown.map((a) => {
        const mine = entries.filter((e) => e.account_id === a.id);
        const before = range === '2026' ? mine.filter((e) => e.transaction.occurred_on < FROM) : [];
        const rows = range === '2026' ? mine.filter((e) => e.transaction.occurred_on >= FROM) : mine;
        let running = before.reduce((s, e) => s + Number(e.amount), 0);
        const label = property ? 'מהנכס' : amountLabel(a.kind);
        return (
          <Paper key={a.id} withBorder p="sm">
            <Group justify="space-between" mb="xs">
              <Text fw={600} size="sm">{ACCOUNT_KIND_HE[a.kind] ?? a.kind} · {a.holder.display_name} · {a.currency}{property ? ` · של ${a.beneficiary.display_name}` : ''}</Text>
              <Text size="sm">{label}: <b>{money(mine.reduce((s, e) => s + Number(e.amount), 0), a.currency)}</b></Text>
            </Group>
            <Table.ScrollContainer minWidth={600}>
              <Table verticalSpacing={4} striped>
                <Table.Thead>
                  <Table.Tr><Table.Th w={100}>תאריך</Table.Th><Table.Th w={110}>סוג</Table.Th><Table.Th>תיאור</Table.Th><Table.Th w={70}>מקור</Table.Th><Table.Th w={120}>סכום</Table.Th><Table.Th w={130}>{label} מצטבר</Table.Th>{edit && <Table.Th w={60} />}</Table.Tr>
                </Table.Thead>
                <Table.Tbody>
                  {range === '2026' && (
                    <Table.Tr fw={600}>
                      <Table.Td>01.01.2026</Table.Td>
                      <Table.Td colSpan={3}>{property ? 'עד 1.1.2026' : a.kind === 'client_bank' ? 'הופקד עד 1.1.2026' : 'יתרת פתיחה ב-1.1.2026'} ({before.length} תנועות קודמות)</Table.Td>
                      <Table.Td />
                      <Table.Td style={{ whiteSpace: 'nowrap' }}>{money(running, a.currency)}</Table.Td>
                      {edit && <Table.Td />}
                    </Table.Tr>
                  )}
                  {rows.map((e) => {
                    running += Number(e.amount);
                    return (
                      <Table.Tr key={e.id}>
                        <Table.Td>{date(e.transaction.occurred_on)}</Table.Td>
                        <Table.Td>{CATEGORY_HE[e.transaction.category] ?? e.transaction.category}</Table.Td>
                        <Table.Td><Text size="sm" lineClamp={2}>{e.memo ?? e.transaction.description}</Text></Table.Td>
                        <Table.Td><SourceBadge source={e.transaction.source} importBatchId={e.transaction.import_batch_id} country={e.transaction.country_code} /></Table.Td>
                        <Table.Td style={{ whiteSpace: 'nowrap' }} c={Number(e.amount) < 0 ? 'red.7' : undefined}>{money(Number(e.amount), e.currency as Currency)}</Table.Td>
                        <Table.Td style={{ whiteSpace: 'nowrap' }}>{money(running, a.currency)}</Table.Td>
                        {edit && <Table.Td>{edit.can(e) && <Button size="compact-xs" variant="subtle" onClick={() => edit.open(e.transaction.id)}>עריכה</Button>}</Table.Td>}
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

const accountName = (a: Account, property: boolean) =>
  `${ACCOUNT_KIND_HE[a.kind] ?? a.kind} · ${a.holder.display_name}${property ? ` · של ${a.beneficiary.display_name}` : ''}`;

function ByDate({ accounts, entries, from, property, edit }: {
  accounts: Account[]; entries: EntryRow[]; from: string | null; property: boolean; edit?: { can: (e: EntryRow) => boolean; open: (transactionId: string) => void };
}) {
  const [account, setAccount] = useState<string | null>(null);
  const [currency, setCurrency] = useState<string | null>(null);
  const byId = new Map(accounts.map((a) => [a.id, a]));
  const rows = entries
    .filter((e) => byId.has(e.account_id ?? '') && (!from || e.transaction.occurred_on >= from))
    .filter((e) => (!account || e.account_id === account) && (!currency || e.currency === currency))
    .sort((x, y) => y.transaction.occurred_on.localeCompare(x.transaction.occurred_on));
  const currencies = [...new Set(accounts.map((a) => a.currency))].sort();
  return (
    <Paper withBorder p="sm">
      <Group gap="sm" mb="xs">
        <Select size="xs" placeholder="כל הקופות" clearable value={account} onChange={setAccount} w={280}
          data={accounts.map((a) => ({ value: a.id, label: `${accountName(a, property)} · ${a.currency}` }))} />
        {currencies.length > 1 && <Select size="xs" placeholder="כל המטבעות" clearable value={currency} onChange={setCurrency} w={130} data={currencies} />}
        <Text size="xs" c="dimmed">{rows.length} תנועות</Text>
      </Group>
      <Table.ScrollContainer minWidth={700}>
        <Table verticalSpacing={4} striped>
          <Table.Thead>
            <Table.Tr><Table.Th w={100}>תאריך</Table.Th><Table.Th w={110}>סוג</Table.Th><Table.Th>תיאור</Table.Th><Table.Th w={200}>קופה</Table.Th><Table.Th w={70}>מקור</Table.Th><Table.Th w={70}>מטבע</Table.Th><Table.Th w={120}>סכום</Table.Th>{edit && <Table.Th w={60} />}</Table.Tr>
          </Table.Thead>
          <Table.Tbody>
            {rows.map((e) => {
              const a = byId.get(e.account_id ?? '')!;
              return (
                <Table.Tr key={e.id}>
                  <Table.Td>{date(e.transaction.occurred_on)}</Table.Td>
                  <Table.Td>{CATEGORY_HE[e.transaction.category] ?? e.transaction.category}</Table.Td>
                  <Table.Td><Text size="sm" lineClamp={2}>{e.memo ?? e.transaction.description}</Text></Table.Td>
                  <Table.Td><Text size="xs">{accountName(a, property)}</Text></Table.Td>
                  <Table.Td><SourceBadge source={e.transaction.source} importBatchId={e.transaction.import_batch_id} country={e.transaction.country_code} /></Table.Td>
                  <Table.Td>{e.currency}</Table.Td>
                  <Table.Td style={{ whiteSpace: 'nowrap' }} c={Number(e.amount) < 0 ? 'red.7' : undefined}>{money(Number(e.amount), e.currency as Currency)}</Table.Td>
                  {edit && <Table.Td>{edit.can(e) && <Button size="compact-xs" variant="subtle" onClick={() => edit.open(e.transaction.id)}>עריכה</Button>}</Table.Td>}
                </Table.Tr>
              );
            })}
          </Table.Tbody>
        </Table>
      </Table.ScrollContainer>
      {!rows.length && <Text c="dimmed" size="sm">אין תנועות בטווח הזה.</Text>}
    </Paper>
  );
}
