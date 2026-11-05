import { Alert, Badge, Group, Loader, Paper, SegmentedControl, SimpleGrid, Stack, Table, Text, Title, Tooltip } from '@mantine/core';
import { useQuery } from '@tanstack/react-query';
import dayjs from 'dayjs';
import { useMemo, useState } from 'react';
import { CountryFilter } from '../components/common';
import { CATEGORY_HE, COUNTRY_HE, money, STATUS_HE } from '../lib/format';
import { useClients, useProperties } from '../lib/queries';
import { byCity, expensesByCategory, monthly, type StatEntry } from '../lib/stats';
import { must, supabase } from '../lib/supabase';
import type { Country, Currency } from '../lib/types';

// Management statistics (SPEC decision 96): clients and apartments, money in and out per
// month, per city, and per apartment. Every sum stays in its own currency.

const INCOME = '#2a78d6';   // categorical slot 1 (blue)
const EXPENSE = '#eb6834';  // categorical slot 2 (orange)

function useLedger(from: string) {
  return useQuery({
    queryKey: ['stats-ledger', from],
    queryFn: async () => {
      const out: StatEntry[] = [];
      for (let at = 0; ; at += 1000) {
        const page = must(await supabase.from('entries')
          .select('amount, currency, property_id, transactions!inner(period, category, status, country_code)')
          .eq('transactions.status', 'posted').gte('transactions.period', from).lte('transactions.period', dayjs().format('YYYY-MM-01')).not('account_id', 'is', null)
          .order('id').range(at, at + 999)) as unknown as { amount: number; currency: string; property_id: string | null; transactions: { period: string; category: string; country_code: Country } }[];
        out.push(...page.map((r) => ({ amount: Number(r.amount), currency: r.currency, property_id: r.property_id, period: r.transactions.period, category: r.transactions.category, country: r.transactions.country_code })));
        if (page.length < 1000) return out as (StatEntry & { country: Country })[];
      }
    },
  });
}

function Tile({ label, value, hint }: { label: string; value: string | number; hint?: string }) {
  return (
    <Paper withBorder p="md">
      <Text size="sm" c="dimmed">{label}</Text>
      <Text fw={700} fz={28} lh={1.2}>{value}</Text>
      {hint && <Text size="xs" c="dimmed">{hint}</Text>}
    </Paper>
  );
}

const Legend = () => (
  <Group gap="md">
    {[['הכנסות ברוטו', INCOME], ['הוצאות', EXPENSE]].map(([l, c]) => (
      <Group key={l} gap={6}><span style={{ width: 12, height: 12, borderRadius: 3, background: c, display: 'inline-block' }} /><Text size="sm">{l}</Text></Group>
    ))}
  </Group>
);

// Income and expenses side by side per month, on one axis from zero.
function MonthChart({ rows, currency }: { rows: { period: string; gross: number; expenses: number; net: number }[]; currency: Currency }) {
  const H = 180, bar = 12, gap = 2, slot = 2 * bar + gap + 18;
  const max = Math.max(1, ...rows.flatMap((r) => [r.gross, r.expenses]));
  const W = Math.max(rows.length * slot, 200);
  const y = (v: number) => H - (Math.max(0, v) / max) * H;
  return (
    <div style={{ overflowX: 'auto' }}>
      <svg width={W} height={H + 22} role="img" aria-label="הכנסות והוצאות לפי חודש" style={{ display: 'block' }}>
        <line x1={0} x2={W} y1={H} y2={H} stroke="var(--mantine-color-gray-4)" />
        {rows.map((r, i) => {
          const x = i * slot + 9;
          const tip = `${dayjs(r.period).format('MM.YYYY')}\nברוטו ${money(r.gross, currency)}\nהוצאות ${money(r.expenses, currency)}\nנטו ${money(r.net, currency)}`;
          return (
            <g key={r.period}>
              <title>{tip}</title>
              <rect x={x - 6} y={0} width={slot - 6} height={H} fill="transparent" />
              <rect x={x} y={y(r.gross)} width={bar} height={H - y(r.gross)} rx={3} fill={INCOME} />
              <rect x={x + bar + gap} y={y(r.expenses)} width={bar} height={H - y(r.expenses)} rx={3} fill={EXPENSE} />
              <text x={x + bar} y={H + 15} fontSize={10} textAnchor="middle" fill="var(--mantine-color-dimmed)">{dayjs(r.period).format('MM.YY')}</text>
            </g>
          );
        })}
      </svg>
    </div>
  );
}

// One measure, horizontal bars, labelled with the value.
function Bars({ rows, currency, color = INCOME }: { rows: { label: string; value: number; note?: string }[]; currency: Currency; color?: string }) {
  const max = Math.max(1, ...rows.map((r) => r.value));
  return (
    <Stack gap={6}>
      {rows.map((r) => (
        <Tooltip key={r.label} label={r.note ?? `${r.label}: ${money(r.value, currency)}`} position="top-start">
          <Group gap="xs" wrap="nowrap">
            <Text size="sm" w={130} truncate>{r.label}</Text>
            <div style={{ flex: 1, minWidth: 0 }}>
              <div style={{ width: `${Math.max(1, (r.value / max) * 100)}%`, height: 14, background: color, borderRadius: '0 4px 4px 0' }} />
            </div>
            <Text size="sm" w={110} ta="left" style={{ whiteSpace: 'nowrap' }}>{money(r.value, currency)}</Text>
          </Group>
        </Tooltip>
      ))}
    </Stack>
  );
}

export function Stats() {
  const [months, setMonths] = useState('12');
  const [country, setCountry] = useState<Country | null>(null);
  const from = dayjs().startOf('month').subtract(Number(months) - 1, 'month').format('YYYY-MM-01');
  const props = useProperties();
  const clients = useClients();
  const ledger = useLedger(from);

  const inCountry = useMemo(() => (props.data ?? []).filter((p) => !country || p.country_code === country), [props.data, country]);
  const active = inCountry.filter((p) => p.status !== 'sold');
  const today = dayjs().format('YYYY-MM-DD');
  const ownersNow = new Set(active.flatMap((p) => p.ownerships.filter((o) => o.valid_from <= today && (!o.valid_to || o.valid_to >= today)).map((o) => o.party.id)));
  const earningNow = active.filter((p) => p.status === 'rented' || p.status === 'short_term').length;
  const soon = dayjs().add(90, 'day').format('YYYY-MM-DD');
  const ending = active.flatMap((p) => p.leases).filter((l) => l.end_date && l.end_date >= today && l.end_date <= soon).length;

  const cityOf = useMemo(() => new Map((props.data ?? []).map((p) => [p.id, p.building.city.name_he])), [props.data]);
  const unitsIn = useMemo(() => { const m = new Map<string, number>(); for (const p of active) m.set(p.building.city.name_he, (m.get(p.building.city.name_he) ?? 0) + 1); return m; }, [active]);
  const entries = useMemo(() => (ledger.data ?? []).filter((e) => !country || e.country === country), [ledger.data, country]);
  const perMonth = useMemo(() => monthly(entries), [entries]);
  const cities = useMemo(() => byCity(entries, cityOf, unitsIn), [entries, cityOf, unitsIn]);
  const byStatus = Object.entries(STATUS_HE).map(([s, label]) => [label, inCountry.filter((p) => p.status === s).length] as const).filter(([, n]) => n);
  const byCountry = (['UA', 'RO', 'GE', 'GR'] as Country[]).map((c) => [c, (props.data ?? []).filter((p) => p.country_code === c && p.status !== 'sold').length] as const);

  return (
    <Stack>
      <Group justify="space-between">
        <Title order={2}>סטטיסטיקות</Title>
        <Group>
          <CountryFilter value={country ?? "all"} onChange={(c) => setCountry(c === "all" ? null : (c as Country))} />
          <SegmentedControl value={months} onChange={setMonths} data={[{ value: '3', label: '3 חודשים' }, { value: '6', label: '6' }, { value: '12', label: '12' }, { value: '24', label: '24' }]} />
        </Group>
      </Group>

      {!props.data || !clients.data ? <Loader /> : (
        <>
          <SimpleGrid cols={{ base: 2, sm: 3, lg: 6 }}>
            <Tile label="לקוחות עם דירה" value={ownersNow.size} hint={`${clients.data.length} לקוחות במערכת`} />
            <Tile label="דירות" value={active.length} hint={`בלי ${inCountry.length - active.length} שנמכרו`} />
            <Tile label="מניבות היום" value={earningNow} hint={`${active.length ? Math.round((earningNow / active.length) * 100) : 0}% מהדירות (מושכרות + השכרה קצרה)`} />
            <Tile label="חוזים שנגמרים ב-90 יום" value={ending} />
            <Tile label="ערים" value={unitsIn.size} />
            <Tile label="מדינות" value={byCountry.filter(([c, n]) => n && (!country || c === country)).length} />
          </SimpleGrid>

          <SimpleGrid cols={{ base: 1, md: 2 }}>
            <Paper withBorder p="md">
              <Title order={4} mb="sm">דירות לפי מדינה</Title>
              <Table><Table.Tbody>{byCountry.map(([c, n]) => <Table.Tr key={c}><Table.Td>{COUNTRY_HE[c]}</Table.Td><Table.Td>{n}</Table.Td></Table.Tr>)}</Table.Tbody></Table>
            </Paper>
            <Paper withBorder p="md">
              <Title order={4} mb="sm">דירות לפי סטטוס</Title>
              <Table><Table.Tbody>{byStatus.map(([l, n]) => <Table.Tr key={l}><Table.Td>{l}</Table.Td><Table.Td>{n}</Table.Td></Table.Tr>)}</Table.Tbody></Table>
            </Paper>
          </SimpleGrid>
        </>
      )}

      <Text size="sm" c="dimmed">הכסף: רק תנועות שאושרו בספר החשבונות, מ-{dayjs(from).format('MM.YYYY')}. העברות, החלפת מטבע, פיקדונות ויתרות פתיחה לא נספרים. כל סכום במטבע שלו, בלי המרה.</Text>
      {ledger.isLoading ? <Loader /> : ledger.error ? <Alert color="red">{(ledger.error as Error).message}</Alert> : !perMonth.size ? (
        <Alert color="gray">אין עדיין תנועות שאושרו בתקופה הזו{country ? ` ב${COUNTRY_HE[country]}` : ''}. דוחות שנקלטו נכנסים לכאן אחרי אישור של כספים.</Alert>
      ) : [...perMonth].map(([cur, rows]) => {
        const currency = cur as Currency;
        const tot = rows.reduce((a, r) => ({ gross: a.gross + r.gross, expenses: a.expenses + r.expenses, net: a.net + r.net }), { gross: 0, expenses: 0, net: 0 });
        const cityRows = cities.filter((c) => c.currency === cur);
        const cats = expensesByCategory(entries, cur);
        return (
          <Paper key={cur} withBorder p="md">
            <Group justify="space-between" mb="sm">
              <Title order={3}>כסף ב-{cur}</Title>
              <Badge variant="light" size="lg">{rows.length} חודשים עם נתונים</Badge>
            </Group>
            <SimpleGrid cols={{ base: 1, sm: 4 }} mb="md">
              <Tile label="ברוטו (הכנסות)" value={money(tot.gross, currency)} hint={`ממוצע ${money(tot.gross / rows.length, currency)} לחודש`} />
              <Tile label="הוצאות" value={money(tot.expenses, currency)} hint={`${tot.gross ? Math.round((tot.expenses / tot.gross) * 100) : 0}% מהברוטו`} />
              <Tile label="נטו ללקוחות" value={money(tot.net, currency)} hint={`ממוצע ${money(tot.net / rows.length, currency)} לחודש`} />
              <Tile label="ממוצע לדירה מניבה בחודש" value={money(cityRows.reduce((a, c) => a + c.gross, 0) / Math.max(1, cityRows.reduce((a, c) => a + c.earning * c.months, 0)), currency)} />
            </SimpleGrid>

            <Group justify="space-between"><Title order={5}>לפי חודש</Title><Legend /></Group>
            <MonthChart rows={rows} currency={currency} />
            <Table.ScrollContainer minWidth={480} mt="sm">
              <Table striped>
                <Table.Thead><Table.Tr><Table.Th>חודש</Table.Th><Table.Th>ברוטו</Table.Th><Table.Th>הוצאות</Table.Th><Table.Th>נטו</Table.Th></Table.Tr></Table.Thead>
                <Table.Tbody>{[...rows].reverse().map((r) => (
                  <Table.Tr key={r.period}><Table.Td>{dayjs(r.period).format('MM.YYYY')}</Table.Td><Table.Td>{money(r.gross, currency)}</Table.Td>
                    <Table.Td>{money(r.expenses, currency)}</Table.Td><Table.Td fw={600}>{money(r.net, currency)}</Table.Td></Table.Tr>
                ))}</Table.Tbody>
              </Table>
            </Table.ScrollContainer>

            <SimpleGrid cols={{ base: 1, md: 2 }} mt="lg" spacing="xl">
              <Stack gap="xs">
                <Title order={5}>ממוצע לדירה מניבה בחודש, לפי עיר</Title>
                <Bars currency={currency} rows={cityRows.map((c) => ({ label: c.city, value: c.perUnit, note: `${c.city}: ${c.earning} דירות עם הכנסה מתוך ${c.units}, ${c.months} חודשים` }))} />
                <Table mt="xs">
                  <Table.Thead><Table.Tr><Table.Th>עיר</Table.Th><Table.Th>דירות</Table.Th><Table.Th>עם הכנסה</Table.Th><Table.Th>ברוטו</Table.Th><Table.Th>נטו</Table.Th></Table.Tr></Table.Thead>
                  <Table.Tbody>{cityRows.map((c) => (
                    <Table.Tr key={c.city}><Table.Td>{c.city}</Table.Td><Table.Td>{c.units}</Table.Td><Table.Td>{c.earning}</Table.Td>
                      <Table.Td>{money(c.gross, currency)}</Table.Td><Table.Td>{money(c.net, currency)}</Table.Td></Table.Tr>
                  ))}</Table.Tbody>
                </Table>
              </Stack>
              <Stack gap="xs">
                <Title order={5}>לאן הולכות ההוצאות</Title>
                <Bars currency={currency} color={EXPENSE} rows={cats.map((c) => ({ label: CATEGORY_HE[c.category] ?? c.category, value: c.amount }))} />
              </Stack>
            </SimpleGrid>
          </Paper>
        );
      })}
    </Stack>
  );
}
