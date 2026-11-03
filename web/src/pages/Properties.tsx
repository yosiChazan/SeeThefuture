import { Anchor, Button, Group, Paper, Select, Stack, Table, Text, TextInput, Title } from '@mantine/core';
import { IconPlus, IconSearch } from '@tabler/icons-react';
import { useMemo, useState } from 'react';
import { PropertyForm } from '../components/PropertyForm';
import { useAccess } from '../lib/access';
import { Link, useSearchParams } from 'react-router-dom';
import { CountryBadge, CountryFilter, QueryState, SortHeader, StatusBadge } from '../components/common';
import { buildingLabel, COUNTRY_HE, currentLease, money, owners, STATUS_HE } from '../lib/format';
import type { Property } from '../lib/types';
import { useProperties } from '../lib/queries';

// Sorting by a column (like the clients list, SPEC decision 73): a click sorts A–Z / 1–∞,
// a second click reverses. Empty values stay at the bottom either way. Rent is sorted by
// currency and then by amount: amounts in different currencies are never compared.
type SortKey = 'country' | 'city' | 'building' | 'unit' | 'owners' | 'status' | 'rent';
const SORT_KEYS: SortKey[] = ['country', 'city', 'building', 'unit', 'owners', 'status', 'rent'];
const COLUMNS: [SortKey, string][] = [['country', 'מדינה'], ['city', 'עיר'], ['building', 'בניין'], ['unit', 'דירה'], ['owners', 'בעלים'], ['status', 'סטטוס'], ['rent', 'שכירות נוכחית']];
const he = (a: string, b: string) => a.localeCompare(b, 'he', { numeric: true });
const natural = (a: Property, b: Property) => he(COUNTRY_HE[a.country_code], COUNTRY_HE[b.country_code])
  || he(buildingLabel(a.building), buildingLabel(b.building)) || he(a.unit_no, b.unit_no);
const SORT_VALUE: Record<SortKey, (p: Property) => string | [string, number] | null> = {
  country: (p) => COUNTRY_HE[p.country_code],
  city: (p) => p.building.city.name_he || null,
  building: (p) => buildingLabel(p.building) || null,
  unit: (p) => p.unit_no || null,
  owners: (p) => owners(p) || null,
  status: (p) => STATUS_HE[p.status],
  rent: (p) => { const l = currentLease(p); return l && l.rent_amount !== null ? [l.rent_currency ?? '', Number(l.rent_amount)] : null; },
};
function compare(key: SortKey, desc: boolean) {
  return (a: Property, b: Property) => {
    const x = SORT_VALUE[key](a), y = SORT_VALUE[key](b);
    if (x === null || y === null) return x === y ? natural(a, b) : x === null ? 1 : -1;
    const d = Array.isArray(x) && Array.isArray(y) ? he(x[0], y[0]) || x[1] - y[1] : he(String(x), String(y));
    return (desc ? -d : d) || natural(a, b);
  };
}

export function Properties() {
  const [params, setParams] = useSearchParams();
  const country = params.get('country') ?? 'all';
  const status = params.get('status');
  const city = params.get('city');
  const search = params.get('q') ?? '';
  const sort = (SORT_KEYS.includes(params.get('sort') as SortKey) ? params.get('sort') : 'country') as SortKey;
  const desc = params.get('dir') === 'desc';
  const q = useProperties();
  const access = useAccess();
  const [adding, setAdding] = useState(false);
  // One call per change: two setParams calls in a row each start from the same URL,
  // so the second undid the first (choosing a country and clearing the city).
  const update = (changes: Record<string, string | null>) => setParams((prev) => {
    const p = new URLSearchParams(prev);
    for (const [k, v] of Object.entries(changes)) if (v) p.set(k, v); else p.delete(k);
    return p;
  }, { replace: true });

  const cities = useMemo(() => [...new Set((q.data ?? []).filter((p) => country === 'all' || p.country_code === country)
    .map((p) => p.building.city.name_he))].sort(), [q.data, country]);

  const rows = useMemo(() => {
    const s = search.trim().toLowerCase();
    return (q.data ?? [])
      .filter((p) => country === 'all' || p.country_code === country)
      .filter((p) => !status || p.status === status)
      .filter((p) => !city || p.building.city.name_he === city)
      .filter((p) => !s || [p.building.name, p.building.address, p.unit_no, owners(p), p.building.project?.name].some((x) => x?.toLowerCase().includes(s)))
      .sort(compare(sort, desc));
  }, [q.data, country, status, city, search, sort, desc]);
  const onSort = (k: SortKey) => update({ sort: k, dir: k === sort && !desc ? 'desc' : 'asc' });

  return (
    <Stack>
      <Group justify="space-between">
        <Title order={2}>נכסים</Title>
        {access.countries.some((c) => access.canEdit(c)) && <Button leftSection={<IconPlus size={16} />} onClick={() => setAdding(true)}>נכס חדש</Button>}
      </Group>
      {adding && <PropertyForm onClose={() => setAdding(false)} />}
      <Group>
        <CountryFilter value={country} onChange={(v) => update({ country: v, city: null })} />
        <Select placeholder="עיר" data={cities} value={city} onChange={(v) => update({ city: v })} clearable w={150} />
        <Select placeholder="סטטוס" data={Object.entries(STATUS_HE).map(([value, label]) => ({ value, label }))} value={status} onChange={(v) => update({ status: v })} clearable w={170} />
        <TextInput placeholder="חיפוש בניין, דירה או בעלים" leftSection={<IconSearch size={16} />} value={search} onChange={(e) => update({ q: e.currentTarget.value })} w={260} />
      </Group>
      <QueryState q={q}>{() => (
        <Paper withBorder p="sm">
          <Text size="sm" c="dimmed" mb="xs">{rows.length} נכסים</Text>
          <Table.ScrollContainer minWidth={800}>
            <Table striped highlightOnHover verticalSpacing="xs">
              <Table.Thead>
                <Table.Tr>
                  {COLUMNS.map(([k, label]) => <SortHeader key={k} label={label} k={k} sort={sort} desc={desc} onSort={onSort} />)}
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
