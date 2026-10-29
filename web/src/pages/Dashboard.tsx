import { Anchor, Group, Paper, SimpleGrid, Stack, Table, Text, ThemeIcon, Title } from '@mantine/core';
import { IconAlertTriangle, IconCalendarDue, IconFileImport, IconMessages } from '@tabler/icons-react';
import { useQuery } from '@tanstack/react-query';
import { Link } from 'react-router-dom';
import { QueryState } from '../components/common';
import { useAccess } from '../lib/access';
import { COUNTRY_HE, currentLease, date, isIncompleteLease, money, propertyTitle } from '../lib/format';
import { useLeases, useProperties } from '../lib/queries';
import { supabase } from '../lib/supabase';
import { filterLeases } from './Leases';

// Counts for modules whose data arrives in later stages (intake, WhatsApp).
function useCount(table: string, column: string, values: string[]) {
  return useQuery({
    queryKey: ['count', table, column, values],
    queryFn: async () => {
      const { count, error } = await supabase.from(table).select('id', { count: 'exact', head: true }).in(column, values);
      if (error) throw new Error(error.message);
      return count ?? 0;
    },
  });
}

function Tile({ icon: Icon, color, label, value, to, hint }: { icon: typeof IconAlertTriangle; color: string; label: string; value: number | string; to?: string; hint?: string }) {
  const body = (
    <Paper withBorder p="md" h="100%">
      <Group justify="space-between" align="flex-start" wrap="nowrap">
        <div>
          <Text size="sm" c="dimmed">{label}</Text>
          <Text fz={28} fw={700} lh={1.2}>{value}</Text>
          {hint && <Text size="xs" c="dimmed">{hint}</Text>}
        </div>
        <ThemeIcon variant="light" color={color} size="lg"><Icon size={20} /></ThemeIcon>
      </Group>
    </Paper>
  );
  return to ? <Anchor component={Link} to={to} underline="never" c="inherit">{body}</Anchor> : body;
}

export function Dashboard() {
  const access = useAccess();
  const properties = useProperties();
  const leases = useLeases();
  const pendingBatches = useCount('import_batches', 'status', ['parsed', 'in_review']);
  const openConversations = useCount('conversations', 'status', ['open']);
  const ending = filterLeases(leases.data ?? [], 'ending').sort((a, b) => (a.end_date ?? '').localeCompare(b.end_date ?? ''));
  const incomplete = (leases.data ?? []).filter(isIncompleteLease).length;

  return (
    <Stack>
      <Title order={2}>שלום, {access.displayName}</Title>
      <SimpleGrid cols={{ base: 1, xs: 2, md: 4 }}>
        <Tile icon={IconFileImport} color="indigo" label="דוחות שממתינים לאישור" value={pendingBatches.data ?? '…'} hint="הקליטה תיבנה בשלב הבא" />
        <Tile icon={IconCalendarDue} color="orange" label="חוזים שמסתיימים ב-60 יום" value={leases.data ? ending.length : '…'} to="/leases?view=ending" />
        <Tile icon={IconAlertTriangle} color="red" label="חוזים שחסרים בהם פרטים" value={leases.data ? incomplete : '…'} to="/leases?view=incomplete" />
        <Tile icon={IconMessages} color="teal" label="הודעות שלא נענו" value={openConversations.data ?? '…'} hint="וואטסאפ ייבנה בשלב 6" />
      </SimpleGrid>

      <Paper withBorder p="md">
        <Title order={4} mb="sm">לפי מדינה</Title>
        <QueryState q={properties}>{(ps) => (
          <Table.ScrollContainer minWidth={500}>
            <Table verticalSpacing="xs">
              <Table.Thead>
                <Table.Tr><Table.Th>מדינה</Table.Th><Table.Th>נכסים</Table.Th><Table.Th>עם חוזה פעיל</Table.Th><Table.Th>השכרה קצרה</Table.Th><Table.Th>בבנייה</Table.Th><Table.Th>נמכרו</Table.Th></Table.Tr>
              </Table.Thead>
              <Table.Tbody>
                {access.countries.map((c) => {
                  const mine = ps.filter((p) => p.country_code === c);
                  if (!mine.length) return null;
                  const link = (q: string) => `/properties?country=${c}${q}`;
                  return (
                    <Table.Tr key={c}>
                      <Table.Td fw={500}>{COUNTRY_HE[c]}</Table.Td>
                      <Table.Td><Anchor component={Link} to={link('')} size="sm">{mine.length}</Anchor></Table.Td>
                      <Table.Td>{mine.filter((p) => currentLease(p)).length}</Table.Td>
                      <Table.Td><Anchor component={Link} to={link('&status=short_term')} size="sm">{mine.filter((p) => p.status === 'short_term').length}</Anchor></Table.Td>
                      <Table.Td><Anchor component={Link} to={link('&status=under_construction')} size="sm">{mine.filter((p) => p.status === 'under_construction').length}</Anchor></Table.Td>
                      <Table.Td>{mine.filter((p) => p.status === 'sold').length}</Table.Td>
                    </Table.Tr>
                  );
                })}
              </Table.Tbody>
            </Table>
          </Table.ScrollContainer>
        )}</QueryState>
      </Paper>

      <Paper withBorder p="md">
        <Group justify="space-between" mb="sm">
          <Title order={4}>חוזים שמסתיימים בקרוב</Title>
          <Anchor component={Link} to="/leases?view=ending" size="sm">לכל החוזים</Anchor>
        </Group>
        <QueryState q={leases}>{() => ending.length ? (
          <Table verticalSpacing="xs">
            <Table.Thead><Table.Tr><Table.Th>נכס</Table.Th><Table.Th>שוכר</Table.Th><Table.Th>סיום</Table.Th><Table.Th>שכירות</Table.Th></Table.Tr></Table.Thead>
            <Table.Tbody>
              {ending.slice(0, 10).map((l) => (
                <Table.Tr key={l.id}>
                  <Table.Td><Anchor component={Link} to={`/properties/${l.property.id}`} size="sm">{propertyTitle(l.property)}</Anchor></Table.Td>
                  <Table.Td>{l.tenant?.display_name ?? '—'}</Table.Td>
                  <Table.Td>{date(l.end_date)}</Table.Td>
                  <Table.Td style={{ whiteSpace: 'nowrap' }}>{money(l.rent_amount, l.rent_currency)}</Table.Td>
                </Table.Tr>
              ))}
            </Table.Tbody>
          </Table>
        ) : <Text c="dimmed" size="sm">אין חוזים שמסתיימים ב-60 הימים הקרובים</Text>}</QueryState>
      </Paper>
    </Stack>
  );
}
