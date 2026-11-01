import { Anchor, Badge, Breadcrumbs, Button, Group, Paper, SimpleGrid, Stack, Table, Text, Title } from '@mantine/core';
import { IconTrash } from '@tabler/icons-react';
import { useState } from 'react';
import { Link, useNavigate, useParams } from 'react-router-dom';
import { DeleteRecord } from '../components/DeleteRecord';
import { EntityDocuments, type DocType } from '../components/EntityDocuments';
import { PropertyDeals } from '../components/PropertyDeals';
import { PropertyCharges, PropertyServices } from '../components/PropertyServices';
import { useAccess } from '../lib/access';
import { CountryBadge, QueryState, StatusBadge } from '../components/common';
import { LeaseTable } from '../components/LeaseTable';
import { COUNTRY_HE, date, isCurrentOwnership, propertyTitle } from '../lib/format';
import { usePropertyEntries, useProperty } from '../lib/queries';
import { AccountLedger } from '../components/AccountLedger';

// Kinds of property documents (SPEC decision 70).
const PROPERTY_DOC_TYPES: DocType[] = [
  { value: 'purchase_contract', label: 'חוזה רכישה' }, { value: 'land_registry', label: 'נסח טאבו' }, { value: 'land_book', label: 'Land book' },
  { value: 'poa', label: 'ייפוי כוח' }, { value: 'management_contract', label: 'חוזה ניהול' }, { value: 'caveat', label: 'הערת אזהרה' },
  { value: 'payment_proof', label: 'הוכחת תשלום / קבלה' }, { value: 'bank_document', label: 'מסמך בנק' }, { value: 'attachment', label: 'מסמך אחר' },
];

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
              {access.isAdmin && <Button size="xs" variant="subtle" color="red" leftSection={<IconTrash size={14} />} onClick={() => setDeleting(true)}>מחיקת נכס</Button>}
            </Group>
          </Group>
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
            <Title order={4} mb="sm">בעלים</Title>
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

          <PropertyDeals propertyId={p.id} />

          <Paper withBorder p="md">
            <Title order={4} mb="sm">חוזי שכירות</Title>
            <LeaseTable leases={leases} country={p.country_code} />
          </Paper>

          <PropertyServices propertyId={p.id} />
          <PropertyCharges propertyId={p.id} />

          <EntityDocuments entityType="property" entityId={p.id} country={p.country_code} types={PROPERTY_DOC_TYPES} title="מסמכי הנכס" />

          <Paper withBorder p="md">
            <Title order={4} mb={4}>תנועות</Title>
            <Text size="xs" c="dimmed" mb="sm">התנועות של הנכס הזה בכל חשבון, לפי הבעלים. רק תנועות שאושרו.</Text>
            <QueryState q={ledger}>{(m) => <AccountLedger accounts={m.accounts} entries={m.entries} property />}</QueryState>
          </Paper>
        </Stack>
      );
    }}</QueryState>
  );
}
