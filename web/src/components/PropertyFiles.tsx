import { ActionIcon, Alert, Badge, Button, Card, FileInput, Group, Image, Modal, Paper, Progress, Select, SimpleGrid, Stack, Table, Tabs, Text, TextInput, Title } from '@mantine/core';
import { modals } from '@mantine/modals';
import { unzip, type Unzipped } from 'fflate';
import { notifications } from '@mantine/notifications';
import { IconExternalLink, IconFileText, IconFileZip, IconLock, IconTrash, IconUpload } from '@tabler/icons-react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { useState } from 'react';
import { useAccess } from '../lib/access';
import { date } from '../lib/format';
import { must, supabase } from '../lib/supabase';
import type { Country } from '../lib/types';
import { inViewer, viewerUrl } from '../lib/viewer';
import { docTypeOptions, groupOf, isSensitive, typeInGroup, typeLabel, type FileGroup } from '../lib/fileGroups';
import { useFileGroups } from '../lib/fileCategories';
import { docTypeFor, folderGroup, foldersOf, pathKey, skipReason } from '../lib/driveZip';

// A property's files in groups with previews (SPEC decisions 102, 104, 106): purchase and
// ownership documents, receipts, photos, floor plans, and every other document. Files are
// added one by one or from a ZIP, renamed, moved between groups and deleted. Photos and plans are not sensitive and
// show at once; a purchase document is sensitive, so it previews only when opened, and
// every opening is logged (as for any document).

interface Doc { id: string; doc_type: string; storage_path: string; sensitive: boolean; file_name: string | null; uploaded_at: string }

const isImage = (d: Doc) => /\.(jpe?g|png|webp|gif|heic)$/i.test(d.file_name ?? d.storage_path);
const isDoc = (d: Doc) => inViewer(d.file_name ?? d.storage_path);
const safeName = (name: string) => name.normalize('NFKD').replace(/[^\w.-]+/g, '_').slice(-120);
const PAGE = 24;
const MIME: Record<string, string> = { pdf: 'application/pdf', jpg: 'image/jpeg', jpeg: 'image/jpeg', png: 'image/png', webp: 'image/webp', heic: 'image/heic', doc: 'application/msword',
  docx: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document', xlsx: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet', xls: 'application/vnd.ms-excel' };

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
  if (isDoc(doc)) return <iframe src={viewerUrl(url, true)} loading="lazy" title={doc.file_name ?? ''} style={{ width: '100%', height, border: 0, borderRadius: 4, pointerEvents: 'none' }} />;
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
  const [name, setName] = useState('');
  const [zipOpen, setZipOpen] = useState(false);
  // The ZIP's folders, each with where its files go ('auto' or a group); a file may differ.
  const [zip, setZip] = useState<{ bytes: Map<string, Uint8Array>; folders: { name: string; files: string[]; skipped: { path: string; why: string }[]; dest: string; perFile: Record<string, string> }[]; skipped: { path: string; why: string }[] } | null>(null);
  const [zipProgress, setZipProgress] = useState<{ done: number; total: number; added: number; existed: number; failed: string[] } | null>(null);
  const canEdit = access.canEdit(country);
  const GROUPS = useFileGroups();

  const all = docs.data ?? [];
  const group = GROUPS.find((g) => g.key === tab) ?? GROUPS[0];
  const inGroup = (g: FileGroup) => all.filter((d) => groupOf(d.doc_type, GROUPS) === g.key);
  const shown = inGroup(group).slice(0, limit);
  const free = shown.filter((d) => !d.sensitive);
  const thumbs = useThumbs(free);

  async function open(d: Doc) {
    const log = await supabase.rpc('log_document_access', { doc: d.id });
    if (log.error) { notifications.show({ color: 'red', message: log.error.message }); return; }
    const { data, error: e } = await supabase.storage.from('documents').createSignedUrl(d.storage_path, 600);
    if (e) notifications.show({ color: 'red', message: e.message }); else { setViewing({ doc: d, url: data.signedUrl }); setName(d.file_name ?? ''); }
  }

  async function rename() {
    const r = await supabase.from('documents').update({ file_name: name.trim() }).eq('id', viewing!.doc.id);
    if (r.error) { notifications.show({ color: 'red', message: r.error.message }); return; }
    notifications.show({ color: 'teal', message: 'השם עודכן' });
    setViewing({ ...viewing!, doc: { ...viewing!.doc, file_name: name.trim() } });
    await qc.invalidateQueries({ queryKey: key });
  }

  // The file first, then its row (the file may be deleted only while its row exists).
  const remove = (d: Doc) => modals.openConfirmModal({
    title: 'מחיקת קובץ', children: <Text size="sm">"{d.file_name ?? d.storage_path.split('/').pop()}" יימחק לצמיתות. המחיקה נרשמת ביומן.</Text>,
    labels: { confirm: 'מחיקה', cancel: 'ביטול' }, confirmProps: { color: 'red' },
    onConfirm: async () => {
      const st = await supabase.storage.from('documents').remove([d.storage_path]);
      if (st.error) { notifications.show({ color: 'red', message: st.error.message }); return; }
      const r = await supabase.from('documents').delete().eq('id', d.id);
      if (r.error) { notifications.show({ color: 'red', message: r.error.message }); return; }
      notifications.show({ color: 'teal', message: 'הקובץ נמחק' });
      setViewing(null);
      await qc.invalidateQueries({ queryKey: key });
    },
  });

  async function readZip(f: File | null) {
    setZip(null); setZipProgress(null);
    if (!f) return;
    const out = await new Promise<Unzipped>((ok, bad) => f.arrayBuffer().then((b) => unzip(new Uint8Array(b), (e, d) => (e ? bad(e) : ok(d)))));
    const bytes = new Map<string, Uint8Array>(), skipped: { path: string; why: string }[] = [];
    for (const [path, b] of Object.entries(out)) {
      if (path.endsWith('/')) continue;
      const why = skipReason({ path, size: b.length });
      if (why) skipped.push({ path, why }); else bytes.set(path, b);
    }
    // Every folder at every depth, under the ZIP's own root folder; the category its name
    // says is proposed ("מסמכי רכישה ובעלות" → purchase). A folder whose files are all
    // skipped (only videos, say) still shows, with why.
    const why = new Map(skipped.map((x) => [x.path, x.why]));
    const folders = [...foldersOf([...bytes.keys(), ...why.keys()])].map(([name, list]) => ({
      name, dest: folderGroup(name, GROUPS) ?? 'auto', perFile: {} as Record<string, string>,
      files: list.filter((p) => bytes.has(p)), skipped: list.filter((p) => why.has(p)).map((p) => ({ path: p, why: why.get(p)! })),
    }));
    setZip({ bytes, folders, skipped });
  }
  const zipType = (folder: { dest: string; perFile: Record<string, string> }, path: string) => {
    const dest = folder.perFile[path] ?? folder.dest;
    const guessed = docTypeFor(path);
    return dest === 'auto' ? guessed : typeInGroup(dest, guessed, GROUPS);
  };
  const setFolder = (i: number, patch: Partial<NonNullable<typeof zip>['folders'][number]>) =>
    setZip((z) => z && { ...z, folders: z.folders.map((f, j) => (j === i ? { ...f, ...patch } : f)) });
  const zipTotal = zip?.folders.reduce((a, f) => a + f.files.length, 0) ?? 0;

  async function uploadZip() {
    const state = { done: 0, total: zipTotal, added: 0, existed: 0, failed: [] as string[] };
    setZipProgress({ ...state });
    for (const folder of zip!.folders) for (const p of folder.files) {
      const fileName = p.split('/').pop()!;
      const type = zipType(folder, p);
      const path = `${country}/property/${propertyId}/zip_${pathKey(p)}_${safeName(fileName)}`;
      const id = crypto.randomUUID();
      const row = await supabase.from('documents').insert({ id, entity_type: 'property', entity_id: propertyId, country_code: country, doc_type: type,
        storage_path: path, sensitive: isSensitive(type, GROUPS), file_name: fileName, source: `zip:${p}`.slice(0, 500) });
      if (row.error?.code === '23505') state.existed++;
      else if (row.error) state.failed.push(`${p}: ${row.error.message}`);
      else {
        const up = await supabase.storage.from('documents').upload(path, new Blob([zip!.bytes.get(p)! as Uint8Array<ArrayBuffer>]), { upsert: true, contentType: MIME[fileName.split('.').pop()?.toLowerCase() ?? ''] });
        if (up.error) { await supabase.from('documents').delete().eq('id', id); state.failed.push(`${p}: ${up.error.message}`); } else state.added++;
      }
      state.done++;
      setZipProgress({ ...state });
    }
    await qc.invalidateQueries({ queryKey: key });
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
        {canEdit && (
          <Group gap="xs">
            <Button size="xs" variant="default" leftSection={<IconFileZip size={14} />} onClick={() => setZipOpen(true)}>העלאת ZIP</Button>
            <Button size="xs" variant="light" leftSection={<IconUpload size={14} />} onClick={() => setAdding(true)}>הוספה ל"{group.label}"</Button>
          </Group>
        )}
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
                    <Badge size="xs" variant="light">{typeLabel(d.doc_type, GROUPS)}</Badge>
                    <Group gap={2} wrap="nowrap">
                      <Text size="xs" c="dimmed">{date(d.uploaded_at.slice(0, 10))}</Text>
                      {canEdit && <ActionIcon size="xs" variant="subtle" color="red" aria-label="מחיקה" onClick={(e) => { e.stopPropagation(); remove(d); }}><IconTrash size={12} /></ActionIcon>}
                    </Group>
                  </Group>
                </Card>
              );
            })}
          </SimpleGrid>
          {inGroup(group).length > limit && <Button mt="sm" variant="subtle" size="xs" onClick={() => setLimit((n) => n + PAGE)}>עוד ({inGroup(group).length - limit})</Button>}
        </>
      )}
      {group.sensitive && <Text size="xs" c="dimmed" mt="xs">המסמכים כאן רגישים: התצוגה נפתחת בלחיצה, וכל פתיחה נרשמת ביומן.</Text>}

      {viewing && (
        <Modal opened onClose={() => setViewing(null)} size="xl" title={viewing.doc.file_name ?? 'קובץ'}>
          <Stack>
            {isImage(viewing.doc) ? <Image src={viewing.url} fit="contain" mah="75vh" alt="" />
              : isDoc(viewing.doc) ? <>
                <iframe src={viewerUrl(viewing.url, true)} title="" style={{ width: '100%', height: '75vh', border: 0 }} />
                <Text size="xs" c="dimmed">התצוגה של Google. אם היא לא נטענת, <a href={viewing.url} target="_blank" rel="noopener noreferrer">פתיחת הקובץ עצמו</a>.</Text>
              </>
              : <Text size="sm">אין תצוגה מקדימה לסוג הקובץ הזה.</Text>}
            {canEdit && (
              <Group gap="xs" align="flex-end">
                <TextInput size="xs" label="שם הקובץ" value={name} onChange={(e) => setName(e.currentTarget.value)} style={{ flex: 1 }} />
                <Button size="xs" variant="light" disabled={!name.trim() || name.trim() === (viewing.doc.file_name ?? '')} onClick={rename}>שמירת השם</Button>
                <Button size="xs" variant="subtle" color="red" leftSection={<IconTrash size={14} />} onClick={() => remove(viewing.doc)}>מחיקה</Button>
              </Group>
            )}
            <Group justify="space-between">
              {canEdit ? <Select size="xs" w={240} label="סוג (קובע את הלשונית)" data={docTypeOptions(GROUPS)} value={viewing.doc.doc_type} allowDeselect={false}
                onChange={async (t) => {
                  if (!t || t === viewing.doc.doc_type) return;
                  // A file moved to photos or plans stops being sensitive, and back.
                  const r = await supabase.from('documents').update({ doc_type: t, sensitive: isSensitive(t, GROUPS) }).eq('id', viewing.doc.id);
                  if (r.error) { notifications.show({ color: 'red', message: r.error.message }); return; }
                  notifications.show({ color: 'teal', message: `סומן כ${typeLabel(t, GROUPS)}` });
                  setViewing({ ...viewing, doc: { ...viewing.doc, doc_type: t, sensitive: isSensitive(t, GROUPS) } });
                  await qc.invalidateQueries({ queryKey: key });
                }} /> : <span />}
              <Button component="a" href={isDoc(viewing.doc) ? viewerUrl(viewing.url) : viewing.url} target="_blank" rel="noopener noreferrer" variant="light" leftSection={<IconExternalLink size={14} />}>פתיחה בלשונית חדשה</Button></Group>
          </Stack>
        </Modal>
      )}

      {zipOpen && (
        <Modal opened onClose={() => setZipOpen(false)} title="העלאת ZIP לנכס הזה" size="xl">
          <Stack>
            <FileInput label="קובץ ZIP" accept=".zip" placeholder="בחירת קובץ" leftSection={<IconFileZip size={16} />}
              onChange={(f) => readZip(f).catch((e) => notifications.show({ color: 'red', message: `לא הצלחתי לפתוח: ${(e as Error).message}` }))} disabled={!!zipProgress && zipProgress.done < zipProgress.total} />
            {zip && (() => {
              const dest = [{ value: 'auto', label: 'אוטומטי (לפי השם)' }, ...GROUPS.map((g) => ({ value: g.key, label: g.label }))];
              return (
                <Stack gap="xs">
                  <Group justify="space-between">
                    <Text size="sm">{zip.folders.length} תיקיות · {zipTotal} קבצים{zip.skipped.length ? ` · ${zip.skipped.length} לא יועלו (פרטי בנק, סיסמאות, סרטונים)` : ''}</Text>
                    <Select size="xs" w={200} placeholder="לאן, לכל התיקיות" data={dest} value={null}
                      onChange={(v) => v && setZip({ ...zip, folders: zip.folders.map((f) => ({ ...f, dest: v, perFile: {} })) })} />
                  </Group>
                  <Table striped verticalSpacing={4}>
                    <Table.Thead><Table.Tr><Table.Th>תיקייה</Table.Th><Table.Th>לאן</Table.Th><Table.Th>קבצים</Table.Th></Table.Tr></Table.Thead>
                    <Table.Tbody>{zip.folders.map((f, i) => (
                      <Table.Tr key={f.name}>
                        <Table.Td><Text size="sm">{f.name}</Text>
                          {f.skipped.length > 0 && <Text size="xs" c="dimmed">{f.skipped.length} לא יועלו: {[...new Set(f.skipped.map((x) => x.why))].join(', ')}</Text>}</Table.Td>
                        <Table.Td>{f.files.length ? <Select size="xs" w={190} data={dest} value={f.dest} allowDeselect={false} onChange={(v) => v && setFolder(i, { dest: v, perFile: {} })} /> : <Text size="xs" c="dimmed">אין מה להעלות</Text>}</Table.Td>
                        <Table.Td>
                          <details>
                            <summary><Text span size="sm">{f.files.length}</Text> <Text span size="xs" c="dimmed">{[...new Set(f.files.map((p) => typeLabel(zipType(f, p), GROUPS)))].join(', ')}</Text></summary>
                            <Stack gap={4} mt={6}>{f.files.map((p) => (
                              <Group key={p} gap={6} wrap="nowrap">
                                <Text size="xs" style={{ flex: 1, minWidth: 0 }} truncate title={p}>{p.split('/').pop()}</Text>
                                <Select size="xs" w={170} data={dest} value={f.perFile[p] ?? f.dest} allowDeselect={false} onChange={(v) => v && setFolder(i, { perFile: { ...f.perFile, [p]: v } })} />
                              </Group>
                            ))}</Stack>
                          </details>
                        </Table.Td>
                      </Table.Tr>
                    ))}</Table.Tbody>
                  </Table>
                  <Text size="xs" c="dimmed">הקטגוריה מוצעת לפי שם התיקייה (או התיקייה שמעליה); אפשר לשנות. בקטגוריה שנבחרה, קובץ שהשם שלו מתאים לסוג מסוים בה (למשל נסח) יישמר בסוג הזה.</Text>
                </Stack>
              );
            })()}
            {zipProgress && (
              <Stack gap={4}>
                <Progress value={zipProgress.total ? (zipProgress.done / zipProgress.total) * 100 : 100} />
                <Text size="sm">{zipProgress.done}/{zipProgress.total} · נוספו {zipProgress.added} · כבר היו {zipProgress.existed}{zipProgress.failed.length ? ` · נכשלו ${zipProgress.failed.length}` : ''}</Text>
                {zipProgress.failed.length > 0 && <Alert color="red" p="xs">{zipProgress.failed.slice(0, 8).map((x) => <div key={x}>{x}</div>)}</Alert>}
              </Stack>
            )}
            <Group justify="flex-end">
              <Button variant="default" onClick={() => setZipOpen(false)}>סגירה</Button>
              <Button onClick={uploadZip} disabled={!zipTotal || (!!zipProgress && zipProgress.done < zipProgress.total)}>העלאה</Button>
            </Group>
          </Stack>
        </Modal>
      )}

      {adding && (
        <Modal opened onClose={() => setAdding(false)} title={`הוספה ל"${group.label}"`}>
          <Stack>
            <FileInput label="קבצים" multiple required value={files} onChange={setFiles} placeholder="אפשר לבחור כמה"
              accept={group.key === 'photos' ? 'image/*' : 'image/*,application/pdf,.doc,.docx,.xls,.xlsx'} leftSection={<IconUpload size={16} />} />
            <Text size="xs" c="dimmed">{group.sensitive ? `יישמרו כ"${typeLabel(group.uploadType, GROUPS)}" ורגישים; את הסוג משנים בלחיצה על הקובץ.` : 'לא רגישים: כל מי שרואה את הנכס יראה אותם.'}</Text>
            {error && <Alert color="red">{error}</Alert>}
            <Group justify="flex-end"><Button variant="default" onClick={() => setAdding(false)}>ביטול</Button><Button onClick={upload} loading={busy} disabled={!files.length}>הוספה</Button></Group>
          </Stack>
        </Modal>
      )}
    </Paper>
  );
}
