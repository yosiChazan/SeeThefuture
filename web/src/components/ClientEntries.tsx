import { Alert, Badge, Button, Checkbox, Group, Modal, NumberInput, Paper, SegmentedControl, Select, SimpleGrid, Stack, Table, Text, TextInput, Title } from '@mantine/core';
import { DateInput, MonthPickerInput } from '@mantine/dates';
import { modals } from '@mantine/modals';
import { notifications } from '@mantine/notifications';
import { IconPlus } from '@tabler/icons-react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import dayjs from 'dayjs';
import { useMemo, useState } from 'react';
import { useAccess } from '../lib/access';
import { ACCOUNT_KIND_HE, CATEGORY_HE, COUNTRY_HE, date, money, propertyTitle } from '../lib/format';
import { must, supabase } from '../lib/supabase';
import type { Account, Country, Currency, Property } from '../lib/types';
import { useMe } from './ManualTopics';
import { CURRENCIES, EXPENSE, INCOME, linkTransferToBox } from './PropertyEntries';

// A movement on a client, not on a property (SPEC decision 176): money that belongs to this
// client alone - a transfer to them, a fee, a payment on their behalf - with an apartment of
// theirs only as a label, or none. It is not split between owners. As on a property's card
// (decision 103): an editor saves it as waiting, finance approves it (or posts it at once).
// A posted one is corrected by voiding it ("מחיקה") and entering it again.

const CURRENCY_OF: Record<Country, Currency> = { UA: 'USD', RO: 'RON', GE: 'USD', GR: 'EUR' };

interface Waiting {
  id: string; occurred_on: string; category: string; description: string | null; created_by: string | null; country_code: Country;
  lines: { amount: number; currency: Currency; where: string }[];
}

function useWaiting(clientId: string) {
  return useQuery({
    queryKey: ['client-drafts', clientId],
    queryFn: async () => {
      const rows = must(await supabase.from('entries')
        .select('amount, currency, transaction:transactions!inner(id, occurred_on, category, description, status, created_by, country_code, import_batch_id), account:accounts!inner(kind, beneficiary_party_id, holder:parties!accounts_holder_party_id_fkey(display_name))')
        .eq('account.beneficiary_party_id', clientId).eq('transaction.status', 'draft').is('transaction.import_batch_id', null)) as unknown as
        { amount: number; currency: Currency; transaction: Omit<Waiting, 'lines'>; account: { kind: string; holder: { display_name: string } } }[];
      const m = new Map<string, Waiting>();
      for (const r of rows) {
        const w = m.get(r.transaction.id) ?? m.set(r.transaction.id, { ...r.transaction, lines: [] }).get(r.transaction.id)!;
        w.lines.push({ amount: Number(r.amount), currency: r.currency, where: `${ACCOUNT_KIND_HE[r.account.kind] ?? r.account.kind} · ${r.account.holder.display_name}` });
      }
      return [...m.values()].sort((a, b) => b.occurred_on.localeCompare(a.occurred_on));
    },
  });
}

function NewClientEntry({ clientId, clientName, accounts, properties, countries, onClose }:
  { clientId: string; clientName: string; accounts: Account[]; properties: Property[]; countries: Country[]; onClose: () => void }) {
  const access = useAccess();
  const qc = useQueryClient();
  const [country, setCountry] = useState<Country>(countries[0]);
  // Where money of this country can be: its cash boxes (Gershon), the managers who report in
  // it, the client's accounts there, and the client's own bank.
  const local = useQuery({
    queryKey: ['entry-holders', country],
    queryFn: async () => ({
      sources: must(await supabase.from('import_sources').select('holder:parties!import_sources_holder_party_id_fkey(id, display_name)').eq('country_code', country)) as unknown as { holder: { id: string; display_name: string } | null }[],
      boxes: ((await supabase.from('cash_boxes').select('name, holder_party_id').eq('country_code', country)).data ?? []) as { name: string; holder_party_id: string | null }[],
    }),
  });
  const holders = useMemo(() => {
    const m = new Map<string, string>();
    for (const b of local.data?.boxes ?? []) if (b.holder_party_id) m.set(`manager_cash|${b.holder_party_id}`, `מזומן אצל גרשון (${b.name})`);
    for (const a of accounts.filter((x) => x.country_code === country && x.active)) {
      const h = a.kind === 'client_bank' ? 'client' : a.holder.id;
      if (!m.has(`${a.kind}|${h}`)) m.set(`${a.kind}|${h}`, a.kind === 'client_bank' ? 'חשבון הבנק של הלקוח' : `${ACCOUNT_KIND_HE[a.kind] ?? a.kind} · ${a.holder.display_name}`);
    }
    for (const s of local.data?.sources ?? []) if (s.holder && !m.has(`manager_cash|${s.holder.id}`)) m.set(`manager_cash|${s.holder.id}`, `${ACCOUNT_KIND_HE.manager_cash} · ${s.holder.display_name}`);
    m.set('client_bank|client', 'חשבון הבנק של הלקוח');
    return [...m].map(([value, label]) => ({ value, label }));
  }, [accounts, local.data, country]);
  const props = properties.filter((p) => p.country_code === country).map((p) => ({ value: p.id, label: propertyTitle(p) }));

  const [v, setV] = useState({
    on: dayjs().format('YYYY-MM-DD') as string | null, period: dayjs().startOf('month').format('YYYY-MM-DD') as string | null,
    dir: 'out' as 'in' | 'out' | 'fx', category: 'transfer' as string | null, amount: '' as number | '', currency: CURRENCY_OF[countries[0]],
    where: null as string | null, toWhere: 'client_bank|client' as string | null, property: null as string | null, description: '', post: false,
  });
  const [fx, setFx] = useState({ toAmount: '' as number | '', toCurrency: 'UAH' as Currency, toWhere: null as string | null });
  const isFx = v.dir === 'fx';
  const isTransfer = v.dir === 'out' && v.category === 'transfer';
  const rate = isFx && Number(v.amount) > 0 && Number(fx.toAmount) > 0 ? Number(v.amount) / Number(fx.toAmount) : null;
  const cats = (v.dir === 'in' ? INCOME : EXPENSE).map((c) => ({ value: c, label: c === 'transfer' ? 'העברה ללקוח' : CATEGORY_HE[c] ?? c }));
  const ready = v.on && v.period && Number(v.amount) > 0 && v.where
    && (isFx ? Number(fx.toAmount) > 0 && fx.toCurrency !== v.currency : !!v.category)
    && (!isTransfer || (!!v.toWhere && v.toWhere !== v.where));
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function save() {
    setBusy(true); setError(null);
    let txn: string | null = null;
    try {
      const memo = v.description.trim() || null;
      const category = isFx ? 'fx' : v.category!;
      const description = memo ?? (isFx ? `המרה ${Number(v.amount).toLocaleString('en-US')} ${v.currency} ← ${Number(fx.toAmount).toLocaleString('en-US')} ${fx.toCurrency}` : isTransfer ? 'העברה ללקוח' : null);
      txn = (must(await supabase.from('transactions').insert({ country_code: country, occurred_on: v.on, period: isFx ? dayjs(v.on).startOf('month').format('YYYY-MM-DD') : v.period, category, description, status: 'draft' })
        .select('id').single()) as { id: string }).id;
      // One line on the client's account at the holder chosen.
      const line = async (where: string, amount: number, currency: Currency, fxRate: number | null) => {
        const [kind, h] = where.split('|');
        const account = must(await supabase.rpc('account_for', { p_kind: kind, p_holder: h === 'client' ? clientId : h, p_beneficiary: clientId, p_currency: currency, p_country: country })) as string;
        must(await supabase.from('entries').insert({ transaction_id: txn, account_id: account, property_id: v.property, amount, currency, fx_rate: fxRate, memo }));
      };
      const amt = Math.abs(Number(v.amount));
      if (isFx) {
        await line(v.where!, -amt, v.currency, null);
        await line(fx.toWhere ?? v.where!, Math.abs(Number(fx.toAmount)), fx.toCurrency, Math.round(rate! * 10000) / 10000);
      } else if (isTransfer) {
        await line(v.where!, -amt, v.currency, null);
        await line(v.toWhere!, amt, v.currency, null);
      } else {
        await line(v.where!, v.dir === 'in' ? amt : -amt, v.currency, null);
      }
      if (v.post) {
        must(await supabase.from('transactions').update({ status: 'posted' }).eq('id', txn));
        if (isTransfer) await linkTransferToBox(txn);
      }
      notifications.show({ color: 'teal', message: v.post ? 'התנועה נרשמה' : 'התנועה נשמרה וממתינה לאישור כספים' });
      await qc.invalidateQueries();
      onClose();
    } catch (e) {
      if (txn) await supabase.from('transactions').delete().eq('id', txn);
      setError((e as Error).message);
    } finally { setBusy(false); }
  }

  return (
    <Modal opened onClose={onClose} title={`תנועה חדשה על ${clientName}`} size="lg">
      <Stack>
        <SegmentedControl value={v.dir} onChange={(x) => setV({ ...v, dir: x as 'in' | 'out' | 'fx', category: x === 'in' ? 'other' : x === 'out' ? 'transfer' : 'fx' })}
          data={[{ value: 'in', label: 'הכנסה' }, { value: 'out', label: 'הוצאה' }, { value: 'fx', label: 'המרה' }]} />
        <SimpleGrid cols={{ base: 1, sm: 3 }}>
          {countries.length > 1 && <Select label="מדינה" data={countries.map((c) => ({ value: c, label: COUNTRY_HE[c] }))} value={country} allowDeselect={false}
            onChange={(x) => { if (x) { setCountry(x as Country); setV({ ...v, where: null, property: null, currency: CURRENCY_OF[x as Country] }); } }} />}
          <DateInput label="תאריך" required value={v.on} onChange={(d) => setV({ ...v, on: d ? dayjs(d).format('YYYY-MM-DD') : null })} valueFormat="DD.MM.YYYY" />
          {!isFx && <MonthPickerInput label="עבור חודש" required value={v.period} onChange={(d) => setV({ ...v, period: d ? dayjs(d).startOf('month').format('YYYY-MM-DD') : null })} valueFormat="MM.YYYY" />}
          {!isFx && <Select label="סוג" required data={cats} value={v.category} onChange={(x) => setV({ ...v, category: x })} allowDeselect={false} />}
        </SimpleGrid>
        <SimpleGrid cols={{ base: 1, sm: 3 }}>
          <NumberInput label={isFx ? 'סכום שהומר (יוצא)' : 'סכום'} required min={0} thousandSeparator="," decimalScale={2} value={v.amount} onChange={(x) => setV({ ...v, amount: x === '' ? '' : Number(x) })} />
          <Select label="מטבע" data={CURRENCIES} value={v.currency} allowDeselect={false} onChange={(x) => x && setV({ ...v, currency: x as Currency })} />
          <Select label="אצל מי הכסף" required data={holders} value={v.where} onChange={(x) => setV({ ...v, where: x })} placeholder="בחירת חשבון" />
        </SimpleGrid>
        {isTransfer && <Select label="לאן" required data={holders} value={v.toWhere} onChange={(x) => setV({ ...v, toWhere: x })}
          description="ההעברה יוצאת מ'אצל מי הכסף' ונכנסת לכאן, באותו סכום ובאותו מטבע. כשהכסף יוצא מקופה (למשל מגרשון), היא נרשמת גם בקופה כ'ללקוח'" />}
        {isFx && (
          <SimpleGrid cols={{ base: 1, sm: 3 }}>
            <NumberInput label="התקבל (נכנס)" required min={0} thousandSeparator="," decimalScale={2} value={fx.toAmount} onChange={(x) => setFx({ ...fx, toAmount: x === '' ? '' : Number(x) })}
              description={rate ? `שער: ${Math.round(rate * 10000) / 10000} ${v.currency} ל-1 ${fx.toCurrency}` : ' '} />
            <Select label="למטבע" data={CURRENCIES.filter((c) => c !== v.currency)} value={fx.toCurrency} allowDeselect={false} onChange={(x) => x && setFx({ ...fx, toCurrency: x as Currency })} />
            <Select label="לאן (אם לא אותו מקום)" data={holders} value={fx.toWhere} onChange={(x) => setFx({ ...fx, toWhere: x })} placeholder="אותו מקום" clearable />
          </SimpleGrid>
        )}
        <Select label="דירה (לא חובה)" data={props} value={v.property} onChange={(x) => setV({ ...v, property: x })} placeholder="בלי דירה: על הלקוח" clearable
          description="רק לציון. הסכום כולו של הלקוח הזה, בלי חלוקה בין בעלים" />
        <TextInput label="פירוט" value={v.description} onChange={(e) => setV({ ...v, description: e.currentTarget.value })} placeholder="למשל: העברה לחשבון בישראל" />
        {access.canApprove(country) && <Checkbox label="לרשום מיד (אישור כספים)" checked={v.post} onChange={(e) => setV({ ...v, post: e.currentTarget.checked })} />}
        {error && <Alert color="red">{error}</Alert>}
        <Group justify="flex-end">
          <Button variant="default" onClick={onClose}>ביטול</Button>
          <Button onClick={save} loading={busy} disabled={!ready}>{v.post ? 'רישום' : 'שמירה לאישור'}</Button>
        </Group>
      </Stack>
    </Modal>
  );
}

// The "new movement" button of a client's ledger and the client's movements waiting for finance.
export function ClientEntries({ clientId, clientName, accounts, properties }: { clientId: string; clientName: string; accounts: Account[]; properties: Property[] }) {
  const access = useAccess();
  const me = useMe();
  const qc = useQueryClient();
  const waiting = useWaiting(clientId);
  const [adding, setAdding] = useState(false);
  const countries = [...new Set([...properties.map((p) => p.country_code), ...accounts.map((a) => a.country_code)])].filter((c) => access.canEdit(c)) as Country[];
  const refresh = () => qc.invalidateQueries();
  const approve = async (w: Waiting) => {
    const r = await supabase.from('transactions').update({ status: 'posted' }).eq('id', w.id);
    if (!r.error && w.category === 'transfer') { try { await linkTransferToBox(w.id); } catch (e) { notifications.show({ color: 'orange', message: `נרשם, אבל לא נוסף לקופה: ${(e as Error).message}` }); } }
    notifications.show(r.error ? { color: 'red', message: r.error.message } : { color: 'teal', message: 'התנועה אושרה ונרשמה' });
    await refresh();
  };
  const remove = (w: Waiting) => {
    let typed = '';
    const id = modals.open({
      title: 'מחיקת תנועה שלא אושרה',
      children: (
        <Stack>
          <Text size="sm">{date(w.occurred_on)} · {CATEGORY_HE[w.category] ?? w.category}</Text>
          <TextInput label='לאישור, כתבו "מחיקה"' onChange={(e) => { typed = e.currentTarget.value; }} />
          <Group justify="flex-end">
            <Button variant="default" onClick={() => modals.close(id)}>חזרה</Button>
            <Button color="red" onClick={async () => {
              if (typed.trim() !== 'מחיקה') { notifications.show({ color: 'orange', message: 'כדי למחוק צריך לכתוב "מחיקה"' }); return; }
              const r = await supabase.from('transactions').delete().eq('id', w.id);
              if (r.error) notifications.show({ color: 'red', message: r.error.message });
              modals.close(id); await refresh();
            }}>מחיקה</Button>
          </Group>
        </Stack>
      ),
    });
  };
  const list = waiting.data ?? [];
  return (
    <>
      <Group justify="space-between" mb="sm">
        <Title order={4}>תנועות</Title>
        {countries.length > 0 && <Button size="xs" variant="light" leftSection={<IconPlus size={14} />} onClick={() => setAdding(true)}>תנועה חדשה על הלקוח</Button>}
      </Group>
      {list.length > 0 && (
        <Paper withBorder p="sm" mb="md" bg="yellow.0">
          <Group gap="xs" mb="xs"><Badge color="yellow">ממתינות לאישור כספים</Badge><Text size="sm">{list.length}</Text></Group>
          <Table fz="sm" verticalSpacing={4}>
            <Table.Tbody>{list.map((w) => (
              <Table.Tr key={w.id}>
                <Table.Td style={{ whiteSpace: 'nowrap' }}>{date(w.occurred_on)}</Table.Td>
                <Table.Td>{CATEGORY_HE[w.category] ?? w.category}{w.description ? ` · ${w.description}` : ''}</Table.Td>
                <Table.Td>{w.lines.map((l, i) => <div key={i}>{money(l.amount, l.currency)} <Text span size="xs" c="dimmed">{l.where}</Text></div>)}</Table.Td>
                <Table.Td><Group gap={4} wrap="nowrap" justify="flex-end">
                  {access.canApprove(w.country_code) && <Button size="compact-xs" color="teal" onClick={() => approve(w)}>אישור</Button>}
                  {(access.canApprove(w.country_code) || w.created_by === me) && <Button size="compact-xs" variant="subtle" color="red" onClick={() => remove(w)}>מחיקה</Button>}
                </Group></Table.Td>
              </Table.Tr>
            ))}</Table.Tbody>
          </Table>
        </Paper>
      )}
      {adding && <NewClientEntry clientId={clientId} clientName={clientName} accounts={accounts} properties={properties} countries={countries} onClose={() => setAdding(false)} />}
    </>
  );
}
