import { Anchor, Badge, Breadcrumbs, Group, Paper, SimpleGrid, Stack, Table, Text, Title } from '@mantine/core';
import { Link, useParams } from 'react-router-dom';
import { CountryBadge, QueryState, StatusBadge } from '../components/common';
import { LeaseTable } from '../components/LeaseTable';
import { COUNTRY_HE, date, isCurrentOwnership, propertyTitle } from '../lib/format';
import { useProperty } from '../lib/queries';

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
            <Group gap="xs"><CountryBadge code={p.country_code} /><StatusBadge status={p.status} size="md" /></Group>
          </Group>

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
                    <Table.Td>{date(o.valid_from)}</Table.Td>
                    <Table.Td>{o.valid_to ? date(o.valid_to) : <Badge size="xs" variant="light" color="teal">נוכחי</Badge>}</Table.Td>
                    <Table.Td><Text size="xs" c="dimmed">{o.notes}</Text></Table.Td>
                  </Table.Tr>
                ))}
              </Table.Tbody>
            </Table>
          </Paper>

          <Paper withBorder p="md">
            <Title order={4} mb="sm">חוזי שכירות</Title>
            <LeaseTable leases={leases} country={p.country_code} />
          </Paper>
        </Stack>
      );
    }}</QueryState>
  );
}
