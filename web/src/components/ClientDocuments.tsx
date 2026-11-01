import { Anchor, Badge, Paper, Table, Text, Title } from '@mantine/core';
import { notifications } from '@mantine/notifications';
import { useQuery } from '@tanstack/react-query';
import { COUNTRY_HE, date } from '../lib/format';
import { must, supabase } from '../lib/supabase';
import type { Country } from '../lib/types';
import { QueryState } from './common';

interface Doc { id: string; country_code: Country; doc_type: string; storage_path: string; sensitive: boolean; file_name: string | null; uploaded_at: string }

const DOC_TYPE_HE: Record<string, string> = {
  id_card: 'תעודת זהות וספח', passport: 'דרכון', poa: 'ייפוי כוח', attachment: 'קובץ מצורף',
};

// A person's documents (SPEC decision 64). Row-level security shows sensitive ones only
// to staff with the country's sensitive-documents flag; every opening is logged.
export function ClientDocuments({ partyId }: { partyId: string }) {
  const docs = useQuery({
    queryKey: ['documents', partyId],
    queryFn: async () => must(await supabase.from('documents')
      .select('id, country_code, doc_type, storage_path, sensitive, file_name, uploaded_at')
      .eq('entity_type', 'party').eq('entity_id', partyId).order('doc_type').order('uploaded_at')) as Doc[],
  });

  async function open(d: Doc) {
    const log = await supabase.rpc('log_document_access', { doc: d.id });
    if (log.error) { notifications.show({ color: 'red', message: log.error.message }); return; }
    const { data, error } = await supabase.storage.from('documents').createSignedUrl(d.storage_path, 60);
    if (error) notifications.show({ color: 'red', message: error.message }); else window.open(data.signedUrl, '_blank');
  }

  return (
    <Paper withBorder p="md">
      <Title order={4} mb={4}>מסמכים</Title>
      <Text size="xs" c="dimmed" mb="sm">מסמכים רגישים מוצגים רק למי שיש לו הרשאה למסמכים רגישים במדינה. כל פתיחה נרשמת.</Text>
      <QueryState q={docs}>{(ds) => ds.length ? (
        <Table.ScrollContainer minWidth={500}>
          <Table verticalSpacing="xs">
            <Table.Thead>
              <Table.Tr><Table.Th>סוג</Table.Th><Table.Th>קובץ</Table.Th><Table.Th>מדינה</Table.Th><Table.Th>נוסף</Table.Th></Table.Tr>
            </Table.Thead>
            <Table.Tbody>
              {ds.map((d) => (
                <Table.Tr key={d.id}>
                  <Table.Td>{DOC_TYPE_HE[d.doc_type] ?? d.doc_type}{d.sensitive && <Badge size="xs" ml={6} variant="light" color="red">רגיש</Badge>}</Table.Td>
                  <Table.Td><Anchor size="sm" dir="ltr" onClick={() => open(d)}>{d.file_name ?? d.storage_path.split('/').pop()}</Anchor></Table.Td>
                  <Table.Td>{COUNTRY_HE[d.country_code]}</Table.Td>
                  <Table.Td>{date(d.uploaded_at.slice(0, 10))}</Table.Td>
                </Table.Tr>
              ))}
            </Table.Tbody>
          </Table>
        </Table.ScrollContainer>
      ) : <Text c="dimmed" size="sm">אין מסמכים שאפשר להציג</Text>}</QueryState>
    </Paper>
  );
}
