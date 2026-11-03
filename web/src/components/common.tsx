import { Alert, Badge, Center, Group, Loader, SegmentedControl, Table, Text, UnstyledButton, type MantineSize } from '@mantine/core';
import { IconChevronDown, IconChevronUp, IconSelector } from '@tabler/icons-react';
import type { UseQueryResult } from '@tanstack/react-query';
import type { ReactNode } from 'react';
import { useAccess } from '../lib/access';
import { COUNTRY_HE, STATUS_COLOR, STATUS_HE } from '../lib/format';
import type { Country, PropertyStatus } from '../lib/types';

export function QueryState<T>({ q, children }: { q: UseQueryResult<T>; children: (data: T) => ReactNode }) {
  if (q.isLoading) return <Center p="xl"><Loader /></Center>;
  if (q.error) return <Alert color="red" title="שגיאה בטעינת הנתונים">{q.error.message}</Alert>;
  return <>{children(q.data as T)}</>;
}

export function StatusBadge({ status, size = 'sm' }: { status: PropertyStatus; size?: MantineSize }) {
  return <Badge color={STATUS_COLOR[status]} variant="light" size={size}>{STATUS_HE[status]}</Badge>;
}

export function CountryBadge({ code }: { code: Country }) {
  return <Badge variant="outline" color="gray" size="sm">{COUNTRY_HE[code]}</Badge>;
}

// "all" plus every country the user may read.
export function CountryFilter({ value, onChange }: { value: string; onChange: (v: string) => void }) {
  const { countries } = useAccess();
  if (countries.length < 2) return null;
  return (
    <SegmentedControl value={value} onChange={onChange}
      data={[{ value: 'all', label: 'הכול' }, ...countries.map((c) => ({ value: c, label: COUNTRY_HE[c] }))]} />
  );
}

// A column header that sorts the table (SPEC decision 73): a click sorts by it, a second
// click reverses. The arrow shows the column and the direction.
export function SortHeader<K extends string>({ label, k, sort, desc, onSort }: { label: string; k: K; sort: K; desc: boolean; onSort: (k: K) => void }) {
  const Icon = sort !== k ? IconSelector : desc ? IconChevronDown : IconChevronUp;
  return (
    <Table.Th>
      <UnstyledButton onClick={() => onSort(k)} aria-label={`מיון לפי ${label}`}>
        <Group gap={4} wrap="nowrap"><Text size="sm" fw={700}>{label}</Text><Icon size={14} stroke={1.6} opacity={sort === k ? 1 : 0.5} /></Group>
      </UnstyledButton>
    </Table.Th>
  );
}
