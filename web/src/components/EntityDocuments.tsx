import { Alert, Anchor, Badge, Button, Checkbox, FileInput, Group, Modal, Paper, Select, Stack, Table, Text, Title } from '@mantine/core';
import { notifications } from '@mantine/notifications';
import { IconUpload } from '@tabler/icons-react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { useState } from 'react';
import { useAccess } from '../lib/access';
import { date } from '../lib/format';
import { must, supabase } from '../lib/supabase';
import { documentLink } from '../lib/viewer';
import type { Country } from '../lib/types';
import { QueryState } from './common';

interface Doc { id: string; doc_type: string; storage_path: string; sensitive: boolean; file_name: string | null; uploaded_at: string }
export interface DocType { value: string; label: string }

const safeName = (name: string) => name.normalize('NFKD').replace(/[^\w.-]+/g, '_').slice(-120);

// Documents of one record in one country, e.g. a lease's signed contract and appendices
// (SPEC decision 68). Sensitive by default; a sensitive file needs the country's
// sensitive-documents flag to add or see. The row is written before the file, so a file
// never sits in storage without a row that guards it. Every opening is logged.
export function EntityDocuments({ entityType, entityId, country, types, title = 'מסמכים' }: {
  entityType: 'lease' | 'property'; entityId: string; country: Country; types: DocType[]; title?: string;
}) {
  const access = useAccess();
  const qc = useQueryClient();
  const key = ['documents', entityType, entityId];
  const docs = useQuery({
    queryKey: key,
    queryFn: async () => must(await supabase.from('documents').select('id, doc_type, storage_path, sensitive, file_name, uploaded_at')
      .eq('entity_type', entityType).eq('entity_id', entityId).order('uploaded_at')) as Doc[],
  });
  const [adding, setAdding] = useState(false);
  const [type, setType] = useState<string | null>(null);
  const [files, setFiles] = useState<File[]>([]);
  const [sensitive, setSensitive] = useState(true);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const label = (t: string) => types.find((x) => x.value === t)?.label ?? t;

  async function open(d: Doc) {
    const log = await supabase.rpc('log_document_access', { doc: d.id });
    if (log.error) { notifications.show({ color: 'red', message: log.error.message }); return; }
    const link = await documentLink(d.storage_path, d.file_name);
    if (link.error) notifications.show({ color: 'red', message: link.error }); else window.open(link.url, '_blank');
  }

  // Re-marking a document's type (SPEC decision 69).
  async function changeType(d: Doc, t: string) {
    const { error: e } = await supabase.from('documents').update({ doc_type: t }).eq('id', d.id);
    if (e) notifications.show({ color: 'red', message: e.message });
    else notifications.show({ color: 'teal', message: `${d.file_name ?? 'המסמך'} סומן כ${label(t)}` });
    await qc.invalidateQueries({ queryKey: key });
  }

  async function upload() {
    if (!type || !files.length) return;
    setBusy(true); setError(null);
    let failed = false;
    for (const f of files) {
      const id = crypto.randomUUID();
      const path = `${country}/${entityType}/${entityId}/${id}_${safeName(f.name)}`;
      const row = await supabase.from('documents').insert({
        id, entity_type: entityType, entity_id: entityId, country_code: country, doc_type: type,
        storage_path: path, sensitive, file_name: f.name, source: 'upload',
      });
      if (row.error) {
        failed = true;
        setError(row.error.code === '42501' ? 'אין לך הרשאה להוסיף מסמך רגיש במדינה הזו. אפשר לבטל את הסימון "רגיש", או לבקש הרשאה ממנהל המערכת' : row.error.message);
        break;
      }
      const up = await supabase.storage.from('documents').upload(path, f, { contentType: f.type || undefined });
      if (up.error) { await supabase.from('documents').delete().eq('id', id); failed = true; setError(`${f.name}: ${up.error.message}`); break; }
    }
    await qc.invalidateQueries({ queryKey: key });
    setBusy(false);
    if (!failed) { setAdding(false); setFiles([]); setType(null); }
  }

  return (
    <Paper withBorder p="md">
      <Group justify="space-between" mb={4}>
        <Title order={4}>{title}</Title>
        {access.canEdit(country) && <Button size="xs" variant="light" leftSection={<IconUpload size={14} />} onClick={() => setAdding(true)}>הוספת מסמכים</Button>}
      </Group>
      <Text size="xs" c="dimmed" mb="sm">מסמך רגיש מוצג רק למי שיש לו הרשאה למסמכים רגישים במדינה. כל פתיחה נרשמת.</Text>
      <QueryState q={docs}>{(ds) => ds.length ? (
        <Table.ScrollContainer minWidth={480}>
          <Table verticalSpacing="xs">
            <Table.Thead><Table.Tr><Table.Th>סוג</Table.Th><Table.Th>קובץ</Table.Th><Table.Th>נוסף</Table.Th></Table.Tr></Table.Thead>
            <Table.Tbody>
              {ds.map((d) => (
                <Table.Tr key={d.id}>
                  <Table.Td w={210}>
                    <Group gap={6} wrap="nowrap">
                      {access.canEdit(country) ? (
                        <Select size="xs" allowDeselect={false} aria-label="סוג המסמך" value={d.doc_type} style={{ flex: 1 }}
                          data={types.some((t) => t.value === d.doc_type) ? types : [...types, { value: d.doc_type, label: d.doc_type }]}
                          onChange={(v) => v && v !== d.doc_type && changeType(d, v)} />
                      ) : <Text size="sm">{label(d.doc_type)}</Text>}
                      {d.sensitive && <Badge size="xs" variant="light" color="red">רגיש</Badge>}
                    </Group>
                  </Table.Td>
                  <Table.Td><Anchor size="sm" dir="ltr" onClick={() => open(d)}>{d.file_name ?? d.storage_path.split('/').pop()}</Anchor></Table.Td>
                  <Table.Td>{date(d.uploaded_at.slice(0, 10))}</Table.Td>
                </Table.Tr>
              ))}
            </Table.Tbody>
          </Table>
        </Table.ScrollContainer>
      ) : <Text c="dimmed" size="sm">אין מסמכים שאפשר להציג</Text>}</QueryState>

      {adding && (
        <Modal opened onClose={() => setAdding(false)} title="הוספת מסמכים">
          <Stack>
            <Select label="סוג המסמך" required data={types} value={type} onChange={setType} />
            <FileInput label="קבצים" required multiple accept="image/*,application/pdf,.doc,.docx" value={files} onChange={setFiles}
              leftSection={<IconUpload size={16} />} placeholder="אפשר לבחור כמה קבצים" clearable />
            <Checkbox label="מסמך רגיש (רק בעלי הרשאה למסמכים רגישים יראו אותו)" checked={sensitive} onChange={(e) => setSensitive(e.currentTarget.checked)} />
            {error && <Alert color="red">{error}</Alert>}
            <Group justify="flex-end">
              <Button variant="default" onClick={() => setAdding(false)}>ביטול</Button>
              <Button onClick={upload} loading={busy} disabled={!type || !files.length}>הוספה</Button>
            </Group>
          </Stack>
        </Modal>
      )}
    </Paper>
  );
}
