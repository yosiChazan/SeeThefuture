import { Alert, Badge, Button, Card, FileInput, Group, Image, Modal, Paper, SimpleGrid, Stack, Tabs, Text, Title } from '@mantine/core';
import { notifications } from '@mantine/notifications';
import { IconExternalLink, IconFileText, IconLock, IconUpload } from '@tabler/icons-react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { useState } from 'react';
import { useAccess } from '../lib/access';
import { date } from '../lib/format';
import { must, supabase } from '../lib/supabase';
import type { Country } from '../lib/types';

// A property's files in three groups with previews (SPEC decision 102): purchase and
// ownership documents, photos, and floor plans. Photos and plans are not sensitive and
// show at once; a purchase document is sensitive, so it previews only when opened, and
// every opening is logged (as for any document).

interface Doc { id: string; doc_type: string; storage_path: string; sensitive: boolean; file_name: string | null; uploaded_at: string }

export const PURCHASE_TYPES = ['purchase_contract', 'land_registry', 'land_book', 'caveat', 'poa', 'payment_proof', 'e9'];
const GROUPS = [
  { key: 'purchase', label: 'מסמכי רכישה ובעלות', types: PURCHASE_TYPES, uploadType: 'purchase_contract', sensitive: true },
  { key: 'photos', label: 'תמונות', types: ['photo'], uploadType: 'photo', sensitive: false },
  { key: 'plans', label: 'שרטוט', types: ['floor_plan'], uploadType: 'floor_plan', sensitive: false },
] as const;
const TYPE_HE: Record<string, string> = {
  purchase_contract: 'חוזה רכישה', land_registry: 'נסח טאבו', land_book: 'Land book', caveat: 'הערת אזהרה', poa: 'ייפוי כוח',
  payment_proof: 'הוכחת תשלום', e9: 'E9', photo: 'תמונה', floor_plan: 'שרטוט',
};
const isImage = (d: Doc) => /\.(jpe?g|png|webp|gif|heic)$/i.test(d.file_name ?? d.storage_path);
const isPdf = (d: Doc) => /\.pdf$/i.test(d.file_name ?? d.storage_path);
const safeName = (name: string) => name.normalize('NFKD').replace(/[^\w.-]+/g, '_').slice(-120);
const PAGE = 24;

// Signed links for the files shown without opening (photos, plans), an hour at a time.
function useThumbs(docs: Doc[]) {
  const paths = docs.map((d) => d.storage_path);
  return useQuery({
    queryKey: ['thumbs', paths],
    enabled: paths.length > 0,
    staleTime: 50 * 60 * 1000,
    queryFn: async () => {
      const { data, error } = await supabase.storage.from('documents').createSignedUrls(paths, 3600);
      if (error) throw error;
      return new Map((data ?? []).map((x) => [x.path, x.signedUrl]));
    },
  });
}

function Preview({ doc, url, height }: { doc: Doc; url: string; height: number }) {
  if (isImage(doc)) return <Image src={url} h={height} fit="cover" radius="sm" alt={doc.file_name ?? ''} loading="lazy" />;
  if (isPdf(doc)) return <iframe src={`${url}#toolbar=0&navpanes=0&view=FitH`} title={doc.file_name ?? ''} style={{ width: '100%', height, border: 0, borderRadius: 4, pointerEvents: 'none' }} />;
  return <Stack h={height} align="center" justify="center"><IconFileText size={36} color="var(--mantine-color-gray-5)" /></Stack>;
}

export function PropertyFiles({ propertyId, country }: { propertyId: string; country: Country }) {
  const access = useAccess();
  const qc = useQueryClient();
  const key = ['documents', 'property', propertyId];
  const docs = useQuery({
    queryKey: key,
    queryFn: async () => must(await supabase.from('documents').select('id, doc_type, storage_path, sensitive, file_name, uploaded_at')
      .eq('entity_type', 'property').eq('entity_id', propertyId).order('uploaded_at')) as Doc[],
  });
  const [tab, setTab] = useState<string>('purchase');
  const [limit, setLimit] = useState(PAGE);
  const [viewing, setViewing] = useState<{ doc: Doc; url: string } | null>(null);
  const [adding, setAdding] = useState(false);
  const [files, setFiles] = useState<File[]>([]);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const all = docs.data ?? [];
  const group = GROUPS.find((g) => g.key === tab)!;
  const inGroup = (g: (typeof GROUPS)[number]) => all.filter((d) => (g.types as readonly string[]).includes(d.doc_type));
  const shown = inGroup(group).slice(0, limit);
  const free = shown.filter((d) => !d.sensitive);
  const thumbs = useThumbs(free);

  async function open(d: Doc) {
    const log = await supabase.rpc('log_document_access', { doc: d.id });
    if (log.error) { notifications.show({ color: 'red', message: log.error.message }); return; }
    const { data, error: e } = await supabase.storage.from('documents').createSignedUrl(d.storage_path, 600);
    if (e) notifications.show({ color: 'red', message: e.message }); else setViewing({ doc: d, url: data.signedUrl });
  }

  async function upload() {
    setBusy(true); setError(null);
    try {
      for (const f of files) {
        const id = crypto.randomUUID();
        const path = `${country}/property/${propertyId}/${id}_${safeName(f.name)}`;
        must(await supabase.from('documents').insert({ id, entity_type: 'property', entity_id: propertyId, country_code: country, doc_type: group.uploadType,
          storage_path: path, sensitive: group.sensitive, file_name: f.name, source: 'upload' }));
        const up = await supabase.storage.from('documents').upload(path, f, { contentType: f.type || undefined });
        if (up.error) { await supabase.from('documents').delete().eq('id', id); throw new Error(`${f.name}: ${up.error.message}`); }
      }
      notifications.show({ color: 'teal', message: `${files.length} קבצים נוספו` });
      setAdding(false); setFiles([]);
    } catch (e) { setError((e as Error).message); } finally { setBusy(false); await qc.invalidateQueries({ queryKey: key }); }
  }

  return (
    <Paper withBorder p="md">
      <Group justify="space-between" mb="sm">
        <Title order={4}>קבצים</Title>
        {access.canEdit(country) && <Button size="xs" variant="light" leftSection={<IconUpload size={14} />} onClick={() => setAdding(true)}>הוספה ל"{group.label}"</Button>}
      </Group>
      <Tabs value={tab} onChange={(v) => { if (v) { setTab(v); setLimit(PAGE); } }}>
        <Tabs.List mb="sm">
          {GROUPS.map((g) => <Tabs.Tab key={g.key} value={g.key}>{g.label} ({inGroup(g).length})</Tabs.Tab>)}
        </Tabs.List>
      </Tabs>
      {docs.isLoading ? <Text size="sm" c="dimmed">טוען…</Text> : !shown.length ? <Text size="sm" c="dimmed">אין קבצים</Text> : (
        <>
          <SimpleGrid cols={{ base: 2, sm: 3, md: 4, lg: 6 }} spacing="sm">
            {shown.map((d) => {
              const url = thumbs.data?.get(d.storage_path);
              return (
                <Card key={d.id} withBorder padding={6} radius="md" style={{ cursor: 'pointer' }} onClick={() => open(d)}>
                  <Card.Section>
                    {d.sensitive
                      ? <Stack h={140} align="center" justify="center" gap={4} bg="gray.0"><IconLock size={28} color="var(--mantine-color-gray-6)" /><Text size="xs" c="dimmed">לחיצה לתצוגה</Text></Stack>
                      : url ? <Preview doc={d} url={url} height={140} /> : <Stack h={140} bg="gray.0" />}
                  </Card.Section>
                  <Text size="xs" mt={6} lineClamp={1} dir="auto">{d.file_name ?? d.storage_path.split('/').pop()}</Text>
                  <Group gap={4} justify="space-between">
                    <Badge size="xs" variant="light">{TYPE_HE[d.doc_type] ?? d.doc_type}</Badge>
                    <Text size="xs" c="dimmed">{date(d.uploaded_at.slice(0, 10))}</Text>
                  </Group>
                </Card>
              );
            })}
          </SimpleGrid>
          {inGroup(group).length > limit && <Button mt="sm" variant="subtle" size="xs" onClick={() => setLimit((n) => n + PAGE)}>עוד ({inGroup(group).length - limit})</Button>}
        </>
      )}
      {tab === 'purchase' && <Text size="xs" c="dimmed" mt="xs">מסמכי רכישה הם רגישים: התצוגה נפתחת בלחיצה, וכל פתיחה נרשמת ביומן.</Text>}

      {viewing && (
        <Modal opened onClose={() => setViewing(null)} size="xl" title={viewing.doc.file_name ?? 'קובץ'}>
          <Stack>
            {isImage(viewing.doc) ? <Image src={viewing.url} fit="contain" mah="75vh" alt="" />
              : isPdf(viewing.doc) ? <iframe src={viewing.url} title="" style={{ width: '100%', height: '75vh', border: 0 }} />
              : <Text size="sm">אין תצוגה מקדימה לסוג הקובץ הזה.</Text>}
            <Group justify="flex-end"><Button component="a" href={viewing.url} target="_blank" rel="noopener noreferrer" variant="light" leftSection={<IconExternalLink size={14} />}>פתיחה בלשונית חדשה</Button></Group>
          </Stack>
        </Modal>
      )}

      {adding && (
        <Modal opened onClose={() => setAdding(false)} title={`הוספה ל"${group.label}"`}>
          <Stack>
            <FileInput label="קבצים" multiple required value={files} onChange={setFiles} placeholder="אפשר לבחור כמה"
              accept={group.key === 'photos' ? 'image/*' : 'image/*,application/pdf'} leftSection={<IconUpload size={16} />} />
            <Text size="xs" c="dimmed">{group.sensitive ? 'יישמרו כ"חוזה רכישה" ורגישים; את הסוג אפשר לשנות בטבלת מסמכי הנכס.' : 'לא רגישים: כל מי שרואה את הנכס יראה אותם.'}</Text>
            {error && <Alert color="red">{error}</Alert>}
            <Group justify="flex-end"><Button variant="default" onClick={() => setAdding(false)}>ביטול</Button><Button onClick={upload} loading={busy} disabled={!files.length}>הוספה</Button></Group>
          </Stack>
        </Modal>
      )}
    </Paper>
  );
}
