import { Alert, Button, Group, Modal, Stack, Table, Text } from '@mantine/core';
import { useState, type ReactNode } from 'react';

// One line of the summary. With `before`, the line is a change ("before → after").
export interface SummaryRow { label: string; before?: string | null; after: string | null }

// Lines for an edit: only the fields that changed. Empty values show as "—".
export function changes(fields: { label: string; before: unknown; after: unknown }[]): SummaryRow[] {
  const show = (x: unknown) => (x === null || x === undefined || x === '' ? null : String(x));
  return fields.filter((f) => show(f.before) !== show(f.after)).map((f) => ({ label: f.label, before: show(f.before), after: show(f.after) }));
}

// Lines for something new: every field that has a value.
export function summary(fields: { label: string; value: unknown }[]): SummaryRow[] {
  return fields.filter((f) => f.value !== null && f.value !== undefined && f.value !== '').map((f) => ({ label: f.label, after: String(f.value) }));
}

interface Ask { title: string; rows: SummaryRow[]; note?: ReactNode; action: () => Promise<boolean | void> }

// A window that shows what is about to be saved, and saves only on "אישור" (SPEC decision 67).
// `ask` opens it; render `element` inside the form.
export function useConfirmSave() {
  const [ask, setAsk] = useState<Ask | null>(null);
  const [busy, setBusy] = useState(false);

  async function confirm() {
    if (!ask) return;
    setBusy(true);
    const ok = await ask.action();
    setBusy(false);
    if (ok !== false) setAsk(null);
  }

  const edit = !!ask?.rows.some((r) => r.before !== undefined);
  const element = ask && (
    <Modal opened onClose={() => !busy && setAsk(null)} title={ask.title} size="lg" zIndex={400}>
      <Stack>
        {ask.rows.length ? (
          <Table verticalSpacing={6} withRowBorders>
            {edit && <Table.Thead><Table.Tr><Table.Th>שדה</Table.Th><Table.Th>היה</Table.Th><Table.Th>יהיה</Table.Th></Table.Tr></Table.Thead>}
            <Table.Tbody>
              {ask.rows.map((r) => (
                <Table.Tr key={r.label}>
                  <Table.Td w={160}><Text size="sm" c="dimmed">{r.label}</Text></Table.Td>
                  {edit && <Table.Td><Text size="sm" dir="auto" td="line-through" c="dimmed" style={{ whiteSpace: 'pre-wrap' }}>{r.before ?? '—'}</Text></Table.Td>}
                  <Table.Td><Text size="sm" dir="auto" fw={500} style={{ whiteSpace: 'pre-wrap' }}>{r.after ?? '—'}</Text></Table.Td>
                </Table.Tr>
              ))}
            </Table.Tbody>
          </Table>
        ) : <Alert color="gray">לא שונה כלום.</Alert>}
        {ask.note}
        <Group justify="flex-end">
          <Button variant="default" onClick={() => setAsk(null)} disabled={busy}>חזרה לעריכה</Button>
          <Button onClick={confirm} loading={busy} disabled={!ask.rows.length}>אישור ושמירה</Button>
        </Group>
      </Stack>
    </Modal>
  );
  return { ask: (a: Ask) => setAsk(a), element };
}
