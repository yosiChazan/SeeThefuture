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

export const INCOME = ['rent', 'hotel_share', 'deposit', 'other'];
export const EXPENSE = ['transfer', 'mgmt_fee', 'office_fee', 'utilities', 'building_fees', 'repair', 'legal_fees', 'tax_withheld', 'vat', 'brokerage', 'commission', 'deposit', 'other'];
export const CURRENCIES: Currency[] = ['USD', 'EUR', 'UAH', 'RON', 'GEL', 'ILS'];
const CURRENCY_OF: Record<Country, Currency> = { UA: 'USD', RO: 'RON', GE: 'USD', GR: 'EUR' };

// A transfer to the client out of a box's money (decision 152): once posted, it is also the box's
// "to the client" line, as a payment made from the box is (decision 113), so the box counts it.
export async function linkTransferToBox(txnId: string) {
  const rows = must(await supabase.from('entries').select('amount, currency, account:accounts(kind, holder_party_id, beneficiary_party_id), transaction:transactions!inner(occurred_on, description, category, status)')
    .eq('transaction_id', txnId)) as unknown as { amount: number; currency: string; account: { kind: string; holder_party_id: string; beneficiary_party_id: string } | null; transaction: { occurred_on: string; description: string | null; category: string; status: string } }[];
  const out = rows.filter((x) => Number(x.amount) < 0 && x.account?.kind === 'manager_cash');
  const to = rows.find((x) => Number(x.amount) > 0);
  if (!out.length || !to || rows[0].transaction.category !== 'transfer' || rows[0].transaction.status !== 'posted') return;
  const holder = out[0].account!.holder_party_id;
  const boxes = must(await supabase.from('cash_boxes').select('id, holder_party_id, linked_manager_ids')) as { id: string; holder_party_id: string | null; linked_manager_ids: string[] }[];
  const box = boxes.find((b) => b.holder_party_id === holder || b.linked_manager_ids.includes(holder));
  if (!box) return;
  const exists = must(await supabase.from('cash_movements').select('id').eq('transaction_id', txnId).limit(1)) as unknown[];
  if (exists.length) return;
  must(await supabase.from('cash_movements').insert({
    box_id: box.id, occurred_on: rows[0].transaction.occurred_on, amount: out.reduce((a, x) => a + Number(x.amount), 0), currency: out[0].currency,
    kind: 'to_client', party_id: to.account?.beneficiary_party_id ?? null, notes: rows[0].transaction.description, transaction_id: txnId,
  }));
}

// A movement entered by hand on this property (no import batch), waiting or posted.
interface Draft {
  id: string; occurred_on: string; period: string; category: string; description: string | null; created_by: string | null; status: string;
  where: string;   // "<account kind>|<holder id or 'beneficiary'>", as in the form
  currency: Currency; total: number;
  lines: { amount: number; currency: Currency; who: string; where: string }[];
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
        d.lines.push({ amount: Number(r.amount), currency: r.currency, who: a ? `${a.beneficiary.display_name} (אצל ${a.holder.display_name})` : '', where });
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

  // A conversion being edited: what went out (the negative lines) and what came in.
  const twoSided = (c?: string | null) => c === 'fx' || c === 'transfer';
  const fxOut = twoSided(editing?.category) ? editing!.lines.filter((l) => l.amount < 0) : [];
  const fxIn = twoSided(editing?.category) ? editing!.lines.filter((l) => l.amount > 0) : [];
  const sumOf = (ls: { amount: number }[]) => Math.round(Math.abs(ls.reduce((a, l) => a + l.amount, 0)) * 100) / 100;
  const [v, setV] = useState(twoSided(editing?.category) ? {
    on: editing!.occurred_on as string | null, period: editing!.period as string | null, dir: (editing!.category === 'fx' ? 'fx' : 'out') as 'in' | 'out' | 'fx',
    category: editing!.category as string | null, amount: sumOf(fxOut) as number | '', currency: (fxOut[0]?.currency ?? editing!.currency) as Currency, where: (fxOut[0]?.where ?? editing!.where) as string | null,
    description: editing!.description ?? '', post: false,
  } : editing ? {
    on: editing.occurred_on as string | null, period: editing.period as string | null, dir: (editing.total < 0 ? 'out' : 'in') as 'in' | 'out' | 'fx',
    category: editing.category as string | null, amount: Math.abs(editing.total) as number | '', currency: editing.currency, where: editing.where as string | null,
    description: editing.description ?? '', post: false,
  } : {
    on: dayjs().format('YYYY-MM-DD') as string | null, period: dayjs().startOf('month').format('YYYY-MM-DD') as string | null,
    dir: 'in' as 'in' | 'out' | 'fx', category: 'rent' as string | null, amount: '' as number | '', currency: CURRENCY_OF[country], where: null as string | null, description: '',
    post: false,
  });
  // A conversion (decision 149): one transaction, two entries in two currencies, with the
  // same holder by default (Gershon's hryvnia into Gershon's dollars).
  const [fx, setFx] = useState(fxIn.length ? {
    toAmount: sumOf(fxIn) as number | '', toCurrency: fxIn[0].currency, toWhere: (fxIn[0].where !== fxOut[0]?.where ? fxIn[0].where : null) as string | null,
  } : { toAmount: '' as number | '', toCurrency: (CURRENCY_OF[country] === 'USD' ? 'UAH' : 'USD') as Currency, toWhere: null as string | null });
  const isFx = v.dir === 'fx';
  // A transfer to the client (decision 152): out of where the money is, into the client's bank.
  const isTransfer = v.dir === 'out' && v.category === 'transfer';
  const [toWhere, setToWhere] = useState<string | null>(editing?.category === 'transfer' ? fxIn[0]?.where ?? 'client_bank|beneficiary' : 'client_bank|beneficiary');
  const rate = isFx && Number(v.amount) > 0 && Number(fx.toAmount) > 0 ? Number(v.amount) / Number(fx.toAmount) : null;
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const cats = (v.dir === 'in' ? INCOME : EXPENSE).map((c) => ({ value: c, label: c === 'transfer' ? 'העברה ללקוח' : CATEGORY_HE[c] ?? c }));
  const ready = v.on && v.period && v.amount && v.where && (isFx ? Number(fx.toAmount) > 0 && fx.toCurrency !== v.currency : v.category) && (!isTransfer || (!!toWhere && toWhere !== v.where));

  // Saves a new movement from the form (a conversion: two entries), waiting or posted.
  async function create(post: boolean): Promise<string> {
    let txn: string | null = null;
    const amount = Math.abs(Number(v.amount)) * (v.dir === 'in' ? 1 : -1);
    const [kind, holder] = v.where!.split('|');
    try {
      if (isFx) {
        const [toKind, toHolder] = (fx.toWhere ?? v.where!).split('|');
        const r4 = Math.round(rate! * 10000) / 10000;
        const desc = v.description.trim() || `המרה ${Number(v.amount).toLocaleString('en-US')} ${v.currency} ← ${Number(fx.toAmount).toLocaleString('en-US')} ${fx.toCurrency} (שער ${r4})`;
        txn = (must(await supabase.from('transactions').insert({ country_code: country, occurred_on: v.on, period: v.period, category: 'fx', description: desc, status: 'draft' })
          .select('id').single()) as { id: string }).id;
        const side = (amt: number, cur: Currency, k: string, h: string, rateOf: number | null) => supabase.rpc('post_import_entry', {
          p_txn: txn, p_property: propertyId, p_source_holder: h === 'beneficiary' ? null : h, p_country: country, p_on: v.on,
          e: { amount: amt, currency: cur, memo: v.description.trim() || null, ...(rateOf ? { fx_rate: rateOf } : {}), account: { kind: k, holder: h === 'beneficiary' ? 'beneficiary' : 'source' } },
        });
        must(await side(-Math.abs(Number(v.amount)), v.currency, kind, holder, null));
        must(await side(Math.abs(Number(fx.toAmount)), fx.toCurrency, toKind, toHolder, r4));
      } else if (isTransfer) {
        const [toKind, toHolder] = toWhere!.split('|');
        txn = (must(await supabase.from('transactions').insert({ country_code: country, occurred_on: v.on, period: v.period, category: 'transfer', description: v.description.trim() || 'העברה ללקוח', status: 'draft' })
          .select('id').single()) as { id: string }).id;
        const side = (amt: number, k: string, h: string) => supabase.rpc('post_import_entry', {
          p_txn: txn, p_property: propertyId, p_source_holder: h === 'beneficiary' ? null : h, p_country: country, p_on: v.on,
          e: { amount: amt, currency: v.currency, memo: v.description.trim() || null, account: { kind: k, holder: h === 'beneficiary' ? 'beneficiary' : 'source' } },
        });
        must(await side(-Math.abs(Number(v.amount)), kind, holder));
        must(await side(Math.abs(Number(v.amount)), toKind, toHolder));
      } else {
      txn = (must(await supabase.from('transactions').insert({ country_code: country, occurred_on: v.on, period: v.period, category: v.category, description: v.description.trim() || null, status: 'draft' })
        .select('id').single()) as { id: string }).id;
      must(await supabase.rpc('post_import_entry', {
        p_txn: txn, p_property: propertyId, p_source_holder: holder === 'beneficiary' ? null : holder, p_country: country, p_on: v.on,
        e: { amount, currency: v.currency, memo: v.description.trim() || null, account: { kind, holder: holder === 'beneficiary' ? 'beneficiary' : 'source' } },
      }));
      }
      if (post) {
        must(await supabase.from('transactions').update({ status: 'posted' }).eq('id', txn));
        await linkTransferToBox(txn!);
      }
      return txn!;
    } catch (e) {
      if (txn) await supabase.from('transactions').delete().eq('id', txn);
      throw e;
    }
  }

  async function save() {
    setBusy(true); setError(null);
    try {
      const amount = Math.abs(Number(v.amount)) * (v.dir === 'in' ? 1 : -1);
      const [kind, holder] = v.where!.split('|');
      // A conversion, or an entry turned into one or out of one (decision 151): the new one is
      // saved as the old one was (waiting, or posted), then the old one goes (deleted while
      // waiting; voided once posted, so both stay in the history).
      if (editing && (isFx || isTransfer || twoSided(editing.category))) {
        const posted = editing.status === 'posted';
        const fresh = await create(posted);
        if (posted) await supabase.from('cash_movements').delete().eq('transaction_id', editing.id);   // its box line, if any
        const gone = posted ? await supabase.from('transactions').update({ status: 'void' }).eq('id', editing.id).select('id')
          : await supabase.from('transactions').delete().eq('id', editing.id).select('id');
        if (gone.error || !gone.data?.length) {
          if (posted) await supabase.from('transactions').update({ status: 'void' }).eq('id', fresh); else await supabase.from('transactions').delete().eq('id', fresh);
          throw new Error(gone.error?.message ?? 'אין הרשאה להחליף את התנועה');
        }
        notifications.show({ color: 'teal', message: posted ? 'התנועה תוקנה: הקודמת בוטלה והמתוקנת נרשמה' : 'התנועה עודכנה' });
        await qc.invalidateQueries();
        onClose();
        return;
      }
      if (editing) {
        must(await supabase.rpc('edit_manual_entry', { p_txn: editing.id, p_on: v.on, p_period: v.period, p_category: v.category, p_description: v.description.trim() || null,
          p_amount: amount, p_currency: v.currency, p_kind: kind, p_holder: holder === 'beneficiary' ? null : holder }));
        notifications.show({ color: 'teal', message: editing.status === 'posted' ? 'התנועה תוקנה: הקודמת בוטלה והמתוקנת נרשמה' : 'התנועה עודכנה' });
        await qc.invalidateQueries();   // the property's and the owners' ledgers
        onClose();
        return;
      }
      await create(v.post);
      notifications.show({ color: 'teal', message: v.post ? 'התנועה נרשמה' : 'התנועה נשמרה וממתינה לאישור כספים' });
      await qc.invalidateQueries({ queryKey: ['property-drafts', propertyId] });
      await qc.invalidateQueries({ queryKey: ['property-entries', propertyId] });
      onClose();
    } catch (e) {
      setError((e as Error).message.includes('has no owner') ? 'לנכס אין בעלים בתאריך הזה' : (e as Error).message);
    } finally { setBusy(false); }
  }

  return (
    <Modal opened onClose={onClose} title={editing ? 'עריכת תנועה' : 'תנועה חדשה בנכס'} size="lg">
      <Stack>
        <SegmentedControl value={v.dir} onChange={(x) => setV({ ...v, dir: x as 'in' | 'out' | 'fx', category: x === 'in' ? 'rent' : x === 'out' ? 'repair' : 'fx', ...(x === 'fx' && v.on ? { period: dayjs(v.on).startOf('month').format('YYYY-MM-DD') } : {}) })}
          data={[{ value: 'in', label: 'הכנסה' }, { value: 'out', label: 'הוצאה' }, { value: 'fx', label: 'המרה' }]} />
        <SimpleGrid cols={{ base: 1, sm: 3 }}>
          {/* A conversion has no "for month": its month is the date's (decision 150). */}
          <DateInput label="תאריך" required value={v.on} onChange={(d) => setV({ ...v, on: d ? dayjs(d).format('YYYY-MM-DD') : null, ...(isFx ? { period: d ? dayjs(d).startOf('month').format('YYYY-MM-DD') : null } : {}) })} valueFormat="DD.MM.YYYY" />
          {!isFx && <MonthPickerInput label="עבור חודש" required value={v.period} onChange={(d) => setV({ ...v, period: d ? dayjs(d).startOf('month').format('YYYY-MM-DD') : null })} valueFormat="MM.YYYY" />}
          {!isFx && <Select label="סוג" required data={cats} value={v.category} onChange={(x) => setV({ ...v, category: x })} allowDeselect={false} />}
        </SimpleGrid>
        <SimpleGrid cols={{ base: 1, sm: 3 }}>
          <NumberInput label={isFx ? 'סכום שהומר (יוצא)' : 'סכום'} required min={0} thousandSeparator="," value={v.amount} onChange={(x) => setV({ ...v, amount: x === '' ? '' : Number(x) })} />
          <Select label="מטבע" data={CURRENCIES} value={v.currency} allowDeselect={false} onChange={(x) => x && setV({ ...v, currency: x as Currency })} />
          <Select label="אצל מי הכסף" required data={holders} value={v.where} onChange={(x) => setV({ ...v, where: x })} placeholder="בחירת חשבון" />
        </SimpleGrid>
        {isTransfer && (
          <Select label="לאן (קופת הלקוח)" required data={holders} value={toWhere} onChange={setToWhere}
            description="ההעברה יוצאת מ'אצל מי הכסף' ונכנסת לכאן, באותו סכום ובאותו מטבע. כשהכסף יוצא מקופה (למשל מגרשון), היא נרשמת גם בקופה כ'ללקוח'" />
        )}
        {isFx && (
          <SimpleGrid cols={{ base: 1, sm: 3 }}>
            <NumberInput label="התקבל (נכנס)" required min={0} thousandSeparator="," decimalScale={2} value={fx.toAmount} onChange={(x) => setFx({ ...fx, toAmount: x === '' ? '' : Number(x) })}
              description={rate ? `שער: ${Math.round(rate * 10000) / 10000} ${v.currency} ל-1 ${fx.toCurrency}` : ' '} />
            <Select label="למטבע" data={CURRENCIES.filter((c) => c !== v.currency)} value={fx.toCurrency} allowDeselect={false} onChange={(x) => x && setFx({ ...fx, toCurrency: x as Currency })} />
            <Select label="לאן (אם לא אותו מקום)" data={holders} value={fx.toWhere} onChange={(x) => setFx({ ...fx, toWhere: x })} placeholder="אותו מקום" clearable />
          </SimpleGrid>
        )}
        <TextInput label="פירוט" value={v.description} onChange={(e) => setV({ ...v, description: e.currentTarget.value })} placeholder="למשל: תיקון דוד מים" />
        <Text size="xs" c="dimmed">{isFx
          ? 'המרה היא תנועה אחת עם שתי שורות: הסכום יוצא במטבע אחד ונכנס במטבע השני, אצל אותו מחזיק (או במקום שבחרת). הסכומים מתחלקים בין הבעלים לפי האחוזים שלהם.'
          : 'הסכום מתחלק בין הבעלים של הנכס בתאריך הזה לפי האחוזים שלהם. בלי המרת מטבע: המטבע צריך להיות של החשבון.'}</Text>
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
    if (!r.error && d.category === 'transfer') { try { await linkTransferToBox(d.id); } catch (e) { notifications.show({ color: 'orange', message: `נרשם, אבל לא נוסף לקופה: ${(e as Error).message}` }); } }
    notifications.show(r.error ? { color: 'red', message: r.error.message } : { color: 'teal', message: 'התנועה אושרה ונרשמה' });
    await refresh();
  };
  // Deleting a waiting movement asks for the word "מחיקה" (decision 153).
  const remove = (d: Draft) => {
    let typed = '';
    const id = modals.open({
      title: 'מחיקת תנועה שלא אושרה',
      children: (
        <Stack>
          <Text size="sm">{date(d.occurred_on)} · {CATEGORY_HE[d.category] ?? d.category}</Text>
          <TextInput label='לאישור, כתבו "מחיקה"' onChange={(e) => { typed = e.currentTarget.value; }} />
          <Group justify="flex-end">
            <Button variant="default" onClick={() => modals.close(id)}>חזרה</Button>
            <Button color="red" onClick={async () => {
              if (typed.trim() !== 'מחיקה') { notifications.show({ color: 'orange', message: 'כדי למחוק צריך לכתוב "מחיקה"' }); return; }
              const r = await supabase.from('transactions').delete().eq('id', d.id);
              if (r.error) notifications.show({ color: 'red', message: r.error.message });
              modals.close(id); await refresh();
            }}>מחיקה</Button>
          </Group>
        </Stack>
      ),
    });
  };
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
    // A movement on the client with no apartment (decision 176) is corrected by voiding it and entering it again.
    && !!e.property
    // A payment made from a box ("העברה ללקוח מקופת…") is edited in the box; one entered on a card here (decision 152).
    && !(e.transaction.category === 'transfer' && (e.transaction.description ?? '').startsWith('העברה ללקוח מ'))
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
        lines: rows.map((r) => ({ amount: Number(r.amount), currency: r.currency, who: `${r.account.beneficiary.display_name} (אצל ${r.account.holder.display_name})`,
          where: `${r.account.kind}|${r.account.kind === 'client_bank' || r.account.holder_party_id === r.account.beneficiary_party_id ? 'beneficiary' : r.account.holder_party_id}` })) };
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
