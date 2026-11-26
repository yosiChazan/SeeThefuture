import { Alert, Anchor, Button, Code, CopyButton, Group, Stack, Table, Text, Title } from '@mantine/core';
import { notifications } from '@mantine/notifications';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { useState } from 'react';
import { must, supabase } from '../lib/supabase';

// The key of the WhatsApp Web extension that reads the groups (SPEC decision 212): made here by the
// admin, shown once, kept only as a hash; a key can be revoked.
interface Key { id: string; label: string; created_at: string; last_used_at: string | null; revoked_at: string | null }
const hex = (b: ArrayBuffer | Uint8Array) => [...new Uint8Array(b)].map((x) => x.toString(16).padStart(2, '0')).join('');

export function WaGroupsKey() {
  const qc = useQueryClient();
  const keys = useQuery({ queryKey: ['ext-tokens'], queryFn: async () => must(await supabase.from('ext_tokens').select('id, label, created_at, last_used_at, revoked_at').order('created_at', { ascending: false })) as Key[] });
  const [fresh, setFresh] = useState<string | null>(null);
  async function make() {
    const key = `stfwa_${hex(crypto.getRandomValues(new Uint8Array(24)))}`;
    const hash = hex(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(key)));
    const r = await supabase.from('ext_tokens').insert({ token_hash: hash, label: `תוסף קבוצות ${new Date().toLocaleDateString('he-IL')}` });
    if (r.error) { notifications.show({ color: 'red', message: r.error.message }); return; }
    setFresh(key);
    await qc.invalidateQueries({ queryKey: ['ext-tokens'] });
  }
  async function revoke(k: Key) {
    const r = await supabase.from('ext_tokens').update({ revoked_at: new Date().toISOString() }).eq('id', k.id);
    if (r.error) notifications.show({ color: 'red', message: r.error.message });
    await qc.invalidateQueries({ queryKey: ['ext-tokens'] });
  }
  const when = (s: string | null) => (s ? new Date(s).toLocaleString('he-IL') : '—');
  return (
    <Stack gap="xs" mt="md">
      <Title order={5}>תוסף לקריאת קבוצות (WhatsApp Web)</Title>
      <Text size="sm" c="dimmed">תוסף ל-Chrome שקורא את הקבוצות שמוצגות ב-WhatsApp Web ושולח אותן למערכת, לקריאה בלבד. הוא לא לוחץ ולא כותב.
        {' '}<Anchor href="/wa-groups-extension.zip" download>הורדת התוסף</Anchor> · התקנה: chrome://extensions ← מצב מפתח ← "טעינת תוסף לא ארוז" (אחרי חילוץ ה-ZIP).</Text>
      {fresh && (
        <Alert color="green" title="המפתח (מוצג פעם אחת)">
          <Group gap="xs" wrap="nowrap"><Code style={{ wordBreak: 'break-all' }}>{fresh}</Code>
            <CopyButton value={fresh}>{({ copied, copy }) => <Button size="compact-xs" onClick={copy}>{copied ? 'הועתק' : 'העתקה'}</Button>}</CopyButton></Group>
          <Text size="xs" mt={4}>מדביקים אותו בתוסף (לחיצה על סמל התוסף). אחרי שהחלון ייסגר אי אפשר לראות אותו שוב.</Text>
        </Alert>
      )}
      <Group><Button size="xs" variant="light" onClick={make}>יצירת מפתח לתוסף</Button></Group>
      {!!keys.data?.length && (
        <Table fz="xs" verticalSpacing={2}>
          <Table.Tbody>{keys.data.map((k) => (
            <Table.Tr key={k.id} opacity={k.revoked_at ? 0.5 : 1}>
              <Table.Td>{k.label}</Table.Td><Table.Td>נוצר {when(k.created_at)}</Table.Td><Table.Td>שימוש אחרון {when(k.last_used_at)}</Table.Td>
              <Table.Td>{k.revoked_at ? 'בוטל' : <Button size="compact-xs" variant="subtle" color="red" onClick={() => revoke(k)}>ביטול</Button>}</Table.Td>
            </Table.Tr>
          ))}</Table.Tbody>
        </Table>
      )}
    </Stack>
  );
}
