import { Anchor, Badge, Button, Group, Modal, Paper, Stack, Table, Text, Textarea, Title } from '@mantine/core';
import { notifications } from '@mantine/notifications';
import { IconCheck } from '@tabler/icons-react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { useState } from 'react';
import { Link } from 'react-router-dom';
import { date, money } from '../lib/format';
import { must, supabase } from '../lib/supabase';
import type { Currency } from '../lib/types';

// Transfers to owners waiting for someone to confirm they arrived (SPEC decision 209).

export interface OwnerTransfer {
  transaction_id: string; occurred_on: string; description: string | null; country_code: string; amount: number; currency: Currency;
  owner_id: string; owner_name: string; confirmed_at: string | null;
}

export function useOwnerTransfers(pendingOnly = true) {
  return useQuery({
    queryKey: ['owner-transfers', pendingOnly],
    queryFn: async () => {
      let q = supabase.from('owner_transfers').select('transaction_id, occurred_on, description, country_code, amount, currency, owner_id, owner_name, confirmed_at').order('occurred_on');
      if (pendingOnly) q = q.is('confirmed_at', null);
      return must(await q) as OwnerTransfer[];
    },
  });
}

export function TransferConfirmations() {
  const qc = useQueryClient();
  const list = useOwnerTransfers();
  const [confirming, setConfirming] = useState<OwnerTransfer | null>(null);
  const [note, setNote] = useState('');
  const [busy, setBusy] = useState(false);
  async function confirm() {
    setBusy(true);
    const { data: u } = await supabase.auth.getUser();
    const r = await supabase.from('transfer_confirmations').insert({ transaction_id: confirming!.transaction_id, confirmed_by: u.user?.id, note: note.trim() || null });
    setBusy(false);
    if (r.error) { notifications.show({ color: 'red', message: r.error.message }); return; }
    notifications.show({ color: 'teal', message: 'סומן שההעברה הגיעה לבעלים' });
    setConfirming(null); setNote('');
    await qc.invalidateQueries({ queryKey: ['owner-transfers'] });
  }
  const rows = list.data ?? [];
  if (!rows.length) return null;
  return (
    <Paper withBorder p="md" style={{ borderColor: 'var(--mantine-color-orange-4)' }}>
      <Group justify="space-between" mb="sm">
        <Title order={4}>העברות לבעלים שממתינות לאימות</Title>
        <Badge color="orange">{rows.length}</Badge>
      </Group>
      <Text size="xs" c="dimmed" mb="xs">כל העברה לבעלים נשארת כאן עד שמישהו בודק שהכסף הגיע אליהם.</Text>
      <Table.ScrollContainer minWidth={640}>
        <Table verticalSpacing={6} fz="sm">
          <Table.Thead><Table.Tr><Table.Th>תאריך</Table.Th><Table.Th>בעלים</Table.Th><Table.Th>סכום</Table.Th><Table.Th>פירוט</Table.Th><Table.Th /></Table.Tr></Table.Thead>
          <Table.Tbody>
            {rows.map((t) => (
              <Table.Tr key={`${t.transaction_id}:${t.owner_id}`}>
                <Table.Td style={{ whiteSpace: 'nowrap' }}>{date(t.occurred_on)}</Table.Td>
                <Table.Td><Anchor component={Link} to={`/clients/${t.owner_id}`} size="sm">{t.owner_name}</Anchor></Table.Td>
                <Table.Td style={{ whiteSpace: 'nowrap' }}>{money(Number(t.amount), t.currency)}</Table.Td>
                <Table.Td><Text size="xs" lineClamp={2}>{t.description}</Text></Table.Td>
                <Table.Td><Button size="compact-xs" color="teal" variant="light" leftSection={<IconCheck size={12} />} onClick={() => setConfirming(t)}>הגיע לבעלים</Button></Table.Td>
              </Table.Tr>
            ))}
          </Table.Tbody>
        </Table>
      </Table.ScrollContainer>
      {confirming && (
        <Modal opened onClose={() => setConfirming(null)} title="אימות שההעברה הגיעה">
          <Stack>
            <Text size="sm">{confirming.owner_name} · {money(Number(confirming.amount), confirming.currency)} · {date(confirming.occurred_on)}</Text>
            <Textarea label="איך זה אומת (לא חובה)" placeholder="למשל: הבעלים אישר בוואטסאפ, רואים בדף הבנק" value={note} onChange={(e) => setNote(e.currentTarget.value)} autosize minRows={2} />
            <Group justify="flex-end">
              <Button variant="default" onClick={() => setConfirming(null)}>ביטול</Button>
              <Button color="teal" loading={busy} onClick={confirm}>אישור שהגיע</Button>
            </Group>
          </Stack>
        </Modal>
      )}
    </Paper>
  );
}
