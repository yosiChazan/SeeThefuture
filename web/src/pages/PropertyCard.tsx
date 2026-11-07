import { Anchor, Badge, Breadcrumbs, Button, Group, Paper, SimpleGrid, Stack, Table, Text, Title } from '@mantine/core';
import { IconPencil, IconTrash } from '@tabler/icons-react';
import { useState } from 'react';
import { Link, useNavigate, useParams } from 'react-router-dom';
import { DeleteRecord } from '../components/DeleteRecord';
import { OwnershipChange, PropertyEdit } from '../components/PropertyEdit';
import { PropertyFiles } from '../components/PropertyFiles';
import { PropertyDeals } from '../components/PropertyDeals';
import { Activities, PropertyContacts } from '../components/CardExtras';
import { PropertyCharges, PropertyServices } from '../components/PropertyServices';
import { useAccess } from '../lib/access';
import { CountryBadge, QueryState, StatusBadge } from '../components/common';
import { LeaseTable } from '../components/LeaseTable';
import { COUNTRY_HE, date, isCurrentOwnership, propertyTitle } from '../lib/format';
import { usePropertyEntries, useProperty } from '../lib/queries';
import { EditableLedger, PropertyEntries } from '../components/PropertyEntries';


function Field({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div>
      <Text size="xs" c="dimmed">{label}</Text>
      <Text size="sm">{children || '—'}</Text>
    </div>
  );
}

export function PropertyCard() {
  const { id } = useParams();
  const q = useProperty(id!);
  const ledger = usePropertyEntries(id!);
  const access = useAccess();
  const navigate = useNavigate();
  const [deleting, setDeleting] = useState(false);
  const [editing, setEditing] = useState(false);
  const [owning, setOwning] = useState(false);
  return (
    <QueryState q={q}>{(p) => {
      const leases = [...p.leases].sort((a, b) => (b.start_date ?? '9999').localeCompare(a.start_date ?? '9999'));
      const ownerships = [...p.ownerships].sort((a, b) => Number(isCurrentOwnership(b)) - Number(isCurrentOwnership(a)) || b.valid_from.localeCompare(a.valid_from));
      return (
        <Stack>
          <Breadcrumbs>
            <Anchor component={Link} to="/properties" size="sm">נכסים</Anchor>
            <Text size="sm">{propertyTitle(p)}</Text>
          </Breadcrumbs>
          <Group justify="space-between">
            <Title order={2}>{propertyTitle(p)}</Title>
            <Group gap="xs">
              <CountryBadge code={p.country_code} /><StatusBadge status={p.status} size="md" />
              {access.canEdit(p.country_code) && <Button size="xs" variant="light" leftSection={<IconPencil size={14} />} onClick={() => setEditing(true)}>עריכה</Button>}
              {access.isAdmin && <Button size="xs" variant="subtle" color="red" leftSection={<IconTrash size={14} />} onClick={() => setDeleting(true)}>מחיקת נכס</Button>}
            </Group>
          </Group>
          {editing && <PropertyEdit p={p} onClose={() => setEditing(false)} />}
          {owning && <OwnershipChange propertyId={p.id} current={ownerships.filter((o) => !o.valid_to)} onClose={() => setOwning(false)} />}
          {deleting && (
            <DeleteRecord kind="property" id={p.id} name={propertyTitle(p)} onClose={() => setDeleting(false)}
              onDeleted={() => navigate('/properties', { replace: true })} />
          )}

          <Paper withBorder p="md">
            <SimpleGrid cols={{ base: 2, sm: 4 }}>
              <Field label="מדינה">{COUNTRY_HE[p.country_code]}</Field>
              <Field label="עיר">{p.building.city.name_he}</Field>
              <Field label="פרויקט">{p.building.project?.name}</Field>
              <Field label="בניין">{p.building.name}</Field>
              <Field label="כתובת">{p.building.address}</Field>
              <Field label="קומה">{p.floor}</Field>
              <Field label="דירה">{p.unit_no}</Field>
              <Field label='שטח (מ"ר)'>{p.sqm}</Field>
            </SimpleGrid>
            {p.notes && <Text size="sm" mt="md" style={{ whiteSpace: 'pre-wrap' }}>{p.notes}</Text>}
          </Paper>

          <Paper withBorder p="md">
            <Group justify="space-between" mb="sm">
              <Title order={4}>בעלים</Title>
              {access.canEdit(p.country_code) && <Button size="xs" variant="light" onClick={() => setOwning(true)}>שינוי בעלות</Button>}
            </Group>
            <Table verticalSpacing="xs">
              <Table.Thead>
                <Table.Tr><Table.Th>שם</Table.Th><Table.Th>חלק</Table.Th><Table.Th>מתאריך</Table.Th><Table.Th>עד</Table.Th><Table.Th>הערות</Table.Th></Table.Tr>
              </Table.Thead>
              <Table.Tbody>
                {ownerships.map((o) => (
                  <Table.Tr key={o.id} c={isCurrentOwnership(o) ? undefined : 'dimmed'}>
                    <Table.Td><Anchor component={Link} to={`/clients/${o.party.id}`} size="sm">{o.party.display_name}</Anchor></Table.Td>
                    <Table.Td>{Number(o.share_pct)}%</Table.Td>
                    <Table.Td>{o.notes?.includes('Start date unknown') ? <Text size="sm" c="dimmed">לא ידוע</Text> : date(o.valid_from)}</Table.Td>
                    <Table.Td>{o.valid_to ? date(o.valid_to) : <Badge size="xs" variant="light" color="teal">נוכחי</Badge>}</Table.Td>
                    <Table.Td><Text size="xs" c="dimmed">{o.notes}</Text></Table.Td>
                  </Table.Tr>
                ))}
              </Table.Tbody>
            </Table>
          </Paper>

          <PropertyContacts propertyId={p.id} buildingId={p.building.id} countryCode={p.country_code} />
          <Activities entityType="property" entityId={p.id} />
          <PropertyDeals propertyId={p.id} country={p.country_code} canEdit={access.canEdit(p.country_code)} ownerId={ownerships.find((o) => !o.valid_to)?.party.id ?? null} />

          <Paper withBorder p="md">
            <Title order={4} mb="sm">חוזי שכירות</Title>
            <LeaseTable leases={leases} country={p.country_code} />
          </Paper>

          <PropertyServices propertyId={p.id} />
          <PropertyCharges propertyId={p.id} />

          <PropertyFiles propertyId={p.id} country={p.country_code} />

          <PropertyEntries propertyId={p.id} country={p.country_code} accounts={ledger.data?.accounts ?? []}>
            <QueryState q={ledger}>{(m) => <EditableLedger accounts={m.accounts} entries={m.entries} property />}</QueryState>
          </PropertyEntries>
        </Stack>
      );
    }}</QueryState>
  );
}
