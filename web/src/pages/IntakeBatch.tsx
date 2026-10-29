import { ActionIcon, Alert, Anchor, Badge, Breadcrumbs, Button, Group, List, Paper, Select, SimpleGrid, Stack, Table, Text, Title, Tooltip } from '@mantine/core';
import { modals } from '@mantine/modals';
import { notifications } from '@mantine/notifications';
import { IconAlertTriangle, IconArrowBackUp, IconCheck, IconDownload, IconEyeOff } from '@tabler/icons-react';
import { useQueryClient } from '@tanstack/react-query';
import { useMemo, useState } from 'react';
import { Link, useParams } from 'react-router-dom';
import { CountryBadge, QueryState } from '../components/common';
import { useAccess } from '../lib/access';
import { date, money, owners, propertyTitle } from '../lib/format';
import { batchNotes, useBatch, type ImportRow, type RowStatus } from '../lib/intake';
import { useProperties } from '../lib/queries';
import { supabase } from '../lib/supabase';
import type { Currency } from '../lib/types';
import { BATCH_STATUS, monthLabel } from './Intake';

const ROW_STATUS: Record<RowStatus, { label: string; color: string }> = {
  matched: { label: 'יירשם', color: 'teal' },
  unmatched: { label: 'נכס לא זוהה', color: 'red' },
  duplicate: { label: 'כבר נרשם', color: 'gray' },
  ignored: { label: 'לא יירשם', color: 'gray' },
};

const CATEGORY_HE: Record<string, string> = {
  rent: 'שכירות', mgmt_fee: 'דמי ניהול', utilities: 'חשבונות', building_fees: 'הוצאות בניין', legal_fees: 'שכ"ט עו"ד',
  repair: 'תיקונים', brokerage: 'תיווך', fx: 'המרת מטבע', deposit: 'פיקדון', opening_balance: 'יתרת פתיחה', transfer: 'העברה', other: 'אחר', tax_withheld: 'מס במקור', hotel_share: 'חלק המלון',
};

function Amounts({ row }: { row: ImportRow }) {
  // The money that moves in the client's accounts; the manager's side is implied.
  const lines = (row.proposed?.entries ?? []).filter((e) => e.account);
  if (!lines.length) return <Text size="sm" c="dimmed">—</Text>;
  return (
    <Stack gap={0}>
      {lines.map((e, i) => (
        <Text key={i} size="sm" c={e.amount < 0 ? 'red.7' : 'teal.8'} style={{ whiteSpace: 'nowrap' }}>
          {e.amount > 0 ? '+' : ''}{money(e.amount, e.currency as Currency)}
        </Text>
      ))}
    </Stack>
  );
}

export function IntakeBatch() {
  const { id } = useParams();
  const q = useBatch(id!);
  const properties = useProperties();
  const access = useAccess();
  const qc = useQueryClient();
  const [busy, setBusy] = useState(false);
  const refresh = () => qc.invalidateQueries({ queryKey: ['import-batch', id] });

  const groups = useMemo(() => {
    const m = new Map<string, ImportRow[]>();
    for (const r of q.data?.rows ?? []) m.set(r.raw.property_ref, [...(m.get(r.raw.property_ref) ?? []), r]);
    return [...m.entries()];
  }, [q.data]);

  return (
    <QueryState q={q}>{({ batch, rows }) => {
      const notes = batchNotes(batch);
      const open = batch.status === 'in_review' || batch.status === 'parsed';
      const editable = open && access.canEdit(batch.country_code);
      const count = (s: RowStatus) => rows.filter((r) => r.match_status === s).length;
      const unmatched = count('unmatched');
      // Rows that will be posted but carry an error nobody has marked as checked.
      const unchecked = rows.filter((r) => r.match_status === 'matched' && r.raw.errors?.length && !r.raw.checked).length;
      const byProperty = new Map((properties.data ?? []).map((p) => [p.id, p]));

      // Totals of what will be posted, per category and currency, never converted.
      const totals = new Map<string, number>();
      for (const r of rows) if (r.match_status === 'matched') for (const e of r.proposed!.entries) {
        if (!e.account) continue;
        const k = `${r.proposed!.category}|${e.currency}`;
        totals.set(k, (totals.get(k) ?? 0) + e.amount);
      }

      async function setProperty(ref: string, propertyId: string | null) {
        const { error } = await supabase.from('import_rows')
          .update({ property_id: propertyId, match_status: propertyId ? 'matched' : 'unmatched' })
          .eq('batch_id', batch.id).eq('raw->>property_ref', ref).in('match_status', ['matched', 'unmatched']);
        if (error) notifications.show({ color: 'red', message: error.message });
        await refresh();
      }

      async function setChecked(r: ImportRow, checked: boolean) {
        const { error } = await supabase.from('import_rows').update({ raw: { ...r.raw, checked } }).eq('id', r.id);
        if (error) notifications.show({ color: 'red', message: error.message });
        await refresh();
      }

      async function toggle(r: ImportRow) {
        const next: RowStatus = r.match_status === 'ignored' ? (r.property_id ? 'matched' : 'unmatched') : 'ignored';
        const { error } = await supabase.from('import_rows').update({ match_status: next }).eq('id', r.id);
        if (error) notifications.show({ color: 'red', message: error.message });
        await refresh();
      }

      async function download() {
        const { data, error } = await supabase.storage.from('imports').createSignedUrl(batch.file_path!, 60);
        if (error) notifications.show({ color: 'red', message: error.message }); else window.open(data.signedUrl, '_blank');
      }

      const approve = () => modals.openConfirmModal({
        title: 'אישור ורישום',
        children: <Text size="sm">{count('matched')} שורות יירשמו בכרטיסי החשבון של הלקוחות. תנועה רשומה לא נמחקת, אפשר רק לבטל אותה. להמשיך?</Text>,
        labels: { confirm: 'אישור ורישום', cancel: 'ביטול' },
        onConfirm: async () => {
          setBusy(true);
          const { data, error } = await supabase.rpc('commit_import_batch', { p_batch: batch.id });
          setBusy(false);
          if (error) { notifications.show({ color: 'red', title: 'הרישום נכשל, שום דבר לא נרשם', message: error.message }); return; }
          notifications.show({ color: 'teal', message: `נרשמו ${data} תנועות` });
          await qc.invalidateQueries();
        },
      });

      const reject = () => modals.openConfirmModal({
        title: 'דחיית הדוח',
        children: <Text size="sm">הדוח יסומן כנדחה ושום דבר ממנו לא יירשם. אפשר לקלוט אותו שוב אחר כך.</Text>,
        labels: { confirm: 'דחייה', cancel: 'ביטול' }, confirmProps: { color: 'red' },
        onConfirm: async () => {
          const { error } = await supabase.from('import_batches').update({ status: 'rejected' }).eq('id', batch.id);
          if (error) notifications.show({ color: 'red', message: error.message });
          await qc.invalidateQueries();
        },
      });

      const options = (candidates: string[] = []) => {
        const list = (properties.data ?? []).filter((p) => p.country_code === batch.country_code)
          .map((p) => ({ value: p.id, label: `${propertyTitle(p)} · ${owners(p) || 'ללא בעלים'}` }));
        return [...list.filter((o) => candidates.includes(o.value)), ...list.filter((o) => !candidates.includes(o.value))];
      };

      return (
        <Stack>
          <Breadcrumbs>
            <Anchor component={Link} to="/intake" size="sm">קליטת דוחות</Anchor>
            <Text size="sm">{batch.source.name}</Text>
          </Breadcrumbs>
          <Group justify="space-between">
            <Stack gap={2}>
              <Title order={2}>{batch.source.name} · {monthLabel(notes?.period)}</Title>
              <Group gap="xs">
                <CountryBadge code={batch.country_code} />
                <Badge variant="light" color={BATCH_STATUS[batch.status].color}>{BATCH_STATUS[batch.status].label}</Badge>
                {notes?.file_name && <Text size="sm" c="dimmed" dir="ltr">{notes.file_name}</Text>}
              </Group>
            </Stack>
            {batch.file_path && <Button variant="default" leftSection={<IconDownload size={16} />} onClick={download}>הקובץ המקורי</Button>}
          </Group>

          {!!notes?.warnings.length && (
            <Alert color="orange" title="בדיקות על הקובץ כולו">
              <List size="sm">{notes.warnings.map((w) => <List.Item key={w}>{w}</List.Item>)}</List>
            </Alert>
          )}

          <SimpleGrid cols={{ base: 2, sm: 4 }}>
            {(['matched', 'unmatched', 'duplicate', 'ignored'] as RowStatus[]).map((s) => (
              <Paper key={s} withBorder p="sm">
                <Text size="xs" c="dimmed">{ROW_STATUS[s].label}</Text>
                <Text fz={24} fw={700} c={s === 'unmatched' && count(s) ? 'red' : undefined}>{count(s)}</Text>
              </Paper>
            ))}
          </SimpleGrid>

          {totals.size > 0 && (
            <Paper withBorder p="sm">
              <Text size="sm" fw={500} mb={4}>{batch.status === 'committed' ? 'מה נרשם' : 'מה יירשם'}</Text>
              <Group gap="lg">
                {[...totals.entries()].map(([k, v]) => {
                  const [cat, cur] = k.split('|');
                  return <Text key={k} size="sm">{CATEGORY_HE[cat] ?? cat}: <b>{money(v, cur as Currency)}</b></Text>;
                })}
              </Group>
            </Paper>
          )}

          {groups.map(([ref, rs]) => {
            const first = rs[0];
            const prop = first.property_id ? byProperty.get(first.property_id) : undefined;
            const postable = rs.some((r) => r.proposed && r.match_status !== 'duplicate');
            return (
              <Paper key={ref} withBorder p="sm">
                <Group justify="space-between" mb="xs" wrap="wrap">
                  <Stack gap={0}>
                    <Text fw={600} dir="ltr" ta="right">{ref}</Text>
                    {first.raw.owner && <Text size="xs" c="dimmed">בדוח: {first.raw.owner}</Text>}
                  </Stack>
                  <Group gap="xs">
                    {first.raw.match_note && <Badge color="orange" variant="light">{first.raw.match_note}</Badge>}
                    {editable && postable ? (
                      <Select w={380} maw="100%" searchable clearable placeholder="בחרו נכס" value={first.property_id}
                        data={options(first.raw.candidates)} onChange={(v) => setProperty(ref, v)} error={!first.property_id} />
                    ) : prop ? (
                      <Anchor component={Link} to={`/properties/${prop.id}`} size="sm">{propertyTitle(prop)} · {owners(prop)}</Anchor>
                    ) : null}
                  </Group>
                </Group>
                <Table.ScrollContainer minWidth={700}>
                  <Table verticalSpacing={6}>
                    <Table.Tbody>
                      {rs.map((r) => (
                        <Table.Tr key={r.id} opacity={r.match_status === 'ignored' || r.match_status === 'duplicate' ? 0.6 : 1}>
                          <Table.Td w={150}>
                            <Text size="sm">{r.raw.kind}</Text>
                            <Text size="xs" c="dimmed">{r.proposed ? CATEGORY_HE[r.proposed.category] ?? r.proposed.category : 'לידיעה'}</Text>
                          </Table.Td>
                          <Table.Td w={100}>{date(r.proposed?.occurred_on)}</Table.Td>
                          <Table.Td>
                            <Text size="sm">{r.proposed?.description ?? String(r.raw.description ?? '')}</Text>
                            {r.issues?.map((i) => <Text key={i} size="xs" c="dimmed">{i}</Text>)}
                            {r.raw.errors?.map((e) => (
                              <Group key={e} gap={4} wrap="nowrap" align="flex-start">
                                <IconAlertTriangle size={14} color={r.raw.checked ? 'var(--mantine-color-gray-6)' : 'var(--mantine-color-red-7)'} style={{ flexShrink: 0, marginTop: 2 }} />
                                <Text size="xs" c={r.raw.checked ? 'dimmed' : 'red.7'} td={r.raw.checked ? 'line-through' : undefined}>{e}</Text>
                              </Group>
                            ))}
                            {!!r.raw.errors?.length && r.match_status === 'matched' && (r.raw.checked ? (
                              <Group gap={4} mt={2}>
                                <Badge size="xs" color="teal" variant="light" leftSection={<IconCheck size={10} />}>נבדק</Badge>
                                {editable && <Button size="compact-xs" variant="subtle" color="gray" onClick={() => setChecked(r, false)}>ביטול</Button>}
                              </Group>
                            ) : editable && (
                              <Button size="compact-xs" variant="light" color="red" mt={4} leftSection={<IconCheck size={12} />} onClick={() => setChecked(r, true)}>בדקתי, אפשר לרשום</Button>
                            ))}
                          </Table.Td>
                          <Table.Td w={130}><Amounts row={r} /></Table.Td>
                          <Table.Td w={120}><Badge variant="light" color={ROW_STATUS[r.match_status].color}>{ROW_STATUS[r.match_status].label}</Badge></Table.Td>
                          <Table.Td w={40}>
                            {editable && r.proposed && r.match_status !== 'duplicate' && (
                              <Tooltip label={r.match_status === 'ignored' ? 'להחזיר לרישום' : 'לא לרשום את השורה'}>
                                <ActionIcon variant="subtle" color="gray" onClick={() => toggle(r)} aria-label="החלפת מצב">
                                  {r.match_status === 'ignored' ? <IconArrowBackUp size={16} /> : <IconEyeOff size={16} />}
                                </ActionIcon>
                              </Tooltip>
                            )}
                          </Table.Td>
                        </Table.Tr>
                      ))}
                    </Table.Tbody>
                  </Table>
                </Table.ScrollContainer>
              </Paper>
            );
          })}

          {open && (
            <Paper withBorder p="md" pos="sticky" bottom={0} style={{ zIndex: 5 }}>
              <Group justify="space-between">
                <Text size="sm" c={unmatched || unchecked ? 'red' : 'dimmed'}>
                  {unmatched ? `יש ${unmatched} שורות בלי נכס. בחרו נכס או סמנו "לא לרשום".`
                    : unchecked ? `יש ${unchecked} שורות עם שגיאה שעוד לא נבדקה. סמנו "בדקתי" או "לא לרשום".`
                    : `${count('matched')} שורות מוכנות לרישום.`}
                  {' '}כל מטבע מוצג בנפרד, בלי המרה.
                </Text>
                <Group>
                  {editable && <Button variant="default" color="red" onClick={reject}>דחיית הדוח</Button>}
                  {access.canApprove(batch.country_code) ? (
                    <Button onClick={approve} loading={busy} disabled={!!unmatched || !!unchecked || !count('matched')}>אישור ורישום</Button>
                  ) : <Text size="sm" c="dimmed">האישור דורש הרשאת כספים</Text>}
                </Group>
              </Group>
            </Paper>
          )}
        </Stack>
      );
    }}</QueryState>
  );
}
