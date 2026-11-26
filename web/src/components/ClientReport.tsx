import { Alert, Box, Button, Group, Loader, Modal, SegmentedControl, Stack, Table, Text, TextInput, Title } from '@mantine/core';
import { DateInput } from '@mantine/dates';
import { notifications } from '@mantine/notifications';
import { IconBrandWhatsapp, IconDownload } from '@tabler/icons-react';
import dayjs from 'dayjs';
import { useMemo, useRef, useState } from 'react';
import { ACCOUNT_KIND_HE, categoryLabel, CURRENCY_SIGN } from '../lib/format';
import { useAccountEntries, useClientAccounts } from '../lib/queries';
import { buildStatement, type AccountStatement } from '../lib/statement';
import { supabase } from '../lib/supabase';
import type { Currency } from '../lib/types';

// A client's statement from the chat (SPEC decision 208): dates and a level (a line per month, or
// every entry), a preview, and then it goes to the client as a PDF in WhatsApp, or is downloaded.
// The PDF is a picture of the preview, so it looks exactly as shown.

const MONTHS = ['ינואר', 'פברואר', 'מרץ', 'אפריל', 'מאי', 'יוני', 'יולי', 'אוגוסט', 'ספטמבר', 'אוקטובר', 'נובמבר', 'דצמבר'];
const monthHe = (m: string) => `${MONTHS[Number(m.slice(5, 7)) - 1]} ${m.slice(0, 4)}`;
const d = (s: string) => s.split('-').reverse().join('.');
const fmt = (n: number, c: string) => `${new Intl.NumberFormat('he-IL', { minimumFractionDigits: 2, maximumFractionDigits: 2 }).format(n)} ${CURRENCY_SIGN[c as Currency] ?? c}`;
// Numbers keep their sign on the left inside Hebrew text.
const N = ({ v, c }: { v: number; c: string }) => <span dir="ltr" style={{ unicodeBidi: 'isolate', color: v < 0 ? '#c92a2a' : undefined }}>{fmt(v, c)}</span>;

export function ClientReport({ partyId, name, conversationId, canSend, onClose, onSent }: {
  partyId: string; name: string; conversationId: string; canSend: boolean; onClose: () => void; onSent: () => void;
}) {
  const [from, setFrom] = useState(dayjs().subtract(3, 'month').startOf('month').format('YYYY-MM-DD'));
  const [to, setTo] = useState(dayjs().format('YYYY-MM-DD'));
  const [level, setLevel] = useState<'summary' | 'detail'>('summary');
  const [caption, setCaption] = useState(`שלום, מצורף דוח החשבון שלך לתקופה ${d(from)}–${d(to)}.`);
  const [busy, setBusy] = useState<'send' | 'download' | null>(null);
  const preview = useRef<HTMLDivElement>(null);
  const accounts = useClientAccounts(partyId);
  const ids = (accounts.data ?? []).map((a) => a.id);
  const entries = useAccountEntries(ids);
  const statements = useMemo<AccountStatement[]>(() => buildStatement(
    (accounts.data ?? []).map((a) => ({
      id: a.id, currency: a.currency,
      title: a.kind === 'client_bank' ? `הופקד בחשבון שלך (${a.currency})` : `${ACCOUNT_KIND_HE[a.kind] ?? a.kind}${a.holder ? ` · ${a.holder.display_name}` : ''} (${a.currency})`,
    })),
    (entries.data ?? []).filter((e) => e.account_id).map((e) => ({
      account_id: e.account_id!, amount: Number(e.amount), on: e.transaction.occurred_on,
      label: [categoryLabel(e.transaction.category), e.transaction.description].filter(Boolean).join(' · '),
      place: e.property ? `${e.property.building?.name ?? ''} ${e.property.unit_no}`.trim() : null,
    })), from, to), [accounts.data, entries.data, from, to]);
  const fileName = `דוח ${name} ${d(from)}-${d(to)}.pdf`;

  // The preview as an A4 PDF, page after page.
  async function pdf(): Promise<Blob> {
    const [{ default: html2canvas }, { jsPDF }] = await Promise.all([import('html2canvas'), import('jspdf')]);
    const canvas = await html2canvas(preview.current!, { scale: 2, backgroundColor: '#ffffff' });
    const doc = new jsPDF({ unit: 'mm', format: 'a4' });
    const w = 190, pageH = 277;
    const pxPerMm = canvas.width / w;
    const slice = Math.floor(pageH * pxPerMm);
    for (let y = 0, page = 0; y < canvas.height; y += slice, page++) {
      const part = document.createElement('canvas');
      part.width = canvas.width; part.height = Math.min(slice, canvas.height - y);
      part.getContext('2d')!.drawImage(canvas, 0, y, canvas.width, part.height, 0, 0, canvas.width, part.height);
      if (page) doc.addPage();
      doc.addImage(part.toDataURL('image/jpeg', 0.92), 'JPEG', 10, 10, w, part.height / pxPerMm);
    }
    return doc.output('blob');
  }
  async function download() {
    setBusy('download');
    try {
      const a = document.createElement('a');
      a.href = URL.createObjectURL(await pdf()); a.download = fileName; a.click();
    } finally { setBusy(null); }
  }
  async function send() {
    setBusy('send');
    try {
      const bytes = new Uint8Array(await (await pdf()).arrayBuffer());
      let bin = '';
      for (let i = 0; i < bytes.length; i += 0x8000) bin += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
      const { error } = await supabase.functions.invoke('whatsapp-send', { body: { conversation_id: conversationId, document: { base64: btoa(bin), file_name: fileName, caption: caption.trim() || undefined } } });
      if (error) {
        let msg = error.message;
        try { msg = (await (error as { context?: Response }).context?.json())?.error ?? msg; } catch { /* keep */ }
        throw new Error(msg);
      }
      notifications.show({ color: 'teal', message: 'הדוח נשלח' });
      onSent(); onClose();
    } catch (e) { notifications.show({ color: 'red', title: 'השליחה נכשלה', message: (e as Error).message }); } finally { setBusy(null); }
  }

  const loading = accounts.isLoading || entries.isLoading;
  return (
    <Modal opened onClose={onClose} title={`דוח ל${name}`} size={860}>
      <Stack>
        <Group align="flex-end" gap="sm">
          <DateInput label="מתאריך" valueFormat="DD.MM.YYYY" value={from} onChange={(x) => x && setFrom(dayjs(x).format('YYYY-MM-DD'))} w={140} />
          <DateInput label="עד תאריך" valueFormat="DD.MM.YYYY" value={to} onChange={(x) => x && setTo(dayjs(x).format('YYYY-MM-DD'))} w={140} />
          <SegmentedControl value={level} onChange={(x) => setLevel(x as typeof level)} data={[{ value: 'summary', label: 'סיכום לפי חודש' }, { value: 'detail', label: 'כל השורות' }]} />
        </Group>
        <Text size="sm" fw={600}>תצוגה מקדימה</Text>
        <Box style={{ border: '1px solid #dee2e6', maxHeight: '55vh', overflow: 'auto', background: '#f1f3f5', padding: 8 }}>
          {loading ? <Group justify="center" p="xl"><Loader size="sm" /></Group> : (
            <div ref={preview} dir="rtl" style={{ width: 760, margin: '0 auto', background: '#fff', padding: 28, fontFamily: 'Heebo, Arial, sans-serif', color: '#212529' }}>
              <Group justify="space-between" align="flex-start">
                <div><Title order={3}>דוח חשבון</Title><Text size="sm">{name}</Text></div>
                <div style={{ textAlign: 'left' }}><Text size="sm" fw={700}>See the Future LTD</Text><Text size="xs" c="dimmed">לראות את העתיד</Text></div>
              </Group>
              <Text size="sm" mt={6} mb="md">תקופה: {d(from)} – {d(to)} · הופק {dayjs().format('DD.MM.YYYY')}</Text>
              {!statements.length && <Text c="dimmed">אין תנועות בתקופה.</Text>}
              {statements.map((s) => {
                const c = s.account.currency;
                return (
                  <div key={s.account.id} style={{ marginBottom: 22 }}>
                    <Text fw={700} size="sm" mb={4} style={{ borderBottom: '2px solid #1c7ed6', paddingBottom: 2 }}>{s.account.title}</Text>
                    <Table fz="xs" verticalSpacing={3} withRowBorders>
                      <Table.Tbody>
                        <Table.Tr bg="gray.0"><Table.Td colSpan={level === 'summary' ? 4 : 3} fw={600}>יתרה ב-{d(from)}</Table.Td><Table.Td fw={600}><N v={s.opening} c={c} /></Table.Td></Table.Tr>
                        {level === 'summary' ? <>
                          <Table.Tr><Table.Th>חודש</Table.Th><Table.Th>הכנסות</Table.Th><Table.Th>הוצאות</Table.Th><Table.Th>נטו</Table.Th><Table.Th>יתרה</Table.Th></Table.Tr>
                          {s.months.map((m) => <Table.Tr key={m.month}><Table.Td>{monthHe(m.month)}</Table.Td><Table.Td><N v={m.income} c={c} /></Table.Td><Table.Td><N v={m.expenses} c={c} /></Table.Td><Table.Td><N v={m.net} c={c} /></Table.Td><Table.Td><N v={m.balance} c={c} /></Table.Td></Table.Tr>)}
                        </> : <>
                          <Table.Tr><Table.Th>תאריך</Table.Th><Table.Th>פירוט</Table.Th><Table.Th>דירה</Table.Th><Table.Th>סכום</Table.Th><Table.Th>יתרה</Table.Th></Table.Tr>
                          {s.lines.map((l, i) => <Table.Tr key={i}><Table.Td style={{ whiteSpace: 'nowrap' }}>{d(l.on)}</Table.Td><Table.Td>{l.label}</Table.Td><Table.Td>{l.place ?? ''}</Table.Td><Table.Td><N v={l.amount} c={c} /></Table.Td><Table.Td><N v={l.balance} c={c} /></Table.Td></Table.Tr>)}
                        </>}
                        <Table.Tr bg="gray.0"><Table.Td colSpan={level === 'summary' ? 4 : 3} fw={700}>יתרה ב-{d(to)} (הכנסות <N v={s.income} c={c} />, הוצאות <N v={s.expenses} c={c} />)</Table.Td><Table.Td fw={700}><N v={s.closing} c={c} /></Table.Td></Table.Tr>
                      </Table.Tbody>
                    </Table>
                  </div>
                );
              })}
            </div>
          )}
        </Box>
        <TextInput label="הודעה שתישלח עם הקובץ" value={caption} onChange={(e) => setCaption(e.currentTarget.value)} />
        {!canSend && <Alert color="orange">הלקוח לא כתב ב-24 השעות האחרונות: וואטסאפ מאפשר לשלוח קובץ רק אחרי שהוא כותב (אפשר לשלוח לו תבנית קודם). אפשר להוריד את הקובץ.</Alert>}
        <Group justify="flex-end">
          <Button variant="default" onClick={onClose}>ביטול</Button>
          <Button variant="light" leftSection={<IconDownload size={16} />} loading={busy === 'download'} disabled={loading || !!busy} onClick={download}>הורדת PDF</Button>
          <Button color="green" leftSection={<IconBrandWhatsapp size={16} />} loading={busy === 'send'} disabled={loading || !!busy || !canSend || !statements.length} onClick={send}>שליחה ללקוח בוואטסאפ</Button>
        </Group>
      </Stack>
    </Modal>
  );
}
