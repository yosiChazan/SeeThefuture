import { Alert, Anchor, Badge, Button, FileInput, Group, List, Modal, Paper, Select, Stack, Table, Text, Title } from '@mantine/core';
import { IconFileSpreadsheet, IconPlus } from '@tabler/icons-react';
import { useQueryClient } from '@tanstack/react-query';
import dayjs from 'dayjs';
import { useState } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import { CountryBadge, QueryState } from '../components/common';
import { ADAPTERS } from '../intake/adapters';
import type { ParseResult } from '../intake/types';
import { useAccess } from '../lib/access';
import { batchNotes, createBatch, readReport, useBatches, useSources, type BatchStatus, type Source } from '../lib/intake';

export const BATCH_STATUS: Record<BatchStatus, { label: string; color: string }> = {
  parsed: { label: 'נקלט', color: 'gray' },
  in_review: { label: 'ממתין לאישור', color: 'orange' },
  committed: { label: 'נרשם', color: 'teal' },
  rejected: { label: 'נדחה', color: 'red' },
};

export const monthLabel = (period?: string) => (period ? dayjs(period).locale('he').format('MMMM YYYY') : '—');

function NewReport({ onClose }: { onClose: () => void }) {
  const access = useAccess();
  const sources = useSources();
  const navigate = useNavigate();
  const qc = useQueryClient();
  const [sourceId, setSourceId] = useState<string | null>(null);
  const [file, setFile] = useState<File | null>(null);
  const [preview, setPreview] = useState<ParseResult | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const usable = (sources.data ?? []).filter((s) => access.canEdit(s.country_code));
  const source = usable.find((s) => s.id === sourceId) as Source | undefined;

  async function read(f: File | null) {
    setFile(f); setPreview(null); setError(null);
    if (!f || !source) return;
    setBusy(true);
    try { setPreview(await readReport(source, f)); } catch (e) { setError((e as Error).message); }
    setBusy(false);
  }

  async function save() {
    if (!source || !file || !preview) return;
    setBusy(true); setError(null);
    try {
      const id = await createBatch(source, file, preview);
      await qc.invalidateQueries({ queryKey: ['import-batches'] });
      navigate(`/intake/${id}`);
    } catch (e) { setError((e as Error).message); setBusy(false); }
  }

  const properties = preview ? new Set(preview.rows.map((r) => r.property.ref)).size : 0;
  return (
    <Modal opened onClose={onClose} title="קליטת דוח" size="lg">
      <Stack>
        <Select label="מקור" placeholder="בחרו את המנהל ואת סוג הדוח" value={sourceId} onChange={(v) => { setSourceId(v); setFile(null); setPreview(null); setError(null); }}
          data={usable.map((s) => ({ value: s.id, label: s.name, disabled: !ADAPTERS[s.adapter] }))}
          renderOption={({ option }) => <Group justify="space-between" w="100%"><span>{option.label}</span>{option.disabled && <Badge size="xs" variant="light" color="gray">בקרוב</Badge>}</Group>} />
        {source && (
          <FileInput label="קובץ" placeholder={`למשל ${ADAPTERS[source.adapter].example}`} accept={ADAPTERS[source.adapter].accept}
            value={file} onChange={read} leftSection={<IconFileSpreadsheet size={16} />} clearable />
        )}
        {error && <Alert color="red" title="הקובץ לא נקלט">{error}</Alert>}
        {preview && (
          <Alert color={preview.warnings.length ? 'orange' : 'teal'} title={`דוח ${monthLabel(preview.period)}`}>
            <Text size="sm">נמצאו {properties} דירות ו-{preview.rows.length} שורות. במסך הבא תראו כל שורה לפני האישור.</Text>
            {preview.warnings.length > 0 && <List size="sm" mt="xs">{preview.warnings.map((w) => <List.Item key={w}>{w}</List.Item>)}</List>}
          </Alert>
        )}
        <Group justify="flex-end">
          <Button variant="default" onClick={onClose}>ביטול</Button>
          <Button onClick={save} loading={busy} disabled={!preview}>המשך לבדיקה</Button>
        </Group>
      </Stack>
    </Modal>
  );
}

export function Intake() {
  const access = useAccess();
  const batches = useBatches();
  const [adding, setAdding] = useState(false);
  const canAdd = access.countries.some((c) => access.canEdit(c));
  return (
    <Stack>
      <Group justify="space-between">
        <Title order={2}>קליטת דוחות</Title>
        {canAdd && <Button leftSection={<IconPlus size={16} />} onClick={() => setAdding(true)}>דוח חדש</Button>}
      </Group>
      <Text c="dimmed" size="sm">דוח שנקלט נבדק כאן לפני שהוא נרשם בכרטיסי החשבון. רק עובד עם הרשאת כספים מאשר רישום.</Text>
      <QueryState q={batches}>{(bs) => (
        <Paper withBorder p="sm">
          {bs.length ? (
            <Table.ScrollContainer minWidth={700}>
              <Table striped highlightOnHover verticalSpacing="xs">
                <Table.Thead>
                  <Table.Tr><Table.Th>התקבל</Table.Th><Table.Th>מקור</Table.Th><Table.Th>מדינה</Table.Th><Table.Th>חודש</Table.Th><Table.Th>שורות</Table.Th><Table.Th>מצב</Table.Th></Table.Tr>
                </Table.Thead>
                <Table.Tbody>
                  {bs.map((b) => (
                    <Table.Tr key={b.id}>
                      <Table.Td><Anchor component={Link} to={`/intake/${b.id}`} size="sm">{dayjs(b.received_at).format('DD.MM.YYYY HH:mm')}</Anchor></Table.Td>
                      <Table.Td>{b.source.name}</Table.Td>
                      <Table.Td><CountryBadge code={b.country_code} /></Table.Td>
                      <Table.Td>{monthLabel(batchNotes(b)?.period)}</Table.Td>
                      <Table.Td>{b.rows[0]?.count ?? 0}</Table.Td>
                      <Table.Td><Badge variant="light" color={BATCH_STATUS[b.status].color}>{BATCH_STATUS[b.status].label}</Badge></Table.Td>
                    </Table.Tr>
                  ))}
                </Table.Tbody>
              </Table>
            </Table.ScrollContainer>
          ) : <Text c="dimmed" size="sm">עוד לא נקלטו דוחות.</Text>}
        </Paper>
      )}</QueryState>
      {adding && <NewReport onClose={() => setAdding(false)} />}
    </Stack>
  );
}
