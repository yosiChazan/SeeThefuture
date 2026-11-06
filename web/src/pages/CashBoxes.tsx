import { Alert, Badge, Button, Group, Modal, NumberInput, Paper, SegmentedControl, Select, SimpleGrid, Stack, Table, Text, TextInput, Title } from '@mantine/core';
import { DateInput } from '@mantine/dates';
import { modals } from '@mantine/modals';
import { notifications } from '@mantine/notifications';
import { IconPlus, IconTrash } from '@tabler/icons-react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import dayjs from 'dayjs';
import { useMemo, useState } from 'react';
import { useSearchParams } from 'react-router-dom';
import { KIND_HE, summarize, type CashMovement } from '../lib/cash';
import { date, money } from '../lib/format';
import { useClients, useContacts } from '../lib/queries';
import { must, supabase } from '../lib/supabase';
import type { Country, Currency } from '../lib/types';
import { useAccess } from '../lib/access';

// Cash boxes (SPEC decision 112): the office's cash and Gershon's. What came in, what went
// out, and what the box should hold: received from the managers minus handed to clients.

interface Box { id: string; name: string; country_code: Country | null; holder_party_id: string | null; notes: string | null; position: number }
const CURRENCIES: Currency[] = ['UAH', 'USD', 'EUR', 'ILS', 'RON', 'GEL'];

function useBoxes() {
  return useQuery({ queryKey: ['cash-boxes'], queryFn: async () => must(await supabase.from('cash_boxes').select('*').order('position')) as Box[] });
}
function useMovements(boxId: string | null) {
  return useQuery({
    queryKey: ['cash-movements', boxId], enabled: !!boxId,
    queryFn: async () => must(await supabase.from('cash_movements').select('id, occurred_on, amount, currency, kind, party_id, party_name, notes, created_by')
      .eq('box_id', boxId!).order('occurred_on', { ascending: false }).order('created_at', { ascending: false })) as CashMovement[],
  });
}

// What a manager's approved reports say he holds (manager cash), per currency: to compare
// with what the box actually received from him.
function useManagerCash(partyIds: string[]) {
  return useQuery({
    queryKey: ['manager-cash', partyIds], enabled: partyIds.length > 0,
    queryFn: async () => {
      const rows: { amount: number; currency: string; accounts: { holder_party_id: string } }[] = [];
      for (let at = 0; ; at += 1000) {
        const page = must(await supabase.from('entries').select('amount, currency, accounts!inner(kind, holder_party_id), transactions!inner(status)')
          .eq('accounts.kind', 'manager_cash').in('accounts.holder_party_id', partyIds).eq('transactions.status', 'posted').order('id').range(at, at + 999)) as unknown as typeof rows;
        rows.push(...page);
        if (page.length < 1000) break;
      }
      const m = new Map<string, number>();
      for (const r of rows) m.set(`${r.accounts.holder_party_id}|${r.currency}`, (m.get(`${r.accounts.holder_party_id}|${r.currency}`) ?? 0) + Number(r.amount));
      return m;
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
    return v.kind === 'to_client' ? cl : v.kind === 'from_manager' ? managers : [...managers, ...cl];
  }, [contacts.data, clients.data, v.kind]);
  const kinds = (v.dir === 'in' ? ['from_manager', 'income', 'transfer', 'other'] : ['to_client', 'expense', 'transfer', 'other']).map((k) => ({ value: k, label: KIND_HE[k] }));
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
        <SegmentedControl value={v.dir} onChange={(x) => setV({ ...v, dir: x as 'in' | 'out', kind: x === 'in' ? 'from_manager' : 'to_client', party: null })}
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
        <TextInput label="פירוט" value={v.notes} onChange={(e) => setV({ ...v, notes: e.currentTarget.value })} />
        {error && <Alert color="red">{error}</Alert>}
        <Group justify="flex-end"><Button variant="default" onClick={onClose}>ביטול</Button>
          <Button onClick={save} loading={busy} disabled={!v.on || !v.amount || (v.kind === 'from_manager' && !v.party && !v.partyName.trim())}>שמירה</Button></Group>
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
  const sums = summarize(movements, nameOf);
  const managerIds = [...new Set(movements.filter((m) => m.kind === 'from_manager' && m.party_id).map((m) => m.party_id!))];
  const reported = useManagerCash(managerIds);
  const [adding, setAdding] = useState(false);
  const canWrite = !!box && (box.country_code ? access.canApprove(box.country_code) : access.isAdmin);

  const remove = (m: CashMovement) => modals.openConfirmModal({
    title: 'מחיקת תנועה', children: <Text size="sm">{date(m.occurred_on)} · {money(Number(m.amount), m.currency as Currency)} · {nameOf(m)}</Text>,
    labels: { confirm: 'מחיקה', cancel: 'ביטול' }, confirmProps: { color: 'red' },
    onConfirm: async () => {
      const r = await supabase.from('cash_movements').delete().eq('id', m.id);
      if (r.error) notifications.show({ color: 'red', message: r.error.message });
      await qc.invalidateQueries({ queryKey: ['cash-movements', box!.id] });
    },
  });

  return (
    <Stack>
      <Title order={2}>קופות</Title>
      {boxes.error && <Alert color="red">{(boxes.error as Error).message}</Alert>}
      {!list.length && !boxes.isLoading && <Text c="dimmed">אין קופות שאפשר לראות.</Text>}
      {list.length > 0 && (
        <SegmentedControl w="fit-content" value={box?.id ?? ''} onChange={(id) => setParams({ box: id }, { replace: true })}
          data={list.map((b) => ({ value: b.id, label: b.name }))} />
      )}
      {box && (
        <>
          {box.notes && <Text size="sm" c="dimmed">{box.notes}</Text>}
          {!sums.length && !ms.isLoading && <Alert color="gray">עוד אין תנועות בקופה. מוסיפים כל סכום שהתקבל ממנהל וכל העברה ללקוח.</Alert>}
          {sums.map((s) => (
            <Paper key={s.currency} withBorder p="md">
              <Title order={4} mb="sm">{box.name} · {s.currency}</Title>
              <SimpleGrid cols={{ base: 1, sm: 4 }}>
                <Paper withBorder p="sm"><Text size="sm" c="dimmed">התקבל מהמנהלים</Text><Text fw={700} fz={22}>{money(s.received, s.currency as Currency)}</Text>
                  {s.fromManagers.map((f) => <Text key={f.who} size="xs" c="dimmed">{f.who}: {money(f.amount, s.currency as Currency)}</Text>)}</Paper>
                <Paper withBorder p="sm"><Text size="sm" c="dimmed">הועבר ללקוחות</Text><Text fw={700} fz={22}>{money(s.toClients, s.currency as Currency)}</Text></Paper>
                <Paper withBorder p="sm" bg="blue.0"><Text size="sm" c="dimmed">אמור להיות בקופה</Text><Text fw={700} fz={22}>{money(s.expected, s.currency as Currency)}</Text>
                  <Text size="xs" c="dimmed">התקבל מהמנהלים פחות מה שהועבר ללקוחות</Text></Paper>
                <Paper withBorder p="sm"><Text size="sm" c="dimmed">אחרי הוצאות ותנועות אחרות</Text><Text fw={700} fz={22}>{money(s.balance, s.currency as Currency)}</Text>
                  <Text size="xs" c="dimmed">{s.others ? `כולל ${money(s.others, s.currency as Currency)} הוצאות ואחר` : 'אין הוצאות שנרשמו'}</Text></Paper>
              </SimpleGrid>
              {managerIds.length > 0 && reported.data && (
                <Text size="xs" c="dimmed" mt="sm">
                  להשוואה, לפי הדוחות שאושרו המנהלים מחזיקים: {managerIds.map((id) => `${names.get(id) ?? ''} ${money(reported.data!.get(`${id}|${s.currency}`) ?? 0, s.currency as Currency)}`).join(' · ')}
                  {' '}(כל מה שגבו פחות הוצאות ודמי ניהול; ההפרש ממה שהתקבל כאן הוא מה שעוד לא הועבר או לא נרשם)
                </Text>
              )}
            </Paper>
          ))}
          <Paper withBorder p="md">
            <Group justify="space-between" mb="sm">
              <Title order={4}>תנועות ({movements.length})</Title>
              {canWrite && <Button size="xs" leftSection={<IconPlus size={14} />} onClick={() => setAdding(true)}>תנועה חדשה</Button>}
            </Group>
            {!movements.length ? <Text size="sm" c="dimmed">אין</Text> : (
              <Table.ScrollContainer minWidth={640}>
                <Table striped verticalSpacing={4}>
                  <Table.Thead><Table.Tr><Table.Th>תאריך</Table.Th><Table.Th>סוג</Table.Th><Table.Th>עם מי</Table.Th><Table.Th>סכום</Table.Th><Table.Th>פירוט</Table.Th><Table.Th /></Table.Tr></Table.Thead>
                  <Table.Tbody>{movements.map((m) => (
                    <Table.Tr key={m.id}>
                      <Table.Td style={{ whiteSpace: 'nowrap' }}>{date(m.occurred_on)}</Table.Td>
                      <Table.Td><Badge variant="light" color={Number(m.amount) > 0 ? 'teal' : 'orange'}>{KIND_HE[m.kind] ?? m.kind}</Badge></Table.Td>
                      <Table.Td>{nameOf(m)}</Table.Td>
                      <Table.Td style={{ whiteSpace: 'nowrap' }} c={Number(m.amount) < 0 ? 'red' : undefined}>{money(Number(m.amount), m.currency as Currency)}</Table.Td>
                      <Table.Td><Text size="xs">{m.notes}</Text></Table.Td>
                      <Table.Td>{canWrite && <Button size="compact-xs" variant="subtle" color="red" onClick={() => remove(m)}><IconTrash size={12} /></Button>}</Table.Td>
                    </Table.Tr>
                  ))}</Table.Tbody>
                </Table>
              </Table.ScrollContainer>
            )}
          </Paper>
          {adding && <NewMovement box={box} onClose={() => setAdding(false)} />}
        </>
      )}
    </Stack>
  );
}
