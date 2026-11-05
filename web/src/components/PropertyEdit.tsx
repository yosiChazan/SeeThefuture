import { ActionIcon, Alert, Button, Group, Modal, NumberInput, SegmentedControl, Select, SimpleGrid, Stack, Text, TextInput, Textarea } from '@mantine/core';
import { DateInput } from '@mantine/dates';
import { notifications } from '@mantine/notifications';
import { IconPlus, IconTrash } from '@tabler/icons-react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import dayjs from 'dayjs';
import { useState } from 'react';
import { STATUS_HE } from '../lib/format';
import { useClients } from '../lib/queries';
import { must, supabase } from '../lib/supabase';
import type { PropertyStatus } from '../lib/types';

const NEW = '__new__';

interface Editable {
  id: string; unit_no: string; floor: string | null; sqm: number | null; status: PropertyStatus; notes: string | null;
  building: { id: string; name: string; address: string | null; city: { id?: string; name_he: string } };
}

// Edits a property (SPEC decision 95): its details, and the building it is in. Changing
// the building's own name or address changes it for every apartment in it, so the form
// says how many. Owners change elsewhere (OwnershipChange), by date.
export function PropertyEdit({ p, onClose }: { p: Editable; onClose: () => void }) {
  const qc = useQueryClient();
  const [v, setV] = useState({ unit_no: p.unit_no, floor: p.floor ?? '', sqm: (p.sqm ?? '') as number | '', status: p.status, notes: p.notes ?? '' });
  const [buildingId, setBuildingId] = useState(p.building.id);
  const [b, setB] = useState({ name: p.building.name, address: p.building.address ?? '' });
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const geo = useQuery({
    queryKey: ['edit-geo', p.building.id],
    queryFn: async () => {
      const own = must(await supabase.from('buildings').select('city_id').eq('id', p.building.id).single()) as { city_id: string };
      const list = must(await supabase.from('buildings').select('id, name, address, properties(count)').eq('city_id', own.city_id).order('name')) as unknown as
        { id: string; name: string; address: string | null; properties: { count: number }[] }[];
      return { cityId: own.city_id, list };
    },
  });
  const isNew = buildingId === NEW;
  const current = geo.data?.list.find((x) => x.id === buildingId);
  const others = Math.max(0, (current?.properties[0]?.count ?? 1) - (buildingId === p.building.id ? 1 : 0));
  const buildingChanged = !isNew && current && (b.name.trim() !== current.name || (b.address.trim() || null) !== (current.address ?? null));

  async function save() {
    setBusy(true); setError(null);
    try {
      let target = buildingId;
      if (isNew) {
        target = crypto.randomUUID();
        must(await supabase.from('buildings').insert({ id: target, city_id: geo.data!.cityId, name: b.name.trim(), address: b.address.trim() || null }));
      } else if (buildingChanged) {
        must(await supabase.from('buildings').update({ name: b.name.trim(), address: b.address.trim() || null }).eq('id', target));
      }
      const up = await supabase.from('properties').update({
        building_id: target, unit_no: v.unit_no.trim(), floor: v.floor.trim() || null, sqm: v.sqm === '' ? null : v.sqm, status: v.status, notes: v.notes.trim() || null,
      }).eq('id', p.id).select('id');
      if (up.error) throw new Error(up.error.code === '23505' ? `בבניין הזה כבר יש דירה ${v.unit_no.trim()}` : up.error.message);
      if (!up.data?.length) throw new Error('אין הרשאה לערוך נכס במדינה הזו');
      notifications.show({ color: 'teal', message: 'הנכס עודכן' });
      await qc.invalidateQueries();
      onClose();
    } catch (e) { setError((e as Error).message); } finally { setBusy(false); }
  }

  return (
    <Modal opened onClose={onClose} title="עריכת נכס" size="lg">
      <Stack>
        <Select label={`בניין (${p.building.city.name_he})`} value={buildingId} searchable allowDeselect={false}
          data={[...(geo.data?.list ?? []).map((x) => ({ value: x.id, label: x.name })), { value: NEW, label: '+ בניין חדש' }]}
          onChange={(x) => {
            if (!x) return;
            setBuildingId(x);
            const nb = geo.data?.list.find((y) => y.id === x);
            setB(nb ? { name: nb.name, address: nb.address ?? '' } : { name: '', address: '' });
          }} />
        <SimpleGrid cols={{ base: 1, sm: 2 }}>
          <TextInput label={isNew ? 'שם הבניין החדש' : 'שם הבניין'} required value={b.name} onChange={(e) => setB({ ...b, name: e.currentTarget.value })} />
          <TextInput label="כתובת הבניין" value={b.address} onChange={(e) => setB({ ...b, address: e.currentTarget.value })} />
        </SimpleGrid>
        {buildingChanged && others > 0 && (
          <Alert color="yellow" p="xs">שינוי שם או כתובת של הבניין ישנה אותם גם אצל {others} דירות נוספות בבניין. אם רק הדירה הזו בבניין אחר: בוחרים בניין אחר או "בניין חדש".</Alert>
        )}
        <SimpleGrid cols={{ base: 2, sm: 4 }}>
          <TextInput label="מספר דירה" required value={v.unit_no} onChange={(e) => setV({ ...v, unit_no: e.currentTarget.value })} />
          <TextInput label="קומה" value={v.floor} onChange={(e) => setV({ ...v, floor: e.currentTarget.value })} />
          <NumberInput label='שטח (מ"ר)' min={0} value={v.sqm} onChange={(x) => setV({ ...v, sqm: x === '' ? '' : Number(x) })} />
          <Select label="סטטוס" allowDeselect={false} value={v.status} onChange={(x) => x && setV({ ...v, status: x as PropertyStatus })}
            data={Object.entries(STATUS_HE).map(([value, label]) => ({ value, label }))} />
        </SimpleGrid>
        <Textarea label="הערות" autosize minRows={2} maxRows={12} value={v.notes} onChange={(e) => setV({ ...v, notes: e.currentTarget.value })} />
        <Text size="xs" c="dimmed">כל שינוי נשמר ביומן הפעילות. הבעלים משתנים בכפתור "שינוי בעלות" בטבלת הבעלים.</Text>
        {error && <Alert color="red" title="הנכס לא עודכן">{error}</Alert>}
        <Group justify="flex-end">
          <Button variant="default" onClick={onClose}>ביטול</Button>
          <Button onClick={save} loading={busy} disabled={!v.unit_no.trim() || !b.name.trim()}>שמירה</Button>
        </Group>
      </Stack>
    </Modal>
  );
}

interface Current { id: string; party: { id: string; display_name: string }; share_pct: number; valid_from: string }
interface Owner { party_id: string | null; share: number }

// Owners change by date (time-bound, never deleted): from the date, the current owners
// end the day before and the new list starts. "Correction" fixes the shares of the
// current owners in place, for an import that guessed them (equal shares).
export function OwnershipChange({ propertyId, current, onClose }: { propertyId: string; current: Current[]; onClose: () => void }) {
  const qc = useQueryClient();
  const clients = useClients();
  const [mode, setMode] = useState<'change' | 'fix'>('change');
  const [owners, setOwners] = useState<Owner[]>(current.length ? current.map((o) => ({ party_id: o.party.id, share: Number(o.share_pct) })) : [{ party_id: null, share: 100 }]);
  const [fix, setFix] = useState<Record<string, number>>(Object.fromEntries(current.map((o) => [o.id, Number(o.share_pct)])));
  const [from, setFrom] = useState<string | null>(dayjs().format('YYYY-MM-DD'));
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const latest = current.reduce((m, o) => (o.valid_from > m ? o.valid_from : m), '0000-00-00');
  const sum = mode === 'change' ? owners.reduce((a, o) => a + (o.share || 0), 0) : Object.values(fix).reduce((a, x) => a + (x || 0), 0);
  const dateBad = mode === 'change' && (!from || from <= latest);
  const ready = Math.abs(sum - 100) < 0.01 && (mode === 'fix' ? current.length > 0 : !dateBad && owners.every((o) => o.party_id && o.share > 0));
  const setOwner = (i: number, patch: Partial<Owner>) => setOwners((os) => os.map((o, j) => (j === i ? { ...o, ...patch } : o)));
  const clientOptions = (clients.data ?? []).map((c) => ({ value: c.id, label: c.display_name })).sort((a, b) => a.label.localeCompare(b.label));

  async function save() {
    setBusy(true); setError(null);
    try {
      if (mode === 'fix') {
        for (const o of current) if (fix[o.id] !== Number(o.share_pct)) {
          must(await supabase.from('ownerships').update({ share_pct: fix[o.id], notes: 'Share corrected by hand.' }).eq('id', o.id));
        }
      } else {
        const end = dayjs(from).subtract(1, 'day').format('YYYY-MM-DD');
        if (current.length) must(await supabase.from('ownerships').update({ valid_to: end }).in('id', current.map((o) => o.id)));
        must(await supabase.from('ownerships').insert(owners.map((o) => ({ property_id: propertyId, party_id: o.party_id, share_pct: o.share, valid_from: from }))));
      }
      notifications.show({ color: 'teal', message: mode === 'fix' ? 'החלקים תוקנו' : 'הבעלות עודכנה' });
      await qc.invalidateQueries();
      onClose();
    } catch (e) { setError((e as Error).message); } finally { setBusy(false); }
  }

  return (
    <Modal opened onClose={onClose} title="שינוי בעלות" size="lg">
      <Stack>
        <SegmentedControl value={mode} onChange={(x) => setMode(x as 'change' | 'fix')} data={[
          { value: 'change', label: 'בעלות חדשה מתאריך' }, { value: 'fix', label: 'תיקון חלקים (טעות)' }]} />
        {mode === 'change' ? (
          <>
            <Text size="sm" c="dimmed">הבעלים הנוכחיים יסתיימו יום לפני התאריך, והרשימה למטה תתחיל ממנו. ההיסטוריה נשמרת.</Text>
            <DateInput label="מתאריך" value={from} onChange={(d) => setFrom(d ? dayjs(d).format('YYYY-MM-DD') : null)} valueFormat="DD.MM.YYYY" w={180}
              error={from && from <= latest ? 'התאריך צריך להיות אחרי תחילת הבעלות הנוכחית' : undefined} />
            {owners.map((o, i) => (
              <Group key={i} gap="xs" wrap="nowrap">
                <Select placeholder="בחירת לקוח" searchable data={clientOptions} value={o.party_id} onChange={(x) => setOwner(i, { party_id: x })} style={{ flex: 1 }} />
                <NumberInput w={110} min={0} max={100} suffix="%" value={o.share} onChange={(x) => setOwner(i, { share: Number(x) || 0 })} />
                {owners.length > 1 && <ActionIcon variant="subtle" color="red" aria-label="הסרה" onClick={() => setOwners((os) => os.filter((_, j) => j !== i))}><IconTrash size={16} /></ActionIcon>}
              </Group>
            ))}
            <Button size="xs" variant="light" w="fit-content" leftSection={<IconPlus size={14} />} onClick={() => setOwners((os) => [...os, { party_id: null, share: Math.max(0, 100 - sum) }])}>בעלים נוסף</Button>
          </>
        ) : (
          <>
            <Text size="sm" c="dimmed">לתיקון חלקים שנרשמו לא נכון (למשל ייבוא שחילק שווה בשווה). לא משנה תאריכים ולא יוצר היסטוריה.</Text>
            {current.map((o) => (
              <Group key={o.id} gap="xs" wrap="nowrap">
                <Text style={{ flex: 1 }}>{o.party.display_name}</Text>
                <NumberInput w={110} min={0} max={100} suffix="%" value={fix[o.id]} onChange={(x) => setFix({ ...fix, [o.id]: Number(x) || 0 })} />
              </Group>
            ))}
          </>
        )}
        {Math.abs(sum - 100) >= 0.01 && <Text size="xs" c="red">סך החלקים {sum}%, צריך 100%</Text>}
        {error && <Alert color="red" title="לא נשמר">{error}</Alert>}
        <Group justify="flex-end">
          <Button variant="default" onClick={onClose}>ביטול</Button>
          <Button onClick={save} loading={busy} disabled={!ready}>שמירה</Button>
        </Group>
      </Stack>
    </Modal>
  );
}
