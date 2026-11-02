import { ActionIcon, Alert, Anchor, Badge, Button, Group, Modal, Paper, Select, Stack, Table, Text, Title, Tooltip } from '@mantine/core';
import { notifications } from '@mantine/notifications';
import { IconLinkOff, IconUserPlus } from '@tabler/icons-react';
import { useQueryClient } from '@tanstack/react-query';
import { useState } from 'react';
import { Link } from 'react-router-dom';
import { must, supabase } from '../lib/supabase';
import { idNumberOf, RELATION_HE, useClients, type PartyLink } from '../lib/queries';

export async function linkPartners(mainId: string, memberId: string, relation: PartyLink['relation']) {
  must(await supabase.from('party_links').insert({ main_party_id: mainId, member_party_id: memberId, relation }));
}

// Choose who joins this client as a spouse, partner or authorized person (SPEC decision 77).
export function AddPartner({ mainId, exclude, onClose, initial }: { mainId: string; exclude: string[]; onClose: () => void; initial?: string }) {
  const clients = useClients();
  const qc = useQueryClient();
  const [member, setMember] = useState<string | null>(initial ?? null);
  const [relation, setRelation] = useState<PartyLink['relation']>('spouse');
  const [busy, setBusy] = useState(false);
  async function save() {
    if (!member) return;
    setBusy(true);
    try { await linkPartners(mainId, member, relation); notifications.show({ color: 'teal', message: 'הקישור נשמר' }); await qc.invalidateQueries(); onClose(); }
    catch (e) { notifications.show({ color: 'red', message: (e as Error).message }); setBusy(false); }
  }
  const options = (clients.data ?? []).filter((c) => !exclude.includes(c.id))
    .map((c) => ({ value: c.id, label: `${c.display_name}${idNumberOf(c) ? ` · ${idNumberOf(c)}` : ''}` })).sort((a, b) => a.label.localeCompare(b.label, 'he'));
  return (
    <Modal opened onClose={onClose} title="הוספת בן/בת זוג, שותף או מורשה">
      <Stack>
        <Text size="sm" c="dimmed">שניהם ייחשבו לקוח אחד: הכרטיס הזה יציג גם את הנכסים והחשבונות של מי שמצטרף, והוא לא יופיע בנפרד ברשימת הלקוחות. שום דבר לא עובר ולא נמחק, ואפשר להפריד בכל רגע.</Text>
        <Select label="מי מצטרף" searchable data={options} value={member} onChange={setMember} nothingFoundMessage="לא נמצא" />
        <Select label="קשר" allowDeselect={false} value={relation} onChange={(v) => v && setRelation(v as PartyLink['relation'])}
          data={Object.entries(RELATION_HE).map(([value, label]) => ({ value, label }))} />
        <Group justify="flex-end"><Button variant="default" onClick={onClose}>ביטול</Button><Button onClick={save} loading={busy} disabled={!member}>שמירה</Button></Group>
      </Stack>
    </Modal>
  );
}

export async function unlinkPartner(memberId: string) {
  must(await supabase.from('party_links').delete().eq('member_party_id', memberId));
}

// The client's partners, inside the main client's card.
export function Partners({ mainId, members, canEdit }: { mainId: string; members: PartyLink[]; canEdit: boolean }) {
  const qc = useQueryClient();
  const [adding, setAdding] = useState(false);
  async function unlink(m: PartyLink) {
    try { await unlinkPartner(m.member_party_id); notifications.show({ color: 'teal', message: `${m.member.display_name} הופרד/ה` }); await qc.invalidateQueries(); }
    catch (e) { notifications.show({ color: 'red', message: (e as Error).message }); }
  }
  if (!members.length && !canEdit) return null;
  return (
    <Paper withBorder p="md">
      <Group justify="space-between" mb={members.length ? 'sm' : 0}>
        <Title order={4}>בני זוג, שותפים ומורשים</Title>
        {canEdit && <Button size="xs" variant="light" leftSection={<IconUserPlus size={14} />} onClick={() => setAdding(true)}>הוספה</Button>}
      </Group>
      {members.length > 0 && (
        <Table verticalSpacing={4}>
          <Table.Tbody>
            {members.map((m) => (
              <Table.Tr key={m.member_party_id}>
                <Table.Td><Anchor component={Link} to={`/clients/${m.member.id}`} size="sm">{m.member.display_name}</Anchor></Table.Td>
                <Table.Td><Badge size="sm" variant="light">{RELATION_HE[m.relation]}</Badge></Table.Td>
                <Table.Td dir="ltr" style={{ textAlign: 'right' }}>{m.member.phone ?? ''}</Table.Td>
                <Table.Td dir="ltr" style={{ textAlign: 'right' }}>{m.member.email ?? ''}</Table.Td>
                <Table.Td w={40}>{canEdit && <Tooltip label="הפרדה"><ActionIcon variant="subtle" color="red" onClick={() => unlink(m)} aria-label="הפרדה"><IconLinkOff size={16} /></ActionIcon></Tooltip>}</Table.Td>
              </Table.Tr>
            ))}
          </Table.Tbody>
        </Table>
      )}
      {members.length > 0 && <Text size="xs" c="dimmed" mt="xs">הנכסים, החשבונות והחיובים שלהם מוצגים גם בכרטיס הזה.</Text>}
      {adding && <AddPartner mainId={mainId} exclude={[mainId, ...members.map((m) => m.member_party_id)]} onClose={() => setAdding(false)} />}
    </Paper>
  );
}

// On a member's own card: whose client they are part of.
export function MemberOf({ link, canEdit }: { link: PartyLink; canEdit: boolean }) {
  const qc = useQueryClient();
  return (
    <Alert color="blue" title={`${RELATION_HE[link.relation]} של ${link.main.display_name}`}>
      <Group justify="space-between">
        <Text size="sm">הלקוח הוא <Anchor component={Link} to={`/clients/${link.main.id}`}>{link.main.display_name}</Anchor>. הנכסים והחשבונות של הכרטיס הזה מוצגים גם שם.</Text>
        {canEdit && <Button size="xs" variant="default" leftSection={<IconLinkOff size={14} />}
          onClick={async () => { await unlinkPartner(link.member_party_id); await qc.invalidateQueries(); }}>הפרדה ללקוח נפרד</Button>}
      </Group>
    </Alert>
  );
}
