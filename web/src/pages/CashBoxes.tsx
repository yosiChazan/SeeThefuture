import { Alert, Anchor, Badge, Button, Group, Modal, NumberInput, Paper, SegmentedControl, Select, SimpleGrid, Stack, Table, Text, TextInput, Title } from '@mantine/core';
import { DateInput } from '@mantine/dates';
import { modals } from '@mantine/modals';
import { notifications } from '@mantine/notifications';
import { IconPlus, IconTrash } from '@tabler/icons-react';
import { ActionIcon } from '@mantine/core';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import dayjs from 'dayjs';
import { useMemo, useState } from 'react';
import { Link, useSearchParams } from 'react-router-dom';
import { division, KIND_HE, summarize, type AutoIn, type CashMovement } from '../lib/cash';
import { date, money } from '../lib/format';
import { useClients, useContacts } from '../lib/queries';
import { must, supabase } from '../lib/supabase';
import type { Country, Currency } from '../lib/types';
import { useAccess } from '../lib/access';

// Cash boxes (SPEC decisions 112–114): the office's cash and Gershon's. Gershon's receives
// Vitaly's and Yarach's money from the approved reports on its own; what he sends to us is
// entered as a sum with a date, then divided: to clients (posted to their accounts) and to
// the office's fees. What Gershon should hold = received − sent to us.

interface Box { id: string; name: string; country_code: Country | null; holder_party_id: string | null; linked_manager_ids: string[]; is_office: boolean; notes: string | null; position: number }
const CURRENCIES: Currency[] = ['UAH', 'USD', 'EUR', 'ILS', 'RON', 'GEL'];

function useBoxes() {
  return useQuery({ queryKey: ['cash-boxes'], queryFn: async () => must(await supabase.from('cash_boxes').select('*').order('position')) as Box[] });
}
function useMovements(boxId: string | null) {
  return useQuery({
    queryKey: ['cash-movements', boxId], enabled: !!boxId,
    queryFn: async () => must(await supabase.from('cash_movements').select('id, occurred_on, amount, currency, kind, party_id, party_name, notes, created_by, parent_id, transaction_id, mirror_of')
      .eq('box_id', boxId!).order('occurred_on', { ascending: false }).order('created_at', { ascending: false })) as CashMovement[],
  });
}

// What flows into a box on its own from approved reports (SPEC decision 112): the cash of
// its linked managers (Vitaly's, into Gershon's), and the rent held by the box's holder
// (Yarach's transfers reach Gershon). Per currency.
function useAuto(box: Box | null, names: Map<string, string>) {
  return useQuery({
    queryKey: ['cash-auto', box?.id, box?.linked_manager_ids, box?.holder_party_id], enabled: !!box && (box.linked_manager_ids.length > 0 || !!box.holder_party_id),
    queryFn: async () => {
      type Row = { amount: number; currency: string; accounts: { kind: string; holder_party_id: string } };
      const load = async (kind: string, holders: string[]) => {
        const out: Row[] = [];
        if (!holders.length) return out;
        for (let at = 0; ; at += 1000) {
          const page = must(await supabase.from('entries').select('amount, currency, accounts!inner(kind, holder_party_id), transactions!inner(status, category)')
            .eq('accounts.kind', kind).in('accounts.holder_party_id', holders).eq('transactions.status', 'posted')
            // A payment to a client is counted once, as "handed to clients": not again here.
            .neq('transactions.category', 'transfer').order('id').range(at, at + 999)) as unknown as Row[];
          out.push(...page);
          if (page.length < 1000) return out;
        }
      };
      const rows = [...await load('manager_cash', box!.linked_manager_ids), ...await load('rent_pool', box!.holder_party_id ? [box!.holder_party_id] : [])];
      const m = new Map<string, AutoIn>();
      for (const r of rows) {
        const who = r.accounts.kind === 'rent_pool' ? 'שכירות שהגיעה לגרשון (ירח), מהדוחות' : `${names.get(r.accounts.holder_party_id) ?? 'מנהל'}, מהדוחות`;
        const k = `${who}|${r.currency}`;
        const a = m.get(k) ?? m.set(k, { who, currency: r.currency, amount: 0 }).get(k)!;
        a.amount += Number(r.amount);
      }
      return [...m.values()].map((a) => ({ ...a, amount: Math.round(a.amount * 100) / 100 }));
    },
  });
}

function NewMovement({ box, onClose }: { box: Box; onClose: () => void }) {
  const qc = useQueryClient();
  const clients = useClients();
  const contacts = useContacts();
  const [v, setV] = useState({ on: dayjs().format('YYYY-MM-DD') as string | null, dir: 'in' as 'in' | 'out', kind: 'from_manager', amount: '' as number | '',
    currency: (box.country_code === 'UA' ? 'UAH' : 'ILS') as Currency, party: null as string | null, partyName: '', notes: '' });
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const people = useMemo(() => {
    const managers = (contacts.data ?? []).map((p) => ({ value: p.id, label: p.display_name }));
    const cl = (clients.data ?? []).map((p) => ({ value: p.id, label: p.display_name }));
    // A linked manager's money comes from the reports; entering it here would count it twice.
    const own = managers.filter((p) => !box.linked_manager_ids.includes(p.value));
    return v.kind === 'to_client' ? cl : v.kind === 'from_manager' ? own : [...managers, ...cl];
  }, [contacts.data, clients.data, v.kind, box.linked_manager_ids]);
  const kinds = (v.dir === 'in' ? ['from_manager', 'income', 'transfer', 'other'] : ['expense', 'transfer', 'other']).map((k) => ({ value: k, label: KIND_HE[k] }));
  async function save() {
    setBusy(true); setError(null);
    const r = await supabase.from('cash_movements').insert({
      box_id: box.id, occurred_on: v.on, amount: Math.abs(Number(v.amount)) * (v.dir === 'in' ? 1 : -1), currency: v.currency, kind: v.kind,
      party_id: v.party, party_name: v.party ? null : v.partyName.trim() || null, notes: v.notes.trim() || null,
    });
    setBusy(false);
    if (r.error) { setError(r.error.message); return; }
    notifications.show({ color: 'teal', message: 'נרשם' });
    await qc.invalidateQueries({ queryKey: ['cash-movements', box.id] });
    onClose();
  }
  return (
    <Modal opened onClose={onClose} title={`תנועה ב${box.name}`} size="lg">
      <Stack>
        <SegmentedControl value={v.dir} onChange={(x) => setV({ ...v, dir: x as 'in' | 'out', kind: x === 'in' ? 'from_manager' : 'expense', party: null })}
          data={[{ value: 'in', label: 'נכנס לקופה' }, { value: 'out', label: 'יצא מהקופה' }]} />
        <SimpleGrid cols={{ base: 1, sm: 3 }}>
          <DateInput label="תאריך" required value={v.on} onChange={(d) => setV({ ...v, on: d ? dayjs(d).format('YYYY-MM-DD') : null })} valueFormat="DD.MM.YYYY" />
          <Select label="סוג" data={kinds} value={v.kind} allowDeselect={false} onChange={(x) => x && setV({ ...v, kind: x, party: null })} />
          <Group gap="xs" wrap="nowrap" align="flex-end">
            <NumberInput label="סכום" required min={0} thousandSeparator="," value={v.amount} onChange={(x) => setV({ ...v, amount: x === '' ? '' : Number(x) })} style={{ flex: 1 }} />
            <Select w={90} data={CURRENCIES} value={v.currency} allowDeselect={false} onChange={(x) => x && setV({ ...v, currency: x as Currency })} />
          </Group>
        </SimpleGrid>
        <SimpleGrid cols={{ base: 1, sm: 2 }}>
          <Select label={v.kind === 'from_manager' ? 'ממי' : v.kind === 'to_client' ? 'לאיזה לקוח' : 'עם מי (לא חובה)'} searchable clearable data={people} value={v.party}
            onChange={(x) => setV({ ...v, party: x })} nothingFoundMessage="לא נמצא" />
          {!v.party && <TextInput label="או שם חופשי" value={v.partyName} onChange={(e) => setV({ ...v, partyName: e.currentTarget.value })} />}
        </SimpleGrid>
        {v.kind === 'from_manager' && box.linked_manager_ids.length > 0 && <Text size="xs" c="dimmed">הכסף של ויטאלי ושל ירח נכנס לקופה לבד מהדוחות שאושרו, ולכן לא מזינים אותו כאן.</Text>}
        <TextInput label="פירוט" value={v.notes} onChange={(e) => setV({ ...v, notes: e.currentTarget.value })} />
        {error && <Alert color="red">{error}</Alert>}
        <Group justify="flex-end"><Button variant="default" onClick={onClose}>ביטול</Button>
          <Button onClick={save} loading={busy} disabled={!v.on || !v.amount || (v.kind === 'from_manager' && !v.party && !v.partyName.trim())}>שמירה</Button></Group>
      </Stack>
    </Modal>
  );
}

// A sum Gershon sent to us (decision 114): date, amount, currency.
function SendToOffice({ box, onClose }: { box: Box; onClose: () => void }) {
  const qc = useQueryClient();
  const [v, setV] = useState({ on: dayjs().format('YYYY-MM-DD') as string | null, amount: '' as number | '', currency: (box.country_code === 'UA' ? 'UAH' : 'ILS') as Currency, notes: '' });
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  async function save() {
    setBusy(true); setError(null);
    const r = await supabase.from('cash_movements').insert({ box_id: box.id, occurred_on: v.on, amount: -Math.abs(Number(v.amount)), currency: v.currency, kind: 'to_office', party_name: 'המשרד', notes: v.notes.trim() || null });
    setBusy(false);
    if (r.error) { setError(r.error.message); return; }
    notifications.show({ color: 'teal', message: 'נרשם. עכשיו אפשר לחלק את הסכום' });
    await qc.invalidateQueries({ queryKey: ['cash-movements', box.id] });
    onClose();
  }
  return (
    <Modal opened onClose={onClose} title="גרשון העביר אלינו" size="md">
      <Stack>
        <DateInput label="תאריך" required value={v.on} onChange={(d) => setV({ ...v, on: d ? dayjs(d).format('YYYY-MM-DD') : null })} valueFormat="DD.MM.YYYY" />
        <Group gap="xs" wrap="nowrap" align="flex-end">
          <NumberInput label="סכום" required min={0} thousandSeparator="," value={v.amount} onChange={(x) => setV({ ...v, amount: x === '' ? '' : Number(x) })} style={{ flex: 1 }} />
          <Select w={90} data={CURRENCIES} value={v.currency} allowDeselect={false} onChange={(x) => x && setV({ ...v, currency: x as Currency })} />
        </Group>
        <TextInput label="פירוט (לא חובה)" value={v.notes} onChange={(e) => setV({ ...v, notes: e.currentTarget.value })} />
        {error && <Alert color="red">{error}</Alert>}
        <Group justify="flex-end"><Button variant="default" onClick={onClose}>ביטול</Button><Button onClick={save} loading={busy} disabled={!v.on || !v.amount}>שמירה</Button></Group>
      </Stack>
    </Modal>
  );
}

const OFFICE = '__office__';
interface Part { to: string | null; amount: number | ''; account: string | null }

// Dividing a sum sent to us: each line goes to a client (out of the client's money in the
// box, posted to the client's accounts) or to the office as fees.
function Divide({ box, sum, left, onClose }: { box: Box; sum: CashMovement; left: number; onClose: () => void }) {
  const qc = useQueryClient();
  const clients = useClients();
  const [parts, setParts] = useState<Part[]>([{ to: null, amount: '', account: null }]);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const clientIds = [...new Set(parts.map((p) => p.to).filter((x): x is string => !!x && x !== OFFICE))];
  // The clients' money held in this box, in the sum's currency, with the balance.
  const accounts = useQuery({
    queryKey: ['box-accounts', box.id, clientIds, sum.currency], enabled: clientIds.length > 0,
    queryFn: async () => {
      const rows = must(await supabase.from('accounts').select('id, kind, currency, beneficiary_party_id, holder_party_id, holder:parties!accounts_holder_party_id_fkey(display_name), entries(amount, transactions!inner(status))')
        .in('beneficiary_party_id', clientIds).in('kind', ['manager_cash', 'rent_pool']).eq('currency', sum.currency)) as unknown as
        { id: string; kind: string; beneficiary_party_id: string; holder_party_id: string; holder: { display_name: string }; entries: { amount: number; transactions: { status: string } }[] }[];
      return rows.filter((a) => (a.kind === 'manager_cash' && box.linked_manager_ids.includes(a.holder_party_id)) || (a.kind === 'rent_pool' && a.holder_party_id === box.holder_party_id))
        .map((a) => ({ id: a.id, client: a.beneficiary_party_id, label: `${a.kind === 'rent_pool' ? 'שכירות אצל' : 'קופת'} ${a.holder.display_name}`,
          balance: Math.round(a.entries.filter((e) => e.transactions.status === 'posted').reduce((x, e) => x + Number(e.amount), 0) * 100) / 100 }))
        .sort((a, b) => b.balance - a.balance);
    },
  });
  const accountsOf = (c: string) => (accounts.data ?? []).filter((a) => a.client === c);
  const accountFor = (p: Part) => (p.to && p.to !== OFFICE ? accountsOf(p.to).find((a) => a.id === p.account) ?? accountsOf(p.to)[0] : undefined);
  const total = parts.reduce((a, p) => a + (Number(p.amount) || 0), 0);
  const set = (i: number, patch: Partial<Part>) => setParts((ps) => ps.map((p, j) => (j === i ? { ...p, ...patch } : p)));
  const options = [{ value: OFFICE, label: 'המשרד (עמלות)' }, ...(clients.data ?? []).map((c) => ({ value: c.id, label: c.display_name })).sort((a, b) => a.label.localeCompare(b.label))];
  const ready = parts.length > 0 && parts.every((p) => p.to && Number(p.amount) > 0 && (p.to === OFFICE || accountFor(p)));

  async function save() {
    setBusy(true); setError(null);
    const done: string[] = [];
    try {
      for (const p of parts) {
        if (p.to === OFFICE) {
          must(await supabase.from('cash_movements').insert({ box_id: box.id, occurred_on: sum.occurred_on, amount: -Number(p.amount), currency: sum.currency, kind: 'office_fee', party_name: 'המשרד', parent_id: sum.id }));
        } else {
          must(await supabase.rpc('cash_pay_client', { p_box: box.id, p_from_account: accountFor(p)!.id, p_amount: Number(p.amount), p_on: sum.occurred_on, p_notes: null, p_parent: sum.id }));
        }
        done.push(p.to!);
      }
      notifications.show({ color: 'teal', message: `נרשמו ${done.length} חלקים` });
      await qc.invalidateQueries();
      onClose();
    } catch (e) {
      setError(`${(e as Error).message}${done.length ? ` (${done.length} חלקים ראשונים כבר נרשמו)` : ''}`);
      await qc.invalidateQueries();
    } finally { setBusy(false); }
  }

  return (
    <Modal opened onClose={onClose} title={`חלוקה של ${money(-Number(sum.amount), sum.currency as Currency)} מ-${date(sum.occurred_on)}`} size="xl">
      <Stack>
        <Text size="sm" c="dimmed">נשאר לחלק: {money(left, sum.currency as Currency)}. לקוח: הסכום יורד מהכסף שלו בקופה ונרשם בכרטיס שלו כהעברה לחשבון הבנק שלו. המשרד: עמלות שהמשרד לקח.</Text>
        {parts.map((p, i) => {
          const acc = accountFor(p);
          return (
            <Group key={i} gap="xs" wrap="nowrap" align="flex-end">
              <Select label={i === 0 ? 'למי' : undefined} searchable data={options} value={p.to} onChange={(x) => set(i, { to: x, account: null })} style={{ flex: 1 }} nothingFoundMessage="לא נמצא" />
              {p.to && p.to !== OFFICE && (accountsOf(p.to).length > 1
                ? <Select label={i === 0 ? 'מאיזה כסף' : undefined} w={230} allowDeselect={false} value={acc?.id ?? null} onChange={(x) => set(i, { account: x })}
                    data={accountsOf(p.to).map((a) => ({ value: a.id, label: `${a.label} · ${money(a.balance, sum.currency as Currency)}` }))} />
                : <Text size="xs" w={230} c={acc ? 'dimmed' : 'red'} mb={8}>{acc ? `${acc.label} · יתרה ${money(acc.balance, sum.currency as Currency)}` : accounts.isLoading ? 'בודק…' : `אין ללקוח כסף ב-${sum.currency} בקופה`}</Text>)}
              <NumberInput label={i === 0 ? 'סכום' : undefined} w={150} min={0} thousandSeparator="," value={p.amount} onChange={(x) => set(i, { amount: x === '' ? '' : Number(x) })} />
              <ActionIcon variant="subtle" color="red" mb={4} onClick={() => setParts((ps) => ps.filter((_, j) => j !== i))} aria-label="הסרה"><IconTrash size={16} /></ActionIcon>
            </Group>
          );
        })}
        <Group justify="space-between">
          <Button size="xs" variant="light" leftSection={<IconPlus size={14} />} onClick={() => setParts((ps) => [...ps, { to: null, amount: '', account: null }])}>שורה</Button>
          <Text size="sm" c={total > left ? 'red' : undefined}>בשורות: {money(total, sum.currency as Currency)}{total > left ? ' (יותר ממה שנשאר לחלק)' : ''}</Text>
        </Group>
        {error && <Alert color="red">{error}</Alert>}
        <Group justify="flex-end"><Button variant="default" onClick={onClose}>ביטול</Button><Button onClick={save} loading={busy} disabled={!ready}>רישום החלוקה</Button></Group>
      </Stack>
    </Modal>
  );
}

export function CashBoxes() {
  const access = useAccess();
  const qc = useQueryClient();
  const boxes = useBoxes();
  const [params, setParams] = useSearchParams();
  const list = boxes.data ?? [];
  const box = list.find((b) => b.id === params.get('box')) ?? list[0] ?? null;
  const ms = useMovements(box?.id ?? null);
  const clients = useClients();
  const contacts = useContacts();
  const names = useMemo(() => new Map([...(clients.data ?? []), ...(contacts.data ?? [])].map((p) => [p.id, p.display_name])), [clients.data, contacts.data]);
  const nameOf = (m: CashMovement) => (m.party_id ? names.get(m.party_id) : null) ?? m.party_name ?? '—';
  const movements = ms.data ?? [];
  const auto = useAuto(box, names);
  const sums = summarize(movements, nameOf, auto.data ?? []);
  const sent = movements.filter((m) => m.kind === 'to_office' && !m.parent_id);
  const parts = movements.filter((m) => m.parent_id);
  const otherMs = movements.filter((m) => !m.parent_id && m.kind !== 'to_office');
  const [adding, setAdding] = useState(false);
  const [sending, setSending] = useState(false);
  const [dividing, setDividing] = useState<CashMovement | null>(null);
  const canWrite = !!box && (box.country_code ? access.canApprove(box.country_code) : access.isAdmin);
  const linked = !!box && (box.linked_manager_ids.length > 0 || !!box.holder_party_id);

  const remove = (m: CashMovement) => modals.openConfirmModal({
    title: 'מחיקה', children: <Text size="sm">{date(m.occurred_on)} · {money(Number(m.amount), m.currency as Currency)} · {nameOf(m)}
      {m.kind === 'to_office' ? '. גם החלוקה שלו תימחק, וההעברות ללקוחות יבוטלו בכרטיסים שלהם.' : m.kind === 'to_client' ? '. ההעברה תבוטל גם בכרטיס הלקוח.' : ''}</Text>,
    labels: { confirm: 'מחיקה', cancel: 'ביטול' }, confirmProps: { color: 'red' },
    onConfirm: async () => {
      const r = await supabase.rpc('cash_remove_movement', { p_movement: m.id });
      if (r.error) notifications.show({ color: 'red', message: r.error.message });
      await qc.invalidateQueries();
    },
  });
  const cur = (c: string) => c as Currency;

  return (
    <Stack>
      <Title order={2}>קופות</Title>
      {boxes.error && <Alert color="red">{(boxes.error as Error).message}</Alert>}
      {!list.length && !boxes.isLoading && <Text c="dimmed">אין קופות שאפשר לראות.</Text>}
      {list.length > 0 && <SegmentedControl w="fit-content" value={box?.id ?? ''} onChange={(id) => setParams({ box: id }, { replace: true })} data={list.map((b) => ({ value: b.id, label: b.name }))} />}
      {box && (
        <>
          {box.notes && <Text size="sm" c="dimmed">{box.notes}</Text>}
          {sums.map((s) => (
            <Paper key={s.currency} withBorder p="md">
              <Title order={4} mb="sm">{box.name} · {s.currency}</Title>
              <SimpleGrid cols={{ base: 1, sm: 4 }}>
                <Paper withBorder p="sm"><Text size="sm" c="dimmed">התקבל מהמנהלים</Text><Text fw={700} fz={22}>{money(s.received, cur(s.currency))}</Text>
                  {s.fromManagers.map((f) => <Text key={f.who} size="xs" c="dimmed">{f.who}: {money(f.amount, cur(s.currency))}</Text>)}</Paper>
                <Paper withBorder p="sm"><Text size="sm" c="dimmed">{linked ? 'גרשון העביר אלינו' : 'הועבר למשרד'}</Text><Text fw={700} fz={22}>{money(s.sentToOffice, cur(s.currency))}</Text>
                  {s.toClients > 0 && <Text size="xs" c="dimmed">ועוד ישירות ללקוחות: {money(s.toClients, cur(s.currency))}</Text>}</Paper>
                <Paper withBorder p="sm" bg="blue.0"><Text size="sm" c="dimmed">{linked ? 'אמור להיות אצל גרשון' : 'אמור להיות בקופה'}</Text><Text fw={700} fz={22}>{money(s.expected, cur(s.currency))}</Text>
                  <Text size="xs" c="dimmed">התקבל פחות מה שהועבר אלינו</Text></Paper>
                <Paper withBorder p="sm"><Text size="sm" c="dimmed">אחרי הוצאות ותנועות אחרות</Text><Text fw={700} fz={22}>{money(s.balance, cur(s.currency))}</Text>
                  <Text size="xs" c="dimmed">{s.others ? `כולל ${money(s.others, cur(s.currency))}` : 'אין הוצאות שנרשמו'}</Text></Paper>
              </SimpleGrid>
              {(auto.data ?? []).some((x) => x.currency === s.currency) && <Text size="xs" c="dimmed" mt="sm">"מהדוחות": מתעדכן לבד עם כל דוח שמאושר בקליטה (קופת ויטאלי: גבייה במזומן פחות דמי ניהול והוצאות).</Text>}
            </Paper>
          ))}

          {!box.is_office && <Paper withBorder p="md">
            <Group justify="space-between" mb="sm">
              <Title order={4}>{linked ? 'מה גרשון העביר אלינו, ולאן זה הלך' : 'העברות למשרד'} ({sent.length})</Title>
              {canWrite && <Button size="xs" leftSection={<IconPlus size={14} />} onClick={() => setSending(true)}>{linked ? 'גרשון העביר אלינו' : 'העברה למשרד'}</Button>}
            </Group>
            {!sent.length ? <Text size="sm" c="dimmed">עוד לא נרשם.</Text> : (
              <Stack gap="sm">
                {sent.map((m) => {
                  const d = division(m, parts);
                  const mine = parts.filter((p) => p.parent_id === m.id);
                  return (
                    <Paper key={m.id} withBorder p="sm">
                      <Group justify="space-between" wrap="nowrap">
                        <Group gap="sm">
                          <Text fw={600}>{date(m.occurred_on)} · {money(d.total, cur(m.currency))}</Text>
                          <Badge variant="light" color="teal">ללקוחות {money(d.toClients, cur(m.currency))}</Badge>
                          <Badge variant="light" color="grape">למשרד {money(d.officeFees, cur(m.currency))}</Badge>
                          <Badge variant="light" color={d.left === 0 ? 'gray' : d.left > 0 ? 'orange' : 'red'}>{d.left === 0 ? 'חולק כולו' : d.left > 0 ? `נשאר לחלק ${money(d.left, cur(m.currency))}` : `חולק יותר ב-${money(-d.left, cur(m.currency))}`}</Badge>
                          {m.notes && <Text size="xs" c="dimmed">{m.notes}</Text>}
                        </Group>
                        {canWrite && (
                          <Group gap={4} wrap="nowrap">
                            <Button size="compact-xs" variant="light" onClick={() => setDividing(m)}>חלוקה</Button>
                            <ActionIcon variant="subtle" color="red" onClick={() => remove(m)} aria-label="מחיקה"><IconTrash size={14} /></ActionIcon>
                          </Group>
                        )}
                      </Group>
                      {mine.length > 0 && (
                        <Table mt="xs" fz="sm" verticalSpacing={2}>
                          <Table.Tbody>{mine.map((p) => (
                            <Table.Tr key={p.id}>
                              <Table.Td>{p.kind === 'office_fee' ? 'המשרד (עמלות)' : nameOf(p)}</Table.Td>
                              <Table.Td style={{ whiteSpace: 'nowrap' }}>{money(-Number(p.amount), cur(p.currency))}</Table.Td>
                              <Table.Td><Text size="xs" c="dimmed">{p.kind === 'to_client' ? 'נרשם בכרטיס הלקוח' : ''}</Text></Table.Td>
                              <Table.Td>{canWrite && <ActionIcon size="sm" variant="subtle" color="red" onClick={() => remove(p)} aria-label="מחיקה"><IconTrash size={12} /></ActionIcon>}</Table.Td>
                            </Table.Tr>
                          ))}</Table.Tbody>
                        </Table>
                      )}
                    </Paper>
                  );
                })}
              </Stack>
            )}
          </Paper>}

          <Paper withBorder p="md">
            <Group justify="space-between" mb="sm">
              <Title order={4}>תנועות אחרות ({otherMs.length})</Title>
              {canWrite && <Button size="xs" variant="light" leftSection={<IconPlus size={14} />} onClick={() => setAdding(true)}>תנועה אחרת</Button>}
            </Group>
            {!otherMs.length ? <Text size="sm" c="dimmed">אין</Text> : (
              <Table.ScrollContainer minWidth={640}>
                <Table striped verticalSpacing={4}>
                  <Table.Thead><Table.Tr><Table.Th>תאריך</Table.Th><Table.Th>סוג</Table.Th><Table.Th>עם מי</Table.Th><Table.Th>סכום</Table.Th><Table.Th>פירוט</Table.Th><Table.Th /></Table.Tr></Table.Thead>
                  <Table.Tbody>{otherMs.map((m) => (
                    <Table.Tr key={m.id}>
                      <Table.Td style={{ whiteSpace: 'nowrap' }}>{date(m.occurred_on)}</Table.Td>
                      <Table.Td><Badge variant="light" color={Number(m.amount) > 0 ? 'teal' : 'orange'}>{KIND_HE[m.kind] ?? m.kind}</Badge></Table.Td>
                      <Table.Td>{nameOf(m)}</Table.Td>
                      <Table.Td style={{ whiteSpace: 'nowrap' }} c={Number(m.amount) < 0 ? 'red' : undefined}>{money(Number(m.amount), cur(m.currency))}</Table.Td>
                      <Table.Td><Text size="xs">{m.notes}</Text>{m.mirror_of && <Text size="xs" c="dimmed">מהחלוקה בקופה של המנהל; משתנה ונמחק שם</Text>}</Table.Td>
                      <Table.Td>{canWrite && !m.mirror_of && <ActionIcon variant="subtle" color="red" onClick={() => remove(m)} aria-label="מחיקה"><IconTrash size={12} /></ActionIcon>}</Table.Td>
                    </Table.Tr>
                  ))}</Table.Tbody>
                </Table>
              </Table.ScrollContainer>
            )}
          </Paper>
          {adding && <NewMovement box={box} onClose={() => setAdding(false)} />}
          {sending && <SendToOffice box={box} onClose={() => setSending(false)} />}
          {dividing && <Divide box={box} sum={dividing} left={division(dividing, parts).left} onClose={() => setDividing(null)} />}
        </>
      )}
    </Stack>
  );
}

// The boxes at a glance, for the statistics page (SPEC decision 116): per box and currency,
// what came in, what was sent to us, what the box should hold and its balance.
function BoxGlance({ box, names }: { box: Box; names: Map<string, string> }) {
  const ms = useMovements(box.id);
  const auto = useAuto(box, names);
  const nameOf = (m: CashMovement) => (m.party_id ? names.get(m.party_id) : null) ?? m.party_name ?? '—';
  const sums = summarize(ms.data ?? [], nameOf, auto.data ?? []);
  const linked = box.linked_manager_ids.length > 0 || !!box.holder_party_id;
  const parts = (ms.data ?? []).filter((m) => m.parent_id);
  const sent = (ms.data ?? []).filter((m) => m.kind === 'to_office' && !m.parent_id);
  return (
    <Paper withBorder p="sm">
      <Group justify="space-between" mb={6}><Text fw={600}>{box.name}</Text><Anchor component={Link} to={`/cash?box=${box.id}`} size="xs">לקופה</Anchor></Group>
      {ms.isLoading || auto.isLoading ? <Text size="sm" c="dimmed">טוען…</Text> : !sums.length ? <Text size="sm" c="dimmed">אין תנועות</Text> : sums.map((s) => {
        const c = s.currency as Currency;
        const fees = parts.filter((p) => p.kind === 'office_fee' && p.currency === s.currency).reduce((a, p) => a - Number(p.amount), 0);
        const toClients = parts.filter((p) => p.kind === 'to_client' && p.currency === s.currency).reduce((a, p) => a - Number(p.amount), 0);
        const left = sent.filter((m) => m.currency === s.currency).reduce((a, m) => a + division(m, parts).left, 0);
        return (
          <Table key={s.currency} fz="sm" verticalSpacing={2} mb={4}>
            <Table.Tbody>
              {linked ? <>
                <Table.Tr><Table.Td>התקבל מהמנהלים</Table.Td><Table.Td ta="left">{money(s.received, c)}</Table.Td></Table.Tr>
                <Table.Tr><Table.Td>הועבר אלינו</Table.Td><Table.Td ta="left">{money(s.sentToOffice, c)}</Table.Td></Table.Tr>
                <Table.Tr><Table.Td c="dimmed">· מזה ללקוחות</Table.Td><Table.Td ta="left" c="dimmed">{money(toClients, c)}</Table.Td></Table.Tr>
                <Table.Tr><Table.Td c="dimmed">· מזה עמלות למשרד</Table.Td><Table.Td ta="left" c="dimmed">{money(fees, c)}</Table.Td></Table.Tr>
                {left !== 0 && <Table.Tr><Table.Td c="orange">· עוד לא חולק</Table.Td><Table.Td ta="left" c="orange">{money(left, c)}</Table.Td></Table.Tr>}
                <Table.Tr fw={700}><Table.Td>אמור להיות בקופה</Table.Td><Table.Td ta="left">{money(s.expected, c)}</Table.Td></Table.Tr>
              </> : (
                <Table.Tr fw={700}><Table.Td>יתרה</Table.Td><Table.Td ta="left">{money(s.balance, c)}</Table.Td></Table.Tr>
              )}
            </Table.Tbody>
          </Table>
        );
      })}
    </Paper>
  );
}

export function CashOverview() {
  const boxes = useBoxes();
  const clients = useClients();
  const contacts = useContacts();
  const names = useMemo(() => new Map([...(clients.data ?? []), ...(contacts.data ?? [])].map((p) => [p.id, p.display_name])), [clients.data, contacts.data]);
  if (boxes.error || !boxes.data?.length) return null;   // no box this user may see
  return (
    <Paper withBorder p="md">
      <Title order={3} mb="sm">קופות</Title>
      <SimpleGrid cols={{ base: 1, md: 2 }}>{boxes.data.map((b) => <BoxGlance key={b.id} box={b} names={names} />)}</SimpleGrid>
    </Paper>
  );
}
