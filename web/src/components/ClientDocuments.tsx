import { Alert, Badge, Button, Card, FileInput, Group, Image, Modal, Paper, Select, SimpleGrid, Stack, Text, Title } from '@mantine/core';
import { IconFileText, IconId, IconUpload } from '@tabler/icons-react';
import { IdFromScans } from './IdFromScans';
import { useIdentity } from '../lib/queries';
import { useEffect, useRef, useState } from 'react';
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

const isImage = (d: Doc) => /\.(jpe?g|png|webp|gif)$/i.test(d.file_name ?? d.storage_path);
const isPdf = (d: Doc) => /\.pdf$/i.test(d.file_name ?? d.storage_path);

// Previews (SPEC decision 126): a picture or the first page of a PDF, so the office sees
// which file it is without opening it. They are shown only to who may see the document
// (row-level security) and come straight from our storage, never through an outside
// viewer; showing them is logged as a view of each document, once per opening of the card.
function usePreviews(docs: Doc[]) {
  const shown = docs.filter((d) => isImage(d) || isPdf(d));
  const paths = shown.map((d) => d.storage_path);
  const logged = useRef(new Set<string>());
  const q = useQuery({
    queryKey: ['doc-previews', paths], enabled: paths.length > 0, staleTime: 50 * 60 * 1000,
    queryFn: async () => {
      const { data, error } = await supabase.storage.from('documents').createSignedUrls(paths, 3600);
      if (error) throw error;
      // A PDF is shown from a local copy marked as PDF, so a file stored without its type
      // previews instead of downloading.
      return new Map(await Promise.all((data ?? []).map(async (x): Promise<[string, string]> => {
        const path = x.path ?? '', url = x.signedUrl ?? '';
        if (!url || !/\.pdf$/i.test(path)) return [path, url];
        try {
          const blob = await (await fetch(url)).blob();
          return [path, URL.createObjectURL(new Blob([blob], { type: 'application/pdf' }))];
        } catch { return [path, '']; }
      })));
    },
  });
  useEffect(() => {
    if (!q.data) return;
    for (const d of shown) if (!logged.current.has(d.id)) { logged.current.add(d.id); supabase.rpc('log_document_access', { doc: d.id }).then(() => undefined); }
  }, [q.data]);
  return q.data;
}

function Preview({ d, url }: { d: Doc; url?: string }) {
  const h = 150;
  if (url && isImage(d)) return <Image src={url} h={h} fit="cover" alt={d.file_name ?? ''} loading="lazy" />;
  if (url && isPdf(d)) return <iframe src={`${url}#toolbar=0&navpanes=0&scrollbar=0&view=FitH`} loading="lazy" title={d.file_name ?? ''} style={{ width: '100%', height: h, border: 0, pointerEvents: 'none', background: '#fff' }} />;
  return <Stack h={h} align="center" justify="center" bg="gray.0"><IconFileText size={36} color="var(--mantine-color-gray-5)" /></Stack>;
}

function DocGrid({ docs, previews, canChange, onOpen, onType }: { docs: Doc[]; previews?: Map<string, string>; canChange: (d: Doc) => boolean; onOpen: (d: Doc) => void; onType: (d: Doc, type: string) => void }) {
  if (!docs.length) return <Text c="dimmed" size="sm">אין</Text>;
  return (
    <SimpleGrid cols={{ base: 2, sm: 3, md: 4, lg: 5 }} spacing="sm">
      {docs.map((d) => (
        <Card key={d.id} withBorder padding={6} radius="md">
          <Card.Section style={{ cursor: 'pointer' }} onClick={() => onOpen(d)} title="פתיחה">
            <Preview d={d} url={previews?.get(d.storage_path)} />
          </Card.Section>
          <Text size="xs" mt={6} lineClamp={1} dir="auto" style={{ cursor: 'pointer' }} onClick={() => onOpen(d)}>{d.file_name ?? d.storage_path.split('/').pop()}</Text>
          {canChange(d) ? (
            <Select size="xs" mt={4} allowDeselect={false} aria-label="סוג המסמך" value={d.doc_type}
              data={TYPE_OPTIONS.some((o) => o.value === d.doc_type) ? TYPE_OPTIONS : [...TYPE_OPTIONS, { value: d.doc_type, label: DOC_TYPE_HE[d.doc_type] ?? d.doc_type }]}
              onChange={(v) => v && v !== d.doc_type && onType(d, v)} />
          ) : <Badge size="xs" mt={4} variant="light">{DOC_TYPE_HE[d.doc_type] ?? d.doc_type}</Badge>}
          <Group justify="space-between" mt={4} gap={4}>
            <Text size="xs" c="dimmed">{COUNTRY_HE[d.country_code]}</Text>
            <Text size="xs" c="dimmed">{date(d.uploaded_at.slice(0, 10))}</Text>
          </Group>
        </Card>
      ))}
    </SimpleGrid>
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

  const previews = usePreviews(docs.data ?? []);

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
      <Text size="xs" c="dimmed" mb="sm">מסמכים רגישים מוצגים רק למי שיש לו הרשאה למסמכים רגישים במדינה. כל פתיחה, וגם הצגת התצוגה המקדימה, נרשמת.</Text>
      <QueryState q={docs}>{(ds) => ds.length ? (
        <Stack>
          {([['דרכונים', ds.filter(isPassport)], ['מסמכים נוספים', ds.filter((d) => !isPassport(d))]] as const).map(([title, list]) => (
            <div key={title}>
              <Group gap="xs" mb={4}><Text fw={600} size="sm">{title}</Text><Badge size="sm" variant="light">{list.length}</Badge></Group>
              <DocGrid docs={list} previews={previews} canChange={(d) => access.canEdit(d.country_code)} onOpen={open} onType={setType} />
            </div>
          ))}
        </Stack>
      ) : <Text c="dimmed" size="sm">אין מסמכים שאפשר להציג</Text>}</QueryState>
    </Paper>
  );
}
