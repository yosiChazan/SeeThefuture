import { ActionIcon, Alert, Button, Checkbox, Group, Modal, NumberInput, Select, SimpleGrid, Stack, Text, TextInput, Textarea } from '@mantine/core';
import { DateInput } from '@mantine/dates';
import { notifications } from '@mantine/notifications';
import { IconPlus, IconTrash } from '@tabler/icons-react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import dayjs from 'dayjs';
import { useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { useAccess } from '../lib/access';
import { summary, useConfirmSave } from './ConfirmSave';
import { COUNTRY_HE, STATUS_HE } from '../lib/format';
import { useClients } from '../lib/queries';
import { must, supabase } from '../lib/supabase';
import type { Country, PropertyStatus } from '../lib/types';

const NEW = '__new__';
// No purchase date: ownership counts from before any report (SPEC decision 60).
const UNKNOWN_START = '2000-01-01';

interface Owner { party_id: string | null; share: number }

// Adds a property: in an existing building or a new one in an existing city, with its
// owners and their shares (SPEC decision 65). `ownerId` starts the form with that client.
export function PropertyForm({ ownerId, onClose }: { ownerId?: string; onClose: () => void }) {
  const access = useAccess();
  const qc = useQueryClient();
  const navigate = useNavigate();
  const clients = useClients();
  const countries = (['UA', 'RO', 'GE', 'GR'] as Country[]).filter((c) => access.canEdit(c));
  const [country, setCountry] = useState<Country | null>(countries.length === 1 ? countries[0] : null);
  const [cityId, setCityId] = useState<string | null>(null);
  const [buildingId, setBuildingId] = useState<string | null>(null);
  const [building, setBuilding] = useState({ name: '', address: '' });
  const [v, setV] = useState({ unit_no: '', floor: '', sqm: '' as number | '', status: 'vacant' as PropertyStatus, notes: '' });
  const [owners, setOwners] = useState<Owner[]>([{ party_id: ownerId ?? null, share: 100 }]);
  const [since, setSince] = useState<string | null>(null);
  const [unknownSince, setUnknownSince] = useState(true);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const geo = useQuery({
    queryKey: ['geo'],
    queryFn: async () => ({
      cities: must(await supabase.from('cities').select('id, country_code, name_he').order('name_he')) as { id: string; country_code: Country; name_he: string }[],
      buildings: must(await supabase.from('buildings').select('id, city_id, name, address, project:projects(name)').order('name')) as unknown as
        { id: string; city_id: string; name: string; address: string | null; project: { name: string } | null }[],
    }),
  });
  const cities = (geo.data?.cities ?? []).filter((c) => c.country_code === country);
  const buildings = (geo.data?.buildings ?? []).filter((b) => b.city_id === cityId);
  const shareSum = owners.reduce((a, o) => a + (o.share || 0), 0);
  const isNew = buildingId === NEW;
  const ready = country && cityId && buildingId && (!isNew || building.name.trim()) && v.unit_no.trim()
    && owners.every((o) => o.party_id && o.share > 0) && Math.abs(shareSum - 100) < 0.01 && (unknownSince || since);
  const setOwner = (i: number, patch: Partial<Owner>) => setOwners((os) => os.map((o, j) => (j === i ? { ...o, ...patch } : o)));

  const confirmSave = useConfirmSave();
  // Shows the new property before it is added (SPEC decision 67).
  function review() {
    const b = isNew ? `${building.name.trim()} (בניין חדש)` : buildings.find((x) => x.id === buildingId)?.name;
    const name = (pid: string | null) => clients.data?.find((c) => c.id === pid)?.display_name ?? '';
    confirmSave.ask({
      title: 'אישור נכס חדש',
      rows: summary([
        { label: 'מדינה', value: country && COUNTRY_HE[country] },
        { label: 'עיר', value: cities.find((c) => c.id === cityId)?.name_he },
        { label: 'בניין', value: b },
        { label: 'כתובת', value: isNew ? building.address.trim() : buildings.find((x) => x.id === buildingId)?.address },
        { label: 'דירה', value: v.unit_no.trim() },
        { label: 'קומה', value: v.floor.trim() },
        { label: 'שטח (מ"ר)', value: v.sqm },
        { label: 'סטטוס', value: STATUS_HE[v.status] },
        { label: 'בעלים', value: owners.map((o) => `${name(o.party_id)} ${o.share}%`).join('\n') },
        { label: 'בעלים מתאריך', value: unknownSince ? 'לא ידוע' : since?.split('-').reverse().join('.') },
        { label: 'הערות', value: v.notes.trim() },
      ]),
      action: save,
    });
  }

  async function save(): Promise<boolean> {
    setBusy(true); setError(null);
    try {
      let bId = buildingId!;
      if (isNew) {
        bId = crypto.randomUUID();
        must(await supabase.from('buildings').insert({ id: bId, city_id: cityId, name: building.name.trim(), address: building.address.trim() || null }));
        // If the apartment fails below, a second try uses this building instead of adding another.
        await geo.refetch();
        setBuildingId(bId);
      }
      const id = crypto.randomUUID();
      const add = await supabase.from('properties').insert({
        id, building_id: bId, unit_no: v.unit_no.trim(), floor: v.floor.trim() || null, sqm: v.sqm === '' ? null : v.sqm,
        status: v.status, notes: v.notes.trim() || null,
      });
      if (add.error) throw new Error(add.error.code === '23505' ? `בבניין הזה כבר יש דירה ${v.unit_no.trim()}` : add.error.message);
      must(await supabase.from('ownerships').insert(owners.map((o) => ({
        property_id: id, party_id: o.party_id, share_pct: o.share,
        valid_from: unknownSince ? UNKNOWN_START : since, notes: unknownSince ? 'Start date unknown' : null,
      }))));
      notifications.show({ color: 'teal', message: 'הנכס נוסף' });
      await qc.invalidateQueries();
      onClose();
      navigate(`/properties/${id}`);
      return true;
    } catch (e) { setError((e as Error).message); setBusy(false); return false; }
  }

  const clientOptions = (clients.data ?? []).map((c) => ({ value: c.id, label: c.display_name })).sort((a, b) => a.label.localeCompare(b.label));
  return (
    <Modal opened onClose={onClose} title="נכס חדש" size="lg">
      <Stack>
        <SimpleGrid cols={{ base: 1, sm: 3 }}>
          <Select label="מדינה" required value={country} allowDeselect={false}
            data={countries.map((c) => ({ value: c, label: COUNTRY_HE[c] }))}
            onChange={(x) => { setCountry(x as Country); setCityId(null); setBuildingId(null); }} />
          <Select label="עיר" required value={cityId} disabled={!country} searchable
            data={cities.map((c) => ({ value: c.id, label: c.name_he }))}
            onChange={(x) => { setCityId(x); setBuildingId(null); }} />
          <Select label="בניין" required value={buildingId} disabled={!cityId} searchable
            data={[...buildings.map((b) => ({ value: b.id, label: b.project ? `${b.name} (${b.project.name})` : b.name })), { value: NEW, label: '+ בניין חדש' }]}
            onChange={setBuildingId} />
        </SimpleGrid>
        {isNew && (
          <SimpleGrid cols={{ base: 1, sm: 2 }}>
            <TextInput label="שם הבניין" required value={building.name} onChange={(e) => setBuilding({ ...building, name: e.currentTarget.value })} />
            <TextInput label="כתובת" value={building.address} onChange={(e) => setBuilding({ ...building, address: e.currentTarget.value })} />
          </SimpleGrid>
        )}
        <SimpleGrid cols={{ base: 2, sm: 4 }}>
          <TextInput label="מספר דירה" required value={v.unit_no} onChange={(e) => setV({ ...v, unit_no: e.currentTarget.value })} />
          <TextInput label="קומה" value={v.floor} onChange={(e) => setV({ ...v, floor: e.currentTarget.value })} />
          <NumberInput label='שטח (מ"ר)' min={0} value={v.sqm} onChange={(x) => setV({ ...v, sqm: x === '' ? '' : Number(x) })} />
          <Select label="סטטוס" allowDeselect={false} value={v.status} onChange={(x) => x && setV({ ...v, status: x as PropertyStatus })}
            data={Object.entries(STATUS_HE).map(([value, label]) => ({ value, label }))} />
        </SimpleGrid>

        <Stack gap={6}>
          <Text size="sm" fw={500}>בעלים</Text>
          {owners.map((o, i) => (
            <Group key={i} gap="xs" wrap="nowrap">
              <Select placeholder="בחירת לקוח" searchable data={clientOptions} value={o.party_id} onChange={(x) => setOwner(i, { party_id: x })} style={{ flex: 1 }} />
              <NumberInput w={110} min={0} max={100} suffix="%" value={o.share} onChange={(x) => setOwner(i, { share: Number(x) || 0 })} />
              {owners.length > 1 && <ActionIcon variant="subtle" color="red" aria-label="הסרה" onClick={() => setOwners((os) => os.filter((_, j) => j !== i))}><IconTrash size={16} /></ActionIcon>}
            </Group>
          ))}
          <Group justify="space-between">
            <Button size="xs" variant="light" leftSection={<IconPlus size={14} />} onClick={() => setOwners((os) => [...os, { party_id: null, share: Math.max(0, 100 - shareSum) }])}>בעלים נוסף</Button>
            {Math.abs(shareSum - 100) >= 0.01 && <Text size="xs" c="red">סך החלקים {shareSum}%, צריך 100%</Text>}
          </Group>
          <Text size="xs" c="dimmed">לקוח שעוד לא קיים מוסיפים קודם במסך הלקוחות.</Text>
          <Group align="flex-end">
            <Checkbox label="תאריך הרכישה לא ידוע" checked={unknownSince} onChange={(e) => setUnknownSince(e.currentTarget.checked)} />
            {!unknownSince && <DateInput label="בעלים מתאריך" value={since} onChange={(d) => setSince(d ? dayjs(d).format('YYYY-MM-DD') : null)} valueFormat="DD.MM.YYYY" w={160} />}
          </Group>
        </Stack>

        <Textarea label="הערות" autosize minRows={2} value={v.notes} onChange={(e) => setV({ ...v, notes: e.currentTarget.value })} />
        {error && <Alert color="red" title="הנכס לא נוסף">{error}</Alert>}
        <Group justify="flex-end">
          <Button variant="default" onClick={onClose}>ביטול</Button>
          {confirmSave.element}
          <Button onClick={review} loading={busy} disabled={!ready}>הוספת נכס</Button>
        </Group>
      </Stack>
    </Modal>
  );
}
