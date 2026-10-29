import { Button, Group, Modal, NumberInput, Select, SimpleGrid, Textarea } from '@mantine/core';
import { DateInput } from '@mantine/dates';
import { notifications } from '@mantine/notifications';
import { useQueryClient } from '@tanstack/react-query';
import dayjs from 'dayjs';
import { useState } from 'react';
import { CURRENCIES, CURRENCY_SIGN } from '../lib/format';
import { supabase } from '../lib/supabase';
import type { Currency, Lease } from '../lib/types';

const currencyOptions = CURRENCIES.map((c) => ({ value: c, label: `${c} ${CURRENCY_SIGN[c]}` }));
const toDate = (s: string | null) => (s ? dayjs(s).toDate() : null);
const fromDate = (d: Date | string | null) => (d ? dayjs(d).format('YYYY-MM-DD') : null);

// Edits the lease terms. Leases are never deleted (CLAUDE.md); a lease that
// ended gets an end date. Row-level security decides whether the save is allowed.
export function LeaseForm({ lease, opened, onClose }: { lease: Lease; opened: boolean; onClose: () => void }) {
  const qc = useQueryClient();
  const [v, setV] = useState({
    start_date: toDate(lease.start_date), end_date: toDate(lease.end_date),
    rent_amount: lease.rent_amount, rent_currency: lease.rent_currency,
    deposit_amount: lease.deposit_amount, collect_day: lease.collect_day, notes: lease.notes ?? '',
  });
  const [busy, setBusy] = useState(false);
  const set = <K extends keyof typeof v>(k: K, x: (typeof v)[K]) => setV((p) => ({ ...p, [k]: x }));
  const endBeforeStart = !!v.start_date && !!v.end_date && v.end_date < v.start_date;

  async function save() {
    setBusy(true);
    const { error } = await supabase.from('leases').update({
      start_date: fromDate(v.start_date), end_date: fromDate(v.end_date),
      rent_amount: v.rent_amount, rent_currency: v.rent_currency,
      deposit_amount: v.deposit_amount,
      deposit_currency: v.deposit_amount !== null ? (lease.deposit_currency ?? v.rent_currency) : null,
      collect_day: v.collect_day, notes: v.notes || null,
    }).eq('id', lease.id);
    setBusy(false);
    if (error) { notifications.show({ color: 'red', title: 'השמירה נכשלה', message: error.message }); return; }
    notifications.show({ color: 'teal', message: 'החוזה נשמר' });
    await qc.invalidateQueries();
    onClose();
  }

  const num = (x: string | number) => (x === '' ? null : Number(x));
  return (
    <Modal opened={opened} onClose={onClose} title={`עריכת חוזה${lease.tenant ? ` · ${lease.tenant.display_name}` : ''}`} size="lg">
      <SimpleGrid cols={{ base: 1, sm: 2 }}>
        <DateInput label="תאריך התחלה" value={v.start_date} onChange={(d) => set('start_date', d ? dayjs(d).toDate() : null)} valueFormat="DD.MM.YYYY" clearable />
        <DateInput label="תאריך סיום" value={v.end_date} onChange={(d) => set('end_date', d ? dayjs(d).toDate() : null)} valueFormat="DD.MM.YYYY" clearable
          error={endBeforeStart ? 'תאריך הסיום לפני ההתחלה' : undefined} />
        <NumberInput label="שכירות חודשית" value={v.rent_amount ?? ''} onChange={(x) => set('rent_amount', num(x))} min={0} thousandSeparator="," />
        <Select label="מטבע" data={currencyOptions} value={v.rent_currency} onChange={(x) => set('rent_currency', x as Currency | null)} clearable />
        <NumberInput label="פיקדון" value={v.deposit_amount ?? ''} onChange={(x) => set('deposit_amount', num(x))} min={0} thousandSeparator="," />
        <NumberInput label="יום גבייה בחודש" value={v.collect_day ?? ''} onChange={(x) => set('collect_day', num(x))} min={1} max={31} />
      </SimpleGrid>
      <Textarea label="הערות" mt="sm" autosize minRows={3} maxRows={10} value={v.notes} onChange={(e) => set('notes', e.currentTarget.value)} />
      <Group justify="flex-end" mt="lg">
        <Button variant="default" onClick={onClose}>ביטול</Button>
        <Button onClick={save} loading={busy} disabled={endBeforeStart}>שמירה</Button>
      </Group>
    </Modal>
  );
}
