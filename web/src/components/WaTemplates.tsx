import { Alert, Badge, Button, Group, Modal, Select, Stack, Table, Text, Textarea, TextInput, Title } from '@mantine/core';
import { notifications } from '@mantine/notifications';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { useState } from 'react';
import { useAccess } from '../lib/access';
import { supabase } from '../lib/supabase';

// The WhatsApp templates of the company's number (SPEC decision 200): each with Meta's verdict,
// and, for the admin, submitting a new one. A template is what can be sent to a client who has not
// written in the last 24 hours. {{1}}, {{2}}… are filled when sending; Meta wants an example of each.

interface Tpl { name: string; language: string; category: string; status: string; rejected_reason: string | null; body: string }
const STATUS: Record<string, { label: string; color: string }> = {
  APPROVED: { label: 'מאושרת', color: 'teal' }, PENDING: { label: 'ממתינה לאישור', color: 'yellow' }, REJECTED: { label: 'נדחתה', color: 'red' },
  PAUSED: { label: 'מושהית', color: 'orange' }, DISABLED: { label: 'מושבתת', color: 'gray' }, IN_APPEAL: { label: 'בערעור', color: 'grape' },
};
// The first three, written with the office (decision 200).
const PRESETS = [
  { name: 'stf_open_chat', body: 'שלום {{1}}, כאן משרד לראות את העתיד. יש לנו עדכון לגבי הדירה שלך. אפשר לכתוב לנו כאן.', examples: ['דנה'] },
  { name: 'stf_monthly_report', body: 'שלום {{1}}, הדוח החודשי של הדירה ב{{2}} מוכן. נשמח לשלוח אותו כאן.', examples: ['דנה', 'אודסה'] },
  { name: 'stf_document_request', body: 'שלום {{1}}, כדי להמשיך בטיפול אנחנו צריכים ממך {{2}}. אפשר לשלוח כאן.', examples: ['דנה', 'צילום דרכון'] },
];
const vars = (body: string) => [...new Set([...body.matchAll(/\{\{(\d+)\}\}/g)].map((m) => Number(m[1])))].sort((a, b) => a - b);

async function call(body: Record<string, unknown>) {
  const { data, error } = await supabase.functions.invoke('whatsapp-send', { body });
  if (error) {
    let msg = error.message;
    try { msg = (await (error as { context?: Response }).context?.json())?.error ?? msg; } catch { /* keep */ }
    throw new Error(msg);
  }
  return data;
}

export function WaTemplates() {
  const access = useAccess();
  const qc = useQueryClient();
  const q = useQuery({ queryKey: ['wa-templates-all'], queryFn: async () => (await call({ action: 'templates_all' })).templates as Tpl[], refetchInterval: 60_000 });
  const [form, setForm] = useState<{ name: string; body: string; examples: string[]; category: string } | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const have = new Set((q.data ?? []).map((t) => t.name));
  async function submit() {
    setBusy(true); setError(null);
    try {
      const r = await call({ action: 'create_template', ...form, language: 'he' });
      notifications.show({ color: 'teal', message: `התבנית ${form!.name} הוגשה (${STATUS[r.status]?.label ?? r.status})` });
      setForm(null);
      await qc.invalidateQueries({ queryKey: ['wa-templates-all'] });
      await qc.invalidateQueries({ queryKey: ['wa-templates'] });
    } catch (e) { setError((e as Error).message); } finally { setBusy(false); }
  }
  const n = form ? vars(form.body) : [];
  return (
    <Stack gap="xs" mt="md">
      <Group justify="space-between">
        <Title order={5}>תבניות</Title>
        {access.isAdmin && <Group gap={4}>
          {PRESETS.filter((p) => !have.has(p.name)).map((p) => <Button key={p.name} size="compact-xs" variant="light" onClick={() => { setError(null); setForm({ ...p, category: 'UTILITY' }); }}>{p.name}</Button>)}
          <Button size="compact-xs" onClick={() => { setError(null); setForm({ name: '', body: '', examples: [], category: 'UTILITY' }); }}>תבנית חדשה</Button>
        </Group>}
      </Group>
      {q.error ? <Alert color="red">{(q.error as Error).message}</Alert> : q.isLoading ? <Text size="sm" c="dimmed">טוען…</Text>
        : !(q.data ?? []).length ? <Text size="sm" c="dimmed">אין עדיין תבניות.</Text> : (
          <Table fz="sm" verticalSpacing={4}>
            <Table.Tbody>{(q.data ?? []).map((t) => (
              <Table.Tr key={`${t.name}:${t.language}`}>
                <Table.Td dir="ltr" style={{ whiteSpace: 'nowrap' }}>{t.name}</Table.Td>
                <Table.Td><Badge size="sm" color={STATUS[t.status]?.color ?? 'gray'}>{STATUS[t.status]?.label ?? t.status}</Badge></Table.Td>
                <Table.Td>{t.body}{t.rejected_reason && t.rejected_reason !== 'NONE' ? <Text size="xs" c="red">סיבה: {t.rejected_reason}</Text> : null}</Table.Td>
              </Table.Tr>
            ))}</Table.Tbody>
          </Table>
        )}
      {form && (
        <Modal opened onClose={() => setForm(null)} title="הגשת תבנית לאישור של Meta" size="lg">
          <Stack>
            <TextInput label="שם" description="אותיות אנגליות קטנות, ספרות וקו תחתון" dir="ltr" value={form.name} onChange={(e) => setForm({ ...form, name: e.currentTarget.value })} />
            <Select label="קטגוריה" allowDeselect={false} value={form.category} onChange={(x) => x && setForm({ ...form, category: x })}
              data={[{ value: 'UTILITY', label: 'Utility (שירות)' }, { value: 'MARKETING', label: 'Marketing (שיווק)' }]} />
            <Textarea label="נוסח" description="{{1}}, {{2}} – מתמלאים בשליחה" autosize minRows={3} value={form.body} onChange={(e) => setForm({ ...form, body: e.currentTarget.value })} />
            {n.map((v, i) => <TextInput key={v} label={`דוגמה ל-{{${v}}}`} value={form.examples[i] ?? ''}
              onChange={(e) => { const ex = [...form.examples]; ex[i] = e.currentTarget.value; setForm({ ...form, examples: ex }); }} />)}
            {error && <Alert color="red">{error}</Alert>}
            <Group justify="flex-end">
              <Button variant="default" onClick={() => setForm(null)}>ביטול</Button>
              <Button onClick={submit} loading={busy} disabled={!form.name || !form.body.trim() || n.some((_, i) => !form.examples[i]?.trim())}>הגשה ל-Meta</Button>
            </Group>
          </Stack>
        </Modal>
      )}
    </Stack>
  );
}
