import { Alert, Anchor, Badge, Button, FileInput, Group, Modal, Paper, Select, Stack, Table, Text, Title } from '@mantine/core';
import { IconId, IconUpload } from '@tabler/icons-react';
import { IdFromScans } from './IdFromScans';
import { useIdentity } from '../lib/queries';
import { useState } from 'react';
import { notifications } from '@mantine/notifications';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { useAccess } from '../lib/access';
import { COUNTRY_HE, date } from '../lib/format';
import { must, supabase } from '../lib/supabase';
import { documentLink } from '../lib/viewer';
import type { Country } from '../lib/types';
import { QueryState } from './common';

interface Doc { id: string; country_code: Country; doc_type: string; storage_path: string; sensitive: boolean; file_name: string | null; uploaded_at: string }

// Two groups (SPEC decision 64): passports (and ID cards), and everything else.
const PASSPORT_TYPES = ['passport', 'id_card'];
const isPassport = (d: Doc) => PASSPORT_TYPES.includes(d.doc_type);
const DOC_TYPE_HE: Record<string, string> = {
  id_card: 'תעודת זהות וספח', passport: 'דרכון', poa: 'ייפוי כוח', attachment: 'מסמך אחר',
};

// The type of each document can be changed in place (SPEC decision 69): a scan that is
// really a passport or an ID card is marked as one, and moves to the passports group.
const TYPE_OPTIONS = [
  { value: 'passport', label: 'דרכון' }, { value: 'id_card', label: 'תעודת זהות וספח' },
  { value: 'poa', label: 'ייפוי כוח' }, { value: 'attachment', label: 'מסמך אחר' },
];

function DocTable({ docs, canChange, onOpen, onType }: { docs: Doc[]; canChange: (d: Doc) => boolean; onOpen: (d: Doc) => void; onType: (d: Doc, type: string) => void }) {
  if (!docs.length) return <Text c="dimmed" size="sm">אין</Text>;
  return (
    <Table.ScrollContainer minWidth={560}>
      <Table verticalSpacing="xs">
        <Table.Thead>
          <Table.Tr><Table.Th>קובץ</Table.Th><Table.Th>סוג המסמך</Table.Th><Table.Th>מדינה</Table.Th><Table.Th>נוסף</Table.Th></Table.Tr>
        </Table.Thead>
        <Table.Tbody>
          {docs.map((d) => (
            <Table.Tr key={d.id}>
              <Table.Td><Anchor size="sm" dir="ltr" onClick={() => onOpen(d)}>{d.file_name ?? d.storage_path.split('/').pop()}</Anchor></Table.Td>
              <Table.Td w={190}>
                {canChange(d) ? (
                  <Select size="xs" allowDeselect={false} aria-label="סוג המסמך" value={d.doc_type}
                    data={TYPE_OPTIONS.some((o) => o.value === d.doc_type) ? TYPE_OPTIONS : [...TYPE_OPTIONS, { value: d.doc_type, label: DOC_TYPE_HE[d.doc_type] ?? d.doc_type }]}
                    onChange={(v) => v && v !== d.doc_type && onType(d, v)} />
                ) : <Text size="sm">{DOC_TYPE_HE[d.doc_type] ?? d.doc_type}</Text>}
              </Table.Td>
              <Table.Td>{COUNTRY_HE[d.country_code]}</Table.Td>
              <Table.Td>{date(d.uploaded_at.slice(0, 10))}</Table.Td>
            </Table.Tr>
          ))}
        </Table.Tbody>
      </Table>
    </Table.ScrollContainer>
  );
}

const UPLOAD_TYPES = TYPE_OPTIONS;
const safeName = (name: string) => name.normalize('NFKD').replace(/[^\w.-]+/g, '_').slice(-120);

// Adds documents to a person (SPEC decision 65). Every document is sensitive (decision 64),
// so only staff with the country's sensitive-documents flag can add one. The row is
// written first, so a file never sits in storage without a row that guards it.
function UploadDocuments({ partyId, countries, onClose }: { partyId: string; countries: Country[]; onClose: () => void }) {
  const access = useAccess();
  const qc = useQueryClient();
  const editable = (['UA', 'RO', 'GE', 'GR'] as Country[]).filter((c) => access.canEdit(c));
  const [country, setCountry] = useState<Country | null>(countries.find((c) => editable.includes(c)) ?? (editable.length === 1 ? editable[0] : null));
  const [type, setType] = useState<string | null>(null);
  const [files, setFiles] = useState<File[]>([]);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function save() {
    if (!country || !type || !files.length) return;
    setBusy(true); setError(null);
    let failed = false;
    for (const f of files) {
      const id = crypto.randomUUID();
      const path = `${country}/party/${partyId}/${id}_${safeName(f.name)}`;
      const row = await supabase.from('documents').insert({
        id, entity_type: 'party', entity_id: partyId, country_code: country, doc_type: type,
        storage_path: path, sensitive: true, file_name: f.name, source: 'upload',
      });
      if (row.error) {
        failed = true;
        setError(row.error.code === '42501' ? `אין לך הרשאה להוסיף מסמכים רגישים ב${COUNTRY_HE[country]}. מנהל המערכת נותן אותה` : row.error.message);
        break;
      }
      const up = await supabase.storage.from('documents').upload(path, f, { contentType: f.type || undefined });
      if (up.error) {
        await supabase.from('documents').delete().eq('id', id);
        failed = true;
        setError(`${f.name}: ${up.error.message}`);
        break;
      }
    }
    await qc.invalidateQueries({ queryKey: ['documents', partyId] });
    setBusy(false);
    if (!failed) onClose();
  }

  return (
    <Modal opened onClose={onClose} title="הוספת מסמכים">
      <Stack>
        <Select label="סוג המסמך" required data={UPLOAD_TYPES} value={type} onChange={setType} />
        <Select label="מדינה" required description="מי שרואה את המדינה הזו, עם הרשאה למסמכים רגישים, יראה את המסמך"
          data={editable.map((c) => ({ value: c, label: COUNTRY_HE[c] }))} value={country} onChange={(x) => setCountry(x as Country)} />
        <FileInput label="קבצים" required multiple accept="image/*,application/pdf" value={files} onChange={setFiles}
          leftSection={<IconUpload size={16} />} placeholder="אפשר לבחור כמה קבצים" clearable />
        {error && <Alert color="red">{error}</Alert>}
        <Group justify="flex-end">
          <Button variant="default" onClick={onClose}>ביטול</Button>
          <Button onClick={save} loading={busy} disabled={!country || !type || !files.length}>הוספה</Button>
        </Group>
      </Stack>
    </Modal>
  );
}

// A person's documents. Row-level security shows sensitive ones only to staff with the
// country's sensitive-documents flag; every opening is logged.
export function ClientDocuments({ partyId, countries = [] }: { partyId: string; countries?: Country[] }) {
  const access = useAccess();
  const qc = useQueryClient();
  const [uploading, setUploading] = useState(false);
  const [scanning, setScanning] = useState(false);
  const canUpload = access.countries.some((c) => access.canEdit(c));
  const identity = useIdentity(partyId);
  const docs = useQuery({
    queryKey: ['documents', partyId],
    queryFn: async () => must(await supabase.from('documents')
      .select('id, country_code, doc_type, storage_path, sensitive, file_name, uploaded_at')
      .eq('entity_type', 'party').eq('entity_id', partyId).order('uploaded_at').order('file_name')) as Doc[],
  });

  async function open(d: Doc) {
    const log = await supabase.rpc('log_document_access', { doc: d.id });
    if (log.error) { notifications.show({ color: 'red', message: log.error.message }); return; }
    const link = await documentLink(d.storage_path, d.file_name);
    if (link.error) notifications.show({ color: 'red', message: link.error }); else window.open(link.url, '_blank');
  }

  // Moving to "other" files a passport as an attachment; a power of attorney stays one.
  async function setType(d: Doc, type: string) {
    const { error } = await supabase.from('documents').update({ doc_type: type }).eq('id', d.id);
    if (error) notifications.show({ color: 'red', message: error.message });
    else notifications.show({ color: 'teal', message: `${d.file_name ?? 'המסמך'} סומן כ${DOC_TYPE_HE[type] ?? type}` });
    await qc.invalidateQueries({ queryKey: ['documents', partyId] });
  }

  return (
    <Paper withBorder p="md">
      <Group justify="space-between" mb={4}>
        <Title order={4}>מסמכים</Title>
        <Group gap="xs">
          {canUpload && access.canViewSensitive && !!docs.data?.length && (
            <Button size="xs" variant="light" leftSection={<IconId size={14} />} onClick={() => setScanning(true)}>זיהוי ת.ז. מהמסמכים</Button>
          )}
          {canUpload && <Button size="xs" variant="light" leftSection={<IconUpload size={14} />} onClick={() => setUploading(true)}>הוספת מסמכים</Button>}
        </Group>
      </Group>
      {scanning && docs.data && (
        <IdFromScans partyId={partyId} current={identity.data?.id_number ?? null} onClose={() => setScanning(false)}
          primary={docs.data.filter(isPassport)} others={docs.data.filter((d) => !isPassport(d))} />
      )}
      {uploading && <UploadDocuments partyId={partyId} countries={countries} onClose={() => setUploading(false)} />}
      <Text size="xs" c="dimmed" mb="sm">מסמכים רגישים מוצגים רק למי שיש לו הרשאה למסמכים רגישים במדינה. כל פתיחה נרשמת.</Text>
      <QueryState q={docs}>{(ds) => ds.length ? (
        <Stack>
          {([['דרכונים', ds.filter(isPassport)], ['מסמכים נוספים', ds.filter((d) => !isPassport(d))]] as const).map(([title, list]) => (
            <div key={title}>
              <Group gap="xs" mb={4}><Text fw={600} size="sm">{title}</Text><Badge size="sm" variant="light">{list.length}</Badge></Group>
              <DocTable docs={list} canChange={(d) => access.canEdit(d.country_code)} onOpen={open} onType={setType} />
            </div>
          ))}
        </Stack>
      ) : <Text c="dimmed" size="sm">אין מסמכים שאפשר להציג</Text>}</QueryState>
    </Paper>
  );
}
