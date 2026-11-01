import { Anchor, Badge, Group, Paper, Select, Stack, Table, Text, Title } from '@mantine/core';
import { notifications } from '@mantine/notifications';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { useAccess } from '../lib/access';
import { COUNTRY_HE, date } from '../lib/format';
import { must, supabase } from '../lib/supabase';
import type { Country } from '../lib/types';
import { QueryState } from './common';

interface Doc { id: string; country_code: Country; doc_type: string; storage_path: string; sensitive: boolean; file_name: string | null; uploaded_at: string }

// Two groups (SPEC decision 64): passports (and ID cards), and everything else.
const PASSPORT_TYPES = ['passport', 'id_card'];
const isPassport = (d: Doc) => PASSPORT_TYPES.includes(d.doc_type);
const DOC_TYPE_HE: Record<string, string> = {
  id_card: 'תעודת זהות וספח', passport: 'דרכון', poa: 'ייפוי כוח', attachment: 'קובץ מצורף',
};

function DocTable({ docs, canMove, onOpen, onMove }: { docs: Doc[]; canMove: (d: Doc) => boolean; onOpen: (d: Doc) => void; onMove: (d: Doc, toPassport: boolean) => void }) {
  if (!docs.length) return <Text c="dimmed" size="sm">אין</Text>;
  return (
    <Table.ScrollContainer minWidth={560}>
      <Table verticalSpacing="xs">
        <Table.Thead>
          <Table.Tr><Table.Th>קובץ</Table.Th><Table.Th>סוג</Table.Th><Table.Th>מדינה</Table.Th><Table.Th>נוסף</Table.Th><Table.Th>סיווג</Table.Th></Table.Tr>
        </Table.Thead>
        <Table.Tbody>
          {docs.map((d) => (
            <Table.Tr key={d.id}>
              <Table.Td><Anchor size="sm" dir="ltr" onClick={() => onOpen(d)}>{d.file_name ?? d.storage_path.split('/').pop()}</Anchor></Table.Td>
              <Table.Td><Text size="sm">{DOC_TYPE_HE[d.doc_type] ?? d.doc_type}</Text></Table.Td>
              <Table.Td>{COUNTRY_HE[d.country_code]}</Table.Td>
              <Table.Td>{date(d.uploaded_at.slice(0, 10))}</Table.Td>
              <Table.Td w={150}>
                {canMove(d) ? (
                  <Select size="xs" allowDeselect={false} value={isPassport(d) ? 'passport' : 'other'}
                    data={[{ value: 'passport', label: 'דרכונים' }, { value: 'other', label: 'מסמכים נוספים' }]}
                    onChange={(v) => v && (v === 'passport') !== isPassport(d) && onMove(d, v === 'passport')} />
                ) : <Text size="xs" c="dimmed">{isPassport(d) ? 'דרכונים' : 'מסמכים נוספים'}</Text>}
              </Table.Td>
            </Table.Tr>
          ))}
        </Table.Tbody>
      </Table>
    </Table.ScrollContainer>
  );
}

// A person's documents. Row-level security shows sensitive ones only to staff with the
// country's sensitive-documents flag; every opening is logged.
export function ClientDocuments({ partyId }: { partyId: string }) {
  const access = useAccess();
  const qc = useQueryClient();
  const docs = useQuery({
    queryKey: ['documents', partyId],
    queryFn: async () => must(await supabase.from('documents')
      .select('id, country_code, doc_type, storage_path, sensitive, file_name, uploaded_at')
      .eq('entity_type', 'party').eq('entity_id', partyId).order('uploaded_at').order('file_name')) as Doc[],
  });

  async function open(d: Doc) {
    const log = await supabase.rpc('log_document_access', { doc: d.id });
    if (log.error) { notifications.show({ color: 'red', message: log.error.message }); return; }
    const { data, error } = await supabase.storage.from('documents').createSignedUrl(d.storage_path, 60);
    if (error) notifications.show({ color: 'red', message: error.message }); else window.open(data.signedUrl, '_blank');
  }

  // Moving to "other" files a passport as an attachment; a power of attorney stays one.
  async function move(d: Doc, toPassport: boolean) {
    const { error } = await supabase.from('documents').update({ doc_type: toPassport ? 'passport' : 'attachment' }).eq('id', d.id);
    if (error) notifications.show({ color: 'red', message: error.message });
    await qc.invalidateQueries({ queryKey: ['documents', partyId] });
  }

  return (
    <Paper withBorder p="md">
      <Title order={4} mb={4}>מסמכים</Title>
      <Text size="xs" c="dimmed" mb="sm">מסמכים רגישים מוצגים רק למי שיש לו הרשאה למסמכים רגישים במדינה. כל פתיחה נרשמת.</Text>
      <QueryState q={docs}>{(ds) => ds.length ? (
        <Stack>
          {([['דרכונים', ds.filter(isPassport)], ['מסמכים נוספים', ds.filter((d) => !isPassport(d))]] as const).map(([title, list]) => (
            <div key={title}>
              <Group gap="xs" mb={4}><Text fw={600} size="sm">{title}</Text><Badge size="sm" variant="light">{list.length}</Badge></Group>
              <DocTable docs={list} canMove={(d) => access.canEdit(d.country_code)} onOpen={open} onMove={move} />
            </div>
          ))}
        </Stack>
      ) : <Text c="dimmed" size="sm">אין מסמכים שאפשר להציג</Text>}</QueryState>
    </Paper>
  );
}
