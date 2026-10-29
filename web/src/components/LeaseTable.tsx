import { ActionIcon, Anchor, Badge, Group, Table, Text, Tooltip } from '@mantine/core';
import { IconPencil } from '@tabler/icons-react';
import dayjs from 'dayjs';
import { useState } from 'react';
import { Link } from 'react-router-dom';
import { useAccess } from '../lib/access';
import { date, isActiveLease, isIncompleteLease, money, propertyTitle, today } from '../lib/format';
import type { LeaseRow } from '../lib/queries';
import type { Country, Lease } from '../lib/types';
import { LeaseForm } from './LeaseForm';

export function LeaseState({ lease }: { lease: Lease }) {
  if (isIncompleteLease(lease)) return <Badge color="red" variant="light" size="sm">חסרים פרטים</Badge>;
  if (isActiveLease(lease)) {
    const soon = lease.end_date && dayjs(lease.end_date).diff(today(), 'day') <= 60;
    return <Badge color={soon ? 'orange' : 'teal'} variant="light" size="sm">{soon ? 'מסתיים בקרוב' : 'פעיל'}</Badge>;
  }
  if (lease.start_date && lease.start_date > today()) return <Badge color="blue" variant="light" size="sm">עתידי</Badge>;
  return <Badge color="gray" variant="light" size="sm">הסתיים</Badge>;
}

// Shows leases; with `property` the property column links to its card.
export function LeaseTable({ leases, country, showProperty }: { leases: (Lease | LeaseRow)[]; country?: Country; showProperty?: boolean }) {
  const access = useAccess();
  const [editing, setEditing] = useState<Lease | null>(null);
  if (!leases.length) return <Text c="dimmed" size="sm">אין חוזים</Text>;
  return (
    <>
      <Table.ScrollContainer minWidth={700}>
        <Table striped highlightOnHover verticalSpacing="xs">
          <Table.Thead>
            <Table.Tr>
              {showProperty && <Table.Th>נכס</Table.Th>}
              <Table.Th>שוכר</Table.Th>
              <Table.Th>התחלה</Table.Th>
              <Table.Th>סיום</Table.Th>
              <Table.Th>שכירות</Table.Th>
              <Table.Th>פיקדון</Table.Th>
              <Table.Th>מצב</Table.Th>
              <Table.Th />
            </Table.Tr>
          </Table.Thead>
          <Table.Tbody>
            {leases.map((l) => {
              const p = 'property' in l ? l.property : undefined;
              const c = p?.country_code ?? country;
              return (
                <Table.Tr key={l.id}>
                  {showProperty && p && (
                    <Table.Td>
                      <Anchor component={Link} to={`/properties/${p.id}`} size="sm">{propertyTitle(p)}</Anchor>
                      <Text size="xs" c="dimmed">{p.building.city.name_he}</Text>
                    </Table.Td>
                  )}
                  <Table.Td>{l.tenant?.display_name ?? <Text span c="dimmed" size="sm">—</Text>}</Table.Td>
                  <Table.Td>{date(l.start_date)}</Table.Td>
                  <Table.Td>{date(l.end_date)}</Table.Td>
                  <Table.Td style={{ whiteSpace: 'nowrap' }}>{money(l.rent_amount, l.rent_currency)}</Table.Td>
                  <Table.Td style={{ whiteSpace: 'nowrap' }}>{money(l.deposit_amount, l.deposit_currency)}</Table.Td>
                  <Table.Td><LeaseState lease={l} /></Table.Td>
                  <Table.Td>
                    <Group gap={4} wrap="nowrap" justify="flex-end">
                      {l.notes && <Tooltip label={<Text size="xs" style={{ whiteSpace: 'pre-wrap' }} maw={360}>{l.notes}</Text>} multiline><Badge variant="dot" color="gray" size="sm">הערה</Badge></Tooltip>}
                      {c && access.canEdit(c) && (
                        <ActionIcon variant="subtle" aria-label="עריכה" onClick={() => setEditing(l)}><IconPencil size={16} /></ActionIcon>
                      )}
                    </Group>
                  </Table.Td>
                </Table.Tr>
              );
            })}
          </Table.Tbody>
        </Table>
      </Table.ScrollContainer>
      {editing && <LeaseForm key={editing.id} lease={editing} opened onClose={() => setEditing(null)} />}
    </>
  );
}
