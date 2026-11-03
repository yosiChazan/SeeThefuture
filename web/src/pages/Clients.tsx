import { Anchor, Button, Group, Paper, Stack, Table, Text, TextInput, Title } from '@mantine/core';
import { IconPlus, IconSearch } from '@tabler/icons-react';
import { useMemo, useState } from 'react';
import { ClientForm } from '../components/ClientForm';
import { useAccess } from '../lib/access';
import { Link, useSearchParams } from 'react-router-dom';
import { CountryBadge, CountryFilter, QueryState, SortHeader } from '../components/common';
import { idNumberOf, RELATION_HE, useClients, usePartyLinks, type ClientRow } from '../lib/queries';
import { COUNTRY_HE } from '../lib/format';
import type { Country } from '../lib/types';

// Countries come from the client's properties; parties themselves span countries.
const countriesOf = (c: ClientRow) => [...new Set(c.ownerships.map((o) => o.property?.country_code).filter((x): x is Country => !!x))];
const propertyCount = (c: ClientRow) => new Set(c.ownerships.filter((o) => !o.valid_to && o.property).map((o) => o.property!.id)).size;

// Sorting by a column (SPEC decision 73): a click sorts by it, a second click reverses.
// Empty values stay at the bottom either way. Kept in the address, like the filters.
type SortKey = 'first' | 'last' | 'id' | 'countries' | 'properties';
const he = (a: string, b: string) => a.localeCompare(b, 'he', { numeric: true });
const byName = (a: ClientRow, b: ClientRow) => he(a.last_name ?? a.display_name, b.last_name ?? b.display_name) || he(a.first_name ?? '', b.first_name ?? '');
const SORT_VALUE: Record<SortKey, (c: ClientRow) => string | number | null> = {
  first: (c) => c.first_name || (c.last_name ? null : c.display_name),
  last: (c) => c.last_name || c.display_name,
  id: (c) => idNumberOf(c),
  countries: (c) => countriesOf(c).map((x) => COUNTRY_HE[x]).sort(he).join(', ') || null,
  properties: (c) => propertyCount(c) || null,
};
function compare(key: SortKey, desc: boolean) {
  return (a: ClientRow, b: ClientRow) => {
    const x = SORT_VALUE[key](a), y = SORT_VALUE[key](b);
    if (x === null || y === null) return x === y ? byName(a, b) : x === null ? 1 : -1;
    const d = typeof x === 'number' && typeof y === 'number' ? x - y : he(String(x), String(y));
    return (desc ? -d : d) || byName(a, b);
  };
}

export function Clients() {
  const [params, setParams] = useSearchParams();
  const country = params.get('country') ?? 'all';
  const search = params.get('q') ?? '';
  const q = useClients();
  const links = usePartyLinks();
  const access = useAccess();
  const canAdd = access.isAdmin || access.countries.some((x) => access.canEdit(x));
  const [adding, setAdding] = useState(false);
  const update = (k: string, v: string) => setParams((p) => { p.set(k, v); return p; }, { replace: true });
  const sort = (['first', 'last', 'id', 'countries', 'properties'].includes(params.get('sort') ?? '') ? params.get('sort') : 'last') as SortKey;
  const desc = params.get('dir') === 'desc';
  const onSort = (k: SortKey) => setParams((p) => { p.set('sort', k); p.set('dir', k === sort && !desc ? 'desc' : 'asc'); return p; }, { replace: true });

  // A partner is listed under the main client, not on its own row (SPEC decision 77).
  const membersOf = useMemo(() => {
    const m = new Map<string, { name: string; relation: string }[]>();
    for (const l of links.data ?? []) m.set(l.main_party_id, [...(m.get(l.main_party_id) ?? []), { name: l.member.display_name, relation: RELATION_HE[l.relation] }]);
    return m;
  }, [links.data]);
  const isMember = useMemo(() => new Set((links.data ?? []).map((l) => l.member_party_id)), [links.data]);
  const rows = useMemo(() => {
    const s = search.trim().toLowerCase();
    return (q.data ?? [])
      .filter((c) => !isMember.has(c.id))
      .filter((c) => country === 'all' || countriesOf(c).includes(country as Country))
      .filter((c) => !s || [c.display_name, c.first_name, c.last_name, c.email, c.phone, idNumberOf(c), ...(membersOf.get(c.id) ?? []).map((m) => m.name)].some((x) => x?.toLowerCase().includes(s))
        || (/^\d{3,}$/.test(s) && (idNumberOf(c) ?? '').replace(/^0+/, '').includes(s.replace(/^0+/, ''))))
      // Default: by family name; a name not split yet sorts by its full name (SPEC decision 72).
      .sort(compare(sort, desc));
  }, [q.data, country, search, sort, desc, isMember, membersOf]);

  return (
    <Stack>
      <Group justify="space-between">
        <Title order={2}>לקוחות</Title>
        {canAdd && <Button leftSection={<IconPlus size={16} />} onClick={() => setAdding(true)}>לקוח חדש</Button>}
      </Group>
      {adding && <ClientForm opened onClose={() => setAdding(false)} />}
      <Group>
        <CountryFilter value={country} onChange={(v) => update('country', v)} />
        <TextInput placeholder="חיפוש שם, ת.ז., מייל או טלפון" leftSection={<IconSearch size={16} />} value={search} onChange={(e) => update('q', e.currentTarget.value)} w={260} />
      </Group>
      <QueryState q={q}>{() => (
        <Paper withBorder p="sm">
          <Text size="sm" c="dimmed" mb="xs">{rows.length} לקוחות</Text>
          <Table.ScrollContainer minWidth={900}>
            <Table striped highlightOnHover verticalSpacing="xs">
              <Table.Thead>
                <Table.Tr>
                  {([['שם פרטי', 'first'], ['שם משפחה', 'last'], ['ת.ז.', 'id'], ['מדינות', 'countries'], ['נכסים', 'properties']] as const).map(([label, k]) => (
                    <SortHeader key={k} label={label} k={k} sort={sort} desc={desc} onSort={onSort} />
                  ))}
                  <Table.Th>טלפון</Table.Th><Table.Th>מייל</Table.Th>
                </Table.Tr>
              </Table.Thead>
              <Table.Tbody>
                {rows.flatMap((c) => [
                  <Table.Tr key={c.id}>
                    {c.first_name || c.last_name ? (
                      <>
                        <Table.Td><Anchor component={Link} to={`/clients/${c.id}`} fw={500} size="sm">{c.first_name || '—'}</Anchor></Table.Td>
                        <Table.Td><Anchor component={Link} to={`/clients/${c.id}`} fw={500} size="sm">{c.last_name || '—'}</Anchor></Table.Td>
                      </>
                    ) : (
                      <Table.Td colSpan={2}><Anchor component={Link} to={`/clients/${c.id}`} fw={500} size="sm">{c.display_name}</Anchor></Table.Td>
                    )}
                    <Table.Td dir="ltr" style={{ textAlign: 'right', whiteSpace: 'nowrap' }}>{idNumberOf(c) ?? '—'}</Table.Td>
                    <Table.Td><Group gap={4}>{countriesOf(c).map((x) => <CountryBadge key={x} code={x} />)}</Group></Table.Td>
                    <Table.Td>{propertyCount(c) || '—'}</Table.Td>
                    <Table.Td dir="ltr" style={{ textAlign: 'right' }}>{c.phone ?? '—'}</Table.Td>
                    <Table.Td dir="ltr" style={{ textAlign: 'right' }}>{c.email ?? '—'}</Table.Td>
                  </Table.Tr>,
                  ...(membersOf.get(c.id) ?? []).map((m) => (
                    <Table.Tr key={`${c.id}-${m.name}`}>
                      <Table.Td colSpan={7} pt={0}><Text size="xs" c="dimmed">↳ {m.relation}: {m.name}</Text></Table.Td>
                    </Table.Tr>
                  ))])}
              </Table.Tbody>
            </Table>
          </Table.ScrollContainer>
        </Paper>
      )}</QueryState>
    </Stack>
  );
}
