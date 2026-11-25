import { ActionIcon, Alert, Badge, Button, Checkbox, Collapse, FileButton, Group, Modal, NumberInput, Paper, Stack, Table, Text, Title, Tooltip } from '@mantine/core';
import { DateInput, MonthPickerInput } from '@mantine/dates';
import { notifications } from '@mantine/notifications';
import { IconClipboard, IconPaperclip, IconPlus, IconTrash } from '@tabler/icons-react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import dayjs from 'dayjs';
import { useEffect, useMemo, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { proRata } from '../intake/manual';
import type { ParseResult, ParsedRow } from '../intake/types';
import { lastDay } from '../intake/util';
import { createBatch, useSources, type Source } from '../lib/intake';
import { gershonId, loadUnits, MANUAL, type AreaUnit } from '../lib/manual';
import { must, supabase } from '../lib/supabase';
import { Units } from './ManualReport';

// Yarach's month (SPEC decision 159). His transfers are entered one by one, each with its proof;
// each is money received from him in Gershon's box, for a rent month, and its proof goes to
// Gershon's card ("העברות מירח"). With the month's last transfer the month is divided: fixed sums
// (Frenkel, the company's apartments in the centre), and the rest among the Arcadia apartments,
// in equal parts or by hand. The division is a report for finance; approved, it is each
// apartment's rent for the month, and the STF fee follows (decision 158).

const fmt = (n: number) => n.toLocaleString('en-US', { maximumFractionDigits: 2 });
const r2 = (n: number) => Math.round(n * 100) / 100;
const safeName = (n: string) => n.normalize('NFKD').replace(/[^\w.-]+/g, '_').slice(-80) || 'file';
interface NewTransfer { on: string; amount: number; file: File | null }
interface Moved { id: string; occurred_on: string; amount: number; allocated_batch: string | null; batch: { status: string } | null }

function useMonthTransfers(yarach: string | null, month: string) {
  return useQuery({
    queryKey: ['yarach-transfers', yarach, month], enabled: !!yarach,
    queryFn: async () => must(await supabase.from('cash_movements').select('id, occurred_on, amount, allocated_batch, batch:import_batches(status)')
      .eq('party_id', yarach!).eq('kind', 'from_manager').eq('currency', 'UAH').eq('rent_month', month).is('parent_id', null).order('occurred_on')) as unknown as Moved[],
  });
}
// A transfer counts as divided while its division is waiting or approved, not after it was rejected.
// The first image in what was pasted, named for when it was pasted.
const imageOf = (d: DataTransfer | null): File | null => {
  const f = [...(d?.files ?? [])].find((x) => x.type.startsWith('image/'));
  return f ? new File([f], `צילום מסך ${dayjs().format('DD.MM.YYYY HH-mm')}.${f.type.split('/')[1] || 'png'}`, { type: f.type }) : null;
};
const divided = (m: Moved) => !!m.allocated_batch && m.batch?.status !== 'rejected';

export function YarachMonth({ source, onClose }: { source: Source; onClose: () => void }) {
  const cfg = MANUAL[source.adapter];
  const qc = useQueryClient();
  const yarach = source.holder_party_id;
  const [month, setMonth] = useState(dayjs().startOf('month').format('YYYY-MM-DD'));
  const [rows, setRows] = useState<NewTransfer[]>([{ on: '', amount: 0, file: null }]);
  const [last, setLast] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [dividing, setDividing] = useState(false);
  const gershon = useQuery({ queryKey: ['gershon-id'], queryFn: gershonId });
  const [showUnits, setShowUnits] = useState(false);
  const units = useQuery({ queryKey: ['manual-units', source.id, month], queryFn: () => loadUnits(cfg, yarach!, month), enabled: !!yarach });
  const done = useMonthTransfers(yarach, month);
  const filled = rows.filter((t) => t.on || t.amount);
  const bad = filled.some((t) => !t.on || !(t.amount > 0));
  const open = (done.data ?? []).filter((m) => !divided(m));
  const set = (i: number, p: Partial<NewTransfer>) => setRows((rs) => rs.map((t, j) => (j === i ? { ...t, ...p } : t)));
  // A screenshot pasted as the proof (decision 160): Ctrl+V on the row, or the button (the browser
  // asks once to let the page read the clipboard).
  async function pasteInto(i: number) {
    try {
      for (const item of await navigator.clipboard.read()) {
        const type = item.types.find((x) => x.startsWith('image/'));
        if (type) { const blob = await item.getType(type); set(i, { file: new File([blob], `צילום מסך ${dayjs().format('DD.MM.YYYY HH-mm')}.${type.split('/')[1]}`, { type }) }); return; }
      }
      notifications.show({ color: 'orange', message: 'אין תמונה בהעתקה. מעתיקים צילום מסך ואז מדביקים' });
    } catch { notifications.show({ color: 'orange', message: 'הדפדפן לא נתן לקרוא את ההעתקה. לוחצים על השורה ומקישים Ctrl+V' }); }
  }

  async function save() {
    setBusy(true); setError(null);
    try {
      const box = (await supabase.from('cash_boxes').select('id').eq('holder_party_id', gershon.data!).limit(1)).data?.[0] as { id: string } | undefined;
      if (!box) throw new Error('לא נמצאה קופת גרשון');
      for (const t of filled) {
        must(await supabase.from('cash_movements').insert({
          box_id: box.id, occurred_on: t.on, amount: t.amount, currency: 'UAH', kind: 'from_manager', party_id: yarach, rent_month: month,
          notes: `העברה של ירח (שכירות ${dayjs(month).format('MM.YYYY')})`,
        }));
        // The proof, on Gershon's card.
        if (t.file) {
          const id = crypto.randomUUID();
          const path = `UA/party/${gershon.data}/${id}_${safeName(t.file.name)}`;
          must(await supabase.from('documents').insert({ id, entity_type: 'party', entity_id: gershon.data, country_code: 'UA', doc_type: 'yarach_transfer',
            storage_path: path, sensitive: true, file_name: `${dayjs(t.on).format('DD.MM.YYYY')} · ${fmt(t.amount)} ₴ · ${t.file.name}`, source: 'upload' }));
          const up = await supabase.storage.from('documents').upload(path, t.file, { contentType: t.file.type || undefined });
          if (up.error) { await supabase.from('documents').delete().eq('id', id); throw new Error(`ההוכחה ${t.file.name} לא נשמרה: ${up.error.message}`); }
        }
      }
      notifications.show({ color: 'teal', message: `${filled.length} העברות נרשמו בקופת גרשון` });
      setRows([{ on: '', amount: 0, file: null }]);
      await qc.invalidateQueries();
      if (last) setDividing(true);
    } catch (e) { setError((e as Error).message); }
    finally { setBusy(false); }
  }

  return (
    <Modal opened onClose={onClose} title="ירח: העברות וחלוקה חודשית" size="xl">
      <Stack>
        <MonthPickerInput label="שכירות של חודש" value={month} onChange={(d) => d && setMonth(dayjs(d).startOf('month').format('YYYY-MM-DD'))} valueFormat="MMMM YYYY" maw={220} />
        <Paper withBorder p="sm">
          <Group justify="space-between">
            <Text size="sm" fw={500}>הדירות של ירח: {(units.data ?? []).filter((u) => u.agreement).length}</Text>
            <Button size="xs" variant="subtle" onClick={() => setShowUnits((s) => !s)}>{showUnits ? 'סגירה' : 'עריכת הדירות (סכום ומטבע)'}</Button>
          </Group>
          <Collapse in={showUnits}>{units.data && <Units source={source} period={month} units={units.data} onSaved={() => units.refetch()} />}</Collapse>
        </Paper>
        <Paper withBorder p="sm">
          <Group justify="space-between" mb={4}>
            <Text size="sm" fw={600}>העברות שנרשמו לחודש הזה: {fmt((done.data ?? []).reduce((a, m) => a + Number(m.amount), 0))} ₴</Text>
            {open.length > 0 && <Button size="xs" variant="light" onClick={() => setDividing(true)}>חלוקת החודש ({fmt(open.reduce((a, m) => a + Number(m.amount), 0))} ₴)</Button>}
          </Group>
          {(done.data ?? []).length ? (done.data ?? []).map((m) => (
            <Group key={m.id} gap="xs"><Text size="sm">{dayjs(m.occurred_on).format('DD.MM.YYYY')} · {fmt(Number(m.amount))} ₴</Text>
              {divided(m) ? <Badge size="xs" color="teal" variant="light">חולק</Badge> : <Badge size="xs" color="orange" variant="light">עוד לא חולק</Badge>}</Group>
          )) : <Text size="xs" c="dimmed">עוד אין</Text>}
        </Paper>
        <Title order={5}>העברות חדשות</Title>
        {rows.map((t, i) => (
          <Group key={i} gap="xs" wrap="nowrap" onPaste={(e) => { const f = imageOf(e.clipboardData); if (f) { e.preventDefault(); set(i, { file: f }); } }}>
            <DateInput placeholder="תאריך" value={t.on || null} onChange={(d) => set(i, { on: d ? dayjs(d).format('YYYY-MM-DD') : '' })} valueFormat="DD.MM.YYYY" w={140} />
            <NumberInput placeholder="סכום ₴" min={0} thousandSeparator="," value={t.amount || ''} onChange={(v) => set(i, { amount: Number(v) || 0 })} w={150} />
            <FileButton accept="image/*,application/pdf" onChange={(f) => set(i, { file: f })}>
              {(p) => <Button {...p} size="xs" variant={t.file ? 'light' : 'default'} leftSection={<IconPaperclip size={14} />}>{t.file ? 'הוכחה ✓' : 'הוכחת העברה'}</Button>}
            </FileButton>
            <Tooltip label="מדביק תמונה שהועתקה (צילום מסך). אפשר גם ללחוץ על השורה ולהקיש Ctrl+V">
              <Button size="xs" variant="default" leftSection={<IconClipboard size={14} />} onClick={() => pasteInto(i)}>הדבקה</Button>
            </Tooltip>
            {t.file && <Text size="xs" c="dimmed" maw={140} truncate>{t.file.name}</Text>}
            <ActionIcon variant="subtle" color="red" onClick={() => setRows((rs) => rs.filter((_, j) => j !== i))} aria-label="הסרה"><IconTrash size={16} /></ActionIcon>
          </Group>
        ))}
        <Group justify="space-between">
          <Button size="xs" variant="light" leftSection={<IconPlus size={14} />} onClick={() => setRows((rs) => [...rs, { on: '', amount: 0, file: null }])}>העברה</Button>
          <Checkbox label="זה התשלום האחרון של החודש (פותח את החלוקה)" checked={last} onChange={(e) => setLast(e.currentTarget.checked)} />
        </Group>
        <Text size="xs" c="dimmed">כל העברה נרשמת בקופת גרשון כ"התקבל ממנהל" מירח, וההוכחה נשמרת בכרטיס של גרשון תחת "העברות מירח".</Text>
        {error && <Alert color="red">{error}</Alert>}
        <Group justify="flex-end">
          <Button variant="default" onClick={onClose}>סגירה</Button>
          <Button onClick={save} loading={busy} disabled={!filled.length || bad || !gershon.data}>רישום ההעברות</Button>
        </Group>
      </Stack>
      {dividing && cfg && <Divide source={source} month={month} transfers={open} gershon={gershon.data!} onClose={() => setDividing(false)} />}
    </Modal>
  );
}

// Dividing the month (decision 159). Fixed lines: the apartments with a rent in hryvnia (Frenkel,
// the company's centre), at that rent. The rest: the apartments with a rent in dollars (Arcadia),
// equal parts, or by hand ("חלוקה שונה"). Every line can be left out.
function Divide({ source, month, transfers, gershon, onClose }: { source: Source; month: string; transfers: Moved[]; gershon: string; onClose: () => void }) {
  const cfg = MANUAL[source.adapter];
  const navigate = useNavigate();
  const qc = useQueryClient();
  const sources = useSources();
  const units = useQuery({ queryKey: ['manual-units', source.id, month], queryFn: () => loadUnits(cfg, source.holder_party_id!, month) });
  const managed = useMemo(() => (units.data ?? []).filter((u) => u.agreement && u.schedule), [units.data]);
  const fixed = managed.filter((u) => u.currency === 'UAH');
  const split = managed.filter((u) => u.currency !== 'UAH');
  const total = r2(transfers.reduce((a, m) => a + Number(m.amount), 0));
  const [on, setOn] = useState<Map<string, boolean>>(new Map());
  const [amount, setAmount] = useState<Map<string, number>>(new Map());
  const [byHand, setByHand] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    setOn(new Map(managed.map((u) => [u.id, true])));
    setAmount(new Map(fixed.map((u) => [u.id, Number(u.expected)])));
  }, [units.data]); // eslint-disable-line react-hooks/exhaustive-deps
  const inc = (u: AreaUnit) => on.get(u.id) ?? true;
  const fixedSum = r2(fixed.filter(inc).reduce((a, u) => a + (amount.get(u.id) ?? 0), 0));
  const rest = r2(total - fixedSum);
  const splitOn = split.filter(inc);
  const equal = proRata(Math.max(rest, 0), splitOn.map(() => 1));
  const share = (u: AreaUnit) => (byHand ? amount.get(u.id) ?? 0 : equal[splitOn.indexOf(u)] ?? 0);
  const allocated = r2(fixedSum + splitOn.reduce((a, u) => a + share(u), 0));
  const diff = r2(total - allocated);

  async function save() {
    setBusy(true); setError(null);
    try {
      const src = (sources.data ?? []).find((s) => s.adapter === 'yarach_accrual');
      if (!src) throw new Error('לא נמצא המקור "ירח · חלוקה חודשית"');
      const label = dayjs(month).format('MM.YYYY');
      const lines = [...fixed.filter(inc).map((u) => [u, amount.get(u.id) ?? 0] as const), ...splitOn.map((u) => [u, share(u)] as const)].filter(([, a]) => a > 0);
      const rows: ParsedRow[] = lines.map(([u, a], i) => ({
        ref: `yarach:${u.id}`, property: { ref: u.ref, unit: '', owner: u.owner, id: u.id }, kind: 'שכירות (חלוקה)',
        proposed: { occurred_on: lastDay(month), period: month, category: 'rent', description: `שכירות ${label}, מההעברות של ירח`,
          entries: [{ amount: a, currency: 'UAH', memo: u.currency !== 'UAH' && u.expected ? `${fmt(a)} ₴ = ${u.expected} $ בשער ${(a / Number(u.expected)).toFixed(4)}` : undefined, account: { kind: 'manager_cash', holder: gershon } }] },
        fingerprint: ['yarach_split', u.id, month, a].join('|'), issues: [], errors: [],
        raw: { row: i + 1, property_ref: u.ref, owner: u.owner, amount: a, description: `שכירות ${label}` },
      }));
      const result: ParseResult = {
        period: month, rows, scope: month.slice(0, 7), warnings: [],
        checks: [`${transfers.length} העברות, ${fmt(total)} ₴: קבוע ${fmt(fixedSum)} ₴, ${splitOn.length} דירות ארקדיה ${fmt(r2(allocated - fixedSum))} ₴${byHand ? ' (חלוקה ידנית)' : ' (חלקים שווים)'}`],
      };
      const id = await createBatch(src, [], result, { transfers: transfers.map((m) => m.id) });
      for (const m of transfers) must(await supabase.from('cash_movements').update({ allocated_batch: id }).eq('id', m.id));
      await qc.invalidateQueries();
      navigate(`/intake/${id}`);
    } catch (e) { setError((e as Error).message); setBusy(false); }
  }

  const row = (u: AreaUnit, a: number, edit: boolean) => (
    <Table.Tr key={u.id} c={inc(u) ? undefined : 'dimmed'}>
      <Table.Td><Checkbox size="xs" checked={inc(u)} onChange={(e) => { const v = e.currentTarget.checked; setOn((m) => new Map(m).set(u.id, v)); }} /></Table.Td>
      <Table.Td><Text size="sm">{u.title}</Text><Text size="xs" c="dimmed">{u.owner}</Text></Table.Td>
      <Table.Td w={150}>{edit && inc(u)
        ? <NumberInput size="xs" min={0} thousandSeparator="," decimalScale={2} value={a || ''} onChange={(v) => setAmount((m) => new Map(m).set(u.id, Number(v) || 0))} />
        : <Text size="sm">{inc(u) ? `${fmt(a)} ₴` : '—'}</Text>}</Table.Td>
      <Table.Td><Text size="xs" c="dimmed">{u.currency !== 'UAH' && u.expected && inc(u) && a ? `${u.expected}$ ← שער ${(a / Number(u.expected)).toFixed(2)}` : ''}</Text></Table.Td>
    </Table.Tr>
  );
  return (
    <Modal opened onClose={onClose} title={`חלוקת ${dayjs(month).format('MM.YYYY')}: ${fmt(total)} ₴ מ-${transfers.length} העברות`} size="xl">
      <Stack>
        <Title order={6}>סכומים קבועים</Title>
        <Table verticalSpacing={4}><Table.Tbody>{fixed.map((u) => row(u, amount.get(u.id) ?? 0, true))}</Table.Tbody></Table>
        <Group justify="space-between">
          <Title order={6}>ארקדיה: היתרה, {fmt(Math.max(rest, 0))} ₴</Title>
          <Button size="xs" variant={byHand ? 'filled' : 'light'} onClick={() => { if (!byHand) setAmount((m) => { const n = new Map(m); splitOn.forEach((u, i) => n.set(u.id, equal[i])); return n; }); setByHand(!byHand); }}>
            {byHand ? 'חזרה לחלקים שווים' : 'חלוקה שונה'}
          </Button>
        </Group>
        <Table verticalSpacing={4}><Table.Tbody>{split.map((u) => row(u, share(u), byHand))}</Table.Tbody></Table>
        <Alert color={Math.abs(diff) < 0.01 ? 'teal' : 'orange'}>
          חולק {fmt(allocated)} ₴ מתוך {fmt(total)} ₴{Math.abs(diff) < 0.01 ? '' : `: ${diff > 0 ? 'נשארו' : 'חולקו יותר מדי'} ${fmt(Math.abs(diff))} ₴`}
        </Alert>
        <Text size="xs" c="dimmed">החלוקה נשמרת כדוח בקליטה, לאישור של כספים. כשהוא מאושר, כל דירה מקבלת את השכירות של החודש, ודמי ניהול STF נוספים לבד.</Text>
        {error && <Alert color="red">{error}</Alert>}
        <Group justify="flex-end">
          <Button variant="default" onClick={onClose}>ביטול</Button>
          <Button onClick={save} loading={busy} disabled={Math.abs(diff) >= 0.01 || !transfers.length || units.isLoading}>שמירה לאישור</Button>
        </Group>
      </Stack>
    </Modal>
  );
}
