import { Group, Paper, SegmentedControl, Stack, Text, TextInput, Title } from '@mantine/core';
import { IconSearch } from '@tabler/icons-react';
import dayjs from 'dayjs';
import { useMemo } from 'react';
import { useSearchParams } from 'react-router-dom';
import { CountryFilter, QueryState } from '../components/common';
import { LeaseTable } from '../components/LeaseTable';
import { isActiveLease, isIncompleteLease, today } from '../lib/format';
import { useLeases, type LeaseRow } from '../lib/queries';

const VIEWS = [
  { value: 'active', label: 'פעילים' },
  { value: 'ending', label: 'מסתיימים ב-60 יום' },
  { value: 'incomplete', label: 'חסרים פרטים' },
  { value: 'all', label: 'הכול' },
];

export function filterLeases(rows: LeaseRow[], view: string): LeaseRow[] {
  const t = today();
  const limit = dayjs().add(60, 'day').format('YYYY-MM-DD');
  switch (view) {
    case 'active': return rows.filter((l) => isActiveLease(l));
    case 'ending': return rows.filter((l) => isActiveLease(l) && !!l.end_date && l.end_date >= t && l.end_date <= limit);
    case 'incomplete': return rows.filter(isIncompleteLease);
    default: return rows;
  }
}

export function Leases() {
  const [params, setParams] = useSearchParams();
  const view = params.get('view') ?? 'active';
  const country = params.get('country') ?? 'all';
  const search = params.get('q') ?? '';
  const q = useLeases();
  const update = (k: string, v: string) => setParams((p) => { p.set(k, v); return p; }, { replace: true });

  const rows = useMemo(() => {
    const s = search.trim().toLowerCase();
    return filterLeases(q.data ?? [], view)
      .filter((l) => country === 'all' || l.property.country_code === country)
      .filter((l) => !s || [l.tenant?.display_name, l.property.building.name, l.property.building.project?.name, l.property.unit_no, l.notes].some((x) => x?.toLowerCase().includes(s)))
      .sort((a, b) => (view === 'ending' ? (a.end_date ?? '').localeCompare(b.end_date ?? '') : (b.start_date ?? '').localeCompare(a.start_date ?? '')));
  }, [q.data, view, country, search]);

  return (
    <Stack>
      <Title order={2}>חוזי שכירות</Title>
      <Group>
        <SegmentedControl data={VIEWS} value={view} onChange={(v) => update('view', v)} />
        <CountryFilter value={country} onChange={(v) => update('country', v)} />
        <TextInput placeholder="חיפוש שוכר, בניין או הערה" leftSection={<IconSearch size={16} />} value={search} onChange={(e) => update('q', e.currentTarget.value)} w={260} />
      </Group>
      <QueryState q={q}>{() => (
        <Paper withBorder p="sm">
          <Text size="sm" c="dimmed" mb="xs">{rows.length} חוזים</Text>
          <LeaseTable leases={rows} showProperty />
        </Paper>
      )}</QueryState>
    </Stack>
  );
}
