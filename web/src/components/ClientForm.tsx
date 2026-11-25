import { ActionIcon, Button, Group, Modal, Select, SimpleGrid, Text, TextInput, Textarea } from '@mantine/core';
import { notifications } from '@mantine/notifications';
import { IconPlus, IconTrash } from '@tabler/icons-react';
import { useQueryClient } from '@tanstack/react-query';
import { useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { useAccess } from '../lib/access';
import { validIsraeliId } from '../lib/idnumber';
import { fullName, suggestSplit } from '../lib/names';
import { saveIdentity, type ClientRow } from '../lib/queries';
import { supabase } from '../lib/supabase';

// Adds a client, or edits one (SPEC decisions 62, 65). Managers' reports name owners in
// Latin letters, and the intake matches them by name: when the display name changes and
// no name as in the reports is set yet, the old name is kept there, so matching goes on.
// `contact`: a new contact rather than a client (SPEC decision 133): with a role (tenant,
// lawyer, supplier…) instead of the client role, listed with the contacts.
const CONTACT_ROLES = [
  { value: 'contact', label: 'איש קשר' }, { value: 'tenant', label: 'שוכר' }, { value: 'manager', label: 'מנהל נכסים' }, { value: 'lawyer', label: 'עו"ד' },
  { value: 'hotel', label: 'מלון' }, { value: 'developer', label: 'יזם' }, { value: 'supplier', label: 'ספק' }, { value: 'marketer', label: 'משווק' },
];
// `initial`: a new person's name and number to start from (a contact card sent in WhatsApp, decision 203);
// `onAdded`: called with the new id instead of going to its card.
export function ClientForm({ client, idNumber = null, opened, onClose, contact = false, initial, onAdded }: { client?: ClientRow; idNumber?: string | null; opened: boolean; onClose: () => void; contact?: boolean;
  initial?: { first_name?: string; last_name?: string; phone?: string; phone_label?: string }; onAdded?: (id: string) => void }) {
  const [role, setRole] = useState('contact');
  useAccess();
  // The ID number is a regular detail, open to all staff (SPEC decision 72).
  const canId = true;
  // A person's name in two parts; a name not split yet starts from the suggested split.
  const split = client && !client.first_name && !client.last_name && client.kind === 'person' ? suggestSplit(client.display_name) : null;
  const [idNo, setIdNo] = useState(idNumber ?? '');
  const qc = useQueryClient();
  const navigate = useNavigate();
  const [v, setV] = useState({
    display_name: client?.display_name ?? '', first_name: client?.first_name ?? split?.first ?? initial?.first_name ?? '', last_name: client?.last_name ?? split?.last ?? initial?.last_name ?? '', legal_name: client?.legal_name ?? '', kind: client?.kind ?? ('person' as ClientRow['kind']),
    phone: client?.phone ?? initial?.phone ?? '', phone_label: client?.phone_label ?? initial?.phone_label ?? '', email: client?.email ?? '', tax_id: client?.tax_id ?? '', address: client?.address ?? '', notes: client?.notes ?? '',
  });
  // More numbers, each with what it is (decision 154).
  const [extra, setExtra] = useState<{ phone: string; label: string }[]>((client?.extra_phones ?? []).map((x) => ({ phone: x.phone, label: x.label ?? '' })));
  const [busy, setBusy] = useState(false);
  const set = <K extends keyof typeof v>(k: K, x: (typeof v)[K]) => setV((p) => ({ ...p, [k]: x }));
  const person = v.kind === 'person';
  const name = person ? fullName(v.first_name, v.last_name) : v.display_name.trim();
  const renamed = !!client && name !== client.display_name;
  const keepOld = renamed && !v.legal_name.trim();
  const blank = (s: string) => s.trim() || null;

  async function save() {
    setBusy(true);
    const fields = {
      display_name: name, first_name: person ? blank(v.first_name) : null, last_name: person ? blank(v.last_name) : null, legal_name: keepOld ? client!.display_name : blank(v.legal_name), kind: v.kind,
      phone: blank(v.phone), phone_label: blank(v.phone_label),
      extra_phones: extra.filter((x) => x.phone.trim()).map((x) => ({ phone: x.phone.trim(), label: x.label.trim() || null })), email: blank(v.email), tax_id: blank(v.tax_id), address: blank(v.address), notes: blank(v.notes),
    };
    const idClean = idNo.replace(/\s/g, '');
    const saveId = async (partyId: string) => {
      if (canId && idClean !== (idNumber ?? '')) await saveIdentity(partyId, idClean || null, 'manual');
    };
    if (client) {
      const { error } = await supabase.from('parties').update(fields).eq('id', client.id);
      let idError: string | null = null;
      if (!error) try { await saveId(client.id); } catch (e) { idError = (e as Error).message; }
      setBusy(false);
      if (error || idError) { notifications.show({ color: 'red', title: 'השמירה נכשלה', message: error?.message ?? idError }); return; }
      notifications.show({ color: 'teal', message: 'פרטי הלקוח נשמרו' });
      await qc.invalidateQueries();
      onClose();
      return;
    }
    // A new client: the party, and its client role so it is listed with the clients.
    const id = crypto.randomUUID();
    const add = await supabase.from('parties').insert({ id, ...fields });
    const who = contact ? 'איש הקשר' : 'הלקוח';
    const added = add.error ? add : await supabase.from('party_roles').insert({ party_id: id, role: contact ? role : 'client' });
    if (!added.error) try { await saveId(id); } catch (e) { notifications.show({ color: 'orange', title: `${who} נוסף, מספר הזהות לא נשמר`, message: (e as Error).message }); }
    setBusy(false);
    if (added.error) { notifications.show({ color: 'red', title: `${who} לא נוסף`, message: added.error.message }); return; }
    notifications.show({ color: 'teal', message: `${who} נוסף` });
    await qc.invalidateQueries();
    onClose();
    if (onAdded) onAdded(id); else navigate(contact ? `/contacts/${id}` : `/clients/${id}`);
  }

  return (
    <Modal opened={opened} onClose={onClose} title={client ? 'עריכת פרטי לקוח' : contact ? 'איש קשר חדש' : 'לקוח חדש'} size="lg">
      {contact && !client && <Select label="תפקיד" mb="sm" w={220} allowDeselect={false} data={CONTACT_ROLES} value={role} onChange={(x) => x && setRole(x)} />}
      <SimpleGrid cols={{ base: 1, sm: 2 }}>
        {person ? (
          <>
            <TextInput label="שם פרטי" value={v.first_name} onChange={(e) => set('first_name', e.currentTarget.value)} />
            <TextInput label="שם משפחה" required value={v.last_name} onChange={(e) => set('last_name', e.currentTarget.value)} error={!v.last_name.trim() && 'חובה'} />
          </>
        ) : (
          <TextInput label="שם החברה" required value={v.display_name} onChange={(e) => set('display_name', e.currentTarget.value)} error={!name && 'חובה'} />
        )}
        <TextInput label="שם כפי שמופיע בדוחות" description="באותיות לטיניות; משמש לזיהוי הבעלים בדוחות המנהלים" dir="ltr"
          value={v.legal_name} onChange={(e) => set('legal_name', e.currentTarget.value)} placeholder={keepOld ? client.display_name : undefined} />
        <Select label="סוג" value={v.kind} allowDeselect={false} onChange={(x) => x && set('kind', x as ClientRow['kind'])}
          data={[{ value: 'person', label: 'לקוח' }, { value: 'company', label: 'חברה' }]} />
        <Group grow gap="xs" align="flex-end">
          <TextInput label="טלפון" dir="ltr" value={v.phone} onChange={(e) => set('phone', e.currentTarget.value)} />
          <TextInput label="תיאור" placeholder="למשל: נייד, וואטסאפ" value={v.phone_label} onChange={(e) => set('phone_label', e.currentTarget.value)} />
        </Group>
        {extra.map((x, i) => (
          <Group key={i} grow gap="xs" align="flex-end" wrap="nowrap">
            <TextInput label={`טלפון נוסף ${i + 1}`} dir="ltr" value={x.phone} onChange={(e) => { const val = e.currentTarget.value; setExtra((l) => l.map((y, j) => (j === i ? { ...y, phone: val } : y))); }} />
            <TextInput label="תיאור" placeholder="למשל: אשתו, משרד" value={x.label} onChange={(e) => { const val = e.currentTarget.value; setExtra((l) => l.map((y, j) => (j === i ? { ...y, label: val } : y))); }} />
            <ActionIcon variant="subtle" color="red" mb={4} style={{ flexGrow: 0 }} onClick={() => setExtra((l) => l.filter((_, j) => j !== i))} aria-label="הסרה"><IconTrash size={16} /></ActionIcon>
          </Group>
        ))}
        <Button size="compact-xs" variant="subtle" leftSection={<IconPlus size={14} />} onClick={() => setExtra((l) => [...l, { phone: '', label: '' }])} w="fit-content">טלפון נוסף</Button>
        <TextInput label="מייל" dir="ltr" type="email" value={v.email} onChange={(e) => set('email', e.currentTarget.value)} />
        {canId && (
          <TextInput label="תעודת זהות" dir="ltr" value={idNo} onChange={(e) => setIdNo(e.currentTarget.value)}
            error={idNo.trim() && /^\d+$/.test(idNo.trim()) && !validIsraeliId(idNo) ? 'ספרת הביקורת לא מתאימה למספר זהות ישראלי' : undefined}
            />
        )}
        <TextInput label="מספר מס" value={v.tax_id} onChange={(e) => set('tax_id', e.currentTarget.value)} />
        <TextInput label="כתובת" value={v.address} onChange={(e) => set('address', e.currentTarget.value)} />
      </SimpleGrid>
      <Textarea label="הערות" mt="sm" autosize minRows={2} value={v.notes} onChange={(e) => set('notes', e.currentTarget.value)} />
      {keepOld && <Text size="xs" c="dimmed" mt="xs">השם הקודם, "{client!.display_name}", יישמר כשם בדוחות, כדי שהדוחות ימשיכו לזהות את הלקוח.</Text>}
      <Group justify="flex-end" mt="md">
        <Button variant="default" onClick={onClose}>ביטול</Button>
        <Button onClick={save} loading={busy} disabled={!name || (person && !v.last_name.trim()) || (!!idNo.trim() && !/^[0-9A-Za-z-]{5,20}$/.test(idNo.replace(/\s/g, '')))}>{client ? 'שמירה' : contact ? 'הוספת איש קשר' : 'הוספת לקוח'}</Button>
      </Group>
    </Modal>
  );
}
