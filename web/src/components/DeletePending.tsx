import { Alert, Button, Checkbox, Group, Modal, Stack, Table, Text, TextInput } from '@mantine/core';
import { notifications } from '@mantine/notifications';
import { useQueryClient } from '@tanstack/react-query';
import dayjs from 'dayjs';
import { useState } from 'react';
import { useAccess } from '../lib/access';
import { loadDropbox, saveSettings } from '../lib/dropbox';
import { batchFiles, batchNotes, type Batch } from '../lib/intake';
import { must, supabase } from '../lib/supabase';

const WORD = 'מחיקה';

// Deletes reports still waiting for review (SPEC decision 57): nothing of them is
// posted. Two steps: choose the reports, then type the word to confirm. Files pulled
// from Dropbox are marked as not pulled, so the next pull offers them again.
export function DeletePending({ batches, onClose }: { batches: Batch[]; onClose: () => void }) {
  const access = useAccess();
  const qc = useQueryClient();
  const pending = batches.filter((b) => (b.status === 'in_review' || b.status === 'parsed') && access.canEdit(b.country_code));
  const [chosen, setChosen] = useState(new Set(pending.map((b) => b.id)));
  const [step, setStep] = useState<1 | 2>(1);
  const [typed, setTyped] = useState('');
  const [busy, setBusy] = useState(false);

  async function run() {
    setBusy(true);
    const gone: Batch[] = [];
    for (const b of pending.filter((x) => chosen.has(x.id))) {
      try {
        must(await supabase.from('import_batches').delete().eq('id', b.id).in('status', ['parsed', 'in_review']));
        const files = batchFiles(b);
        if (files.length) await supabase.storage.from('imports').remove(files);
        gone.push(b);
      } catch (e) { notifications.show({ color: 'red', title: `${b.source.name}: לא נמחק`, message: (e as Error).message }); }
    }
    // Let the next Dropbox pull offer these files again (admins only can change it).
    if (access.isAdmin && gone.length) {
      try {
        const d = await loadDropbox();
        if (d?.settings.files) {
          const files = { ...d.settings.files };
          for (const b of gone) { const name = batchNotes(b)?.file_name; if (name) delete files[name]; }
          await saveSettings({ ...d.settings, files });
        }
      } catch { /* not connected to Dropbox: nothing to reset */ }
    }
    setBusy(false);
    notifications.show({ color: 'teal', message: `נמחקו ${gone.length} דוחות` });
    await qc.invalidateQueries({ queryKey: ['import-batches'] });
    onClose();
  }

  const toggle = (id: string, on: boolean) => setChosen((s) => { const n = new Set(s); if (on) n.add(id); else n.delete(id); return n; });
  const allOn = chosen.size === pending.length;
  return (
    <Modal opened onClose={onClose} title="מחיקת דוחות שממתינים לאישור" size="xl">
      {!pending.length ? <Text size="sm">אין דוחות שממתינים לאישור.</Text> : step === 1 ? (
        <Stack>
          <Text size="sm">דוח שממתין לאישור עוד לא נרשם, ולכן אפשר למחוק אותו לגמרי. דוחות שאושרו לא נמחקים: אותם מבטלים מתוך הדוח.</Text>
          <Table.ScrollContainer minWidth={600}>
            <Table verticalSpacing={4}>
              <Table.Thead><Table.Tr>
                <Table.Th w={40}><Checkbox checked={allOn} indeterminate={!allOn && chosen.size > 0} aria-label="הכול"
                  onChange={(e) => setChosen(new Set(e.currentTarget.checked ? pending.map((b) => b.id) : []))} /></Table.Th>
                <Table.Th>מקור</Table.Th><Table.Th>קובץ</Table.Th><Table.Th>התקבל</Table.Th><Table.Th>שורות</Table.Th>
              </Table.Tr></Table.Thead>
              <Table.Tbody>
                {pending.map((b) => (
                  <Table.Tr key={b.id}>
                    <Table.Td><Checkbox checked={chosen.has(b.id)} onChange={(e) => toggle(b.id, e.currentTarget.checked)} aria-label={batchNotes(b)?.file_name ?? b.id} /></Table.Td>
                    <Table.Td>{b.source.name}</Table.Td>
                    <Table.Td dir="ltr" style={{ textAlign: 'right' }}><Text size="xs">{batchNotes(b)?.file_name}</Text></Table.Td>
                    <Table.Td>{dayjs(b.received_at).format('DD.MM.YYYY HH:mm')}</Table.Td>
                    <Table.Td>{b.rows[0]?.count ?? 0}</Table.Td>
                  </Table.Tr>
                ))}
              </Table.Tbody>
            </Table>
          </Table.ScrollContainer>
          <Group justify="flex-end">
            <Button variant="default" onClick={onClose}>ביטול</Button>
            <Button color="red" onClick={() => setStep(2)} disabled={!chosen.size}>המשך ({chosen.size})</Button>
          </Group>
        </Stack>
      ) : (
        <Stack>
          <Alert color="red" title={`${chosen.size} דוחות יימחקו לצמיתות`}>
            הדוחות, השורות שלהם והקבצים המקוריים שנשמרו יימחקו. שום תנועה לא נרשמה מהם, ולכן היתרות לא משתנות.
            קבצים מהדרופבוקס יסומנו מחדש כחדשים, כך שבמשיכה הבאה הם יוצעו שוב.
          </Alert>
          <TextInput label={`כדי לאשר, הקלידו: ${WORD}`} value={typed} onChange={(e) => setTyped(e.currentTarget.value)} autoFocus />
          <Group justify="flex-end">
            <Button variant="default" onClick={() => { setStep(1); setTyped(''); }}>חזרה</Button>
            <Button color="red" onClick={run} loading={busy} disabled={typed.trim() !== WORD}>מחיקה סופית</Button>
          </Group>
        </Stack>
      )}
    </Modal>
  );
}
