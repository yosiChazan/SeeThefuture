import { Anchor, Breadcrumbs, Button, Group, Paper, SimpleGrid, Stack, Text, Title } from '@mantine/core';
import { IconPencil, IconTrash } from '@tabler/icons-react';
import { useState } from 'react';
import { Link, useNavigate, useParams } from 'react-router-dom';
import { CountryBadge, QueryState } from '../components/common';
import { DeleteRecord } from '../components/DeleteRecord';
import { EntityDocuments, type DocType } from '../components/EntityDocuments';
import { LeaseForm } from '../components/LeaseForm';
import { LeaseState } from '../components/LeaseTable';
import { useAccess } from '../lib/access';
import { COUNTRY_HE, date, money, propertyTitle, today } from '../lib/format';
import { useLease } from '../lib/queries';

// Kinds of lease documents (SPEC decision 68).
const LEASE_DOC_TYPES: DocType[] = [
  { value: 'lease_contract', label: 'חוזה חתום' }, { value: 'lease_appendix', label: 'נספח / הארכה' },
  { value: 'tenant_id', label: 'מסמך זיהוי של השוכר' }, { value: 'handover', label: 'פרוטוקול מסירה' },
  { value: 'receipt', label: 'קבלה / אישור תשלום' }, { value: 'attachment', label: 'מסמך אחר' },
];

function Field({ label, children }: { label: string; children: React.ReactNode }) {
  return <div><Text size="xs" c="dimmed">{label}</Text><Text size="sm" component="div">{children || '—'}</Text></div>;
}

export function LeaseCard() {
  const { id } = useParams();
  const q = useLease(id!);
  const access = useAccess();
  const navigate = useNavigate();
  const [editing, setEditing] = useState(false);
  const [deleting, setDeleting] = useState(false);
  return (
    <QueryState q={q}>{(l) => {
      const p = l.property;
      const title = `חוזה ${l.tenant?.display_name ?? 'ללא שוכר'} · ${propertyTitle(p)}`;
      const owners = p.ownerships.filter((o) => !o.valid_to || o.valid_to >= today());
      return (
        <Stack>
          <Breadcrumbs>
            <Anchor component={Link} to="/leases" size="sm">חוזי שכירות</Anchor>
            <Text size="sm">{title}</Text>
          </Breadcrumbs>
          <Group justify="space-between">
            <Stack gap={2}>
              <Title order={2}>{l.tenant?.display_name ?? 'חוזה ללא שוכר'}</Title>
              <Group gap="xs"><CountryBadge code={p.country_code} /><LeaseState lease={l} /></Group>
            </Stack>
            <Group gap="xs">
              {access.isAdmin && <Button variant="subtle" color="red" leftSection={<IconTrash size={16} />} onClick={() => setDeleting(true)}>מחיקת חוזה</Button>}
              {access.canEdit(p.country_code) && <Button variant="default" leftSection={<IconPencil size={16} />} onClick={() => setEditing(true)}>עריכה</Button>}
            </Group>
          </Group>
          {editing && <LeaseForm lease={l} opened onClose={() => setEditing(false)} />}
          {deleting && <DeleteRecord kind="lease" id={l.id} name={title} onClose={() => setDeleting(false)} onDeleted={() => navigate('/leases', { replace: true })} />}

          <Paper withBorder p="md">
            <SimpleGrid cols={{ base: 2, sm: 4 }}>
              <Field label="נכס"><Anchor component={Link} to={`/properties/${p.id}`} size="sm">{propertyTitle(p)}</Anchor></Field>
              <Field label="עיר">{p.building.city.name_he}, {COUNTRY_HE[p.country_code]}</Field>
              <Field label="כתובת">{p.building.address}</Field>
              <Field label="בעלים">{owners.map((o, i) => (
                <span key={o.party.id}>{i > 0 && ', '}<Anchor component={Link} to={`/clients/${o.party.id}`} size="sm">{o.party.display_name}</Anchor></span>
              ))}</Field>
              <Field label="שוכר">{l.tenant?.display_name}</Field>
              <Field label="תאריך התחלה">{date(l.start_date)}</Field>
              <Field label="תאריך סיום">{date(l.end_date)}</Field>
              <Field label="שכירות חודשית">{money(l.rent_amount, l.rent_currency)}</Field>
              <Field label="פיקדון">{money(l.deposit_amount, l.deposit_currency)}</Field>
              <Field label="יום גבייה בחודש">{l.collect_day}</Field>
              <Field label="ניכוי מס במקור">{l.withholding_tax_pct ? `${Number(l.withholding_tax_pct)}%` : null}</Field>
              <Field label="דמי תיווך">{money(l.brokerage_fee, l.brokerage_currency)}</Field>
            </SimpleGrid>
            {l.notes && <Text size="sm" mt="md" style={{ whiteSpace: 'pre-wrap' }}>{l.notes}</Text>}
          </Paper>

          <EntityDocuments entityType="lease" entityId={l.id} country={p.country_code} types={LEASE_DOC_TYPES} title="מסמכי החוזה" />
        </Stack>
      );
    }}</QueryState>
  );
}
