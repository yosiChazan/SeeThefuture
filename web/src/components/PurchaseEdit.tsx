import { ActionIcon, Alert, Button, Group, Modal, NumberInput, Select, SimpleGrid, Stack, Table, Tabs, Text, TextInput, Textarea } from '@mantine/core';
import { DateInput } from '@mantine/dates';
import { modals } from '@mantine/modals';
import { notifications } from '@mantine/notifications';
import { IconPencil, IconPlus, IconTrash } from '@tabler/icons-react';
import { useQueryClient } from '@tanstack/react-query';
import dayjs from 'dayjs';
import { useState } from 'react';
import { date, money } from '../lib/format';
import { KIND_HE } from '../lib/purchase';
import { useClients, useContacts, type DealRow, type PurchasePaymentRow } from '../lib/queries';
import { must, supabase } from '../lib/supabase';
import type { Country, Currency } from '../lib/types';

// Editing the purchase of a property (SPEC decision 101): the deal (price, date, status,
// client, referrer, notes), the payments around it, and the installments still to pay.
// Purchase payments are a record, not ledger entries, so they can be corrected and removed;
// an installment already paid through the ledger cannot.

const CURRENCIES: Currency[] = ['USD', 'EUR', 'ILS', 'UAH', 'RON', 'GEL'];
const STATUS = [{ value: 'lead', label: 'ליד' }, { value: 'in_progress', label: 'בתהליך' }, { value: 'completed', label: 'הושלמה' }, { value: 'cancelled', label: 'בוטלה' }];
const day = (d: Date | string | null) => (d ? dayjs(d).format('YYYY-MM-DD') : null);

function useSave(propertyId: string) {
  const qc = useQueryClient();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const run = async (fn: () => Promise<void>, ok: string) => {
    setBusy(true); setError(null);
    try { await fn(); notifications.show({ color: 'teal', message: ok }); await qc.invalidateQueries({ queryKey: ['deals', propertyId] }); await qc.invalidateQueries({ queryKey: ['purchase_payments', propertyId] }); return true; }
    catch (e) { setError((e as Error).message); return false; } finally { setBusy(false); }
  };
  return { busy, error, run };
}

function DealForm({ propertyId, country, deal, ownerId, onDone }: { propertyId: string; country: Country; deal: DealRow | null; ownerId: string | null; onDone: () => void }) {
  const clients = useClients();
  const contacts = useContacts();
  const { busy, error, run } = useSave(propertyId);
  const [v, setV] = useState({
    status: deal?.status ?? 'completed', signed_on: deal?.signed_on ?? null as string | null, total_price: (deal?.total_price ?? '') as number | '',
    price_currency: deal?.price_currency ?? 'USD', client: deal?.client?.id ?? ownerId, referrer: deal?.referrer?.id ?? null as string | null, notes: deal?.notes ?? '',
  });
  const people = [...(clients.data ?? []), ...(contacts.data ?? [])].map((p) => ({ value: p.id, label: p.display_name }));
  const unique = [...new Map(people.map((p) => [p.value, p])).values()].sort((a, b) => a.label.localeCompare(b.label));
  const save = () => run(async () => {
    const row = { status: v.status, signed_on: v.signed_on, total_price: v.total_price === '' ? null : v.total_price, price_currency: v.total_price === '' ? null : v.price_currency,
      client_party_id: v.client, referrer_party_id: v.referrer, notes: v.notes.trim() || null };
    if (deal) must(await supabase.from('deals').update(row).eq('id', deal.id));
    else must(await supabase.from('deals').insert({ ...row, property_id: propertyId, country_code: country }));
  }, 'פרטי הרכישה נשמרו').then((ok) => ok && onDone());
  return (
    <Stack>
      <SimpleGrid cols={{ base: 1, sm: 3 }}>
        <Select label="מצב" data={STATUS} value={v.status} allowDeselect={false} onChange={(x) => x && setV({ ...v, status: x as DealRow['status'] })} />
        <DateInput label="תאריך חתימה" value={v.signed_on} onChange={(d) => setV({ ...v, signed_on: day(d) })} valueFormat="DD.MM.YYYY" clearable />
        <Group gap="xs" wrap="nowrap" align="flex-end">
          <NumberInput label="מחיר" thousandSeparator="," min={0} value={v.total_price} onChange={(x) => setV({ ...v, total_price: x === '' ? '' : Number(x) })} style={{ flex: 1 }} />
          <Select w={90} data={CURRENCIES} value={v.price_currency} allowDeselect={false} onChange={(x) => x && setV({ ...v, price_currency: x as Currency })} />
        </Group>
      </SimpleGrid>
      <SimpleGrid cols={{ base: 1, sm: 2 }}>
        <Select label="לקוח" required searchable data={unique} value={v.client} onChange={(x) => setV({ ...v, client: x })} nothingFoundMessage="לא נמצא" />
        <Select label="הגיע דרך (לא חובה)" searchable clearable data={unique} value={v.referrer} onChange={(x) => setV({ ...v, referrer: x })} nothingFoundMessage="לא נמצא" />
      </SimpleGrid>
      <Textarea label="הערות" autosize minRows={2} value={v.notes} onChange={(e) => setV({ ...v, notes: e.currentTarget.value })} />
      {error && <Alert color="red">{error}</Alert>}
      <Group justify="flex-end"><Button onClick={save} loading={busy} disabled={!v.client}>שמירה</Button></Group>
    </Stack>
  );
}

type PayDraft = { id?: string; paid_on: string | null; kind: string; amount: number | ''; currency: Currency; amount_usd: number | ''; payer_name: string; payee_name: string; notes: string };
const emptyPay = (): PayDraft => ({ paid_on: null, kind: 'payment', amount: '', currency: 'USD', amount_usd: '', payer_name: '', payee_name: '', notes: '' });

function Payments({ propertyId, country, payments }: { propertyId: string; country: Country; payments: PurchasePaymentRow[] }) {
  const { busy, error, run } = useSave(propertyId);
  const [draft, setDraft] = useState<PayDraft | null>(null);
  const save = () => run(async () => {
    const d = draft!;
    const row = { paid_on: d.paid_on, kind: d.kind, amount: d.amount === '' ? null : d.amount, currency: d.amount === '' ? null : d.currency,
      amount_usd: d.currency === 'USD' || d.amount_usd === '' ? null : d.amount_usd, payer_name: d.payer_name.trim() || null, payee_name: d.payee_name.trim() || null, notes: d.notes.trim() || null };
    if (d.id) must(await supabase.from('purchase_payments').update(row).eq('id', d.id));
    else must(await supabase.from('purchase_payments').insert({ ...row, property_id: propertyId, country_code: country }));
  }, draft?.id ? 'התנועה עודכנה' : 'התנועה נוספה').then((ok) => ok && setDraft(null));
  const remove = (p: PurchasePaymentRow) => modals.openConfirmModal({
    title: 'מחיקת תנועה', children: <Text size="sm">{date(p.paid_on)} · {money(p.amount, p.currency)}. המחיקה נשמרת ביומן הפעילות.</Text>,
    labels: { confirm: 'מחיקה', cancel: 'ביטול' }, confirmProps: { color: 'red' },
    onConfirm: () => { run(async () => { must(await supabase.from('purchase_payments').delete().eq('id', p.id)); }, 'התנועה נמחקה'); },
  });
  return (
    <Stack>
      {draft ? (
        <Stack gap="xs">
          <SimpleGrid cols={{ base: 2, sm: 4 }}>
            <DateInput label="תאריך" value={draft.paid_on} onChange={(d) => setDraft({ ...draft, paid_on: day(d) })} valueFormat="DD.MM.YYYY" clearable />
            <Select label="סוג" data={Object.entries(KIND_HE).map(([value, label]) => ({ value, label }))} value={draft.kind} allowDeselect={false} onChange={(x) => x && setDraft({ ...draft, kind: x })} />
            <NumberInput label="סכום" thousandSeparator="," value={draft.amount} onChange={(x) => setDraft({ ...draft, amount: x === '' ? '' : Number(x) })} />
            <Select label="מטבע" data={CURRENCIES} value={draft.currency} allowDeselect={false} onChange={(x) => x && setDraft({ ...draft, currency: x as Currency })} />
          </SimpleGrid>
          {draft.currency !== 'USD' && <NumberInput label="שווי בדולר לפי המקור (לא חובה)" description="רק אם המקור כתב אותו; לא מחושב" thousandSeparator="," w={260} value={draft.amount_usd} onChange={(x) => setDraft({ ...draft, amount_usd: x === '' ? '' : Number(x) })} />}
          <SimpleGrid cols={{ base: 1, sm: 2 }}>
            <TextInput label="משלם" value={draft.payer_name} onChange={(e) => setDraft({ ...draft, payer_name: e.currentTarget.value })} />
            <TextInput label="מקבל" value={draft.payee_name} onChange={(e) => setDraft({ ...draft, payee_name: e.currentTarget.value })} />
          </SimpleGrid>
          <Textarea label="פירוט" autosize minRows={1} value={draft.notes} onChange={(e) => setDraft({ ...draft, notes: e.currentTarget.value })} />
          <Group justify="flex-end"><Button variant="default" onClick={() => setDraft(null)}>ביטול</Button><Button onClick={save} loading={busy}>שמירה</Button></Group>
        </Stack>
      ) : <Button w="fit-content" size="xs" variant="light" leftSection={<IconPlus size={14} />} onClick={() => setDraft(emptyPay())}>תנועה חדשה</Button>}
      {error && <Alert color="red">{error}</Alert>}
      {payments.length > 0 && (
        <Table.ScrollContainer minWidth={600} mah={360}>
          <Table striped fz="sm" verticalSpacing={2}>
            <Table.Thead><Table.Tr><Table.Th>תאריך</Table.Th><Table.Th>סוג</Table.Th><Table.Th>סכום</Table.Th><Table.Th>פירוט</Table.Th><Table.Th /></Table.Tr></Table.Thead>
            <Table.Tbody>{payments.map((p) => (
              <Table.Tr key={p.id}>
                <Table.Td style={{ whiteSpace: 'nowrap' }}>{date(p.paid_on)}</Table.Td><Table.Td>{KIND_HE[p.kind]}</Table.Td>
                <Table.Td style={{ whiteSpace: 'nowrap' }}>{money(p.amount, p.currency)}</Table.Td><Table.Td><Text size="xs" lineClamp={2}>{p.notes}</Text></Table.Td>
                <Table.Td><Group gap={2} wrap="nowrap">
                  <ActionIcon variant="subtle" aria-label="עריכה" onClick={() => setDraft({ id: p.id, paid_on: p.paid_on, kind: p.kind, amount: p.amount ?? '', currency: (p.currency ?? 'USD') as Currency,
                    amount_usd: p.amount_usd ?? '', payer_name: p.payer_name ?? p.payer?.display_name ?? '', payee_name: p.payee_name ?? p.payee?.display_name ?? '', notes: p.notes ?? '' })}><IconPencil size={14} /></ActionIcon>
                  <ActionIcon variant="subtle" color="red" aria-label="מחיקה" onClick={() => remove(p)}><IconTrash size={14} /></ActionIcon>
                </Group></Table.Td>
              </Table.Tr>
            ))}</Table.Tbody>
          </Table>
        </Table.ScrollContainer>
      )}
    </Stack>
  );
}

function Installments({ propertyId, deal }: { propertyId: string; deal: DealRow }) {
  const { busy, error, run } = useSave(propertyId);
  const [rows, setRows] = useState(deal.installments.filter((i) => !i.paid_txn_id).map((i) => ({ ...i, amount: i.amount as number | '' })));
  const paid = deal.installments.filter((i) => i.paid_txn_id);
  const save = () => run(async () => {
    const keep = new Set(rows.filter((r) => r.id).map((r) => r.id));
    for (const old of deal.installments.filter((i) => !i.paid_txn_id && !keep.has(i.id))) must(await supabase.from('installments').delete().eq('id', old.id));
    for (const r of rows) {
      const row = { due_date: r.due_date, amount: r.amount === '' ? 0 : r.amount, currency: r.currency, notes: r.notes?.trim() || null };
      if (r.id) must(await supabase.from('installments').update(row).eq('id', r.id));
      else must(await supabase.from('installments').insert({ ...row, deal_id: deal.id }));
    }
  }, 'התשלומים המתוכננים נשמרו');
  const set = (i: number, patch: Partial<(typeof rows)[number]>) => setRows((rs) => rs.map((r, j) => (j === i ? { ...r, ...patch } : r)));
  return (
    <Stack>
      <Text size="sm" c="dimmed">תשלומים שעוד לא שולמו. תשלום שכבר נרשם בספר החשבונות ({paid.length}) לא נערך כאן.</Text>
      {rows.map((r, i) => (
        <Group key={r.id || i} gap="xs" wrap="nowrap" align="flex-end">
          <DateInput label={i === 0 ? 'מועד' : undefined} value={r.due_date} onChange={(d) => set(i, { due_date: day(d) })} valueFormat="DD.MM.YYYY" w={140} clearable />
          <NumberInput label={i === 0 ? 'סכום' : undefined} thousandSeparator="," value={r.amount} onChange={(x) => set(i, { amount: x === '' ? '' : Number(x) })} w={140} />
          <Select label={i === 0 ? 'מטבע' : undefined} data={CURRENCIES} value={r.currency} allowDeselect={false} onChange={(x) => x && set(i, { currency: x as Currency })} w={90} />
          <TextInput label={i === 0 ? 'הערה' : undefined} value={r.notes ?? ''} onChange={(e) => set(i, { notes: e.currentTarget.value })} style={{ flex: 1 }} />
          <ActionIcon variant="subtle" color="red" aria-label="הסרה" onClick={() => setRows((rs) => rs.filter((_, j) => j !== i))} mb={4}><IconTrash size={16} /></ActionIcon>
        </Group>
      ))}
      <Group justify="space-between">
        <Button size="xs" variant="light" leftSection={<IconPlus size={14} />} onClick={() => setRows((rs) => [...rs, { id: '', due_date: null, amount: '', currency: deal.price_currency ?? 'USD', notes: '', paid_txn_id: null }])}>תשלום מתוכנן</Button>
        <Button onClick={save} loading={busy} disabled={rows.some((r) => r.amount === '' || !r.amount)}>שמירה</Button>
      </Group>
      {error && <Alert color="red">{error}</Alert>}
    </Stack>
  );
}

export function PurchaseEdit({ propertyId, country, deals, payments, ownerId, onClose }: {
  propertyId: string; country: Country; deals: DealRow[]; payments: PurchasePaymentRow[]; ownerId: string | null; onClose: () => void;
}) {
  const deal = deals[0] ?? null;
  return (
    <Modal opened onClose={onClose} title="עריכת הרכישה" size="xl">
      <Tabs defaultValue="deal">
        <Tabs.List mb="md">
          <Tabs.Tab value="deal">העסקה</Tabs.Tab>
          <Tabs.Tab value="payments">תנועות ברכישה ({payments.length})</Tabs.Tab>
          <Tabs.Tab value="plan" disabled={!deal}>תשלומים מתוכננים</Tabs.Tab>
        </Tabs.List>
        <Tabs.Panel value="deal">
          {deals.length > 1 && <Text size="xs" c="dimmed" mb="xs">לנכס יש {deals.length} עסקאות; נערכת הראשונה.</Text>}
          <DealForm propertyId={propertyId} country={country} deal={deal} ownerId={ownerId} onDone={() => { if (!deal) onClose(); }} />
        </Tabs.Panel>
        <Tabs.Panel value="payments"><Payments propertyId={propertyId} country={country} payments={payments} /></Tabs.Panel>
        {deal && <Tabs.Panel value="plan"><Installments propertyId={propertyId} deal={deal} /></Tabs.Panel>}
      </Tabs>
    </Modal>
  );
}
