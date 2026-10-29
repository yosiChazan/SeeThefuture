import { Anchor, Group, Paper, Stack, Table, Text, TextInput, Title } from '@mantine/core';
import { IconSearch } from '@tabler/icons-react';
import { useMemo } from 'react';
import { Link, useSearchParams } from 'react-router-dom';
import { CountryBadge, CountryFilter, QueryState } from '../components/common';
import { useClients, type ClientRow } from '../lib/queries';
import type { Country } from '../lib/types';

// Countries come from the client's properties; parties themselves span countries.
const countriesOf = (c: ClientRow) => [...new Set(c.ownerships.map((o) => o.property?.country_code).filter((x): x is Country => !!x))];
const propertyCount = (c: ClientRow) => new Set(c.ownerships.filter((o) => !o.valid_to && o.property).map((o) => o.property!.id)).size;

export function Clients() {
  const [params, setParams] = useSearchParams();
  const country = params.get('country') ?? 'all';
  const search = params.get('q') ?? '';
  const q = useClients();
  const update = (k: string, v: string) => setParams((p) => { p.set(k, v); return p; }, { replace: true });

  const rows = useMemo(() => {
    const s = search.trim().toLowerCase();
    return (q.data ?? [])
      .filter((c) => country === 'all' || countriesOf(c).includes(country as Country))
      .filter((c) => !s || [c.display_name, c.email, c.phone].some((x) => x?.toLowerCase().includes(s)))
      .sort((a, b) => a.display_name.localeCompare(b.display_name));
  }, [q.data, country, search]);

  return (
    <Stack>
      <Title order={2}>לקוחות</Title>
      <Group>
        <CountryFilter value={country} onChange={(v) => update('country', v)} />
        <TextInput placeholder="חיפוש שם, מייל או טלפון" leftSection={<IconSearch size={16} />} value={search} onChange={(e) => update('q', e.currentTarget.value)} w={260} />
      </Group>
      <QueryState q={q}>{() => (
        <Paper withBorder p="sm">
          <Text size="sm" c="dimmed" mb="xs">{rows.length} לקוחות</Text>
          <Table.ScrollContainer minWidth={700}>
            <Table striped highlightOnHover verticalSpacing="xs">
              <Table.Thead>
                <Table.Tr><Table.Th>שם</Table.Th><Table.Th>מדינות</Table.Th><Table.Th>נכסים</Table.Th><Table.Th>טלפון</Table.Th><Table.Th>מייל</Table.Th></Table.Tr>
              </Table.Thead>
              <Table.Tbody>
                {rows.map((c) => (
                  <Table.Tr key={c.id}>
                    <Table.Td><Anchor component={Link} to={`/clients/${c.id}`} fw={500} size="sm">{c.display_name}</Anchor></Table.Td>
                    <Table.Td><Group gap={4}>{countriesOf(c).map((x) => <CountryBadge key={x} code={x} />)}</Group></Table.Td>
                    <Table.Td>{propertyCount(c) || '—'}</Table.Td>
                    <Table.Td dir="ltr" style={{ textAlign: 'right' }}>{c.phone ?? '—'}</Table.Td>
                    <Table.Td dir="ltr" style={{ textAlign: 'right' }}>{c.email ?? '—'}</Table.Td>
                  </Table.Tr>
                ))}
              </Table.Tbody>
            </Table>
          </Table.ScrollContainer>
        </Paper>
      )}</QueryState>
    </Stack>
  );
}
