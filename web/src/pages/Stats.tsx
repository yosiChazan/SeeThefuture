import { Alert, Anchor, Badge, Group, Loader, Paper, SegmentedControl, SimpleGrid, Stack, Table, Text, Title, Tooltip } from '@mantine/core';
import { useQuery } from '@tanstack/react-query';
import dayjs from 'dayjs';
import { useMemo, useState } from 'react';
import { Link } from 'react-router-dom';
import { CountryFilter } from '../components/common';
import { CATEGORY_HE, COUNTRY_HE, money, propertyTitle, STATUS_HE } from '../lib/format';
import { useClients, useProperties } from '../lib/queries';
import { byCity, change, contractRent, expensesByCategory, occupancy, monthly, quiet, trend, yearBefore, type StatEntry } from '../lib/stats';
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

// Open charges (not paid) and tenants' deposits held by managers (decision 97).
function useOpen() {
  return useQuery({
    queryKey: ['stats-open'],
    queryFn: async () => {
      const charges = must(await supabase.from('charges').select('id, property_id, period, kind, amount, currency, status, notes').in('status', ['due', 'partial']).order('period')) as
        { id: string; property_id: string; period: string; kind: string; amount: number; currency: string; status: string; notes: string | null }[];
      const deposits: { amount: number; currency: string; accounts: { id: string; holder: { display_name: string } | null } }[] = [];
      for (let at = 0; ; at += 1000) {
        const page = must(await supabase.from('entries')
          .select('amount, currency, accounts!inner(id, kind, holder:parties!accounts_holder_party_id_fkey(display_name)), transactions!inner(status)')
          .eq('accounts.kind', 'deposit_held').eq('transactions.status', 'posted').order('id').range(at, at + 999)) as unknown as typeof deposits;
        deposits.push(...page);
        if (page.length < 1000) break;
      }
      const held = new Map<string, { holder: string; currency: string; amount: number; accounts: Set<string> }>();
      for (const d of deposits) {
        const k = `${d.accounts.holder?.display_name ?? '?'}|${d.currency}`;
        const h = held.get(k) ?? held.set(k, { holder: d.accounts.holder?.display_name ?? 'לא ידוע', currency: d.currency, amount: 0, accounts: new Set() }).get(k)!;
        h.amount += Number(d.amount); h.accounts.add(d.accounts.id);
      }
      return { charges, held: [...held.values()].filter((h) => Math.abs(h.amount) >= 0.01) };
    },
  });
}

const pct = (x: number | null) => (x === null ? '—' : `${x > 0 ? '+' : ''}${x}%`);

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
  // A year more than shown: for "a year earlier" and for apartments that went quiet.
  const loadFrom = dayjs(from).subtract(12, 'month').format('YYYY-MM-01');
  const [quietN, setQuietN] = useState('2');
  const open = useOpen();
  const props = useProperties();
  const clients = useClients();
  const ledger = useLedger(loadFrom);

  const inCountry = useMemo(() => (props.data ?? []).filter((p) => !country || p.country_code === country), [props.data, country]);
  const active = inCountry.filter((p) => p.status !== 'sold');
  const today = dayjs().format('YYYY-MM-DD');
  const ownersNow = new Set(active.flatMap((p) => p.ownerships.filter((o) => o.valid_from <= today && (!o.valid_to || o.valid_to >= today)).map((o) => o.party.id)));
  const occ = useMemo(() => occupancy(inCountry.map((p) => ({ city: p.building.city.name_he, status: p.status }))), [inCountry]);
  const occTotal = occ.reduce((t, r) => ({ ...t, total: t.total + r.total, construction: t.construction + r.construction, ownerUse: t.ownerUse + r.ownerUse, rentable: t.rentable + r.rentable, rented: t.rented + r.rented, notRented: t.notRented + r.notRented }),
    { city: 'סה"כ', total: 0, construction: 0, ownerUse: 0, rentable: 0, rented: 0, notRented: 0, notRentedPct: 0 });
  const ofRentable = (n: number) => (occTotal.rentable ? Math.round((n / occTotal.rentable) * 100) : 0);
  const rentedIds = useMemo(() => new Set(active.filter((p) => p.status === 'rented' || p.status === 'short_term').map((p) => p.id)), [active]);
  const leaseRent = useMemo(() => contractRent(active.map((p) => ({ city: p.building.city.name_he, status: p.status, leases: p.leases })), dayjs().format('YYYY-MM-DD')), [active]);
  const soon = dayjs().add(90, 'day').format('YYYY-MM-DD');
  const ending = active.flatMap((p) => p.leases).filter((l) => l.end_date && l.end_date >= today && l.end_date <= soon).length;

  const cityOf = useMemo(() => new Map((props.data ?? []).map((p) => [p.id, p.building.city.name_he])), [props.data]);
  const unitsIn = useMemo(() => { const m = new Map<string, number>(); for (const p of active) m.set(p.building.city.name_he, (m.get(p.building.city.name_he) ?? 0) + 1); return m; }, [active]);
  const all = useMemo(() => (ledger.data ?? []).filter((e) => !country || e.country === country), [ledger.data, country]);
  const entries = useMemo(() => all.filter((e) => e.period >= from), [all, from]);
  const perMonth = useMemo(() => monthly(entries), [entries]);
  const perMonthAll = useMemo(() => monthly(all), [all]);
  const titleOf = useMemo(() => new Map((props.data ?? []).map((p) => [p.id, p])), [props.data]);
  const quietRows = useMemo(() => quiet(all.filter((e) => e.period < dayjs().format('YYYY-MM-01')), active.map((p) => ({ id: p.id, country: p.country_code, expected: p.status === 'rented' || p.status === 'short_term' })), Number(quietN)), [all, active, quietN]);
  const openCharges = (open.data?.charges ?? []).filter((c) => !country || titleOf.get(c.property_id)?.country_code === country);
  const cities = useMemo(() => byCity(entries, cityOf, unitsIn, rentedIds), [entries, cityOf, unitsIn, rentedIds]);
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
          <SimpleGrid cols={{ base: 2, sm: 4, lg: 7 }}>
            <Tile label="לקוחות עם דירה" value={ownersNow.size} hint={`${clients.data.length} לקוחות במערכת`} />
            <Tile label="דירות" value={active.length} hint={`בלי ${inCountry.length - active.length} שנמכרו`} />
            <Tile label="בבנייה" value={occTotal.construction} hint={occTotal.ownerUse ? `ועוד ${occTotal.ownerUse} בשימוש הבעלים` : undefined} />
            <Tile label="יכולות להיות מושכרות" value={occTotal.rentable} hint="בלי בבנייה ובשימוש הבעלים" />
            <Tile label="מושכרות" value={occTotal.rented} hint={`${ofRentable(occTotal.rented)}% מאלו שיכולות (כולל השכרה קצרה)`} />
            <Tile label="לא מושכרות" value={occTotal.notRented} hint={`${ofRentable(occTotal.notRented)}% מאלו שיכולות`} />
            <Tile label="חוזים שנגמרים ב-90 יום" value={ending} />
          </SimpleGrid>

          <SimpleGrid cols={{ base: 1, md: 2 }}>
            <Paper withBorder p="md">
              <Title order={4} mb="sm">דירות לפי מדינה</Title>
              <Table><Table.Tbody>{byCountry.map(([c, n]) => <Table.Tr key={c}><Table.Td>{COUNTRY_HE[c]}</Table.Td><Table.Td>{n}</Table.Td></Table.Tr>)}</Table.Tbody></Table>
            </Paper>
          </SimpleGrid>
          <Paper withBorder p="md">
            <Title order={4} mb={4}>תפוסה לפי עיר</Title>
            <Text size="xs" c="dimmed" mb="sm">"לא מושכרות" והאחוז שלהן נספרים רק מתוך הדירות שיכולות להיות מושכרות: בלי דירות בבנייה ובשימוש הבעלים. שכר הדירה הממוצע: מהחוזים הפעילים של דירות מושכרות בלבד.</Text>
            <Table.ScrollContainer minWidth={720}>
              <Table striped>
                <Table.Thead><Table.Tr><Table.Th>עיר</Table.Th><Table.Th>דירות</Table.Th><Table.Th>בבנייה</Table.Th><Table.Th>בשימוש הבעלים</Table.Th><Table.Th>יכולות להיות מושכרות</Table.Th>
                  <Table.Th>מושכרות</Table.Th><Table.Th>לא מושכרות</Table.Th><Table.Th>% לא מושכרות</Table.Th><Table.Th>שכ"ד ממוצע בחוזה</Table.Th></Table.Tr></Table.Thead>
                <Table.Tbody>{[...occ, occTotal].map((r) => {
                  const total = r.city === 'סה"כ';
                  const pctNR = r.rentable ? Math.round((r.notRented / r.rentable) * 1000) / 10 : 0;
                  return (
                    <Table.Tr key={r.city} fw={total ? 700 : undefined}><Table.Td>{r.city}</Table.Td><Table.Td>{r.total}</Table.Td><Table.Td>{r.construction}</Table.Td><Table.Td>{r.ownerUse}</Table.Td>
                      <Table.Td>{r.rentable}</Table.Td><Table.Td>{r.rented}</Table.Td><Table.Td>{r.notRented}</Table.Td>
                      <Table.Td c={pctNR >= 25 ? 'red' : undefined}>{r.rentable ? `${pctNR}%` : '—'}</Table.Td>
                      <Table.Td>{total ? '' : leaseRent.filter((x) => x.city === r.city).map((x) => `${money(x.avg, x.currency as Currency)} (${x.leases})`).join(' · ') || '—'}</Table.Td></Table.Tr>
                  );
                })}</Table.Tbody>
              </Table>
            </Table.ScrollContainer>
          </Paper>
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
              <Tile label="ממוצע לדירה מושכרת בחודש (בפועל)" value={money(cityRows.reduce((a, c) => a + c.perUnit * c.earning * c.months, 0) / Math.max(1, cityRows.reduce((a, c) => a + c.earning * c.months, 0)), currency)} />
            </SimpleGrid>
            {(() => {
              const full = perMonthAll.get(cur) ?? [];
              const t3 = trend(full, 3);
              const tAll = trend(full.filter((r) => r.period <= rows[rows.length - 1].period), rows.length);
              return (
                <SimpleGrid cols={{ base: 1, sm: 2 }} mb="md">
                  <Tile label="3 החודשים האחרונים מול אשתקד (ברוטו)" value={t3?.before ? pct(change(t3.now, t3.before)) : 'אין נתוני אשתקד'}
                    hint={t3 ? `${money(t3.now, currency)}${t3.before ? ` מול ${money(t3.before, currency)}` : ''}` : undefined} />
                  <Tile label={`כל הטווח (${rows.length} חודשים) מול אשתקד`} value={tAll?.before ? pct(change(tAll.now, tAll.before)) : 'אין נתוני אשתקד'}
                    hint={tAll?.before ? `${money(tAll.now, currency)} מול ${money(tAll.before, currency)}` : 'ההשוואה מופיעה כשיש נתונים לאותם חודשים שנה קודם'} />
                </SimpleGrid>
              );
            })()}

            <Group justify="space-between"><Title order={5}>לפי חודש</Title><Legend /></Group>
            <MonthChart rows={rows} currency={currency} />
            <Table.ScrollContainer minWidth={480} mt="sm">
              <Table striped>
                <Table.Thead><Table.Tr><Table.Th>חודש</Table.Th><Table.Th>ברוטו</Table.Th><Table.Th>הוצאות</Table.Th><Table.Th>נטו</Table.Th><Table.Th>ברוטו אשתקד</Table.Th><Table.Th>שינוי</Table.Th></Table.Tr></Table.Thead>
                <Table.Tbody>{[...rows].reverse().map((r) => {
                  const ly = (perMonthAll.get(cur) ?? []).find((x) => x.period === yearBefore(r.period));
                  const ch = change(r.gross, ly?.gross);
                  return (
                    <Table.Tr key={r.period}><Table.Td>{dayjs(r.period).format('MM.YYYY')}</Table.Td><Table.Td>{money(r.gross, currency)}</Table.Td>
                      <Table.Td>{money(r.expenses, currency)}</Table.Td><Table.Td fw={600}>{money(r.net, currency)}</Table.Td>
                      <Table.Td c="dimmed">{ly ? money(ly.gross, currency) : '—'}</Table.Td>
                      <Table.Td c={ch === null ? 'dimmed' : ch < 0 ? 'red' : 'teal'}>{pct(ch)}</Table.Td></Table.Tr>
                  );
                })}</Table.Tbody>
              </Table>
            </Table.ScrollContainer>

            <SimpleGrid cols={{ base: 1, md: 2 }} mt="lg" spacing="xl">
              <Stack gap="xs">
                <Title order={5}>ממוצע לדירה מושכרת בחודש, לפי עיר (הכנסה בפועל)</Title>
                <Bars currency={currency} rows={cityRows.map((c) => ({ label: c.city, value: c.perUnit, note: `${c.city}: ${c.earning} דירות מושכרות עם הכנסה מתוך ${c.units}, ${c.months} חודשים` }))} />
                <Table mt="xs">
                  <Table.Thead><Table.Tr><Table.Th>עיר</Table.Th><Table.Th>דירות</Table.Th><Table.Th>מושכרות עם הכנסה</Table.Th><Table.Th>ברוטו</Table.Th><Table.Th>נטו</Table.Th></Table.Tr></Table.Thead>
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

      <Paper withBorder p="md">
        <Group justify="space-between" mb="xs">
          <Title order={3}>דירות שקטות</Title>
          <SegmentedControl size="xs" value={quietN} onChange={setQuietN} data={[{ value: '2', label: 'חודשיים' }, { value: '3', label: '3 חודשים' }]} />
        </Group>
        <Text size="sm" c="dimmed" mb="sm">דירות מושכרות או בהשכרה קצרה בלי שום הכנסה ב-{quietN} החודשים האחרונים שיש עליהם נתונים במדינה שלהן (בלי החודש הנוכחי, שעוד לא דווח). מדינה בלי הכנסות שאושרו עוד לא נבדקת.</Text>
        {!quietRows.windowEnd.size ? <Text size="sm" c="dimmed">אין עדיין הכנסות שאושרו לבדוק מולן.</Text> : (
          <>
            <Text size="sm" mb="xs">נבדק עד: {[...quietRows.windowEnd].map(([c, m]) => `${COUNTRY_HE[c as Country]} ${dayjs(m).format('MM.YYYY')}`).join(' · ')}</Text>
            {!quietRows.rows.length ? <Badge color="teal" variant="light">אין דירות שקטות</Badge> : (
              <Table.ScrollContainer minWidth={480} mah={360}>
                <Table striped>
                  <Table.Thead><Table.Tr><Table.Th>דירה</Table.Th><Table.Th>סטטוס</Table.Th><Table.Th>הכנסה אחרונה</Table.Th></Table.Tr></Table.Thead>
                  <Table.Tbody>{quietRows.rows.map((q) => {
                    const p = titleOf.get(q.id)!;
                    return (
                      <Table.Tr key={q.id}><Table.Td><Anchor component={Link} to={`/properties/${q.id}`} size="sm">{propertyTitle(p)}</Anchor></Table.Td>
                        <Table.Td>{STATUS_HE[p.status]}</Table.Td><Table.Td>{q.lastIncome ? dayjs(q.lastIncome).format('MM.YYYY') : `אין ב-${Number(months) + 12} החודשים האחרונים`}</Table.Td></Table.Tr>
                    );
                  })}</Table.Tbody>
                </Table>
              </Table.ScrollContainer>
            )}
          </>
        )}
      </Paper>

      <Paper withBorder p="md">
        <Title order={3} mb="xs">חובות ותשלומים פתוחים</Title>
        {open.isLoading ? <Loader size="sm" /> : open.error ? <Alert color="red">{(open.error as Error).message}</Alert> : (
          <SimpleGrid cols={{ base: 1, md: 2 }} spacing="xl">
            <Stack gap="xs">
              <Title order={5}>חיובים שלא שולמו ({openCharges.length})</Title>
              {!openCharges.length ? <Text size="sm" c="dimmed">אין</Text> : (
                <>
                  <Text size="sm">{[...openCharges.reduce((m, c) => m.set(c.currency, (m.get(c.currency) ?? 0) + Number(c.amount)), new Map<string, number>())].map(([cur, sum]) => money(sum, cur as Currency)).join(' · ')}</Text>
                  <Table.ScrollContainer minWidth={420} mah={300}>
                    <Table striped>
                      <Table.Thead><Table.Tr><Table.Th>דירה</Table.Th><Table.Th>חודש</Table.Th><Table.Th>סכום</Table.Th></Table.Tr></Table.Thead>
                      <Table.Tbody>{openCharges.map((c) => {
                        const p = titleOf.get(c.property_id);
                        return (
                          <Table.Tr key={c.id}><Table.Td>{p ? <Anchor component={Link} to={`/properties/${c.property_id}`} size="sm">{propertyTitle(p)}</Anchor> : '—'}</Table.Td>
                            <Table.Td>{dayjs(c.period).format('MM.YYYY')}</Table.Td><Table.Td>{money(Number(c.amount), c.currency as Currency)}</Table.Td></Table.Tr>
                        );
                      })}</Table.Tbody>
                    </Table>
                  </Table.ScrollContainer>
                </>
              )}
            </Stack>
            <Stack gap="xs">
              <Title order={5}>פיקדונות של שוכרים שמוחזקים אצל מנהלים</Title>
              {!open.data?.held.length ? <Text size="sm" c="dimmed">אין</Text> : (
                <Table>
                  <Table.Thead><Table.Tr><Table.Th>מנהל</Table.Th><Table.Th>חשבונות פיקדון</Table.Th><Table.Th>מוחזק</Table.Th></Table.Tr></Table.Thead>
                  <Table.Tbody>{open.data.held.map((h) => (
                    <Table.Tr key={h.holder + h.currency}><Table.Td>{h.holder}</Table.Td><Table.Td>{h.accounts.size}</Table.Td><Table.Td fw={600}>{money(h.amount, h.currency as Currency)}</Table.Td></Table.Tr>
                  ))}</Table.Tbody>
                </Table>
              )}
              <Text size="xs" c="dimmed">הפיקדון שייך לשוכר ויוחזר לו בסוף החוזה; הוא לא חלק מהיתרה של הלקוח.</Text>
            </Stack>
          </SimpleGrid>
        )}
      </Paper>
    </Stack>
  );
}
