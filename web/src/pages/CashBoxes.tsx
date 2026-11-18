import { Alert, Anchor, Badge, Button, Collapse, Group, Modal, NumberInput, Paper, SegmentedControl, Select, SimpleGrid, Stack, Table, Text, TextInput, Title, Tooltip } from '@mantine/core';
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
import { date, money, propertyTitle } from '../lib/format';
import { useClients, useContacts } from '../lib/queries';
import { must, supabase } from '../lib/supabase';
import type { Country, Currency } from '../lib/types';
import { useAccess } from '../lib/access';
import { useMe } from '../components/ManualTopics';

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
    queryFn: async () => must(await supabase.from('cash_movements').select('id, occurred_on, amount, currency, kind, party_id, party_name, notes, created_by, parent_id, transaction_id, mirror_of, fx_rate, fx_transaction_id')
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
      type Row = { amount: number; currency: string; accounts: { kind: string; holder_party_id: string; beneficiary_party_id: string }; transactions: { category: string; import_batch_id: string | null } };
      // Yarach's monthly charge (decision 141) is the clients' due from Gershon, not cash he got:
      // what Yarach really sent is entered in the box as received from him.
      const accrualSources = (must(await supabase.from('import_sources').select('id').eq('adapter', 'yarach_accrual')) as { id: string }[]).map((x) => x.id);
      const accrual = new Set(accrualSources.length ? (must(await supabase.from('import_batches').select('id').in('source_id', accrualSources)) as { id: string }[]).map((x) => x.id) : []);
      const load = async (kind: string, holders: string[], transfers = false) => {
        const out: Row[] = [];
        if (!holders.length) return out;
        for (let at = 0; ; at += 1000) {
          const page = must(await supabase.from('entries').select('amount, currency, accounts!inner(kind, holder_party_id, beneficiary_party_id), transactions!inner(status, category, import_batch_id)')
            .eq('accounts.kind', kind).in('accounts.holder_party_id', holders).eq('transactions.status', 'posted')
            // A payment to a client is counted once, as "handed to clients": not again here.
            [transfers ? 'eq' : 'neq']('transactions.category', 'transfer').order('id').range(at, at + 999)) as unknown as Row[];
          out.push(...page.filter((r) => !r.transactions.import_batch_id || !accrual.has(r.transactions.import_batch_id)));
          if (page.length < 1000) return out;
        }
      };
      const holder = box!.holder_party_id ? [box!.holder_party_id] : [];
      const rows = [...await load('manager_cash', [...box!.linked_manager_ids, ...holder]), ...await load('rent_pool', holder)];
      const m = new Map<string, AutoIn>();
      for (const r of rows) {
        const fx = r.transactions.category === 'fx';
        const who = fx ? 'המרות' : r.accounts.holder_party_id === box!.holder_party_id
          ? (r.accounts.kind === 'rent_pool' ? 'שכירות מירח אצל גרשון' : 'מזומן אצל גרשון: מהדוחות ומכרטיסי הנכסים')
          : `${names.get(r.accounts.holder_party_id) ?? 'מנהל'}, מהדוחות`;
        const k = `${who}|${r.currency}`;
        const a = m.get(k) ?? m.set(k, { who, currency: r.currency, amount: 0, fx }).get(k)!;
        a.amount += Number(r.amount);
      }
      // What a conversion left in a client's dollars, euros or shekels after the transfer to the
      // client (decision 125): the client's debt to Gershon or credit with him, not cash in the box.
      const transfers = (await load('manager_cash', [...box!.linked_manager_ids, ...holder], true)).filter((r) => r.currency !== 'UAH');
      const fxClients = new Set(rows.filter((r) => r.transactions.category === 'fx' && r.currency !== 'UAH').map((r) => `${r.accounts.beneficiary_party_id}|${r.currency}`));
      for (const r of [...rows.filter((x) => x.currency !== 'UAH' && x.transactions.category === 'fx'), ...transfers]) {
        if (!fxClients.has(`${r.accounts.beneficiary_party_id}|${r.currency}`)) continue;
        const k = `residual|${r.currency}`;
        const a = m.get(k) ?? m.set(k, { who: 'residual', currency: r.currency, amount: 0, residual: true }).get(k)!;
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

// A sum Gershon sent to us (decision 114): date, amount, currency; in dollars or euros also
// the rate (decision 123), so that each client's part is converted from the client's hryvnia.
function SendToOffice({ box, onClose }: { box: Box; onClose: () => void }) {
  const qc = useQueryClient();
  const [v, setV] = useState({ on: dayjs().format('YYYY-MM-DD') as string | null, amount: '' as number | '', currency: (box.country_code === 'UA' ? 'USD' : 'ILS') as Currency, rate: '' as number | '', notes: '' });
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const withRate = box.country_code === 'UA' && v.currency !== 'UAH';
  async function save() {
    setBusy(true); setError(null);
    const r = await supabase.from('cash_movements').insert({ box_id: box.id, occurred_on: v.on, amount: -Math.abs(Number(v.amount)), currency: v.currency, kind: 'to_office', party_name: 'המשרד',
      fx_rate: withRate && Number(v.rate) > 0 ? Number(v.rate) : null, notes: v.notes.trim() || null });
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
        {withRate && <NumberInput label={`שער: כמה גריבנה ל-1 ${v.currency}`} decimalScale={4} min={0} value={v.rate} onChange={(x) => setV({ ...v, rate: x === '' ? '' : Number(x) })}
          description="עם שער: החלק של כל לקוח מומר מהגריבנה שלו אצל גרשון ומועבר לו. בלי שער: משלמים ממה שכבר יש ללקוח במטבע הזה" />}
        <TextInput label="פירוט (לא חובה)" value={v.notes} onChange={(e) => setV({ ...v, notes: e.currentTarget.value })} />
        {error && <Alert color="red">{error}</Alert>}
        <Group justify="flex-end"><Button variant="default" onClick={onClose}>ביטול</Button><Button onClick={save} loading={busy} disabled={!v.on || !v.amount}>שמירה</Button></Group>
      </Stack>
    </Modal>
  );
}

const OFFICE = '__office__';
interface Part { to: string | null; amount: number | ''; account: string | null; uah: number | '' }

// Dividing a sum sent to us: each line goes to a client (out of the client's money in the
// box, posted to the client's accounts) or to the office as fees. A sum with a rate
// (decision 123): the client's part is converted from the client's hryvnia in the box at the
// rate (by default the part times the rate; it can be set, as in Gershon's Excel), then paid.
function Divide({ box, sum, left, onClose }: { box: Box; sum: CashMovement; left: number; onClose: () => void }) {
  const qc = useQueryClient();
  const clients = useClients();
  const [parts, setParts] = useState<Part[]>([{ to: null, amount: '', account: null, uah: '' }]);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const rate = sum.fx_rate ? Number(sum.fx_rate) : null;
  const from = rate ? 'UAH' : sum.currency;
  const clientIds = [...new Set(parts.map((p) => p.to).filter((x): x is string => !!x && x !== OFFICE))];
  // The clients' money held in this box, in the sum's currency, with the balance.
  const accounts = useQuery({
    queryKey: ['box-accounts', box.id, clientIds, from], enabled: clientIds.length > 0,
    queryFn: async () => {
      const rows = must(await supabase.from('accounts').select('id, kind, currency, beneficiary_party_id, holder_party_id, holder:parties!accounts_holder_party_id_fkey(display_name), entries(amount, transactions!inner(status))')
        .in('beneficiary_party_id', clientIds).in('kind', rate ? ['manager_cash'] : ['manager_cash', 'rent_pool']).eq('currency', from)) as unknown as
        { id: string; kind: string; beneficiary_party_id: string; holder_party_id: string; holder: { display_name: string }; entries: { amount: number; transactions: { status: string } }[] }[];
      return rows.filter((a) => (a.kind === 'manager_cash' && (box.linked_manager_ids.includes(a.holder_party_id) || a.holder_party_id === box.holder_party_id)) || (a.kind === 'rent_pool' && a.holder_party_id === box.holder_party_id))
        .map((a) => ({ id: a.id, client: a.beneficiary_party_id, label: a.holder_party_id === box.holder_party_id ? (a.kind === 'rent_pool' ? 'שכירות מירח אצל גרשון' : 'מזומן אצל גרשון') : `מזומן אצל ${a.holder.display_name}`,
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
        if (p.to === OFFICE && box.holder_party_id) {
          // The office's money at the holder (STF fees, decision 146) moves to the office.
          must(await supabase.rpc('cash_office_fee', { p_box: box.id, p_amount: Number(p.amount), p_uah: p.uah === '' ? null : Number(p.uah), p_on: sum.occurred_on, p_notes: null, p_parent: sum.id }));
        } else if (p.to === OFFICE) {
          must(await supabase.from('cash_movements').insert({ box_id: box.id, occurred_on: sum.occurred_on, amount: -Number(p.amount), currency: sum.currency, kind: 'office_fee', party_name: 'המשרד', parent_id: sum.id }));
        } else {
          if (rate) must(await supabase.rpc('cash_pay_client_fx', { p_box: box.id, p_from: accountFor(p)!.id, p_amount: Number(p.amount), p_uah: p.uah === '' ? null : Number(p.uah), p_on: sum.occurred_on, p_notes: null, p_parent: sum.id }));
          else must(await supabase.rpc('cash_pay_client', { p_box: box.id, p_from_account: accountFor(p)!.id, p_amount: Number(p.amount), p_on: sum.occurred_on, p_notes: null, p_parent: sum.id }));
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
        <Text size="sm" c="dimmed">נשאר לחלק: {money(left, sum.currency as Currency)}. {rate
          ? `לקוח: הגריבנה שלו אצל גרשון מומרת בשער ${rate} (המרה בכרטיס שלו), והסכום ב-${sum.currency} מועבר לחשבון הבנק שלו. מה שהומר מעבר לסכום נשאר לו ב-${sum.currency} (מינוס = חייב לקופה).`
          : 'לקוח: הסכום יורד מהכסף שלו בקופה ונרשם בכרטיס שלו כהעברה לחשבון הבנק שלו.'} המשרד: עמלות שהמשרד לקח.</Text>
        {parts.map((p, i) => {
          const acc = accountFor(p);
          return (
            <Group key={i} gap="xs" wrap="nowrap" align="flex-end">
              <Select label={i === 0 ? 'למי' : undefined} searchable data={options} value={p.to} onChange={(x) => set(i, { to: x, account: null })} style={{ flex: 1 }} nothingFoundMessage="לא נמצא" />
              {p.to && p.to !== OFFICE && (accountsOf(p.to).length > 1
                ? <Select label={i === 0 ? 'מאיזה כסף' : undefined} w={230} allowDeselect={false} value={acc?.id ?? null} onChange={(x) => set(i, { account: x })}
                    data={accountsOf(p.to).map((a) => ({ value: a.id, label: `${a.label} · ${money(a.balance, from as Currency)}` }))} />
                : <Text size="xs" w={230} c={acc ? 'dimmed' : 'red'} mb={8}>{acc ? `${acc.label} · יתרה ${money(acc.balance, from as Currency)}` : accounts.isLoading ? 'בודק…' : `אין ללקוח כסף ב-${from} בקופה`}</Text>)}
              <NumberInput label={i === 0 ? `סכום (${sum.currency})` : undefined} w={140} min={0} thousandSeparator="," value={p.amount} onChange={(x) => set(i, { amount: x === '' ? '' : Number(x) })} />
              {rate && (p.to !== OFFICE || !!box.holder_party_id) && <NumberInput label={i === 0 ? 'הומר (₴)' : undefined} w={140} min={0} thousandSeparator="," decimalScale={2} value={p.uah}
                placeholder={Number(p.amount) > 0 ? String(Math.round(Number(p.amount) * rate * 100) / 100) : ''} onChange={(x) => set(i, { uah: x === '' ? '' : Number(x) })} />}
              {rate && p.to !== OFFICE && p.uah !== '' && Number(p.amount) > 0 && <Text size="xs" c="dimmed" w={110} mb={8}>נשאר לו {money(Math.round((Number(p.uah) / rate - Number(p.amount)) * 100) / 100, sum.currency as Currency)}</Text>}
              <ActionIcon variant="subtle" color="red" mb={4} onClick={() => setParts((ps) => ps.filter((_, j) => j !== i))} aria-label="הסרה"><IconTrash size={16} /></ActionIcon>
            </Group>
          );
        })}
        <Group justify="space-between">
          <Button size="xs" variant="light" leftSection={<IconPlus size={14} />} onClick={() => setParts((ps) => [...ps, { to: null, amount: '', account: null, uah: '' }])}>שורה</Button>
          <Text size="sm" c={total > left ? 'red' : undefined}>בשורות: {money(total, sum.currency as Currency)}{total > left ? ' (יותר ממה שנשאר לחלק)' : ''}</Text>
        </Group>
        {error && <Alert color="red">{error}</Alert>}
        <Group justify="flex-end"><Button variant="default" onClick={onClose}>ביטול</Button><Button onClick={save} loading={busy} disabled={!ready}>רישום החלוקה</Button></Group>
      </Stack>
    </Modal>
  );
}

// Editing a movement entered by hand (SPEC decision 119): date, amount and notes; its author
// or an admin. A client's part is paid again with the new amount (app.cash_edit_movement).
function EditMovement({ m, onClose }: { m: CashMovement; onClose: () => void }) {
  const qc = useQueryClient();
  const [v, setV] = useState({ on: m.occurred_on as string | null, amount: Math.abs(Number(m.amount)) as number | '', notes: m.notes ?? '' });
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  async function save() {
    setBusy(true); setError(null);
    const r = await supabase.rpc('cash_edit_movement', { p_movement: m.id, p_on: v.on, p_amount: Number(v.amount), p_notes: v.notes.trim() || null });
    setBusy(false);
    if (r.error) { setError(r.error.message); return; }
    notifications.show({ color: 'teal', message: m.transaction_id ? 'עודכן; ההעברה ללקוח נרשמה מחדש בסכום החדש' : 'עודכן' });
    await qc.invalidateQueries();
    onClose();
  }
  return (
    <Modal opened onClose={onClose} title={`עריכה: ${KIND_HE[m.kind] ?? m.kind}`} size="sm">
      <Stack>
        <DateInput label="תאריך" required value={v.on} onChange={(d) => setV({ ...v, on: d ? dayjs(d).format('YYYY-MM-DD') : null })} valueFormat="DD.MM.YYYY" />
        <NumberInput label={`סכום (${m.currency})`} required min={0} thousandSeparator="," value={v.amount} onChange={(x) => setV({ ...v, amount: x === '' ? '' : Number(x) })} />
        <TextInput label="פירוט" value={v.notes} onChange={(e) => setV({ ...v, notes: e.currentTarget.value })} />
        {m.transaction_id && <Text size="xs" c="dimmed">ההעברה בכרטיס הלקוח תבוטל ותירשם מחדש בסכום ובתאריך החדשים.</Text>}
        {error && <Alert color="red">{error}</Alert>}
        <Group justify="flex-end"><Button variant="default" onClick={onClose}>ביטול</Button><Button onClick={save} loading={busy} disabled={!v.on || !v.amount}>שמירה</Button></Group>
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
  const [editingM, setEditingM] = useState<CashMovement | null>(null);
  const me = useMe();
  const canEditM = (m: CashMovement) => canWrite && !m.mirror_of && (access.isAdmin || m.created_by === me);
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
              <SimpleGrid cols={{ base: 1, sm: s.converted ? 5 : 4 }}>
                <Paper withBorder p="sm"><Text size="sm" c="dimmed">התקבל מהמנהלים</Text><Text fw={700} fz={22}>{money(s.received, cur(s.currency))}</Text>
                  {s.fromManagers.map((f) => <Text key={f.who} size="xs" c="dimmed">{f.who}: {money(f.amount, cur(s.currency))}</Text>)}</Paper>
                {s.converted !== 0 && <Paper withBorder p="sm"><Text size="sm" c="dimmed">{convLabel(s)}</Text><Text fw={700} fz={22}>{money(s.converted, cur(s.currency))}</Text>
                  <Text size="xs" c="dimmed">{s.converted < 0 ? 'גריבנה של לקוחות שהומרה לפני העברה אליהם' : 'מהגריבנה של הלקוחות, לפני ההעברה אליהם'}</Text>
                  {s.residual !== 0 && <Text size="xs" c="dimmed">מזה נשאר ללקוחות כיתרה מול גרשון (לא בקופה): {money(s.residual, cur(s.currency))}</Text>}</Paper>}
                <Paper withBorder p="sm"><Text size="sm" c="dimmed">{linked ? 'גרשון העביר אלינו' : 'הועבר למשרד'}</Text><Text fw={700} fz={22}>{money(s.sentToOffice, cur(s.currency))}</Text>
                  {s.toClients > 0 && <Text size="xs" c="dimmed">ועוד ישירות ללקוחות: {money(s.toClients, cur(s.currency))}</Text>}</Paper>
                <Paper withBorder p="sm" bg="blue.0"><Text size="sm" c="dimmed">{linked ? 'אמור להיות אצל גרשון' : 'אמור להיות בקופה'}</Text><Text fw={700} fz={22}>{money(s.expected, cur(s.currency))}</Text>
                  <Text size="xs" c="dimmed">{s.converted ? 'התקבל, ± המרות, פחות מה שהועבר אלינו וללקוחות' : 'התקבל פחות מה שהועבר אלינו וללקוחות'}</Text></Paper>
                <Paper withBorder p="sm"><Text size="sm" c="dimmed">אחרי הוצאות ותנועות אחרות</Text><Text fw={700} fz={22}>{money(s.balance, cur(s.currency))}</Text>
                  <Text size="xs" c="dimmed">{s.others ? `כולל ${money(s.others, cur(s.currency))}` : 'אין הוצאות שנרשמו'}</Text></Paper>
              </SimpleGrid>
              {(auto.data ?? []).some((x) => x.currency === s.currency) && <Text size="xs" c="dimmed" mt="sm">"מהדוחות": מתעדכן לבד עם כל דוח שמאושר בקליטה (קופת ויטאלי: גבייה במזומן פחות דמי ניהול והוצאות).</Text>}
              {linked && <ByClient box={box} currency={s.currency} names={names} />}
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
                          {m.fx_rate && <Badge variant="outline" color="gray">שער {Number(m.fx_rate)}</Badge>}
                          <Badge variant="light" color="teal">ללקוחות {money(d.toClients, cur(m.currency))}</Badge>
                          <Badge variant="light" color="grape">למשרד {money(d.officeFees, cur(m.currency))}</Badge>
                          <Badge variant="light" color={d.left === 0 ? 'gray' : d.left > 0 ? 'orange' : 'red'}>{d.left === 0 ? 'חולק כולו' : d.left > 0 ? `נשאר לחלק ${money(d.left, cur(m.currency))}` : `חולק יותר ב-${money(-d.left, cur(m.currency))}`}</Badge>
                          {m.notes && <Text size="xs" c="dimmed">{m.notes}</Text>}
                        </Group>
                        {canWrite && (
                          <Group gap={4} wrap="nowrap">
                            {canEditM(m) && <Button size="compact-xs" variant="subtle" onClick={() => setEditingM(m)}>עריכה</Button>}
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
                              <Table.Td><Text size="xs" c="dimmed">{p.kind === 'to_client' ? (p.fx_transaction_id ? 'הומר והועבר, נרשם בכרטיס הלקוח' : 'נרשם בכרטיס הלקוח') : ''}</Text></Table.Td>
                              <Table.Td><Group gap={2} wrap="nowrap">
                                {canEditM(p) && <Button size="compact-xs" variant="subtle" onClick={() => setEditingM(p)}>עריכה</Button>}
                                {canWrite && <ActionIcon size="sm" variant="subtle" color="red" onClick={() => remove(p)} aria-label="מחיקה"><IconTrash size={12} /></ActionIcon>}
                              </Group></Table.Td>
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

          {box?.is_office && <OfficeAtManagers />}
          {box?.is_office && <OfficeByCity />}

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
                      <Table.Td><Group gap={2} wrap="nowrap">
                        {canEditM(m) && <Button size="compact-xs" variant="subtle" onClick={() => setEditingM(m)}>עריכה</Button>}
                        {canWrite && !m.mirror_of && <ActionIcon variant="subtle" color="red" onClick={() => remove(m)} aria-label="מחיקה"><IconTrash size={12} /></ActionIcon>}
                      </Group></Table.Td>
                    </Table.Tr>
                  ))}</Table.Tbody>
                </Table>
              </Table.ScrollContainer>
            )}
          </Paper>
          {adding && <NewMovement box={box} onClose={() => setAdding(false)} />}
          {sending && <SendToOffice box={box} onClose={() => setSending(false)} />}
          {editingM && <EditMovement m={editingM} onClose={() => setEditingM(null)} />}
          {dividing && <Divide box={box} sum={dividing} left={division(dividing, parts).left} onClose={() => setDividing(null)} />}
        </>
      )}
    </Stack>
  );
}

// A conversion line (decision 124): hryvnia that left for another currency, or the dollars,
// euros or shekels it became.
const convLabel = (s: { converted: number; currency: string }) => (s.converted < 0 ? 'הומר למטבע אחר' : 'התקבל מהמרה מגריבנה');

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
                {s.converted !== 0 && <Table.Tr><Table.Td>{convLabel(s)}</Table.Td><Table.Td ta="left">{money(s.converted, c)}</Table.Td></Table.Tr>}
                {s.toClients !== 0 && <Table.Tr><Table.Td>הועבר ישירות ללקוחות</Table.Td><Table.Td ta="left">{money(-s.toClients, c)}</Table.Td></Table.Tr>}
                {s.residual !== 0 && <Table.Tr><Table.Td c="dimmed">· יתרות לקוחות מול גרשון מההמרות (לא בקופה)</Table.Td><Table.Td ta="left" c="dimmed">{money(s.residual, c)}</Table.Td></Table.Tr>}
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

// What managers hold for the office (decision 146): Odessa's STF fees, credited to the office
// on every fee line and left with Gershon until he sends them to us. With the breakdown: by
// client and apartment, each opening to its months; or by month.
interface CreditRow { amount: number; currency: string; account_id: string; property: { id: string; unit_no: string; building: { name: string; project: { name: string } | null }; ownerships: { valid_to: string | null; party: { display_name: string } }[] } | null; transaction: { period: string; category: string; status: string } }
function OfficeAtManagers() {
  const [open, setOpen] = useState(false);
  const [by, setBy] = useState<'client' | 'month'>('client');
  const [unit, setUnit] = useState<string | null>(null);
  const q = useQuery({
    queryKey: ['office-at-managers'],
    queryFn: async () => {
      const office = must(await supabase.rpc('office_party')) as string | null;
      if (!office) return { accs: [], rows: [] as CreditRow[] };
      const accs = must(await supabase.from('accounts').select('id, currency, holder:parties!accounts_holder_party_id_fkey(display_name)').eq('kind', 'manager_cash').eq('beneficiary_party_id', office)) as unknown as { id: string; currency: string; holder: { display_name: string } }[];
      const rows: CreditRow[] = [];
      if (accs.length) for (let at = 0; ; at += 1000) {
        const page = must(await supabase.from('entries').select('amount, currency, account_id, property:properties(id, unit_no, building:buildings(name, project:projects(name)), ownerships(valid_to, party:parties(display_name))), transaction:transactions!inner(period, category, status)')
          .in('account_id', accs.map((x) => x.id)).eq('transaction.status', 'posted').order('id').range(at, at + 999)) as unknown as CreditRow[];
        rows.push(...page);
        if (page.length < 1000) break;
      }
      return { accs, rows };
    },
  });
  const accs = q.data?.accs ?? [];
  const rows = q.data?.rows ?? [];
  const totals = accs.map((a) => ({ who: a.holder.display_name, currency: a.currency, balance: Math.round(rows.filter((r) => r.account_id === a.id).reduce((x, r) => x + Number(r.amount), 0) * 100) / 100 }))
    .filter((a) => Math.abs(a.balance) > 0.005);
  if (!totals.length) return null;
  const fees = rows.filter((r) => r.transaction.category === 'office_fee');
  const paid = rows.filter((r) => r.transaction.category !== 'office_fee');   // sent to the office, conversions
  const r2 = (n: number) => Math.round(n * 100) / 100;
  const ownerOf = (p: NonNullable<CreditRow['property']>) => p.ownerships.filter((o) => !o.valid_to).map((o) => o.party.display_name).join(', ') || '—';
  const groups = [...fees.reduce((m, r) => {
    const k = r.property?.id ?? '—';
    const g = m.get(k) ?? { key: k, title: r.property ? propertyTitle(r.property) : 'בלי נכס', owner: r.property ? ownerOf(r.property) : '', total: 0, currency: r.currency, months: new Map<string, number>() };
    g.total += Number(r.amount);
    g.months.set(r.transaction.period, (g.months.get(r.transaction.period) ?? 0) + Number(r.amount));
    return m.set(k, g);
  }, new Map<string, { key: string; title: string; owner: string; total: number; currency: string; months: Map<string, number> }>()).values()]
    .sort((a, b) => a.owner.localeCompare(b.owner, 'he') || a.title.localeCompare(b.title, 'he', { numeric: true }));
  const months = [...fees.reduce((m, r) => m.set(r.transaction.period, (m.get(r.transaction.period) ?? 0) + Number(r.amount)), new Map<string, number>())].sort((a, b) => b[0].localeCompare(a[0]));
  const sentTotal = r2(paid.filter((r) => r.currency === 'UAH').reduce((x, r) => x + Number(r.amount), 0));
  return (
    <Paper withBorder p="md">
      <Group justify="space-between" mb="xs">
        <Title order={4}>מגיע למשרד ממנהלים (דמי ניהול משרד)</Title>
        <Button size="xs" variant="subtle" onClick={() => setOpen((o) => !o)}>{open ? 'הסתרת הפירוט' : 'פירוט'}</Button>
      </Group>
      <Text size="xs" c="dimmed" mb="xs">כל שורת דמי ניהול משרד נרשמת גם כזכות של המשרד, והכסף נשאר אצל המנהל (גרשון, ויטאלי) עד שהוא מעביר אותו. בחלוקה של סכום מגרשון, השורה "המשרד (עמלות)" מורידה מכאן.</Text>
      <Table fz="sm"><Table.Tbody>{totals.map((a) => (
        <Table.Tr key={a.who + a.currency}><Table.Td>אצל {a.who}</Table.Td><Table.Td><Text fw={600} size="sm">{money(a.balance, a.currency as Currency)}</Text></Table.Td></Table.Tr>
      ))}</Table.Tbody></Table>
      <Collapse in={open}>
        <Stack gap="xs" mt="sm">
          <Group justify="space-between">
            <SegmentedControl size="xs" value={by} onChange={(v) => setBy(v as 'client' | 'month')} data={[{ value: 'client', label: 'לפי לקוח ודירה' }, { value: 'month', label: 'לפי חודש' }]} />
            <Text size="xs" c="dimmed">דמי ניהול: {money(r2(fees.reduce((x, r) => x + Number(r.amount), 0)), 'UAH')}{sentTotal ? ` · הועבר למשרד: ${money(-sentTotal, 'UAH')}` : ''}</Text>
          </Group>
          {by === 'client' ? (
            <Table.ScrollContainer minWidth={520}>
              <Table fz="sm" striped highlightOnHover verticalSpacing={4}>
                <Table.Thead><Table.Tr><Table.Th>לקוח</Table.Th><Table.Th>דירה</Table.Th><Table.Th>חודשים</Table.Th><Table.Th>סכום</Table.Th></Table.Tr></Table.Thead>
                <Table.Tbody>{groups.flatMap((g) => [
                  <Table.Tr key={g.key} style={{ cursor: 'pointer' }} onClick={() => setUnit(unit === g.key ? null : g.key)}>
                    <Table.Td>{g.owner}</Table.Td><Table.Td>{unit === g.key ? '▾ ' : '▸ '}{g.title}</Table.Td><Table.Td>{g.months.size}</Table.Td>
                    <Table.Td><Text size="sm" fw={600}>{money(r2(g.total), g.currency as Currency)}</Text></Table.Td>
                  </Table.Tr>,
                  ...(unit === g.key ? [...g.months].sort((a, b) => b[0].localeCompare(a[0])).map(([m, v]) => (
                    <Table.Tr key={g.key + m}><Table.Td /><Table.Td><Text size="xs" c="dimmed" ps="md">{dayjs(m).format('MM.YYYY')}</Text></Table.Td><Table.Td /><Table.Td><Text size="xs">{money(r2(v), g.currency as Currency)}</Text></Table.Td></Table.Tr>
                  )) : []),
                ])}</Table.Tbody>
              </Table>
            </Table.ScrollContainer>
          ) : (
            <Table fz="sm" striped verticalSpacing={4}>
              <Table.Thead><Table.Tr><Table.Th>חודש</Table.Th><Table.Th>דמי ניהול</Table.Th></Table.Tr></Table.Thead>
              <Table.Tbody>{months.map(([m, v]) => <Table.Tr key={m}><Table.Td>{dayjs(m).format('MM.YYYY')}</Table.Td><Table.Td>{money(r2(v), 'UAH')}</Table.Td></Table.Tr>)}</Table.Tbody>
            </Table>
          )}
        </Stack>
      </Collapse>
    </Paper>
  );
}

// What each client's money with the box's holder (and its linked managers) did in a period, in
// one currency (decision 163): only what happened inside the period, nothing carried from before.
// The small fund for building costs (expense_pool) is a box of its own and is not here.
function ByClient({ box, currency, names }: { box: Box; currency: string; names: Map<string, string> }) {
  const [open, setOpen] = useState(false);
  const [from, setFrom] = useState<string | null>(null);   // null: from the start
  const [to, setTo] = useState<string | null>(null);       // null: today
  const [sort, setSort] = useState<{ key: 'name' | 'in' | 'out' | 'net'; desc: boolean; then?: { key: 'name' | 'in' | 'out' | 'net'; desc: boolean } }>({ key: 'name', desc: false });
  const holders = [...(box.holder_party_id ? [box.holder_party_id] : []), ...box.linked_manager_ids];
  const q = useQuery({
    queryKey: ['box-by-client', box.id, currency, from, to], enabled: open && holders.length > 0,
    queryFn: async () => {
      const out: { amount: number; accounts: { beneficiary_party_id: string } }[] = [];
      for (let at = 0; ; at += 1000) {
        let qq = supabase.from('entries').select('amount, accounts!inner(kind, currency, holder_party_id, beneficiary_party_id), transactions!inner(status, occurred_on)')
          .eq('accounts.kind', 'manager_cash').eq('accounts.currency', currency).in('accounts.holder_party_id', holders).eq('transactions.status', 'posted');
        if (from) qq = qq.gte('transactions.occurred_on', from);
        if (to) qq = qq.lte('transactions.occurred_on', to);
        const page = must(await qq.order('id').range(at, at + 999)) as unknown as { amount: number; accounts: { beneficiary_party_id: string } }[];
        out.push(...page);
        if (page.length < 1000) break;
      }
      const m = new Map<string, { in: number; out: number }>();
      for (const e of out) {
        const k = e.accounts.beneficiary_party_id, v = m.get(k) ?? { in: 0, out: 0 }, a = Number(e.amount);
        if (a > 0) v.in += a; else v.out += a;
        m.set(k, v);
      }
      return [...m].map(([id, v]) => ({ id, in: Math.round(v.in * 100) / 100, out: Math.round(v.out * 100) / 100, net: Math.round((v.in + v.out) * 100) / 100 }));
    },
  });
  const nameOf = (id: string) => names.get(id) ?? (id === box.holder_party_id ? 'גרשון' : '—');
  const val = (r: { id: string; in: number; out: number; net: number }, k: typeof sort.key) => (k === 'name' ? nameOf(r.id) : r[k]);
  const cmp = (a: { id: string; in: number; out: number; net: number }, b: typeof a, k: typeof sort.key, desc: boolean) => {
    const x = val(a, k), y = val(b, k);
    const d = typeof x === 'number' && typeof y === 'number' ? x - y : String(x).localeCompare(String(y), 'he');
    return desc ? -d : d;
  };
  const rows = [...(q.data ?? [])].sort((a, b) => cmp(a, b, sort.key, sort.desc) || (sort.then ? cmp(a, b, sort.then.key, sort.then.desc) : 0));
  const total = rows.reduce((t, r) => ({ in: t.in + r.in, out: t.out + r.out, net: t.net + r.net }), { in: 0, out: 0, net: 0 });
  const th = (k: typeof sort.key, label: string) => (
    <Table.Th style={{ cursor: 'pointer', whiteSpace: 'nowrap' }} onClick={() => setSort(sort.key === k ? { ...sort, desc: !sort.desc } : { key: k, desc: k !== 'name', then: { key: sort.key, desc: sort.desc } })}>
      {label} <Text span size="xs" c={sort.key === k ? undefined : 'dimmed'}>{sort.key === k ? (sort.desc ? '▼' : '▲') : '↕'}</Text>
    </Table.Th>
  );
  const c = currency as Currency;
  return (
    <Stack gap="xs" mt="sm">
      <Button size="xs" variant="subtle" w="fit-content" onClick={() => setOpen((o) => !o)}>{open ? 'הסתרת הפירוט לפי לקוח' : 'פירוט לפי לקוח'}</Button>
      {open && <>
        <Group gap="xs" align="flex-end">
          <DateInput size="xs" label="מתאריך" placeholder="מתחילת הספירה" clearable value={from} onChange={(d) => setFrom(d ? dayjs(d).format('YYYY-MM-DD') : null)} valueFormat="DD.MM.YYYY" w={150} />
          <DateInput size="xs" label="עד תאריך" placeholder="היום" clearable value={to} onChange={(d) => setTo(d ? dayjs(d).format('YYYY-MM-DD') : null)} valueFormat="DD.MM.YYYY" w={150} />
          <Text size="xs" c="dimmed" mb={6}>רק מה שקרה בתקופה, בלי יתרות מלפניה. בלי הקופה הקטנה.</Text>
        </Group>
        {q.isLoading ? <Text size="sm" c="dimmed">טוען…</Text> : !rows.length ? <Text size="sm" c="dimmed">אין תנועות בתקופה</Text> : (
          <Table.ScrollContainer minWidth={520}>
            <Table fz="sm" striped highlightOnHover verticalSpacing={4}>
              <Table.Thead><Table.Tr>{th('name', 'לקוח')}{th('in', 'נכנס')}{th('out', 'יצא')}{th('net', 'סה"כ בתקופה')}</Table.Tr></Table.Thead>
              <Table.Tbody>
                {rows.map((r) => (
                  <Table.Tr key={r.id}>
                    <Table.Td><Anchor component={Link} to={`/clients/${r.id}`} size="sm">{nameOf(r.id)}</Anchor></Table.Td>
                    <Table.Td>{money(r.in, c)}</Table.Td>
                    <Table.Td c={r.out < 0 ? 'red.7' : undefined}>{money(r.out, c)}</Table.Td>
                    <Table.Td fw={600}>{money(r.net, c)}</Table.Td>
                  </Table.Tr>
                ))}
                <Table.Tr fw={700}><Table.Td>סה"כ ({rows.length})</Table.Td><Table.Td>{money(Math.round(total.in * 100) / 100, c)}</Table.Td><Table.Td>{money(Math.round(total.out * 100) / 100, c)}</Table.Td><Table.Td>{money(Math.round(total.net * 100) / 100, c)}</Table.Td></Table.Tr>
              </Table.Tbody>
            </Table>
          </Table.ScrollContainer>
        )}
      </>}
    </Stack>
  );
}

// The office's fees by city (decision 165): what was credited to the office from each city's
// apartments in a period, per currency, with each city's share. A part-to-whole of a few parts: a
// segmented bar (every segment labelled by the legend and the table), not a pie.
const CITY_COLORS = ['#2a78d6', '#eb6834', '#1baf7a', '#eda100', '#e87ba4', '#008300', '#6250d6', '#e34948'];
function OfficeByCity() {
  const [from, setFrom] = useState<string | null>(null);
  const [to, setTo] = useState<string | null>(null);
  const q = useQuery({
    queryKey: ['office-by-city', from, to],
    queryFn: async () => {
      const office = must(await supabase.rpc('office_party')) as string | null;
      if (!office) return [];
      const out: { amount: number; currency: string; property: { building: { city: { name_he: string } } | null } | null }[] = [];
      for (let at = 0; ; at += 1000) {
        let qq = supabase.from('entries').select('amount, currency, accounts!inner(beneficiary_party_id), transactions!inner(status, category, occurred_on), property:properties(building:buildings(city:cities(name_he)))')
          .eq('accounts.beneficiary_party_id', office).eq('transactions.status', 'posted').eq('transactions.category', 'office_fee');
        if (from) qq = qq.gte('transactions.occurred_on', from);
        if (to) qq = qq.lte('transactions.occurred_on', to);
        const page = must(await qq.order('id').range(at, at + 999)) as unknown as typeof out;
        out.push(...page);
        if (page.length < 1000) break;
      }
      const m = new Map<string, Map<string, number>>();
      for (const e of out) {
        const city = e.property?.building?.city?.name_he ?? 'בלי נכס';
        const byCity = m.get(e.currency) ?? m.set(e.currency, new Map()).get(e.currency)!;
        byCity.set(city, (byCity.get(city) ?? 0) + Number(e.amount));
      }
      return [...m].map(([currency, byCity]) => {
        const cities = [...byCity].map(([city, amount]) => ({ city, amount: Math.round(amount * 100) / 100 })).filter((c) => c.amount !== 0).sort((a, b) => b.amount - a.amount);
        return { currency, cities, total: cities.reduce((a, c) => a + c.amount, 0) };
      });
    },
  });
  // A city keeps its color whatever the period (color follows the entity, not its rank).
  const allCities = [...new Set((q.data ?? []).flatMap((x) => x.cities.map((c) => c.city)))].sort((a, b) => a.localeCompare(b, 'he'));
  const colorOf = (city: string) => CITY_COLORS[allCities.indexOf(city) % CITY_COLORS.length];
  return (
    <Paper withBorder p="md">
      <Title order={4} mb={4}>דמי ניהול משרד, לפי עיר</Title>
      <Group gap="xs" align="flex-end" mb="sm">
        <DateInput size="xs" label="מתאריך" placeholder="מתחילת הספירה" clearable value={from} onChange={(d) => setFrom(d ? dayjs(d).format('YYYY-MM-DD') : null)} valueFormat="DD.MM.YYYY" w={150} />
        <DateInput size="xs" label="עד תאריך" placeholder="היום" clearable value={to} onChange={(d) => setTo(d ? dayjs(d).format('YYYY-MM-DD') : null)} valueFormat="DD.MM.YYYY" w={150} />
        <Text size="xs" c="dimmed" mb={6}>הזכות של המשרד מכל שורת דמי ניהול, לפי העיר של הדירה.</Text>
      </Group>
      {q.isLoading ? <Text size="sm" c="dimmed">טוען…</Text> : !(q.data ?? []).length ? <Text size="sm" c="dimmed">אין דמי ניהול בתקופה</Text> : (q.data ?? []).map((x) => (
        <Stack key={x.currency} gap={6} mb="md">
          <Text size="sm" fw={600}>{x.currency} · סה"כ {money(x.total, x.currency as Currency)}</Text>
          <div role="img" aria-label={x.cities.map((c) => `${c.city} ${Math.round((c.amount / x.total) * 100)}%`).join(', ')}
            style={{ display: 'flex', gap: 2, height: 22, borderRadius: 4, overflow: 'hidden', direction: 'rtl' }}>
            {x.cities.map((c) => (
              <Tooltip key={c.city} label={`${c.city}: ${money(c.amount, x.currency as Currency)} (${((c.amount / x.total) * 100).toFixed(1)}%)`}>
                <div style={{ flex: `${Math.max(c.amount, 0)} 0 0`, background: colorOf(c.city), minWidth: 4 }} />
              </Tooltip>
            ))}
          </div>
          <Table fz="sm" verticalSpacing={2}>
            <Table.Tbody>{x.cities.map((c) => (
              <Table.Tr key={c.city}>
                <Table.Td w={20}><div style={{ width: 10, height: 10, borderRadius: 2, background: colorOf(c.city) }} /></Table.Td>
                <Table.Td>{c.city}</Table.Td>
                <Table.Td>{money(c.amount, x.currency as Currency)}</Table.Td>
                <Table.Td c="dimmed">{((c.amount / x.total) * 100).toFixed(1)}%</Table.Td>
              </Table.Tr>
            ))}</Table.Tbody>
          </Table>
        </Stack>
      ))}
    </Paper>
  );
}
