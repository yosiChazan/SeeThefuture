import { Alert, Anchor, Badge, Button, FileInput, Group, Loader, Paper, Progress, Select, Stack, Switch, Table, Text, Title } from '@mantine/core';
import { useQueryClient } from '@tanstack/react-query';
import { unzip, type Unzipped } from 'fflate';
import { useMemo, useState } from 'react';
import { Link } from 'react-router-dom';
import { useAccess } from '../lib/access';
import { docTypeFor, groupByFolder, matchFolder, pathKey, skipReason, type ZipFile } from '../lib/driveZip';
import { isCurrentOwnership, propertyTitle } from '../lib/format';
import { useProperties } from '../lib/queries';
import { supabase } from '../lib/supabase';

// Documents from a Drive folder downloaded as ZIP (SPEC decision 100). Each apartment
// folder is matched to an apartment (checked by a person), then its files are uploaded as
// the apartment's documents; a passport goes to the owner's card when there is one owner.
// Importing the same ZIP again skips what is already in.

const TYPE_HE: Record<string, string> = {
  poa: 'ייפוי כוח', passport: 'דרכון', payment_proof: 'הוכחת תשלום', land_registry: 'נסח טאבו', purchase_contract: 'חוזה רכישה',
  bank_document: 'מסמך בנק', photo: 'תמונה', attachment: 'מסמך אחר',
};
const MIME: Record<string, string> = { pdf: 'application/pdf', jpg: 'image/jpeg', jpeg: 'image/jpeg', png: 'image/png', webp: 'image/webp', heic: 'image/heic', doc: 'application/msword',
  docx: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document', xlsx: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet', xls: 'application/vnd.ms-excel' };
const safeName = (s: string) => s.normalize('NFKD').replace(/[^\w.-]+/g, '_').slice(-100);
const readZip = (f: File) => f.arrayBuffer().then((b) => new Promise<Unzipped>((ok, bad) => unzip(new Uint8Array(b), (e, d) => (e ? bad(e) : ok(d)))));

interface Folder { name: string; files: ZipFile[]; skipped: (ZipFile & { why: string })[]; target: string | null; sure: boolean; include: boolean }

export function DriveZipImport() {
  const access = useAccess();
  const qc = useQueryClient();
  const props = useProperties();
  const [zips, setZips] = useState<File[]>([]);
  const [data, setData] = useState<Map<string, Uint8Array>>(new Map());
  const [folders, setFolders] = useState<Folder[]>([]);
  const [reading, setReading] = useState(false);
  const [progress, setProgress] = useState<{ done: number; total: number; added: number; existed: number; failed: string[] } | null>(null);
  const [error, setError] = useState<string | null>(null);

  const editable = useMemo(() => (props.data ?? []).filter((p) => access.canEdit(p.country_code)), [props.data, access]);
  const targets = useMemo(() => editable.map((p) => ({
    id: p.id, building: p.building.name, unit: p.unit_no, owners: p.ownerships.filter((o) => isCurrentOwnership(o)).map((o) => o.party.display_name),
  })), [editable]);
  const options = useMemo(() => editable.map((p) => ({ value: p.id, label: propertyTitle(p) })).sort((a, b) => a.label.localeCompare(b.label)), [editable]);
  const byId = useMemo(() => new Map(editable.map((p) => [p.id, p])), [editable]);

  async function read(files: File[]) {
    setZips(files); setError(null); setProgress(null); setReading(true);
    try {
      const all = new Map<string, Uint8Array>();
      for (const f of files) for (const [path, bytes] of Object.entries(await readZip(f))) if (!path.endsWith('/')) all.set(path, bytes);
      setData(all);
      const groups = groupByFolder([...all].map(([path, b]) => ({ path, size: b.length })));
      setFolders([...groups].map(([name, list]) => {
        const skipped = list.map((f) => ({ ...f, why: skipReason(f) ?? '' })).filter((f) => f.why);
        const m = matchFolder(name, targets);
        return { name, files: list.filter((f) => !skipReason(f)), skipped, target: m.id, sure: m.sure, include: !!m.id };
      }).sort((a, b) => Number(!!a.target) - Number(!!b.target) || a.name.localeCompare(b.name)));
    } catch (e) { setError(`לא הצלחתי לפתוח את הקובץ: ${(e as Error).message}`); } finally { setReading(false); }
  }

  // The original path inside the ZIP, for a file regrouped without its root folder.
  const original = (rel: string) => [...data.keys()].find((k) => k === rel || k.endsWith(`/${rel}`))!;

  async function upload() {
    const chosen = folders.filter((f) => f.include && f.target);
    const total = chosen.reduce((a, f) => a + f.files.length, 0);
    const state = { done: 0, total, added: 0, existed: 0, failed: [] as string[] };
    setProgress({ ...state });
    for (const f of chosen) {
      const p = byId.get(f.target!)!;
      const owners = p.ownerships.filter((o) => isCurrentOwnership(o));
      for (const file of f.files) {
        const name = file.path.split('/').pop()!;
        const type = docTypeFor(file.path);
        const toParty = type === 'passport' && owners.length === 1;
        const entityType = toParty ? 'party' : 'property';
        const entityId = toParty ? owners[0].party.id : p.id;
        const path = `${p.country_code}/${entityType}/${entityId}/zip_${pathKey(file.path)}_${safeName(name)}`;
        const id = crypto.randomUUID();
        const row = await supabase.from('documents').insert({
          id, entity_type: entityType, entity_id: entityId, country_code: p.country_code, doc_type: type,
          storage_path: path, sensitive: type !== 'photo', file_name: name, source: `drive-zip:${file.path}`.slice(0, 500),
        });
        if (row.error?.code === '23505') state.existed++;
        else if (row.error) state.failed.push(`${file.path}: ${row.error.message}`);
        else {
          const ext = name.split('.').pop()?.toLowerCase() ?? '';
          const up = await supabase.storage.from('documents').upload(path, new Blob([data.get(original(file.path))! as Uint8Array<ArrayBuffer>]), { contentType: MIME[ext], upsert: true });
          if (up.error) { await supabase.from('documents').delete().eq('id', id); state.failed.push(`${file.path}: ${up.error.message}`); } else state.added++;
        }
        state.done++;
        setProgress({ ...state });
      }
    }
    await qc.invalidateQueries();
  }

  const set = (i: number, patch: Partial<Folder>) => setFolders((fs) => fs.map((f, j) => (j === i ? { ...f, ...patch } : f)));
  const chosen = folders.filter((f) => f.include && f.target);
  const fileCount = chosen.reduce((a, f) => a + f.files.length, 0);
  const skippedAll = folders.flatMap((f) => f.skipped.map((s) => ({ ...s, folder: f.name })));

  return (
    <Stack>
      <Title order={2}>ייבוא מסמכים מ-ZIP</Title>
      <Text size="sm" c="dimmed">
        מורידים מהדרייב את התיקייה (למשל "פארק LAKE CITY") כ-ZIP: לחיצה ימנית ← הורדה. הדרייב עלול לפצל תיקייה גדולה לכמה קבצי ZIP: בוחרים את כולם יחד.
        כל תיקיית דירה מותאמת לדירה במערכת; בודקים, מתקנים, ומעלים. פרטי חשבון בנק, סיסמאות וכרטיסים לא מועלים.
      </Text>
      <FileInput label="קובצי ZIP" placeholder="בחירת קבצים" accept=".zip" multiple value={zips} onChange={(f) => f.length && read(f)} disabled={reading || (!!progress && progress.done < progress.total)} w={360} />
      {reading && <Group><Loader size="sm" /><Text size="sm">פותח את הקבצים…</Text></Group>}
      {error && <Alert color="red">{error}</Alert>}
      {props.isLoading && <Loader size="sm" />}

      {folders.length > 0 && (
        <Paper withBorder p="md">
          <Group justify="space-between" mb="sm">
            <Text fw={600}>{folders.length} תיקיות · {folders.filter((f) => f.target).length} הותאמו · {fileCount} קבצים להעלאה</Text>
            <Button onClick={upload} disabled={!fileCount || (!!progress && progress.done < progress.total)}>העלאת {fileCount} קבצים</Button>
          </Group>
          {progress && (
            <Stack gap={4} mb="sm">
              <Progress value={progress.total ? (progress.done / progress.total) * 100 : 100} />
              <Text size="sm">{progress.done}/{progress.total} · נוספו {progress.added} · כבר היו {progress.existed}{progress.failed.length ? ` · נכשלו ${progress.failed.length}` : ''}</Text>
              {progress.failed.length > 0 && <Alert color="red" p="xs">{progress.failed.slice(0, 10).map((x) => <div key={x}>{x}</div>)}</Alert>}
            </Stack>
          )}
          <Table.ScrollContainer minWidth={760}>
            <Table striped verticalSpacing={4}>
              <Table.Thead><Table.Tr><Table.Th>להעלות</Table.Th><Table.Th>תיקייה בדרייב</Table.Th><Table.Th>דירה במערכת</Table.Th><Table.Th>קבצים</Table.Th></Table.Tr></Table.Thead>
              <Table.Tbody>{folders.map((f, i) => (
                <Table.Tr key={f.name}>
                  <Table.Td><Switch checked={f.include} disabled={!f.target} onChange={(e) => set(i, { include: e.currentTarget.checked })} /></Table.Td>
                  <Table.Td><Text size="sm">{f.name}</Text></Table.Td>
                  <Table.Td>
                    <Group gap={6} wrap="nowrap">
                      <Select size="xs" w={300} searchable clearable placeholder="בחירת דירה" data={options} value={f.target}
                        onChange={(v) => set(i, { target: v, sure: false, include: !!v })} nothingFoundMessage="לא נמצא" />
                      {f.target && (f.sure ? <Badge color="teal" variant="light">שם הבעלים תואם</Badge> : <Badge color="yellow" variant="light">לבדוק</Badge>)}
                      {f.target && <Anchor component={Link} to={`/properties/${f.target}`} target="_blank" size="xs">פתיחה</Anchor>}
                    </Group>
                  </Table.Td>
                  <Table.Td><Text size="sm">{f.files.length}{f.skipped.length ? <Text span c="dimmed" size="xs"> (+{f.skipped.length} לא יועלו)</Text> : null}</Text>
                    <Text size="xs" c="dimmed">{[...new Set(f.files.map((x) => TYPE_HE[docTypeFor(x.path)]))].join(', ')}</Text></Table.Td>
                </Table.Tr>
              ))}</Table.Tbody>
            </Table>
          </Table.ScrollContainer>
          {skippedAll.length > 0 && (
            <details style={{ marginTop: 12 }}>
              <summary><Text span size="sm">{skippedAll.length} קבצים לא יועלו</Text></summary>
              <Table mt="xs"><Table.Tbody>{skippedAll.map((s) => (
                <Table.Tr key={s.folder + s.path}><Table.Td><Text size="xs">{s.path}</Text></Table.Td><Table.Td><Text size="xs" c="dimmed">{s.why}</Text></Table.Td></Table.Tr>
              ))}</Table.Tbody></Table>
            </details>
          )}
        </Paper>
      )}
    </Stack>
  );
}
