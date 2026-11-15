import { Affix, Button, Checkbox, Group, Paper, SegmentedControl, Select, Stack, Table, Text } from '@mantine/core';
import { useState } from 'react';
import { ACCOUNT_KIND_HE, categoryLabel, amountLabel, date, money } from '../lib/format';
import type { EntryRow } from '../lib/queries';
import { nextSort, sortLedger, type LedgerKey, type LedgerSort } from '../lib/ledgerSort';
import { toggleRows, totalsByCurrency } from '../lib/selection';
import { SourceBadge, useTransactionSources, type TxnSource } from './SourceBadge';
import type { Account, Currency } from '../lib/types';

const FROM = '2026-01-01';

// A column title that sorts the table on a click, up and down (decision 147).
function SortTh({ k, sort, set, w, children }: { k: LedgerKey; sort: LedgerSort; set: (s: LedgerSort) => void; w?: number; children: React.ReactNode }) {
  const on = sort.key === k;
  return (
    <Table.Th w={w} onClick={() => set(nextSort(sort, k))} style={{ cursor: 'pointer', userSelect: 'none', whiteSpace: 'nowrap' }}>
      {children} <Text span size="xs" c={on ? undefined : 'dimmed'}>{on ? (sort.desc ? '▼' : '▲') : '↕'}</Text>
    </Table.Th>
  );
}
// Marking rows to add them up (decision 148): a click on a row (Shift: the whole range from the
// last click), or its box; the header's box marks or clears every row shown. The total of what
// is marked, per currency, floats at the bottom of the screen.
export interface Marks { selected: Set<string>; toggle: (order: string[], id: string, shift: boolean) => void; setMany: (ids: string[], on: boolean) => void }
function useMarks(): Marks & { clear: () => void } {
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [last, setLast] = useState<string | null>(null);
  return {
    selected,
    toggle: (order, id, shift) => { setSelected((s) => toggleRows(s, order, id, last, shift)); setLast(id); },
    setMany: (ids, on) => setSelected((s) => { const n = new Set(s); for (const x of ids) { if (on) n.add(x); else n.delete(x); } return n; }),
    clear: () => { setSelected(new Set()); setLast(null); },
  };
}
const rowClick = (m: Marks, order: string[], id: string) => (ev: React.MouseEvent) => {
  if ((ev.target as HTMLElement).closest('button, a, input')) return;
  if (ev.shiftKey) window.getSelection()?.removeAllRanges();
  m.toggle(order, id, ev.shiftKey);
};
const markStyle = (on: boolean) => ({ cursor: 'pointer', backgroundColor: on ? 'var(--mantine-color-blue-light)' : undefined });
function MarkAll({ m, ids }: { m: Marks; ids: string[] }) {
  const n = ids.filter((x) => m.selected.has(x)).length;
  return <Table.Th w={32}><Checkbox size="xs" aria-label="סימון הכל" checked={n > 0 && n === ids.length} indeterminate={n > 0 && n < ids.length} onChange={() => m.setMany(ids, n < ids.length)} /></Table.Th>;
}
function MarkBox({ m, order, id }: { m: Marks; order: string[]; id: string }) {
  return <Table.Td><Checkbox size="xs" aria-label="סימון" checked={m.selected.has(id)} onChange={() => undefined}
    onClick={(ev) => { ev.stopPropagation(); m.toggle(order, id, ev.shiftKey); }} /></Table.Td>;
}

const typeOf = (e: EntryRow) => categoryLabel(e.transaction.category, e.property?.building?.city?.name_en);
const descOf = (e: EntryRow) => e.memo ?? e.transaction.description ?? '';

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
  const [sortA, setSortA] = useState<LedgerSort>({ key: 'date', desc: false });
  const marks = useMarks();
  const marked = entries.filter((e) => marks.selected.has(e.id));
  const sums = totalsByCurrency(marked.map((e) => ({ amount: Number(e.amount), currency: e.currency })));
  const shown = accounts.filter((a) => entries.some((e) => e.account_id === a.id));
  // The source column shows only for the viewer who may see a source here (decision 138).
  const sources = useTransactionSources(entries.map((e) => e.transaction.id));
  const showSrc = (sources.data?.size ?? 0) > 0;
  return (
    <Stack>
      <Group gap="sm">
        <SegmentedControl value={view} onChange={(v) => setView(v as 'date' | 'account')} w="fit-content"
          data={[{ value: 'date', label: 'לפי תאריך' }, { value: 'account', label: 'לפי קופה' }]} />
        <SegmentedControl value={range} onChange={(v) => setRange(v as '2026' | 'all')} w="fit-content"
          data={[{ value: '2026', label: 'מתחילת 2026' }, { value: 'all', label: 'כל התנועות' }]} />
      </Group>
      {!shown.length && <Text c="dimmed" size="sm">עוד אין תנועות. הן ייכנסו עם קליטת הדוחות מהמנהלים המקומיים.</Text>}
      {view === 'date' && !!shown.length && <ByDate accounts={shown} entries={entries} from={range === '2026' ? FROM : null} property={property} edit={edit} sources={showSrc ? sources.data : undefined} marks={marks} />}
      {marked.length > 0 && (
        <Affix position={{ bottom: 16, left: 16, right: 16 }}>
          <Paper withBorder shadow="md" p="xs" radius="md" maw={640} mx="auto">
            <Group justify="space-between" wrap="nowrap" gap="sm">
              <Text size="sm">נבחרו <b>{marked.length}</b> שורות · סה"כ {sums.map((x, i) => <b key={x.currency}>{i ? ' · ' : ''}<span dir="ltr">{money(x.total, x.currency as Currency)}</span></b>)}</Text>
              <Button size="compact-xs" variant="subtle" onClick={marks.clear}>ניקוי</Button>
            </Group>
          </Paper>
        </Affix>
      )}
      {view === 'account' && shown.map((a) => {
        const mine = entries.filter((e) => e.account_id === a.id);
        const before = range === '2026' ? mine.filter((e) => e.transaction.occurred_on < FROM) : [];
        const rows = range === '2026' ? mine.filter((e) => e.transaction.occurred_on >= FROM) : mine;
        let running = before.reduce((s, e) => s + Number(e.amount), 0);
        // The running total follows the date; another order keeps each row's total as it was then.
        const totals = new Map(rows.map((e) => [e.id, (running += Number(e.amount))]));
        running = before.reduce((s, e) => s + Number(e.amount), 0);
        const sorted = sortLedger(rows, sortA, (e) => ({ date: e.transaction.occurred_on, type: typeOf(e), desc: descOf(e), amount: Number(e.amount), source: sources.data?.get(e.transaction.id)?.source ?? '' }));
        const label = property ? 'מהנכס' : amountLabel(a.kind);
        const order = sorted.map((x) => x.id);
        return (
          <Paper key={a.id} withBorder p="sm">
            <Group justify="space-between" mb="xs">
              <Text fw={600} size="sm">{ACCOUNT_KIND_HE[a.kind] ?? a.kind} · {a.holder.display_name} · {a.currency}{property ? ` · של ${a.beneficiary.display_name}` : ''}</Text>
              <Text size="sm">{label}: <b>{money(mine.reduce((s, e) => s + Number(e.amount), 0), a.currency)}</b></Text>
            </Group>
            <Table.ScrollContainer minWidth={600}>
              <Table verticalSpacing={4} striped>
                <Table.Thead>
                  <Table.Tr><MarkAll m={marks} ids={order} /><SortTh k="date" sort={sortA} set={setSortA} w={100}>תאריך</SortTh><SortTh k="type" sort={sortA} set={setSortA} w={110}>סוג</SortTh><SortTh k="desc" sort={sortA} set={setSortA}>תיאור</SortTh>{showSrc && <SortTh k="source" sort={sortA} set={setSortA} w={70}>מקור</SortTh>}<SortTh k="amount" sort={sortA} set={setSortA} w={120}>סכום</SortTh><Table.Th w={130}>{label} מצטבר</Table.Th>{edit && <Table.Th w={60} />}</Table.Tr>
                </Table.Thead>
                <Table.Tbody>
                  {range === '2026' && (
                    <Table.Tr fw={600}>
                      <Table.Td />
                      <Table.Td>01.01.2026</Table.Td>
                      <Table.Td colSpan={showSrc ? 3 : 2}>{property ? 'עד 1.1.2026' : a.kind === 'client_bank' ? 'הופקד עד 1.1.2026' : 'יתרת פתיחה ב-1.1.2026'} ({before.length} תנועות קודמות)</Table.Td>
                      <Table.Td />
                      <Table.Td style={{ whiteSpace: 'nowrap' }}>{money(running, a.currency)}</Table.Td>
                      {edit && <Table.Td />}
                    </Table.Tr>
                  )}
                  {sorted.map((e) => {
                    return (
                      <Table.Tr key={e.id} onClick={rowClick(marks, order, e.id)} style={markStyle(marks.selected.has(e.id))}>
                        <MarkBox m={marks} order={order} id={e.id} />
                        <Table.Td>{date(e.transaction.occurred_on)}</Table.Td>
                        <Table.Td>{typeOf(e)}</Table.Td>
                        <Table.Td><Text size="sm" lineClamp={2}>{descOf(e)}</Text></Table.Td>
                        {showSrc && <Table.Td>{sources.data?.get(e.transaction.id) && <SourceBadge src={sources.data.get(e.transaction.id)!} importBatchId={e.transaction.import_batch_id} country={e.transaction.country_code} />}</Table.Td>}
                        <Table.Td style={{ whiteSpace: 'nowrap' }} c={Number(e.amount) < 0 ? 'red.7' : undefined}>{money(Number(e.amount), e.currency as Currency)}</Table.Td>
                        <Table.Td style={{ whiteSpace: 'nowrap' }}>{money(totals.get(e.id) ?? 0, a.currency)}</Table.Td>
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

function ByDate({ accounts, entries, from, property, edit, sources, marks }: {
  accounts: Account[]; entries: EntryRow[]; from: string | null; property: boolean; edit?: { can: (e: EntryRow) => boolean; open: (transactionId: string) => void };
  sources?: Map<string, TxnSource>; marks: Marks;
}) {
  const showSrc = !!sources;
  const [account, setAccount] = useState<string | null>(null);
  const [currency, setCurrency] = useState<string | null>(null);
  const [sort, setSort] = useState<LedgerSort>({ key: 'date', desc: true });
  const byId = new Map(accounts.map((a) => [a.id, a]));
  const picked = entries
    .filter((e) => byId.has(e.account_id ?? '') && (!from || e.transaction.occurred_on >= from))
    .filter((e) => (!account || e.account_id === account) && (!currency || e.currency === currency));
  const rows = sortLedger(picked, sort, (e) => ({
    date: e.transaction.occurred_on, type: typeOf(e), desc: descOf(e), account: byId.get(e.account_id ?? '') ? accountName(byId.get(e.account_id ?? '')!, property) : '',
    currency: e.currency, amount: Number(e.amount), source: sources?.get(e.transaction.id)?.source ?? '',
  }));
  const currencies = [...new Set(accounts.map((a) => a.currency))].sort();
  const order = rows.map((e) => e.id);
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
            <Table.Tr><MarkAll m={marks} ids={order} /><SortTh k="date" sort={sort} set={setSort} w={100}>תאריך</SortTh><SortTh k="type" sort={sort} set={setSort} w={110}>סוג</SortTh><SortTh k="desc" sort={sort} set={setSort}>תיאור</SortTh><SortTh k="account" sort={sort} set={setSort} w={200}>קופה</SortTh>{showSrc && <SortTh k="source" sort={sort} set={setSort} w={70}>מקור</SortTh>}<SortTh k="currency" sort={sort} set={setSort} w={70}>מטבע</SortTh><SortTh k="amount" sort={sort} set={setSort} w={120}>סכום</SortTh>{edit && <Table.Th w={60} />}</Table.Tr>
          </Table.Thead>
          <Table.Tbody>
            {rows.map((e) => {
              const a = byId.get(e.account_id ?? '')!;
              return (
                <Table.Tr key={e.id} onClick={rowClick(marks, order, e.id)} style={markStyle(marks.selected.has(e.id))}>
                  <MarkBox m={marks} order={order} id={e.id} />
                  <Table.Td>{date(e.transaction.occurred_on)}</Table.Td>
                  <Table.Td>{typeOf(e)}</Table.Td>
                  <Table.Td><Text size="sm" lineClamp={2}>{descOf(e)}</Text></Table.Td>
                  <Table.Td><Text size="xs">{accountName(a, property)}</Text></Table.Td>
                  {showSrc && <Table.Td>{sources?.get(e.transaction.id) && <SourceBadge src={sources.get(e.transaction.id)!} importBatchId={e.transaction.import_batch_id} country={e.transaction.country_code} />}</Table.Td>}
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
