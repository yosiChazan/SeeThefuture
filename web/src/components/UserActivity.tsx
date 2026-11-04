import { Anchor, Badge, Button, Group, Modal, SegmentedControl, Stack, Table, Text } from '@mantine/core';
import { useInfiniteQuery } from '@tanstack/react-query';
import { useState } from 'react';
import { Link } from 'react-router-dom';
import { ACTION_HE, changedFields, groupActivity, recordLabel, recordLink, TABLE_HE, type AuditRow } from '../lib/activity';
import { must, supabase } from '../lib/supabase';

const PAGE = 300;
const FILTERS = [
  { value: 'all', label: 'הכול' }, { value: 'changes', label: 'שינויים' },
  { value: 'views', label: 'פתיחת מסמכים' }, { value: 'logins', label: 'כניסות' },
];
const COLOR: Record<string, string> = { INSERT: 'teal', UPDATE: 'blue', DELETE: 'red', VIEW: 'grape', LOGIN: 'gray' };
const when = (s: string) => new Date(s).toLocaleString('he-IL', { day: '2-digit', month: '2-digit', year: 'numeric', hour: '2-digit', minute: '2-digit' });

// Everything one user did, newest first (SPEC decision 90). Admins only: the log's policy.
export function UserActivity({ userId, name, onClose }: { userId: string; name: string; onClose: () => void }) {
  const [filter, setFilter] = useState('all');
  const q = useInfiniteQuery({
    queryKey: ['user-activity', userId, filter],
    initialPageParam: 0,
    queryFn: async ({ pageParam }) => {
      let s = supabase.from('audit_log').select('id, at, table_name, row_id, action, old_row, new_row').eq('user_id', userId);
      if (filter === 'views') s = s.eq('action', 'VIEW');
      if (filter === 'logins') s = s.eq('action', 'LOGIN');
      if (filter === 'changes') s = s.in('action', ['INSERT', 'UPDATE', 'DELETE']);
      return must(await s.order('at', { ascending: false }).order('id', { ascending: false }).range(pageParam, pageParam + PAGE - 1)) as AuditRow[];
    },
    getNextPageParam: (last, all) => (last.length === PAGE ? all.length * PAGE : undefined),
  });
  const rows = (q.data?.pages ?? []).flat();
  const groups = groupActivity(rows);
  return (
    <Modal opened onClose={onClose} title={`פעילות: ${name}`} size="xl">
      <Stack>
        <Group justify="space-between">
          <SegmentedControl size="xs" data={FILTERS} value={filter} onChange={setFilter} />
          <Text size="xs" c="dimmed">{rows.length} רישומים{q.hasNextPage ? ' (יש עוד)' : ''}</Text>
        </Group>
        {q.isLoading ? <Text c="dimmed">טוען…</Text> : !groups.length ? <Text c="dimmed">אין פעילות רשומה</Text> : (
          <Table.ScrollContainer minWidth={720}>
            <Table verticalSpacing={6} striped fz="sm">
              <Table.Thead><Table.Tr><Table.Th>מתי</Table.Th><Table.Th>פעולה</Table.Th><Table.Th>על מה</Table.Th><Table.Th>פרטים</Table.Th></Table.Tr></Table.Thead>
              <Table.Tbody>
                {groups.map((g) => {
                  const r = g.first, link = recordLink(r), label = recordLabel(r), fields = changedFields(r);
                  return (
                    <Table.Tr key={r.id}>
                      <Table.Td style={{ whiteSpace: 'nowrap' }}>{when(g.at)}</Table.Td>
                      <Table.Td><Badge size="sm" variant="light" color={COLOR[r.action] ?? 'gray'}>{ACTION_HE[r.action] ?? r.action}</Badge></Table.Td>
                      <Table.Td>{r.action === 'LOGIN' ? '' : g.count > 1 ? `${g.count} × ${TABLE_HE[r.table_name] ?? r.table_name}` : TABLE_HE[r.table_name] ?? r.table_name}</Table.Td>
                      <Table.Td>
                        {g.count === 1 && (link ? <Anchor component={Link} to={link} size="sm" onClick={onClose}>{label || 'פתיחה'}</Anchor> : <Text span size="sm">{label}</Text>)}
                        {g.count === 1 && fields.length > 0 && <Text span size="xs" c="dimmed"> · שונה: {fields.slice(0, 5).join(', ')}{fields.length > 5 ? '…' : ''}</Text>}
                        {g.count > 1 && <Text span size="xs" c="dimmed">עד {when(g.until)}</Text>}
                      </Table.Td>
                    </Table.Tr>
                  );
                })}
              </Table.Tbody>
            </Table>
          </Table.ScrollContainer>
        )}
        {q.hasNextPage && <Button variant="subtle" onClick={() => q.fetchNextPage()} loading={q.isFetchingNextPage}>טעינת פעילות קודמת</Button>}
        <Text size="xs" c="dimmed">פעולות רבות באותו רגע (למשל אישור דוח) מוצגות בשורה אחת עם מספר. פעילות מלפני 4.11.2026 על נכסים, מסמכים ודוחות לא נרשמה.</Text>
      </Stack>
    </Modal>
  );
}
