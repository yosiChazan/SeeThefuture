import { ActionIcon, Anchor, Badge, Button, Group, Modal, NumberInput, Paper, SegmentedControl, Select, Stack, Table, Text, TextInput, Textarea, Title, Tooltip } from '@mantine/core';
import { modals } from '@mantine/modals';
import { notifications } from '@mantine/notifications';
import { IconPlus, IconTrash } from '@tabler/icons-react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import dayjs from 'dayjs';
import { useState } from 'react';
import { Link } from 'react-router-dom';
import { useAccess } from '../lib/access';
import { COUNTRY_HE, propertyTitle } from '../lib/format';
import { useClients, useProperties } from '../lib/queries';
import { must, supabase } from '../lib/supabase';
import type { Country } from '../lib/types';

const useCanEdit = () => { const a = useAccess(); return a.isAdmin || a.countries.some((c) => a.canEdit(c)); };
const confirmDelete = (title: string, onConfirm: () => void) => modals.openConfirmModal({
  title, children: <Text size="sm">למחוק? אי אפשר לבטל.</Text>, labels: { confirm: 'מחיקה', cancel: 'ביטול' }, confirmProps: { color: 'red' }, onConfirm,
});

// ---- Activities: a title, the text and when it was written (SPEC decision 80) ----------

interface Activity { id: string; title: string; body: string | null; created_at: string }

export function Activities({ entityType, entityId }: { entityType: 'party' | 'property' | 'lease'; entityId: string }) {
  const qc = useQueryClient();
  const canEdit = useCanEdit();
  const key = ['activities', entityType, entityId];
  const q = useQuery({
    queryKey: key,
    queryFn: async () => must(await supabase.from('activities').select('id, title, body, created_at').eq('entity_type', entityType).eq('entity_id', entityId)
      .order('created_at', { ascending: false })) as Activity[],
  });
  const [adding, setAdding] = useState(false);
  const [title, setTitle] = useState('');
  const [body, setBody] = useState('');
  const [busy, setBusy] = useState(false);

  async function add() {
    setBusy(true);
    const { error } = await supabase.from('activities').insert({ entity_type: entityType, entity_id: entityId, title: title.trim(), body: body.trim() || null });
    setBusy(false);
    if (error) { notifications.show({ color: 'red', message: error.message }); return; }
    setTitle(''); setBody(''); setAdding(false);
    await qc.invalidateQueries({ queryKey: key });
  }
  async function remove(a: Activity) {
    const { error } = await supabase.from('activities').delete().eq('id', a.id);
    if (error) notifications.show({ color: 'red', message: error.message });
    await qc.invalidateQueries({ queryKey: key });
  }

  return (
    <Paper withBorder p="md">
      <Group justify="space-between" mb="sm">
        <Title order={4}>פעולות</Title>
        {canEdit && !adding && <Button size="xs" variant="light" leftSection={<IconPlus size={14} />} onClick={() => setAdding(true)}>הוספה</Button>}
      </Group>
      {adding && (
        <Stack gap="xs" mb="sm">
          <TextInput label="כותרת" required value={title} onChange={(e) => setTitle(e.currentTarget.value)} data-autofocus />
          <Textarea label="תוכן" autosize minRows={2} value={body} onChange={(e) => setBody(e.currentTarget.value)} />
          <Group justify="flex-end">
            <Button size="xs" variant="default" onClick={() => setAdding(false)}>ביטול</Button>
            <Button size="xs" onClick={add} loading={busy} disabled={!title.trim()}>שמירה</Button>
          </Group>
        </Stack>
      )}
      {q.data?.length ? (
        <Stack gap="xs">
          {q.data.map((a) => (
            <Group key={a.id} justify="space-between" align="flex-start" wrap="nowrap" pb={6} style={{ borderBottom: '1px solid var(--mantine-color-default-border)' }}>
              <div style={{ minWidth: 0 }}>
                <Group gap="xs"><Text fw={600} size="sm">{a.title}</Text><Text size="xs" c="dimmed">{dayjs(a.created_at).format('DD.MM.YYYY HH:mm')}</Text></Group>
                {a.body && <Text size="sm" style={{ whiteSpace: 'pre-wrap' }}>{a.body}</Text>}
              </div>
              {canEdit && <Tooltip label="מחיקה"><ActionIcon variant="subtle" color="red" aria-label="מחיקה" onClick={() => confirmDelete(`מחיקת "${a.title}"`, () => remove(a))}><IconTrash size={16} /></ActionIcon></Tooltip>}
            </Group>
          ))}
        </Stack>
      ) : !adding && <Text c="dimmed" size="sm">אין פעולות</Text>}
    </Paper>
  );
}

// ---- What a contact is responsible for (SPEC decision 79) -------------------------------

type Scope = 'property' | 'building' | 'city' | 'country';
const SCOPE_HE: Record<Scope, string> = { property: 'נכס', building: 'בניין', city: 'עיר', country: 'מדינה' };
interface Assignment {
  id: string; role: string | null; country_code: Country | null;
  property: { id: string; unit_no: string; building: { name: string; project: { name: string } | null } } | null;
  building: { id: string; name: string; city: { name_he: string } } | null;
  city: { id: string; name_he: string; country_code: Country } | null;
  party?: { id: string; display_name: string; phone: string | null };
}
const ASSIGNMENT_COLS = `id, role, country_code, property:properties(id, unit_no, building:buildings(name, project:projects(name))),
  building:buildings(id, name, city:cities(name_he)), city:cities(id, name_he, country_code)`;
const scopeOf = (a: Assignment): Scope => (a.property ? 'property' : a.building ? 'building' : a.city ? 'city' : 'country');
const placeOf = (a: Assignment) => a.property ? <Anchor component={Link} to={`/properties/${a.property.id}`} size="sm">{propertyTitle(a.property)}</Anchor>
  : a.building ? `${a.building.name}, ${a.building.city.name_he}` : a.city ? `${a.city.name_he}, ${COUNTRY_HE[a.city.country_code]}` : COUNTRY_HE[a.country_code!];

function useGeo() {
  return useQuery({
    queryKey: ['geo'],
    queryFn: async () => ({
      cities: must(await supabase.from('cities').select('id, country_code, name_he').order('name_he')) as { id: string; country_code: Country; name_he: string }[],
      buildings: must(await supabase.from('buildings').select('id, city_id, name, address, project:projects(name)').order('name')) as unknown as
        { id: string; city_id: string; name: string; address: string | null; project: { name: string } | null }[],
    }),
  });
}

export function ContactAssignments({ partyId }: { partyId: string }) {
  const qc = useQueryClient();
  const canEdit = useCanEdit();
  const key = ['assignments', partyId];
  const q = useQuery({ queryKey: key, queryFn: async () => must(await supabase.from('contact_assignments').select(ASSIGNMENT_COLS).eq('party_id', partyId)) as unknown as Assignment[] });
  const [adding, setAdding] = useState(false);
  async function remove(a: Assignment) {
    const { error } = await supabase.from('contact_assignments').delete().eq('id', a.id);
    if (error) notifications.show({ color: 'red', message: error.message });
    await qc.invalidateQueries();
  }
  return (
    <Paper withBorder p="md">
      <Group justify="space-between" mb="sm">
        <Title order={4}>אחראי על</Title>
        {canEdit && <Button size="xs" variant="light" leftSection={<IconPlus size={14} />} onClick={() => setAdding(true)}>שיוך</Button>}
      </Group>
      <Text size="xs" c="dimmed" mb="xs">נכסים, בניינים, ערים או מדינות שאיש הקשר מטפל בהם. הבעלים של הנכסים לא משתנים.</Text>
      {q.data?.length ? (
        <Table verticalSpacing={4}>
          <Table.Tbody>
            {q.data.map((a) => (
              <Table.Tr key={a.id}>
                <Table.Td w={80}><Badge size="sm" variant="light" color="gray">{SCOPE_HE[scopeOf(a)]}</Badge></Table.Td>
                <Table.Td>{placeOf(a)}</Table.Td>
                <Table.Td><Text size="sm" c="dimmed">{a.role ?? ''}</Text></Table.Td>
                <Table.Td w={40}>{canEdit && <ActionIcon variant="subtle" color="red" aria-label="הסרה" onClick={() => remove(a)}><IconTrash size={16} /></ActionIcon>}</Table.Td>
              </Table.Tr>
            ))}
          </Table.Tbody>
        </Table>
      ) : <Text c="dimmed" size="sm">לא משויך לשום דבר</Text>}
      {adding && <AddAssignment partyId={partyId} onClose={() => setAdding(false)} />}
    </Paper>
  );
}

function AddAssignment({ partyId, onClose }: { partyId: string; onClose: () => void }) {
  const qc = useQueryClient();
  const access = useAccess();
  const geo = useGeo();
  const properties = useProperties();
  const [scope, setScope] = useState<Scope>('property');
  const [target, setTarget] = useState<string | null>(null);
  const [role, setRole] = useState('');
  const [busy, setBusy] = useState(false);
  const countries = (['UA', 'RO', 'GE', 'GR'] as Country[]).filter((c) => access.canRead(c));
  const cityName = new Map((geo.data?.cities ?? []).map((c) => [c.id, c.name_he]));
  const data = scope === 'property' ? (properties.data ?? []).map((p) => ({ value: p.id, label: `${propertyTitle(p)} · ${p.building.city.name_he}` }))
    : scope === 'building' ? (geo.data?.buildings ?? []).map((b) => ({ value: b.id, label: `${b.project ? `${b.name} (${b.project.name})` : b.name} · ${cityName.get(b.city_id) ?? ''}` }))
    : scope === 'city' ? (geo.data?.cities ?? []).map((c) => ({ value: c.id, label: `${c.name_he} · ${COUNTRY_HE[c.country_code]}` }))
    : countries.map((c) => ({ value: c, label: COUNTRY_HE[c] }));
  async function save() {
    if (!target) return;
    setBusy(true);
    const col = { property: 'property_id', building: 'building_id', city: 'city_id', country: 'country_code' }[scope];
    const { error } = await supabase.from('contact_assignments').insert({ party_id: partyId, [col]: target, role: role.trim() || null });
    setBusy(false);
    if (error) { notifications.show({ color: 'red', message: error.message }); return; }
    await qc.invalidateQueries(); onClose();
  }
  return (
    <Modal opened onClose={onClose} title="שיוך איש קשר">
      <Stack>
        <SegmentedControl value={scope} onChange={(v) => { setScope(v as Scope); setTarget(null); }}
          data={(Object.keys(SCOPE_HE) as Scope[]).map((s) => ({ value: s, label: SCOPE_HE[s] }))} />
        <Select label={SCOPE_HE[scope]} searchable data={data.sort((a, b) => a.label.localeCompare(b.label, 'he', { numeric: true }))} value={target} onChange={setTarget} nothingFoundMessage="לא נמצא" />
        <TextInput label="תפקיד (לא חובה)" placeholder='למשל: עו"ד, ועד בית, מנהל' value={role} onChange={(e) => setRole(e.currentTarget.value)} />
        <Group justify="flex-end"><Button variant="default" onClick={onClose}>ביטול</Button><Button onClick={save} loading={busy} disabled={!target}>שמירה</Button></Group>
      </Stack>
    </Modal>
  );
}

// On the property card: the contacts responsible for it, its building, city or country.
export function PropertyContacts({ propertyId, buildingId, countryCode }: { propertyId: string; buildingId: string; countryCode: Country }) {
  const q = useQuery({
    queryKey: ['property-contacts', propertyId],
    queryFn: async () => {
      const b = must(await supabase.from('buildings').select('city_id').eq('id', buildingId).single()) as { city_id: string };
      return must(await supabase.from('contact_assignments').select(`${ASSIGNMENT_COLS}, party:parties(id, display_name, phone)`)
        .or(`property_id.eq.${propertyId},building_id.eq.${buildingId},city_id.eq.${b.city_id},country_code.eq.${countryCode}`)) as unknown as Assignment[];
    },
  });
  if (!q.data?.length) return null;
  const order: Scope[] = ['property', 'building', 'city', 'country'];
  return (
    <Paper withBorder p="md">
      <Title order={4} mb="sm">אנשי קשר אחראים</Title>
      <Table verticalSpacing={4}>
        <Table.Tbody>
          {[...q.data].sort((a, b) => order.indexOf(scopeOf(a)) - order.indexOf(scopeOf(b))).map((a) => (
            <Table.Tr key={a.id}>
              <Table.Td><Anchor component={Link} to={`/contacts/${a.party!.id}`} size="sm" fw={500}>{a.party!.display_name}</Anchor></Table.Td>
              <Table.Td><Text size="sm">{a.role ?? ''}</Text></Table.Td>
              <Table.Td dir="ltr" style={{ textAlign: 'right' }}><Text size="sm">{a.party!.phone ?? ''}</Text></Table.Td>
              <Table.Td><Text size="xs" c="dimmed">דרך {SCOPE_HE[scopeOf(a)]}{scopeOf(a) !== 'property' ? ': ' : ''}{scopeOf(a) !== 'property' && placeOf(a)}</Text></Table.Td>
            </Table.Tr>
          ))}
        </Table.Tbody>
      </Table>
    </Paper>
  );
}

// ---- Partners of a company that is a client (SPEC decision 81) --------------------------

interface CompanyPartner { company_party_id: string; partner_party_id: string; share_pct: number | null;
  company: { id: string; display_name: string }; partner: { id: string; display_name: string } }
const CP_COLS = `company_party_id, partner_party_id, share_pct,
  company:parties!company_partners_company_party_id_fkey(id, display_name), partner:parties!company_partners_partner_party_id_fkey(id, display_name)`;

export function CompanyPartners({ companyId }: { companyId: string }) {
  const qc = useQueryClient();
  const canEdit = useCanEdit();
  const clients = useClients();
  const q = useQuery({ queryKey: ['company-partners', companyId], queryFn: async () => must(await supabase.from('company_partners').select(CP_COLS).eq('company_party_id', companyId)) as unknown as CompanyPartner[] });
  const [adding, setAdding] = useState(false);
  const [partner, setPartner] = useState<string | null>(null);
  const [share, setShare] = useState<number | ''>('');
  async function add() {
    const { error } = await supabase.from('company_partners').insert({ company_party_id: companyId, partner_party_id: partner, share_pct: share === '' ? null : share });
    if (error) { notifications.show({ color: 'red', message: error.message }); return; }
    setAdding(false); setPartner(null); setShare(''); await qc.invalidateQueries();
  }
  async function remove(p: CompanyPartner) {
    const { error } = await supabase.from('company_partners').delete().eq('company_party_id', companyId).eq('partner_party_id', p.partner_party_id);
    if (error) notifications.show({ color: 'red', message: error.message }); else await qc.invalidateQueries();
  }
  const taken = new Set([companyId, ...(q.data ?? []).map((p) => p.partner_party_id)]);
  return (
    <Paper withBorder p="md">
      <Group justify="space-between" mb="sm">
        <Title order={4}>שותפים בחברה</Title>
        {canEdit && <Button size="xs" variant="light" leftSection={<IconPlus size={14} />} onClick={() => setAdding(true)}>הוספת שותף</Button>}
      </Group>
      <Text size="xs" c="dimmed" mb="xs">השותפים מקושרים לחברה, אבל הנכסים והחשבונות שלהם נשארים בכרטיס שלהם. כל מה ששייך לחברה (נכסים, חוזים, תנועות) מופיע כאן.</Text>
      {q.data?.length ? (
        <Table verticalSpacing={4}>
          <Table.Tbody>
            {q.data.map((p) => (
              <Table.Tr key={p.partner_party_id}>
                <Table.Td><Anchor component={Link} to={`/clients/${p.partner.id}`} size="sm" fw={500}>{p.partner.display_name}</Anchor></Table.Td>
                <Table.Td>{p.share_pct ? `${Number(p.share_pct)}%` : ''}</Table.Td>
                <Table.Td w={40}>{canEdit && <ActionIcon variant="subtle" color="red" aria-label="הסרה" onClick={() => remove(p)}><IconTrash size={16} /></ActionIcon>}</Table.Td>
              </Table.Tr>
            ))}
          </Table.Tbody>
        </Table>
      ) : <Text c="dimmed" size="sm">אין שותפים</Text>}
      {adding && (
        <Modal opened onClose={() => setAdding(false)} title="הוספת שותף לחברה">
          <Stack>
            <Select label="לקוח" searchable value={partner} onChange={setPartner} nothingFoundMessage="לא נמצא"
              data={(clients.data ?? []).filter((c) => !taken.has(c.id)).map((c) => ({ value: c.id, label: c.display_name })).sort((a, b) => a.label.localeCompare(b.label, 'he'))} />
            <NumberInput label="חלק בחברה (לא חובה)" suffix="%" min={0} max={100} value={share} onChange={(v) => setShare(v === '' ? '' : Number(v))} />
            <Group justify="flex-end"><Button variant="default" onClick={() => setAdding(false)}>ביטול</Button><Button onClick={add} disabled={!partner}>שמירה</Button></Group>
          </Stack>
        </Modal>
      )}
    </Paper>
  );
}

// On a partner's own card: the companies they are a partner in.
export function PartnerIn({ partyId }: { partyId: string }) {
  const q = useQuery({ queryKey: ['partner-in', partyId], queryFn: async () => must(await supabase.from('company_partners').select(CP_COLS).eq('partner_party_id', partyId)) as unknown as CompanyPartner[] });
  if (!q.data?.length) return null;
  return (
    <Group gap="xs">
      <Text size="sm" c="dimmed">שותף/ה ב:</Text>
      {q.data.map((p) => <Badge key={p.company_party_id} variant="light" component={Link} to={`/clients/${p.company.id}`} style={{ cursor: 'pointer' }}>
        {p.company.display_name}{p.share_pct ? ` · ${Number(p.share_pct)}%` : ''}</Badge>)}
    </Group>
  );
}
