import { Alert, Badge, Button, Checkbox, Group, Modal, NumberInput, Paper, SegmentedControl, Select, SimpleGrid, Stack, Table, Text, TextInput, Title } from '@mantine/core';
import { DateInput, MonthPickerInput } from '@mantine/dates';
import { modals } from '@mantine/modals';
import { notifications } from '@mantine/notifications';
import { IconPlus } from '@tabler/icons-react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import dayjs from 'dayjs';
import { useMemo, useState } from 'react';
import { useAccess } from '../lib/access';
import { ACCOUNT_KIND_HE, CATEGORY_HE, date, money } from '../lib/format';
import { useMe } from './ManualTopics';
import { AccountLedger } from './AccountLedger';
import type { EntryRow } from '../lib/queries';
import { must, supabase } from '../lib/supabase';
import type { Account, Country, Currency } from '../lib/types';

// Adding a movement to a property from its card (SPEC decision 103). An editor saves it as
// a draft; finance approves (posts) it, here or at once when finance adds it. The money
// goes to the property's owners on that date, split by their shares, in the account of
// whoever holds it (a manager's cash, or the client's own bank), exactly as an approved
// report line does (app.post_import_entry). Drafts can be deleted; posted ones only voided.

const INCOME = ['rent', 'hotel_share', 'deposit', 'other'];
const EXPENSE = ['mgmt_fee', 'utilities', 'building_fees', 'repair', 'legal_fees', 'tax_withheld', 'vat', 'brokerage', 'commission', 'deposit', 'other'];
const CURRENCIES: Currency[] = ['USD', 'EUR', 'UAH', 'RON', 'GEL', 'ILS'];
const CURRENCY_OF: Record<Country, Currency> = { UA: 'USD', RO: 'RON', GE: 'USD', GR: 'EUR' };

// A movement entered by hand on this property (no import batch), waiting or posted.
interface Draft {
  id: string; occurred_on: string; period: string; category: string; description: string | null; created_by: string | null; status: string;
  where: string;   // "<account kind>|<holder id or 'beneficiary'>", as in the form
  currency: Currency; total: number;
  lines: { amount: number; currency: Currency; who: string }[];
}

function useDrafts(propertyId: string) {
  return useQuery({
    queryKey: ['property-drafts', propertyId],
    queryFn: async () => {
      const rows = must(await supabase.from('entries')
        .select('amount, currency, transaction:transactions!inner(id, occurred_on, period, category, description, status, created_by, import_batch_id), account:accounts(kind, holder_party_id, beneficiary_party_id, holder:parties!accounts_holder_party_id_fkey(display_name), beneficiary:parties!accounts_beneficiary_party_id_fkey(display_name))')
        .eq('property_id', propertyId).in('transaction.status', ['draft', 'posted']).is('transaction.import_batch_id', null)) as unknown as
        { amount: number; currency: Currency; transaction: Omit<Draft, 'lines' | 'where' | 'currency' | 'total'>;
          account: { kind: string; holder_party_id: string; beneficiary_party_id: string; holder: { display_name: string }; beneficiary: { display_name: string } } | null }[];
      const m = new Map<string, Draft>();
      for (const r of rows) {
        const a = r.account;
        const where = a ? `${a.kind}|${a.kind === 'client_bank' || a.holder_party_id === a.beneficiary_party_id ? 'beneficiary' : a.holder_party_id}` : '';
        const d = m.get(r.transaction.id) ?? m.set(r.transaction.id, { ...r.transaction, where, currency: r.currency, total: 0, lines: [] }).get(r.transaction.id)!;
        d.total += Number(r.amount);
        d.lines.push({ amount: Number(r.amount), currency: r.currency, who: a ? `${a.beneficiary.display_name} (אצל ${a.holder.display_name})` : '' });
      }
      return [...m.values()].sort((a, b) => b.occurred_on.localeCompare(a.occurred_on));
    },
  });
}

function NewEntry({ propertyId, country, accounts, editing, onClose }: { propertyId: string; country: Country; accounts: Account[]; editing?: Draft; onClose: () => void }) {
  const access = useAccess();
  const qc = useQueryClient();
  const managers = useQuery({
    queryKey: ['property-managers', propertyId],
    queryFn: async () => must(await supabase.from('management_agreements').select('manager:parties!management_agreements_manager_party_id_fkey(id, display_name), valid_to')
      .eq('property_id', propertyId)) as unknown as { manager: { id: string; display_name: string }; valid_to: string | null }[],
  });
  // The managers who report in this country (their import sources) and the cash boxes of
  // this country: money can be with any of them even before the property has an account there.
  const local = useQuery({
    queryKey: ['entry-holders', country],
    queryFn: async () => ({
      sources: must(await supabase.from('import_sources').select('holder:parties!import_sources_holder_party_id_fkey(id, display_name)').eq('country_code', country)) as unknown as { holder: { id: string; display_name: string } | null }[],
      boxes: ((await supabase.from('cash_boxes').select('name, holder_party_id').eq('country_code', country)).data ?? []) as { name: string; holder_party_id: string | null }[],
    }),
  });
  // Where the money is (SPEC decisions 103, 118): a cash box of the country (Gershon's), the
  // accounts this property already uses, every current manager's and every reporting
  // manager's cash, and the client's own bank account.
  const holders = useMemo(() => {
    const m = new Map<string, string>();
    // The box's holder's cash is the box (decision 121): "מזומן אצל גרשון".
    for (const b of local.data?.boxes ?? []) if (b.holder_party_id) m.set(`manager_cash|${b.holder_party_id}`, `מזומן אצל גרשון (${b.name})`);
    for (const a of accounts) {
      const holder = a.kind === 'client_bank' ? 'beneficiary' : a.holder.id;
      if (!m.has(`${a.kind}|${holder}`)) m.set(`${a.kind}|${holder}`, a.kind === 'client_bank' ? 'חשבון הבנק של הלקוח' : `${ACCOUNT_KIND_HE[a.kind] ?? a.kind} · ${a.holder.display_name}`);
    }
    const cash = (id: string, name: string) => { if (!m.has(`manager_cash|${id}`)) m.set(`manager_cash|${id}`, `${ACCOUNT_KIND_HE.manager_cash} · ${name}`); };
    for (const g of managers.data ?? []) if (!g.valid_to) cash(g.manager.id, g.manager.display_name);
    for (const s of local.data?.sources ?? []) if (s.holder) cash(s.holder.id, s.holder.display_name);
    m.set('client_bank|beneficiary', 'חשבון הבנק של הלקוח');
    if (editing && !m.has(editing.where)) m.set(editing.where, editing.lines[0]?.who || 'החשבון של התנועה');
    return [...m].map(([value, label]) => ({ value, label }));
  }, [accounts, managers.data, local.data, editing]);

  const [v, setV] = useState(editing ? {
    on: editing.occurred_on as string | null, period: editing.period as string | null, dir: (editing.total < 0 ? 'out' : 'in') as 'in' | 'out',
    category: editing.category as string | null, amount: Math.abs(editing.total) as number | '', currency: editing.currency, where: editing.where as string | null,
    description: editing.description ?? '', post: false,
  } : {
    on: dayjs().format('YYYY-MM-DD') as string | null, period: dayjs().startOf('month').format('YYYY-MM-DD') as string | null,
    dir: 'in' as 'in' | 'out', category: 'rent' as string | null, amount: '' as number | '', currency: CURRENCY_OF[country], where: null as string | null, description: '',
    post: false,
  });
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const cats = (v.dir === 'in' ? INCOME : EXPENSE).map((c) => ({ value: c, label: CATEGORY_HE[c] ?? c }));
  const ready = v.on && v.period && v.category && v.amount && v.where;

  async function save() {
    setBusy(true); setError(null);
    let txn: string | null = null;
    try {
      const amount = Math.abs(Number(v.amount)) * (v.dir === 'in' ? 1 : -1);
      const [kind, holder] = v.where!.split('|');
      if (editing) {
        must(await supabase.rpc('edit_manual_entry', { p_txn: editing.id, p_on: v.on, p_period: v.period, p_category: v.category, p_description: v.description.trim() || null,
          p_amount: amount, p_currency: v.currency, p_kind: kind, p_holder: holder === 'beneficiary' ? null : holder }));
        notifications.show({ color: 'teal', message: editing.status === 'posted' ? 'התנועה תוקנה: הקודמת בוטלה והמתוקנת נרשמה' : 'התנועה עודכנה' });
        await qc.invalidateQueries();   // the property's and the owners' ledgers
        onClose();
        return;
      }
      txn = (must(await supabase.from('transactions').insert({ country_code: country, occurred_on: v.on, period: v.period, category: v.category, description: v.description.trim() || null, status: 'draft' })
        .select('id').single()) as { id: string }).id;
      must(await supabase.rpc('post_import_entry', {
        p_txn: txn, p_property: propertyId, p_source_holder: holder === 'beneficiary' ? null : holder, p_country: country, p_on: v.on,
        e: { amount, currency: v.currency, memo: v.description.trim() || null, account: { kind, holder: holder === 'beneficiary' ? 'beneficiary' : 'source' } },
      }));
      if (v.post) must(await supabase.from('transactions').update({ status: 'posted' }).eq('id', txn));
      notifications.show({ color: 'teal', message: v.post ? 'התנועה נרשמה' : 'התנועה נשמרה וממתינה לאישור כספים' });
      await qc.invalidateQueries({ queryKey: ['property-drafts', propertyId] });
      await qc.invalidateQueries({ queryKey: ['property-entries', propertyId] });
      onClose();
    } catch (e) {
      if (txn) await supabase.from('transactions').delete().eq('id', txn);
      setError((e as Error).message.includes('has no owner') ? 'לנכס אין בעלים בתאריך הזה' : (e as Error).message);
    } finally { setBusy(false); }
  }

  return (
    <Modal opened onClose={onClose} title={editing ? 'עריכת תנועה' : 'תנועה חדשה בנכס'} size="lg">
      <Stack>
        <SegmentedControl value={v.dir} onChange={(x) => setV({ ...v, dir: x as 'in' | 'out', category: x === 'in' ? 'rent' : 'repair' })}
          data={[{ value: 'in', label: 'הכנסה' }, { value: 'out', label: 'הוצאה' }]} />
        <SimpleGrid cols={{ base: 1, sm: 3 }}>
          <DateInput label="תאריך" required value={v.on} onChange={(d) => setV({ ...v, on: d ? dayjs(d).format('YYYY-MM-DD') : null })} valueFormat="DD.MM.YYYY" />
          <MonthPickerInput label="עבור חודש" required value={v.period} onChange={(d) => setV({ ...v, period: d ? dayjs(d).startOf('month').format('YYYY-MM-DD') : null })} valueFormat="MM.YYYY" />
          <Select label="סוג" required data={cats} value={v.category} onChange={(x) => setV({ ...v, category: x })} allowDeselect={false} />
        </SimpleGrid>
        <SimpleGrid cols={{ base: 1, sm: 3 }}>
          <NumberInput label="סכום" required min={0} thousandSeparator="," value={v.amount} onChange={(x) => setV({ ...v, amount: x === '' ? '' : Number(x) })} />
          <Select label="מטבע" data={CURRENCIES} value={v.currency} allowDeselect={false} onChange={(x) => x && setV({ ...v, currency: x as Currency })} />
          <Select label="אצל מי הכסף" required data={holders} value={v.where} onChange={(x) => setV({ ...v, where: x })} placeholder="בחירת חשבון" />
        </SimpleGrid>
        <TextInput label="פירוט" value={v.description} onChange={(e) => setV({ ...v, description: e.currentTarget.value })} placeholder="למשל: תיקון דוד מים" />
        <Text size="xs" c="dimmed">הסכום מתחלק בין הבעלים של הנכס בתאריך הזה לפי האחוזים שלהם. בלי המרת מטבע: המטבע צריך להיות של החשבון.</Text>
        {!editing && access.canApprove(country) && <Checkbox label="לרשום מיד (אישור כספים)" checked={v.post} onChange={(e) => setV({ ...v, post: e.currentTarget.checked })} />}
        {editing?.status === 'posted' && <Text size="xs" c="dimmed">התנועה כבר נרשמה: היא לא משתנה, אלא מבוטלת ונרשמת במקומה תנועה מתוקנת (שתיהן נשארות בהיסטוריה).</Text>}
        {error && <Alert color="red">{error}</Alert>}
        <Group justify="flex-end">
          <Button variant="default" onClick={onClose}>ביטול</Button>
          <Button onClick={save} loading={busy} disabled={!ready}>{editing ? 'שמירת התיקון' : v.post ? 'רישום' : 'שמירה לאישור'}</Button>
        </Group>
      </Stack>
    </Modal>
  );
}

export function PropertyEntries({ propertyId, country, accounts, children }: { propertyId: string; country: Country; accounts: Account[]; children: React.ReactNode }) {
  const access = useAccess();
  const me = useMe();
  const qc = useQueryClient();
  const drafts = useDrafts(propertyId);
  const [adding, setAdding] = useState(false);
  const [editing, setEditing] = useState<Draft | null>(null);
  const refresh = async () => { await qc.invalidateQueries({ queryKey: ['property-drafts', propertyId] }); await qc.invalidateQueries({ queryKey: ['property-entries', propertyId] }); };
  const approve = async (d: Draft) => {
    const r = await supabase.from('transactions').update({ status: 'posted' }).eq('id', d.id);
    notifications.show(r.error ? { color: 'red', message: r.error.message } : { color: 'teal', message: 'התנועה אושרה ונרשמה' });
    await refresh();
  };
  const remove = (d: Draft) => modals.openConfirmModal({
    title: 'מחיקת תנועה שלא אושרה', children: <Text size="sm">{date(d.occurred_on)} · {CATEGORY_HE[d.category] ?? d.category}</Text>,
    labels: { confirm: 'מחיקה', cancel: 'ביטול' }, confirmProps: { color: 'red' },
    onConfirm: async () => { const r = await supabase.from('transactions').delete().eq('id', d.id); if (r.error) notifications.show({ color: 'red', message: r.error.message }); await refresh(); },
  });
  const all = drafts.data ?? [];
  const list = all.filter((d) => d.status === 'draft');
  // Who may edit (decision 119): its author or an admin; a posted one is voided and re-entered,
  // which is finance's to do, so its author needs finance rights too.
  const canEditDraft = (d: Draft) => access.isAdmin || d.created_by === me;
  return (
    <Paper withBorder p="md">
      <Group justify="space-between" mb={4}>
        <Title order={4}>תנועות</Title>
        {access.canEdit(country) && <Button size="xs" variant="light" leftSection={<IconPlus size={14} />} onClick={() => setAdding(true)}>תנועה חדשה</Button>}
      </Group>
      <Text size="xs" c="dimmed" mb="sm">התנועות של הנכס הזה בכל חשבון, לפי הבעלים. תנועה חדשה נכנסת לחשבון אחרי אישור כספים.</Text>
      {list.length > 0 && (
        <Paper withBorder p="sm" mb="md" bg="yellow.0">
          <Group gap="xs" mb="xs"><Badge color="yellow">ממתינות לאישור כספים</Badge><Text size="sm">{list.length}</Text></Group>
          <Table fz="sm" verticalSpacing={4}>
            <Table.Tbody>{list.map((d) => (
              <Table.Tr key={d.id}>
                <Table.Td style={{ whiteSpace: 'nowrap' }}>{date(d.occurred_on)}</Table.Td>
                <Table.Td>{CATEGORY_HE[d.category] ?? d.category}{d.description ? ` · ${d.description}` : ''}</Table.Td>
                <Table.Td>{d.lines.map((l, i) => <div key={i}>{money(l.amount, l.currency)} <Text span size="xs" c="dimmed">{l.who}</Text></div>)}</Table.Td>
                <Table.Td><Group gap={4} wrap="nowrap" justify="flex-end">
                  {canEditDraft(d) && <Button size="compact-xs" variant="light" onClick={() => setEditing(d)}>עריכה</Button>}
                  {access.canApprove(country) && <Button size="compact-xs" color="teal" onClick={() => approve(d)}>אישור</Button>}
                  {(access.canApprove(country) || d.created_by === me) && <Button size="compact-xs" variant="subtle" color="red" onClick={() => remove(d)}>מחיקה</Button>}
                </Group></Table.Td>
              </Table.Tr>
            ))}</Table.Tbody>
          </Table>
        </Paper>
      )}
      {children}
      {adding && <NewEntry propertyId={propertyId} country={country} accounts={accounts} onClose={() => setAdding(false)} />}
      {editing && <NewEntry propertyId={propertyId} country={country} accounts={accounts} editing={editing} onClose={() => setEditing(null)} />}
    </Paper>
  );
}

// The edit button on a ledger row (SPEC decision 119): a movement entered by hand (no import
// batch, not a payment from a cash box), by its author with finance rights, or an admin.
export function useCanEditEntry() {
  const access = useAccess();
  const me = useMe();
  return (e: EntryRow) => e.transaction.import_batch_id === null && e.transaction.status === 'posted'
    && !(e.transaction.category === 'transfer' && (e.transaction.description ?? '').startsWith('העברה ללקוח'))
    && (access.isAdmin || (!!me && e.transaction.created_by === me && !!e.transaction.country_code && access.canApprove(e.transaction.country_code as Country)));
}

// Opens the edit form for one transaction, read from its entries.
function EditTransaction({ txnId, onClose }: { txnId: string; onClose: () => void }) {
  const q = useQuery({
    queryKey: ['manual-txn', txnId],
    queryFn: async () => {
      const rows = must(await supabase.from('entries')
        .select('amount, currency, property_id, transaction:transactions!inner(id, occurred_on, period, category, description, status, created_by, country_code), account:accounts(kind, holder_party_id, beneficiary_party_id, holder:parties!accounts_holder_party_id_fkey(display_name), beneficiary:parties!accounts_beneficiary_party_id_fkey(display_name))')
        .eq('transaction_id', txnId)) as unknown as { amount: number; currency: Currency; property_id: string; transaction: Draft & { country_code: Country };
          account: { kind: string; holder_party_id: string; beneficiary_party_id: string; holder: { display_name: string }; beneficiary: { display_name: string } } }[];
      const a = rows[0].account;
      const draft: Draft = { ...rows[0].transaction, currency: rows[0].currency, total: rows.reduce((x, r) => x + Number(r.amount), 0),
        where: `${a.kind}|${a.kind === 'client_bank' || a.holder_party_id === a.beneficiary_party_id ? 'beneficiary' : a.holder_party_id}`,
        lines: rows.map((r) => ({ amount: Number(r.amount), currency: r.currency, who: `${r.account.beneficiary.display_name} (אצל ${r.account.holder.display_name})` })) };
      return { draft, propertyId: rows[0].property_id, country: rows[0].transaction.country_code };
    },
  });
  if (!q.data) return null;
  return <NewEntry propertyId={q.data.propertyId} country={q.data.country} accounts={[]} editing={q.data.draft} onClose={onClose} />;
}

// A ledger whose rows entered by hand carry an edit button.
export function EditableLedger({ accounts, entries, property = false }: { accounts: Account[]; entries: EntryRow[]; property?: boolean }) {
  const can = useCanEditEntry();
  const [txn, setTxn] = useState<string | null>(null);
  return (
    <>
      <AccountLedger accounts={accounts} entries={entries} property={property} edit={{ can, open: setTxn }} />
      {txn && <EditTransaction txnId={txn} onClose={() => setTxn(null)} />}
    </>
  );
}
