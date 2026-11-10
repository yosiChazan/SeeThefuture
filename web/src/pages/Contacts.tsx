import { Anchor, Badge, Button, Group, Paper, Stack, Table, Text, TextInput, Title } from '@mantine/core';
import { IconPlus, IconSearch } from '@tabler/icons-react';
import { useMemo, useState } from 'react';
import { ClientForm } from '../components/ClientForm';
import { useAccess } from '../lib/access';
import { Link, useSearchParams } from 'react-router-dom';
import { QueryState } from '../components/common';
import { useContacts } from '../lib/queries';

export const ROLE_HE: Record<string, string> = {
  client: 'לקוח', contact: 'איש קשר', tenant: 'שוכר', manager: 'מנהל נכסים', lawyer: 'עו"ד', hotel: 'מלון',
  developer: 'יזם', supplier: 'ספק', marketer: 'משווק', internal: 'פנימי',
};

// Everyone we deal with who is not a client (SPEC decision 76). A contact opens in the
// same card as a client; "set as client" there moves them back to the clients list.
export function Contacts() {
  const [params, setParams] = useSearchParams();
  const search = params.get('q') ?? '';
  const role = params.get('role');
  const q = useContacts();
  const roles = useMemo(() => [...new Set((q.data ?? []).flatMap((c) => c.party_roles.map((r) => r.role)))].sort(), [q.data]);
  const rows = useMemo(() => {
    const s = search.trim().toLowerCase();
    return (q.data ?? [])
      .filter((c) => !role || c.party_roles.some((r) => r.role === role))
      .filter((c) => !s || [c.display_name, c.phone, c.email].some((x) => x?.toLowerCase().includes(s)))
      .sort((a, b) => a.display_name.localeCompare(b.display_name, 'he'));
  }, [q.data, search, role]);
  const access = useAccess();
  const canAdd = access.isAdmin || access.countries.some((x) => access.canEdit(x));
  const [adding, setAdding] = useState(false);
  const set = (k: string, v: string | null) => setParams((p) => { if (v) p.set(k, v); else p.delete(k); return p; }, { replace: true });

  return (
    <Stack>
      <Group justify="space-between">
        <Title order={2}>אנשי קשר</Title>
        {canAdd && <Button leftSection={<IconPlus size={16} />} onClick={() => setAdding(true)}>איש קשר חדש</Button>}
      </Group>
      {adding && <ClientForm opened contact onClose={() => setAdding(false)} />}
      <Text size="sm" c="dimmed">שוכרים, ספקים, עורכי דין, מנהלים ומי שאינו לקוח. לקוח שאינו באמת לקוח מעבירים לכאן מהכרטיס שלו ("הגדרה כאיש קשר").</Text>
      <Group>
        <TextInput placeholder="חיפוש שם, טלפון או מייל" leftSection={<IconSearch size={16} />} value={search} onChange={(e) => set('q', e.currentTarget.value)} w={260} />
        <Group gap={6}>
          <Badge variant={!role ? 'filled' : 'light'} style={{ cursor: 'pointer' }} onClick={() => set('role', null)}>הכול</Badge>
          {roles.map((r) => <Badge key={r} variant={role === r ? 'filled' : 'light'} color="gray" style={{ cursor: 'pointer' }} onClick={() => set('role', r)}>{ROLE_HE[r] ?? r}</Badge>)}
        </Group>
      </Group>
      <QueryState q={q}>{() => (
        <Paper withBorder p="sm">
          <Text size="sm" c="dimmed" mb="xs">{rows.length} אנשי קשר</Text>
          <Table.ScrollContainer minWidth={700}>
            <Table striped highlightOnHover verticalSpacing="xs">
              <Table.Thead><Table.Tr><Table.Th>שם</Table.Th><Table.Th>תפקיד</Table.Th><Table.Th>טלפון</Table.Th><Table.Th>מייל</Table.Th></Table.Tr></Table.Thead>
              <Table.Tbody>
                {rows.map((c) => (
                  <Table.Tr key={c.id}>
                    <Table.Td><Anchor component={Link} to={`/contacts/${c.id}`} fw={500} size="sm">{c.display_name}</Anchor>{c.kind === 'company' && <Badge size="xs" ml={6} variant="light">חברה</Badge>}</Table.Td>
                    <Table.Td><Group gap={4}>{c.party_roles.map((r) => <Badge key={r.role} size="sm" variant="light" color="gray">{ROLE_HE[r.role] ?? r.role}</Badge>)}</Group></Table.Td>
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
