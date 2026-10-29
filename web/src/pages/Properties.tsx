import { Anchor, Group, Paper, Select, Stack, Table, Text, TextInput, Title } from '@mantine/core';
import { IconSearch } from '@tabler/icons-react';
import { useMemo } from 'react';
import { Link, useSearchParams } from 'react-router-dom';
import { CountryBadge, CountryFilter, QueryState, StatusBadge } from '../components/common';
import { buildingLabel, currentLease, money, owners, STATUS_HE } from '../lib/format';
import { useProperties } from '../lib/queries';

export function Properties() {
  const [params, setParams] = useSearchParams();
  const country = params.get('country') ?? 'all';
  const status = params.get('status');
  const city = params.get('city');
  const search = params.get('q') ?? '';
  const q = useProperties();
  const update = (k: string, v: string | null) => setParams((p) => { if (v) p.set(k, v); else p.delete(k); return p; }, { replace: true });

  const cities = useMemo(() => [...new Set((q.data ?? []).filter((p) => country === 'all' || p.country_code === country)
    .map((p) => p.building.city.name_he))].sort(), [q.data, country]);

  const rows = useMemo(() => {
    const s = search.trim().toLowerCase();
    return (q.data ?? [])
      .filter((p) => country === 'all' || p.country_code === country)
      .filter((p) => !status || p.status === status)
      .filter((p) => !city || p.building.city.name_he === city)
      .filter((p) => !s || [p.building.name, p.building.address, p.unit_no, owners(p), p.building.project?.name].some((x) => x?.toLowerCase().includes(s)))
      .sort((a, b) => a.country_code.localeCompare(b.country_code) || buildingLabel(a.building).localeCompare(buildingLabel(b.building))
        || a.unit_no.localeCompare(b.unit_no, undefined, { numeric: true }));
  }, [q.data, country, status, city, search]);

  return (
    <Stack>
      <Title order={2}>נכסים</Title>
      <Group>
        <CountryFilter value={country} onChange={(v) => { update('country', v); update('city', null); }} />
        <Select placeholder="עיר" data={cities} value={city} onChange={(v) => update('city', v)} clearable w={150} />
        <Select placeholder="סטטוס" data={Object.entries(STATUS_HE).map(([value, label]) => ({ value, label }))} value={status} onChange={(v) => update('status', v)} clearable w={170} />
        <TextInput placeholder="חיפוש בניין, דירה או בעלים" leftSection={<IconSearch size={16} />} value={search} onChange={(e) => update('q', e.currentTarget.value)} w={260} />
      </Group>
      <QueryState q={q}>{() => (
        <Paper withBorder p="sm">
          <Text size="sm" c="dimmed" mb="xs">{rows.length} נכסים</Text>
          <Table.ScrollContainer minWidth={800}>
            <Table striped highlightOnHover verticalSpacing="xs">
              <Table.Thead>
                <Table.Tr>
                  <Table.Th>מדינה</Table.Th>
                  <Table.Th>עיר</Table.Th>
                  <Table.Th>בניין</Table.Th>
                  <Table.Th>דירה</Table.Th>
                  <Table.Th>בעלים</Table.Th>
                  <Table.Th>סטטוס</Table.Th>
                  <Table.Th>שכירות נוכחית</Table.Th>
                </Table.Tr>
              </Table.Thead>
              <Table.Tbody>
                {rows.map((p) => {
                  const l = currentLease(p);
                  return (
                    <Table.Tr key={p.id}>
                      <Table.Td><CountryBadge code={p.country_code} /></Table.Td>
                      <Table.Td>{p.building.city.name_he}</Table.Td>
                      <Table.Td>{buildingLabel(p.building)}</Table.Td>
                      <Table.Td><Anchor component={Link} to={`/properties/${p.id}`} fw={500}>{p.unit_no}</Anchor></Table.Td>
                      <Table.Td><Text size="sm" lineClamp={2}>{owners(p) || '—'}</Text></Table.Td>
                      <Table.Td><StatusBadge status={p.status} /></Table.Td>
                      <Table.Td style={{ whiteSpace: 'nowrap' }}>{l ? money(l.rent_amount, l.rent_currency) : '—'}</Table.Td>
                    </Table.Tr>
                  );
                })}
              </Table.Tbody>
            </Table>
          </Table.ScrollContainer>
        </Paper>
      )}</QueryState>
    </Stack>
  );
}
