import { Button, Group, Modal, Select, SimpleGrid, Text, TextInput, Textarea } from '@mantine/core';
import { notifications } from '@mantine/notifications';
import { useQueryClient } from '@tanstack/react-query';
import { useState } from 'react';
import type { ClientRow } from '../lib/queries';
import { supabase } from '../lib/supabase';

// Edits a client's details (SPEC decision 62). Managers' reports name owners in Latin
// letters, and the intake matches them by name: when the display name changes and no
// name as in the reports is set yet, the old name is kept there, so matching goes on.
export function ClientForm({ client, opened, onClose }: { client: ClientRow; opened: boolean; onClose: () => void }) {
  const qc = useQueryClient();
  const [v, setV] = useState({
    display_name: client.display_name, legal_name: client.legal_name ?? '', kind: client.kind,
    phone: client.phone ?? '', email: client.email ?? '', tax_id: client.tax_id ?? '', address: client.address ?? '', notes: client.notes ?? '',
  });
  const [busy, setBusy] = useState(false);
  const set = <K extends keyof typeof v>(k: K, x: (typeof v)[K]) => setV((p) => ({ ...p, [k]: x }));
  const name = v.display_name.trim();
  const renamed = name !== client.display_name;
  const keepOld = renamed && !v.legal_name.trim();
  const blank = (s: string) => s.trim() || null;

  async function save() {
    setBusy(true);
    const { error } = await supabase.from('parties').update({
      display_name: name, legal_name: keepOld ? client.display_name : blank(v.legal_name), kind: v.kind,
      phone: blank(v.phone), email: blank(v.email), tax_id: blank(v.tax_id), address: blank(v.address), notes: blank(v.notes),
    }).eq('id', client.id);
    setBusy(false);
    if (error) { notifications.show({ color: 'red', title: 'השמירה נכשלה', message: error.message }); return; }
    notifications.show({ color: 'teal', message: 'פרטי הלקוח נשמרו' });
    await qc.invalidateQueries();
    onClose();
  }

  return (
    <Modal opened={opened} onClose={onClose} title="עריכת פרטי לקוח" size="lg">
      <SimpleGrid cols={{ base: 1, sm: 2 }}>
        <TextInput label="שם" required value={v.display_name} onChange={(e) => set('display_name', e.currentTarget.value)} error={!name && 'חובה'} />
        <TextInput label="שם כפי שמופיע בדוחות" description="באותיות לטיניות; משמש לזיהוי הבעלים בדוחות המנהלים" dir="ltr"
          value={v.legal_name} onChange={(e) => set('legal_name', e.currentTarget.value)} placeholder={keepOld ? client.display_name : undefined} />
        <Select label="סוג" value={v.kind} allowDeselect={false} onChange={(x) => x && set('kind', x as ClientRow['kind'])}
          data={[{ value: 'person', label: 'אדם' }, { value: 'company', label: 'חברה' }]} />
        <TextInput label="טלפון" dir="ltr" value={v.phone} onChange={(e) => set('phone', e.currentTarget.value)} />
        <TextInput label="מייל" dir="ltr" type="email" value={v.email} onChange={(e) => set('email', e.currentTarget.value)} />
        <TextInput label="מספר מס" value={v.tax_id} onChange={(e) => set('tax_id', e.currentTarget.value)} />
        <TextInput label="כתובת" value={v.address} onChange={(e) => set('address', e.currentTarget.value)} />
      </SimpleGrid>
      <Textarea label="הערות" mt="sm" autosize minRows={2} value={v.notes} onChange={(e) => set('notes', e.currentTarget.value)} />
      {keepOld && <Text size="xs" c="dimmed" mt="xs">השם הקודם, "{client.display_name}", יישמר כשם בדוחות, כדי שהדוחות ימשיכו לזהות את הלקוח.</Text>}
      <Group justify="flex-end" mt="md">
        <Button variant="default" onClick={onClose}>ביטול</Button>
        <Button onClick={save} loading={busy} disabled={!name}>שמירה</Button>
      </Group>
    </Modal>
  );
}
