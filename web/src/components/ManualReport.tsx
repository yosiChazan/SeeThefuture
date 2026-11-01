import { ActionIcon, Alert, Badge, Button, Checkbox, Collapse, FileInput, Group, List, Modal, NumberInput, Paper, Stack, Table, Text, Title } from '@mantine/core';
import { DateInput, MonthPickerInput } from '@mantine/dates';
import { notifications } from '@mantine/notifications';
import { IconPhoto, IconPlus, IconTrash } from '@tabler/icons-react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import dayjs from 'dayjs';
import { useEffect, useMemo, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { buildLiana, buildYarach, type LianaForm, type Transfer, type YarachForm } from '../intake/manual';
import type { ParseResult } from '../intake/types';
import { createBatch, latestForm, type Source } from '../lib/intake';
import { gershonId, loadUnits, MANUAL, pendingVersion, saveUnit, type AreaUnit, type UnitChange } from '../lib/manual';
import { monthLabel } from '../pages/Intake';

const fmt = (n: number) => n.toLocaleString('en-US', { maximumFractionDigits: 2 });
const iso = (d: unknown) => (d ? dayjs(d as string).format('YYYY-MM-DD') : '');
const numOrNull = (v: string | number) => (v === '' || v === null ? null : Number(v));

// Which apartments the manager handles, with the expected rent (Yarach) or the fee
// (Liana). Saved to management_agreements and rent_schedule from the form's month.
function Units({ source, period, units, onSaved }: { source: Source; period: string; units: AreaUnit[]; onSaved: () => Promise<unknown> }) {
  const cfg = MANUAL[source.adapter];
  const init = () => new Map(units.map((u) => [u.id, { managed: !!u.agreement, expected: u.expected ?? null, feePct: u.feePct ?? null } as UnitChange]));
  const [draft, setDraft] = useState(init);
  const [busy, setBusy] = useState(false);
  useEffect(() => setDraft(init()), [units]); // eslint-disable-line react-hooks/exhaustive-deps
  const set = (id: string, patch: Partial<UnitChange>) => setDraft((d) => new Map(d).set(id, { ...d.get(id)!, ...patch }));
  const changed = units.filter((u) => {
    const c = draft.get(u.id)!;
    return c.managed !== !!u.agreement || (cfg.kind === 'yarach' && (c.expected ?? 0) !== (u.expected ?? 0))
      || (cfg.kind === 'liana' && c.managed && !!u.agreement && c.feePct !== u.feePct);
  });

  async function save() {
    setBusy(true);
    for (const u of changed) {
      try { await saveUnit(cfg, source.holder_party_id!, period, u, draft.get(u.id)!); } catch (e) {
        notifications.show({ color: 'red', title: u.title, message: (e as Error).message });
      }
    }
    await onSaved();
    setBusy(false);
  }

  return (
    <Stack gap="xs">
      <Text size="xs" c="dimmed">
        סמנו את הדירות ש{cfg.manager} מנהל{cfg.kind === 'liana' ? 'ת' : ''}{cfg.kind === 'yarach' ? ' ואת השכירות הצפויה של כל אחת בגריבנה. ההעברות מתחלקות לפי השכירות הצפויה' : ' ואת העמלה שלה'}.
        {' '}שינוי חל מ{monthLabel(period)} והלאה, וההיסטוריה נשמרת.
      </Text>
      <Table.ScrollContainer minWidth={520}>
        <Table verticalSpacing={4}>
          <Table.Thead>
            <Table.Tr><Table.Th>בניהול</Table.Th><Table.Th>דירה</Table.Th><Table.Th>בעלים</Table.Th>
              <Table.Th>{cfg.kind === 'yarach' ? 'שכירות צפויה (₴)' : 'עמלה (%)'}</Table.Th></Table.Tr>
          </Table.Thead>
          <Table.Tbody>
            {units.map((u) => {
              const c = draft.get(u.id) ?? { managed: false };
              return (
                <Table.Tr key={u.id}>
                  <Table.Td><Checkbox checked={c.managed} onChange={(e) => set(u.id, { managed: e.currentTarget.checked })} /></Table.Td>
                  <Table.Td><Text size="sm">{u.title}</Text>{u.otherManager && <Badge size="xs" variant="light" color="gray">מנוהלת גם ע"י {u.otherManager}</Badge>}</Table.Td>
                  <Table.Td><Text size="xs" c="dimmed">{u.owner ?? 'ללא בעלים'}</Text></Table.Td>
                  <Table.Td w={160}>
                    {cfg.kind === 'yarach'
                      ? <NumberInput size="xs" min={0} thousandSeparator="," disabled={!c.managed} value={c.expected ?? ''} onChange={(v) => set(u.id, { expected: numOrNull(v) })} />
                      : <NumberInput size="xs" min={0} max={100} disabled={!c.managed} value={c.feePct ?? ''} onChange={(v) => set(u.id, { feePct: numOrNull(v) })} />}
                  </Table.Td>
                </Table.Tr>
              );
            })}
          </Table.Tbody>
        </Table>
      </Table.ScrollContainer>
      <Group justify="flex-end">
        <Button size="xs" onClick={save} loading={busy} disabled={!changed.length}>שמירת הדירות{changed.length ? ` (${changed.length})` : ''}</Button>
      </Group>
    </Stack>
  );
}

export function ManualReport({ source, onClose }: { source: Source; onClose: () => void }) {
  const cfg = MANUAL[source.adapter];
  const navigate = useNavigate();
  const qc = useQueryClient();
  const [month, setMonth] = useState<string>(dayjs().subtract(1, 'month').startOf('month').format('YYYY-MM-DD'));
  const period = month;
  const scope = period.slice(0, 7);
  const [showUnits, setShowUnits] = useState(false);
  const [transfers, setTransfers] = useState<Transfer[]>([]);
  const [lines, setLines] = useState<Map<string, number | null>>(new Map());
  const [paidOn, setPaidOn] = useState('');
  const [files, setFiles] = useState<File[]>([]);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const units = useQuery({ queryKey: ['manual-units', source.id, period], queryFn: () => loadUnits(cfg, source.holder_party_id!, period), enabled: !!source.holder_party_id });
  const gershon = useQuery({ queryKey: ['gershon-id'], queryFn: gershonId, enabled: cfg.kind === 'yarach' });
  const earlier = useQuery({ queryKey: ['manual-form', source.id, scope], queryFn: () => latestForm<YarachForm & LianaForm>(source, scope) });
  const pending = useQuery({ queryKey: ['manual-pending', source.id, scope], queryFn: () => pendingVersion(source.id, scope) });

  // Each month starts from what was typed in its latest version, if any.
  useEffect(() => {
    if (earlier.isPending) return;
    const f = earlier.data;
    setTransfers(f?.transfers?.length ? f.transfers : [{ on: '', amount: 0 }]);
    setLines(new Map((f?.lines ?? []).map((l) => [l.property_id, l.gross])));
    setPaidOn(f?.paid_on ?? '');
  }, [earlier.isPending, earlier.data, scope]);

  const managed = useMemo(() => (units.data ?? []).filter((u) => u.agreement), [units.data]);
  useEffect(() => { if (units.data && !managed.length) setShowUnits(true); }, [units.data, managed.length]);

  const form: YarachForm | LianaForm = cfg.kind === 'yarach'
    ? { transfers: transfers.filter((t) => t.on || t.amount) }
    : { ...(paidOn ? { paid_on: paidOn } : {}), lines: managed.map((u) => ({ property_id: u.id, gross: lines.get(u.id) ?? 0 })).filter((l) => l.gross) };

  let preview: ParseResult | null = null;
  let problem: string | null = null;
  try {
    if (units.data && (cfg.kind === 'liana' || gershon.data)) {
      preview = cfg.kind === 'yarach'
        ? buildYarach(period, form as YarachForm, managed, gershon.data!)
        : buildLiana(period, form as LianaForm, managed);
    }
  } catch (e) { problem = (e as Error).message; }

  async function save() {
    if (!preview) return;
    setBusy(true); setError(null);
    try {
      const id = await createBatch(source, files, preview, form);
      await qc.invalidateQueries({ queryKey: ['import-batches'] });
      navigate(`/intake/${id}`);
    } catch (e) { setError((e as Error).message); setBusy(false); }
  }

  const total = transfers.reduce((a, t) => a + (t.amount || 0), 0);
  const expected = managed.reduce((a, u) => a + (u.expected ?? 0), 0);
  const setTransfer = (i: number, patch: Partial<Transfer>) => setTransfers((ts) => ts.map((t, j) => (j === i ? { ...t, ...patch } : t)));

  return (
    <Modal opened onClose={onClose} title={`${source.name}: הזנה ידנית`} size="xl">
      <Stack>
        {!source.holder_party_id && <Alert color="red">למקור הזה לא מוגדר מנהל (holder_party_id). פנו למנהל המערכת.</Alert>}
        <MonthPickerInput label="חודש הדוח" value={month} onChange={(d) => d && setMonth(dayjs(d).startOf('month').format('YYYY-MM-DD'))} valueFormat="MMMM YYYY" maw={240} />
        {earlier.data && <Text size="xs" c="dimmed">הטופס נפתח עם מה שהוזן בגרסה האחרונה של {monthLabel(period)}. מוסיפים את מה שהגיע מאז; באישור, השורות שהשתנו יחליפו את מה שנרשם.</Text>}
        {pending.data && (
          <Alert color="orange" title="יש גרסה של החודש הזה שממתינה לאישור">
            קודם מאשרים, דוחים או מוחקים אותה ברשימת הדוחות, ורק אז מזינים גרסה חדשה. אחרת אותו כסף יירשם פעמיים.
          </Alert>
        )}

        <Paper withBorder p="sm">
          <Group justify="space-between">
            <Text size="sm" fw={500}>
              הדירות של {cfg.manager} ({cfg.area}): {managed.length}
              {cfg.kind === 'yarach' && managed.length > 0 && <Text span size="sm" c="dimmed"> · צפוי {fmt(expected)} ₴ לחודש</Text>}
            </Text>
            <Button size="xs" variant="subtle" onClick={() => setShowUnits((s) => !s)}>{showUnits ? 'סגירה' : 'עריכת הדירות'}</Button>
          </Group>
          <Collapse in={showUnits}>
            {units.data && <Units source={source} period={period} units={units.data} onSaved={() => units.refetch()} />}
          </Collapse>
        </Paper>

        {cfg.kind === 'yarach' ? (
          <Stack gap="xs">
            <Title order={5}>ההעברות לגרשון בחודש</Title>
            {transfers.map((t, i) => (
              <Group key={i} gap="xs" wrap="nowrap">
                <DateInput placeholder="תאריך" value={t.on || null} onChange={(d) => setTransfer(i, { on: iso(d) })} valueFormat="DD.MM.YYYY" w={150}
                  defaultDate={period} minDate={period} maxDate={dayjs(period).endOf('month').format('YYYY-MM-DD')} />
                <NumberInput placeholder="סכום ₴" min={0} thousandSeparator="," value={t.amount || ''} onChange={(v) => setTransfer(i, { amount: Number(v) || 0 })} w={170} />
                <ActionIcon variant="subtle" color="red" onClick={() => setTransfers((ts) => ts.filter((_, j) => j !== i))} aria-label="הסרה"><IconTrash size={16} /></ActionIcon>
              </Group>
            ))}
            <Group justify="space-between">
              <Button size="xs" variant="light" leftSection={<IconPlus size={14} />} onClick={() => setTransfers((ts) => [...ts, { on: '', amount: 0 }])}>העברה</Button>
              <Text size="sm">סה"כ {fmt(total)} ₴{expected ? ` מתוך ${fmt(expected)} ₴` : ''}</Text>
            </Group>
          </Stack>
        ) : (
          <Stack gap="xs">
            <Group justify="space-between" align="flex-end">
              <Title order={5}>ההכנסה החודשית לכל דירה (₾, לפני העמלה)</Title>
              <DateInput label="תאריך התשלום" placeholder="סוף החודש" value={paidOn || null} onChange={(d) => setPaidOn(iso(d))} valueFormat="DD.MM.YYYY" w={150} clearable
                defaultDate={period} minDate={period} maxDate={dayjs(period).endOf('month').format('YYYY-MM-DD')} />
            </Group>
            {managed.length ? (
              <Table verticalSpacing={4}>
                <Table.Tbody>
                  {managed.map((u) => {
                    const gross = lines.get(u.id) ?? 0;
                    const fee = Math.round(gross * (u.feePct ?? 10)) / 100;
                    return (
                      <Table.Tr key={u.id}>
                        <Table.Td><Text size="sm">{u.title}</Text><Text size="xs" c="dimmed">{u.owner}</Text></Table.Td>
                        <Table.Td w={170}><NumberInput size="xs" min={0} thousandSeparator="," value={lines.get(u.id) ?? ''} onChange={(v) => setLines((m) => new Map(m).set(u.id, numOrNull(v)))} /></Table.Td>
                        <Table.Td><Text size="xs" c="dimmed">{gross ? `עמלה ${u.feePct}%: ${fmt(fee)} ₾ · לבנק ${fmt(gross - fee)} ₾` : ''}</Text></Table.Td>
                      </Table.Tr>
                    );
                  })}
                </Table.Tbody>
              </Table>
            ) : <Text size="sm" c="dimmed">עוד לא סומנו דירות של ליאנה. פתחו את "עריכת הדירות".</Text>}
          </Stack>
        )}

        <FileInput label="צילומי מסך מהוואטסאפ" placeholder="אפשר לבחור כמה קבצים" multiple accept="image/*,application/pdf"
          value={files} onChange={setFiles} leftSection={<IconPhoto size={16} />} clearable
          description="נשמרים עם הדוח, ומי שמאשר יכול לפתוח אותם" />

        {problem && <Alert color="gray">{problem}</Alert>}
        {preview && (
          <Alert color={preview.warnings.length ? 'orange' : 'teal'} title={`דוח ${monthLabel(preview.period)}`}>
            <List size="sm">{(preview.checks ?? []).map((c) => <List.Item key={c}>{c}</List.Item>)}</List>
            {preview.warnings.length > 0 && <List size="sm" mt="xs">{preview.warnings.map((w) => <List.Item key={w}>{w}</List.Item>)}</List>}
            <Text size="sm" mt="xs">במסך הבא תראו כל שורה לפני האישור.</Text>
          </Alert>
        )}
        {error && <Alert color="red" title="הדוח לא נשמר">{error}</Alert>}
        <Group justify="flex-end">
          <Button variant="default" onClick={onClose}>ביטול</Button>
          <Button onClick={save} loading={busy} disabled={!preview || !!pending.data}>המשך לבדיקה</Button>
        </Group>
      </Stack>
    </Modal>
  );
}
