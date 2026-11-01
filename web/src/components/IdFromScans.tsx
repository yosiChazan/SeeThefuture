import { Alert, Badge, Button, Group, Modal, Progress, Stack, Table, Text } from '@mantine/core';
import { notifications } from '@mantine/notifications';
import { useQueryClient } from '@tanstack/react-query';
import { useEffect, useRef, useState } from 'react';
import { IdReader } from '../lib/idocr';
import type { IdCandidate } from '../lib/idnumber';
import { saveIdentity } from '../lib/queries';
import { supabase } from '../lib/supabase';

export interface ScanDoc { id: string; storage_path: string; file_name: string | null }
interface Found extends IdCandidate { doc: ScanDoc }

const HOW_HE: Record<IdCandidate['how'], string> = { mrz: 'שורת הקוד בדרכון', label: 'ליד "מספר זהות"', digits: 'רצף של 9 ספרות' };

// Reads the client's documents in the browser and offers the ID numbers found, each
// valid by the check digit. Nothing is saved until a person picks one (SPEC decision 66).
export function IdFromScans({ partyId, primary, others, current, onClose }: {
  partyId: string; primary: ScanDoc[]; others: ScanDoc[]; current: string | null; onClose: () => void;
}) {
  const qc = useQueryClient();
  const reader = useRef(new IdReader());
  const [queue, setQueue] = useState<ScanDoc[]>(primary.length ? primary : others);
  const [extended, setExtended] = useState(!primary.length);
  const [done, setDone] = useState(0);
  const [found, setFound] = useState<Found[]>([]);
  const [failed, setFailed] = useState<string[]>([]);
  const [running, setRunning] = useState(true);
  const [saving, setSaving] = useState<string | null>(null);

  useEffect(() => () => { void reader.current.close(); }, []);
  useEffect(() => {
    let cancelled = false;
    (async () => {
      setRunning(true);
      for (const d of queue.slice(done)) {
        if (cancelled) return;
        try {
          await supabase.rpc('log_document_access', { doc: d.id });
          const file = await supabase.storage.from('documents').download(d.storage_path);
          if (file.error) throw new Error(file.error.message);
          const ids = await reader.current.read(file.data);
          if (!cancelled) setFound((f) => mergeFound(f, ids.map((c) => ({ ...c, doc: d }))));
        } catch (e) {
          if (!cancelled) setFailed((f) => [...f, `${d.file_name ?? d.storage_path}: ${(e as Error).message}`]);
        }
        if (!cancelled) setDone((n) => n + 1);
      }
      if (!cancelled) setRunning(false);
    })();
    return () => { cancelled = true; };
  }, [queue]); // eslint-disable-line react-hooks/exhaustive-deps

  async function pick(f: Found) {
    setSaving(f.id);
    try {
      await saveIdentity(partyId, f.id, `ocr:${f.doc.id}`);
      notifications.show({ color: 'teal', message: `מספר הזהות ${f.id} נשמר` });
      await qc.invalidateQueries({ queryKey: ['identity', partyId] });
      onClose();
    } catch (e) { notifications.show({ color: 'red', message: (e as Error).message }); setSaving(null); }
  }

  return (
    <Modal opened onClose={onClose} title="זיהוי מספר זהות מהמסמכים" size="lg">
      <Stack>
        <Text size="xs" c="dimmed">הקריאה נעשית במחשב שלך, והסריקות לא נשלחות לשום שירות. מוצגים רק מספרים שעוברים את ספרת הביקורת. לפני השמירה, כדאי לפתוח את המסמך ולוודא.</Text>
        <Progress value={queue.length ? (done / queue.length) * 100 : 100} animated={running} />
        <Text size="sm">{running ? `קורא מסמך ${Math.min(done + 1, queue.length)} מתוך ${queue.length}…` : `נקראו ${queue.length} מסמכים`}</Text>
        {found.length > 0 ? (
          <Table verticalSpacing="xs">
            <Table.Thead><Table.Tr><Table.Th>מספר</Table.Th><Table.Th>איך נמצא</Table.Th><Table.Th>מסמך</Table.Th><Table.Th /></Table.Tr></Table.Thead>
            <Table.Tbody>
              {found.map((f) => (
                <Table.Tr key={f.id}>
                  <Table.Td dir="ltr" style={{ fontFamily: 'monospace' }}>{f.id}{f.id === current && <Badge size="xs" ml={6} color="teal" variant="light">שמור</Badge>}</Table.Td>
                  <Table.Td><Text size="xs">{HOW_HE[f.how]}</Text></Table.Td>
                  <Table.Td><Text size="xs" dir="ltr" lineClamp={1}>{f.doc.file_name}</Text></Table.Td>
                  <Table.Td><Button size="xs" onClick={() => pick(f)} loading={saving === f.id} disabled={f.id === current}>שמירה</Button></Table.Td>
                </Table.Tr>
              ))}
            </Table.Tbody>
          </Table>
        ) : !running && <Alert color="gray">לא נמצא מספר זהות תקין {extended ? 'במסמכים' : 'בדרכונים ובתעודות הזהות'}.</Alert>}
        {!running && !extended && others.length > 0 && (
          <Button variant="light" onClick={() => { setExtended(true); setQueue((q) => [...q, ...others]); }}>לחפש גם ב-{others.length} המסמכים הנוספים</Button>
        )}
        {failed.length > 0 && <Text size="xs" c="red">לא נקראו: {failed.join(' · ')}</Text>}
        <Group justify="flex-end"><Button variant="default" onClick={onClose}>סגירה</Button></Group>
      </Stack>
    </Modal>
  );
}

// The same number from several files: keep it once, with the best way it was found.
function mergeFound(prev: Found[], add: Found[]): Found[] {
  const m = new Map(prev.map((f) => [f.id, f]));
  for (const f of add) { const p = m.get(f.id); if (!p || p.score < f.score) m.set(f.id, f); }
  return [...m.values()].sort((a, b) => b.score - a.score);
}
