import { Anchor, Badge, Breadcrumbs, Button, Group, Paper, SimpleGrid, Stack, Table, Text, Title } from '@mantine/core';
import { IconAddressBook, IconPencil, IconPlus, IconTrash, IconUserCheck } from '@tabler/icons-react';
import { notifications } from '@mantine/notifications';
import { useQueryClient } from '@tanstack/react-query';
import { MemberOf, Partners } from '../components/Partners';
import { Activities, CompanyPartners, ContactAssignments, PartnerIn } from '../components/CardExtras';
import { useState } from 'react';
import { Link, useNavigate, useParams } from 'react-router-dom';
import { DeleteRecord } from '../components/DeleteRecord';
import { ClientDocuments } from '../components/ClientDocuments';
import { ClientPropertyActivity } from '../components/ClientPropertyActivity';
import { ClientForm } from '../components/ClientForm';
import { PropertyForm } from '../components/PropertyForm';
import { LeaseTable } from '../components/LeaseTable';
import { useAccess } from '../lib/access';
import { CountryBadge, QueryState, StatusBadge } from '../components/common';
import { EditableLedger } from '../components/PropertyEntries';
import { ACCOUNT_KIND_HE, COUNTRY_HE, amountLabel, currentLease, date, isCurrentOwnership, money, propertyTitle } from '../lib/format';
import { setClientRole, useAccountEntries, useClient, useClientAccounts, useClientProperties, useIdentity, usePartyLinks } from '../lib/queries';
import { validIsraeliId } from '../lib/idnumber';
import { Phone } from '../components/Phone';

export function ClientCard() {
  const { id } = useParams();
  const client = useClient(id!);
  // A client and the partners linked to it are one client (SPEC decision 77).
  const links = usePartyLinks();
  const members = (links.data ?? []).filter((l) => l.main_party_id === id);
  const memberOf = (links.data ?? []).find((l) => l.member_party_id === id);
  const household = [id!, ...members.map((m) => m.member_party_id)];
  const properties = useClientProperties(household);
  const accounts = useClientAccounts(household);
  const qc = useQueryClient();
  const entries = useAccountEntries((accounts.data ?? []).map((a) => a.id));
  const access = useAccess();
  // Any editor may change a client's details (the parties table is not per country).
  const canEdit = access.isAdmin || access.countries.some((x) => access.canEdit(x));
  const [editing, setEditing] = useState(false);
  const [deleting, setDeleting] = useState(false);
  const navigate = useNavigate();
  const identity = useIdentity(id!);
  const [addingProperty, setAddingProperty] = useState(false);
  const canAddProperty = access.countries.some((x) => access.canEdit(x));

  // Clients and contacts are listed apart (SPEC decision 76); the card is the same.
  async function moveTo(asClient: boolean) {
    try {
      await setClientRole(id!, asClient);
      notifications.show({ color: 'teal', message: asClient ? 'הועבר ללקוחות' : 'הועבר לאנשי הקשר' });
      await qc.invalidateQueries();
      navigate(asClient ? `/clients/${id}` : `/contacts/${id}`, { replace: true });
    } catch (e) { notifications.show({ color: 'red', message: (e as Error).message }); }
  }

  return (
    <QueryState q={client}>{(c) => {
      const isClient = !!c.party_roles?.some((r) => r.role === 'client');
      return (
      <Stack>
        <Breadcrumbs>
          {isClient ? <Anchor component={Link} to="/clients" size="sm">לקוחות</Anchor> : <Anchor component={Link} to="/contacts" size="sm">אנשי קשר</Anchor>}
          <Text size="sm">{c.display_name}</Text>
        </Breadcrumbs>
        <Group justify="space-between">
          <Group gap="xs">
            <Title order={2}>{c.display_name}</Title>
            {c.kind === 'company' && <Badge variant="light">חברה</Badge>}
          </Group>
          <Group gap="xs">
            {access.isAdmin && <Button variant="subtle" color="red" leftSection={<IconTrash size={16} />} onClick={() => setDeleting(true)}>מחיקה</Button>}
            {canEdit && (isClient
              ? <Button variant="subtle" leftSection={<IconAddressBook size={16} />} onClick={() => moveTo(false)}>הגדרה כאיש קשר</Button>
              : <Button variant="subtle" leftSection={<IconUserCheck size={16} />} onClick={() => moveTo(true)}>הגדרה כלקוח</Button>)}
            {canEdit && <Button variant="default" leftSection={<IconPencil size={16} />} onClick={() => setEditing(true)}>עריכה</Button>}
          </Group>
        </Group>
        {isClient && <PartnerIn partyId={c.id} />}
        {memberOf && <MemberOf link={memberOf} canEdit={canEdit} />}
        {deleting && <DeleteRecord kind="client" id={c.id} name={c.display_name} onClose={() => setDeleting(false)} onDeleted={() => navigate('/clients', { replace: true })} />}
        {editing && <ClientForm client={c} idNumber={identity.data?.id_number ?? null} opened onClose={() => setEditing(false)} />}

        <Paper withBorder p="md">
          <SimpleGrid cols={{ base: 1, sm: 3 }}>
            <div><Text size="xs" c="dimmed">שם בדוחות</Text><Text size="sm" dir="ltr" ta="right">{c.legal_name ?? '—'}</Text></div>
            <div><Text size="xs" c="dimmed">טלפון</Text><Phone phone={c.phone} /></div>
            <div><Text size="xs" c="dimmed">מייל</Text><Text size="sm" dir="ltr" ta="right">{c.email ?? '—'}</Text></div>
            {(c.first_name || c.last_name) && (
              <>
                <div><Text size="xs" c="dimmed">שם פרטי</Text><Text size="sm">{c.first_name ?? '—'}</Text></div>
                <div><Text size="xs" c="dimmed">שם משפחה</Text><Text size="sm">{c.last_name ?? '—'}</Text></div>
              </>
            )}
            {(
              <div><Text size="xs" c="dimmed">תעודת זהות</Text>
                <Group gap={6}>
                  <Text size="sm" dir="ltr">{identity.data?.id_number ?? '—'}</Text>
                  {identity.data && !validIsraeliId(identity.data.id_number) && <Badge size="xs" color="orange" variant="light">לא מספר ישראלי תקין</Badge>}
                  {identity.data?.source?.startsWith('ocr:') && <Badge size="xs" variant="light" color="gray">זוהה ממסמך</Badge>}
                </Group>
              </div>
            )}
            <div><Text size="xs" c="dimmed">מספר מס</Text><Text size="sm">{c.tax_id ?? '—'}</Text></div>
            <div><Text size="xs" c="dimmed">כתובת</Text><Text size="sm">{c.address ?? '—'}</Text></div>
            <div><Text size="xs" c="dimmed">הגיע דרך</Text><Text size="sm">{c.referred_by?.display_name ?? '—'}</Text></div>
          </SimpleGrid>
          {c.notes && <Text size="sm" mt="md" style={{ whiteSpace: 'pre-wrap' }}>{c.notes}</Text>}
        </Paper>

        {/* A contact is responsible for places, it does not own them (SPEC decision 79). */}
        {!isClient && <ContactAssignments partyId={c.id} />}
        <Activities entityType="party" entityId={c.id} />
        {!isClient && <ClientDocuments partyId={c.id} countries={[]} />}

        {isClient && c.kind === 'company' && <CompanyPartners companyId={c.id} />}
        {isClient && !memberOf && c.kind === 'person' && <Partners mainId={c.id} members={members} canEdit={canEdit} />}

        {isClient && <>
        <Paper withBorder p="md">
          <Group justify="space-between" mb="sm">
            <Title order={4}>נכסים</Title>
            {canAddProperty && <Button size="xs" variant="light" leftSection={<IconPlus size={14} />} onClick={() => setAddingProperty(true)}>נכס חדש</Button>}
          </Group>
          {addingProperty && <PropertyForm ownerId={c.id} onClose={() => setAddingProperty(false)} />}
          <QueryState q={properties}>{(ps) => ps.length ? (
            <Table.ScrollContainer minWidth={600}>
              <Table verticalSpacing="xs">
                <Table.Thead>
                  <Table.Tr><Table.Th>מדינה</Table.Th><Table.Th>נכס</Table.Th><Table.Th>חלק</Table.Th><Table.Th>סטטוס</Table.Th><Table.Th>שכירות נוכחית</Table.Th></Table.Tr>
                </Table.Thead>
                <Table.Tbody>
                  {ps.map((p) => {
                    const own = p.ownerships.find((o) => household.includes(o.party.id));
                    const l = currentLease(p);
                    const past = own && !isCurrentOwnership(own);
                    return (
                      <Table.Tr key={p.id} c={past ? 'dimmed' : undefined}>
                        <Table.Td><CountryBadge code={p.country_code} /></Table.Td>
                        <Table.Td><Anchor component={Link} to={`/properties/${p.id}`} size="sm">{propertyTitle(p)}</Anchor>
                          <Text size="xs" c="dimmed">{p.building.city.name_he}</Text></Table.Td>
                        <Table.Td>{own ? `${Number(own.share_pct)}%` : '—'}{past && <Text size="xs">עד {date(own!.valid_to)}</Text>}
                          {members.length > 0 && own && <Text size="xs" c="dimmed">{own.party.display_name}</Text>}</Table.Td>
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

        {/* The leases of the client's properties (of a company: all its contracts, decision 81). */}
        {properties.data && properties.data.some((p) => p.leases.length) && (
          <Paper withBorder p="md">
            <Title order={4} mb="sm">חוזי שכירות</Title>
            <LeaseTable showProperty leases={properties.data.flatMap((p) => p.leases.map((l) => ({ ...l, property: { id: p.id, unit_no: p.unit_no, country_code: p.country_code, status: p.status, building: p.building } })))
              .sort((a, b) => (b.start_date ?? '').localeCompare(a.start_date ?? ''))} />
          </Paper>
        )}

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

        {properties.data && <ClientPropertyActivity partyIds={household} properties={properties.data} />}

        <ClientDocuments partyId={c.id} countries={[...new Set((properties.data ?? []).map((p) => p.country_code))]} />

        <Paper withBorder p="md">
          <Title order={4} mb="sm">תנועות</Title>
          <QueryState q={accounts}>{(as) => (
            entries.isLoading ? <Text c="dimmed" size="sm">טוען תנועות…</Text>
              : <EditableLedger accounts={as} entries={entries.data ?? []} />
          )}</QueryState>
        </Paper>
        </>}
      </Stack>
      );
    }}</QueryState>
  );
}
