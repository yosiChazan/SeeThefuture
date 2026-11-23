import { Alert, Anchor, Badge, Button, Group, Paper, Select, SimpleGrid, Stack, Table, Text, Textarea, Title } from '@mantine/core';
import { IconBrandWhatsapp, IconCheck, IconSend } from '@tabler/icons-react';
import { useQuery } from '@tanstack/react-query';
import { useMemo, useState } from 'react';
import { Link } from 'react-router-dom';
import { waLink } from '../components/Phone';
import { must, supabase } from '../lib/supabase';
import type { Country } from '../lib/types';
import { COUNTRY_HE } from '../lib/format';

// A message to every owner in a city (SPEC decision 187, a trial): the text is written once, with
// {שם} and {עיר} filled per client, and each client has a "send" button that opens their chat in
// WhatsApp (the Business app or WhatsApp Web) with the text ready. Sent from the app it is free
// and needs no Meta template; it also reaches the inbox, as every message from the phone does.
// What was sent is remembered in this browser only.

interface Owner { id: string; name: string; first: string | null; phone: string | null; units: string[] }
const SENT_KEY = 'broadcast-sent';

function useCities() {
  return useQuery({
    queryKey: ['cities-list'],
    queryFn: async () => must(await supabase.from('cities').select('id, country_code, name_he').order('name_he')) as { id: string; country_code: Country; name_he: string }[],
  });
}

function useOwners(cityId: string | null) {
  return useQuery({
    queryKey: ['city-owners', cityId], enabled: !!cityId,
    queryFn: async () => {
      const rows = must(await supabase.from('ownerships')
        .select('party:parties!inner(id, display_name, first_name, phone), property:properties!inner(unit_no, building:buildings!inner(name, city_id))')
        .is('valid_to', null).eq('property.building.city_id', cityId!)) as unknown as
        { party: { id: string; display_name: string; first_name: string | null; phone: string | null }; property: { unit_no: string | null; building: { name: string } } }[];
      const m = new Map<string, Owner>();
      for (const r of rows) {
        const o = m.get(r.party.id) ?? m.set(r.party.id, { id: r.party.id, name: r.party.display_name, first: r.party.first_name, phone: r.party.phone, units: [] }).get(r.party.id)!;
        o.units.push(`${r.property.building.name} ${r.property.unit_no ?? ''}`.trim());
      }
      return [...m.values()].sort((a, b) => a.name.localeCompare(b.name, 'he'));
    },
  });
}

const fill = (text: string, o: Owner, city: string) => text.replaceAll('{שם}', o.first || o.name).replaceAll('{עיר}', city);

export function Broadcast() {
  const cities = useCities();
  const [cityId, setCityId] = useState<string | null>(null);
  const owners = useOwners(cityId);
  const [text, setText] = useState('שלום {שם},\n');
  const city = cities.data?.find((c) => c.id === cityId);
  const [sent, setSent] = useState<Record<string, string>>(() => { try { return JSON.parse(localStorage.getItem(SENT_KEY) ?? '{}'); } catch { return {}; } });
  // "Sent" belongs to this text: a new text starts the list again.
  const key = (id: string) => `${cityId}|${id}|${text.length}:${text.slice(0, 40)}`;
  const markSent = (id: string) => setSent((s) => { const n = { ...s, [key(id)]: new Date().toISOString() }; try { localStorage.setItem(SENT_KEY, JSON.stringify(n)); } catch { /* not kept */ } return n; });
  const list = owners.data ?? [];
  const withPhone = useMemo(() => list.filter((o) => waLink(o.phone)), [list]);
  const without = list.filter((o) => !waLink(o.phone));
  const done = withPhone.filter((o) => sent[key(o.id)]).length;

  return (
    <Stack>
      <Group justify="space-between">
        <Title order={2}>הודעה לבעלים בעיר</Title>
        <Badge color="yellow" variant="light">גרסת ניסיון</Badge>
      </Group>
      <Alert color="green" icon={<IconBrandWhatsapp size={18} />}>
        כותבים הודעה אחת, ולכל לקוח יש כפתור "שליחה" שפותח את הצ'אט שלו בוואטסאפ עם ההודעה מוכנה. נשאר רק ללחוץ "שלח". נשלח מהאפליקציה או מ-WhatsApp Web של מספר החברה: חינם, בלי תבנית של Meta, וההודעה נכנסת גם לדף ההודעות.
      </Alert>
      <Paper withBorder p="md">
        <SimpleGrid cols={{ base: 1, sm: 2 }}>
          <Select label="עיר" searchable placeholder="בחירת עיר" value={cityId} onChange={setCityId}
            data={(cities.data ?? []).map((c) => ({ value: c.id, label: `${c.name_he} (${COUNTRY_HE[c.country_code]})` }))} />
          <Text size="sm" c="dimmed" mt={{ sm: 28 }}>{cityId ? (owners.isLoading ? 'טוען…' : `${list.length} בעלים · ${withPhone.length} עם וואטסאפ`) : ''}</Text>
        </SimpleGrid>
        <Textarea mt="sm" label="ההודעה" autosize minRows={5} value={text} onChange={(e) => setText(e.currentTarget.value)}
          description="{שם} יוחלף בשם הפרטי של כל לקוח, {עיר} בשם העיר." />
        {city && withPhone[0] && (
          <Paper mt="sm" p="sm" style={{ background: '#d9fdd3' }}>
            <Text size="xs" c="dimmed" mb={4}>כך זה ייראה אצל {withPhone[0].name}:</Text>
            <Text size="sm" style={{ whiteSpace: 'pre-wrap' }} dir="auto">{fill(text, withPhone[0], city.name_he)}</Text>
          </Paper>
        )}
      </Paper>

      {city && withPhone.length > 0 && (
        <Paper withBorder p="md">
          <Group justify="space-between" mb="xs">
            <Text fw={600}>שליחה ({done} מתוך {withPhone.length} נשלחו)</Text>
          </Group>
          <Table verticalSpacing={4} fz="sm" striped>
            <Table.Tbody>{withPhone.map((o) => {
              const was = sent[key(o.id)];
              const url = `${waLink(o.phone)}?text=${encodeURIComponent(fill(text, o, city.name_he))}`;
              return (
                <Table.Tr key={o.id}>
                  <Table.Td><Anchor component={Link} to={`/clients/${o.id}`} size="sm">{o.name}</Anchor></Table.Td>
                  <Table.Td dir="ltr" style={{ textAlign: 'right' }}>{o.phone}</Table.Td>
                  <Table.Td><Text size="xs" c="dimmed" lineClamp={1}>{o.units.join(', ')}</Text></Table.Td>
                  <Table.Td style={{ whiteSpace: 'nowrap' }}>
                    {was
                      ? <Group gap={4} wrap="nowrap"><Badge color="teal" variant="light" leftSection={<IconCheck size={12} />}>נשלח</Badge>
                          <Button size="compact-xs" variant="subtle" component="a" href={url} target="_blank" rel="noopener noreferrer">שוב</Button></Group>
                      : <Button size="compact-sm" color="green" leftSection={<IconSend size={14} />} component="a" href={url} target="_blank" rel="noopener noreferrer"
                          disabled={!text.trim()} onClick={() => markSent(o.id)}>שליחה</Button>}
                  </Table.Td>
                </Table.Tr>
              );
            })}</Table.Tbody>
          </Table>
        </Paper>
      )}
      {city && without.length > 0 && (
        <Paper withBorder p="md">
          <Text fw={600} mb={4}>בלי טלפון לוואטסאפ ({without.length})</Text>
          <Text size="sm" c="dimmed">{without.map((o, i) => <span key={o.id}>{i ? ', ' : ''}<Anchor component={Link} to={`/clients/${o.id}`} size="sm">{o.name}</Anchor></span>)}</Text>
        </Paper>
      )}
    </Stack>
  );
}
