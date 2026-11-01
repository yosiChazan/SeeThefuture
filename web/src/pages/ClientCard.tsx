import { Anchor, Badge, Breadcrumbs, Button, Group, Paper, SimpleGrid, Stack, Table, Text, Title } from '@mantine/core';
import { IconPencil } from '@tabler/icons-react';
import { useState } from 'react';
import { Link, useParams } from 'react-router-dom';
import { ClientForm } from '../components/ClientForm';
import { useAccess } from '../lib/access';
import { CountryBadge, QueryState, StatusBadge } from '../components/common';
import { AccountLedger } from '../components/AccountLedger';
import { ACCOUNT_KIND_HE, COUNTRY_HE, amountLabel, currentLease, date, isCurrentOwnership, money, propertyTitle } from '../lib/format';
import { useAccountEntries, useClient, useClientAccounts, useClientProperties } from '../lib/queries';

export function ClientCard() {
  const { id } = useParams();
  const client = useClient(id!);
  const properties = useClientProperties(id!);
  const accounts = useClientAccounts(id!);
  const entries = useAccountEntries((accounts.data ?? []).map((a) => a.id));
  const access = useAccess();
  // Any editor may change a client's details (the parties table is not per country).
  const canEdit = access.isAdmin || access.countries.some((x) => access.canEdit(x));
  const [editing, setEditing] = useState(false);

  return (
    <QueryState q={client}>{(c) => (
      <Stack>
        <Breadcrumbs>
          <Anchor component={Link} to="/clients" size="sm">לקוחות</Anchor>
          <Text size="sm">{c.display_name}</Text>
        </Breadcrumbs>
        <Group justify="space-between">
          <Group gap="xs">
            <Title order={2}>{c.display_name}</Title>
            {c.kind === 'company' && <Badge variant="light">חברה</Badge>}
          </Group>
          {canEdit && <Button variant="default" leftSection={<IconPencil size={16} />} onClick={() => setEditing(true)}>עריכה</Button>}
        </Group>
        {editing && <ClientForm client={c} opened onClose={() => setEditing(false)} />}

        <Paper withBorder p="md">
          <SimpleGrid cols={{ base: 1, sm: 3 }}>
            <div><Text size="xs" c="dimmed">שם בדוחות</Text><Text size="sm" dir="ltr" ta="right">{c.legal_name ?? '—'}</Text></div>
            <div><Text size="xs" c="dimmed">טלפון</Text><Text size="sm" dir="ltr" ta="right">{c.phone ?? '—'}</Text></div>
            <div><Text size="xs" c="dimmed">מייל</Text><Text size="sm" dir="ltr" ta="right">{c.email ?? '—'}</Text></div>
            <div><Text size="xs" c="dimmed">מספר מס</Text><Text size="sm">{c.tax_id ?? '—'}</Text></div>
            <div><Text size="xs" c="dimmed">כתובת</Text><Text size="sm">{c.address ?? '—'}</Text></div>
            <div><Text size="xs" c="dimmed">הגיע דרך</Text><Text size="sm">{c.referred_by?.display_name ?? '—'}</Text></div>
          </SimpleGrid>
          {c.notes && <Text size="sm" mt="md" style={{ whiteSpace: 'pre-wrap' }}>{c.notes}</Text>}
        </Paper>

        <Paper withBorder p="md">
          <Title order={4} mb="sm">נכסים</Title>
          <QueryState q={properties}>{(ps) => ps.length ? (
            <Table.ScrollContainer minWidth={600}>
              <Table verticalSpacing="xs">
                <Table.Thead>
                  <Table.Tr><Table.Th>מדינה</Table.Th><Table.Th>נכס</Table.Th><Table.Th>חלק</Table.Th><Table.Th>סטטוס</Table.Th><Table.Th>שכירות נוכחית</Table.Th></Table.Tr>
                </Table.Thead>
                <Table.Tbody>
                  {ps.map((p) => {
                    const own = p.ownerships.find((o) => o.party.id === c.id);
                    const l = currentLease(p);
                    const past = own && !isCurrentOwnership(own);
                    return (
                      <Table.Tr key={p.id} c={past ? 'dimmed' : undefined}>
                        <Table.Td><CountryBadge code={p.country_code} /></Table.Td>
                        <Table.Td><Anchor component={Link} to={`/properties/${p.id}`} size="sm">{propertyTitle(p)}</Anchor>
                          <Text size="xs" c="dimmed">{p.building.city.name_he}</Text></Table.Td>
                        <Table.Td>{own ? `${Number(own.share_pct)}%` : '—'}{past && <Text size="xs">עד {date(own!.valid_to)}</Text>}</Table.Td>
                        <Table.Td><StatusBadge status={p.status} /></Table.Td>
                        <Table.Td style={{ whiteSpace: 'nowrap' }}>{l ? money(l.rent_amount, l.rent_currency) : '—'}</Table.Td>
                      </Table.Tr>
                    );
                  })}
                </Table.Tbody>
              </Table>
            </Table.ScrollContainer>
          ) : <Text c="dimmed" size="sm">אין נכסים</Text>}</QueryState>
        </Paper>

        <Paper withBorder p="md">
          <Title order={4} mb={4}>חשבונות ויתרות</Title>
          <Text size="xs" c="dimmed" mb="sm">כל מטבע מוצג בנפרד, ורק תנועות שאושרו נספרות. בחשבון הבנק של הלקוח מוצג כמה הופקד אליו לפי הדוחות, ולא היתרה בבנק.</Text>
          <QueryState q={accounts}>{(as) => as.length ? (
            <Table.ScrollContainer minWidth={700}>
              <Table verticalSpacing="xs">
                <Table.Thead>
                  <Table.Tr><Table.Th>מדינה</Table.Th><Table.Th>סוג</Table.Th><Table.Th>מחזיק</Table.Th><Table.Th>בנק</Table.Th><Table.Th>IBAN</Table.Th><Table.Th>סכום</Table.Th></Table.Tr>
                </Table.Thead>
                <Table.Tbody>
                  {as.map((a) => (
                    <Table.Tr key={a.id} c={a.active ? undefined : 'dimmed'}>
                      <Table.Td>{COUNTRY_HE[a.country_code]}</Table.Td>
                      <Table.Td>{ACCOUNT_KIND_HE[a.kind] ?? a.kind}{a.label && <Text size="xs" c="dimmed">{a.label}</Text>}</Table.Td>
                      <Table.Td>{a.holder.display_name}</Table.Td>
                      <Table.Td>{a.bank_name ?? '—'}</Table.Td>
                      <Table.Td dir="ltr" style={{ textAlign: 'right', fontFamily: 'monospace', fontSize: 12 }}>{a.iban ?? (a.card_last4 ? `•••• ${a.card_last4}` : '—')}</Table.Td>
                      <Table.Td style={{ whiteSpace: 'nowrap' }}>
                        <Text size="sm" fw={500}>{money(a.balance, a.currency)}</Text>
                        <Text size="xs" c="dimmed">{amountLabel(a.kind)}</Text>
                      </Table.Td>
                    </Table.Tr>
                  ))}
                </Table.Tbody>
              </Table>
            </Table.ScrollContainer>
          ) : <Text c="dimmed" size="sm">אין חשבונות</Text>}</QueryState>
        </Paper>

        <Paper withBorder p="md">
          <Title order={4} mb="sm">תנועות</Title>
          <QueryState q={accounts}>{(as) => (
            entries.isLoading ? <Text c="dimmed" size="sm">טוען תנועות…</Text>
              : <AccountLedger accounts={as} entries={entries.data ?? []} />
          )}</QueryState>
        </Paper>
      </Stack>
    )}</QueryState>
  );
}
