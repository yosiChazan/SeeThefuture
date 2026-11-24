import { Alert, Button, FileInput, Group, Modal, Select, Stack, Table, Text, TextInput } from '@mantine/core';
import { notifications } from '@mantine/notifications';
import { IconFileZip } from '@tabler/icons-react';
import { useQueryClient } from '@tanstack/react-query';
import { unzipSync } from 'fflate';
import { useState } from 'react';
import { toE164 } from '../lib/phone';
import { useClients } from '../lib/queries';
import { supabase } from '../lib/supabase';
import { importId, parseWaExport, senders, type WaExportMessage } from '../lib/waExport';

// Importing a chat exported from WhatsApp ("ייצוא צ'אט" on the phone: a ZIP with the text and, "with
// media", the pictures) into the inbox (SPEC decision 191, a temporary button). The export names
// people, not numbers, so the client (or the number) is chosen here, and who of the senders is the
// office. Messages from the connection on are skipped: they came in by themselves. Importing the
// same file again adds nothing.

interface Parsed { name: string; msgs: WaExportMessage[]; files: Record<string, Uint8Array> }

const MIME: Record<string, string> = { jpg: 'image/jpeg', jpeg: 'image/jpeg', png: 'image/png', webp: 'image/webp', gif: 'image/gif', mp4: 'video/mp4', opus: 'audio/ogg', ogg: 'audio/ogg', mp3: 'audio/mpeg', m4a: 'audio/mp4', pdf: 'application/pdf' };
const kindOf = (f: string) => { const e = f.split('.').pop()!.toLowerCase(); return /^(jpe?g|png|webp|gif)$/.test(e) ? 'image' : /^(mp4|3gp|mov)$/.test(e) ? 'video' : /^(opus|ogg|mp3|m4a|aac)$/.test(e) ? 'audio' : 'document'; };

export function WaImport({ onClose }: { onClose: () => void }) {
  const qc = useQueryClient();
  const clients = useClients();
  const [parsed, setParsed] = useState<Parsed | null>(null);
  const [office, setOffice] = useState<string | null>(null);
  const [clientId, setClientId] = useState<string | null>(null);
  const [phone, setPhone] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function read(file: File | null) {
    setError(null); setParsed(null);
    if (!file) return;
    try {
      const all = unzipSync(new Uint8Array(await file.arrayBuffer()));
      const txt = Object.keys(all).find((k) => k.toLowerCase().endsWith('.txt'));
      if (!txt) throw new Error('בקובץ אין את קובץ הטקסט של השיחה');
      const msgs = parseWaExport(new TextDecoder().decode(all[txt]));
      if (!msgs.length) throw new Error('לא נמצאו הודעות בקובץ');
      const files: Record<string, Uint8Array> = {};
      for (const [k, v] of Object.entries(all)) if (k !== txt) files[k.split('/').pop()!] = v;
      const name = txt.replace(/^.*\//, '').replace(/\.txt$/i, '').replace(/^(WhatsApp Chat with|צ'אט WhatsApp עם|WhatsApp Chat -)\s*/i, '');
      setParsed({ name, msgs, files });
      const ss = senders(msgs);
      setOffice(ss.find((s) => /העתיד|future|STF/i.test(s.name))?.name ?? ss[1]?.name ?? null);
      // The client by the chat's name, if it matches one.
      const match = (clients.data ?? []).find((c) => c.display_name.trim() === name.trim());
      if (match) { setClientId(match.id); setPhone(match.phone ?? ''); }
      else if (toE164(name)) setPhone(name);
    } catch (e) { setError((e as Error).message); }
  }

  const e164 = toE164(phone);
  const client = clients.data?.find((c) => c.id === clientId);

  async function run() {
    if (!parsed || !e164 || !office) return;
    setBusy(true); setError(null);
    try {
      const { data: acct } = await supabase.from('whatsapp_account').select('connected_at').eq('id', 1).maybeSingle();
      const until = acct?.connected_at ? new Date(acct.connected_at).getTime() : Infinity;
      // The chat of this number: found or opened.
      let { data: conv } = await supabase.from('conversations').select('id, client_party_id, last_message_at').eq('wa_phone', e164).maybeSingle();
      if (!conv) {
        const ins = await supabase.from('conversations').insert({ wa_phone: e164, client_party_id: clientId, contact_name: parsed.name }).select('id, client_party_id, last_message_at').single();
        if (ins.error) throw new Error(ins.error.message);
        conv = ins.data;
      } else if (!conv.client_party_id && clientId) {
        await supabase.from('conversations').update({ client_party_id: clientId }).eq('id', conv.id);
      }
      const rows = [];
      let n = 0, skipped = 0, pics = 0;
      for (const m of parsed.msgs) {
        n++;
        if (m.at.getTime() >= until) { skipped++; continue; }
        const id = await importId(e164, m, n);
        let media_path: string | null = null;
        if (m.file && parsed.files[m.file]) {
          const ext = m.file.split('.').pop()!.toLowerCase();
          const path = `import/${conv!.id}/${id.slice(7)}.${ext}`;
          const up = await supabase.storage.from('whatsapp').upload(path, parsed.files[m.file], { contentType: MIME[ext] ?? 'application/octet-stream', upsert: true });
          if (!up.error) { media_path = path; pics++; }
        }
        rows.push({
          conversation_id: conv!.id, direction: m.sender === office ? 'out' : 'in', body: m.text || null,
          kind: m.file ? kindOf(m.file) : 'text', file_name: m.file, media_path, origin: 'history',
          wa_message_id: id, created_at: m.at.toISOString(), wa_timestamp: m.at.toISOString(),
        });
      }
      for (let i = 0; i < rows.length; i += 300) {
        const r = await supabase.from('messages').upsert(rows.slice(i, i + 300), { onConflict: 'wa_message_id', ignoreDuplicates: true });
        if (r.error) throw new Error(r.error.message);
      }
      const last = rows.reduce((a, r) => (r.created_at > a ? r.created_at : a), '');
      if (last && (!conv!.last_message_at || conv!.last_message_at < last)) await supabase.from('conversations').update({ last_message_at: last }).eq('id', conv!.id);
      notifications.show({ color: 'teal', autoClose: false, message: `יובאו ${rows.length} הודעות${pics ? `, ${pics} קבצים` : ''}${skipped ? `. ${skipped} הודעות מאז החיבור דולגו (הן כבר במערכת)` : ''}.` });
      await qc.invalidateQueries({ queryKey: ['conversations'] });
      await qc.invalidateQueries({ queryKey: ['messages-recent'] });
      onClose();
    } catch (e) { setError((e as Error).message); } finally { setBusy(false); }
  }

  const ss = parsed ? senders(parsed.msgs) : [];
  const withFiles = parsed?.msgs.filter((m) => m.file).length ?? 0;
  const missing = parsed?.msgs.filter((m) => m.file && !parsed.files[m.file]).length ?? 0;
  return (
    <Modal opened onClose={onClose} title="ייבוא שיחה מוואטסאפ (זמני)" size="lg">
      <Stack>
        <Text size="sm" c="dimmed">בטלפון: פותחים את הצ'אט ← ⋮ ← עוד ← ייצוא צ'אט ← "עם מדיה" (או בלי) ← שומרים את קובץ ה-ZIP ומעלים אותו כאן, שיחה אחת בכל פעם.</Text>
        <FileInput label="קובץ ה-ZIP" accept=".zip,application/zip" leftSection={<IconFileZip size={16} />} placeholder="בחירת קובץ" onChange={read} clearable />
        {error && <Alert color="red">{error}</Alert>}
        {parsed && <>
          <Table fz="sm" withRowBorders={false}>
            <Table.Tbody>
              <Table.Tr><Table.Td c="dimmed">שיחה</Table.Td><Table.Td>{parsed.name}</Table.Td></Table.Tr>
              <Table.Tr><Table.Td c="dimmed">הודעות</Table.Td><Table.Td>{parsed.msgs.length} · {parsed.msgs[0].at.toLocaleDateString('he-IL')} עד {parsed.msgs.at(-1)!.at.toLocaleDateString('he-IL')}</Table.Td></Table.Tr>
              <Table.Tr><Table.Td c="dimmed">קבצים</Table.Td><Table.Td>{withFiles}{missing ? ` (${missing} לא בקובץ: יוצאו בלי מדיה)` : ''}</Table.Td></Table.Tr>
            </Table.Tbody>
          </Table>
          <Select label="מי מהם המשרד" data={ss.map((s) => ({ value: s.name, label: `${s.name} (${s.count})` }))} value={office} onChange={setOffice} allowDeselect={false} />
          <Select label="הלקוח" searchable clearable placeholder="בחירת לקוח (או מספר למטה)" value={clientId}
            data={(clients.data ?? []).map((c) => ({ value: c.id, label: `${c.display_name}${c.phone ? ` · ${c.phone}` : ''}` }))}
            onChange={(x) => { setClientId(x); const c = clients.data?.find((y) => y.id === x); if (c?.phone) setPhone(c.phone); }} />
          <TextInput label="מספר הוואטסאפ של השיחה" value={phone} onChange={(e) => setPhone(e.currentTarget.value)} placeholder="+972…" dir="ltr"
            error={phone && !e164 ? 'מספר לא תקין' : undefined} description={client && !client.phone ? 'ללקוח אין טלפון בכרטיס: מקלידים את המספר' : undefined} />
        </>}
        <Group justify="flex-end">
          <Button variant="default" onClick={onClose}>ביטול</Button>
          <Button onClick={run} loading={busy} disabled={!parsed || !e164 || !office}>ייבוא</Button>
        </Group>
      </Stack>
    </Modal>
  );
}
