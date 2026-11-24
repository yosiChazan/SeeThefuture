import { Alert, Button, Checkbox, Group, Modal, Select, Stack, Text } from '@mantine/core';
import { notifications } from '@mantine/notifications';
import { useQueryClient } from '@tanstack/react-query';
import { useState } from 'react';
import { useAccess } from '../lib/access';
import { COUNTRY_HE, propertyTitle } from '../lib/format';
import { useFileGroups } from '../lib/fileCategories';
import { useClientProperties, useClients } from '../lib/queries';
import { supabase } from '../lib/supabase';
import type { Country } from '../lib/types';

// A picture or a document that came in WhatsApp, kept in the system (SPEC decision 195): on the
// client (as one of its documents) and on any of its apartments (in a file group of the
// apartment). The file is copied from the chat's storage to the documents' storage, with a row
// in app.documents that guards it, like any upload. The same file on the same place twice is
// added once.

const PARTY_TYPES = [
  { value: 'attachment', label: 'מסמך אחר' }, { value: 'passport', label: 'דרכון' }, { value: 'id_card', label: 'תעודת זהות וספח' }, { value: 'poa', label: 'ייפוי כוח' },
];
const safeName = (name: string) => name.normalize('NFKD').replace(/[^\w.-]+/g, '_').slice(-120);

export interface WaFile { id: string; media_path: string; file_name: string | null; kind?: string }

export function WaSaveDoc({ file, partyId, onClose }: { file: WaFile; partyId: string | null; onClose: () => void }) {
  const qc = useQueryClient();
  const access = useAccess();
  const clients = useClients();
  const [client, setClient] = useState<string | null>(partyId);
  const props = useClientProperties(client ?? []);
  const groups = useFileGroups();
  const image = file.kind === 'image' || /\.(jpe?g|png|webp|gif)$/i.test(file.media_path);
  const [onClient, setOnClient] = useState(true);
  const [partyType, setPartyType] = useState('attachment');
  const [chosen, setChosen] = useState<string[]>([]);
  const [group, setGroup] = useState<string>(image ? 'photos' : 'other');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const list = client ? props.data ?? [] : [];
  const name = file.file_name || file.media_path.split('/').pop()!;
  // The client's country: of its apartments, else the first the user may edit.
  const editable = (['UA', 'RO', 'GE', 'GR'] as Country[]).filter((c) => access.canEdit(c));
  const clientCountry = (list.map((p) => p.country_code as Country).find((c) => editable.includes(c)) ?? editable[0]) as Country | undefined;

  async function save() {
    setBusy(true); setError(null);
    try {
      const { data: blob, error: e } = await supabase.storage.from('whatsapp').download(file.media_path);
      if (e || !blob) throw new Error(e?.message ?? 'הקובץ לא נמצא');
      const g = groups.find((x) => x.key === group) ?? groups[groups.length - 1];
      const targets = [
        ...(onClient && client && clientCountry ? [{ type: 'party', id: client, country: clientCountry, docType: partyType, sensitive: true }] : []),
        ...list.filter((p) => chosen.includes(p.id)).map((p) => ({ type: 'property', id: p.id, country: p.country_code as Country, docType: g.uploadType, sensitive: g.sensitive })),
      ];
      let added = 0, there = 0;
      for (const t of targets) {
        const docId = crypto.randomUUID();
        const path = `${t.country}/${t.type}/${t.id}/wa_${file.id.slice(0, 8)}_${safeName(name)}`;
        const row = await supabase.from('documents').insert({ id: docId, entity_type: t.type, entity_id: t.id, country_code: t.country, doc_type: t.docType,
          storage_path: path, sensitive: t.sensitive, file_name: name, source: `whatsapp:${file.id}` });
        if (row.error?.code === '23505') { there++; continue; }
        if (row.error) throw new Error(row.error.code === '42501' ? `אין לך הרשאה להוסיף מסמכים ב${COUNTRY_HE[t.country]}` : row.error.message);
        const up = await supabase.storage.from('documents').upload(path, blob, { upsert: true, contentType: blob.type || undefined });
        if (up.error) { await supabase.from('documents').delete().eq('id', docId); throw new Error(up.error.message); }
        added++;
      }
      await qc.invalidateQueries({ queryKey: ['documents'] });
      await qc.invalidateQueries({ queryKey: ['wa-saved'] });
      setBusy(false);
      onClose();
      notifications.show({ color: 'teal', message: `נשמר ב-${added} מקומות${there ? `; ב-${there} הוא כבר היה` : ''}` });
    } catch (x) { setError((x as Error).message); setBusy(false); }
  }

  const count = (onClient && client ? 1 : 0) + chosen.length;
  return (
    <Modal opened onClose={onClose} title="שמירה במערכת" size="lg">
      <Stack>
        <Text size="sm" dir="auto">{name}</Text>
        {!partyId && <Select label="הלקוח" searchable placeholder="השיחה לא מקושרת ללקוח: בחירת לקוח" value={client} onChange={(x) => { setClient(x); setChosen([]); }}
          data={(clients.data ?? []).map((c) => ({ value: c.id, label: c.display_name }))} />}
        {client && <>
          <Group align="flex-end">
            <Checkbox label="במסמכים של הלקוח" checked={onClient} onChange={(e) => setOnClient(e.currentTarget.checked)} />
            {onClient && <Select size="xs" w={180} aria-label="סוג המסמך" data={PARTY_TYPES} value={partyType} allowDeselect={false} onChange={(x) => x && setPartyType(x)} />}
          </Group>
          <Stack gap={4}>
            <Text size="sm" fw={600}>בנכסים של הלקוח</Text>
            {props.isLoading ? <Text size="sm" c="dimmed">טוען…</Text> : !list.length ? <Text size="sm" c="dimmed">אין נכסים</Text>
              : list.map((p) => (
                <Checkbox key={p.id} label={`${propertyTitle(p)}${p.building?.city?.name_he ? ` · ${p.building.city.name_he}` : ''}`} checked={chosen.includes(p.id)}
                  onChange={(e) => setChosen(e.currentTarget.checked ? [...chosen, p.id] : chosen.filter((x) => x !== p.id))} />
              ))}
            {chosen.length > 0 && <Select size="xs" w={240} label="בקבוצה בנכס" data={groups.map((g) => ({ value: g.key, label: g.label }))} value={group} allowDeselect={false} onChange={(x) => x && setGroup(x)} />}
          </Stack>
        </>}
        {onClient && client && !clientCountry && <Alert color="orange">אין לך הרשאת עריכה לאף מדינה: אי אפשר לשמור על הלקוח.</Alert>}
        {error && <Alert color="red">{error}</Alert>}
        <Group justify="flex-end">
          <Button variant="default" onClick={onClose}>ביטול</Button>
          <Button onClick={save} loading={busy} disabled={!count}>שמירה{count > 1 ? ` (${count})` : ''}</Button>
        </Group>
      </Stack>
    </Modal>
  );
}
