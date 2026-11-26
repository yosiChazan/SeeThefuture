import { ActionIcon, Alert, Button, Group, Modal, Select, Stack, Text, TextInput, Tooltip } from '@mantine/core';
import { notifications } from '@mantine/notifications';
import { IconPencil } from '@tabler/icons-react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import dayjs from 'dayjs';
import { useState } from 'react';
import { currentManager } from '../lib/format';
import { must, supabase } from '../lib/supabase';
import type { Property } from '../lib/types';

// A property's project and manager (SPEC decision 211). The project belongs to the building, so
// changing it moves every apartment of the building; a new project can be added in the city.
// The manager is the open management agreement: a change closes it today and opens one with the
// new manager (the fee is kept on the agreement, set where the reports need it).

export function PropertyCategories({ p, canEdit }: { p: Property; canEdit: boolean }) {
  const qc = useQueryClient();
  const [open, setOpen] = useState(false);
  const manager = currentManager(p);
  return (
    <>
      <Group gap={4} wrap="nowrap">
        <Text size="sm">{p.building.project?.name ?? '—'} · מנהל: {manager?.display_name ?? '—'}</Text>
        {canEdit && <Tooltip label="שינוי פרויקט ומנהל נכס"><ActionIcon size="xs" variant="subtle" onClick={() => setOpen(true)} aria-label="שינוי"><IconPencil size={12} /></ActionIcon></Tooltip>}
      </Group>
      {open && <Edit p={p} onClose={() => setOpen(false)} onSaved={() => qc.invalidateQueries()} />}
    </>
  );
}

function Edit({ p, onClose, onSaved }: { p: Property; onClose: () => void; onSaved: () => void }) {
  const building = useQuery({
    queryKey: ['building-of', p.building.id],
    queryFn: async () => {
      const b = must(await supabase.from('buildings').select('city_id, project_id').eq('id', p.building.id).single()) as { city_id: string; project_id: string | null };
      const [projects, siblings] = await Promise.all([
        supabase.from('projects').select('id, name').eq('city_id', b.city_id).order('name'),
        supabase.from('properties').select('id', { count: 'exact', head: true }).eq('building_id', p.building.id),
      ]);
      return { ...b, projects: must(projects) as { id: string; name: string }[], units: siblings.count ?? 1 };
    },
  });
  const managers = useQuery({
    queryKey: ['managers'],
    queryFn: async () => must(await supabase.from('parties').select('id, display_name, party_roles!inner(role)').eq('party_roles.role', 'manager').order('display_name')) as { id: string; display_name: string }[],
  });
  const current = currentManager(p);
  const [project, setProject] = useState<string | null>(null);
  const [newProject, setNewProject] = useState('');
  const [manager, setManager] = useState<string | null>(current?.id ?? null);
  const [busy, setBusy] = useState(false);
  const projectId = project ?? building.data?.project_id ?? null;

  async function save() {
    setBusy(true);
    try {
      const b = building.data!;
      let target = projectId;
      if (project === 'new') {
        const ins = must(await supabase.from('projects').insert({ city_id: b.city_id, name: newProject.trim() }).select('id').single()) as { id: string };
        target = ins.id;
      }
      if (target !== b.project_id) must(await supabase.from('buildings').update({ project_id: target === 'none' ? null : target }).eq('id', p.building.id));
      if ((manager ?? null) !== (current?.id ?? null)) {
        const today = dayjs().format('YYYY-MM-DD');
        const open = (p.management_agreements ?? []).filter((m) => !m.valid_to);
        for (const m of open) must(await supabase.from('management_agreements').update({ valid_to: today }).eq('id', m.id));
        if (manager) must(await supabase.from('management_agreements').insert({ property_id: p.id, manager_party_id: manager, fee_model: 'none', valid_from: today, notes: 'נקבע בכרטיס הנכס' }));
      }
      notifications.show({ color: 'teal', message: 'נשמר' });
      onSaved(); onClose();
    } catch (e) { notifications.show({ color: 'red', message: (e as Error).message }); } finally { setBusy(false); }
  }

  const b = building.data;
  return (
    <Modal opened onClose={onClose} title="פרויקט ומנהל נכס">
      <Stack>
        <Select label="פרויקט" value={projectId ?? 'none'} onChange={(x) => setProject(x)} allowDeselect={false} searchable
          data={[...(b?.projects ?? []).map((x) => ({ value: x.id, label: x.name })), { value: 'none', label: 'בלי פרויקט' }, { value: 'new', label: '+ פרויקט חדש בעיר' }]} />
        {project === 'new' && <TextInput label="שם הפרויקט החדש" value={newProject} onChange={(e) => setNewProject(e.currentTarget.value)} />}
        {b && b.units > 1 && projectId !== b.project_id && <Alert color="orange">הפרויקט שייך לבניין: השינוי יחול על כל {b.units} הדירות בבניין {p.building.name}.</Alert>}
        <Select label="מנהל נכס" value={manager} onChange={setManager} clearable searchable placeholder="בלי מנהל"
          data={(managers.data ?? []).map((m) => ({ value: m.id, label: m.display_name }))} description="רשימת מנהלי הנכסים: אנשי קשר בתפקיד מנהל נכסים" />
        <Group justify="flex-end">
          <Button variant="default" onClick={onClose}>ביטול</Button>
          <Button onClick={save} loading={busy} disabled={!b || (project === 'new' && !newProject.trim())}>שמירה</Button>
        </Group>
      </Stack>
    </Modal>
  );
}
