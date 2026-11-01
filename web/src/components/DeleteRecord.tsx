import { Alert, Button, Group, List, Modal, Stack, Text, TextInput, Textarea } from '@mantine/core';
import { notifications } from '@mantine/notifications';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { useState } from 'react';
import { must, supabase } from '../lib/supabase';

export type DeleteKind = 'property' | 'lease' | 'client';
const KIND_HE: Record<DeleteKind, string> = { property: 'הנכס', lease: 'החוזה', client: 'הלקוח' };
const COUNT_HE: Record<string, string> = {
  ownerships: 'רשומות בעלות', leases: 'חוזי שכירות', rent_schedule: 'רשומות שכירות צפויה', management: 'הסכמי ניהול',
  documents: 'מסמכים', id_number: 'מספר זהות', referred: 'לקוחות שהגיעו דרכו (הקישור יוסר)',
};
const WORD = 'מחיקה';

// Deletes a property, a lease or a client entered by mistake (SPEC decision 67). The
// database decides: anything with financial history is refused, and the window says why.
// Otherwise it lists what goes with the record, and deletes after a reason and the typed word.
export function DeleteRecord({ kind, id, name, onClose, onDeleted }: {
  kind: DeleteKind; id: string; name: string; onClose: () => void; onDeleted: () => void;
}) {
  const qc = useQueryClient();
  const [reason, setReason] = useState('');
  const [typed, setTyped] = useState('');
  const [busy, setBusy] = useState(false);
  const preview = useQuery({
    queryKey: ['deletion-preview', kind, id],
    queryFn: async () => must(await supabase.rpc('deletion_preview', { p_kind: kind, p_id: id })) as { blocked: string[]; deletes: Record<string, number> },
    gcTime: 0,
  });

  async function run() {
    setBusy(true);
    const { data, error } = await supabase.rpc('delete_record', { p_kind: kind, p_id: id, p_reason: reason.trim() });
    if (error) { setBusy(false); notifications.show({ color: 'red', title: 'לא נמחק', message: error.message }); return; }
    const files = (data as { files: string[] }).files ?? [];
    if (files.length) {
      const rm = await supabase.storage.from('documents').remove(files);
      if (rm.error) notifications.show({ color: 'orange', title: 'נמחק, אבל הקבצים נשארו באחסון', message: rm.error.message });
    }
    notifications.show({ color: 'teal', message: `${name} נמחק` });
    onDeleted();
    await qc.invalidateQueries();
  }

  const p = preview.data;
  const extra = p ? Object.entries(p.deletes).filter(([, n]) => n > 0) : [];
  return (
    <Modal opened onClose={onClose} title={`מחיקת ${KIND_HE[kind].slice(1)}: ${name}`}>
      <Stack>
        {preview.isLoading && <Text size="sm" c="dimmed">בודק מה קשור…</Text>}
        {preview.error && <Alert color="red">{(preview.error as Error).message}</Alert>}
        {p && p.blocked.length > 0 && (
          <Alert color="orange" title={`אי אפשר למחוק את ${KIND_HE[kind]}`}>
            <List size="sm">{p.blocked.map((b) => <List.Item key={b}>{b}</List.Item>)}</List>
            <Text size="xs" mt="xs">תנועות כספיות לא נמחקות לעולם. כדי שהנכס או הלקוח לא יופיעו כפעילים, סוגרים אותם (תאריך סיום) במקום למחוק.</Text>
          </Alert>
        )}
        {p && !p.blocked.length && (
          <>
            <Alert color="red" title="המחיקה סופית">
              <Text size="sm">{KIND_HE[kind]} יימחק מהמערכת{extra.length ? ', יחד עם:' : '.'}</Text>
              {extra.length > 0 && <List size="sm" mt={4}>{extra.map(([k, n]) => <List.Item key={k}>{n} {COUNT_HE[k] ?? k}</List.Item>)}</List>}
              <Text size="xs" mt="xs">עותק של מה שנמחק נשמר ביומן השינויים, עם הסיבה.</Text>
            </Alert>
            <Textarea label="סיבה" required autosize minRows={2} value={reason} onChange={(e) => setReason(e.currentTarget.value)}
              error={reason && reason.trim().length < 5 ? 'לפחות 5 תווים' : undefined} />
            <TextInput label={`כדי לאשר, הקלידו "${WORD}"`} value={typed} onChange={(e) => setTyped(e.currentTarget.value)} />
          </>
        )}
        <Group justify="flex-end">
          <Button variant="default" onClick={onClose} disabled={busy}>ביטול</Button>
          {p && !p.blocked.length && (
            <Button color="red" onClick={run} loading={busy} disabled={reason.trim().length < 5 || typed.trim() !== WORD}>מחיקה</Button>
          )}
        </Group>
      </Stack>
    </Modal>
  );
}
